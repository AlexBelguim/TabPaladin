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

const api = typeof browser !== 'undefined' ? browser : chrome;

const STORE_KEY = 'tpTree';
const DATA_PREFIX = 'data:application/json,';

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
                state.rev = stored.rev || null;
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
        state.baseVersion = Number(next.baseVersion) || 0;
        state.roots = Array.isArray(next.roots) ? next.roots : [];
        state.dirty = Boolean(next.dirty);
        state.lastSyncAt = next.lastSyncAt || null;
        state.lastSyncKind = next.lastSyncKind || null;
        state.rev = next.rev || null;
        state.loaded = true;
        reindex();
        emit('external');
    });
}

function markDirty() {
    state.dirty = true;
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
        throw err;
    }
    return body;
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
            baseVersion: state.baseVersion,
            lastSyncAt: state.lastSyncAt,
            lastSyncKind: state.lastSyncKind,
            isEmpty: state.roots.length === 0
        };
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
        async pull(config) {
            await ensureLoaded();
            const body = await apiFetch(config, '/api/tree');
            state.roots = Array.isArray(body.roots) ? body.roots : [];
            state.baseVersion = Number(body.version) || 0;
            state.dirty = false;
            state.lastSyncAt = new Date().toISOString();
            state.lastSyncKind = 'pull';
            reindex();
            await persistNow();
            emit('pull');
            return { version: state.baseVersion };
        },

        // Replace the server's tree with the working copy. Refused with a
        // conflict error when the server moved on since our last pull.
        async push(config, { force = false } = {}) {
            await ensureLoaded();
            const body = await apiFetch(config, '/api/tree', {
                method: 'PUT',
                body: JSON.stringify({
                    roots: stripVirtual(state.roots),
                    baseVersion: state.baseVersion,
                    deviceId: 'extension',
                    force
                })
            });
            state.baseVersion = Number(body.version) || state.baseVersion + 1;
            state.dirty = false;
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
