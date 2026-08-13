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

let failed = 0;
console.log('\n--- consolidate ---');
for (const r of results) {
    if (!r.pass) failed++;
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}${r.detail ? `\n      ${r.detail}` : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
