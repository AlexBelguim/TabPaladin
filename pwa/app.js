// Minimal vanilla PWA for TabPaladin. Browses the latest synced snapshot.
// "Drop here" filing: navigate to a folder, tap the button — every link in the
// Recent-links modal is appended to the current folder of an in-memory edited
// snapshot, then pushed back to the server.

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
    snapshot: null,           // bookmark tree root: { type:'root', children: [...] }
    snapshotTimestamp: null,
    pathIds: [],              // breadcrumb stack of folder identifiers (root, child, ...)
    inbox: [],                // [{id, url, title}]
    dirty: false,             // unsaved local edits to the snapshot
    openNoteId: null,         // _pwaId of the note open in the detail view
    editingNewNote: false,    // detail view is editing a not-yet-created note
    newNotePrefill: null,     // optional pre-filled content for a new note (e.g. from a wikilink)
    newNoteParentId: null,    // _pwaId of the notebook a new note is filed into (null = notes root)
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
    toast.style.whiteSpace = 'nowrap';
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
        return;
    }
    await pullSnapshot();
    await refreshInbox();
    await refreshProposals();
    await checkUnfiledLinks();
    await processImportHashIfAny();
}

// Universal import link: /#note=<percent-encoded markdown>[&notebook=<name>]
// Used by LLM chats that cannot POST. The fragment never reaches the server;
// the note opens in the editor for review and is only stored when the user
// presses Save. First "# " heading becomes the title, as usual.
async function processImportHashIfAny() {
    const raw = location.hash.slice(1);

    // Multi-note batch: #notes=<percent-encoded JSON array of {"content","notebook"?}>
    if (raw.startsWith('notes=')) {
        history.replaceState(null, '', location.pathname);
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
        renderView();
        showToast('Review the import, then press Import.');
        return;
    }

    // Reorder: #reorder=<percent-encoded JSON array of note titles>
    if (raw.startsWith('reorder=')) {
        history.replaceState(null, '', location.pathname);
        let order = null;
        try { order = JSON.parse(decodeURIComponent(raw.slice(8))); } catch (e) { /* invalid */ }
        if (!Array.isArray(order) || order.length === 0) {
            showToast('Reorder link could not be decoded.');
            return;
        }
        state.importBatch = { kind: 'reorder', order: order.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim()) };
        renderView();
        showToast('Review the new order, then press Apply.');
        return;
    }

    if (!raw.startsWith('note=')) return;
    history.replaceState(null, '', location.pathname); // consume: refresh must not re-import

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

    if (notebook) {
        let nb = (found.node.children || []).find(c =>
            (c.type === 'folder' || c.type === 'root') && c.title === notebook);
        if (!nb) {
            nb = { type: 'folder', title: notebook, children: [] };
            assignIds(nb);
            found.node.children = found.node.children || [];
            found.node.children.push(nb);
            state.dirty = true;
            try {
                setStatus('Saving…');
                await pushSnapshot();
                setStatus('');
            } catch (e) {
                setStatus('');
            }
        }
        state.newNoteParentId = nb._pwaId;
    }

    state.newNotePrefill = content;
    state.editingNewNote = true;
    state.openNoteId = null;
    renderView();
    const sec = document.getElementById('notes-section');
    if (sec) sec.scrollIntoView();
    showToast('Review the note, then press Save.');
}

async function pullSnapshot() {
    try {
        setStatus('Pulling…');
        const data = await api('/api/pull');
        if (!data.snapshot) {
            setStatus('No snapshot on server yet. Use Push from the extension to upload your bookmarks.');
            state.snapshot = null;
            return;
        }
        state.snapshot = data.snapshot;
        state.snapshotTimestamp = data.timestamp;
        state.pathIds = [getRootId(state.snapshot)];
        state.dirty = false;
        renderView();
    } catch (e) {
        setStatus('Pull failed: ' + e.message);
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
        state.proposals = data.proposals || [];
    } catch (e) {
        console.warn('Proposals fetch failed', e);
    }
}

// --- Snapshot navigation ---
// The snapshot is the same shape as the extension's bookmark export:
//   { version, type:'root'|'folder', title, children: [{type:'folder', title, children:[...]}, {type:'bookmark', url, title}] }
// We synthesize a stable "id" per node so we can navigate it.

function getRootId(snap) { return assignIds(snap); }

let _idCounter = 0;
function assignIds(node) {
    if (!node._pwaId) node._pwaId = 'n' + (++_idCounter);
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
function renderView() {
    setStatus('');
    document.body.classList.toggle('note-open', Boolean(state.openNoteId || state.editingNewNote));
    renderBreadcrumb();
    renderContent();
    updateInboxFab();
    if (document.getElementById('quick-file-sheet') && !document.getElementById('quick-file-sheet').classList.contains('hidden')) {
        renderQuickFileSheet();
    }
    updatePushBtnState();
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
            state.openNoteId = null;
            state.editingNewNote = false;
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
    // An open note is a fullscreen page — no bookmark chrome around it.
    if (state.openNoteId || state.editingNewNote) {
        renderNotesSection(root);
        return;
    }
    const node = findNodeByPath(state.pathIds);
    if (!node) {
        root.innerHTML = '<div class="empty">Folder not found.</div>';
        return;
    }
    // The notes folder gets its own editor UI instead of generic bookmark rows.
    if (isNotesFolder(node)) {
        renderNotesView(root, node);
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
        note.innerHTML = '<strong>Synced from Reddit.</strong> The server rebuilds this folder on every sweep, '
            + 'so nothing can be filed into it. '
            + 'Move something out and it stays where you put it, never re-added. '
            + 'Delete it and it is purged, and will not come back on the next sweep.';
        root.appendChild(note);
    }
    const children = node.children || [];
    // Neither the notes nor the pins folder is shown among the bookmarks —
    // notes get their own section on the root view, pins get the home tiles.
    const atRoot = state.pathIds.length === 1;
    const folders = children.filter(c => (c.type === 'folder' || c.type === 'root')
        && !isNotesFolder(c) && !isPinsFolder(c)
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
        renderNotesSection(root);
    }
}

// Imported bookmarks live under this root, written by the server's importers.
const IMPORTS_ROOT_TITLE = 'TabPaladin Imports';

function isImportsFolder(node) {
    return node && node.type === 'folder' && node.title === IMPORTS_ROOT_TITLE;
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
    showToast(`Can't ${action} here — this folder is synced from Reddit and is rebuilt on every sweep.`);
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
        state.openNoteId = null;
        state.editingNewNote = false;
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
    return node && (node.type === 'folder' || node.type === 'root') && node.title === PINS_ROOT_TITLE;
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

    // Quick actions. These delegate to the existing topbar/menu buttons rather
    // than re-implementing their handlers — the phone gets bigger targets for
    // the same four things, and there is still one code path per action.
    const actionsHead = document.createElement('div');
    actionsHead.className = 'home-head';
    actionsHead.textContent = 'Quick actions';
    wrap.appendChild(actionsHead);

    const actions = document.createElement('div');
    actions.className = 'home-actions';
    const ACTIONS = [
        { label: '📝 Notes', cls: 'a-notes', delegate: 'notesBtn' },
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
            const target = document.getElementById(a.delegate);
            if (target) target.click();
        });
        actions.appendChild(btn);
    }
    wrap.appendChild(actions);

    // Recent notes, with open-task counts read from the markdown.
    const notesFolder = findNotesFolderWithPath();
    const recent = collectRecentNotes(notesFolder?.node).slice(0, 4);
    if (recent.length) {
        const head = document.createElement('div');
        head.className = 'home-head';
        head.textContent = 'Recent notes';
        wrap.appendChild(head);

        const panel = document.createElement('div');
        panel.className = 'home-panel';
        for (const n of recent) {
            const row = document.createElement('div');
            row.className = 'home-note-row';
            const left = document.createElement('span');
            left.className = 'home-note-title';
            left.textContent = n.title;
            const right = document.createElement('span');
            right.className = 'home-note-meta';
            right.textContent = n.total ? `${n.open} of ${n.total} open` : '';
            row.append(left, right);
            row.addEventListener('click', () => {
                state.openNoteId = n.id;
                state.editingNewNote = false;
                renderView();
            });
            panel.appendChild(row);
        }
        wrap.appendChild(panel);
    }

    root.appendChild(wrap);
}

// Notes anywhere under the notes root, newest-looking first, with task counts.
function collectRecentNotes(node, out = []) {
    if (!node) return out;
    for (const child of node.children || []) {
        if (isNoteBookmark(child)) {
            const { content } = decodeNote(child);
            let open = 0;
            let total = 0;
            for (const line of String(content).split(/\r?\n/)) {
                const task = parseTaskLine(line);
                if (!task) continue;
                total++;
                if (!task.checked) open++;
            }
            out.push({ id: child._pwaId, title: child.title || 'Untitled', open, total });
        } else if (child.type === 'folder') {
            collectRecentNotes(child, out);
        }
    }
    return out;
}

function isNotesFolder(node) {
    return node && (node.type === 'folder' || node.type === 'root') && node.title === NOTES_ROOT_TITLE;
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

function decodeNote(b) {
    try {
        const p = JSON.parse(decodeURIComponent(b.url.slice(NOTE_DATA_PREFIX.length)));
        return { content: p.content || '', createdAt: p.createdAt || null, updatedAt: p.updatedAt || null };
    } catch (e) {
        return { content: '', createdAt: null, updatedAt: null };
    }
}

function encodeNoteUrl({ content, createdAt, updatedAt }) {
    return NOTE_DATA_PREFIX + encodeURIComponent(JSON.stringify({ v: 1, content, createdAt, updatedAt }));
}

// Locate the notes folder (root → browser root → TabPaladin Notes) with its path.
function findNotesFolderWithPath() {
    if (!state.snapshot) return null;
    for (const rootChild of state.snapshot.children || []) {
        if (isNotesFolder(rootChild)) {
            return { node: rootChild, path: [state.snapshot._pwaId, rootChild._pwaId] };
        }
        for (const c of rootChild.children || []) {
            if (isNotesFolder(c)) {
                return { node: c, path: [state.snapshot._pwaId, rootChild._pwaId, c._pwaId] };
            }
        }
    }
    return null;
}

// Replace [[oldTitle]] with [[newTitle]] inside a content string.
function rewriteWikiLink(content, oldTitle, newTitle) {
    const escaped = oldTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return content.replace(new RegExp(`\\[\\[\\s*${escaped}\\s*\\]\\]`, 'g'), `[[${newTitle}]]`);
}

// Markdown task lists — mirrors NotesManager.parseTaskLine/toggleTaskAtLine in
// the extension. The PWA is served standalone and can't import from src/.
// The list marker is optional: a bare "[ ] thing" is treated as a task too,
// because that is how people actually type them. Kept identical to
// src/utils/notesManager.js — the two implementations must agree or a note
// toggles on one device and not the other.
const TASK_LINE_RE = /^(\s*)(?:[-*]\s+)?\[([ xX])\]\s?(.*)$/;

function parseTaskLine(line) {
    const m = String(line).match(TASK_LINE_RE);
    if (!m) return null;
    return { indent: m[1].length, checked: m[2].toLowerCase() === 'x', label: m[3] };
}

// Flip one checkbox, leaving every other character of the note untouched.
function toggleTaskAtLine(content, lineIndex) {
    const text = String(content == null ? '' : content);
    const lines = text.split('\n');
    if (!Number.isInteger(lineIndex) || lineIndex < 0 || lineIndex >= lines.length) return text;
    const line = lines[lineIndex];
    const m = line.match(/^(\s*(?:[-*]\s+)?\[)([ xX])(\])/);
    if (!m) return text;
    lines[lineIndex] = m[1] + (m[2].toLowerCase() === 'x' ? ' ' : 'x') + line.slice(m[1].length + 1);
    return lines.join('\n');
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

    // The PWA never creates the notes root.
    //
    // It used to, guessing at the extension's location by native id and then
    // by title. When the guess missed — localized root names, a browser whose
    // "Other Bookmarks" carries a different native id, a snapshot pushed from
    // a second browser — the two ended up with a notes root each, neither
    // seeing the other's notes, and pulls stacked more. One creator removes
    // the whole class of problem: the extension owns root creation, the PWA
    // only ever reads and writes inside a root that already exists.
    showToast('No notes folder yet — open TabPaladin on your computer and create a note there first, then pull.');
    return null;
}

function buildNoteRow(note, onOpen) {
    const meta = decodeNote(note);
    const snippet = meta.content.replace(/\s+/g, ' ').trim().slice(0, 80);
    const row = document.createElement('div');
    row.className = 'row note';
    row.innerHTML = `
        <span class="icon">📝</span>
        <div class="note-row-text">
            <span class="title">${escapeHtml(note.title || 'Untitled')}</span>
            ${snippet ? `<span class="snippet">${escapeHtml(snippet)}</span>` : ''}
        </div>
    `;
    row.addEventListener('click', onOpen);
    return row;
}

// --- Notebooks: direct subfolders of the notes root act as named groups ---

// All notes under a folder (recursively) as { note, parent } entries.
function collectNotes(folder, out = []) {
    for (const c of folder.children || []) {
        if (isNoteBookmark(c)) out.push({ note: c, parent: folder });
        else if (c && (c.type === 'folder' || c.type === 'root')) collectNotes(c, out);
    }
    return out;
}

// Every note in the collection as { note, parent }, or [] when there is no notes folder.
function allNotes() {
    const found = findNotesFolderWithPath();
    return found ? collectNotes(found.node) : [];
}

// Find a note by _pwaId anywhere under folder; returns { note, parent } or null.
function findNoteWithParent(folder, noteId) {
    for (const c of folder.children || []) {
        if (isNoteBookmark(c) && c._pwaId === noteId) return { note: c, parent: folder };
        if (c && (c.type === 'folder' || c.type === 'root')) {
            const r = findNoteWithParent(c, noteId);
            if (r) return r;
        }
    }
    return null;
}

// Direct subfolders of the notes root = notebooks.
function notebookFolders(notesRoot) {
    return (notesRoot.children || []).filter(c =>
        (c.type === 'folder' || c.type === 'root') && c.title !== '__tabpaladin_meta__');
}

// --- Notes section (root view): notes live under the bookmarks, not in the tree ---
function renderNotesSection(root) {
    const section = document.createElement('div');
    section.className = 'notes-section';
    section.id = 'notes-section';

    const found = findNotesFolderWithPath();

    // Detail view (existing note or new one) replaces the section content.
    if ((state.editingNewNote || state.openNoteId) && found) {
        let note = null;
        let parent = found.node;
        if (state.editingNewNote) {
            parent = (found.node.children || []).find(c => c._pwaId === state.newNoteParentId) || found.node;
        } else {
            const r = findNoteWithParent(found.node, state.openNoteId);
            if (r) {
                note = r.note;
                parent = r.parent;
            } else {
                state.openNoteId = null; // note vanished — fall back to the list
            }
        }
        if (state.editingNewNote || note) {
            section.classList.add('detail-open');
            renderNoteDetail(section, parent, note);
            root.appendChild(section);
            return;
        }
    }

    const header = document.createElement('div');
    header.className = 'notes-section-header';
    const title = document.createElement('h2');
    title.textContent = '📝 Notes';
    header.appendChild(title);

    const shareBtn = document.createElement('button');
    shareBtn.textContent = '🔗 Share with LLM';
    shareBtn.title = 'Create a 1-hour link with your notes + instructions to paste into any LLM chat';
    shareBtn.addEventListener('click', createShareLink);
    header.appendChild(shareBtn);

    const newNotebookBtn = document.createElement('button');
    newNotebookBtn.textContent = '📓+';
    newNotebookBtn.title = 'New notebook';
    newNotebookBtn.addEventListener('click', createNotebook);
    header.appendChild(newNotebookBtn);

    const newBtn = document.createElement('button');
    newBtn.textContent = '+ New Note';
    newBtn.addEventListener('click', async () => {
        const f = await ensureNotesFolder();
        if (!f) return;
        state.openNoteId = null;
        state.editingNewNote = true;
        state.newNoteParentId = null;
        renderView();
    });
    header.appendChild(newBtn);
    section.appendChild(header);

    if (state.importBatch) {
        section.appendChild(renderImportBlock());
    }

    if (state.proposals.length > 0) {
        section.appendChild(renderProposalsBlock());
    }

    if (!found) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No notes yet.';
        section.appendChild(empty);
        root.appendChild(section);
        return;
    }

    const openNote = (note) => () => {
        state.openNoteId = note._pwaId;
        state.editingNewNote = false;
        state.newNoteParentId = null;
        renderView();
    };

    // Loose notes live directly in the notes root.
    const looseNotes = (found.node.children || []).filter(isNoteBookmark);
    for (const note of looseNotes) {
        section.appendChild(buildNoteRow(note, openNote(note)));
    }

    // Notebooks as collapsible groups.
    for (const nb of notebookFolders(found.node)) {
        const nbNotes = (nb.children || []).filter(isNoteBookmark);
        const det = document.createElement('details');
        det.className = 'notebook';
        det.open = true;
        const sum = document.createElement('summary');
        sum.innerHTML = `<span class="notebook-name">📓 ${escapeHtml(nb.title || '(unnamed)')}</span><span class="count">${nbNotes.length}</span>`;
        det.appendChild(sum);

        const addBtn = document.createElement('button');
        addBtn.className = 'notebook-add';
        addBtn.textContent = '+ Note';
        addBtn.addEventListener('click', () => {
            state.openNoteId = null;
            state.editingNewNote = true;
            state.newNoteParentId = nb._pwaId;
            renderView();
        });
        det.appendChild(addBtn);

        if (nbNotes.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = 'Empty notebook.';
            det.appendChild(empty);
        }
        for (const note of nbNotes) {
            det.appendChild(buildNoteRow(note, openNote(note)));
        }
        section.appendChild(det);
    }

    if (looseNotes.length === 0 && notebookFolders(found.node).length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No notes yet.';
        section.appendChild(empty);
    }
    root.appendChild(section);
}

async function createNotebook() {
    const found = await ensureNotesFolder();
    if (!found) return;
    const name = prompt('Notebook name:');
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) { showToast('Notebook name cannot be empty.'); return; }
    const nb = { type: 'folder', title: trimmed, children: [] };
    assignIds(nb);
    found.node.children = found.node.children || [];
    found.node.children.push(nb);
    state.dirty = true;
    try {
        setStatus('Saving…');
        await pushSnapshot();
        showToast(`Notebook "${trimmed}" created.`);
        setStatus('');
    } catch (e) {
        alert('Save failed: ' + e.message + '\nLocal changes preserved; use ⬆️ to retry.');
        setStatus('');
    }
    renderView();
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
            showToast(p.kind === 'reorder' ? 'New order applied.' : `Note "${p.title}" added.`);
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
            const m = it.content.match(/^#\s+(.+?)\s*$/m);
            const t = m ? m[1].trim() : 'Untitled';
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
    } else {
        for (const it of batch.items) {
            let parent = found.node;
            if (it.notebook) {
                parent = (found.node.children || []).find(c =>
                    (c.type === 'folder' || c.type === 'root') && c.title === it.notebook);
                if (!parent) {
                    parent = { type: 'folder', title: it.notebook, children: [] };
                    assignIds(parent);
                    found.node.children = found.node.children || [];
                    found.node.children.push(parent);
                }
            }
            const m = it.content.match(/^#\s+(.+?)\s*$/m);
            const title = (m ? m[1].trim() : '') || 'Untitled';
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
            ? 'Notes reordered.'
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

function renderNotesView(container, folder) {
    // Detail view (existing note or a new one being composed)
    if (state.editingNewNote || state.openNoteId) {
        const note = state.editingNewNote
            ? null
            : (folder.children || []).find(c => c._pwaId === state.openNoteId && isNoteBookmark(c));
        if (!state.editingNewNote && !note) {
            state.openNoteId = null; // note vanished — fall back to the list
        } else {
            renderNoteDetail(container, folder, note);
            return;
        }
    }

    container.innerHTML = '';
    const addBtn = document.createElement('button');
    addBtn.className = 'primary';
    addBtn.style.marginBottom = '10px';
    addBtn.textContent = '+ New Note';
    addBtn.addEventListener('click', () => {
        state.editingNewNote = true;
        state.openNoteId = null;
        renderView();
    });
    container.appendChild(addBtn);

    const notes = (folder.children || []).filter(isNoteBookmark);
    if (notes.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No notes yet.';
        container.appendChild(empty);
        return;
    }
    for (const note of notes) {
        container.appendChild(buildNoteRow(note, () => {
            state.openNoteId = note._pwaId;
            state.editingNewNote = false;
            renderView();
        }));
    }
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

function renderNotePreviewHtml(content) {
    const out = [];
    let listTag = null; // 'ul' | 'ol' | null
    const closeList = () => {
        if (listTag) { out.push(`</${listTag}>`); listTag = null; }
    };
    const lines = String(content || '').split('\n');
    for (let i = 0; i < lines.length; i++) {
        const rawLine = lines[i];
        const line = escapeHtml(rawLine);
        const trimmed = line.trim();
        if (!trimmed) { closeList(); continue; }

        // Task items before the plain-bullet rule — "- [ ] x" is also a bullet.
        // data-line ties the box back to its source line for the write-back.
        const task = parseTaskLine(rawLine);
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

// Notes whose content links to [[title]] (excluding the note itself), across all notebooks.
function getNoteBacklinks(title, excludeId) {
    if (!title) return [];
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\[\\[\\s*${escaped}\\s*\\]\\]`);
    return allNotes()
        .filter(e => e.note._pwaId !== excludeId && re.test(decodeNote(e.note).content))
        .map(e => e.note);
}

// Obsidian-style: reading view renders markdown; the pencil switches to an
// editor styled exactly like the page. The first "# " heading is the title.
function renderNoteDetail(container, folder, note) {
    const meta = note
        ? decodeNote(note)
        : { content: state.newNotePrefill || '', createdAt: null, updatedAt: null };
    state.newNotePrefill = null;
    container.innerHTML = `
        <div class="note-page">
            <div class="note-topbar">
                <button id="note-back-btn" title="Back to notes">←</button>
                <div class="note-topbar-right">
                    <button id="note-edit-btn" title="Edit">✏️</button>
                    <button id="note-save-btn" class="hidden" title="Save">✓</button>
                    <button id="note-cancel-btn" class="hidden" title="Discard changes">✕</button>
                    <div class="note-menu-wrap">
                        <button id="note-menu-btn" title="More">⋯</button>
                        <div id="note-menu-pop" class="hidden">
                            ${note ? '<select id="note-move-select" class="note-move" title="Move to notebook"></select>' : ''}
                            ${note ? '<button id="note-delete-btn" class="danger menu-item">Delete note</button>' : ''}
                        </div>
                    </div>
                </div>
            </div>
            <div id="note-preview" class="note-preview-body"></div>
            <textarea id="note-body-input" class="hidden"
                      placeholder="# Note title&#10;&#10;Write here… Link notes with [[Note Title]].">${escapeHtml(meta.content)}</textarea>
        </div>
    `;

    const textarea = container.querySelector('#note-body-input');
    const previewEl = container.querySelector('#note-preview');
    const editBtn = container.querySelector('#note-edit-btn');
    const saveBtn = container.querySelector('#note-save-btn');
    const cancelBtn = container.querySelector('#note-cancel-btn');
    const menuBtn = container.querySelector('#note-menu-btn');
    const menuPop = container.querySelector('#note-menu-pop');

    // Grow the editor with the content — a note page, not a fixed input box.
    const autogrow = () => {
        textarea.style.height = 'auto';
        textarea.style.height = Math.max(textarea.scrollHeight, Math.round(window.innerHeight * 0.6)) + 'px';
    };
    textarea.addEventListener('input', autogrow);

    // Title comes from the first "# " heading; falls back to the stored title.
    function currentTitle() {
        const m = textarea.value.match(/^#\s+(.+?)\s*$/m);
        if (m) return m[1].trim();
        return (note && note.title) || 'Untitled';
    }

    function openNoteByTitle(title) {
        const found = allNotes().find(e => e.note.title === title);
        if (found) {
            state.openNoteId = found.note._pwaId;
            state.editingNewNote = false;
            state.newNoteParentId = null;
        } else {
            // A link to a missing note starts a new one, Obsidian-style.
            state.openNoteId = null;
            state.editingNewNote = true;
            state.newNotePrefill = `# ${title}\n\n`;
        }
        renderView();
    }

    function renderReadingView() {
        const body = renderNotePreviewHtml(textarea.value);
        let html = body || '<span style="color:var(--muted);">Empty note. Tap ✏️ to write.</span>';
        const backlinks = getNoteBacklinks(currentTitle(), note ? note._pwaId : null);
        if (backlinks.length > 0) {
            const items = backlinks.map(n =>
                `<span class="note-wikilink note-backlink" data-target="${escapeHtml(n.title)}">${escapeHtml(n.title)}</span>`
            ).join(' ');
            html += `<div class="note-backlinks"><span style="color:var(--muted);">Linked from:</span> ${items}</div>`;
        }
        previewEl.innerHTML = html;
    }

    function setMode(edit) {
        editBtn.classList.toggle('hidden', edit);
        saveBtn.classList.toggle('hidden', !edit);
        cancelBtn.classList.toggle('hidden', !edit);
        textarea.classList.toggle('hidden', !edit);
        previewEl.classList.toggle('hidden', edit);
        if (edit) {
            autogrow();
            textarea.focus();
        } else {
            renderReadingView();
        }
    }

    editBtn.addEventListener('click', () => setMode(true));
    cancelBtn.addEventListener('click', () => {
        if (textarea.value !== meta.content && !confirm('Discard unsaved changes?')) return;
        textarea.value = meta.content;
        if (note) {
            setMode(false);
        } else {
            // Cancelling a brand-new note leaves the page entirely.
            state.editingNewNote = false;
            state.openNoteId = null;
            state.newNoteParentId = null;
            renderView();
        }
    });
    previewEl.addEventListener('click', async (e) => {
        const box = e.target.closest('.note-task-box');
        if (box) {
            const updated = toggleTaskAtLine(textarea.value, Number(box.dataset.line));
            if (updated === textarea.value) return;
            textarea.value = updated;
            renderReadingView();
            // A note that isn't saved yet just updates in place; the user's ✓
            // writes it. An existing note syncs the tick straight away.
            if (!note) return;
            const now = new Date().toISOString();
            note.url = encodeNoteUrl({ content: updated, createdAt: meta.createdAt || now, updatedAt: now });
            meta.content = updated;
            state.dirty = true;
            try {
                setStatus('Saving…');
                await pushSnapshot();
                setStatus('');
            } catch (err) {
                setStatus('');
                showToast('Save failed: ' + err.message + ' — use ⬆️ to retry.');
            }
            return;
        }
        const link = e.target.closest('.note-wikilink');
        if (link && link.dataset.target) openNoteByTitle(link.dataset.target);
    });

    menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        menuPop.classList.toggle('hidden');
    });
    document.addEventListener('click', () => menuPop.classList.add('hidden'));

    // Existing notes open in reading mode (like a note app); new notes in edit mode.
    setMode(!note);

    container.querySelector('#note-back-btn').addEventListener('click', () => {
        state.openNoteId = null;
        state.editingNewNote = false;
        state.newNoteParentId = null;
        renderView();
    });

    // Move an existing note between notebooks.
    const moveSel = container.querySelector('#note-move-select');
    if (moveSel && note) {
        const foundRoot = findNotesFolderWithPath();
        const notesRoot = foundRoot ? foundRoot.node : null;
        const notebooks = notesRoot ? notebookFolders(notesRoot) : [];
        const makeOpt = (value, label) => {
            const o = document.createElement('option');
            o.value = value;
            o.textContent = label;
            return o;
        };
        moveSel.appendChild(makeOpt('', '📥 No notebook'));
        for (const nb of notebooks) moveSel.appendChild(makeOpt(nb._pwaId, '📓 ' + (nb.title || '(unnamed)')));
        moveSel.value = folder === notesRoot ? '' : folder._pwaId;
        moveSel.addEventListener('change', async () => {
            const target = notebooks.find(nb => nb._pwaId === moveSel.value) || notesRoot;
            if (!target || target === folder) return;
            folder.children = (folder.children || []).filter(c => c._pwaId !== note._pwaId);
            target.children = target.children || [];
            target.children.push(note);
            folder = target;
            state.dirty = true;
            try {
                setStatus('Moving…');
                await pushSnapshot();
                showToast(`Moved to ${moveSel.value ? target.title : 'No notebook'}.`);
                setStatus('');
            } catch (e) {
                alert('Move failed: ' + e.message);
                setStatus('');
            }
        });
    }

    saveBtn.addEventListener('click', async () => {
        const content = textarea.value;
        const title = currentTitle();
        const now = new Date().toISOString();
        const oldTitle = note ? note.title : null;

        if (note) {
            note.title = title;
            note.url = encodeNoteUrl({ content, createdAt: meta.createdAt || now, updatedAt: now });
        } else {
            note = { type: 'bookmark', title, url: encodeNoteUrl({ content, createdAt: now, updatedAt: now }) };
            assignIds(note);
            folder.children = folder.children || [];
            folder.children.push(note);
            state.openNoteId = note._pwaId;
            state.editingNewNote = false;
        }
        meta.content = content;

        // Rename: rewrite [[Old Title]] links in all other notes so they don't break.
        if (oldTitle && oldTitle !== title) {
            for (const entry of allNotes()) {
                const sibling = entry.note;
                if (sibling._pwaId === note._pwaId) continue;
                const sMeta = decodeNote(sibling);
                const rewritten = rewriteWikiLink(sMeta.content, oldTitle, title);
                if (rewritten !== sMeta.content) {
                    sibling.url = encodeNoteUrl({ content: rewritten, createdAt: sMeta.createdAt || now, updatedAt: now });
                }
            }
        }

        state.newNoteParentId = null;

        state.dirty = true;
        try {
            setStatus('Saving…');
            await pushSnapshot();
            showToast('Note saved.');
            setStatus('');
            // Stay on the note, back in reading mode.
            setMode(false);
        } catch (e) {
            alert('Save failed: ' + e.message + '\nLocal changes preserved; use ⬆️ to retry.');
            setStatus('');
        }
    });

    const deleteBtn = container.querySelector('#note-delete-btn');
    if (deleteBtn) {
        deleteBtn.addEventListener('click', async () => {
            if (!confirm(`Delete note "${note.title || 'Untitled'}"?`)) return;
            folder.children = (folder.children || []).filter(c => c._pwaId !== note._pwaId);
            state.openNoteId = null;
            state.dirty = true;
            try {
                setStatus('Saving…');
                await pushSnapshot();
                showToast('Note deleted.');
                setStatus('');
            } catch (e) {
                alert('Delete failed: ' + e.message + '\nLocal changes preserved; use ⬆️ to retry.');
                setStatus('');
            }
            renderView();
        });
    }
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

async function pushSnapshot() {
    // Strip our PWA-only _pwaId fields before sending.
    const clean = cleanSnapshot(state.snapshot);
    await api('/api/push', { method: 'POST', body: JSON.stringify({ snapshot: clean, deviceId: 'pwa' }) });
    state.dirty = false;
}

function cleanSnapshot(node) {
    const out = { type: node.type, title: node.title };
    if (node.url) out.url = node.url;
    if (node.dateAdded) out.dateAdded = node.dateAdded;
    if (node.nativeId) out.nativeId = node.nativeId;
    if (node.children) out.children = node.children.map(cleanSnapshot);
    return out;
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
            if (result.projected && !state.dirty) await pullSnapshot();
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
        try {
            setStatus('Pulling…');
            const data = await api('/api/pull');
            if (!data.snapshot) {
                setStatus('No snapshot on server yet.');
                showToast('No snapshot on server yet.');
                return;
            }
            state.snapshot = data.snapshot;
            state.snapshotTimestamp = data.timestamp;
            state.pathIds = [getRootId(state.snapshot)];
            state.dirty = false;
            
            showToast('Snapshot pulled successfully! Refreshing...');
            setStatus('Pulled successfully! Refreshing...');
            setTimeout(() => {
                location.reload();
            }, 1000);
        } catch (err) {
            setStatus('Pull failed: ' + err.message);
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
            showToast('Snapshot pushed successfully! Refreshing...');
            setStatus('Pushed successfully! Refreshing...');
            setTimeout(() => {
                location.reload();
            }, 1000);
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

        if (state.pathIds.length <= 1) {
            showToast('Please open Bookmarks Bar or Other Bookmarks before creating a folder.');
            return;
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

    safeAddListener('notesBtn', 'click', async (e) => {
        e.stopPropagation();
        e.preventDefault();
        const found = await ensureNotesFolder();
        if (!found) return;
        // Notes live in their own section on the root view — jump there.
        state.pathIds = [state.snapshot._pwaId];
        state.openNoteId = null;
        state.editingNewNote = false;
        renderView();
        const sec = document.getElementById('notes-section');
        if (sec) sec.scrollIntoView({ behavior: 'smooth' });
    });

    // The wordmark goes home: close any open note and return to the root view,
    // which is where search and the pinned tiles live.
    const goHome = () => {
        if (!state.snapshot) return;
        state.openNoteId = null;
        state.editingNewNote = false;
        state.pathIds = [state.snapshot._pwaId];
        renderView();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    };
    safeAddListener('brand-home', 'click', goHome);

    // Bottom tab bar. Notes/Inbox/Settings delegate to the controls that
    // already exist so there is still one handler per action.
    const nav = document.getElementById('bottom-nav');
    if (nav) {
        nav.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-nav]');
            if (!btn) return;
            for (const b of nav.querySelectorAll('button')) b.classList.toggle('on', b === btn);
            const dest = btn.dataset.nav;
            if (dest === 'home') goHome();
            else if (dest === 'notes') document.getElementById('notesBtn')?.click();
            else if (dest === 'inbox') openInbox();
            else if (dest === 'settings') document.getElementById('settingsBtn')?.click();
        });
    }

    safeAddListener('settings-close', 'click', () => hide($('settings-sheet')));
    safeAddListener('cfg-save', 'click', saveSettings);
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
