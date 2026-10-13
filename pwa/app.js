// Minimal vanilla PWA for TabPaladin. Browses the server's canonical tree
// (GET /api/tree) as an in-memory working copy, edits it locally, and pushes it
// back (PUT /api/tree) git-style — a push against a tree another device changed
// since the last pull is refused until you pull or force.
// "Drop here" filing: navigate to a folder, tap the button — every link in the
// Recent-links modal is appended to the current folder, then pushed.

import { importedFolderFrom, countNodes } from './bookmarksHtml.js';
import * as NM from './notesModel.js';

const LS = {
    url: 'tp_pwa_url',
    token: 'tp_pwa_token',   // now a session token from /api/login, not a shared secret
    username: 'tp_pwa_user'
};

const state = {
    config: {
        // Falls back to wherever this PWA is served from, because that is the
        // backend — the server hosts it. Only needs setting by hand if you host
        // the PWA somewhere other than the sync server.
        url: localStorage.getItem(LS.url)
            || ((location.protocol === 'http:' || location.protocol === 'https:') ? location.origin : ''),
        token: localStorage.getItem(LS.token) || ''
    },
    snapshot: null,           // wrapper { type:'root', children: [...] } around the server's top-level folders
    treeVersion: 0,           // server tree version this working copy is based on
    pathIds: [],              // breadcrumb stack of folder identifiers (root, child, ...)
    inbox: [],                // [{id, url, title}]
    dirty: false,             // unsaved local edits to the snapshot
    view: 'home',             // 'home' (search, pins, bookmark folders) | 'notes'
    nv: freshNv(),            // notes navigation: pane, scope, open note, editor draft
    proposals: [],            // pending LLM note proposals awaiting approval
    importers: [],            // configured import sources: [{id, provider, connected, items, ...}]
    importBatch: null         // pending #notes / #reorder import awaiting review: {kind:'notes',items}|{kind:'reorder',order}
};

const $ = (id) => document.getElementById(id);

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
// Mirror the server URL and session token into Cache Storage so the service
// worker can reach the server on its own. That is what lets a shared link be
// captured without launching the app: workers cannot read localStorage, where
// the config actually lives. Called on every change, including sign-out, which
// clears it — a stale token in here would keep working after you signed out.
const SW_CONFIG_CACHE = 'tp-config';
const SW_CONFIG_KEY = '/__tp_config';

async function mirrorConfigToSW() {
    if (!('caches' in window)) return;
    try {
        const cache = await caches.open(SW_CONFIG_CACHE);
        if (!state.config.url || !state.config.token) {
            await cache.delete(SW_CONFIG_KEY);
            return;
        }
        await cache.put(SW_CONFIG_KEY, new Response(
            JSON.stringify({ url: state.config.url, token: state.config.token }),
            { headers: { 'Content-Type': 'application/json' } }
        ));
    } catch (e) {
        // Not fatal: the worker falls back to opening the app for a share.
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

async function api(path, opts = {}) {
    if (!configured()) throw new Error('Server not configured. Open Settings.');
    const res = await fetch(state.config.url.replace(/\/$/, '') + path, {
        ...opts,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + state.config.token,
            ...(opts.headers || {})
        }
    });
    if (res.status === 401) {
        // The session expired or was revoked — say so plainly and send the user
        // to sign in, rather than surfacing a bare 401 from somewhere deep in
        // the app.
        state.config.token = '';
        localStorage.removeItem(LS.token);
        setStatus('Session expired — sign in again.');
        try { refreshAuthUi(); show($('settings-sheet')); } catch (e) { /* pre-DOM */ }
        throw new Error('Signed out');
    }
    if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`${res.status} ${res.statusText}: ${t}`);
    }
    return res.json();
}

// --- Initial load ---
async function bootstrap() {
    // Existing installs already hold a token in localStorage and will never
    // sign in again, so mirror on every start rather than only on change —
    // otherwise the worker has no config and every share falls back to opening
    // the app.
    mirrorConfigToSW();

    await processShareTargetIfAny();

    if (!configured()) {
        setStatus('Open Settings (⚙) to configure your sync server.');
        // An import link stays in the URL for the reload after setup. Tag its
        // entry, so coming back to it later reads as Home, not as a new link.
        if (IMPORT_HASH_RE.test(location.hash) && !history.state) {
            history.replaceState({ tp: 'import-pending' }, '', location.href);
        }
        return;
    }
    try { await pullSnapshot(); } catch (e) { /* status already set */ }
    await refreshInbox();
    await refreshProposals();
    await checkUnfiledLinks();
    await processImportHashIfAny();
}

// Universal import link: /#note=<percent-encoded markdown>[&notebook=<name>]
// Used by LLM chats that cannot POST. The fragment never reaches the server;
// the note opens in the editor for review and is only stored when the user
// presses ✓ Done. A first-line "# " heading becomes the title, as usual.
const IMPORT_HASH_RE = /^#(note|notes|reorder)=/;

async function processImportHashIfAny() {
    const raw = location.hash.slice(1);

    // Drop the fragment so a reload cannot import twice. A link tapped while
    // the app is open arrived as a history entry of its own; it takes over
    // whatever is on screen, so back still behaves.
    const consumeHash = () => {
        if (state.view === 'notes') {
            navDepth++;
            history.replaceState(nvHistoryState(), '', location.pathname);
        } else {
            history.replaceState(null, '', location.pathname);
        }
    };
    // The review block lives in the Notes library.
    const showReview = () => {
        if (state.view === 'notes' && !state.nv.editing) openNotes({ pane: 'library' });
        else renderView();
    };

    // Multi-note batch: #notes=<percent-encoded JSON array of {"content","notebook"?}>
    if (raw.startsWith('notes=')) {
        consumeHash();
        let items = null;
        try { items = JSON.parse(decodeURIComponent(raw.slice(6))); } catch (e) { /* invalid */ }
        if (!Array.isArray(items) || items.length === 0) {
            showToast('Import link could not be decoded.');
            return;
        }
        const notes = items
            .filter(it => it && typeof it.content === 'string' && it.content.trim())
            .map(it => ({ content: it.content, notebook: typeof it.notebook === 'string' && it.notebook.trim() ? it.notebook.trim() : null }));
        if (notes.length === 0) {
            showToast('Import link contained no notes.');
            return;
        }
        state.importBatch = { kind: 'notes', items: notes };
        showReview();
        showToast('Review the import, then press Import.');
        return;
    }

    // Reorder: #reorder=<percent-encoded JSON array of note titles>
    if (raw.startsWith('reorder=')) {
        consumeHash();
        let order = null;
        try { order = JSON.parse(decodeURIComponent(raw.slice(8))); } catch (e) { /* invalid */ }
        if (!Array.isArray(order) || order.length === 0) {
            showToast('Reorder link could not be decoded.');
            return;
        }
        state.importBatch = { kind: 'reorder', order: order.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim()) };
        showReview();
        showToast('Review the new order, then press Apply.');
        return;
    }

    if (!raw.startsWith('note=')) return;
    consumeHash();

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
    if (!content.trim()) return;

    const found = await ensureNotesFolder();
    if (!found) return;

    // The notebook is resolved the same way the server and the extension do
    // (an exact top-level name, 'Parent / Child', a unique nested name), and
    // a missing one is only created on ✓ Done — nothing is saved or pushed
    // before the note has been reviewed.
    let parentId = null;
    let pendingNotebookName = null;
    if (notebook && notebook.trim()) {
        const res = NM.resolveNotebookByName(notesLibrary(), notebook);
        if (res && res.id) parentId = res.id;
        else if (res) pendingNotebookName = notebook.trim();
    }
    if (await startNewNote({ parentId, content, pendingNotebookName })) {
        showToast('Review the note, then press ✓ Done.');
    } else if (editorDirty()) {
        showToast('Import skipped — your unsaved edit is still open.');
    }
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

async function pullSnapshot() {
    try {
        setStatus('Pulling…');
        const data = await api('/api/tree');
        // A wrapper node so the rest of the app keeps its "root with children"
        // navigation model; only its children are real.
        state.snapshot = { type: 'root', title: '', children: (data.roots || []).map(fromWire) };
        state.treeVersion = Number(data.version) || 0;
        state.pathIds = [getRootId(state.snapshot)];
        state.dirty = false;
        renderView();
    } catch (e) {
        setStatus('Pull failed: ' + e.message);
        throw e;
    }
}

async function refreshInbox() {
    try {
        const data = await api('/api/shared');
        state.inbox = data.links || [];
        updateInboxFab();
    } catch (e) {
        console.warn('Inbox fetch failed', e);
    }
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
    if (document.getElementById('quick-file-sheet') && !document.getElementById('quick-file-sheet').classList.contains('hidden')) {
        renderQuickFileSheet();
    }
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
    if (state.view === 'notes') {
        renderNotesScreen(root);
        return;
    }
    const node = findNodeByPath(state.pathIds);
    if (!node) {
        root.innerHTML = '<div class="empty">Folder not found.</div>';
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

function renderBookmarkRow(b) {
    const row = document.createElement('div');
    row.className = 'row bookmark';
    let domain = '';
    try { domain = new URL(b.url).hostname.replace(/^www\./, ''); } catch (e) {}
    const favicon = domain
        ? `<img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32">`
        : '<span class="icon">🔖</span>';
    row.innerHTML = `
        ${favicon}
        <a href="${escapeAttr(b.url)}" target="_blank" rel="noopener">${escapeHtml(b.title || b.url)}</a>
    `;
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
// a query. Same rule as the extension's home screen.
function searchTargetFor(text) {
    const t = String(text || '').trim();
    if (!t) return null;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t;
    if (!/\s/.test(t) && /^[^.]+\.[^.]{2,}/.test(t)) return 'https://' + t;
    return DDG + encodeURIComponent(t);
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
        window.open(target, '_blank', 'noopener');
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
            const tile = document.createElement('a');
            tile.className = 'pin-tile';
            // A pin saved as a bare host has no scheme, and a scheme-less href
            // resolves against this app's origin instead of the web.
            tile.href = /^[a-z][a-z0-9+.-]*:/i.test(String(p.url).trim())
                ? p.url
                : `https://${String(p.url).trim()}`;
            tile.target = '_blank';
            tile.rel = 'noopener';
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
            attachFavicon(fav, tile.href);
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
        { label: '📋 Unfiled links', cls: 'a-clip', delegate: 'clipBtn' },
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
// allow pop-ups for this site once. Count what got through and say so.
function openWorkflowTabs(folder) {
    const tabs = workflowTabs(folder);
    if (!tabs.length) { showToast('This workflow has no tabs.'); return; }
    let opened = 0;
    for (const t of tabs) {
        const w = window.open(t.url, '_blank', 'noopener');
        if (w) opened++;
    }
    if (opened < tabs.length) {
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
            if (!confirm(`Delete workflow "${wf.title}" (${tabs.length} tabs)?`)) return;
            wfRoot.children = (wfRoot.children || []).filter(c => c !== wf);
            state.dirty = true;
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

// Locate the notes folder, offering to create + push it if missing.
// Returns { node, path } or null.
async function ensureNotesFolder() {
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

    // Safe to create now: the notes root is identified by its role, so there
    // is no title-guessing and no duplicate-roots hazard. Created locally only
    // — deliberately NOT auto-pushed. Merely opening Notes must never push a
    // whole tree; if this phone's copy were stale, that push would raise the
    // conflict/force dialog as a side effect of viewing notes. The root rides
    // along with the next real save or explicit push.
    const nb = { type: 'folder', title: NOTES_ROOT_TITLE, _role: 'notes', children: [] };
    assignIds(nb);
    state.snapshot.children = state.snapshot.children || [];
    state.snapshot.children.push(nb);
    state.dirty = true;
    updatePushBtnState();
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
    state.dirty = true;
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
        loaded: null              // what the editor started from
    };
}

// History entries pushed above the Home entry; stored in each entry too, so
// a popstate knows where it landed.
let navDepth = 0;
let skipNavGuardOnce = false;

function isDesktop() {
    return window.matchMedia('(min-width: 900px)').matches;
}

function nvHistoryState() {
    const nv = state.nv;
    return { tp: 'nv', depth: navDepth, pane: nv.pane, scope: nv.scope, noteId: nv.noteId, from: nv.from, query: nv.query };
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

// The guard on every way out of an edit: back, the bottom nav, wikilinks, the
// wordmark, another note.
function confirmDiscardEdit() {
    return !editorDirty() || confirm('Discard unsaved changes?');
}

function stopEditing() {
    Object.assign(state.nv, {
        editing: false,
        isNew: false,
        draft: null,
        loaded: null,
        newParentId: null,
        pendingNotebookName: null
    });
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
    if (!state.snapshot) return;
    if (!confirmDiscardEdit()) return;
    stopEditing();
    closeNotesSheets();
    state.pathIds = [state.snapshot._pwaId];
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
    // hashchange handler takes the entry over in consumeHash.
    if (!e.state && IMPORT_HASH_RE.test(location.hash)) return;
    const st = e.state && e.state.tp === 'nv' ? e.state : null;
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
async function startNewNote({ parentId = null, content = '', from, pendingNotebookName = null } = {}) {
    if (!confirmDiscardEdit()) return false;
    const found = await ensureNotesFolder();
    if (!found) return false;
    stopEditing();
    const patch = {
        pane: 'note', noteId: null, isNew: true, editing: true,
        newParentId: parentId, pendingNotebookName,
        draft: content, loaded: content
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

    // Proposals and import review wait here, unchanged.
    if (state.importBatch) pane.appendChild(renderImportBlock());
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
        body.innerHTML = renderNotePreviewHtml(note.content, note.title)
            || '<span style="color:var(--muted);">Empty note. Tap ✏️ to write.</span>';
        const links = NM.backlinksTo(lib, note.title, note.id);
        if (links.length) {
            body.insertAdjacentHTML('beforeend', '<div class="note-backlinks"><span style="color:var(--muted);">Linked from:</span> '
                + links.map(n => `<span class="note-wikilink note-backlink" data-target="${escapeHtml(n.title)}">${escapeHtml(n.title || 'Untitled')}</span>`).join(' ')
                + '</div>');
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
    const found = await ensureNotesFolder();
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
    if (!hit || state.nv.editing) return;
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
    if (!hit) return;
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
    if (!hit) return;
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
    const parent = parentId ? findNotesNode(parentId)?.node : found.node;
    if (!isFolderNode(parent)) { showToast('That notebook is gone.'); return null; }
    const name = prompt(parentId ? `New notebook inside “${parent.title}”:` : 'New notebook name:');
    if (name === null) return null;
    const problem = NM.notebookNameProblem(name, folderTitles(parent));
    if (problem) { showToast(problem); return null; }
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
    if (!hit || !isFolderNode(hit.node)) return;
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
    if (!hit || !found || !isFolderNode(hit.node)) return;
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
    if (!hit || !found) return;
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
    if (!hit || !isFolderNode(hit.node)) return;
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
            if (!confirmDiscardEdit()) return;
            openNotes({ pane: 'list', scope: t.dataset.scope, query: '' });
            break;
        case 'open-nb':
            if (!confirmDiscardEdit()) return;
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

async function resolveProposal(p, approve) {
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
            showToast(p.kind === 'reorder' ? 'New order applied (Manual order)' : `Note "${p.title}" added.`);
            await pullSnapshot(); // server applied the change — pull it down
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
    cancelBtn.addEventListener('click', () => { state.importBatch = null; renderView(); });
    actions.appendChild(okBtn);
    actions.appendChild(cancelBtn);
    block.appendChild(actions);
    return block;
}

async function applyImportBatch() {
    const batch = state.importBatch;
    if (!batch) return;
    const found = await ensureNotesFolder();
    if (!found) return;
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

    state.importBatch = null;
    state.dirty = true;
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

// Render note content as safe HTML, GitHub/Obsidian-style: # headings,
// real - and 1. lists, **bold**, *italic*, [[wiki-links]] as clickable
// chips, bare URLs as links. Everything else is escaped text.
// Zero-dependency, mirrors the extension sidepanel renderer.
function renderNoteInline(escapedLine) {
    let html = escapedLine;
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    html = html.replace(/\[\[([^\[\]]+)\]\]/g, (m, t) =>
        `<span class="note-wikilink" data-target="${t.trim()}">[[${t.trim()}]]</span>`);
    html = html.replace(/(https?:\/\/[^\s<)&]+)/g,
        `<a href="$1" class="note-urllink" target="_blank" rel="noopener">$1</a>`);
    return html;
}

// `skipTitle` drops a leading '# Title' that repeats the note's title, which
// the page already shows as its heading.
function renderNotePreviewHtml(content, skipTitle = '') {
    const out = [];
    let listTag = null; // 'ul' | 'ol' | null
    const closeList = () => {
        if (listTag) { out.push(`</${listTag}>`); listTag = null; }
    };
    const lines = String(content || '').split('\n');
    const first = lines.findIndex(l => l.trim());
    const skip = String(skipTitle || '').trim().toLowerCase();
    for (let i = 0; i < lines.length; i++) {
        const rawLine = lines[i];
        if (i === first && skip) {
            const h1 = rawLine.match(/^#\s+(.+?)\s*$/);
            if (h1 && h1[1].trim().toLowerCase() === skip) continue;
        }
        const line = escapeHtml(rawLine);
        const trimmed = line.trim();
        if (!trimmed) { closeList(); continue; }

        // Task items before the plain-bullet rule — "- [ ] x" is also a bullet.
        // data-line ties the box back to its source line for the write-back.
        const task = NM.parseTaskLine(rawLine);
        if (task) {
            if (listTag !== 'ul') { closeList(); out.push('<ul class="note-tasks">'); listTag = 'ul'; }
            out.push(
                `<li class="note-task${task.checked ? ' done' : ''}"` +
                (task.indent ? ` style="margin-left:${task.indent * 12}px"` : '') + '>' +
                `<input type="checkbox" class="note-task-box" data-line="${i}"${task.checked ? ' checked' : ''}>` +
                `<span>${renderNoteInline(escapeHtml(task.label))}</span></li>`
            );
            continue;
        }

        const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
        if (heading) {
            closeList();
            const level = heading[1].length;
            out.push(`<h${level}>${renderNoteInline(heading[2])}</h${level}>`);
            continue;
        }

        const bullet = rawLine.match(/^\s*[-*]\s+(.+)$/);
        if (bullet) {
            if (listTag !== 'ul') { closeList(); out.push('<ul>'); listTag = 'ul'; }
            out.push(`<li>${renderNoteInline(escapeHtml(bullet[1]))}</li>`);
            continue;
        }

        const numbered = rawLine.match(/^\s*\d+[.)]\s+(.+)$/);
        if (numbered) {
            if (listTag !== 'ol') { closeList(); out.push('<ol>'); listTag = 'ol'; }
            out.push(`<li>${renderNoteInline(escapeHtml(numbered[1]))}</li>`);
            continue;
        }

        closeList();
        out.push(`<p>${renderNoteInline(line)}</p>`);
    }
    closeList();
    return out.join('\n');
}

// --- Bottom tab bar ---
// The highlight follows what is on screen rather than the last tap: Notes
// while Notes shows, Inbox or Settings only while their sheet is open, Home
// otherwise — including a note opened straight from Home, whose back goes
// to Home. The Notes tab carries the pending-proposal count.
function syncBottomNav() {
    const nav = $('bottom-nav');
    const open = (id) => { const el = $(id); return Boolean(el) && !el.classList.contains('hidden'); };
    const fromHome = state.nv.pane === 'note' && state.nv.from === 'Home';
    const active = open('settings-sheet') ? 'settings'
        : open('inbox-sheet') ? 'inbox'
            : state.view === 'notes' && !fromHome ? 'notes' : 'home';
    if (nav) {
        for (const b of nav.querySelectorAll('button[data-nav]')) b.classList.toggle('on', b.dataset.nav === active);
        const badge = nav.querySelector('.bn-badge');
        if (badge) {
            const n = state.proposals.length;
            badge.textContent = n > 99 ? '99+' : String(n);
            badge.classList.toggle('hidden', n === 0);
        }
    }
    const notesBtn = $('notesBtn');
    if (notesBtn) notesBtn.classList.toggle('on', state.view === 'notes');
}

// --- Inbox modal ---
function updateInboxFab() {
    const fab = $('inbox-fab');
    const count = $('inbox-count');
    if (!fab || !count) return;
    if (state.inbox.length === 0) { hide(fab); return; }
    count.textContent = state.inbox.length;
    show(fab);
}

function openInbox() {
    const list = $('inbox-list');
    if (!list) return;
    list.innerHTML = '';
    if (state.inbox.length === 0) {
        list.innerHTML = '<div class="empty">No pending links. Share something from your phone to TabPaladin to add one.</div>';
    } else {
        state.inbox.forEach(link => {
            const row = document.createElement('div');
            row.className = 'row bookmark';
            let domain = '';
            try { domain = new URL(link.url).hostname.replace(/^www\./, ''); } catch (e) {}
            const favicon = domain
                ? `<img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32">`
                : '<span class="icon">🔖</span>';
            row.innerHTML = `
                ${favicon}
                <a href="${escapeAttr(link.url)}" target="_blank" rel="noopener">${escapeHtml(link.title || link.url)}</a>
                <button class="remove" data-id="${link.id}" title="Remove">✕</button>
            `;
            row.querySelector('.remove').addEventListener('click', async (e) => {
                e.stopPropagation();
                const id = e.currentTarget.dataset.id;
                try {
                    await api('/api/shared/' + id, { method: 'DELETE' });
                    state.inbox = state.inbox.filter(l => String(l.id) !== String(id));
                    openInbox();
                    updateInboxFab();
                } catch (err) { alert('Remove failed: ' + err.message); }
            });
            list.appendChild(row);
        });
    }
    const currentFolder = findNodeByPath(state.pathIds);
    const hint = $('dropHereHint');
    if (hint) hint.textContent = currentFolder ? `Will add to "${currentFolder.title || 'Bookmarks'}"` : '';
    show($('inbox-sheet'));
}

async function dropHere() {
    const folder = findNodeByPath(state.pathIds);
    if (!folder) { alert('Pick a folder first.'); return; }
    if (blockedByImports('drop links')) return;
    if (state.inbox.length === 0) { alert('Nothing in the inbox.'); return; }

    // Append each link as a bookmark to the current folder, locally.
    folder.children = folder.children || [];
    for (const link of state.inbox) {
        folder.children.push({ type: 'bookmark', url: link.url, title: link.title || link.url });
    }
    state.dirty = true;
    renderView();

    // Push the updated snapshot back to the server (clean of helper fields).
    try {
        setStatus('Saving…');
        await pushSnapshot();
        // Clear the server inbox.
        await api('/api/shared', { method: 'DELETE' });
        state.inbox = [];
        updateInboxFab();
        hide($('inbox-sheet'));
        setStatus('');
    } catch (e) {
        alert('Push failed: ' + e.message + '\nLocal changes preserved; will retry next time you press Drop.');
        setStatus('');
    }
}

async function pushSnapshot({ force = false } = {}) {
    const roots = (state.snapshot.children || []).map(toWire).filter(Boolean);
    // Pushing an empty tree erases everything server-side for every device —
    // never do that without a very explicit yes.
    if (roots.length === 0 && (state.treeVersion || 0) > 0) {
        if (!confirm('This would push an EMPTY tree and erase all bookmarks on the server. Really continue?')) {
            throw new Error('Push cancelled — tree is empty.');
        }
    }
    try {
        const data = await api('/api/tree', {
            method: 'PUT',
            body: JSON.stringify({ roots, baseVersion: state.treeVersion || 0, deviceId: 'pwa', force })
        });
        state.treeVersion = Number(data.version) || (state.treeVersion || 0) + 1;
        state.dirty = false;
    } catch (e) {
        // A stale baseVersion means another device pushed since our last pull.
        // Never overwrite that silently — ask.
        if (/^409[\s:]/.test(e.message) || /changed on the server/i.test(e.message)) {
            if (confirm('Another device pushed changes since this phone last pulled.\n\nOK = overwrite the server with THIS phone\'s version\nCancel = keep both as they are (pull later to see theirs — your edit is then lost)')) {
                return pushSnapshot({ force: true });
            }
        }
        throw e;
    }
}

// --- Quick-File Modal (proactive clipboard & inbox filing) ---
const DISMISSED_KEY = 'tp_dismissed_urls';
const SCANNED_CLIPBOARD_KEY = 'tp_scanned_clipboard_links';

function normalizeUrl(u) {
    try {
        const parsed = new URL(u);
        return parsed.origin + parsed.pathname.replace(/\/$/, '') + parsed.search + parsed.hash;
    } catch (e) {
        return (u || '').trim().replace(/\/$/, '');
    }
}

function getDismissedUrls() {
    try { return JSON.parse(localStorage.getItem(DISMISSED_KEY)) || []; }
    catch (e) { return []; }
}

function dismissUrl(url) {
    const list = getDismissedUrls();
    const norm = normalizeUrl(url);
    if (!list.includes(norm)) {
        list.push(norm);
        localStorage.setItem(DISMISSED_KEY, JSON.stringify(list));
    }
}

function getScannedClipboardLinks() {
    try { return JSON.parse(localStorage.getItem(SCANNED_CLIPBOARD_KEY)) || []; }
    catch (e) { return []; }
}

function addScannedClipboardLink(url, title) {
    const list = getScannedClipboardLinks();
    const norm = normalizeUrl(url);
    if (!list.some(item => normalizeUrl(item.url) === norm)) {
        list.push({ url, title, addedAt: Date.now() });
        localStorage.setItem(SCANNED_CLIPBOARD_KEY, JSON.stringify(list));
    }
}

function removeScannedClipboardLink(url) {
    const list = getScannedClipboardLinks();
    const norm = normalizeUrl(url);
    const filtered = list.filter(item => normalizeUrl(item.url) !== norm);
    localStorage.setItem(SCANNED_CLIPBOARD_KEY, JSON.stringify(filtered));
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

let activeQuickFileItems = [];
let _lastClipboardScanTime = 0;

async function checkUnfiledLinks(skipClipboardScan = false) {
    if (!state.snapshot) return;
    const dismissed = getDismissedUrls();
    const dismissedSet = new Set(dismissed.map(normalizeUrl));
    const unfiled = [];

    // 1. Process shared inbox items
    for (const link of state.inbox) {
        const norm = normalizeUrl(link.url);
        if (!isUrlInSnapshot(link.url, state.snapshot) && !dismissedSet.has(norm)) {
            if (!unfiled.some(item => normalizeUrl(item.url) === norm)) {
                unfiled.push({ url: link.url, title: link.title || link.url, inboxId: link.id });
            }
        }
    }

    // 2. Process historically scanned clipboard items
    const clipboardLinks = getScannedClipboardLinks();
    for (const item of clipboardLinks) {
        const norm = normalizeUrl(item.url);
        if (!isUrlInSnapshot(item.url, state.snapshot) && !dismissedSet.has(norm)) {
            if (!unfiled.some(u => normalizeUrl(u.url) === norm)) {
                unfiled.push({ url: item.url, title: item.title, fromClipboard: true });
            }
        } else {
            removeScannedClipboardLink(item.url);
        }
    }

    // 3. Process clipboard if permission is available and throttled (max once per 3s)
    if (!skipClipboardScan) {
        const now = Date.now();
        if (now - _lastClipboardScanTime > 3000) {
            _lastClipboardScanTime = now;
            if (navigator.clipboard && navigator.clipboard.readText) {
                try {
                    const text = await navigator.clipboard.readText();
                    const trimmed = (text || '').trim();
                    if (/^https?:\/\/\S+$/.test(trimmed)) {
                        const normTrimmed = normalizeUrl(trimmed);
                        if (!isUrlInSnapshot(trimmed, state.snapshot) && !dismissedSet.has(normTrimmed)) {
                            addScannedClipboardLink(trimmed, trimmed);
                            if (!unfiled.some(item => normalizeUrl(item.url) === normTrimmed)) {
                                unfiled.push({ url: trimmed, title: trimmed, fromClipboard: true });
                            }
                        }
                    }
                } catch (e) {
                    // Silently swallow clipboard permission errors
                }
            }
        }
    }

    activeQuickFileItems = unfiled;
    updateClipBtnBadge();
    // Never auto-open the sheet — the 📋 button badge shows the count instead.
    const sheet = $('quick-file-sheet');
    const isOpen = sheet && !sheet.classList.contains('hidden');
    if (isOpen) {
        renderQuickFileSheet();
    }
}

function updateClipBtnBadge() {
    const btn = $('clipBtn');
    if (!btn) return;
    const n = activeQuickFileItems.length;
    btn.classList.toggle('has-items', n > 0);
    btn.textContent = n > 0 ? `📋 Unfiled links (${n})` : '📋 Unfiled links';
    btn.title = n > 0
        ? `${n} unfiled link${n > 1 ? 's' : ''} — tap to review`
        : 'Scan clipboard for unfiled links';
}

function openQuickFileSheet() {
    renderQuickFileSheet();
    show($('quick-file-sheet'));
}

function renderQuickFileSheet() {
    updateClipBtnBadge();
    const sheet = $('quick-file-sheet');
    const list = $('quick-file-list');
    const hint = $('quick-file-hint');
    if (!sheet || !list || !hint) return;
    
    const currentFolder = findNodeByPath(state.pathIds);
    hint.textContent = currentFolder 
        ? `Will add to folder: "${currentFolder.title || 'Bookmarks'}"` 
        : 'Select a folder in the background to file these links.';

    list.innerHTML = '';
    
    if (activeQuickFileItems.length === 0) {
        list.innerHTML = `
            <div class="empty" style="padding: 32px 16px; color: var(--muted); text-align: center; font-style: italic; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;">
                <span style="font-size: 2rem;">📥</span>
                <span>No unfiled links queued.</span>
                <span style="font-size: 0.8rem; font-style: normal; color: var(--primary); font-weight: 500;">
                    Paste a link in the box above to add it!
                </span>
            </div>
        `;
    } else {
        activeQuickFileItems.forEach((item, index) => {
            const row = document.createElement('div');
            row.className = 'row bookmark';
            row.style.display = 'flex';
            row.style.alignItems = 'center';
            row.style.justifyContent = 'space-between';
            row.style.gap = '10px';
            row.style.background = 'rgba(255, 255, 255, 0.04)';
            row.style.marginBottom = '6px';
            row.style.padding = '10px 14px';

            let domain = '';
            try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch (e) {}
            const favicon = domain
                ? `<img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32" style="width:16px; height:16px; border-radius:3px; flex-shrink:0;">`
                : '<span class="icon">🔖</span>';

            row.innerHTML = `
                <div style="display:flex; align-items:center; gap:10px; overflow:hidden; flex:1;">
                    ${favicon}
                    <div style="display:flex; flex-direction:column; overflow:hidden; text-align:left;">
                        <strong style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-size:0.88rem; color:var(--text);">${escapeHtml(item.title)}</strong>
                        <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-size:0.75rem; color:var(--muted);">${escapeHtml(item.url)}</span>
                    </div>
                </div>
                <div style="display:flex; gap:6px; flex-shrink:0;">
                    <button class="place-btn" style="padding:6px 10px; font-size:0.8rem; font-weight:600; background:var(--success); color:white; border-radius:6px;">Place</button>
                    <button class="skip-btn" style="padding:6px 10px; font-size:0.8rem; font-weight:600; background:var(--surface-2); color:var(--text); border-radius:6px;">Skip</button>
                </div>
            `;

            row.querySelector('.place-btn').addEventListener('click', async (e) => {
                e.stopPropagation();
                const folder = findNodeByPath(state.pathIds);
                if (!folder) {
                    alert('Please navigate to a folder in the background first.');
                    return;
                }
                if (blockedByImports('file links')) return;
                // File locally
                folder.children = folder.children || [];
                folder.children.push({ type: 'bookmark', url: item.url, title: item.title });
                state.dirty = true;
                renderView();

                try {
                    setStatus('Saving…');
                    await pushSnapshot();
                    // Clear server shared link if it came from inbox
                    if (item.inboxId) {
                        await api('/api/shared/' + item.inboxId, { method: 'DELETE' });
                        state.inbox = state.inbox.filter(l => String(l.id) !== String(item.inboxId));
                    }
                    dismissUrl(item.url);
                    removeScannedClipboardLink(item.url);
                    activeQuickFileItems.splice(index, 1);
                    renderQuickFileSheet();
                    updateInboxFab();
                    setStatus('');
                } catch (err) {
                    alert('Place failed: ' + err.message);
                    setStatus('');
                }
            });

            row.querySelector('.skip-btn').addEventListener('click', async (e) => {
                e.stopPropagation();
                try {
                    if (item.inboxId) {
                        await api('/api/shared/' + item.inboxId, { method: 'DELETE' });
                        state.inbox = state.inbox.filter(l => String(l.id) !== String(item.inboxId));
                    }
                    dismissUrl(item.url);
                    removeScannedClipboardLink(item.url);
                    activeQuickFileItems.splice(index, 1);
                    renderQuickFileSheet();
                    updateInboxFab();
                } catch (err) {
                    alert('Skip failed: ' + err.message);
                }
            });

            list.appendChild(row);
        });
    }
}

// --- Share Target API ---
// When the user shares a URL from another mobile app, the browser navigates to
// /?share=1&title=...&text=...&url=... (configured in manifest). We capture and
// POST to /api/shared so it lands in the inbox.
async function processShareTargetIfAny() {
    const params = new URLSearchParams(location.search);
    // Browsers vary in where they put the URL when share_target action is `/`.
    let url = params.get('url') || '';
    const title = params.get('title') || '';
    const text = params.get('text') || '';
    if (!url && /^https?:\/\//.test(text)) url = text;
    if (!url) return;
    const shareTitle = title || text;
    try {
        // Posts shared from X or Instagram go straight into their own archive
        // rather than the generic inbox — neither can be swept, so sharing is
        // the only way those archives are ever filled. Anything else falls
        // through to the inbox exactly as before.
        let captured = null;
        try {
            captured = await api('/api/imports/capture', {
                method: 'POST',
                body: JSON.stringify({ url, title: shareTitle })
            });
        } catch (e) {
            // An older server has no capture route; the inbox still works.
            console.warn('Capture unavailable, falling back to inbox', e);
        }

        if (captured && captured.captured) {
            const name = captured.provider === 'x' ? 'X' : 'Instagram';
            showToast(captured.duplicate
                ? `Already in your ${name} archive.`
                : `Saved to ${name} — ${captured.items} archived.`);
        } else {
            await api('/api/shared', { method: 'POST', body: JSON.stringify({ url, title: shareTitle }) });
        }
    } catch (e) {
        console.warn('Share-target push failed', e);
    } finally {
        // Clean the URL so reload doesn't double-add.
        history.replaceState({}, '', location.pathname);
    }
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
    if (state.config.token) refreshImporters();
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

    list.innerHTML = sources.map(src => `
        <div class="import-row" data-id="${escapeAttr(src.id)}">
          <div class="import-head">
            <span class="import-name">${escapeHtml(src.label || src.provider)}</span>
            <span class="import-count">${src.items} saved</span>
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
        const data = await api('/api/imports');
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
        if (!confirm(`Remove "${source.label}"?\n\nThe ${source.items} archived links stay on the server, and the bookmark folder stays where it is.`)) return;
        await api('/api/imports/' + id, { method: 'DELETE' });
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
        window.open(data.url, '_blank', 'noopener');
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
        window.open(auth.url, '_blank', 'noopener');
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
    const setupHint = $('auth-setup-hint');
    if (setupHint) setupHint.classList.add('hidden');
    if (!signedIn) probeAuthStatus();
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
                hint.textContent = 'No account on this server yet — the details you enter will create it.';
                hint.classList.remove('hidden');
            }
            if (btn) btn.textContent = 'Create account';
        } else if (btn) {
            btn.textContent = 'Sign in';
        }
    } catch (e) {
        // Server unreachable; the sign-in attempt will report it properly.
    }
}

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
        const res = await fetch(base + (hasAccount ? '/api/login' : '/api/auth/setup'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return setErr(data.error || `Sign in failed (HTTP ${res.status}).`);

        state.config.url = base;
        state.config.token = data.token;
        localStorage.setItem(LS.url, base);
        localStorage.setItem(LS.token, data.token);
        localStorage.setItem(LS.username, data.username || username);
        mirrorConfigToSW();
        if ($('cfg-password')) $('cfg-password').value = '';
        refreshAuthUi();
        hide($('settings-sheet'));
        bootstrap();
    } catch (e) {
        setErr('Sign in failed: ' + e.message);
    }
}

async function signOut() {
    const base = currentServerUrl();
    // Best effort — the local token is cleared either way, so a server that is
    // unreachable can't leave you stuck signed in on the device.
    try {
        await fetch(base + '/api/logout', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + state.config.token }
        });
    } catch (e) { /* ignore */ }
    state.config.token = '';
    localStorage.removeItem(LS.token);
    localStorage.removeItem(LS.username);
    mirrorConfigToSW();
    state.snapshot = null;
    refreshAuthUi();
    setStatus('Signed out.');
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
    safeAddListener('clipBtn', 'click', async (e) => {
        e.stopPropagation();
        e.preventDefault();

        // 1. Instantly read the clipboard before ANY microtask boundary or async call!
        // This satisfies WebKit's strict security engine in standalone mobile PWAs.
        if (!navigator.clipboard || !navigator.clipboard.readText) {
            showToast('Clipboard API not supported. Paste manually below.');
            openQuickFileSheet();
            $('quick-file-paste-input').focus();
            return;
        }

        let text = '';
        try {
            text = await navigator.clipboard.readText();
        } catch (e) {
            showToast('Clipboard access denied. Paste manually below.');
            openQuickFileSheet();
            $('quick-file-paste-input').focus();
            console.warn(e);
            return;
        }

        const trimmed = (text || '').trim();
        if (!trimmed || !/^https?:\/\/\S+$/.test(trimmed)) {
            showToast('No URL in clipboard. Paste manually below.');
            openQuickFileSheet();
            $('quick-file-paste-input').focus();
            return;
        }

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

        // 2. Process the scanned URL
        const normTrimmed = normalizeUrl(trimmed);
        if (isUrlInSnapshot(trimmed, state.snapshot)) {
            showToast('Link is already filed in your bookmarks.');
            openQuickFileSheet();
            $('quick-file-paste-input').focus();
            return;
        }

        const dismissed = getDismissedUrls();
        const dismissedSet = new Set(dismissed.map(normalizeUrl));

        if (dismissedSet.has(normTrimmed)) {
            showToast('Previously skipped clipboard link. Paste manually if desired.');
            openQuickFileSheet();
            $('quick-file-paste-input').focus();
            return;
        }

        // Add to persistent clipboard scan storage
        addScannedClipboardLink(trimmed, trimmed);
        
        // Re-run the full checklist combining everything (skipping duplicate scan)
        await checkUnfiledLinks(true);

        // Check if our specific scanned item is now active in the sheet
        if (activeQuickFileItems.some(item => normalizeUrl(item.url) === normTrimmed)) {
            showToast('Unfiled link added from clipboard!');
        } else {
            showToast('Showing unfiled links bottom sheet.');
        }
        openQuickFileSheet();
        $('quick-file-paste-input').focus();
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
        }
    });

    safeAddListener('pushBtn', 'click', async (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (!configured()) {
            showToast('Please open settings (⚙) first.');
            return;
        }
        if (!state.snapshot) {
            showToast('No snapshot loaded to push.');
            return;
        }
        try {
            setStatus('Pushing…');
            await pushSnapshot();
            setStatus('');
            showToast('Pushed.');
            renderView();
        } catch (err) {
            setStatus('Push failed: ' + err.message);
            showToast('Push failed: ' + err.message);
        }
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

        state.dirty = true;
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
    // Leaving with an unsaved note (closing the tab, reloading) asks first.
    window.addEventListener('beforeunload', (e) => {
        if (!editorDirty()) return;
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

    // Import a browser's exported bookmarks file — the no-extension way in.
    safeAddListener('bm-import-btn', 'click', () => $('bm-import-file').click());
    safeAddListener('bm-import-file', 'change', async (e) => {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;
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
        assignIds(folder);
        state.snapshot.children = state.snapshot.children || [];
        state.snapshot.children.push(folder);
        state.dirty = true;
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
    safeAddListener('dropHereBtn', 'click', dropHere);

    safeAddListener('quick-file-close', 'click', () => hide($('quick-file-sheet')));

    const pasteInput = $('quick-file-paste-input');
    
    function processPastedLink(text) {
        let trimmed = (text || '').trim();
        if (!trimmed) return false;
        
        // Auto-prepend https:// if it looks like a domain without scheme
        if (!/^https?:\/\//i.test(trimmed)) {
            if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(trimmed)) {
                trimmed = 'https://' + trimmed;
            }
        }
        
        if (/^https?:\/\/\S+$/.test(trimmed)) {
            if (!configured()) {
                showToast('Please open settings (⚙) first.');
                return false;
            }
            if (!state.snapshot) {
                showToast('Pulling snapshot first…');
                pullSnapshot().then(() => {
                    handleScannedLink(trimmed);
                }).catch(err => {
                    showToast('Failed to pull snapshot: ' + err.message);
                });
                return true;
            }
            
            handleScannedLink(trimmed);
            return true;
        }
        return false;
    }

    function handleScannedLink(url) {
        const norm = normalizeUrl(url);
        if (isUrlInSnapshot(url, state.snapshot)) {
            showToast('Link is already filed in your bookmarks.');
            return;
        }
        
        const dismissed = getDismissedUrls();
        const dismissedSet = new Set(dismissed.map(normalizeUrl));
        
        // If it was previously dismissed/skipped, allow un-dismissing it on manual entry!
        if (dismissedSet.has(norm)) {
            const updatedDismissed = dismissed.filter(d => normalizeUrl(d) !== norm);
            localStorage.setItem(DISMISSED_KEY, JSON.stringify(updatedDismissed));
        }
        
        addScannedClipboardLink(url, url);
        checkUnfiledLinks(true);
        showToast('Unfiled link added!');
    }

    if (pasteInput) {
        pasteInput.addEventListener('paste', (e) => {
            const text = (e.clipboardData || window.clipboardData).getData('text');
            if (processPastedLink(text)) {
                e.preventDefault();
                pasteInput.value = '';
            }
        });

        pasteInput.addEventListener('input', () => {
            const text = pasteInput.value;
            if (processPastedLink(text)) {
                pasteInput.value = '';
            }
        });

        pasteInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                const text = pasteInput.value;
                if (processPastedLink(text)) {
                    pasteInput.value = '';
                } else if (text.trim()) {
                    showToast('Please enter a valid URL.');
                }
            }
        });
    }

    // Global click listener to trigger clipboard scan using a valid user gesture context
    document.addEventListener('click', (e) => {
        if (e.target.closest('.sheet')) return;
        if (!$('settings-sheet').classList.contains('hidden')) return;
        if (!$('inbox-sheet').classList.contains('hidden')) return;
        
        if (state.snapshot && $('quick-file-sheet').classList.contains('hidden')) {
            checkUnfiledLinks().catch(() => {});
        }
    });

    // Notes always opens fresh at start-up; an entry left over from before a
    // reload would otherwise claim a pane this page is not showing.
    loadNotesPrefs();
    if (history.state && history.state.tp === 'nv') history.replaceState(null, '', location.pathname);
    syncBottomNav();

    bootstrap();

    // Import links tapped while the app is already open.
    window.addEventListener('hashchange', () => { processImportHashIfAny(); });

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(() => {});
    }
});

// Proactively scan clipboard and refresh inbox on window focus (perfect for returning to mobile PWA)
window.addEventListener('focus', async () => {
    if (configured() && state.snapshot) {
        await refreshInbox();
        await checkUnfiledLinks();
    }
});
