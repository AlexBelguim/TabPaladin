// Which cards the user left open on this device.
//
// Every card on the main page (the Open Tabs column, its keyword groups, each
// folder column and every nested folder card) is collapsible, and every drop,
// pull or refresh rebuilds them. This remembers the user's choice per card so
// a rebuild — or a reload, or a browser restart — comes back the way it was.
//
// UI state only, and per device by nature, so it lives under its own
// storage.local key rather than in `settings`: that object is read in full and
// written back from several places (toggle writes would race them).
//
// Stored shape:
//   { v: 1, cards: { "<key>": { o: 1|0, t: <ms last touched> } } }
// Keys are tree node ids (stable across push/pull, virtual import ids
// included), OPEN_TABS_KEY, or tabGroupKey(name) — keyword group ids are
// regenerated on every regroup, so those go by name. Only explicit choices are
// stored; a missing key means the card's default.
//
// The map holds the folders of whichever account's working copy is here. When
// TreeStore sets a copy aside for another account's, that copy's entries go
// with it (entriesFor) and come back with it (restore).
//
// Never throws: losing this costs a few collapsed folders, nothing more.

// The browser's API, unless a page installed a platform first (see treeStore.js).
const api = globalThis.__tpPlatform || (typeof browser !== 'undefined' ? browser : (typeof chrome !== 'undefined' ? chrome : null));

export const EXPAND_KEY = 'tpUiExpanded';
export const OPEN_TABS_KEY = '__open_tabs__';
// The Open Tabs column's keyword groups (TabGrouper). The 'aigroup:' prefix
// is from when they were called AI groups; it stays, so remembered cards do.
export const tabGroupKey = (name) => `aigroup:${String(name || '').trim().toLowerCase()}`;
export const aiGroupKey = tabGroupKey;

// Oldest-touched entries go first past this, so the map cannot grow forever
// with folders opened once years ago.
const MAX_ENTRIES = 500;
const WRITE_DELAY_MS = 150;

// Keys that are not tree node ids. They are never pruned against the tree,
// only aged out by the cap.
const isUiKey = (k) => k.startsWith('__') || k.startsWith('aigroup:');

let cards = {};
let loadPromise = null;
let writeTimer = null;
// Opened by drag-hover (spring-loading). Honoured until the page closes, so
// the re-render after the drop keeps the folder open, but never written: a
// folder you only hovered over should not reopen tomorrow.
const session = new Set();

// Merge a stored map in, keeping whichever side touched an entry last. That
// is also how a toggle in another open TabPaladin page reaches this one.
function adopt(stored) {
    const incoming = stored && stored.v === 1 && stored.cards;
    if (!incoming || typeof incoming !== 'object') return;
    for (const [k, v] of Object.entries(incoming)) {
        if (!k || !v || (v.o !== 0 && v.o !== 1)) continue;
        const t = Number(v.t) || 0;
        if (!cards[k] || t > cards[k].t) cards[k] = { o: v.o, t };
    }
    evict();
}

function evict() {
    const keys = Object.keys(cards);
    if (keys.length <= MAX_ENTRIES) return;
    keys.sort((a, b) => cards[a].t - cards[b].t);
    for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete cards[k];
}

async function writeNow() {
    writeTimer = null;
    try {
        await api.storage.local.set({ [EXPAND_KEY]: { v: 1, cards } });
    } catch (e) { /* UI state only */ }
}

function scheduleWrite() {
    if (!writeTimer) writeTimer = setTimeout(writeNow, WRITE_DELAY_MS);
}

try {
    api.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes[EXPAND_KEY]) adopt(changes[EXPAND_KEY].newValue);
    });
} catch (e) { /* no storage events: other pages' toggles show on reload */ }

export const ExpandState = {
    load() {
        if (!loadPromise) {
            loadPromise = (async () => {
                try {
                    const data = await api.storage.local.get(EXPAND_KEY);
                    adopt(data && data[EXPAND_KEY]);
                } catch (e) { /* start from defaults */ }
            })();
        }
        return loadPromise;
    },

    isOpen(key, defaultOpen = false) {
        key = String(key);
        if (session.has(key)) return true;
        const e = cards[key];
        return e ? e.o === 1 : defaultOpen;
    },

    // An explicit open/close by the user. Supersedes a spring-open.
    set(key, open) {
        key = String(key);
        session.delete(key);
        cards[key] = { o: open ? 1 : 0, t: Date.now() };
        evict();
        scheduleWrite();
    },

    openForSession(key) {
        session.add(String(key));
    },

    // Drop tree-id keys whose node no longer exists. `exists` is async and
    // answers for one id; an id it cannot answer for is kept.
    async prune(exists) {
        let dropped = 0;
        for (const k of Object.keys(cards)) {
            if (isUiKey(k)) continue;
            let keep = true;
            try { keep = await exists(k); } catch (e) { keep = true; }
            if (!keep && cards[k]) {
                delete cards[k];
                dropped++;
            }
        }
        if (dropped) scheduleWrite();
        return dropped;
    },

    // The saved choices for tree-id cards that `belongs` claims: those of a
    // working copy being set aside, which carries them (see TreeStore) so that
    // pruning against the next account's tree loses none of them.
    async entriesFor(belongs) {
        await ExpandState.load();
        const out = {};
        for (const [k, v] of Object.entries(cards)) {
            if (isUiKey(k)) continue;
            let mine = false;
            try { mine = Boolean(belongs(k)); } catch (e) { mine = false; }
            if (mine) out[k] = { o: v.o, t: v.t };
        }
        return out;
    },

    // Put a set-aside copy's choices back as it comes back. A choice made
    // here since then wins; the rest count as touched now, so the cap drops
    // what the other account left behind before any of these.
    async restore(entries) {
        await ExpandState.load();
        if (!entries || typeof entries !== 'object') return 0;
        const now = Date.now();
        let restored = 0;
        for (const [k, v] of Object.entries(entries)) {
            if (!k || isUiKey(k) || !v || (v.o !== 0 && v.o !== 1)) continue;
            if (cards[k] && cards[k].t > (Number(v.t) || 0)) continue;
            cards[k] = { o: v.o, t: now };
            restored++;
        }
        if (restored) {
            evict();
            if (writeTimer) clearTimeout(writeTimer);
            await writeNow();
        }
        return restored;
    },

    // prune(), but only against a working copy that is really there. An empty
    // copy (fresh install, or a failed startup pull) makes every saved folder
    // look deleted, and pruning then would wipe the lot. `tree` is TreeStore,
    // or anything with the same status()/getNode().
    async pruneAgainstTree(tree, { syncError = null } = {}) {
        if (syncError) return 0;
        let st;
        try { st = tree.status(); } catch (e) { return 0; }
        if (!st || !st.loaded || st.isEmpty) return 0;
        return ExpandState.prune(async (id) => !!(await tree.getNode(id)));
    },

    // Write any pending change now (page closing).
    flush() {
        if (!writeTimer) return Promise.resolve();
        clearTimeout(writeTimer);
        return writeNow();
    }
};
