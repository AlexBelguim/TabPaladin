// Firefox/Chrome compatibility - use browser API directly
const api = typeof browser !== 'undefined' ? browser : chrome;

const WORKFLOW_ROOT_TITLE = 'TabPaladin Workflows';
// Sentinel bookmark title used to store workflow metadata (createdAt, etc).
// Lives at the top of each workflow folder, has a non-http url so users can't accidentally open it.
const META_TITLE = '__tabpaladin_meta__';

// Resolved root folders, keyed by the settings key that persists their id
// (e.g. 'workflowRootBookmarkId', 'notesRootBookmarkId').
const rootFolderCaches = new Map();
// Number of *extra* "TabPaladin Workflows" folders found during the last full
// resolution (0 = no duplicates). Surfaced in the settings UI.
let workflowRootDuplicateCount = 0;

async function persistRootId(settingsKey, id, settings) {
    try {
        await StorageManager.saveSettings({ ...settings, [settingsKey]: id });
    } catch (e) { /* non-fatal */ }
}

// --- Root identity ------------------------------------------------------
//
// A title is not an identity. It is not unique and it is not stable, and
// resolving "the" workflows root by searching the tree for a folder called
// "TabPaladin Workflows" is what produced duplicates that came back after
// every pull: with two candidates the code picked whichever had more children,
// which flips as they diverge.
//
// So each app root carries a marker bookmark holding a generated id and a
// creation time — the same trick already used per-workflow with
// __tabpaladin_meta__, one level up. The title is only a hint for finding
// candidates; the marker decides which is real, and the oldest wins, which is
// stable no matter what either folder contains.
const ROOT_MARKER_TITLE = '__tabpaladin_root__';
const ROOT_MARKER_PREFIX = 'data:application/json,';

function buildMarkerUrl(payload) {
    return ROOT_MARKER_PREFIX + encodeURIComponent(JSON.stringify(payload));
}

async function readRootMarker(folderId) {
    try {
        const children = await api.bookmarks.getChildren(folderId);
        const node = children.find(c => c.title === ROOT_MARKER_TITLE && c.url);
        if (!node) return null;
        const parsed = JSON.parse(decodeURIComponent(node.url.slice(ROOT_MARKER_PREFIX.length)));
        return { nodeId: node.id, rootId: parsed.rootId, createdAt: parsed.createdAt || null };
    } catch (e) {
        return null;
    }
}

async function writeRootMarker(folderId, settingsKey, createdAt) {
    try {
        const payload = {
            v: 1,
            kind: settingsKey,
            rootId: (globalThis.crypto && globalThis.crypto.randomUUID)
                ? globalThis.crypto.randomUUID()
                : 'r' + Date.now() + Math.random().toString(16).slice(2),
            createdAt: createdAt || new Date().toISOString()
        };
        await api.bookmarks.create({
            parentId: folderId,
            title: ROOT_MARKER_TITLE,
            url: buildMarkerUrl(payload)
        });
        return payload;
    } catch (e) {
        return null;
    }
}

// Move everything out of `from` into `keep`, then delete `from` — but only if
// it actually emptied. Never destroy content we failed to move.
async function absorbFolder(from, keepId) {
    let moved = 0;
    const kids = await api.bookmarks.getChildren(from.id);
    for (const k of kids) {
        // The loser's marker is dropped, not carried across.
        if (k.title === ROOT_MARKER_TITLE && k.url) {
            try { await api.bookmarks.remove(k.id); } catch (e) { /* ignore */ }
            continue;
        }
        try { await api.bookmarks.move(k.id, { parentId: keepId }); moved++; }
        catch (e) { console.warn('[TabPaladin] could not move during merge', k.id, e); }
    }
    const left = await api.bookmarks.getChildren(from.id);
    if (left.length === 0) {
        try { await api.bookmarks.removeTree(from.id); return moved; }
        catch (e) { console.warn('[TabPaladin] could not remove merged folder', from.id, e); }
    } else {
        console.warn(`[TabPaladin] leaving duplicate "${from.title}" (${from.id}); ${left.length} child(ren) would not move.`);
    }
    return moved;
}

async function countDuplicateFolders(title) {
    try {
        const matches = await api.bookmarks.search({ title });
        return Math.max(0, matches.filter(m => !m.url && m.title === title).length - 1);
    } catch (e) {
        return 0;
    }
}

/**
 * Single source of truth for an app-managed root folder (workflows, notes).
 * Every caller (save, list, render, settings) must resolve through this so
 * they never disagree about which folder is "the" root.
 *
 * Resolution order:
 *   1. Verified in-memory cache.
 *   2. The persisted settings[settingsKey], if it still exists.
 *   3. Exact-title bookmark search; with duplicates, the folder holding the
 *      most children wins. The choice is persisted.
 *   4. With create=true, a new folder under Other Bookmarks (id '2').
 *
 * Returns null when nothing exists and create=false.
 */
async function resolveRootFolder({ title, settingsKey, create = false }) {
    // No early return on a cache or a persisted id.
    //
    // Both used to short-circuit straight to a folder, which meant the
    // duplicate scan below only ran when the stored id was already broken —
    // so on the common path the app happily kept using one of two roots and
    // the Consolidate warning came back forever. The scan is a local indexed
    // lookup; paying it every resolve is what makes a second root impossible
    // to observe. The cache and the persisted id now only express a
    // *preference* between candidates.
    const settings = await StorageManager.getSettings();
    const cached = rootFolderCaches.get(settingsKey);
    const preferredId = (cached && cached.id) || (settings && settings[settingsKey]) || null;

    if (preferredId && !cached) {
        try {
            const node = (await api.bookmarks.get(preferredId))[0];
            // The id alone isn't enough: bookmark ids are only meaningful within
            // the tree that produced them, so a persisted id can end up on some
            // unrelated folder (a destructive pull recreates every node, users
            // reorganize, profiles get restored). Binding to it silently would
            // hide every note and file new ones into a stranger's folder, so the
            // title has to match too.
            if (node && node.title !== title) {
                console.warn(`[TabPaladin] Persisted ${settingsKey}=${preferredId} now points at ` +
                    `"${node.title}", not "${title}" — re-resolving by title.`);
            }
        } catch (e) {
            // Persisted folder gone — the title search below covers it.
        }
    }

    // bookmarks.search is token-based and can return near-matches like
    // "TabPaladin Workflows backup" — require an exact title match.
    const matches = await api.bookmarks.search({ title });
    const folders = matches.filter(m => !m.url && m.title === title);

    let chosen = folders[0] || null;

    if (folders.length > 1) {
        // Heal here, on every resolve — not only after a pull.
        //
        // Duplicates can appear at any time: a push from another device, the
        // browser's own sync landing a second copy, a manual move. Healing only
        // in the pull path left every other moment exposed, which is why the
        // warning kept coming back. Merging at the single point that every
        // caller already funnels through means the rest of the app can never
        // observe two roots.
        const marked = [];
        for (const f of folders) {
            const marker = await readRootMarker(f.id);
            const kids = await api.bookmarks.getChildren(f.id);
            marked.push({ folder: f, marker, count: kids.length });
        }

        // Oldest marker wins — stable regardless of what either folder holds.
        // With no markers at all, prefer the one we already had recorded, and
        // only then fall back to the fullest.
        const remembered = marked.find(m => preferredId && String(m.folder.id) === String(preferredId));
        const withMarkers = marked.filter(m => m.marker && m.marker.createdAt);
        const winner = withMarkers.length
            ? withMarkers.reduce((a, b) => (a.marker.createdAt <= b.marker.createdAt ? a : b))
            : (remembered || marked.reduce((a, b) => (a.count >= b.count ? a : b)));

        chosen = winner.folder;
        for (const other of marked) {
            if (other.folder.id === chosen.id) continue;
            const moved = await absorbFolder(other.folder, chosen.id);
            console.log(`[TabPaladin] Merged duplicate "${title}" ${other.folder.id} into ${chosen.id} (${moved} item(s)).`);
        }
    }

    // Create under Other Bookmarks. '2' is the standard id on both Chrome and Firefox.
    if (!chosen && create) {
        chosen = await api.bookmarks.create({
            parentId: '2',
            title
        });
    }

    if (chosen) {
        // Stamp anything that isn't marked yet, so the next resolve has a
        // stable identity to compare rather than counting children again.
        if (!(await readRootMarker(chosen.id))) {
            await writeRootMarker(chosen.id, settingsKey);
        }
        rootFolderCaches.set(settingsKey, chosen);
        await persistRootId(settingsKey, chosen.id, settings);
    }

    // Recount after healing, so settings shows the truth rather than the
    // situation before the merge.
    if (title === WORKFLOW_ROOT_TITLE) {
        workflowRootDuplicateCount = await countDuplicateFolders(title);
    }
    return chosen;
}

async function resolveWorkflowRoot({ create = false } = {}) {
    return resolveRootFolder({
        title: WORKFLOW_ROOT_TITLE,
        settingsKey: 'workflowRootBookmarkId',
        create
    });
}

async function findOrCreateRoot() {
    return resolveWorkflowRoot({ create: true });
}

function isMetaNode(node) {
    return node && node.title === META_TITLE;
}

function parseMeta(node) {
    if (!node || !node.url) return {};
    try {
        // url is data:application/json,<encoded JSON>
        const prefix = 'data:application/json,';
        if (!node.url.startsWith(prefix)) return {};
        return JSON.parse(decodeURIComponent(node.url.slice(prefix.length)));
    } catch (e) {
        return {};
    }
}

function buildMetaUrl(meta) {
    return 'data:application/json,' + encodeURIComponent(JSON.stringify(meta));
}

async function hydrateWorkflow(folderNode) {
    const children = await api.bookmarks.getChildren(folderNode.id);
    let meta = {};
    const tabs = [];
    for (const c of children) {
        if (isMetaNode(c)) {
            meta = parseMeta(c);
            continue;
        }
        if (c.url) {
            tabs.push({
                id: c.id, // bookmark id, used for partial restore + sync
                url: c.url,
                title: c.title,
                favIconUrl: null
            });
        }
    }
    return {
        id: folderNode.id,
        name: folderNode.title,
        createdAt: meta.createdAt || new Date(folderNode.dateAdded || Date.now()).toISOString(),
        tabs
    };
}

export const StorageManager = {
    /**
     * Save a new workflow as a bookmark folder under "TabPaladin Workflows".
     */
    saveWorkflow: async (name, tabs) => {
        const root = await findOrCreateRoot();
        const folder = await api.bookmarks.create({
            parentId: root.id,
            title: name
        });

        // Write meta sentinel first so it stays at the top.
        await api.bookmarks.create({
            parentId: folder.id,
            title: META_TITLE,
            url: buildMetaUrl({ createdAt: new Date().toISOString() })
        });

        for (const t of tabs) {
            if (!t.url) continue;
            await api.bookmarks.create({
                parentId: folder.id,
                title: t.title || t.url,
                url: t.url
            });
        }

        return await hydrateWorkflow(folder);
    },

    getWorkflows: async () => {
        const root = await findOrCreateRoot();
        const children = await api.bookmarks.getChildren(root.id);
        const folders = children.filter(c => !c.url);
        const workflows = [];
        for (const f of folders) {
            workflows.push(await hydrateWorkflow(f));
        }
        return workflows;
    },

    /**
     * Delete a workflow by its bookmark folder id.
     */
    deleteWorkflow: async (id) => {
        try {
            await api.bookmarks.removeTree(id);
        } catch (e) {
            console.warn("deleteWorkflow: folder already gone?", e);
        }
    },

    /**
     * Remove a single tab (bookmark) from a workflow without touching others.
     */
    removeTabFromWorkflow: async (bookmarkId) => {
        try {
            await api.bookmarks.remove(bookmarkId);
        } catch (e) {
            // Already gone — that's fine
        }
    },

    /**
     * Open a workflow (or a subset of its tabs) in a new window.
     * Returns { window, openedTabs: [{ tabId, bookmarkId }] } so callers can wire up auto-sync.
     */
    restoreWorkflow: async (workflow, options = {}) => {
        if (!workflow.tabs || workflow.tabs.length === 0) return { window: null, openedTabs: [] };

        const selectedTabs = options.bookmarkIds
            ? workflow.tabs.filter(t => options.bookmarkIds.includes(t.id))
            : workflow.tabs;

        if (selectedTabs.length === 0) return { window: null, openedTabs: [] };

        let win;
        if (options.inCurrentWindow) {
            const current = await api.windows.getCurrent();
            win = current;
        } else {
            win = await api.windows.create({ url: selectedTabs[0].url, focused: true });
        }

        const openedTabs = [];
        const startIndex = options.inCurrentWindow ? 0 : 1;

        // If we created a new window, the first tab is already opened by windows.create.
        // We need to map that opened tab id to its bookmark id.
        if (!options.inCurrentWindow && selectedTabs[0]) {
            // The new window contains exactly one tab at this point.
            const wTabs = await api.tabs.query({ windowId: win.id });
            if (wTabs[0]) openedTabs.push({ tabId: wTabs[0].id, bookmarkId: selectedTabs[0].id });
        }

        for (let i = startIndex; i < selectedTabs.length; i++) {
            const tab = await api.tabs.create({ windowId: win.id, url: selectedTabs[i].url });
            openedTabs.push({ tabId: tab.id, bookmarkId: selectedTabs[i].id });
        }

        // Tell the background script so it can autosync on tab close
        try {
            await api.runtime.sendMessage({
                type: 'TP_TRACK_WORKFLOW_TABS',
                workflowId: workflow.id,
                entries: openedTabs
            });
        } catch (e) {
            // Background not listening yet? Not fatal.
        }

        return { window: win, openedTabs };
    },

    /**
     * Export workflows to a JSON file.
     */
    exportWorkflows: async () => {
        const workflows = await StorageManager.getWorkflows();
        const blob = new Blob([JSON.stringify(workflows, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);

        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        await api.downloads.download({
            url: url,
            filename: `tabpaladin_workflows_${timestamp}.json`
        });
    },

    /**
     * Import workflows from JSON. Each entry becomes a new bookmark folder under the root.
     */
    importWorkflows: async (jsonString) => {
        try {
            const incoming = JSON.parse(jsonString);
            if (!Array.isArray(incoming)) throw new Error("Invalid format");

            let count = 0;
            for (const wf of incoming) {
                if (!wf || !Array.isArray(wf.tabs)) continue;
                await StorageManager.saveWorkflow(wf.name || 'Imported Workflow', wf.tabs);
                count++;
            }
            return { success: true, count };
        } catch (e) {
            console.error("Import failed", e);
            return { success: false, error: e.message };
        }
    },

    /**
     * One-time migration: move legacy storage.local "workflows" into the bookmark tree.
     */
    migrateLegacyIfNeeded: async () => {
        const data = await api.storage.local.get(['workflows', 'tpMigrationDone']);
        if (data.tpMigrationDone) return { migrated: 0, alreadyDone: true };

        const legacy = (data && data.workflows) || [];
        let migrated = 0;
        for (const wf of legacy) {
            if (!wf || !Array.isArray(wf.tabs)) continue;
            await StorageManager.saveWorkflow(wf.name || 'Migrated', wf.tabs);
            migrated++;
        }

        await api.storage.local.set({ tpMigrationDone: true });
        if (legacy.length) {
            // Keep the old data under a renamed key in case the user wants to recover, then drop in a later release.
            await api.storage.local.set({ workflows_legacy_backup: legacy });
            await api.storage.local.remove('workflows');
        }
        return { migrated, alreadyDone: false };
    },

    /**
     * Settings Management (still in extension storage — these aren't workflows).
     */
    saveSettings: async (settings) => {
        await api.storage.local.set({ settings });
    },

    getSettings: async () => {
        const data = await api.storage.local.get("settings") || {};
        return (data && data.settings) || {
            focusedFolderIds: []
        };
    },

    /**
     * Expose helpers for callers that need them.
     */
    getWorkflowRoot: findOrCreateRoot,
    // Resolve the workflows root without creating it (null when absent).
    findWorkflowRoot: () => resolveWorkflowRoot({ create: false }),
    getWorkflowRootDuplicateCount: () => workflowRootDuplicateCount,
    // Generic root-folder resolver, also used by the notes feature.
    resolveRootFolder,
    // Drop the in-memory root cache. Call after anything that rebuilds the
    // bookmark tree wholesale (a destructive pull), since every cached id is
    // then meaningless.
    resetRootCache: () => rootFolderCaches.clear(),

    /**
     * Merge every duplicate folder of `title` into one, moving their children
     * across and deleting the emptied husks. Returns the number merged.
     *
     * This is what the Consolidate button in settings does, as a function, so a
     * pull can do it automatically. Duplicates keep coming back because a pull
     * faithfully recreates whatever the snapshot holds — if the snapshot itself
     * carries two workflow roots, consolidating locally fixes nothing the next
     * time you sync. Healing after every pull makes the recurrence a non-event
     * whatever put the second folder there.
     *
     * The survivor is the folder with the most children, matching how
     * resolveRootFolder picks, so the two never disagree about which is "the"
     * root.
     */
    consolidateDuplicateRoots: async (title) => {
        let folders;
        try {
            const matches = await api.bookmarks.search({ title });
            folders = matches.filter(m => !m.url && m.title === title);
        } catch (e) {
            return 0;
        }
        if (folders.length < 2) return 0;

        const counts = new Map();
        for (const f of folders) {
            try { counts.set(f.id, (await api.bookmarks.getChildren(f.id)).length); }
            catch (e) { counts.set(f.id, -1); }
        }
        const keep = folders.reduce((best, f) => (counts.get(f.id) > counts.get(best.id) ? f : best), folders[0]);

        let merged = 0;
        for (const dupe of folders) {
            if (dupe.id === keep.id) continue;
            try {
                const kids = await api.bookmarks.getChildren(dupe.id);
                for (const k of kids) {
                    try { await api.bookmarks.move(k.id, { parentId: keep.id }); }
                    catch (e) { console.warn('[TabPaladin] consolidate: could not move', k.id, e); }
                }
                // Only remove once empty — never delete content we failed to move.
                const left = await api.bookmarks.getChildren(dupe.id);
                if (left.length === 0) {
                    await api.bookmarks.removeTree(dupe.id);
                    merged++;
                } else {
                    console.warn(`[TabPaladin] consolidate: leaving "${title}" ${dupe.id}, ${left.length} child(ren) would not move.`);
                }
            } catch (e) {
                console.warn('[TabPaladin] consolidate failed for', dupe.id, e);
            }
        }
        if (merged > 0) {
            rootFolderCaches.clear();
            workflowRootDuplicateCount = 0;
        }
        return merged;
    },
    META_TITLE
};
