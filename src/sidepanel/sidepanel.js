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
import { TreeStore } from '../utils/treeStore.js';
import { ExpandState, OPEN_TABS_KEY, aiGroupKey } from '../utils/expandState.js';
import { NotesManager } from '../utils/notesManager.js';
import { resolveServerUrl } from '../utils/config.js';

// Every read and write goes against the local working copy of the synced tree
// (chrome.bookmarks-compatible facade). The browser's own bookmarks are only
// touched by the one-time "Import from this browser" action.
const Tree = TreeStore.bookmarks;

// --- State ---
let currentTabs = [];
let savedWorkflows = [];
// Set when the startup pull fails, so the empty state can explain itself
// rather than looking like data loss.
let startupSyncError = null;

// A dismissible banner at the top of the app explaining why there is no data.
function showStartupSyncBanner() {
    if (!startupSyncError) return;
    if (document.getElementById('tp-sync-banner')) return;
    const bar = document.createElement('div');
    bar.id = 'tp-sync-banner';
    bar.style.cssText = 'margin:8px; padding:10px 12px; border-radius:8px; background:rgba(245,158,11,0.12);'
        + 'border:1px solid var(--warning-color, #f59e0b); color:#fcd34d; font-size:0.82rem; line-height:1.45;';
    bar.innerHTML = `<strong>Couldn't load your bookmarks from the server.</strong><br>`
        + `${escapeHtml(startupSyncError)}<br>`
        + `<span style="color:#9ca3af;">Your data is on the server — nothing here has been deleted. `
        + `Fix the server, then press ⬇ Pull.</span>`;
    const host = document.querySelector('.container') || document.body;
    host.insertBefore(bar, host.firstChild);
}

// --- Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
    // Which cards were open last time is read alongside the tree, so the first
    // render already has it and paints once, in its final state.
    await Promise.all([TreeStore.load(), ExpandState.load()]);

    // First run after the update (or a fresh install): the working copy is
    // empty. If we're already signed in, pull the server's tree silently so
    // the app doesn't open onto nothing.
    try {
        const st = TreeStore.status();
        if (st.isEmpty && !st.dirty) {
            const cfg = await getSyncConfig();
            if (cfg.token) {
                await TreeStore.sync.pull(cfg);
                await persistSyncStamp('pull');
                console.log('[TabPaladin] Working copy was empty — pulled the server tree.');
            }
        }
    } catch (e) {
        // Never fail silently here: an empty working copy plus a failed pull
        // looks exactly like "all my bookmarks are gone", when in fact the
        // data is on the server and only the fetch failed.
        console.warn('[TabPaladin] Initial pull failed:', e.message);
        startupSyncError = e.message;
    }

    // Drop focused-folder ids that no longer resolve.
    //
    // These were browser bookmark ids ('1', '2', '347'...) chosen against the
    // old chrome.bookmarks tree. The migrated tree has its own ids, so every
    // one of them now points at nothing — and because the list is non-empty,
    // the views that filter by it render nothing while skipping the "show
    // everything" fallback that only triggers on an empty list. The result is
    // a fully populated working copy that displays as empty.
    try {
        const dropped = await pruneStaleFocusedFolders();
        if (dropped) console.log(`[TabPaladin] Dropped ${dropped} focused folder id(s) that predate the migration.`);
    } catch (e) {
        console.warn('[TabPaladin] Could not prune focused folders:', e.message);
    }
    await pruneStaleExpandState();
    window.addEventListener('pagehide', () => { ExpandState.flush(); });

    // One-time migration of legacy storage.local workflows into the tree.
    try {
        const result = await StorageManager.migrateLegacyIfNeeded();
        if (result.migrated > 0) {
            console.log(`TabPaladin: Migrated ${result.migrated} legacy workflow(s).`);
        }
    } catch (e) {
        console.warn("Migration check failed (non-fatal):", e);
    }

    await loadWorkflows();
    await loadCurrentTabs();

    setupEventListeners();

    // Live refresh: when the tree changes (an edit here, the background script
    // auto-removing a closed workflow tab, or a pull), refresh what's visible.
    const scheduleRefresh = (() => {
        let pending = null;
        return () => {
            if (pending) return;
            pending = setTimeout(async () => {
                pending = null;
                await loadWorkflows();
                // Keep the notes list in sync too when that view is open.
                if (document.getElementById('notes-container').style.display === 'block') {
                    await loadNotes();
                }
            }, 250);
        };
    })();
    TreeStore.onChanged(scheduleRefresh);
    TreeStore.onChanged(() => { if (!isSourceGridVisible()) sourceGridStale = true; });

    setupDragAutoScroll();
    showStartupSyncBanner();
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

            // Remembered before saving: if the working copy already had
            // unpushed edits, a conflict cannot be resolved by pulling
            // without discarding them, so the workflow stays local instead.
            const hadLocalEdits = TreeStore.status().dirty;
            const saved = await StorageManager.saveWorkflow(name, saveable);

            // The tabs are about to be closed, so the workflow has to be on
            // disk first. The tree persists on a debounce, and when this page
            // is a tab in the same window it used to close itself before the
            // timer fired — the tabs were gone and the workflow never written.
            await TreeStore.flush();
            const expected = saveable.length;
            if (!saved || saved.tabs.length !== expected) {
                alert(`Workflow saved ${saved ? saved.tabs.length : 0} of ${expected} tabs — leaving your tabs open so nothing is lost.`);
                loadWorkflows();
                return;
            }

            // Never close the page doing the saving; only close tabs that
            // were actually saved.
            const self = api.tabs.getCurrent ? await api.tabs.getCurrent() : null;
            const tabIds = saveable.map(t => t.id).filter(id => !self || id !== self.id);

            // Fresh tab so the window doesn't close when we remove the rest
            if (!self) await api.tabs.create({});
            await api.tabs.remove(tabIds);

            loadWorkflows();
            const synced = await pushSavedWorkflow(name, saveable, hadLocalEdits);
            alert(`Workflow "${name}" saved (${expected} tabs). ${synced}`);
        } catch (err) {
            console.error("Save workflow error:", err);
            alert("Error saving workflow: " + err.message);
        }
    }

    // A saved workflow is the only copy of tabs that were just closed, so it
    // goes to the server straight away instead of waiting for a manual Push.
    // When another device pushed in between, and this working copy has no
    // other unpushed edits, pull their tree and save the workflow again on
    // top of it — never force, which would erase what they pushed.
    async function pushSavedWorkflow(name, tabs, hadLocalEdits) {
        const cfg = await getSyncConfig();
        if (!cfg.token) return 'Not signed in, so it is only on this computer — sign in and Push.';
        try {
            await TreeStore.sync.push(cfg);
            await persistSyncStamp('push');
            return 'Synced to the server.';
        } catch (e) {
            if (e.status !== 409) return `Kept on this computer — push failed: ${e.message}`;
            if (hadLocalEdits) {
                return 'Kept on this computer: the server has newer changes and you have other unpushed edits. Push when ready.';
            }
            try {
                await TreeStore.sync.pull(cfg);
                await StorageManager.saveWorkflow(name, tabs);
                await TreeStore.flush();
                await TreeStore.sync.push(cfg);
                await persistSyncStamp('push');
                loadWorkflows();
                return 'Synced to the server (merged with changes from another device).';
            } catch (e2) {
                await TreeStore.flush().catch(() => {});
                return `Kept on this computer — sync failed: ${e2.message}`;
            }
        }
    }
}

// Browser roots that are not bookmark folders in any useful sense. They came
// across in the migration because the old snapshot was a whole browser tree,
// and Opera in particular contributes four of them. Same list as the PWA's
// NOISE_ROOTS in pwa/app.js — that client is deployed separately and cannot
// import from here, so the two must be kept in step by hand.
const NOISE_ROOT_TITLES = new Set([
    'trash', 'prullenbak', 'papierkorb', 'corbeille',
    'speed dials', 'speeddial', 'pinboard', 'unsynchronized pinboard',
    'unsynchronized pinboard ', 'imported bookmarks', 'geïmporteerde bladwijzers'
]);

function isNoiseRoot(node) {
    const t = (node.title || '').toLowerCase().trim();
    return NOISE_ROOT_TITLES.has(t);
}

// The tree's top-level folders worth listing: not an app-managed root (those
// have their own homes — pins tiles, notes view, the workflows card), not
// browser noise, and not empty. An empty root is a row that does nothing.
async function topLevelFolders() {
    try {
        const top = await Tree.getChildren('0');
        const out = [];
        for (const n of top) {
            if (n.kind !== 'folder') continue;
            if (n.role === 'pins' || n.role === 'notes' || n.role === 'workflows') continue;
            if (isNoiseRoot(n)) continue;
            // The imports archive is always worth showing; anything else has to
            // actually contain something.
            if (!n.readOnly) {
                const kids = await Tree.getChildren(n.id);
                if (kids.length === 0) continue;
            }
            out.push(n);
        }
        return out;
    } catch (e) {
        console.warn('[TabPaladin] Could not read the top level:', e.message);
        return [];
    }
}

// Keep only focused-folder ids that exist in the current tree. Returns how
// many were dropped, so a one-off migration cleanup can say so.
async function pruneStaleFocusedFolders() {
    const settings = await StorageManager.getSettings();
    const ids = settings.focusedFolderIds || [];
    if (!ids.length) return 0;
    const kept = [];
    for (const id of ids) {
        if (await TreeStore.getNode(id)) kept.push(id);
    }
    if (kept.length === ids.length) return 0;
    await StorageManager.saveSettings({ ...settings, focusedFolderIds: kept });
    return ids.length - kept.length;
}

// Forget open/closed state for folders that are gone. At startup the guard
// in pruneAgainstTree matters: a failed startup pull leaves an empty working
// copy in which every remembered folder looks deleted. A pull that just
// succeeded is trustworthy whatever happened at startup.
async function pruneStaleExpandState({ afterPull = false } = {}) {
    const dropped = await ExpandState.pruneAgainstTree(TreeStore, {
        syncError: afterPull ? null : startupSyncError
    });
    if (dropped) console.log(`[TabPaladin] Forgot open/closed state of ${dropped} deleted folder(s).`);
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

// The Organize ("Sources") grid. Hidden in the markup until first shown.
function isSourceGridVisible() {
    const c = document.getElementById('organizer-source-container');
    return !!c && c.style.display !== 'none' && c.style.display !== '';
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
    const subTree = await Tree.getSubTree(folderId);
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
                await Tree.create({ parentId, title: node.title || node.url, url: node.url });
            } catch (e) { console.warn('Failed to create bookmark', node, e); }
        } else if (node.type === 'folder') {
            try {
                const folder = await Tree.create({ parentId, title: node.title || 'Folder' });
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

    const siblings = await Tree.getChildren(parentId);
    const existing = siblings.find(s => !s.url && s.title === data.title);

    let finalTitle = data.title;
    if (existing) {
        const choice = await askFolderConflict(data.title);
        if (choice === 'cancel') return null;
        if (choice === 'overwrite') {
            try { await Tree.removeTree(existing.id); }
            catch (e) { throw new Error('Could not delete existing folder: ' + e.message); }
        } else if (choice === 'rename') {
            const newName = prompt(`New name for the imported folder:`, `${data.title} (imported)`);
            if (!newName || !newName.trim()) return null;
            finalTitle = newName.trim();
        }
    }

    const folder = await Tree.create({ parentId, title: finalTitle });
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
        const nodes = await Tree.get(id).catch(() => []);
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

// Node ids survive push/pull now, so there is nothing to remap after a sync —
// the old path-capture/remap machinery that lived here is gone with the
// destructive pull it compensated for.

// Module-level state for the main view (AI groups are mutable in-memory; tabs are sourced live).
let mainViewState = {
    aiGroups: [],         // [{ id, name, items: [{tabId, url, title, favIconUrl}] }]
    bookmarkUrls: new Set(), // URLs already in bookmarks — filters Open Tabs
};

async function getAllBookmarkUrls() {
    const urls = new Set();
    const tree = await Tree.getTree();
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

// Every drop, pull and regroup rebuilds the main view. It is built off-screen
// and swapped in whole, so the page never flashes empty or loses its scroll,
// and a render that a newer one overtook is thrown away instead of landing last.
let mainRenderSeq = 0;

async function renderMainView({ regroup = true } = {}) {
    const seq = ++mainRenderSeq;
    const container = document.getElementById('groups-container');
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
    // Same default as the Sources grid: nothing focused means show everything,
    // rather than only the workflows folder.
    if (focused.length === 0) {
        for (const top of await topLevelFolders()) {
            if (!realRoots.find(r => r.id === top.id)) {
                realRoots.push({ id: top.id, isWorkflow: false, isBookmarks: top.role === 'bookmarks' });
            }
        }
    }
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
    headerBar.querySelector('#mainRegroupBtn').addEventListener('click', () => renderMainView({ regroup: true }));

    const grid = document.createElement('div');
    grid.className = 'roots-row';

    // Columns, side by side: Open Tabs, Workflows, Bookmarks. Each is a
    // section you scan independently, so they sit next to each other rather
    // than stacking and pushing the later ones below the fold.
    grid.appendChild(renderOpenTabsCard(unclaimedTabs, mainViewState.aiGroups));

    // One budget across all columns: it caps how much the remembered-open
    // folders may build on their own in this pass.
    const budget = newRestoreBudget();
    for (const r of realRoots) {
        try {
            const c = await BookmarkOrganizer.getDirectoryContents(r.id);
            if (!c) continue;
            grid.appendChild(buildFolderCard({
                id: c.id,
                title: c.title,
                folderCount: c.subfolders.length,
                fileCount: c.looseCount,
                icon: r.isWorkflow ? '🛡️' : (r.isBookmarks ? '🔖' : '📁')
            }, 0, budget));
        } catch (e) {
            console.warn("Could not load root", r.id, e);
        }
    }
    await restoreQueued(budget);

    if (seq !== mainRenderSeq) return;
    swapKeepingColumnScroll(container, headerBar, grid);
}

// Replace a view's contents in one go. Each column is its own scroll box, so
// carry every column's scrollTop over to its rebuilt counterpart (same
// data-id) — a drop deep in a long column should not throw you to its top.
function swapKeepingColumnScroll(container, ...nodes) {
    const COLUMNS = ':scope > .roots-row > .source-folder-card';
    const scrolls = new Map();
    for (const col of container.querySelectorAll(COLUMNS)) {
        if (col.scrollTop) scrolls.set(col.dataset.id, col.scrollTop);
    }
    container.replaceChildren(...nodes);
    if (!scrolls.size) return;
    for (const col of container.querySelectorAll(COLUMNS)) {
        const top = scrolls.get(col.dataset.id);
        if (top) col.scrollTop = top;
    }
}

function renderOpenTabsCard(unclaimedTabs, aiGroups) {
    const card = document.createElement('div');
    card.className = 'source-folder-card open-tabs-card';
    card.dataset.id = OPEN_TABS_KEY;

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
    wireRememberedToggle(card, header, body, OPEN_TABS_KEY);

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

// Open Tabs and the AI groups build their whole body up front (one window's
// tabs), so collapsing only hides it. Both default to open; an explicit
// toggle is remembered under `key`.
function wireRememberedToggle(card, header, body, key) {
    const caret = header.querySelector('.folder-caret');
    const paint = (open) => {
        card.dataset.open = open ? '1' : '';
        body.style.display = open ? 'block' : 'none';
        caret.textContent = open ? '▼' : '▶';
    };
    paint(ExpandState.isOpen(key, true));
    header.addEventListener('click', (e) => {
        if (e.target.closest('button') || e.target.closest('input') || e.target.classList.contains('folder-drag-handle')) return;
        const open = card.dataset.open !== '1';
        ExpandState.set(key, open);
        paint(open);
    });
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
    card.appendChild(body);

    if (group.items.length === 0) {
        body.innerHTML = '<div class="src-empty-state">Empty group.</div>';
    } else {
        appendTabDomainGroups(body, group.items, group.id);
    }

    // Expand/collapse. Group ids are regenerated on every regroup, so the
    // remembered state goes by the group's name.
    wireRememberedToggle(card, header, body, aiGroupKey(group.name));

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

// Built off-screen and swapped in. Two loads close together (a tree edit and
// a pull) used to interleave their appends and list workflows twice; now the
// later render wins and the earlier one is dropped.
let workflowsRenderSeq = 0;

async function renderWorkflows() {
    // Every tree edit lands here. While the view is hidden, rebuilding the
    // workflow cards (and any remembered-open bodies) is wasted work; the
    // Workflows button loads them again when it shows the view.
    const view = document.getElementById('workflows-container');
    if (view && view.style.display === 'none') return;

    const seq = ++workflowsRenderSeq;
    const list = document.getElementById('workflows-list');
    const frag = document.createDocumentFragment();

    const wfRoot = await findWorkflowRootSilent();
    const wfFolders = wfRoot ? (await Tree.getChildren(wfRoot.id)).filter(c => !c.url) : [];
    const budget = newRestoreBudget();
    // Render each workflow as a folder card with the workflow Open button.
    // List items become non-list divs since the folder-card UI doesn't fit <li> semantics.
    for (const wf of wfFolders) {
        const wfChildren = await Tree.getChildren(wf.id);
        const card = buildFolderCard({
            id: wf.id,
            title: wf.title,
            parentId: wfRoot.id,
            folderCount: wfChildren.filter(c => !c.url).length,
            fileCount: wfChildren.filter(isVisibleBookmark).length,
            icon: '🛡️',
            isWorkflow: true
        }, 0, budget);
        const li = document.createElement('li');
        li.style.listStyle = 'none';
        li.appendChild(card);
        frag.appendChild(li);
    }
    await restoreQueued(budget);

    if (seq !== workflowsRenderSeq) return;
    if (wfFolders.length === 0) {
        list.innerHTML = '<li class="empty-state">No saved workflows.</li>';
        return;
    }
    list.style.listStyle = 'none';
    list.style.padding = '0';
    list.replaceChildren(frag);
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

// --- Bookmark Organizer Logic ---
let currentProposal = null;
let currentNavStack = []; // Stack of {id, title} for breadcrumbs.
// Virtual root sentinel: shown when multiple focused folders are selected in settings.
const VIRTUAL_ROOT_ID = '__virtual_root__';

async function findWorkflowRootSilent() {
    try {
        // Role lookup on the tree — duplicates can't exist any more.
        return await StorageManager.findWorkflowRoot();
    } catch (e) {
        return null;
    }
}

// Hide internal sentinel bookmarks from rendering. Both are bookkeeping the
// user never asked for: the per-workflow meta record, and the root-identity
// marker that stops duplicate roots reappearing.
const TP_META_TITLE = '__tabpaladin_meta__';
const TP_ROOT_MARKER_TITLE = '__tabpaladin_root__';
function isInternalBookmark(node) {
    return !!node && (node.title === TP_META_TITLE || node.title === TP_ROOT_MARKER_TITLE);
}
function isVisibleBookmark(node) {
    return node && node.url && !isInternalBookmark(node);
}

// Deleting or moving a row that lives inside the imports archive goes through
// the server's explicit verbs instead of a tree edit: delete tombstones it so a
// sweep cannot bring it back, and moving it out files a copy into your own tree
// while the archive stops drawing it.
// Split a batch of node ids into archived import items and ordinary nodes.
// Refuses up front when the batch contains the archive's own folders (month /
// provider ids like `imp:src:…`): those have no delete/file verb, and letting
// the batch start would tombstone some items and then die mid-loop on the
// folder, leaving a half-applied operation.
function partitionImportIds(ids) {
    const strIds = ids.map(String);
    if (strIds.some(id => id.startsWith('imp:src:') || id === 'imports:root')) {
        throw new Error('Import folders are managed by the server — act on the items inside them instead.');
    }
    return {
        importIds: strIds.filter(id => TreeStore.imports.parse(id)),
        plainIds: strIds.filter(id => !TreeStore.imports.parse(id))
    };
}

async function removeBookmarksSmart(ids) {
    const { importIds, plainIds } = partitionImportIds(ids);
    if (importIds.length) {
        await TreeStore.imports.deleteItems(await getSyncConfig(), importIds);
    }
    for (const id of plainIds) {
        await Tree.remove(id);
    }
}

async function moveBookmarksSmart(ids, targetFolderId) {
    const { importIds, plainIds } = partitionImportIds(ids);
    if (importIds.length) {
        await TreeStore.imports.fileItems(await getSyncConfig(), importIds, targetFolderId);
    }
    for (const id of plainIds) {
        await Tree.move(id, { parentId: targetFolderId });
    }
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
    const children = await Tree.getChildren(folderId);
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

// Same build-then-swap as the main view; drill, Back and drops all land here,
// and each level comes back with its remembered-open cards already open.
let sourceRenderSeq = 0;
// Out of date: never built, or the tree changed while the grid was hidden
// (refreshes skip hidden views). Back from a proposal is the one way back to
// the grid that does not rebuild it, so it checks this.
let sourceGridStale = true;

async function renderSourceGrid(folderId) {
    const seq = ++sourceRenderSeq;
    sourceGridStale = false; // an edit landing while this builds sets it again
    const sourceList = document.getElementById('source-list');
    const frag = document.createDocumentFragment();
    const budget = newRestoreBudget();
    await buildSourceGrid(frag, folderId, budget);
    await restoreQueued(budget);
    if (seq !== sourceRenderSeq) return;
    sourceList.className = 'source-folder-list';
    swapKeepingColumnScroll(sourceList, frag);
}

// The Organize grid for one level, built into `out` (a detached fragment).
// Remembered-open cards are queued on `budget` for the caller to reopen.
async function buildSourceGrid(out, folderId, budget) {
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
        // With no folders focused, show the whole tree's top level.
        //
        // The old fallback only fired when `roots` was completely empty, which
        // the workflows root alone was enough to prevent — so a user with no
        // focused folders saw a lone Workflows card and none of their
        // bookmarks. It used to be masked by focusedFolderIds defaulting to
        // real browser roots; the migrated tree has no such thing, so the
        // top level of the tree is the honest default.
        if (focused.length === 0) {
            for (const top of await topLevelFolders()) {
                if (!roots.find(r => r.id === top.id)) {
                    roots.push({ id: top.id, isWorkflow: false, isBookmarks: top.role === 'bookmarks' });
                }
            }
        }

        out.appendChild(buildOrganizeHeader('Sources', null));

        const grid = document.createElement('div');
        grid.className = 'roots-row'; // side by side — see renderMainView
        out.appendChild(grid);

        for (const r of roots) {
            try {
                const c = await BookmarkOrganizer.getDirectoryContents(r.id);
                if (!c) continue;
                grid.appendChild(buildFolderCard({
                    id: c.id,
                    title: c.title,
                    folderCount: c.subfolders.length,
                    fileCount: c.looseCount,
                    icon: r.isWorkflow ? '🛡️' : (r.isBookmarks ? '🔖' : '📁')
                }, 0, budget));
            } catch (e) {
                console.warn("Could not load root", r.id, e);
            }
        }
        return;
    }

    const content = await BookmarkOrganizer.getDirectoryContents(folderId);
    if (!content) return;

    out.appendChild(buildOrganizeHeader(content.title, content.id));

    // Render each subfolder as a card. Direct bookmarks of `folderId` would be siblings —
    // surface them by expanding the breadcrumb itself: any user who wants to see them
    // can open the parent breadcrumb level via Back, or expand the folder card from above.
    // For now: if the breadcrumb folder has loose bookmarks, render them as a section at the top.
    if (content.looseCount > 0) {
        const looseChildren = (await Tree.getChildren(content.id)).filter(isVisibleBookmark);
        if (looseChildren.length > 0) {
            out.appendChild(renderTopLevelLooseSection(content.id, looseChildren, budget));
        }
    }

    for (const sub of content.subfolders) {
        // Pass parentId so refresh-on-drop knows where to update.
        out.appendChild(buildFolderCard({ ...sub, parentId: content.id }, 0, budget));
    }
}

// Renders loose bookmarks of the current breadcrumb folder as a flat group above the subfolder cards.
function renderTopLevelLooseSection(parentFolderId, looseBookmarks, budget) {
    const wrap = document.createElement('div');
    wrap.className = 'src-top-loose';

    const header = document.createElement('div');
    header.className = 'src-top-loose-header';
    header.textContent = `Loose bookmarks here (${looseBookmarks.length})`;
    wrap.appendChild(header);

    appendDomainGroups(wrap, looseBookmarks, parentFolderId, budget);
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
                const created = await Tree.create({ parentId: parentFolderId, title: name });
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

// Root of the server-managed import archive. Its whole subtree is read-only to
// the user apart from taking things out of it.
const IMPORTS_ROOT_TITLE = 'TabPaladin Imports';

// --- Remembered open folders ---
// Folder cards reopen the way the user left them (ExpandState, keyed by node
// id, so a folder is open or closed alike in the main view, Organize and
// Workflows). Every rebuild restores that while the card is still detached,
// so the view paints once, in its final shape. Building rows is the slow part
// (~180 ms for 6000), so it is bounded twice: a body shows its first
// BODY_ROW_CAP rows with "Show more" for the rest, and one render pass reopens
// at most RESTORE_ROW_BUDGET rows' worth of cards on its own.
const BODY_ROW_CAP = 200;
const SHOW_MORE_STEP = 500;
const RESTORE_ROW_BUDGET = 2000;
const RESTORE_SKIPPED_TIP = 'Open last time — not reopened automatically to keep the page fast. Click to open.';

// `queue` holds the remembered-open cards built in this pass and not yet
// reopened, `paged` the bodies waiting to show their "Show more" pages
// again; restoreQueued works through both.
function newRestoreBudget() {
    return { rows: RESTORE_ROW_BUDGET, queue: [], paged: [] };
}

// Folder card element -> its open/close controller (see renderFolderCard).
const cardControls = new WeakMap();

// Folder id -> Map(domain -> rows shown), for the bodies the user paged with
// "Show more". This page session only. A rebuild (a drop, a pull, a refresh)
// shows those rows again, so the scrollTop a column carries over still lands
// on the row it was on rather than past the end of the first page.
const pagedRows = new Map();

// A folder card, built closed. When the user left it open it is queued on the
// pass's budget, and the pass's restoreQueued reopens it before the view is
// attached.
function buildFolderCard(sub, depth, budget) {
    const card = renderFolderCard(sub, depth);
    if (ExpandState.isOpen(sub.id)) budget.queue.push({ card, sub });
    return card;
}

// Reopens the queued cards one level at a time. Every card on a level is
// charged before any of their bodies is built, and those bodies queue their
// own remembered-open subfolders for the next level. So a top-level column is
// never given up for a grandchild in another column, nor a folder for a
// sibling's deep subtree. Past the budget: left closed, marked as open last
// time. Paged bodies get their extra rows last, out of what is left.
async function restoreQueued(budget) {
    while (budget.queue.length) {
        const opening = [];
        for (const { card, sub } of budget.queue.splice(0)) {
            const cost = (sub.folderCount || 0) + Math.min(sub.fileCount || 0, BODY_ROW_CAP);
            if (cost <= budget.rows) {
                budget.rows -= cost;
                opening.push(card);
            } else {
                cardControls.get(card).markSkipped();
            }
        }
        for (const card of opening) await cardControls.get(card).restore(budget);
    }
    for (const build of budget.paged.splice(0)) build();
}

function folderStatsText(folderCount, fileCount) {
    const parts = [];
    if (folderCount > 0) parts.push(`${folderCount} 📁`);
    if (fileCount > 0) parts.push(`${fileCount} 📄`);
    return parts.join(' · ') || 'Empty';
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
    // The imports subtree is server-managed: the sweep rebuilds it, and moving
    // or deleting inside it is read back and acted on rather than being a local
    // edit like anywhere else. Mark it so that is visible before someone starts
    // rearranging, and so the drop target below can refuse.
    //
    // inImports is inherited from the parent card, so the whole subtree is
    // locked rather than just the root — dropping into Reddit/Saved/2026-08 is
    // exactly as pointless as dropping into the root.
    const isImportsRoot = sub.title === IMPORTS_ROOT_TITLE || sub.readOnly === true;
    const isImports = isImportsRoot || sub.inImports === true;
    header.className = 'source-folder-header' + (isImports ? ' is-imports' : '');
    card.dataset.imports = isImports ? '1' : '';

    const stats = folderStatsText(sub.folderCount, sub.fileCount);

    const openBtnHtml = sub.isWorkflow
        ? `<button class="sm-btn open-workflow-btn" title="Open all bookmarks in a new window" style="padding:2px 8px;">▶ Open</button>`
        : '';
    // Drill jumps into the Organize folder grid; that target is the Organize page, not the
    // Workflows page. Hide drill on workflow cards to avoid an apparent dead button.
    const drillBtnHtml = sub.isWorkflow
        ? ''
        : `<button class="sm-btn drill-btn" title="Enter ${escapeHtml(sub.title)}" style="padding:2px 8px;">›</button>`;
    const showDelete = sub.parentId && sub.parentId !== '0';
    const deleteBtnHtml = showDelete
        ? `<button class="sm-btn delete-folder-btn" title="Delete ${escapeHtml(sub.title)}" style="padding:2px 6px; color: #f87171;">🗑</button>`
        : '';

    header.innerHTML = `
        <span class="folder-drag-handle" title="Drag to move folder" draggable="true">⋮⋮</span>
        <span class="folder-caret">▶</span>
        <span class="folder-icon">${isImports ? '📥' : (sub.icon || '📁')}</span>
        <span class="folder-title">${escapeHtml(sub.title)}</span>
        ${isImports ? '<span class="imports-badge">synced</span>' : ''}
        <span class="folder-stats">${stats}</span>
        ${openBtnHtml}
        ${isImports ? '' : `<button class="sm-btn split-btn" title="Sort loose files in this folder" style="padding:2px 8px;">✨ Split</button>`}
        ${isImports ? '' : `<button class="sm-btn new-subfolder-btn" title="Create a folder inside ${escapeHtml(sub.title)}" style="padding:2px 8px;">＋📁</button>`}
        ${deleteBtnHtml}
        ${drillBtnHtml}
        ${isImports ? '' : '<input type="checkbox" class="source-select-check" title="Select for batch action (Analyze & Sort / Restructure)">'}
    `;
    card.appendChild(header);

    // Body (collapsed by default). It is built when the card opens and emptied
    // when it closes, so a closed big folder holds no rows.
    //
    // card.dataset.open is the one source of truth for open/closed. Every way
    // of opening the card — header click, new subfolder, drag-hover, restore
    // on render, refresh — goes through the controller below, so the caret,
    // the body and the remembered state cannot drift apart.
    const body = document.createElement('div');
    body.className = 'source-folder-body';
    body.style.display = 'none';
    card.appendChild(body);
    card.dataset.open = '';

    const caret = header.querySelector('.folder-caret');
    // Bumped by every open and close: a build that was overtaken (a quick
    // second click, a refresh racing a click) is dropped rather than landing
    // on top, which used to append the subfolders twice.
    let bodySeq = 0;
    // A body opened on its own (a click, a refresh) is its own restore pass:
    // its remembered-open subfolders are reopened before it is shown. Inside
    // a bigger pass (restore), that pass's restoreQueued does it.
    const showBody = async (budget, ownPass = false) => {
        card.dataset.open = '1';
        caret.textContent = '▼';
        const seq = ++bodySeq;
        const frag = await buildFolderBody(sub.id, depth, isImports, budget);
        if (ownPass) await restoreQueued(budget);
        if (seq !== bodySeq || card.dataset.open !== '1') return;
        body.replaceChildren(frag);
        body.style.display = 'block';
    };
    const hideBody = () => {
        bodySeq++;
        card.dataset.open = '';
        caret.textContent = '▶';
        body.style.display = 'none';
        body.replaceChildren();
    };
    const clearSkipped = () => {
        card.classList.remove('restore-skipped');
        header.removeAttribute('title');
    };
    const ctl = {
        // The user opened or closed it: remembered on this device. Closing
        // also drops its "Show more" pages, so it reopens on its first rows.
        async setOpen(open) {
            clearSkipped();
            ExpandState.set(sub.id, open);
            if (open) {
                await showBody(newRestoreBudget(), true);
            } else {
                pagedRows.delete(String(sub.id));
                hideBody();
            }
        },
        // Drag-hover: open for the rest of this page session, never saved.
        async springOpen() {
            clearSkipped();
            ExpandState.openForSession(sub.id);
            await showBody(newRestoreBudget(), true);
        },
        // Rebuilding a view: reopen as remembered, writing nothing. Called by
        // restoreQueued, which then reopens this body's own queued cards.
        restore(budget) {
            return showBody(budget);
        },
        // Over this pass's budget: left closed, marked as open last time.
        markSkipped() {
            card.classList.add('restore-skipped');
            caret.textContent = '▷';
            header.title = RESTORE_SKIPPED_TIP;
        },
        // The folder's contents changed: rebuild the body if it is showing.
        async refresh(budget = newRestoreBudget()) {
            if (card.dataset.open === '1') await showBody(budget, true);
        }
    };
    cardControls.set(card, ctl);

    // Toggle expand on header click (ignoring interactive children).
    header.addEventListener('click', (e) => {
        if (e.target.closest('button') || e.target.closest('input')) return;
        ctl.setOpen(card.dataset.open !== '1');
    });

    // Drill — push breadcrumb and re-render at that folder (only for non-workflow cards).
    const drillBtn = header.querySelector('.drill-btn');
    if (drillBtn) {
        drillBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const organize = document.getElementById('organizer-source-container');
            if (isSourceGridVisible()) {
                currentNavStack.push({ id: sub.id, title: sub.title });
                renderSourceGrid(sub.id);
                return;
            }
            // Outside Organize the grid renders into a hidden section, which
            // made this button look dead. Open Organize at this folder
            // instead, with Back leading to Sources.
            currentNavStack = [{ id: VIRTUAL_ROOT_ID, title: 'Sources' }, { id: sub.id, title: sub.title }];
            await renderSourceGrid(sub.id);
            document.getElementById('groups-container').style.display = 'none';
            document.getElementById('workflows-container').style.display = 'none';
            document.getElementById('organizer-container').style.display = 'none';
            document.getElementById('notes-container').style.display = 'none';
            organize.style.display = 'block';
            window.scrollTo(0, 0);
        });
    }

    // Split = AI/heuristic on this folder's loose files only.
    // Optional chaining throughout: these controls are omitted inside the
    // import archive, where they would only queue up work the next sweep undoes.
    header.querySelector('.split-btn')?.addEventListener('click', async (e) => {
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
    header.querySelector('.new-subfolder-btn')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        const name = prompt(`Name for new folder inside "${sub.title}":`);
        if (!name) return;
        try {
            await Tree.create({ parentId: sub.id, title: name.trim() });
            // Expand the card so the user sees the new folder.
            if (card.dataset.open === '1') await ctl.refresh();
            else await ctl.setOpen(true);
            // Update header stats, and any other open copy of this folder.
            await refreshFolderBodyIfOpen(sub.id, card);
        } catch (err) {
            alert('Could not create folder: ' + err.message);
        }
    });

    // Delete folder button — removes this folder and all its contents.
    const deleteBtn = header.querySelector('.delete-folder-btn');
    if (deleteBtn) {
        deleteBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const totalItems = (sub.folderCount || 0) + (sub.fileCount || 0);
            const msg = totalItems > 0
                ? `Delete "${sub.title}" and all its contents (${totalItems} items)?`
                : `Delete empty folder "${sub.title}"?`;
            if (!confirm(msg)) return;
            try {
                await Tree.removeTree(sub.id);
                // Remove the card from the DOM with a quick fade-out.
                card.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
                card.style.opacity = '0';
                card.style.transform = 'translateX(20px)';
                setTimeout(() => card.remove(), 200);
            } catch (err) {
                alert('Could not delete folder: ' + err.message);
            }
        });
    }

    // Checkbox: select for batch Analyze/Restructure.
    const checkbox = header.querySelector('.source-select-check');
    checkbox?.addEventListener('change', () => {
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
            const kids = await Tree.getChildren(sub.id);
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
        // Nothing may be filed *into* the archive. The next sweep rebuilds this
        // subtree from the server's own records, so anything dropped here is
        // either thrown away or quietly relocated — better to refuse the drop
        // than to accept it and lose it. Not calling preventDefault is what
        // makes the browser show "no drop" and reject it.
        if (isImports) { e.dataTransfer.dropEffect = 'none'; return; }
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
        if (card.dataset.open !== '1' && springTimer == null) {
            springTimer = setTimeout(() => {
                springTimer = null;
                if (card.dataset.open === '1') return; // user expanded it manually meanwhile
                ctl.springOpen();
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

        // Belt and braces: dragover already refuses, but a drop can still be
        // synthesised, and silently accepting one would lose the bookmark at
        // the next sweep.
        if (isImports) return;

        const bookmarkId = e.dataTransfer.getData('text/tp-bookmark-id');
        const bookmarkIdsJson = e.dataTransfer.getData('text/tp-bookmark-ids');
        const draggedFolderId = e.dataTransfer.getData('text/tp-folder-id');
        const sourceParentId = e.dataTransfer.getData('text/tp-parent-id');
        const tabPayload = e.dataTransfer.getData('text/tp-tab');
        const tabsPayload = e.dataTransfer.getData('text/tp-tabs');
        const groupPayload = e.dataTransfer.getData('text/tp-group');

        const closeTabs = isMainViewVisible(); // honor main view's expectation
        const closedTabIds = [];

        try {
            if (groupPayload) {
                // AI Group → create subfolder + bookmarks for each item, then close source tabs.
                const g = JSON.parse(groupPayload);
                if (!g.items || g.items.length === 0) return;
                // Create subfolder under target with the group name (reuse existing if name matches).
                const siblings = await Tree.getChildren(sub.id);
                const existing = siblings.find(s => !s.url && s.title.toLowerCase() === g.name.toLowerCase());
                const folderId = existing ? existing.id : (await Tree.create({ parentId: sub.id, title: g.name })).id;
                for (const it of g.items) {
                    await Tree.create({ parentId: folderId, title: it.title || it.url, url: it.url });
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
                        const siblings = await Tree.getChildren(sub.id);
                        const takenNames = new Set(siblings.filter(s => !s.url).map(s => s.title));
                        let name = domain, suffix = 2;
                        while (takenNames.has(name)) name = `${domain} (${suffix++})`;
                        const subfolder = await Tree.create({ parentId: sub.id, title: name });
                        targetFolderId = subfolder.id;
                    }

                    for (const it of items) {
                        await Tree.create({ parentId: targetFolderId, title: it.title || it.url, url: it.url });
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
                await Tree.create({ parentId: sub.id, title: t.title || t.url, url: t.url });
                if (closeTabs && t.tabId != null) closedTabIds.push(t.tabId);
                // Remove tab from its source AI group, if any.
                if (t.sourceGroupId) {
                    const src = mainViewState.aiGroups.find(g => g.id === t.sourceGroupId);
                    if (src) src.items = src.items.filter(it => it.tabId !== t.tabId);
                }
            } else if (bookmarkIdsJson) {
                let ids = [];
                try { ids = JSON.parse(bookmarkIdsJson); } catch (err) { console.warn('Bad bookmark-ids payload'); }
                await moveBookmarksSmart(ids.map(String), sub.id);
            } else if (bookmarkId) {
                await moveBookmarksSmart([bookmarkId], sub.id);
            } else if (draggedFolderId) {
                if (draggedFolderId === sub.id) return;
                if (await isAncestorOf(draggedFolderId, sub.id)) {
                    alert("Can't move a folder into one of its own descendants.");
                    return;
                }
                await Tree.move(draggedFolderId, { parentId: sub.id });
            } else {
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

            // Refresh whichever view we're in. When the Organize level on
            // screen is the source or the target, rebuilding it covers every
            // card of both; otherwise both folders' open bodies are rebuilt in
            // one go, and a target card inside the rebuilt source body only once.
            const top = currentNavStack[currentNavStack.length - 1];
            if (isMainViewVisible()) {
                await renderMainView({ regroup: false });
            } else if (isSourceGridVisible() && top && (top.id === sourceParentId || top.id === sub.id)) {
                await renderSourceGrid(top.id);
            } else {
                await refreshFolderBodyIfOpen([sourceParentId, sub.id]);
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
//
// Only the first `rowCap` rows are built: a folder of thousands (an import
// archive) would otherwise cost every re-render hundreds of milliseconds. The
// group the cap cuts through gets its own "Show N more"; groups the cap never
// reached sit behind one button at the end. Whatever a group header does —
// drag, ▶ All, ▶ 10, delete — acts on the group's full list, never only on
// the rows on screen.
//
// A folder the user paged further comes back paged (pagedRows), the rows
// past the first page paid from the pass's restore `budget`. Open cards come
// first, so that part is built at the end of the pass (restoreQueued), out of
// what the cards left, into a spot held for it here.
function appendDomainGroups(container, bookmarks, parentFolderId, budget = null) {
    if (!bookmarks || bookmarks.length === 0) return;
    const key = String(parentFolderId);
    if (!pagedRows.has(key)) {
        fillDomainGroups(container, bookmarks, parentFolderId, new Map(), BODY_ROW_CAP);
        return;
    }
    // This body takes over keeping the folder's pages (unless it was closed
    // meanwhile, which forgets them).
    const build = (into) => {
        const remembered = pagedRows.get(key);
        const pages = new Map();
        if (remembered) pagedRows.set(key, pages);
        fillDomainGroups(into, bookmarks, parentFolderId, pages, BODY_ROW_CAP, remembered, budget);
    };
    if (!budget) {
        build(container);
        return;
    }
    const spot = document.createElement('div');
    container.appendChild(spot);
    budget.paged.push(() => {
        const frag = document.createDocumentFragment();
        build(frag);
        spot.replaceWith(frag);
    });
}

// The groups themselves, first `rowCap` rows free. `pages` is the body's
// record of rows shown per group, handed on when the end button continues
// the body. With `remembered` (the folder's pages before this rebuild) each
// group it showed gets the rows it had, the ones past `rowCap` charged to
// `budget`; once that runs out, the groups left wait behind the end button.
function fillDomainGroups(container, bookmarks, parentFolderId, pages, rowCap, remembered = null, budget = null) {
    const key = String(parentFolderId);
    const byDomain = {};
    bookmarks.forEach(b => {
        const d = tabDomain(b.url);
        if (!byDomain[d]) byDomain[d] = [];
        byDomain[d].push(b);
    });

    const domains = Object.keys(byDomain).sort();
    // The last group shown before. One that has turned up ahead of it since
    // (a drop) is shown whole rather than left behind the end button.
    const reachedTo = remembered?.size ? [...remembered.keys()].sort().pop() : null;
    let free = rowCap;
    let next = 0;
    for (; next < domains.length; next++) {
        const d = domains[next];
        const items = byDomain[d];
        let want;
        if (remembered?.has(d)) want = remembered.get(d);
        else if (free > 0) want = free;
        else if (reachedTo !== null && d < reachedTo) want = items.length;
        else break;
        want = Math.min(want, items.length);
        const fromCap = Math.min(want, free);
        let extra = want - fromCap;
        if (budget) extra = Math.min(extra, Math.max(0, budget.rows));
        if (want > 0 && fromCap + extra === 0) break;
        if (budget) budget.rows -= extra;
        free -= fromCap;
        const shown = appendDomainGroup(container, d, items, parentFolderId, fromCap + extra, pages);
        // Cut short by the budget: a later pass with more to spare shows the
        // rest again. Likewise the groups it never reached, below.
        if (shown < want) pages.set(d, want);
    }
    for (const d of domains.slice(next)) {
        if (remembered?.has(d)) pages.set(d, remembered.get(d));
    }
    if (next === domains.length) return;

    const restDomains = domains.slice(next);
    const rest = restDomains.flatMap(d => byDomain[d]);
    const more = document.createElement('button');
    more.className = 'sm-btn src-more-btn';
    more.textContent = `Show ${rest.length.toLocaleString()} more bookmarks in `
        + `${restDomains.length.toLocaleString()} site${restDomains.length === 1 ? '' : 's'}`;
    more.addEventListener('click', (e) => {
        e.stopPropagation();
        const frag = document.createDocumentFragment();
        fillDomainGroups(frag, rest, parentFolderId, pages, SHOW_MORE_STEP);
        more.replaceWith(frag);
        pagedRows.set(key, pages);
    });
    container.appendChild(more);
}

// One domain group showing its first `firstRows` rows. `items` is the group's
// full list, rendered or not; a row deleted on its own is taken out of it, so
// the header's bulk actions stay exact. `pages` (domain -> rows shown) is
// kept current for the body it sits in. Returns how many rows it built.
function appendDomainGroup(container, d, items, parentFolderId, firstRows, pages) {
    const group = document.createElement('div');
    group.className = 'src-domain-group';
    group.dataset.domain = d;
    group.dataset.parentId = String(parentFolderId);

    const header = document.createElement('div');
    header.className = 'src-domain-header';
    const count = items.length;
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
        <button class="sm-btn domain-delete-btn" title="Delete all ${count} bookmarks under this domain" style="padding:2px 6px; color: #f87171;">🗑</button>
    `;
    group.appendChild(header);
    const countSpan = header.querySelector('.src-domain-count');
    const deleteBtn = header.querySelector('.domain-delete-btn');

    // Open All / Open 10 click handlers
    header.querySelector('.domain-open-all-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        await openBookmarksAsNewWindow([...items]);
    });
    const open10Btn = header.querySelector('.domain-open-10-btn');
    if (open10Btn) {
        open10Btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await openBookmarksAsNewWindow(items.slice(0, 10));
        });
    }

    // Delete entire domain group click handler
    deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete all ${items.length} bookmarks under "${d}"?`)) return;
        try {
            await removeBookmarksSmart(items.map(b => b.id));
            group.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
            group.style.opacity = '0';
            group.style.transform = 'translateX(20px)';
            setTimeout(async () => {
                group.remove();
                pages.delete(d);
                await refreshFolderBodyIfOpen(parentFolderId);
            }, 200);
        } catch (err) {
            alert('Could not delete bookmarks: ' + err.message);
        }
    });

    // Middle click on the domain row opens all in a new window too.
    const ignoreOnInteractive = (e) => e.target.closest('button') || e.target.closest('input');
    header.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
    header.addEventListener('auxclick', async (e) => {
        if (e.button !== 1 || ignoreOnInteractive(e)) return;
        e.preventDefault();
        await openBookmarksAsNewWindow([...items]);
    });

    // Group-level drag (all bookmarks in this domain)
    const handle = header.querySelector('.domain-drag-handle');
    handle.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/tp-bookmark-ids', JSON.stringify(items.map(b => b.id)));
        e.dataTransfer.setData('text/tp-parent-id', String(parentFolderId));
        e.dataTransfer.effectAllowed = 'move';
        group.classList.add('dragging');
        e.stopPropagation();
    });
    handle.addEventListener('dragend', () => group.classList.remove('dragging'));

    // Individual rows: items[0..shown) are on screen, the rest behind "Show more".
    let shown = 0;
    let moreBtn = null;
    const syncMore = () => {
        const left = items.length - shown;
        if (left <= 0) {
            moreBtn?.remove();
            moreBtn = null;
            return;
        }
        if (!moreBtn) {
            moreBtn = document.createElement('button');
            moreBtn.className = 'sm-btn src-more-btn';
            moreBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                showRows(SHOW_MORE_STEP);
                pagedRows.set(String(parentFolderId), pages);
            });
            group.appendChild(moreBtn);
        }
        moreBtn.textContent = `Show ${left.toLocaleString()} more`;
    };
    const showRows = (n) => {
        const end = Math.min(items.length, shown + n);
        const frag = document.createDocumentFragment();
        for (let i = shown; i < end; i++) {
            frag.appendChild(buildBookmarkRow(items[i], d, parentFolderId, onRowDeleted));
        }
        group.insertBefore(frag, moreBtn);
        shown = end;
        pages.set(d, shown);
        syncMore();
    };
    // After a single row's delete: the count comes from the list, not from
    // the rows on screen, which are only the first page of it.
    async function onRowDeleted(b) {
        const idx = items.indexOf(b);
        if (idx >= 0) {
            items.splice(idx, 1);
            if (idx < shown) shown--;
        }
        if (items.length === 0) {
            pages.delete(d);
            group.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
            group.style.opacity = '0';
            group.style.transform = 'translateX(20px)';
            setTimeout(async () => {
                group.remove();
                await refreshFolderBodyIfOpen(parentFolderId);
            }, 200);
            return;
        }
        pages.set(d, shown);
        countSpan.textContent = `(${items.length})`;
        deleteBtn.title = `Delete all ${items.length} bookmarks under this domain`;
        syncMore();
        // This body is already right, and rebuilding it would cost a whole
        // pass. Header stats, and other copies, still update.
        await refreshFolderBodyIfOpen(parentFolderId, group.closest('.source-folder-card'));
    }

    showRows(Math.max(0, firstRows));
    container.appendChild(group);
    return shown;
}

function buildBookmarkRow(b, d, parentFolderId, onDeleted) {
    const row = document.createElement('div');
    row.className = 'src-tab-row';
    row.draggable = true;
    row.dataset.bookmarkId = b.id;
    row.dataset.parentId = String(parentFolderId);
    row.innerHTML = `
        <img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(d)}&sz=16" width="16" height="16" style="flex-shrink:0;">
        <span title="${escapeHtml(b.url)}" style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(b.title || b.url)}</span>
        <button class="sm-btn bookmark-delete-btn" title="Delete bookmark" style="padding:2px 6px; color: #f87171;">🗑</button>
    `;
    row.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/tp-bookmark-id', String(b.id));
        e.dataTransfer.setData('text/tp-parent-id', String(parentFolderId));
        e.dataTransfer.effectAllowed = 'move';
        row.classList.add('dragging');
        e.stopPropagation();
    });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));

    // Delete individual bookmark click handler
    row.querySelector('.bookmark-delete-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete bookmark "${b.title || b.url}"?`)) return;
        try {
            await removeBookmarksSmart([b.id]);
            row.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
            row.style.opacity = '0';
            row.style.transform = 'translateX(20px)';
            setTimeout(() => {
                row.remove();
                onDeleted(b);
            }, 200);
        } catch (err) {
            alert('Could not delete bookmark: ' + err.message);
        }
    });

    // Middle-click on a bookmark row → open in a new background tab in the current window.
    row.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
    row.addEventListener('auxclick', async (e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        await openBookmarkInCurrentWindow(b.url);
    });

    return row;
}

// The body of an open folder card, built detached: subfolders first as nested
// cards (the remembered-open ones queued on `budget` for the pass's
// restoreQueued), then the loose bookmarks by domain. inImports rides down the
// recursion so the whole archive subtree is locked, not just its root.
async function buildFolderBody(folderId, depth, inImports, budget) {
    const frag = document.createDocumentFragment();
    const note = (text) => {
        frag.replaceChildren();
        const el = document.createElement('div');
        el.className = 'src-empty-state';
        el.textContent = text;
        frag.appendChild(el);
        return frag;
    };

    try {
        // One level is all a body shows; getSubTree would build a view of the
        // folder's entire subtree on every open.
        const children = await Tree.getChildren(folderId);
        const subfolders = children.filter(c => !c.url);
        const looseBookmarks = children.filter(isVisibleBookmark);

        if (subfolders.length === 0 && looseBookmarks.length === 0) {
            return note('This folder is empty.');
        }

        // If this body belongs to the TabPaladin Workflows root, mark each child folder as a workflow.
        const wfRoot = await findWorkflowRootSilent();
        const parentIsWorkflowsRoot = wfRoot && wfRoot.id === folderId;

        // Subfolders first — each as a nested expandable card.
        for (const sf of subfolders) {
            const sfChildren = await Tree.getChildren(sf.id);
            frag.appendChild(buildFolderCard({
                id: sf.id,
                title: sf.title,
                parentId: folderId,
                folderCount: sfChildren.filter(c => !c.url).length,
                fileCount: sfChildren.filter(isVisibleBookmark).length,
                icon: parentIsWorkflowsRoot ? '🛡️' : '📁',
                isWorkflow: parentIsWorkflowsRoot,
                inImports: inImports || sf.title === IMPORTS_ROOT_TITLE
            }, depth + 1, budget));
        }

        // Loose bookmarks grouped by domain.
        appendDomainGroups(frag, looseBookmarks, folderId, budget);
    } catch (e) {
        // Deleted while this was open (another view, a pull): say so instead
        // of leaving a half-built body behind.
        if (!(await TreeStore.getNode(folderId))) return note('Folder no longer exists.');
        console.warn('[TabPaladin] Could not show folder', folderId, e);
        return note('Could not load this folder.');
    }
    return frag;
}

// Helper: walk parent chain to detect cycles for folder drops.
async function isAncestorOf(ancestorId, descendantId) {
    let current = descendantId;
    let safety = 64;
    while (current && safety-- > 0) {
        const arr = await Tree.get(current).catch(() => []);
        const node = arr && arr[0];
        if (!node) return false;
        const parent = node.parentId;
        if (!parent || parent === '0') return false;
        if (parent === ancestorId) return true;
        current = parent;
    }
    return false;
}

function folderCardsFor(folderId) {
    return document.querySelectorAll(`.source-folder-card[data-id="${CSS.escape(String(folderId))}"]`);
}

// Header stats of every card showing this folder, open or closed.
async function updateFolderCardStats(folderId) {
    const cards = folderCardsFor(folderId);
    if (!cards.length) return;
    let children;
    try {
        children = await Tree.getChildren(folderId);
    } catch (e) { return; /* folder gone — fine */ }
    const text = folderStatsText(children.filter(c => !c.url).length, children.filter(isVisibleBookmark).length);
    for (const card of cards) {
        const statsEl = card.querySelector(':scope > .source-folder-header .folder-stats');
        if (statsEl) statsEl.textContent = text;
    }
}

// A card in a view that is not on screen (the main view while Organize
// shows, say). Every way of showing a view again rebuilds it, so rebuilding
// its cards meanwhile is wasted work.
function inHiddenView(el) {
    const view = el.closest('section');
    return !!view && view.style.display === 'none';
}

// Surgical refresh: re-render only the open bodies of the given folder(s)'
// cards in the view on screen. Used after a drop so expanded siblings remain
// expanded — and each rebuilt body reopens its own remembered-open
// subfolders. One restore budget covers the whole call, and a card inside
// another one being rebuilt is left to that rebuild rather than built twice.
// `except` is a card the caller has already brought up to date.
async function refreshFolderBodyIfOpen(folderIds, except = null) {
    const ids = [...new Set([].concat(folderIds).filter(Boolean))];
    const open = [];
    for (const id of ids) {
        await updateFolderCardStats(id);
        for (const card of folderCardsFor(id)) {
            if (card !== except && card.dataset.open === '1' && !inHiddenView(card)) open.push(card);
        }
    }
    const outermost = open.filter(card => !open.some(o => o !== card && o.contains(card)));
    const budget = newRestoreBudget();
    for (const card of outermost) await cardControls.get(card)?.refresh(budget);
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
    document.getElementById('notes-container').style.display = 'none';
    document.getElementById('workflows-container').style.display = 'block';

    await loadWorkflows(); // Ensure workflows are refreshed
});

document.getElementById('groupTabsBtn').addEventListener('click', async () => {
    // Switch Views
    document.getElementById('organizer-source-container').style.display = 'none';
    document.getElementById('organizer-container').style.display = 'none';
    document.getElementById('settings-container').style.display = 'none';
    document.getElementById('workflows-container').style.display = 'none';
    document.getElementById('notes-container').style.display = 'none';
    document.getElementById('groups-container').style.display = 'block';

    await loadCurrentTabs();
});

// --- Notes Logic ---
let currentNotes = [];
let activeNoteId = null;

async function loadNotes() {
    currentNotes = await NotesManager.listNotes();
    renderNotesList(document.getElementById('notesSearchInput').value.trim());
}

function renderNotesList(filter = '') {
    const list = document.getElementById('notes-list');
    list.innerHTML = '';
    const q = filter.toLowerCase();
    const shown = currentNotes.filter(n =>
        !q || n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q));

    if (shown.length === 0) {
        list.innerHTML = '<li class="empty-state">No notes yet.</li>';
        return;
    }

    // Grouped by notebook, because a flat list of every note across every
    // notebook is only browsable while you have very few. Notes filed directly
    // in the root have no notebook and lead, since they belong to no group.
    const groups = new Map();
    for (const note of shown) {
        const key = note.notebook || '';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(note);
    }
    const names = [...groups.keys()].sort((a, b) => {
        if (a === '') return -1;
        if (b === '') return 1;
        return a.localeCompare(b);
    });

    const renderNote = (note) => {
        const li = document.createElement('li');
        li.className = 'note-list-item';
        const snippet = note.content.replace(/\s+/g, ' ').trim().slice(0, 80);
        // The notebook name is the heading now, so repeating it on every card
        // would just be noise.
        li.innerHTML = `
            <div class="note-item-title">${escapeHtml(note.title)}</div>
            ${snippet ? `<div class="note-item-snippet">${escapeHtml(snippet)}</div>` : ''}
        `;
        li.addEventListener('click', () => openNoteInEditor(note));
        return li;
    };

    for (const name of names) {
        const notes = groups.get(name);
        // With everything in one notebook, a single heading says nothing.
        if (names.length > 1) {
            const head = document.createElement('li');
            head.className = 'note-group-head';
            head.innerHTML =
                `<span>${escapeHtml(name || 'Ungrouped')}</span><span class="note-group-count">${notes.length}</span>`;
            list.appendChild(head);
        }
        for (const note of notes) list.appendChild(renderNote(note));
    }
}

// readMode=false for a brand new note: there is nothing to read yet, and you
// came here to type.
async function openNoteInEditor(note, readMode = true) {
    activeNoteId = note.id || null;
    document.getElementById('noteTitleInput').value = note.title || '';
    document.getElementById('noteContentInput').value = note.content || '';
    document.getElementById('note-editor').style.display = 'block';
    document.getElementById('notes-list').style.display = 'none';
    document.getElementById('notesSearchInput').style.display = 'none';
    // Opens as a reading page, not a textarea. Most of the time you are here to
    // read the note or tick something off, and checkboxes only render in the
    // preview — landing in raw markdown made the note look like it had no
    // working tasks at all. "Edit" is one click away.
    if (readMode) {
        await renderNotePreview();
        setNotePreviewMode(true);
    } else {
        setNotePreviewMode(false);
    }
}

function closeNoteEditor() {
    activeNoteId = null;
    document.getElementById('note-editor').style.display = 'none';
    document.getElementById('notes-list').style.display = 'block';
    document.getElementById('notesSearchInput').style.display = 'block';
}

function setNotePreviewMode(previewOn) {
    document.getElementById('noteContentInput').style.display = previewOn ? 'none' : 'block';
    document.getElementById('notePreview').style.display = previewOn ? 'block' : 'none';
    document.getElementById('previewNoteBtn').textContent = previewOn ? 'Edit' : 'Preview';
}

// Inline markup shared by every line: [[wiki-links]] become clickable chips
// and bare URLs become links. Takes already-escaped text.
function renderNoteInlineHtml(escaped) {
    let html = escaped.replace(/\[\[([^\[\]]+)\]\]/g, (m, t) =>
        `<span class="note-wikilink" data-target="${t.trim()}">[[${t.trim()}]]</span>`);
    html = html.replace(/(https?:\/\/[^\s<)&]+)/g,
        `<a href="$1" class="note-urllink" title="Open in new tab">$1</a>`);
    return html;
}

// Inline markdown: **bold**, *italic*, `code`. Applied after escaping, so the
// patterns only ever see safe text.
function renderNoteEmphasis(html) {
    return html
        .replace(/`([^`]+)`/g, '<code class="note-code">$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
}

// Render note content as HTML.
//
// Tasks become real checkboxes carrying their source line number, so toggling
// one edits exactly that line of the stored markdown. Headings, bullets and
// emphasis render too — previously everything except tasks and links came out
// as escaped text, so a note full of "## Meat" and "- 260 g soy sauce" read as
// raw markdown with only the checkboxes working.
//
// `skipTitle` drops a leading "# Heading" that just repeats the note's title,
// which is otherwise shown twice: once in the title field, once at the top of
// the body.
function renderNoteContentHtml(content, skipTitle = '') {
    const lines = String(content == null ? '' : content).split('\n');
    const out = [];
    let inList = false;
    let titleDropped = false;

    const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };

    lines.forEach((raw, i) => {
        const task = NotesManager.parseTaskLine(raw);
        if (task) {
            closeList();
            const label = renderNoteEmphasis(renderNoteInlineHtml(escapeHtml(task.label)));
            out.push(
                `<label class="note-task"${task.indent ? ` style="margin-left:${task.indent * 14}px;"` : ''}>` +
                `<input type="checkbox" class="note-task-box" data-line="${i}"${task.checked ? ' checked' : ''}>` +
                `<span class="note-task-label${task.checked ? ' done' : ''}">${label}</span>` +
                `</label>`
            );
            return;
        }

        const heading = raw.match(/^(#{1,4})\s+(.*)$/);
        if (heading) {
            closeList();
            const text = heading[2].trim();
            // A leading H1 echoing the title is noise, not content.
            if (!titleDropped && heading[1].length === 1 && skipTitle
                && text.toLowerCase() === skipTitle.toLowerCase()) {
                titleDropped = true;
                return;
            }
            const level = Math.min(heading[1].length + 1, 5); // h1 -> h2, so page structure stays sane
            out.push(`<h${level} class="note-h">${renderNoteEmphasis(renderNoteInlineHtml(escapeHtml(text)))}</h${level}>`);
            return;
        }

        const bullet = raw.match(/^(\s*)[-*]\s+(.*)$/);
        if (bullet) {
            if (!inList) { out.push('<ul class="note-list">'); inList = true; }
            out.push(`<li>${renderNoteEmphasis(renderNoteInlineHtml(escapeHtml(bullet[2])))}</li>`);
            return;
        }

        closeList();
        if (raw.trim() === '') { out.push('<div class="note-gap"></div>'); return; }
        out.push(`<p class="note-p">${renderNoteEmphasis(renderNoteInlineHtml(escapeHtml(raw)))}</p>`);
    });

    closeList();
    return out.join('');
}

async function renderNotePreview() {
    const preview = document.getElementById('notePreview');
    const title = document.getElementById('noteTitleInput').value.trim();
    const content = document.getElementById('noteContentInput').value;

    let html = `<div class="note-preview-body">${renderNoteContentHtml(content, title) || '<span style="color:var(--text-muted);">Empty note.</span>'}</div>`;

    if (title) {
        const backlinks = await NotesManager.getBacklinks(title, activeNoteId);
        if (backlinks.length > 0) {
            const items = backlinks.map(n =>
                `<span class="note-wikilink note-backlink" data-target="${escapeHtml(n.title)}">${escapeHtml(n.title)}</span>`
            ).join(' ');
            html += `<div class="note-backlinks"><span style="color:var(--text-muted);">Linked from:</span> ${items}</div>`;
        }
    }
    preview.innerHTML = html;
}

document.getElementById('viewNotesBtn').addEventListener('click', async () => {
    // Switch Views
    document.getElementById('organizer-source-container').style.display = 'none';
    document.getElementById('organizer-container').style.display = 'none';
    document.getElementById('settings-container').style.display = 'none';
    document.getElementById('groups-container').style.display = 'none';
    document.getElementById('workflows-container').style.display = 'none';
    document.getElementById('notes-container').style.display = 'block';
    closeNoteEditor();

    await loadNotes();
});

document.getElementById('notesSearchInput').addEventListener('input', (e) => {
    renderNotesList(e.target.value.trim());
});

document.getElementById('newNoteBtn').addEventListener('click', () => {
    openNoteInEditor({ id: null, title: '', content: '' }, false);
    document.getElementById('noteTitleInput').focus();
});

document.getElementById('saveNoteBtn').addEventListener('click', async () => {
    const title = document.getElementById('noteTitleInput').value.trim() || 'Untitled';
    const content = document.getElementById('noteContentInput').value;
    try {
        if (activeNoteId) {
            await NotesManager.updateNote(activeNoteId, { title, content });
        } else {
            const created = await NotesManager.createNote(title, content);
            activeNoteId = created.id;
        }
        await loadNotes();
        if (document.getElementById('notePreview').style.display === 'block') {
            await renderNotePreview();
        }
    } catch (err) {
        console.error('Save note error:', err);
        alert('Error saving note: ' + err.message);
    }
});

document.getElementById('deleteNoteBtn').addEventListener('click', async () => {
    if (!activeNoteId) { closeNoteEditor(); return; }
    const title = document.getElementById('noteTitleInput').value.trim() || 'Untitled';
    if (!confirm(`Delete note "${title}"?`)) return;
    try {
        await NotesManager.deleteNote(activeNoteId);
        closeNoteEditor();
        await loadNotes();
    } catch (err) {
        console.error('Delete note error:', err);
        alert('Error deleting note: ' + err.message);
    }
});

document.getElementById('previewNoteBtn').addEventListener('click', async () => {
    const turningOn = document.getElementById('notePreview').style.display !== 'block';
    if (turningOn) await renderNotePreview();
    setNotePreviewMode(turningOn);
});

document.getElementById('closeNoteEditorBtn').addEventListener('click', async () => {
    closeNoteEditor();
    await loadNotes();
});

// Clicks inside the preview: task checkboxes toggle, wiki-links navigate
// between notes, URLs open tabs.
document.getElementById('notePreview').addEventListener('click', async (e) => {
    const box = e.target.closest('.note-task-box');
    if (box) {
        const textarea = document.getElementById('noteContentInput');
        const updated = NotesManager.toggleTaskAtLine(textarea.value, Number(box.dataset.line));
        if (updated === textarea.value) return;
        textarea.value = updated;
        try {
            // A note that hasn't been saved yet just updates in place; the
            // user's Save writes it. An existing note persists immediately,
            // the way ticking a box in a notes app should behave.
            if (activeNoteId) {
                await NotesManager.updateNote(activeNoteId, { content: updated });
                await loadNotes();
            }
            await renderNotePreview();
        } catch (err) {
            console.error('Toggle task error:', err);
            alert('Error updating task: ' + err.message);
        }
        return;
    }

    const urlLink = e.target.closest('.note-urllink');
    if (urlLink) {
        e.preventDefault();
        await chrome.tabs.create({ url: urlLink.getAttribute('href') });
        return;
    }
    const wiki = e.target.closest('.note-wikilink');
    if (!wiki) return;
    // dataset.target is entity-decoded by the HTML parser, so it holds the raw title.
    const target = wiki.dataset.target;
    const note = currentNotes.find(n => n.title === target);
    if (note) {
        openNoteInEditor(note);
        await renderNotePreview();
        setNotePreviewMode(true);
    } else if (confirm(`Note "${target}" doesn't exist. Create it?`)) {
        openNoteInEditor({ id: null, title: target, content: '' });
    }
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
        document.getElementById('notes-container').style.display = 'none';
    } catch (err) {
        console.error("Organize Bookmarks Error:", err);
        alert("Error opening organizer: " + err.message);
    }
});

document.getElementById('cancelSourceBtn').addEventListener('click', () => {
    document.getElementById('organizer-source-container').style.display = 'none';
    document.getElementById('groups-container').style.display = 'block';
    document.getElementById('source-list').className = ''; // Reset class just in case
    // Folders opened or closed in Organize share their state with the main
    // view; bring its columns in line instead of showing them as they were.
    if (isMainViewVisible()) renderMainView({ regroup: false });
});
// The app page's wordmark (app.js goHome) is the other way back.
window.addEventListener('tabpaladin:home-refresh', () => {
    if (isMainViewVisible()) renderMainView({ regroup: false });
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
    // Kept as it was (with its selected cards) unless the tree changed while
    // it was hidden, e.g. a Split started from the main view.
    if (sourceGridStale) {
        if (currentNavStack.length === 0) currentNavStack = [{ id: VIRTUAL_ROOT_ID, title: 'Sources' }];
        renderSourceGrid(currentNavStack[currentNavStack.length - 1].id);
    }
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
    // The main view was hidden while the tree changed under it (refreshes
    // skip hidden views), so rebuild it like every other way back does.
    if (isMainViewVisible()) await renderMainView({ regroup: false });
});

async function applyTabModeGroups(approvedGroups) {
    // 1. Create bookmarks for each group at the chosen destination
    for (const group of approvedGroups) {
        let folderId = group.targetId;

        if (group.newSubfolder && group.newSubfolder.trim() !== '') {
            try {
                const siblings = await Tree.getChildren(folderId);
                const existing = siblings.find(s => !s.url && s.title.toLowerCase() === group.newSubfolder.toLowerCase());
                if (existing) {
                    folderId = existing.id;
                } else {
                    const created = await Tree.create({
                        parentId: folderId,
                        title: group.newSubfolder
                    });
                    folderId = created.id;
                }
            } catch (e) { console.error("Error creating subfolder", e); }
        }

        for (const item of group.items) {
            await Tree.create({
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
    document.getElementById('notes-container').style.display = 'none';

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
                <button class="sm-btn" id="addTargetBtn" title="Add an existing browser folder to your targets">＋ Add target</button>
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
                    <input type="password" id="gemini-api-key" value="${escapeHtml(settings.geminiApiKey || '')}" placeholder="Paste API Key..." style="width:100%; padding:8px; background:#111827; border:1px solid #374151; color:white; border-radius:4px;">
                    <div style="font-size:0.75rem; color:#666; margin-top:6px;">
                        Keys are stored locally. <a href="#" style="color:#3b82f6;">Get Free Key</a>
                    </div>
                </div>
            </div>

            <!-- 4. Backend Sync -->
            <h3 style="font-size:0.9rem; color:#aaa; margin-bottom:10px; margin-top:20px; text-transform:uppercase; letter-spacing:0.5px;">Backend Sync</h3>
            <div style="background:var(--card-bg); padding:15px; border-radius:8px; border:1px solid var(--border-color);">
                <!-- The token is a session issued by signing in; it stays a
                     hidden input so the push/pull/test code reads it as before. -->
                <div style="font-size:0.85rem; margin-bottom:5px; color:#ccc;">Server address</div>
                <input type="url" id="backend-url" value="${escapeHtml(resolveServerUrl(settings.backend && settings.backend.url))}" placeholder="https://bookmarks.example.com" style="width:100%; padding:8px; background:#111827; border:1px solid #374151; color:white; border-radius:4px; margin-bottom:10px;">
                <input type="hidden" id="backend-token" value="${escapeHtml((settings.backend && settings.backend.token) || '')}">

                <div id="backend-signed-in" style="display:${(settings.backend && settings.backend.token) ? 'block' : 'none'}; margin-bottom:10px;">
                    <div style="font-size:0.85rem; color:#ccc;">Signed in as <strong>${(settings.backend && settings.backend.username) || 'unknown'}</strong></div>
                    <button id="backend-signout-btn" class="sm-btn" style="margin-top:8px; width:100%;">Sign out</button>
                </div>

                <div id="backend-signed-out" style="display:${(settings.backend && settings.backend.token) ? 'none' : 'block'}; margin-bottom:10px;">
                    <div style="font-size:0.85rem; margin-bottom:5px; color:#ccc;">Username</div>
                    <input type="text" id="backend-username" autocomplete="username" value="${(settings.backend && settings.backend.username) || ''}" style="width:100%; padding:8px; background:#111827; border:1px solid #374151; color:white; border-radius:4px; margin-bottom:8px;">
                    <div style="font-size:0.85rem; margin-bottom:5px; color:#ccc;">Password</div>
                    <input type="password" id="backend-password" autocomplete="current-password" style="width:100%; padding:8px; background:#111827; border:1px solid #374151; color:white; border-radius:4px; margin-bottom:8px;">
                    <div id="backend-auth-error" style="font-size:0.75rem; color:var(--danger-color); min-height:14px; margin-bottom:6px;"></div>
                    <button id="backend-signin-btn" class="primary-btn" style="width:100%;">Sign in</button>
                </div>
                <div style="display:flex; gap:8px; margin-top:10px;">
                    <button id="backend-test-btn" class="sm-btn" style="flex:1;">⚡ Test</button>
                    <button id="backend-push-btn" class="sm-btn" style="flex:1; background:rgba(59,130,246,0.2); border:1px solid var(--primary-color);">⬆ Push</button>
                    <button id="backend-pull-btn" class="sm-btn" style="flex:1; background:rgba(245,158,11,0.2); border:1px solid var(--warning-color);">⬇ Pull</button>
                </div>
                <div id="backend-status" style="font-size:0.75rem; color:var(--text-muted); margin-top:8px; min-height:14px;">
                    ${settings.backend && settings.backend.lastSyncAt ? 'Last sync: ' + new Date(settings.backend.lastSyncAt).toLocaleString() : ''}
                </div>
                <div style="font-size:0.7rem; color:#666; margin-top:6px;">
                    Your bookmarks live on the server and in this local working copy — the browser's own
                    bookmarks are not touched. Push uploads your local edits; Pull replaces the working copy
                    with the server's tree. A push is refused if another device pushed since your last pull.
                </div>
                <button id="browser-import-btn" class="sm-btn" style="width:100%; margin-top:10px;"
                        title="Copy this browser's own bookmarks into the tree as a new top-level folder (one-time)">
                    📚 Import this browser's bookmarks
                </button>
            </div>

            <!-- Browsing extras -->
            <h3 style="font-size:0.9rem; color:#aaa; margin-bottom:10px; margin-top:20px; text-transform:uppercase; letter-spacing:0.5px;">Video</h3>
            <div style="background:var(--card-bg); padding:15px; border-radius:8px; border:1px solid var(--border-color);">
                <label style="display:flex; align-items:center; cursor:pointer;">
                    <input type="checkbox" id="video-seek-toggle" ${settings.videoSeek ? 'checked' : ''} style="margin-right:10px; transform:scale(1.2);">
                    <span style="font-weight:bold;">Scroll to seek in fullscreen videos</span>
                </label>
                <div style="font-size:0.75rem; color:#666; margin-top:6px;">
                    Scroll the mouse wheel over a fullscreen video to skip forward or back. Needs access to all sites, which the browser asks for when you switch it on.
                </div>
            </div>

            <!-- 5. Imports -->
            <h3 style="font-size:0.9rem; color:#aaa; margin-bottom:10px; margin-top:20px; text-transform:uppercase; letter-spacing:0.5px;">Imports</h3>
            <div style="background:var(--card-bg); padding:15px; border-radius:8px; border:1px solid var(--border-color);">
                <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:10px;">
                    Reddit only ever lists your most recent 1000 saved posts. The server sweeps the list on a schedule and keeps everything it has seen, so the archive outgrows that cap.
                </div>

                <div id="imports-list" style="font-size:0.8rem; color:var(--text-muted);">Loading…</div>

                <button id="imports-add-btn" class="sm-btn" style="width:100%; margin-top:10px;">+ Connect Reddit</button>

                <div id="imports-form" style="display:none; margin-top:12px; border-top:1px solid var(--border-color); padding-top:12px;">
                    <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:6px;">
                        Create a <strong>web app</strong> at <code style="color:#93c5fd;">reddit.com/prefs/apps</code> with this exact redirect URI:
                    </div>
                    <code id="imports-redirect" style="display:block; padding:6px 8px; background:#111827; border-radius:4px; font-size:0.7rem; color:#93c5fd; word-break:break-all; margin-bottom:10px; user-select:all;"></code>

                    <div style="font-size:0.85rem; margin-bottom:5px; color:#ccc;">Client ID</div>
                    <input type="text" id="imports-client-id" autocapitalize="none" spellcheck="false" placeholder="the short string under the app name" style="width:100%; padding:8px; background:#111827; border:1px solid #374151; color:white; border-radius:4px; margin-bottom:8px;">

                    <div style="font-size:0.85rem; margin-bottom:5px; color:#ccc;">Client secret</div>
                    <input type="password" id="imports-client-secret" autocapitalize="none" spellcheck="false" style="width:100%; padding:8px; background:#111827; border:1px solid #374151; color:white; border-radius:4px; margin-bottom:8px;">

                    <div style="font-size:0.85rem; margin-bottom:5px; color:#ccc;">Sweep every (minutes)</div>
                    <input type="number" id="imports-interval" min="5" step="5" value="60" style="width:100%; padding:8px; background:#111827; border:1px solid #374151; color:white; border-radius:4px; margin-bottom:8px;">

                    <div id="imports-error" style="font-size:0.75rem; color:var(--danger-color); min-height:14px; margin-bottom:6px;"></div>
                    <button id="imports-submit-btn" class="primary-btn" style="width:100%;">Create &amp; authorise</button>
                </div>

                <div id="imports-status" style="font-size:0.75rem; color:var(--text-muted); margin-top:8px; min-height:14px;"></div>
                <div style="font-size:0.7rem; color:#666; margin-top:6px;">
                    Imported links arrive as bookmarks in <strong>TabPaladin Imports</strong>. Sweeping happens on the server whether or not this panel is open — press <strong>Pull</strong> above to bring new ones into this browser.
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

    // Build the list of "top-level" entries shown in the grid.
    // Only show focused folders + the TabPaladin Workflows root, so browsers like Vivaldi
    // don't drown the list with extras (Trash, Pinboard, Imported bookmarks, etc.).
    // To add a NEW folder to your targets: use the "+ Add target" button.
    const wfRoot = await findWorkflowRootSilent();
    const allTopLevel = folders || [];

    function computeDisplayed() {
        let list = allTopLevel.filter(f => mutableFocused.has(f.id));
        if (mutableFocused.size === 0) {
            const STANDARD_TITLES = new Set([
                'Bookmarks bar', 'Bookmarks Bar', 'Bookmarks Toolbar', 'Bookmarks toolbar',
                'Other bookmarks', 'Other Bookmarks',
                'Mobile bookmarks', 'Mobile Bookmarks', 'Mobile'
            ]);
            list = allTopLevel.filter(f => STANDARD_TITLES.has(f.title));
            if (list.length === 0) list = [...allTopLevel];
        }
        if (wfRoot && !list.find(f => f.id === wfRoot.id)) {
            list.push({ id: wfRoot.id, title: wfRoot.title, isWorkflow: true });
        }
        return list;
    }

    function renderFolderGrid() {
        grid.innerHTML = '';
        const displayedFolders = computeDisplayed();
        if (displayedFolders.length === 0) return;
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
            card.innerHTML = `
                <div class="icon" style="margin:0; width:auto;">${icon}</div>
                <div style="flex:1; width:auto; overflow:hidden; min-width:0;">
                    <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(folder.title)}</div>
                </div>
                <button class="sm-btn folder-export-btn" title="Export this folder + contents as JSON" data-id="${folder.id}" style="padding:4px 8px; flex-shrink:0;">📤</button>
                <div class="checkbox-indicator" style="font-size:1.2rem; width:auto; flex-shrink:0; color:${isChecked ? '#10b981' : 'transparent'};">✓</div>
            `;

            card.addEventListener('click', (e) => {
                if (e.target.closest('.folder-export-btn')) return;
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

            grid.appendChild(card);
        });
    }

    renderFolderGrid();

    // "+ Add target" — pick an existing browser folder and add it to focused targets.
    document.getElementById('addTargetBtn').addEventListener('click', () => {
        const unfocused = allTopLevel.filter(f => !mutableFocused.has(f.id));
        if (unfocused.length === 0) {
            alert('All top-level browser folders are already in your targets.');
            return;
        }
        const labels = unfocused.map((f, i) => `${i + 1}. ${f.title}`).join('\n');
        const choice = prompt(`Pick a folder to add as a target:\n\n${labels}\n\nEnter the number:`);
        if (!choice) return;
        const idx = parseInt(choice.trim()) - 1;
        if (isNaN(idx) || idx < 0 || idx >= unfocused.length) {
            alert('Invalid choice.');
            return;
        }
        mutableFocused.add(unfocused[idx].id);
        renderFolderGrid();
    });

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
                const nodes = await Tree.get(id);
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

    // Applied immediately rather than on Save: switching it on has to ask for
    // the all-sites permission, and that prompt only works during the click.
    document.getElementById('video-seek-toggle').addEventListener('change', async (e) => {
        const box = e.target;
        let on = box.checked;
        // Firefox's chrome.* is callback-style; browser.* returns promises.
        const perms = (globalThis.browser || chrome).permissions;
        try {
            if (on) {
                on = await perms.request({ origins: ['<all_urls>'] });
            } else {
                await perms.remove({ origins: ['<all_urls>'] }).catch(() => {});
            }
        } catch (err) {
            on = false;
            alert('Could not enable video seek: ' + err.message);
        }
        box.checked = on;
        const current = await StorageManager.getSettings();
        await StorageManager.saveSettings({ ...current, videoSeek: on });
    });

    // Backend sync buttons
    const backendStatus = document.getElementById('backend-status');
    const getBackendConfig = () => ({
        url: resolveServerUrl(document.getElementById('backend-url').value),
        token: document.getElementById('backend-token').value.trim()
    });
    const writeBackendStatus = (msg) => { backendStatus.textContent = msg; };
    const persistBackendConfig = async (extras = {}) => {
        const cfg = getBackendConfig();
        const current = await StorageManager.getSettings();
        const updated = { ...current, backend: { ...(current.backend || {}), ...cfg, ...extras } };
        await StorageManager.saveSettings(updated);
    };

    // --- Sign in / out ---
    const authError = (msg) => {
        const el = document.getElementById('backend-auth-error');
        if (el) el.textContent = msg || '';
    };
    const setSignedInUi = (signedIn, username) => {
        const inEl = document.getElementById('backend-signed-in');
        const outEl = document.getElementById('backend-signed-out');
        if (inEl) inEl.style.display = signedIn ? 'block' : 'none';
        if (outEl) outEl.style.display = signedIn ? 'none' : 'block';
        const strong = inEl && inEl.querySelector('strong');
        if (signedIn && strong && username) strong.textContent = username;
    };

    const doSignIn = async () => {
        const base = getBackendConfig().url;
        const username = (document.getElementById('backend-username')?.value || '').trim();
        const password = document.getElementById('backend-password')?.value || '';
        authError('');
        if (!base) { authError('Enter your server address first.'); return; }
        if (!username || !password) { authError('Username and password are both required.'); return; }

        // Ask first whether an account exists: accounts are created on the
        // server from its .env, never from here, so an empty server gets
        // directions instead of a confusing "wrong password".
        let hasAccount = true;
        try {
            const s = await fetch(base + '/api/auth/status').then(r => r.json());
            hasAccount = Boolean(s.hasAccount);
        } catch (e) {
            authError(`Can't reach ${base} — is it up?`);
            return;
        }

        if (!hasAccount) {
            authError("This server has no account yet. Set ADMIN_USERNAME and ADMIN_PASSWORD in the server's .env and restart it, then sign in.");
            return;
        }

        try {
            const res = await fetch(base + '/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) { authError(data.error || `Sign in failed (HTTP ${res.status}).`); return; }

            document.getElementById('backend-token').value = data.token;
            const pw = document.getElementById('backend-password');
            if (pw) pw.value = '';
            await persistBackendConfig({ username: data.username || username });
            setSignedInUi(true, data.username || username);
            writeBackendStatus('Signed in.');
        } catch (e) {
            authError('Sign in failed: ' + e.message);
        }
    };

    const doSignOut = async () => {
        const cfg = getBackendConfig();
        // Best effort — the local token is cleared either way, so an unreachable
        // server can't leave you stuck signed in on this machine.
        try {
            await fetch(cfg.url + '/api/logout', {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + cfg.token }
            });
        } catch (e) { /* ignore */ }
        document.getElementById('backend-token').value = '';
        await persistBackendConfig({});
        setSignedInUi(false);
        writeBackendStatus('Signed out.');
    };

    document.getElementById('backend-signin-btn')?.addEventListener('click', doSignIn);
    document.getElementById('backend-signout-btn')?.addEventListener('click', doSignOut);
    document.getElementById('backend-password')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); doSignIn(); }
    });

    document.getElementById('backend-test-btn').addEventListener('click', async () => {
        const cfg = getBackendConfig();
        if (!cfg.url) { alert('Enter a server URL first.'); return; }
        writeBackendStatus('Testing…');
        try {
            const h = await TreeStore.sync.health(cfg);
            writeBackendStatus(h && h.ok ? `Server OK (auth ${h.configured ? 'ready' : 'MISSING'})` : 'Unexpected response');
        } catch (e) {
            writeBackendStatus('Test failed: ' + e.message);
        }
    });

    document.getElementById('backend-push-btn').addEventListener('click', async () => {
        writeBackendStatus(await doPush() || '');
    });

    document.getElementById('backend-pull-btn').addEventListener('click', async () => {
        writeBackendStatus(await doPull() || '');
    });

    document.getElementById('browser-import-btn').addEventListener('click', async () => {
        if (!confirm(
            'Copy this browser\'s own bookmarks into TabPaladin?\n\n' +
            'They land in a new "Imported <date>" top-level folder in your working copy — ' +
            'the browser\'s bookmarks themselves are not changed. Push afterwards to sync them.'
        )) return;
        try {
            const result = await TreeStore.importFromBrowser();
            if (!result.imported) {
                writeBackendStatus('Nothing to import — this browser has no bookmarks.');
                return;
            }
            writeBackendStatus(`Imported ${result.imported} item(s). Push to sync them to the server.`);
            alert(`Imported ${result.imported} item(s) from this browser.`);
        } catch (e) {
            writeBackendStatus('Import failed: ' + e.message);
        }
    });

    // --- Imports ---
    //
    // A second front-end for the server's /api/imports endpoints, sharing the
    // Backend Sync URL and session token above. Nothing importer-specific runs
    // in the browser: the sweep is scheduled server-side and happens whether or
    // not this panel is open, so this only configures sources and kicks off a
    // run by hand.
    const importsStatus = () => document.getElementById('imports-status');
    const writeImportsStatus = (msg) => { const el = importsStatus(); if (el) el.textContent = msg || ''; };

    const importsApi = async (path, opts = {}) => {
        const cfg = getBackendConfig();
        if (!cfg.token) throw new Error('Sign in to the sync server first.');
        const res = await fetch(cfg.url.replace(/\/$/, '') + path, {
            ...opts,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + cfg.token,
                ...(opts.headers || {})
            }
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            // A server that predates the importers has no such route at all,
            // which is worth saying plainly rather than as a bare 404.
            if (res.status === 404 && !/Source not found/.test(body)) {
                throw new Error('This server has no importer support yet — rebuild it (docker compose up -d --build).');
            }
            throw new Error(`${res.status}: ${body.slice(0, 200)}`);
        }
        return res.json();
    };

    const importSubtitle = (src) => {
        if (src.manual) {
            // Nothing polls this one, so a last-run time would be meaningless.
            const gone = src.filed ? ` · ${src.filed} filed away` : '';
            return `Filled by sharing posts to TabPaladin on your phone${gone}`;
        }
        if (!src.connected) return 'Not connected — press Authorise.';
        if (src.lastStatus === 'error') return src.lastError || 'Last sweep failed.';
        if (!src.lastRun) return 'Connected. Waiting for the first sweep.';
        const mins = Math.round((Date.now() - Date.parse(src.lastRun)) / 60000);
        const when = mins < 1 ? 'just now'
            : mins < 60 ? `${mins} min ago`
            : mins < 1440 ? `${Math.round(mins / 60)} h ago`
            : `${Math.round(mins / 1440)} d ago`;
        // Items Reddit no longer lists are the point of the archive, so name
        // them rather than leaving a count that looks like a discrepancy.
        const gone = src.goneFromSource ? ` · ${src.goneFromSource} kept past Reddit's cap` : '';
        return `Swept ${when} · every ${src.intervalMinutes} min${gone}`;
    };

    const renderImports = (sources) => {
        const list = document.getElementById('imports-list');
        if (!list) return;
        if (!sources.length) {
            list.innerHTML = '<div style="color:#666;">No importers yet.</div>';
            return;
        }
        list.innerHTML = sources.map(src => `
            <div data-import-id="${src.id}" style="background:rgba(0,0,0,0.2); border:1px solid var(--border-color); border-radius:6px; padding:10px; margin-bottom:8px;">
                <div style="display:flex; justify-content:space-between; align-items:baseline; gap:8px;">
                    <strong style="color:#ddd;">${escapeHtml(src.label || src.provider)}</strong>
                    <span style="font-size:0.72rem; color:var(--text-muted); white-space:nowrap;">${src.items} saved</span>
                </div>
                <div style="font-size:0.72rem; margin-top:3px; color:${src.lastStatus === 'error' ? 'var(--danger-color)' : 'var(--text-muted)'};">${escapeHtml(importSubtitle(src))}</div>
                <div style="display:flex; gap:6px; margin-top:8px;">
                    ${src.manual ? '' : `<button class="sm-btn" data-import-act="${src.connected ? 'run' : 'auth'}" style="flex:1;">${src.connected ? 'Sweep now' : 'Authorise'}</button>`}
                    ${src.manual ? '' : `<button class="sm-btn" data-import-act="toggle" style="flex:1;">${src.enabled ? 'Pause' : 'Resume'}</button>`}
                    <button class="sm-btn" data-import-act="delete" style="flex:1; color:var(--danger-color);">Remove</button>
                </div>
            </div>
        `).join('');

        list.querySelectorAll('[data-import-act]').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.closest('[data-import-id]').dataset.importId;
                handleImportAction(id, btn.dataset.importAct, btn)
                    .catch(e => writeImportsStatus('Importer error: ' + e.message));
            });
        });
    };

    const refreshImports = async () => {
        const list = document.getElementById('imports-list');
        if (!list) return;
        const cfg = getBackendConfig();
        if (!cfg.token) { list.innerHTML = '<div style="color:#666;">Sign in above to manage importers.</div>'; return; }
        try {
            const data = await importsApi('/api/imports');
            renderImports(data.sources || []);
        } catch (e) {
            list.innerHTML = `<div style="color:#666;">${escapeHtml(e.message)}</div>`;
        }
    };

    const openAuthTab = (url) => {
        const ext = typeof browser !== 'undefined' ? browser : chrome;
        ext.tabs.create({ url });
    };

    async function handleImportAction(id, act, btn) {
        const cfg = getBackendConfig();

        if (act === 'delete') {
            // The archive is the only copy of anything Reddit has already
            // dropped, so removing a connection must not quietly bin it.
            if (!confirm('Remove this importer?\n\nThe archived links stay on the server and the bookmark folder stays where it is.')) return;
            await importsApi('/api/imports/' + id, { method: 'DELETE' });
            writeImportsStatus('Importer removed.');
            await refreshImports();
            return;
        }

        if (act === 'toggle') {
            const list = await importsApi('/api/imports');
            const src = (list.sources || []).find(s => String(s.id) === String(id));
            await importsApi('/api/imports/' + id, {
                method: 'PATCH',
                body: JSON.stringify({ enabled: !(src && src.enabled) })
            });
            await refreshImports();
            return;
        }

        if (act === 'auth') {
            const data = await importsApi('/api/imports/' + id + '/authorize');
            openAuthTab(data.url);
            writeImportsStatus('Approve the app on Reddit, then come back and sweep.');
            return;
        }

        if (act === 'run') {
            const original = btn.textContent;
            btn.disabled = true;
            btn.textContent = 'Sweeping…';
            try {
                const result = await importsApi('/api/imports/' + id + '/run', { method: 'POST' });
                writeImportsStatus(result.added
                    ? `Imported ${result.added} new link${result.added === 1 ? '' : 's'}. Press Pull to bring them into this browser.`
                    : 'Already up to date.');
            } catch (e) {
                writeImportsStatus('Sweep failed: ' + e.message);
            } finally {
                btn.disabled = false;
                btn.textContent = original;
                await refreshImports();
            }
        }
    }

    document.getElementById('imports-add-btn')?.addEventListener('click', () => {
        const form = document.getElementById('imports-form');
        const redirect = document.getElementById('imports-redirect');
        if (redirect) redirect.textContent = getBackendConfig().url.replace(/\/$/, '') + '/api/imports/reddit/callback';
        form.style.display = form.style.display === 'none' ? 'block' : 'none';
    });

    document.getElementById('imports-submit-btn')?.addEventListener('click', async () => {
        const err = document.getElementById('imports-error');
        const clientId = document.getElementById('imports-client-id').value.trim();
        const clientSecret = document.getElementById('imports-client-secret').value.trim();
        const intervalMinutes = Number(document.getElementById('imports-interval').value) || 60;
        err.textContent = '';

        if (!clientId || !clientSecret) { err.textContent = 'Both the client ID and secret are required.'; return; }

        try {
            const created = await importsApi('/api/imports', {
                method: 'POST',
                body: JSON.stringify({ provider: 'reddit', label: 'Reddit saved', clientId, clientSecret, intervalMinutes })
            });
            document.getElementById('imports-client-id').value = '';
            document.getElementById('imports-client-secret').value = '';
            document.getElementById('imports-form').style.display = 'none';
            await refreshImports();
            // Straight into consent — a source with no credentials can do
            // nothing, so stopping here would just be a dead end.
            const auth = await importsApi('/api/imports/' + created.source.id + '/authorize');
            openAuthTab(auth.url);
            writeImportsStatus('Approve the app on Reddit, then come back and sweep.');
        } catch (e) {
            err.textContent = e.message;
        }
    });

    refreshImports();

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
        // Spread `existing` first: this form doesn't own every setting. The
        // resolved workflow/notes root ids live here too, and dropping them
        // unbinds the notes root every time the user saves settings.
        const newSettings = {
            ...existing,
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

});

// --- Push/Pull (shared by the main header buttons and the Settings panel) ---
//
// Git-style: the working copy is edited locally, push uploads it, pull replaces
// it. A push against a server that moved on since the last pull is refused with
// a conflict, so nothing another device pushed can be silently overwritten.
function _updateMainStatus(msg) {
    // #backend-status only exists while the Settings panel is rendered, so it
    // cannot be the only place a sync reports to: clicking Push or Pull from
    // the header wrote into nothing and the buttons looked dead even when the
    // sync had worked. The toast always exists.
    const el = document.getElementById('backend-status');
    if (el) el.textContent = msg;
    tpToast(msg);
}

// Small transient banner, bottom-centre. Deliberately not alert(): a sync runs
// on every push and a modal per sync is its own kind of broken.
function tpToast(msg, ms = 3200) {
    if (!msg) return;
    let el = document.getElementById('tp-toast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'tp-toast';
        el.style.cssText = 'position:fixed; left:50%; bottom:24px; transform:translateX(-50%);'
            + 'background:rgba(17,24,39,0.97); color:#e5e7eb; border:1px solid var(--border-color,#374151);'
            + 'padding:10px 16px; border-radius:10px; font-size:0.85rem; z-index:3000;'
            + 'box-shadow:0 10px 30px rgba(0,0,0,0.5); max-width:80vw; text-align:center;'
            + 'transition:opacity .18s ease;';
        document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(tpToast._t);
    tpToast._t = setTimeout(() => { el.style.opacity = '0'; }, ms);
}

async function getSyncConfig() {
    const settings = await StorageManager.getSettings();
    const cfg = settings.backend || {};
    const url = resolveServerUrl(cfg.url);
    // A token without an address has nowhere to go; treat it as signed out
    // rather than fetching relative paths against the extension's own origin.
    return { url, token: url ? (cfg.token || '') : '' };
}

async function persistSyncStamp(kind) {
    const settings = await StorageManager.getSettings();
    await StorageManager.saveSettings({
        ...settings,
        backend: { ...(settings.backend || {}), lastSyncAt: new Date().toISOString(), lastSyncKind: kind }
    });
}

// Returns a status string for the caller to display.
async function doPush() {
    const cfg = await getSyncConfig();
    if (!cfg.token) {
        alert('Not signed in to the sync server. Open Settings (⚙️) and sign in.');
        return 'Not signed in.';
    }
    // A fresh install has an empty working copy; pushing it (especially with
    // force after the inevitable conflict) would erase the whole tree on the
    // server for every device. Pull is almost always what was meant.
    if (TreeStore.status().isEmpty) {
        if (!confirm('Your local working copy is EMPTY. Pushing it would erase the entire tree on the server.\n\nIf this is a fresh install, press Cancel and Pull instead.\n\nReally push an empty tree?')) {
            return 'Push cancelled — working copy is empty.';
        }
    }
    try {
        const { version } = await TreeStore.sync.push(cfg);
        await persistSyncStamp('push');
        return `Pushed (v${version}).`;
    } catch (e) {
        if (e.status === 409) {
            const takeTheirs = confirm(
                'The server has changes you have not pulled (another device pushed).\n\n' +
                'OK = Pull the server\'s tree now (your unpushed local edits are discarded)\n' +
                'Cancel = Do nothing, so you can look first.\n\n' +
                'To overwrite the server instead, push again after this dialog and confirm the force prompt.'
            );
            if (takeTheirs) return doPull({ skipConfirm: true });
            if (confirm('Force-push YOUR tree and overwrite the server\'s newer version? This discards what the other device pushed.')) {
                const { version } = await TreeStore.sync.push(cfg, { force: true });
                await persistSyncStamp('push');
                return `Force-pushed (v${version}).`;
            }
            return 'Push cancelled — pull first.';
        }
        alert('Push failed: ' + e.message);
        return 'Push failed: ' + e.message;
    }
}

async function doPull({ skipConfirm = false } = {}) {
    const cfg = await getSyncConfig();
    if (!cfg.token) {
        alert('Not signed in to the sync server. Open Settings (⚙️) and sign in.');
        return 'Not signed in.';
    }
    const status = TreeStore.status();
    if (!skipConfirm && status.dirty) {
        if (!confirm('You have local edits that were never pushed. Pulling replaces your working copy with the server\'s tree and discards them.\n\nPull anyway?')) {
            return 'Pull cancelled.';
        }
    }
    try {
        const { version } = await TreeStore.sync.pull(cfg);
        await persistSyncStamp('pull');
        // Count what arrived: a successful pull that returns an empty tree is a
        // completely different problem from a pull that failed, and they are
        // indistinguishable if the message only says "pulled".
        const tree = await Tree.getTree();
        let items = 0;
        const walk = (n) => { items++; (n.children || []).forEach(walk); };
        (tree[0].children || []).forEach(walk);
        // Folders deleted on another device drop out of the open/closed
        // state — but never against an empty pull, where all would look gone.
        if (items > 0) await pruneStaleExpandState({ afterPull: true });
        return items === 0
            ? `Pulled (v${version}) — but the server's tree is EMPTY.`
            : `Pulled ${items} item(s) (v${version}).`;
    } catch (e) {
        alert('Pull failed: ' + e.message);
        return 'Pull failed: ' + e.message;
    }
}

document.getElementById('mainPushBtn').addEventListener('click', async () => {
    _updateMainStatus('Pushing…');
    _updateMainStatus(await doPush());
});

document.getElementById('mainPullBtn').addEventListener('click', async () => {
    _updateMainStatus('Pulling…');
    _updateMainStatus(await doPull());
    await loadWorkflows();
    if (isMainViewVisible()) await renderMainView({ regroup: false });
});

function closeSettings() {
    document.getElementById('settings-container').style.display = 'none';
    document.getElementById('actions').style.display = 'grid';
    document.getElementById('groups-container').style.display = 'block';
    document.getElementById('workflows-container').style.display = 'none';
    document.getElementById('organizer-container').style.display = 'none';
    document.getElementById('organizer-source-container').style.display = 'none';
    document.getElementById('notes-container').style.display = 'none';

    // Reload tabs in case settings changed context logic
    loadCurrentTabs();
}
