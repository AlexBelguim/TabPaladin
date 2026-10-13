// Background script: opens the app page, workflow auto-sync, and the
// optional video scroll-seek content script.
// Compatible with both Chrome (service worker) and Firefox (event page).

const api = typeof browser !== 'undefined' ? browser : chrome;

const TRACK_STORE_KEY = 'tpOpenWorkflowTabs'; // { [tabId]: { workflowId, bookmarkId } }
const APP_PAGE = 'src/app/app.html';


// --- Who may talk to this script ---
//
// Only this extension's own pages: the sender is this extension, and the
// message comes from a page on the extension's own origin. A content script
// is this extension too, but it runs inside a web page, so its sender.url is
// that page's address and it is refused here — nothing a web page can make
// a content script say reaches tracking.
//
// Not !sender.tab: the app page (src/app/app.html) runs in a tab, so its
// messages carry one.
function fromExtensionPage(sender) {
    if (!sender || sender.id !== api.runtime.id) return false;
    const base = api.runtime.getURL('');
    return typeof sender.url === 'string' && sender.url.startsWith(base);
}


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


// --- One writer for tracking and the removal queue ---
//
// Every write to the tracking map and to the removal queue goes through this
// one chain. Closing several tracked tabs at once fires onRemoved for each of
// them together; when each handler read the map and the queue, changed them
// and wrote them back on its own, they overwrote one another and entries were
// lost.
//
// The queue is also read by the extension pages (TreeStore applies and
// clears it), so appending to it additionally holds the 'tp-pending-removals'
// lock that TreeStore takes to read and clear it: an id appended while a page
// takes the queue is never cleared with it unapplied.
let chain = Promise.resolve();
function serialized(fn) {
    const run = chain.then(() => fn());
    chain = run.catch(() => {});
    return run;
}

const REMOVALS_LOCK = 'tp-pending-removals';
function withRemovalsLock(fn) {
    const locks = typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function'
        ? navigator.locks : null;
    return locks ? locks.request(REMOVALS_LOCK, () => fn()) : fn();
}

// Tab ids seen closing while this script ran, so pruning (below) never takes
// an entry its onRemoved handler is still about to deal with.
const seenRemoved = new Set();

api.runtime.onInstalled.addListener((details) => {
    // Only a fresh install starts from nothing. An update keeps the map: the
    // tabs of open workflow windows keep their ids across it, and clearing it
    // silently stopped auto-sync for every workflow window open at the time.
    if (details && details.reason === 'install') {
        serialized(() => api.storage.local.remove(TRACK_STORE_KEY)).catch(() => {});
    }
    syncVideoSeek();
});

if (api.runtime.onStartup) {
    // A browser restart gives every tab a new id: the old entries name nothing.
    api.runtime.onStartup.addListener(() => {
        serialized(() => api.storage.local.remove(TRACK_STORE_KEY)).catch(() => {});
    });
}

// --- Workflow tab tracking ---
async function getTrackMap() {
    const data = await api.storage.local.get(TRACK_STORE_KEY);
    return (data && data[TRACK_STORE_KEY]) || {};
}

async function setTrackMap(map) {
    await api.storage.local.set({ [TRACK_STORE_KEY]: map });
}

// Entries whose tab is gone are dropped on each wake. A tab can close while
// nothing here listens (the update itself, a crash); dropping its entry only
// ever keeps a bookmark in its workflow, never removes one.
async function pruneGoneTabs() {
    const map = await getTrackMap();
    const ids = Object.keys(map);
    if (!ids.length) return;
    let open;
    try {
        open = new Set((await api.tabs.query({})).map(t => String(t.id)));
    } catch (e) {
        return;
    }
    let changed = false;
    for (const id of ids) {
        if (open.has(id) || seenRemoved.has(Number(id))) continue;
        delete map[id];
        changed = true;
    }
    if (changed) await setTrackMap(map);
}
// After the event that woke this script has been handed to its listener.
setTimeout(() => { serialized(pruneGoneTabs).catch(() => {}); }, 1000);

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;
    if (!fromExtensionPage(sender)) return;

    if (msg.type === 'TP_TRACK_WORKFLOW_TABS') {
        serialized(async () => {
            const map = await getTrackMap();
            for (const e of Array.isArray(msg.entries) ? msg.entries : []) {
                if (!e || e.tabId === undefined || e.tabId === null || !e.bookmarkId) continue;
                map[e.tabId] = { workflowId: msg.workflowId, bookmarkId: String(e.bookmarkId) };
            }
            await setTrackMap(map);
        }).then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: e.message }));
        return true; // async response
    }

    if (msg.type === 'TP_UNTRACK_WORKFLOW') {
        serialized(async () => {
            const map = await getTrackMap();
            for (const tabId of Object.keys(map)) {
                if (map[tabId].workflowId === msg.workflowId) delete map[tabId];
            }
            await setTrackMap(map);
        }).then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: e.message }));
        return true;
    }
});

// --- Workflow auto-sync without touching the tree ---
//
// This script must not edit the stored tree itself: an open TabPaladin page
// holds the working copy in memory and persists it on a debounce, so a
// read-modify-write from here would race it — last writer wins and one side's
// edit silently vanishes. Instead the background only appends the node id to a
// pending-removals queue; treeStore (which owns the tree) applies the queue on
// its next load or storage event, against its own current copy.
const PENDING_REMOVALS_KEY = 'tpPendingRemovals';

async function queueTreeRemoval(id) {
    await withRemovalsLock(async () => {
        const data = await api.storage.local.get(PENDING_REMOVALS_KEY);
        const list = (data && data[PENDING_REMOVALS_KEY]) || [];
        if (!list.includes(id)) list.push(id);
        await api.storage.local.set({ [PENDING_REMOVALS_KEY]: list });
    });
}

// Closing a whole workflow window keeps its tabs in the workflow; closing
// single tabs still removes them. (Owner decision; the helper in a later
// release makes this a setting.)
const WINDOW_CLOSE_POLICY = 'keep';

// Auto-sync: when a tracked tab closes, remove its bookmark from the workflow.
// The removal is queued before the entry is untracked: stopped in between, the
// same id is queued again at worst, which is harmless.
async function untrackClosedTab(tabId, removeInfo) {
    const map = await getTrackMap();
    const entry = map[tabId];
    if (!entry) return;
    const windowClosing = Boolean(removeInfo && removeInfo.isWindowClosing);
    if (!(windowClosing && WINDOW_CLOSE_POLICY === 'keep')) {
        await queueTreeRemoval(entry.bookmarkId);
    }
    delete map[tabId];
    await setTrackMap(map);
}

api.tabs.onRemoved.addListener((tabId, removeInfo) => {
    seenRemoved.add(tabId);
    serialized(() => untrackClosedTab(tabId, removeInfo))
        .catch((e) => console.warn('TabPaladin autosync error:', e));
});


// --- Video scroll-seek (opt-in) ---
//
// Scroll the wheel over a fullscreen video to seek. It needs access to every
// site, which is not something to ask for at install for a side feature, so
// the host permission is optional and the script is registered only while
// Settings has it switched on and the permission is granted.
//
// The switch is its own key, tpVideoSeek, rather than a field of `settings`:
// the content script reads no storage at all, and this script reads
// `settings` only once, to carry an earlier version's choice over.
const VIDEO_SEEK_ID = 'tp-video-seek';
const VIDEO_SEEK_KEY = 'tpVideoSeek';
const ALL_SITES = { origins: ['<all_urls>'] };

async function videoSeekWanted() {
    const data = await api.storage.local.get([VIDEO_SEEK_KEY, 'settings']);
    if (typeof data[VIDEO_SEEK_KEY] === 'boolean') return data[VIDEO_SEEK_KEY];
    const wanted = Boolean(data.settings && data.settings.videoSeek);
    await api.storage.local.set({ [VIDEO_SEEK_KEY]: wanted });
    return wanted;
}

// Pages that loaded the script before it was switched off keep it until
// they reload: tell them. Best effort; a tab without it just says no.
async function tellOpenTabs(type) {
    let tabs = [];
    try { tabs = await api.tabs.query({}); } catch (e) { return; }
    for (const t of tabs) {
        if (!t || t.id === undefined || !/^(https?|file):/.test(String(t.url || ''))) continue;
        try {
            const sent = api.tabs.sendMessage(t.id, { type });
            if (sent && typeof sent.catch === 'function') sent.catch(() => {});
        } catch (e) { /* no script there */ }
    }
}

// One at a time: a wake, a permission change and the switch itself can all
// ask at once, and two registrations of the same id fail.
let videoSeekRun = Promise.resolve();
function syncVideoSeek() {
    videoSeekRun = videoSeekRun.then(syncVideoSeekNow, syncVideoSeekNow);
    return videoSeekRun;
}

async function syncVideoSeekNow() {
    if (!api.scripting || !api.scripting.registerContentScripts) return;
    try {
        const wanted = await videoSeekWanted();
        const granted = await api.permissions.contains(ALL_SITES);
        const existing = await api.scripting.getRegisteredContentScripts({ ids: [VIDEO_SEEK_ID] });
        if (wanted && granted && !existing.length) {
            const script = {
                id: VIDEO_SEEK_ID,
                matches: ['<all_urls>'],
                js: ['src/content/videoSeek.js'],
                runAt: 'document_idle'
            };
            try {
                await api.scripting.registerContentScripts([{ ...script, persistAcrossSessions: true }]);
            } catch (e) {
                // Older Firefox lacks persistAcrossSessions; this runs on every
                // background wake, so a session-only registration is enough.
                await api.scripting.registerContentScripts([script]);
            }
            await tellOpenTabs('tp-video-seek-on');
        } else if ((!wanted || !granted) && existing.length) {
            await api.scripting.unregisterContentScripts({ ids: [VIDEO_SEEK_ID] });
            await tellOpenTabs('tp-video-seek-off');
        }
    } catch (e) {
        console.warn('TabPaladin: could not update video seek', e);
    }
}

syncVideoSeek();
api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[VIDEO_SEEK_KEY]) syncVideoSeek();
});
if (api.permissions && api.permissions.onAdded) {
    api.permissions.onAdded.addListener(syncVideoSeek);
    api.permissions.onRemoved.addListener(syncVideoSeek);
}
