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
import { TreeStore } from '../utils/treeStore.js';
import { ExpandState, OPEN_TABS_KEY, tabGroupKey } from '../utils/expandState.js';
import { resolveServerUrl } from '../utils/config.js';
import { parkedDraftsOnlyWith, dropParkedDrafts, parkedDraftsMarkdown, saveLiveDraft } from '../app/notesView.js';
import { downloadBackup } from '../utils/backup.js';

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
    // A Gemini key an earlier version kept is deleted (the built-in AI is gone).
    StorageManager.purgeRetiredSettings().catch(() => {});
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
        // Another page brought a copy in, or edited this one, meanwhile:
        // nothing is missing here.
        if (e.code !== 'account-changed' && e.code !== 'edited-during-pull') startupSyncError = e.message;
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
            const helperData = await api.storage.local.get(['tpHelper', 'settings']);
            let serverOrigin = helperData.tpHelper && helperData.tpHelper.serverOrigin;
            if (!serverOrigin) {
                try { serverOrigin = new URL(helperData.settings && helperData.settings.backend && helperData.settings.backend.url).origin; }
                catch (_) { /* no configured server */ }
            }
            const isServer = (url) => {
                try { return Boolean(serverOrigin) && new URL(url).origin === serverOrigin; }
                catch (_) { return false; }
            };
            const saveable = tabs.filter(t => !t.incognito && t.url && /^https?:|^file:|^ftp:/.test(t.url) && !isServer(t.url));

            if (saveable.length === 0) {
                alert("No saveable tabs in the current window.");
                return;
            }

            const name = prompt("Name this session (e.g. 'Research', 'Private'):");
            if (!name) return;

            // The copy as it was before saving: if it already had unpushed
            // edits, a conflict cannot be resolved by pulling without
            // discarding them, so the workflow stays local instead. And the
            // push goes only to this copy (see pushSavedWorkflow).
            const before = await TreeStore.currentCopy();
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
            // A tab may have navigated while the dialog or disk flush waited.
            const currentTabs = await api.tabs.query({ currentWindow: true });
            const tabIds = saveable.filter(savedTab => currentTabs.some(t => t.id === savedTab.id
                && t.url === savedTab.url && !t.incognito && !isServer(t.url)))
                .map(t => t.id).filter(id => !self || id !== self.id);

            // Fresh tab so the window doesn't close when we remove the rest
            if (!self) await api.tabs.create({});
            await api.tabs.remove(tabIds);

            loadWorkflows();
            const synced = await pushSavedWorkflow(name, saveable, before);
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
    //
    // `before` is the copy as it was before the save. Only that copy is
    // pushed: when another page brought another one in meanwhile, the
    // workflow went with this copy (set aside, see TreeStore) and stays there.
    async function pushSavedWorkflow(name, tabs, before) {
        const cfg = await getSyncConfig();
        if (!cfg.token) return 'Not signed in, so it is only on this computer — sign in and Push.';
        try {
            // Links filed from the phone since the last pull are folded in,
            // not a conflict (see TreeStore.sync.pushFolding).
            const pushed = await TreeStore.sync.pushFolding(cfg, { expect: before });
            await persistSyncStamp('push');
            return (pushed.left ? `Synced to the server. ${pushed.message}` : 'Synced to the server.') + foldedNote(pushed);
        } catch (e) {
            if (e.code === 'account-changed') {
                return 'Kept on this computer, with the working copy it was saved in — another account’s copy came in before it could be pushed.';
            }
            // Never pull over or force a copy that belongs to another account.
            if (e.status === 412) return 'Kept on this computer — this working copy belongs to another account.';
            if (e.status !== 409) return `Kept on this computer — push failed: ${e.message}`;
            // Pulling discards everything unpushed in the copy that was
            // refused: only when that is nothing but this workflow — no
            // unpushed edits before it, and nothing from another page since.
            const onlyThisSave = !before.dirty && e.copy && TreeStore.sameCopy(e.copy, before)
                && e.copy.baseId === before.baseId && e.copy.adopted === before.adopted;
            if (!onlyThisSave) {
                return 'Kept on this computer: the server has newer changes and you have other unpushed edits. Push when ready.';
            }
            try {
                const pulled = await TreeStore.sync.pull(cfg, { expect: e.copy });
                await StorageManager.saveWorkflow(name, tabs);
                await TreeStore.flush();
                await TreeStore.sync.push(cfg, { expect: pulled.copy });
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

// Module-level state for the main view (keyword groups are mutable in-memory; tabs are sourced live).
let mainViewState = {
    tabGroups: [],        // [{ id, name, items: [{tabId, url, title, favIconUrl}] }]
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

    // Build / refresh the keyword groups. On first render or explicit regroup, ask TabGrouper.
    // Otherwise preserve existing groups but drop items whose URLs are now bookmarked
    // and drop items whose tabs are closed.
    if (regroup || mainViewState.tabGroups.length === 0) {
        const s = await StorageManager.getSettings();
        const grouped = TabGrouper.groupSmart(filteredTabs, s.customKeywords || {}, s.categoryOrder || null);
        mainViewState.tabGroups = Object.entries(grouped).map(([name, items], idx) => ({
            id: `g_${idx}_${Date.now()}`,
            name,
            items: items.map(t => ({
                tabId: t.id, url: t.url, title: t.title, favIconUrl: t.favIconUrl
            }))
        }));
    } else {
        const tabIdsOpen = new Set(saveable.map(t => t.id));
        mainViewState.tabGroups = mainViewState.tabGroups
            .map(g => ({
                ...g,
                items: g.items.filter(it =>
                    tabIdsOpen.has(it.tabId) && !mainViewState.bookmarkUrls.has(it.url))
            }))
            .filter(g => g.items.length > 0);
    }

    // Tabs that are currently in some keyword group — Open Tabs root excludes them.
    const claimedTabIds = new Set();
    mainViewState.tabGroups.forEach(g => g.items.forEach(i => claimedTabIds.add(i.tabId)));
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
    grid.appendChild(renderOpenTabsCard(unclaimedTabs, mainViewState.tabGroups));

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

function renderOpenTabsCard(unclaimedTabs, tabGroups) {
    const card = document.createElement('div');
    card.className = 'source-folder-card open-tabs-card';
    card.dataset.id = OPEN_TABS_KEY;

    const totalTabs = unclaimedTabs.length + tabGroups.reduce((n, g) => n + g.items.length, 0);

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
        // 2. Each keyword group as a nested card inside Open Tabs body.
        tabGroups.forEach(g => body.appendChild(renderGroupCard(g)));
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
                    const src = mainViewState.tabGroups.find(g => g.id === sourceGroupId);
                    if (src) {
                        const ids = new Set(items.map(it => it.tabId));
                        src.items = src.items.filter(it => !ids.has(it.tabId));
                    }
                }
                await renderMainView({ regroup: false });
            } else if (payload) {
                const { tabId, sourceGroupId } = JSON.parse(payload);
                if (sourceGroupId) {
                    const g = mainViewState.tabGroups.find(g => g.id === sourceGroupId);
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

// Open Tabs and the keyword groups build their whole body up front (one window's
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
    card.className = 'source-folder-card tab-group-card nested';
    card.dataset.id = group.id;
    card.dataset.groupId = group.id;

    const header = document.createElement('div');
    header.className = 'source-folder-header';
    header.innerHTML = `
        <span class="folder-drag-handle" title="Drag group to a folder to file it" draggable="true">⋮⋮</span>
        <span class="folder-caret">▼</span>
        <span class="folder-icon">🏷️</span>
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
    wireRememberedToggle(card, header, body, tabGroupKey(group.name));

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
                    const src = mainViewState.tabGroups.find(g => g.id === sourceGroupId);
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
                    const src = mainViewState.tabGroups.find(g => g.id === sourceGroupId);
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
        ${isImports ? '' : '<input type="checkbox" class="source-select-check" title="Select for Analyze & Sort">'}
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

    // Split = the keyword organizer on this folder's loose files only.
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

    // Checkbox: select for Analyze & Sort.
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

    // Drop target — accept dragged bookmark, bulk bookmarks, folder, tab, bulk tabs, or a keyword group.
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
                // Keyword group → create subfolder + bookmarks for each item, then close source tabs.
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
                mainViewState.tabGroups = mainViewState.tabGroups.filter(x => x.id !== g.groupId);
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
                        const src = mainViewState.tabGroups.find(g => g.id === sourceGroupId);
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
                // Remove tab from its source keyword group, if any.
                if (t.sourceGroupId) {
                    const src = mainViewState.tabGroups.find(g => g.id === t.sourceGroupId);
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

// Split: the keyword organizer on this folder's loose files only.
async function runSplitOnFolder(folderId, folderTitle) {
    const sourceIds = [`loose-${folderId}`];

    try {
        const proposal = await BookmarkOrganizer.proposeSmartOrganization(sourceIds);
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

// --- Notes ---
// The notes view lives in src/app/notesView.js; app.js starts it. The view
// switchers here only hide #notes-container, the same way they hide every
// other section.

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

// Step 2: Analyze & Propose — the keyword organizer on the selected folders.
document.getElementById('analyzeBtn').addEventListener('click', async () => {
    // FIX: Include split cards in selection!
    const selected = document.querySelectorAll('.source-folder-card.selected');
    // Pass raw values (e.g. 'loose-5' or '5'); proposeSmartOrganization handles the distinction.
    const folderIds = Array.from(selected).map(btn => btn.dataset.value).filter(Boolean);

    if (folderIds.length === 0) {
        alert('Please select at least one folder to organize.');
        return;
    }

    const btn = document.getElementById('analyzeBtn');
    const originalText = btn.textContent;
    btn.textContent = 'Analyzing…';
    btn.disabled = true;

    try {
        const proposal = await BookmarkOrganizer.proposeSmartOrganization(folderIds);
        renderOrganizerProposal(proposal);

    } catch (error) {
        console.error(error);
        alert('Analysis failed: ' + error.message);
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
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

    await BookmarkOrganizer.applyOrganization(approvedGroups);
    alert(`Organized ${approvedGroups.length} groups!`);

    document.getElementById('organizer-container').style.display = 'none';
    document.getElementById('groups-container').style.display = 'block';
    // The main view was hidden while the tree changed under it (refreshes
    // skip hidden views), so rebuild it like every other way back does.
    if (isMainViewVisible()) await renderMainView({ regroup: false });
});

// Proposals from the keyword organizer (Analyze & Sort, Split). Group names,
// folder paths and bookmark titles come from the synced tree, so they are
// escaped wherever they land in markup.
async function renderOrganizerProposal(proposal) {
    const list = document.getElementById('proposals-list');
    const applyBtn = document.getElementById('applyOrganizerBtn');

    // Switch Views
    document.getElementById('groups-container').style.display = 'none';
    document.getElementById('organizer-container').style.display = 'block';

    applyBtn.textContent = 'Apply Changes';
    list.onchange = null;

    list.innerHTML = '';

    if (proposal.groups.length === 0) {
        list.innerHTML = '<p>No suggestions found.</p>';
        applyBtn.style.display = 'none';
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
    datalist.innerHTML = folderMap.map(f => `<option value="${escapeHtml(f.fullPath)}"></option>`).join('');

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
            let domain = '';
            try { domain = new URL(i.url).hostname; } catch (e) { /* no icon */ }
            const faviconUrl = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=16`;
            return `
                <div class="draggable-item" draggable="true" data-group-index="${index}" data-item-index="${itemIndex}" style="display:flex; align-items:center; gap:8px; padding:6px; background:rgba(255,255,255,0.03); margin-bottom:2px; border-radius:4px; cursor:grab;">
                    <img src="${faviconUrl}" width="16" height="16" style="flex-shrink:0; border-radius:3px;"/>
                    <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:0.85rem; color:var(--text-color); opacity:0.9;">${escapeHtml(i.title || i.url || '')}</div>
                </div>
            `;
        }).join('');

        div.innerHTML = `
      <div class="group-header" style="display:flex; flex-direction:column; gap:8px; margin-bottom: 8px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
             <!-- Label -->
            <label style="display:flex; align-items:center; cursor:pointer; font-weight:bold; font-size:1rem; flex:1;">
                <input type="checkbox" checked class="proposal-checkbox" data-index="${index}" style="margin-right:10px; transform:scale(1.1); accent-color: var(--primary-color);">
                ${escapeHtml(group.groupName)}
            </label>
            
            <button class="sm-btn apply-single-btn" data-index="${index}" style="margin-left:8px; background:transparent; border:1px solid #10b981; color:#10b981;">✓ Apply This</button>
        </div>
        
        <!-- Smart Input UI -->
        <div style="position:relative;">
             <div style="font-size:0.7rem; color:#888; margin-bottom:4px; font-weight:600;">DESTINATION</div>
             <div style="display:flex; align-items:center; background:#111827; border:1px solid var(--border-color); border-radius:4px; padding:2px 8px;">
                <span class="status-icon" style="font-size:1.2rem; margin-right:8px; cursor:default;" title="${isNew ? 'New Folder' : 'Existing Folder'}">${initialIcon}</span>
                <input type="text" class="smart-dest-input" list="${datalistId}" value="${escapeHtml(initialValue)}"
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
            await BookmarkOrganizer.applyOrganization([group]);
            proposal.groups.splice(index, 1);
            renderOrganizerProposal(proposal);
        });
    });

    setupDragAndDrop(proposal);

    window.currentRenderedProposal = proposal;
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
            renderOrganizerProposal(proposal);
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
    const videoSeekOn = await StorageManager.getVideoSeek();
    const helperServerPattern = (await api.storage.local.get('tpHelper')).tpHelper?.pattern;

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

            <!-- 3. Backend Sync -->
            <h3 style="font-size:0.9rem; color:#aaa; margin-bottom:10px; margin-top:20px; text-transform:uppercase; letter-spacing:0.5px;">Backend Sync</h3>
            <div style="background:var(--card-bg); padding:15px; border-radius:8px; border:1px solid var(--border-color);">
                <!-- The token is a session issued by signing in; it stays a
                     hidden input so the push/pull/test code reads it as before. -->
                <div style="font-size:0.85rem; margin-bottom:5px; color:#ccc;">Server address</div>
                <input type="url" id="backend-url" value="${escapeHtml(resolveServerUrl(settings.backend && settings.backend.url))}" placeholder="https://bookmarks.example.com" style="width:100%; padding:8px; background:#111827; border:1px solid #374151; color:white; border-radius:4px; margin-bottom:10px;">
                <input type="hidden" id="backend-token" value="${escapeHtml((settings.backend && settings.backend.token) || '')}">

                <div id="backend-signed-in" style="display:${(settings.backend && settings.backend.token) ? 'block' : 'none'}; margin-bottom:10px;">
                    <div style="font-size:0.85rem; color:#ccc;">Signed in as <strong id="backend-username-label">${escapeHtml((settings.backend && settings.backend.username) || 'unknown')}</strong><span id="backend-role-label" style="color:var(--text-muted);">${settings.backend && settings.backend.role ? ' · ' + escapeHtml(settings.backend.role) + (settings.backend.tenancyOwner ? ' · owner' : '') : ''}</span></div>
                    <button id="backend-signout-btn" class="sm-btn" style="margin-top:8px; width:100%;">Sign out</button>
                    <details id="backend-password-box" style="margin-top:8px;">
                        <summary style="cursor:pointer; font-size:0.8rem; color:#93c5fd;">Change password</summary>
                        <input type="password" id="backend-pw-current" autocomplete="current-password" placeholder="Current password" style="width:100%; padding:8px; background:#111827; border:1px solid #374151; color:white; border-radius:4px; margin:8px 0 6px;">
                        <input type="password" id="backend-pw-new" autocomplete="new-password" placeholder="New password (8+ characters)" style="width:100%; padding:8px; background:#111827; border:1px solid #374151; color:white; border-radius:4px; margin-bottom:6px;">
                        <div style="font-size:0.72rem; color:var(--text-muted); margin-bottom:6px;">Signs you out on every other device.</div>
                        <div id="backend-pw-error" style="font-size:0.75rem; color:var(--danger-color); min-height:14px; margin-bottom:6px;"></div>
                        <button id="backend-pw-save" class="sm-btn" style="width:100%;">Change password</button>
                    </details>
                </div>

                <div id="backend-signed-out" style="display:${(settings.backend && settings.backend.token) ? 'none' : 'block'}; margin-bottom:10px;">
                    <div style="font-size:0.85rem; margin-bottom:5px; color:#ccc;">Username</div>
                    <input type="text" id="backend-username" autocomplete="username" value="${escapeHtml((settings.backend && settings.backend.username) || '')}" style="width:100%; padding:8px; background:#111827; border:1px solid #374151; color:white; border-radius:4px; margin-bottom:8px;">
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

            <!-- Backup -->
            <h3 style="font-size:0.9rem; color:#aaa; margin-bottom:10px; margin-top:20px; text-transform:uppercase; letter-spacing:0.5px;">Backup</h3>
            <div style="background:var(--card-bg); padding:15px; border-radius:8px; border:1px solid var(--border-color);">
                <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:10px;">
                    Everything this browser's TabPaladin holds as one file: the working copy with its unpushed edits,
                    set-aside copies, unsaved note drafts and your settings. Your sign-in session is left out.
                </div>
                <button id="backup-download-btn" class="sm-btn" style="width:100%;">📦 Download a backup</button>
                <div id="backup-status" style="font-size:0.75rem; color:var(--text-muted); margin-top:8px; min-height:14px;"></div>
            </div>

            <!-- Working copies of other accounts, kept when you switched -->
            <div id="stash-block" style="display:none;">
                <h3 style="font-size:0.9rem; color:#aaa; margin-bottom:10px; margin-top:20px; text-transform:uppercase; letter-spacing:0.5px;">Set-aside working copies</h3>
                <div style="background:var(--card-bg); padding:15px; border-radius:8px; border:1px solid var(--border-color);">
                    <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:10px;">
                        Kept when this browser signed in as someone else. Nothing here is ever thrown away unless you discard it.
                    </div>
                    <div id="stash-list" style="font-size:0.8rem;"></div>
                    <div id="stash-status" style="font-size:0.75rem; color:var(--text-muted); margin-top:8px; min-height:14px;"></div>
                </div>
            </div>

            <!-- Browsing extras -->
            <h3 style="font-size:0.9rem; color:#aaa; margin-bottom:10px; margin-top:20px; text-transform:uppercase; letter-spacing:0.5px;">Video</h3>
            <div style="background:var(--card-bg); padding:15px; border-radius:8px; border:1px solid var(--border-color);">
                <label style="display:flex; align-items:center; cursor:pointer;">
                    <input type="checkbox" id="video-seek-toggle" ${videoSeekOn ? 'checked' : ''} style="margin-right:10px; transform:scale(1.2);">
                    <span style="font-weight:bold;">Scroll to seek in fullscreen videos</span>
                </label>
                <div style="font-size:0.75rem; color:#666; margin-top:6px;">
                    Scroll the mouse wheel over a fullscreen video to skip forward or back. Needs access to all sites, which the browser asks for when you switch it on.
                </div>
            </div>

            <!-- 4. Imports -->
            <h3 style="font-size:0.9rem; color:#aaa; margin-bottom:10px; margin-top:20px; text-transform:uppercase; letter-spacing:0.5px;">Imports</h3>
            <div style="background:var(--card-bg); padding:15px; border-radius:8px; border:1px solid var(--border-color);">
                <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:10px;">
                    Reddit only ever lists your most recent 1000 saved posts. The server sweeps the list on a schedule and keeps everything it has seen, so the archive outgrows that cap.
                </div>

                <div id="imports-list" style="font-size:0.8rem; color:var(--text-muted);">Loading…</div>
                <label style="display:flex; align-items:center; gap:6px; margin-top:6px; font-size:0.75rem; color:var(--text-muted); cursor:pointer;">
                    <input type="checkbox" id="imports-show-removed"> Show removed sources
                </label>

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

            <!-- Users (admins only; hidden for everyone else) -->
            <div id="users-block" style="display:none;">
                <h3 style="font-size:0.9rem; color:#aaa; margin-bottom:10px; margin-top:20px; text-transform:uppercase; letter-spacing:0.5px;">Users</h3>
                <div style="background:var(--card-bg); padding:15px; border-radius:8px; border:1px solid var(--border-color);">
                    <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:10px;">
                        Every account has its own bookmarks, notes, workflows, inbox and imports. Changes here ask for your password again.
                    </div>
                    <div id="users-list" style="display:grid; grid-template-columns:repeat(auto-fill, minmax(260px, 1fr)); gap:8px;"></div>
                    <button id="users-add-btn" class="sm-btn" style="width:100%; margin-top:10px;">+ Add user</button>
                    <div id="users-add-form" style="display:none; margin-top:12px; border-top:1px solid var(--border-color); padding-top:12px;">
                        <div style="font-size:0.85rem; margin-bottom:5px; color:#ccc;">Username</div>
                        <input type="text" id="users-new-name" autocapitalize="none" spellcheck="false" style="width:100%; padding:8px; background:#111827; border:1px solid #374151; color:white; border-radius:4px; margin-bottom:8px;">
                        <div style="font-size:0.85rem; margin-bottom:5px; color:#ccc;">Password</div>
                        <div style="display:flex; gap:6px; margin-bottom:8px;">
                            <input type="text" id="users-new-password" autocomplete="off" spellcheck="false" style="flex:1; min-width:0; padding:8px; background:#111827; border:1px solid #374151; color:white; border-radius:4px;">
                            <button class="sm-btn" id="users-new-generate">Generate</button>
                        </div>
                        <div style="font-size:0.85rem; margin-bottom:5px; color:#ccc;">Role</div>
                        <select id="users-new-role" style="width:100%; padding:8px; background:#111827; border:1px solid #374151; color:white; border-radius:4px; margin-bottom:8px;">
                            <option value="user" selected>user</option>
                            <option value="admin">admin</option>
                        </select>
                        <div style="font-size:0.85rem; margin-bottom:5px; color:#ccc;">Your password</div>
                        <input type="password" id="users-new-current" autocomplete="current-password" style="width:100%; padding:8px; background:#111827; border:1px solid #374151; color:white; border-radius:4px; margin-bottom:8px;">
                        <div id="users-add-error" style="font-size:0.75rem; color:var(--danger-color); min-height:14px; margin-bottom:6px;"></div>
                        <button id="users-add-submit" class="primary-btn" style="width:100%;">Create</button>
                    </div>
                    <div id="users-status" style="font-size:0.75rem; color:var(--text-muted); margin-top:8px; min-height:14px;"></div>
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
                // Keep the helper's exact server grant when dropping video access.
                // Request it before any await in this click, as Firefox requires.
                if (helperServerPattern && !(await perms.request({ origins: [helperServerPattern] }))) {
                    box.checked = true;
                    alert('Grant access to the configured TabPaladin server before removing video seek access.');
                    return;
                }
                await perms.remove({ origins: ['<all_urls>'] }).catch(() => {});
            }
        } catch (err) {
            on = false;
            alert('Could not enable video seek: ' + err.message);
        }
        box.checked = on;
        await StorageManager.setVideoSeek(on);
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
        const label = document.getElementById('backend-username-label');
        if (signedIn && label && username) label.textContent = username;
        if (!signedIn) setRoleLabel(null);
    };
    const setRoleLabel = (user) => {
        const el = document.getElementById('backend-role-label');
        if (el) el.textContent = user && user.role ? ` · ${user.role}${user.tenancyOwner ? ' · owner' : ''}` : '';
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

            const name = data.username || username;
            const user = data.user || {};
            const serverId = data.serverId || null;
            const account = { url: base, userId: user.id, username: name, serverId, tenancyOwner: Boolean(user.tenancyOwner) };
            const known = user.id !== undefined && user.id !== null;

            // The questions below are about the copy as it is now, not as
            // this page last heard of it (switchAccount decides on it again).
            await TreeStore.currentCopy().catch(() => null);

            // A note left unsaved in Notes goes with the copy it was written
            // in, never into this account's: saved into it first or discarded.
            // Asked before the question below, which then counts that save.
            if (known && TreeStore.wouldSetAside(account) && !(await beforeAccountSwitch(`Signing in as ${name}`))) {
                fetch(base + '/api/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + data.token } }).catch(() => {});
                authError('Sign-in cancelled — nothing changed.');
                return;
            }

            // The working copy here may belong to someone else — on this
            // server, or the same id on another one. It is never pushed into
            // this account and never discarded: it is set aside. A copy made
            // while nobody was signed in becomes this account's. Either way,
            // with unpushed edits in it, say so first — Cancel signs nothing in.
            const st = TreeStore.status();
            const edits = `${st.editCount} unpushed edit${st.editCount === 1 ? '' : 's'}`;
            let question = null;
            if (known && st.dirty && TreeStore.wouldSetAside(account)) {
                const previous = (await StorageManager.getSettings()).backend || {};
                const oldName = st.owner ? (st.owner.username || previous.username || `account #${st.owner.userId}`) : null;
                const where = st.owner && st.owner.url !== base ? ` on ${st.owner.url}` : '';
                // Same id at another address: maybe this server, moved. Only
                // the user knows, so it is set aside and offered back from there.
                const maybeMoved = where && Number(st.owner.userId) === Number(user.id)
                    && !(st.owner.serverId && serverId && st.owner.serverId !== serverId);
                question = `This browser holds ${oldName ? oldName + "'s" : 'an older'} working copy${where} (${edits}).\n\n`
                    + `Signing in as ${name} here sets it aside: it stays in this browser (Settings › Set-aside copies) `
                    + `and comes back when you sign in as ${oldName || "the server's owner"}${where ? ' there' : ''}.`
                    + (maybeMoved ? `\n\nIf ${base} is the same server at a new address, restore it from Set-aside copies once signed in.` : '');
            } else if (known && st.dirty && !st.owner && st.origin === 'local') {
                question = `This browser holds ${edits} made while nobody was signed in.\n\n`
                    + `Signing in as ${name} makes them ${name}'s working copy.`;
            }
            if (question && !confirm(question)) {
                fetch(base + '/api/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + data.token } }).catch(() => {});
                authError('Sign-in cancelled — nothing changed.');
                return;
            }

            document.getElementById('backend-token').value = data.token;
            const pw = document.getElementById('backend-password');
            if (pw) pw.value = '';
            const previousName = ((await StorageManager.getSettings()).backend || {}).username || null;
            await persistBackendConfig({ username: name, userId: known ? user.id : null, role: user.role || null, tenancyOwner: Boolean(user.tenancyOwner), serverId });
            setSignedInUi(true, name);
            setRoleLabel(user);

            let note = 'Signed in.';
            if (known) {
                const switched = await TreeStore.switchAccount({ ...account, previousUsername: previousName });
                if (switched.setAside) note = 'Signed in. The previous working copy is set aside below.';
                if (switched.action === 'restored') note = `Signed in. Your working copy from before is back.`;
                if (switched.action === 'claimed' && !TreeStore.status().isEmpty) note = 'Signed in. What you made while signed out is in your working copy.';
                if (TreeStore.status().isEmpty) {
                    try {
                        // Only into the copy this sign-in made this account's.
                        await TreeStore.sync.pull(getBackendConfig(), { expect: switched.copy });
                        await persistSyncStamp('pull');
                    } catch (e) {
                        note += ` Pull failed: ${e.message}`;
                    }
                }
                // Only now, against this account's copy: pruning before the
                // switch would have dropped the other account's folders.
                await pruneStaleFocusedFolders().catch(() => 0);
                await loadWorkflows();
            }
            writeBackendStatus(note);
            refreshImports();
            refreshUsers();
            renderStashes();
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
        await persistBackendConfig({ role: null, tenancyOwner: false });
        setSignedInUi(false);
        writeBackendStatus('Signed out.');
        refreshUsers();
        renderStashes();
    };

    // Who this session is, fresh from the server each time Settings opens:
    // the role and owner flag shown above, and what the Users card and the
    // set-aside copies go by.
    const refreshWhoAmI = async () => {
        const cfg = getBackendConfig();
        if (!cfg.token) return null;
        try {
            const res = await fetch(cfg.url.replace(/\/$/, '') + '/api/auth/me', { headers: { Authorization: 'Bearer ' + cfg.token } });
            if (!res.ok) return null;
            const me = await res.json();
            const user = me.user;
            if (!user) return null;
            setRoleLabel(user);
            await persistBackendConfig({ userId: user.id, role: user.role, tenancyOwner: Boolean(user.tenancyOwner), serverId: me.serverId || null });
            return user;
        } catch (e) {
            return null;
        }
    };

    document.getElementById('backend-pw-save')?.addEventListener('click', async () => {
        const err = document.getElementById('backend-pw-error');
        const cfg = getBackendConfig();
        const currentPassword = document.getElementById('backend-pw-current').value;
        const newPassword = document.getElementById('backend-pw-new').value;
        err.textContent = '';
        if (!cfg.token) { err.textContent = 'Sign in first.'; return; }
        try {
            const res = await fetch(cfg.url.replace(/\/$/, '') + '/api/auth/password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token },
                body: JSON.stringify({ currentPassword, newPassword })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) { err.textContent = data.error || `HTTP ${res.status}`; return; }
            // Every session was revoked, this one included; the reply carries its replacement.
            document.getElementById('backend-token').value = data.token;
            await persistBackendConfig({});
            document.getElementById('backend-pw-current').value = '';
            document.getElementById('backend-pw-new').value = '';
            document.getElementById('backend-password-box').open = false;
            writeBackendStatus('Password changed. Other devices need to sign in again.');
        } catch (e) {
            err.textContent = e.message;
        }
    });

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
        await beforeSync('push');
        writeBackendStatus(await doPush() || '');
    });

    document.getElementById('backend-pull-btn').addEventListener('click', async () => {
        await beforeSync('pull');
        writeBackendStatus(await doPull() || '');
    });

    document.getElementById('backup-download-btn').addEventListener('click', async () => {
        const status = document.getElementById('backup-status');
        status.textContent = 'Preparing…';
        try {
            const backup = await downloadPageBackup();
            const s = backup.summary;
            status.textContent = `Saved: ${s.workingCopy.items} items, ${s.workingCopy.unpushedEdits} unpushed edit(s), `
                + `${s.setAsideCopies} set-aside cop${s.setAsideCopies === 1 ? 'y' : 'ies'}, ${s.parkedDrafts + s.liveDrafts} note draft(s). No session token.`;
        } catch (e) {
            status.textContent = 'Backup failed: ' + e.message;
        }
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
        list.innerHTML = sources.map(src => src.removed ? `
            <div data-import-id="${src.id}" style="background:rgba(0,0,0,0.12); border:1px dashed var(--border-color); border-radius:6px; padding:10px; margin-bottom:8px; opacity:0.7;">
                <div style="display:flex; justify-content:space-between; align-items:baseline; gap:8px;">
                    <strong style="color:#aaa;">${escapeHtml(src.label || src.provider)}</strong>
                    <span style="font-size:0.72rem; color:var(--text-muted); white-space:nowrap;">${src.items} archived</span>
                </div>
                <div style="font-size:0.72rem; margin-top:3px; color:var(--text-muted);">Removed${src.removedAt ? ' ' + escapeHtml(new Date(src.removedAt).toLocaleDateString()) : ''} — the archive is kept until you delete it.</div>
                <div style="display:flex; gap:6px; margin-top:8px;">
                    <button class="sm-btn" data-import-act="restore" style="flex:1;">Restore</button>
                    <button class="sm-btn" data-import-act="purge" style="flex:1; color:var(--danger-color);">Delete archive…</button>
                </div>
            </div>
        ` : `
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
            const showRemoved = document.getElementById('imports-show-removed')?.checked;
            const data = await importsApi('/api/imports' + (showRemoved ? '?includeRemoved=1' : ''));
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
            if (!confirm('Remove this importer?\n\nThe archived links stay on the server: tick "Show removed sources" to restore it or delete the archive.')) return;
            await importsApi('/api/imports/' + id, { method: 'DELETE' });
            writeImportsStatus('Importer removed. Its archive is kept.');
            await refreshImports();
            return;
        }

        if (act === 'restore') {
            await importsApi('/api/imports/' + id + '/restore', { method: 'POST' });
            writeImportsStatus('Restored. A Reddit source needs authorising again; press Pull to see its archive.');
            await refreshImports();
            return;
        }

        if (act === 'purge') {
            // Unrecoverable: anything past Reddit's window cannot be fetched again.
            const typed = prompt('This deletes the archive for good — anything the source no longer lists cannot come back.\n\nType DELETE to confirm.');
            if (typed !== 'DELETE') return;
            await importsApi('/api/imports/' + id + '?purge=1', { method: 'DELETE' });
            writeImportsStatus('Archive deleted.');
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

    document.getElementById('imports-show-removed')?.addEventListener('change', () => refreshImports());

    // --- Users (admins) ---
    //
    // Account management. The server only answers an admin in a signed-in
    // session, so the card stays hidden for everyone else (a 403) and for the
    // legacy token. Every change asks for your own password again; the server
    // checks it, and refuses outright to delete, demote or reset the server's
    // owner, the last admin, or you.
    const writeUsersStatus = (msg) => { const el = document.getElementById('users-status'); if (el) el.textContent = msg || ''; };

    const adminApi = async (path, opts = {}) => {
        const cfg = getBackendConfig();
        if (!cfg.token) { const e = new Error('Sign in first.'); e.status = 401; throw e; }
        const res = await fetch(cfg.url.replace(/\/$/, '') + path, {
            ...opts,
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token, ...(opts.headers || {}) }
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            const e = new Error(body.error || `HTTP ${res.status}`);
            e.status = res.status;
            e.code = body.code;
            throw e;
        }
        return body;
    };

    // 16 characters, no look-alikes, from the platform CSPRNG.
    const generatePassword = () => {
        const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        return Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
    };
    const fmtN = (n) => Number(n || 0).toLocaleString();
    const statsLine = (st) => [
        `${fmtN(st.bookmarks)} bookmarks`, `${fmtN(st.notes)} notes`, `${fmtN(st.workflows)} workflows`,
        `${fmtN(st.imports + st.removedImports)} imports (${fmtN(st.archived)} archived)`, `${fmtN(st.inbox)} inbox`
    ].join(' · ');
    const pill = (text, color) =>
        `<span style="font-size:0.68rem; padding:1px 7px; border-radius:999px; border:1px solid ${color}; color:${color}; margin-left:4px;">${escapeHtml(text)}</span>`;
    const fieldStyle = 'width:100%; padding:7px; background:#111827; border:1px solid #374151; color:white; border-radius:4px; margin-bottom:6px;';

    let usersCache = [];

    const renderUsers = (users) => {
        const list = document.getElementById('users-list');
        if (!list) return;
        list.innerHTML = users.map(u => {
            const pills = pill(u.role, u.role === 'admin' ? '#93c5fd' : '#9ca3af') + (u.owner ? pill('owner', '#fbbf24') : '');
            let actions;
            if (u.you) {
                actions = '<a href="#" data-user-act="change-password" style="font-size:0.75rem; color:#93c5fd;">Change password</a>';
            } else if (u.owner) {
                actions = '<div style="font-size:0.72rem; color:var(--text-muted);">Server owner: change from the owner\'s own Settings or the server CLI</div>';
            } else {
                actions = `
                    <button class="sm-btn" data-user-act="role" style="flex:1;">${u.role === 'admin' ? 'Make user' : 'Make admin'}</button>
                    <button class="sm-btn" data-user-act="reset" style="flex:1;">Reset password</button>
                    <button class="sm-btn" data-user-act="delete" style="flex:1; color:var(--danger-color);"
                        ${u.legacyToken ? 'disabled title="AUTH_TOKEN acts as this account; remove it from .env first"' : ''}>Delete</button>`;
            }
            return `
                <div data-user-id="${Number(u.id)}" style="background:rgba(0,0,0,0.2); border:1px solid var(--border-color); border-radius:6px; padding:10px; min-width:0;">
                    <div style="display:flex; justify-content:space-between; align-items:baseline; gap:6px; flex-wrap:wrap;">
                        <span><strong style="color:#ddd;">${escapeHtml(u.username)}</strong>${u.you ? ' <span style="color:var(--text-muted); font-size:0.75rem;">(you)</span>' : ''}${pills}</span>
                        <span style="font-size:0.7rem; color:var(--text-muted);">since ${escapeHtml(new Date(u.createdAt).toLocaleDateString())}</span>
                    </div>
                    <div style="font-size:0.72rem; color:var(--text-muted); margin-top:3px;">${escapeHtml(statsLine(u.stats || {}))}</div>
                    <div style="display:flex; gap:6px; margin-top:8px; flex-wrap:wrap;">${actions}</div>
                    <div class="user-action-panel"></div>
                </div>`;
        }).join('');
        list.querySelectorAll('[data-user-act]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const row = btn.closest('[data-user-id]');
                const user = usersCache.find(u => String(u.id) === row.dataset.userId);
                if (user) openUserAction(user, btn.dataset.userAct, row);
            });
        });
    };

    const refreshUsers = async () => {
        const block = document.getElementById('users-block');
        if (!block) return;
        if (!getBackendConfig().token) { block.style.display = 'none'; return; }
        try {
            const data = await adminApi('/api/users');
            usersCache = data.users || [];
            block.style.display = 'block';
            renderUsers(usersCache);
        } catch (e) {
            // Not an admin, the legacy token, or an older server: no card.
            block.style.display = 'none';
        }
    };

    // The inline form under one account's row for a role change, a reset or
    // a delete. Each needs your own password; the server checks it.
    function openUserAction(user, act, row) {
        if (act === 'change-password') {
            const box = document.getElementById('backend-password-box');
            if (box) { box.open = true; box.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
            return;
        }
        const panel = row.querySelector('.user-action-panel');
        const name = escapeHtml(user.username);
        const st = user.stats || {};
        const newRole = user.role === 'admin' ? 'user' : 'admin';
        let body = '';
        if (act === 'role') {
            body = `<div style="font-size:0.78rem; margin-bottom:6px;">Make ${name} ${newRole === 'admin' ? 'an admin' : 'a user'}?</div>`;
        } else if (act === 'reset') {
            body = `
                <div style="display:flex; gap:6px;">
                    <input type="text" class="ua-new" placeholder="New password" autocomplete="off" spellcheck="false" style="${fieldStyle} flex:1; min-width:0;">
                    <button class="sm-btn ua-gen" style="margin-bottom:6px;">Generate</button>
                </div>
                <div style="font-size:0.72rem; color:var(--text-muted); margin-bottom:6px;">${name} will be signed out on every device; unpushed edits on their phone stay on the phone.</div>`;
        } else if (act === 'delete') {
            body = `
                <div style="font-size:0.78rem; margin-bottom:6px; color:#fca5a5;">
                    Delete ${name} and everything they hold: ${fmtN(st.bookmarks)} bookmarks, ${fmtN(st.notes)} notes,
                    ${fmtN(st.workflows)} workflows, ${fmtN(st.inbox)} inbox links,
                    ${fmtN(st.imports + st.removedImports)} import sources with ${fmtN(st.archived)} archived posts (removed sources included)
                    and ${fmtN(st.history)} history versions. A backup is taken first.
                </div>
                <input type="text" class="ua-confirm" placeholder="Type ${name} to confirm" autocapitalize="none" spellcheck="false" style="${fieldStyle}">`;
        }
        panel.innerHTML = `
            <div style="margin-top:8px; border-top:1px solid var(--border-color); padding-top:8px;">
                ${body}
                <input type="password" class="ua-pw" placeholder="Your password" autocomplete="current-password" style="${fieldStyle}">
                <div class="ua-err" style="font-size:0.75rem; color:var(--danger-color); min-height:14px; margin-bottom:6px;"></div>
                <div style="display:flex; gap:6px;">
                    <button class="sm-btn ua-go" style="flex:1; ${act === 'delete' ? 'color:var(--danger-color);' : ''}">${act === 'delete' ? `Delete ${name}` : act === 'reset' ? 'Save' : 'Confirm'}</button>
                    <button class="sm-btn ua-cancel" style="flex:1;">Cancel</button>
                </div>
            </div>`;
        const q = (sel) => panel.querySelector(sel);
        q('.ua-cancel').addEventListener('click', () => { panel.innerHTML = ''; });
        q('.ua-gen')?.addEventListener('click', () => {
            const input = q('.ua-new');
            input.value = generatePassword();
            input.focus();
            input.select();
        });
        q('.ua-go').addEventListener('click', async () => {
            const err = q('.ua-err');
            err.textContent = '';
            const currentPassword = q('.ua-pw').value;
            try {
                if (act === 'role') {
                    await adminApi(`/api/users/${user.id}`, { method: 'PUT', body: JSON.stringify({ role: newRole, currentPassword }) });
                    writeUsersStatus(`${user.username} is now ${newRole === 'admin' ? 'an admin' : 'a user'}.`);
                } else if (act === 'reset') {
                    const password = q('.ua-new').value;
                    const out = await adminApi(`/api/users/${user.id}`, { method: 'PUT', body: JSON.stringify({ password, currentPassword }) });
                    writeUsersStatus(`New password saved for ${user.username}; signed out of ${out.signedOut} session(s).`);
                } else if (act === 'delete') {
                    const confirmName = q('.ua-confirm').value.trim();
                    if (confirmName !== user.username) { err.textContent = `Type ${user.username} to confirm.`; return; }
                    const out = await adminApi(`/api/users/${user.id}/delete`, { method: 'POST', body: JSON.stringify({ confirm: confirmName, currentPassword }) });
                    writeUsersStatus(`Deleted ${user.username}. Backup: ${out.backup}`);
                }
                await refreshUsers();
            } catch (e) {
                err.textContent = e.message;
            }
        });
    }

    document.getElementById('users-add-btn')?.addEventListener('click', () => {
        const form = document.getElementById('users-add-form');
        form.style.display = form.style.display === 'none' ? 'block' : 'none';
    });
    document.getElementById('users-new-generate')?.addEventListener('click', () => {
        const input = document.getElementById('users-new-password');
        input.value = generatePassword();
        input.focus();
        input.select();
    });
    document.getElementById('users-add-submit')?.addEventListener('click', async () => {
        const err = document.getElementById('users-add-error');
        err.textContent = '';
        const username = document.getElementById('users-new-name').value.trim();
        try {
            await adminApi('/api/users', {
                method: 'POST',
                body: JSON.stringify({
                    username,
                    password: document.getElementById('users-new-password').value,
                    role: document.getElementById('users-new-role').value,
                    currentPassword: document.getElementById('users-new-current').value
                })
            });
            for (const id of ['users-new-name', 'users-new-password', 'users-new-current']) document.getElementById(id).value = '';
            document.getElementById('users-add-form').style.display = 'none';
            writeUsersStatus(`Created ${username}. They start with an empty tree.`);
            await refreshUsers();
        } catch (e) {
            err.textContent = e.message;
        }
    });

    // --- Set-aside working copies ---
    const renderStashes = async () => {
        const block = document.getElementById('stash-block');
        const list = document.getElementById('stash-list');
        if (!block || !list) return;
        // Which copies the account signed in now may restore is the tree
        // store's call (TreeStore.listStashes): its own on this server, or
        // its own at an old address of what looks like the same server.
        const backend = (await StorageManager.getSettings()).backend || {};
        const signedIn = Boolean(getBackendConfig().token) && backend.userId !== undefined && backend.userId !== null;
        const account = signedIn ? {
            url: getBackendConfig().url, userId: backend.userId, username: backend.username || null,
            serverId: backend.serverId || null, tenancyOwner: Boolean(backend.tenancyOwner)
        } : null;
        const stashes = await TreeStore.listStashes(account).catch(() => []);
        block.style.display = stashes.length ? 'block' : 'none';
        if (!stashes.length) return;
        const restoreAttrs = (st) => !st.match ? 'disabled title="Sign in as this account to restore it"'
            : st.match === 'moved' ? 'title="Made at another address of this server — restoring asks first"' : '';
        // Note drafts parked on this device that only this copy brings back.
        const parkedWith = new Map(stashes.map(st => [st.key,
            parkedDraftsOnlyWith(st.stamps, stashes.filter(x => x.key !== st.key).map(x => x.stamps)).length]));
        list.innerHTML = stashes.map(st => `
            <div data-stash-key="${escapeHtml(st.key)}" style="background:rgba(0,0,0,0.2); border:1px solid var(--border-color); border-radius:6px; padding:10px; margin-bottom:8px;">
                <div style="color:#ddd;"><strong>${escapeHtml(st.username || (st.userId === null ? (st.origin === 'local' ? 'Made while signed out' : 'An older copy') : 'account #' + st.userId))}</strong>
                    <span style="color:var(--text-muted);">@ ${escapeHtml(st.url || '')}</span></div>
                <div style="font-size:0.72rem; color:var(--text-muted); margin-top:3px;">
                    ${st.editCount ? `${st.editCount} unpushed edit${st.editCount === 1 ? '' : 's'}` : 'no unpushed edits'} · ${fmtN(st.items)} items
                    · set aside ${escapeHtml(st.setAsideAt ? new Date(st.setAsideAt).toLocaleDateString() : '')}
                    ${parkedWith.get(st.key) ? `· ${parkedWith.get(st.key)} unsaved note draft${parkedWith.get(st.key) === 1 ? '' : 's'} parked with it` : ''}
                </div>
                <div style="display:flex; gap:6px; margin-top:8px; flex-wrap:wrap;">
                    <button class="sm-btn" data-stash-act="restore" style="flex:1;" ${restoreAttrs(st)}>Restore</button>
                    <button class="sm-btn" data-stash-act="export" style="flex:1;">Export bookmarks.html</button>
                    <button class="sm-btn" data-stash-act="discard" style="flex:1; color:var(--danger-color);">Discard…</button>
                </div>
            </div>
        `).join('');
        list.querySelectorAll('[data-stash-act]').forEach(btn => {
            btn.addEventListener('click', () => {
                const key = btn.closest('[data-stash-key]').dataset.stashKey;
                const st = stashes.find(x => x.key === key);
                handleStashAction(st, btn.dataset.stashAct, account)
                    .catch(e => { const el = document.getElementById('stash-status'); if (el) el.textContent = e.message; });
            });
        });
    };

    async function handleStashAction(st, act, account) {
        const status = document.getElementById('stash-status');
        const fileStem = `tabpaladin-${(st.username || 'older-copy').replace(/[^\w.-]+/g, '_')}`;
        const download = (text, type, name) => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([text], { type }));
            a.download = name;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        };
        if (act === 'export') {
            download(await TreeStore.exportStashHtml(st.key), 'text/html', `${fileStem}-set-aside.html`);
            return;
        }
        if (act === 'discard') {
            // A note draft parked with this copy comes back only with it. It
            // is named here and offered as a file first, and goes only with
            // the copy, once the discard is confirmed.
            const others = (await TreeStore.listStashes()).filter(x => x.key !== st.key).map(x => x.stamps);
            const drafts = parkedDraftsOnlyWith(st.stamps, others);
            const n = drafts.length;
            const draftsText = `${n} unsaved note draft${n === 1 ? '' : 's'} (${drafts.map(d => `“${d.title || 'Untitled'}”`).join(', ')})`;
            if (n && confirm(`This copy has ${draftsText} parked with it on this device. ${n === 1 ? 'It comes' : 'They come'} back only with this copy.\n\n`
                + `OK = Download ${n === 1 ? 'it' : 'them'} first, as a Markdown file.\nCancel = Don’t download.`)) {
                download(parkedDraftsMarkdown(drafts), 'text/markdown', `${fileStem}-note-drafts.md`);
            }
            const word = st.username || 'discard';
            const goes = [st.editCount ? `its ${st.editCount} unpushed edit(s)` : '', n ? `its ${draftsText}` : ''].filter(Boolean).join(' and ');
            const typed = prompt(`Discard this working copy for good${goes ? `, with ${goes}` : ''}?\n\nType ${word} to confirm.`);
            if (typed !== word) return;
            // Only the copy listed: restored meanwhile (here or in another
            // page), it is the working copy now and nothing is discarded —
            // nor are the drafts it brings back.
            if (!(await TreeStore.discardStash(st.key, { setAsideAt: st.setAsideAt }))) {
                status.textContent = 'That copy is no longer set aside — it was restored or replaced meanwhile. Nothing was discarded.';
                await renderStashes();
                return;
            }
            // The drafts go with it only while nothing kept here would bring
            // them back now.
            const stillOnly = new Set(parkedDraftsOnlyWith(st.stamps, (await TreeStore.listStashes()).map(x => x.stamps))
                .map(d => JSON.stringify(d)));
            const gone = drafts.filter(d => stillOnly.has(JSON.stringify(d)));
            dropParkedDrafts(gone);
            status.textContent = gone.length ? `Discarded, with its ${gone.length === 1 ? 'note draft' : `${gone.length} note drafts`}.` : 'Discarded.';
            await renderStashes();
            return;
        }
        if (act === 'restore') {
            const moved = st.match === 'moved';
            if (moved && !confirm(`This copy was made on ${st.url}. Restore it here, on ${account.url}?\n\n`
                + 'Only if that is the same server at a new address. A copy of the server\'s database reports the same id, '
                + 'and what you push to a copy never reaches the original.')) return;
            if (!(await beforeAccountSwitch('Restoring that copy'))) {
                status.textContent = 'Restore cancelled — nothing changed.';
                return;
            }
            await TreeStore.restoreStash(st.key, account, { moved });
            await pruneStaleFocusedFolders().catch(() => 0);
            await loadWorkflows();
            status.textContent = 'Restored. Whatever was here before is set aside in its place.';
            await renderStashes();
        }
    }

    refreshImports();
    refreshWhoAmI().then(() => { refreshUsers(); renderStashes(); });

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

// The account this browser is signed in as, as the server says for the token
// in hand — or null when it cannot say (unreachable, or older than accounts).
// Never what Settings last learned: it may not have learned it yet (a session
// from before accounts, Settings not opened since) or may still name whoever
// was signed in before a token was saved by hand, and a copy set aside on
// that guess, or pulled over, is the wrong one. With null, the pull goes by
// whose tree the server sends, or stops (see TreeStore.sync.pull).
async function signedInAccount(cfg) {
    if (!cfg.token) return null;
    try {
        const res = await fetch(cfg.url.replace(/\/$/, '') + '/api/auth/me', { headers: { Authorization: 'Bearer ' + cfg.token } });
        const me = res.ok ? await res.json() : null;
        const user = me && me.user;
        if (user && user.id !== undefined && user.id !== null) {
            return {
                url: cfg.url, userId: Number(user.id), username: user.username || null,
                serverId: me.serverId || null, tenancyOwner: Boolean(user.tenancyOwner)
            };
        }
    } catch (e) { /* unreachable, or older than accounts */ }
    return null;
}

// The working copy belongs to another account. Pulling over it would discard
// that account's edits and forcing would write them into this one, so the
// only offer is to set it aside (kept, under Settings › Set-aside copies) and
// pull this account's tree. Only the copy the server refused (err.copy) is set
// aside, and the pull goes only into the copy started for this account.
async function setAsideAndPull(cfg, err) {
    if (!confirm('This working copy belongs to another account.\n\n'
        + 'OK = Set it aside and pull this account\'s tree. The copy stays in this browser (Settings › Set-aside copies).\n'
        + 'Cancel = Do nothing.')) {
        return 'Push cancelled — this working copy belongs to another account.';
    }
    const me = await signedInAccount(cfg);
    const userId = me ? me.userId : err && err.userId;
    if (userId === undefined || userId === null) return 'Couldn’t confirm the account — try again. Nothing was changed.';
    if (!(await beforeAccountSwitch('Pulling this account’s tree'))) return 'Push cancelled — this working copy belongs to another account.';
    let reset;
    try {
        reset = await TreeStore.setAsideAndReset({
            url: cfg.url, userId, username: me ? me.username : null, serverId: me ? me.serverId : null,
            expect: (err && err.copy) || null
        });
    } catch (e) {
        if (e.code === 'account-changed') return 'Account changed meanwhile — nothing was set aside or pulled.';
        throw e;
    }
    let version;
    try {
        ({ version } = await TreeStore.sync.pull(cfg, { expect: reset.copy }));
    } catch (e) {
        return `Set the other account’s copy aside (Settings), but the pull did not happen: ${e.message}`;
    }
    await persistSyncStamp('pull');
    return `Set the other account's copy aside and pulled (v${version}).`;
}

async function persistSyncStamp(kind) {
    const settings = await StorageManager.getSettings();
    await StorageManager.saveSettings({
        ...settings,
        backend: { ...(settings.backend || {}), lastSyncAt: new Date().toISOString(), lastSyncKind: kind }
    });
}

// What a folding push brought in, for its status line: links filed from the
// phone, and those put in Bookmarks because their folder is gone here.
function relocatedNote(pushed) {
    const n = pushed && pushed.relocated;
    return n ? ` ${n} of them went into Bookmarks: the folder they were filed into is gone here.` : '';
}

function foldedNote(pushed) {
    const n = pushed && pushed.folded;
    return n ? ` Included ${n} link${n === 1 ? '' : 's'} filed from your phone.${relocatedNote(pushed)}` : '';
}

// Returns a status string for the caller to display.
async function doPush() {
    const cfg = await getSyncConfig();
    if (!cfg.token) {
        alert('Not signed in to the sync server. Open Settings (⚙️) and sign in.');
        return 'Not signed in.';
    }
    // The copy this push is for. Another page can bring another account's
    // copy in meanwhile: then nothing is pushed, and once the push is under
    // way, what the server answers is only ever applied to this copy — the
    // success (TreeStore.sync.push) and every answer to a refusal below.
    const copy = await TreeStore.currentCopy();
    // A fresh install has an empty working copy; pushing it (especially with
    // force after the inevitable conflict) would erase the whole tree on the
    // server for every device. Pull is almost always what was meant.
    if (copy.isEmpty) {
        if (!confirm('Your local working copy is EMPTY. Pushing it would erase the entire tree on the server.\n\nIf this is a fresh install, press Cancel and Pull instead.\n\nReally push an empty tree?')) {
            return 'Push cancelled — working copy is empty.';
        }
    }
    try {
        // A 409 that is only links filed from the phone since the last pull
        // folds them in and pushes again, without asking; any other conflict
        // gets the questions below.
        const pushed = await TreeStore.sync.pushFolding(cfg, { expect: copy });
        await persistSyncStamp('push');
        const included = pushed.folded ? `: included ${pushed.folded} link${pushed.folded === 1 ? '' : 's'} filed from your phone` : '';
        return (pushed.left ? `Pushed (v${pushed.version})${included}. ${pushed.message}` : `Pushed (v${pushed.version})${included}.`)
            + relocatedNote(pushed);
    } catch (e) {
        if (e.code === 'account-changed') return e.message;
        if (e.status === 412) return setAsideAndPull(cfg, e);
        if (e.status === 409) {
            const takeTheirs = confirm(
                'The server has changes you have not pulled (another device pushed).\n\n' +
                'OK = Pull the server\'s tree now (your unpushed local edits are discarded)\n' +
                'Cancel = Do nothing, so you can look first.\n\n' +
                'To overwrite the server instead, push again after this dialog and confirm the force prompt.'
            );
            // Both answers are about the copy that was refused (e.copy), as
            // it was then: never another account's copy brought in since,
            // nor edits made since.
            if (takeTheirs) return doPull({ skipConfirm: true, expect: e.copy });
            if (confirm('Force-push YOUR tree and overwrite the server\'s newer version? This discards what the other device pushed.')) {
                try {
                    const forced = await TreeStore.sync.push(cfg, { force: true, expect: e.copy });
                    await persistSyncStamp('push');
                    return forced.left ? `Force-pushed (v${forced.version}). ${forced.message}` : `Force-pushed (v${forced.version}).`;
                } catch (e2) {
                    if (e2.code === 'account-changed') return e2.message;
                    alert('Push failed: ' + e2.message);
                    return 'Push failed: ' + e2.message;
                }
            }
            return 'Push cancelled — pull first.';
        }
        alert('Push failed: ' + e.message);
        return 'Push failed: ' + e.message;
    }
}

async function doPull({ skipConfirm = false, expect = null } = {}) {
    // The copy this pull is for: the one here when Pull was pressed or, from
    // a refused push, the one that was refused (expect). Another page can
    // bring another account's copy in, or this one can be edited, while the
    // pull waits on the server or on a question: then nothing is replaced,
    // and the pull says so (TreeStore.sync.pull).
    const startedOn = expect || await TreeStore.currentCopy();
    const accountChanged = 'Account changed during pull — nothing was replaced.';
    const cfg = await getSyncConfig();
    if (!cfg.token) {
        alert('Not signed in to the sync server. Open Settings (⚙️) and sign in.');
        return 'Not signed in.';
    }
    // A copy that belongs to another account (or predates accounts, for
    // anyone but the server owner) is set aside, never pulled over — when the
    // server says whose session this is. When it cannot, the pull goes by
    // whose tree the server sends, or stops (TreeStore.sync.pull).
    const me = await signedInAccount(cfg);
    if (!TreeStore.sameCopy(await TreeStore.currentCopy(), startedOn)) return accountChanged;
    const status = TreeStore.status();
    let setAside = false;
    let into = startedOn;
    if (me && TreeStore.wouldSetAside(me)) {
        if (!(await beforeAccountSwitch('This pull'))) return 'Pull cancelled.';
        // Only the copy this pull was for is set aside, and the pull goes
        // only into the copy started in its place.
        let reset;
        try {
            reset = await TreeStore.setAsideAndReset({ ...me, expect: startedOn });
        } catch (e) {
            if (e.code === 'account-changed') return accountChanged;
            throw e;
        }
        // An empty copy has nothing to set aside, and nothing to say about it.
        setAside = Boolean(reset.setAside);
        into = reset.copy;
    } else if (!skipConfirm && status.dirty) {
        if (!confirm('You have local edits that were never pushed. Pulling replaces your working copy with the server\'s tree and discards them.\n\nPull anyway?')) {
            return 'Pull cancelled.';
        }
    }
    try {
        // The pull sets the copy aside itself when the tree turns out to be
        // another account's than the copy's (see TreeStore.sync.pull).
        const pulled = await TreeStore.sync.pull(cfg, { expect: into });
        const version = pulled.version;
        if (pulled.setAside) setAside = true;
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
        const aside = setAside ? ' The other account’s working copy is set aside (Settings).' : '';
        return (items === 0
            ? `Pulled (v${version}) — but the server's tree is EMPTY.`
            : `Pulled ${items} item(s) (v${version}).`) + aside;
    } catch (e) {
        // Stopped before anything was written: another copy came in, the copy
        // was edited meanwhile, or the server could not say whose copy this
        // is. Not a failure to alarm anyone over — pulling again is the answer.
        if (e.code === 'account-changed' || e.code === 'account-unconfirmed' || e.code === 'edited-during-pull') {
            return e.message + (setAside || e.setAside ? ' The other account’s working copy is set aside (Settings).' : '');
        }
        alert('Pull failed: ' + e.message);
        return 'Pull failed: ' + e.message;
    }
}

// Give open editors a say before a sync. The notes view offers to save a
// dirty note before a push, so the push carries it; before a pull it saves
// nothing, since the pull would replace that save, and keeps the draft open.
// Listeners call event.detail.waitUntil(promise); the sync waits for all of
// them, and a listener that fails never blocks it.
async function beforeSync(kind) {
    const pending = [];
    window.dispatchEvent(new CustomEvent('tabpaladin:before-sync', {
        detail: { kind, waitUntil: (p) => pending.push(Promise.resolve(p)) }
    }));
    await Promise.allSettled(pending);
}

// The same, before this working copy is set aside for another one (signing in
// as someone else, a pull or refused push that sets it aside, a restore). An
// unsaved note belongs to the copy it was written in: the notes view saves it
// into that copy, so it is set aside with it, or discards it — or the user
// keeps editing and a listener resolves false, which calls the switch off.
async function beforeAccountSwitch(action) {
    const pending = [];
    window.dispatchEvent(new CustomEvent('tabpaladin:before-account-switch', {
        detail: { action, waitUntil: (p) => pending.push(Promise.resolve(p)) }
    }));
    const results = await Promise.allSettled(pending);
    return !results.some(r => r.status === 'fulfilled' && r.value === false);
}

document.getElementById('mainPushBtn').addEventListener('click', async () => {
    await beforeSync('push');
    _updateMainStatus('Pushing…');
    _updateMainStatus(await doPush());
});

document.getElementById('mainPullBtn').addEventListener('click', async () => {
    await beforeSync('pull');
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

// Settings › Backup: the working copy and the open note's unsaved text are
// written first, so the file has what is on screen.
function downloadPageBackup() {
    return downloadBackup({
        api: globalThis.browser || chrome,
        prepare: () => Promise.allSettled([TreeStore.flush(), saveLiveDraft()])
    });
}
