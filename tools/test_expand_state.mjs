// Headless test for remembered open/closed cards on the extension's main page.
//
// What this locks down:
//   1. src/utils/expandState.js: saved state comes back, defaults hold for
//      cards never touched, junk in storage is ignored, a drag-hover open
//      lasts the session but is never written, writes are debounced, another
//      page's newer toggle is adopted, and the map is capped.
//   2. Pruning drops only tree ids that are gone — and never runs against an
//      empty working copy or after a failed startup pull, where every saved
//      folder would look deleted. Driven through the same guard the sidepanel
//      uses (pruneAgainstTree), against the real TreeStore.
//
// Run: node tools/test_expand_state.mjs

let failures = 0;
function check(name, cond, detail) {
    if (cond) {
        console.log(`  ok  ${name}`);
    } else {
        failures++;
        console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

// --- chrome mock ----------------------------------------------------------

const storageData = new Map();
const storageListeners = [];
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const local = {
    get: async (keys) => {
        const out = {};
        for (const k of [].concat(keys)) if (storageData.has(k)) out[k] = clone(storageData.get(k));
        return out;
    },
    set: async (obj) => {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) {
            changes[k] = { oldValue: storageData.get(k), newValue: clone(v) };
            storageData.set(k, clone(v));
        }
        for (const fn of storageListeners) fn(changes, 'local');
    },
    remove: async (k) => { storageData.delete(k); }
};
globalThis.chrome = {
    storage: { local, onChanged: { addListener: (fn) => storageListeners.push(fn) } }
};

const KEY = 'tpUiExpanded';
const stored = () => (storageData.get(KEY) || {}).cards || {};

storageData.set(KEY, {
    v: 1,
    cards: {
        aaaa: { o: 1, t: 5 },
        gone: { o: 1, t: 6 },
        __open_tabs__: { o: 0, t: 7 },
        'aigroup:news': { o: 0, t: 8 },
        'imp:3:x1': { o: 1, t: 9 },
        bad: { o: 'x', t: 1 },
        nul: null,
        noflag: { t: 3 }
    }
});

const { ExpandState, OPEN_TABS_KEY, aiGroupKey } = await import('../src/utils/expandState.js');
const { TreeStore } = await import('../src/utils/treeStore.js');

console.log('restore and defaults');
await Promise.all([TreeStore.load(), ExpandState.load()]);
check('a folder left open comes back open', ExpandState.isOpen('aaaa') === true);
check('Open Tabs remembered collapsed despite defaulting open', ExpandState.isOpen(OPEN_TABS_KEY, true) === false);
check('an AI group remembered collapsed, keyed by its name', ExpandState.isOpen(aiGroupKey('  News '), true) === false);
check('never-touched folder defaults closed', ExpandState.isOpen('never') === false);
check('never-touched Open Tabs / AI group default open',
    ExpandState.isOpen(OPEN_TABS_KEY + 'x', true) === true && ExpandState.isOpen(aiGroupKey('Shopping'), true) === true);
check('malformed entries are ignored (default applies)',
    ExpandState.isOpen('bad', true) === true && ExpandState.isOpen('nul', true) === true
    && ExpandState.isOpen('noflag', true) === true && ExpandState.isOpen('bad') === false);

console.log('session-only spring open');
ExpandState.openForSession('spring');
check('a drag-hover open is honoured this session', ExpandState.isOpen('spring') === true);
await ExpandState.flush();
check('…and never written', !('spring' in stored()));
ExpandState.openForSession('springclose');
ExpandState.set('springclose', false);
check('an explicit close overrides a drag-hover open', ExpandState.isOpen('springclose') === false);

console.log('writes');
ExpandState.set('bbbb', true);
check('a toggle is not written synchronously (debounced)', !('bbbb' in stored()));
await ExpandState.flush();
check('set() persists after the debounce/flush', stored().bbbb && stored().bbbb.o === 1 && stored().bbbb.t > 0);
check('the stored map keeps the v:1 shape', storageData.get(KEY).v === 1);
check('malformed entries are not written back', !('bad' in stored()) && !('nul' in stored()));

console.log('prune guard');
const before = JSON.stringify(storageData.get(KEY));
check('working copy is empty before any tree arrives', TreeStore.status().isEmpty === true);
let dropped = await ExpandState.pruneAgainstTree(TreeStore);
await ExpandState.flush();
check('empty working copy: nothing pruned', dropped === 0, String(dropped));
check('empty working copy: map untouched', JSON.stringify(storageData.get(KEY)) === before);
check('empty working copy: folders still remembered open', ExpandState.isOpen('gone') === true);

// A tree arrives the way a pull or another page's write lands: through storage.
await local.set({
    tpTree: {
        baseVersion: 3,
        dirty: false,
        rev: 'other-page',
        roots: [
            { id: 'aaaa', kind: 'folder', title: 'Bookmarks', role: 'bookmarks', children: [
                { id: 'bbbb', kind: 'folder', title: 'Work', children: [] }
            ]},
            { id: 'imports:root', kind: 'folder', title: 'TabPaladin Imports', virtual: true, readOnly: true, children: [
                { id: 'imp:3:x1', kind: 'bookmark', title: 'Saved post', url: 'https://reddit.com/x1' }
            ]}
        ]
    }
});
check('tree adopted (non-empty now)', TreeStore.status().isEmpty === false);

dropped = await ExpandState.pruneAgainstTree(TreeStore, { syncError: 'Failed to fetch' });
await ExpandState.flush();
check('startup sync error: nothing pruned', dropped === 0 && JSON.stringify(storageData.get(KEY)) === before);

dropped = await ExpandState.pruneAgainstTree(TreeStore);
await ExpandState.flush();
const after = stored();
check('prune drops only tree ids that are gone', dropped === 2 && !after.gone && !after.springclose,
    `${dropped} dropped; keys ${Object.keys(after).join(',')}`);
check('…keeps folders that still exist, virtual import ids included', after.aaaa && after.bbbb && after['imp:3:x1']);
check('…and never prunes UI keys', after.__open_tabs__ && after['aigroup:news']);

console.log('other pages');
await local.set({ [KEY]: { v: 1, cards: { aaaa: { o: 0, t: Date.now() + 1000 } } } });
check('a newer toggle from another TabPaladin page is adopted', ExpandState.isOpen('aaaa') === false);
await local.set({ [KEY]: { v: 1, cards: { bbbb: { o: 0, t: 1 } } } });
check('an older write from another page does not undo a newer local toggle', ExpandState.isOpen('bbbb') === true);
await local.set({ [KEY]: { v: 2, cards: { bbbb: { o: 0, t: Date.now() + 5000 } } } });
check('an unknown format version is ignored', ExpandState.isOpen('bbbb') === true);

console.log('cap');
for (let i = 0; i < 700; i++) ExpandState.set('k' + i, true);
await ExpandState.flush();
const capped = stored();
check('at most 500 entries are kept', Object.keys(capped).length === 500, String(Object.keys(capped).length));
check('the most recently touched survive', capped.k699 && capped.k500);

console.log('storage failures');
const realSet = local.set;
local.set = async () => { throw new Error('QUOTA_BYTES quota exceeded'); };
let threw = false;
try {
    ExpandState.set('quota', true);
    await ExpandState.flush();
} catch (e) { threw = true; }
local.set = realSet;
check('a failing write is swallowed', !threw);
check('…and the toggle still holds for this page', ExpandState.isOpen('quota') === true);

const realGet = local.get;
local.get = async () => { throw new Error('storage unavailable'); };
const fresh = await import('../src/utils/expandState.js?fresh=1');
threw = false;
try { await fresh.ExpandState.load(); } catch (e) { threw = true; }
local.get = realGet;
check('a failing read loads defaults instead of throwing',
    !threw && fresh.ExpandState.isOpen('aaaa') === false && fresh.ExpandState.isOpen(OPEN_TABS_KEY, true) === true);

console.log(failures === 0 ? '\nAll expand-state tests passed.\n' : `\n${failures} test(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
