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
        setStatus('Open Settings (⚙) to configure your sync server.');
        return;
    }
    await pullSnapshot();
    await refreshInbox();
    await checkUnfiledLinks();
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
    const sheet = $('quick-file-sheet');
    const isOpen = sheet && !sheet.classList.contains('hidden');
    if (activeQuickFileItems.length > 0 || isOpen) {
        renderQuickFileSheet();
    }
}

function renderQuickFileSheet() {
    const sheet = $('quick-file-sheet');
    const list = $('quick-file-list');
    const hint = $('quick-file-hint');
    
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

    show(sheet);
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
    $('clipBtn').addEventListener('click', async (e) => {
        e.stopPropagation();
        e.preventDefault();

        // 1. Instantly read the clipboard before ANY microtask boundary or async call!
        // This satisfies WebKit's strict security engine in standalone mobile PWAs.
        if (!navigator.clipboard || !navigator.clipboard.readText) {
            showToast('Clipboard API not supported. Paste manually below.');
            renderQuickFileSheet();
            $('quick-file-paste-input').focus();
            return;
        }

        let text = '';
        try {
            text = await navigator.clipboard.readText();
        } catch (e) {
            showToast('Clipboard access denied. Paste manually below.');
            renderQuickFileSheet();
            $('quick-file-paste-input').focus();
            console.warn(e);
            return;
        }

        const trimmed = (text || '').trim();
        if (!trimmed || !/^https?:\/\/\S+$/.test(trimmed)) {
            showToast('No URL in clipboard. Paste manually below.');
            renderQuickFileSheet();
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
            renderQuickFileSheet();
            $('quick-file-paste-input').focus();
            return;
        }

        const dismissed = getDismissedUrls();
        const dismissedSet = new Set(dismissed.map(normalizeUrl));

        if (dismissedSet.has(normTrimmed)) {
            showToast('Previously skipped clipboard link. Paste manually if desired.');
            renderQuickFileSheet();
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
        $('quick-file-paste-input').focus();
    });

    $('pullBtn').addEventListener('click', async (e) => {
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

    $('pushBtn').addEventListener('click', async (e) => {
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

    $('settingsBtn').addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        openSettings();
    });

    $('newFolderBtn').addEventListener('click', async (e) => {
        e.stopPropagation();
        e.preventDefault();

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

    $('settings-close').addEventListener('click', () => hide($('settings-sheet')));
    $('cfg-save').addEventListener('click', saveSettings);

    $('inbox-fab').addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        openInbox();
    });
    $('inbox-close').addEventListener('click', () => hide($('inbox-sheet')));
    $('dropHereBtn').addEventListener('click', dropHere);

    $('quick-file-close').addEventListener('click', () => hide($('quick-file-sheet')));

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
