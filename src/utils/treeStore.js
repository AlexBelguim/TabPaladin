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
//
// Every extension page (the side panel, the app tab) runs its own instance of
// this module over the one working copy in storage. So everything that reads
// the copy and then replaces or re-stamps it — a pull, a push, switching
// accounts, setting a copy aside, restoring or discarding one, and writing
// edits — runs under one lock that all pages share (withCopyLock), and starts
// by reading the copy from storage rather than trusting memory (reconcile):
// another page's switch is seen even before its storage event arrives here.
// Network waits happen outside the lock; what a pull or push saw before
// waiting is checked again under it before anything is written, and when
// the copy is another one now, or was edited meanwhile, nothing is replaced
// or marked pushed (see copyToken/sameCopy). Callers that asked the user
// about one copy pass that copy along (`expect`), so the answer is never
// applied to another.
//
// A link filed from the phone's share sheet goes straight into the server's
// tree as a small append. A push that meets a 409 because of such links only
// folds them into this copy and goes again (sync.pushFolding), under the same
// lock and copy checks as a pull; any other conflict is the caller's to ask
// about, as before.
//
// Edits stay instant and in memory and are written on a short debounce,
// under the same lock. Until written, each is also kept as a step that can be
// applied again: when another page wrote this copy first (an edit, a pull, a
// push), the steps are applied again on top of what it wrote; when another
// page brought another copy in, they go to the copy they were made in, which
// was set aside (adoptStored, saveOrphan). An edit is never written over
// another page's copy, and never lost to one.

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
    rev: null,          // stamp of the stored version this memory holds (last write here or adopted)
    seq: 0,             // that version's place in line: every write is one more than the one before
    baseId: null        // new with each pull, push and copy: edits since then are this copy's own
};

// Edits made here and not written yet, each as a step that applies it again
// (see recordEdit). Cleared by a write.
let pendingOps = [];
// How many writes from other pages this page has taken in.
let adoptedWrites = 0;

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
    const step = removeStep(list.map(String));
    const removed = step();
    try { await api.storage.local.remove(PENDING_REMOVALS_KEY); } catch (e) { /* retried next load */ }
    if (removed) {
        recordEdit(step);
        emit('removed');
    }
}

// The copy as stored (or as another page's storage event carries it) into
// memory.
function applyStored(stored) {
    state.baseVersion = Number(stored.baseVersion) || 0;
    state.roots = Array.isArray(stored.roots) ? stored.roots : [];
    state.dirty = Boolean(stored.dirty);
    state.lastSyncAt = stored.lastSyncAt || null;
    state.lastSyncKind = stored.lastSyncKind || null;
    state.owner = stored.owner || null;
    state.origin = originOf(stored);
    state.editCount = Number(stored.editCount) || (state.dirty ? 1 : 0);
    state.copyId = stored.copyId || null;
    state.restoredFrom = stampsIn(stored.restoredFrom);
    state.rev = stored.rev || null;
    state.seq = Number(stored.seq) || 0;
    state.baseId = stored.baseId || null;
    state.loaded = true;
    reindex();
}

let loadPromise = null;
async function ensureLoaded() {
    if (state.loaded) return;
    if (!loadPromise) {
        loadPromise = (async () => {
            const data = await api.storage.local.get(STORE_KEY);
            const stored = data && data[STORE_KEY];
            // A storage event may have brought a later version meanwhile.
            if (!state.loaded) {
                if (stored && Array.isArray(stored.roots)) {
                    applyStored(stored);
                } else {
                    // Nothing here yet: whatever is made before someone signs
                    // in belongs to nobody so far.
                    state.origin = 'local';
                    reindex();
                    state.loaded = true;
                }
            }
            await applyPendingRemovals();
        })();
    }
    return loadPromise;
}

// --- The lock, and writing --------------------------------------------------

const LOCK_NAME = 'tp-working-copy';
let lockChain = Promise.resolve();

// Run `fn` holding the working-copy lock. Web Locks are shared by every page
// of the extension, in Chrome and Firefox alike; where they are missing, a
// promise chain still keeps this page's own operations in line. Not
// re-entrant: nothing that runs under the lock may ask for it again.
function withCopyLock(fn) {
    const locks = typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function'
        ? navigator.locks : null;
    if (locks) return locks.request(LOCK_NAME, () => fn());
    const run = lockChain.then(() => fn());
    lockChain = run.catch(() => {});
    return run;
}

function record() {
    return {
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
        rev: state.rev,
        seq: state.seq,
        baseId: state.baseId
    };
}

// Persist with a small debounce so a burst of edits (recreating a folder,
// applying an organiser proposal) serializes the tree once, not per node.
let persistTimer = null;
function schedulePersist() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
        persistTimer = null;
        withCopyLock(reconcile).catch((e) => console.warn('[TabPaladin] Failed to persist tree', e));
    }, 150);
}

// Write the copy in memory. Under the lock only, after reconcile: what it
// replaces in storage is then what this page last saw there.
async function writeCopy() {
    if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
    }
    const ops = pendingOps;
    const prev = { rev: state.rev, seq: state.seq };
    pendingOps = [];
    state.rev = newId();
    state.seq = prev.seq + 1;
    try {
        await api.storage.local.set({ [STORE_KEY]: record() });
    } catch (e) {
        // Not written, so still this page's to write.
        state.rev = prev.rev;
        state.seq = prev.seq;
        pendingOps = [...ops, ...pendingOps];
        console.warn('[TabPaladin] Failed to persist tree', e);
    }
}

// Bring this page up to the copy in storage before acting on it — another
// page may have written it, or brought another copy in, and its storage event
// may not have arrived yet — then write this page's own unwritten edits.
// Under the lock only.
async function reconcile() {
    await ensureLoaded();
    let stored = null;
    try {
        const data = await api.storage.local.get(STORE_KEY);
        stored = (data && data[STORE_KEY]) || null;
    } catch (e) { /* storage unreadable: memory is all there is */ }
    if (stored && (stored.rev || null) !== state.rev) {
        const orphan = adoptStored(stored);
        if (orphan) await saveOrphan(orphan);
    }
    if (pendingOps.length) await writeCopy();
}

// Take in a version of the copy that another page wrote. This page's
// unwritten edits are made again on top of it when it is the same copy; when
// it is another copy, they belong to the one they were made in, and come back
// for saveOrphan to put with it. Listeners hear 'switch' for another copy,
// as the page that brought it in did, and 'external' otherwise.
function adoptStored(stored) {
    const switched = state.loaded && (stored.copyId || null) !== state.copyId;
    const ops = pendingOps;
    pendingOps = [];
    if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
    }
    const orphan = switched && ops.length ? { copyId: state.copyId, rev: state.rev, ops, copy: record() } : null;
    applyStored(stored);
    adoptedWrites++;
    if (!switched && ops.length) {
        const { kept, applied } = replay(ops);
        pendingOps = kept;
        if (applied) {
            state.dirty = true;
            state.editCount += applied;
        }
        if (kept.length) schedulePersist();
    }
    emit(switched ? 'switch' : 'external');
    return orphan;
}

// Make these edits again on the tree in state now. Returns those that changed
// something, and how many of them count as edits.
function replay(ops) {
    const kept = [];
    let applied = 0;
    for (const op of ops) {
        let changed = false;
        try { changed = op.step() !== false; } catch (e) { changed = false; }
        if (!changed) continue;
        kept.push(op);
        if (op.dirty) applied++;
    }
    reindex();
    return { kept, applied };
}

// The same, on another tree (a set-aside copy's), leaving state as it was.
function replayOnto(roots, ops) {
    const saved = { roots: state.roots, index };
    state.roots = roots;
    reindex();
    try {
        const { applied } = replay(ops);
        return { roots: state.roots, applied };
    } finally {
        state.roots = saved.roots;
        index = saved.index;
    }
}

// Edits made here to a copy that another page has since set aside go to that
// copy where it waits (the set-aside copy made from it), or, when it is not
// there any more, into a set-aside copy of their own: never into the copy
// that came in, and never dropped. Under the lock only.
async function saveOrphan(orphan) {
    const keys = await stashIndex();
    const data = keys.length ? await api.storage.local.get(keys) : {};
    const key = keys.find(k => data[k] && orphan.copyId && data[k].copyId === orphan.copyId)
        || keys.find(k => data[k] && orphan.rev && data[k].fromRev === orphan.rev);
    if (key) {
        const stash = data[key];
        const { roots, applied } = replayOnto(Array.isArray(stash.roots) ? stash.roots : [], orphan.ops);
        await api.storage.local.set({
            [key]: {
                ...stash,
                roots,
                dirty: Boolean(stash.dirty) || applied > 0,
                editCount: (Number(stash.editCount) || 0) + applied
            }
        });
        return key;
    }
    const settings = await readSettings();
    return writeStash(orphan.copy, { fallbackUrl: (settings.backend && settings.backend.url) || '' });
}

// Another page wrote the tree, or brought another copy in: take it in.
if (api.storage && api.storage.onChanged) {
    api.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        // The background queued a removal while this page holds the tree.
        if (changes[PENDING_REMOVALS_KEY] && changes[PENDING_REMOVALS_KEY].newValue && state.loaded) {
            applyPendingRemovals();
        }
        if (!changes[STORE_KEY]) return;
        const next = changes[STORE_KEY].newValue;
        if (!next || (next.rev || null) === state.rev) return;
        // Older than what this page already read from storage under the lock:
        // the event arrived after that read.
        if (Number(next.seq) > 0 && Number(next.seq) < state.seq) return;
        const orphan = adoptStored(next);
        if (orphan) {
            withCopyLock(() => saveOrphan(orphan))
                .catch((e) => console.warn('[TabPaladin] Could not keep edits to a copy set aside elsewhere', e));
        }
    });
}

// --- Edits, kept as steps until written ----------------------------------------
//
// Each edit is made at once, and also kept as a step that makes it again on
// whatever tree is in state.roots when the step runs: this copy as another
// page wrote it, or the set-aside copy it was made in (see adoptStored). A
// step says whether it changed anything; what is no longer there is skipped,
// and a new item whose folder is gone is kept at the top level, not dropped.

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function clampAt(at, length) {
    return (at === undefined || at === null || at < 0 || at > length) ? length : at;
}

function recordEdit(step, { dirty = true } = {}) {
    pendingOps.push({ step, dirty });
    if (dirty) {
        state.dirty = true;
        state.editCount++;
    }
    schedulePersist();
}

function insertStep(node, parentId, at) {
    const saved = clone(node);
    return () => {
        if (index.has(saved.id)) return false;
        const top = isTopLevelParent(parentId);
        const parent = top ? null : index.get(String(parentId));
        const intoParent = Boolean(parent) && parent.node.kind === 'folder' && !inVirtual(parent.node.id);
        const siblings = intoParent ? (parent.node.children = parent.node.children || []) : state.roots;
        siblings.splice(top || intoParent ? clampAt(at, siblings.length) : siblings.length, 0, clone(saved));
        reindex();
        return true;
    };
}

function changeStep(id, apply) {
    return () => {
        const e = index.get(String(id));
        if (!e || inVirtual(id)) return false;
        apply(e.node);
        return true;
    };
}

function moveStep(id, parentId, at) {
    return () => {
        const e = index.get(String(id));
        if (!e || inVirtual(id)) return false;
        let siblings = state.roots;
        if (!isTopLevelParent(parentId)) {
            const p = index.get(String(parentId));
            if (!p || p.node.kind !== 'folder' || inVirtual(parentId)) return false;
            for (let q = p; q; q = q.parent ? index.get(q.parent.id) : null) {
                if (q.node.id === e.node.id) return false;
            }
            siblings = p.node.children = p.node.children || [];
        }
        detach(id);
        siblings.splice(clampAt(at, siblings.length), 0, e.node);
        reindex();
        return true;
    };
}

// Removes the items with these ids: the user's own, or with `virtual` only
// rows of the imports archive.
function removeStep(ids, { virtual = false } = {}) {
    return () => {
        let n = 0;
        for (const id of ids) {
            if (!index.has(String(id)) || inVirtual(id) !== virtual) continue;
            detach(id);
            n++;
        }
        if (n) reindex();
        return n > 0;
    };
}

function applyFields(node, { title, url, payload }) {
    if (title !== undefined) node.title = String(title);
    if (url !== undefined && node.kind === 'bookmark') node.url = String(url);
    if (payload !== undefined) node.payload = payload;
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
    siblings.splice(clampAt(at, siblings.length), 0, node);
    reindex();
    recordEdit(insertStep(node, parentId, at));
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

// The account a pull or push answered for, keeping what `current` (the copy's
// stamp) knew of it. A server too old to say keeps `current`.
function ownerFrom(config, userId, serverId = null, current = state.owner) {
    if (userId === undefined || userId === null) return current;
    const prev = current && Number(current.userId) === Number(userId) ? current : null;
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
async function pullPlan(config, owner, copy) {
    if (!owner) return 'into';
    if (copy.owner) return sameAccount(copy.owner, owner) ? 'into' : 'aside';
    if (copy.origin === 'local' || (copy.isEmpty && !copy.dirty)) return 'into';
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

// The working copy as an operation found it, read under the lock: which copy,
// whose, and which version of it. A pull or push holds on to it across its
// network wait and checks it again before writing; callers that asked the
// user about a copy hand it back (`expect`), so that the answer is applied
// to that copy and no other.
function copyToken() {
    return {
        copyId: state.copyId,
        owner: state.owner ? { ...state.owner } : null,
        origin: state.owner ? null : state.origin,
        rev: state.rev,
        seq: state.seq,
        baseId: state.baseId,
        baseVersion: state.baseVersion,
        editCount: state.editCount,
        dirty: state.dirty,
        isEmpty: state.roots.length === 0,
        adopted: adoptedWrites
    };
}

// Two tokens for the same copy: the same copyId, stamped with the same
// account, or both unstamped. Another page bringing another copy in gives it
// a new copyId; stamping an unstamped one (claimed, adopted) changes its owner.
function sameCopy(a, b) {
    if (!a || !b || (a.copyId || null) !== (b.copyId || null)) return false;
    if (!a.owner || !b.owner) return !a.owner && !b.owner;
    return sameAccount(a.owner, b.owner);
}

// Why an operation stopped without changing anything. `code` is for callers;
// the message is for the user.
const STOPPED = {
    'account-changed': 'Account changed during pull — nothing was replaced.',
    'edited-during-pull': 'Changed during pull — nothing was replaced; pull again.',
    'account-unconfirmed': 'Couldn’t confirm the account — try again. Nothing was changed.'
};

function stopped(code, message = STOPPED[code], setAside = null) {
    const err = new Error(message);
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
// its key, or null when there was nothing to keep. Under the lock only.
async function stashCurrent({ fallbackUrl, username = null } = {}) {
    // What is set aside is what is stored: the version another page's
    // unwritten edits go looking for (saveOrphan).
    if (pendingOps.length) await writeCopy();
    if (!state.roots.length && !state.dirty) return null;
    const settings = await readSettings();
    let pendingRemovals = [];
    try {
        pendingRemovals = ((await api.storage.local.get(PENDING_REMOVALS_KEY)) || {})[PENDING_REMOVALS_KEY] || [];
    } catch (e) { /* nothing queued */ }
    let expanded = {};
    try { expanded = await ExpandState.entriesFor((id) => index.has(id)); } catch (e) { /* UI state only */ }
    const key = await writeStash(record(), {
        fallbackUrl, username, focusedFolderIds: settings.focusedFolderIds || [], expanded, pendingRemovals
    });
    if (pendingRemovals.length) await api.storage.local.remove(PENDING_REMOVALS_KEY);
    return key;
}

// A set-aside copy of `copy` (as record() gives it). It says which copy it was
// made from, and from which stored version of it, for saveOrphan.
async function writeStash(copy, { fallbackUrl, username = null, focusedFolderIds = [], expanded = {}, pendingRemovals = [] } = {}) {
    const keys = await stashIndex();
    const base = stashKeyFor(copy.owner, fallbackUrl);
    let key = base;
    for (let n = 0; keys.includes(key); n++) key = `${base}#${Date.now()}${n ? `-${n}` : ''}`;
    const owner = copy.owner ? { ...copy.owner, username: copy.owner.username || username } : null;
    await api.storage.local.set({
        [key]: {
            roots: copy.roots,
            baseVersion: copy.baseVersion,
            dirty: copy.dirty,
            editCount: copy.editCount,
            lastSyncAt: copy.lastSyncAt,
            owner,
            origin: owner ? null : copy.origin,
            url: trim(owner ? owner.url : fallbackUrl),
            username: owner ? owner.username : username,
            setAsideAt: new Date().toISOString(),
            focusedFolderIds,
            expanded,
            pendingRemovals,
            restoredFrom: copy.restoredFrom,
            copyId: copy.copyId || null,
            fromRev: copy.rev || null
        },
        [STASH_INDEX_KEY]: [...keys, key]
    });
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
// copy it made (see copyToken). Under the lock only.
async function loadCopy(stash, owner) {
    // Edits made here to the outgoing copy after it was set aside go with it.
    const orphan = pendingOps.length ? { copyId: state.copyId, rev: state.rev, ops: pendingOps, copy: record() } : null;
    pendingOps = [];
    if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
    }
    state.copyId = newId();
    state.roots = stash ? stash.roots || [] : [];
    state.baseVersion = stash ? Number(stash.baseVersion) || 0 : 0;
    state.dirty = stash ? Boolean(stash.dirty) : false;
    state.editCount = stash ? Number(stash.editCount) || 0 : 0;
    state.lastSyncAt = stash ? stash.lastSyncAt || null : null;
    state.lastSyncKind = null;
    state.owner = owner;
    state.origin = null;
    state.restoredFrom = stash ? stampsIn([stampOf(stash), ...stampsIn(stash.restoredFrom)]) : [];
    state.baseId = newId();
    reindex();
    if (orphan) await saveOrphan(orphan);
    const settings = await readSettings();
    await api.storage.local.set({ [SETTINGS_KEY]: { ...settings, focusedFolderIds: stash ? stash.focusedFolderIds || [] : [] } });
    if (stash && stash.expanded) {
        try { await ExpandState.restore(stash.expanded); } catch (e) { /* UI state only */ }
    }
    if (stash && (stash.pendingRemovals || []).length) {
        await api.storage.local.set({ [PENDING_REMOVALS_KEY]: stash.pendingRemovals });
        await applyPendingRemovals();
    }
    await writeCopy();
    emit('switch');
    return copyToken();
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

// --- Links filed from a share sheet, folded into the copy -------------------
//
// The phone files a shared link straight into the server's tree, as a small
// append, without pushing its copy; the server logs it (GET /api/tree/ops).
// When a push here meets a 409 and that log says everything the server gained
// since this copy's base is such appends (or their undo), they are added to
// this copy and the push goes again — no conflict prompt for a link filed on
// the phone. The rules are shareCore.js's applyOps (the PWA's), restated here
// because the extension cannot load from pwa/: a node already here is
// skipped; one whose folder is gone here goes to the end of the Bookmarks
// root (counted as relocated) rather than being dropped by the next push; an
// undo removes a bookmark only while it still has that URL, a folder only
// while it is empty. Not an edit of this copy's own: nothing is marked dirty.
function applyServerOps(ops) {
    const out = { applied: 0, relocated: 0, removed: 0, skipped: 0 };
    const bookmarksRoot = () => {
        for (const [, e] of index) if (e.node.kind === 'folder' && e.node.role === 'bookmarks' && !inVirtual(e.node.id)) return e.node;
        return null;
    };
    for (const op of ops || []) {
        if (op.kind === 'append') {
            for (const n of (op.payload && op.payload.nodes) || []) {
                if (!n || !n.id || index.has(String(n.id))) { out.skipped++; continue; }
                let parent = n.parentId ? index.get(String(n.parentId)) : null;
                parent = parent && parent.node.kind === 'folder' && !inVirtual(parent.node.id) ? parent.node : null;
                if (!parent) {
                    parent = bookmarksRoot();
                    out.relocated++;
                }
                const node = n.kind === 'folder'
                    ? { id: String(n.id), kind: 'folder', title: String(n.title || ''), children: [] }
                    : { id: String(n.id), kind: 'bookmark', title: String(n.title || ''), url: String(n.url || '') };
                const siblings = parent ? (parent.children = parent.children || []) : state.roots;
                siblings.push(node);
                reindex();
                out.applied++;
            }
        } else if (op.kind === 'unappend') {
            for (const it of (op.payload && op.payload.items) || []) {
                const e = it && it.id ? index.get(String(it.id)) : null;
                if (!e || inVirtual(e.node.id)) continue;
                const same = it.kind === 'bookmark'
                    ? e.node.kind === 'bookmark' && e.node.url === it.url
                    : e.node.kind === 'folder' && (e.node.children || []).length === 0;
                if (!same) continue;
                detach(e.node.id);
                reindex();
                out.removed++;
            }
        }
    }
    return out;
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
        await withCopyLock(reconcile);
    },

    // The working copy as it is in storage now, with this page's edits
    // written: a token to hand back as `expect` to sync.pull, sync.push and
    // setAsideAndReset, so that they act on this copy or stop.
    async currentCopy() {
        await ensureLoaded();
        return withCopyLock(async () => {
            await reconcile();
            return copyToken();
        });
    },

    // Are two tokens (from currentCopy, or carried by a result or an error)
    // the same copy? See sameCopy.
    sameCopy(a, b) {
        return sameCopy(a, b);
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
    // back, or an empty one ready to pull. Decided on the copy as stored
    // now, under the lock, whatever another page did since this page asked.
    // Returns {action: 'same'|'claimed'|'adopted'|'restored'|'fresh', setAside, copy}.
    async switchAccount({ url, userId, username = null, serverId = null, tenancyOwner = false, previousUsername = null }) {
        await ensureLoaded();
        return withCopyLock(async () => {
            await reconcile();
            await applyPendingRemovals();
            const target = accountOf({ url, userId, username, serverId });
            if (state.owner && sameAccount(state.owner, target)) {
                const next = {
                    ...state.owner,
                    username: username || state.owner.username,
                    serverId: state.owner.serverId || target.serverId
                };
                if (next.username !== state.owner.username || next.serverId !== state.owner.serverId || pendingOps.length) {
                    state.owner = next;
                    await writeCopy();
                }
                return { action: 'same', setAside: null, copy: copyToken() };
            }
            if (!state.owner && (state.origin === 'local' || tenancyOwner)) {
                const action = state.origin === 'local' ? 'claimed' : 'adopted';
                state.owner = target;
                state.origin = null;
                await writeCopy();
                return { action, setAside: null, copy: copyToken() };
            }
            const setAside = await stashCurrent({ fallbackUrl: target.url, username: previousUsername });
            const restored = await takeStashFor(target)
                || (tenancyOwner ? await takeStashFor(target, { legacy: true }) : null);
            const copy = await loadCopy(restored, target);
            return { action: restored ? 'restored' : 'fresh', setAside, copy };
        });
    },

    // Set this copy aside and start an empty one for the signed-in account,
    // ready to pull. The answer to a 412: never pull over the copy (that
    // discards it) and never force it (that writes it into this account).
    // With `expect`, only that copy: when another page has brought another
    // one in, nothing is set aside (err.code 'account-changed').
    // Returns {setAside, copy}: copy is the new one, for sync.pull's expect.
    async setAsideAndReset({ url, userId, username = null, serverId = null, expect = null }) {
        await ensureLoaded();
        return withCopyLock(async () => {
            await reconcile();
            if (expect && !sameCopy(copyToken(), expect)) {
                throw stopped('account-changed', 'Account changed — nothing was set aside.');
            }
            await applyPendingRemovals();
            const setAside = await stashCurrent({ fallbackUrl: url });
            const copy = await loadCopy(null, accountOf({ url, userId, username, serverId }));
            return { setAside, copy };
        });
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
        return withCopyLock(async () => {
            await reconcile();
            const data = await api.storage.local.get(key);
            const stash = data && data[key];
            if (!stash) throw new Error('That set-aside copy is gone.');
            const target = accountOf({ url, userId, username, serverId });
            const match = stashMatch(stash, { ...target, tenancyOwner });
            if (!match || (match === 'moved' && !moved)) throw new Error('Sign in as the account this copy belongs to first.');
            await applyPendingRemovals();
            const setAside = await stashCurrent({ fallbackUrl: target.url });
            await takeStash(key);
            const copy = await loadCopy(stash, target);
            return { setAside, copy };
        });
    },

    // Discard a set-aside copy for good. With `setAsideAt` (as listStashes
    // gave it), only the copy that was listed: not one set aside under the
    // same key since. Says whether it removed anything — the copy may have
    // been restored meanwhile, in this page or another.
    async discardStash(key, { setAsideAt = null } = {}) {
        await ensureLoaded();
        return withCopyLock(async () => {
            const data = await api.storage.local.get(key);
            const stash = data && data[key];
            if (!stash || (setAsideAt && stash.setAsideAt !== setAsideAt)) return false;
            return Boolean(await takeStash(key));
        });
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
        applyFields(e.node, { title, url, payload });
        const saved = clone({ title, url, payload });
        recordEdit(changeStep(id, (node) => applyFields(node, clone(saved))));
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
        siblings.splice(clampAt(at, siblings.length), 0, e.node);
        reindex();
        recordEdit(moveStep(String(id), parentId, at));
        emit('moved');
        return e.node;
    },

    async removeNode(id) {
        await ensureLoaded();
        assertWritable(id);
        detach(id);
        reindex();
        recordEdit(removeStep([String(id)]));
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
        // It replaces only the copy it started on, as it was then: with
        // `expect` (a token from currentCopy), the copy the caller asked the
        // user about. Otherwise it stops having written nothing, rejecting
        // with err.code: 'account-changed' when another copy came in (in this
        // page or another; that copy is never replaced), 'edited-during-pull'
        // when the copy was edited, pulled or pushed while the pull waited (an
        // edit made after Pull was pressed is never discarded), and
        // 'account-unconfirmed' when whose copy this is was the server's to
        // say and it did not answer (the copy is never set aside on a guess).
        // Returns {version, setAside, copy}.
        async pull(config, { expect = null } = {}) {
            await ensureLoaded();
            const started = await withCopyLock(async () => {
                await reconcile();
                const now = copyToken();
                if (expect && !sameCopy(now, expect)) throw stopped('account-changed');
                if (expect && expect.rev !== now.rev) throw stopped('edited-during-pull');
                return now;
            });
            const body = await apiFetch(config, '/api/tree');
            const owner = ownerFrom(config, body.userId, body.serverId, started.owner);
            const plan = await pullPlan(config, owner, started);
            return withCopyLock(async () => {
                await reconcile();
                const now = copyToken();
                if (!sameCopy(now, started)) throw stopped('account-changed');
                if (now.rev !== started.rev) throw stopped('edited-during-pull');
                if (plan === 'unconfirmed') throw stopped('account-unconfirmed');
                let setAside = null;
                if (plan === 'aside') {
                    await applyPendingRemovals();
                    setAside = await stashCurrent({ fallbackUrl: owner.url });
                    await loadCopy(null, owner);
                }
                // Anything edited here since (only while the copy was being
                // set aside) is the new copy's, and stays on top.
                const ops = pendingOps;
                pendingOps = [];
                state.roots = Array.isArray(body.roots) ? body.roots : [];
                state.baseVersion = Number(body.version) || 0;
                state.dirty = false;
                state.editCount = 0;
                state.owner = owner;
                state.lastSyncAt = new Date().toISOString();
                state.lastSyncKind = 'pull';
                state.baseId = newId();
                reindex();
                if (ops.length) {
                    const { kept, applied } = replay(ops);
                    pendingOps = kept;
                    state.dirty = applied > 0;
                    state.editCount = applied;
                }
                await writeCopy();
                emit('pull');
                return { version: state.baseVersion, setAside, copy: copyToken() };
            });
        },

        // Replace the server's tree with the working copy. Refused with a
        // conflict error when the server moved on since our last pull, and
        // with a 412 (err.code) when the copy belongs to another account —
        // which the server checks against baseUserId, baseServerId and the
        // pushed ids. Either error carries `copy`: the copy that was refused,
        // for the caller's answer (pull theirs, force, set aside) to go to it
        // and no other.
        //
        // With `expect`, only that copy is pushed: when another one came in,
        // nothing is (err.code 'account-changed'). What the server says is
        // only ever applied to the copy that was pushed: when another copy is
        // here by then, or this one was pulled or pushed elsewhere meanwhile,
        // it is left as it is (`left` says why); edits made to it during the
        // push stay unpushed edits, on top of the version pushed.
        // Returns {version, copy, left, message}.
        async push(config, { force = false, expect = null } = {}) {
            await ensureLoaded();
            const started = await withCopyLock(async () => {
                await reconcile();
                const now = copyToken();
                if (expect && !sameCopy(now, expect)) throw stopped('account-changed', 'Account changed — nothing was pushed.');
                const payload = JSON.stringify({
                    roots: stripVirtual(state.roots),
                    baseVersion: state.baseVersion,
                    ...(state.owner ? { baseUserId: state.owner.userId } : {}),
                    ...(state.owner && state.owner.serverId ? { baseServerId: state.owner.serverId } : {}),
                    deviceId: 'extension',
                    force
                });
                return { copy: now, payload };
            });
            const { copy } = started;
            let body;
            try {
                body = await apiFetch(config, '/api/tree', { method: 'PUT', body: started.payload });
            } catch (e) {
                e.copy = copy;
                throw e;
            }
            return withCopyLock(async () => {
                await reconcile();
                const now = copyToken();
                const version = Number(body.version) || copy.baseVersion + 1;
                if (!sameCopy(now, copy)) {
                    return { version, copy: now, left: 'account-changed', message: 'The working copy here is another account’s now, so it was left as it is.' };
                }
                if (now.baseId !== copy.baseId) {
                    return { version, copy: now, left: 'synced', message: 'The working copy here was pulled or pushed elsewhere meanwhile, so it was left as it is.' };
                }
                const gained = now.rev === copy.rev ? 0 : Math.max(0, state.editCount - copy.editCount);
                state.baseVersion = version;
                state.dirty = gained > 0;
                state.editCount = gained;
                state.owner = ownerFrom(config, body.userId, body.serverId, state.owner);
                state.lastSyncAt = new Date().toISOString();
                state.lastSyncKind = 'push';
                state.baseId = newId();
                await writeCopy();
                emit('push');
                return { version: state.baseVersion, copy: copyToken(), left: null, message: null };
            });
        },

        // What a copy based on `since` missed, when that was only links
        // filed from a share sheet: {version, complete, ops, userId, serverId}.
        async opsSince(config, since) {
            return apiFetch(config, '/api/tree/ops?since=' + encodeURIComponent(since));
        },

        // After a push refused with a 409: fold the server's logged appends
        // into the copy that was refused (`expect`, the error's copy) and base
        // it on the server's version, so the push can go again. Only when the
        // log is complete (nothing but appends since this copy's base), only
        // for this copy's own account, and only while the copy is still the
        // one refused and still based where it was — another page's pull or
        // push meanwhile, or another copy brought in, and nothing is folded.
        // Returns {applied, relocated, removed, version, copy}, or null when
        // there is nothing to fold (the caller asks as it always has).
        async rebaseOnto(config, { expect = null } = {}) {
            await ensureLoaded();
            const started = await withCopyLock(async () => {
                await reconcile();
                const now = copyToken();
                if (expect && !sameCopy(now, expect)) throw stopped('account-changed', 'Account changed — nothing was pushed.');
                return now;
            });
            let body;
            try {
                body = await apiFetch(config, '/api/tree/ops?since=' + encodeURIComponent(started.baseVersion));
            } catch (e) {
                // A server from before the ops log: nothing to fold.
                if (e.status === 404) return null;
                throw e;
            }
            if (!body || body.complete !== true) return null;
            if (started.owner && body.userId !== undefined && body.userId !== null
                && !sameAccount(started.owner, ownerFrom(config, body.userId, body.serverId, started.owner))) return null;
            return withCopyLock(async () => {
                await reconcile();
                const now = copyToken();
                if (!sameCopy(now, started)) throw stopped('account-changed', 'Account changed — nothing was pushed.');
                if (now.baseVersion !== started.baseVersion || now.baseId !== started.baseId) return null;
                const result = applyServerOps(body.ops || []);
                state.baseVersion = Number(body.version) || state.baseVersion;
                state.baseId = newId();
                await writeCopy();
                emit('pull');
                return { ...result, version: state.baseVersion, copy: copyToken() };
            });
        },

        // push, but a 409 whose gap is only links filed from a share sheet
        // folds them in and pushes again (up to three times) before the
        // caller sees it. Returns push's result plus {folded, relocated}: how
        // many filed links came in, and how many of those went to the
        // Bookmarks root because their folder is gone here. Any other 409
        // (another device pushed) is thrown as before, with its copy.
        async pushFolding(config, { force = false, expect = null } = {}) {
            let copy = expect;
            let folded = 0;
            let relocated = 0;
            for (let attempt = 0; ; attempt++) {
                try {
                    const pushed = await TreeStore.sync.push(config, { force, expect: copy });
                    return { ...pushed, folded, relocated };
                } catch (e) {
                    if (e.status !== 409 || force || attempt >= 3) throw e;
                    // Folding is only ever a way past the 409: when it cannot
                    // be done (another copy came in meanwhile, the server is
                    // unreachable), the caller gets the 409 as it always did.
                    let r = null;
                    try { r = await TreeStore.sync.rebaseOnto(config, { expect: e.copy || copy }); } catch (e2) { r = null; }
                    if (!r) throw e;
                    folded += r.applied;
                    relocated += r.relocated;
                    copy = r.copy;
                }
            }
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
            const gone = [];
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
                    gone.push(String(it.id));
                    removed++;
                }
            }
            reindex();
            recordEdit(removeStep(gone, { virtual: true }), { dirty: false });
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
            const steps = [];
            for (const [sourceId, items] of bySource) {
                await apiFetch(config, `/api/imports/${sourceId}/items/file`, {
                    method: 'POST',
                    body: JSON.stringify({ externalIds: items.map(i => i.externalId) })
                });
                for (const it of items) {
                    const siblings = siblingsOf(targetFolderId);
                    const node = makeNode({ kind: 'bookmark', title: it.title, url: it.url });
                    siblings.push(node);
                    steps.push(insertStep(node, targetFolderId));
                    try { detach(it.id); } catch (e) { /* already gone locally */ }
                    steps.push(removeStep([String(it.id)], { virtual: true }));
                    filed++;
                }
            }
            reindex();
            recordEdit(() => steps.map(step => step()).some(Boolean));
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
            const apply = (node) => {
                if (title !== undefined) node.title = String(title);
                if (url !== undefined) {
                    if (node.kind === 'note' && url.startsWith(DATA_PREFIX)) {
                        const p = decodePayloadUrl(url) || {};
                        delete p.v;
                        node.payload = p;
                    } else if (node.kind === 'bookmark') {
                        node.url = String(url);
                    }
                }
            };
            apply(e.node);
            recordEdit(changeStep(id, apply));
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
