// The local working copy of the bookmark tree.
//
// The browser's own bookmark tree is no longer touched. The server owns the
// canonical tree (see server/items.js); this module holds a full working copy
// in extension storage, all edits land here instantly (and offline), and
// syncing is explicit and git-style: pull replaces the working copy with the
// server's tree, push replaces the server's tree with this one, and a push
// whose baseVersion is stale is refused until you pull.
//
// Node model (same shape the server speaks):
//   { id, kind: 'folder'|'bookmark'|'note', title, url?, payload?, role?,
//     children?, virtual?, readOnly? }
//
// Ids are random hex strings that survive push/pull unchanged, which is what
// lets settings or UI state hold onto a folder forever. The virtual imports
// subtree the server appends to a pull is kept for browsing but is read-only
// here: it is never pushed back, and edits inside it throw.
//
// For the many call sites written against chrome.bookmarks, `TreeStore.bookmarks`
// exposes the same API surface (getTree/getChildren/create/move/...) over this
// tree. Notes appear through that facade as bookmarks with the historical
// data:application/json url encoding, so tree-browsing UI renders them the way
// it always has; the facade decodes that url back into a payload on write.
//
// A working copy belongs to one account on one server, and says so: `owner`
// ({url, userId, username, serverId}) is stamped from every pull and push.
// Signing in as someone else never pushes this copy into their account and
// never discards it: switchAccount sets it aside (tpTreeStash:<url>|<userId>,
// with the per-account state that travels with it) and brings back the new
// account's own set-aside copy, if this browser has one. Each copy brought in
// that way gets a new `copyId`, and listeners hear 'switch' — in this page and,
// through the storage event, in every other one — so nothing drawn from the
// previous copy is carried into this one.
//
// A copy with no stamp is one of two things, and `origin` says which: one
// from before accounts ('pre-accounts', the server owner's), or one made in
// this browser while nobody was signed in ('local', claimed by the first
// account to sign in).
//
// A pull never replaces another account's copy either: a tree pulled for an
// account the copy is not stamped with (or, from before accounts, for anyone
// but the server's owner) comes into a copy of its own, and this one is set
// aside first. When the server cannot say whether it is the owner, or another
// page brings another copy in while the pull waits, the pull stops having
// changed nothing. And a copy brought back from being set aside remembers the
// stamps it was set aside under (`restoredFrom`): from before accounts, or at
// the old address of a server that moved. What was left with it on this
// device, such as a note draft, can then find its way back to it.

import { ExpandState } from './expandState.js';

const api = typeof browser !== 'undefined' ? browser : chrome;

const STORE_KEY = 'tpTree';
const DATA_PREFIX = 'data:application/json,';
const STASH_PREFIX = 'tpTreeStash:';
const STASH_INDEX_KEY = 'tpTreeStashIndex';
const SETTINGS_KEY = 'settings';

export const ROLES = ['bookmarks', 'pins', 'notes', 'workflows'];
const ROLE_DEFAULT_TITLE = {
    bookmarks: 'Bookmarks',
    pins: 'TabPaladin Pinned',
    notes: 'TabPaladin Notes',
    workflows: 'TabPaladin Workflows'
};

export function newId() {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function encodePayloadUrl(payload) {
    return DATA_PREFIX + encodeURIComponent(JSON.stringify(payload));
}

function decodePayloadUrl(url) {
    try {
        return JSON.parse(decodeURIComponent(url.slice(DATA_PREFIX.length)));
    } catch (e) {
        try { return JSON.parse(url.slice(DATA_PREFIX.length)); } catch (e2) { return null; }
    }
}

// --- State ------------------------------------------------------------------

const state = {
    loaded: false,
    baseVersion: 0,     // server version this working copy is based on
    roots: [],
    dirty: false,
    lastSyncAt: null,
    lastSyncKind: null,
    owner: null,        // {url, userId, username, serverId} of the account this copy belongs to; null = unstamped
    origin: null,       // for an unstamped copy: 'pre-accounts' (older version) or 'local' (made while signed out)
    editCount: 0,       // local edits since the last pull or push, for "N unpushed edits"
    copyId: null,       // new each time another copy becomes the working copy (loadCopy)
    restoredFrom: [],   // stamps of the set-aside copies this one came back from, latest first (see stampOf)
    rev: null           // stamp of the last write, to recognise our own storage events
};

// Rebuilt after every change: node id -> { node, parent (node|null), index }.
let index = new Map();

function reindex() {
    index = new Map();
    const walk = (node, parent, i) => {
        index.set(node.id, { node, parent, index: i });
        (node.children || []).forEach((c, j) => walk(c, node, j));
    };
    state.roots.forEach((r, i) => walk(r, null, i));
}

const listeners = new Set();
function emit(kind) {
    for (const fn of listeners) {
        try { fn(kind); } catch (e) { console.warn('[TabPaladin] tree listener failed', e); }
    }
}

// Node removals queued by the background script (workflow auto-sync on tab
// close). The background never edits the tree itself — that would race the
// debounced persist of an open page — it only appends ids here, and whichever
// context owns a live working copy applies them against its own current state.
const PENDING_REMOVALS_KEY = 'tpPendingRemovals';

async function applyPendingRemovals() {
    let list = [];
    try {
        const data = await api.storage.local.get(PENDING_REMOVALS_KEY);
        list = (data && data[PENDING_REMOVALS_KEY]) || [];
    } catch (e) {
        return;
    }
    if (!list.length) return;
    let removed = 0;
    for (const id of list) {
        const e = index.get(String(id));
        if (!e || inVirtual(id)) continue;
        detach(id);
        removed++;
    }
    try { await api.storage.local.remove(PENDING_REMOVALS_KEY); } catch (e) { /* retried next load */ }
    if (removed) {
        reindex();
        markDirty();
        emit('removed');
    }
}

let loadPromise = null;
async function ensureLoaded() {
    if (state.loaded) return;
    if (!loadPromise) {
        loadPromise = (async () => {
            const data = await api.storage.local.get(STORE_KEY);
            const stored = data && data[STORE_KEY];
            if (stored && Array.isArray(stored.roots)) {
                state.baseVersion = Number(stored.baseVersion) || 0;
                state.roots = stored.roots;
                state.dirty = Boolean(stored.dirty);
                state.lastSyncAt = stored.lastSyncAt || null;
                state.lastSyncKind = stored.lastSyncKind || null;
                state.owner = stored.owner || null;
                state.origin = originOf(stored);
                state.editCount = Number(stored.editCount) || (state.dirty ? 1 : 0);
                state.copyId = stored.copyId || null;
                state.restoredFrom = stampsIn(stored.restoredFrom);
                state.rev = stored.rev || null;
            } else {
                // Nothing here yet: whatever is made before someone signs in
                // belongs to nobody so far.
                state.origin = 'local';
            }
            reindex();
            state.loaded = true;
            await applyPendingRemovals();
        })();
    }
    return loadPromise;
}

// Persist with a small debounce so a burst of edits (recreating a folder,
// applying an organiser proposal) serializes the tree once, not per node.
let persistTimer = null;
function schedulePersist() {
    if (persistTimer) return;
    persistTimer = setTimeout(persistNow, 150);
}

async function persistNow() {
    persistTimer = null;
    state.rev = newId();
    try {
        await api.storage.local.set({
            [STORE_KEY]: {
                baseVersion: state.baseVersion,
                roots: state.roots,
                dirty: state.dirty,
                lastSyncAt: state.lastSyncAt,
                lastSyncKind: state.lastSyncKind,
                owner: state.owner,
                origin: state.owner ? null : state.origin,
                editCount: state.editCount,
                copyId: state.copyId,
                restoredFrom: state.restoredFrom,
                rev: state.rev
            }
        });
    } catch (e) {
        console.warn('[TabPaladin] Failed to persist tree', e);
    }
}

// Another context (background vs. app page) wrote the tree — adopt its copy.
if (api.storage && api.storage.onChanged) {
    api.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        // The background queued a removal while this page holds the tree.
        if (changes[PENDING_REMOVALS_KEY] && changes[PENDING_REMOVALS_KEY].newValue && state.loaded) {
            applyPendingRemovals();
        }
        if (!changes[STORE_KEY]) return;
        const next = changes[STORE_KEY].newValue;
        if (!next || next.rev === state.rev) return;
        // Another page brought another account's copy in: the same 'switch'
        // its own listeners heard.
        const switched = state.loaded && (next.copyId || null) !== state.copyId;
        state.baseVersion = Number(next.baseVersion) || 0;
        state.roots = Array.isArray(next.roots) ? next.roots : [];
        state.dirty = Boolean(next.dirty);
        state.lastSyncAt = next.lastSyncAt || null;
        state.lastSyncKind = next.lastSyncKind || null;
        state.owner = next.owner || null;
        state.origin = originOf(next);
        state.editCount = Number(next.editCount) || 0;
        state.copyId = next.copyId || null;
        state.restoredFrom = stampsIn(next.restoredFrom);
        state.rev = next.rev || null;
        state.loaded = true;
        reindex();
        emit(switched ? 'switch' : 'external');
    });
}

function markDirty() {
    state.dirty = true;
    state.editCount++;
    schedulePersist();
}

// --- Lookup helpers ---------------------------------------------------------

function entry(id) {
    const e = index.get(String(id));
    if (!e) throw new Error(`No item with id ${id}`);
    return e;
}

function isVirtualNode(node) {
    return Boolean(node && (node.virtual || node.readOnly));
}

function inVirtual(id) {
    let e = index.get(String(id));
    while (e) {
        if (isVirtualNode(e.node)) return true;
        e = e.parent ? index.get(e.parent.id) : null;
    }
    return false;
}

function assertWritable(id) {
    if (inVirtual(id)) {
        throw new Error('This item is part of the imports archive, which is read-only here. Use the Imports screen to delete or file it.');
    }
}

// Where do legacy "root" parent ids land? The old tree had a virtual root '0'
// and browser roots '1'/'2'; this tree just has top-level folders. Anything
// that still passes one of those ids means "top level".
function isTopLevelParent(parentId) {
    return parentId == null || parentId === '' || parentId === '0' || parentId === '1' || parentId === '2';
}

function siblingsOf(parentId) {
    if (isTopLevelParent(parentId)) return state.roots;
    const e = entry(parentId);
    if (e.node.kind !== 'folder') throw new Error('Parent is not a folder');
    e.node.children = e.node.children || [];
    return e.node.children;
}

// --- Facade views -----------------------------------------------------------

// A chrome.bookmarks-shaped view of a node. Notes come back with the
// historical data:application/json url so existing rendering code treats them
// exactly as before.
function view(node, parent, idx, withChildren = false) {
    const v = {
        id: node.id,
        parentId: parent ? parent.id : '0',
        index: idx,
        title: node.title,
        kind: node.kind,
        dateAdded: node.payload && node.payload.createdAt ? Date.parse(node.payload.createdAt) || undefined : undefined
    };
    if (node.role) v.role = node.role;
    if (isVirtualNode(node)) v.readOnly = true;
    if (node.kind === 'bookmark') v.url = node.url;
    if (node.kind === 'note') {
        v.url = encodePayloadUrl({ v: 1, ...(node.payload || {}) });
    }
    if (withChildren && node.kind === 'folder') {
        v.children = (node.children || []).map((c, i) => view(c, node, i, true));
    }
    return v;
}

function viewOf(id, withChildren = false) {
    const e = entry(id);
    return view(e.node, e.parent, e.index, withChildren);
}

// --- Mutations --------------------------------------------------------------

function makeNode({ kind, title, url, payload, role }) {
    const node = { id: newId(), kind, title: String(title || '') };
    if (kind === 'bookmark') node.url = String(url || '');
    if (kind === 'folder') node.children = [];
    if (payload && typeof payload === 'object') node.payload = payload;
    if (role && ROLES.includes(role)) node.role = role;
    return node;
}

function insertNode(node, parentId, at) {
    const siblings = siblingsOf(parentId);
    const idx = (at === undefined || at === null || at < 0 || at > siblings.length) ? siblings.length : at;
    siblings.splice(idx, 0, node);
    reindex();
    markDirty();
    emit('created');
    return node;
}

function detach(id) {
    const e = entry(id);
    const siblings = e.parent ? e.parent.children : state.roots;
    const i = siblings.indexOf(e.node);
    if (i >= 0) siblings.splice(i, 1);
    return e.node;
}

// --- Sync -------------------------------------------------------------------

function trim(url) { return String(url || '').replace(/\/$/, ''); }

// One server address, however it was typed: host case, a default port and a
// trailing slash make no difference.
function sameUrl(a, b) {
    const norm = (u) => {
        try {
            const x = new URL(trim(u));
            return x.origin + x.pathname.replace(/\/$/, '');
        } catch (e) {
            return trim(u);
        }
    };
    return norm(a) === norm(b);
}

function authHeader(token) {
    return token ? { 'Authorization': 'Bearer ' + token } : {};
}

async function apiFetch(config, path, opts = {}) {
    const res = await fetch(trim(config.url) + path, {
        ...opts,
        headers: {
            'Content-Type': 'application/json',
            ...authHeader(config.token),
            ...(opts.headers || {})
        }
    });
    let body = null;
    try { body = await res.json(); } catch (e) { /* non-JSON error page */ }
    if (!res.ok) {
        // A server that predates the tree API has no /api/tree at all: the
        // request falls through to the PWA static handler and comes back as
        // 404 HTML. That is a deployment state, not a sync failure, and saying
        // so plainly is the difference between "rebuild the server" and
        // "my bookmarks are gone".
        if (res.status === 404 && !body) {
            const err = new Error(
                'This server is still running an older TabPaladin build (no /api/tree). '
                + 'Rebuild it — `docker compose up -d --build` in the server folder — then pull again. '
                + 'Nothing is lost: your bookmarks are still in the server database.'
            );
            err.status = 404;
            err.serverTooOld = true;
            throw err;
        }
        const err = new Error((body && body.error) || `${res.status} ${res.statusText}`);
        err.status = res.status;
        if (body && body.version !== undefined) err.serverVersion = body.version;
        // 'wrong-account' / 'foreign-ids' on a 412: this copy belongs to
        // another account. Callers set it aside; they never pull over it or
        // force it.
        if (body && body.code) err.code = body.code;
        if (body && body.userId !== undefined) err.userId = body.userId;
        throw err;
    }
    return body;
}

// --- Accounts -----------------------------------------------------------------

// An unstamped copy (or set-aside copy) as stored. Versions before accounts
// never wrote `origin`, so its absence means the copy is from then.
function originOf(stored) {
    return stored && stored.owner ? null : (stored && stored.origin) || 'pre-accounts';
}

function ownerFrom(config, userId, serverId = null) {
    if (userId === undefined || userId === null) return state.owner;
    const prev = state.owner && Number(state.owner.userId) === Number(userId) ? state.owner : null;
    return {
        url: trim(config.url),
        userId: Number(userId),
        username: prev ? prev.username : null,
        serverId: serverId || (prev && prev.serverId) || null
    };
}

const accountOf = ({ url, userId, username = null, serverId = null }) =>
    ({ url: trim(url), userId: Number(userId), username, serverId: serverId || null });

// The same account: the same id on the same server — the same address and,
// where both are known, the same server id. Ids start at 1 on every server
// and the first admin is "admin" by default, so a matching id and name prove
// nothing on their own.
function sameAccount(a, b) {
    if (!a || !b || Number(a.userId) !== Number(b.userId)) return false;
    if (a.serverId && b.serverId && a.serverId !== b.serverId) return false;
    return sameUrl(a.url, b.url);
}

// The same id on a server that reports the same server id, reached at another
// address: most likely the server moved — but a copy of its database reports
// the same id, and only the user can tell the two apart. So it is never
// assumed; it is offered as a restore the user confirms.
function movedServer(a, b) {
    if (!a || !b || Number(a.userId) !== Number(b.userId) || sameAccount(a, b)) return false;
    return Boolean(a.serverId && b.serverId && a.serverId === b.serverId);
}

// May `account` restore this set-aside copy? 'same' for its own, 'moved' for
// its own on what looks like the same server at a new address (the caller
// confirms first), null otherwise. An unstamped copy from before accounts is
// the server owner's, on the server it was set aside from; one made while
// nobody was signed in may be claimed by whoever is.
function stashMatch(stash, account) {
    if (!stash || !account || account.userId === undefined || account.userId === null) return null;
    const target = accountOf(account);
    if (stash.owner) {
        if (sameAccount(stash.owner, target)) return 'same';
        return movedServer(stash.owner, target) ? 'moved' : null;
    }
    if (originOf(stash) === 'local') return 'same';
    return account.tenancyOwner && sameUrl(stash.url, target.url) ? 'same' : null;
}

const stashKeyFor = (owner, url) => STASH_PREFIX + `${trim(owner ? owner.url : url)}|${owner ? owner.userId : 'legacy'}`;

// Where a tree pulled for `owner` goes: 'into' the working copy when the copy
// is theirs, 'aside' when it is not (the copy is set aside first and the tree
// comes into a copy of its own), or 'unconfirmed' when only the server could
// say and it cannot. A stamped copy is theirs when the stamps match, one made
// here while nobody was signed in is theirs to claim, and one from before
// accounts only when they are the server's owner, which /api/auth/me says.
// When it does not answer, nothing is set aside on a guess and nothing is
// pulled: the caller says so and the user tries again.
async function pullPlan(config, owner) {
    if (!owner) return 'into';
    if (state.owner) return sameAccount(state.owner, owner) ? 'into' : 'aside';
    if (state.origin === 'local' || !(state.roots.length > 0 || state.dirty)) return 'into';
    let me = null;
    try {
        me = await apiFetch(config, '/api/auth/me');
    } catch (e) {
        return 'unconfirmed';
    }
    const user = me && me.user;
    if (!user || user.id === undefined || user.id === null || Number(user.id) !== Number(owner.userId)) return 'unconfirmed';
    return user.tenancyOwner ? 'into' : 'aside';
}

// The working copy as a pull found it. Another page can bring another
// account's copy in (or stamp this one) while the pull waits on the server;
// the pull then writes nothing, since what it decided was about a copy that
// is no longer here.
function currentCopy() {
    return { copyId: state.copyId, owner: state.owner };
}

function stillCopy(copy) {
    if (state.copyId !== copy.copyId) return false;
    if (!state.owner || !copy.owner) return !state.owner && !copy.owner;
    return sameAccount(state.owner, copy.owner);
}

// Why a pull stopped without changing anything. `code` is for callers;
// the message is for the user.
function pullStopped(code, setAside = null) {
    const err = new Error(code === 'account-changed'
        ? 'Account changed during pull — nothing was replaced.'
        : 'Couldn’t confirm the account — try again. Nothing was changed.');
    err.code = code;
    err.setAside = setAside;
    return err;
}

// The stamp a set-aside copy was set aside under: its account, or for an
// unstamped one its origin (and the address it was set aside from).
function stampOf(stash) {
    return stash.owner
        ? { url: trim(stash.owner.url), userId: Number(stash.owner.userId), serverId: stash.owner.serverId || null, origin: null }
        : { url: stash.url ? trim(stash.url) : null, userId: null, serverId: null, origin: originOf(stash) };
}

// Stamps as stored, without repeats (a copy set aside and brought back again
// and again keeps one of each) and only the latest few.
const MAX_RESTORED_FROM = 10;
function stampsIn(list) {
    const seen = new Set();
    return (Array.isArray(list) ? list : []).filter((s) => {
        if (!s || typeof s !== 'object') return false;
        const key = `${s.url}|${s.userId}|${s.serverId}|${s.origin}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).slice(0, MAX_RESTORED_FROM).map(s => ({
        url: s.url || null,
        userId: s.userId === null || s.userId === undefined ? null : Number(s.userId),
        serverId: s.serverId || null,
        origin: s.origin || null
    }));
}

async function readSettings() {
    try {
        const data = await api.storage.local.get(SETTINGS_KEY);
        return (data && data[SETTINGS_KEY]) || {};
    } catch (e) {
        return {};
    }
}

async function stashIndex() {
    const data = await api.storage.local.get(STASH_INDEX_KEY);
    return (data && data[STASH_INDEX_KEY]) || [];
}

function countItems(roots) {
    let n = 0;
    const walk = (node) => { if (!isVirtualNode(node)) { n++; (node.children || []).forEach(walk); } };
    (roots || []).forEach(walk);
    return n;
}

// Put the current working copy aside, with what belongs with it: the focused
// folders and which of its folder cards are open (both hold this account's
// item ids, and ExpandState prunes ids the next account's tree lacks) and any
// tab-close removals still queued. Never overwrites an earlier stash. Returns
// its key, or null when there was nothing to keep.
async function stashCurrent({ fallbackUrl, username = null } = {}) {
    if (!state.roots.length && !state.dirty) return null;
    const settings = await readSettings();
    let pendingRemovals = [];
    try {
        pendingRemovals = ((await api.storage.local.get(PENDING_REMOVALS_KEY)) || {})[PENDING_REMOVALS_KEY] || [];
    } catch (e) { /* nothing queued */ }
    let expanded = {};
    try { expanded = await ExpandState.entriesFor((id) => index.has(id)); } catch (e) { /* UI state only */ }
    const keys = await stashIndex();
    let key = stashKeyFor(state.owner, fallbackUrl);
    if (keys.includes(key)) key += '#' + Date.now();
    const owner = state.owner ? { ...state.owner, username: state.owner.username || username } : null;
    await api.storage.local.set({
        [key]: {
            roots: state.roots,
            baseVersion: state.baseVersion,
            dirty: state.dirty,
            editCount: state.editCount,
            lastSyncAt: state.lastSyncAt,
            owner,
            origin: owner ? null : state.origin,
            url: trim(owner ? owner.url : fallbackUrl),
            username: owner ? owner.username : username,
            setAsideAt: new Date().toISOString(),
            focusedFolderIds: settings.focusedFolderIds || [],
            expanded,
            pendingRemovals,
            restoredFrom: state.restoredFrom
        },
        [STASH_INDEX_KEY]: [...keys, key]
    });
    if (pendingRemovals.length) await api.storage.local.remove(PENDING_REMOVALS_KEY);
    return key;
}

async function takeStash(key) {
    const index = await stashIndex();
    if (!index.includes(key)) return null;
    const data = await api.storage.local.get(key);
    const stash = data && data[key];
    if (!stash) return null;
    await api.storage.local.set({ [STASH_INDEX_KEY]: index.filter(k => k !== key) });
    await api.storage.local.remove(key);
    return stash;
}

// The first set-aside copy that is `target`'s own — matched on the stamp, not
// the key, since a key names the address and id but not the server. With
// `legacy`, an unstamped copy from before accounts set aside from this
// address instead.
async function takeStashFor(target, { legacy = false } = {}) {
    const keys = await stashIndex();
    if (!keys.length) return null;
    const data = await api.storage.local.get(keys);
    const key = keys.find(k => {
        const s = data[k];
        if (!s) return false;
        if (legacy) return !s.owner && originOf(s) === 'pre-accounts' && sameUrl(s.url, target.url);
        return Boolean(s.owner) && sameAccount(s.owner, target);
    });
    return key ? takeStash(key) : null;
}

// Make `stash` (or, with none, an empty copy for `owner`) the working copy,
// and put the per-account state it carries back in place. A stash says which
// stamp it was set aside under, so the copy it becomes still knows it once
// stamped `owner` — the server's owner adopting a copy from before accounts,
// or an account restoring its copy from a server's old address. Returns the
// copy it made (see currentCopy).
async function loadCopy(stash, owner) {
    const copy = { copyId: newId(), owner };
    state.copyId = copy.copyId;
    state.roots = stash ? stash.roots || [] : [];
    state.baseVersion = stash ? Number(stash.baseVersion) || 0 : 0;
    state.dirty = stash ? Boolean(stash.dirty) : false;
    state.editCount = stash ? Number(stash.editCount) || 0 : 0;
    state.lastSyncAt = stash ? stash.lastSyncAt || null : null;
    state.lastSyncKind = null;
    state.owner = owner;
    state.origin = null;
    state.restoredFrom = stash ? stampsIn([stampOf(stash), ...stampsIn(stash.restoredFrom)]) : [];
    reindex();
    const settings = await readSettings();
    await api.storage.local.set({ [SETTINGS_KEY]: { ...settings, focusedFolderIds: stash ? stash.focusedFolderIds || [] : [] } });
    if (stash && stash.expanded) {
        try { await ExpandState.restore(stash.expanded); } catch (e) { /* UI state only */ }
    }
    if (stash && (stash.pendingRemovals || []).length) {
        await api.storage.local.set({ [PENDING_REMOVALS_KEY]: stash.pendingRemovals });
        await applyPendingRemovals();
    }
    await persistNow();
    emit('switch');
    return copy;
}

function htmlEscape(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// A browser-importable bookmarks file. Notes travel as the historical
// data:application/json bookmarks, so nothing in them is lost.
function bookmarksHtml(roots) {
    const lines = [
        '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
        '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
        '<TITLE>Bookmarks</TITLE>',
        '<H1>Bookmarks</H1>',
        '<DL><p>'
    ];
    const walk = (nodes, depth) => {
        const pad = '    '.repeat(depth);
        for (const n of nodes) {
            if (isVirtualNode(n)) continue;
            if (n.kind === 'folder') {
                lines.push(`${pad}<DT><H3>${htmlEscape(n.title)}</H3>`, `${pad}<DL><p>`);
                walk(n.children || [], depth + 1);
                lines.push(`${pad}</DL><p>`);
            } else {
                const url = n.kind === 'note' ? encodePayloadUrl({ v: 1, ...(n.payload || {}) }) : n.url;
                lines.push(`${pad}<DT><A HREF="${htmlEscape(url)}">${htmlEscape(n.title)}</A>`);
            }
        }
    };
    walk(roots || [], 1);
    lines.push('</DL><p>');
    return lines.join('\n') + '\n';
}

function stripVirtual(roots) {
    const clean = (node) => {
        if (isVirtualNode(node)) return null;
        if (node.kind !== 'folder') return node;
        return { ...node, children: (node.children || []).map(clean).filter(Boolean) };
    };
    return roots.map(clean).filter(Boolean);
}

// --- Browser import (one-time, replaces the old push-from-tree) -------------

const IMPORTS_ROOT_TITLE = 'TabPaladin Imports';
const SENTINELS = new Set(['__tabpaladin_root__', '__tabpaladin_meta__']);

// Browser folders that hold nothing worth importing: Opera's and Vivaldi's
// trash. Same spirit as NOISE_ROOT_TITLES in the sidepanel.
const TRASH_TITLES = new Set(['trash', 'prullenbak', 'papierkorb', 'corbeille']);

function convertBrowserNode(node) {
    if (!node) return null;
    // Firefox separators are nodes with neither url nor children; without
    // this they arrive as empty untitled folders.
    if (node.type === 'separator') return null;
    if (node.url) {
        // Firefox's smart folders ("Most Visited", "Recent Tags") are place:
        // queries against its own history database — meaningless anywhere else.
        if (node.url.startsWith('place:')) return null;
        if (SENTINELS.has(node.title)) return null;
        if (node.url.startsWith(DATA_PREFIX)) {
            const p = decodePayloadUrl(node.url) || {};
            return makeNode({
                kind: 'note', title: node.title || 'Untitled',
                payload: {
                    content: p.content || '',
                    createdAt: p.createdAt || null,
                    updatedAt: p.updatedAt || p.createdAt || null
                }
            });
        }
        return makeNode({ kind: 'bookmark', title: node.title || node.url, url: node.url });
    }
    if (node.title === IMPORTS_ROOT_TITLE) return null;
    if (TRASH_TITLES.has((node.title || '').toLowerCase().trim())) return null;
    const folder = makeNode({ kind: 'folder', title: node.title || '' });
    folder.children = (node.children || []).map(convertBrowserNode).filter(Boolean);
    return folder;
}

// Best-effort browser name for the import folder. userAgentData is the
// non-deprecated source and names Brave/Edge/Opera correctly where the UA
// string lies about being Chrome; the UA is the fallback, ordered so the
// impostors are tested before Chrome itself.
function browserName() {
    try {
        const brands = (navigator.userAgentData && navigator.userAgentData.brands) || [];
        const known = brands
            .map(b => b.brand)
            .find(b => /Brave|Opera|Microsoft Edge|Firefox|Vivaldi|Chrome/i.test(b) && !/Not.?A.?Brand/i.test(b));
        if (known) {
            if (/Microsoft Edge/i.test(known)) return 'Edge';
            if (/Chrome/i.test(known) && brands.length > 2) {
                const better = brands.map(b => b.brand).find(b => /Brave|Opera|Vivaldi|Edge/i.test(b));
                if (better) return better.replace(/Microsoft /, '');
            }
            return known;
        }
    } catch (e) { /* not available — fall through to the UA string */ }

    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    if (/Firefox\//i.test(ua)) return 'Firefox';
    if (/OPR\/|Opera/i.test(ua)) return 'Opera';
    if (/Edg\//i.test(ua)) return 'Edge';
    if (/Vivaldi/i.test(ua)) return 'Vivaldi';
    if (/Chrome\//i.test(ua)) return 'Chrome';
    return 'Browser';
}

// --- Public API -------------------------------------------------------------

export const TreeStore = {
    onChanged(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
    },

    async load() {
        await ensureLoaded();
    },

    // Write the working copy to storage now instead of on the debounce.
    // Anything about to close this page (saving a workflow closes its own
    // tab along with the rest) must await this first, or the edit dies with
    // the page before the timer fires.
    async flush() {
        await ensureLoaded();
        if (persistTimer) clearTimeout(persistTimer);
        await persistNow();
    },

    status() {
        return {
            loaded: state.loaded,
            dirty: state.dirty,
            editCount: state.dirty ? Math.max(1, state.editCount) : 0,
            baseVersion: state.baseVersion,
            lastSyncAt: state.lastSyncAt,
            lastSyncKind: state.lastSyncKind,
            owner: state.owner ? { ...state.owner } : null,
            origin: state.owner ? null : state.origin,
            copyId: state.copyId,
            restoredFrom: state.restoredFrom.map(s => ({ ...s })),
            isEmpty: state.roots.length === 0
        };
    },

    // --- Accounts ---------------------------------------------------------

    // Would signing in as {url, userId, serverId, tenancyOwner} set this copy
    // aside? An unstamped copy from before accounts is the owner's; one made
    // here while nobody was signed in is claimed instead (see switchAccount).
    wouldSetAside({ url, userId, username = null, serverId = null, tenancyOwner = false }) {
        const target = accountOf({ url, userId, username, serverId });
        if (state.owner) return !sameAccount(state.owner, target);
        if (state.origin === 'local') return false;
        return !tenancyOwner && (state.roots.length > 0 || state.dirty);
    },

    // Make the working copy the one for this account. In order: queued
    // tab-close removals are applied to the copy they belong to; a copy made
    // here while nobody was signed in is claimed by this account (doSignIn
    // asks first when it holds edits); a copy from before accounts is adopted
    // when this account is the server's tenancy owner; otherwise the copy is
    // set aside (never discarded) and this account's own set-aside copy comes
    // back, or an empty one ready to pull.
    // Returns {action: 'same'|'claimed'|'adopted'|'restored'|'fresh', setAside}.
    async switchAccount({ url, userId, username = null, serverId = null, tenancyOwner = false, previousUsername = null }) {
        await ensureLoaded();
        await applyPendingRemovals();
        const target = accountOf({ url, userId, username, serverId });
        if (state.owner && sameAccount(state.owner, target)) {
            const next = {
                ...state.owner,
                username: username || state.owner.username,
                serverId: state.owner.serverId || target.serverId
            };
            if (next.username !== state.owner.username || next.serverId !== state.owner.serverId) {
                state.owner = next;
                await persistNow();
            }
            return { action: 'same', setAside: null };
        }
        if (!state.owner && (state.origin === 'local' || tenancyOwner)) {
            const action = state.origin === 'local' ? 'claimed' : 'adopted';
            state.owner = target;
            state.origin = null;
            await persistNow();
            return { action, setAside: null };
        }
        const setAside = await stashCurrent({ fallbackUrl: target.url, username: previousUsername });
        const restored = await takeStashFor(target)
            || (tenancyOwner ? await takeStashFor(target, { legacy: true }) : null);
        await loadCopy(restored, target);
        return { action: restored ? 'restored' : 'fresh', setAside };
    },

    // Set this copy aside and start an empty one for the signed-in account,
    // ready to pull. The answer to a 412: never pull over the copy (that
    // discards it) and never force it (that writes it into this account).
    async setAsideAndReset({ url, userId, username = null, serverId = null }) {
        await ensureLoaded();
        await applyPendingRemovals();
        const setAside = await stashCurrent({ fallbackUrl: url });
        await loadCopy(null, accountOf({ url, userId, username, serverId }));
        return { setAside };
    },

    // With `account`, each copy also says whether that account may restore
    // it: `match` is 'same', 'moved' (its own, apparently on the same server
    // at a new address — confirm first) or null. `stamps` are the stamps it
    // answers to — its own, then those it was set aside under before — which
    // is what a note draft parked with it goes by.
    async listStashes(account = null) {
        const keys = await stashIndex();
        if (!keys.length) return [];
        const data = await api.storage.local.get(keys);
        return keys.filter(k => data[k]).map(k => {
            const s = data[k];
            return {
                key: k,
                url: s.url,
                userId: s.owner ? s.owner.userId : null,
                username: s.username || (s.owner && s.owner.username) || null,
                origin: originOf(s),
                dirty: Boolean(s.dirty),
                editCount: s.dirty ? Math.max(1, Number(s.editCount) || 0) : 0,
                items: countItems(s.roots),
                setAsideAt: s.setAsideAt,
                stamps: stampsIn([stampOf(s), ...stampsIn(s.restoredFrom)]),
                match: account ? stashMatch(s, account) : null
            };
        });
    },

    // Bring a set-aside copy back. Only for the account it belongs to (see
    // stashMatch); one from what looks like the same server at a new address
    // only with `moved`, once the user has said it is. Whatever is current is
    // set aside in its place, so a restore never discards anything either.
    async restoreStash(key, { url, userId, username = null, serverId = null, tenancyOwner = false }, { moved = false } = {}) {
        await ensureLoaded();
        const data = await api.storage.local.get(key);
        const stash = data && data[key];
        if (!stash) throw new Error('That set-aside copy is gone.');
        const target = accountOf({ url, userId, username, serverId });
        const match = stashMatch(stash, { ...target, tenancyOwner });
        if (!match || (match === 'moved' && !moved)) throw new Error('Sign in as the account this copy belongs to first.');
        await applyPendingRemovals();
        const setAside = await stashCurrent({ fallbackUrl: target.url });
        await takeStash(key);
        await loadCopy(stash, target);
        return { setAside };
    },

    async discardStash(key) {
        await takeStash(key);
    },

    async exportStashHtml(key) {
        const data = await api.storage.local.get(key);
        const stash = data && data[key];
        if (!stash) throw new Error('That set-aside copy is gone.');
        return bookmarksHtml(stash.roots);
    },

    // The raw node (not a view). Do not mutate what this returns.
    async getNode(id) {
        await ensureLoaded();
        const e = index.get(String(id));
        return e ? e.node : null;
    },

    async isReadOnly(id) {
        await ensureLoaded();
        return inVirtual(id);
    },

    // The first folder carrying this role, anywhere in the tree.
    async findRoleRoot(role) {
        await ensureLoaded();
        for (const [, e] of index) {
            if (e.node.kind === 'folder' && e.node.role === role) return e.node;
        }
        return null;
    },

    // Same, creating a top-level folder when it does not exist yet.
    async ensureRoleRoot(role) {
        await ensureLoaded();
        const existing = await TreeStore.findRoleRoot(role);
        if (existing) return existing;
        const node = makeNode({ kind: 'folder', title: ROLE_DEFAULT_TITLE[role] || role, role });
        return insertNode(node, null);
    },

    // Node-level API for the managers (notes, pins, workflows).
    async createNode({ parentId, kind, title, url, payload, index: at }) {
        await ensureLoaded();
        if (!isTopLevelParent(parentId)) assertWritable(parentId);
        return insertNode(makeNode({ kind, title, url, payload }), parentId, at);
    },

    async updateNode(id, { title, url, payload }) {
        await ensureLoaded();
        assertWritable(id);
        const e = entry(id);
        if (title !== undefined) e.node.title = String(title);
        if (url !== undefined && e.node.kind === 'bookmark') e.node.url = String(url);
        if (payload !== undefined) e.node.payload = payload;
        markDirty();
        emit('changed');
        return e.node;
    },

    async moveNode(id, { parentId, index: at }) {
        await ensureLoaded();
        assertWritable(id);
        if (!isTopLevelParent(parentId)) assertWritable(parentId);
        const e = entry(id);
        // Refuse moving a folder into itself or a descendant.
        if (e.node.kind === 'folder' && !isTopLevelParent(parentId)) {
            let p = entry(parentId);
            while (p) {
                if (p.node.id === e.node.id) throw new Error('Cannot move a folder into itself.');
                p = p.parent ? entry(p.parent.id) : null;
            }
        }
        detach(id);
        reindex();
        const siblings = siblingsOf(parentId);
        const idx = (at === undefined || at === null || at < 0 || at > siblings.length) ? siblings.length : at;
        siblings.splice(idx, 0, e.node);
        reindex();
        markDirty();
        emit('moved');
        return e.node;
    },

    async removeNode(id) {
        await ensureLoaded();
        assertWritable(id);
        detach(id);
        reindex();
        markDirty();
        emit('removed');
    },

    // --- Sync ---------------------------------------------------------------

    sync: {
        async health(config) {
            const res = await fetch(trim(config.url) + '/api/health');
            return res.json();
        },

        async serverVersion(config) {
            const body = await apiFetch(config, '/api/tree/version');
            return body.version;
        },

        // Replace the working copy with the server's tree. Discards local
        // unpushed edits — callers confirm with the user when status().dirty.
        // But only the account's own: when the tree is another account's than
        // the copy's (callers set that aside first, but one may not know who
        // it is signed in as), the copy is set aside here and the tree comes
        // into a new one — `setAside` is its stash key.
        //
        // Two ways it stops having written nothing, rejecting with err.code:
        // 'account-changed' when another page brought another copy in while
        // it waited on the server (that copy is never replaced), and
        // 'account-unconfirmed' when whose copy this is was the server's to
        // say and it did not answer (the copy is never set aside on a guess).
        async pull(config) {
            await ensureLoaded();
            const started = currentCopy();
            const body = await apiFetch(config, '/api/tree');
            if (!stillCopy(started)) throw pullStopped('account-changed');
            const owner = ownerFrom(config, body.userId, body.serverId);
            const plan = await pullPlan(config, owner);
            if (!stillCopy(started)) throw pullStopped('account-changed');
            if (plan === 'unconfirmed') throw pullStopped('account-unconfirmed');
            let setAside = null;
            if (plan === 'aside') {
                await applyPendingRemovals();
                if (!stillCopy(started)) throw pullStopped('account-changed');
                setAside = await stashCurrent({ fallbackUrl: owner.url });
                // The copy is in its stash now. If another one came in
                // meanwhile, no fresh copy replaces it.
                if (!stillCopy(started)) throw pullStopped('account-changed', setAside);
                const fresh = await loadCopy(null, owner);
                if (!stillCopy(fresh)) throw pullStopped('account-changed', setAside);
            }
            state.roots = Array.isArray(body.roots) ? body.roots : [];
            state.baseVersion = Number(body.version) || 0;
            state.dirty = false;
            state.editCount = 0;
            state.owner = owner;
            state.lastSyncAt = new Date().toISOString();
            state.lastSyncKind = 'pull';
            reindex();
            await persistNow();
            emit('pull');
            return { version: state.baseVersion, setAside };
        },

        // Replace the server's tree with the working copy. Refused with a
        // conflict error when the server moved on since our last pull, and
        // with a 412 (err.code) when the copy belongs to another account —
        // which the server checks against baseUserId, baseServerId and the
        // pushed ids.
        async push(config, { force = false } = {}) {
            await ensureLoaded();
            const body = await apiFetch(config, '/api/tree', {
                method: 'PUT',
                body: JSON.stringify({
                    roots: stripVirtual(state.roots),
                    baseVersion: state.baseVersion,
                    ...(state.owner ? { baseUserId: state.owner.userId } : {}),
                    ...(state.owner && state.owner.serverId ? { baseServerId: state.owner.serverId } : {}),
                    deviceId: 'extension',
                    force
                })
            });
            state.baseVersion = Number(body.version) || state.baseVersion + 1;
            state.dirty = false;
            state.editCount = 0;
            state.owner = ownerFrom(config, body.userId, body.serverId);
            state.lastSyncAt = new Date().toISOString();
            state.lastSyncKind = 'push';
            await persistNow();
            emit('push');
            return { version: state.baseVersion };
        }
    },

    // --- Import-archive verbs -------------------------------------------------
    //
    // The imports subtree is read-only as a tree, but two gestures on it are
    // real features: deleting an archived item (tombstoned server-side so a
    // sweep cannot resurrect it) and filing one into your own tree (a copy is
    // created locally and the archive stops drawing it). Both go through
    // explicit server verbs instead of being inferred from a pushed tree.
    imports: {
        // Node ids in the virtual subtree are `imp:<sourceId>:<externalId>`.
        parse(id) {
            const m = String(id).match(/^imp:(\d+):(.+)$/);
            return m ? { sourceId: m[1], externalId: m[2] } : null;
        },

        async deleteItems(config, nodeIds) {
            await ensureLoaded();
            const bySource = new Map();
            for (const id of nodeIds) {
                const p = TreeStore.imports.parse(id);
                if (!p) continue;
                if (!bySource.has(p.sourceId)) bySource.set(p.sourceId, []);
                bySource.get(p.sourceId).push({ id, externalId: p.externalId });
            }
            let removed = 0;
            for (const [sourceId, items] of bySource) {
                await apiFetch(config, `/api/imports/${sourceId}/items/delete`, {
                    method: 'POST',
                    body: JSON.stringify({ externalIds: items.map(i => i.externalId) })
                });
                // Server accepted — mirror it locally so the row disappears now
                // rather than on the next pull. Not a dirty edit: virtual nodes
                // are never pushed anyway.
                for (const it of items) {
                    try { detach(it.id); } catch (e) { /* already gone locally */ }
                    removed++;
                }
            }
            reindex();
            schedulePersist();
            emit('removed');
            return removed;
        },

        async fileItems(config, nodeIds, targetFolderId) {
            await ensureLoaded();
            assertWritable(targetFolderId);
            const bySource = new Map();
            for (const id of nodeIds) {
                const p = TreeStore.imports.parse(id);
                if (!p) continue;
                const e = index.get(String(id));
                if (!e) continue;
                if (!bySource.has(p.sourceId)) bySource.set(p.sourceId, []);
                bySource.get(p.sourceId).push({ id, externalId: p.externalId, title: e.node.title, url: e.node.url });
            }
            let filed = 0;
            for (const [sourceId, items] of bySource) {
                await apiFetch(config, `/api/imports/${sourceId}/items/file`, {
                    method: 'POST',
                    body: JSON.stringify({ externalIds: items.map(i => i.externalId) })
                });
                for (const it of items) {
                    const siblings = siblingsOf(targetFolderId);
                    siblings.push(makeNode({ kind: 'bookmark', title: it.title, url: it.url }));
                    try { detach(it.id); } catch (e) { /* already gone locally */ }
                    filed++;
                }
            }
            reindex();
            markDirty();
            emit('moved');
            return filed;
        }
    },

    // Import this browser's own bookmarks into the working copy, as a named
    // folder inside Bookmarks — "Chrome bookmarks", "Firefox bookmarks" — so
    // it is obvious later where a collection came from, and so importing from
    // a second browser does not merge into the first. The browser's own
    // bookmarks are read once and never written.
    async importFromBrowser() {
        await ensureLoaded();
        const tree = await api.bookmarks.getTree();
        const root = tree[0];
        const host = await TreeStore.ensureRoleRoot('bookmarks');
        const folder = makeNode({
            kind: 'folder',
            title: `${browserName()} bookmarks`
        });
        let count = 0;
        for (const browserRoot of root.children || []) {
            const converted = convertBrowserNode(browserRoot);
            if (!converted || (converted.kind === 'folder' && converted.children.length === 0)) continue;
            folder.children.push(converted);
            count++;
        }
        if (!folder.children.length) return { imported: 0 };
        // A second import from the same browser gets its own dated folder
        // rather than silently merging into, or replacing, the first.
        const taken = new Set((host.children || []).map(c => c.title));
        if (taken.has(folder.title)) {
            folder.title = `${folder.title} (${new Date().toISOString().slice(0, 10)})`;
            let n = 2;
            while (taken.has(folder.title)) folder.title = `${browserName()} bookmarks (${n++})`;
        }
        insertNode(folder, host.id);
        const walkCount = (n) => 1 + (n.children || []).reduce((s, c) => s + walkCount(c), 0);
        return { imported: walkCount(folder) - 1, folderId: folder.id };
    },

    // --- chrome.bookmarks-compatible facade ----------------------------------
    bookmarks: {
        async getTree() {
            await ensureLoaded();
            return [{
                id: '0',
                title: '',
                children: state.roots.map((r, i) => view(r, null, i, true))
            }];
        },

        async getSubTree(id) {
            await ensureLoaded();
            // Legacy browser-root ids ('0','1','2') still arrive from old
            // persisted settings and hard-coded fallbacks; all of them mean
            // "the top level" now, on reads as well as writes.
            if (isTopLevelParent(id)) {
                return [{
                    id: String(id ?? '0'),
                    title: 'All bookmarks',
                    kind: 'folder',
                    children: state.roots.map((r, i) => view(r, null, i, true))
                }];
            }
            return [viewOf(id, true)];
        },

        async get(idOrIds) {
            await ensureLoaded();
            const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
            return ids.map(id => isTopLevelParent(id)
                ? { id: String(id ?? '0'), parentId: '0', index: 0, title: '', kind: 'folder' }
                : viewOf(id, false));
        },

        async getChildren(id) {
            await ensureLoaded();
            if (isTopLevelParent(id)) return state.roots.map((r, i) => view(r, null, i, false));
            const e = entry(id);
            if (e.node.kind !== 'folder') return [];
            return (e.node.children || []).map((c, i) => view(c, e.node, i, false));
        },

        // Exact-field matching on title, substring on a plain query — enough
        // for every call site this app has.
        async search(query) {
            await ensureLoaded();
            const results = [];
            const q = typeof query === 'string' ? query.toLowerCase() : null;
            for (const [, e] of index) {
                const n = e.node;
                if (q !== null) {
                    const hay = (n.title + ' ' + (n.url || '')).toLowerCase();
                    if (hay.includes(q)) results.push(view(n, e.parent, e.index, false));
                } else if (query && query.title !== undefined) {
                    if (n.title === query.title) results.push(view(n, e.parent, e.index, false));
                }
            }
            return results;
        },

        async create({ parentId, title, url, index: at }) {
            await ensureLoaded();
            if (!isTopLevelParent(parentId)) assertWritable(parentId);
            let node;
            if (url && url.startsWith(DATA_PREFIX)) {
                const p = decodePayloadUrl(url) || {};
                delete p.v;
                node = makeNode({ kind: 'note', title, payload: p });
            } else if (url) {
                node = makeNode({ kind: 'bookmark', title: title || url, url });
            } else {
                node = makeNode({ kind: 'folder', title });
            }
            insertNode(node, parentId, at);
            return viewOf(node.id, false);
        },

        async update(id, { title, url }) {
            await ensureLoaded();
            assertWritable(id);
            const e = entry(id);
            if (title !== undefined) e.node.title = String(title);
            if (url !== undefined) {
                if (e.node.kind === 'note' && url.startsWith(DATA_PREFIX)) {
                    const p = decodePayloadUrl(url) || {};
                    delete p.v;
                    e.node.payload = p;
                } else if (e.node.kind === 'bookmark') {
                    e.node.url = String(url);
                }
            }
            markDirty();
            emit('changed');
            return viewOf(id, false);
        },

        async move(id, { parentId, index: at }) {
            await TreeStore.moveNode(id, { parentId, index: at });
            return viewOf(id, false);
        },

        async remove(id) {
            await ensureLoaded();
            const e = entry(id);
            if (e.node.kind === 'folder' && (e.node.children || []).length) {
                throw new Error('Folder is not empty — use removeTree.');
            }
            await TreeStore.removeNode(id);
        },

        async removeTree(id) {
            await TreeStore.removeNode(id);
        }
    }
};
