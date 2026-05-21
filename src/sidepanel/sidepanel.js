// Firefox/Chrome compatibility - Firefox uses 'browser', Chrome uses 'chrome'
// We need to make 'chrome' available globally for all the code that uses it
if (typeof globalThis.chrome === 'undefined' && typeof globalThis.browser !== 'undefined') {
    globalThis.chrome = globalThis.browser;
}
// Ensure chrome is available as a local reference too
const chrome = globalThis.chrome || globalThis.browser;

import { TabGrouper, CONTEXT_KEYWORDS } from '../utils/tabGrouper.js';
import { StorageManager } from '../utils/storageManager.js';
import { BookmarkOrganizer } from '../utils/bookmarkOrganizer.js';
import { AIService } from '../utils/aiService.js';
import { BackendSync } from '../utils/backendSync.js';

// --- State ---
let currentTabs = [];
let savedWorkflows = [];

// --- Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
    // One-time migration of legacy storage.local workflows into bookmark-backed storage.
    try {
        const result = await StorageManager.migrateLegacyIfNeeded();
        if (result.migrated > 0) {
            console.log(`TabPaladin: Migrated ${result.migrated} legacy workflow(s) to bookmarks.`);
        }
    } catch (e) {
        console.warn("Migration check failed (non-fatal):", e);
    }

    await loadWorkflows();
    await loadCurrentTabs();

    console.log("🛠️ StorageManager Loaded:", StorageManager);
    console.log("Existing Workflows:", savedWorkflows);

    setupEventListeners();

    // Live refresh: when bookmarks change (e.g. auto-sync removed a tab), refresh the workflow list.
    const api = typeof browser !== 'undefined' ? browser : chrome;
    const scheduleRefresh = (() => {
        let pending = null;
        return () => {
            if (pending) return;
            pending = setTimeout(async () => {
                pending = null;
                await loadWorkflows();
            }, 250);
        };
    })();

    if (api.bookmarks) {
        if (api.bookmarks.onRemoved) api.bookmarks.onRemoved.addListener(scheduleRefresh);
        if (api.bookmarks.onCreated) api.bookmarks.onCreated.addListener(scheduleRefresh);
        if (api.bookmarks.onChanged) api.bookmarks.onChanged.addListener(scheduleRefresh);
        if (api.bookmarks.onMoved) api.bookmarks.onMoved.addListener(scheduleRefresh);
    }

    setupDragAutoScroll();
});

// Auto-scroll the sidepanel when the cursor approaches the top/bottom edge during a drag.
function setupDragAutoScroll() {
    const EDGE = 60;       // px from edge that triggers scroll
    const BASE_SPEED = 6;  // px per frame at the edge
    const MAX_SPEED = 24;  // px per frame at the very edge
    let direction = 0;     // -1 = up, 1 = down, 0 = idle
    let speed = 0;
    let rafId = null;

    const tick = () => {
        if (direction === 0) { rafId = null; return; }
        // Use the scrolling element — usually documentElement, but fall back to body.
        const el = document.scrollingElement || document.documentElement;
        el.scrollTop += speed * direction;
        rafId = requestAnimationFrame(tick);
    };

    document.addEventListener('dragover', (e) => {
        const y = e.clientY;
        const h = window.innerHeight;
        if (y < EDGE) {
            const intensity = (EDGE - y) / EDGE; // 0..1
            speed = BASE_SPEED + (MAX_SPEED - BASE_SPEED) * intensity;
            direction = -1;
            if (rafId == null) rafId = requestAnimationFrame(tick);
        } else if (y > h - EDGE) {
            const intensity = (y - (h - EDGE)) / EDGE;
            speed = BASE_SPEED + (MAX_SPEED - BASE_SPEED) * intensity;
            direction = 1;
            if (rafId == null) rafId = requestAnimationFrame(tick);
        } else {
            direction = 0;
        }
    });

    const stop = () => {
        direction = 0;
        if (rafId != null) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }
    };
    document.addEventListener('drop', stop, true);
    document.addEventListener('dragend', stop, true);
    document.addEventListener('dragleave', (e) => {
        // Stop scrolling if we've left the entire document.
        if (e.relatedTarget == null) stop();
    });
}

function setupEventListeners() {
    document.getElementById('saveWorkflowBtn').addEventListener('click', saveSessionAndClose);

    async function saveSessionAndClose() {
        try {
            const api = typeof browser !== 'undefined' ? browser : chrome;
            // Current window only — saving across windows is rarely what the user wants
            // and complicates partial-restore + auto-sync.
            const tabs = await api.tabs.query({ currentWindow: true });

            // Filter out internal/extension pages — they can't be reopened anyway
            const saveable = tabs.filter(t => t.url && /^https?:|^file:|^ftp:/.test(t.url));

            if (saveable.length === 0) {
                alert("No saveable tabs in the current window.");
                return;
            }

            const name = prompt("Name this session (e.g. 'Research', 'Private'):");
            if (!name) return;

            await StorageManager.saveWorkflow(name, saveable);

            // Fresh tab so the window doesn't close when we remove the rest
            await api.tabs.create({});

            const tabIds = tabs.map(t => t.id);
            await api.tabs.remove(tabIds);

            loadWorkflows();
            alert("Workflow saved!");
        } catch (err) {
            console.error("Save workflow error:", err);
            alert("Error saving workflow: " + err.message);
        }
    }

    // Dynamic listeners for workflow items
    document.getElementById('workflows-list').addEventListener('click', handleWorkflowClick);
}

// --- Tabs Logic ---
async function loadCurrentTabs() {
    try {
        const api = typeof browser !== 'undefined' ? browser : chrome;
        // Current window only — matches save behavior.
        currentTabs = await api.tabs.query({ currentWindow: true }) || [];
    } catch (e) {
        console.error("Error loading tabs:", e);
        currentTabs = [];
    }
    if (currentTabs.length > 0) {
        renderGroupedTabs();
    }
}

function isMainViewVisible() {
    const c = document.getElementById('groups-container');
    return c && c.style.display !== 'none' && c.classList.contains('main-view');
}

// --- Folder export / import ---
// JSON shape (self-describing; also the wire format for a future backend):
// {
//   version: 1,
//   exportedAt: "ISO",
//   type: "folder",
//   title: "Work",
//   dateAdded: 1234567890,
//   children: [
//     { type: "bookmark", title, url, dateAdded? },
//     { type: "folder", title, children: [...] }
//   ]
// }

function serializeBookmarkNode(node) {
    if (node.url) {
        return { type: 'bookmark', title: node.title, url: node.url, dateAdded: node.dateAdded };
    }
    return {
        type: 'folder',
        title: node.title,
        dateAdded: node.dateAdded,
        children: (node.children || []).map(serializeBookmarkNode)
    };
}

async function exportBookmarkFolder(folderId) {
    const subTree = await chrome.bookmarks.getSubTree(folderId);
    if (!subTree || !subTree[0]) throw new Error('Folder not found');
    const payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        ...serializeBookmarkNode(subTree[0])
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const safe = (payload.title || 'folder').replace(/[^a-z0-9]/gi, '_').toLowerCase() || 'folder';
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    await chrome.downloads.download({
        url,
        filename: `tabpaladin_folder_${safe}_${ts}.json`
    });
}

async function recreateBookmarkChildren(parentId, children) {
    for (const node of children) {
        if (!node || typeof node !== 'object') continue;
        if (node.type === 'bookmark' && node.url) {
            try {
                await chrome.bookmarks.create({ parentId, title: node.title || node.url, url: node.url });
            } catch (e) { console.warn('Failed to create bookmark', node, e); }
        } else if (node.type === 'folder') {
            try {
                const folder = await chrome.bookmarks.create({ parentId, title: node.title || 'Folder' });
                await recreateBookmarkChildren(folder.id, node.children || []);
            } catch (e) { console.warn('Failed to create folder', node, e); }
        }
    }
}

async function importBookmarkFolder(jsonText, parentId = '2') {
    const data = JSON.parse(jsonText);
    if (!data || typeof data !== 'object' || data.type !== 'folder' || !data.title) {
        throw new Error('Not a valid TabPaladin folder export (missing type:folder or title).');
    }

    const siblings = await chrome.bookmarks.getChildren(parentId);
    const existing = siblings.find(s => !s.url && s.title === data.title);

    let finalTitle = data.title;
    if (existing) {
        const choice = await askFolderConflict(data.title);
        if (choice === 'cancel') return null;
        if (choice === 'overwrite') {
            try { await chrome.bookmarks.removeTree(existing.id); }
            catch (e) { throw new Error('Could not delete existing folder: ' + e.message); }
        } else if (choice === 'rename') {
            const newName = prompt(`New name for the imported folder:`, `${data.title} (imported)`);
            if (!newName || !newName.trim()) return null;
            finalTitle = newName.trim();
        }
    }

    const folder = await chrome.bookmarks.create({ parentId, title: finalTitle });
    await recreateBookmarkChildren(folder.id, data.children || []);
    return folder.id;
}

// Minimal modal-like prompt for the 3-way conflict choice using confirm dialogs.
function askFolderConflict(name) {
    return new Promise((resolve) => {
        const msg = `A folder named "${name}" already exists at the import target.\n\n` +
            `OK = Overwrite (delete existing, replace)\n` +
            `Cancel = Pick a different name (rename)\n\n` +
            `Press Esc to cancel the import.`;
        // Use confirm: OK -> overwrite, Cancel -> rename. Escape -> "cancel" via second confirm.
        if (confirm(msg)) {
            resolve('overwrite');
        } else {
            // Distinguish "rename" from "cancel the whole import" with a follow-up
            if (confirm(`Import as a renamed copy of "${name}"?`)) {
                resolve('rename');
            } else {
                resolve('cancel');
            }
        }
    });
}

async function getFolderPath(folderId) {
    const parts = [];
    let id = folderId;
    let safety = 32;
    while (id && safety-- > 0) {
        const nodes = await chrome.bookmarks.get(id).catch(() => []);
        const node = nodes && nodes[0];
        if (!node) break;
        const label = node.title ||
            (node.id === '1' ? 'Bookmarks Bar' : node.id === '2' ? 'Other Bookmarks' : node.id === '3' ? 'Mobile' : '');
        if (label) parts.unshift(label);
        if (!node.parentId || node.parentId === '0') break;
        id = node.parentId;
    }
    return parts.join(' > ');
}

// Module-level state for the main view (AI groups are mutable in-memory; tabs are sourced live).
let mainViewState = {
    aiGroups: [],         // [{ id, name, items: [{tabId, url, title, favIconUrl}] }]
    bookmarkUrls: new Set(), // URLs already in bookmarks — filters Open Tabs
};

async function getAllBookmarkUrls() {
    const urls = new Set();
    const tree = await chrome.bookmarks.getTree();
    function walk(node) {
        if (node.url) urls.add(node.url);
        (node.children || []).forEach(walk);
    }
    tree.forEach(walk);
    return urls;
}

async function renderGroupedTabs() {
    await renderMainView({ regroup: false });
}

async function renderMainView({ regroup = true } = {}) {
    const container = document.getElementById('groups-container');
    container.innerHTML = '';
    container.className = 'main-view';

    const api = typeof browser !== 'undefined' ? browser : chrome;
    const tabs = await api.tabs.query({ currentWindow: true });
    const saveable = tabs.filter(t => t.url && /^https?:|^file:|^ftp:/.test(t.url));

    mainViewState.bookmarkUrls = await getAllBookmarkUrls();
    const filteredTabs = saveable.filter(t => !mainViewState.bookmarkUrls.has(t.url));

    // Build / refresh AI Groups. On first render or explicit regroup, ask TabGrouper.
    // Otherwise preserve existing aiGroups but drop items whose URLs are now bookmarked
    // and drop items whose tabs are closed.
    if (regroup || mainViewState.aiGroups.length === 0) {
        const s = await StorageManager.getSettings();
        const grouped = TabGrouper.groupSmart(filteredTabs, s.customKeywords || {}, s.categoryOrder || null);
        mainViewState.aiGroups = Object.entries(grouped).map(([name, items], idx) => ({
            id: `g_${idx}_${Date.now()}`,
            name,
            items: items.map(t => ({
                tabId: t.id, url: t.url, title: t.title, favIconUrl: t.favIconUrl
            }))
        }));
    } else {
        const tabIdsOpen = new Set(saveable.map(t => t.id));
        mainViewState.aiGroups = mainViewState.aiGroups
            .map(g => ({
                ...g,
                items: g.items.filter(it =>
                    tabIdsOpen.has(it.tabId) && !mainViewState.bookmarkUrls.has(it.url))
            }))
            .filter(g => g.items.length > 0);
    }

    // Tabs that are currently in some AI group — Open Tabs root excludes them.
    const claimedTabIds = new Set();
    mainViewState.aiGroups.forEach(g => g.items.forEach(i => claimedTabIds.add(i.tabId)));
    const unclaimedTabs = filteredTabs.filter(t => !claimedTabIds.has(t.id));

    // Real folder roots for the main view: TabPaladin Workflows (if exists) + focused folders.
    // Workflows is included so users can drag a group or tabs straight into a workflow folder.
    const settings = await StorageManager.getSettings();
    const focused = settings.focusedFolderIds || [];
    const wfRoot = await findWorkflowRootSilent();
    const realRoots = [];
    if (wfRoot) realRoots.push({ id: wfRoot.id, isWorkflow: true });
    for (const id of focused) {
        if (!realRoots.find(r => r.id === id)) realRoots.push({ id, isWorkflow: false });
    }

    // --- Render ---
    const headerBar = document.createElement('div');
    headerBar.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:10px;';
    headerBar.innerHTML = `
        <span style="font-weight:600; color:#ddd; font-size:1rem; flex:1;">Open Tabs &amp; Suggestions</span>
        <button class="sm-btn" id="mainRegroupBtn" title="Re-run smart grouping on the current open tabs">↻ Re-group</button>
    `;
    container.appendChild(headerBar);
    headerBar.querySelector('#mainRegroupBtn').addEventListener('click', () => renderMainView({ regroup: true }));

    const grid = document.createElement('div');
    const totalRoots = 1 + realRoots.length;
    grid.className = totalRoots > 1 ? 'roots-grid multi' : 'roots-grid';
    container.appendChild(grid);

    grid.appendChild(renderOpenTabsCard(unclaimedTabs, mainViewState.aiGroups));

    for (const r of realRoots) {
        try {
            const c = await BookmarkOrganizer.getDirectoryContents(r.id);
            if (!c) continue;
            const card = renderFolderCard({
                id: c.id,
                title: c.title,
                folderCount: c.subfolders.length,
                fileCount: c.looseCount,
                icon: r.isWorkflow ? '🛡️' : '📁'
            }, 0);
            grid.appendChild(card);
        } catch (e) {
            console.warn("Could not load root", r.id, e);
        }
    }
}

function renderOpenTabsCard(unclaimedTabs, aiGroups) {
    const card = document.createElement('div');
    card.className = 'source-folder-card open-tabs-card';
    card.dataset.id = '__open_tabs__';

    const totalTabs = unclaimedTabs.length + aiGroups.reduce((n, g) => n + g.items.length, 0);

    const header = document.createElement('div');
    header.className = 'source-folder-header';
    header.innerHTML = `
        <span class="folder-caret">▼</span>
        <span class="folder-icon">🌐</span>
        <span class="folder-title">Open Tabs</span>
        <span class="folder-stats">${totalTabs}</span>
    `;
    card.appendChild(header);

    const body = document.createElement('div');
    body.className = 'source-folder-body';
    body.style.display = 'block';
    card.appendChild(body);

    if (totalTabs === 0) {
        body.innerHTML = '<div class="src-empty-state">No saveable open tabs (all are bookmarked or browser-internal).</div>';
    } else {
        // 1. Unclaimed tabs at the top — domain-grouped, drag rows. No "group" wrapper card.
        if (unclaimedTabs.length > 0) {
            const ungroupedWrap = document.createElement('div');
            ungroupedWrap.className = 'open-tabs-ungrouped';
            const lbl = document.createElement('div');
            lbl.className = 'src-top-loose-header';
            lbl.textContent = `Ungrouped (${unclaimedTabs.length})`;
            ungroupedWrap.appendChild(lbl);
            appendTabDomainGroups(ungroupedWrap, unclaimedTabs, null);
            body.appendChild(ungroupedWrap);
        }
        // 2. Each AI group as a nested card inside Open Tabs body.
        aiGroups.forEach(g => body.appendChild(renderGroupCard(g)));
    }

    // Expand/collapse the whole Open Tabs card
    const caret = header.querySelector('.folder-caret');
    header.addEventListener('click', (e) => {
        if (e.target.closest('button') || e.target.closest('input')) return;
        if (body.style.display === 'none') {
            body.style.display = 'block';
            caret.textContent = '▼';
        } else {
            body.style.display = 'none';
            caret.textContent = '▶';
        }
    });

    // Drop target: tabs (single or bulk) dragged back from a group return to Open Tabs (un-claim).
    card.addEventListener('dragover', (e) => {
        const types = e.dataTransfer.types;
        if (!types.includes('text/tp-tab') && !types.includes('text/tp-tabs')) return;
        e.preventDefault();
        e.stopPropagation();
        card.classList.add('drop-hover');
    });
    card.addEventListener('dragleave', (e) => {
        if (!card.contains(e.relatedTarget)) card.classList.remove('drop-hover');
    });
    card.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        card.classList.remove('drop-hover');
        const tabsPayload = e.dataTransfer.getData('text/tp-tabs');
        const payload = e.dataTransfer.getData('text/tp-tab');
        try {
            if (tabsPayload) {
                const { items = [], sourceGroupId } = JSON.parse(tabsPayload);
                if (sourceGroupId) {
                    const src = mainViewState.aiGroups.find(g => g.id === sourceGroupId);
                    if (src) {
                        const ids = new Set(items.map(it => it.tabId));
                        src.items = src.items.filter(it => !ids.has(it.tabId));
                    }
                }
                await renderMainView({ regroup: false });
            } else if (payload) {
                const { tabId, sourceGroupId } = JSON.parse(payload);
                if (sourceGroupId) {
                    const g = mainViewState.aiGroups.find(g => g.id === sourceGroupId);
                    if (g) g.items = g.items.filter(it => it.tabId !== tabId);
                }
                await renderMainView({ regroup: false });
            }
        } catch (err) {
            console.warn('Unclaim drop failed', err);
        }
    });

    return card;
}

// Same as appendDomainGroups but the rows carry tab payloads, not bookmark payloads.
function appendTabDomainGroups(container, tabs, sourceGroupId = null) {
    if (!tabs || tabs.length === 0) return;

    const byDomain = {};
    tabs.forEach(t => {
        const d = tabDomain(t.url);
        if (!byDomain[d]) byDomain[d] = [];
        byDomain[d].push(t);
    });

    Object.keys(byDomain).sort().forEach(d => {
        const group = document.createElement('div');
        group.className = 'src-domain-group';

        // Bulk payload for the whole domain.
        const bulkPayload = byDomain[d].map(t => ({
            tabId: t.tabId != null ? t.tabId : t.id,
            url: t.url,
            title: t.title
        }));

        const header = document.createElement('div');
        header.className = 'src-domain-header';
        header.innerHTML = `
            <span class="domain-drag-handle" title="Drag entire domain group" draggable="true">⋮⋮</span>
            <span class="domain-name">${escapeHtml(d)}</span>
            <span class="src-domain-count">(${byDomain[d].length})</span>
        `;
        group.appendChild(header);

        const handle = header.querySelector('.domain-drag-handle');
        handle.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/tp-tabs', JSON.stringify({
                items: bulkPayload,
                sourceGroupId
            }));
            e.dataTransfer.effectAllowed = 'move';
            group.classList.add('dragging');
            console.log('[TabPaladin] Drag start tab-domain', d, 'with', bulkPayload.length, 'tabs from group', sourceGroupId || '(unclaimed)');
            e.stopPropagation();
        });
        handle.addEventListener('dragend', () => group.classList.remove('dragging'));

        byDomain[d].forEach(t => {
            const tabId = t.tabId != null ? t.tabId : t.id;
            const row = document.createElement('div');
            row.className = 'src-tab-row';
            row.draggable = true;
            row.dataset.tabId = String(tabId);
            row.innerHTML = `
                <img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(d)}&sz=16" width="16" height="16" style="flex-shrink:0;">
                <span title="${escapeHtml(t.url)}">${escapeHtml(t.title || t.url)}</span>
            `;
            row.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/tp-tab', JSON.stringify({
                    tabId,
                    url: t.url,
                    title: t.title,
                    sourceGroupId
                }));
                e.dataTransfer.effectAllowed = 'move';
                row.classList.add('dragging');
                e.stopPropagation();
            });
            row.addEventListener('dragend', () => row.classList.remove('dragging'));
            group.appendChild(row);
        });

        container.appendChild(group);
    });
}

function renderGroupCard(group) {
    const card = document.createElement('div');
    // Render as a nested card so it inherits the indented styling used by Organize subfolders.
    card.className = 'source-folder-card ai-group-card nested';
    card.dataset.id = group.id;
    card.dataset.groupId = group.id;

    const header = document.createElement('div');
    header.className = 'source-folder-header';
    header.innerHTML = `
        <span class="folder-drag-handle" title="Drag group to a folder to file it" draggable="true">⋮⋮</span>
        <span class="folder-caret">▼</span>
        <span class="folder-icon">🧠</span>
        <span class="folder-title">${escapeHtml(group.name)}</span>
        <span class="folder-stats">${group.items.length}</span>
    `;
    card.appendChild(header);

    const body = document.createElement('div');
    body.className = 'source-folder-body';
    body.style.display = 'block';
    card.appendChild(body);

    if (group.items.length === 0) {
        body.innerHTML = '<div class="src-empty-state">Empty group.</div>';
    } else {
        appendTabDomainGroups(body, group.items, group.id);
    }

    // Expand/collapse
    const caret = header.querySelector('.folder-caret');
    header.addEventListener('click', (e) => {
        if (e.target.closest('button') || e.target.closest('input') || e.target.classList.contains('folder-drag-handle')) return;
        if (body.style.display === 'none') {
            body.style.display = 'block';
            caret.textContent = '▼';
        } else {
            body.style.display = 'none';
            caret.textContent = '▶';
        }
    });

    // Drag the WHOLE group via the handle.
    const handle = header.querySelector('.folder-drag-handle');
    handle.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/tp-group', JSON.stringify({
            groupId: group.id,
            name: group.name,
            items: group.items
        }));
        e.dataTransfer.effectAllowed = 'move';
        card.classList.add('dragging');
        console.log('[TabPaladin] Drag start group', group.name, 'with', group.items.length, 'tabs');
        e.stopPropagation();
    });
    handle.addEventListener('dragend', () => card.classList.remove('dragging'));

    // Drop target: accept single tabs OR a bulk tab-domain group.
    card.addEventListener('dragover', (e) => {
        const types = e.dataTransfer.types;
        if (!types.includes('text/tp-tab') && !types.includes('text/tp-tabs')) return;
        e.preventDefault();
        e.stopPropagation();
        card.classList.add('drop-hover');
    });
    card.addEventListener('dragleave', (e) => {
        if (!card.contains(e.relatedTarget)) card.classList.remove('drop-hover');
    });
    card.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        card.classList.remove('drop-hover');
        const tabsPayload = e.dataTransfer.getData('text/tp-tabs');
        const payload = e.dataTransfer.getData('text/tp-tab');
        try {
            if (tabsPayload) {
                const { items = [], sourceGroupId } = JSON.parse(tabsPayload);
                if (sourceGroupId === group.id) return;
                if (sourceGroupId) {
                    const src = mainViewState.aiGroups.find(g => g.id === sourceGroupId);
                    if (src) {
                        const ids = new Set(items.map(it => it.tabId));
                        src.items = src.items.filter(it => !ids.has(it.tabId));
                    }
                }
                const existingIds = new Set(group.items.map(it => it.tabId));
                items.forEach(it => {
                    if (!existingIds.has(it.tabId)) group.items.push(it);
                });
                await renderMainView({ regroup: false });
            } else if (payload) {
                const { tabId, url, title, sourceGroupId } = JSON.parse(payload);
                if (sourceGroupId === group.id) return;
                if (sourceGroupId) {
                    const src = mainViewState.aiGroups.find(g => g.id === sourceGroupId);
                    if (src) src.items = src.items.filter(it => it.tabId !== tabId);
                }
                if (!group.items.find(it => it.tabId === tabId)) {
                    group.items.push({ tabId, url, title });
                }
                await renderMainView({ regroup: false });
            }
        } catch (err) {
            console.warn('Group drop failed', err);
        }
    });

    return card;
}

// --- Workflows Logic ---
async function loadWorkflows() {
    savedWorkflows = await StorageManager.getWorkflows();
    renderWorkflows();
}

function tabDomain(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch (e) {
        return 'unknown';
    }
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

async function renderWorkflows() {
    const list = document.getElementById('workflows-list');
    list.innerHTML = '';

    const wfRoot = await findWorkflowRootSilent();
    if (!wfRoot) {
        list.innerHTML = '<li class="empty-state">No saved workflows.</li>';
        return;
    }

    const children = await chrome.bookmarks.getChildren(wfRoot.id);
    const wfFolders = children.filter(c => !c.url);
    if (wfFolders.length === 0) {
        list.innerHTML = '<li class="empty-state">No saved workflows.</li>';
        return;
    }

    // Render each workflow as a folder card with the workflow Open button.
    // List items become non-list divs since the folder-card UI doesn't fit <li> semantics.
    list.style.listStyle = 'none';
    list.style.padding = '0';
    for (const wf of wfFolders) {
        const wfChildren = await chrome.bookmarks.getChildren(wf.id);
        const card = renderFolderCard({
            id: wf.id,
            title: wf.title,
            parentId: wfRoot.id,
            folderCount: wfChildren.filter(c => !c.url).length,
            fileCount: wfChildren.filter(isVisibleBookmark).length,
            icon: '🛡️',
            isWorkflow: true
        }, 0);
        const li = document.createElement('li');
        li.style.listStyle = 'none';
        li.appendChild(card);
        list.appendChild(li);
    }
}

function renderWorkflowBody(wf, body) {
    const byDomain = {};
    wf.tabs.forEach(t => {
        const d = tabDomain(t.url);
        if (!byDomain[d]) byDomain[d] = [];
        byDomain[d].push(t);
    });

    const domains = Object.keys(byDomain).sort();
    const groupsHtml = domains.map(d => {
        const tabsHtml = byDomain[d].map(t => `
            <label class="wf-tab-row" style="display:flex; align-items:center; gap:8px; padding:4px 8px 4px 24px; cursor:pointer;">
                <input type="checkbox" class="wf-tab-check" data-bookmark-id="${t.id}" data-domain="${escapeHtml(d)}">
                <img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(d)}&sz=16" width="16" height="16" style="flex-shrink:0;">
                <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:0.85rem;" title="${escapeHtml(t.url)}">${escapeHtml(t.title || t.url)}</span>
            </label>
        `).join('');

        return `
            <div class="wf-domain-group" data-domain="${escapeHtml(d)}">
                <label style="display:flex; align-items:center; gap:8px; padding:6px 8px; background:rgba(255,255,255,0.03); cursor:pointer; font-weight:600;">
                    <input type="checkbox" class="wf-domain-check" data-domain="${escapeHtml(d)}">
                    <span style="flex:1;">${escapeHtml(d)}</span>
                    <span style="color:var(--text-muted); font-weight:400; font-size:0.8rem;">${byDomain[d].length}</span>
                </label>
                <div class="wf-tabs">${tabsHtml}</div>
            </div>
        `;
    }).join('');

    body.innerHTML = `
        <div style="padding:8px; background:rgba(0,0,0,0.15); border-radius:6px; margin-top:6px;">
            ${groupsHtml || '<div style="color:var(--text-muted); padding:8px;">No tabs in this workflow.</div>'}
            <div style="display:flex; gap:6px; margin-top:10px; padding-top:10px; border-top:1px solid var(--border-color);">
                <button class="sm-btn wf-open-selected-btn primary-btn" style="flex:1; padding:6px;">Open Selected</button>
                <button class="sm-btn wf-open-here-btn" style="flex:1; padding:6px;" title="Open selected in current window">Open Here</button>
            </div>
        </div>
    `;

    // Wire domain-level checkboxes (toggle all tabs in that domain)
    body.querySelectorAll('.wf-domain-check').forEach(domCb => {
        domCb.addEventListener('change', () => {
            const d = domCb.dataset.domain;
            body.querySelectorAll(`.wf-tab-check[data-domain="${d}"]`).forEach(cb => {
                cb.checked = domCb.checked;
            });
        });
    });

    // When a tab checkbox changes, reflect indeterminate state on the domain row
    body.querySelectorAll('.wf-tab-check').forEach(tabCb => {
        tabCb.addEventListener('change', () => {
            const d = tabCb.dataset.domain;
            const all = Array.from(body.querySelectorAll(`.wf-tab-check[data-domain="${d}"]`));
            const checked = all.filter(c => c.checked).length;
            const domCb = body.querySelector(`.wf-domain-check[data-domain="${d}"]`);
            if (domCb) {
                domCb.checked = checked === all.length;
                domCb.indeterminate = checked > 0 && checked < all.length;
            }
        });
    });

    // Open Selected (new window)
    body.querySelector('.wf-open-selected-btn').addEventListener('click', async () => {
        const ids = collectCheckedBookmarkIds(body);
        if (ids.length === 0) { alert("No tabs selected."); return; }
        await StorageManager.restoreWorkflow(wf, { bookmarkIds: ids });
    });

    // Open Here (current window)
    body.querySelector('.wf-open-here-btn').addEventListener('click', async () => {
        const ids = collectCheckedBookmarkIds(body);
        if (ids.length === 0) { alert("No tabs selected."); return; }
        await StorageManager.restoreWorkflow(wf, { bookmarkIds: ids, inCurrentWindow: true });
    });
}

function collectCheckedBookmarkIds(body) {
    return Array.from(body.querySelectorAll('.wf-tab-check:checked')).map(c => c.dataset.bookmarkId);
}

// --- Import/Export Workflow Handlers ---
document.getElementById('exportAllWorkflowsBtn').addEventListener('click', async () => {
    try {
        await StorageManager.exportWorkflows();
    } catch (e) {
        console.error("Export failed:", e);
        alert("Export failed: " + e.message);
    }
});

document.getElementById('importWorkflowsBtn').addEventListener('click', () => {
    document.getElementById('importFileInput').click();
});

document.getElementById('importFileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    try {
        const text = await file.text();
        const result = await StorageManager.importWorkflows(text);
        if (result.success) {
            await loadWorkflows();
            alert(`Imported ${result.count} workflow(s) successfully!`);
        } else {
            alert("Import failed: " + result.error);
        }
    } catch (err) {
        console.error("Import error:", err);
        alert("Import failed: " + err.message);
    }
    e.target.value = ''; // Reset file input
});


// Handle clicking a workflow (toggle expand, restore, delete, export)
async function handleWorkflowClick(e) {
    const wrapper = e.target.closest('.workflow-item-wrapper');
    if (!wrapper) return;

    const id = wrapper.dataset.id;
    const wf = savedWorkflows.find(w => w.id === id);
    if (!wf) return;

    // Export single workflow
    if (e.target.classList.contains('export-wf-btn')) {
        e.stopPropagation();
        try {
            const blob = new Blob([JSON.stringify([wf], null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const safeName = wf.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
            await chrome.downloads.download({
                url: url,
                filename: `workflow_${safeName}.json`
            });
        } catch (err) {
            console.error("Export single failed:", err);
            alert("Export failed: " + err.message);
        }
        return;
    }

    // Delete
    if (e.target.classList.contains('delete-wf-btn')) {
        e.stopPropagation();
        if (confirm(`Delete workflow "${wf.name}"?`)) {
            await StorageManager.deleteWorkflow(id);
            loadWorkflows();
        }
        return;
    }

    // Open all in new window
    if (e.target.classList.contains('restore-all-btn')) {
        e.stopPropagation();
        await StorageManager.restoreWorkflow(wf);
        return;
    }

    // Toggle expand on header / caret / name
    if (e.target.closest('.wf-toggle')) {
        const body = wrapper.querySelector('.workflow-body');
        const caret = wrapper.querySelector('.wf-caret');
        if (body.style.display === 'none') {
            renderWorkflowBody(wf, body);
            body.style.display = 'block';
            caret.textContent = '▼';
        } else {
            body.style.display = 'none';
            caret.textContent = '▶';
        }
    }
}

// --- Bookmark Organizer Logic ---
let currentProposal = null;
let currentNavStack = []; // Stack of {id, title} for breadcrumbs.
// Virtual root sentinel: shown when multiple focused folders are selected in settings.
const VIRTUAL_ROOT_ID = '__virtual_root__';

async function findWorkflowRootSilent() {
    try {
        const matches = await chrome.bookmarks.search({ title: 'TabPaladin Workflows' });
        return matches.find(m => !m.url) || null;
    } catch (e) {
        return null;
    }
}

// Hide internal meta sentinel bookmarks from rendering.
const TP_META_TITLE = '__tabpaladin_meta__';
function isVisibleBookmark(node) {
    return node && node.url && node.title !== TP_META_TITLE;
}

// Open an array of bookmark-shaped {url, title} items as tabs in a new window.
async function openBookmarksAsNewWindow(bookmarks) {
    if (!bookmarks || bookmarks.length === 0) return;
    const api = typeof browser !== 'undefined' ? browser : chrome;
    const win = await api.windows.create({ url: bookmarks[0].url, focused: true });
    for (let i = 1; i < bookmarks.length; i++) {
        await api.tabs.create({ windowId: win.id, url: bookmarks[i].url });
    }
}

// Open a single bookmark in a new (background) tab in the current window.
async function openBookmarkInCurrentWindow(url) {
    const api = typeof browser !== 'undefined' ? browser : chrome;
    await api.tabs.create({ url, active: false });
}

async function openWorkflowAsTabs(folderId, folderTitle) {
    const children = await chrome.bookmarks.getChildren(folderId);
    const bookmarks = children.filter(isVisibleBookmark);
    if (bookmarks.length === 0) {
        alert(`"${folderTitle}" has no bookmarks to open.`);
        return;
    }
    const api = typeof browser !== 'undefined' ? browser : chrome;
    const win = await api.windows.create({ url: bookmarks[0].url, focused: true });

    const opened = [];
    const wTabs = await api.tabs.query({ windowId: win.id });
    if (wTabs[0]) opened.push({ tabId: wTabs[0].id, bookmarkId: bookmarks[0].id });
    for (let i = 1; i < bookmarks.length; i++) {
        const tab = await api.tabs.create({ windowId: win.id, url: bookmarks[i].url });
        opened.push({ tabId: tab.id, bookmarkId: bookmarks[i].id });
    }

    // Tell background.js to track these tabs → bookmarks so closing one removes it from the workflow.
    try {
        await api.runtime.sendMessage({
            type: 'TP_TRACK_WORKFLOW_TABS',
            workflowId: folderId,
            entries: opened
        });
    } catch (e) {}
}

async function renderSourceGrid(folderId) {
    const sourceList = document.getElementById('source-list');
    sourceList.innerHTML = '';
    sourceList.className = 'source-folder-list';

    // Virtual root: TabPaladin Workflows + focused folders (if any), laid out side-by-side.
    if (folderId === VIRTUAL_ROOT_ID) {
        const settings = await StorageManager.getSettings();
        const focused = settings.focusedFolderIds || [];

        const roots = [];
        const wfRoot = await findWorkflowRootSilent();
        if (wfRoot) roots.push({ id: wfRoot.id, isWorkflow: true });
        for (const id of focused) {
            if (!roots.find(r => r.id === id)) roots.push({ id, isWorkflow: false });
        }
        if (roots.length === 0) roots.push({ id: '2', isWorkflow: false }); // Fallback: Other Bookmarks

        sourceList.appendChild(buildOrganizeHeader('Sources', null));

        const grid = document.createElement('div');
        grid.className = roots.length > 1 ? 'roots-grid multi' : 'roots-grid';
        sourceList.appendChild(grid);

        for (const r of roots) {
            try {
                const c = await BookmarkOrganizer.getDirectoryContents(r.id);
                if (!c) continue;
                const card = renderFolderCard({
                    id: c.id,
                    title: c.title,
                    folderCount: c.subfolders.length,
                    fileCount: c.looseCount,
                    icon: r.isWorkflow ? '🛡️' : '📁'
                }, 0);
                grid.appendChild(card);
            } catch (e) {
                console.warn("Could not load root", r.id, e);
            }
        }
        return;
    }

    const content = await BookmarkOrganizer.getDirectoryContents(folderId);
    if (!content) return;

    sourceList.appendChild(buildOrganizeHeader(content.title, content.id));

    // Render each subfolder as a card. Direct bookmarks of `folderId` would be siblings —
    // surface them by expanding the breadcrumb itself: any user who wants to see them
    // can open the parent breadcrumb level via Back, or expand the folder card from above.
    // For now: if the breadcrumb folder has loose bookmarks, render them as a section at the top.
    if (content.looseCount > 0) {
        const looseChildren = (await chrome.bookmarks.getChildren(content.id)).filter(isVisibleBookmark);
        if (looseChildren.length > 0) {
            sourceList.appendChild(renderTopLevelLooseSection(content.id, looseChildren));
        }
    }

    for (const sub of content.subfolders) {
        // Pass parentId so refresh-on-drop knows where to update.
        sourceList.appendChild(renderFolderCard({ ...sub, parentId: content.id }, 0));
    }
}

// Renders loose bookmarks of the current breadcrumb folder as a flat group above the subfolder cards.
function renderTopLevelLooseSection(parentFolderId, looseBookmarks) {
    const wrap = document.createElement('div');
    wrap.className = 'src-top-loose';

    const header = document.createElement('div');
    header.className = 'src-top-loose-header';
    header.textContent = `Loose bookmarks here (${looseBookmarks.length})`;
    wrap.appendChild(header);

    appendDomainGroups(wrap, looseBookmarks, parentFolderId);
    return wrap;
}

function buildOrganizeHeader(title, parentFolderId) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:10px;';

    if (currentNavStack.length > 1) {
        const backBtn = document.createElement('button');
        backBtn.className = 'sm-btn';
        backBtn.innerHTML = '<span style="font-size:1.1rem;">⬅</span> Back';
        backBtn.style.cssText = 'border:none; background:transparent; color:#9ca3af; padding:4px 8px;';
        backBtn.addEventListener('click', () => {
            currentNavStack.pop();
            const prev = currentNavStack[currentNavStack.length - 1];
            renderSourceGrid(prev.id);
        });
        wrap.appendChild(backBtn);
    }

    const titleEl = document.createElement('span');
    titleEl.style.cssText = 'font-weight:600; color:#ddd; font-size:1rem; flex:1;';
    titleEl.textContent = title;
    wrap.appendChild(titleEl);

    // + New Folder is only meaningful when we're inside a real folder.
    if (parentFolderId) {
        const newBtn = document.createElement('button');
        newBtn.className = 'sm-btn';
        newBtn.textContent = '+ New Folder';
        newBtn.title = `Create a folder inside "${title}"`;
        newBtn.addEventListener('click', async () => {
            const name = prompt(`Name for new folder inside "${title}":`);
            if (!name) return;
            try {
                const created = await chrome.bookmarks.create({ parentId: parentFolderId, title: name });
                console.log('[TabPaladin] Created folder', created);
                // Refresh the top-level view if we're at this folder's breadcrumb.
                const top = currentNavStack[currentNavStack.length - 1];
                if (top && top.id === parentFolderId) {
                    await renderSourceGrid(parentFolderId);
                }
                // Also surgically refresh any expanded body that shows this parent.
                await refreshFolderBodyIfOpen(parentFolderId);
            } catch (e) {
                console.error('[TabPaladin] Folder create failed', e);
                alert("Could not create folder: " + e.message);
            }
        });
        wrap.appendChild(newBtn);
    }

    return wrap;
}

function renderFolderCard(sub, depth = 0) {
    const card = document.createElement('div');
    card.className = 'source-folder-card';
    if (depth > 0) card.classList.add('nested');
    card.dataset.id = sub.id;
    card.dataset.depth = String(depth);
    if (sub.parentId) card.dataset.parentId = String(sub.parentId);

    // Indent nested cards so hierarchy is visible.
    if (depth > 0) card.style.marginLeft = `${Math.min(depth, 6) * 14}px`;

    // Header
    const header = document.createElement('div');
    header.className = 'source-folder-header';

    const statsParts = [];
    if (sub.folderCount > 0) statsParts.push(`${sub.folderCount} 📁`);
    if (sub.fileCount > 0) statsParts.push(`${sub.fileCount} 📄`);
    const stats = statsParts.join(' · ') || 'Empty';

    const openBtnHtml = sub.isWorkflow
        ? `<button class="sm-btn open-workflow-btn" title="Open all bookmarks in a new window" style="padding:2px 8px;">▶ Open</button>`
        : '';
    // Drill jumps into the Organize folder grid; that target is the Organize page, not the
    // Workflows page. Hide drill on workflow cards to avoid an apparent dead button.
    const drillBtnHtml = sub.isWorkflow
        ? ''
        : `<button class="sm-btn drill-btn" title="Enter ${escapeHtml(sub.title)}" style="padding:2px 8px;">›</button>`;
    header.innerHTML = `
        <span class="folder-drag-handle" title="Drag to move folder" draggable="true">⋮⋮</span>
        <span class="folder-caret">▶</span>
        <span class="folder-icon">${sub.icon || '📁'}</span>
        <span class="folder-title">${escapeHtml(sub.title)}</span>
        <span class="folder-stats">${stats}</span>
        ${openBtnHtml}
        <button class="sm-btn split-btn" title="Sort loose files in this folder" style="padding:2px 8px;">✨ Split</button>
        <button class="sm-btn new-subfolder-btn" title="Create a folder inside ${escapeHtml(sub.title)}" style="padding:2px 8px;">＋📁</button>
        ${drillBtnHtml}
        <input type="checkbox" class="source-select-check" title="Select for batch action (Analyze & Sort / Restructure)">
    `;
    card.appendChild(header);

    // Body (collapsed by default)
    const body = document.createElement('div');
    body.className = 'source-folder-body';
    body.style.display = 'none';
    card.appendChild(body);

    // Toggle expand on header click (ignoring interactive children).
    const caret = header.querySelector('.folder-caret');
    header.addEventListener('click', async (e) => {
        if (e.target.closest('button') || e.target.closest('input')) return;
        if (body.style.display === 'none') {
            await renderFolderBody(sub.id, body, depth);
            body.style.display = 'block';
            caret.textContent = '▼';
        } else {
            body.style.display = 'none';
            caret.textContent = '▶';
        }
    });

    // Drill — push breadcrumb and re-render at that folder (only for non-workflow cards).
    const drillBtn = header.querySelector('.drill-btn');
    if (drillBtn) {
        drillBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            currentNavStack.push({ id: sub.id, title: sub.title });
            renderSourceGrid(sub.id);
        });
    }

    // Split = AI/heuristic on this folder's loose files only.
    header.querySelector('.split-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        await runSplitOnFolder(sub.id, sub.title);
    });

    // Open workflow as tabs (only present when isWorkflow is set).
    const openBtn = header.querySelector('.open-workflow-btn');
    if (openBtn) {
        openBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            try { await openWorkflowAsTabs(sub.id, sub.title); }
            catch (err) { alert('Open failed: ' + err.message); }
        });
    }

    // New subfolder button — creates a folder inside this one.
    header.querySelector('.new-subfolder-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        const name = prompt(`Name for new folder inside "${sub.title}":`);
        if (!name) return;
        try {
            await chrome.bookmarks.create({ parentId: sub.id, title: name.trim() });
            // Expand the card so the user sees the new folder.
            const caret = header.querySelector('.folder-caret');
            if (body.style.display === 'none') {
                await renderFolderBody(sub.id, body, depth);
                body.style.display = 'block';
                if (caret) caret.textContent = '▼';
            } else {
                await renderFolderBody(sub.id, body, depth);
            }
            // Update header stats.
            await refreshFolderBodyIfOpen(sub.id);
        } catch (err) {
            alert('Could not create folder: ' + err.message);
        }
    });

    // Checkbox: select for batch Analyze/Restructure.
    const checkbox = header.querySelector('.source-select-check');
    checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
            card.classList.add('selected');
            card.dataset.value = sub.id;
        } else {
            card.classList.remove('selected');
            delete card.dataset.value;
        }
    });

    // Middle-click on the card → open all loose bookmarks under this folder as a new window.
    header.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
    header.addEventListener('auxclick', async (e) => {
        if (e.button !== 1) return;
        if (e.target.closest('button') || e.target.closest('input')) return;
        e.preventDefault();
        try {
            const kids = await chrome.bookmarks.getChildren(sub.id);
            const bookmarks = kids.filter(isVisibleBookmark);
            if (bookmarks.length === 0) return;
            await openBookmarksAsNewWindow(bookmarks);
        } catch (err) { console.warn('Middle-click open failed', err); }
    });

    // Only the drag handle initiates folder drag — avoids button/input conflicts
    // and nested-draggable issues.
    const handle = header.querySelector('.folder-drag-handle');
    handle.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/tp-folder-id', String(sub.id));
        e.dataTransfer.setData('text/tp-parent-id', String(sub.parentId || ''));
        e.dataTransfer.effectAllowed = 'move';
        card.classList.add('dragging');
        console.log('[TabPaladin] Drag start folder', sub.id, 'parent', sub.parentId);
        e.stopPropagation();
    });
    handle.addEventListener('dragend', () => card.classList.remove('dragging'));

    // Spring-loaded folder timer (Finder-style auto-expand on drag-hover).
    let springTimer = null;
    const cancelSpring = () => {
        if (springTimer) { clearTimeout(springTimer); springTimer = null; }
    };

    // Drop target — accept dragged bookmark, bulk bookmarks, folder, tab, bulk tabs, or AI group.
    card.addEventListener('dragover', (e) => {
        const types = e.dataTransfer.types;
        if (!types.includes('text/tp-bookmark-id') &&
            !types.includes('text/tp-bookmark-ids') &&
            !types.includes('text/tp-folder-id') &&
            !types.includes('text/tp-tab') &&
            !types.includes('text/tp-tabs') &&
            !types.includes('text/tp-group')) return;
        e.preventDefault();
        e.stopPropagation();
        card.classList.add('drop-hover');

        // Schedule auto-expand if collapsed.
        if (body.style.display === 'none' && springTimer == null) {
            springTimer = setTimeout(async () => {
                springTimer = null;
                if (body.style.display !== 'none') return; // user expanded it manually meanwhile
                await renderFolderBody(sub.id, body, depth);
                body.style.display = 'block';
                const caretEl = header.querySelector('.folder-caret');
                if (caretEl) caretEl.textContent = '▼';
            }, 700);
        }
    });
    card.addEventListener('dragleave', (e) => {
        if (!card.contains(e.relatedTarget)) {
            card.classList.remove('drop-hover');
            cancelSpring();
        }
    });
    card.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        card.classList.remove('drop-hover');
        cancelSpring();

        const bookmarkId = e.dataTransfer.getData('text/tp-bookmark-id');
        const bookmarkIdsJson = e.dataTransfer.getData('text/tp-bookmark-ids');
        const draggedFolderId = e.dataTransfer.getData('text/tp-folder-id');
        const sourceParentId = e.dataTransfer.getData('text/tp-parent-id');
        const tabPayload = e.dataTransfer.getData('text/tp-tab');
        const tabsPayload = e.dataTransfer.getData('text/tp-tabs');
        const groupPayload = e.dataTransfer.getData('text/tp-group');

        console.log('[TabPaladin] Drop on folder', sub.id, '— bookmark:', bookmarkId || '(none)', 'group(bookmarks):', bookmarkIdsJson || '(none)', 'folder:', draggedFolderId || '(none)', 'tab:', tabPayload || '(none)', 'tabs:', tabsPayload || '(none)', 'aiGroup:', groupPayload || '(none)');

        const closeTabs = isMainViewVisible(); // honor main view's expectation
        const closedTabIds = [];

        try {
            if (groupPayload) {
                // AI Group → create subfolder + bookmarks for each item, then close source tabs.
                const g = JSON.parse(groupPayload);
                if (!g.items || g.items.length === 0) return;
                // Create subfolder under target with the group name (reuse existing if name matches).
                const siblings = await chrome.bookmarks.getChildren(sub.id);
                const existing = siblings.find(s => !s.url && s.title.toLowerCase() === g.name.toLowerCase());
                const folderId = existing ? existing.id : (await chrome.bookmarks.create({ parentId: sub.id, title: g.name })).id;
                for (const it of g.items) {
                    await chrome.bookmarks.create({ parentId: folderId, title: it.title || it.url, url: it.url });
                    if (closeTabs && it.tabId != null) closedTabIds.push(it.tabId);
                }
                // Remove group from main-view state.
                mainViewState.aiGroups = mainViewState.aiGroups.filter(x => x.id !== g.groupId);
            } else if (tabsPayload) {
                // Bulk tabs (a whole domain group).
                // Special case: main view + drop on the workflows ROOT → auto-create a
                // domain subfolder (numeric suffix on name conflict). Everywhere else,
                // just bookmark the items directly into the target folder.
                const { items = [], sourceGroupId } = JSON.parse(tabsPayload);
                if (items.length > 0) {
                    let targetFolderId = sub.id;
                    const wfRoot = await findWorkflowRootSilent();
                    const shouldNestByDomain = isMainViewVisible() && wfRoot && sub.id === wfRoot.id;

                    if (shouldNestByDomain) {
                        let domain = 'Tabs';
                        try { domain = new URL(items[0].url).hostname.replace(/^www\./, ''); } catch (err) {}
                        const siblings = await chrome.bookmarks.getChildren(sub.id);
                        const takenNames = new Set(siblings.filter(s => !s.url).map(s => s.title));
                        let name = domain, suffix = 2;
                        while (takenNames.has(name)) name = `${domain} (${suffix++})`;
                        const subfolder = await chrome.bookmarks.create({ parentId: sub.id, title: name });
                        targetFolderId = subfolder.id;
                    }

                    for (const it of items) {
                        await chrome.bookmarks.create({ parentId: targetFolderId, title: it.title || it.url, url: it.url });
                        if (closeTabs && it.tabId != null) closedTabIds.push(it.tabId);
                    }

                    if (sourceGroupId) {
                        const src = mainViewState.aiGroups.find(g => g.id === sourceGroupId);
                        if (src) {
                            const ids = new Set(items.map(it => it.tabId));
                            src.items = src.items.filter(it => !ids.has(it.tabId));
                        }
                    }
                }
            } else if (tabPayload) {
                // Single tab → one bookmark in this folder.
                const t = JSON.parse(tabPayload);
                await chrome.bookmarks.create({ parentId: sub.id, title: t.title || t.url, url: t.url });
                if (closeTabs && t.tabId != null) closedTabIds.push(t.tabId);
                // Remove tab from its source AI group, if any.
                if (t.sourceGroupId) {
                    const src = mainViewState.aiGroups.find(g => g.id === t.sourceGroupId);
                    if (src) src.items = src.items.filter(it => it.tabId !== t.tabId);
                }
            } else if (bookmarkIdsJson) {
                let ids = [];
                try { ids = JSON.parse(bookmarkIdsJson); } catch (err) { console.warn('Bad bookmark-ids payload'); }
                for (const id of ids) {
                    try { await chrome.bookmarks.move(String(id), { parentId: sub.id }); }
                    catch (err) { console.warn('Failed to move bookmark', id, err); }
                }
            } else if (bookmarkId) {
                await chrome.bookmarks.move(bookmarkId, { parentId: sub.id });
            } else if (draggedFolderId) {
                if (draggedFolderId === sub.id) { console.log('[TabPaladin] Skipped self-drop'); return; }
                if (await isAncestorOf(draggedFolderId, sub.id)) {
                    alert("Can't move a folder into one of its own descendants.");
                    return;
                }
                await chrome.bookmarks.move(draggedFolderId, { parentId: sub.id });
            } else {
                console.log('[TabPaladin] Drop ignored — no payload');
                return;
            }

            // Close any tabs that were committed.
            if (closedTabIds.length > 0) {
                try {
                    const api = typeof browser !== 'undefined' ? browser : chrome;
                    const winTabs = await api.tabs.query({ currentWindow: true });
                    const active = winTabs.find(t => t.active);
                    const safeIds = closedTabIds.filter(id => {
                        const t = winTabs.find(w => w.id === id);
                        return t && !t.pinned && !(active && t.id === active.id);
                    });
                    if (safeIds.length > 0) {
                        // If closing would empty the window, open a blank tab first.
                        const remaining = winTabs.filter(t => !safeIds.includes(t.id));
                        if (remaining.length === 0) await api.tabs.create({});
                        await api.tabs.remove(safeIds);
                    }
                } catch (err) { console.warn('Tab close failed', err); }
            }

            // Refresh whichever view we're in.
            if (isMainViewVisible()) {
                await renderMainView({ regroup: false });
            } else {
                if (sourceParentId) await refreshFolderBodyIfOpen(sourceParentId);
                await refreshFolderBodyIfOpen(sub.id);
                const top = currentNavStack[currentNavStack.length - 1];
                if (top && (top.id === sourceParentId || top.id === sub.id)) {
                    await renderSourceGrid(top.id);
                }
            }
        } catch (err) {
            console.error('[TabPaladin] Drop action failed:', err);
            alert("Action failed: " + err.message);
        }
    });

    return card;
}

// Render domain groups into `container`. Each group is draggable as a unit via a ⋮⋮ handle;
// each row is also draggable individually.
function appendDomainGroups(container, bookmarks, parentFolderId) {
    if (!bookmarks || bookmarks.length === 0) return;

    const byDomain = {};
    bookmarks.forEach(b => {
        const d = tabDomain(b.url);
        if (!byDomain[d]) byDomain[d] = [];
        byDomain[d].push(b);
    });

    Object.keys(byDomain).sort().forEach(d => {
        const group = document.createElement('div');
        group.className = 'src-domain-group';
        group.dataset.domain = d;
        group.dataset.parentId = String(parentFolderId);

        const header = document.createElement('div');
        header.className = 'src-domain-header';
        const ids = byDomain[d].map(b => b.id);
        const count = byDomain[d].length;
        // Show "Open 10" only when there's more than 10 to make a difference.
        const open10Html = count > 10
            ? `<button class="sm-btn domain-open-10-btn" title="Open first 10 in a new window" style="padding:2px 6px;">▶ 10</button>`
            : '';
        header.innerHTML = `
            <span class="domain-drag-handle" title="Drag entire group" draggable="true">⋮⋮</span>
            <span class="domain-name">${escapeHtml(d)}</span>
            <span class="src-domain-count">(${count})</span>
            <button class="sm-btn domain-open-all-btn" title="Open all in a new window" style="padding:2px 6px;">▶ All</button>
            ${open10Html}
        `;
        group.appendChild(header);

        // Open All / Open 10 click handlers
        header.querySelector('.domain-open-all-btn').addEventListener('click', async (e) => {
            e.stopPropagation();
            await openBookmarksAsNewWindow(byDomain[d]);
        });
        const open10Btn = header.querySelector('.domain-open-10-btn');
        if (open10Btn) {
            open10Btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                await openBookmarksAsNewWindow(byDomain[d].slice(0, 10));
            });
        }

        // Middle click on the domain row opens all in a new window too.
        const ignoreOnInteractive = (e) => e.target.closest('button') || e.target.closest('input');
        header.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
        header.addEventListener('auxclick', async (e) => {
            if (e.button !== 1 || ignoreOnInteractive(e)) return;
            e.preventDefault();
            await openBookmarksAsNewWindow(byDomain[d]);
        });

        // Group-level drag (all bookmarks in this domain)
        const handle = header.querySelector('.domain-drag-handle');
        handle.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/tp-bookmark-ids', JSON.stringify(ids));
            e.dataTransfer.setData('text/tp-parent-id', String(parentFolderId));
            e.dataTransfer.effectAllowed = 'move';
            group.classList.add('dragging');
            console.log('[TabPaladin] Drag start group', d, 'with', ids.length, 'bookmarks from parent', parentFolderId);
            e.stopPropagation();
        });
        handle.addEventListener('dragend', () => group.classList.remove('dragging'));

        // Individual rows
        byDomain[d].forEach(b => {
            const row = document.createElement('div');
            row.className = 'src-tab-row';
            row.draggable = true;
            row.dataset.bookmarkId = b.id;
            row.dataset.parentId = String(parentFolderId);
            row.innerHTML = `
                <img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(d)}&sz=16" width="16" height="16" style="flex-shrink:0;">
                <span title="${escapeHtml(b.url)}">${escapeHtml(b.title || b.url)}</span>
            `;
            row.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/tp-bookmark-id', String(b.id));
                e.dataTransfer.setData('text/tp-parent-id', String(parentFolderId));
                e.dataTransfer.effectAllowed = 'move';
                row.classList.add('dragging');
                e.stopPropagation();
            });
            row.addEventListener('dragend', () => row.classList.remove('dragging'));

            // Middle-click on a bookmark row → open in a new background tab in the current window.
            row.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
            row.addEventListener('auxclick', async (e) => {
                if (e.button !== 1) return;
                e.preventDefault();
                await openBookmarkInCurrentWindow(b.url);
            });

            group.appendChild(row);
        });

        container.appendChild(group);
    });
}

async function renderFolderBody(folderId, body, depth = 0) {
    // Recursive: show subfolders (as nested cards) + loose bookmarks (grouped by domain).
    const tree = await chrome.bookmarks.getSubTree(folderId);
    if (!tree || !tree[0]) return;
    const children = tree[0].children || [];
    const subfolders = children.filter(c => !c.url);
    const looseBookmarks = children.filter(isVisibleBookmark);

    body.innerHTML = '';

    if (subfolders.length === 0 && looseBookmarks.length === 0) {
        body.innerHTML = '<div class="src-empty-state">This folder is empty.</div>';
        return;
    }

    // If this body belongs to the TabPaladin Workflows root, mark each child folder as a workflow.
    const wfRoot = await findWorkflowRootSilent();
    const parentIsWorkflowsRoot = wfRoot && wfRoot.id === folderId;

    // Subfolders first — each as a nested expandable card.
    for (const sf of subfolders) {
        const sfChildren = await chrome.bookmarks.getChildren(sf.id);
        const card = renderFolderCard({
            id: sf.id,
            title: sf.title,
            parentId: folderId,
            folderCount: sfChildren.filter(c => !c.url).length,
            fileCount: sfChildren.filter(isVisibleBookmark).length,
            icon: parentIsWorkflowsRoot ? '🛡️' : '📁',
            isWorkflow: parentIsWorkflowsRoot
        }, depth + 1);
        body.appendChild(card);
    }

    // Loose bookmarks grouped by domain.
    appendDomainGroups(body, looseBookmarks, folderId);
}

// Helper: walk parent chain to detect cycles for folder drops.
async function isAncestorOf(ancestorId, descendantId) {
    let current = descendantId;
    let safety = 64;
    while (current && safety-- > 0) {
        const arr = await chrome.bookmarks.get(current).catch(() => []);
        const node = arr && arr[0];
        if (!node) return false;
        const parent = node.parentId;
        if (!parent || parent === '0') return false;
        if (parent === ancestorId) return true;
        current = parent;
    }
    return false;
}

// Surgical refresh: re-render only the open body of the given folder card(s).
// Used after a drop so expanded siblings remain expanded.
async function refreshFolderBodyIfOpen(folderId) {
    if (!folderId) return;
    const cards = document.querySelectorAll(`.source-folder-card[data-id="${CSS.escape(String(folderId))}"]`);
    for (const card of cards) {
        const body = card.querySelector('.source-folder-body');
        const depth = parseInt(card.dataset.depth || '0');

        // Update header stats regardless of body open/closed
        try {
            const children = await chrome.bookmarks.getChildren(folderId);
            const folderCount = children.filter(c => !c.url).length;
            const fileCount = children.filter(c => c.url).length;
            const statsEl = card.querySelector('.folder-stats');
            if (statsEl) {
                const parts = [];
                if (folderCount > 0) parts.push(`${folderCount} 📁`);
                if (fileCount > 0) parts.push(`${fileCount} 📄`);
                statsEl.textContent = parts.join(' · ') || 'Empty';
            }
        } catch (e) { /* folder gone — fine */ }

        if (body && body.style.display !== 'none') {
            await renderFolderBody(folderId, body, depth);
        }
    }
}

async function runSplitOnFolder(folderId, folderTitle) {
    const settings = await StorageManager.getSettings();
    const hintsInput = document.getElementById('aiHintsInput');
    const userHints = hintsInput ? hintsInput.value.trim() : '';
    const sourceIds = [`loose-${folderId}`];

    try {
        let proposal;
        if (settings.useAI && settings.geminiApiKey) {
            proposal = await BookmarkOrganizer.analyzeWithAI(sourceIds, [folderId], settings.geminiApiKey, userHints);
        } else {
            proposal = await BookmarkOrganizer.proposeSmartOrganization(sourceIds);
        }
        if (!proposal.groups || proposal.groups.length === 0) {
            alert(`Nothing to split in "${folderTitle}".`);
            return;
        }
        renderOrganizerProposal(proposal);
    } catch (e) {
        console.error(e);
        alert(`Split failed for "${folderTitle}": ${e.message}`);
    }
}


document.getElementById('viewWorkflowsBtn').addEventListener('click', async () => {
    // Switch Views
    document.getElementById('organizer-source-container').style.display = 'none';
    document.getElementById('organizer-container').style.display = 'none';
    document.getElementById('settings-container').style.display = 'none';
    document.getElementById('groups-container').style.display = 'none';
    document.getElementById('workflows-container').style.display = 'block';

    await loadWorkflows(); // Ensure workflows are refreshed
});

document.getElementById('groupTabsBtn').addEventListener('click', async () => {
    // Switch Views
    document.getElementById('organizer-source-container').style.display = 'none';
    document.getElementById('organizer-container').style.display = 'none';
    document.getElementById('settings-container').style.display = 'none';
    document.getElementById('workflows-container').style.display = 'none';
    document.getElementById('groups-container').style.display = 'block';

    await loadCurrentTabs();
});

// AI Grouping for TABS
document.getElementById('aiGroupTabsBtn').addEventListener('click', async () => {
    const btn = document.getElementById('aiGroupTabsBtn');
    const originalText = btn.textContent;
    btn.textContent = 'Grouping... 🧠';
    btn.disabled = true;

    try {
        const settings = await StorageManager.getSettings();
        if (!settings.useAI || !settings.geminiApiKey) {
            alert("AI features disabled. Check Settings.");
            return;
        }

        // 1. Get Tabs (Source) — current window only, http/https/file
        const tabs = await chrome.tabs.query({ currentWindow: true });
        const looseItems = tabs
            .filter(t => t.url && /^https?:|^file:|^ftp:/.test(t.url))
            .map(t => ({
                id: t.id.toString(),
                title: t.title,
                url: t.url,
                isTab: true
            }));

        // 2. Get Context (Folders)
        // We want AI to file tabs into EXISTING folders if possible, or create NEW ones.
        const allowedIds = settings.focusedFolderIds || [];
        const allStructure = await BookmarkOrganizer.getFolderMap(allowedIds);
        const contextFolders = allStructure.map(f => ({ id: f.id, path: f.fullPath }));

        // 3. User Hints
        const hints = document.getElementById('aiTabsHintsInput').value.trim();

        // 4. Call AIService (Reusing the core AI logic)
        // We use the same 'organizeWithAI' because the signature is generic (links, folders, key, hints)
        const mapping = await AIService.organizeWithAI(looseItems, contextFolders, settings.geminiApiKey, hints);

        // 5. Convert Mapping to UI Proposal
        // (Similar logic to Analyze, but for Tabs)
        const groups = {};

        // Default for NEW: proposals — first focused folder, then first in scope, finally Other Bookmarks
        const focusedRoot = allowedIds.length
            ? allStructure.find(f => f.id === allowedIds[0])
            : null;
        const defaultRoot = focusedRoot || allStructure[0] || { id: '2', fullPath: 'Other Bookmarks' };

        looseItems.forEach(item => {
            const decision = mapping[item.id];
            if (!decision || decision === 'SKIP') return;

            if (decision.startsWith('NEW:')) {
                const newCat = decision.replace('NEW:', '').trim();
                const groupKey = `NEW_${newCat}`;
                if (!groups[groupKey]) {
                    groups[groupKey] = {
                        groupName: newCat, action: 'CREATE', targetId: defaultRoot.id, targetPath: defaultRoot.fullPath,
                        newSubfolder: newCat, items: []
                    };
                }
                groups[groupKey].items.push(item);
            } else {
                const folderId = decision;
                const folderInfo = allStructure.find(f => f.id === folderId);
                if (folderInfo) {
                    if (!groups[folderId]) {
                        groups[folderId] = {
                            groupName: folderInfo.title, action: 'MOVE', targetId: folderId,
                            targetPath: folderInfo.fullPath, newSubfolder: '', items: []
                        };
                    }
                    groups[folderId].items.push(item);
                }
            }
        });

        // 6. Render
        const proposal = { groups: Object.values(groups) };
        renderOrganizerProposal(proposal, true); // true = isTabMode

    } catch (e) {
        console.error("AI Tab Grouping Failed", e);
        alert("AI Failed: " + e.message);
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
    }
});

document.getElementById('organizeBookmarksBtn').addEventListener('click', async () => {
    try {
        // Always land on the virtual root — Workflows + focused folders side-by-side.
        // Drill into a single root if you want a focused view.
        currentNavStack = [{ id: VIRTUAL_ROOT_ID, title: 'Sources' }];
        await renderSourceGrid(VIRTUAL_ROOT_ID);

        document.getElementById('groups-container').style.display = 'none';
        document.getElementById('organizer-source-container').style.display = 'block';
        document.getElementById('organizer-container').style.display = 'none';
    } catch (err) {
        console.error("Organize Bookmarks Error:", err);
        alert("Error opening organizer: " + err.message);
    }
});

document.getElementById('cancelSourceBtn').addEventListener('click', () => {
    document.getElementById('organizer-source-container').style.display = 'none';
    document.getElementById('groups-container').style.display = 'block';
    document.getElementById('source-list').className = ''; // Reset class just in case
});

// Step 2: Analyze & Propose
document.getElementById('analyzeBtn').addEventListener('click', async () => {
    // FIX: Include split cards in selection!
    const selected = document.querySelectorAll('.source-folder-card.selected');
    // Pass raw values (e.g. 'loose-5' or '5'). The backend 'getAllItemsInScope' handles the distinction.
    const folderIds = Array.from(selected).map(btn => btn.dataset.value).filter(Boolean);

    if (folderIds.length === 0) {
        alert('Please select at least one folder to organize.');
        return;
    }

    const btn = document.getElementById('analyzeBtn');
    const originalText = btn.textContent;
    btn.textContent = 'Analyzing... 🧠';
    btn.disabled = true;

    try {
        // Validation check for StorageManager
        if (typeof StorageManager.getSettings !== 'function') {
            alert("StorageManager.getSettings missing. Reload extension.");
            return;
        }

        const settings = await StorageManager.getSettings();

        // Get user hints
        const hintsInput = document.getElementById('aiHintsInput');
        const userHints = hintsInput ? hintsInput.value.trim() : '';

        // Call the actual AI or fallback to naive
        let proposal;
        if (settings.useAI && settings.geminiApiKey) {
            // FIXED: Context Scope logic
            // When explicitly analyzing selected folders (Source View), user intent is usually to organize WITHIN that scope.
            // If we use 'focusedFolderIds', it might be too broad (e.g. Root) or too narrow (unrelated).
            // We should prioritize the EXPLICITLY SELECTED source folders as the context.
            // (If user wants to move items OUT of source to Global, they might need a different mode, but "Analyze" usually implies "Cleanup this folder").

            const cleanSourceIds = folderIds.map(id => id.replace('loose-', ''));
            // If we have selected sources, USE THEM. Only fallback to Settings if no source selected (rare/impossible here).
            const contextIds = (cleanSourceIds.length > 0) ? cleanSourceIds : (settings.focusedFolderIds || []);

            console.log("🔍 DEBUG CONTEXT (Fixed):", {
                folderIds,
                cleanSourceIds,
                focusedSettings: settings.focusedFolderIds,
                FINAL_CONTEXT: contextIds
            });

            proposal = await BookmarkOrganizer.analyzeWithAI(folderIds, contextIds, settings.geminiApiKey, userHints);
        } else {
            proposal = await BookmarkOrganizer.proposeSmartOrganization(folderIds);
        }
        renderOrganizerProposal(proposal);

    } catch (error) {
        console.error(error);
        alert('Analysis failed: ' + error.message);
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
    }
});

document.getElementById('restructureBtn').addEventListener('click', async () => {
    // Logic similar to analyzeBtn but calls restructureWithAI
    const selected = document.querySelectorAll('.source-folder-card.selected');
    const folderIds = Array.from(selected).map(btn => btn.dataset.value).filter(Boolean);

    if (folderIds.length === 0) {
        alert('Please select at least one folder to RESTRUCTURE.');
        return;
    }

    const btn = document.getElementById('restructureBtn');
    const originalText = btn.textContent;
    btn.textContent = 'Re-Architecting... 🏗️';
    btn.disabled = true;
    document.getElementById('analyzeBtn').disabled = true;

    try {
        const settings = await StorageManager.getSettings();
        if (!settings.useAI || !settings.geminiApiKey) {
            alert("AI features are required for Restructure. Please enable AI and set an API key in Settings.");
            return;
        }

        // 1. Get ALL items from selected folders
        const { looseItems } = await BookmarkOrganizer.getAllItemsInScope(folderIds);

        // Get user hints
        const hintsInput = document.getElementById('aiHintsInput');
        const userHints = hintsInput ? hintsInput.value.trim() : '';

        // 2. Call AI Restructure
        const aiMapping = await AIService.restructureWithAI(looseItems, settings.geminiApiKey, userHints);

        // 3. Build Proposal from AI Mapping
        // aiMapping: { "bookmarkId": "Category > Subcategory" }
        const groups = {};
        looseItems.forEach(item => {
            const newPath = aiMapping[item.id];
            if (!newPath) return;

            if (!groups[newPath]) {
                groups[newPath] = {
                    groupName: newPath,
                    action: 'CREATE',
                    targetId: '2', // Default to Other Bookmarks
                    targetPath: `Other bookmarks/${newPath.replace(/ > /g, '/')}`,
                    newSubfolder: newPath.replace(/ > /g, '/'),
                    items: []
                };
            }
            groups[newPath].items.push(item);
        });

        const proposal = { groups: Object.values(groups) };
        renderOrganizerProposal(proposal);

    } catch (error) {
        console.error(error);
        alert('Restructure failed: ' + error.message);
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
        document.getElementById('analyzeBtn').disabled = false;
    }
});

// Back from proposals
document.getElementById('cancelOrganizerBtn').addEventListener('click', () => {
    document.getElementById('organizer-container').style.display = 'none';
    document.getElementById('organizer-source-container').style.display = 'block';
});

// Step 3: Apply
document.getElementById('applyOrganizerBtn').addEventListener('click', async () => {
    const proposal = window.currentRenderedProposal;
    if (!proposal) return;

    const checkboxes = document.querySelectorAll('.proposal-checkbox');
    const checkedIndices = Array.from(checkboxes)
        .filter(cb => cb.checked)
        .map(cb => parseInt(cb.dataset.index));

    const approvedGroups = proposal.groups.filter((_, idx) => checkedIndices.includes(idx));

    if (approvedGroups.length === 0) {
        alert("No groups selected.");
        return;
    }

    if (window.isTabMode) {
        await applyTabModeGroups(approvedGroups);
    } else {
        await BookmarkOrganizer.applyOrganization(approvedGroups);
        alert(`Organized ${approvedGroups.length} groups!`);
    }

    document.getElementById('organizer-container').style.display = 'none';
    document.getElementById('groups-container').style.display = 'block';
});

async function applyTabModeGroups(approvedGroups) {
    // 1. Create bookmarks for each group at the chosen destination
    for (const group of approvedGroups) {
        let folderId = group.targetId;

        if (group.newSubfolder && group.newSubfolder.trim() !== '') {
            try {
                const siblings = await chrome.bookmarks.getChildren(folderId);
                const existing = siblings.find(s => !s.url && s.title.toLowerCase() === group.newSubfolder.toLowerCase());
                if (existing) {
                    folderId = existing.id;
                } else {
                    const created = await chrome.bookmarks.create({
                        parentId: folderId,
                        title: group.newSubfolder
                    });
                    folderId = created.id;
                }
            } catch (e) { console.error("Error creating subfolder", e); }
        }

        for (const item of group.items) {
            await chrome.bookmarks.create({
                parentId: folderId,
                title: item.title,
                url: item.url
            });
        }
    }

    // 2. Close source tabs if the toggle is on (default: on)
    const toggle = document.getElementById('closeAfterApplyToggle');
    let closed = 0;
    if (toggle && toggle.checked) {
        closed = await closeFiledTabs(approvedGroups);
    }

    const msg = closed > 0
        ? `Saved ${approvedGroups.length} group(s) to bookmarks. Closed ${closed} filed tab(s).`
        : `Saved ${approvedGroups.length} group(s) to bookmarks!`;
    alert(msg);

    await loadWorkflows();
}

async function closeFiledTabs(approvedGroups) {
    const api = typeof browser !== 'undefined' ? browser : chrome;

    // Collect tab IDs from approved groups. Items in tab-mode carry the chrome tab id.
    const tabIds = [];
    for (const g of approvedGroups) {
        for (const item of g.items) {
            const id = Number(item.id);
            if (Number.isFinite(id)) tabIds.push(id);
        }
    }
    if (tabIds.length === 0) return 0;

    // Resolve which of these tabs still exist and are safe to close.
    // Skip: pinned tabs, the currently-active tab (don't kill the user's current page).
    const allTabs = await api.tabs.query({ currentWindow: true });
    const byId = new Map(allTabs.map(t => [t.id, t]));
    const safeIds = tabIds.filter(id => {
        const t = byId.get(id);
        if (!t) return false;
        if (t.pinned) return false;
        if (t.active) return false;
        return true;
    });

    if (safeIds.length === 0) return 0;

    // If closing these would empty the window, open a blank tab first.
    const remaining = allTabs.filter(t => !safeIds.includes(t.id));
    if (remaining.length === 0) {
        await api.tabs.create({});
    }

    try {
        await api.tabs.remove(safeIds);
    } catch (e) {
        console.warn("Some tabs could not be closed:", e);
    }
    return safeIds.length;
}

async function renderOrganizerProposal(proposal, isTabMode = false) {
    const list = document.getElementById('proposals-list');
    const applyBtn = document.getElementById('applyOrganizerBtn');
    const closeWrapper = document.getElementById('closeAfterApplyWrapper');
    const closeToggle = document.getElementById('closeAfterApplyToggle');

    // Switch Views
    document.getElementById('groups-container').style.display = 'none';
    document.getElementById('organizer-container').style.display = 'block';

    // Tab mode shows the close toggle and a reactive button label.
    closeWrapper.style.display = isTabMode ? 'flex' : 'none';

    const updateApplyLabel = () => {
        if (!isTabMode) {
            applyBtn.textContent = 'Apply Changes';
            return;
        }
        // Count tabs in currently-checked groups.
        const checked = document.querySelectorAll('.proposal-checkbox:checked');
        let tabCount = 0;
        checked.forEach(cb => {
            const idx = parseInt(cb.dataset.index);
            if (proposal.groups[idx]) tabCount += proposal.groups[idx].items.length;
        });
        applyBtn.textContent = closeToggle.checked
            ? `Apply & Close (${tabCount} tab${tabCount === 1 ? '' : 's'})`
            : `Apply (${tabCount} tab${tabCount === 1 ? '' : 's'})`;
    };

    // Re-attach a single change handler (idempotent — replace any prior one).
    closeToggle.onchange = updateApplyLabel;
    list.onchange = (e) => {
        if (e.target && e.target.classList.contains('proposal-checkbox')) updateApplyLabel();
    };

    list.innerHTML = '';

    if (proposal.groups.length === 0) {
        list.innerHTML = '<p>No suggestions found.</p>';
        applyBtn.style.display = 'none';
        closeWrapper.style.display = 'none';
        return;
    }
    applyBtn.style.display = 'block';

    const settings = await StorageManager.getSettings();
    const allowedIds = settings.focusedFolderIds || [];
    const folderMap = await BookmarkOrganizer.getFolderMap(allowedIds);

    // -- Generate Datalist (Once) --
    // We assume this list is relatively static for the session
    const datalistId = 'folder-paths-list';
    let datalist = document.getElementById(datalistId);
    if (!datalist) {
        datalist = document.createElement('datalist');
        datalist.id = datalistId;
        document.body.appendChild(datalist);
    }
    datalist.innerHTML = folderMap.map(f => `<option value="${f.fullPath}"></option>`).join('');

    // Default Fallback (usually 'Other Bookmarks' or first available)
    const fallbackRoot = folderMap.find(f => f.id === '2') || folderMap[0];

    proposal.groups.forEach((group, index) => {
        const div = document.createElement('div');
        div.className = 'group-card';
        div.style.borderLeft = group.action === 'MOVE' ? '4px solid #10b981' : '4px solid #3b82f6';
        div.dataset.index = index;

        // Determine Initial State
        // If targetId is known folder, use its path.
        // If it was a CREATE proposal, use the newSubfolder name (or groupName if simple)
        let initialValue = '';
        let initialIcon = '📂'; // Default to folder
        let isNew = false;

        const originalFolder = folderMap.find(f => f.id === group.targetId);

        if (group.action === 'CREATE' || (group.newSubfolder && group.newSubfolder !== '')) {
            // It's a creation proposal
            // We display just the Name they want to create (simplified) OR standard path?
            // User request: "Auto complete... indication icon of new folder".
            // If it's "New: Minecraft", prompt likely returned "Minecraft".
            // We should preset it to "Minecraft".
            initialValue = group.newSubfolder || group.groupName;
            initialIcon = '🆕';
            isNew = true;
            div.style.borderLeft = '4px solid #f59e0b'; // Amber for Create
        } else if (originalFolder) {
            initialValue = originalFolder.fullPath;
            initialIcon = '📂';
            isNew = false;
        } else {
            // Fallback
            initialValue = group.groupName;
            initialIcon = '❓';
        }


        // Generate Items HTML
        const itemsHtml = group.items.map((i, itemIndex) => {
            const domain = new URL(i.url).hostname;
            const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
            return `
                <div class="draggable-item" draggable="true" data-group-index="${index}" data-item-index="${itemIndex}" style="display:flex; align-items:center; gap:8px; padding:6px; background:rgba(255,255,255,0.03); margin-bottom:2px; border-radius:4px; cursor:grab;">
                    <img src="${faviconUrl}" width="16" height="16" style="flex-shrink:0; border-radius:3px;"/>
                    <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:0.85rem; color:var(--text-color); opacity:0.9;">${i.title}</div>
                </div>
            `;
        }).join('');

        div.innerHTML = `
      <div class="group-header" style="display:flex; flex-direction:column; gap:8px; margin-bottom: 8px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
             <!-- Label -->
            <label style="display:flex; align-items:center; cursor:pointer; font-weight:bold; font-size:1rem; flex:1;">
                <input type="checkbox" checked class="proposal-checkbox" data-index="${index}" style="margin-right:10px; transform:scale(1.1); accent-color: var(--primary-color);">
                ${group.groupName} 
            </label>
            
            <button class="sm-btn apply-single-btn" data-index="${index}" style="margin-left:8px; background:transparent; border:1px solid #10b981; color:#10b981;">✓ Apply This</button>
        </div>
        
        <!-- Smart Input UI -->
        <div style="position:relative;">
             <div style="font-size:0.7rem; color:#888; margin-bottom:4px; font-weight:600;">DESTINATION</div>
             <div style="display:flex; align-items:center; background:#111827; border:1px solid var(--border-color); border-radius:4px; padding:2px 8px;">
                <span class="status-icon" style="font-size:1.2rem; margin-right:8px; cursor:default;" title="${isNew ? 'New Folder' : 'Existing Folder'}">${initialIcon}</span>
                <input type="text" class="smart-dest-input" list="${datalistId}" value="${initialValue}" 
                       placeholder="Type folder path or new name..." 
                       style="flex:1; background:transparent; border:none; color:white; padding:8px 0; font-size:0.9rem; outline:none;">
             </div>
             <!-- Optional: Tiny help text -->
        </div>
      </div>
      
      <div class="group-items drop-zone" data-index="${index}" style="overflow:visible; border-top:1px solid rgba(255,255,255,0.1); padding-top:8px; min-height:40px;">
        ${itemsHtml}
        ${group.items.length === 0 ? '<div style="color:#666; font-style:italic; font-size:0.8rem; text-align:center; padding:10px;">Drag items here</div>' : ''}
      </div>
    `;

        list.appendChild(div);

        // -- Logic: Handle Smart Input --
        const input = div.querySelector('.smart-dest-input');
        const iconSpan = div.querySelector('.status-icon');
        const cardBorder = div;

        input.addEventListener('input', () => {
            const val = input.value.trim();

            // Check exact match in folderMap
            // We use fullPath or maybe just title if unique? fullPath is safer.
            const match = folderMap.find(f => f.fullPath.toLowerCase() === val.toLowerCase());

            if (match) {
                // FOUND: Move Mode
                group.action = 'MOVE';
                group.targetId = match.id;
                group.targetPath = match.fullPath;
                group.newSubfolder = ''; // Clear creation

                // Visuals
                iconSpan.textContent = '📂';
                iconSpan.title = "Existing Folder";
                cardBorder.style.borderLeft = '4px solid #10b981'; // Green
            } else {
                // NOT FOUND: Create Mode
                group.action = 'CREATE';
                group.newSubfolder = val;
                // Target ID should be the Root Scope (fallbackRoot) because we can't infer parent easily from a text string unless we parse ">"
                // Advanced: Parse "Parent > Child" string?
                // For now, simple "Name" -> Create in Root.
                group.targetId = fallbackRoot.id;
                group.targetPath = fallbackRoot.fullPath;

                // Visuals
                iconSpan.textContent = '🆕';
                iconSpan.title = "Will Create New Folder";
                cardBorder.style.borderLeft = '4px solid #f59e0b'; // Amber
            }
        });

        // Single Apply
        div.querySelector('.apply-single-btn').addEventListener('click', async (e) => {
            if (!confirm(`Organize just this group?`)) return;
            if (isTabMode) {
                await applyTabModeGroups([group]);
            } else {
                await BookmarkOrganizer.applyOrganization([group]);
            }
            proposal.groups.splice(index, 1);
            renderOrganizerProposal(proposal, window.isTabMode);
        });
    });

    setupDragAndDrop(proposal);

    window.currentRenderedProposal = proposal;
    window.isTabMode = isTabMode;

    // Initial label sync (counts tabs in checked groups).
    updateApplyLabel();
}

function setupDragAndDrop(proposal) {
    const draggables = document.querySelectorAll('.draggable-item');
    const droppables = document.querySelectorAll('.drop-zone');

    let draggedItem = null;
    let sourceGroupIndex = null;
    let sourceItemIndex = null;

    draggables.forEach(elem => {
        elem.addEventListener('dragstart', (e) => {
            draggedItem = elem;
            sourceGroupIndex = parseInt(elem.dataset.groupIndex);
            sourceItemIndex = parseInt(elem.dataset.itemIndex);
            e.dataTransfer.setData('text/plain', 'item'); // Firefox req
            elem.style.opacity = '0.5';
        });

        elem.addEventListener('dragend', () => {
            elem.style.opacity = '1';
            draggedItem = null;
        });
    });

    droppables.forEach(zone => {
        zone.addEventListener('dragover', (e) => {
            e.preventDefault(); // Allow dropping
            zone.style.background = 'rgba(255,255,255,0.05)';
        });

        zone.addEventListener('dragleave', () => {
            zone.style.background = 'transparent';
        });

        zone.addEventListener('drop', (e) => {
            e.preventDefault();
            zone.style.background = 'transparent';

            const targetGroupIndex = parseInt(zone.dataset.index);

            if (sourceGroupIndex === targetGroupIndex) return; // Dropped in same group

            // Move Data
            const item = proposal.groups[sourceGroupIndex].items[sourceItemIndex];

            // Remove from Source
            // Note: splicing invalidates indices. We must rely on our render check.
            proposal.groups[sourceGroupIndex].items.splice(sourceItemIndex, 1);

            // Add to Target
            proposal.groups[targetGroupIndex].items.push(item);

            // Re-Render EVERYTHING (easiest way to fix indices)
            renderOrganizerProposal(proposal, window.isTabMode);
        });
    });
}

// --- Settings Logic ---
// --- Settings Logic ---
document.getElementById('settingsToggleBtn').addEventListener('click', async () => {
    // Show Settings, Hide others
    document.getElementById('actions').style.display = 'none';
    document.getElementById('groups-container').style.display = 'none';
    document.getElementById('workflows-container').style.display = 'none';
    document.getElementById('organizer-container').style.display = 'none';
    document.getElementById('organizer-source-container').style.display = 'none';

    const container = document.getElementById('settings-container');
    container.style.display = 'block';

    // Fetch Data
    const settings = await StorageManager.getSettings();
    const folders = await BookmarkOrganizer.getStructure();

    // -- Render UI --
    container.innerHTML = `
        <h2 style="font-size:1.1rem; margin-bottom:12px; border-bottom:1px solid var(--border-color); padding-bottom:8px;">Extension Settings</h2>
        
        <div id="settings-scroll-area" style="overflow-y:auto; max-height: calc(100vh - 100px); padding-right:4px;">
            
            <!-- 1. Source Folders (Grid Style) -->
            <h3 style="font-size:0.9rem; color:#aaa; margin-bottom:10px; text-transform:uppercase; letter-spacing:0.5px;">Target Folders</h3>
            <div id="settings-folder-toolbar" style="display:flex; gap:8px; margin-bottom:10px;">
                <button class="sm-btn" id="folderImportBtn" title="Import a folder from a JSON file">📥 Import Folder</button>
                <input type="file" id="folderImportFile" accept=".json" style="display:none">
            </div>
            <div id="settings-folder-grid" class="source-grid" style="margin-bottom:20px;">
                <!-- Folders injected here -->
            </div>
            <div id="settings-extra-focused" style="margin-bottom:20px;">
                <!-- Non-top-level focused folders injected here -->
            </div>

            <!-- 2. Custom Keywords -->
            <h3 style="font-size:0.9rem; color:#aaa; margin-bottom:10px; margin-top:20px; text-transform:uppercase; letter-spacing:0.5px;">Custom Keywords</h3>
            <div id="settings-keywords-list" style="margin-bottom:20px;">
                <!-- Inputs injected here -->
            </div>

            <!-- 3. AI Configuration -->
            <h3 style="font-size:0.9rem; color:#aaa; margin-bottom:10px; margin-top:20px; text-transform:uppercase; letter-spacing:0.5px;">AI Brain (Gemini)</h3>
            <div style="background:var(--card-bg); padding:15px; border-radius:8px; border:1px solid var(--border-color);">
                <label style="display:flex; align-items:center; cursor:pointer; margin-bottom:10px;">
                    <input type="checkbox" id="use-ai-toggle" ${settings.useAI ? 'checked' : ''} style="margin-right:10px; transform:scale(1.2);">
                    <span style="font-weight:bold;">Enable AI Organization</span>
                </label>

                <div id="ai-key-wrapper" style="display:${settings.useAI ? 'block' : 'none'}; margin-top:10px; padding-left:5px;">
                    <div style="font-size:0.85rem; margin-bottom:5px; color:#ccc;">Gemini API Key</div>
                    <input type="password" id="gemini-api-key" value="${settings.geminiApiKey || ''}" placeholder="Paste API Key..." style="width:100%; padding:8px; background:#111827; border:1px solid #374151; color:white; border-radius:4px;">
                    <div style="font-size:0.75rem; color:#666; margin-top:6px;">
                        Keys are stored locally. <a href="#" style="color:#3b82f6;">Get Free Key</a>
                    </div>
                </div>
            </div>

            <!-- 4. Backend Sync -->
            <h3 style="font-size:0.9rem; color:#aaa; margin-bottom:10px; margin-top:20px; text-transform:uppercase; letter-spacing:0.5px;">Backend Sync</h3>
            <div style="background:var(--card-bg); padding:15px; border-radius:8px; border:1px solid var(--border-color);">
                <div style="font-size:0.85rem; margin-bottom:5px; color:#ccc;">Server URL</div>
                <input type="url" id="backend-url" value="${(settings.backend && settings.backend.url) || ''}" placeholder="http://truenas.local:18921" style="width:100%; padding:8px; background:#111827; border:1px solid #374151; color:white; border-radius:4px; margin-bottom:10px;">
                <div style="font-size:0.85rem; margin-bottom:5px; color:#ccc;">Auth Token</div>
                <input type="password" id="backend-token" value="${(settings.backend && settings.backend.token) || ''}" placeholder="TABPALADIN_TOKEN" style="width:100%; padding:8px; background:#111827; border:1px solid #374151; color:white; border-radius:4px; margin-bottom:10px;">
                <div style="display:flex; gap:8px; margin-top:10px;">
                    <button id="backend-test-btn" class="sm-btn" style="flex:1;">⚡ Test</button>
                    <button id="backend-push-btn" class="sm-btn" style="flex:1; background:rgba(59,130,246,0.2); border:1px solid var(--primary-color);">⬆ Push</button>
                    <button id="backend-pull-btn" class="sm-btn" style="flex:1; background:rgba(245,158,11,0.2); border:1px solid var(--warning-color);">⬇ Pull</button>
                </div>
                <div id="backend-status" style="font-size:0.75rem; color:var(--text-muted); margin-top:8px; min-height:14px;">
                    ${settings.backend && settings.backend.lastSyncAt ? 'Last sync: ' + new Date(settings.backend.lastSyncAt).toLocaleString() : ''}
                </div>
                <div style="font-size:0.7rem; color:#666; margin-top:6px;">
                    Push uploads your full bookmark tree as a timestamped snapshot. Pull <strong>replaces</strong> your local bookmarks (Bookmarks Bar / Other Bookmarks / Mobile) with the latest snapshot from the server.
                </div>
            </div>

            <!-- Save Actions -->
            <div style="margin-top:20px; display:flex; gap:10px; justify-content:flex-end;">
                 <button id="closeSettingsBtnInternal" class="sm-btn" style="padding:8px 16px;">Cancel</button>
                 <button id="saveGlobalSettingsBtn" class="main-btn" style="width:auto; padding:8px 24px;">Save All Settings</button>
            </div>
            <div style="height:40px;"></div>
        </div>
    `;

    // A. Render Folders as Grid Cards
    // mutableFocused is the working set of focused folder IDs (top-level + custom imported).
    const mutableFocused = new Set(settings.focusedFolderIds || []);

    const grid = document.getElementById('settings-folder-grid');
    // Override the grid layout: with an export button per card, the cramped 140px columns
    // collapse the title to a single letter. Stack vertically instead.
    grid.style.display = 'flex';
    grid.style.flexDirection = 'column';
    grid.style.gap = '8px';

    // Build the list of "top-level" entries shown in the grid: real browser roots PLUS
    // TabPaladin Workflows treated as a top-level (it's physically inside Other Bookmarks
    // because the bookmarks API doesn't allow new root folders, but UX-wise it's a root).
    const wfRoot = await findWorkflowRootSilent();
    const displayedFolders = [...(folders || [])];
    if (wfRoot && !displayedFolders.find(f => f.id === wfRoot.id)) {
        displayedFolders.push({
            id: wfRoot.id,
            title: wfRoot.title,
            isWorkflow: true
        });
    }

    if (displayedFolders.length > 0) {
        displayedFolders.forEach(folder => {
            const isChecked = mutableFocused.has(folder.id);
            const card = document.createElement('div');
            card.className = `source-btn ${isChecked ? 'selected' : ''}`;
            // Override .source-btn's column layout for these settings cards so the
            // export button + checkmark sit in a row next to the title.
            card.style.cssText = `
                flex-direction: row;
                align-items: center;
                justify-content: flex-start;
                padding: 12px;
                text-align: left;
                height: auto;
                min-height: 60px;
                gap: 8px;
            `;
            card.dataset.id = folder.id;

            const icon = folder.isWorkflow ? '🛡️' : '📁';
            let subtitleHtml = '';
            if (folder.isWorkflow) {
                // Build a dropdown of valid parents (the three real browser roots).
                const parentOptionsHtml = (folders || []).map(f =>
                    `<option value="${f.id}" ${f.id === wfRoot.parentId ? 'selected' : ''}>${escapeHtml(f.title)}</option>`
                ).join('');
                subtitleHtml = `
                    <div style="display:flex; align-items:center; gap:6px; margin-top:4px; font-size:0.72rem; color:var(--text-muted);">
                        <span>Located in:</span>
                        <select class="wf-location-select" title="Move the workflows folder to a different root"
                                style="background:rgba(0,0,0,0.2); border:1px solid var(--border-color); color:var(--text-color); padding:2px 4px; border-radius:4px; font-size:0.72rem;">
                            ${parentOptionsHtml}
                        </select>
                    </div>
                `;
            }
            card.innerHTML = `
                <div class="icon" style="margin:0; width:auto;">${icon}</div>
                <div style="flex:1; width:auto; overflow:hidden; min-width:0;">
                    <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(folder.title)}</div>
                    ${subtitleHtml}
                </div>
                <button class="sm-btn folder-export-btn" title="Export this folder + contents as JSON" data-id="${folder.id}" style="padding:4px 8px; flex-shrink:0;">📤</button>
                <div class="checkbox-indicator" style="font-size:1.2rem; width:auto; flex-shrink:0; color:${isChecked ? '#10b981' : 'transparent'};">✓</div>
            `;

            card.addEventListener('click', (e) => {
                if (e.target.closest('.folder-export-btn')) return;
                if (e.target.closest('.wf-location-select')) return;
                card.classList.toggle('selected');
                const indicator = card.querySelector('.checkbox-indicator');
                indicator.style.color = card.classList.contains('selected') ? '#10b981' : 'transparent';
                if (card.classList.contains('selected')) mutableFocused.add(folder.id);
                else mutableFocused.delete(folder.id);
            });

            card.querySelector('.folder-export-btn').addEventListener('click', async (e) => {
                e.stopPropagation();
                try { await exportBookmarkFolder(folder.id); }
                catch (err) { alert('Export failed: ' + err.message); }
            });

            // Workflows folder: dropdown to move it between top-level roots.
            const locSel = card.querySelector('.wf-location-select');
            if (locSel && folder.isWorkflow) {
                let currentParentId = wfRoot.parentId;
                locSel.addEventListener('click', (e) => e.stopPropagation());
                locSel.addEventListener('change', async (e) => {
                    e.stopPropagation();
                    const newParentId = e.target.value;
                    if (newParentId === currentParentId) return;
                    try {
                        await chrome.bookmarks.move(wfRoot.id, { parentId: newParentId });
                        currentParentId = newParentId;
                        console.log('[TabPaladin] Moved workflows folder to', newParentId);
                    } catch (err) {
                        alert('Move failed: ' + err.message);
                        e.target.value = currentParentId;
                    }
                });
            }

            grid.appendChild(card);
        });
    }

    // Render non-top-level focused folders as removable rows (so user can see and unfocus them).
    async function renderExtraFocused() {
        const extra = document.getElementById('settings-extra-focused');
        extra.innerHTML = '';
        // Treat real browser roots AND the workflows root as "top-level" for this section,
        // since they all already get a row in the main grid above.
        const topLevelIds = new Set([
            ...(folders || []).map(f => f.id),
            ...(wfRoot ? [wfRoot.id] : [])
        ]);
        const customIds = [...mutableFocused].filter(id => !topLevelIds.has(id));
        if (customIds.length === 0) return;

        const heading = document.createElement('div');
        heading.style.cssText = 'font-size:0.75rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:6px;';
        heading.textContent = 'Additional focused folders (sub-folders)';
        extra.appendChild(heading);

        for (const id of customIds) {
            try {
                const nodes = await chrome.bookmarks.get(id);
                const node = nodes && nodes[0];
                if (!node) continue;
                const path = await getFolderPath(id);
                const row = document.createElement('div');
                row.style.cssText = 'display:flex; align-items:center; gap:8px; padding:8px 10px; background:var(--surface-color); border:1px solid var(--border-color); border-radius:6px; margin-bottom:6px;';
                row.innerHTML = `
                    <span style="font-size:1rem;">📁</span>
                    <span style="flex:1; font-size:0.85rem;">${escapeHtml(path)}</span>
                    <button class="sm-btn folder-export-btn" title="Export this folder" style="padding:2px 6px;">📤</button>
                    <button class="sm-btn" title="Remove from focused folders" style="padding:2px 6px; color:var(--danger-color);">✕</button>
                `;
                row.querySelector('.folder-export-btn').addEventListener('click', async () => {
                    try { await exportBookmarkFolder(id); }
                    catch (err) { alert('Export failed: ' + err.message); }
                });
                row.querySelectorAll('.sm-btn')[1].addEventListener('click', () => {
                    mutableFocused.delete(id);
                    renderExtraFocused();
                });
                extra.appendChild(row);
            } catch (e) {
                console.warn('Could not load focused folder', id, e);
                // Folder was deleted — quietly drop it from focused set.
                mutableFocused.delete(id);
            }
        }
    }
    await renderExtraFocused();

    // Wire the import button.
    document.getElementById('folderImportBtn').addEventListener('click', () => {
        document.getElementById('folderImportFile').click();
    });
    document.getElementById('folderImportFile').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;
        try {
            const text = await file.text();
            const newId = await importBookmarkFolder(text, '2');
            if (newId) {
                mutableFocused.add(newId);
                await renderExtraFocused();
                alert('Folder imported and focused.');
            }
        } catch (err) {
            alert('Import failed: ' + err.message);
        }
    });

    // B. Render Keywords — chips per category with defaults (locked) + custom (removable).
    const kwList = document.getElementById('settings-keywords-list');

    // Mutable working state until Save. categoryOrder is the user-set ordering of all categories.
    const mutableState = {
        customKeywords: JSON.parse(JSON.stringify(settings.customKeywords || {})),
        categoryOrder: Array.isArray(settings.categoryOrder) ? [...settings.categoryOrder] : null
    };

    // Toolbar above the list: Add Category + Export + Import.
    const toolbar = document.createElement('div');
    toolbar.className = 'kw-toolbar';
    toolbar.innerHTML = `
        <button class="sm-btn" id="kwExportBtn" title="Download keyword config as JSON">📤 Export</button>
        <button class="sm-btn" id="kwImportBtn" title="Load keyword config from JSON">📥 Import</button>
        <input type="file" id="kwImportFile" accept=".json" style="display:none">
    `;
    kwList.parentNode.insertBefore(toolbar, kwList);

    toolbar.querySelector('#kwExportBtn').addEventListener('click', () => {
        const payload = {
            version: 1,
            exportedAt: new Date().toISOString(),
            customKeywords: mutableState.customKeywords,
            categoryOrder: getEffectiveOrder()
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        chrome.downloads.download({
            url,
            filename: `tabpaladin_keywords_${new Date().toISOString().replace(/[:.]/g, '-')}.json`
        });
    });

    toolbar.querySelector('#kwImportBtn').addEventListener('click', () => {
        toolbar.querySelector('#kwImportFile').click();
    });
    toolbar.querySelector('#kwImportFile').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (!data || typeof data !== 'object' || !data.customKeywords) {
                alert('Invalid keyword config file.');
                return;
            }
            // Merge: incoming custom keywords append to existing (dedup case-insensitive).
            for (const [cat, kws] of Object.entries(data.customKeywords)) {
                if (!Array.isArray(kws)) continue;
                const existing = new Set((mutableState.customKeywords[cat] || []).map(w => w.toLowerCase()));
                const fresh = kws.filter(w => !existing.has(String(w).toLowerCase()));
                mutableState.customKeywords[cat] = [...(mutableState.customKeywords[cat] || []), ...fresh];
            }
            // Take imported order if present, but only for categories we now know about.
            if (Array.isArray(data.categoryOrder)) {
                mutableState.categoryOrder = data.categoryOrder;
            }
            renderKeywordSection();
            alert('Imported.');
        } catch (err) {
            alert('Import failed: ' + err.message);
        }
        e.target.value = '';
    });

    function getEffectiveOrder() {
        const defaultCats = Object.keys(CONTEXT_KEYWORDS);
        const customCats = Object.keys(mutableState.customKeywords).filter(c => !defaultCats.includes(c));
        const known = [...defaultCats, ...customCats];
        if (Array.isArray(mutableState.categoryOrder) && mutableState.categoryOrder.length) {
            const seen = new Set();
            const ordered = mutableState.categoryOrder.filter(c => known.includes(c) && !seen.has(c) && seen.add(c));
            const missing = known.filter(c => !seen.has(c));
            return [...ordered, ...missing];
        }
        return known;
    }

    function renderKeywordSection() {
        kwList.innerHTML = '';
        const allCats = getEffectiveOrder();
        const defaultCats = Object.keys(CONTEXT_KEYWORDS);

        allCats.forEach(cat => {
            const isDefault = defaultCats.includes(cat);
            const defaultWords = isDefault ? CONTEXT_KEYWORDS[cat] : [];
            const customWords = mutableState.customKeywords[cat] || [];

            const row = document.createElement('div');
            row.className = 'kw-category';
            row.dataset.cat = cat;

            const head = document.createElement('div');
            head.className = 'kw-category-head';
            head.innerHTML = `
                <span class="kw-drag-handle" title="Drag to reorder" draggable="true">⋮⋮</span>
                <span class="kw-cat-name">${escapeHtml(cat)}</span>
                ${isDefault ? '' : '<button class="sm-btn kw-delete-cat-btn" title="Remove this category">✕</button>'}
            `;
            row.appendChild(head);

            // Drag-to-reorder: handle initiates, the whole row is a drop target.
            const handle = head.querySelector('.kw-drag-handle');
            handle.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/tp-kw-cat', cat);
                e.dataTransfer.effectAllowed = 'move';
                row.classList.add('dragging');
            });
            handle.addEventListener('dragend', () => row.classList.remove('dragging'));

            row.addEventListener('dragover', (e) => {
                if (!e.dataTransfer.types.includes('text/tp-kw-cat')) return;
                e.preventDefault();
                // Above/below split: top half = insert before, bottom half = insert after.
                const rect = row.getBoundingClientRect();
                const isAbove = (e.clientY - rect.top) < rect.height / 2;
                row.classList.toggle('drop-above', isAbove);
                row.classList.toggle('drop-below', !isAbove);
            });
            row.addEventListener('dragleave', (e) => {
                if (!row.contains(e.relatedTarget)) {
                    row.classList.remove('drop-above', 'drop-below');
                }
            });
            row.addEventListener('drop', (e) => {
                e.preventDefault();
                const dragged = e.dataTransfer.getData('text/tp-kw-cat');
                row.classList.remove('drop-above', 'drop-below');
                if (!dragged || dragged === cat) return;

                const order = getEffectiveOrder();
                const from = order.indexOf(dragged);
                if (from === -1) return;
                order.splice(from, 1);
                const rect = row.getBoundingClientRect();
                const isAbove = (e.clientY - rect.top) < rect.height / 2;
                let to = order.indexOf(cat);
                if (!isAbove) to += 1;
                order.splice(to, 0, dragged);
                mutableState.categoryOrder = order;
                renderKeywordSection();
            });

            const chipsBox = document.createElement('div');
            chipsBox.className = 'kw-chips';

            // Default chips (locked)
            defaultWords.forEach(w => {
                const chip = document.createElement('span');
                chip.className = 'kw-chip kw-chip-default';
                chip.title = 'Built-in keyword (not removable)';
                chip.textContent = w;
                chipsBox.appendChild(chip);
            });

            // Custom chips (removable)
            customWords.forEach(w => {
                const chip = document.createElement('span');
                chip.className = 'kw-chip kw-chip-custom';
                chip.innerHTML = `${escapeHtml(w)}<button class="kw-chip-remove" title="Remove">×</button>`;
                chip.querySelector('.kw-chip-remove').addEventListener('click', () => {
                    mutableState.customKeywords[cat] = customWords.filter(x => x !== w);
                    if (mutableState.customKeywords[cat].length === 0) delete mutableState.customKeywords[cat];
                    renderKeywordSection();
                });
                chipsBox.appendChild(chip);
            });

            // Add-keyword input
            const addInput = document.createElement('input');
            addInput.type = 'text';
            addInput.className = 'kw-add-input';
            addInput.placeholder = '+ keyword (Enter)';
            const commit = () => {
                const v = addInput.value.trim();
                if (!v) return;
                // Allow comma-separated entry
                const words = v.split(',').map(s => s.trim()).filter(Boolean);
                const existing = new Set([...defaultWords.map(w => w.toLowerCase()), ...customWords.map(w => w.toLowerCase())]);
                const fresh = words.filter(w => !existing.has(w.toLowerCase()));
                if (fresh.length === 0) { addInput.value = ''; return; }
                mutableState.customKeywords[cat] = [...customWords, ...fresh];
                renderKeywordSection();
            };
            addInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); commit(); }
            });
            addInput.addEventListener('blur', commit);
            chipsBox.appendChild(addInput);

            row.appendChild(chipsBox);

            // Delete-category button (only for custom categories)
            const delBtn = head.querySelector('.kw-delete-cat-btn');
            if (delBtn) {
                delBtn.addEventListener('click', () => {
                    if (confirm(`Remove category "${cat}"? Custom keywords for it will be lost.`)) {
                        delete mutableState.customKeywords[cat];
                        renderKeywordSection();
                    }
                });
            }

            kwList.appendChild(row);
        });

        // + Add Category button
        const addCatBtn = document.createElement('button');
        addCatBtn.className = 'sm-btn kw-add-cat-btn';
        addCatBtn.textContent = '+ Add Category';
        addCatBtn.addEventListener('click', () => {
            const name = prompt('New category name:');
            if (!name) return;
            const trimmed = name.trim();
            if (!trimmed) return;
            if (allCats.find(c => c.toLowerCase() === trimmed.toLowerCase())) {
                alert(`Category "${trimmed}" already exists.`);
                return;
            }
            mutableState.customKeywords[trimmed] = [];
            renderKeywordSection();
        });
        kwList.appendChild(addCatBtn);
    }
    renderKeywordSection();

    // C. Event Listeners
    document.getElementById('use-ai-toggle').addEventListener('change', (e) => {
        document.getElementById('ai-key-wrapper').style.display = e.target.checked ? 'block' : 'none';
    });

    // Backend sync buttons
    const backendStatus = document.getElementById('backend-status');
    const getBackendConfig = () => ({
        url: document.getElementById('backend-url').value.trim(),
        token: document.getElementById('backend-token').value.trim()
    });
    const writeBackendStatus = (msg) => { backendStatus.textContent = msg; };
    const persistBackendConfig = async (extras = {}) => {
        const cfg = getBackendConfig();
        const current = await StorageManager.getSettings();
        const updated = { ...current, backend: { ...(current.backend || {}), ...cfg, ...extras } };
        await StorageManager.saveSettings(updated);
    };

    document.getElementById('backend-test-btn').addEventListener('click', async () => {
        const cfg = getBackendConfig();
        if (!cfg.url) { alert('Enter a server URL first.'); return; }
        writeBackendStatus('Testing…');
        try {
            const h = await BackendSync.health(cfg);
            writeBackendStatus(h && h.ok ? `Server OK (auth ${h.configured ? 'ready' : 'MISSING'})` : 'Unexpected response');
        } catch (e) {
            writeBackendStatus('Test failed: ' + e.message);
        }
    });

    document.getElementById('backend-push-btn').addEventListener('click', async () => {
        const cfg = getBackendConfig();
        if (!cfg.url || !cfg.token) { alert('Server URL and token required.'); return; }
        if (!confirm('Upload your selected target folders and workflows folder to the server?')) return;
        writeBackendStatus('Pushing…');
        try {
            const settings = await StorageManager.getSettings();
            const focusedFolderIds = settings.focusedFolderIds || [];
            const wfRoot = await findWorkflowRootSilent();
            const workflowRootId = wfRoot ? wfRoot.id : null;
            const ts = await BackendSync.push(cfg, focusedFolderIds, workflowRootId);
            await persistBackendConfig({ lastSyncAt: ts, lastSyncKind: 'push' });
            writeBackendStatus('Pushed at ' + new Date(ts).toLocaleString());
        } catch (e) {
            writeBackendStatus('Push failed: ' + e.message);
        }
    });

    document.getElementById('backend-pull-btn').addEventListener('click', async () => {
        const cfg = getBackendConfig();
        if (!cfg.url || !cfg.token) { alert('Server URL and token required.'); return; }
        writeBackendStatus('Checking latest…');
        try {
            const data = await BackendSync.pullLatestInfo(cfg);
            if (!data || !data.snapshot) {
                writeBackendStatus('No snapshot on server yet.');
                return;
            }
            const when = new Date(data.timestamp).toLocaleString();
            const yes = confirm(
                `Replace your local bookmarks with the snapshot from ${when}?\n\n` +
                `This wipes the current contents of Bookmarks Bar / Other Bookmarks / Mobile and recreates them from the server snapshot.\n\n` +
                `Tip: Push first if you have local changes you want to keep.`
            );
            if (!yes) { writeBackendStatus('Pull cancelled.'); return; }
            writeBackendStatus('Pulling…');
            await BackendSync.applyPull(data.snapshot);
            await persistBackendConfig({ lastSyncAt: data.timestamp, lastSyncKind: 'pull' });
            writeBackendStatus('Pulled snapshot from ' + when);
        } catch (e) {
            writeBackendStatus('Pull failed: ' + e.message);
        }
    });

    document.getElementById('closeSettingsBtnInternal').addEventListener('click', closeSettings);

    document.getElementById('saveGlobalSettingsBtn').addEventListener('click', async () => {
        // Sync DOM-checked top-level cards back into mutableFocused (covers click toggles after import).
        const selectedCards = grid.querySelectorAll('.source-btn.selected');
        const topLevelIds = new Set((folders || []).map(f => f.id));
        // Drop any top-level that's been unchecked
        for (const id of [...mutableFocused]) {
            if (topLevelIds.has(id) && !Array.from(selectedCards).some(c => c.dataset.id === id)) {
                mutableFocused.delete(id);
            }
        }
        // Add any newly checked
        Array.from(selectedCards).forEach(c => mutableFocused.add(c.dataset.id));
        const focusedFolderIds = [...mutableFocused];

        const useAI = document.getElementById('use-ai-toggle').checked;
        const apiKey = document.getElementById('gemini-api-key').value.trim();

        // Filter out empty custom keyword arrays so we don't persist empty entries.
        const cleanCustom = {};
        for (const [cat, kws] of Object.entries(mutableState.customKeywords)) {
            if (Array.isArray(kws) && kws.length > 0) cleanCustom[cat] = kws;
            else if (!Object.keys(CONTEXT_KEYWORDS).includes(cat)) {
                // Keep a user-added (empty) category around as an empty array so it survives saves.
                cleanCustom[cat] = [];
            }
        }

        const existing = await StorageManager.getSettings();
        const backendUrl = document.getElementById('backend-url').value.trim();
        const backendToken = document.getElementById('backend-token').value.trim();
        const newSettings = {
            focusedFolderIds,
            customKeywords: cleanCustom,
            categoryOrder: mutableState.categoryOrder || null,
            useAI,
            geminiApiKey: apiKey,
            backend: {
                ...(existing.backend || {}),
                url: backendUrl,
                token: backendToken
            }
        };

        await StorageManager.saveSettings(newSettings);
        alert("Settings Saved!");
        closeSettings();
    });

    // Main header Push and Pull event listeners
    const mainStatus = document.getElementById('backend-status');
    const updateMainStatus = (msg) => {
        if (mainStatus) mainStatus.textContent = msg;
    };

    document.getElementById('mainPushBtn').addEventListener('click', async () => {
        try {
            const settings = await StorageManager.getSettings();
            const cfg = settings.backend || {};
            if (!cfg.url || !cfg.token) {
                alert('Sync server URL and token are not configured. Open Settings (⚙️) to set them up.');
                return;
            }
            if (!confirm('Upload your selected target folders and workflows folder to the server?')) return;
            
            updateMainStatus('Pushing…');
            const focusedFolderIds = settings.focusedFolderIds || [];
            const wfRoot = await findWorkflowRootSilent();
            const workflowRootId = wfRoot ? wfRoot.id : null;
            const ts = await BackendSync.push(cfg, focusedFolderIds, workflowRootId);
            
            const updated = { ...settings, backend: { ...cfg, lastSyncAt: ts, lastSyncKind: 'push' } };
            await StorageManager.saveSettings(updated);
            
            updateMainStatus('Pushed at ' + new Date(ts).toLocaleString());
            alert('Push successful!');
            await loadCurrentTabs();
        } catch (e) {
            updateMainStatus('Push failed: ' + e.message);
            alert('Push failed: ' + e.message);
        }
    });

    document.getElementById('mainPullBtn').addEventListener('click', async () => {
        try {
            const settings = await StorageManager.getSettings();
            const cfg = settings.backend || {};
            if (!cfg.url || !cfg.token) {
                alert('Sync server URL and token are not configured. Open Settings (⚙️) to set them up.');
                return;
            }
            
            updateMainStatus('Checking latest…');
            const data = await BackendSync.pullLatestInfo(cfg);
            if (!data || !data.snapshot) {
                updateMainStatus('No snapshot on server yet.');
                alert('No snapshot on server yet.');
                return;
            }
            
            const when = new Date(data.timestamp).toLocaleString();
            const yes = confirm(
                `Replace your local bookmarks with the snapshot from ${when}?\n\n` +
                `This wipes the current contents of Bookmarks Bar / Other Bookmarks / Mobile and recreates them from the server snapshot.\n\n` +
                `Tip: Push first if you have local changes you want to keep.`
            );
            if (!yes) {
                updateMainStatus('Pull cancelled.');
                return;
            }
            
            updateMainStatus('Pulling…');
            await BackendSync.applyPull(data.snapshot);
            
            const updated = { ...settings, backend: { ...cfg, lastSyncAt: data.timestamp, lastSyncKind: 'pull' } };
            await StorageManager.saveSettings(updated);
            
            updateMainStatus('Pulled snapshot from ' + when);
            alert('Pull successful! Local bookmarks updated.');
            await loadCurrentTabs();
        } catch (e) {
            updateMainStatus('Pull failed: ' + e.message);
            alert('Pull failed: ' + e.message);
        }
    });
});

function closeSettings() {
    document.getElementById('settings-container').style.display = 'none';
    document.getElementById('actions').style.display = 'grid';
    document.getElementById('groups-container').style.display = 'block';
    document.getElementById('workflows-container').style.display = 'none';
    document.getElementById('organizer-container').style.display = 'none';
    document.getElementById('organizer-source-container').style.display = 'none';

    // Reload tabs in case settings changed context logic
    loadCurrentTabs();
}
