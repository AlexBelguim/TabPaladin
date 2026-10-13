// Workflows + settings.
//
// Workflows live in the synced tree under the folder carrying role
// 'workflows': each workflow is a folder whose payload holds {createdAt} and
// whose bookmark children are the saved tabs. Roles replaced the old
// magic-title lookup, so the entire root-identity apparatus this file used to
// carry — marker bookmarks, duplicate scans, merge-on-resolve — is gone: a
// role is unique in the tree by construction, and ids are stable across sync.
//
// Settings stay in extension storage; they are device-local, not tree data.
import { TreeStore } from './treeStore.js';

const api = typeof browser !== 'undefined' ? browser : chrome;

const VIDEO_SEEK_KEY = 'tpVideoSeek';

function hydrateWorkflow(folderNode) {
    const tabs = [];
    for (const c of folderNode.children || []) {
        if (c.kind === 'bookmark' && c.url) {
            tabs.push({
                id: c.id, // tree node id, used for partial restore + sync
                url: c.url,
                title: c.title,
                favIconUrl: null
            });
        }
    }
    const payload = folderNode.payload || {};
    return {
        id: folderNode.id,
        name: folderNode.title,
        createdAt: payload.createdAt || new Date().toISOString(),
        tabs
    };
}

export const StorageManager = {
    /**
     * Save a new workflow as a folder under the workflows root.
     */
    saveWorkflow: async (name, tabs) => {
        const root = await TreeStore.ensureRoleRoot('workflows');
        const folder = await TreeStore.createNode({
            parentId: root.id,
            kind: 'folder',
            title: name,
            payload: { createdAt: new Date().toISOString() }
        });

        for (const t of tabs) {
            if (!t.url) continue;
            await TreeStore.createNode({
                parentId: folder.id,
                kind: 'bookmark',
                title: t.title || t.url,
                url: t.url
            });
        }

        const fresh = await TreeStore.getNode(folder.id);
        return hydrateWorkflow(fresh);
    },

    getWorkflows: async () => {
        const root = await TreeStore.findRoleRoot('workflows');
        if (!root) return [];
        return (root.children || [])
            .filter(c => c.kind === 'folder')
            .map(hydrateWorkflow);
    },

    /**
     * Delete a workflow by its folder id.
     */
    deleteWorkflow: async (id) => {
        try {
            await TreeStore.removeNode(id);
        } catch (e) {
            console.warn("deleteWorkflow: folder already gone?", e);
        }
    },

    /**
     * Remove a single tab (bookmark) from a workflow without touching others.
     */
    removeTabFromWorkflow: async (bookmarkId) => {
        try {
            await TreeStore.removeNode(bookmarkId);
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
     * Import workflows from JSON. Each entry becomes a new folder under the root.
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
     * One-time migration: move legacy storage.local "workflows" into the tree.
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
     * Video scroll-seek's switch. Its own key (tpVideoSeek), which the
     * background registers the content script by; settings.videoSeek, where
     * it lived before, is still written so an older version finds it set.
     */
    getVideoSeek: async () => {
        const data = await api.storage.local.get([VIDEO_SEEK_KEY, 'settings']) || {};
        if (typeof data[VIDEO_SEEK_KEY] === 'boolean') return data[VIDEO_SEEK_KEY];
        return Boolean(data.settings && data.settings.videoSeek);
    },

    setVideoSeek: async (on) => {
        const current = await StorageManager.getSettings();
        await api.storage.local.set({ [VIDEO_SEEK_KEY]: Boolean(on), settings: { ...current, videoSeek: Boolean(on) } });
    },

    /**
     * Expose helpers for callers that need them.
     */
    getWorkflowRoot: () => TreeStore.ensureRoleRoot('workflows'),
    // Resolve the workflows root without creating it (null when absent).
    findWorkflowRoot: () => TreeStore.findRoleRoot('workflows')
};
