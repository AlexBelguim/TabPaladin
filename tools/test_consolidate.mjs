// Duplicate app roots must be merged, not lost.
//
// The Consolidate warning kept coming back after every pull, so pulls now heal
// automatically. This locks down the merge: children survive, the fullest
// folder wins, and nothing is deleted that could not be moved.
//
// Run: node tools/test_consolidate.mjs

let nextId = 300;
const nodes = new Map();

const mk = ({ parentId, title, url }) => {
    const n = { id: String(nextId++), parentId, title, dateAdded: Date.now() };
    if (url) n.url = url;
    nodes.set(n.id, n);
    return n;
};
const kids = (id) => [...nodes.values()].filter(n => n.parentId === id);
const removeTree = (id) => { for (const c of kids(id)) removeTree(c.id); nodes.delete(id); };

let failMoveFor = null;

globalThis.chrome = {
    storage: { local: { get: async () => ({}), set: async () => {} } },
    bookmarks: {
        getChildren: async (id) => kids(id),
        get: async (id) => (nodes.get(String(id)) ? [nodes.get(String(id))] : []),
        search: async ({ title }) => [...nodes.values()].filter(n => n.title === title),
        create: async (o) => mk({ parentId: String(o.parentId), title: o.title, url: o.url }),
        move: async (id, { parentId }) => {
            if (failMoveFor && String(id) === String(failMoveFor)) throw new Error('move blocked');
            nodes.get(String(id)).parentId = String(parentId);
            return nodes.get(String(id));
        },
        remove: async (id) => { nodes.delete(String(id)); },
        removeTree: async (id) => removeTree(String(id))
    }
};

const { StorageManager } = await import('../src/utils/storageManager.js');

const results = [];
const check = (n, pass, detail = '') => results.push({ n, pass, detail });

function reset() {
    nodes.clear();
    nextId = 300;
    nodes.set('0', { id: '0', title: '' });
    nodes.set('1', { id: '1', parentId: '0', title: 'Bookmarks Bar' });
    nodes.set('2', { id: '2', parentId: '0', title: 'Other Bookmarks' });
    failMoveFor = null;
    StorageManager.resetRootCache();
}

const TITLE = 'TabPaladin Workflows';

// 1. Two roots in different browser roots — the exact shape a pull recreates.
reset();
const big = mk({ parentId: '2', title: TITLE });
mk({ parentId: big.id, title: 'Funscript pipeline' });
mk({ parentId: big.id, title: 'TrueNAS rebuild' });
const small = mk({ parentId: '1', title: TITLE });
mk({ parentId: small.id, title: 'Kimi K3 research' });

let merged = await StorageManager.consolidateDuplicateRoots(TITLE);
let remaining = [...nodes.values()].filter(n => n.title === TITLE);
check('merges two roots into one', merged === 1 && remaining.length === 1,
    `merged=${merged}, ${remaining.length} left`);
check('survivor is the fuller folder', remaining[0]?.id === big.id,
    remaining[0]?.id === big.id ? 'kept the 2-child folder' : 'kept the wrong one');
check('no workflow is lost', kids(big.id).length === 3,
    `${kids(big.id).length} workflows (want 3)`);

// 2. Idempotent — running again with one root does nothing.
merged = await StorageManager.consolidateDuplicateRoots(TITLE);
check('second run is a no-op', merged === 0, `merged=${merged}`);

// 3. Three roots collapse in one pass.
reset();
const a = mk({ parentId: '2', title: TITLE });
mk({ parentId: a.id, title: 'one' });
mk({ parentId: a.id, title: 'two' });
const b = mk({ parentId: '1', title: TITLE });
mk({ parentId: b.id, title: 'three' });
const c = mk({ parentId: '2', title: TITLE });
mk({ parentId: c.id, title: 'four' });

merged = await StorageManager.consolidateDuplicateRoots(TITLE);
remaining = [...nodes.values()].filter(n => n.title === TITLE);
check('three roots collapse to one', merged === 2 && remaining.length === 1,
    `merged=${merged}, ${remaining.length} left`);
check('all four workflows survive', kids(remaining[0].id).length === 4,
    `${kids(remaining[0].id).length} workflows (want 4)`);

// 4. A child that refuses to move must not be deleted with its folder.
reset();
const keep = mk({ parentId: '2', title: TITLE });
mk({ parentId: keep.id, title: 'safe one' });
mk({ parentId: keep.id, title: 'safe two' });
const stuck = mk({ parentId: '1', title: TITLE });
const stuckChild = mk({ parentId: stuck.id, title: 'will not move' });
failMoveFor = stuckChild.id;

merged = await StorageManager.consolidateDuplicateRoots(TITLE);
check('folder with an unmovable child is not deleted', merged === 0 && nodes.has(stuck.id),
    `merged=${merged}, folder ${nodes.has(stuck.id) ? 'kept' : 'DELETED'}`);
check('the unmovable workflow still exists', nodes.has(stuckChild.id),
    nodes.has(stuckChild.id) ? 'intact' : 'LOST');

// 5. Unrelated folders of the same-ish name are untouched.
reset();
const real = mk({ parentId: '2', title: TITLE });
mk({ parentId: real.id, title: 'x' });
const decoy = mk({ parentId: '2', title: 'TabPaladin Workflows backup' });
mk({ parentId: decoy.id, title: 'archived' });
const dupe2 = mk({ parentId: '1', title: TITLE });
mk({ parentId: dupe2.id, title: 'y' });

merged = await StorageManager.consolidateDuplicateRoots(TITLE);
check('near-miss title is left alone', nodes.has(decoy.id) && kids(decoy.id).length === 1,
    nodes.has(decoy.id) ? 'backup folder intact' : 'BACKUP DELETED');

// ---------------------------------------------------------------------------
// resolveRootFolder heals on every call, and identity comes from a marker
// rather than a title, so the winner does not change as folders diverge.
// ---------------------------------------------------------------------------
const MARKER = '__tabpaladin_root__';
const markerOf = (folderId) => kids(folderId).find(k => k.title === MARKER);
const resolve = () => StorageManager.resolveRootFolder({
    title: TITLE, settingsKey: 'workflowRootBookmarkId', create: true
});

// 6. First resolve stamps a marker.
reset();
const only = mk({ parentId: '2', title: TITLE });
mk({ parentId: only.id, title: 'w1' });
let got = await resolve();
check('resolve stamps a marker on an unmarked root', !!markerOf(only.id) && got.id === only.id,
    markerOf(only.id) ? 'marker written' : 'NO MARKER');

// 7. Two roots are merged by resolve itself, without anyone calling consolidate.
reset();
const r1 = mk({ parentId: '2', title: TITLE });
mk({ parentId: r1.id, title: 'alpha' });
const r2 = mk({ parentId: '1', title: TITLE });
mk({ parentId: r2.id, title: 'beta' });
mk({ parentId: r2.id, title: 'gamma' });

got = await resolve();
let left = [...nodes.values()].filter(n => n.title === TITLE);
check('resolve merges duplicates by itself', left.length === 1, `${left.length} roots left`);
check('all workflows survive the merge',
    kids(got.id).filter(k => k.title !== MARKER).length === 3,
    `${kids(got.id).filter(k => k.title !== MARKER).length} workflows (want 3)`);

// 8. The older marker wins even when the other folder has more children —
//    the case that used to flip, because the old rule was "most children".
reset();
const oldRoot = mk({ parentId: '2', title: TITLE });
mk({ parentId: oldRoot.id, title: 'just one' });
mk({
    parentId: oldRoot.id, title: MARKER,
    url: 'data:application/json,' + encodeURIComponent(JSON.stringify({
        v: 1, rootId: 'aaa', createdAt: '2024-01-01T00:00:00.000Z'
    }))
});
const newRoot = mk({ parentId: '1', title: TITLE });
for (const t of ['a', 'b', 'c', 'd']) mk({ parentId: newRoot.id, title: t });
mk({
    parentId: newRoot.id, title: MARKER,
    url: 'data:application/json,' + encodeURIComponent(JSON.stringify({
        v: 1, rootId: 'bbb', createdAt: '2025-06-01T00:00:00.000Z'
    }))
});

got = await resolve();
check('older marker wins over the fuller folder', got.id === oldRoot.id,
    got.id === oldRoot.id ? 'kept the original root' : 'kept the newer one');
check('nothing is lost when the smaller folder wins',
    kids(got.id).filter(k => k.title !== MARKER).length === 5,
    `${kids(got.id).filter(k => k.title !== MARKER).length} workflows (want 5)`);
check('only one marker survives the merge',
    [...nodes.values()].filter(n => n.title === MARKER).length === 1,
    `${[...nodes.values()].filter(n => n.title === MARKER).length} markers`);

// ---------------------------------------------------------------------------
// 9. The real-world shape: two roots holding COPIES of the same workflows.
//    Merging must not concatenate them — that is what turned 4 workflows into
//    8, then 16, on every sync cycle.
// ---------------------------------------------------------------------------
const WF = ['Video', 'chaturbate.com', 'dddd', 'monday'];
const buildRoot = (parentId) => {
    const root = mk({ parentId, title: TITLE });
    for (const name of WF) {
        const f = mk({ parentId: root.id, title: name });
        mk({ parentId: f.id, title: name + ' tab', url: 'https://example.com/' + name });
    }
    return root;
};

reset();
const copyA = buildRoot('2');
buildRoot('1'); // an identical second root, as a pull would recreate

got = await resolve();
let names = kids(got.id).filter(k => k.title !== MARKER).map(k => k.title).sort();
check('identical roots merge without duplicating workflows',
    names.length === 4, `${names.length} workflows: ${names.join(', ')}`);
check('the four originals are all present',
    JSON.stringify(names) === JSON.stringify([...WF].sort()), names.join(', '));
check('only one root survives',
    [...nodes.values()].filter(n => n.title === TITLE).length === 1);

// Repeat the cycle — it must stay at four, not grow.
buildRoot('1');
got = await resolve();
names = kids(got.id).filter(k => k.title !== MARKER).map(k => k.title).sort();
check('a second cycle does not grow the list', names.length === 4, `${names.length} workflows`);

// 10. Same name, different contents — both must survive.
reset();
const rootX = mk({ parentId: '2', title: TITLE });
const wfX = mk({ parentId: rootX.id, title: 'monday' });
mk({ parentId: wfX.id, title: 'a', url: 'https://a.example' });
const rootY = mk({ parentId: '1', title: TITLE });
const wfY = mk({ parentId: rootY.id, title: 'monday' });
mk({ parentId: wfY.id, title: 'b', url: 'https://b.example' });
mk({ parentId: wfY.id, title: 'c', url: 'https://c.example' });

got = await resolve();
const mondays = kids(got.id).filter(k => k.title === 'monday');
check('same-named workflows with different tabs are both kept',
    mondays.length === 2, `${mondays.length} "monday" folders (want 2)`);

// 11. Stray markers collapse to one.
reset();
const rootM = mk({ parentId: '2', title: TITLE });
for (let i = 0; i < 4; i++) {
    mk({
        parentId: rootM.id, title: MARKER,
        url: 'data:application/json,' + encodeURIComponent(JSON.stringify({ v: 1, rootId: 'x' + i }))
    });
}
await resolve();
check('extra markers are collapsed to one',
    kids(rootM.id).filter(k => k.title === MARKER).length === 1,
    `${kids(rootM.id).filter(k => k.title === MARKER).length} markers`);

let failed = 0;
console.log('\n--- consolidate ---');
for (const r of results) {
    if (!r.pass) failed++;
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}${r.detail ? `\n      ${r.detail}` : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
