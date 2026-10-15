// The move, on the web app's side: what the browser extension's old
// interface kept, handed over by the helper (src/helper/move.js) and settled
// into this web app's own copy.
//
// Receive. 'Bring in' is a click: the helper answers only the tab it opened
// from its move page, only within ten minutes, and only with a gesture. The
// manifest lists the parts meant for this server; each part this browser
// does not hold already is read in 512 KiB chunks, its SHA-256 and its shape
// checked, and then all of them are written as they came, in one strict
// IndexedDB transaction, to the store 'moves' (in a database of its own,
// 'tabpaladin-moves'): 'part:<digest>' each and 'bundle:<bundleId>'. Only
// then does the helper hear move.ack. A tab closed half-way keeps nothing,
// and Bring in reads the parts again.
//
// Settle. Signed in only (the server confirms the account first; no token
// ever comes from the extension), each part one decision, each in TreeStore's
// own lock, each recorded as its outcome ('outcome:<digest>') and in the
// bundle's receipt ('receipt:<bundleId>'). Running it again — at the next
// start, after a failure, with the same data sent again — repeats nothing: a
// digest already settled has the same outcome as before.
//   - Every copy lands as a set-aside copy first (TreeStore.importBackupCopy),
//     keeping its owner and origin stamps. It is this account's when it is
//     stamped for it, was made while signed out ('local'), or is from before
//     accounts and this account is the server's owner (TreeStore's own rules).
//     The working copy that is this account's becomes the current one only
//     when the copy here is empty, when it has unpushed edits and the copy
//     here has none, or when both are clean and it is the later one: an
//     ordinary restoreStash, which sets the copy here aside. Otherwise it
//     waits in Settings › Set-aside copies, labelled as from the extension.
//     So no copy with unpushed edits is ever replaced.
//   - Note drafts are parked for their copies (a live one as a parked one)
//     and never dropped.
//   - Device preferences fill in only what the web app lacks.
// The parts stay in 'moves' until they are removed here.
import { el, button, download } from './desktopCore.js';
import * as DC from './durableCopy.js';
import { readNotesUi, NOTES_UI_KEY } from './lib/notesModel.js';
import { legacyWorkflowFolders } from './lib/storageManager.js';

// A database of its own: adding a store to 'tabpaladin' would close every
// window's connection to the working copy for a version change.
export const MOVES_DB = 'tabpaladin-moves';
export const MOVES_STORE = 'moves';
export const UNSETTLED_KEY = 'tp_moves_unsettled';
const CHUNK = 512 * 1024;
const MAX_PART = 64 * 1024 * 1024;
const NOTES_UI_ACCOUNTS_KEY = 'tp_notes_ui_accounts_v1';
const EXPAND_KEY = 'tpUiExpanded';
const SECRET_FIELD = /(token|password|secret|apikey)$/i;
const KINDS = new Set(['tree', 'drafts', 'prefs']);
const CLASSES = new Set(['this', 'this-moved', 'unstamped']);
const plain = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
const decode = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
const iso = () => new Date().toISOString();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// --- Checks ----------------------------------------------------------------------

export function checkManifest(m) {
    if (!plain(m) || typeof m.bundleId !== 'string' || !/^[a-f0-9-]{32,36}$/i.test(m.bundleId) || typeof m.serverId !== 'string'
        || !Array.isArray(m.parts) || m.parts.length > 1000) throw new Error('The helper sent an invalid hand-over. Nothing was kept.');
    const ids = new Set();
    for (const p of m.parts) {
        if (!plain(p) || typeof p.id !== 'string' || !p.id || p.id.length > 600 || ids.has(p.id) || !KINDS.has(p.kind)
            || typeof p.digest !== 'string' || !/^[a-f0-9]{64}$/.test(p.digest) || !Number.isSafeInteger(p.bytes) || p.bytes < 2 || p.bytes > MAX_PART) {
            throw new Error('The helper sent an invalid part list. Nothing was kept.');
        }
        ids.add(p.id);
    }
    return m;
}

// Named like a secret anywhere (keyword categories are the user's words):
// the helper never sends one, so a part that has one is refused.
function holdsSecret(value, depth = 0) {
    if (depth > 200) return true;
    if (Array.isArray(value)) return value.some(v => holdsSecret(v, depth + 1));
    if (!plain(value)) return false;
    return Object.entries(value).some(([k, v]) => SECRET_FIELD.test(k) || (k !== 'customKeywords' && holdsSecret(v, depth + 1)));
}

export function checkPart(meta, value) {
    const bad = (why) => { throw new Error(`The part "${meta.id}" is not what the helper said (${why}). Nothing was kept.`); };
    if (!plain(value) || value.v !== 1 || value.part !== meta.id) bad('header');
    if (holdsSecret(value)) bad('it holds a credential');
    if (meta.kind === 'tree') {
        if (!CLASSES.has(value.class) || !plain(value.record) || !Array.isArray(value.record.roots)) bad('copy');
        if (value.pendingRemovals !== undefined && !Array.isArray(value.pendingRemovals)) bad('removals');
        if (value.legacyWorkflows !== undefined && value.legacyWorkflows !== null && !Array.isArray(value.legacyWorkflows)) bad('workflows');
        if (value.focusedFolderIds !== undefined && !Array.isArray(value.focusedFolderIds)) bad('focused folders');
        if (value.expanded !== undefined && !plain(value.expanded)) bad('open cards');
        if (!meta.id.startsWith('stash:') && !['working', 'workflows'].includes(meta.id)) bad('name');
    } else if (meta.kind === 'drafts') {
        for (const k of ['parked', 'mirrored', 'live']) if (!Array.isArray(value[k]) || value[k].some(d => !plain(d) || typeof d.content !== 'string')) bad('drafts');
    } else if (meta.kind === 'prefs') {
        if (!plain(value.customKeywords) || !Array.isArray(value.categoryOrder) || !plain(value.uiExpanded)
            || (value.notesUi !== null && typeof value.notesUi !== 'string') || !plain(value.notesUiAccounts)) bad('settings');
    }
    return value;
}

// --- Settling, piece by piece (pure where it can be) -------------------------------

// The incoming copy E, ready to be filed: virtual and read-only nodes go
// (importBackupCopy drops them), the queued removals and the legacy workflows
// array come with it, and a copy of this server stamped at its old address
// (confirmed on the move page against the pinned identity) is stamped at
// this one, remembering the old stamp (restoredFrom) for its drafts.
export function prepareCopy(value, origin, { now = iso() } = {}) {
    const rec = value.record;
    let owner = plain(rec.owner) ? { ...rec.owner } : null;
    let restoredFrom = Array.isArray(rec.restoredFrom) ? [...rec.restoredFrom] : [];
    if (owner && value.class === 'this-moved') {
        restoredFrom = [{ url: String(owner.url || ''), userId: owner.userId ?? null, serverId: owner.serverId || null, origin: null }, ...restoredFrom];
        owner = { ...owner, url: origin };
    }
    let roots = rec.roots;
    let dirty = rec.dirty === true;
    let editCount = Math.max(0, Number(rec.editCount) || 0);
    let converted = 0;
    if (Array.isArray(value.legacyWorkflows) && value.legacyWorkflows.length) {
        const r = legacyWorkflowFolders(roots, value.legacyWorkflows, { now });
        roots = r.roots;
        converted = r.added;
        if (converted) {
            dirty = true;
            editCount += converted;
        }
    }
    // An unstamped copy from before accounts keeps the address it came from
    // (this server's own when the helper confirmed it is; one with none can
    // be nobody's here). One made while signed out was nobody's anywhere:
    // it is claimable here, as in the extension.
    const local = !owner && rec.origin === 'local';
    const url = owner ? owner.url : value.sameServer || local ? origin : (value.legacyUrl || rec.url || 'unknown');
    return {
        incoming: {
            roots, owner, origin: owner ? null : rec.origin || 'pre-accounts', url, dirty, editCount,
            baseVersion: rec.baseVersion, copyId: rec.copyId, rev: rec.rev, lastSyncAt: rec.lastSyncAt, restoredFrom,
            meta: { ...(plain(rec.meta) ? rec.meta : {}), movedFromExtension: { part: value.part, at: now, class: value.class } }
        },
        focusedFolderIds: Array.isArray(value.focusedFolderIds) ? value.focusedFolderIds : Array.isArray(rec.focusedFolderIds) ? rec.focusedFolderIds : [],
        expanded: plain(value.expanded) ? value.expanded : plain(rec.expanded) ? rec.expanded : {},
        pendingRemovals: Array.isArray(value.pendingRemovals) ? value.pendingRemovals : Array.isArray(rec.pendingRemovals) ? rec.pendingRemovals : [],
        converted
    };
}

// Whether this account's incoming working copy E becomes the current one,
// over the copy here C (which is set aside, not replaced): C empty; E with
// unpushed edits and C without; both clean and E the later one. Otherwise C
// stays, and so does E, set aside.
export function decide(e, c) {
    const cEmpty = Boolean(c.isEmpty) && !c.dirty;
    if (cEmpty) return 'restore';
    if (e.dirty && !c.dirty) return 'restore';
    if (!e.dirty && !c.dirty && (Number(e.baseVersion) || 0) > (Number(c.baseVersion) || 0)) return 'restore';
    return 'keep';
}

// Parked, mirrored and live drafts as parked drafts, in the extension's
// format the web app parks in (tp_notes_parked_v1). A title edited in the old
// editor comes back in the title field.
export function draftsFrom(value, { now = iso() } = {}) {
    const out = [];
    const add = (d, parkedAt) => {
        if (!plain(d) || typeof d.content !== 'string') return;
        const loaded = plain(d.loaded) ? { title: String(d.loaded.title || ''), content: String(d.loaded.content || '') } : { title: '', content: '' };
        const owner = plain(d.owner) && d.owner.url ? { url: String(d.owner.url), userId: d.owner.userId, username: d.owner.username || null, serverId: d.owner.serverId || null } : null;
        const draft = {
            owner, origin: owner ? null : d.origin || 'pre-accounts', noteId: d.noteId || null, notebookId: d.notebookId || null,
            title: typeof d.title === 'string' ? d.title : '', content: d.content, loaded, parkedAt: typeof parkedAt === 'string' ? parkedAt : now
        };
        if (plain(d.nv)) draft.nv = d.nv;
        else if (draft.title && draft.title !== loaded.title) {
            draft.nv = { pane: 'note', noteId: draft.noteId, editing: true, isNew: !draft.noteId, newParentId: draft.notebookId,
                draft: draft.content, loaded: loaded.content, titleField: draft.title, loadedTitle: loaded.title };
        }
        if (!out.some(x => DC.sameDraft(x, draft))) out.push(draft);
    };
    for (const d of value.parked || []) add(d, d.parkedAt);
    for (const d of value.mirrored || []) add(d, d.parkedAt);
    for (const d of value.live || []) add(d, d.at || d.parkedAt);
    return out;
}

// Keyword categories: the web app's words stay, the extension's are added
// (trimmed, lower case, once each); a category it lacks comes over. The
// category order is the web app's, with the extension's missing names after.
export function mergeKeywords(web, incoming) {
    const custom = { ...(plain(web.customKeywords) ? web.customKeywords : {}) };
    const added = [];
    for (const [name, words] of Object.entries(plain(incoming.customKeywords) ? incoming.customKeywords : {})) {
        if (['__proto__', 'constructor', 'prototype'].includes(name) || !Array.isArray(words)) continue;
        const before = Array.isArray(custom[name]) ? custom[name] : [];
        const merged = [...new Set([...before, ...words].filter(w => typeof w === 'string').map(w => w.trim().toLowerCase()).filter(Boolean))];
        if (merged.length !== before.length) {
            custom[name] = merged;
            added.push(name);
        }
    }
    const order = Array.isArray(web.categoryOrder) ? web.categoryOrder.filter(n => typeof n === 'string') : [];
    const extra = (Array.isArray(incoming.categoryOrder) ? incoming.categoryOrder : []).filter(n => typeof n === 'string' && !order.includes(n));
    return { customKeywords: custom, categoryOrder: [...order, ...extra], added, orderAdded: extra.length, orderKept: order.length > 0 && extra.length !== (incoming.categoryOrder || []).length };
}

// Open cards by newest touch, at most 500.
export function mergeCards(web, incoming) {
    const cards = { ...(plain(web) ? web : {}) };
    for (const [k, v] of Object.entries(plain(incoming) ? incoming : {})) {
        if (!plain(v) || (v.o !== 0 && v.o !== 1)) continue;
        if (!cards[k] || (Number(v.t) || 0) > (Number(cards[k].t) || 0)) cards[k] = { o: v.o, t: Number(v.t) || 0 };
    }
    const keys = Object.keys(cards).sort((a, b) => (Number(cards[b].t) || 0) - (Number(cards[a].t) || 0));
    for (const k of keys.slice(500)) delete cards[k];
    return cards;
}

// The notes view by account: by newest touch, at most 20.
export function mergeAccountsUi(web, incoming) {
    const map = { ...(plain(web) ? web : {}) };
    for (const [k, v] of Object.entries(plain(incoming) ? incoming : {})) {
        if (!plain(v) || ['__proto__', 'constructor', 'prototype'].includes(k)) continue;
        if (!map[k] || (Number(v.t) || 0) > (Number(map[k].t) || 0)) map[k] = v;
    }
    const keys = Object.keys(map).sort((a, b) => (Number(map[b] && map[b].t) || 0) - (Number(map[a] && map[a].t) || 0));
    for (const k of keys.slice(20)) delete map[k];
    return map;
}

const sameAccount = (a, b) => Boolean(a && b) && String(a.url || '').replace(/\/+$/, '') === String(b.url || '').replace(/\/+$/, '')
    && Number(a.userId) === Number(b.userId) && (a.serverId || null) === (b.serverId || null);
const partLabel = id => (id === 'working' ? 'Working copy' : id.startsWith('stash:') ? 'Set-aside copy' : id === 'workflows' ? 'Old workflows'
    : id === 'drafts' ? 'Note drafts' : id === 'prefs' ? 'Device settings' : id);

export function outcomeText(o) {
    if (!o) return 'waiting';
    if (!o.done) return 'waiting: ' + (o.error || 'not settled yet');
    const edits = o.dirty ? `${o.editCount || 1} unpushed edit${o.editCount === 1 ? '' : 's'}` : 'nothing unpushed';
    switch (o.result) {
        case 'restored': return `now your working copy (${o.items} items, ${edits}); the copy that was here is set aside`;
        case 'current': return 'already your working copy';
        case 'gone': return 'filed earlier and since brought back or discarded';
        case 'set-aside':
            if (o.why === 'both-dirty') return `From the browser extension: ${edits}. Kept aside, as your copy here has unpushed edits too. Settings › Set-aside copies: switch to it, export or discard it.`;
            if (o.why === 'current-kept') return `kept aside (${o.items} items, ${edits}): the copy here stays current. Settings › Set-aside copies has it.`;
            if (o.why === 'another-account') return `kept aside for its own account (${o.whose || 'another account'}): it comes back for that account only`;
            return `kept aside (${o.items} items, ${edits}). Settings › Set-aside copies has it.`;
        case 'parked': return `${o.count} note draft${o.count === 1 ? '' : 's'} parked; each opens with its own copy`;
        case 'merged': return (o.changed && o.changed.length ? 'added ' + o.changed.join(', ') : 'nothing new') + (o.kept && o.kept.length ? '; kept this web app\'s ' + o.kept.join(', ') : '');
        default: return o.result || 'done';
    }
}

// --- The receiver -------------------------------------------------------------------
//
// ctx: { helper, store (TreeStore), storage (StorageManager), platform, ls
//   (localStorage), indexedDB | moves (a store with createKv's get, getMany
//   and write), origin, account(), helperAccount(), confirmAccount(),
//   assertAccount(account), restore(key, account), parkDrafts(list), toast,
//   refresh, signIn, confirm, crypto }
export function createMoveReceiver(ctx) {
    let kv = null;
    let busy = false;
    let settling = false;
    let message = '';
    let sheet = null;
    // Where the section is drawn now (the sheet, Settings): drawn again on a change.
    const bodies = new Set();
    // Bundles settled here already: a hello naming one again costs nothing.
    const settledHere = new Set();
    const subtle = () => (ctx.crypto || globalThis.crypto || {}).subtle;
    const moves = () => {
        if (!kv) kv = ctx.moves || DC.createKv(ctx.indexedDB, { name: MOVES_DB, store: MOVES_STORE });
        return kv;
    };
    const ask = (text) => (ctx.confirm ? ctx.confirm(text) : globalThis.confirm(text));
    function unsettled() {
        try {
            const list = JSON.parse(ctx.ls.getItem(UNSETTLED_KEY) || '[]');
            return Array.isArray(list) ? list.filter(id => typeof id === 'string') : [];
        } catch (e) { return []; }
    }
    function markUnsettled(id, on) {
        try {
            const list = unsettled().filter(x => x !== id);
            if (on) list.push(id);
            if (list.length) ctx.ls.setItem(UNSETTLED_KEY, JSON.stringify(list)); else ctx.ls.removeItem(UNSETTLED_KEY);
        } catch (e) { /* the helper's hello and Settings find them too */ }
    }
    function changed() {
        for (const body of [...bodies]) {
            if (!body.isConnected) { bodies.delete(body); continue; }
            draw(body).catch(() => {});
        }
    }

    // One chunk, at the helper's pace: a short pause between chunks keeps
    // under its request rate, and a busy or restarting helper is asked again.
    async function readChunk(body) {
        for (let attempt = 0; ; attempt++) {
            await pause(attempt ? 1000 : 20);
            try {
                return await ctx.helper.request('move.part', body);
            } catch (e) {
                if (attempt >= 4 || !['rate-limited', 'restarting'].includes(e && e.code)) throw e;
            }
        }
    }

    async function receive({ progress = () => {} } = {}) {
        if (busy) throw new Error('Already bringing data in.');
        busy = true;
        try {
            if (!ctx.helper.supports('move.manifest')) {
                throw new Error('Connect TabPaladin helper 1.9.0 to this web app, then click Move on its move page (the toolbar icon).');
            }
            if (!subtle()) throw new Error('This needs a secure connection (HTTPS) to check what arrives. Use the backup file instead: Download a backup file on the extension\'s move page, then Bring in an extension backup here.');
            const manifest = checkManifest(await ctx.helper.request('move.manifest', {}));
            if (ctx.helper.hello && ctx.helper.hello.serverId !== manifest.serverId) throw new Error('The helper is pinned to another server identity. Nothing was kept.');
            const store = moves();
            const held = manifest.parts.length ? await store.getMany(manifest.parts.map(p => 'part:' + p.digest)) : {};
            const fresh = {};
            let done = 0;
            const total = manifest.parts.reduce((n, p) => n + p.bytes, 0);
            for (const p of manifest.parts) {
                if (held['part:' + p.digest] || fresh['part:' + p.digest]) { done += p.bytes; continue; }
                const bytes = new Uint8Array(p.bytes);
                for (let offset = 0; offset < p.bytes; offset += CHUNK) {
                    const r = await readChunk({ bundleId: manifest.bundleId, partId: p.id, offset });
                    if (!plain(r) || r.offset !== offset || r.total !== p.bytes || r.digest !== p.digest || typeof r.chunk !== 'string' || r.chunk.length > 800000) {
                        throw new Error('The helper sent an unexpected part. Nothing was kept; click Bring in again.');
                    }
                    let chunk;
                    try { chunk = decode(r.chunk); } catch (e) { throw new Error('The helper sent an unreadable part. Nothing was kept.'); }
                    if (chunk.length !== Math.min(CHUNK, p.bytes - offset)) throw new Error('A part arrived with the wrong size. Nothing was kept.');
                    bytes.set(chunk, offset);
                    done += chunk.length;
                    progress(done, total);
                }
                if (hex(await subtle().digest('SHA-256', bytes)) !== p.digest) throw new Error('A part did not match its digest. Nothing was kept; click Bring in again.');
                let text, value;
                try {
                    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
                    value = JSON.parse(text);
                } catch (e) { throw new Error('A part is not readable. Nothing was kept.'); }
                checkPart(p, value);
                fresh['part:' + p.digest] = { digest: p.digest, id: p.id, kind: p.kind, bytes: p.bytes, text, bundleId: manifest.bundleId, at: iso() };
            }
            const index = (await store.get('index')) || { bundles: [] };
            const bundle = {
                bundleId: manifest.bundleId, from: 'extension', origin: ctx.origin, serverId: manifest.serverId,
                helperVersion: typeof manifest.helperVersion === 'string' ? manifest.helperVersion.slice(0, 40) : null, at: iso(),
                parts: manifest.parts.map(({ id, kind, digest, bytes }) => ({ id, kind, digest, bytes }))
            };
            // Every part and the bundle, all or nothing, before the helper hears.
            await store.write({ ...fresh, ['bundle:' + bundle.bundleId]: bundle,
                index: { bundles: [...(Array.isArray(index.bundles) ? index.bundles : []).filter(b => b !== bundle.bundleId), bundle.bundleId] } });
            markUnsettled(bundle.bundleId, true);
            const account = ctx.helperAccount ? ctx.helperAccount() : null;
            await ctx.helper.request('move.ack', { bundleId: bundle.bundleId, received: bundle.parts.map(p => ({ id: p.id, digest: p.digest })), ...(account ? { account } : {}) });
            await store.write({ ['bundle:' + bundle.bundleId]: { ...bundle, ackedAt: iso() } });
            return bundle;
        } finally {
            busy = false;
        }
    }

    async function settleTree(part, value, account) {
        const prep = prepareCopy(value, ctx.origin);
        const saved = await ctx.store.importBackupCopy(prep.incoming, { account, sourceId: 'move:' + part.digest,
            focusedFolderIds: prep.focusedFolderIds, expanded: prep.expanded, pendingRemovals: prep.pendingRemovals });
        if (saved.current) return { result: 'current', items: saved.items };
        const listed = (await ctx.store.listStashes(account)).find(s => s.key === saved.key);
        if (!listed) return { result: 'gone', key: saved.key };
        const owner = prep.incoming.owner;
        const base = { key: saved.key, items: listed.items, dirty: listed.dirty, editCount: listed.editCount, converted: prep.converted,
            whose: owner ? `${owner.username || 'account #' + owner.userId} @ ${owner.url}` : listed.origin === 'local' ? 'made while signed out' : 'from before accounts' };
        if (listed.match !== 'same') return { ...base, result: 'set-aside', why: 'another-account' };
        if (part.id !== 'working') return { ...base, result: 'set-aside', why: 'set-aside-copy' };
        const current = ctx.store.status();
        if (decide({ dirty: listed.dirty, baseVersion: prep.incoming.baseVersion }, current) === 'restore') {
            await ctx.restore(saved.key, account);
            return { ...base, result: 'restored', setAsideHere: !current.isEmpty || current.dirty };
        }
        return { ...base, result: 'set-aside', why: current.dirty && listed.dirty ? 'both-dirty' : 'current-kept' };
    }

    async function settlePrefs(value, account) {
        const changedNames = [], kept = [];
        const settings = await ctx.storage.getSettings();
        const k = mergeKeywords(settings || {}, value);
        if (k.added.length || k.orderAdded) {
            await ctx.store.saveCopySettings({ customKeywords: k.customKeywords, categoryOrder: k.categoryOrder }, { account });
            if (k.added.length) changedNames.push(`keywords in ${k.added.length} categor${k.added.length === 1 ? 'y' : 'ies'}`);
            if (k.orderAdded) changedNames.push(`${k.orderAdded} categor${k.orderAdded === 1 ? 'y' : 'ies'} to the order`);
        }
        if (k.orderKept) kept.push('category order');
        if (Object.keys(value.uiExpanded).length) {
            const raw = (await ctx.platform.storage.local.get(EXPAND_KEY))[EXPAND_KEY];
            const web = plain(raw) && raw.v === 1 && plain(raw.cards) ? raw.cards : {};
            const cards = mergeCards(web, value.uiExpanded);
            if (JSON.stringify(cards) !== JSON.stringify(web)) {
                await ctx.platform.storage.local.set({ [EXPAND_KEY]: { v: 1, cards } });
                changedNames.push('open cards');
            }
        }
        if (value.notesUi) {
            let webRaw = null;
            try { webRaw = ctx.ls.getItem(NOTES_UI_KEY); } catch (e) { webRaw = null; }
            const incoming = readNotesUi({ getItem: () => value.notesUi });
            if (!webRaw) {
                try { ctx.ls.setItem(NOTES_UI_KEY, JSON.stringify(incoming)); changedNames.push('the notes view'); } catch (e) { /* kept in the part */ }
            } else {
                const web = readNotesUi(ctx.ls);
                const expanded = [...new Set([...web.expanded, ...incoming.expanded])].slice(0, 1000);
                if (expanded.length !== web.expanded.length) {
                    try { ctx.ls.setItem(NOTES_UI_KEY, JSON.stringify({ ...web, expanded })); changedNames.push('open notebooks'); } catch (e) { /* kept in the part */ }
                }
                kept.push('notes view');
            }
        }
        if (Object.keys(value.notesUiAccounts).length) {
            let web = {};
            try { web = JSON.parse(ctx.ls.getItem(NOTES_UI_ACCOUNTS_KEY) || '{}') || {}; } catch (e) { web = {}; }
            const merged = mergeAccountsUi(web, value.notesUiAccounts);
            if (JSON.stringify(merged) !== JSON.stringify(web)) {
                try { ctx.ls.setItem(NOTES_UI_ACCOUNTS_KEY, JSON.stringify(merged)); } catch (e) { /* kept in the part */ }
            }
        }
        return { result: 'merged', changed: changedNames, kept };
    }

    async function settlePart(part, value, account) {
        if (part.kind === 'tree') return settleTree(part, value, account);
        if (part.kind === 'drafts') {
            const list = draftsFrom(value);
            if (list.length) {
                ctx.parkDrafts(list);
                // One for the copy here now comes back into the editor.
                if (ctx.reopenDrafts) ctx.reopenDrafts();
            }
            return { result: 'parked', count: list.length };
        }
        return settlePrefs(value, account);
    }

    async function settleBundle(bundleId, { interactive = false } = {}) {
        const store = moves();
        const bundle = await store.get('bundle:' + bundleId);
        if (!bundle) return { bundleId, gone: true };
        let receipt = (await store.get('receipt:' + bundleId)) || { bundleId, from: 'extension', at: iso(), outcome: {} };
        if (receipt.done) return { ...receipt, already: true };
        let account = null;
        try {
            account = await ctx.confirmAccount();
        } catch (e) {
            return { ...receipt, waiting: 'offline', error: 'The server could not confirm your account just now. What arrived is kept here and is brought in at the next start.' };
        }
        if (!account) return { ...receipt, waiting: 'sign-in' };
        if (bundle.serverId && account.serverId && bundle.serverId !== account.serverId) {
            return { ...receipt, waiting: 'server', error: 'This data was handed over for another server identity. It stays here, not brought in.' };
        }
        if (receipt.account && !sameAccount(receipt.account, account)) {
            const name = account.username || 'account #' + account.userId;
            if (!interactive || !ask(`Bringing in the extension's data began as ${receipt.account.username || 'another account'}. Continue as ${name}?`)) {
                return { ...receipt, waiting: 'confirm' };
            }
        }
        receipt = { ...receipt, account: { url: account.url, userId: account.userId, username: account.username || null, serverId: account.serverId || null } };
        const rank = p => (p.id === 'working' ? 0 : p.kind === 'tree' ? 1 : p.kind === 'drafts' ? 2 : 3);
        for (const part of [...bundle.parts].sort((a, b) => rank(a) - rank(b))) {
            if (receipt.outcome[part.id] && receipt.outcome[part.id].done) continue;
            const prior = await store.get('outcome:' + part.digest);
            if (prior && prior.done) {
                receipt.outcome = { ...receipt.outcome, [part.id]: { ...prior, again: true } };
                await store.write({ ['receipt:' + bundleId]: receipt });
                continue;
            }
            let outcome;
            try {
                // The account and its copy, as they are now, before each decision.
                await ctx.assertAccount(account);
            } catch (e) {
                receipt.outcome = { ...receipt.outcome, [part.id]: { done: false, at: iso(), error: 'The account or working copy changed. It continues at the next start.' } };
                await store.write({ ['receipt:' + bundleId]: receipt });
                break;
            }
            try {
                const held = await store.get('part:' + part.digest);
                if (!held || typeof held.text !== 'string') throw new Error('This part is no longer held here. Click Send again on the extension\'s move page.');
                const value = checkPart(part, JSON.parse(held.text));
                outcome = { done: true, at: iso(), ...(await settlePart(part, value, account)) };
            } catch (e) {
                receipt.outcome = { ...receipt.outcome, [part.id]: { done: false, at: iso(), error: e.message } };
                await store.write({ ['receipt:' + bundleId]: receipt });
                if (e && e.code === 'account-changed') break;
                continue;
            }
            receipt.outcome = { ...receipt.outcome, [part.id]: outcome };
            // One decision, one record: the outcome by digest and the receipt.
            await store.write({ ['outcome:' + part.digest]: outcome, ['receipt:' + bundleId]: receipt });
        }
        receipt.done = bundle.parts.every(p => receipt.outcome[p.id] && receipt.outcome[p.id].done);
        if (receipt.done) receipt.settledAt = iso();
        await store.write({ ['receipt:' + bundleId]: receipt });
        if (receipt.done) markUnsettled(bundleId, false);
        return receipt;
    }

    function summary(receipt) {
        const outcomes = Object.values(receipt.outcome || {}).filter(o => o.done && !o.again);
        const restored = outcomes.some(o => o.result === 'restored');
        const aside = outcomes.filter(o => o.result === 'set-aside').length;
        const drafts = outcomes.filter(o => o.result === 'parked').reduce((n, o) => n + (o.count || 0), 0);
        const kept = outcomes.flatMap(o => o.kept || []);
        const said = [restored ? 'its working copy is current now' : '',
            aside ? `${aside} cop${aside === 1 ? 'y' : 'ies'} kept aside (Settings › Set-aside copies)` : '',
            drafts ? `${drafts} note draft${drafts === 1 ? '' : 's'} parked` : '',
            kept.length ? `kept this web app's ${kept.join(', ')}` : ''].filter(Boolean);
        return 'Brought in from the extension: ' + (said.length ? said.join('; ') : 'nothing new') + '.';
    }

    // Every bundle not settled yet (or `ids`), once signed in. Quietly at a
    // start: an account change asks only from a click.
    async function settlePending({ ids = null, interactive = false } = {}) {
        if (settling || busy) return null;
        const list = [...new Set([...unsettled(), ...(ids || [])])].filter(id => !settledHere.has(id));
        if (!list.length) return null;
        if (!ctx.account()) {
            message = 'Sign in to finish bringing your data in from the extension.';
            changed();
            return null;
        }
        settling = true;
        const results = [];
        try {
            for (const id of list) {
                const r = await settleBundle(id, { interactive });
                results.push(r);
                if (r && (r.done || r.gone)) settledHere.add(id);
                if (r && r.done && !r.already) ctx.toast(summary(r));
                else if (r && r.waiting === 'confirm') message = 'The extension\'s data waits for you to continue as this account: open it from Settings.';
                else if (r && r.waiting === 'sign-in') message = 'Sign in to finish bringing your data in from the extension.';
                else if (r && r.error) message = r.error;
                else if (r && !r.done && !r.gone) message = 'Some of the extension\'s data is not settled yet. It continues at the next start.';
                if (r && r.gone) markUnsettled(id, false);
            }
            if (results.some(r => r && r.done && !r.already)) ctx.refresh();
        } finally {
            settling = false;
            changed();
        }
        return results;
    }

    async function bundles() {
        const store = moves();
        const index = (await store.get('index')) || { bundles: [] };
        const ids = (Array.isArray(index.bundles) ? index.bundles : []).slice().reverse();
        if (!ids.length) return [];
        const data = await store.getMany(ids.flatMap(id => ['bundle:' + id, 'receipt:' + id]));
        return ids.map(id => ({ bundle: data['bundle:' + id], receipt: data['receipt:' + id] || null })).filter(x => x.bundle);
    }

    // Remove one hand-over's parts. A part another hand-over also holds
    // stays; what each part settled into stays where it is, and a later
    // hand-over of the same data is still not settled twice.
    async function removeBundle(bundleId) {
        const store = moves();
        const index = (await store.get('index')) || { bundles: [] };
        const bundle = await store.get('bundle:' + bundleId);
        const others = (Array.isArray(index.bundles) ? index.bundles : []).filter(b => b !== bundleId);
        const otherData = others.length ? await store.getMany(others.map(b => 'bundle:' + b)) : {};
        const used = new Set(Object.values(otherData).flatMap(b => (b && b.parts ? b.parts : []).map(p => p.digest)));
        const entries = { ['bundle:' + bundleId]: null, ['receipt:' + bundleId]: null, index: { bundles: others } };
        for (const p of (bundle && bundle.parts) || []) if (!used.has(p.digest)) entries['part:' + p.digest] = null;
        await store.write(entries);
        markUnsettled(bundleId, false);
    }

    async function draw(body) {
        if (!body) return;
        const nodes = [];
        nodes.push(el('p', {}, 'What the TabPaladin extension\'s old interface kept arrives here. Every copy lands set aside first: nothing replaces work you have in this web app. The extension keeps its own data until you remove it there.'));
        if (message) nodes.push(el('p', { className: 'move-message', role: 'status' }, message));
        if (ctx.helper.supports('move.manifest')) {
            const note = el('p', { className: 'move-progress' });
            nodes.push(button('Bring in', async () => {
                message = '';
                note.textContent = 'Bringing in…';
                try {
                    await receive({ progress: (n, total) => { note.textContent = `Bringing in… ${Math.round((n / Math.max(1, total)) * 100)}%`; } });
                    note.textContent = 'Received and kept on this device.';
                    if (!ctx.account()) message = 'Received. Sign in to finish bringing your data in.';
                    else await settlePending({ interactive: true });
                } catch (e) {
                    note.textContent = '';
                    message = e.message;
                }
                changed();
            }, 'primary'), note);
        } else {
            nodes.push(el('p', {}, 'To bring data in, click the TabPaladin extension\'s toolbar icon and choose Move on its move page. That needs helper 1.9.0 connected to this server.'));
        }
        if (!ctx.account() && unsettled().length) nodes.push(button('Sign in', () => ctx.signIn()));
        let list = [];
        try { list = await bundles(); } catch (e) { nodes.push(el('p', {}, 'The moved data cannot be read here: ' + e.message)); }
        for (const { bundle, receipt } of list) {
            const item = el('article', { className: 'move-bundle' });
            const done = receipt && receipt.done;
            item.append(el('strong', {}, `From the extension, ${new Date(bundle.at).toLocaleString()} · ${bundle.parts.length} part${bundle.parts.length === 1 ? '' : 's'} · ${done ? 'brought in' : 'waiting'}`));
            for (const p of bundle.parts) {
                const line = el('div', { className: 'move-part' }, el('span', {}, partLabel(p.id) + ': ' + outcomeText(receipt && receipt.outcome[p.id])));
                line.append(button('Export', async () => {
                    const held = await moves().get('part:' + p.digest);
                    if (!held) throw new Error('This part is no longer held here.');
                    download(`tabpaladin-moved-${p.kind}-${p.digest.slice(0, 8)}.json`, held.text);
                }));
                item.append(line);
            }
            if (!done) item.append(button('Finish now', () => settlePending({ ids: [bundle.bundleId], interactive: true })));
            item.append(button('Remove moved parts…', async () => {
                const text = done ? 'Remove these moved parts from this device? What they brought in stays; the extension keeps its own data.'
                    : 'Not all of this has been brought in yet. Remove it anyway? The extension keeps its own data, and you can send it again from there.';
                if (!ask(text)) return;
                await removeBundle(bundle.bundleId);
                changed();
            }));
            nodes.push(item);
        }
        body.replaceChildren(...nodes);
    }

    function open() {
        if (sheet && sheet.isConnected) { changed(); return; }
        const body = el('div', { className: 'move-body' });
        bodies.add(body);
        sheet = el('div', { className: 'move-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Bring in from the TabPaladin extension' },
            el('div', { className: 'move-panel' },
                el('div', { className: 'move-head' }, el('strong', {}, 'Bring in from the TabPaladin extension'), button('✕', () => close())),
                body));
        document.body.append(sheet);
        draw(body).catch(() => {});
    }
    function close() {
        if (sheet) sheet.remove();
        sheet = null;
    }
    async function render(root) {
        const section = el('section', { className: 'move-settings' }, el('h2', {}, 'Moved from the extension'));
        const body = el('div', { className: 'move-body' });
        section.append(body);
        root.append(section);
        bodies.add(body);
        await draw(body);
    }
    return { receive, settleBundle, settlePending, removeBundle, bundles, open, close, render, unsettled, get message() { return message; } };
}
