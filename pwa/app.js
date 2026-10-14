// Minimal vanilla PWA for TabPaladin. Browses the server's canonical tree
// (GET /api/tree) as a working copy, edits it locally, and pushes it back
// (PUT /api/tree) git-style — a push against a tree another device changed
// since the last pull is refused until you pull or force, unless all that
// changed is links filed from a share sheet, which are folded in and the push
// goes again.
//
// The working copy is the extension's own: the shared TreeStore
// (lib/treeStore.js, byte-identical to src/utils/treeStore.js) on this app's
// platform (platform.js: IndexedDB, Web Locks, BroadcastChannel). So every
// edit and every sync goes through TreeStore, with its account rules — a copy
// belongs to one account, another account's is set aside and never pulled
// over or pushed into this one (a 412), a pull never runs over unpushed
// edits unasked — and every window of the app edits the one copy at once,
// each hearing the others. What this file draws (state.snapshot) is a view of
// TreeStore's copy, rebuilt whenever it changes. Without Web Locks (a
// plain-http address) one window edits at a time, as before.
//
// A phone pushes after each change by default, as it always has; a computer
// keeps its edits until Push (a per-device setting, with a sync chip).
//
// Sharing: a link shared to the app is kept in the outbox (tp-outbox, by the
// service worker or here), and the share sheet (shareSheet.js) files it with
// one tap on a suggested folder — straight into the server's tree, as a small
// append (POST /api/shares/:sid/file) rather than a push of this whole copy.

// First: the shared core reads its platform as it loads.
import { pagePlatform } from './platform.js';
import { TreeStore } from './lib/treeStore.js';
import { importedFolderFrom, countNodes } from './bookmarksHtml.js';
import * as NM from './lib/notesModel.js';
import { createShareSheet } from './shareSheet.js';
import * as DC from './durableCopy.js';

const platform = pagePlatform || globalThis.__tpPlatform;

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
        serverId: localStorage.getItem(LS.serverId) || null,
        tenancyOwner: localStorage.getItem(LS.owner) === '1'
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
    // snapshot, dirty, editCount, treeVersion: read from TreeStore (below)
    treeRev: 0,               // bumped on every change to the copy, for the share sheet's folder index
    pathIds: [],              // breadcrumb stack of folder identifiers (root, child, ...)
    view: 'home',             // 'home' (search, pins, bookmark folders) | 'notes'
    nv: freshNv(),            // notes navigation: pane, scope, open note, editor draft
    proposals: [],            // pending LLM note proposals awaiting approval
    changes: [],              // pending bookmark changes from AI chats (share link or MCP), with previews
    importers: [],            // configured import sources: [{id, provider, connected, items, ...}]
    importBatch: null         // pending #notes / #reorder import awaiting review: {kind:'notes',items}|{kind:'reorder',order}
};

const $ = (id) => document.getElementById(id);

// --- The working copy, as TreeStore holds it ------------------------------------------
//
// state.snapshot is a view of TreeStore's copy in the shape this app draws:
// a wrapper { type: 'root', children } around the top-level folders, notes as
// bookmarks with a data: url, every id as _pwaId (see fromWire). It is built
// again, when next read, after any change to the copy — here, in another
// window, a pull — so nothing ever edits it: every change goes through
// TreeStore, and code holding a node across an await finds it again by id.
// Null while there is no copy to show: none pulled yet for this account.
const ROOT_ID = '__tp_root__';
let viewStamp = 0;
let view = null;
state.pathIds = [ROOT_ID];

function copyStatus() {
    return TreeStore.status();
}

// A copy worth drawing: pulled or pushed at least once, or holding something.
// A copy just started for an account, whose pull has not landed, is not.
function copyPresent() {
    const st = copyStatus();
    return st.loaded && (!st.isEmpty || Boolean(st.lastSyncAt) || st.baseVersion > 0 || st.dirty);
}

function currentView() {
    if (!copyPresent()) return null;
    if (!view || view.stamp !== viewStamp) {
        view = { stamp: viewStamp, snapshot: { type: 'root', title: '', _pwaId: ROOT_ID, children: TreeStore.roots().map(fromWire) } };
    }
    return view.snapshot;
}

Object.defineProperties(state, {
    snapshot: { get: currentView, enumerable: true },
    dirty: { get: () => copyStatus().dirty, enumerable: true },
    editCount: { get: () => copyStatus().editCount, enumerable: true },
    treeVersion: { get: () => copyStatus().baseVersion, enumerable: true }
});

// This copy's own data (TreeStore meta): the import links whose notes are in
// it and not on the server yet, and the ids of it the server has.
let metaCache = null;
function copyMetaNow() {
    if (!metaCache) metaCache = TreeStore.meta();
    return metaCache;
}

function serverIdSet() {
    return new Set(copyMetaNow().serverIds || []);
}

function idsOfRoots(roots) {
    const ids = [];
    const walk = (n) => {
        if (!n || n.virtual || n.readOnly) return;
        if (n.id) ids.push(String(n.id));
        (n.children || []).forEach(walk);
    };
    (roots || []).forEach(walk);
    return ids;
}

// Something changed in the copy (an edit here or in another window, a pull,
// a push, another copy brought in).
// undefined until the start has read the copy: a copy's id may itself be null.
let lastCopyId;
TreeStore.onChanged((kind) => {
    metaCache = null;
    if (kind === 'meta') return;
    viewStamp++;
    state.treeRev++;
    onCopyChanged(kind);
});

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

// The session expired or was revoked — say so plainly and send the user to
// sign in, rather than surfacing a bare 401 from somewhere deep in the app.
// The worker's copy of the token goes too, or it would keep posting shares
// with a dead one. Unpushed edits stay where they are, in the copy. Only that
// session: a request still on its way from before a sign-out and another
// sign-in leaves the new one alone.
function sessionExpired(used) {
    if (state.config.token !== used) return;
    const stored = holdsStoredSession();
    state.config.token = '';
    if (stored) {
        localStorage.removeItem(LS.token);
        mirrorConfigToSW();
    }
    setStatus('Session expired — sign in again.');
    try { refreshAuthUi(); show($('settings-sheet')); } catch (e) { /* pre-DOM */ }
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
        sessionExpired(used);
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
// Bumped whenever this window stops editing the copy (enterSecondary): a
// start on its way then goes no further — no pull, no prompt, nothing
// opened behind the card for a copy another window has now.
let bootGen = 0;

async function bootstrap({ previousUsername = null, switched: switchedAtSignIn = null } = {}) {
    const gen = bootGen;
    const gone = () => gen !== bootGen || halted();
    if (gone()) return;
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
    // So is a link with suggested bookmark changes (offered at the end).
    stashChangesHash();

    // A share that opened the app is in the outbox (or, from the old
    // redirect, in the URL, and goes in there now) before anything else.
    await migrateLegacyShares();
    if (gone()) return;
    const shared = await handleShareEntry();
    if (gone()) return;

    // On the first start of this page: the working copy kept on the device
    // (what the last release kept becomes TreeStore's first), so a reload, a
    // share that reloaded the window, or the phone closing the app, loses no
    // unpushed edit or half-written note.
    const restored = !booted ? await startCopy() : null;
    booted = true;
    if (gone()) return;

    // The sheet's pins and statistics as kept on the phone, before it draws:
    // its chips are drawn once and never reordered.
    await loadKeptShareData();
    if (gone()) return;
    if (shared) shareSheet.open(shared, { fromShare: true });

    if (!configured()) {
        const owner = copyStatus().owner;
        setStatus(restored && restored.dirty
            ? `Restored unpushed changes from ${restored.at} — sign in as ${(owner && owner.username) || 'their account'} to push them.`
            : 'Open Settings (⚙) to configure your sync server.');
        if (arrived) showToast(SIGN_IN_TO_IMPORT);
        shareSheet.refreshInbox();
        return;
    }
    await refreshWhoAmI();
    if (gone()) return;
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
    // The working copy is this account's before anything goes into it:
    // another account's is set aside (never pulled over, never pushed into
    // this one), and this account's own set-aside copy comes back.
    const switchedNow = await ensureAccountCopy({ previousUsername });
    const switched = switchedAtSignIn && (!switchedNow || switchedNow.action === 'same') ? switchedAtSignIn : switchedNow;
    if (gone()) return;
    // Shares waiting on the phone go up now (and those chosen offline are
    // filed), before the pull, so the pull brings them in. Those made while
    // nobody, or someone else, was signed in are asked about, never sent on
    // their own.
    await flushShares();
    if (gone()) return;
    await offerUnclaimedShares();
    if (gone()) return;
    // A pull replaces the working copy, so it never runs over unpushed edits
    // — after a sign-out and back in, or a reload, they are still here.
    if (state.dirty && state.snapshot) {
        renderView();
        const at = switched && switched.restoredAt ? keptTime(switched.restoredAt) : restored && restored.dirty ? restored.at : null;
        setStatus(at
            ? `Restored unpushed changes from ${at} — ⬆️ Push to keep them, or Pull to discard.`
            : 'You have unpushed edits from before you were signed out — Push to keep them, or Pull to discard.');
    } else if (restored && state.snapshot && copyIsMine() && !(switched && switched.action !== 'same' && switched.action !== 'claimed')) {
        // A clean copy from the last time: on screen already; pulled only
        // when the server has moved on.
        renderView();
        try {
            const copy = await TreeStore.currentCopy();
            const v = await api('/api/tree/version');
            if (!gone() && Number(v.version) !== state.treeVersion && !state.dirty) await pullSnapshot({ expect: copy, quiet: true });
        } catch (e) { /* offline, or changed meanwhile: the kept copy stands */ }
    } else {
        try { await pullSnapshot(); } catch (e) { /* status already set */ }
    }
    if (gone()) return;
    // A note parked with this copy (a sign-out, another account signing in,
    // another window bringing another copy in) is back in its editor.
    reopenParkedDraft();
    loadShareStats();
    loadSharePrefs();
    await refreshInbox();
    if (gone()) return;
    if (!shareSheet.isOpen()) await afterShareSheet();
    if (gone()) return;
    await openPendingImport({ id: arrived ? arrived.id : null, why: arrived ? 'arrived' : 'auto' });
    await offerPendingChanges();
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
// the server yet. They are kept with the copy itself (its meta), so they last
// exactly as long as it does — set aside with it, and back with it: the push
// that carries them up drops them from the phone (pushSnapshot), and a pull
// that throws the copy away gives them back to the waiting block, since what
// they hold never got anywhere. Meanwhile they are neither waiting nor opened
// a second time.
function copyImportIds() {
    return copyPresent() ? copyMetaNow().importIds || [] : [];
}

async function holdImportInCopy(id) {
    if (!id) return;
    await TreeStore.updateMeta((m) => {
        const ids = Array.isArray(m.importIds) ? m.importIds : [];
        return ids.includes(id) ? m : { ...m, importIds: [...ids, id] };
    });
}

// Pending links for whoever is here, other than the one under review, those
// already in this copy, and those of notes parked on the device (back in the
// editor when their copy is).
function waitingImports() {
    const open = new Set([
        state.importBatch && state.importBatch.importId,
        state.nv.editing && state.nv.importId,
        ...parkedImportIds(),
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

// The copy on screen is the signed-in account's. Always so while signed in
// (ensureAccountCopy); checked anyway before anything is put into it.
function copyIsMine() {
    const owner = copyStatus().owner;
    const id = state.identity && state.identity.userId !== null && state.identity.userId !== undefined
        ? Number(state.identity.userId) : currentUserId();
    if (!owner || id === null) return true;
    return Number(owner.userId) === Number(id) && sameServerUrl(owner.url, state.config.url);
}

function sameServerUrl(a, b) {
    const norm = (u) => {
        const t = String(u || '').replace(/\/+$/, '');
        try {
            const x = new URL(t);
            return x.origin + x.pathname.replace(/\/$/, '');
        } catch (e) {
            return t;
        }
    };
    return norm(a) === norm(b);
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

// What TreeStore's requests go with: this page's server and session.
function syncConfig() {
    return { url: (state.config.url || '').replace(/\/+$/, ''), token: state.config.token || '' };
}

// TreeStore meets a dead session the way api() does, and it is said the same
// way: the token goes, the sign-in opens. True when it was that.
function sessionRefused(e, used) {
    if (!e || e.status !== 401) return false;
    sessionExpired(used);
    return true;
}

// Why a sync stopped having changed nothing (TreeStore's codes): said as it
// is, not as a failure.
function stoppedCode(e) {
    return Boolean(e) && (e.code === 'account-changed' || e.code === 'edited-during-pull' || e.code === 'account-unconfirmed');
}

// Replace the working copy with the server's tree: TreeStore.sync.pull, for
// the copy as it is now or the one the user was asked about (`expect`). It
// stops having replaced nothing when another copy came in meanwhile, the
// copy was edited meanwhile, or whose it is could not be confirmed — and a
// tree that turns out another account's comes into a copy of its own, this
// one set aside. Callers have asked about unpushed edits first.
async function pullSnapshot({ expect = null } = {}) {
    syncBusy++;
    try {
        setStatus('Pulling…');
        if (!configured()) throw new Error('Server not configured. Open Settings.');
        const used = state.config.token;
        const into = expect || await TreeStore.currentCopy();
        let res;
        try {
            res = await asLocalSwitch(() => TreeStore.sync.pull(syncConfig(), { expect: into }));
        } catch (e) {
            if (sessionRefused(e, used)) throw Object.assign(new Error('Signed out'), { status: 401 });
            throw e;
        }
        // What the pull threw away never got anywhere: the links held in it
        // wait again. Everything in it now, the server has.
        await TreeStore.updateMeta((m) => ({ ...m, importIds: [], serverIds: idsOfRoots(TreeStore.roots()) }));
        state.pathIds = [ROOT_ID];
        noteSync('pull');
        renderView();
        if (res && res.setAside) showToast('The copy on this device was another account’s: it is set aside here, not pulled over.');
        if (shareSheet) shareSheet.refresh();
        return res;
    } catch (e) {
        setStatus(stoppedCode(e) ? e.message : 'Pull failed: ' + e.message);
        throw e;
    } finally {
        syncBusy--;
        updateSyncUi();
    }
}

async function refreshInbox() {
    if (shareSheet) await shareSheet.refreshInbox();
}

// Everything AI chats proposed, from the share link or MCP: notes and orders
// wait in Notes (state.proposals), bookmark changes on Home (state.changes),
// each with the server's preview and whether it is out of date. An older
// server only lists notes and orders.
async function refreshProposals() {
    const account = accountKey();
    try {
        let list;
        try {
            list = (await api('/api/proposals/review')).proposals || [];
        } catch (e) {
            if (e.status !== 404) throw e;
            list = (await api('/api/proposals')).proposals || [];
        }
        // Signed out or switched while it was asked: not this account's.
        if (accountKey() !== account) return;
        // Redrawn when anything shown changed, not only the status: a
        // suggestion's lines are planned again against the tree each time.
        const sig = (l) => JSON.stringify(l.map(p => [p.id, changeShown(p)]));
        const before = sig(state.proposals) + '|' + sig(state.changes);
        state.proposals = list.filter(p => p.kind !== 'tree');
        state.changes = list.filter(p => p.kind === 'tree');
        // They arrive after the first paint: Home's banner and block and the
        // library's pending block need a redraw when they changed.
        if (state.snapshot && sig(state.proposals) + '|' + sig(state.changes) !== before) renderView();
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
    updateSyncUi();
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
    if (configured() && !copyIsMine()) return; // another account's copy: see renderContent
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
    // Signed in as someone else than the copy here is (another window's
    // switch on its way, a sign-in a moment from setting it aside): never
    // drawn under this account.
    if (state.snapshot && configured() && !copyIsMine()) {
        root.classList.remove('in-imports');
        const wait = document.createElement('div');
        wait.className = 'empty';
        wait.textContent = 'Loading your copy…';
        root.appendChild(wait);
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

    // Bookmark changes AI chats proposed wait here, on Home.
    if (state.changes.length) wrap.appendChild(renderChangesBlock());

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
            if (!(await copyEdit(() => TreeStore.removeNode(wf._pwaId)))) return;
            renderView();
            try {
                setStatus('Saving…');
                const pushed = await pushAfterEdit();
                showToast(pushed ? 'Workflow deleted.' : 'Workflow deleted on this computer — ⬆️ Push when ready.');
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
    // is no title-guessing and no duplicate-roots hazard. Made in the copy as
    // part of the save that asked for it, which edits it next and pushes (or
    // not, on a computer), and the root goes with it.
    if (!(await copyEdit(() => TreeStore.ensureRoleRoot('notes')))) return null;
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

// After every notes write (made in the copy through TreeStore already): push
// it, with the usual 409 dialog — on a device that pushes after each change,
// which a phone does unless told otherwise. A computer keeps it until Push.
// One helper, so changing that is a change in one place.
async function commitNotesEdit(label = 'Saving…', doneToast = '') {
    updatePushBtnState();
    if (!pushAfterEachChange()) {
        if (doneToast) showToast(doneToast);
        updateSyncUi();
        return true;
    }
    try {
        setStatus(label);
        await pushSnapshot();
        setStatus('');
        if (doneToast) showToast(doneToast);
        return true;
    } catch (e) {
        setStatus('');
        showToast(`Push failed: ${e.message} — kept on this ${deviceWord()}, use ⬆️ to retry.`);
        return false;
    } finally {
        updatePushBtnState();
        syncBottomNav();
    }
}

// An edit of the copy, through TreeStore: false, and said why, when it could
// not be made (the item is gone, or is part of the read-only archive).
async function copyEdit(fn) {
    try {
        await fn();
        return true;
    } catch (e) {
        showToast(e && e.message ? e.message : String(e));
        return false;
    }
}

// After an edit outside Notes: pushed when this device pushes after each
// change (true), kept for Push otherwise (false). Throws what the push threw.
async function pushAfterEdit() {
    if (!pushAfterEachChange()) {
        updateSyncUi();
        return false;
    }
    await pushSnapshot();
    return true;
}

// A note's payload as TreeStore holds it, for an edit that keeps whatever
// fields this app does not know.
function rawPayload(id) {
    const hit = findRaw(id);
    return hit && hit.payload && typeof hit.payload === 'object' ? hit.payload : {};
}

function findRaw(id) {
    const walk = (nodes) => {
        for (const n of nodes || []) {
            if (n.id === id) return n;
            const hit = walk(n.children);
            if (hit) return hit;
        }
        return null;
    };
    return id ? walk(TreeStore.roots()) : null;
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
    // The kept draft goes once the copy is written with whatever the editor
    // saved: never before it (saveLiveDraft).
    if (was) saveLiveDraft();
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
    if (!e.state && (IMPORT_HASH_RE.test(location.hash) || location.hash.startsWith(CHANGES_HASH))) return;
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

    const share = nvEl('button', 'ghost-block nv-share', '🔗 Share notes & bookmarks with an AI chat (1-hour link)');
    share.type = 'button';
    share.dataset.nv = 'share';
    share.title = 'Create a 1-hour link with your notes, bookmarks and instructions to paste into any AI chat that can browse';
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
async function rewriteLinksAfterRename(oldTitle, newTitle, exceptId) {
    const found = findNotesFolderWithPath();
    if (!found || !oldTitle || oldTitle === newTitle) return;
    const changes = [];
    const walk = (folder) => {
        for (const c of folder.children || []) {
            if (isNoteBookmark(c) && c._pwaId !== exceptId) {
                const meta = decodeNote(c);
                const rewritten = NM.rewriteWikiLink(meta.content, oldTitle, newTitle);
                if (rewritten !== meta.content) changes.push({ id: c._pwaId, content: rewritten });
            } else if (isFolderNode(c)) {
                walk(c);
            }
        }
    };
    walk(found.node);
    for (const ch of changes) {
        await copyEdit(() => TreeStore.updateNode(ch.id, { payload: { ...rawPayload(ch.id), content: ch.content } }));
    }
}

// Create the folders an import link named, now that the note is being saved.
// Resolves the id of the notebook to file into.
async function ensureNotebookByName(name) {
    const found = findNotesFolderWithPath();
    if (!found) return null;
    const res = NM.resolveNotebookByName(notesLibrary(), name);
    if (!res) return found.node._pwaId;
    if (res.id) return findNotesNode(res.id) ? res.id : found.node._pwaId;
    let parentId = res.create.parentId && findNotesNode(res.create.parentId) ? res.create.parentId : found.node._pwaId;
    for (const segment of res.create.segments) {
        let made = null;
        if (!(await copyEdit(async () => { made = await TreeStore.createNode({ parentId, kind: 'folder', title: segment }); }))) break;
        NV_UI.expanded.add(parentId);
        parentId = made.id;
    }
    return parentId;
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
        let parentId = null;
        if (nv.pendingNotebookName) parentId = await ensureNotebookByName(nv.pendingNotebookName);
        else if (nv.newParentId && isFolderNode(findNotesNode(nv.newParentId)?.node)) parentId = nv.newParentId;
        if (!parentId) parentId = (findNotesFolderWithPath() || found).node._pwaId;
        const r = NM.resolveTitleOnSave({ storedTitle: null, loadedContent: nv.loaded || '', newContent: content });
        let made = null;
        const ok = await copyEdit(async () => {
            made = await TreeStore.createNode({ parentId, kind: 'note', title: r.title, payload: { content: r.content, createdAt: now, updatedAt: now } });
        });
        if (!ok) return;
        // An import link's note is in the copy now, not on the server: the
        // link stays on the phone until the push below (or a later one) gets
        // it there.
        await holdImportInCopy(nv.importId);
        nv.importId = null;
        stopEditing();
        nv.noteId = made.id;
        history.replaceState(nvHistoryState(), '', location.pathname);
    } else {
        const hit = findNotesNode(nv.noteId);
        if (!hit) {
            showToast('This note is gone — copy your text before leaving.');
            return;
        }
        const note = hit.node;
        const meta = decodeNote(note);
        // The note changed under the editor (a Pull, an approved proposal,
        // another window or an import brought another version in): never
        // overwrite that. The edit is saved as a note of its own right next
        // to it.
        if (nv.loaded != null && meta.content !== nv.loaded) {
            const title = `${note.title} (my edit)`;
            let made = null;
            const ok = await copyEdit(async () => {
                made = await TreeStore.createNode({
                    parentId: hit.parent._pwaId, kind: 'note', title, index: hit.index + 1,
                    payload: { content, createdAt: now, updatedAt: now }
                });
            });
            if (!ok) return;
            stopEditing();
            nv.noteId = made.id;
            history.replaceState(nvHistoryState(), '', location.pathname);
            saveNotesPrefs();
            renderView();
            await commitNotesEdit('Saving…', `“${note.title}” changed on another device — your edit is saved next to it as “${title}”.`);
            renderView();
            return;
        }
        const r = NM.resolveTitleOnSave({
            storedTitle: note.title,
            loadedContent: nv.loaded == null ? meta.content : nv.loaded,
            newContent: content
        });
        const oldTitle = note.title;
        const ok = await copyEdit(() => TreeStore.updateNode(note._pwaId, {
            title: r.title,
            payload: { ...rawPayload(note._pwaId), content: r.content, createdAt: meta.createdAt || now, updatedAt: now }
        }));
        if (!ok) return;
        await rewriteLinksAfterRename(oldTitle, r.title, note._pwaId);
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
    if (!(await copyEdit(() => TreeStore.updateNode(hit.node._pwaId, {
        payload: { ...rawPayload(hit.node._pwaId), content: updated, createdAt: meta.createdAt || now, updatedAt: now }
    })))) return;
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
    if (!(await copyEdit(() => TreeStore.updateNode(id, {
        title: r.title,
        payload: { ...rawPayload(id), content: r.content, createdAt: meta.createdAt || now, updatedAt: now }
    })))) return;
    await rewriteLinksAfterRename(oldTitle, r.title, id);
    renderView();
    await commitNotesEdit('Renaming…', `Renamed to “${r.title}”.`);
    renderView();
}

async function deleteNote(id) {
    const hit = findNotesNode(id);
    if (!hit || signedOutRefuses()) return;
    if (!confirm(`Delete note “${hit.node.title || 'Untitled'}”?`)) return;
    if (!(await copyEdit(() => TreeStore.removeNode(id)))) return;
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
    let made = null;
    if (!(await copyEdit(async () => { made = await TreeStore.createNode({ parentId: parent._pwaId, kind: 'folder', title: name.trim() }); }))) return null;
    const nb = { _pwaId: made.id, title: made.title, type: 'folder', children: [] };
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
    if (!(await copyEdit(() => TreeStore.updateNode(id, { title: name.trim() })))) return;
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
    if (!(await copyEdit(() => TreeStore.moveNode(id, { parentId: target._pwaId })))) return;
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
    // Re-parent only: the note's payload (and so its edited time) is untouched.
    if (!(await copyEdit(() => TreeStore.moveNode(id, { parentId: target._pwaId })))) return;
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
    // Its children into its place, in order, then the empty notebook goes:
    // NM.liftChildren as edits of the copy.
    const lifted = await copyEdit(async () => {
        const kids = (hit.node.children || []).map(c => c._pwaId);
        for (let i = 0; i < kids.length; i++) {
            await TreeStore.moveNode(kids[i], { parentId: hit.parent._pwaId, index: hit.index + i });
        }
        await TreeStore.removeNode(id);
    });
    if (!lifted) { renderView(); return; }
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

// --- Bookmark changes suggested by AI chats (Home) ---
//
// The server plans each one against its tree as it is now and sends a line
// per change (new folder, new bookmark, move, rename, DELETE) and whether it
// is out of date: something it names was renamed, moved or removed since, in
// which case it can only be rejected. Approving follows the note proposals'
// rule: the server applies it and this copy pulls, so a copy with unpushed
// edits (or a note open in the editor) pushes first. Built from DOM nodes:
// everything shown here was written by a chat.
function renderChangesBlock() {
    const block = document.createElement('div');
    block.className = 'proposals changes';
    const heading = document.createElement('div');
    heading.className = 'proposals-title';
    heading.textContent = `🤖 Suggested changes (${state.changes.length})`;
    block.appendChild(heading);
    const intro = document.createElement('div');
    intro.className = 'hint changes-intro';
    intro.textContent = 'From AI chats. Nothing changes until you approve it.';
    block.appendChild(intro);

    if (state.dirty) {
        const hint = document.createElement('div');
        hint.className = 'proposal proposals-push-hint';
        const text = document.createElement('div');
        text.className = 'proposal-text';
        const snippet = document.createElement('span');
        snippet.className = 'snippet';
        snippet.textContent = 'Push your changes first, then approve.';
        text.appendChild(snippet);
        const actions = document.createElement('div');
        actions.className = 'proposal-actions';
        const push = document.createElement('button');
        push.className = 'primary proposals-push';
        push.textContent = '⬆️ Push';
        push.addEventListener('click', () => pushNow());
        actions.appendChild(push);
        hint.append(text, actions);
        block.appendChild(hint);
    }

    for (const p of state.changes) block.appendChild(renderChangeItem(p));
    return block;
}

// What a suggestion shows the user. When it reads otherwise than what was
// drawn, the user has not seen what Approve would do now.
function changeShown(p) {
    return JSON.stringify([p.status || '', p.title || '', Boolean(p.danger), p.reviewKey || '',
        (p.preview || []).map(l => [l.op || '', l.text || '']), p.stale || []]);
}

function changeSourceLabel(p) {
    if (p.source === 'mcp') return p.tokenName ? `MCP · ${p.tokenName}` : 'MCP (token revoked)';
    return 'Share link';
}

function renderChangeItem(p) {
    const stale = p.status === 'stale';
    const item = document.createElement('div');
    item.className = 'change' + (stale ? ' stale' : '') + (p.danger ? ' danger' : '');
    item.dataset.id = String(p.id);

    const head = document.createElement('div');
    head.className = 'change-head';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = (p.danger ? '⚠️ ' : '') + (p.title || 'Suggested changes');
    const src = document.createElement('span');
    src.className = 'change-src';
    src.textContent = `${changeSourceLabel(p)}${p.createdAt ? ' · ' + NM.relativeTime(p.createdAt, Date.now()) : ''}`;
    head.append(title, src);
    item.appendChild(head);

    if (p.reason) {
        const reason = document.createElement('div');
        reason.className = 'change-reason';
        reason.textContent = `“${p.reason}”`;
        item.appendChild(reason);
    }

    const list = document.createElement('ul');
    list.className = 'change-preview';
    for (const line of p.preview || []) {
        const li = document.createElement('li');
        li.className = `op-${String(line.op || '').replace(/[^a-z_]/g, '')}` + (line.danger ? ' danger' : '');
        li.textContent = line.text;
        list.appendChild(li);
    }
    item.appendChild(list);

    if (stale) {
        const why = document.createElement('div');
        why.className = 'change-stale';
        why.textContent = 'Out of date — nothing of it can be applied: ' + (p.stale || []).join(' ');
        item.appendChild(why);
    }

    const actions = document.createElement('div');
    actions.className = 'proposal-actions';
    const approve = document.createElement('button');
    approve.className = 'primary proposal-approve' + (p.danger ? ' danger' : '');
    approve.textContent = p.danger ? 'Approve, deleting' : 'Approve';
    approve.disabled = stale;
    approve.addEventListener('click', () => resolveChange(p, true));
    const reject = document.createElement('button');
    reject.className = 'proposal-reject';
    reject.textContent = 'Reject';
    reject.addEventListener('click', () => resolveChange(p, false));
    approve.dataset.id = reject.dataset.id = String(p.id);
    actions.append(approve, reject);
    item.appendChild(actions);
    return item;
}

async function resolveChange(p, approve) {
    if (approve && p.status === 'stale') {
        showToast('This suggestion is out of date — reject it and ask the chat again.');
        return;
    }
    if (approve && (state.dirty || editorOpen())) {
        askToPushBeforeApproving();
        return;
    }
    const account = accountKey();
    if (approve) {
        // Asked again first: the tree may have changed since this was drawn
        // (a push from here or another device, a filed link), and what is
        // approved must be what the user was shown and asked about.
        await refreshProposals();
        if (accountKey() !== account) return;
        const now = state.changes.find(x => x.id === p.id);
        if (!now) {
            showToast('This suggestion is no longer waiting.');
            renderView();
            return;
        }
        if (changeShown(now) !== changeShown(p)) {
            renderView();
            showToast(now.status === 'stale'
                ? 'This suggestion is out of date now — reject it and ask the chat again.'
                : 'This suggestion changed since it was shown — look at it again, then approve.');
            return;
        }
        p = now;
    }
    if (approve && p.danger) {
        // Every deletion: the server never leaves a DELETE line out.
        const lines = (p.preview || []).filter(l => l.danger).map(l => '• ' + l.text).join('\n');
        if (!confirm(`This suggestion DELETES:\n\n${lines}\n\nA history version is kept on the server. Approve it?`)) return;
    }
    try {
        setStatus(approve ? 'Approving…' : 'Rejecting…');
        // The preview approved: the server refuses if it now reads otherwise.
        await api(`/api/proposals/${p.id}/${approve ? 'approve' : 'reject'}`, {
            method: 'POST', ...(approve && p.reviewKey ? { body: JSON.stringify({ reviewed: p.reviewKey }) } : {})
        });
        setStatus('');
        if (approve) {
            const done = 'Suggested changes applied';
            if (accountKey() !== account) {
                // Signed out or switched meanwhile: this copy is not the one it went into.
            } else if (state.dirty) {
                showToast(`${done} on the server — not pulled here, over the changes made meanwhile.`);
            } else if (editorOpen()) {
                showToast(`${done} on the server — not pulled here under your open note. ⬇️ Pull once it is saved or closed.`);
            } else {
                showToast(`${done}.`);
                await pullSnapshot();
            }
        } else {
            showToast('Suggestion rejected.');
        }
        await refreshProposals();
        renderView();
    } catch (e) {
        setStatus('');
        if (e.status === 409 && e.code === 'stale') {
            const why = (e.body && e.body.stale && e.body.stale[0]) || 'the bookmarks changed since.';
            showToast(`Out of date, nothing was applied: ${why}`);
            await refreshProposals();
            renderView();
            return;
        }
        if (e.status === 409 && e.code === 'changed') {
            showToast('This suggestion changed since it was shown, so nothing was applied — look at it again.');
            await refreshProposals();
            renderView();
            return;
        }
        alert('Action failed: ' + ((e.body && e.body.error) || e.message));
    }
}

// Review links for bookmark changes: /#changes=<percent-encoded JSON
// {"changes": [...], "reason": "..."}>, from chats that cannot POST to the
// share link. The fragment never reaches the server: the link is kept on the
// phone until someone is signed in, then — once they say yes — filed with
// the server as a suggestion like any other, checked there against their
// tree, and waits on Home for approval. Nothing is applied by the link.
const CHANGES_HASH = '#changes=';
const PENDING_CHANGES_KEY = 'tp_pending_changes';

function stashChangesHash() {
    if (!location.hash.startsWith(CHANGES_HASH)) return false;
    try {
        localStorage.setItem(PENDING_CHANGES_KEY, JSON.stringify({ hash: location.hash, at: new Date().toISOString() }));
    } catch (e) {
        showToast('This suggestion link could not be kept on the phone — it stays in the address bar for now.');
        return false;
    }
    history.replaceState(history.state, '', location.pathname);
    return true;
}

let offeringChanges = false;

async function offerPendingChanges() {
    if (offeringChanges || !configured()) return;
    let rec = null;
    try { rec = JSON.parse(localStorage.getItem(PENDING_CHANGES_KEY) || 'null'); } catch (e) { /* corrupt */ }
    if (!rec || typeof rec.hash !== 'string') return;
    const drop = () => { try { localStorage.removeItem(PENDING_CHANGES_KEY); } catch (e) { /* storage blocked */ } };
    let body = null;
    const raw = rec.hash.slice(CHANGES_HASH.length);
    try { body = JSON.parse(decodeURIComponent(raw)); } catch (e) {
        try { body = JSON.parse(raw); } catch (e2) { /* not JSON */ }
    }
    if (Array.isArray(body)) body = { changes: body };
    if (!body || typeof body !== 'object' || (!Array.isArray(body.changes) && !body.action)) {
        drop();
        showToast('This suggestion link could not be read.');
        return;
    }
    const n = Array.isArray(body.changes) ? body.changes.length : 1;
    const who = (state.identity && state.identity.username) || localStorage.getItem(LS.username) || 'this account';
    offeringChanges = true;
    try {
        if (!confirm(`An AI chat suggested ${n} change${n === 1 ? '' : 's'} to your bookmarks.\n\n`
            + `Add ${n === 1 ? 'it' : 'them'} to ${who}'s Suggested changes on Home? You review and approve there; nothing changes before that.`)) {
            drop();
            return;
        }
        await api('/api/proposals', { method: 'POST', body: JSON.stringify(body) });
        drop();
        showToast('Added to Suggested changes — review it on Home.');
        await refreshProposals();
        // To Home, unless a note is open: that stays where it is.
        if (state.view !== 'home' && !editorOpen()) goHome();
        else renderView();
    } catch (e) {
        if (e.status === 401) return; // kept for the next sign-in
        drop();
        const problems = (e.body && e.body.problems) || [];
        alert('The suggestion was not added: ' + ((e.body && e.body.error) || e.message)
            + (problems.length ? '\n\n' + problems.slice(0, 8).join('\n') : ''));
    } finally {
        offeringChanges = false;
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

    // Taken off the review block now: a second tap meanwhile imports nothing twice.
    state.importBatch = null;
    if (batch.kind === 'reorder') {
        await applyNoteOrder(found.node, batch.order);
        NV_UI.sort = 'manual';
        saveNotesPrefs();
    } else {
        for (const it of batch.items) {
            // Resolved against the tree as it grows, so two items naming the
            // same new notebook land in one notebook.
            const notesRoot = (findNotesFolderWithPath() || found).node._pwaId;
            const parentId = it.notebook ? (await ensureNotebookByName(it.notebook)) || notesRoot : notesRoot;
            const title = NM.leadingTitle(it.content) || 'Untitled';
            await copyEdit(() => TreeStore.createNode({ parentId, kind: 'note', title, payload: { content: it.content, createdAt: now, updatedAt: now } }));
        }
    }

    // In the copy now: an unpushed edit like any other if the push fails,
    // and the link stays on the phone until a push gets it to the server.
    await holdImportInCopy(batch.importId);
    try {
        setStatus('Saving…');
        const pushed = await pushAfterEdit();
        const done = batch.kind === 'reorder'
            ? 'New order applied (Manual order)'
            : `Imported ${batch.items.length} note${batch.items.length > 1 ? 's' : ''}.`;
        showToast(pushed ? done : `${done} ⬆️ Push when ready.`);
        setStatus('');
    } catch (e) {
        alert('Import failed: ' + e.message + '\nLocal changes preserved; use ⬆️ to retry.');
        setStatus('');
    }
    renderView();
}

// Sort note children in every folder under the notes root to match the given
// list of titles; unlisted notes keep their relative order at the end. As
// moves in the copy, made only where a place changes.
async function applyNoteOrder(notesRoot, order) {
    const idx = new Map(order.map((t, i) => [t, i]));
    const rank = (n) => (idx.has(n.title) ? idx.get(n.title) : Infinity);
    const moves = [];
    const sortFolder = (folder) => {
        const kids = folder.children || [];
        const sortedNotes = kids.filter(isNoteBookmark).slice().sort((a, b) => rank(a) - rank(b));
        let ni = 0;
        const wanted = kids.map(c => (isNoteBookmark(c) ? sortedNotes[ni++] : c));
        moves.push({ folderId: folder._pwaId, ids: wanted.map(c => c._pwaId) });
        for (const c of wanted) {
            if (c && (c.type === 'folder' || c.type === 'root')) sortFolder(c);
        }
    };
    sortFolder(notesRoot);
    for (const m of moves) {
        for (let i = 0; i < m.ids.length; i++) {
            const kids = (findRaw(m.folderId) || {}).children || [];
            if (kids[i] && kids[i].id === m.ids[i]) continue;
            await copyEdit(() => TreeStore.moveNode(m.ids[i], { parentId: m.folderId, index: i }));
        }
    }
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
    // A note being written is offered a save first, so the push carries it.
    if (editorDirty() && confirm('Save the note you are writing first, so this push carries it?\n\nOK = Save it, then push\nCancel = Push without it (it stays open, unsaved)')) {
        await saveNoteEdit();
        if (!state.dirty) return true; // saved and pushed already
    }
    try {
        setStatus('Pushing…');
        lastFold = null;
        await pushSnapshot();
        setStatus('');
        const n = lastFold ? lastFold.applied : 0;
        showToast(n ? `Pushed — included ${n} filed link${n === 1 ? '' : 's'} from another device.` : 'Pushed.');
        renderView();
        // Suggestions are planned against the server's tree, which this push
        // just changed: their lines may read otherwise now.
        refreshProposals();
        return true;
    } catch (err) {
        setStatus('Push failed: ' + err.message);
        showToast('Push failed: ' + err.message);
        return false;
    }
}

// What the last push folded in from links filed elsewhere, for its message.
let lastFold = null;

// Every push asks first whether this window still edits the copy. One that
// lost it without hearing so yet — held up in a dialog (a folder name, a
// confirm) while another window took the copy, which now edits from what was
// kept — sends nothing: its tree would land on the server over that window's
// work. The wait lets word of a lock taken meanwhile arrive; a claim another
// window made since says the same.
async function ensureStillEditing() {
    if (guard && guard.mode !== 'none') {
        const mine = !halted() && await claimStillMine();
        if (!mine && !halted()) lostCopy();
    }
    if (halted()) {
        const e = new Error('TabPaladin is open in another tab, which edits the copy now — nothing was pushed from this one.');
        e.halted = true;
        throw e;
    }
    if (!state.snapshot) throw new Error('No snapshot loaded to push.');
}

// Push the working copy: TreeStore.sync.pushFolding, for the copy as it is
// now or the one the user was asked about (`expect`). A 409 that is only
// links filed from a share sheet folds them in and goes again without asking;
// any other 409 asks: pull the server's tree (discarding this copy's unpushed
// edits), or force it after a second yes. A 412 — the copy is another
// account's — is never forced and never pulled over: it is set aside, and
// this account's tree pulled, after a yes.
async function pushSnapshot({ force = false, expect = null } = {}) {
    syncBusy++;
    try {
        return await pushOnce({ force, expect });
    } finally {
        syncBusy--;
        updateSyncUi();
    }
}

// Has the copy anything of its own to push? An empty one would erase the
// server's tree for every device.
function copyHasOwnRoots() {
    return TreeStore.roots().some(r => r && !r.virtual && !r.readOnly);
}

async function pushOnce({ force, expect }) {
    await ensureStillEditing();
    const used = state.config.token;
    let copy = expect || await TreeStore.currentCopy();
    // Pushing an empty tree erases everything server-side for every device —
    // never do that without a very explicit yes.
    if (!copyHasOwnRoots() && (copy.baseVersion || 0) > 0) {
        if (!confirm('This would push an EMPTY tree and erase all bookmarks on the server. Really continue?')) {
            throw new Error('Push cancelled — tree is empty.');
        }
        // The dialog held this window up: another may have taken the copy,
        // or brought another in.
        await ensureStillEditing();
        const now = await TreeStore.currentCopy();
        if (!TreeStore.sameCopy(now, copy)) throw new Error('The working copy changed while you decided — nothing was pushed. Push again.');
        copy = now;
    }
    // What goes up with this push: the import links in the copy as it is
    // now, and the ids it has. Anything added while the push is on its way
    // goes up with the next one.
    const carried = (copyMetaNow().importIds || []).slice();
    const idsAtStart = idsOfRoots(TreeStore.roots());
    let pushed;
    try {
        pushed = force
            ? { ...(await TreeStore.sync.push(syncConfig(), { force: true, expect: copy })), folded: 0, relocated: 0 }
            : await TreeStore.sync.pushFolding(syncConfig(), { expect: copy });
    } catch (e) {
        if (sessionRefused(e, used)) throw Object.assign(new Error('Signed out'), { status: 401 });
        if (e.code === 'account-changed') throw e;
        if (e.status === 412) return answerWrongAccount(e);
        if (e.status === 409 && !force) return answerConflict(e);
        throw e;
    }
    if (pushed.folded || pushed.relocated) {
        lastFold = {
            applied: (lastFold ? lastFold.applied : 0) + (pushed.folded || 0),
            relocated: (lastFold ? lastFold.relocated : 0) + (pushed.relocated || 0)
        };
    }
    // On the server now: the links those imports came from are done, even
    // when the copy here is another one by now (a pull, a sign-out, another
    // account signing in — in this window or another).
    if (carried.length) dropPendingImports(carried);
    if (pushed.left) {
        showToast(pushed.message);
        noteSync('push');
        return pushed;
    }
    const st = copyStatus();
    await TreeStore.updateMeta((m) => ({
        ...m,
        importIds: (m.importIds || []).filter(id => !carried.includes(id)),
        // Everything in the copy, when nothing was edited during the push;
        // otherwise what was in it when the push went, and what it had.
        serverIds: st.dirty ? [...new Set([...(m.serverIds || []), ...idsAtStart])] : idsOfRoots(TreeStore.roots())
    }));
    noteSync('push');
    return pushed;
}

// A 409 that is not only filed links: another device pushed since this
// copy's last pull. Both answers are about the copy that was refused
// (err.copy), as it was then.
async function answerConflict(err) {
    const n = Math.max(1, copyStatus().editCount || 0);
    const here = deviceWord();
    if (confirm(`Another device pushed changes since this ${here} last pulled.\n\n`
        + `OK = Pull the server's tree now (this ${here}'s ${n} unpushed edit${n === 1 ? ' is' : 's are'} discarded)\n`
        + 'Cancel = Do nothing, so you can look first.\n\n'
        + `To overwrite the server with this ${here}'s version instead, choose Cancel and say yes to the next question.`)) {
        await pullSnapshot({ expect: err.copy || null });
        const e = new Error('Not pushed — the server’s tree was pulled instead.');
        e.pulledInstead = true;
        throw e;
    }
    if (confirm(`Force-push this ${here}'s version and overwrite the server's newer one? That discards what the other device pushed.`)) {
        await ensureStillEditing();
        return pushOnce({ force: true, expect: err.copy || null });
    }
    throw new Error('Push cancelled — pull first.');
}

// A 412: this working copy belongs to another account. Pulling over it
// would discard that account's edits and forcing would write them into this
// one, so the only offer is to set it aside (kept on this device, Settings ›
// Storage) and pull this account's tree — only the copy the server refused.
async function answerWrongAccount(err) {
    if (!confirm('This working copy belongs to another account.\n\n'
        + `OK = Set it aside and pull this account's tree. The copy stays on this ${deviceWord()} (Settings › Storage).\n`
        + 'Cancel = Do nothing.')) {
        throw new Error('Push cancelled — this working copy belongs to another account.');
    }
    const me = await accountFromServer();
    if (!me) throw new Error('Couldn’t confirm the account — try again. Nothing was changed.');
    parkOpenDraft(copyStatus());
    let reset;
    try {
        reset = await asLocalSwitch(() => TreeStore.setAsideAndReset({ ...me, expect: err.copy || null }));
    } catch (e) {
        if (e.code === 'account-changed') throw new Error('Account changed meanwhile — nothing was set aside or pulled.');
        throw e;
    }
    resetAccountUi();
    try {
        await pullSnapshot({ expect: reset.copy });
    } catch (e) {
        throw new Error(`The other account’s copy is set aside on this ${deviceWord()}, but the pull did not happen: ${e.message}`);
    }
    const e = new Error(`Not pushed — that copy was another account’s. It is set aside on this ${deviceWord()}, and this account’s tree is pulled.`);
    e.setAside = true;
    throw e;
}

// --- Links filed from a share sheet, folded into the copy ----------------------
//
// Filing is an append on the server, not a push of this copy, so the copy
// learns of it one of two ways: from the filing's own answer (applyFiled,
// when this app filed it), or from the server's ops log when a push meets a
// 409 (TreeStore.sync.pushFolding). Either way only nodes that are not here
// yet are added, so the two never double up — and only into the copy of the
// account it was filed as (TreeStore.sync.foldFiling).

// A filing this app made (or the worker made and told it of): its new
// folders and bookmarks go into the copy, and when the copy was based on the
// version the filing started from, it is based on the filing's version now —
// with its own unpushed edits, if any, still on top.
function applyFiled(res) {
    return foldFiled(res, 'append', (res && res.created) || []);
}

function applyUnfiled(res) {
    return foldFiled(res, 'unappend', (res && res.removed) || []);
}

async function foldFiled(res, kind, list) {
    const owner = shareAccount();
    if (!res || !owner || !copyIsMine()) return;
    try {
        const r = await TreeStore.sync.foldFiling({
            kind, nodes: list, items: list, userId: res.userId, serverId: res.serverId,
            baseVersion: res.baseVersion, version: res.version
        }, { owner });
        if (!r) return;
        await TreeStore.updateMeta((m) => {
            const ids = new Set(m.serverIds || []);
            for (const n of list) {
                if (!n || !n.id) continue;
                if (kind === 'append') ids.add(String(n.id));
                else ids.delete(String(n.id));
            }
            return { ...m, serverIds: [...ids] };
        });
    } catch (e) {
        console.warn('[TabPaladin] Could not fold a filing into the copy', e);
    }
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

// --- The working copy, kept on this device ---------------------------------------
//
// TreeStore keeps it (IndexedDB, through platform.js) a moment after every
// edit and at once when the app goes to the background or away, from every
// window, under its lock. This file adds to each write what the last release
// reads after a step back (DC.decorateCoreRecord), and writes the same copy
// into tp-data in the last release's shape, as that release did, for one
// more release. The note being written is kept beside it as it is typed
// (tpLiveDraft: one entry per window, as the extension keeps them), and a
// note whose copy goes (a sign-out, another account signing in, another
// window bringing another copy in) is parked on the device under that copy's
// stamp, to come back with it (tp_notes_parked_v1).
//
// The first start of this release turns what the last one kept into
// TreeStore's record (startCopy): nothing is dropped on the way.
const DATA_CACHE = 'tp-data';
const TREE_KEY = '/__tp_tree';
const PREFS_KEY = '/__tp_prefs';
const STATS_KEY = '/__tp_stats';
// How long after the last key the note being written is kept.
const LIVE_DRAFT_MS = 500;
// How long a hand-over to another window waits for a pull or push on its way.
const SYNC_WAIT_MS = 8000;
// The savedAt of the record last mirrored into tp-data (DC.chooseKept), this
// window's claim on the copy where IndexedDB cannot hold it, and the mark a
// clear leaves when one of the two places refused it (DC.chooseKept's
// clearedAt) — the last release's, read and honoured here.
const TP_DATA_AT_KEY = 'tp_copy_tpdata_at';
const CLAIM_LS_KEY = 'tp_copy_claim';
const CLEARED_AT_KEY = 'tp_copy_cleared_at';
const LIVE_DRAFT_LOCK = 'tp-live-drafts';
const PAGE_LOCK_PREFIX = 'tp-notes-page:';

const windowId = DC.newId();
// Which window edits the copy where Web Locks are missing (startApp); null
// where every window edits (TreeStore's lock keeps them in turn).
let guard = null;
// Where the last write kept the copy ('indexeddb', 'cache', 'memory', or
// 'aside': IndexedDB full, Cache Storage instead), and why the last one that
// should have kept it did not.
let keptIn = null;
let copyWriteError = null;
let draftTimer = null;
// The latest savedAt this window has stamped or seen kept (ms): every record
// it writes is stamped after it, so one written after a clear is never taken
// for what the clear removed, even with the clock set back.
let copyMark = Date.now();
// When the copy this window started from was written, and the folder it
// showed.
let keptAt = null;
let keptPath = [];

function stampSavedAt() {
    copyMark = Math.max(Date.now(), copyMark + 1);
    return new Date(copyMark).toISOString();
}

function noteKeptTime(iso) {
    const t = iso ? Date.parse(iso) : NaN;
    if (Number.isFinite(t)) copyMark = Math.max(copyMark, t);
}

function keptTime(iso) {
    const d = new Date(iso || NaN);
    return Number.isNaN(d.getTime()) ? 'earlier' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// TreeStore stamps the copy with each pull and push itself.
function noteSync() {}

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

async function writeData(key, value) {
    try {
        const c = await dataCache();
        if (!c) return false;
        if (value === null) await c.delete(key);
        else await c.put(key, new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } }));
        return true;
    } catch (e) {
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

// Another window edits the copy now (no Web Locks here): this one writes
// nothing.
function halted() {
    return Boolean(guard) && !guard.isPrimary();
}

// --- What every write of the copy carries, and what it did -------------------------

platform.setDecorator((key, value) => (key === DC.TREE_KEY
    ? DC.decorateCoreRecord(value, { savedAt: stampSavedAt(), pathIds: (state.pathIds || []).slice(1), keptDraft: stepBackDraft(value) })
    : value));

// The note parked with this copy that the last release would put back into
// its editor after a step back (it reads no parked list, only the record's
// keptDraft): the newest one parked for the copy's account.
function stepBackDraft(rec) {
    if (!rec || !rec.owner) return null;
    try {
        const stamps = DC.stampsOfStatus(rec);
        const mine = parkedList().filter(d => DC.draftAnswersTo(d, stamps) && d.owner);
        if (!mine.length) return null;
        const newest = mine.reduce((a, b) => (String(b.parkedAt || '') > String(a.parkedAt || '') ? b : a));
        return DC.nvOfParked(newest);
    } catch (e) {
        return null;
    }
}
platform.onWrite(({ entries, error, backend, aside }) => {
    if (!(DC.TREE_KEY in entries)) return;
    noteCopyWrite({ error, backend, aside });
    if (!error) mirrorToTpData(entries[DC.TREE_KEY], { aside });
});
// A write met another window's later claim (no Web Locks): this one stops.
platform.onFenced(() => lostCopy());

// The same copy into tp-data, in the last release's shape, with the note being
// written. A copy that holds nothing of anyone's (what a clean sign-out
// leaves) is no copy there, as the last release kept it.
let mirrorChain = Promise.resolve();
function mirrorToTpData(rec, { aside = false } = {}) {
    const v1 = rec ? DC.toV1Record(rec, { nv: editorOpen() ? state.nv : null }) : null;
    mirrorChain = mirrorChain.then(async () => {
        if (!(await writeData(TREE_KEY, v1))) return;
        try {
            if (v1) localStorage.setItem(TP_DATA_AT_KEY, v1.savedAt);
            else localStorage.removeItem(TP_DATA_AT_KEY);
            // Both places hold what was written last: a clear the last
            // release left half done is over.
            if (!aside) localStorage.removeItem(CLEARED_AT_KEY);
        } catch (e) { /* only the step-back check misses it */ }
    });
    return mirrorChain;
}

// Going to the background: the copy as stored, with the note being written,
// into tp-data too (TreeStore writes its own edits on hide).
async function mirrorOnHide() {
    if (halted()) return;
    try {
        const rec = (await platform.getRaw([DC.TREE_KEY]))[DC.TREE_KEY];
        if (rec && rec.pwa) await mirrorToTpData(rec, { aside: keptIn === 'aside' });
    } catch (e) { /* the next write has it */ }
}

// What the last write did, for Settings, and a word when the device could
// not keep what it should have: the edits then live only in this window
// (TreeStore writes them with the next write that can).
function noteCopyWrite({ error, backend, aside }) {
    keptIn = error ? null : aside ? 'aside' : backend;
    const before = copyWriteError;
    copyWriteError = error && error.name !== 'FencedError'
        ? { name: error.name || 'Error', message: error.message || String(error), quota: DC.isQuotaError(error) }
        : null;
    if (copyWriteError && !before) {
        showToast(copyWriteError.quota
            ? `This ${deviceWord()} is out of storage: changes are kept only while the app stays open. ⬆️ Push them now.`
            : `Could not keep changes on this ${deviceWord()} (${copyWriteError.message}). ⬆️ Push them now.`);
    }
    if (settingsOpen()) refreshStorageUi();
}

// --- This window's claim (no Web Locks), and the last release's windows -----------

// When this window claimed the copy: writes stop once another has since.
let claimedAt = 0;

// What every write checks where one window edits at a time, or null where
// every window edits.
function fenceId() {
    const id = guard ? guard.fence() : null;
    return id ? { id, at: claimedAt } : null;
}
platform.setFence(fenceId);

function claimedElsewhere(fence) {
    try {
        return DC.claimedSince(JSON.parse(localStorage.getItem(CLAIM_LS_KEY) || 'null'), fence);
    } catch (e) {
        return false;
    }
}

// This window edits the copy from now on: its claim goes where every write
// checks it — this release's single-window mode, and the last release's
// windows, which stop at their next write once a later claim stands. A claim
// another window made since stands (two windows that started together
// without Web Locks): this one stops at once, before it holds anything.
async function claimCopy() {
    claimedAt = Date.now();
    const fence = { id: windowId, at: claimedAt };
    try { localStorage.setItem(CLAIM_LS_KEY, JSON.stringify(fence)); } catch (e) { /* IndexedDB holds it */ }
    let res = null;
    try { res = await platform.claim(fence); } catch (e) { /* nowhere to keep it: localStorage holds it */ }
    if (guard && guard.fence() && res && res.claimed === false) {
        try { localStorage.setItem(CLAIM_LS_KEY, JSON.stringify(res.holder)); } catch (e) { /* IndexedDB holds it */ }
        lostCopy();
    }
}

function lostCopy() {
    if (guard) guard.lost('fenced');
}

// Work in this window that the device could not keep: the last write failed
// (a full disk). Only this window has it, so it never lets go of it unasked,
// and losing the copy does not drop it (enterSecondary).
function unkeptWork() {
    if (!copyWriteError) return false;
    return Boolean(state.snapshot && state.dirty) || editorDirty();
}

// Going where it cannot answer — the back-forward cache, frozen in the
// background — a window without Web Locks lets go of the copy, written down
// just before. It keeps what it holds in memory: back, it edits on in place
// when nobody claimed the copy meanwhile (resumeIfFree). It keeps the copy
// instead when what it holds could not be written down (or a sign-out is on
// its way). With Web Locks there is nothing to let go of: every window edits.
let awayFromCopy = false;

function letGoWhileAway() {
    if (!guard || !guard.isPrimary() || guard.mode === 'none') return;
    if (accountChanging || copyWriteError || unkeptWork()) return;
    awayFromCopy = true;
    guard.lost('away');
}

// Has no other window claimed the copy since this one did?
async function claimStillMine() {
    const fence = fenceId();
    if (!fence) return true;
    try {
        const held = (await platform.getRaw([DC.CLAIM_KEY]))[DC.CLAIM_KEY];
        return !DC.claimedSince(held, fence) && !claimedElsewhere(fence);
    } catch (e) {
        return !claimedElsewhere(fence);
    }
}

// --- The first start: what the last release kept ---------------------------------
//
// Under the copy's lock, so two windows starting at once do this once: the
// copy the last release kept (IndexedDB's, or tp-data's when that is later —
// a step back that wrote there), as TreeStore's record; the note open in it
// and one a sign-out set aside, parked for their copy; the drafts kept with
// set-aside copies, parked for theirs. Then TreeStore reads it.
function withCopyLockAtStart(fn) {
    const locks = typeof navigator !== 'undefined' && navigator && navigator.locks && typeof navigator.locks.request === 'function'
        ? navigator.locks : null;
    return locks ? locks.request('tp-working-copy', () => fn()) : fn();
}

function storedIdentityWithUrl() {
    return { ...storedIdentity(), url: (state.config.url || '').replace(/\/+$/, '') };
}

async function migrateKept() {
    let got = {};
    try {
        got = await platform.getRaw([DC.TREE_KEY, DC.DRAFT_KEY, DC.STASH_INDEX_KEY]);
    } catch (e) {
        return;
    }
    const tp = await readData(TREE_KEY);
    let tpWrittenAt = null;
    let clearedAt = null;
    try {
        tpWrittenAt = localStorage.getItem(TP_DATA_AT_KEY);
        clearedAt = localStorage.getItem(CLEARED_AT_KEY);
    } catch (e) { /* unknown */ }
    // From here, this window stamps what it writes later than anything kept,
    // and than a clear left unfinished.
    noteKeptTime(clearedAt);
    noteKeptTime(got[DC.TREE_KEY] && got[DC.TREE_KEY].savedAt);
    noteKeptTime(tp && tp.savedAt);
    keptAt = (got[DC.TREE_KEY] && got[DC.TREE_KEY].savedAt) || null;
    keptPath = got[DC.TREE_KEY] && Array.isArray(got[DC.TREE_KEY].pathIds) ? got[DC.TREE_KEY].pathIds.map(String) : [];
    const index = Array.isArray(got[DC.STASH_INDEX_KEY]) ? got[DC.STASH_INDEX_KEY] : [];
    const plan = DC.planMigration({
        kvRaw: got[DC.TREE_KEY] || null, drafts: got[DC.DRAFT_KEY] || null, tp, tpWrittenAt, clearedAt,
        stashIndex: index, identity: storedIdentityWithUrl()
    });
    if (plan.action === 'convert') {
        // The note a sign-out set aside, parked for the copy's account first,
        // so the record written next carries it for a step back as well.
        if (plan.keptDraft && plan.keptDraft.editing) parkDrafts([DC.draftFromNv(plan.keptDraft, stampOfRecord(plan.record), plan.record.savedAt || undefined)]);
        // Written as every write of it is (a step back reads it the same),
        // keeping when it was kept.
        const record = DC.decorateCoreRecord(plan.record, { savedAt: plan.record.savedAt || undefined, pathIds: plan.record.pathIds,
            keptDraft: stepBackDraft(plan.record) });
        const entries = { [DC.TREE_KEY]: record };
        // The note open when tp-data was written (IndexedDB's is in the
        // live drafts already): one more live draft, of a page that is gone.
        if (plan.nv && plan.nv.editing) {
            entries[DC.DRAFT_KEY] = { ...(got[DC.DRAFT_KEY] || {}), ...DC.liveDraftsFor(plan.nv, plan.account || {}, 'kept-' + DC.newId(), record.savedAt) };
        }
        await platform.putRaw(entries);
        keptAt = record.savedAt || keptAt;
        // And into tp-data, for the release before the last one.
        await mirrorToTpData(record);
    } else if (plan.action === 'drop') {
        // Cleared by the last release after a step back: not offered again,
        // but one with work in it is set aside rather than lost.
        const entries = { [DC.TREE_KEY]: null, [DC.DRAFT_KEY]: null };
        if (plan.stash) {
            entries[plan.stash.key] = plan.stash.value;
            entries[DC.STASH_INDEX_KEY] = [...index, plan.stash.key];
        }
        await platform.putRaw(entries);
        try { localStorage.removeItem(TP_DATA_AT_KEY); } catch (e) { /* the same next start */ }
        keptAt = null;
    } else if (plan.action === 'clear') {
        await platform.putRaw({ [DC.TREE_KEY]: null });
        keptAt = null;
    }
    // The last release's set-aside copies: their parts into their meta, their
    // notes parked with them.
    const keys = plan.action === 'drop' && plan.stash ? [...index, plan.stash.key] : index;
    if (keys.length) {
        const stashes = await platform.getRaw(keys);
        for (const key of keys) {
            const m = DC.migrateStash(stashes[key]);
            if (!m) continue;
            if (m.drafts.length) parkDrafts(m.drafts);
            await platform.putRaw({ [key]: m.value });
        }
    }
}

function stampOfRecord(rec) {
    return rec && rec.owner ? { owner: rec.owner, origin: null } : { owner: null, origin: (rec && rec.origin) || 'pre-accounts' };
}

// The copy as this window starts on it. Returns {dirty, at} when there is one
// to show (with work in it, or not), else null.
async function startCopy() {
    try {
        await withCopyLockAtStart(migrateKept);
    } catch (e) {
        // Not taken over: what the last release kept stays where it is, and
        // the next start tries again.
        console.warn('[TabPaladin] Could not take over the copy the last release kept', e);
    }
    try { await TreeStore.load(); } catch (e) { console.warn('[TabPaladin] Could not read the working copy', e); }
    const st = copyStatus();
    lastCopyId = st.copyId;
    lastStamp = stampOfStatus(st);
    viewStamp++;
    // The folder it was showing, when it is still there.
    const path = [ROOT_ID, ...keptPath];
    state.pathIds = state.snapshot && findNodeByPath(path) ? path : [ROOT_ID];
    holdPageLock();
    await recoverLiveDrafts();
    renderView();
    if (!copyPresent()) return null;
    return { dirty: Boolean(copyStatus().dirty || editorOpen() || parkedFor(copyStatus()).length), at: keptTime(keptAt) };
}

// --- The note being written --------------------------------------------------------
//
// Kept as it is typed (half a second after the last key), when the app goes to
// the background or away, and let go once what it was saved into is written:
// one entry per window ({[windowId]: draft}, the extension's shape, with this
// app's editor state beside it), each window holding a lock named after it for
// as long as it lives. An entry whose lock nobody holds is a window that is
// gone (closed, or killed): the next start takes it — back into its editor
// when it is this copy's and someone is signed in to it, else parked.

function webLocks() {
    return typeof navigator !== 'undefined' && navigator && navigator.locks && typeof navigator.locks.request === 'function'
        ? navigator.locks : null;
}

function holdPageLock() {
    const locks = webLocks();
    if (!locks) return;
    try {
        locks.request(PAGE_LOCK_PREFIX + windowId, () => new Promise(() => {})).catch(() => {});
    } catch (e) { /* no lock: other windows take this one's entry as gone */ }
}

// The windows alive now, by id, or null when this browser cannot say.
async function livePages() {
    const locks = webLocks();
    if (!locks || typeof locks.query !== 'function') return null;
    try {
        const snap = await locks.query();
        return new Set([...(snap.held || []), ...(snap.pending || [])]
            .map(l => String(l.name || ''))
            .filter(n => n.startsWith(PAGE_LOCK_PREFIX))
            .map(n => n.slice(PAGE_LOCK_PREFIX.length)));
    } catch (e) {
        return null;
    }
}

let liveChain = Promise.resolve();
// What this window last wrote as its live draft, or null while it has none.
let liveWritten = null;

// Read, change and write the live-draft map, one window at a time. `fn`
// returns false to write nothing.
function updateLiveDrafts(fn) {
    const run = async () => {
        const data = await platform.storage.local.get(DC.DRAFT_KEY);
        const stored = data && data[DC.DRAFT_KEY];
        const map = stored && typeof stored === 'object' && !Array.isArray(stored) ? { ...stored } : {};
        if ((await fn(map)) === false) return;
        if (Object.keys(map).length) await platform.storage.local.set({ [DC.DRAFT_KEY]: map });
        else await platform.storage.local.remove(DC.DRAFT_KEY);
    };
    const locks = webLocks();
    const p = liveChain.then(() => (locks ? locks.request(LIVE_DRAFT_LOCK, run) : run()));
    liveChain = p.catch(() => {});
    return p;
}

// After a key in the note editor: its text is written once typing pauses.
function scheduleLiveDraft() {
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
        draftTimer = null;
        saveLiveDraft();
    }, LIVE_DRAFT_MS);
}

function clearCopyTimers() {
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = null;
}

// The account a draft is kept under: the copy's.
function draftAccount() {
    const owner = copyStatus().owner;
    return owner ? { ...owner } : {};
}

// Write this window's live draft now: the editor's text while a note is open,
// nothing once it is not — after what it was saved into is written.
function saveLiveDraft() {
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = null;
    if (halted() || accountChanging) return liveChain;
    const drafts = editorOpen() && copyPresent() ? DC.liveDraftsFor(state.nv, draftAccount(), windowId) : null;
    const draft = drafts ? drafts[windowId] : null;
    const json = draft ? JSON.stringify({ ...draft, at: null }) : null;
    if (json === liveWritten) return liveChain;
    liveWritten = json;
    return updateLiveDrafts(async (map) => {
        if (draft) {
            map[windowId] = draft;
            return true;
        }
        if (!(windowId in map)) return false;
        // What the editor saved is in storage before its draft lets go.
        if (!(await TreeStore.flush())) throw new Error('The working copy is not written yet');
        delete map[windowId];
        return true;
    }).catch(() => {
        liveWritten = undefined; // written again next time
    });
}

// The live drafts of windows that are gone (closed, killed, or the last
// release's): back into this editor when one is this copy's and someone is
// signed in to it (the newest), else parked for their copy.
async function recoverLiveDrafts() {
    const alive = await livePages();
    const taken = [];
    try {
        await updateLiveDrafts((map) => {
            for (const [id, d] of Object.entries(map)) {
                if (id === windowId || (alive && alive.has(id))) continue;
                delete map[id];
                if (d && typeof d.content === 'string') taken.push(d);
            }
            return taken.length > 0;
        });
    } catch (e) {
        return;
    }
    taken.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    const st = copyStatus();
    const stamps = DC.stampsOfStatus(st);
    const park = [];
    for (const d of taken) {
        const nv = DC.nvOfParked(d);
        if (!nv) continue;
        const owner = d.owner && d.owner.userId !== null && d.owner.userId !== undefined && d.owner.url ? d.owner : null;
        const stamp = { owner, origin: owner ? null : d.origin || 'pre-accounts' };
        if (!editorOpen() && configured() && copyPresent() && copyIsMine() && DC.draftAnswersTo(stamp, stamps)) {
            openDraftInEditor(nv);
        } else {
            park.push(DC.draftFromNv(nv, stamp, d.at || undefined));
        }
    }
    if (park.length) parkDrafts(park);
}

function openDraftInEditor(nv) {
    state.view = 'notes';
    state.nv = { ...freshNv(), ...nv, editing: true };
    navDepth++;
    history.pushState(nvHistoryState(), '', location.pathname);
    // This window's own live draft from now on.
    liveWritten = undefined;
    saveLiveDraft();
}

// --- Parked notes -------------------------------------------------------------------

function parkedList() {
    return DC.readParked(localStorage);
}

function parkDrafts(drafts) {
    const list = parkedList();
    for (const d of drafts) {
        if (d && !list.some(x => DC.sameDraft(x, d))) list.push(d);
    }
    if (!DC.writeParked(localStorage, list)) {
        showToast(`An unsaved note could not be kept on this ${deviceWord()} — it stays open here only.`);
        return false;
    }
    return true;
}

// The stamp a copy goes by (TreeStore.status()).
function stampOfStatus(st) {
    return { owner: st && st.owner ? { ...st.owner } : null, origin: st && !st.owner ? st.origin || null : null };
}
let lastStamp = null;

// The note open in the editor, parked under the copy it was written in, and
// the editor closed: its copy is going (a sign-out, another account signing
// in, a copy set aside). Its import link, if any, rides with it. True when
// one was parked.
function parkOpenDraft(st = copyStatus(), { onlyChanged = false } = {}) {
    if (!editorOpen()) return false;
    const nv = state.nv;
    const changed = editorDirty();
    if (onlyChanged && !changed) return false;
    let parked = false;
    if (changed || nv.importId) {
        parked = parkDrafts([DC.draftFromNv(nv, stampOfStatus(st))]);
    }
    if (parked) {
        // Its import link stays held by the parked note, not dropped.
        Object.assign(state.nv, { editing: false, isNew: false, draft: null, loaded: null, newParentId: null, pendingNotebookName: null, importId: null });
    } else {
        stopEditing();
    }
    liveWritten = undefined;
    saveLiveDraft();
    return parked;
}

// The parked notes this copy brings back: parked under it, or under a stamp
// it was set aside with.
function parkedFor(st) {
    const stamps = DC.stampsOfStatus(st);
    return parkedList().filter(d => DC.draftAnswersTo(d, stamps));
}

function parkedImportIds() {
    return parkedList().map(d => d.nv && d.nv.importId).filter(Boolean);
}

// A note parked with this copy back in its editor, unsaved, once the copy
// is ready and signed in to, and the editor free. One at a time.
function reopenParkedDraft() {
    if (editorOpen() || !configured() || !copyPresent() || !copyIsMine()) return false;
    const st = copyStatus();
    const list = parkedList();
    const stamps = DC.stampsOfStatus(st);
    const i = list.findIndex(d => DC.draftAnswersTo(d, stamps));
    if (i === -1) return false;
    const [d] = list.splice(i, 1);
    const nv = DC.nvOfParked(d);
    if (!nv) {
        DC.writeParked(localStorage, list);
        return false;
    }
    openDraftInEditor(nv);
    // Out of the list once it is the live draft: never both lost, at worst both kept.
    liveWritten = undefined;
    saveLiveDraft().then(() => DC.writeParked(localStorage, parkedList().filter(x => !DC.sameDraft(x, d))));
    renderView();
    return true;
}

// --- Whose copy -----------------------------------------------------------------------

// The account this page is signed in as, as the server said: null while it
// has not (a session from before ids, the server unreachable at start).
function signedInAccount() {
    const id = state.identity || {};
    if (!configured() || id.userId === null || id.userId === undefined) return null;
    return {
        url: (state.config.url || '').replace(/\/+$/, ''),
        userId: Number(id.userId),
        username: id.username || localStorage.getItem(LS.username) || null,
        serverId: id.serverId || null,
        tenancyOwner: Boolean(id.tenancyOwner)
    };
}

// The same, asked of the server now.
async function accountFromServer() {
    await refreshWhoAmI();
    return signedInAccount();
}

// The working copy is this account's: the same account's stays (its stamp
// brought up to date); one made here while nobody was signed in is claimed;
// one from before accounts is adopted by the server's owner; any other is set
// aside — never pulled over, never pushed into this account — with the note
// open in it parked, and this account's own set-aside copy comes back (or an
// empty one, to pull into). Null when the server has not said who this is:
// nothing is decided on a guess.
// Another copy brought in by this window (a switch, a pull or a refused push
// that set the copy aside, a clean sign-out): not another window's doing.
let switchingHere = 0;
async function asLocalSwitch(fn) {
    switchingHere++;
    try {
        return await fn();
    } finally {
        switchingHere--;
    }
}

async function ensureAccountCopy({ previousUsername = null } = {}) {
    const me = signedInAccount();
    if (!me) return null;
    const before = copyStatus();
    const leaving = TreeStore.wouldSetAside(me);
    let restoredAt = null;
    if (leaving) {
        try {
            const back = (await TreeStore.listStashes(me)).find(s => s.match === 'same');
            restoredAt = back ? back.setAsideAt : null;
        } catch (e) { /* only the status line misses it */ }
    }
    let r;
    try {
        r = await asLocalSwitch(async () => {
            if (leaving) {
                // Nothing drawn from the copy going (the note open in it, the
                // notebook or folder it showed, even a back label) is drawn
                // over the one coming in.
                parkOpenDraft(before);
                state.nv = freshNv();
                state.view = 'home';
                state.pathIds = [ROOT_ID];
                state.importBatch = null;
            }
            return TreeStore.switchAccount({ ...me, previousUsername: previousUsername || (before.owner && before.owner.username) || null });
        });
    } catch (e) {
        console.warn('[TabPaladin] Could not make the copy this account\'s', e);
        return null;
    }
    // An empty copy that belonged to nobody (what a clean sign-out leaves)
    // is claimed, not set aside: this account's own set-aside copy, if this
    // device keeps one, comes back in its place all the same.
    if (r.action === 'claimed' && copyStatus().isEmpty && !copyStatus().dirty) {
        try {
            const mine = (await TreeStore.listStashes(me)).filter(s => s.match === 'same');
            // Not one an earlier release cleared after a step back (pushed or
            // let go of on purpose since): kept only so nothing is lost, and
            // brought back only by hand.
            const raw = mine.length ? await platform.getRaw(mine.map(s => s.key)) : {};
            const back = mine.filter(s => raw[s.key] && !raw[s.key].why)
                .sort((a, b) => String(b.setAsideAt || '').localeCompare(String(a.setAsideAt || '')))[0];
            if (back) {
                await asLocalSwitch(() => TreeStore.restoreStash(back.key, me));
                r = { ...r, action: 'restored' };
                restoredAt = back.setAsideAt || null;
            }
        } catch (e) { /* it stays set aside, for Settings */ }
    }
    noteCopySwitched();
    if (r.setAside && before.dirty) {
        const who = (before.owner && before.owner.username) || previousUsername || 'another account';
        showToast(`This ${deviceWord()} keeps unpushed changes for ${who} — set aside until ${who} signs in.`);
    }
    if (r.action !== 'same' && r.action !== 'claimed' && r.action !== 'adopted') resetAccountUi();
    return { ...r, restoredAt: r.action === 'restored' ? restoredAt : null, before };
}

// The copy here is another one now (a switch here, or in another window):
// nothing drawn from the last one carries over.
function noteCopySwitched() {
    const st = copyStatus();
    lastCopyId = st.copyId;
    lastStamp = stampOfStatus(st);
}

// TreeStore heard a change (onChanged): an edit here or in another window, a
// pull, a push, another copy brought in.
let renderQueued = false;
function onCopyChanged(kind) {
    const st = copyStatus();
    const switched = kind === 'switch' && lastCopyId !== undefined && st.copyId !== lastCopyId;
    if (switched && !switchingHere) {
        // Another window brought another copy in: the note open here was
        // written in the last one, and waits with it.
        if (editorOpen()) parkOpenDraft({ ...st, owner: lastStamp && lastStamp.owner, origin: lastStamp && lastStamp.origin, restoredFrom: [] });
        state.nv = freshNv();
        state.view = 'home';
        state.pathIds = [ROOT_ID];
        state.importBatch = null;
        showToast('Another window switched to another account’s copy.');
        // A note parked with the copy that came in (back from being set
        // aside) is back in its editor, when this window is signed in to it.
        queueMicrotask(() => { if (configured() && copyIsMine()) reopenParkedDraft(); });
    }
    if (switched || kind === 'switch') noteCopySwitched();
    updateSyncUi();
    if (shareSheet) shareSheet.refresh();
    if (!booted || halted()) return;
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(() => {
        renderQueued = false;
        // Not under an open note: the editor would lose its place.
        if (!editorOpen()) renderView();
    });
}

// --- One window edits the copy, where Web Locks are missing -----------------------
//
// With Web Locks (every secure context) every window of the app edits the one
// copy: TreeStore's lock keeps them in turn, and each hears the others. The
// last release's windows edited one at a time under the lock 'tp-primary':
// this release's hold it together (shared), so none of the last release's
// starts editing beside them, and ask one that edits to write down what it
// holds and let go first (takeOverFromLastRelease).
//
// Without Web Locks (a plain-http address) two windows could each read the
// copy and write it over the other's, so one edits (durableCopy.js's guard
// over BroadcastChannel), and any other says the app is open elsewhere, with
// 'Use here'. A window that a share or an import link opened takes over at
// once: that is where the person is.

function arrivedWithWork() {
    try {
        return Boolean(new URLSearchParams(location.search).get('share')) || IMPORT_HASH_RE.test(location.hash);
    } catch (e) {
        return false;
    }
}

// The last release's windows talk on BroadcastChannel 'tp-primary' (the
// guard's protocol). This release's windows answer them: one here edits
// ('here'), and none lets go of the copy to one of them ('refused'): it would
// write its own memory over what this release's windows wrote. A message of
// this release's own (`v`) is not the last release's.
let lastReleaseChannel = null;
function answerLastRelease() {
    if (lastReleaseChannel || typeof BroadcastChannel !== 'function') return;
    try {
        lastReleaseChannel = new BroadcastChannel(DC.CHANNEL_NAME);
        lastReleaseChannel.onmessage = (e) => {
            const msg = e && e.data;
            if (!msg || typeof msg !== 'object' || msg.from === windowId || msg.v || (msg.to && msg.to !== windowId)) return;
            try {
                if (msg.t === 'probe') lastReleaseChannel.postMessage({ t: 'here', to: msg.from, from: windowId, v: DC.PWA_RECORD });
                if (msg.t === 'yield') lastReleaseChannel.postMessage({ t: 'refused', to: msg.from, reason: 'newer', from: windowId, v: DC.PWA_RECORD });
            } catch (x) { /* closed */ }
        };
    } catch (e) {
        lastReleaseChannel = null;
    }
}

// Hold 'tp-primary' with this release's other windows (shared), for the
// page's life: at once or not at all, or waiting up to `wait` ms.
function holdSharedPrimary(locks, { wait = 0 } = {}) {
    return new Promise((resolve) => {
        let settled = false;
        let timer = null;
        const done = (v) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            resolve(v);
        };
        const ac = wait && typeof AbortController === 'function' ? new AbortController() : null;
        const opts = wait ? { mode: 'shared', ...(ac ? { signal: ac.signal } : {}) } : { mode: 'shared', ifAvailable: true };
        if (wait) timer = setTimeout(() => { if (ac) { try { ac.abort(); } catch (e) { /* done */ } } done(false); }, wait);
        try {
            Promise.resolve(locks.request(DC.LOCK_NAME, opts, (lock) => {
                if (!lock || settled) {
                    done(false);
                    return undefined;
                }
                done(true);
                return new Promise(() => {});
            })).catch(() => done(false));
        } catch (e) {
            done(false);
        }
    });
}

// Ask the last release's window that edits, as its own windows do, to write
// down what it holds and let go: its answer ('yielded', 'refused' with why),
// or 'silent' — a window frozen in the background, which wrote everything
// down when it was hidden.
function askLastRelease() {
    return new Promise((resolve) => {
        let ch = null;
        try { ch = new BroadcastChannel(DC.CHANNEL_NAME); } catch (e) { resolve({ t: 'silent' }); return; }
        let timer = null;
        const finish = (msg) => {
            if (timer) clearTimeout(timer);
            try { ch.close(); } catch (e) { /* closed */ }
            resolve(msg);
        };
        const arm = (ms) => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => finish({ t: 'silent' }), ms);
        };
        ch.onmessage = (e) => {
            const msg = e && e.data;
            if (!msg || msg.to !== windowId) return;
            if (msg.t === 'busy') arm(SYNC_WAIT_MS * 2);
            else if (msg.t === 'yielded' || msg.t === 'refused') finish(msg);
        };
        arm(2000);
        try { ch.postMessage({ t: 'yield', from: windowId }); } catch (e) { finish({ t: 'silent' }); }
    });
}

// With Web Locks: edit beside this release's other windows, once no window
// of the last release does. True when this window may edit.
let lastReleaseHolds = null;
async function takeOverFromLastRelease(locks) {
    answerLastRelease();
    if (await holdSharedPrimary(locks)) return { ok: true };
    const answer = typeof BroadcastChannel === 'function' ? await askLastRelease() : { t: 'silent' };
    if (answer.t === 'refused') return { ok: false, reason: answer.reason || null };
    if (answer.t === 'silent') {
        // Taken from it, as its own windows do; it hears so when it wakes,
        // and its next write meets this window's claim.
        try { await locks.request(DC.LOCK_NAME, { steal: true }, () => {}); } catch (e) { /* taken meanwhile */ }
    }
    if (await holdSharedPrimary(locks, { wait: SYNC_WAIT_MS })) return { ok: true };
    return { ok: false, reason: 'busy' };
}

async function startApp() {
    const locks = webLocks();
    if (locks) {
        const took = await takeOverFromLastRelease(locks);
        if (!took.ok) {
            lastReleaseHolds = took.reason || 'busy';
            showLastReleaseCard(lastReleaseHolds);
            return;
        }
        lastReleaseHolds = null;
        await claimCopy();
        await bootstrap();
        return;
    }
    try {
        guard = DC.createPrimaryGuard({
            locks: null,
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
    // Another window's claim stood, or one asked for the copy meanwhile:
    // this one waits behind the card.
    if (halted()) return;
    await bootstrap();
}

// A window of the last release would not let go of the copy (it holds
// what it could not save), or did not let go in time.
function showLastReleaseCard(reason) {
    const box = guardOverlay();
    const title = $('primary-guard-title');
    const text = $('primary-guard-text');
    if (title) title.textContent = 'TabPaladin is open in a tab from before an update';
    if (text) {
        text.textContent = 'That tab edits the copy on this device the old way, so this one waits for it. '
            + 'Push what it holds there, then reload it — or close it — and try again here.';
    }
    setGuardNote(reason && reason !== 'busy' && reason !== 'newer' ? refusalNote(reason) : '');
    const btn = $('primary-take');
    if (btn) btn.disabled = false;
    show(box);
}

// Back in the foreground. Without Web Locks, a window that edited while
// this one was frozen answers, and this one stops (guard.recheck). None
// answering, this one goes on editing — unless one claimed the copy
// meanwhile and has gone since: what this window holds is then from before
// that one's work, and it starts again from what is kept, as a window
// coming back to a lock taken meanwhile does (resumeHere).
async function recheckCopy() {
    if (!guard) return;
    try { await guard.recheck(); } catch (e) { return; }
    if (guard.mode !== 'channel' || !guard.isPrimary() || moving || restarting) return;
    if (await claimStillMine()) return;
    if (!guard.isPrimary() || moving || restarting) return;
    moving = true;
    try {
        await resumeHere();
    } catch (e) {
        /* stays as it is */
    } finally {
        moving = false;
    }
}

// Another window asks for the copy: what is on its way lands first, then
// everything is written down. Refused — the copy stays here — when what this
// window holds could not be written: handing it over would lose it.
async function yieldCopy() {
    const until = Date.now() + SYNC_WAIT_MS;
    while ((syncBusy > 0 || accountChanging) && Date.now() < until) {
        await new Promise(r => setTimeout(r, 100));
    }
    // A sign-out still on its way writes what it keeps when it lands.
    if (accountChanging) return { ok: false, reason: 'busy' };
    let written = false;
    try { written = await TreeStore.flush(); } catch (e) { written = false; }
    await saveLiveDraft();
    if (!written) return { ok: false, reason: 'storage' };
    return true;
}

// This window no longer edits the copy: it stops writing, lets go of what it
// showed (written down, and the other window's now), and says where the app
// is. A start on its way goes no further (bootGen). Work the device could not
// keep (unkeptWork) is not let go of — it is nowhere else: it stays behind
// the card, closing the tab asks first, and Use here brings the copy back to
// it (carryOnHere) to push it.
function enterSecondary(reason) {
    clearCopyTimers();
    bootGen++;
    const holding = booted && unkeptWork();
    if (booted && !holding) {
        state.nv = freshNv();
        state.view = 'home';
        state.importBatch = null;
        for (const id of ['settings-sheet', 'inbox-sheet', 'user-sheet', 'move-sheet', 'nb-sheet', 'import-sheet']) hide($(id));
    }
    showGuard(reason);
    if (holding) setGuardNote(unkeptNote());
}

function unkeptNote() {
    return `This tab still has unpushed changes this ${deviceWord()} could not keep — the other tab does not have them. `
        + 'Use here to bring the copy back to this tab, and ⬆️ Push them first.';
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
            : 'On this address one tab or window edits the copy at a time, so two never write over each other '
                + '(open the app over https to use several at once). Use it there, or move it here: the other tab saves what it holds first.';
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
    if (reason === 'busy') return 'The other tab is signing out. Try again in a moment.';
    if (reason === 'foreign') {
        return 'The other tab has unpushed changes it cannot keep on this device while another account\'s are kept here. ⬆️ Push them there first, then try again.';
    }
    return 'The other tab could not save what it holds (is this device out of storage?). ⬆️ Push or finish there first, then try again.';
}

// 'Use here': the copy moves to this window.
async function useHere() {
    if (lastReleaseHolds) {
        // The last release's tab: asked again.
        if (moving) return;
        moving = true;
        const btn = $('primary-take');
        if (btn) btn.disabled = true;
        setGuardNote('Asking the other tab to save what it holds…');
        try {
            const took = await takeOverFromLastRelease(webLocks());
            if (!took.ok) {
                if (btn) btn.disabled = false;
                setGuardNote(took.reason && took.reason !== 'busy' && took.reason !== 'newer' ? refusalNote(took.reason) : 'It could not be moved here. Try again.');
                return;
            }
            lastReleaseHolds = null;
            hide($('primary-guard'));
            await claimCopy();
            await bootstrap();
        } finally {
            moving = false;
        }
        return;
    }
    if (!guard || guard.isPrimary() || moving) return;
    moving = true;
    linkDuringMove = false;
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
        // A link that arrived meanwhile: the move took it along (a start
        // again, or carrying on here, opens it), or, the move failed, it
        // stays in the address bar for the next one.
        linkDuringMove = false;
    }
}

// An import link tapped while a move was on its way (resumeIfFree), which
// useHere let be: taken up once the move is done.
let linkDuringMove = false;

// Back to a window that does not edit, without asking anyone: behind the
// card, once the window that edited is gone (closed after filing a share,
// say), it edits again; back from being away, it edits on in place when no
// other window claimed the copy meanwhile, and otherwise either starts again
// from what is kept or, another window editing now, shows the card.
async function resumeIfFree() {
    if (!guard || guard.isPrimary() || moving) return;
    moving = true;
    linkDuringMove = false;
    let inPlace = false;
    try {
        const free = await guard.takeIfFree();
        if (awayFromCopy) {
            awayFromCopy = false;
            if (free && await claimStillMine()) inPlace = true;
            else if (!free) enterSecondary('lost');
            else await resumeHere();
        } else if (free) {
            await resumeHere();
        }
    } catch (e) {
        /* stays as it is */
    } finally {
        moving = false;
    }
    // An import link that arrived on the way back (its hashchange came
    // while this was under way): opened here now that this window edits on
    // in place, or it moves the copy here, as any link tapped behind the
    // card does. A start again (reload) takes it along in the address bar.
    const linked = linkDuringMove;
    linkDuringMove = false;
    if (restarting) return;
    if (!halted()) {
        if (inPlace) openLinkInUrl();
    } else if (linked && IMPORT_HASH_RE.test(location.hash)) {
        useHere();
    }
}

// An import link still in the address bar, opened by a window that edits on
// in place rather than starting again (which would take it up itself).
function openLinkInUrl() {
    if (halted()) return;
    if (IMPORT_HASH_RE.test(location.hash)) processImportHashIfAny();
    offerPendingChanges();
}

// Starting again from what is kept: nothing in this page's memory is
// anything to ask about on the way out.
let restarting = false;

// This window edits now. One that let go of the copy before starts again
// from what is kept, its memory being from before — unless it holds work
// the device could not keep, which it carries on with here instead.
async function resumeHere() {
    if (booted) {
        if (unkeptWork()) {
            await carryOnHere();
            return;
        }
        restarting = true;
        location.reload();
        return;
    }
    await claimCopy();
    // Asked for the copy again while claiming it (a third window): it is
    // that one's, and this one stays behind the card.
    if (halted()) return;
    hide($('primary-guard'));
    await bootstrap();
}

// Back to editing what this window holds in memory, work the device could
// not keep: no start again, which would lose it. TreeStore writes it over
// whatever another window kept meanwhile only by taking that in first (its
// edits made again on top, or into their own copy, set aside).
async function carryOnHere() {
    await claimCopy();
    if (halted()) return;
    hide($('primary-guard'));
    setGuardNote('');
    renderView();
    try { await TreeStore.flush(); } catch (e) { /* said by the write */ }
    openLinkInUrl();
}

// --- Settings › Storage ------------------------------------------------------
//
// Where the copy is kept, whether the browser may clear it to make room
// (navigator.storage.persisted()), and 'Keep my data on this phone', which
// asks it not to — from the click, as Firefox wants. The copies set aside on
// this device (another account's, or this one's from before), each to bring
// back, export or discard. And whether this device pushes after each change.

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
    renderPushSetting();
    if (!status) return;
    const storage = typeof navigator !== 'undefined' && navigator ? navigator.storage : null;
    const [st, kind] = await Promise.all([DC.storageStatus(storage), platform.backendKind()]);
    const here = deviceWord();
    const lines = [];
    if (keptIn === 'aside') lines.push(`Your copy is kept in this browser's cache storage on this ${here} for now: its database is full.`);
    else if (kind === 'indexeddb') lines.push(`Your copy is kept in this browser's database on this ${here}.`);
    else if (kind === 'cache') lines.push(`Your copy is kept in this browser's cache storage on this ${here}.`);
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
    await renderSetAsideCopies();
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

// --- Set-aside copies ------------------------------------------------------------
//
// A working copy is set aside, never discarded, when another account signs
// in, a pull brings another account's tree, a push is refused as another
// account's (412), or a copy is brought back in its place. Each comes back on
// its own when its account signs in again; here it can also be brought back
// by hand (its own account only — one from the same server at a new address
// after a yes), exported as a bookmarks file, or discarded with its name typed,
// after any notes parked with it are offered as a file.

function stashLabel(s) {
    const who = s.username || (s.userId !== null && s.userId !== undefined ? `account #${s.userId}` : null);
    let host = s.url || '';
    try { host = new URL(s.url).host; } catch (e) { /* as kept */ }
    if (who) return `${who} @ ${host}`;
    return s.origin === 'local' ? 'Made while nobody was signed in' : `From before accounts${host ? ` @ ${host}` : ''}`;
}

// The parked notes only this set-aside copy brings back: not the working
// copy, nor another set-aside one.
function parkedOnlyWith(s, all) {
    const others = all.filter(x => x.key !== s.key).map(x => x.stamps);
    const kept = [DC.stampsOfStatus(copyStatus()), ...others.map(st => (st || []).map(x => (x.userId === null || x.userId === undefined
        ? { owner: null, origin: x.origin || null }
        : { owner: { url: x.url, userId: x.userId, serverId: x.serverId || null }, origin: null })))];
    const own = (s.stamps || []).map(x => (x.userId === null || x.userId === undefined
        ? { owner: null, origin: x.origin || null }
        : { owner: { url: x.url, userId: x.userId, serverId: x.serverId || null }, origin: null }));
    return parkedList().filter(d => DC.draftAnswersTo(d, own) && !kept.some(k => DC.draftAnswersTo(d, k)));
}

// The account a copy kept aside only (DC.keptAsideOnly) was kept for, when
// it is the one signed in: it may bring it back by hand.
function keptForMe(raw) {
    const me = signedInAccount();
    const was = raw && raw.ownerWas;
    if (!me || !was || Number(was.userId) !== Number(me.userId) || !sameServerUrl(was.url, me.url)) return false;
    return !(was.serverId && me.serverId && was.serverId !== me.serverId);
}

async function renderSetAsideCopies() {
    const box = $('stash-list');
    const block = $('stash-block');
    if (!box) return;
    let list = [];
    let raw = {};
    try {
        list = await TreeStore.listStashes(signedInAccount());
        raw = list.length ? await platform.getRaw(list.map(s => s.key)) : {};
    } catch (e) { list = []; }
    // A copy kept aside only says whose it was.
    list = list.map(s => {
        const was = raw[s.key] && raw[s.key].ownerWas;
        return was ? { ...s, username: s.username || was.username || null, keptForMe: keptForMe(raw[s.key]) } : s;
    });
    if (block) block.classList.toggle('hidden', list.length === 0);
    const rows = list.map((s) => {
        const row = document.createElement('div');
        row.className = 'import-row stash-row';
        row.dataset.key = s.key;
        const head = document.createElement('div');
        head.className = 'import-head';
        const name = document.createElement('span');
        name.className = 'import-name';
        name.textContent = stashLabel(s);
        const count = document.createElement('span');
        count.className = 'import-count';
        count.textContent = `${s.items} item${s.items === 1 ? '' : 's'}`;
        head.append(name, count);
        const meta = document.createElement('div');
        meta.className = 'import-meta';
        const drafts = parkedOnlyWith(s, list).length;
        meta.textContent = [
            s.dirty ? `${s.editCount} unpushed edit${s.editCount === 1 ? '' : 's'}` : 'nothing unpushed',
            s.setAsideAt ? `set aside ${new Date(s.setAsideAt).toLocaleString()}` : '',
            drafts ? `${drafts} unsaved note${drafts === 1 ? '' : 's'} parked with it` : ''
        ].filter(Boolean).join(' · ');
        const actions = document.createElement('div');
        actions.className = 'import-actions';
        if (s.match === 'same' || s.match === 'moved' || s.keptForMe) {
            const restore = document.createElement('button');
            restore.type = 'button';
            restore.textContent = 'Bring back';
            restore.dataset.stashAct = 'restore';
            restore.addEventListener('click', () => restoreSetAside(s));
            actions.appendChild(restore);
        }
        const exp = document.createElement('button');
        exp.type = 'button';
        exp.textContent = 'Export';
        exp.dataset.stashAct = 'export';
        exp.addEventListener('click', () => exportSetAside(s));
        const discard = document.createElement('button');
        discard.type = 'button';
        discard.className = 'danger';
        discard.textContent = 'Discard…';
        discard.dataset.stashAct = 'discard';
        discard.addEventListener('click', () => discardSetAside(s, list));
        actions.append(exp, discard);
        row.append(head, meta, actions);
        return row;
    });
    box.replaceChildren(...rows);
}

function downloadFile(text, type, name) {
    try {
        const url = URL.createObjectURL(new Blob([text], { type }));
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        return true;
    } catch (e) {
        return false;
    }
}

const fileStem = (s) => String(stashLabel(s)).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'set-aside-copy';

async function exportSetAside(s) {
    try {
        const html = await TreeStore.exportStashHtml(s.key);
        if (!downloadFile(html, 'text/html', `${fileStem(s)}-bookmarks.html`)) showToast('This browser could not save the file.');
    } catch (e) {
        showToast(e.message);
    }
}

async function restoreSetAside(s) {
    const me = signedInAccount();
    if (!me) { showToast('Sign in as the account this copy belongs to first.'); return; }
    if (s.match === 'moved' && !confirm(`This copy is ${stashLabel(s)}: the same server, reached at another address.\n\n`
        + 'Bring it back here? Only if it is the same server, moved — a copy of its database answers the same.')) return;
    const st = copyStatus();
    if (st.dirty && !confirm(`The copy here has ${st.editCount} unpushed edit${st.editCount === 1 ? '' : 's'}. It is set aside in its place, not discarded. Go on?`)) return;
    try {
        await asLocalSwitch(async () => {
            parkOpenDraft(st);
            if (s.keptForMe && s.match !== 'same' && s.match !== 'moved') {
                // Kept aside only, for this account: its stamp back, then
                // brought back as any of its set-aside copies is.
                const raw = (await platform.getRaw([s.key]))[s.key];
                if (!raw || !keptForMe(raw)) throw new Error('That set-aside copy is gone.');
                const { ownerWas, ...rest } = raw;
                await platform.storage.local.set({ [s.key]: { ...rest, owner: ownerWas, origin: null } });
            }
            await TreeStore.restoreStash(s.key, me, { moved: s.match === 'moved' });
        });
    } catch (e) {
        showToast(e.message);
        return;
    }
    noteCopySwitched();
    resetAccountUi();
    hide($('settings-sheet'));
    reopenParkedDraft();
    renderView();
    setStatus(copyStatus().dirty ? 'Brought back, with its unpushed edits — ⬆️ Push to keep them.' : 'Brought back.');
}

async function discardSetAside(s, all) {
    const drafts = parkedOnlyWith(s, all);
    if (drafts.length && confirm(`${drafts.length} unsaved note${drafts.length === 1 ? ' is' : 's are'} parked with this copy, and come${drafts.length === 1 ? 's' : ''} back only with it.\n\nOK = save ${drafts.length === 1 ? 'it' : 'them'} as a Markdown file first`)) {
        downloadFile(draftsMarkdown(drafts), 'text/markdown', `${fileStem(s)}-note-drafts.md`);
    }
    const name = s.username || 'DISCARD';
    const what = s.dirty ? ` with ${s.editCount} unpushed edit${s.editCount === 1 ? '' : 's'}` : '';
    const typed = prompt(`Discard ${stashLabel(s)}${what}? It cannot be recovered.\n\nType ${name} to confirm.`);
    if (typed === null || typed.trim() !== name) {
        if (typed !== null) showToast('The name did not match — nothing was discarded.');
        return;
    }
    let gone = false;
    try { gone = await TreeStore.discardStash(s.key, { setAsideAt: s.setAsideAt }); } catch (e) { gone = false; }
    if (!gone) {
        showToast('That copy changed or is gone already — nothing was discarded.');
    } else {
        const out = new Set(drafts.map(d => JSON.stringify(d)));
        DC.writeParked(localStorage, parkedList().filter(d => !out.has(JSON.stringify(d))));
        showToast('Discarded.');
    }
    await refreshStorageUi();
}

function draftsMarkdown(drafts) {
    const whose = (d) => (d.owner
        ? `${d.owner.username || `account #${d.owner.userId}`} @ ${d.owner.url}`
        : d.origin === 'local' ? 'made while signed out' : 'an older copy, from before accounts');
    return ['# Unsaved note drafts', '', `Parked on this device, exported ${new Date().toISOString().slice(0, 10)}.`, '',
        ...drafts.map(d => ['---', '', `**${NM.leadingTitle(d.content) || d.title || 'Untitled'}** — unsaved draft (${whose(d)}${d.parkedAt ? `, parked ${String(d.parkedAt).slice(0, 10)}` : ''})`, '', String(d.content || ''), ''].join('\n'))
    ].join('\n');
}

// --- Push after each change (per device) ----------------------------------------
//
// A phone pushes every change as it is made, as it always has: the copy on a
// phone is the one in a pocket, and the share sheet files into the server
// anyway. A computer keeps its edits until ⬆️ Push, as the extension does. Either
// way round, by the device's own choice in Settings.
const PUSH_POLICY_KEY = 'tp_push_after_change';

function phoneLike() {
    if (!isDesktop()) return true;
    try {
        const standalone = window.matchMedia('(display-mode: standalone)').matches;
        return Boolean(standalone && /Android|iPhone|iPad|Mobile/i.test((navigator && navigator.userAgent) || ''));
    } catch (e) {
        return false;
    }
}

function pushAfterEachChange() {
    try {
        const v = localStorage.getItem(PUSH_POLICY_KEY);
        if (v === '1') return true;
        if (v === '0') return false;
    } catch (e) { /* the default */ }
    return phoneLike();
}

function renderPushSetting() {
    const box = $('push-after-change');
    if (box) box.checked = pushAfterEachChange();
    const hint = $('push-after-change-hint');
    if (hint) {
        hint.textContent = pushAfterEachChange()
            ? `Every change on this ${deviceWord()} goes to the server as it is made.`
            : `Changes stay on this ${deviceWord()} until ⬆️ Push (the sync chip shows how many).`;
    }
}

function setPushAfterEachChange(on) {
    try { localStorage.setItem(PUSH_POLICY_KEY, on ? '1' : '0'); } catch (e) { /* this session only */ }
    renderPushSetting();
    updateSyncUi();
    if (on && state.dirty) showToast('Pushing after each change from now on — ⬆️ Push what is waiting.');
}

// --- The sync chip ----------------------------------------------------------------
//
// Always in view: in the top bar on a computer ('3 unpushed · Push · Pull'),
// and on a phone as a count on the bottom bar's Home.
function updateSyncUi() {
    updatePushBtnState();
    let st = null;
    try { st = copyStatus(); } catch (e) { return; }
    const n = st && st.dirty ? Math.max(1, st.editCount || 0) : 0;
    const label = $('sync-chip-label');
    if (label) {
        label.textContent = !copyPresent() ? 'Nothing pulled yet' : n ? `${n} unpushed` : 'Up to date';
    }
    const chip = $('sync-chip');
    if (chip) chip.classList.toggle('dirty', n > 0);
    const nav = $('bottom-nav');
    const badge = nav && nav.querySelector ? nav.querySelector('.sync-badge') : null;
    if (badge) {
        badge.textContent = n > 99 ? '99+' : String(n);
        badge.classList.toggle('hidden', n === 0);
    }
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
let copyIndex = { rev: -1, copyId: null, index: null, serverIds: null };

// The copy's own nodes in the server's shape: the virtual archive left out.
function ownRoots() {
    const clean = (n) => {
        if (!n || n.virtual || n.readOnly) return null;
        return n.kind === 'folder' ? { ...n, children: (n.children || []).map(clean).filter(Boolean) } : n;
    };
    return TreeStore.roots().map(clean).filter(Boolean);
}

function shareCopy() {
    if (!state.snapshot || !configured() || accountChanging || !copyIsMine() || !copyStatus().owner) return { ready: false };
    const st = copyStatus();
    if (copyIndex.copyId !== st.copyId || copyIndex.rev !== state.treeRev) {
        copyIndex = { rev: state.treeRev, copyId: st.copyId, index: Share.indexFolders(ownRoots()), meta: null, serverIds: null };
    }
    const meta = copyMetaNow();
    if (copyIndex.meta !== meta) {
        copyIndex.meta = meta;
        copyIndex.serverIds = new Set(meta.serverIds || []);
    }
    return { ready: true, index: copyIndex.index, serverIds: copyIndex.serverIds };
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
    forgetMadeMcpToken();
    mcpError('');
    show($('settings-sheet'));
    refreshStorageUi();
    if (state.config.token) {
        refreshImporters();
        refreshMcpTokens();
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
                serverId: data.serverId || null,
                tenancyOwner: Boolean(user.tenancyOwner)
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

        // Unpushed edits are never discarded by a sign-in, nor pulled over.
        // The same account keeps them (and bootstrap skips its pull). For
        // another account the copy here is set aside on this device —
        // with an unsaved note in it, open or parked — and that account's own
        // set-aside copy comes back, or its tree is pulled into a new one
        // (bootstrap, ensureAccountCopy). The same id on another server is
        // another account: ids start at 1 everywhere.
        const user = data.user || {};
        const name = data.username || username;
        const before = copyStatus();
        const known = user.id !== undefined && user.id !== null;
        const target = { url: base, userId: known ? Number(user.id) : null, username: name, serverId: data.serverId || null, tenancyOwner: Boolean(user.tenancyOwner) };
        const nameKey = (s) => String(s || '').normalize('NFKC').toLowerCase();
        const sameAccount = known
            ? !TreeStore.wouldSetAside(target) && (!before.owner || (Number(before.owner.userId) === target.userId && sameServerUrl(before.owner.url, base)
                && (!before.owner.serverId || !target.serverId || before.owner.serverId === target.serverId)))
            : nameKey(localStorage.getItem(LS.username) || name) === nameKey(name);
        // The note open in another account's copy waits with that copy.
        if (!sameAccount) parkOpenDraft(before, { onlyChanged: true });

        state.config.url = base;
        state.config.token = data.token;
        localStorage.setItem(LS.url, base);
        localStorage.setItem(LS.token, data.token);
        localStorage.setItem(LS.username, name);
        if (!sameAccount) localStorage.removeItem(LS.serverId);
        rememberUser(user, name, data.serverId);
        state.identity = storedIdentity();
        mirrorConfigToSW();
        let switched = null;
        if (!sameAccount) {
            // Nothing of the last account's may show up under this one: the
            // copy (set aside before anything is drawn), the lists, an open
            // note or an import waiting for review, and the share sheet's
            // folders and choices.
            switched = await ensureAccountCopy({ previousUsername: (before.owner && before.owner.username) || null });
            shareStats = null;
            sharePrefs = { value: null, updatedAt: null, dirty: [] };
            resetAccountUi();
        }
        if ($('cfg-password')) $('cfg-password').value = '';
        refreshAuthUi();
        hide($('settings-sheet'));
        await bootstrap({ previousUsername: (before.owner && before.owner.username) || null, switched });
    } catch (e) {
        setErr('Sign in failed: ' + e.message);
    }
}

// Unpushed edits are not discarded by a sign-out either. After a yes they stay
// in the copy, kept on the device for the account they belong to: that
// account has them back when it signs in again, and anyone else signing in
// meanwhile sets them aside, never over them. An unsaved note is parked with
// them. A copy with nothing unpushed goes with the sign-out: everything in it
// is on the server, and whoever picks up the device next finds none of it.
async function signOut() {
    const base = currentServerUrl();
    const before = copyStatus();
    const keepEdits = Boolean(state.dirty && state.snapshot);
    const keepDraft = editorDirty() && Boolean(state.snapshot);
    const n = state.editCount || 1;
    const who = localStorage.getItem(LS.username) || 'this account';
    const here = deviceWord();
    const kept = [keepEdits ? `${n} unpushed edit${n === 1 ? '' : 's'}` : '', keepDraft ? 'an unsaved note' : '']
        .filter(Boolean).join(' and ');
    if (kept) {
        if (!confirm(`This ${here} has ${kept} for ${who}.\n\n` + (keepEdits
            ? `Sign out anyway? They stay on this ${here} until ${who} signs in again and pushes them. `
                + `Someone else signing in here meanwhile sets them aside — they are never discarded.`
            : `Sign out anyway? It stays on this ${here} until ${who} signs in again to finish it. `
                + `Someone else signing in here meanwhile never sees it.`))) return;
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
    // The note being written waits, parked with this copy, for this account.
    if (keepDraft) parkOpenDraft(before, { onlyChanged: true });
    state.config.token = '';
    forgetUser();
    state.identity = null;
    mirrorConfigToSW();
    if (!keepEdits) {
        try {
            await asLocalSwitch(() => TreeStore.clearCleanCopy());
        } catch (e) {
            // Not cleared (a full disk): it is this account's, all of it on
            // the server, and stays hidden while nobody is signed in.
        }
        noteCopySwitched();
    }
    shareStats = null;
    sharePrefs = { value: null, updatedAt: null, dirty: [] };
    resetAccountUi();
    refreshAuthUi();
    const plural = (keepEdits && keepDraft) || (keepEdits && n !== 1);
    const shares = waiting ? ` ${waiting} shared link${waiting === 1 ? '' : 's'} not uploaded yet ${waiting === 1 ? 'waits' : 'wait'} on this phone for ${who}.` : '';
    setStatus((!kept ? 'Signed out.'
        : keepEdits ? `Signed out. ${kept} for ${who} ${plural ? 'stay' : 'stays'} on this ${here} until ${who} signs in and pushes.`
            : `Signed out. ${who}’s unsaved note stays on this ${here} until ${who} signs in again.`) + shares);
}

// What the screen holds for the signed-in account besides the working copy:
// the server's lists (inbox, proposals, importers), an import waiting for
// review, the share sheet's folders, and the notes screen with whatever note is
// open in it. Dropped whenever the account changes or signs out, back to
// Home, so none of it shows up — or can be saved — under whoever signs in
// next. The working copy follows its own rules above; an unsaved note is
// parked before this runs. An import link under review stays kept on the
// phone (pendingImports), for the account it was opened for.
function resetAccountUi() {
    closeNotesSheets();
    hide($('inbox-sheet'));
    state.proposals = [];
    state.changes = [];
    state.importers = [];
    renderImporters(); // Settings stays open over a sign-out
    mcpTokens = null;
    renderMcpTokens();
    state.importBatch = null;
    setInboxCount(0);
    // An open share sheet stays (the share is not the account's), but draws
    // its folders again from whoever is signed in now, or none.
    if (shareSheet) shareSheet.refresh({ reset: true });
    state.nv = freshNv();
    state.view = 'home';
    state.pathIds = [ROOT_ID];
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

// --- AI chats: MCP tokens (Settings) ---
//
// A token lets an MCP client (Claude Code, Claude Desktop through a bridge)
// read this account's bookmarks and notes and suggest changes at the server's
// /mcp. The server shows a new token once and keeps only its hash; here it
// sits in a read-only field until Settings closes or another is made. An
// older server has no /api/mcp/tokens: the block stays hidden.

let mcpTokens = null;   // [{id, name, prefix, createdAt, lastUsedAt}] | null (not loaded)
let mcpEndpoint = '';

async function refreshMcpTokens() {
    const block = $('mcp-block');
    if (!block) return;
    if (!configured()) { mcpTokens = null; renderMcpTokens(); return; }
    const account = accountKey();
    try {
        const data = await api('/api/mcp/tokens');
        if (accountKey() !== account) return;
        mcpTokens = data.tokens || [];
        mcpEndpoint = data.endpoint || `${(state.config.url || '').replace(/\/$/, '')}/mcp`;
    } catch (e) {
        mcpTokens = null;
    }
    renderMcpTokens();
}

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString() : '');

function renderMcpTokens() {
    const block = $('mcp-block');
    const list = $('mcp-tokens-list');
    if (!block || !list) return;
    if (!mcpTokens) {
        hide(block);
        forgetMadeMcpToken();
        list.replaceChildren();
        return;
    }
    show(block);
    $('mcp-endpoint').textContent = mcpEndpoint;
    const rows = mcpTokens.map(t => {
        const row = document.createElement('div');
        row.className = 'import-row mcp-token-row';
        const head = document.createElement('div');
        head.className = 'import-head';
        const name = document.createElement('span');
        name.className = 'import-name';
        name.textContent = t.name;
        const prefix = document.createElement('span');
        prefix.className = 'import-count';
        prefix.textContent = `${t.prefix}…`;
        head.append(name, prefix);
        const meta = document.createElement('div');
        meta.className = 'import-meta';
        meta.textContent = `Made ${fmtDate(t.createdAt)} · ${t.lastUsedAt ? `last used ${fmtDate(t.lastUsedAt)}` : 'never used'} · read + suggest`;
        const actions = document.createElement('div');
        actions.className = 'import-actions';
        const revoke = document.createElement('button');
        revoke.type = 'button';
        revoke.className = 'danger';
        revoke.textContent = 'Revoke';
        revoke.addEventListener('click', () => revokeMcpToken(t));
        actions.appendChild(revoke);
        row.append(head, meta, actions);
        return row;
    });
    if (!rows.length) {
        const none = document.createElement('p');
        none.className = 'hint';
        none.textContent = 'No tokens yet.';
        rows.push(none);
    }
    list.replaceChildren(...rows);
}

function mcpError(message) {
    const el = $('mcp-error');
    if (!el) return;
    el.textContent = message || '';
    el.classList.toggle('hidden', !message);
}

async function createMcpToken() {
    if (signedOutRefuses()) return;
    mcpError('');
    const nameEl = $('mcp-token-name');
    const name = (nameEl.value || '').trim();
    if (!name) { mcpError('Give the token a name, so you can tell your tokens apart.'); nameEl.focus(); return; }
    try {
        const made = await api('/api/mcp/tokens', { method: 'POST', body: JSON.stringify({ name }) });
        nameEl.value = '';
        mcpEndpoint = made.endpoint || mcpEndpoint;
        $('mcp-token-value').value = made.token;
        $('mcp-token-cmd').value = `claude mcp add --transport http --scope user tabpaladin ${mcpEndpoint} --header "Authorization: Bearer ${made.token}"`;
        show($('mcp-token-made'));
        await refreshMcpTokens();
    } catch (e) {
        mcpError((e.body && e.body.error) || e.message);
    }
}

async function revokeMcpToken(t) {
    if (!confirm(`Revoke “${t.name}”?\n\nAny AI chat using it stops reaching your bookmarks and notes at once. Suggestions it already made stay until you approve or reject them.`)) return;
    mcpError('');
    try {
        await api(`/api/mcp/tokens/${encodeURIComponent(t.id)}`, { method: 'DELETE' });
        showToast(`Revoked “${t.name}”.`);
    } catch (e) {
        mcpError((e.body && e.body.error) || e.message);
    }
    await refreshMcpTokens();
}

async function copyField(id, done) {
    const el = $(id);
    if (!el || !el.value) return;
    try {
        await navigator.clipboard.writeText(el.value);
        showToast(done);
    } catch (e) {
        el.focus();
        el.select();
        showToast('Select it and copy it by hand.');
    }
}

// The made token leaves the screen when Settings closes: it is never kept.
function forgetMadeMcpToken() {
    const value = $('mcp-token-value');
    const cmd = $('mcp-token-cmd');
    if (value) value.value = '';
    if (cmd) cmd.value = '';
    hide($('mcp-token-made'));
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
        // The copy the question is about: the pull replaces that one, as it
        // is now, or nothing (another window's edit or switch meanwhile).
        let expect = null;
        try { expect = await TreeStore.currentCopy(); } catch (err) { expect = null; }
        if (state.dirty && !confirm(`You have local edits that were never pushed. Pulling replaces this ${deviceWord()}'s copy with the server's tree and discards them.\n\nPull anyway?`)) {
            return;
        }
        try {
            await pullSnapshot({ expect });
            showToast('Pulled the latest tree.');
        } catch (err) {
            showToast(stoppedCode(err) ? err.message : 'Pull failed: ' + err.message);
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
        // Asked while the prompt was up: signed out meanwhile, or another copy.
        if (signedOutRefuses()) return;
        const parentId = parentFolder._pwaId === ROOT_ID ? null : parentFolder._pwaId;
        if (!(await copyEdit(() => TreeStore.createNode({ parentId, kind: 'folder', title: trimmed })))) return;
        renderView();

        try {
            setStatus('Creating folder…');
            const pushed = await pushAfterEdit();
            showToast(pushed ? `Folder "${trimmed}" created successfully!` : `Folder "${trimmed}" created on this ${deviceWord()} — ⬆️ Push when ready.`);
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
    // work that is not on the server: an unsaved note, edits the device could
    // not keep, or — on a device that pushes after each change — unpushed
    // edits, kept for their account or not. A computer that pushes when told
    // keeps its edits on the device, as it is meant to.
    window.addEventListener('beforeunload', (e) => {
        // Another window edits the copy, or this one starts again from what
        // is kept: nothing here is this page's to lose — unless it is work
        // the device could not keep, which stays here behind the card.
        if (restarting || (halted() && !unkeptWork())) return;
        saveLiveDraft();
        if (!editorDirty() && !unkeptWork() && !(pushAfterEachChange() && state.dirty && state.snapshot)) return;
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

    safeAddListener('settings-close', 'click', () => { hide($('settings-sheet')); forgetMadeMcpToken(); });
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
        if (!confirm(`Import ${n} item(s) into a new "${folder.title}" folder${pushAfterEachChange() ? ' and push' : ''}?`)) return;
        if (importNeedsSignIn() || !state.snapshot) return; // signed out while the file was read
        // One edit for the whole folder, notes as notes (toWire's shape).
        if (!(await copyEdit(() => TreeStore.createTree({ parentId: null, tree: toWire(folder) })))) return;
        try {
            setStatus('Saving…');
            const pushed = await pushAfterEdit();
            setStatus('');
            showToast(pushed ? `Imported ${n} item(s).` : `Imported ${n} item(s) on this ${deviceWord()} — ⬆️ Push when ready.`);
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
    safeAddListener('push-after-change', 'change', (e) => setPushAfterEachChange(Boolean(e.target && e.target.checked)));
    safeAddListener('sync-chip-push', 'click', (e) => { e.stopPropagation(); pushNow(); });
    safeAddListener('sync-chip-pull', 'click', (e) => { e.stopPropagation(); $('pullBtn')?.click(); });
    safeAddListener('imports-show-removed', 'change', refreshImporters);
    safeAddListener('users-add', 'click', () => openUserSheet('add'));
    safeAddListener('ai-share-link', 'click', () => { if (!signedOutRefuses()) createShareLink(); });
    safeAddListener('mcp-token-create', 'click', createMcpToken);
    safeAddListener('mcp-token-copy', 'click', () => copyField('mcp-token-value', 'Token copied — it will not be shown again.'));
    safeAddListener('mcp-token-cmd-copy', 'click', () => copyField('mcp-token-cmd', 'Command copied.'));
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

    // Going to the background writes the copy (TreeStore does, on hide) and
    // the note being written down at once rather than after the usual moment:
    // a share reloads this window, and Android may close it. Coming back, and
    // coming online, sends what waits.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            saveLiveDraft();
            mirrorOnHide();
        } else if (document.visibilityState === 'visible') {
            // Without Web Locks, a window that edited while this one was
            // frozen makes this one stop (recheckCopy). A window behind the
            // card edits again once the one that edited is gone.
            recheckCopy();
            if (halted()) resumeIfFree();
            if (configured() && !halted()) {
                flushShares().then(res => { if (res && (res.uploaded.length || res.filed.length)) refreshInbox(); }).catch(() => {});
            }
        }
    });
    window.addEventListener('pagehide', (e) => {
        saveLiveDraft();
        mirrorOnHide();
        // Kept in the back-forward cache, this window would hold the copy
        // while it can answer nobody: it lets go until it is back.
        if (e && e.persisted) letGoWhileAway();
    });
    document.addEventListener('freeze', () => {
        saveLiveDraft();
        try { TreeStore.flush().catch(() => {}); } catch (e) { /* written on the next start's read */ }
        letGoWhileAway();
    });
    window.addEventListener('pageshow', (e) => {
        if (!e || !e.persisted) return;
        if (halted()) resumeIfFree();
        else recheckCopy();
    });
    document.addEventListener('resume', () => {
        if (halted()) resumeIfFree();
        else recheckCopy();
    });
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

    // Import and suggestion links tapped while the app is already open. One
    // tapped in a window that does not edit the copy moves the copy there:
    // that is where the person is. One tapped while this window is on its
    // way back (resumeIfFree) is taken up once it is: Use here waits for
    // that. A suggestion link is kept on the device first either way; it
    // does not depend on the copy.
    window.addEventListener('hashchange', () => {
        if (!halted()) {
            processImportHashIfAny();
            if (stashChangesHash()) offerPendingChanges();
        } else if (IMPORT_HASH_RE.test(location.hash) || location.hash.startsWith(CHANGES_HASH)) {
            stashChangesHash();
            if (moving) linkDuringMove = true;
            useHere();
        }
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
        // Another device may have changed what a suggestion would do.
        await refreshProposals();
    }
});
