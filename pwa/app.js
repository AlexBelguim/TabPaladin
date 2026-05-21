// Minimal vanilla PWA for TabPaladin. Browses the latest synced snapshot.
// "Drop here" filing: navigate to a folder, tap the button — every link in the
// Recent-links modal is appended to the current folder of an in-memory edited
// snapshot, then pushed back to the server.

const LS = {
    url: 'tp_pwa_url',
    token: 'tp_pwa_token'
};

const state = {
    config: { url: localStorage.getItem(LS.url) || '', token: localStorage.getItem(LS.token) || '' },
    snapshot: null,           // bookmark tree root: { type:'root', children: [...] }
    snapshotTimestamp: null,
    pathIds: [],              // breadcrumb stack of folder identifiers (root, child, ...)
    inbox: [],                // [{id, url, title}]
    dirty: false              // unsaved local edits to the snapshot
};

const $ = (id) => document.getElementById(id);

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

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
    if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`${res.status} ${res.statusText}: ${t}`);
    }
    return res.json();
}

// --- Initial load ---
async function bootstrap() {
    await processShareTargetIfAny();

    if (!configured()) {
        $('status').textContent = 'Open Settings (⚙) to configure your sync server.';
        return;
    }
    await pullSnapshot();
    await refreshInbox();
}

async function pullSnapshot() {
    try {
        $('status').textContent = 'Pulling…';
        const data = await api('/api/pull');
        if (!data.snapshot) {
            $('status').textContent = 'No snapshot on server yet. Use Push from the extension to upload your bookmarks.';
            state.snapshot = null;
            return;
        }
        state.snapshot = data.snapshot;
        state.snapshotTimestamp = data.timestamp;
        state.pathIds = [getRootId(state.snapshot)];
        state.dirty = false;
        renderView();
    } catch (e) {
        $('status').textContent = 'Pull failed: ' + e.message;
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
    renderBreadcrumb();
    renderContent();
    updateInboxFab();
}

function renderBreadcrumb() {
    const bc = $('breadcrumb');
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
    root.innerHTML = '';
    const node = findNodeByPath(state.pathIds);
    if (!node) {
        root.innerHTML = '<div class="empty">Folder not found.</div>';
        return;
    }
    const children = node.children || [];
    if (children.length === 0) {
        root.innerHTML = '<div class="empty">Empty folder.</div>';
        return;
    }
    const folders = children.filter(c => c.type === 'folder' || c.type === 'root');
    const bookmarks = children.filter(c => c.type === 'bookmark' && c.url && c.title !== '__tabpaladin_meta__');

    folders.forEach(f => root.appendChild(renderFolderRow(f)));
    bookmarks.forEach(b => root.appendChild(renderBookmarkRow(b)));
}

function renderFolderRow(folder) {
    const row = document.createElement('div');
    row.className = 'row folder';
    const subfolders = (folder.children || []).filter(c => c.type === 'folder');
    const bms = (folder.children || []).filter(c => c.type === 'bookmark' && c.title !== '__tabpaladin_meta__');
    row.innerHTML = `
        <span class="icon">📁</span>
        <span class="title">${escapeHtml(folder.title || '(unnamed)')}</span>
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

// --- Inbox modal ---
function updateInboxFab() {
    const fab = $('inbox-fab');
    const count = $('inbox-count');
    if (state.inbox.length === 0) { hide(fab); return; }
    count.textContent = state.inbox.length;
    show(fab);
}

function openInbox() {
    const list = $('inbox-list');
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
    $('dropHereHint').textContent = currentFolder ? `Will add to "${currentFolder.title || 'Bookmarks'}"` : '';
    show($('inbox-sheet'));
}

async function dropHere() {
    const folder = findNodeByPath(state.pathIds);
    if (!folder) { alert('Pick a folder first.'); return; }
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
        $('status').textContent = 'Saving…';
        await pushSnapshot();
        // Clear the server inbox.
        await api('/api/shared', { method: 'DELETE' });
        state.inbox = [];
        updateInboxFab();
        hide($('inbox-sheet'));
        $('status').textContent = '';
    } catch (e) {
        alert('Push failed: ' + e.message + '\nLocal changes preserved; will retry next time you press Drop.');
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
    if (node.children) out.children = node.children.map(cleanSnapshot);
    return out;
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
    try {
        await api('/api/shared', { method: 'POST', body: JSON.stringify({ url, title: title || text }) });
    } catch (e) {
        console.warn('Share-target push failed', e);
    } finally {
        // Clean the URL so reload doesn't double-add.
        history.replaceState({}, '', location.pathname);
    }
}

// --- Settings modal ---
function openSettings() {
    $('cfg-url').value = state.config.url || '';
    $('cfg-token').value = state.config.token || '';
    show($('settings-sheet'));
}

function saveSettings() {
    state.config.url = $('cfg-url').value.trim();
    state.config.token = $('cfg-token').value.trim();
    localStorage.setItem(LS.url, state.config.url);
    localStorage.setItem(LS.token, state.config.token);
    hide($('settings-sheet'));
    bootstrap();
}

// --- Wire up ---
window.addEventListener('DOMContentLoaded', () => {
    $('syncBtn').addEventListener('click', async () => {
        await pullSnapshot();
        await refreshInbox();
    });
    $('settingsBtn').addEventListener('click', openSettings);
    $('settings-close').addEventListener('click', () => hide($('settings-sheet')));
    $('cfg-save').addEventListener('click', saveSettings);

    $('inbox-fab').addEventListener('click', openInbox);
    $('inbox-close').addEventListener('click', () => hide($('inbox-sheet')));
    $('dropHereBtn').addEventListener('click', dropHere);

    bootstrap();

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(() => {});
    }
});
