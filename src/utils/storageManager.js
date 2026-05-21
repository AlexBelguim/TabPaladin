// Firefox/Chrome compatibility - use browser API directly
const api = typeof browser !== 'undefined' ? browser : chrome;

const WORKFLOW_ROOT_TITLE = 'TabPaladin Workflows';
// Sentinel bookmark title used to store workflow metadata (createdAt, etc).
// Lives at the top of each workflow folder, has a non-http url so users can't accidentally open it.
const META_TITLE = '__tabpaladin_meta__';

let rootFolderCache = null;

async function findOrCreateRoot() {
    if (rootFolderCache) {
        // Verify it still exists
        try {
            const check = await api.bookmarks.get(rootFolderCache.id);
            if (check && check[0]) return rootFolderCache;
        } catch (e) {
            rootFolderCache = null;
        }
    }

    // Search "Other Bookmarks" (id '2') for an existing root folder.
    // Search API is the most reliable cross-browser way.
    const matches = await api.bookmarks.search({ title: WORKFLOW_ROOT_TITLE });
    const existing = matches.find(m => !m.url);
    if (existing) {
        rootFolderCache = existing;
        return existing;
    }

    // Create under Other Bookmarks. '2' is the standard id on both Chrome and Firefox.
    const created = await api.bookmarks.create({
        parentId: '2',
        title: WORKFLOW_ROOT_TITLE
    });
    rootFolderCache = created;
    return created;
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
    META_TITLE
};
