// The move page: an extension page, so consent to the move is given in UI
// this helper controls (see move.js for what happens behind it).
//
// It copies the old UI's localStorage keys into storage.local (where the
// helper can read them: this page's origin is the old UI's), offers a backup
// file first, sets the server up when it is not yet, shows what moves and
// what stays, and approves a hand-over to the web-app tab it opens. Once the
// move is done it says so, and signs the old UI's session out once the web
// app has one. It writes no tree data.
import { downloadBackup } from '../utils/backup.js';

const api = typeof browser !== 'undefined' ? browser : chrome;
const $ = id => document.getElementById(id);
const LEGACY_LS_KEYS = ['tp_notes_parked_v1', 'tp_notes_ui_v1', 'tp_notes_ui_accounts_v1'];
const SECRET_FIELD = /(token|password|secret|apikey)$/i;
let state = null;
let backedUp = false;

const say = text => { $('status').textContent = text; };
async function call(op, body = {}) {
    const reply = await api.runtime.sendMessage({ channel: 'tp-helper-move', op, body });
    if (!reply || !reply.ok) throw new Error((reply && reply.error && reply.error.message) || 'The helper is restarting. Try again.');
    return reply.data;
}
const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
};
function button(text, fn) {
    const b = el('button', text);
    b.type = 'button';
    b.addEventListener('click', async () => {
        b.disabled = true;
        try { await fn(); } catch (e) { say(e.message); } finally { b.disabled = false; }
    });
    return b;
}

// a. The old UI's localStorage keys, into storage.local, under the working
// copy's lock. The originals stay; a key this page no longer finds keeps its
// earlier copy.
async function copyLocalStorage() {
    const run = async () => {
        const keys = {};
        for (const k of LEGACY_LS_KEYS) {
            try {
                const v = localStorage.getItem(k);
                if (v !== null) keys[k] = v;
            } catch (e) { /* blocked: what was copied before stands */ }
        }
        const prev = (await api.storage.local.get('tpLegacyLocalStorage')).tpLegacyLocalStorage;
        const kept = prev && prev.keys && typeof prev.keys === 'object' ? prev.keys : {};
        const merged = { ...kept, ...keys };
        if (prev && JSON.stringify(kept) === JSON.stringify(merged)) return prev;
        const next = { v: 1, copiedAt: new Date().toISOString(), keys: merged };
        await api.storage.local.set({ tpLegacyLocalStorage: next });
        return next;
    };
    return navigator.locks && navigator.locks.request ? navigator.locks.request('tp-working-copy', run) : run();
}

function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
function scrub(value) {
    if (Array.isArray(value)) return value.map(scrub);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).filter(([k]) => !SECRET_FIELD.test(k)).map(([k, v]) => [k, scrub(v)]));
}
const escape = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// A browser-importable bookmarks file of a kept copy. Notes travel as the
// historical data:application/json bookmarks, as the old UI exported them.
function bookmarksHtml(roots) {
    const lines = ['<!DOCTYPE NETSCAPE-Bookmark-file-1>', '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">', '<TITLE>Bookmarks</TITLE>', '<H1>Bookmarks</H1>', '<DL><p>'];
    const walk = (nodes, depth) => {
        const pad = '    '.repeat(depth);
        for (const n of nodes || []) {
            if (!n || n.virtual) continue;
            if (n.kind === 'folder') {
                lines.push(`${pad}<DT><H3>${escape(n.title)}</H3>`, `${pad}<DL><p>`);
                walk(n.children, depth + 1);
                lines.push(`${pad}</DL><p>`);
            } else {
                const url = n.kind === 'note' ? 'data:application/json,' + encodeURIComponent(JSON.stringify({ v: 1, ...(n.payload || {}) })) : n.url;
                lines.push(`${pad}<DT><A HREF="${escape(url)}">${escape(n.title)}</A>`);
            }
        }
    };
    walk(roots, 1);
    lines.push('</DL><p>');
    return lines.join('\n') + '\n';
}
async function downloadKept(copy, kind) {
    const key = copy.key || 'tpTree';
    const record = (await api.storage.local.get(key))[key];
    if (!record) throw new Error('That copy is no longer here.');
    const stem = 'tabpaladin-kept-' + String(copy.owner ? `${copy.owner.username || 'account-' + copy.owner.userId}` : copy.origin).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60);
    if (kind === 'json') download(stem + '.json', JSON.stringify({ format: 'tabpaladin-kept-copy', version: 1, exportedAt: new Date().toISOString(), key, copy: scrub(record) }, null, 2), 'application/json');
    else download(stem + '.html', bookmarksHtml(record.roots), 'text/html');
}

const whose = c => (c.owner
    ? `${c.owner.username || 'account #' + c.owner.userId} @ ${c.owner.url}`
    : c.origin === 'local' ? 'made while signed out' : `from before accounts${c.url ? ' @ ' + c.url : ''}`);
function where(c) {
    if (c.class === 'this') return 'moves';
    if (c.class === 'this-moved') return 'moves: this server, from its old address';
    if (c.class === 'unstamped') return c.sameServer || c.origin === 'local' ? 'moves: the web app decides whose it is'
        : 'moves, kept aside there: from another address';
    if (c.class === 'other') return 'kept in this browser: another server';
    return 'connect your server to see where it goes';
}
function row(c, label) {
    const div = el('div', null, 'copy');
    div.append(el('strong', `${label}: ${whose(c)}`), el('span', c.moves ? 'moves' : 'kept', 'tag' + (c.moves ? '' : ' kept')));
    div.append(el('small', `${c.items} item${c.items === 1 ? '' : 's'} · ${c.dirty ? c.editCount + ' unpushed edit' + (c.editCount === 1 ? '' : 's') : 'nothing unpushed'}${c.setAsideAt ? ' · set aside ' + new Date(c.setAsideAt).toLocaleString() : ''} · ${where(c)}`));
    return div;
}

function render() {
    const s = state;
    const server = s.server;
    const ready = Boolean(server && server.enabled && !server.identityError);
    $('connected').textContent = server
        ? `Connected to ${server.origin} (server ${server.serverId})${server.enabled ? '' : ' · disconnected: connect again below'}${server.identityError ? ' · ' + server.identityError : ''}`
            + (s.session ? (s.session.signedIn ? ` · web app signed in as ${s.session.username || 'an account'}` : ' · web app signed out') : '')
        : 'Not connected yet. Enter your server\'s address.';
    $('setup').hidden = ready;
    if (!$('origin').value) $('origin').value = (server && server.origin) || s.legacyUrl || '';

    const summary = $('summary');
    summary.replaceChildren();
    if (s.working) summary.append(row(s.working, 'Working copy'));
    const moving = s.stashes.filter(c => c.moves);
    for (const c of moving) summary.append(row(c, 'Set-aside copy'));
    const lines = [
        `Note drafts: ${s.drafts.moving} move${s.drafts.kept ? `, ${s.drafts.kept} stay (another server)` : ''}`,
        `Device settings: ${s.prefs.keywordCategories} keyword categories, ${s.prefs.categoryOrder ? 'a category order, ' : ''}${s.prefs.notesView ? 'the notes view, ' : ''}${s.prefs.openCards} open cards`,
        s.queuedRemovals ? `${s.queuedRemovals} queued workflow removal${s.queuedRemovals === 1 ? '' : 's'} go with the working copy` : '',
        s.legacyWorkflows ? `${s.legacyWorkflows} workflow${s.legacyWorkflows === 1 ? '' : 's'} from before the tree become folders under Workflows` : '',
        s.legacyWorkflowsBackup ? 'An older workflows backup (already in the working copy) stays in this browser and in the backup file.' : ''
    ].filter(Boolean);
    for (const line of lines) summary.append(el('p', line));
    if (!s.working && !moving.length && !s.drafts.moving) summary.append(el('p', server ? 'No copy here is for this server.' : 'Connect your server to see what moves.'));

    const kept = $('kept');
    kept.replaceChildren();
    const stays = [...(s.working && !s.working.moves && s.working.class !== 'unknown' ? [{ ...s.working, key: 'tpTree', label: 'Working copy' }] : []),
        ...s.stashes.filter(c => !c.moves && c.class !== 'unknown').map(c => ({ ...c, label: 'Set-aside copy' }))];
    for (const c of stays) {
        const div = row(c, c.label);
        div.append(button('Download JSON', () => downloadKept(c, 'json')), button('Download bookmarks.html', () => downloadKept(c, 'html')));
        kept.append(div);
    }
    if (!stays.length) kept.append(el('p', 'Nothing.'));

    const move = $('move');
    move.textContent = ready ? `Move to ${server.origin}` : 'Move';
    move.disabled = !ready || s.state === 'none';
    $('move-note').textContent = s.approval
        ? `Waiting for the web app: click Bring in there before ${new Date(s.approval.until).toLocaleTimeString()}.`
        : s.state === 'none' ? 'This browser holds nothing of the old TabPaladin.' : '';

    const delivered = Object.entries(s.deliveredTo || {});
    $('done').hidden = !delivered.length;
    const text = $('done-text');
    text.replaceChildren();
    for (const [origin, d] of delivered) {
        text.append(el('p', `Moved to ${origin} on ${new Date(d.at).toLocaleString()}.`));
        text.append(el('pre', (d.parts || []).map(p => `${p.id} · ${p.kind} · ${p.bytes} bytes · ${String(p.digest).slice(0, 12)}`).join('\n'), 'parts'));
        const r = s.retargeted && s.retargeted[origin];
        if (r && (r.count || r.kept)) text.append(el('p', `${r.count || 0} tracked workflow tab${r.count === 1 ? '' : 's'} now update the web app${r.kept ? `; ${r.kept} could not be matched and keep their bookmarks when closed` : ''}.`));
    }
    const t = s.legacyToken;
    $('token').textContent = !t ? 'The old interface\'s sign-in is signed out once the web app is signed in.'
        : t.state === 'revoked' ? 'The old interface\'s sign-in was signed out and removed from this browser.'
            : t.state === 'none' ? 'The old interface held no sign-in.'
                : t.message || 'The old sign-in waits for the web app to be signed in.';
    $('revoke').hidden = Boolean(t && ['revoked', 'none', 'shared-kept'].includes(t.state));
}

async function refresh() {
    state = await call('status');
    render();
    return state;
}

$('backup').addEventListener('click', async () => {
    $('backup').disabled = true;
    try {
        await copyLocalStorage();
        const backup = await downloadBackup({ api });
        backedUp = true;
        $('backup-done').textContent = `Saved ${new Date(backup.exportedAt).toLocaleString()}: the working copy (${backup.summary.workingCopy.items} items), ${backup.summary.setAsideCopies} set-aside copies, the note drafts and settings.`;
    } catch (e) {
        say('The backup could not be made: ' + e.message);
    } finally {
        $('backup').disabled = false;
    }
});
function showHost() {
    try { $('host').textContent = 'Server: ' + globalThis.TPHelper.parseOrigin($('origin').value, $('insecure').checked).serverOrigin; }
    catch (e) { $('host').textContent = e.message; }
}
$('origin').addEventListener('input', showHost);
$('insecure').addEventListener('change', showHost);
$('connect').addEventListener('click', () => {
    let p;
    try { p = globalThis.TPHelper.parseOrigin($('origin').value, $('insecure').checked); } catch (e) { say(e.message); return; }
    // The first asynchronous browser call in this click (Firefox).
    const requested = api.permissions.request({ origins: [p.pattern] });
    say('Checking the server identity…');
    requested.then(async (granted) => {
        if (!granted) throw new Error('Server access was not granted.');
        try {
            await call('configure', { origin: p.serverOrigin, insecureAck: $('insecure').checked });
        } catch (e) {
            const old = (await api.storage.local.get('tpHelper')).tpHelper;
            if (!old || old.serverOrigin !== p.serverOrigin) await api.permissions.remove({ origins: [p.pattern] });
            throw e;
        }
        say('Connected. Now press Move.');
        await refresh();
    }).catch(e => say(e.message));
});
$('settings').addEventListener('click', () => api.runtime.openOptionsPage());
async function startMove() {
    if (!backedUp && !confirm('Move without downloading a backup file first? Nothing in this browser is deleted either way.')) return;
    await copyLocalStorage();
    const r = await call('approve');
    say(`Opened ${r.origin}. Click Bring in there within ten minutes.`);
    await refresh();
}
$('move').addEventListener('click', () => { startMove().catch(e => say(e.message)); });
$('again').addEventListener('click', () => { startMove().catch(e => say(e.message)); });
$('open').addEventListener('click', () => { call('open').catch(e => say(e.message)); });
$('revoke').addEventListener('click', async () => {
    try {
        const r = await call('revoke', { force: true });
        say(r.state === 'waiting' ? 'Sign in in the web app first.' : r.message || 'Done.');
        await refresh();
    } catch (e) { say(e.message); }
});

api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && ['tpMove', 'tpHelper', 'tpHelperSession'].some(k => k in changes)) refresh().catch(e => say(e.message));
});
(async () => {
    try { await copyLocalStorage(); } catch (e) { say('The notes preferences could not be copied: ' + e.message); }
    try {
        await refresh();
        say(state.state === 'done' ? 'Moved. The toolbar now opens your web app.'
            : state.state === 'none' ? 'Nothing of the old TabPaladin is in this browser.'
                : 'Ready. Keep a backup file, check your server, then move.');
        if (state.state === 'done') call('revoke').then(() => refresh()).catch(() => {});
    } catch (e) { say(e.message); }
})();
