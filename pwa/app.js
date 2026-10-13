// Minimal vanilla PWA for TabPaladin. Browses the server's canonical tree
// (GET /api/tree) as a working copy, edits it locally, and pushes it back
// (PUT /api/tree) git-style — a push against a tree another device changed
// since the last pull is refused until you pull or force, unless all that
// changed is links filed from a share sheet, which are folded in and the push
// goes again. The copy is kept on the device (IndexedDB, durableCopy.js) a
// moment after every change and whenever the app goes to the background, so
// a reload, a share that reloads the window, or the phone closing the app
// loses nothing. One window of the app edits it at a time.
//
// Sharing: a link shared to the app is kept in the outbox (tp-outbox, by the
// service worker or here), and the share sheet (shareSheet.js) files it with
// one tap on a suggested folder — straight into the server's tree, as a small
// append (POST /api/shares/:sid/file) rather than a push of this whole copy.

import { importedFolderFrom, countNodes } from './bookmarksHtml.js';
import * as NM from './notesModel.js';
import { createShareSheet } from './shareSheet.js';
import * as DC from './durableCopy.js';

// The share core, loaded by a classic <script> before this module.
const Share = window.TPShare;

const LS = {
    url: 'tp_pwa_url',
    token: 'tp_pwa_token',   // now a session token from /api/login, not a shared secret
    username: 'tp_pwa_user',
    // Who that session is, as the server said at sign-in (and /api/auth/me
    // since): the account id, its role, whether it holds the data from
    // before accounts were separated ('1'), and the server's own id.
    userId: 'tp_pwa_userid',
    role: 'tp_pwa_role',
    owner: 'tp_pwa_owner',
    serverId: 'tp_pwa_serverid',
    // Shares an earlier build queued here; moved into the outbox at start.
    legacyShares: 'tp_pending_shares'
};

function currentUserId() {
    const v = localStorage.getItem(LS.userId);
    return v === null || v === '' ? null : Number(v);
}

function rememberUser(user, username, serverId = null) {
    if (!user || user.id === undefined || user.id === null) return;
    localStorage.setItem(LS.userId, String(user.id));
    localStorage.setItem(LS.role, user.role || '');
    localStorage.setItem(LS.owner, user.tenancyOwner ? '1' : '0');
    if (username || user.username) localStorage.setItem(LS.username, username || user.username);
    if (serverId) localStorage.setItem(LS.serverId, serverId);
}

function forgetUser() {
    for (const k of [LS.token, LS.username, LS.userId, LS.role, LS.owner, LS.serverId]) localStorage.removeItem(k);
}

// Who this page's session is, as localStorage says it when the page takes
// its token from there (at load) or puts one there (a sign-in).
function storedIdentity() {
    return {
        userId: currentUserId(),
        username: localStorage.getItem(LS.username) || null,
        serverId: localStorage.getItem(LS.serverId) || null
    };
}

// Is the session in localStorage this page's own? Another window of the app
// may have signed in as someone else since this one took its token.
function holdsStoredSession() {
    return (localStorage.getItem(LS.token) || '') === (state.config.token || '');
}

// The account signed in now, as an outbox entry records it, or null: this
// page's identity, kept with its token (state.identity), never what another
// window wrote to localStorage since — shares are recorded and sent only as
// the account this page's token is.
function shareAccount() {
    if (!configured() || accountChanging) return null;
    const id = state.identity || {};
    return {
        url: state.config.url.replace(/\/+$/, ''),
        userId: id.userId === undefined ? null : id.userId,
        username: id.username || null,
        serverId: id.serverId || null
    };
}

// The config as the worker and flushOutbox take it.
function shareConfig() {
    const a = shareAccount();
    return a ? { ...a, token: state.config.token } : null;
}

// Shares wait in Cache Storage, shared with the worker; a page without it
// (an http origin, where no worker runs either) keeps them in localStorage.
const outbox = (typeof caches !== 'undefined' && caches && typeof caches.open === 'function')
    ? Share.cacheOutbox(caches) : Share.localOutbox(localStorage);

const state = {
    config: {
        // Falls back to wherever this PWA is served from, because that is the
        // backend — the server hosts it. Only needs setting by hand if you host
        // the PWA somewhere other than the sync server.
        url: localStorage.getItem(LS.url)
            || ((location.protocol === 'http:' || location.protocol === 'https:') ? location.origin : ''),
        token: localStorage.getItem(LS.token) || ''
    },
    identity: storedIdentity(),   // who that token is: see shareAccount
    snapshot: null,           // wrapper { type:'root', children: [...] } around the server's top-level folders
    snapshotUserId: null,     // the account that snapshot belongs to (from the pull)
    snapshotUsername: null,   // its name, kept for the sign-in guard after a sign-out
    snapshotUrl: '',          // the server it came from, and that server's id: ids
    snapshotServerId: null,   // start at 1 on every server, so the id alone is not enough
    treeVersion: 0,           // server tree version this working copy is based on
    serverIds: new Set(),     // ids of this copy's nodes the server has (last pull, push or filing)
    treeRev: 0,               // bumped on every change to the copy, for the share sheet's folder index
    pathIds: [],              // breadcrumb stack of folder identifiers (root, child, ...)
    dirty: false,             // unsaved local edits to the snapshot
    editCount: 0,             // how many, for "N unpushed edits"
    view: 'home',             // 'home' (search, pins, bookmark folders) | 'notes'
    nv: freshNv(),            // notes navigation: pane, scope, open note, editor draft
    keptDraft: null,          // an unsaved note's nv, set aside by a sign-out for that account's return
    proposals: [],            // pending LLM note proposals awaiting approval
    importers: [],            // configured import sources: [{id, provider, connected, items, ...}]
    importBatch: null         // pending #notes / #reorder import awaiting review: {kind:'notes',items}|{kind:'reorder',order}
};

const $ = (id) => document.getElementById(id);

function markDirty() {
    state.dirty = true;
    state.editCount++;
    state.treeRev++;
    scheduleCopySave();
}

function show(el) { if (el) el.classList.remove('hidden'); }
function hide(el) { if (el) el.classList.add('hidden'); }

function safeAddListener(id, event, cb) {
    const el = $(id);
    if (el) el.addEventListener(event, cb);
}

function setStatus(text) {
    const el = $('status');
    if (!el) return;
    el.textContent = text;
    if (text) {
        show(el);
    } else {
        hide(el);
    }
}

// Premium glassmorphic toast notification
// Mirror the server URL, session token and account into Cache Storage so the
// service worker can upload a share on its own the moment it arrives, and
// knows whose it is: workers cannot read localStorage, where the config
// actually lives. Called on every change, including sign-out and an expired
// session, which clear it — a stale token in here would keep working after
// you signed out.
const SW_CONFIG_CACHE = 'tp-config';
const SW_CONFIG_KEY = '/__tp_config';

async function mirrorConfigToSW() {
    if (!('caches' in window)) return;
    // Only the window holding the session localStorage has: a window still on
    // an older one never points the worker at its account, or signs it out.
    if (!holdsStoredSession()) return;
    try {
        const cache = await caches.open(SW_CONFIG_CACHE);
        const cfg = shareConfig();
        if (!cfg) {
            await cache.delete(SW_CONFIG_KEY);
            return;
        }
        await cache.put(SW_CONFIG_KEY, new Response(JSON.stringify(cfg), { headers: { 'Content-Type': 'application/json' } }));
    } catch (e) {
        // Not fatal: shares wait in the outbox until the app uploads them.
        console.warn('Could not mirror config to the service worker', e);
    }
}

function showToast(message) {
    const existing = document.getElementById('tp-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'tp-toast';
    toast.style.position = 'fixed';
    toast.style.bottom = '80px';
    toast.style.left = '50%';
    toast.style.transform = 'translateX(-50%)';
    toast.style.background = 'rgba(30, 41, 59, 0.95)';
    toast.style.color = '#f1f5f9';
    toast.style.padding = '12px 20px';
    toast.style.borderRadius = '12px';
    toast.style.border = '1px solid #334155';
    toast.style.boxShadow = '0 10px 30px rgba(0,0,0,0.5)';
    toast.style.backdropFilter = 'blur(12px)';
    toast.style.webkitBackdropFilter = 'blur(12px)';
    toast.style.fontSize = '0.88rem';
    toast.style.fontWeight = '500';
    toast.style.zIndex = '2000';
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
    toast.style.textAlign = 'center';
    toast.style.pointerEvents = 'none';
    toast.style.width = 'max-content';
    toast.style.maxWidth = 'calc(100vw - 32px)';
    toast.textContent = message;

    document.body.appendChild(toast);
    
    // Force layout reflow and trigger fade/slide up
    toast.offsetHeight;
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(-50%) translateY(-5px)';

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(-50%) translateY(5px)';
        setTimeout(() => toast.remove(), 200);
    }, 2500);
}

// --- Config ---
function configured() { return state.config.url && state.config.token; }

// Nobody signed in, nothing written. A copy kept over a sign-out, or still
// shown after a session expired, belongs to its account: whatever went into
// it now would go up with that account's next push. The same goes for the
// per-account lists on the phone, which signed out have no account to be
// kept under. Every way of changing either asks this first.
function signedOutRefuses(message = 'Sign in first — changes go into your account.') {
    if (configured()) return false;
    showToast(message);
    return true;
}

async function api(path, opts = {}) {
    if (!configured()) throw new Error('Server not configured. Open Settings.');
    const used = state.config.token;
    const res = await fetch(state.config.url.replace(/\/$/, '') + path, {
        ...opts,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + used,
            ...(opts.headers || {})
        }
    });
    if (res.status === 401) {
        // The session expired or was revoked — say so plainly and send the user
        // to sign in, rather than surfacing a bare 401 from somewhere deep in
        // the app. The worker's copy of the token goes too, or it would keep
        // posting shares with a dead one. Unpushed edits stay in memory. Only
        // that session: a request still on its way from before a sign-out
        // and another sign-in leaves the new one alone.
        if (state.config.token === used) {
            const stored = holdsStoredSession();
            state.config.token = '';
            if (stored) {
                localStorage.removeItem(LS.token);
                mirrorConfigToSW();
            }
            setStatus('Session expired — sign in again.');
            try { refreshAuthUi(); show($('settings-sheet')); } catch (e) { /* pre-DOM */ }
        }
        const err = new Error('Signed out');
        err.status = 401;
        throw err;
    }
    if (!res.ok) {
        const t = await res.text().catch(() => '');
        const err = new Error(`${res.status} ${res.statusText}: ${t}`);
        err.status = res.status;
        try { err.body = JSON.parse(t); err.code = err.body.code; } catch (e) { /* not JSON */ }
        throw err;
    }
    return res.json();
}

// --- Initial load ---
let booted = false;

async function bootstrap() {
    // Existing installs already hold a token in localStorage and will never
    // sign in again, so mirror on every start rather than only on change —
    // otherwise the worker has no config and every share waits for the app.
    mirrorConfigToSW();

    // An import link that opened the app is kept on the phone before anything
    // else can fail; it opens at the end, or waits for a sign-in or a pull.
    // It is nobody's until the server has said whose session this is: a
    // token kept from last time may have expired while the app was closed,
    // and then the link waits for whoever signs in next.
    const arrived = stashImportHash({ claim: false });

    // A share that opened the app is in the outbox (or, from the old
    // redirect, in the URL, and goes in there now) before anything else.
    await migrateLegacyShares();
    const shared = await handleShareEntry();

    // On the first start of this page: the working copy kept on the device,
    // so a reload, a share that reloaded the window, or the phone closing the
    // app, loses no unpushed edit or half-written note.
    // Later, after a sign-in: a copy with work in it kept for another
    // account, which has it back once that account is the one signing in.
    const restored = !booted || (foreignKeptCopy && configured()) ? await restoreTreeCache() : null;
    booted = true;

    // The sheet's pins and statistics as kept on the phone, before it draws:
    // its chips are drawn once and never reordered.
    await loadKeptShareData();
    if (shared) shareSheet.open(shared, { fromShare: true });

    if (!configured()) {
        setStatus(restored && restored.dirty
            ? `Restored unpushed changes from ${restored.at} — sign in as ${state.snapshotUsername || 'their account'} to push them.`
            : 'Open Settings (⚙) to configure your sync server.');
        if (arrived) showToast(SIGN_IN_TO_IMPORT);
        shareSheet.refreshInbox();
        return;
    }
    await refreshWhoAmI();
    if (!configured()) {
        // The server has just said the kept session is over (api() says so
        // and opens the sign-in): nothing to pull, and the link is nobody's.
        if (arrived) showToast(SIGN_IN_TO_IMPORT);
        return;
    }
    // Still signed in after asking the server: the session is this account's,
    // or the server could not be reached and the kept session stands until it
    // says otherwise. Only a rejected session (handled above) leaves the link
    // to whoever signs in next.
    if (arrived) claimPendingImport(arrived.id);
    // Shares waiting on the phone go up now (and those chosen offline are
    // filed), before the pull, so the pull brings them in. Those made while
    // nobody, or someone else, was signed in are asked about, never sent on
    // their own.
    await flushShares();
    await offerUnclaimedShares();
    // A pull replaces the working copy, so it never runs over unpushed edits
    // — after a sign-out and back in, or a reload, they are still here.
    if (state.dirty && state.snapshot) {
        renderView();
        setStatus(restored && restored.dirty
            ? `Restored unpushed changes from ${restored.at} — ⬆️ Push to keep them, or Pull to discard.`
            : 'You have unpushed edits from before you were signed out — Push to keep them, or Pull to discard.');
    } else if (restored && state.snapshot && copyIsMine()) {
        // A clean copy from the last time: on screen already; pulled only
        // when the server has moved on.
        renderView();
        try {
            const v = await api('/api/tree/version');
            const copy = state.snapshot;
            if (Number(v.version) !== state.treeVersion && state.snapshot === copy && !state.dirty) await pullSnapshot();
        } catch (e) { /* offline: the kept copy stands */ }
    } else {
        try { await pullSnapshot(); } catch (e) { /* status already set */ }
    }
    loadShareStats();
    loadSharePrefs();
    await refreshInbox();
    if (!shareSheet.isOpen()) await afterShareSheet();
    await openPendingImport({ id: arrived ? arrived.id : null, why: arrived ? 'arrived' : 'auto' });
}

// What waits while the share sheet is up: the proposals (which would redraw
// what is behind it) and the clipboard scan (Android shows a toast for it).
async function afterShareSheet() {
    await refreshProposals();
    await checkUnfiledLinks();
}

// Universal import link: /#note=<percent-encoded markdown>[&notebook=<name>]
// Used by LLM chats that cannot POST. The fragment never reaches the server;
// the note opens in the editor for review and is only stored when the user
// presses ✓ Done. A first-line "# " heading becomes the title, as usual.
// #notes= and #reorder= open a review block in the Notes library instead.
const IMPORT_HASH_RE = /^#(note|notes|reorder)=/;

// Every import link is kept on the phone the moment it arrives, before its
// fragment leaves the URL, and stays until it is imported or dismissed: when
// it cannot be opened right away (signed out, no copy pulled yet, offline, an
// account changing, another review or edit open) it waits for the next
// sign-in or pull. One tapped while an account is signed in is that
// account's (`account`), as is one opened for review under an account; it
// waits for that account alone, through a sign-out. One tapped while nobody
// is signed in goes to whoever signs in next: it came from a tap on this
// phone. So does one that opened the app, until the server has confirmed the
// session it found: a session that turns out expired is nobody's. Imported is
// not yet kept, either: what a link imports goes into the working copy, which
// lives in this page alone, so the link stays on the phone until a push that
// carries it succeeds (see copyImportIds). [{ id, hash, at, account }],
// oldest first.
const PENDING_IMPORT_KEY = 'tp_pending_import';
const SIGN_IN_TO_IMPORT = 'Sign in to import this link — it is kept on this phone until then.';

function pendingImports() {
    try {
        const list = JSON.parse(localStorage.getItem(PENDING_IMPORT_KEY) || '[]');
        return Array.isArray(list) ? list.filter(p => p && p.id && typeof p.hash === 'string') : [];
    } catch (e) {
        return [];
    }
}

function savePendingImports(list) {
    try {
        if (list.length) localStorage.setItem(PENDING_IMPORT_KEY, JSON.stringify(list));
        else localStorage.removeItem(PENDING_IMPORT_KEY);
    } catch (e) {
        console.warn('Could not update the pending import links', e);
    }
}

// Dismissed on purpose, or on the server now.
function dropPendingImport(id) {
    if (id) dropPendingImports([id]);
}

function dropPendingImports(ids) {
    if (ids.length) savePendingImports(pendingImports().filter(p => !ids.includes(p.id)));
}

// Tie a link that is nobody's yet to the account signed in now: it was
// opened for review under it, or it opened the app and the server has since
// confirmed the session. A link already some account's stays that one's.
function claimPendingImport(id) {
    const key = accountKey();
    if (!id || !key) return;
    savePendingImports(pendingImports().map(p => (p.id === id && !p.account ? { ...p, account: key } : p)));
}

// A kept link is for whoever is signed in when it is nobody's, or this
// account's: by its key, or by one an earlier build kept it under — the
// account id, or the name as stored for a session from before ids.
function pendingImportVisible(p) {
    if (!p.account) return true;
    const key = accountKey();
    if (!key) return false;
    if (p.account === key) return true;
    const base = key.slice(0, key.lastIndexOf('|name:'));
    const id = currentUserId();
    // A name that reads as a number could equal another account's id key,
    // so the name form only counts for names that cannot.
    const name = localStorage.getItem(LS.username) || '';
    return (id !== null && p.account === `${base}|${id}`)
        || (!/^\d+$/.test(name) && p.account === `${base}|${name}`);
}

// The links whose notes, batch or order are in this working copy but not on
// the server yet. They are kept on the copy itself, so they last exactly as
// long as it does: the push that carries them up drops them from the phone
// (pushSnapshot), and a pull or a discard that throws the copy away gives
// them back to the waiting block, since what they hold never got anywhere.
// Meanwhile they are neither waiting nor opened a second time.
function copyImportIds() {
    return (state.snapshot && state.snapshot._importIds) || [];
}

function holdImportInCopy(id) {
    if (!id || !state.snapshot) return;
    const ids = state.snapshot._importIds || (state.snapshot._importIds = []);
    if (!ids.includes(id)) ids.push(id);
}

// Pending links for whoever is here, other than the one under review and
// those already in this copy.
function waitingImports() {
    const open = new Set([
        state.importBatch && state.importBatch.importId,
        state.nv.editing && state.nv.importId,
        state.keptDraft && state.keptDraft.importId,
        ...copyImportIds()
    ].filter(Boolean));
    return pendingImports().filter(p => pendingImportVisible(p) && !open.has(p.id));
}

// Keep the URL's import link on the phone, then drop the fragment, so neither
// a reload nor back brings it round again. A link tapped while the app is open
// arrived as a history entry of its own; it takes over whatever is on screen,
// so back still behaves. Returns the kept link, or null when there was none —
// or nowhere to keep it, in which case the fragment stays where it is.
// `claim: false` keeps a new link nobody's, for a session not confirmed yet.
function stashImportHash({ claim = true } = {}) {
    const hash = location.hash;
    if (!IMPORT_HASH_RE.test(hash)) return null;
    let rec = null;
    try {
        const list = pendingImports();
        rec = list.find(p => p.hash === hash && pendingImportVisible(p)) || null;
        if (!rec) {
            const account = claim && configured() && !accountChanging ? accountKey() || null : null;
            rec = { id: newLocalId(), hash, at: new Date().toISOString(), account };
            localStorage.setItem(PENDING_IMPORT_KEY, JSON.stringify([...list, rec]));
        }
    } catch (e) {
        showToast('This link could not be kept on the phone — it stays in the address bar for now.');
        return null;
    }
    if (state.view === 'notes') {
        navDepth++;
        history.replaceState(nvHistoryState(), '', location.pathname);
    } else {
        history.replaceState(null, '', location.pathname);
    }
    return rec;
}

// A link tapped while the app is open.
async function processImportHashIfAny() {
    const rec = stashImportHash();
    if (rec) await openPendingImport({ id: rec.id, why: 'arrived' });
}

let openingImport = false;

// Open a pending link (the oldest, or `id`) for review, if there is somewhere
// to put it now: signed in, this account's copy pulled, no account change on
// its way and nothing else under review or being written. Otherwise it keeps
// waiting. `why`: 'arrived' (just tapped) and 'asked' (Review) say why not;
// the automatic tries after a sign-in or a pull keep quiet.
async function openPendingImport({ id = null, why = 'auto' } = {}) {
    const held = copyImportIds();
    if (id && held.includes(id)) {
        // Tapped again before the push that carries it got through.
        if (why !== 'auto') showToast('This link is in your notes already — ⬆️ Push to put it on the server.');
        return false;
    }
    const list = pendingImports().filter(p => pendingImportVisible(p) && !held.includes(p.id));
    const rec = id ? list.find(p => p.id === id) : list[0];
    if (!rec || openingImport) return false;
    const wait = (msg) => {
        if (why !== 'auto') {
            showToast(msg);
            if (state.view === 'notes') renderView(); // the waiting block
        }
        return false;
    };
    if (!configured()) return wait(SIGN_IN_TO_IMPORT);
    if (accountChanging || (unwindingAccount && why !== 'asked')) return false;
    if (!state.snapshot || !copyIsMine()) return wait('This link is kept on this phone — it opens after the next ⬇️ Pull.');
    // A note is reviewed in the editor, a batch or an order in the library's
    // review block: each waits only for its own place to be free.
    const busy = parseImportHash(rec.hash).kind === 'note'
        ? editorDirty() || Boolean(state.nv.editing && state.nv.importId)
        : Boolean(state.importBatch);
    if (busy) return wait('This link is kept on this phone — finish what is open, then review it in Notes.');
    openingImport = true;
    try {
        return await openImportReview(rec);
    } finally {
        openingImport = false;
    }
}

// The copy on screen is the signed-in account's. Always so while signed in;
// checked anyway before an import link is put into it.
function copyIsMine() {
    return state.snapshotUserId == null || currentUserId() == null
        || Number(state.snapshotUserId) === Number(currentUserId());
}

// What a link holds: { kind: 'note', content, notebook } | { kind: 'notes',
// items } | { kind: 'reorder', order }, or { error } when there is nothing in
// it to import.
function parseImportHash(hash) {
    const raw = String(hash || '').replace(/^#/, '');
    // Multi-note batch: #notes=<percent-encoded JSON array of {"content","notebook"?}>
    if (raw.startsWith('notes=')) {
        let items = null;
        try { items = JSON.parse(decodeURIComponent(raw.slice(6))); } catch (e) { /* invalid */ }
        if (!Array.isArray(items) || items.length === 0) return { error: 'Import link could not be decoded.' };
        const notes = items
            .filter(it => it && typeof it.content === 'string' && it.content.trim())
            .map(it => ({ content: it.content, notebook: typeof it.notebook === 'string' && it.notebook.trim() ? it.notebook.trim() : null }));
        if (notes.length === 0) return { error: 'Import link contained no notes.' };
        return { kind: 'notes', items: notes };
    }
    // Reorder: #reorder=<percent-encoded JSON array of note titles>
    if (raw.startsWith('reorder=')) {
        let order = null;
        try { order = JSON.parse(decodeURIComponent(raw.slice(8))); } catch (e) { /* invalid */ }
        order = Array.isArray(order) ? order.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim()) : [];
        if (order.length === 0) return { error: 'Reorder link could not be decoded.' };
        return { kind: 'reorder', order };
    }
    if (!raw.startsWith('note=')) return { error: 'Import link could not be decoded.' };
    let payload = raw.slice(5);
    let notebook = null;
    const nbIdx = payload.indexOf('&notebook=');
    if (nbIdx >= 0) {
        try { notebook = decodeURIComponent(payload.slice(nbIdx + 10)); } catch (e) { /* ignore */ }
        payload = payload.slice(0, nbIdx);
    }
    let content;
    try {
        content = decodeURIComponent(payload);
    } catch (e) {
        // LLMs are sloppy encoders — fall back to the raw payload so the user
        // can still review/fix it instead of losing the note.
        content = payload;
    }
    if (!content.trim()) return { error: 'Import link contained no note.' };
    return { kind: 'note', content, notebook };
}

// The usual review: the editor for a note, the review block for a batch or an
// order. A link with nothing in it is dropped, with a word why.
async function openImportReview(rec) {
    const link = parseImportHash(rec.hash);
    if (link.error) {
        dropPendingImport(rec.id);
        showToast(link.error);
        return false;
    }
    if (link.kind === 'notes' || link.kind === 'reorder') {
        state.importBatch = link.kind === 'notes'
            ? { kind: 'notes', items: link.items, importId: rec.id }
            : { kind: 'reorder', order: link.order, importId: rec.id };
        claimPendingImport(rec.id);
        // The review block lives in the Notes library.
        if (state.view === 'notes' && !state.nv.editing) openNotes({ pane: 'library' });
        else renderView();
        showToast(link.kind === 'notes' ? 'Review the import, then press Import.' : 'Review the new order, then press Apply.');
        return true;
    }

    const found = await ensureNotesFolder();
    if (!found) return false;
    // The notebook is resolved the same way the server and the extension do
    // (an exact top-level name, 'Parent / Child', a unique nested name), and
    // a missing one is only created on ✓ Done — nothing is saved or pushed
    // before the note has been reviewed.
    let parentId = null;
    let pendingNotebookName = null;
    if (link.notebook && link.notebook.trim()) {
        const res = NM.resolveNotebookByName(notesLibrary(), link.notebook);
        if (res && res.id) parentId = res.id;
        else if (res) pendingNotebookName = link.notebook.trim();
    }
    if (!(await startNewNote({ parentId, content: link.content, pendingNotebookName, importId: rec.id }))) return false;
    claimPendingImport(rec.id);
    showToast('Review the note, then press ✓ Done.');
    return true;
}

// A line for the waiting block: what the link holds.
function describePendingImport(p) {
    const link = parseImportHash(p.hash);
    if (link.kind === 'notes') return `📥 ${link.items.length} note${link.items.length === 1 ? '' : 's'}`;
    if (link.kind === 'reorder') return `🔀 New order for ${link.order.length} note${link.order.length === 1 ? '' : 's'}`;
    if (link.kind === 'note') return `📝 ${NM.leadingTitle(link.content) || 'Untitled'}`;
    return '🔗 Import link';
}

function renderPendingImportsBlock(list) {
    const block = document.createElement('div');
    block.className = 'proposals pending-imports';
    const heading = document.createElement('div');
    heading.className = 'proposals-title';
    heading.textContent = `🔗 Links waiting to be imported (${list.length})`;
    block.appendChild(heading);
    const now = Date.now();
    for (const p of list) {
        const when = NM.relativeTime(p.at, now);
        const arrived = when === 'now' ? 'just now'
            : /^\d+[mh]$/.test(when) ? `${when} ago`
                : when === 'Yesterday' ? 'yesterday' : when;
        const item = document.createElement('div');
        item.className = 'proposal pending-import';
        item.innerHTML = `
            <div class="proposal-text">
                <span class="title">${escapeHtml(describePendingImport(p))}</span>
                ${arrived ? `<span class="snippet">Arrived ${escapeHtml(arrived)}</span>` : ''}
            </div>
            <div class="proposal-actions">
                <button class="primary pending-import-review">Review</button>
                <button class="pending-import-dismiss">Dismiss</button>
            </div>
        `;
        item.querySelector('.pending-import-review').addEventListener('click', () => openPendingImport({ id: p.id, why: 'asked' }));
        item.querySelector('.pending-import-dismiss').addEventListener('click', () => dismissPendingImport(p));
        block.appendChild(item);
    }
    return block;
}

function dismissPendingImport(p) {
    if (!confirm(`Dismiss this link (${describePendingImport(p)})? It is not imported, and cannot be opened again.`)) return;
    dropPendingImport(p.id);
    renderView();
}

// --- Wire format <-> local shape ---
//
// The server's tree (GET/PUT /api/tree) speaks {id, kind:'folder'|'bookmark'|'note',
// title, url?, payload?, role?, virtual?} with no browser roots — just top-level
// folders. This app's rendering and editing code predates that and works on
// {type, title, url, children} nodes where a note is a bookmark whose url is a
// data:application/json payload. Rather than rewrite every view, the two shapes
// convert at the sync boundary: notes gain their data: url on the way in and
// give it back up on the way out, and server ids ride along as _pwaId so they
// survive a round trip unchanged.
function fromWire(node) {
    const out = { title: node.title || '', _pwaId: node.id };
    if (node.role) out._role = node.role;
    if (node.virtual || node.readOnly) out._virtual = true;
    // Payloads this app doesn't render (a workflow folder's createdAt, fields a
    // newer client added) must survive the round trip, or a push from the
    // phone would erase them server-wide for every device.
    if (node.payload) out._payload = node.payload;
    if (node.kind === 'bookmark') {
        out.type = 'bookmark';
        out.url = node.url;
    } else if (node.kind === 'note') {
        out.type = 'bookmark';
        out.url = encodeNoteUrl({
            content: (node.payload && node.payload.content) || '',
            createdAt: (node.payload && node.payload.createdAt) || null,
            updatedAt: (node.payload && node.payload.updatedAt) || null
        });
    } else {
        out.type = 'folder';
        out.children = (node.children || []).map(fromWire);
    }
    return out;
}

function toWire(node) {
    if (node._virtual) return null; // the imports subtree is never pushed back
    const id = node._pwaId || newLocalId();
    if (node.type === 'bookmark' && node.url && node.url.startsWith(NOTE_DATA_PREFIX)) {
        const meta = decodeNote(node);
        // Merge over the carried payload so fields this app doesn't know about
        // survive; the data: url only ever encodes these three.
        return { id, kind: 'note', title: node.title || '', payload: { ...(node._payload || {}), ...meta } };
    }
    if (node.type === 'bookmark') {
        const out = { id, kind: 'bookmark', title: node.title || '', url: node.url };
        if (node._payload) out.payload = node._payload;
        return out;
    }
    const out = { id, kind: 'folder', title: node.title || '' };
    if (node._role) out.role = node._role;
    if (node._payload) out.payload = node._payload;
    out.children = (node.children || []).map(toWire).filter(Boolean);
    return out;
}

// Pulls and pushes on their way, for a hand-over to another window to wait
// out (yieldCopy): what they bring back is this window's to write down.
let syncBusy = 0;

async function pullSnapshot() {
    syncBusy++;
    try {
        return await pullSnapshotOnce();
    } finally {
        syncBusy--;
    }
}

async function pullSnapshotOnce() {
    try {
        setStatus('Pulling…');
        const data = await api('/api/tree');
        // A wrapper node so the rest of the app keeps its "root with children"
        // navigation model; only its children are real.
        state.snapshot = { type: 'root', title: '', children: (data.roots || []).map(fromWire) };
        state.snapshotUserId = data.userId ?? currentUserId();
        state.snapshotUsername = localStorage.getItem(LS.username);
        state.snapshotUrl = state.config.url.replace(/\/$/, '');
        state.snapshotServerId = data.serverId || null;
        state.treeVersion = Number(data.version) || 0;
        state.pathIds = [getRootId(state.snapshot)];
        state.dirty = false;
        state.editCount = 0;
        state.serverIds = idsOf(data.roots || []);
        state.treeRev++;
        // Another copy now, as far as what is kept with it goes.
        copyMeta.copyId = DC.newId();
        noteSync('pull');
        renderView();
        saveTreeCache();
        if (shareSheet) shareSheet.refresh();
    } catch (e) {
        setStatus('Pull failed: ' + e.message);
        throw e;
    }
}

// Every id in a wire-format tree, the virtual archive's excepted.
function idsOf(roots) {
    const ids = new Set();
    const walk = (n) => {
        if (!n || n.virtual || n.readOnly) return;
        if (n.id) ids.add(String(n.id));
        (n.children || []).forEach(walk);
    };
    (roots || []).forEach(walk);
    return ids;
}

async function refreshInbox() {
    if (shareSheet) await shareSheet.refreshInbox();
}

async function refreshProposals() {
    try {
        const data = await api('/api/proposals');
        const before = state.proposals.length;
        state.proposals = data.proposals || [];
        // They arrive after the first paint: Home's banner and the library's
        // pending block need a redraw when the count changed.
        if (state.snapshot && state.proposals.length !== before) renderView();
        else syncBottomNav();
    } catch (e) {
        console.warn('Proposals fetch failed', e);
    }
}

// --- Snapshot navigation ---
// The snapshot is the same shape as the extension's bookmark export:
//   { version, type:'root'|'folder', title, children: [{type:'folder', title, children:[...]}, {type:'bookmark', url, title}] }
// We synthesize a stable "id" per node so we can navigate it.

function getRootId(snap) { return assignIds(snap); }

// Random rather than a counter: these ids are pushed to the server as the
// node's permanent identity, and a counter would hand two different nodes the
// same id across sessions.
function newLocalId() {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function assignIds(node) {
    if (!node._pwaId) node._pwaId = newLocalId();
    if (node.children) node.children.forEach(assignIds);
    return node._pwaId;
}

function findNodeByPath(pathIds) {
    if (!state.snapshot || pathIds.length === 0) return null;
    if (pathIds[0] !== state.snapshot._pwaId) return null;
    let cur = state.snapshot;
    for (let i = 1; i < pathIds.length; i++) {
        const next = (cur.children || []).find(c => c._pwaId === pathIds[i]);
        if (!next) return null;
        cur = next;
    }
    return cur;
}

// --- Render ---
// What the last render showed, so a pane change can manage scrolling.
let lastRender = { view: 'home', pane: null, noteId: null, scope: null };
const nvScroll = { library: 0, list: 0, listScope: null };

function renderView() {
    setStatus('');
    const notes = state.view === 'notes';
    const prev = lastRender;
    const cur = { view: state.view, pane: state.nv.pane, noteId: state.nv.noteId, scope: state.nv.scope };
    const desktop = isDesktop();

    // A phone scrolls the page itself: remember where the pane being left was.
    if (!desktop && prev.view === 'notes' && (cur.view !== 'notes' || prev.pane !== cur.pane)) {
        if (prev.pane === 'library') nvScroll.library = window.scrollY;
        if (prev.pane === 'list') { nvScroll.list = window.scrollY; nvScroll.listScope = prev.scope; }
    }
    // A desktop scrolls each pane on its own: keep them through the rebuild.
    const paneScroll = {};
    if (desktop && notes && prev.view === 'notes') {
        for (const p of ['side', 'list', 'note']) {
            const el = document.querySelector(`.nv-${p}`);
            if (el) paneScroll[p] = el.scrollTop;
        }
    }

    document.body.classList.toggle('view-notes', notes);
    for (const p of ['library', 'list', 'note']) document.body.classList.toggle(`pane-${p}`, notes && cur.pane === p);
    document.body.classList.toggle('nv-editing', notes && state.nv.editing);
    renderBreadcrumb();
    renderContent();
    updateInboxFab();
    updatePushBtnState();
    syncBottomNav();

    if (notes) {
        const paneChanged = prev.view !== 'notes' || prev.pane !== cur.pane;
        const noteChanged = cur.pane === 'note' && prev.noteId !== cur.noteId;
        if (desktop) {
            const set = (p, y) => { const el = document.querySelector(`.nv-${p}`); if (el && y) el.scrollTop = y; };
            set('side', paneScroll.side);
            if (prev.scope === cur.scope) set('list', paneScroll.list);
            if (!noteChanged && prev.noteId === cur.noteId) set('note', paneScroll.note);
        } else if (paneChanged || noteChanged) {
            // An opened note starts at its top, with its toolbar on screen;
            // back from a note lands where the list was.
            let y = 0;
            if (cur.pane === 'list' && prev.pane === 'note' && nvScroll.listScope === cur.scope) y = nvScroll.list;
            else if (cur.pane === 'library' && prev.view === 'notes') y = nvScroll.library;
            window.scrollTo(0, y);
        }
    } else if (prev.view === 'notes') {
        window.scrollTo(0, 0);
    }
    lastRender = cur;
}

function updatePushBtnState() {
    const pushBtn = $('pushBtn');
    if (!pushBtn) return;
    if (state.dirty) {
        pushBtn.classList.add('dirty');
        pushBtn.title = "Push latest snapshot (pending local changes! ⬆️)";
    } else {
        pushBtn.classList.remove('dirty');
        pushBtn.title = "Push latest snapshot to server ⬆️";
    }
}

function renderBreadcrumb() {
    const bc = $('breadcrumb');
    if (!bc) return;
    bc.innerHTML = '';
    state.pathIds.forEach((id, idx) => {
        const node = findNodeByPath(state.pathIds.slice(0, idx + 1));
        if (!node) return;
        const a = document.createElement('a');
        a.href = '#';
        a.textContent = node.title || (idx === 0 ? 'Bookmarks' : '(unnamed)');
        a.addEventListener('click', (e) => {
            e.preventDefault();
            state.pathIds = state.pathIds.slice(0, idx + 1);
            renderView();
        });
        bc.appendChild(a);
        if (idx < state.pathIds.length - 1) {
            const sep = document.createElement('span');
            sep.className = 'sep';
            sep.textContent = '›';
            bc.appendChild(sep);
        }
    });
}

function renderContent() {
    const root = $('content');
    if (!root) return;
    root.innerHTML = '';
    // Signed out with a copy kept for its account: it waits for that account
    // and is not for whoever picks up the phone to browse meanwhile. An
    // expired session still knows its user, and keeps showing their copy.
    if (state.snapshot && !state.config.token && !localStorage.getItem(LS.username)) {
        root.classList.remove('in-imports');
        root.innerHTML = '<div class="empty">Signed out — open Settings (⚙) to sign in.</div>';
        return;
    }
    if (state.view === 'notes') {
        renderNotesScreen(root);
        return;
    }
    const node = findNodeByPath(state.pathIds);
    if (!node) {
        // No snapshot yet (offline start, failed pull): Home is reachable
        // from Notes all the same, so say what is missing.
        const why = state.snapshot ? 'Folder not found.'
            : configured() ? 'Nothing loaded yet — use ⬇️ Pull once the server is reachable.'
                : 'Open Settings (⚙) to configure your sync server.';
        root.innerHTML = `<div class="empty">${why}</div>`;
        return;
    }
    // A path into the notes folder (left over from before Notes had a screen
    // of its own) opens Notes instead of drawing notes as bookmark rows.
    if (isNotesFolder(node)) {
        state.pathIds = [state.snapshot._pwaId];
        state.view = 'notes';
        queueMicrotask(renderView);
        return;
    }
    // Everything under the imports root is server-managed: the sweep rebuilds
    // it, and moving or deleting in here is read back and acted on rather than
    // being a local edit like anywhere else. Tint the whole view so that is
    // obvious before someone starts rearranging.
    const inImports = isInsideImports();
    root.classList.toggle('in-imports', inImports);
    if (inImports) {
        const note = document.createElement('div');
        note.className = 'imports-note';
        note.innerHTML = '<strong>Import archive.</strong> This folder is drawn straight from the '
            + 'server\'s archive on every pull, so nothing can be filed into it and it is read-only here. '
            + 'Use the desktop app to file or delete archived items.';
        root.appendChild(note);
    }
    const children = node.children || [];
    // App-managed folders are not shown among the bookmarks — notes get their
    // own section, pins get the home tiles, workflows get their own section.
    const atRoot = state.pathIds.length === 1;
    const folders = children.filter(c => (c.type === 'folder' || c.type === 'root')
        && !isNotesFolder(c) && !isPinsFolder(c) && !isWorkflowsFolder(c)
        && !(atRoot && isNoiseRoot(c)));
    const bookmarks = children.filter(c => c.type === 'bookmark' && c.url && !isInternalNode(c));

    // Search and pins lead the root view — the landing state, same as the
    // extension's home screen.
    if (state.pathIds.length === 1) {
        renderHome(root);
    }

    if (folders.length === 0 && bookmarks.length === 0 && state.pathIds.length > 1) {
        root.innerHTML = '<div class="empty">Empty folder.</div>';
        return;
    }

    folders.forEach(f => root.appendChild(renderFolderRow(f)));
    bookmarks.forEach(b => root.appendChild(renderBookmarkRow(b)));

    if (state.pathIds.length === 1) {
        renderWorkflowsSection(root);
    }
}

// Imported bookmarks live under this root, written by the server's importers.
const IMPORTS_ROOT_TITLE = 'TabPaladin Imports';

function isImportsFolder(node) {
    // The virtual flag is authoritative (it is what the push-side strip keys
    // on); the title check remains as a fallback for the root row.
    return node && node.type === 'folder' && (node._virtual || node.title === IMPORTS_ROOT_TITLE);
}

// Is the folder currently being viewed the imports root, or inside it?
function isInsideImports() {
    return state.pathIds.some((_, idx) => {
        const node = findNodeByPath(state.pathIds.slice(0, idx + 1));
        return isImportsFolder(node);
    });
}

// Guard for anything that would write into the folder currently open. Nothing
// may be filed into the archive: the next sweep rebuilds that subtree from the
// server's own records, so a bookmark added here is moved back out at best and
// deleted at worst. Refusing up front beats explaining afterwards.
function blockedByImports(action = 'add anything') {
    if (!isInsideImports()) return false;
    showToast(`Can't ${action} here — this folder is the import archive and is read-only.`);
    return true;
}

function renderFolderRow(folder) {
    const row = document.createElement('div');
    row.className = 'row folder' + (isImportsFolder(folder) ? ' imports-root' : '');
    const subfolders = (folder.children || []).filter(c => c.type === 'folder');
    const bms = (folder.children || []).filter(c => c.type === 'bookmark' && !isInternalNode(c));
    row.innerHTML = `
        <span class="icon">${isImportsFolder(folder) ? '📥' : '📁'}</span>
        <span class="title">${escapeHtml(folder.title || '(unnamed)')}</span>
        ${isImportsFolder(folder) ? '<span class="imports-badge">synced</span>' : ''}
        <span class="count">${subfolders.length} 📁 · ${bms.length} 📄</span>
    `;
    row.addEventListener('click', () => {
        state.pathIds = [...state.pathIds, folder._pwaId];
        renderView();
    });
    return row;
}

// Only an http(s) bookmark is a link. Anything else (a javascript:
// bookmarklet from a browser import, a file: or data: URL) is shown as text,
// so tapping it can neither run script here nor open what a page may not.
function renderBookmarkRow(b) {
    const row = document.createElement('div');
    row.className = 'row bookmark';
    const href = NM.safeHref(b.url);
    let domain = '';
    try { if (href) domain = new URL(href).hostname.replace(/^www\./, ''); } catch (e) {}
    if (domain) {
        const img = document.createElement('img');
        img.alt = '';
        img.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`;
        row.appendChild(img);
    } else {
        row.appendChild(nvEl('span', 'icon', '🔖'));
    }
    if (href) {
        const a = nvEl('a', null, b.title || b.url);
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener';
        row.appendChild(a);
    } else {
        const text = nvEl('span', 'bookmark-inert', b.title || b.url);
        text.title = `Not a web link, so it does not open from here: ${String(b.url).slice(0, 200)}`;
        row.appendChild(text);
    }
    return row;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// --- Notes ---
// Notes live in the "TabPaladin Notes" folder as bookmarks whose url is a
// data:application/json payload — same format the extension writes.
const NOTES_ROOT_TITLE = 'TabPaladin Notes';
const NOTE_DATA_PREFIX = 'data:application/json,';

// Pinned links. Mirrors src/utils/pinsManager.js on the extension side — same
// folder title, same plain-bookmark storage — but read from the synced snapshot
// instead of chrome.bookmarks, because the PWA has no bookmarks API. Like the
// notes root, the PWA never creates it: pin something on the computer first.
const PINS_ROOT_TITLE = 'TabPaladin Pinned';
const DDG = 'https://duckduckgo.com/?q=';

// Top-level roots not worth browsing on a phone.
//
// Push used to send only the folders you had focused; it now sends the whole
// tree, which is what makes a round trip lossless — but it also means every
// browser root reaches the snapshot. On Opera that is Trash, Speed Dials,
// Pinboard and friends, so the phone opened onto a wall of folders that are
// not bookmarks. Hidden at the root only: navigate into one deliberately and
// its contents still show.
const NOISE_ROOTS = new Set([
    'trash', 'prullenbak', 'papierkorb', 'corbeille',
    'speed dials', 'speeddial', 'pinboard', 'unsynchronized pinboard',
    'imported bookmarks', 'geïmporteerde bladwijzers'
]);

function isNoiseRoot(node) {
    const t = (node.title || '').toLowerCase().trim();
    if (NOISE_ROOTS.has(t)) return true;
    // An empty root is a row that does nothing.
    return (node.children || []).length === 0;
}

function isPinsFolder(node) {
    return node && (node.type === 'folder' || node.type === 'root')
        && (node._role === 'pins' || node.title === PINS_ROOT_TITLE);
}

function findPinsFolder() {
    if (!state.snapshot) return null;
    for (const rootChild of state.snapshot.children || []) {
        if (isPinsFolder(rootChild)) return rootChild;
        for (const c of rootChild.children || []) {
            if (isPinsFolder(c)) return c;
        }
    }
    return null;
}

function hostOf(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch (e) {
        return '';
    }
}

function initialsFor(title, url) {
    const source = (title || hostOf(url) || '?').trim();
    const words = source.split(/[\s._-]+/).filter(Boolean);
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
    return source.slice(0, 2).toUpperCase();
}

// Same hash as the extension so a pin keeps its colour across devices.
function colorFor(url) {
    const key = hostOf(url) || url || '';
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
    if (h > 25 && h < 45) h = (h + 60) % 360;
    return `hsl(${h} 55% 42%)`;
}

// A bare domain goes to the site; anything with a space, or without a dot, is
// a query. Same rule as the extension's home screen. A typed http(s) URL
// opens as it is; any other scheme is searched for, never opened.
function searchTargetFor(text) {
    const t = String(text || '').trim();
    if (!t) return null;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) && NM.safeHref(t)) return NM.safeHref(t);
    if (!/\s/.test(t) && /^[^.]+\.[^.]{2,}/.test(t) && NM.safeHref('https://' + t)) return 'https://' + t;
    return DDG + encodeURIComponent(t);
}

// Every page this app opens goes through here: only an http(s) URL (see
// NM.safeHref), always in a new tab that cannot reach back into this one
// (noopener, which the app's Cross-Origin-Opener-Policy also relies on).
// Returns what window.open did, or null for a refused URL.
function openExternal(url) {
    const href = NM.safeHref(url);
    if (!href) return null;
    return window.open(href, '_blank', 'noopener');
}

// One source, fetched the way the bookmark rows on this page already fetch
// theirs: a plain <img src> pointed at Google's service. Mirrors
// src/app/home.js exactly — no source chain, nothing deferring the load.
//
// The coloured initials sit in their own element behind the icon, and a loaded
// icon hides them by putting .has-icon on the container — CSS does the hiding,
// nothing is removed from the DOM. That separation is deliberate: the initials
// used to be text directly on the container, so hiding them meant
// favEl.textContent = '', which removes *every* child including the <img>. The
// icon deleted itself the instant it loaded and the tile went blank.
function attachFavicon(favEl, pageUrl) {
    let host = '';
    try {
        host = new URL(pageUrl).hostname;
    } catch (e) {
        return; // unparseable — initials only
    }
    if (!host.includes('.')) return;

    const img = document.createElement('img');
    img.className = 'pin-favimg';
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    // Initials are a better fallback than a broken-image glyph on top of them.
    img.addEventListener('error', () => img.remove());
    img.addEventListener('load', () => favEl.classList.add('has-icon'));
    img.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;

    favEl.appendChild(img);
}

function renderHome(root) {
    const wrap = document.createElement('div');
    wrap.className = 'home-block';

    const search = document.createElement('div');
    search.className = 'home-search';
    search.innerHTML =
        '<span class="home-search-mark" aria-hidden="true">Q</span>' +
        '<input id="homeSearchInput" type="search" autocomplete="off" spellcheck="false" ' +
        'placeholder="Search DuckDuckGo" aria-label="Search DuckDuckGo">';
    search.querySelector('input').addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const target = searchTargetFor(e.target.value);
        if (!target) return;
        e.target.value = '';
        e.target.blur();
        openExternal(target);
    });
    wrap.appendChild(search);

    const pinsFolder = findPinsFolder();
    // isInternalNode keeps the __tabpaladin_root__ identity marker out — it
    // lives in this folder and is a bookmark, so it was showing up as a pin.
    const pins = (pinsFolder?.children || [])
        .filter(c => c.type === 'bookmark' && c.url && !isInternalNode(c));
    if (pins.length) {
        const head = document.createElement('div');
        head.className = 'home-head';
        head.textContent = 'Pinned';
        wrap.appendChild(head);

        const grid = document.createElement('div');
        grid.className = 'pins-grid';
        for (const p of pins) {
            // A pin saved as a bare host has no scheme, and a scheme-less href
            // resolves against this app's origin instead of the web. Only an
            // http(s) pin is a link; any other scheme is an inert tile.
            const raw = String(p.url).trim();
            const href = NM.safeHref(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
            const tile = document.createElement(href ? 'a' : 'span');
            tile.className = 'pin-tile' + (href ? '' : ' pin-inert');
            if (href) {
                tile.href = href;
                tile.target = '_blank';
                tile.rel = 'noopener';
            }
            // Icon only. The name lives in title/aria-label so the tile is
            // still identifiable on hover and to a screen reader — a row of
            // unlabelled squares would otherwise be unusable without sight.
            const label = p.title || hostOf(p.url) || p.url;
            tile.title = label;
            tile.setAttribute('aria-label', label);

            const fav = document.createElement('span');
            fav.className = 'pin-fav';

            // Own element, not text on the container, so hiding it can never
            // take the icon with it. The tile colour rides on the initials
            // rather than the container for the same reason: it has to
            // disappear together with them.
            const initials = document.createElement('span');
            initials.className = 'pin-initials';
            initials.style.background = colorFor(p.url);
            initials.textContent = initialsFor(p.title, p.url);
            fav.appendChild(initials);

            // Initials show through if the icon never arrives.
            if (href) attachFavicon(fav, href);
            tile.appendChild(fav);
            grid.appendChild(tile);
        }
        wrap.appendChild(grid);
    }

    // Quick actions. Most delegate to the existing topbar/menu buttons rather
    // than re-implementing their handlers — the phone gets bigger targets for
    // the same things, and there is still one code path per action.
    const actionsHead = document.createElement('div');
    actionsHead.className = 'home-head';
    actionsHead.textContent = 'Quick actions';
    wrap.appendChild(actionsHead);

    const actions = document.createElement('div');
    actions.className = 'home-actions';
    const ACTIONS = [
        { label: '+ New note', cls: 'a-notes', run: () => startNewNote({ parentId: null, from: 'Home' }) },
        { label: '📥 Inbox', cls: 'a-clip', delegate: 'clipBtn' },
        { label: '⬇️ Pull', cls: 'a-pull', delegate: 'pullBtn' },
        { label: '⬆️ Push', cls: 'a-push', delegate: 'pushBtn' }
    ];
    for (const a of ACTIONS) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'home-action ' + a.cls;
        btn.textContent = a.label;
        btn.addEventListener('click', () => {
            if (a.run) { a.run(); return; }
            const target = document.getElementById(a.delegate);
            if (target) target.click();
        });
        actions.appendChild(btn);
    }
    wrap.appendChild(actions);

    // Proposals and imports wait in Notes; say so here.
    const pending = [];
    if (state.proposals.length) {
        pending.push(`${state.proposals.length} note${state.proposals.length === 1 ? '' : 's'} waiting for approval`);
    }
    if (state.importBatch) pending.push('an import waiting for review');
    const waiting = waitingImports().length;
    if (waiting) pending.push(`${waiting} link${waiting === 1 ? '' : 's'} waiting to be imported`);
    if (pending.length) {
        const banner = document.createElement('button');
        banner.type = 'button';
        banner.className = 'home-pending';
        const text = pending.join(' · ');
        banner.textContent = `${text.charAt(0).toUpperCase()}${text.slice(1)} · Review ›`;
        banner.addEventListener('click', () => openNotes({ pane: 'library' }));
        wrap.appendChild(banner);
    }

    // Recent notes: the three most recently edited, from any notebook depth.
    // Notes has its own screen now; this is only the way back into the latest.
    const lib = notesLibrary();
    if (lib.notes.length) {
        const head = document.createElement('div');
        head.className = 'home-head home-head-row';
        head.innerHTML = `<span>Recent notes</span><button type="button" class="home-head-link">All ${lib.notes.length} ›</button>`;
        head.querySelector('button').addEventListener('click', () => {
            openNotes({ pane: 'list', scope: 'all', query: '', noteId: null });
        });
        wrap.appendChild(head);

        const panel = document.createElement('div');
        panel.className = 'home-panel recent-notes';
        const now = Date.now();
        for (const n of NM.sortNotes(lib.notes, 'edited').slice(0, 3)) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'recent-note';
            row.innerHTML =
                `<span class="rn-top"><span class="rn-title${n.title ? '' : ' untitled'}">${escapeHtml(n.title || 'Untitled')}</span>`
                + `<span class="rn-time">${escapeHtml(NM.relativeTime(n.updatedAt, now))}</span></span>`
                + `<span class="rn-bottom"><span class="rn-preview">${escapeHtml(n.preview)}</span>${taskPillHtml(n.tasks)}</span>`;
            row.addEventListener('click', () => openNoteById(n.id, { from: 'Home' }));
            panel.appendChild(row);
        }
        wrap.appendChild(panel);
    }

    root.appendChild(wrap);
}

function isNotesFolder(node) {
    return node && (node.type === 'folder' || node.type === 'root')
        && (node._role === 'notes' || node.title === NOTES_ROOT_TITLE);
}

// --- Workflows: saved tab sessions, now first-class in the web app ---
//
// A workflow is a folder under the workflows root whose bookmark children are
// the saved tabs. The web app can't capture open tabs (that needs the
// extension's tabs API), but it can list, open and delete what's saved — which
// is the part that matters on a machine without the extension.
const WORKFLOWS_ROOT_TITLE = 'TabPaladin Workflows';

function isWorkflowsFolder(node) {
    return node && (node.type === 'folder' || node.type === 'root')
        && (node._role === 'workflows' || node.title === WORKFLOWS_ROOT_TITLE);
}

function findWorkflowsRoot() {
    if (!state.snapshot) return null;
    const walk = (node) => {
        for (const c of node.children || []) {
            if (c.type !== 'folder' && c.type !== 'root') continue;
            if (isWorkflowsFolder(c)) return c;
            const hit = walk(c);
            if (hit) return hit;
        }
        return null;
    };
    return walk(state.snapshot);
}

function workflowTabs(folder) {
    return (folder.children || []).filter(c =>
        c.type === 'bookmark' && c.url && !c.url.startsWith(NOTE_DATA_PREFIX) && !isInternalNode(c));
}

// One user gesture is usually allowed one popup; the rest need the user to
// allow pop-ups for this site once. Count what got through and say so. A tab
// that is not an http(s) page (file:, a browser's own pages) is not opened
// from here at all.
function openWorkflowTabs(folder) {
    const all = workflowTabs(folder);
    if (!all.length) { showToast('This workflow has no tabs.'); return; }
    const tabs = all.filter(t => NM.safeHref(t.url));
    const skipped = all.length - tabs.length;
    let opened = 0;
    for (const t of tabs) {
        const w = openExternal(t.url);
        if (w) opened++;
    }
    if (skipped) {
        showToast(`Opened ${tabs.length} of ${all.length} — ${skipped} ${skipped === 1 ? 'is not a web page' : 'are not web pages'} and cannot be opened from here.`);
    } else if (opened < tabs.length) {
        showToast(`Opened ${opened} of ${tabs.length} — allow pop-ups for this site to open all at once.`);
    }
}

function renderWorkflowsSection(root) {
    const wfRoot = findWorkflowsRoot();
    if (!wfRoot) return;
    const workflows = (wfRoot.children || []).filter(c => c.type === 'folder');
    if (!workflows.length) return;

    const section = document.createElement('div');
    section.className = 'notes-section workflows-section';

    const header = document.createElement('div');
    header.className = 'notes-section-header';
    const title = document.createElement('h2');
    title.textContent = '🛡️ Workflows';
    header.appendChild(title);
    section.appendChild(header);

    for (const wf of workflows) {
        const tabs = workflowTabs(wf);
        const row = document.createElement('div');
        row.className = 'row workflow-row';
        row.innerHTML = `
            <span class="icon">🛡️</span>
            <span class="title">${escapeHtml(wf.title || '(unnamed)')}</span>
            <span class="count">${tabs.length} tab${tabs.length === 1 ? '' : 's'}</span>
            <button class="wf-open primary" title="Open all tabs">▶ Open</button>
            <button class="wf-del" title="Delete workflow">🗑</button>
        `;
        row.querySelector('.wf-open').addEventListener('click', (e) => {
            e.stopPropagation();
            openWorkflowTabs(wf);
        });
        row.querySelector('.wf-del').addEventListener('click', async (e) => {
            e.stopPropagation();
            if (signedOutRefuses()) return;
            if (!confirm(`Delete workflow "${wf.title}" (${tabs.length} tabs)?`)) return;
            wfRoot.children = (wfRoot.children || []).filter(c => c !== wf);
            markDirty();
            renderView();
            try {
                setStatus('Saving…');
                await pushSnapshot();
                showToast('Workflow deleted.');
                setStatus('');
            } catch (err) {
                setStatus('');
                showToast('Delete failed: ' + err.message + ' — use ⬆️ to retry.');
            }
        });
        section.appendChild(row);
    }
    root.appendChild(section);
}

// TabPaladin's own sentinels: the per-workflow meta record and the root
// identity marker. Bookkeeping, never shown as bookmarks.
function isInternalNode(node) {
    return !!node && (node.title === '__tabpaladin_meta__' || node.title === '__tabpaladin_root__');
}

function isNoteBookmark(b) {
    return b && b.type === 'bookmark' && typeof b.url === 'string'
        && b.url.startsWith(NOTE_DATA_PREFIX)
        && b.title !== '__tabpaladin_meta__'
        // Root-identity marker written by the extension — bookkeeping, not a note.
        && b.title !== '__tabpaladin_root__';
}

// Memoised by the url string: the notes screen reads every note on each
// render, and a few hundred decodeURIComponent + JSON.parse calls per tap add
// up on a phone. Callers get a copy, so the cache cannot be edited through it.
const decodedNoteUrls = new Map();

function decodeNote(b) {
    let hit = decodedNoteUrls.get(b.url);
    if (!hit) {
        try {
            const p = JSON.parse(decodeURIComponent(b.url.slice(NOTE_DATA_PREFIX.length)));
            hit = { content: p.content || '', createdAt: p.createdAt || null, updatedAt: p.updatedAt || null };
        } catch (e) {
            hit = { content: '', createdAt: null, updatedAt: null };
        }
        if (decodedNoteUrls.size > 2000) decodedNoteUrls.clear();
        decodedNoteUrls.set(b.url, hit);
    }
    return { ...hit };
}

function encodeNoteUrl({ content, createdAt, updatedAt }) {
    return NOTE_DATA_PREFIX + encodeURIComponent(JSON.stringify({ v: 1, content, createdAt, updatedAt }));
}

// Locate the notes folder anywhere in the tree, with its path. A full search,
// not a fixed-depth one: missing a root the user moved deeper is what would
// make ensureNotesFolder create a duplicate.
function findNotesFolderWithPath() {
    if (!state.snapshot) return null;
    const walk = (node, path) => {
        for (const c of node.children || []) {
            if (c.type !== 'folder' && c.type !== 'root') continue;
            if (isNotesFolder(c)) return { node: c, path: [...path, c._pwaId] };
            const hit = walk(c, [...path, c._pwaId]);
            if (hit) return hit;
        }
        return null;
    };
    return walk(state.snapshot, [state.snapshot._pwaId]);
}

// Locate the notes folder, pulling the tree first if there is none yet.
// Returns { node, path }, or null when there is no tree to look in. A missing
// folder is only created with { create: true }, by the saves, right before
// they mark the copy dirty: opening an editor or a name prompt and cancelling
// must leave nothing behind to push. Without it, a missing folder comes back
// as { node: null, path: null }.
async function ensureNotesFolder({ create = false } = {}) {
    if (!configured()) {
        showToast('Please open settings (⚙) first.');
        return null;
    }
    if (!state.snapshot) {
        showToast('Loading snapshot first…');
        try {
            await pullSnapshot();
        } catch (err) {
            showToast('Failed to pull snapshot: ' + err.message);
            return null;
        }
    }
    if (!state.snapshot) return null;

    const existing = findNotesFolderWithPath();
    if (existing) return existing;
    if (!create) return { node: null, path: null };

    // Safe to create now: the notes root is identified by its role, so there
    // is no title-guessing and no duplicate-roots hazard. Created locally, as
    // part of the save that asked for it: that save marks the copy dirty and
    // pushes, and the root goes with it.
    const nb = { type: 'folder', title: NOTES_ROOT_TITLE, _role: 'notes', children: [] };
    assignIds(nb);
    state.snapshot.children = state.snapshot.children || [];
    state.snapshot.children.push(nb);
    return findNotesFolderWithPath();
}

// --- Notes screen -------------------------------------------------------------
//
// Notebook-first, the same three panes as the extension's notes page:
//   library — All notes / Open tasks / Unfiled, then the notebook tree at any
//             depth with its fold state remembered on this device
//   list    — the scope's notes by last edit, with plain-text previews, task
//             progress and scoped search
//   note    — the note itself, read or edit
// A phone shows one pane at a time and drills through them with real history
// entries, so Android back walks note > list > library > Home. From 900px the
// panes sit side by side — same DOM, CSS only.
//
// Tree, counts, previews, search and the title rule all come from
// notesModel.js, the byte-identical twin of the extension's copy, so both
// clients agree on every one of them.

const NV_UI = { expanded: new Set(), sort: 'edited', prefs: NM.defaultNotesUi() };

function notesStorage() {
    try { return window.localStorage; } catch (e) { return null; }
}

function loadNotesPrefs() {
    const p = NM.readNotesUi(notesStorage());
    NV_UI.expanded = new Set(p.expanded);
    NV_UI.sort = p.sort;
    NV_UI.prefs = p;
}

// Per device, never synced. The mode field belongs to the extension's
// Read/Edit/Split and is carried through untouched.
function saveNotesPrefs() {
    const prev = NM.readNotesUi(notesStorage());
    NM.writeNotesUi(notesStorage(), {
        ...prev,
        expanded: [...NV_UI.expanded],
        sort: NV_UI.sort,
        scope: state.nv.scope,
        noteId: state.nv.noteId || prev.noteId
    });
}

function isFolderNode(n) {
    return Boolean(n) && (n.type === 'folder' || n.type === 'root');
}

// How notesModel reads this app's nodes: folders, note bookmarks, _pwaId.
const NOTES_ADAPTER = {
    children: (n) => n.children || [],
    isFolder: isFolderNode,
    isNote: isNoteBookmark,
    id: (n) => n._pwaId,
    title: (n) => n.title || '',
    fields: (n) => decodeNote(n)
};

function notesLibrary() {
    const found = findNotesFolderWithPath();
    return found ? NM.buildLibrary(found.node, NOTES_ADAPTER) : NM.emptyLibrary();
}

// A node anywhere under the notes root: { node, parent, index }, or null.
function findNotesNode(id) {
    const found = findNotesFolderWithPath();
    if (!found || !id) return null;
    const walk = (folder) => {
        const kids = folder.children || [];
        for (let i = 0; i < kids.length; i++) {
            if (kids[i]._pwaId === id) return { node: kids[i], parent: folder, index: i };
            if (isFolderNode(kids[i])) {
                const hit = walk(kids[i]);
                if (hit) return hit;
            }
        }
        return null;
    };
    return walk(found.node);
}

// Every notes write goes through here: mark the copy dirty and push it, with
// the usual 409 dialog. The phone's working copy lives only in memory, so a
// note kept here unpushed would be gone after a reload — that is why notes
// push in the same step, unlike the extension. One helper, so changing that
// is a change in one place.
async function commitNotesEdit(label = 'Saving…', doneToast = '') {
    markDirty();
    updatePushBtnState();
    try {
        setStatus(label);
        await pushSnapshot();
        setStatus('');
        if (doneToast) showToast(doneToast);
        return true;
    } catch (e) {
        setStatus('');
        showToast(`Push failed: ${e.message} — kept on this phone, use ⬆️ to retry.`);
        return false;
    } finally {
        updatePushBtnState();
        syncBottomNav();
    }
}

// --- navigation ---

function freshNv() {
    return {
        pane: 'library',          // 'library' | 'list' | 'note'
        scope: 'all',             // 'all' | 'tasks' | 'unfiled' | 'nb:<id>'
        noteId: null,
        editing: false,
        isNew: false,
        newParentId: null,        // where a new note is filed (null = Unfiled)
        pendingNotebookName: null, // an import link's notebook, created on ✓ Done
        query: '',
        from: 'Notes',            // label of where back goes
        draft: null,              // the editor's text, kept across re-renders
        loaded: null,             // what the editor started from
        importId: null            // the pending import link a new note is the review of
    };
}

// History entries pushed above the Home entry; stored in each entry too, so
// a popstate knows where it landed.
let navDepth = 0;
let skipNavGuardOnce = false;
let unwindingAccount = false; // resetAccountUi's history.go, already drawn
let accountChanging = false;  // a sign-out on its way to the server

function isDesktop() {
    return window.matchMedia('(min-width: 900px)').matches;
}

// Who the page is showing, for its history entries and pending import links:
// the server and the account's name, compared the way the server compares
// names (NFKC, any case). A server never renames an account or hands a name
// out twice, deleted accounts' included, so the name is as sure as the id —
// and unlike the id it is there from the first moment of every session, one
// from before ids too: the key is the same before and after the server has
// said who the session is. Empty when nobody is. "name:" keeps it apart from
// the keys earlier builds kept links under (see pendingImportVisible): a
// username never has a colon.
function accountKey() {
    const who = (localStorage.getItem(LS.username) || '').normalize('NFKC').toLowerCase();
    return who ? `${(state.config.url || '').replace(/\/$/, '')}|name:${who}` : '';
}

// Each entry says whose notes it shows, so one left in the stack by an
// account change is never reopened for the next account.
function nvHistoryState() {
    const nv = state.nv;
    return { tp: 'nv', account: accountKey(), depth: navDepth, pane: nv.pane, scope: nv.scope, noteId: nv.noteId, from: nv.from, query: nv.query };
}

function placeLabel(lib) {
    if (state.view !== 'notes') return 'Home';
    if (state.nv.pane === 'library') return 'Notes';
    if (state.nv.pane === 'list') return NM.scopeLabel(lib || notesLibrary(), state.nv.scope);
    const hit = findNotesNode(state.nv.noteId);
    return hit ? hit.node.title || 'Untitled' : 'Notes';
}

// Show Notes or move within it. Every pane change is a history entry with the
// URL left as it is — no hash, so back and forward never reach the #note= /
// #notes= / #reorder= import handler. mode: 'auto' (push when the pane
// changes), 'push', 'replace' or 'none'.
function openNotes(patch = {}, { history: mode = 'auto' } = {}) {
    const wasNotes = state.view === 'notes';
    const prevPane = state.nv.pane;
    const from = placeLabel();
    const next = { ...state.nv, ...patch };
    const push = mode === 'push' || (mode === 'auto' && (!wasNotes || prevPane !== next.pane));
    if (push && patch.from === undefined) next.from = from;
    state.view = 'notes';
    state.nv = next;
    if (push) {
        navDepth++;
        history.pushState(nvHistoryState(), '', location.pathname);
    } else if (mode !== 'none') {
        history.replaceState(nvHistoryState(), '', location.pathname);
    }
    saveNotesPrefs();
    renderView();
}

function editorDirty() {
    const nv = state.nv;
    if (state.view !== 'notes' || !nv.editing || nv.draft == null) return false;
    if (nv.isNew) return nv.draft.trim() !== '';
    return nv.draft !== (nv.loaded == null ? '' : nv.loaded);
}

// A note open in the editor, changed or not: what it saves is its own text,
// loaded before anything a pull brings in under it.
function editorOpen() {
    return state.view === 'notes' && Boolean(state.nv.editing);
}

// The guard on every way out of an edit: back, the bottom nav, wikilinks, the
// wordmark, another note.
function confirmDiscardEdit() {
    return !editorDirty() || confirm('Discard unsaved changes?');
}

// Every way out of an edit comes through here, saved (✓ Done) or discarded
// (✕, or a confirmed back or switch). An import link's note that is thrown
// away on purpose ends its link here; a saved one has handed its link to the
// copy first (saveNoteEdit), to be kept until the copy is pushed. An account
// change sets the editor aside without coming through here.
function stopEditing() {
    if (state.nv.importId) dropPendingImport(state.nv.importId);
    const was = state.nv.editing;
    Object.assign(state.nv, {
        editing: false,
        isNew: false,
        draft: null,
        loaded: null,
        newParentId: null,
        pendingNotebookName: null,
        importId: null
    });
    // The kept draft goes with the next write of the copy, which holds
    // whatever the editor saved: never before it.
    if (was) scheduleCopySave();
}

// Switching what the library or list column shows. A desktop keeps the note
// column, and any edit in it, on screen, so there is nothing to ask; a phone
// replaces the note, so a confirmed discard has to drop the draft as well —
// or ✓ Done would later save what the user chose to throw away.
function confirmLeaveNotePane() {
    if (isDesktop()) return true;
    if (!confirmDiscardEdit()) return false;
    stopEditing();
    return true;
}

// Notes from the topbar 📝 or the tab bar. A phone always lands on the
// library; a desktop comes back to the last scope and note.
function enterNotes() {
    if (state.view === 'notes') {
        if (isDesktop()) return;
        if (!confirmDiscardEdit()) return;
        stopEditing();
        openNotes({ pane: 'library' });
        return;
    }
    const lib = notesLibrary();
    const p = NV_UI.prefs;
    const scopeOk = !NM.notebookIdOf(p.scope) || lib.notebooks.has(NM.notebookIdOf(p.scope));
    stopEditing();
    if (isDesktop()) {
        const last = p.noteId && lib.notes.find(n => n.id === p.noteId);
        openNotes({
            pane: last ? 'note' : 'list',
            scope: scopeOk ? p.scope : 'all',
            noteId: last ? last.id : null,
            query: ''
        });
    } else {
        openNotes({ pane: 'library', scope: scopeOk ? p.scope : 'all', noteId: null, query: '' });
    }
}

function goHome() {
    if (!confirmDiscardEdit()) return;
    stopEditing();
    closeNotesSheets();
    // Notes opens without a snapshot too (offline start, failed pull), so
    // Home must work without one; there is just no folder path to reset.
    if (state.snapshot) state.pathIds = [state.snapshot._pwaId];
    if (state.view === 'notes' && navDepth > 0) {
        // Unwind to the Home entry so back from Home leaves the app, as it should.
        skipNavGuardOnce = true;
        history.go(-navDepth);
        return;
    }
    state.view = 'home';
    renderView();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// '‹' in the list or note toolbar: back to wherever you came from.
function nvBack({ confirmed = false } = {}) {
    if (!confirmed && !confirmDiscardEdit()) return;
    if (navDepth > 0) {
        skipNavGuardOnce = true;
        history.back();
        return;
    }
    // Nothing of ours to go back to (a reload landed here): step up by hand.
    stopEditing();
    const pane = state.nv.pane;
    if (pane === 'note') openNotes({ pane: 'list' }, { history: 'replace' });
    else if (pane === 'list') openNotes({ pane: 'library' }, { history: 'replace' });
    else {
        state.view = 'home';
        history.replaceState(null, '', location.pathname);
        renderView();
    }
}

function onNotesPopState(e) {
    // An import link opened while the app runs is a fragment navigation: the
    // browser pops a fresh, state-less entry just before hashchange. That is
    // no way back to Home (and no reason to ask about an edit) — the
    // hashchange handler takes the entry over in stashImportHash.
    if (!e.state && IMPORT_HASH_RE.test(location.hash)) return;
    // An entry of another account's notes, left in the stack by an account
    // change, reads as Home: its pane, label and search are not this one's.
    const st = e.state && e.state.tp === 'nv' && e.state.account === accountKey() ? e.state : null;
    // The unwind a sign-out or an account change started lands on Home,
    // which it drew already. Anything else (a stray unwind that never
    // landed, then a real back) is handled as usual. A link that waited for
    // the unwind to land opens now, if it can.
    if (unwindingAccount) {
        unwindingAccount = false;
        if (!st && state.view === 'home' && !state.nv.editing) {
            navDepth = 0;
            openPendingImport();
            return;
        }
    }
    if (!skipNavGuardOnce && editorDirty() && !confirm('Discard unsaved changes?')) {
        // Stay: put back the entry back just took away.
        history.pushState(nvHistoryState(), '', location.pathname);
        return;
    }
    skipNavGuardOnce = false;
    stopEditing();
    closeNotesSheets();
    navDepth = st ? Math.max(0, Number(st.depth) || 0) : 0;
    if (!st) {
        state.view = 'home';
    } else {
        state.view = 'notes';
        Object.assign(state.nv, {
            pane: st.pane || 'library',
            scope: st.scope || 'all',
            noteId: st.noteId || null,
            from: st.from || 'Notes',
            query: st.query || ''
        });
    }
    renderView();
}

function openNoteById(id, { from } = {}) {
    if (!confirmDiscardEdit()) return;
    stopEditing();
    const patch = { pane: 'note', noteId: id };
    if (from) patch.from = from;
    // Desktop switches notes in place; a phone stacks them so back returns.
    const same = state.nv.pane === 'note';
    openNotes(patch, { history: same && isDesktop() ? 'replace' : 'auto' });
}

// Resolves true once the editor is open.
async function startNewNote({ parentId = null, content = '', from, pendingNotebookName = null, importId = null } = {}) {
    if (!confirmDiscardEdit()) return false;
    const found = await ensureNotesFolder();
    if (!found) return false;
    stopEditing();
    const patch = {
        pane: 'note', noteId: null, isNew: true, editing: true,
        newParentId: parentId, pendingNotebookName,
        draft: content, loaded: content, importId
    };
    if (from) patch.from = from;
    openNotes(patch, { history: 'push' });
    focusNoteEditor();
    return true;
}

function focusNoteEditor() {
    requestAnimationFrame(() => {
        const ta = document.getElementById('note-body-input');
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
    });
}

// Drop scope and note ids a pull or another device removed.
function validateNv(lib) {
    const nv = state.nv;
    const nbId = NM.notebookIdOf(nv.scope);
    if (nbId && !lib.notebooks.has(nbId)) nv.scope = 'all';
    if (nv.noteId && !nv.isNew && !lib.notes.some(n => n.id === nv.noteId)) {
        nv.noteId = null;
        if (nv.editing && nv.draft != null) {
            // The note vanished under an edit: keep the text as a new note.
            nv.isNew = true;
            showToast('This note was removed elsewhere — ✓ Done keeps your text as a new note.');
        } else {
            stopEditing();
            if (nv.pane === 'note' && !isDesktop()) nv.pane = 'list';
        }
    }
}

// --- rendering ---

function nvEl(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
}

function taskPillHtml(tasks) {
    if (!tasks || !tasks.total) return '';
    if (tasks.open === 0) return `<span class="nv-pill done" title="All tasks done">✓ ${tasks.done}/${tasks.total}</span>`;
    const pct = Math.round((tasks.done / tasks.total) * 100);
    return `<span class="nv-pill" title="${tasks.done} of ${tasks.total} tasks done">`
        + `<span class="nv-pill-bar"><span style="width:${pct}%"></span></span>${tasks.done}/${tasks.total}</span>`;
}

function noteRowHtml(note, { chip = false, titleRanges = null, snippet = null, now = Date.now() } = {}) {
    const untitled = !String(note.title || '').trim();
    const title = untitled
        ? 'Untitled'
        : (titleRanges && titleRanges.length ? NM.highlightHtml(note.title, titleRanges, escapeHtml) : escapeHtml(note.title));
    const preview = snippet
        ? `${escapeHtml(snippet.before)}<mark>${escapeHtml(snippet.hit)}</mark>${escapeHtml(snippet.after)}`
        : escapeHtml(note.preview);
    const pathChip = chip && note.notebookId
        ? `<span class="nv-chip" title="${escapeHtml(note.path.join(' › '))}">📓 ${escapeHtml(NM.pathLabel(note.path, 28))}</span>`
        : '';
    const chips = taskPillHtml(note.tasks) + pathChip;
    const selected = state.nv.noteId === note.id && !state.nv.isNew;
    return `<div class="nv-row${selected ? ' selected' : ''}" data-nv="open-note" data-id="${escapeHtml(note.id)}" role="button" tabindex="0"`
        + `${isDesktop() ? ' draggable="true"' : ''}>`
        + `<div class="nv-row-top"><span class="nv-row-title${untitled ? ' untitled' : ''}">${title}</span>`
        + `<span class="nv-row-time">${escapeHtml(NM.relativeTime(note.updatedAt, now))}</span></div>`
        + (preview ? `<div class="nv-row-preview">${preview}</div>` : '')
        + (chips ? `<div class="nv-row-chips">${chips}</div>` : '')
        + '</div>';
}

function renderNotesScreen(root) {
    root.classList.remove('in-imports');
    const lib = notesLibrary();
    validateNv(lib);
    const nv = nvEl('div', 'nv');
    nv.append(renderNvSide(lib), renderNvList(lib), renderNvNote(lib));
    root.appendChild(nv);
}

function renderNvSide(lib) {
    const pane = nvEl('section', 'nv-pane nv-side');
    const head = nvEl('div', 'nv-side-head');
    head.innerHTML = '<h2>Notes</h2><button type="button" class="nv-round primary" data-nv="new-note" aria-label="New note" title="New note">+</button>';
    pane.appendChild(head);

    const search = nvEl('button', 'nv-searchbar', '🔍 Search notes');
    search.type = 'button';
    search.dataset.nv = 'search';
    pane.appendChild(search);

    // Proposals, import review and import links still waiting wait here.
    if (state.importBatch) pane.appendChild(renderImportBlock());
    const waiting = waitingImports();
    if (waiting.length) pane.appendChild(renderPendingImportsBlock(waiting));
    if (state.proposals.length > 0) pane.appendChild(renderProposalsBlock());

    const scopes = nvEl('div', 'nv-card nv-scopes');
    scopes.innerHTML = [
        ['all', '🗒', 'All notes', lib.counts.all],
        ['tasks', '☐', 'Open tasks', lib.counts.openTasks],
        ['unfiled', '📥', 'Unfiled', lib.counts.unfiled]
    ].map(([s, icon, label, n]) =>
        `<button type="button" class="nv-scope${state.nv.scope === s ? ' selected' : ''}" data-nv="scope" data-scope="${s}">`
        + `<span class="nv-ico" aria-hidden="true">${icon}</span><span class="nv-name">${label}</span>`
        + `<span class="nv-count">${n}</span><span class="nv-chev-r" aria-hidden="true">›</span></button>`).join('');
    pane.appendChild(scopes);

    const label = nvEl('div', 'nv-label-row');
    label.innerHTML = '<span>Notebooks</span><button type="button" class="nv-text-btn" data-nv="new-notebook">+ New notebook</button>';
    pane.appendChild(label);

    const tree = nvEl('div', 'nv-tree');
    const rows = [];
    const drag = isDesktop() ? ' draggable="true"' : '';
    const walk = (books) => {
        for (const b of books) {
            const kids = b.children.length > 0;
            const open = kids && NV_UI.expanded.has(b.id);
            const id = escapeHtml(b.id);
            const name = escapeHtml(b.title || '(unnamed)');
            rows.push(
                `<div class="nv-tree-row${state.nv.scope === 'nb:' + b.id ? ' selected' : ''}" style="--depth:${b.depth}" data-id="${id}"${drag}>`
                + (kids
                    ? `<button type="button" class="nv-fold${open ? ' open' : ''}" data-nv="fold" data-id="${id}" aria-expanded="${open}" aria-label="${open ? 'Collapse' : 'Expand'} ${name}"><span aria-hidden="true">▸</span></button>`
                    : '<span class="nv-fold-space"></span>')
                + `<button type="button" class="nv-tree-name" data-nv="open-nb" data-id="${id}">`
                + `<span class="nv-ico" aria-hidden="true">📓</span><span class="nv-name">${name}</span>`
                + `<span class="nv-count">${b.totalCount}</span></button>`
                + `<button type="button" class="nv-more" data-nv="nb-menu" data-id="${id}" aria-label="Actions for ${name}">⋯</button>`
                + '</div>');
            if (open) walk(b.children);
        }
    };
    walk(lib.roots);
    tree.innerHTML = rows.join('');
    pane.appendChild(tree);

    if (!lib.notes.length && !lib.roots.length) {
        const empty = nvEl('div', 'nv-empty');
        empty.innerHTML = '<p>No notes yet</p><button type="button" class="primary" data-nv="new-note">+ New note</button>';
        pane.appendChild(empty);
    }

    const share = nvEl('button', 'ghost-block nv-share', '🔗 Share notes with an LLM (1-hour link)');
    share.type = 'button';
    share.dataset.nv = 'share';
    share.title = 'Create a 1-hour link with your notes + instructions to paste into any LLM chat';
    pane.appendChild(share);
    return pane;
}

function renderNvList(lib) {
    const nv = state.nv;
    const pane = nvEl('section', 'nv-pane nv-list');
    const nbId = NM.notebookIdOf(nv.scope);
    const nb = nbId ? lib.notebooks.get(nbId) : null;
    const label = NM.scopeLabel(lib, nv.scope);

    const back = nvEl('div', 'nv-backrow');
    back.innerHTML = `<button type="button" class="nv-back" data-nv="list-back">‹ ${escapeHtml(nv.pane === 'list' ? nv.from || 'Notes' : 'Notes')}</button>`
        + '<span class="nv-spacer"></span>'
        + '<button type="button" class="nv-icon" data-nv="new-note" aria-label="New note" title="New note">+</button>'
        + (nb ? '<button type="button" class="nv-icon" data-nv="list-menu" aria-label="Notebook actions" title="Notebook actions">⋯</button>' : '');
    pane.appendChild(back);

    const head = nvEl('div', 'nv-list-head');
    const count = nb ? nb.totalCount : NM.notesInScope(lib, nv.scope).length;
    const sub = [nb && nb.depth > 0 ? nb.path.join(' › ') : '', `${count} note${count === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
    head.innerHTML = `<h2>${escapeHtml(label)}</h2><div class="nv-sub">${escapeHtml(sub)}</div>`;
    pane.appendChild(head);

    const tools = nvEl('div', 'nv-tools');
    tools.innerHTML =
        `<input type="search" class="nv-search" id="nv-search" autocomplete="off" spellcheck="false" aria-label="Search notes"`
        + ` placeholder="${escapeHtml(nv.scope === 'all' ? 'Search all notes' : `Search in ${label}`)}">`
        + '<select class="nv-sort" id="nv-sort" aria-label="Sort notes">'
        + `<option value="edited"${NV_UI.sort === 'edited' ? ' selected' : ''}>Edited ▾</option>`
        + `<option value="title"${NV_UI.sort === 'title' ? ' selected' : ''}>Title A–Z ▾</option>`
        + `<option value="manual"${NV_UI.sort === 'manual' ? ' selected' : ''}>Manual ▾</option>`
        + '</select>';
    tools.querySelector('input').value = nv.query;
    pane.appendChild(tools);

    const results = nvEl('div', 'nv-results');
    results.id = 'nv-results';
    fillNvResults(results, lib);
    pane.appendChild(results);
    return pane;
}

function fillNvResults(box, lib) {
    const nv = state.nv;
    const nbId = NM.notebookIdOf(nv.scope);
    const nb = nbId ? lib.notebooks.get(nbId) : null;
    const label = NM.scopeLabel(lib, nv.scope);
    const pool = NM.notesInScope(lib, nv.scope);
    const now = Date.now();
    const q = nv.query.trim();
    const html = [];

    if (q) {
        const scoped = nv.scope !== 'all';
        const hits = NM.searchNotes(lib, q, nb ? { notebookId: nb.id } : scoped ? { notes: pool } : {});
        if (!hits.length) {
            html.push(`<div class="nv-empty"><p>No notes match “${escapeHtml(q)}”</p>`
                + `<button type="button" class="primary" data-nv="create-from-query">+ Create note “${escapeHtml(q)}”</button>`
                + (scoped ? '<button type="button" class="ghost-block" data-nv="search-all">Search all notes</button>' : '')
                + '</div>');
        } else {
            html.push(`<div class="nv-summary">${hits.length} match${hits.length === 1 ? '' : 'es'}`
                + (scoped ? ` in ${escapeHtml(label)} · <button type="button" class="nv-text-btn" data-nv="search-all">Search all notes</button>` : '')
                + '</div>');
            for (const r of hits) html.push(noteRowHtml(r.note, { chip: true, titleRanges: r.titleRanges, snippet: r.snippet, now }));
        }
    } else {
        if (nb) {
            for (const child of nb.children) {
                html.push(`<button type="button" class="nv-subnb" data-nv="open-nb" data-id="${escapeHtml(child.id)}">`
                    + `<span class="nv-ico" aria-hidden="true">📓</span><span class="nv-name">${escapeHtml(child.title || '(unnamed)')}</span>`
                    + `<span class="nv-count">${child.totalCount}</span><span class="nv-chev-r" aria-hidden="true">›</span></button>`);
            }
        }
        const chip = nv.scope === 'all' || nv.scope === 'tasks';
        const notes = NM.sortNotes(pool, NV_UI.sort);
        if (NV_UI.sort === 'edited') {
            for (const g of NM.groupByRecency(notes, now)) {
                html.push(`<div class="nv-bucket">${escapeHtml(g.bucket)}</div>`);
                for (const n of g.notes) html.push(noteRowHtml(n, { chip, now }));
            }
        } else {
            for (const n of notes) html.push(noteRowHtml(n, { chip, now }));
        }
        if (!notes.length && !(nb && nb.children.length)) {
            if (nb) {
                html.push(`<div class="nv-empty"><p>No notes in ${escapeHtml(label)} yet</p>`
                    + '<button type="button" class="primary" data-nv="new-here">+ New note here</button></div>');
            } else if (nv.scope === 'tasks') {
                html.push('<div class="nv-empty"><p>No open tasks.</p></div>');
            } else if (nv.scope === 'unfiled') {
                html.push('<div class="nv-empty"><p>No unfiled notes.</p></div>');
            } else {
                html.push('<div class="nv-empty"><p>No notes yet</p><button type="button" class="primary" data-nv="new-note">+ New note</button></div>');
            }
        }
    }
    box.innerHTML = html.join('');
}

let nvSearchTimer = null;
function onNvSearchInput(input) {
    clearTimeout(nvSearchTimer);
    nvSearchTimer = setTimeout(() => {
        state.nv.query = input.value;
        history.replaceState(nvHistoryState(), '', location.pathname);
        const box = document.getElementById('nv-results');
        if (box) {
            fillNvResults(box, notesLibrary());
            box.scrollTop = 0;
        }
    }, 100);
}

function renderNvNote(lib) {
    const nv = state.nv;
    const pane = nvEl('section', 'nv-pane nv-note');
    const note = nv.noteId ? lib.notes.find(n => n.id === nv.noteId) : null;
    if (!note && !nv.isNew) {
        pane.appendChild(nvEl('div', 'nv-note-empty', 'Select a note, or press + to start one'));
        return pane;
    }

    const page = nvEl('div', 'note-page');
    const bar = nvEl('div', 'note-topbar');
    const backLabel = nv.from || 'Notes';
    let right;
    if (nv.editing) {
        right = '<button type="button" data-nv="cancel-edit" title="Discard changes" aria-label="Discard changes">✕</button>'
            + '<button type="button" class="note-done primary" data-nv="done" title="Save (Ctrl+S)">✓ Done</button>';
    } else {
        right = '<button type="button" data-nv="edit" title="Edit" aria-label="Edit">✏️</button>'
            + '<div class="note-menu-wrap"><button type="button" data-nv="note-menu" title="More" aria-label="More">⋯</button>'
            + '<div id="note-menu-pop" class="hidden">'
            + '<button type="button" class="menu-item" data-nv="rename-note">Rename…</button>'
            + '<button type="button" class="menu-item" data-nv="move-note">Move to…</button>'
            + '<hr>'
            + '<button type="button" class="menu-item danger" data-nv="delete-note">Delete note</button>'
            + '</div></div>';
    }
    bar.innerHTML = `<button type="button" class="nv-back" data-nv="note-back">‹ ${escapeHtml(backLabel)}</button>`
        + `<div class="note-topbar-right">${right}</div>`;
    page.appendChild(bar);

    if (nv.editing) {
        if (nv.isNew) {
            let where = 'Unfiled';
            if (nv.pendingNotebookName) where = `${nv.pendingNotebookName} (new)`;
            else if (nv.newParentId && lib.notebooks.has(nv.newParentId)) where = lib.notebooks.get(nv.newParentId).title || '(unnamed)';
            const chip = nvEl('button', 'nv-crumb', `in ${where} ▾`);
            chip.type = 'button';
            chip.dataset.nv = 'crumb';
            chip.title = 'Choose where the new note is filed';
            page.appendChild(chip);
        }
        const ta = nvEl('textarea');
        ta.id = 'note-body-input';
        ta.placeholder = '# Note title…';
        ta.value = nv.draft == null ? '' : nv.draft;
        page.appendChild(ta);
        requestAnimationFrame(() => autogrowNoteEditor(ta));
    } else {
        const nb = note.notebookId ? lib.notebooks.get(note.notebookId) : null;
        const crumb = nvEl('button', 'nv-crumb', nb ? `📓 ${NM.pathLabel(nb.path, 34)}` : '📥 Unfiled');
        crumb.type = 'button';
        crumb.dataset.nv = 'crumb';
        crumb.title = `${nb ? nb.path.join(' › ') : 'Unfiled'} — Move to…`;
        page.appendChild(crumb);
        const h1 = nvEl('h1', 'note-title' + (note.title ? '' : ' untitled'), note.title || 'Untitled');
        page.appendChild(h1);
        const meta = NM.noteMetaLine(note);
        if (meta) page.appendChild(nvEl('div', 'note-meta', meta));
        const body = nvEl('div', 'note-preview-body');
        body.id = 'note-preview';
        const blocks = renderNotePreview(document, note.content, note.title);
        if (blocks.length) {
            for (const b of blocks) body.appendChild(b);
        } else {
            const empty = nvEl('span', null, 'Empty note. Tap ✏️ to write.');
            empty.style.color = 'var(--muted)';
            body.appendChild(empty);
        }
        const links = NM.backlinksTo(lib, note.title, note.id);
        if (links.length) {
            const box = nvEl('div', 'note-backlinks');
            const label = nvEl('span', null, 'Linked from:');
            label.style.color = 'var(--muted)';
            box.appendChild(label);
            for (const n of links) {
                box.appendChild(document.createTextNode(' '));
                const chip = nvEl('span', 'note-wikilink note-backlink', n.title || 'Untitled');
                chip.dataset.target = n.title || '';
                box.appendChild(chip);
            }
            body.appendChild(box);
        }
        page.appendChild(body);
    }
    pane.appendChild(page);
    return pane;
}

// Grow the editor with the content — a note page, not a fixed input box.
function autogrowNoteEditor(ta) {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.max(ta.scrollHeight, Math.round(window.innerHeight * 0.6)) + 'px';
}

// --- note actions ---

function startEditing() {
    const hit = findNotesNode(state.nv.noteId);
    if (!hit) return;
    const content = decodeNote(hit.node).content;
    Object.assign(state.nv, { editing: true, isNew: false, draft: content, loaded: content });
    renderView();
    focusNoteEditor();
}

function cancelEditing() {
    if (!confirmDiscardEdit()) return;
    if (state.nv.isNew) {
        // Cancelling a brand-new note leaves the page entirely.
        stopEditing();
        nvBack({ confirmed: true });
        return;
    }
    stopEditing();
    renderView();
}

// Rewrite [[Old]] in every other note after a rename. Their edited time is
// kept: a rename is not an edit of theirs, and bumping it would jump them all
// to the top of Recent.
function rewriteLinksAfterRename(oldTitle, newTitle, exceptId) {
    const found = findNotesFolderWithPath();
    if (!found || !oldTitle || oldTitle === newTitle) return;
    const walk = (folder) => {
        for (const c of folder.children || []) {
            if (isNoteBookmark(c) && c._pwaId !== exceptId) {
                const meta = decodeNote(c);
                const rewritten = NM.rewriteWikiLink(meta.content, oldTitle, newTitle);
                if (rewritten !== meta.content) {
                    c.url = encodeNoteUrl({ content: rewritten, createdAt: meta.createdAt, updatedAt: meta.updatedAt });
                }
            } else if (isFolderNode(c)) {
                walk(c);
            }
        }
    };
    walk(found.node);
}

// Create the folders an import link named, now that the note is being saved.
function ensureNotebookByName(name) {
    const found = findNotesFolderWithPath();
    if (!found) return null;
    const res = NM.resolveNotebookByName(notesLibrary(), name);
    if (!res) return found.node;
    if (res.id) return findNotesNode(res.id)?.node || found.node;
    let parent = res.create.parentId ? findNotesNode(res.create.parentId)?.node : found.node;
    if (!parent) parent = found.node;
    for (const segment of res.create.segments) {
        const nb = { type: 'folder', title: segment, children: [] };
        assignIds(nb);
        parent.children = parent.children || [];
        parent.children.push(nb);
        NV_UI.expanded.add(parent._pwaId);
        parent = nb;
    }
    return parent;
}

async function saveNoteEdit() {
    const nv = state.nv;
    if (!nv.editing) return;
    // Only a new note needs the folder made; an existing one is already in it.
    const found = await ensureNotesFolder({ create: nv.isNew });
    if (!found) return;
    const content = nv.draft == null ? '' : nv.draft;
    const now = new Date().toISOString();
    if (nv.isNew) {
        let parent = null;
        if (nv.pendingNotebookName) parent = ensureNotebookByName(nv.pendingNotebookName);
        else if (nv.newParentId) parent = findNotesNode(nv.newParentId)?.node;
        if (!isFolderNode(parent)) parent = found.node;
        const r = NM.resolveTitleOnSave({ storedTitle: null, loadedContent: nv.loaded || '', newContent: content });
        const note = { type: 'bookmark', title: r.title, url: encodeNoteUrl({ content: r.content, createdAt: now, updatedAt: now }) };
        assignIds(note);
        parent.children = parent.children || [];
        parent.children.push(note);
        // An import link's note is in the copy now, not on the server: the
        // link stays on the phone until the push below (or a later one) gets
        // it there.
        holdImportInCopy(nv.importId);
        nv.importId = null;
        stopEditing();
        nv.noteId = note._pwaId;
        history.replaceState(nvHistoryState(), '', location.pathname);
    } else {
        const hit = findNotesNode(nv.noteId);
        if (!hit) {
            showToast('This note is gone — copy your text before leaving.');
            return;
        }
        const note = hit.node;
        const meta = decodeNote(note);
        // The note changed under the editor (a Pull, an approved proposal or
        // an import brought another device's version in): never overwrite
        // that. The edit is saved as a note of its own right next to it.
        if (nv.loaded != null && meta.content !== nv.loaded) {
            const mine = {
                type: 'bookmark',
                title: `${note.title} (my edit)`,
                url: encodeNoteUrl({ content, createdAt: now, updatedAt: now })
            };
            assignIds(mine);
            hit.parent.children.splice(hit.index + 1, 0, mine);
            stopEditing();
            nv.noteId = mine._pwaId;
            history.replaceState(nvHistoryState(), '', location.pathname);
            saveNotesPrefs();
            renderView();
            await commitNotesEdit('Saving…', `“${note.title}” changed on another device — your edit is saved next to it as “${mine.title}”.`);
            renderView();
            return;
        }
        const r = NM.resolveTitleOnSave({
            storedTitle: note.title,
            loadedContent: nv.loaded == null ? meta.content : nv.loaded,
            newContent: content
        });
        const oldTitle = note.title;
        note.title = r.title;
        note.url = encodeNoteUrl({ content: r.content, createdAt: meta.createdAt || now, updatedAt: now });
        rewriteLinksAfterRename(oldTitle, r.title, note._pwaId);
        stopEditing();
    }
    saveNotesPrefs();
    renderView();
    await commitNotesEdit('Saving…', 'Note saved.');
    renderView();
}

async function toggleNoteTask(line) {
    const hit = findNotesNode(state.nv.noteId);
    if (!hit || state.nv.editing || signedOutRefuses()) return;
    const meta = decodeNote(hit.node);
    const updated = NM.toggleTaskAtLine(meta.content, line);
    if (updated === meta.content) return;
    const now = new Date().toISOString();
    hit.node.url = encodeNoteUrl({ content: updated, createdAt: meta.createdAt || now, updatedAt: now });
    renderView();
    await commitNotesEdit();
    renderView();
}

async function renameNote(id) {
    const hit = findNotesNode(id);
    if (!hit || signedOutRefuses()) return;
    const note = hit.node;
    const meta = decodeNote(note);
    const name = prompt('Rename note:', note.title || '');
    if (name === null) return;
    const r = NM.resolveTitleOnSave({
        storedTitle: note.title, loadedContent: meta.content, newContent: meta.content, titleField: name
    });
    if (r.title === note.title && r.content === meta.content) return;
    const now = new Date().toISOString();
    const oldTitle = note.title;
    note.title = r.title;
    note.url = encodeNoteUrl({ content: r.content, createdAt: meta.createdAt || now, updatedAt: now });
    rewriteLinksAfterRename(oldTitle, r.title, id);
    renderView();
    await commitNotesEdit('Renaming…', `Renamed to “${r.title}”.`);
    renderView();
}

async function deleteNote(id) {
    const hit = findNotesNode(id);
    if (!hit || signedOutRefuses()) return;
    if (!confirm(`Delete note “${hit.node.title || 'Untitled'}”?`)) return;
    hit.parent.children = (hit.parent.children || []).filter(c => c !== hit.node);
    if (state.nv.noteId === id) {
        state.nv.noteId = null;
        if (!isDesktop() && state.nv.pane === 'note') {
            renderView();
            await commitNotesEdit('Deleting…', 'Note deleted.');
            nvBack({ confirmed: true });
            return;
        }
    }
    renderView();
    await commitNotesEdit('Deleting…', 'Note deleted.');
    renderView();
}

function openNoteByTitle(title) {
    if (!confirmDiscardEdit()) return;
    const lib = notesLibrary();
    const note = NM.findNoteByTitle(lib, title);
    if (note) {
        stopEditing();
        openNotes({ pane: 'note', noteId: note.id }, { history: 'push' });
        return;
    }
    // A link to a missing note starts a new one, Obsidian-style, in the same notebook.
    const from = state.nv.noteId ? lib.notes.find(n => n.id === state.nv.noteId) : null;
    startNewNote({ parentId: from ? from.notebookId : null, content: `# ${title}\n\n` });
}

// --- notebook actions ---

function folderTitles(folder, exceptId = null) {
    return (folder.children || []).filter(c => isFolderNode(c) && c._pwaId !== exceptId).map(c => c.title);
}

async function createNotebookIn(parentId = null, { andThen } = {}) {
    const found = await ensureNotesFolder();
    if (!found) return null;
    let parent = parentId ? findNotesNode(parentId)?.node : found.node;
    if (parentId && !isFolderNode(parent)) { showToast('That notebook is gone.'); return null; }
    const name = prompt(parentId ? `New notebook inside “${parent.title}”:` : 'New notebook name:');
    if (name === null) return null;
    const problem = NM.notebookNameProblem(name, parent ? folderTitles(parent) : []);
    if (problem) { showToast(problem); return null; }
    // A first notebook brings the notes folder with it, now that there is a name.
    if (!parent) parent = (await ensureNotesFolder({ create: true }))?.node;
    if (!isFolderNode(parent)) return null;
    const nb = { type: 'folder', title: name.trim(), children: [] };
    assignIds(nb);
    parent.children = parent.children || [];
    parent.children.push(nb);
    if (parentId) NV_UI.expanded.add(parentId);
    saveNotesPrefs();
    if (andThen) {
        await andThen(nb);
        return nb;
    }
    renderView();
    await commitNotesEdit('Saving…', `Notebook “${nb.title}” created.`);
    renderView();
    return nb;
}

async function renameNotebook(id) {
    const hit = findNotesNode(id);
    if (!hit || !isFolderNode(hit.node) || signedOutRefuses()) return;
    const name = prompt('Rename notebook:', hit.node.title || '');
    if (name === null || name.trim() === hit.node.title) return;
    const problem = NM.notebookNameProblem(name, folderTitles(hit.parent, id));
    if (problem) { showToast(problem); return; }
    hit.node.title = name.trim();
    renderView();
    await commitNotesEdit('Renaming…', 'Notebook renamed.');
    renderView();
}

// Is `id` the folder itself or somewhere inside it?
function folderContains(folder, id) {
    if (folder._pwaId === id) return true;
    return (folder.children || []).some(c => isFolderNode(c) && folderContains(c, id));
}

async function moveNotebookTo(id, targetId) {
    const hit = findNotesNode(id);
    const found = findNotesFolderWithPath();
    if (!hit || !found || !isFolderNode(hit.node) || signedOutRefuses()) return;
    const target = targetId ? findNotesNode(targetId)?.node : found.node;
    if (!isFolderNode(target)) { showToast('That notebook is gone.'); return; }
    if (folderContains(hit.node, target._pwaId)) { showToast('A notebook cannot move into itself.'); return; }
    if (target === hit.parent) return;
    const problem = NM.notebookNameProblem(hit.node.title, folderTitles(target, id));
    if (problem) { showToast(problem); return; }
    hit.parent.children = hit.parent.children.filter(c => c !== hit.node);
    target.children = target.children || [];
    target.children.push(hit.node);
    if (targetId) NV_UI.expanded.add(targetId);
    saveNotesPrefs();
    renderView();
    await commitNotesEdit('Moving…', `Moved to ${movedToLabel(targetId, 'the top level')}`);
    renderView();
}

async function moveNoteTo(id, targetId) {
    const hit = findNotesNode(id);
    const found = findNotesFolderWithPath();
    if (!hit || !found || signedOutRefuses()) return;
    const target = targetId ? findNotesNode(targetId)?.node : found.node;
    if (!isFolderNode(target)) { showToast('That notebook is gone.'); return; }
    if (target === hit.parent) return;
    // Re-parent only: the note's url (and so its edited time) is untouched.
    hit.parent.children = hit.parent.children.filter(c => c !== hit.node);
    target.children = target.children || [];
    target.children.push(hit.node);
    renderView();
    await commitNotesEdit('Moving…', `Moved to ${movedToLabel(targetId, 'Unfiled')}`);
    renderView();
}

function movedToLabel(targetId, rootLabel) {
    if (!targetId) return rootLabel;
    const nb = notesLibrary().notebooks.get(targetId);
    return nb ? NM.pathLabel(nb.path) : 'the notebook';
}

// Always a lift: the notebook's notes and sub-notebooks take its place in its
// parent, in order and with their ids. Deleting a notebook never deletes notes.
async function deleteNotebook(id) {
    const hit = findNotesNode(id);
    if (!hit || !isFolderNode(hit.node) || signedOutRefuses()) return;
    const lib = notesLibrary();
    const nb = lib.notebooks.get(id);
    const parentNb = nb && nb.parentId ? lib.notebooks.get(nb.parentId) : null;
    const parts = [];
    if (nb && nb.directCount) parts.push(`${nb.directCount} note${nb.directCount === 1 ? '' : 's'}`);
    if (nb && nb.children.length) parts.push(`${nb.children.length} notebook${nb.children.length === 1 ? '' : 's'}`);
    const title = hit.node.title || '(unnamed)';
    const msg = parts.length
        ? `Delete notebook “${title}”? Its ${parts.join(' and ')} move up to ${parentNb ? parentNb.title : 'Notes'}.`
        : `Delete notebook “${title}”?`;
    if (!confirm(msg)) return;
    hit.parent.children = NM.liftChildren(hit.parent.children, hit.index, hit.node.children || []);
    NV_UI.expanded.delete(id);
    if (state.nv.scope === `nb:${id}`) state.nv.scope = parentNb ? `nb:${parentNb.id}` : 'all';
    if (state.nv.newParentId === id) state.nv.newParentId = parentNb ? parentNb.id : null;
    saveNotesPrefs();
    history.replaceState(nvHistoryState(), '', location.pathname);
    renderView();
    await commitNotesEdit('Deleting…', `Notebook “${title}” deleted.`);
    renderView();
}

// --- sheets: Move to… and notebook actions ---

let moveCtx = null;

function closeNotesSheets() {
    hide($('move-sheet'));
    hide($('nb-sheet'));
}

function openMoveSheet(kind, id = null) {
    const lib = notesLibrary();
    let currentId = null;
    let excludeId = null;
    let heading = 'Move to…';
    if (kind === 'note') {
        const n = lib.notes.find(x => x.id === id);
        if (!n) return;
        currentId = n.notebookId;
        heading = `Move “${n.title || 'Untitled'}” to…`;
    } else if (kind === 'new') {
        currentId = state.nv.pendingNotebookName ? undefined : state.nv.newParentId;
        heading = 'File the new note in…';
    } else {
        const b = lib.notebooks.get(id);
        if (!b) return;
        currentId = b.parentId;
        excludeId = id;
        heading = `Move notebook “${b.title || '(unnamed)'}” to…`;
    }
    moveCtx = { kind, id };
    $('move-title').textContent = heading;
    const atRoot = currentId === null;
    const opts = NM.notebookOptions(lib, { excludeId, currentId: currentId === undefined ? null : currentId });
    const rows = [];
    if (kind === 'new' && state.nv.pendingNotebookName) {
        rows.push(`<button type="button" class="move-opt current" disabled><span class="nv-ico">📓</span>`
            + `<span class="nv-name">${escapeHtml(state.nv.pendingNotebookName)} (new)</span><span class="tick">✓</span></button>`);
    }
    rows.push(`<button type="button" class="move-opt${atRoot ? ' current' : ''}" data-target=""${atRoot ? ' disabled' : ''}>`
        + `<span class="nv-ico">${kind === 'notebook' ? '🗒' : '📥'}</span><span class="nv-name">${kind === 'notebook' ? 'Top level' : 'Unfiled'}</span>`
        + `${atRoot ? '<span class="tick">✓</span>' : ''}</button>`);
    for (const o of opts) {
        rows.push(`<button type="button" class="move-opt${o.current ? ' current' : ''}" style="--depth:${o.depth}" data-target="${escapeHtml(o.id)}"${o.disabled ? ' disabled' : ''}>`
            + `<span class="nv-ico">📓</span><span class="nv-name">${escapeHtml(o.title || '(unnamed)')}</span>`
            + `<span class="nv-count">${o.count}</span>${o.current ? '<span class="tick">✓</span>' : ''}</button>`);
    }
    $('move-list').innerHTML = rows.join('');
    hide($('nb-sheet'));
    show($('move-sheet'));
}

async function moveSheetPick(targetId) {
    const ctx = moveCtx;
    hide($('move-sheet'));
    if (!ctx) return;
    const target = targetId || null;
    if (ctx.kind === 'new') {
        state.nv.newParentId = target;
        state.nv.pendingNotebookName = null;
        renderView();
        return;
    }
    if (ctx.kind === 'note') await moveNoteTo(ctx.id, target);
    else await moveNotebookTo(ctx.id, target);
}

// '+ New notebook…' in the picker: a top-level notebook, then the move.
async function moveSheetNewNotebook() {
    const ctx = moveCtx;
    hide($('move-sheet'));
    if (!ctx) return;
    await createNotebookIn(null, {
        andThen: async (nb) => {
            if (ctx.kind === 'new') {
                state.nv.newParentId = nb._pwaId;
                state.nv.pendingNotebookName = null;
                renderView();
                await commitNotesEdit('Saving…', `Notebook “${nb.title}” created.`);
                renderView();
            } else if (ctx.kind === 'note') {
                await moveNoteTo(ctx.id, nb._pwaId);
            } else {
                await moveNotebookTo(ctx.id, nb._pwaId);
            }
        }
    });
}

function openNotebookSheet(id) {
    const nb = notesLibrary().notebooks.get(id);
    if (!nb) return;
    $('nb-sheet-title').textContent = `📓 ${nb.title || '(unnamed)'}`;
    $('nb-sheet').dataset.id = id;
    hide($('move-sheet'));
    show($('nb-sheet'));
}

async function notebookSheetAction(act) {
    const id = $('nb-sheet').dataset.id;
    hide($('nb-sheet'));
    if (!id) return;
    if (act === 'new-note') {
        if (state.nv.pane !== 'note') openNotes({ pane: 'list', scope: `nb:${id}`, query: '' });
        startNewNote({ parentId: id });
    } else if (act === 'new-sub') {
        await createNotebookIn(id);
    } else if (act === 'rename') {
        await renameNotebook(id);
    } else if (act === 'move') {
        openMoveSheet('notebook', id);
    } else if (act === 'delete') {
        await deleteNotebook(id);
    }
}

// One delegated handler for everything the notes screen draws, installed once
// at startup — the old note page added a document listener on every render.
function onNotesClick(e) {
    if (state.view !== 'notes') return;
    const box = e.target.closest('.note-task-box');
    if (box) {
        e.preventDefault();
        toggleNoteTask(Number(box.dataset.line));
        return;
    }
    const wiki = e.target.closest('.note-wikilink');
    if (wiki && wiki.dataset.target) {
        openNoteByTitle(wiki.dataset.target);
        return;
    }
    const pop = $('note-menu-pop');
    const t = e.target.closest('[data-nv]');
    if (!t) return;
    const act = t.dataset.nv;
    const id = t.dataset.id;
    if (act !== 'note-menu' && pop) pop.classList.add('hidden');
    const lib = () => notesLibrary();
    switch (act) {
        case 'new-note': {
            const inList = t.closest('.nv-list');
            const nbId = inList ? NM.notebookIdOf(state.nv.scope) : null;
            startNewNote({ parentId: nbId && lib().notebooks.has(nbId) ? nbId : null });
            break;
        }
        case 'new-here':
            startNewNote({ parentId: NM.notebookIdOf(state.nv.scope) });
            break;
        case 'search':
            openNotes({ pane: 'list', scope: 'all', query: '' });
            requestAnimationFrame(() => document.getElementById('nv-search')?.focus());
            break;
        case 'scope':
            if (!confirmLeaveNotePane()) return;
            openNotes({ pane: 'list', scope: t.dataset.scope, query: '' });
            break;
        case 'open-nb':
            if (!confirmLeaveNotePane()) return;
            openNotes({ pane: 'list', scope: `nb:${id}`, query: '' }, { history: state.nv.pane === 'list' ? 'push' : 'auto' });
            break;
        case 'fold':
            if (NV_UI.expanded.has(id)) NV_UI.expanded.delete(id);
            else NV_UI.expanded.add(id);
            saveNotesPrefs();
            renderView();
            break;
        case 'nb-menu':
            openNotebookSheet(id);
            break;
        case 'list-menu': {
            const nbId = NM.notebookIdOf(state.nv.scope);
            if (nbId) openNotebookSheet(nbId);
            break;
        }
        case 'new-notebook':
            createNotebookIn(null);
            break;
        case 'share':
            createShareLink();
            break;
        case 'list-back':
            if (isDesktop()) openNotes({ pane: 'library' });
            else nvBack();
            break;
        case 'note-back':
            nvBack();
            break;
        case 'open-note':
            openNoteById(id);
            break;
        case 'search-all':
            openNotes({ scope: 'all' }, { history: 'replace' });
            break;
        case 'create-from-query': {
            const q = state.nv.query.trim();
            const nbId = NM.notebookIdOf(state.nv.scope);
            startNewNote({ parentId: nbId && lib().notebooks.has(nbId) ? nbId : null, content: `# ${q}\n\n` });
            break;
        }
        case 'edit':
            startEditing();
            break;
        case 'cancel-edit':
            cancelEditing();
            break;
        case 'done':
            saveNoteEdit();
            break;
        case 'note-menu':
            e.stopPropagation();
            if (pop) pop.classList.toggle('hidden');
            break;
        case 'rename-note':
            renameNote(state.nv.noteId);
            break;
        case 'move-note':
            openMoveSheet('note', state.nv.noteId);
            break;
        case 'delete-note':
            deleteNote(state.nv.noteId);
            break;
        case 'crumb':
            if (state.nv.isNew) openMoveSheet('new');
            else if (state.nv.noteId) openMoveSheet('note', state.nv.noteId);
            break;
        default:
            break;
    }
}

// Desktop drag and drop: a note row dropped on a notebook (or on Unfiled)
// moves it; a notebook dropped on another notebook (or on the Notebooks
// label, for the top level) moves that — never into itself or below.
let nvDragging = null; // { kind: 'note' | 'notebook', id }

function nvDropTarget(el) {
    if (!el || !el.closest) return null;
    const row = el.closest('.nv-tree-row[data-id]');
    if (row) return { kind: 'notebook', id: row.dataset.id, el: row };
    const unfiled = el.closest('.nv-scope[data-scope="unfiled"]');
    if (unfiled) return { kind: 'unfiled', id: null, el: unfiled };
    const label = el.closest('.nv-label-row');
    if (label) return { kind: 'top', id: null, el: label };
    return null;
}

function nvCanDrop(target) {
    if (!nvDragging || !target) return false;
    const lib = notesLibrary();
    if (nvDragging.kind === 'note') {
        const note = lib.notes.find(n => n.id === nvDragging.id);
        return Boolean(note) && target.kind !== 'top' && (target.id || null) !== note.notebookId;
    }
    const nb = lib.notebooks.get(nvDragging.id);
    if (!nb || target.kind === 'unfiled') return false;
    if (target.kind === 'top') return nb.parentId !== null;
    const t = lib.notebooks.get(target.id);
    return Boolean(t) && !t.pathIds.includes(nb.id) && t.id !== nb.parentId;
}

function clearNvDropMarks() {
    for (const el of document.querySelectorAll('.nv .drop-target')) el.classList.remove('drop-target');
}

function wireNotesDragAndDrop(root) {
    root.addEventListener('dragstart', (e) => {
        if (state.view !== 'notes') return;
        const row = e.target.closest && e.target.closest('.nv-row[data-id]');
        const nbRow = !row && e.target.closest && e.target.closest('.nv-tree-row[data-id]');
        if (row) nvDragging = { kind: 'note', id: row.dataset.id };
        else if (nbRow) nvDragging = { kind: 'notebook', id: nbRow.dataset.id };
        else return;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', nvDragging.id);
    });
    root.addEventListener('dragover', (e) => {
        const target = nvDropTarget(e.target);
        if (!nvCanDrop(target)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!target.el.classList.contains('drop-target')) {
            clearNvDropMarks();
            target.el.classList.add('drop-target');
        }
    });
    root.addEventListener('dragleave', (e) => {
        const target = nvDropTarget(e.target);
        if (target && !target.el.contains(e.relatedTarget)) target.el.classList.remove('drop-target');
    });
    root.addEventListener('drop', async (e) => {
        const target = nvDropTarget(e.target);
        clearNvDropMarks();
        if (!nvCanDrop(target)) return;
        e.preventDefault();
        const d = nvDragging;
        nvDragging = null;
        if (d.kind === 'note') await moveNoteTo(d.id, target.id);
        else await moveNotebookTo(d.id, target.id);
    });
    root.addEventListener('dragend', () => {
        nvDragging = null;
        clearNvDropMarks();
    });
}

function onNotesInput(e) {
    if (state.view !== 'notes') return;
    if (e.target.id === 'nv-search') {
        onNvSearchInput(e.target);
    } else if (e.target.id === 'note-body-input') {
        state.nv.draft = e.target.value;
        autogrowNoteEditor(e.target);
        // Kept on the device as it is typed, once typing pauses.
        scheduleLiveDraft();
    }
}

function onNotesChange(e) {
    if (state.view !== 'notes' || e.target.id !== 'nv-sort') return;
    NV_UI.sort = e.target.value;
    saveNotesPrefs();
    const box = document.getElementById('nv-results');
    if (box) fillNvResults(box, notesLibrary());
}

// Desktop keys: '/' searches, ↑/↓ walk the list, Esc clears search or leaves
// an edit, Ctrl/Cmd+S saves.
function onNotesKeydown(e) {
    if (state.view !== 'notes') return;
    if (document.querySelector('.sheet:not(.hidden)')) return;
    const t = e.target;
    const search = document.getElementById('nv-search');
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
        if (state.nv.editing) {
            e.preventDefault();
            saveNoteEdit();
        }
        return;
    }
    if (e.key === 'Escape') {
        if (t === search && search.value) {
            e.preventDefault();
            search.value = '';
            onNvSearchInput(search);
        } else if (state.nv.editing) {
            e.preventDefault();
            cancelEditing();
        }
        return;
    }
    const inField = t && t.closest && t.closest('input, textarea, select');
    if (e.key === '/' && !inField && !e.ctrlKey && !e.metaKey && search) {
        e.preventDefault();
        if (!isDesktop() && state.nv.pane !== 'list') {
            if (!confirmLeaveNotePane()) return;
            openNotes({ pane: 'list' });
            requestAnimationFrame(() => document.getElementById('nv-search')?.focus());
        } else {
            search.focus();
            search.select();
        }
        return;
    }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && (!inField || t === search) && isDesktop()) {
        const rows = [...document.querySelectorAll('#nv-results .nv-row[data-id]')];
        if (!rows.length) return;
        e.preventDefault();
        let i = rows.findIndex(r => r.dataset.id === state.nv.noteId);
        i = i === -1 ? (e.key === 'ArrowDown' ? 0 : rows.length - 1)
            : Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
        openNoteById(rows[i].dataset.id);
        const row = document.querySelector(`#nv-results .nv-row[data-id="${CSS.escape(rows[i].dataset.id)}"]`);
        if (row) row.scrollIntoView({ block: 'nearest' });
    }
}

// --- LLM share link ---
async function createShareLink() {
    try {
        setStatus('Creating share link…');
        const data = await api('/api/share', { method: 'POST' });
        setStatus('');
        try {
            await navigator.clipboard.writeText(data.url);
            showToast('Link copied — expires in 1 hour.');
        } catch (e) {
            window.prompt('Copy this link (expires in 1 hour):', data.url);
        }
    } catch (e) {
        setStatus('');
        alert('Failed to create share link: ' + e.message);
    }
}

// --- Pending LLM note proposals ---
function renderProposalsBlock() {
    const block = document.createElement('div');
    block.className = 'proposals';
    const heading = document.createElement('div');
    heading.className = 'proposals-title';
    heading.textContent = `⏳ Pending approval (${state.proposals.length})`;
    block.appendChild(heading);

    // Approving waits for a clean copy (see resolveProposal); say so up front.
    if (state.dirty) {
        const hint = document.createElement('div');
        hint.className = 'proposal proposals-push-hint';
        hint.innerHTML = `
            <div class="proposal-text"><span class="snippet">Push your changes first, then approve.</span></div>
            <div class="proposal-actions"><button class="primary proposals-push">⬆️ Push</button></div>
        `;
        hint.querySelector('.proposals-push').addEventListener('click', () => pushNow());
        block.appendChild(hint);
    }

    for (const p of state.proposals) {
        let title = p.title;
        let snippet = (p.content || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        if (p.kind === 'reorder') {
            title = '🔀 Reorder notes';
            let order = [];
            try { order = JSON.parse(p.content); } catch (e) { /* corrupt */ }
            snippet = order.join(' → ');
        }
        const item = document.createElement('div');
        item.className = 'proposal';
        item.innerHTML = `
            <div class="proposal-text">
                <span class="title">${escapeHtml(title)}${p.notebook ? ` <span class="notebook-badge">📓 ${escapeHtml(p.notebook)}</span>` : ''}</span>
                ${snippet ? `<span class="snippet">${escapeHtml(snippet)}</span>` : ''}
            </div>
            <div class="proposal-actions">
                <button class="primary proposal-approve">Approve</button>
                <button class="proposal-reject">Reject</button>
            </div>
        `;
        item.querySelector('.proposal-approve').addEventListener('click', () => resolveProposal(p, true));
        item.querySelector('.proposal-reject').addEventListener('click', () => resolveProposal(p, false));
        block.appendChild(item);
    }
    return block;
}

// The server makes an approved note or order on its own tree, and the phone
// pulls that tree down — which replaces this copy. So a copy with unpushed
// edits, or a note open in the editor (changed or not: it holds the text from
// before the pull, and saving it would write that back over an approval that
// rewrote the note), approves nothing: push (or save or close the note)
// first, and the proposal keeps waiting. A clean copy approves, then pulls.
async function resolveProposal(p, approve) {
    if (approve && (state.dirty || editorOpen())) {
        askToPushBeforeApproving();
        return;
    }
    const account = accountKey();
    try {
        setStatus(approve ? 'Approving…' : 'Rejecting…');
        await api(`/api/proposals/${p.id}/${approve ? 'approve' : 'reject'}`, { method: 'POST' });
        setStatus('');
        if (approve) {
            if (p.kind === 'reorder') {
                // The default Edited sort would hide the new order.
                NV_UI.sort = 'manual';
                saveNotesPrefs();
            }
            const done = p.kind === 'reorder' ? 'New order applied (Manual order)' : `Note “${p.title}” added`;
            if (accountKey() !== account) {
                // Signed out or switched while it was on its way: this copy is
                // not the one it went into.
            } else if (state.dirty) {
                // Edited while it was on its way: no pull over that.
                showToast(`${done} on the server — not pulled here, over the changes made meanwhile.`);
            } else if (editorOpen()) {
                // A note opened while it was on its way: no pull under that.
                showToast(`${done} on the server — not pulled here under your open note. ⬇️ Pull once it is saved or closed.`);
            } else {
                showToast(`${done}.`);
                await pullSnapshot(); // server applied the change — pull it down
            }
        } else {
            showToast('Proposal rejected.');
        }
        await refreshProposals();
        renderView();
    } catch (e) {
        setStatus('');
        alert('Action failed: ' + e.message);
    }
}

function askToPushBeforeApproving() {
    const writing = editorOpen();
    if (!state.dirty) {
        alert('Save or close your note first, then approve.\n\n'
            + 'You have a note open in the editor, and approving pulls the server’s tree under it: '
            + 'the editor would keep the text from before, and saving it could undo what you approved. '
            + '✓ Done saves and pushes it; ✕ closes it.\n\nThe proposal keeps waiting.');
        return;
    }
    const n = state.editCount || 1;
    const what = `${n} unpushed edit${n === 1 ? '' : 's'}${writing ? ' and a note open in the editor' : ''}`;
    if (confirm('Push your changes first, then approve.\n\n'
        + `This phone has ${what}. Approving pulls the server’s tree, which would replace ${n === 1 && !writing ? 'it' : 'them'}.\n\n`
        + `OK = ⬆️ Push now, then tap Approve again${writing ? ' (save or close the note first)' : ''}\n`
        + 'Cancel = not now — the proposal keeps waiting')) {
        pushNow();
    }
}

// --- Import links (#notes / #reorder): review block in the notes section ---
function renderImportBlock() {
    const batch = state.importBatch;
    const block = document.createElement('div');
    block.className = 'proposals import-batch';
    const heading = document.createElement('div');
    heading.className = 'proposals-title';
    heading.textContent = batch.kind === 'reorder'
        ? `📥 Review new order (${batch.order.length} notes)`
        : `📥 Review import (${batch.items.length} note${batch.items.length > 1 ? 's' : ''})`;
    block.appendChild(heading);

    const list = document.createElement('div');
    list.className = 'import-list';
    if (batch.kind === 'reorder') {
        list.innerHTML = batch.order
            .map((t, i) => `<div class="import-item">${i + 1}. ${escapeHtml(t)}</div>`)
            .join('');
    } else {
        list.innerHTML = batch.items.map(it => {
            const t = NM.leadingTitle(it.content) || 'Untitled';
            return `<div class="import-item">📝 ${escapeHtml(t)}${it.notebook ? ` <span class="notebook-badge">📓 ${escapeHtml(it.notebook)}</span>` : ''}</div>`;
        }).join('');
    }
    block.appendChild(list);

    const actions = document.createElement('div');
    actions.className = 'proposal-actions import-actions';
    const okBtn = document.createElement('button');
    okBtn.className = 'primary';
    okBtn.textContent = batch.kind === 'reorder' ? 'Apply order' : 'Import';
    okBtn.addEventListener('click', applyImportBatch);
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Discard';
    cancelBtn.addEventListener('click', () => {
        state.importBatch = null;
        dropPendingImport(batch.importId); // dismissed on purpose
        renderView();
    });
    actions.appendChild(okBtn);
    actions.appendChild(cancelBtn);
    block.appendChild(actions);
    return block;
}

async function applyImportBatch() {
    const batch = state.importBatch;
    if (!batch) return;
    const found = await ensureNotesFolder({ create: true });
    if (!found || state.importBatch !== batch) return;
    const now = new Date().toISOString();

    if (batch.kind === 'reorder') {
        applyNoteOrder(found.node, batch.order);
        NV_UI.sort = 'manual';
        saveNotesPrefs();
    } else {
        for (const it of batch.items) {
            // Resolved against the tree as it grows, so two items naming the
            // same new notebook land in one notebook.
            const parent = it.notebook ? (ensureNotebookByName(it.notebook) || found.node) : found.node;
            const title = NM.leadingTitle(it.content) || 'Untitled';
            const note = { type: 'bookmark', title, url: encodeNoteUrl({ content: it.content, createdAt: now, updatedAt: now }) };
            assignIds(note);
            parent.children = parent.children || [];
            parent.children.push(note);
        }
    }

    // In the copy now: an unpushed edit like any other if the push fails,
    // and the link stays on the phone until a push gets it to the server.
    state.importBatch = null;
    holdImportInCopy(batch.importId);
    markDirty();
    try {
        setStatus('Saving…');
        await pushSnapshot();
        showToast(batch.kind === 'reorder'
            ? 'New order applied (Manual order)'
            : `Imported ${batch.items.length} note${batch.items.length > 1 ? 's' : ''}.`);
        setStatus('');
    } catch (e) {
        alert('Import failed: ' + e.message + '\nLocal changes preserved; use ⬆️ to retry.');
        setStatus('');
    }
    renderView();
}

// Sort note children in every folder under the notes root to match the given
// list of titles; unlisted notes keep their relative order at the end.
function applyNoteOrder(notesRoot, order) {
    const idx = new Map(order.map((t, i) => [t, i]));
    const rank = (n) => (idx.has(n.title) ? idx.get(n.title) : Infinity);
    const sortFolder = (folder) => {
        const kids = folder.children || [];
        const sortedNotes = kids.filter(isNoteBookmark).sort((a, b) => rank(a) - rank(b));
        let ni = 0;
        folder.children = kids.map(c => isNoteBookmark(c) ? sortedNotes[ni++] : c);
        for (const c of folder.children) {
            if (c && (c.type === 'folder' || c.type === 'root')) sortFolder(c);
        }
    };
    sortFolder(notesRoot);
}

// Render note content GitHub/Obsidian-style: # headings, real - and 1.
// lists, tasks, **bold**, *italic*, `code`, [[wiki-links]] as clickable chips,
// bare URLs as links. Returns the block elements, built as DOM nodes: the
// inline parts come from notesModel's tokens (NM.appendInlineNodes), so a
// note's text only ever goes in as text, a chip's target through dataset and
// a link's href through safeHref. It used to be an HTML string, and a URL
// inside a wikilink broke out of the chip's attribute.
//
// Uses only NM and `doc`, nothing else from this file:
// tools/test_render_safety.mjs evaluates it on its own.
//
// `skipTitle` drops a leading '# Title' that repeats the note's title, which
// the page already shows as its heading.
function renderNotePreview(doc, content, skipTitle = '') {
    const blocks = [];
    const el = (tag, cls) => {
        const node = doc.createElement(tag);
        if (cls) node.className = cls;
        return node;
    };
    const inline = (parent, text) => NM.appendInlineNodes(doc, parent, NM.renderInlineTokens(text), { target: '_blank', rel: 'noopener' });
    let list = null; // { tag: 'ul' | 'ol', node }
    const listOf = (tag, cls) => {
        if (!list || list.tag !== tag) {
            list = { tag, node: el(tag, cls) };
            blocks.push(list.node);
        }
        return list.node;
    };
    const closeList = () => { list = null; };
    const lines = String(content || '').split('\n');
    const first = lines.findIndex(l => l.trim());
    const skip = String(skipTitle || '').trim().toLowerCase();
    for (let i = 0; i < lines.length; i++) {
        const rawLine = lines[i];
        if (i === first && skip) {
            const h1 = rawLine.match(/^#\s+(.+?)\s*$/);
            if (h1 && h1[1].trim().toLowerCase() === skip) continue;
        }
        const trimmed = rawLine.trim();
        if (!trimmed) { closeList(); continue; }

        // Task items before the plain-bullet rule — "- [ ] x" is also a bullet.
        // data-line ties the box back to its source line for the write-back.
        const task = NM.parseTaskLine(rawLine);
        if (task) {
            const li = el('li', 'note-task' + (task.checked ? ' done' : ''));
            if (task.indent) li.style.marginLeft = `${task.indent * 12}px`;
            const box = el('input', 'note-task-box');
            box.type = 'checkbox';
            box.dataset.line = String(i);
            box.checked = task.checked;
            li.appendChild(box);
            li.appendChild(inline(el('span'), task.label));
            listOf('ul', 'note-tasks').appendChild(li);
            continue;
        }

        const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
        if (heading) {
            closeList();
            blocks.push(inline(el(`h${heading[1].length}`), heading[2]));
            continue;
        }

        const bullet = rawLine.match(/^\s*[-*]\s+(.+)$/);
        if (bullet) {
            listOf('ul').appendChild(inline(el('li'), bullet[1]));
            continue;
        }

        const numbered = rawLine.match(/^\s*\d+[.)]\s+(.+)$/);
        if (numbered) {
            listOf('ol').appendChild(inline(el('li'), numbered[1]));
            continue;
        }

        closeList();
        blocks.push(inline(el('p'), rawLine));
    }
    return blocks;
}

// --- Bottom tab bar ---
// The highlight follows what is on screen rather than the last tap: Notes
// while Notes shows, Inbox or Settings only while their sheet is open, Home
// otherwise — including a note opened straight from Home, whose back goes
// to Home. The Notes tab carries the pending-proposal count, the Inbox tab
// what waits to be filed.
function syncBottomNav() {
    const nav = $('bottom-nav');
    const open = (id) => { const el = $(id); return Boolean(el) && !el.classList.contains('hidden'); };
    const fromHome = state.nv.pane === 'note' && state.nv.from === 'Home';
    const active = open('settings-sheet') ? 'settings'
        : open('inbox-sheet') || open('share-sheet') ? 'inbox'
            : state.view === 'notes' && !fromHome ? 'notes' : 'home';
    if (nav) {
        for (const b of nav.querySelectorAll('button[data-nav]')) b.classList.toggle('on', b.dataset.nav === active);
        const badge = nav.querySelector('.bn-badge');
        if (badge) {
            const n = state.proposals.length;
            badge.textContent = n > 99 ? '99+' : String(n);
            badge.classList.toggle('hidden', n === 0);
        }
        const inboxBadge = nav.querySelector('.inbox-badge');
        if (inboxBadge) {
            const n = configured() ? inboxCount : 0;
            inboxBadge.textContent = n > 99 ? '99+' : String(n);
            inboxBadge.classList.toggle('hidden', n === 0);
        }
    }
    const notesBtn = $('notesBtn');
    if (notesBtn) notesBtn.classList.toggle('on', state.view === 'notes');
}

// --- Inbox ---
// One list (shareSheet.js) for everything waiting to be filed: shares not
// uploaded yet, the server's inbox, copied links, and what was filed lately.
// The tab bar has it on a phone; on a desktop, where there is no tab bar, the
// floating button does, with the same count.
let shareSheet = null;
let inboxBase = 0;   // what the inbox itself counts
let inboxCount = 0;  // ... plus copied links waiting

function setInboxCount(n = inboxBase) {
    inboxBase = n;
    inboxCount = inboxBase + clipboardSuggestions().length;
    updateInboxFab();
    syncBottomNav();
}

function updateInboxFab() {
    const fab = $('inbox-fab');
    const count = $('inbox-count');
    if (!fab || !count) return;
    if (!inboxCount || !configured()) { hide(fab); return; }
    count.textContent = inboxCount > 99 ? '99+' : String(inboxCount);
    show(fab);
}

function openInbox() {
    if (!shareSheet) return;
    shareSheet.openInbox();
    syncBottomNav();
}

// ⬆️ Push: the topbar button, Home's quick action, and the way past a
// proposal waiting for a clean copy.
async function pushNow() {
    if (!configured()) {
        showToast('Please open settings (⚙) first.');
        return false;
    }
    if (!state.snapshot) {
        showToast('No snapshot loaded to push.');
        return false;
    }
    try {
        setStatus('Pushing…');
        lastFold = null;
        await pushSnapshot();
        setStatus('');
        const n = lastFold ? lastFold.applied : 0;
        showToast(n ? `Pushed — included ${n} filed link${n === 1 ? '' : 's'} from another device.` : 'Pushed.');
        renderView();
        return true;
    } catch (err) {
        setStatus('Push failed: ' + err.message);
        showToast('Push failed: ' + err.message);
        return false;
    }
}

// What the last push folded in from links filed elsewhere, for its message.
let lastFold = null;

async function pushSnapshot(opts) {
    syncBusy++;
    try {
        return await pushSnapshotOnce(opts);
    } finally {
        syncBusy--;
    }
}

async function pushSnapshotOnce({ force = false, attempt = 0 } = {}) {
    const roots = (state.snapshot.children || []).map(toWire).filter(Boolean);
    // Pushing an empty tree erases everything server-side for every device —
    // never do that without a very explicit yes.
    if (roots.length === 0 && (state.treeVersion || 0) > 0) {
        if (!confirm('This would push an EMPTY tree and erase all bookmarks on the server. Really continue?')) {
            throw new Error('Push cancelled — tree is empty.');
        }
    }
    const baseUserId = state.snapshotUserId ?? null;
    const baseServerId = state.snapshotServerId || null;
    // What goes up with this push: the import links in the copy as it is
    // now, and the edits counted so far. Anything added while the push is on
    // its way goes up with the next one.
    const copy = state.snapshot;
    const carried = copyImportIds().slice();
    const edits = state.editCount;
    const base = state.treeVersion || 0;
    try {
        const data = await api('/api/tree', {
            method: 'PUT',
            body: JSON.stringify({
                roots, baseVersion: base, deviceId: 'pwa', force,
                ...(baseUserId !== null ? { baseUserId } : {}),
                ...(baseServerId ? { baseServerId } : {})
            })
        });
        // The copy was replaced while the push was on its way (a pull, a
        // sign-out, another account signing in): the server has what was
        // sent, and nothing here describes the copy now on screen, so none of
        // its version, owner or edit count may be stamped onto it.
        if (state.snapshot !== copy) {
            if (carried.length) dropPendingImports(carried);
            return;
        }
        state.treeVersion = Number(data.version) || base + 1;
        if (data.userId !== undefined) state.snapshotUserId = data.userId;
        if (data.serverId) state.snapshotServerId = data.serverId;
        state.editCount = Math.max(0, state.editCount - edits);
        state.dirty = state.editCount > 0;
        state.serverIds = idsOf(roots);
        // On the server now: the links those imports came from are done.
        if (carried.length) {
            dropPendingImports(carried);
            copy._importIds = (copy._importIds || []).filter(id => !carried.includes(id));
        }
        noteSync('push');
        saveTreeCache();
    } catch (e) {
        // This copy belongs to another account. Forcing would write it into
        // this one, so there is no offer to — sign in as its account to push.
        if (e.status === 412) {
            throw new Error('This working copy belongs to another account — sign in as that account to push it.');
        }
        // A stale baseVersion means another device pushed since our last pull.
        // Never overwrite that silently — ask.
        if (/^409[\s:]/.test(e.message) || /changed on the server/i.test(e.message)) {
            if (state.snapshot !== copy) {
                throw new Error('The working copy changed while pushing — nothing was overwritten. Push again.');
            }
            // Unless all that changed is links filed from a share sheet: those
            // are folded into this copy, and the push goes again.
            if (!force && attempt < 3) {
                const folded = await rebaseOntoServer(copy, base);
                if (folded) {
                    lastFold = { applied: (lastFold ? lastFold.applied : 0) + folded.applied, relocated: (lastFold ? lastFold.relocated : 0) + folded.relocated };
                    return pushSnapshot({ force, attempt: attempt + 1 });
                }
            }
            if (state.snapshot !== copy) {
                throw new Error('The working copy changed while pushing — nothing was overwritten. Push again.');
            }
            if (confirm('Another device pushed changes since this phone last pulled.\n\nOK = overwrite the server with THIS phone\'s version\nCancel = keep both as they are (pull later to see theirs — your edit is then lost)')) {
                // The dialog waits on the user; the copy may change meanwhile.
                if (state.snapshot !== copy) {
                    throw new Error('The working copy changed while you decided — nothing was overwritten. Push again.');
                }
                return pushSnapshot({ force: true });
            }
        }
        throw e;
    }
}

// --- Links filed from a share sheet, folded into the copy ----------------------
//
// Filing is an append on the server, not a push of this copy, so the copy
// learns of it one of two ways: from the filing's own answer (applyFiled,
// when this app filed it), or from the server's ops log when a push meets a
// 409 (rebaseOntoServer). Either way only nodes that are not here yet are
// added, so the two never double up.

// The copy's nodes by id, for shareCore's applyOps.
function localAdapter(wrapper) {
    const nodes = new Map();
    const parents = new Map();
    const walk = (node) => {
        for (const c of node.children || []) {
            if (c._pwaId) { nodes.set(String(c._pwaId), c); parents.set(String(c._pwaId), node); }
            if (c.children) walk(c);
        }
    };
    walk(wrapper);
    const isFolder = (n) => n.type === 'folder' || n.type === 'root';
    return {
        find: (id) => nodes.get(String(id)) || null,
        kindOf: (n) => (isFolder(n) ? 'folder' : typeof n.url === 'string' && n.url.startsWith(NOTE_DATA_PREFIX) ? 'note' : 'bookmark'),
        urlOf: (n) => n.url,
        childCount: (n) => (n.children || []).length,
        insert(parent, spec) {
            const node = spec.kind === 'folder'
                ? { type: 'folder', title: spec.title, _pwaId: spec.id, children: [] }
                : { type: 'bookmark', title: spec.title, url: spec.url, _pwaId: spec.id };
            // Carried like a pulled node's (fromWire), so a push keeps it.
            if (spec.payload) node._payload = spec.payload;
            const into = parent || wrapper;
            (into.children = into.children || []).push(node);
            nodes.set(String(spec.id), node);
            parents.set(String(spec.id), into);
            return node;
        },
        remove(node) {
            const p = parents.get(String(node._pwaId));
            if (!p) return;
            const i = (p.children || []).indexOf(node);
            if (i >= 0) p.children.splice(i, 1);
            nodes.delete(String(node._pwaId));
        },
        fallbackParent: () => [...nodes.values()].find(n => isFolder(n) && n._role === 'bookmarks') || null
    };
}

// After a 409 at `base`: when everything the server gained since is links
// filed (or taken back) from a share sheet, fold them into the copy that was
// refused and say how many; otherwise null, and the push asks as before. Only
// into that copy as it was, and only with what the server says of this copy's
// own account.
async function rebaseOntoServer(copy, base) {
    // A filing from this phone (applyFiled) moved the same copy on while the
    // push was on its way: nothing to fold, only push again from there.
    const movedOn = () => state.snapshot === copy && (state.treeVersion || 0) !== base;
    if (movedOn()) return { applied: 0, relocated: 0 };
    let ops;
    try {
        ops = await api('/api/tree/ops?since=' + encodeURIComponent(base));
    } catch (e) {
        return null;
    }
    if (movedOn()) return { applied: 0, relocated: 0 };
    if (state.snapshot !== copy || (state.treeVersion || 0) !== base || !ops || !ops.complete) return null;
    if (ops.userId !== undefined && state.snapshotUserId != null && Number(ops.userId) !== Number(state.snapshotUserId)) return null;
    if (ops.serverId && state.snapshotServerId && ops.serverId !== state.snapshotServerId) return null;
    const result = Share.applyOps(ops.ops || [], localAdapter(copy));
    state.treeVersion = Number(ops.version) || base;
    for (const op of ops.ops || []) {
        for (const n of (op.payload && op.payload.nodes) || []) state.serverIds.add(String(n.id));
    }
    state.treeRev++;
    saveTreeCache();
    if (!editorOpen()) renderView();
    return result;
}

// A filing this app made (or the worker made and told it of): its new
// folders and bookmarks go into the copy, and when the copy was based on the
// version the filing started from, it is based on the filing's version now —
// with its own unpushed edits, if any, still on top.
function applyFiled(res) {
    applyFiling(res, 'append', (res && res.created) || []);
}

function applyUnfiled(res) {
    applyFiling(res, 'unappend', (res && res.removed) || []);
}

function applyFiling(res, kind, list) {
    if (!res || !state.snapshot || !configured() || !copyIsMine()) return;
    // A filing names the account and server whose tree it changed: never
    // folded into another's copy (an answer that arrived after a sign-in).
    if (res.userId !== undefined && res.userId !== null && state.snapshotUserId != null && Number(res.userId) !== Number(state.snapshotUserId)) return;
    if (res.serverId && state.snapshotServerId && res.serverId !== state.snapshotServerId) return;
    const copy = state.snapshot;
    Share.applyOps([{ kind, payload: kind === 'append' ? { nodes: list } : { items: list } }], localAdapter(copy));
    for (const n of list) {
        if (kind === 'append') state.serverIds.add(String(n.id));
        else state.serverIds.delete(String(n.id));
    }
    if (Number(res.baseVersion) === (state.treeVersion || 0) && Number(res.version) > Number(res.baseVersion)) {
        state.treeVersion = Number(res.version);
    }
    state.treeRev++;
    saveTreeCache();
    if (!editorOpen()) renderView();
}

// --- Copied links ---
//
// Both lists are per account (<key>:<userId>): one person's skipped links are
// not another's. The per-device lists from before accounts are adopted once,
// by the server's owner only — whose phone they were. Copied links show in
// the Inbox under From clipboard until filed (through the share sheet) or
// skipped.
const DISMISSED_KEY = 'tp_dismissed_urls';
const SCANNED_CLIPBOARD_KEY = 'tp_scanned_clipboard_links';

function userKey(base) {
    const id = currentUserId();
    if (id === null) return base; // not told yet: an older session, which is the owner's
    const key = `${base}:${id}`;
    if (localStorage.getItem(key) === null && localStorage.getItem(base) !== null && localStorage.getItem(LS.owner) === '1') {
        localStorage.setItem(key, localStorage.getItem(base));
        localStorage.removeItem(base);
    }
    return key;
}

function normalizeUrl(u) {
    try {
        const parsed = new URL(u);
        return parsed.origin + parsed.pathname.replace(/\/$/, '') + parsed.search + parsed.hash;
    } catch (e) {
        return (u || '').trim().replace(/\/$/, '');
    }
}

function getDismissedUrls() {
    try { return JSON.parse(localStorage.getItem(userKey(DISMISSED_KEY))) || []; }
    catch (e) { return []; }
}

function dismissUrl(url) {
    const list = getDismissedUrls();
    const norm = normalizeUrl(url);
    if (!list.includes(norm)) {
        list.push(norm);
        localStorage.setItem(userKey(DISMISSED_KEY), JSON.stringify(list));
    }
}

function getScannedClipboardLinks() {
    try { return JSON.parse(localStorage.getItem(userKey(SCANNED_CLIPBOARD_KEY))) || []; }
    catch (e) { return []; }
}

function addScannedClipboardLink(url, title) {
    const list = getScannedClipboardLinks();
    const norm = normalizeUrl(url);
    if (!list.some(item => normalizeUrl(item.url) === norm)) {
        list.push({ url, title, addedAt: Date.now() });
        localStorage.setItem(userKey(SCANNED_CLIPBOARD_KEY), JSON.stringify(list));
    }
}

function removeScannedClipboardLink(url) {
    const list = getScannedClipboardLinks();
    const norm = normalizeUrl(url);
    const filtered = list.filter(item => normalizeUrl(item.url) !== norm);
    localStorage.setItem(userKey(SCANNED_CLIPBOARD_KEY), JSON.stringify(filtered));
}

function isUrlInSnapshot(url, node) {
    if (!node) return false;
    if (node.type === 'bookmark' && normalizeUrl(node.url) === normalizeUrl(url)) return true;
    if (node.children) {
        for (const child of node.children) {
            if (isUrlInSnapshot(url, child)) return true;
        }
    }
    return false;
}

// Copied links still worth offering: signed in, not skipped, not filed.
function clipboardSuggestions() {
    if (!configured() || accountChanging) return [];
    const dismissed = new Set(getDismissedUrls().map(normalizeUrl));
    return getScannedClipboardLinks().filter(item => !dismissed.has(normalizeUrl(item.url))
        && !(state.snapshot && isUrlInSnapshot(item.url, state.snapshot)));
}

let _lastClipboardScanTime = 0;

// Signed in only: the suggestions are filed into, and remembered for, the
// signed-in account. Signed out there is none — a copy kept on the phone is
// its account's, not the place for whatever is on the clipboard now. Never
// while the share sheet is up: Android announces every clipboard read.
async function checkUnfiledLinks(skipClipboardScan = false) {
    if (!state.snapshot || !configured()) return;
    if (shareSheet && shareSheet.isOpen()) return;
    const dismissedSet = new Set(getDismissedUrls().map(normalizeUrl));
    for (const item of getScannedClipboardLinks()) {
        if (isUrlInSnapshot(item.url, state.snapshot)) removeScannedClipboardLink(item.url);
    }
    // At most once every 3s.
    if (!skipClipboardScan) {
        const now = Date.now();
        if (now - _lastClipboardScanTime > 3000) {
            _lastClipboardScanTime = now;
            if (navigator.clipboard && navigator.clipboard.readText) {
                try {
                    const text = await navigator.clipboard.readText();
                    const trimmed = (text || '').trim();
                    if (/^https?:\/\/\S+$/.test(trimmed) && configured() && !isUrlInSnapshot(trimmed, state.snapshot)
                        && !dismissedSet.has(normalizeUrl(trimmed))) {
                        addScannedClipboardLink(trimmed, trimmed);
                    }
                } catch (e) {
                    // Silently swallow clipboard permission errors
                }
            }
        }
    }
    setInboxCount();
}

// --- Shares ---------------------------------------------------------------------
//
// A share is kept in the outbox before anything touches the network — by the
// worker, or here when it arrives the old way, in the URL — and stays there
// until the server has taken it in and the user has filed it, left it for
// later or discarded it. Each records the account signed in when it was
// shared; it is only ever uploaded as that account, and one shared while
// nobody (or someone else) was signed in waits for a yes.

// Shares an earlier build queued in localStorage, moved into the outbox.
async function migrateLegacyShares() {
    let list = [];
    try { list = JSON.parse(localStorage.getItem(LS.legacyShares) || '[]'); } catch (e) { list = []; }
    if (!Array.isArray(list)) list = [];
    if (!list.length) {
        if (localStorage.getItem(LS.legacyShares) !== null) localStorage.removeItem(LS.legacyShares);
        return 0;
    }
    let existing = [];
    try { existing = await outbox.list(); } catch (e) { return 0; }
    const base = (state.config.url || '').replace(/\/+$/, '');
    let moved = 0;
    for (const old of list) {
        if (!old || typeof old.url !== 'string' || !old.url) continue;
        // Moved already, by a start that stopped halfway.
        if (existing.some(e => e.fields && e.fields.url === old.url && e.createdAt === old.at)) continue;
        const mine = old.userId !== null && old.userId !== undefined && Number(old.userId) === currentUserId();
        const account = old.userId === null || old.userId === undefined ? null : {
            url: base, userId: Number(old.userId),
            username: mine ? localStorage.getItem(LS.username) : null,
            serverId: mine ? localStorage.getItem(LS.serverId) : null
        };
        const at = old.at && !Number.isNaN(Date.parse(old.at)) ? new Date(old.at) : new Date();
        try {
            // Bound for the inbox, as the old queue delivered them: once
            // uploaded they leave the phone.
            await outbox.put({ ...Share.makeEntry({ fields: { url: old.url, title: old.title || '', text: '' }, account, source: 'share', now: at }), later: true });
            moved++;
        } catch (e) {
            return moved; // still in the old queue; moved on the next start
        }
    }
    localStorage.removeItem(LS.legacyShares);
    return moved;
}

// The share that opened the app, if one did: /?share=<sid> (kept by the
// worker) or /?share=1&url&title&text (the server's fallback, or the worker's
// when it could not keep it), which goes into the outbox now. The address is
// cleaned once the share is kept, so neither a reload nor back brings it
// round again and no history entry holds the link.
async function handleShareEntry() {
    const params = new URLSearchParams(location.search);
    const id = params.get('share');
    if (!id) return null;
    let entry = null;
    if (id === '1') {
        const fields = { url: params.get('url') || '', title: params.get('title') || '', text: params.get('text') || '' };
        entry = Share.makeEntry({ fields, account: shareAccount(), source: 'share' });
        try {
            await outbox.put(entry);
        } catch (e) {
            showToast('This share could not be kept on the phone — it stays in the address bar for now.');
            return entry;
        }
    } else {
        entry = await outbox.get(id).catch(() => null);
        if (!entry && configured()) {
            try {
                entry = shareSheet.entryFromShare((await api('/api/shares/' + encodeURIComponent(id))).share);
            } catch (e) {
                entry = null;
            }
        }
        if (!entry) showToast('That share is no longer on this phone — look in the Inbox.');
    }
    history.replaceState(null, '', location.pathname);
    return entry;
}

// Upload what waits (and file what was chosen offline), for the account
// signed in now. Filed links go into the copy; a dead session is found out
// the usual way; offline, the browser is asked to try again when it can.
async function flushShares(sids = null) {
    const cfg = shareConfig();
    if (!cfg) return null;
    let res;
    try {
        res = await Share.flushOutbox({ outbox, cfg, fetch: (u, o) => fetch(u, o), sids });
    } catch (e) {
        return null;
    }
    // What it filed went into the tree of the account it flushed as; signed
    // out, or in as someone else, by now, none of it is this copy's.
    if (!stillSignedInAs(cfg)) return res;
    for (const f of res.filed) applyFiled(f.result);
    if (res.filed.length) loadShareStats();
    if (shareSheet) shareSheet.onFlushed(res);
    if (res.stopped === 'auth') {
        try { await api('/api/auth/me'); } catch (e) { /* api() has said so */ }
    }
    // The server says this session is not the account the share was kept
    // for: learn again who it is (nothing was sent or changed).
    if (res.stopped === 'account') await refreshWhoAmI();
    if (res.stopped === 'network') registerShareSync();
    return res;
}

// Is the account something was started for (a flush, a fetch) still the one
// signed in? Its answer is dropped otherwise.
function stillSignedInAs(account) {
    const now = shareConfig();
    return Boolean(account && now) && Share.sameAccount(Share.accountOf({ ...account, token: account.token || 'x' }), now);
}

function registerShareSync() {
    try {
        if (!('serviceWorker' in navigator) || !navigator.serviceWorker || !navigator.serviceWorker.ready) return;
        navigator.serviceWorker.ready.then(reg => reg.sync && reg.sync.register('tp-outbox')).catch(() => {});
    } catch (e) { /* no Background Sync: the next start or 'online' sends it */ }
}

// Shares made while nobody was signed in: offered to the account signing in
// now, never sent on their own. (The share sheet asks for the one it shows.)
// One kept for another account is not offered here: it is that account's,
// and waits in the Inbox under its name, with Upload to <you> for a yes.
async function offerUnclaimedShares() {
    const me = shareConfig();
    if (!me) return;
    let list = [];
    try { list = await outbox.list(); } catch (e) { return; }
    const others = list.filter(e => e.url && !e.account && !e.uploaded && !(shareSheet && shareSheet.current() === e.sid));
    if (!others.length) return;
    const n = others.length;
    const who = me.username || 'this account';
    if (confirm(`${n} link${n === 1 ? ' was' : 's were'} shared while signed out — add ${n === 1 ? 'it' : 'them'} to ${who}'s inbox?`)) {
        const account = shareAccount();
        // Into the inbox: once uploaded they leave the phone.
        for (const e of others) await outbox.update(e.sid, (c) => (c.account ? null : { ...Share.claimEntry(c, account), later: true })).catch(() => {});
        const res = await flushShares(others.map(e => e.sid));
        if (res && res.uploaded.length) showToast(`${res.uploaded.length} shared link${res.uploaded.length === 1 ? '' : 's'} added`);
        return;
    }
    if (confirm(`Discard ${n === 1 ? 'that link' : `those ${n} links`}? Cancel keeps ${n === 1 ? 'it' : 'them'} on this phone for later (in the Inbox).`)) {
        for (const e of others) await outbox.remove(e.sid).catch(() => {});
    }
}

// --- The working copy, kept for the next start --------------------------------
//
// Kept in IndexedDB (durableCopy.js): written a moment after every change and
// at once when the app goes to the background or away, and the note being
// written is kept as it is typed. So a reload, a share that reloads the
// window, or the phone closing the app loses neither unpushed edits nor a
// half-written note. It says whose it is, and comes back only under the same
// rules as a copy kept in memory: for its own account, or signed out (for its
// account to come back to) when it holds work.
//
// The same record still goes into Cache Storage (tp-data) for one more
// release: the previous release reads it from there after a step back, and
// this one starts from it when IndexedDB holds nothing, or something older.
const DATA_CACHE = 'tp-data';
const TREE_KEY = '/__tp_tree';
const PREFS_KEY = '/__tp_prefs';
const STATS_KEY = '/__tp_stats';
// How long after an edit the copy is written, and after the last key the
// note being written.
const COPY_SAVE_MS = 150;
const LIVE_DRAFT_MS = 500;
// How long a hand-over to another window waits for a pull or push on its way.
const SYNC_WAIT_MS = 8000;
// The savedAt of the record this release last wrote into tp-data (see
// DC.chooseKept), and this window's claim on the copy where IndexedDB cannot
// hold it.
const TP_DATA_AT_KEY = 'tp_copy_tpdata_at';
const CLAIM_LS_KEY = 'tp_copy_claim';

// Reading indexedDB itself throws where site data is blocked.
const kv = DC.createKv((() => { try { return globalThis.indexedDB; } catch (e) { return null; } })());
const windowId = DC.newId();
// Which window edits the copy (startApp); null until then, and where it
// could not be set up — every window edits then, as before.
let guard = null;
// What this window knows of the copy beyond the snapshot, kept with it.
const copyMeta = { copyId: null, seq: 0, lastSyncAt: null, lastSyncKind: null };
// Where the last write kept it ('kv', 'tp-data', or null for nowhere), and
// why the last one that should have kept it did not.
let keptIn = null;
let copyWriteError = null;
let copyTimer = null;
let draftTimer = null;

function noteSync(kind) {
    copyMeta.lastSyncAt = new Date().toISOString();
    copyMeta.lastSyncKind = kind;
}

async function dataCache() {
    if (typeof caches === 'undefined' || !caches || typeof caches.open !== 'function') return null;
    try { return await caches.open(DATA_CACHE); } catch (e) { return null; }
}

async function readData(key) {
    try {
        const c = await dataCache();
        const hit = c && await c.match(key);
        return hit ? await hit.json() : null;
    } catch (e) {
        return null;
    }
}

// Why the last write refused, when Cache Storage was there to write to.
let dataWriteError = null;

async function writeData(key, value) {
    try {
        const c = await dataCache();
        if (!c) return false;
        if (value === null) await c.delete(key);
        else await c.put(key, new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } }));
        dataWriteError = null;
        return true;
    } catch (e) {
        dataWriteError = e;
        return false;
    }
}

// Is a kept record's account the one signed in now?
function sameKeptAccount(acct) {
    if (!acct || !configured()) return false;
    const url = state.config.url.replace(/\/+$/, '');
    if ((acct.url || '').replace(/\/+$/, '') !== url) return false;
    const serverId = localStorage.getItem(LS.serverId);
    if (acct.serverId && serverId && acct.serverId !== serverId) return false;
    const id = currentUserId();
    if (acct.userId !== null && acct.userId !== undefined && id !== null) return Number(acct.userId) === id;
    const name = (localStorage.getItem(LS.username) || '').normalize('NFKC').toLowerCase();
    return Boolean(name) && String(acct.username || '').normalize('NFKC').toLowerCase() === name;
}

// A copy with work in it kept for another account than the one signed in:
// never written over until that account has it back.
let foreignKeptCopy = null;
let treeCacheWrite = Promise.resolve();

// Another window edits the copy now: this one writes nothing.
function halted() {
    return Boolean(guard) && !guard.isPrimary();
}

function keptAccount() {
    return {
        url: (state.snapshotUrl || state.config.url || '').replace(/\/+$/, ''),
        userId: state.snapshotUserId ?? null,
        username: state.snapshotUsername || localStorage.getItem(LS.username) || null,
        serverId: state.snapshotServerId || null
    };
}

function clearCopyTimers() {
    if (copyTimer) clearTimeout(copyTimer);
    if (draftTimer) clearTimeout(draftTimer);
    copyTimer = null;
    draftTimer = null;
}

// After an edit: written once the burst is over.
function scheduleCopySave() {
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
        copyTimer = null;
        saveTreeCache();
    }, COPY_SAVE_MS);
}

// After a key in the note editor: its text is written once typing pauses.
function scheduleLiveDraft() {
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
        draftTimer = null;
        saveLiveDraft();
    }, LIVE_DRAFT_MS);
}

// Write the copy as it is now (with the note being written, if any).
// Resolves true once it is kept, false when it could not be, and null when
// there was nothing of this window's to write.
function saveTreeCache() {
    clearCopyTimers();
    const snap = state.snapshot;
    if (!snap || accountChanging || halted()) return treeCacheWrite.then(() => null);
    const account = keptAccount();
    if (foreignKeptCopy) {
        const kept = foreignKeptCopy.account || {};
        if (kept.url !== account.url || Number(kept.userId) !== Number(account.userId)) return treeCacheWrite.then(() => null);
        foreignKeptCopy = null;
    }
    const record = {
        v: 1,
        savedAt: new Date().toISOString(),
        account,
        roots: (snap.children || []).map(toWire).filter(Boolean),
        version: state.treeVersion || 0,
        dirty: Boolean(state.dirty),
        editCount: state.editCount || 0,
        importIds: copyImportIds().slice(),
        serverIds: [...state.serverIds],
        nv: editorOpen() ? { ...state.nv } : null,
        keptDraft: state.keptDraft ? { ...state.keptDraft } : null,
        pathIds: state.pathIds.slice(1)
    };
    if (!copyMeta.copyId) copyMeta.copyId = DC.newId();
    copyMeta.seq++;
    const entries = {
        [DC.TREE_KEY]: DC.toKvRecord(record, copyMeta),
        // The note being written goes, or stays, with the copy it was
        // written in, in the same transaction: never before what it saved.
        [DC.DRAFT_KEY]: DC.liveDraftsFor(record.nv, account, windowId, record.savedAt)
    };
    treeCacheWrite = treeCacheWrite.then(() => writeKept(entries, record));
    return treeCacheWrite;
}

// The note being written, on its own, between writes of the copy.
function saveLiveDraft() {
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = null;
    // A copy kept for another account owns what is stored: its draft too.
    if (!state.snapshot || !editorOpen() || accountChanging || foreignKeptCopy || halted()) return treeCacheWrite;
    const drafts = DC.liveDraftsFor(state.nv, keptAccount(), windowId);
    treeCacheWrite = treeCacheWrite.then(async () => {
        try {
            const res = await kv.write({ [DC.DRAFT_KEY]: drafts }, { fence: fenceId() });
            if (res.fenced) lostCopy();
        } catch (e) { /* the next write of the copy, at the latest on hide, has it */ }
        return null;
    });
    return treeCacheWrite;
}

// The copy kept on the phone goes — the copy of the account signing in or
// out. One kept for another account with work in it (foreignKeptCopy) is not
// that copy: it stays until its own account signs in and has it back.
function clearTreeCache() {
    if (foreignKeptCopy || halted()) return treeCacheWrite;
    clearCopyTimers();
    treeCacheWrite = treeCacheWrite.then(() => writeKept({ [DC.TREE_KEY]: null, [DC.DRAFT_KEY]: null }, null));
    return treeCacheWrite;
}

// Write (or, with a null record, remove) the copy: into IndexedDB first, the
// copy this release starts from, then into tp-data. A write that finds
// another window's claim on the copy writes nothing, and this window stops
// editing. True once it is kept somewhere.
async function writeKept(entries, record) {
    const fence = fenceId();
    let inKv = false;
    let error = null;
    try {
        const res = await kv.write(entries, { fence });
        if (res.fenced) {
            lostCopy();
            return false;
        }
        inKv = true;
    } catch (e) {
        // No IndexedDB here is no failure: tp-data is what there is.
        if (!e || e.name !== 'NotSupportedError') error = e;
    }
    if (!inKv && fence && claimedElsewhere(fence)) {
        lostCopy();
        return false;
    }
    dataWriteError = null;
    const inTp = await writeData(TREE_KEY, record);
    if (inTp) {
        try {
            if (record) localStorage.setItem(TP_DATA_AT_KEY, record.savedAt);
            else localStorage.removeItem(TP_DATA_AT_KEY);
        } catch (e) { /* only the step-back check misses it */ }
    }
    noteCopyWrite({ inKv, inTp, error: error || dataWriteError, keeping: Boolean(record) });
    return inKv || inTp;
}

// What the last write did, for Settings, and a word when the device could
// not keep what it should have: the edits then live only in this window.
function noteCopyWrite({ inKv, inTp, error, keeping }) {
    keptIn = inKv ? 'kv' : inTp ? 'tp-data' : null;
    const before = copyWriteError;
    copyWriteError = keeping && !inKv && !inTp && error
        ? { name: error.name || 'Error', message: error.message || String(error), quota: DC.isQuotaError(error) }
        : null;
    if (copyWriteError && !before) {
        showToast(copyWriteError.quota
            ? `This ${deviceWord()} is out of storage: changes are kept only while the app stays open. ⬆️ Push them now.`
            : `Could not keep changes on this ${deviceWord()} (${copyWriteError.message}). ⬆️ Push them now.`);
    }
    if (settingsOpen()) refreshStorageUi();
}

// When this window claimed the copy: writes stop once another has since.
let claimedAt = 0;

// What every write checks: this window and its claim, or null where every
// window edits.
function fenceId() {
    const id = guard ? guard.fence() : null;
    return id ? { id, at: claimedAt } : null;
}

function claimedElsewhere(fence) {
    try {
        return DC.claimedSince(JSON.parse(localStorage.getItem(CLAIM_LS_KEY) || 'null'), fence);
    } catch (e) {
        return false;
    }
}

// This window edits the copy from now on: its claim goes where every write
// checks it.
async function claimCopy() {
    if (!guard || !guard.fence()) return;
    claimedAt = Date.now();
    const fence = fenceId();
    try { localStorage.setItem(CLAIM_LS_KEY, JSON.stringify(fence)); } catch (e) { /* IndexedDB holds it */ }
    try { await kv.claim(fence); } catch (e) { /* no IndexedDB: localStorage holds it */ }
}

function lostCopy() {
    if (guard) guard.lost('fenced');
}

// Going where it cannot answer — the back-forward cache, frozen in the
// background — a window lets go of the copy, written down just before (the
// write on its way still lands: it is fenced by this window's claim, which
// stands until another window claims the copy). It keeps what it holds in
// memory: back, it edits on in place when nobody claimed the copy meanwhile
// (resumeIfFree).
let awayFromCopy = false;

function letGoWhileAway() {
    if (!guard || !guard.isPrimary() || guard.mode !== 'locks') return;
    awayFromCopy = true;
    guard.lost('away');
}

// Has no other window claimed the copy since this one did?
async function claimStillMine() {
    const fence = fenceId();
    if (!fence) return true;
    try {
        return !DC.claimedSince(await kv.get(DC.CLAIM_KEY), fence) && !claimedElsewhere(fence);
    } catch (e) {
        return !claimedElsewhere(fence);
    }
}

// The kept copy a start takes, as a 'v: 1' record (see DC.chooseKept): from
// IndexedDB, or from tp-data, which then goes into IndexedDB as it is.
async function readKeptCopy() {
    let got = {};
    let fromKv = null;
    try {
        got = await kv.getMany([DC.TREE_KEY, DC.DRAFT_KEY, DC.STASH_INDEX_KEY]);
        fromKv = DC.fromKvRecord(got[DC.TREE_KEY], got[DC.DRAFT_KEY]);
    } catch (e) { /* no IndexedDB here */ }
    const tp = await readData(TREE_KEY);
    let tpWrittenAt = null;
    try { tpWrittenAt = localStorage.getItem(TP_DATA_AT_KEY); } catch (e) { /* unknown */ }
    const pick = DC.chooseKept({ kv: fromKv, tp, tpWrittenAt });
    if (pick.drop) {
        // The previous release cleared the copy after a step back: it pushed
        // what was in it, or let it go on purpose. Not brought back over
        // that — but one that held work is set aside, never lost.
        const entries = { [DC.TREE_KEY]: null, [DC.DRAFT_KEY]: null };
        if (fromKv.dirty || fromKv.nv || fromKv.keptDraft) {
            const index = Array.isArray(got[DC.STASH_INDEX_KEY]) ? got[DC.STASH_INDEX_KEY] : [];
            const stash = DC.stashEntry(got[DC.TREE_KEY], got[DC.DRAFT_KEY], index);
            entries[stash.key] = stash.value;
            entries[DC.STASH_INDEX_KEY] = [...index, stash.key];
        }
        treeCacheWrite = treeCacheWrite.then(async () => {
            try {
                const res = await kv.write(entries, { fence: fenceId() });
                if (res.fenced) {
                    lostCopy();
                    return;
                }
                localStorage.removeItem(TP_DATA_AT_KEY);
            } catch (e) { /* the same next start */ }
        });
        return null;
    }
    const rec = pick.rec;
    if (rec && pick.seed) {
        // Whoever's it is: from here this release keeps it in IndexedDB.
        rec.copyId = rec.copyId || DC.newId();
        const entries = {
            [DC.TREE_KEY]: DC.toKvRecord(rec, { copyId: rec.copyId, seq: 1 }),
            [DC.DRAFT_KEY]: DC.liveDraftsFor(rec.nv, rec.account, windowId, rec.savedAt || undefined)
        };
        treeCacheWrite = treeCacheWrite.then(async () => {
            try {
                const res = await kv.write(entries, { fence: fenceId() });
                if (res.fenced) lostCopy();
            } catch (e) { /* tp-data still holds it */ }
        });
    }
    return rec;
}

// Put the kept copy back. Returns {dirty, at} when it did, else null.
async function restoreTreeCache() {
    const rec = await readKeptCopy();
    if (!rec || rec.v !== 1 || !Array.isArray(rec.roots) || state.snapshot || halted()) return null;
    const signedIn = configured();
    const holdsWork = Boolean(rec.dirty || rec.nv || rec.keptDraft);
    if (signedIn && !sameKeptAccount(rec.account)) {
        if (holdsWork) {
            foreignKeptCopy = rec;
            showToast(`This phone keeps unpushed changes for ${(rec.account && rec.account.username) || 'another account'} — sign in as them to push them.`);
        }
        return null;
    }
    // A clean copy waits for nobody: signed out, there is nothing to keep it for.
    if (!signedIn && !holdsWork) return null;
    // Its own account (or, signed out, the one it waits for) has it back.
    if (signedIn) foreignKeptCopy = null;
    const acct = rec.account || {};
    state.snapshot = { type: 'root', title: '', children: rec.roots.map(fromWire) };
    const rootId = getRootId(state.snapshot);
    state.snapshotUserId = acct.userId ?? null;
    state.snapshotUsername = acct.username || null;
    state.snapshotUrl = acct.url || '';
    state.snapshotServerId = acct.serverId || null;
    state.treeVersion = Number(rec.version) || 0;
    state.dirty = Boolean(rec.dirty);
    state.editCount = state.dirty ? Math.max(1, Number(rec.editCount) || 0) : 0;
    state.serverIds = new Set(rec.serverIds || []);
    state.treeRev++;
    copyMeta.copyId = rec.copyId || null;
    copyMeta.seq = Number(rec.seq) || 0;
    copyMeta.lastSyncAt = rec.lastSyncAt || null;
    copyMeta.lastSyncKind = rec.lastSyncKind || null;
    if (Array.isArray(rec.importIds) && rec.importIds.length) state.snapshot._importIds = rec.importIds.slice();
    const path = [rootId, ...(Array.isArray(rec.pathIds) ? rec.pathIds : [])];
    state.pathIds = findNodeByPath(path) ? path : [rootId];
    // The note being written (or set aside by a sign-out): back in its
    // editor when its account is the one signed in, else set aside for it.
    const draft = rec.nv && rec.nv.editing ? rec.nv : rec.keptDraft && rec.keptDraft.editing ? rec.keptDraft : null;
    if (draft && signedIn) {
        state.view = 'notes';
        state.nv = { ...freshNv(), ...draft };
        navDepth++;
        history.pushState(nvHistoryState(), '', location.pathname);
    } else if (draft) {
        state.keptDraft = { ...freshNv(), ...draft };
    }
    renderView();
    const d = new Date(rec.savedAt);
    const at = Number.isNaN(d.getTime()) ? 'earlier' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return { dirty: holdsWork, at };
}

// --- One window edits the copy -----------------------------------------------
//
// Two windows of the app on one device would each hold the copy in memory and
// write it over the other's. So one edits (durableCopy.js's guard, over the
// Web Lock 'tp-primary'), and any other says the app is open elsewhere, with
// 'Use here', which has the first write down what it holds and let go. A
// window that a share or an import link opened takes over at once: that is
// where the person is, and the one behind it wrote everything down when it
// went to the background.

function arrivedWithWork() {
    try {
        return Boolean(new URLSearchParams(location.search).get('share')) || IMPORT_HASH_RE.test(location.hash);
    } catch (e) {
        return false;
    }
}

async function startApp() {
    try {
        guard = DC.createPrimaryGuard({
            locks: (typeof navigator !== 'undefined' && navigator && navigator.locks) || null,
            BroadcastChannel: typeof BroadcastChannel === 'function' ? BroadcastChannel : null,
            secure: globalThis.isSecureContext,
            id: windowId,
            onYield: yieldCopy,
            onYielded: () => enterSecondary('yielded'),
            // Let go of while away: decided when back (resumeIfFree).
            onLost: (why) => { if (why !== 'away') enterSecondary('lost'); }
        });
    } catch (e) {
        guard = null;
    }
    let role = 'primary';
    if (guard) {
        try {
            role = await guard.start({ take: arrivedWithWork() });
        } catch (e) {
            guard = null; // as before: this window edits
        }
    }
    if (role !== 'primary') {
        enterSecondary('elsewhere');
        const last = guard.lastTake();
        if (last && last.how === 'refused') setGuardNote(refusalNote(last.reason));
        return;
    }
    await claimCopy();
    await bootstrap();
}

// Another window asks for the copy: what is on its way lands first, then
// everything is written down. Refused — the copy stays here — when what this
// window holds could not be kept: handing it over would lose it. That is so
// while a copy with work in it is kept for another account (it, not this
// one, is what the device holds), or when nothing could be written.
async function yieldCopy() {
    const until = Date.now() + SYNC_WAIT_MS;
    while ((syncBusy > 0 || accountChanging) && Date.now() < until) {
        await new Promise(r => setTimeout(r, 100));
    }
    // A sign-out still on its way writes what it keeps when it lands.
    if (accountChanging) return { ok: false, reason: 'busy' };
    const holdsWork = Boolean(state.snapshot && state.dirty) || editorDirty();
    const kept = await saveTreeCache();
    if (kept === false) return { ok: false, reason: 'storage' };
    if (kept === null && foreignKeptCopy && holdsWork) return { ok: false, reason: 'foreign' };
    return true;
}

// This window no longer edits the copy: it stops writing, lets go of what it
// held (written down, and the other window's now), and says where the app is.
function enterSecondary(reason) {
    clearCopyTimers();
    if (booted) {
        state.snapshot = null;
        state.dirty = false;
        state.editCount = 0;
        state.keptDraft = null;
        state.nv = freshNv();
        state.view = 'home';
        state.importBatch = null;
        foreignKeptCopy = null;
        for (const id of ['settings-sheet', 'inbox-sheet', 'user-sheet', 'move-sheet', 'nb-sheet', 'import-sheet']) hide($(id));
    }
    showGuard(reason);
}

function guardOverlay() {
    let box = $('primary-guard');
    if (box) return box;
    // A shell cached from before this release: draw the card here.
    box = document.createElement('div');
    box.id = 'primary-guard';
    box.className = 'primary-guard hidden';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    const card = document.createElement('div');
    card.className = 'primary-guard-card';
    const title = document.createElement('strong');
    title.id = 'primary-guard-title';
    const text = document.createElement('p');
    text.id = 'primary-guard-text';
    text.className = 'hint';
    const btn = document.createElement('button');
    btn.id = 'primary-take';
    btn.type = 'button';
    btn.className = 'primary';
    btn.textContent = 'Use here';
    btn.addEventListener('click', useHere);
    const note = document.createElement('small');
    note.id = 'primary-guard-note';
    note.className = 'hint';
    card.append(title, text, btn, note);
    box.appendChild(card);
    document.body.appendChild(box);
    return box;
}

function showGuard(reason) {
    const box = guardOverlay();
    const title = $('primary-guard-title');
    const text = $('primary-guard-text');
    if (title) title.textContent = 'TabPaladin is open in another tab';
    if (text) {
        text.textContent = reason === 'yielded'
            ? 'It moved there, with everything this tab held. Use it there, or bring it back here.'
            : 'One tab or window edits the copy on this device at a time, so two never write over each other. '
                + 'Use it there, or move it here: the other tab saves what it holds first.';
    }
    setGuardNote('');
    const btn = $('primary-take');
    if (btn) btn.disabled = false;
    show(box);
}

function setGuardNote(text) {
    const note = $('primary-guard-note');
    if (note) note.textContent = text;
}

// A take-over on its way ('Use here', or coming back to this window).
let moving = false;

// Why a holder kept the copy, for the card.
function refusalNote(reason) {
    if (reason === 'foreign') {
        return 'The other tab has unpushed changes it cannot keep on this device while another account\'s are kept here. ⬆️ Push them there first, then try again.';
    }
    if (reason === 'busy') return 'The other tab is signing out. Try again in a moment.';
    return 'The other tab could not save what it holds (is this device out of storage?). ⬆️ Push or finish there first, then try again.';
}

// 'Use here': the copy moves to this window.
async function useHere() {
    if (!guard || guard.isPrimary() || moving) return;
    moving = true;
    const btn = $('primary-take');
    if (btn) btn.disabled = true;
    setGuardNote('Asking the other tab to save what it holds…');
    try {
        let r = { ok: false, how: 'failed' };
        try { r = await guard.take(); } catch (e) { r = { ok: false, how: 'failed' }; }
        if (!r.ok) {
            if (btn) btn.disabled = false;
            setGuardNote(r.how === 'refused' ? refusalNote(r.reason) : 'It could not be moved here. Try again.');
            return;
        }
        await resumeHere();
    } finally {
        moving = false;
    }
}

// Back to a window that does not edit, without asking anyone: behind the
// card, once the window that edited is gone (closed after filing a share,
// say), it edits again; back from being away, it edits on in place when no
// other window claimed the copy meanwhile, and otherwise either starts again
// from what is kept or, another window editing now, shows the card.
async function resumeIfFree() {
    if (!guard || guard.isPrimary() || moving) return;
    moving = true;
    try {
        const free = await guard.takeIfFree();
        if (awayFromCopy) {
            awayFromCopy = false;
            if (free && await claimStillMine()) return;
            if (!free) {
                enterSecondary('lost');
                return;
            }
        }
        if (free) await resumeHere();
    } catch (e) {
        /* stays as it is */
    } finally {
        moving = false;
    }
}

// Starting again from what is kept: nothing in this page's memory is
// anything to ask about on the way out.
let restarting = false;

// This window edits now. One that let go of the copy before starts again
// from what is kept, its memory being from before.
async function resumeHere() {
    if (booted) {
        restarting = true;
        location.reload();
        return;
    }
    await claimCopy();
    hide($('primary-guard'));
    await bootstrap();
}

// --- Settings › Storage ------------------------------------------------------
//
// Where the copy is kept, whether the browser may clear it to make room
// (navigator.storage.persisted()), and 'Keep my data on this phone', which
// asks it not to — from the click, as Firefox wants.

function deviceWord() {
    return isDesktop() ? 'computer' : 'phone';
}

function settingsOpen() {
    const sheet = $('settings-sheet');
    return Boolean(sheet) && !sheet.classList.contains('hidden');
}

function formatBytes(n) {
    if (!Number.isFinite(n)) return '';
    if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// The browser's last answer to the button, for the line under it.
let persistAnswer = null;

async function refreshStorageUi() {
    const status = $('storage-status');
    const btn = $('storage-persist');
    if (!status) return;
    const storage = typeof navigator !== 'undefined' && navigator ? navigator.storage : null;
    const [st, kvWorks] = await Promise.all([
        DC.storageStatus(storage),
        kv.open().then(() => true, () => false)
    ]);
    const here = deviceWord();
    const lines = [];
    if (kvWorks && keptIn !== 'tp-data') lines.push(`Your copy is kept in this browser's database on this ${here}.`);
    else if (keptIn === 'tp-data' || (typeof caches !== 'undefined' && caches)) lines.push(`Your copy is kept in this browser's cache storage on this ${here}.`);
    else lines.push(`This browser keeps nothing between starts here: ⬆️ Push before closing the app.`);
    if (state.snapshot && state.dirty) {
        const n = state.editCount || 1;
        lines.push(`It holds ${n} unpushed edit${n === 1 ? '' : 's'}.`);
    }
    if (!st.supported) {
        lines.push('This browser cannot be asked to keep it: it may clear it when space runs low.');
    } else if (st.persisted) {
        lines.push('The browser keeps it: it will not clear it to make room.');
    } else if (persistAnswer === 'declined') {
        lines.push('The browser said no for now: it may clear it when space runs low. Installing the app, or bookmarking it, usually changes its mind.');
    } else {
        lines.push('The browser may clear it when space runs low.');
    }
    if (st.usage !== null && st.quota) lines.push(`${formatBytes(st.usage)} used of ${formatBytes(st.quota)}.`);
    status.textContent = lines.join(' ');
    const err = $('storage-error');
    if (err) {
        err.textContent = copyWriteError
            ? (copyWriteError.quota
                ? `The last save failed: this ${here} is out of storage. Changes are kept only while the app stays open — ⬆️ Push them.`
                : `The last save failed (${copyWriteError.message}). Changes are kept only while the app stays open — ⬆️ Push them.`)
            : '';
        err.classList.toggle('hidden', !copyWriteError);
    }
    if (btn) {
        btn.textContent = `Keep my data on this ${here}`;
        btn.classList.toggle('hidden', !st.supported || st.persisted === true);
        btn.disabled = false;
    }
}

// From the click: persist() may prompt, and some browsers grant it only to
// a gesture.
async function keepDataHere() {
    const storage = typeof navigator !== 'undefined' && navigator ? navigator.storage : null;
    const btn = $('storage-persist');
    if (btn) btn.disabled = true;
    const r = await DC.askPersist(storage);
    persistAnswer = r.how;
    if (r.how === 'granted') showToast(`Kept: the browser will not clear TabPaladin's data on this ${deviceWord()} to make room.`);
    else if (r.how === 'declined') showToast('The browser said no for now. Installing the app, or bookmarking it, usually changes its mind.');
    else if (r.how === 'unsupported') showToast('This browser cannot be asked to keep data.');
    else showToast('Could not ask the browser: ' + ((r.error && r.error.message) || 'unknown error'));
    await refreshStorageUi();
}

// --- The share sheet's prefs and statistics --------------------------------------
//
// Prefs ('share': pins, hidden folders and slots per app) are kept on the
// phone and in /api/prefs/share; a change saves here at once and then on the
// server, merged per app with whatever another device saved meanwhile.
// Statistics (where each app's links were filed) come from the server with
// each start and filing, and are kept for offline.
let shareStats = null;
let sharePrefs = { value: null, updatedAt: null, dirty: [] };

// What the phone kept of both for the account signed in now.
async function loadKeptShareData() {
    if (!configured()) return;
    if (!shareStats) {
        const kept = await readData(STATS_KEY);
        if (kept && sameKeptAccount(kept.account)) shareStats = kept.stats;
    }
    if (!sharePrefs.value && !sharePrefs.dirty.length) {
        const kept = await readData(PREFS_KEY);
        if (kept && sameKeptAccount(kept.account)) {
            sharePrefs = { value: kept.value || null, updatedAt: kept.updatedAt || null, dirty: kept.dirty || [] };
        }
    }
}

async function loadShareStats() {
    await loadKeptShareData();
    if (!configured()) return;
    const asked = shareConfig();
    try {
        const r = await api('/api/shares/stats');
        // Another account signed in while it was asked: not theirs.
        if (!stillSignedInAs(asked)) return;
        shareStats = { apps: r.apps || {} };
        writeData(STATS_KEY, { account: shareAccount(), stats: shareStats, fetchedAt: new Date().toISOString() });
        if (shareSheet) shareSheet.refresh();
    } catch (e) { /* the kept ones stand */ }
}

function mergeSharePrefs(server, local, dirtyApps) {
    const out = server && typeof server === 'object' ? JSON.parse(JSON.stringify(server)) : { v: 1, slots: 4, apps: {} };
    out.v = 1;
    out.apps = out.apps || {};
    for (const app of dirtyApps) {
        if (app === '__slots') { if (local && local.slots) out.slots = local.slots; continue; }
        if (local && local.apps && local.apps[app]) out.apps[app] = local.apps[app];
    }
    return out;
}

function keepSharePrefs() {
    writeData(PREFS_KEY, { account: shareAccount(), ...sharePrefs });
}

async function loadSharePrefs() {
    await loadKeptShareData();
    if (!configured()) return;
    const asked = shareConfig();
    try {
        const r = await api('/api/prefs/share');
        if (!stillSignedInAs(asked)) return;
        sharePrefs.value = mergeSharePrefs(r.value, sharePrefs.value, sharePrefs.dirty);
        sharePrefs.updatedAt = r.updatedAt || null;
    } catch (e) {
        if (e.status !== 404 || !stillSignedInAs(asked)) return; // offline: what is kept stands
    }
    if (sharePrefs.dirty.length) await pushSharePrefs();
    keepSharePrefs();
    if (shareSheet) shareSheet.refresh();
}

// Folder ids no longer in the tree are dropped on the way out.
function pruneSharePrefs(value) {
    const c = shareCopy();
    if (!c.ready || !value || !value.apps) return value;
    const out = JSON.parse(JSON.stringify(value));
    for (const a of Object.values(out.apps)) {
        if (Array.isArray(a.pinned)) a.pinned = a.pinned.filter(id => c.index.folders.has(id));
        if (Array.isArray(a.hidden)) a.hidden = a.hidden.filter(id => c.index.folders.has(id));
    }
    return out;
}

async function pushSharePrefs() {
    if (!configured()) return;
    for (let i = 0; i < 3; i++) {
        try {
            const r = await api('/api/prefs/share', {
                method: 'PUT',
                body: JSON.stringify({ value: pruneSharePrefs(sharePrefs.value), baseUpdatedAt: sharePrefs.updatedAt })
            });
            sharePrefs.updatedAt = r.updatedAt;
            sharePrefs.dirty = [];
            keepSharePrefs();
            return;
        } catch (e) {
            if (e.status === 409 && e.body) {
                const cur = e.body.current || null;
                sharePrefs.value = mergeSharePrefs(cur && cur.value, sharePrefs.value, sharePrefs.dirty);
                sharePrefs.updatedAt = cur ? cur.updatedAt : null;
                continue;
            }
            // Offline, or a server without prefs: kept on the phone, sent next time.
            return;
        }
    }
}

async function updateSharePrefs(fn, app) {
    sharePrefs.value = fn(sharePrefs.value);
    for (const k of [app, '__slots']) if (!sharePrefs.dirty.includes(k)) sharePrefs.dirty.push(k);
    keepSharePrefs();
    await pushSharePrefs();
}

// The copy's folders for the share sheet: only this account's copy, from
// this server.
let copyIndex = { rev: -1, snapshot: null, index: null };

function shareCopy() {
    if (!state.snapshot || !configured() || accountChanging || !copyIsMine()) return { ready: false };
    if (state.snapshotUrl && state.snapshotUrl !== state.config.url.replace(/\/$/, '')) return { ready: false };
    if (copyIndex.snapshot !== state.snapshot || copyIndex.rev !== state.treeRev) {
        assignIds(state.snapshot);
        copyIndex = {
            rev: state.treeRev,
            snapshot: state.snapshot,
            index: Share.indexFolders((state.snapshot.children || []).map(toWire).filter(Boolean))
        };
    }
    return { ready: true, index: copyIndex.index, serverIds: state.serverIds };
}

// The folder's place in the copy, for 'Open folder'.
function openFolderById(id) {
    if (!state.snapshot) return;
    const path = [];
    const walk = (node) => {
        for (const c of node.children || []) {
            if (c.type !== 'folder') continue;
            path.push(c._pwaId);
            if (c._pwaId === id || walk(c)) return true;
            path.pop();
        }
        return false;
    };
    if (!walk(state.snapshot)) return;
    if (state.view === 'notes' && !confirmDiscardEdit()) return;
    if (state.view === 'notes') stopEditing();
    state.view = 'home';
    state.pathIds = [state.snapshot._pwaId, ...path];
    renderView();
}

// A toast with an Undo, for a soft delete.
function showUndoToast(message, undo) {
    showToast(message);
    const toast = document.getElementById('tp-toast');
    if (!toast) return;
    toast.style.pointerEvents = 'auto';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-undo';
    btn.textContent = 'Undo';
    btn.addEventListener('click', () => { toast.remove(); undo(); });
    toast.appendChild(btn);
}

function makeShareSheet() {
    return createShareSheet({
        outbox,
        signedIn: () => configured() && !accountChanging,
        account: shareAccount,
        username: () => (state.identity && state.identity.username) || localStorage.getItem(LS.username) || 'this account',
        copy: shareCopy,
        flush: (sids) => flushShares(sids),
        api,
        applyFiled,
        applyUnfiled,
        prefs: { get: () => sharePrefs.value, update: updateSharePrefs },
        stats: () => shareStats,
        clipboardLinks: clipboardSuggestions,
        forgetClipboardLink: (url) => { removeScannedClipboardLink(url); setInboxCount(); },
        dismissClipboardLink: (url) => { dismissUrl(url); removeScannedClipboardLink(url); setInboxCount(); },
        toast: showToast,
        toastUndo: showUndoToast,
        openSettings: () => openSettings(),
        // True once the note editor holds the text; the sheet keeps the share
        // until then.
        saveAsNote: async (text) => {
            if (!configured()) {
                showToast('Sign in first, then save it as a note.');
                return false;
            }
            if (await startNewNote({ parentId: null, content: text, from: 'Home' })) return true;
            showToast('Not saved as a note — it is kept in the Inbox until you do.');
            return false;
        },
        openFolder: openFolderById,
        registerSync: registerShareSync,
        newId: newLocalId,
        isDesktop,
        onInboxCount: (n) => setInboxCount(n),
        onClose: () => {
            syncBottomNav();
            afterShareSheet().catch(() => {});
            refreshInbox();
        },
        done: ({ label, fromShare }) => {
            // A window the share opened goes back to the app it came from.
            if (fromShare && history.length === 1) {
                try { window.close(); } catch (e) { /* not ours to close */ }
            }
            if (state.view !== 'notes') renderView();
            if (label) showToast(`Saved to ${label}`);
        }
    });
}

// --- Settings / sign in ---
//
// The token field is gone: you sign in with a username and password and the
// server hands back a session token, which is what actually goes in the
// Authorization header. Same wire format as before, so nothing downstream of
// api() changed — only how the token is obtained.
function openSettings() {
    const urlEl = $('cfg-url');
    if (urlEl) urlEl.value = state.config.url || defaultServerUrl();
    refreshAuthUi();
    show($('settings-sheet'));
    refreshStorageUi();
    if (state.config.token) {
        refreshImporters();
        refreshWhoAmI().then(() => { refreshAuthUi(); refreshUsers(); });
    }
}

// Who this session is, from the server: kept in localStorage for the account
// label, the per-account lists and queued shares. Sessions from before
// accounts never learned it at sign-in.
async function refreshWhoAmI() {
    if (!configured()) return null;
    const token = state.config.token;
    try {
        const data = await api('/api/auth/me');
        // Signed out, or in as someone else, while it was asked.
        if (state.config.token !== token) return null;
        const user = data.user || {};
        if (holdsStoredSession()) {
            rememberUser(user, undefined, data.serverId);
            state.identity = storedIdentity();
            // The worker records shares under this account: tell it who it is.
            mirrorConfigToSW();
        } else {
            // Another window has signed in since: localStorage is its session.
            // This page learns who its own token is, and writes nothing there.
            state.identity = {
                userId: user.id === undefined || user.id === null ? null : Number(user.id),
                username: user.username || (state.identity && state.identity.username) || null,
                serverId: data.serverId || null
            };
        }
        return data.user;
    } catch (e) {
        return null;
    }
}

// The server serves this PWA, so when you opened it you were already talking to
// the backend. Defaulting to that origin means the URL only ever needs typing
// if you host the PWA somewhere else.
function defaultServerUrl() {
    try {
        if (location.protocol === 'http:' || location.protocol === 'https:') return location.origin;
    } catch (e) { /* file:// or similar */ }
    return '';
}

function currentServerUrl() {
    const urlEl = $('cfg-url');
    const typed = urlEl ? urlEl.value.trim() : '';
    return (typed || state.config.url || defaultServerUrl()).replace(/\/$/, '');
}

// --- Importers ---
//
// The archive itself is browsed as ordinary bookmarks in the main UI, so this
// screen only has to cover what bookmarks cannot express: connection state, when
// the last sweep ran, and what went wrong.

function importerSubtitle(src) {
    if (src.manual) {
        // Nothing polls this one, so last-run time would be meaningless. Say
        // how it gets filled instead.
        const gone = src.filed ? ` · ${src.filed} filed away` : '';
        return `Filled by sharing posts to TabPaladin${gone}`;
    }
    if (!src.connected) return 'Not connected — tap Authorise.';
    if (src.lastStatus === 'error') return src.lastError || 'Last sweep failed.';
    if (!src.lastRun) return 'Connected. Waiting for the first sweep.';
    const mins = Math.round((Date.now() - Date.parse(src.lastRun)) / 60000);
    const when = mins < 1 ? 'just now'
        : mins < 60 ? `${mins} min ago`
        : mins < 1440 ? `${Math.round(mins / 60)} h ago`
        : `${Math.round(mins / 1440)} d ago`;
    // Items Reddit no longer lists are the whole point of the archive, so say so
    // rather than hiding them in a count that looks like a discrepancy.
    const gone = src.goneFromSource ? ` · ${src.goneFromSource} kept past Reddit's cap` : '';
    return `Swept ${when} · every ${src.intervalMinutes} min${gone}`;
}

function renderImporters() {
    const list = $('imports-list');
    if (!list) return;
    const sources = state.importers || [];

    if (sources.length === 0) {
        list.innerHTML = '<p class="hint">No importers yet.</p>';
        return;
    }

    list.innerHTML = sources.map(src => src.removed ? `
        <div class="import-row removed" data-id="${escapeAttr(src.id)}">
          <div class="import-head">
            <span class="import-name">${escapeHtml(src.label || src.provider)}</span>
            <span class="import-count">${Number(src.items) || 0} archived</span>
          </div>
          <div class="import-meta">Removed — the archive is kept until you delete it.</div>
          <div class="import-actions">
            <button data-act="restore">Restore</button>
            <button data-act="purge" class="danger">Delete archive</button>
          </div>
        </div>
    ` : `
        <div class="import-row" data-id="${escapeAttr(src.id)}">
          <div class="import-head">
            <span class="import-name">${escapeHtml(src.label || src.provider)}</span>
            <span class="import-count">${Number(src.items) || 0} saved</span>
          </div>
          <div class="import-meta${src.lastStatus === 'error' ? ' error' : ''}">${escapeHtml(importerSubtitle(src))}</div>
          <div class="import-actions">
            ${src.manual ? '' : `<button data-act="${src.connected ? 'run' : 'auth'}">${src.connected ? 'Sweep now' : 'Authorise'}</button>`}
            ${src.manual ? '' : `<button data-act="toggle">${src.enabled ? 'Pause' : 'Resume'}</button>`}
            <button data-act="delete" class="danger">Remove</button>
          </div>
        </div>
    `).join('');

    list.querySelectorAll('.import-actions button').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = btn.closest('.import-row').dataset.id;
            handleImporterAction(id, btn.dataset.act, btn);
        });
    });
}

async function refreshImporters() {
    if (!configured()) return;
    try {
        const showRemoved = $('imports-show-removed') && $('imports-show-removed').checked;
        const data = await api('/api/imports' + (showRemoved ? '?includeRemoved=1' : ''));
        state.importers = data.sources || [];
        renderImporters();
    } catch (e) {
        const list = $('imports-list');
        // An older server simply has no /api/imports; that is not an error worth
        // shouting about in the settings sheet.
        if (list) list.innerHTML = `<p class="hint">${/404/.test(String(e)) ? 'This server does not support importers yet.' : 'Could not load importers.'}</p>`;
    }
}

function handleImporterAction(id, act, btn) {
    // Every branch talks to the server, so one catch here beats four.
    runImporterAction(id, act, btn).catch(e => setStatus('Importer error: ' + e.message));
}

async function runImporterAction(id, act, btn) {
    const source = (state.importers || []).find(s => String(s.id) === String(id));
    if (!source) return;

    if (act === 'delete') {
        // Deleting the connection must not silently bin the archive — anything
        // Reddit has already forgotten only exists here.
        if (!confirm(`Remove "${source.label}"?\n\nThe ${source.items} archived links stay on the server — tick "Show removed sources" to restore it or delete the archive.`)) return;
        await api('/api/imports/' + id, { method: 'DELETE' });
        await refreshImporters();
        return;
    }

    if (act === 'restore') {
        await api('/api/imports/' + id + '/restore', { method: 'POST' });
        setStatus('Restored. A Reddit source needs authorising again.');
        await refreshImporters();
        return;
    }

    if (act === 'purge') {
        // Unrecoverable: anything past Reddit's window cannot be fetched again.
        if (prompt(`Delete the ${source.items} archived links of "${source.label}" for good?\n\nType DELETE to confirm.`) !== 'DELETE') return;
        await api('/api/imports/' + id + '?purge=1', { method: 'DELETE' });
        await refreshImporters();
        return;
    }

    if (act === 'toggle') {
        await api('/api/imports/' + id, {
            method: 'PATCH',
            body: JSON.stringify({ enabled: !source.enabled })
        });
        await refreshImporters();
        return;
    }

    if (act === 'auth') {
        const data = await api('/api/imports/' + id + '/authorize');
        // Opened rather than navigated: losing the PWA to a redirect chain and
        // coming back to a cold start is a bad way to connect an account.
        openExternal(data.url);
        setStatus('Approve the app on Reddit, then come back and sweep.');
        return;
    }

    if (act === 'run') {
        const original = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Sweeping…';
        try {
            const result = await api('/api/imports/' + id + '/run', { method: 'POST' });
            setStatus(result.added
                ? `Imported ${result.added} new link${result.added === 1 ? '' : 's'}.`
                : 'Already up to date.');
            // Only pull when there is nothing unsaved locally — pullSnapshot
            // replaces state wholesale and would discard pending edits.
            if (result.added && !state.dirty) await pullSnapshot();
        } catch (e) {
            setStatus('Sweep failed: ' + e.message);
        } finally {
            btn.disabled = false;
            btn.textContent = original;
            await refreshImporters();
        }
    }
}

function openImporterSetup() {
    const redirect = $('import-redirect');
    if (redirect) redirect.textContent = currentServerUrl() + '/api/imports/reddit/callback';
    hide($('import-error'));
    show($('import-sheet'));
}

async function submitImporter() {
    const err = $('import-error');
    const clientId = $('import-client-id').value.trim();
    const clientSecret = $('import-client-secret').value.trim();
    const intervalMinutes = Number($('import-interval').value) || 60;

    if (!clientId || !clientSecret) {
        err.textContent = 'Both the client ID and secret are required.';
        show(err);
        return;
    }

    try {
        const created = await api('/api/imports', {
            method: 'POST',
            body: JSON.stringify({ provider: 'reddit', label: 'Reddit saved', clientId, clientSecret, intervalMinutes })
        });
        $('import-client-id').value = '';
        $('import-client-secret').value = '';
        hide($('import-sheet'));
        await refreshImporters();
        // Straight into the consent flow — a source with no credentials cannot
        // do anything, so stopping here would just be a dead end.
        const auth = await api('/api/imports/' + created.source.id + '/authorize');
        openExternal(auth.url);
        setStatus('Approve the app on Reddit, then come back and sweep.');
    } catch (e) {
        err.textContent = e.message;
        show(err);
    }
}

function refreshAuthUi() {
    const signedIn = Boolean(state.config.token);
    const inEl = $('auth-signed-in');
    const outEl = $('auth-signed-out');
    if (inEl) inEl.classList.toggle('hidden', !signedIn);
    if (outEl) outEl.classList.toggle('hidden', signedIn);
    const who = $('auth-username-label');
    if (who) who.textContent = localStorage.getItem(LS.username) || '';
    const role = $('auth-role-label');
    if (role) {
        const parts = [localStorage.getItem(LS.role), localStorage.getItem(LS.owner) === '1' ? 'owner' : ''].filter(Boolean);
        role.textContent = parts.length ? ` (${parts.join(', ')})` : '';
    }
    if (!signedIn) hide($('users-block'));
    const setupHint = $('auth-setup-hint');
    if (setupHint) setupHint.classList.add('hidden');
    updateOriginNotice();
    if (!signedIn) probeAuthStatus();
}

// The server in Settings, when it is not the one this app was opened from:
// say so and offer that one. A coming release talks only to the server the
// app is opened from (its pages may then only connect there).
function updateOriginNotice() {
    const box = $('cfg-origin-notice');
    if (!box) return;
    const here = defaultServerUrl();
    const there = currentServerUrl();
    let differs = false;
    try {
        differs = Boolean(here && there) && new URL(there).origin !== new URL(here).origin;
    } catch (e) {
        differs = Boolean(here && there);
    }
    box.classList.toggle('hidden', !differs);
    const text = $('cfg-origin-text');
    if (text) {
        text.textContent = differs
            ? `This app was opened from ${here} but syncs with ${there}. A coming release only talks to the server it is opened from.`
            : '';
    }
}

// Puts this app's own server in the field; Sign in, or Save server when
// signed in, then switches to it the usual way.
function useOriginServer() {
    const urlEl = $('cfg-url');
    if (urlEl) urlEl.value = defaultServerUrl();
    updateOriginNotice();
    showToast(state.config.token ? 'Press Save server to switch, then sign in there if asked.' : 'Now sign in to this server.');
}

// Tells the user whether to sign in or create the first account.
async function probeAuthStatus() {
    const base = currentServerUrl();
    if (!base) return;
    try {
        const res = await fetch(base + '/api/auth/status');
        if (!res.ok) return;
        const data = await res.json();
        const hint = $('auth-setup-hint');
        const btn = $('auth-submit');
        if (!data.hasAccount) {
            if (hint) {
                hint.textContent = NO_ACCOUNT_HINT;
                hint.classList.remove('hidden');
            }
        }
        if (btn) {
            btn.textContent = 'Sign in';
        }
    } catch (e) {
        // Server unreachable; the sign-in attempt will report it properly.
    }
}

// Accounts are created on the server from its .env, never from the app — an
// open "first visitor creates the account" form let anyone claim a new server.
const NO_ACCOUNT_HINT = "This server has no account yet. Set ADMIN_USERNAME and ADMIN_PASSWORD in the server's .env and restart it, then sign in.";

async function submitAuth() {
    const base = currentServerUrl();
    const username = ($('cfg-username')?.value || '').trim();
    const password = $('cfg-password')?.value || '';
    const err = $('auth-error');
    const setErr = (m) => {
        if (!err) return;
        err.textContent = m || '';
        err.classList.toggle('hidden', !m);
    };
    setErr('');

    if (!base) return setErr('Enter the server address first.');
    if (!username || !password) return setErr('Username and password are both required.');

    let hasAccount = true;
    try {
        const s = await fetch(base + '/api/auth/status').then(r => r.json());
        hasAccount = Boolean(s.hasAccount);
    } catch (e) {
        return setErr("Can't reach that server. Check the address, and that Tailscale is connected.");
    }

    try {
        if (!hasAccount) return setErr(NO_ACCOUNT_HINT);
        const res = await fetch(base + '/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return setErr(data.error || `Sign in failed (HTTP ${res.status}).`);

        // Unpushed edits are never discarded by a sign-in. The same account
        // keeps them (and bootstrap skips its pull); another account is
        // refused until they are pushed or deliberately discarded. The same
        // id on another server is another account: ids start at 1 everywhere.
        // An unsaved note counts the same, open (a session that expired
        // mid-edit) or set aside by a sign-out.
        const user = data.user || {};
        const name = data.username || username;
        const previousId = state.snapshotUserId ?? currentUserId();
        const previousName = state.snapshotUsername || localStorage.getItem(LS.username) || 'the previous account';
        const sameServer = !state.snapshot
            || ((!state.snapshotUrl || state.snapshotUrl === base)
                && (!state.snapshotServerId || !data.serverId || state.snapshotServerId === data.serverId));
        const sameAccount = sameServer && (user.id !== undefined && user.id !== null && previousId !== null
            ? Number(user.id) === Number(previousId)
            : (state.snapshotUsername || localStorage.getItem(LS.username) || name) === name);
        const draft = editorDirty() || Boolean(state.keptDraft);
        if ((state.dirty || draft) && state.snapshot && !sameAccount) {
            fetch(base + '/api/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + data.token } }).catch(() => {});
            const n = state.editCount || 1;
            const where = sameServer ? '' : ` on ${state.snapshotUrl || 'another server'}`;
            const what = [state.dirty ? `${n} unpushed edit${n === 1 ? '' : 's'}` : '', draft ? 'an unsaved note' : '']
                .filter(Boolean).join(' and ');
            const todo = state.dirty ? 'push them, or discard them' : 'save it, or discard it';
            setErr(`This phone has ${what} for ${previousName}${where}. Sign in as ${previousName}${where ? ' there' : ''} and ${todo}.`);
            const discard = $('auth-discard');
            if (discard) {
                discard.textContent = `Discard ${previousName}'s edits`;
                discard.dataset.account = previousName;
                show(discard);
            }
            return;
        }

        state.config.url = base;
        state.config.token = data.token;
        localStorage.setItem(LS.url, base);
        localStorage.setItem(LS.token, data.token);
        localStorage.setItem(LS.username, name);
        if (!sameAccount) localStorage.removeItem(LS.serverId);
        rememberUser(user, name, data.serverId);
        state.identity = storedIdentity();
        mirrorConfigToSW();
        if (!sameAccount) {
            // A clean copy of someone else's: nothing of theirs is lost, and
            // none of it may show up under this account — the copy (on the
            // phone too), the lists, an open note or an import waiting for
            // review, and the share sheet's folders and choices.
            state.snapshot = null;
            state.snapshotUserId = null;
            state.snapshotUsername = null;
            state.keptDraft = null;
            state.serverIds = new Set();
            shareStats = null;
            sharePrefs = { value: null, updatedAt: null, dirty: [] };
            clearTreeCache();
            resetAccountUi();
        } else {
            reopenKeptDraft();
        }
        if ($('cfg-password')) $('cfg-password').value = '';
        hide($('auth-discard'));
        refreshAuthUi();
        hide($('settings-sheet'));
        await bootstrap();
    } catch (e) {
        setErr('Sign in failed: ' + e.message);
    }
}

// The only way past a blocked sign-in: the previous account's edits, thrown
// away on purpose, with its name typed in.
function discardPreviousEdits() {
    const btn = $('auth-discard');
    const account = (btn && btn.dataset.account) || '';
    const typed = prompt(`Discard ${account}'s unpushed edits on this phone? They cannot be recovered.\n\nType ${account} to confirm.`);
    if (typed === null || typed.trim() !== account) return;
    // An import link opened as one of those unsaved notes goes with it. One
    // whose import was already in the copy waits again for its account: the
    // copy goes, the links it held were never on the server.
    for (const nv of [state.keptDraft, state.nv]) {
        if (nv && nv.editing && nv.importId) dropPendingImport(nv.importId);
    }
    state.snapshot = null;
    state.snapshotUserId = null;
    state.snapshotUsername = null;
    state.dirty = false;
    state.editCount = 0;
    state.keptDraft = null;
    state.serverIds = new Set();
    clearTreeCache();
    resetAccountUi();
    hide(btn);
    const err = $('auth-error');
    if (err) { err.textContent = 'Discarded. Sign in again.'; err.classList.remove('hidden'); }
}

// Unpushed edits are not discarded by a sign-out either. After a yes they stay
// in memory with the account they belong to, so the next sign-in follows the
// same rules as after an expired session: that account keeps them, anyone else
// is refused until they are pushed or discarded by name.
async function signOut() {
    const base = currentServerUrl();
    const keepEdits = Boolean(state.dirty && state.snapshot);
    // An open note with unsaved changes is asked about the same way. It is
    // set aside with the copy, which says whose it is, and reopens only for
    // that account.
    const keepDraft = editorDirty() && Boolean(state.snapshot);
    const n = state.editCount || 1;
    const who = localStorage.getItem(LS.username) || 'this account';
    const kept = [keepEdits ? `${n} unpushed edit${n === 1 ? '' : 's'}` : '', keepDraft ? 'an unsaved note' : '']
        .filter(Boolean).join(' and ');
    if (kept) {
        if (!confirm(`This phone has ${kept} for ${who}.\n\n` + (keepEdits
            ? `Sign out anyway? They stay here until ${who} signs in again and pushes them (closing the app loses them), `
                + `and nobody else can sign in here until they are pushed or discarded.`
            : `Sign out anyway? It stays here until ${who} signs in again to finish it (closing the app loses it), `
                + `and nobody else can sign in here until it is saved or discarded.`))) return;
        state.snapshotUserId = state.snapshotUserId ?? currentUserId();
        state.snapshotUsername = state.snapshotUsername || localStorage.getItem(LS.username);
    }
    // Best effort — the local token is cleared either way, so a server that is
    // unreachable can't leave you stuck signed in on the device. An import
    // link tapped meanwhile waits for whoever signs in next.
    accountChanging = true;
    try {
        await fetch(base + '/api/logout', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + state.config.token }
        });
    } catch (e) { /* ignore */ } finally {
        accountChanging = false;
    }
    // Shares not uploaded yet stay on the phone, kept for this account.
    const me = shareConfig();
    let waiting = 0;
    try {
        waiting = (await outbox.list()).filter(e => e.url && !e.uploaded && me && Share.sameAccount(e.account, me)).length;
    } catch (e) { waiting = 0; }
    state.config.token = '';
    forgetUser();
    state.identity = null;
    mirrorConfigToSW();
    state.keptDraft = keepDraft ? { ...state.nv } : null;
    if (!kept) {
        state.snapshot = null;
        state.snapshotUserId = null;
        state.snapshotUsername = null;
        state.dirty = false;
        state.editCount = 0;
        state.serverIds = new Set();
    }
    // The copy kept on the phone goes with it — unless it holds the work
    // just kept for this account, which a reload must not lose either.
    if (kept) saveTreeCache();
    else clearTreeCache();
    shareStats = null;
    sharePrefs = { value: null, updatedAt: null, dirty: [] };
    resetAccountUi();
    refreshAuthUi();
    const plural = (keepEdits && keepDraft) || (keepEdits && n !== 1);
    const shares = waiting ? ` ${waiting} shared link${waiting === 1 ? '' : 's'} not uploaded yet ${waiting === 1 ? 'waits' : 'wait'} on this phone for ${who}.` : '';
    setStatus((!kept ? 'Signed out.'
        : keepEdits ? `Signed out. ${kept} for ${who} ${plural ? 'stay' : 'stays'} on this phone until ${who} signs in and pushes.`
            : `Signed out. ${who}’s unsaved note stays on this phone until ${who} signs in again.`) + shares);
}

// What the screen holds for the signed-in account besides the working copy:
// the server's lists (inbox, proposals, importers), an import waiting for
// review, the share sheet's folders, and the notes screen with whatever note is
// open in it. Dropped whenever the account changes or signs out, back to
// Home, so none of it shows up — or can be saved — under whoever signs in
// next. The working copy follows its own rules above; an unsaved note is set
// aside by signOut before this runs. An import link under review stays kept
// on the phone (pendingImports), for the account it was opened for.
function resetAccountUi() {
    closeNotesSheets();
    hide($('inbox-sheet'));
    state.proposals = [];
    state.importers = [];
    renderImporters(); // Settings stays open over a sign-out
    state.importBatch = null;
    setInboxCount(0);
    // An open share sheet stays (the share is not the account's), but draws
    // its folders again from whoever is signed in now, or none.
    if (shareSheet) shareSheet.refresh({ reset: true });
    state.nv = freshNv();
    state.view = 'home';
    if (state.snapshot) state.pathIds = [state.snapshot._pwaId];
    // Back to the Home entry, as goHome does, so back from here leaves the
    // app instead of reopening the last account's notes. Home is drawn here
    // already, so the popstate that follows has nothing to draw: drawing it
    // again would wipe the status saying what a sign-out kept. Entries the
    // unwind leaves above Home are the last account's, and read as Home.
    if (navDepth > 0) {
        unwindingAccount = true;
        history.go(-navDepth);
    } else if (history.state && history.state.tp === 'nv') {
        history.replaceState(null, '', location.pathname);
    }
    navDepth = 0;
    renderView();
}

// The note a sign-out set aside, back in its editor now that its account has
// signed in again. The pull that follows goes through validateNv as usual: a
// note deleted meanwhile keeps the text as a new one.
function reopenKeptDraft() {
    const nv = state.keptDraft;
    state.keptDraft = null;
    if (!nv) return;
    state.view = 'notes';
    state.nv = nv;
    navDepth++;
    history.pushState(nvHistoryState(), '', location.pathname);
    renderView();
}

// --- Users (admins) ---
//
// Account management, for an admin signed in with a real session: the server
// answers anyone else with 403 and the block stays hidden. Every change asks
// for your own password again; the server checks it, and refuses to delete,
// demote or reset the server's owner, the last admin, or you.

let usersCache = [];
let userSheet = null; // {mode, user}

function generatePassword() {
    const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
}

const fmtN = (n) => Number(n || 0).toLocaleString();

function userStatsLine(st) {
    return [
        `${fmtN(st.bookmarks)} bookmarks`, `${fmtN(st.notes)} notes`, `${fmtN(st.workflows)} workflows`,
        `${fmtN(st.imports + st.removedImports)} imports (${fmtN(st.archived)} archived)`, `${fmtN(st.inbox)} inbox`
    ].join(' · ');
}

async function refreshUsers() {
    const block = $('users-block');
    if (!block) return;
    if (!configured()) { hide(block); return; }
    try {
        const data = await api('/api/users');
        usersCache = data.users || [];
        show(block);
        renderUsers();
    } catch (e) {
        hide(block);
    }
}

function renderUsers() {
    const list = $('users-list');
    if (!list) return;
    list.innerHTML = usersCache.map(u => {
        let actions;
        if (u.you) {
            actions = '<button data-uact="self-password">Change password</button>';
        } else if (u.owner) {
            actions = `<p class="hint">Server owner: change from the owner's own Settings or the server CLI.</p>`;
        } else {
            actions = `
                <button data-uact="role">${u.role === 'admin' ? 'Make user' : 'Make admin'}</button>
                <button data-uact="reset">Reset password</button>
                <button data-uact="delete" class="danger" ${u.legacyToken ? 'disabled title="AUTH_TOKEN acts as this account; remove it from .env first"' : ''}>Delete</button>`;
        }
        return `
            <div class="import-row user-row" data-uid="${escapeAttr(u.id)}">
              <div class="import-head">
                <span class="import-name">${escapeHtml(u.username)}${u.you ? ' <span class="hint">(you)</span>' : ''}
                  <span class="pill ${u.role === 'admin' ? 'admin' : ''}">${escapeHtml(u.role)}</span>${u.owner ? '<span class="pill owner">owner</span>' : ''}</span>
                <span class="import-count">since ${escapeHtml(new Date(u.createdAt).toLocaleDateString())}</span>
              </div>
              <div class="import-meta">${escapeHtml(userStatsLine(u.stats || {}))}</div>
              <div class="import-actions user-actions">${actions}</div>
            </div>`;
    }).join('');
    list.querySelectorAll('[data-uact]').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = btn.closest('.user-row').dataset.uid;
            const user = usersCache.find(u => String(u.id) === String(id));
            if (user) userAction(user, btn.dataset.uact);
        });
    });
}

function userAction(user, act) {
    if (act === 'delete') {
        const st = user.stats || {};
        if (!confirm(`Delete ${user.username} and everything they hold?\n\n`
            + `${fmtN(st.bookmarks)} bookmarks, ${fmtN(st.notes)} notes, ${fmtN(st.workflows)} workflows, `
            + `${fmtN(st.inbox)} inbox links, ${fmtN(st.imports + st.removedImports)} import sources with `
            + `${fmtN(st.archived)} archived posts (removed sources included) and ${fmtN(st.history)} history versions.\n\n`
            + 'A backup is taken first.')) return;
        const typed = prompt(`Type ${user.username} to confirm.`);
        if (typed === null) return;
        if (typed.trim() !== user.username) { showToast('The name did not match — nothing was deleted.'); return; }
        openUserSheet('delete', user, { confirm: typed.trim() });
        return;
    }
    openUserSheet(act, user);
}

// One sheet for every account change. Each needs your own password.
function openUserSheet(mode, user = null, extra = {}) {
    userSheet = { mode, user, ...extra };
    const name = user ? user.username : '';
    const titles = {
        add: 'Add user',
        reset: `Reset ${name}'s password`,
        role: user && user.role === 'admin' ? `Make ${name} a user` : `Make ${name} an admin`,
        delete: `Delete ${name}`,
        'self-password': 'Change your password'
    };
    const hints = {
        add: 'They start with an empty tree.',
        reset: `${name} will be signed out on every device; unpushed edits on their phone stay on the phone.`,
        role: '',
        delete: `${name} is signed out first, then a backup is taken, then everything they hold is deleted.`,
        'self-password': 'Signs you out on every other device.'
    };
    $('user-sheet-title').textContent = titles[mode];
    const hint = $('user-sheet-hint');
    hint.textContent = hints[mode];
    hint.classList.toggle('hidden', !hints[mode]);
    $('user-sheet-name-field').classList.toggle('hidden', mode !== 'add');
    $('user-sheet-role-field').classList.toggle('hidden', mode !== 'add');
    const wantsPassword = mode === 'add' || mode === 'reset' || mode === 'self-password';
    $('user-sheet-password-field').classList.toggle('hidden', !wantsPassword);
    $('user-sheet-generate').classList.toggle('hidden', !wantsPassword);
    $('user-sheet-current-label').textContent = mode === 'self-password' ? 'Current password' : 'Your password';
    for (const id of ['user-sheet-name', 'user-sheet-password', 'user-sheet-current']) $(id).value = '';
    $('user-sheet-role').value = 'user';
    $('user-sheet-submit').textContent = { add: 'Create', reset: 'Save', role: 'Confirm', delete: `Delete ${name}`, 'self-password': 'Change password' }[mode];
    $('user-sheet-submit').classList.toggle('danger', mode === 'delete');
    hide($('user-sheet-error'));
    show($('user-sheet'));
}

async function submitUserSheet() {
    const { mode, user, confirm: confirmName } = userSheet || {};
    const err = $('user-sheet-error');
    const fail = (m) => { err.textContent = m; show(err); };
    const currentPassword = $('user-sheet-current').value;
    const password = $('user-sheet-password').value;
    hide(err);
    try {
        let done = '';
        if (mode === 'add') {
            const username = $('user-sheet-name').value.trim();
            await api('/api/users', { method: 'POST', body: JSON.stringify({ username, password, role: $('user-sheet-role').value, currentPassword }) });
            done = `Created ${username}. They start with an empty tree.`;
        } else if (mode === 'reset') {
            const out = await api(`/api/users/${user.id}`, { method: 'PUT', body: JSON.stringify({ password, currentPassword }) });
            done = `New password saved for ${user.username}; signed out of ${out.signedOut} session(s).`;
        } else if (mode === 'role') {
            const role = user.role === 'admin' ? 'user' : 'admin';
            await api(`/api/users/${user.id}`, { method: 'PUT', body: JSON.stringify({ role, currentPassword }) });
            done = `${user.username} is now ${role === 'admin' ? 'an admin' : 'a user'}.`;
        } else if (mode === 'delete') {
            const out = await api(`/api/users/${user.id}/delete`, { method: 'POST', body: JSON.stringify({ confirm: confirmName, currentPassword }) });
            done = `Deleted ${user.username}. Backup: ${out.backup}`;
        } else if (mode === 'self-password') {
            const out = await api('/api/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword: password }) });
            // Every session was revoked, this one included; the reply carries its replacement.
            state.config.token = out.token;
            localStorage.setItem(LS.token, out.token);
            mirrorConfigToSW();
            done = 'Password changed. Other devices need to sign in again.';
        }
        hide($('user-sheet'));
        showToast(done);
        await refreshUsers();
    } catch (e) {
        fail((e.body && e.body.error) || e.message);
    }
}

function saveSettings() {
    const base = currentServerUrl();
    state.config.url = base;
    localStorage.setItem(LS.url, base);
    mirrorConfigToSW();
    hide($('settings-sheet'));
    bootstrap();
}

// --- Wire up ---
window.addEventListener('DOMContentLoaded', () => {
    shareSheet = makeShareSheet();

    // ⋯ › Inbox. The tap is also the gesture that lets the clipboard be
    // read: a copied link shows in the Inbox under From clipboard.
    safeAddListener('clipBtn', 'click', async (e) => {
        e.stopPropagation();
        e.preventDefault();

        // Links are filed into the signed-in account: signed out, neither
        // the clipboard is read nor the inbox opened. (Synchronous, so the
        // clipboard read below is still the gesture's first await.)
        if (signedOutRefuses('Sign in first — links are filed into your account.')) return;

        // Read the clipboard before any other await: WebKit allows it only
        // as the gesture's first.
        if (navigator.clipboard && navigator.clipboard.readText) {
            let text = '';
            try { text = await navigator.clipboard.readText(); } catch (err) { text = ''; }
            const trimmed = (text || '').trim();
            if (/^https?:\/\/\S+$/.test(trimmed)) {
                if (signedOutRefuses('Sign in first — links are filed into your account.')) return;
                if (state.snapshot && isUrlInSnapshot(trimmed, state.snapshot)) showToast('The copied link is filed already.');
                else if (getDismissedUrls().map(normalizeUrl).includes(normalizeUrl(trimmed))) showToast('You skipped the copied link before — paste it to file it.');
                else addScannedClipboardLink(trimmed, trimmed);
                setInboxCount();
            }
        }
        if (signedOutRefuses('Sign in first — links are filed into your account.')) return;
        openInbox();
    });

    safeAddListener('pullBtn', 'click', async (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (!configured()) {
            showToast('Please open settings (⚙) first.');
            return;
        }
        if (state.dirty && !confirm('You have local edits that were never pushed. Pulling replaces this phone\'s copy with the server\'s tree and discards them.\n\nPull anyway?')) {
            return;
        }
        try {
            await pullSnapshot();
            showToast('Pulled the latest tree.');
        } catch (err) {
            showToast('Pull failed: ' + err.message);
            return;
        }
        // An import link that was waiting for a copy to go into.
        await openPendingImport();
    });

    safeAddListener('pushBtn', 'click', async (e) => {
        e.stopPropagation();
        e.preventDefault();
        await pushNow();
    });

    safeAddListener('settingsBtn', 'click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        hide($('menu'));
        openSettings();
    });

    safeAddListener('menuBtn', 'click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        $('menu').classList.toggle('hidden');
    });
    // Menu items close the menu; clicks elsewhere dismiss it.
    $('menu').addEventListener('click', () => hide($('menu')));
    document.addEventListener('click', (e) => {
        const menu = $('menu');
        if (menu && !menu.classList.contains('hidden') && !e.target.closest('#menu-wrap')) {
            hide(menu);
        }
    });

    safeAddListener('newFolderBtn', 'click', async (e) => {
        e.stopPropagation();
        e.preventDefault();

        if (blockedByImports('create a folder')) return;

        if (!configured()) {
            showToast('Please open settings (⚙) first.');
            return;
        }

        if (!state.snapshot) {
            showToast('Loading snapshot first…');
            try {
                await pullSnapshot();
            } catch (err) {
                showToast('Failed to pull snapshot: ' + err.message);
                return;
            }
        }

        const name = prompt('Enter new folder name:');
        if (name === null) return; // User cancelled
        const trimmed = name.trim();
        if (!trimmed) {
            showToast('Folder name cannot be empty.');
            return;
        }

        const parentFolder = findNodeByPath(state.pathIds);
        if (!parentFolder) {
            showToast('Current folder not found.');
            return;
        }

        const newFolder = {
            type: 'folder',
            title: trimmed,
            children: []
        };
        assignIds(newFolder);
        
        parentFolder.children = parentFolder.children || [];
        parentFolder.children.push(newFolder);

        markDirty();
        renderView();

        try {
            setStatus('Creating folder…');
            await pushSnapshot();
            showToast(`Folder "${trimmed}" created successfully!`);
            setStatus('');
        } catch (err) {
            alert('Failed to save folder: ' + err.message);
            setStatus('');
        }
    });

    safeAddListener('notesBtn', 'click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        enterNotes();
    });

    // The wordmark goes home: back to the root view, which is where search
    // and the pinned tiles live. An unsaved edit asks first.
    safeAddListener('brand-home', 'click', goHome);

    // Bottom tab bar. Inbox and Settings open their sheets; the highlight
    // itself is drawn from state by syncBottomNav, not from the tap.
    const nav = document.getElementById('bottom-nav');
    if (nav) {
        nav.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-nav]');
            if (!btn) return;
            const dest = btn.dataset.nav;
            if (dest === 'home') goHome();
            else if (dest === 'notes') enterNotes();
            else if (dest === 'inbox') openInbox();
            else if (dest === 'settings') document.getElementById('settingsBtn')?.click();
            syncBottomNav();
        });
    }
    // Sheets open and close from many places (a 401 opens Settings), so watch
    // them rather than chasing every caller.
    const sheetWatch = new MutationObserver(syncBottomNav);
    for (const id of ['settings-sheet', 'inbox-sheet']) {
        const el = $(id);
        if (el) sheetWatch.observe(el, { attributes: true, attributeFilter: ['class'] });
    }

    // Notes: one delegated listener set for everything the screen draws.
    const content = $('content');
    if (content) {
        content.addEventListener('click', onNotesClick);
        content.addEventListener('input', onNotesInput);
        content.addEventListener('change', onNotesChange);
        wireNotesDragAndDrop(content);
        content.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' || state.view !== 'notes') return;
            const row = e.target.closest && e.target.closest('.nv-row[data-id]');
            if (row) openNoteById(row.dataset.id);
        });
    }
    document.addEventListener('click', (e) => {
        const pop = $('note-menu-pop');
        if (pop && !e.target.closest('.note-menu-wrap')) pop.classList.add('hidden');
    });
    document.addEventListener('keydown', onNotesKeydown);
    window.addEventListener('popstate', onNotesPopState);
    safeAddListener('move-close', 'click', () => hide($('move-sheet')));
    safeAddListener('move-new-nb', 'click', moveSheetNewNotebook);
    safeAddListener('move-list', 'click', (e) => {
        const opt = e.target.closest('.move-opt[data-target]');
        if (opt && !opt.disabled) moveSheetPick(opt.dataset.target);
    });
    safeAddListener('nb-sheet-close', 'click', () => hide($('nb-sheet')));
    safeAddListener('nb-sheet-list', 'click', (e) => {
        const b = e.target.closest('[data-nb-act]');
        if (b) notebookSheetAction(b.dataset.nbAct);
    });
    // Leaving (closing the tab, reloading) asks first while this page holds
    // work nothing else does: an unsaved note, open or set aside by a
    // sign-out, or unpushed edits, kept for their account or not.
    window.addEventListener('beforeunload', (e) => {
        // Another window edits the copy, or this one starts again from what
        // is kept: nothing here is this page's to lose.
        if (halted() || restarting) return;
        if (!editorDirty() && !state.keptDraft && !(state.dirty && state.snapshot)) return;
        e.preventDefault();
        e.returnValue = '';
    });
    // The topbar height feeds the desktop notes panes' height.
    const measureTopbar = () => {
        const bar = $('topbar');
        if (bar) document.documentElement.style.setProperty('--topbar-h', `${bar.offsetHeight}px`);
    };
    measureTopbar();
    window.addEventListener('resize', measureTopbar);
    // Crossing 900px swaps the phone's one pane for side-by-side ones.
    window.matchMedia('(min-width: 900px)').addEventListener('change', () => {
        if (state.view === 'notes') renderView();
    });

    safeAddListener('settings-close', 'click', () => hide($('settings-sheet')));
    safeAddListener('cfg-save', 'click', saveSettings);
    safeAddListener('cfg-url', 'input', updateOriginNotice);
    safeAddListener('cfg-use-origin', 'click', useOriginServer);

    // Import a browser's exported bookmarks file — the no-extension way in.
    // Signed in only: a copy kept over a sign-out belongs to its account, and
    // an import into it would go up with that account's next push.
    const importNeedsSignIn = () => signedOutRefuses('Sign in first — the bookmarks go into your account.');
    safeAddListener('bm-import-btn', 'click', () => {
        if (!importNeedsSignIn()) $('bm-import-file').click();
    });
    safeAddListener('bm-import-file', 'change', async (e) => {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;
        if (importNeedsSignIn()) return;
        if (!state.snapshot) {
            try { await pullSnapshot(); } catch (err) { showToast('Pull the tree first: ' + err.message); return; }
        }
        let folder;
        try {
            folder = importedFolderFrom(await file.text(), new Date().toISOString().slice(0, 10));
        } catch (err) {
            showToast('Could not read that file: ' + err.message);
            return;
        }
        if (!folder) {
            showToast('No bookmarks found in that file — is it a browser bookmarks export?');
            return;
        }
        const n = countNodes(folder) - 1;
        if (!confirm(`Import ${n} item(s) into a new "${folder.title}" folder and push?`)) return;
        if (importNeedsSignIn() || !state.snapshot) return; // signed out while the file was read
        assignIds(folder);
        state.snapshot.children = state.snapshot.children || [];
        state.snapshot.children.push(folder);
        markDirty();
        try {
            setStatus('Saving…');
            await pushSnapshot();
            setStatus('');
            showToast(`Imported ${n} item(s).`);
            hide($('settings-sheet'));
            renderView();
        } catch (err) {
            setStatus('');
            showToast('Push failed: ' + err.message + ' — the import is kept locally, use ⬆️ to retry.');
            renderView();
        }
    });
    safeAddListener('imports-add', 'click', openImporterSetup);
    safeAddListener('import-close', 'click', () => hide($('import-sheet')));
    safeAddListener('import-submit', 'click', submitImporter);
    safeAddListener('auth-submit', 'click', submitAuth);
    safeAddListener('auth-signout', 'click', signOut);
    safeAddListener('auth-discard', 'click', discardPreviousEdits);
    safeAddListener('imports-show-removed', 'change', refreshImporters);
    safeAddListener('users-add', 'click', () => openUserSheet('add'));
    safeAddListener('auth-change-password', 'click', () => openUserSheet('self-password'));
    safeAddListener('user-sheet-close', 'click', () => hide($('user-sheet')));
    safeAddListener('user-sheet-submit', 'click', submitUserSheet);
    safeAddListener('user-sheet-generate', 'click', () => {
        const input = $('user-sheet-password');
        input.value = generatePassword();
        input.focus();
        input.select();
    });
    // Enter in the password field signs in, which is what everyone expects.
    safeAddListener('cfg-password', 'keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submitAuth(); }
    });

    safeAddListener('inbox-fab', 'click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        openInbox();
    });
    safeAddListener('inbox-close', 'click', () => hide($('inbox-sheet')));

    // The share sheet's keys on a desktop: a number saves to that chip (as
    // drawn, the starter first), typing searches, Esc steps back or means
    // Later, Enter is Done unless a button has the focus.
    document.addEventListener('keydown', (e) => {
        if (shareSheet && shareSheet.onKey(e) && e.stopImmediatePropagation) e.stopImmediatePropagation();
    }, true);

    // Global click listener to trigger clipboard scan using a valid user gesture context.
    // Signed in only: signed out, a copy kept on the phone is its account's,
    // and the clipboard is whoever holds the phone now.
    document.addEventListener('click', (e) => {
        if (e.target.closest('.sheet')) return;
        if (!$('settings-sheet').classList.contains('hidden')) return;
        if (!$('inbox-sheet').classList.contains('hidden')) return;
        if (shareSheet && shareSheet.isOpen()) return;

        if (configured() && state.snapshot) {
            checkUnfiledLinks().catch(() => {});
        }
    });

    // Going to the background writes the copy (and a note being written)
    // down at once rather than after the usual moment: a share reloads this
    // window, and Android may close it. Coming back, and coming online, sends
    // what waits.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') saveTreeCache();
        else if (document.visibilityState === 'visible') {
            // Without Web Locks, a window that edited while this one was
            // frozen makes this one stop (durableCopy.js). A window behind
            // the card edits again once the one that edited is gone.
            if (guard) guard.recheck().catch(() => {});
            if (halted()) resumeIfFree();
            if (configured() && !halted()) {
                flushShares().then(res => { if (res && (res.uploaded.length || res.filed.length)) refreshInbox(); }).catch(() => {});
            }
        }
    });
    window.addEventListener('pagehide', (e) => {
        saveTreeCache();
        // Kept in the back-forward cache, this window would hold the copy
        // while it can answer nobody: it lets go until it is back.
        if (e && e.persisted) letGoWhileAway();
    });
    document.addEventListener('freeze', () => {
        saveTreeCache();
        letGoWhileAway();
    });
    window.addEventListener('pageshow', (e) => { if (e && e.persisted) resumeIfFree(); });
    document.addEventListener('resume', () => { if (halted()) resumeIfFree(); });
    window.addEventListener('online', () => {
        if (!configured() || halted()) return;
        flushShares().then(() => refreshInbox()).catch(() => {});
    });
    // The worker uploaded or filed something: links it filed go into the copy.
    if (navigator.serviceWorker && typeof navigator.serviceWorker.addEventListener === 'function') {
        navigator.serviceWorker.addEventListener('message', (e) => {
            const data = e.data || {};
            if (data.type !== 'tp-outbox' || !data.result || halted()) return;
            // Only what it did as the account this page is signed in as.
            if (data.account && !stillSignedInAs(data.account)) return;
            for (const f of data.result.filed || []) applyFiled(f.result);
            if (shareSheet) shareSheet.onFlushed(data.result);
            refreshInbox();
        });
    }

    // Notes always opens fresh at start-up; an entry left over from before a
    // reload would otherwise claim a pane this page is not showing.
    loadNotesPrefs();
    if (history.state && history.state.tp === 'nv') history.replaceState(null, '', location.pathname);
    syncBottomNav();

    // The copy kept on the phone survives, but the browser may clear it under
    // pressure unless the site's storage is persistent. Asked here as before
    // (granted without a prompt to an installed app); Settings › Storage
    // shows the answer and asks again from a click.
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch (e) { /* not offered */ }
    safeAddListener('storage-persist', 'click', keepDataHere);
    safeAddListener('primary-take', 'click', useHere);

    startApp();

    // Import links tapped while the app is already open. One tapped in a
    // window that does not edit the copy moves the copy there: that is
    // where the person is.
    window.addEventListener('hashchange', () => {
        if (!halted()) processImportHashIfAny();
        else if (IMPORT_HASH_RE.test(location.hash)) useHere();
    });

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(() => {});
    }
});

// Proactively scan clipboard and refresh inbox on window focus (perfect for returning to mobile PWA)
window.addEventListener('focus', async () => {
    if (halted()) {
        resumeIfFree();
        return;
    }
    if (configured() && state.snapshot) {
        await refreshInbox();
        await checkUnfiledLinks();
    }
});
