// Background script: handles sidebar wiring + workflow auto-sync.
// Compatible with both Chrome (service worker) and Firefox (event page).

const api = typeof browser !== 'undefined' ? browser : chrome;

const TRACK_STORE_KEY = 'tpOpenWorkflowTabs'; // { [tabId]: { workflowId, bookmarkId } }

console.log("TabPaladin background script loaded.");

// --- Sidebar wiring ---
if (api.sidePanel && typeof api.sidePanel.setPanelBehavior === 'function') {
    api.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
        .catch((error) => console.error("TabPaladin: Failed to set panel behavior:", error));
}

if (api.sidebarAction && typeof api.sidebarAction.toggle === 'function' && api.browserAction) {
    api.browserAction.onClicked.addListener(() => {
        api.sidebarAction.toggle();
    });
}

if (api.action && api.action.onClicked) {
    api.action.onClicked.addListener(() => {
        api.tabs.create({ url: api.runtime.getURL("src/sidepanel/sidepanel.html") });
    });
}

api.runtime.onInstalled.addListener(() => {
    console.log("TabPaladin installed.");
    if (api.sidePanel && typeof api.sidePanel.setPanelBehavior === 'function') {
        api.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    }
    // Clear stale tracking from previous session
    api.storage.local.remove(TRACK_STORE_KEY).catch(() => {});
});

if (api.runtime.onStartup) {
    api.runtime.onStartup.addListener(() => {
        api.storage.local.remove(TRACK_STORE_KEY).catch(() => {});
    });
}

// --- Workflow tab tracking ---
async function getTrackMap() {
    const data = await api.storage.local.get(TRACK_STORE_KEY);
    return data[TRACK_STORE_KEY] || {};
}

async function setTrackMap(map) {
    await api.storage.local.set({ [TRACK_STORE_KEY]: map });
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;

    if (msg.type === 'TP_TRACK_WORKFLOW_TABS') {
        (async () => {
            const map = await getTrackMap();
            for (const e of msg.entries || []) {
                map[e.tabId] = { workflowId: msg.workflowId, bookmarkId: e.bookmarkId };
            }
            await setTrackMap(map);
            sendResponse({ ok: true });
        })();
        return true; // async response
    }

    if (msg.type === 'TP_UNTRACK_WORKFLOW') {
        (async () => {
            const map = await getTrackMap();
            for (const tabId of Object.keys(map)) {
                if (map[tabId].workflowId === msg.workflowId) delete map[tabId];
            }
            await setTrackMap(map);
            sendResponse({ ok: true });
        })();
        return true;
    }
});

// Auto-sync: when a tracked tab closes, remove its bookmark from the workflow
api.tabs.onRemoved.addListener(async (tabId) => {
    try {
        const map = await getTrackMap();
        const entry = map[tabId];
        if (!entry) return;

        try {
            await api.bookmarks.remove(entry.bookmarkId);
        } catch (e) {
            // Bookmark already gone — fine
        }

        delete map[tabId];
        await setTrackMap(map);
    } catch (e) {
        console.warn("TabPaladin autosync error:", e);
    }
});
