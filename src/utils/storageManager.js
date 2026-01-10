/**
 * StorageManager - Handles Chrome Storage for Workflows and Settings.
 */

export const StorageManager = {
    /**
     * Save a new workflow.
     * @param {string} name - Name of the workflow.
     * @param {Array} tabs - Array of tab objects (url, title, favicon).
     */
    saveWorkflow: async (name, tabs) => {
        const workflow = {
            id: Date.now().toString(),
            name,
            createdAt: new Date().toISOString(),
            tabs: tabs.map(t => ({ url: t.url, title: t.title, favIconUrl: t.favIconUrl }))
        };

        const data = await chrome.storage.local.get("workflows");
        const workflows = data.workflows || [];
        workflows.push(workflow);

        await chrome.storage.local.set({ workflows });
        return workflow;
    },

    /**
     * Get all saved workflows.
     */
    getWorkflows: async () => {
        const data = await chrome.storage.local.get("workflows");
        return data.workflows || [];
    },

    /**
     * Delete a workflow by ID.
     */
    deleteWorkflow: async (id) => {
        const data = await chrome.storage.local.get("workflows");
        let workflows = data.workflows || [];
        workflows = workflows.filter(w => w.id !== id);
        await chrome.storage.local.set({ workflows });
    },

    /**
     * Open a workflow in a new window.
     */
    restoreWorkflow: async (workflow) => {
        if (!workflow.tabs || workflow.tabs.length === 0) return;

        // Create new window with the first tab
        const firstUrl = workflow.tabs[0].url;
        const window = await chrome.windows.create({ url: firstUrl, focused: true });

        // Open remaining tabs
        for (let i = 1; i < workflow.tabs.length; i++) {
            await chrome.tabs.create({ windowId: window.id, url: workflow.tabs[i].url });
        }
    },

    /**
     * Export workflows to JSON file.
     */
    exportWorkflows: async () => {
        const workflows = await StorageManager.getWorkflows();
        const blob = new Blob([JSON.stringify(workflows, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);

        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        await chrome.downloads.download({
            url: url,
            filename: `tabworkflow_backup_${timestamp}.json`
        });
    },

    /**
   * Import workflows from JSON string.
   */
    importWorkflows: async (jsonString) => {
        try {
            const newWorkflows = JSON.parse(jsonString);
            if (!Array.isArray(newWorkflows)) throw new Error("Invalid format");

            const data = await chrome.storage.local.get("workflows");
            const currentWorkflows = data.workflows || [];

            // Merge unique flows (simple check by name+length for now, or just append)
            const merged = [...currentWorkflows, ...newWorkflows];

            await chrome.storage.local.set({ workflows: merged });
            return { success: true, count: newWorkflows.length };
        } catch (e) {
            console.error("Import failed", e);
            return { success: false, error: e.message };
        }
    },
    /**
     * Settings Management
     */
    saveSettings: async (settings) => {
        await chrome.storage.local.set({ settings });
    },

    getSettings: async () => {
        const data = await chrome.storage.local.get("settings");
        return data.settings || {
            focusedFolderIds: [] // Default: check all if empty? Or check '2' (Other)? 
            // Let's default to [] which implies "Scan All" or "Ask User". 
            // Actually, if we want "Scope", we probably want explicit. 
        };
    }
};
