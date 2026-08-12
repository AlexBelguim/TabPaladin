// Headless regression test for the destructive-pull bugs.
//
// Two failures this locks down, both in BackendSync.applyPull:
//   1. The root wipe was unconditional while the refill was guarded by the
//      incoming child count, so a snapshot carrying an empty root child deleted
//      everything under the matching browser root and restored nothing.
//   2. Orphan snapshot roots (ones that match no browser root — easy across
//      Chrome/Firefox, whose root titles differ) were created unconditionally,
//      so every pull stacked another copy, each containing its own
//      "TabPaladin Workflows".
//
// Run: node tools/test_pull_safety.mjs

let nextId = 500;
const nodes = new Map();

function makeNode({ parentId, title, url }) {
    const node = { id: String(nextId++), parentId, title, dateAdded: Date.now() };
    if (url) node.url = url;
    nodes.set(node.id, node);
    return node;
}

function reset() {
    nodes.clear();
    nextId = 500;
    nodes.set('0', { id: '0', parentId: null, title: '' });
    nodes.set('1', { id: '1', parentId: '0', title: 'Bookmarks Bar' });
    nodes.set('2', { id: '2', parentId: '0', title: 'Other Bookmarks' });
}

const childrenOf = (id) => [...nodes.values()].filter(n => n.parentId === id);

function removeTree(id) {
    for (const c of childrenOf(id)) removeTree(c.id);
    nodes.delete(id);
}

globalThis.chrome = {
    bookmarks: {
        async getChildren(id) { return childrenOf(id); },
        async get(id) { const n = nodes.get(String(id)); return n ? [n] : []; },
        async create({ parentId, title, url }) { return makeNode({ parentId: String(parentId), title, url }); },
        async remove(id) { nodes.delete(String(id)); },
        async removeTree(id) { removeTree(String(id)); },
        async search() { return []; }
    }
};
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

// Quiet the pull's very chatty logging; keep warnings.
const realLog = console.log;
console.log = () => {};

const { BackendSync } = await import('../src/utils/backendSync.js');

const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

// ---------------------------------------------------------------------------
// 1. A snapshot whose matching root has no children must not wipe that root.
// ---------------------------------------------------------------------------
reset();
const notesRoot = makeNode({ parentId: '2', title: 'TabPaladin Notes' });
makeNode({ parentId: notesRoot.id, title: 'PWA install checklist', url: 'data:application/json,%7B%7D' });
makeNode({ parentId: notesRoot.id, title: 'Tailscale serve setup', url: 'data:application/json,%7B%7D' });
const unrelated = makeNode({ parentId: '2', title: 'Tax documents' });
makeNode({ parentId: unrelated.id, title: 'Receipt', url: 'https://example.com/r' });

await BackendSync.applyPull({
    title: 'root',
    children: [{ title: 'Other Bookmarks', nativeId: '2', children: [] }]
});

const notesSurvived = nodes.has(notesRoot.id) && childrenOf(notesRoot.id).length === 2;
const unrelatedSurvived = nodes.has(unrelated.id);
check('empty snapshot root does not delete existing notes', notesSurvived,
    notesSurvived ? '2 notes intact' : 'NOTES DESTROYED');
check('empty snapshot root does not delete unrelated bookmarks', unrelatedSurvived,
    unrelatedSurvived ? '"Tax documents" intact' : 'UNRELATED BOOKMARKS DESTROYED');

// ---------------------------------------------------------------------------
// 2. A non-empty snapshot must still replace the root's contents.
// ---------------------------------------------------------------------------
reset();
const stale = makeNode({ parentId: '2', title: 'Stale folder' });
makeNode({ parentId: stale.id, title: 'old', url: 'https://old.example' });

await BackendSync.applyPull({
    title: 'root',
    children: [{
        title: 'Other Bookmarks',
        nativeId: '2',
        children: [{ type: 'folder', title: 'TabPaladin Notes', children: [
            { type: 'bookmark', title: 'Fresh note', url: 'data:application/json,%7B%7D' }
        ]}]
    }]
});

const afterKids = childrenOf('2');
const replaced = afterKids.length === 1 && afterKids[0].title === 'TabPaladin Notes';
check('non-empty snapshot still replaces root contents', replaced,
    `root now holds: ${afterKids.map(k => k.title).join(', ') || '(nothing)'}`);

// ---------------------------------------------------------------------------
// 3. Repeated pulls of an unmatched (orphan) root must not stack duplicates.
// ---------------------------------------------------------------------------
reset();
const orphanSnapshot = {
    title: 'root',
    children: [{
        // No nativeId, and a title no browser root normalizes to.
        title: 'Firefox Toolbar Import',
        children: [{ type: 'folder', title: 'TabPaladin Workflows', children: [
            { type: 'bookmark', title: 'Funscript pipeline', url: 'https://example.com/1' }
        ]}]
    }]
};

await BackendSync.applyPull(orphanSnapshot);
await BackendSync.applyPull(orphanSnapshot);
await BackendSync.applyPull(orphanSnapshot);

const orphanCopies = childrenOf('2').filter(c => c.title === 'Firefox Toolbar Import');
const workflowRoots = [...nodes.values()].filter(n => n.title === 'TabPaladin Workflows');
check('three pulls create one orphan folder, not three', orphanCopies.length === 1,
    `${orphanCopies.length} copies of "Firefox Toolbar Import"`);
check('only one "TabPaladin Workflows" exists after repeated pulls', workflowRoots.length === 1,
    `${workflowRoots.length} workflow roots`);

const inside = workflowRoots.length === 1 ? childrenOf(workflowRoots[0].id) : [];
check('reused orphan folder is refilled, not left empty', inside.length === 1,
    `${inside.length} workflows inside`);

// ---------------------------------------------------------------------------
// 4. A round trip must be lossless: push then pull leaves the tree unchanged.
//    This is what "both directions full" buys — a filtered push replayed into a
//    replacing pull used to delete whatever the filter dropped.
// ---------------------------------------------------------------------------
reset();
const wfRoot = makeNode({ parentId: '2', title: 'TabPaladin Workflows' });
makeNode({ parentId: wfRoot.id, title: 'Funscript pipeline' });
const keepMe = makeNode({ parentId: '2', title: 'Unrelated folder' });
makeNode({ parentId: keepMe.id, title: 'A bookmark', url: 'https://example.com' });
makeNode({ parentId: '1', title: 'Toolbar link', url: 'https://toolbar.example' });

// Push with focus arguments set — the old code would have narrowed the snapshot.
globalThis.chrome.bookmarks.getTree = async () => {
    const build = (id) => {
        const n = { ...nodes.get(id) };
        if (!n.url) n.children = childrenOf(id).map(c => build(c.id));
        return n;
    };
    return [build('0')];
};
let captured = null;
globalThis.fetch = async (_url, opts) => {
    captured = JSON.parse(opts.body).snapshot;
    return { ok: true, json: async () => ({ ok: true }) };
};
await BackendSync.push({ url: 'http://x', token: '' }, [wfRoot.id], wfRoot.id, null);

const pushedOther = (captured.children || []).find(c => c.nativeId === '2');
const pushedNames = (pushedOther?.children || []).map(c => c.title).sort();
check('focused push still sends the whole tree', pushedNames.join(',') === 'TabPaladin Workflows,Unrelated folder',
    `Other Bookmarks in snapshot: ${pushedNames.join(', ') || '(empty)'}`);

await BackendSync.applyPull(captured);
const afterNames = childrenOf('2').map(c => c.title).sort();
const wfCount = [...nodes.values()].filter(n => n.title === 'TabPaladin Workflows').length;
check('round trip preserves unrelated folders', afterNames.join(',') === 'TabPaladin Workflows,Unrelated folder',
    `Other Bookmarks now: ${afterNames.join(', ') || '(empty)'}`);
check('round trip does not duplicate the workflows root', wfCount === 1,
    `${wfCount} "TabPaladin Workflows" folders`);

// ---------------------------------------------------------------------------
console.log = realLog;
let failed = 0;
console.log('\n--- pull safety ---');
for (const r of results) {
    if (!r.pass) failed++;
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n      ${r.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
