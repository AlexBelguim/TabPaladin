// Background script: opens the app page + workflow auto-sync.
// Compatible with both Chrome (service worker) and Firefox (event page).

const api = typeof browser !== 'undefined' ? browser : chrome;

const TRACK_STORE_KEY = 'tpOpenWorkflowTabs'; // { [tabId]: { workflowId, bookmarkId } }
const APP_PAGE = 'src/app/app.html';

console.log("TabPaladin background script loaded.");

// --- Opening the app ---
//
// The toolbar icon opens a full browser tab. This used to call
// sidePanel.setPanelBehavior({ openPanelOnActionClick: true }), and that is
// worth knowing about: while it is set, action.onClicked never fires in Chrome,
// because the click is consumed by the panel. Adding the listener below without
// removing those calls looks like the listener is simply broken.
//
// Reuse an existing tab rather than piling up copies — this is a workspace, not
// a document.
async function openApp() {
    const url = api.runtime.getURL(APP_PAGE);
    try {
        const existing = await api.tabs.query({ url });
        if (existing && existing.length) {
            await api.tabs.update(existing[0].id, { active: true });
            if (existing[0].windowId != null && api.windows) {
                await api.windows.update(existing[0].windowId, { focused: true });
            }
            return;
        }
    } catch (e) {
        // tabs.query needs the "tabs" permission; fall through and just open one.
    }
    await api.tabs.create({ url });
}

if (api.action && api.action.onClicked) {
    api.action.onClicked.addListener(openApp);
} else if (api.browserAction && api.browserAction.onClicked) {
    // Firefox MV2 naming.
    api.browserAction.onClicked.addListener(openApp);
}

api.runtime.onInstalled.addListener(() => {
    console.log("TabPaladin installed.");
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
