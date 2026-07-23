// Headless test: mock chrome.bookmarks + storage.local, exercise NotesManager
// and the generalized root resolver.
let nextId = 100;
const nodes = new Map(); // id -> node
const childrenOf = (id) => [...nodes.values()].filter(n => n.parentId === id);

function makeNode({ parentId, title, url }) {
    const node = { id: String(nextId++), parentId, title, dateAdded: Date.now() };
    if (url) node.url = url;
    nodes.set(node.id, node);
    return node;
}
// Browser roots
makeNode({ parentId: null, title: 'Bookmarks Bar' }); // id 100 -> '100'? we need '2'
nodes.set('2', { id: '2', parentId: null, title: 'Other Bookmarks', dateAdded: Date.now() });

const storageData = {};

globalThis.chrome = {
    bookmarks: {
        create: async (opts) => makeNode(opts),
        get: async (id) => {
            const n = nodes.get(String(id));
            if (!n) throw new Error('not found');
            return [n];
        },
        getChildren: async (id) => childrenOf(String(id)),
        search: async ({ title }) => {
            const tokens = String(title).toLowerCase().split(/\s+/).filter(Boolean);
            return [...nodes.values()].filter(n =>
                tokens.every(t => (n.title || '').toLowerCase().includes(t)));
        },
        update: async (id, changes) => {
            const n = nodes.get(String(id));
            if (!n) throw new Error('not found');
            Object.assign(n, changes);
            return n;
        },
        remove: async (id) => { nodes.delete(String(id)); },
        removeTree: async (id) => {
            const kill = (nid) => { childrenOf(nid).forEach(c => kill(c.id)); nodes.delete(nid); };
            kill(String(id));
        },
        getTree: async () => {
            const build = (id) => {
                const n = nodes.get(id);
                const out = { ...n };
                if (!n.url) out.children = childrenOf(id).map(c => build(c.id));
                return out;
            };
            // Virtual root '0' with the browser roots as children.
            return [{ id: '0', title: '', children: [build('100'), build('2')] }];
        }
    },
    storage: {
        local: {
            get: async (key) => {
                if (key === undefined || key === null) return { ...storageData };
                if (Array.isArray(key)) {
                    const out = {};
                    key.forEach(k => { if (k in storageData) out[k] = storageData[k]; });
                    return out;
                }
                return key in storageData ? { [key]: storageData[key] } : {};
            },
            set: async (obj) => { Object.assign(storageData, obj); },
            remove: async (key) => { delete storageData[key]; }
        }
    }
};

const { StorageManager } = await import('../src/utils/storageManager.js');
const { NotesManager } = await import('../src/utils/notesManager.js');

let failures = 0;
function check(name, cond) {
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name);
    if (!cond) failures++;
}

// 1. Create notes → root created, id persisted
const alpha = await NotesManager.createNote('Alpha', 'links to [[Beta]] and https://example.com/?a=1&b=2');
const beta = await NotesManager.createNote('Beta', 'nothing here');
check('root id persisted in settings', !!storageData.settings?.notesRootBookmarkId);

// 2. Root is resolved through the same persisted id on subsequent calls
const root = await NotesManager.findNotesRoot();
check('root resolved with expected title', root && root.title === 'TabPaladin Notes');
check('root id matches persisted id', root.id === storageData.settings.notesRootBookmarkId);

// 3. List + hydration
const notes = await NotesManager.listNotes();
check('two notes listed', notes.length === 2);
const alphaLoaded = notes.find(n => n.title === 'Alpha');
check('content hydrated', alphaLoaded.content.includes('[[Beta]]'));

// 4. parseLinks
const { wiki, urls } = NotesManager.parseLinks(alphaLoaded.content);
check('wiki link parsed', wiki.length === 1 && wiki[0] === 'Beta');
check('url parsed with & intact', urls.length === 1 && urls[0] === 'https://example.com/?a=1&b=2');

// 5. Backlinks
const backlinks = await NotesManager.getBacklinks('Beta', beta.id);
check('backlink from Alpha to Beta', backlinks.length === 1 && backlinks[0].title === 'Alpha');

// 6. Rename rewrites links
await NotesManager.updateNote(beta.id, { title: 'Gamma' });
const alphaAfter = (await NotesManager.listNotes()).find(n => n.title === 'Alpha');
check('rename rewrote [[Beta]] -> [[Gamma]]', alphaAfter.content.includes('[[Gamma]]') && !alphaAfter.content.includes('[[Beta]]'));

// 7. Update content preserves createdAt, bumps updatedAt
const before = (await NotesManager.listNotes()).find(n => n.id === alpha.id);
await new Promise(r => setTimeout(r, 5));
await NotesManager.updateNote(alpha.id, { content: 'new content [[Gamma]]' });
const after = (await NotesManager.listNotes()).find(n => n.id === alpha.id);
check('createdAt preserved', before.createdAt === after.createdAt);
check('updatedAt bumped', after.updatedAt > before.updatedAt);
check('content updated', after.content === 'new content [[Gamma]]');

// 8. Duplicate roots: resolver sticks to persisted id
const persistedId = storageData.settings.notesRootBookmarkId;
makeNode({ parentId: '2', title: 'TabPaladin Notes' }); // empty duplicate
const rootAgain = await NotesManager.findNotesRoot();
check('duplicate root ignored, persisted id wins', rootAgain.id === persistedId);

// 9. Delete
await NotesManager.deleteNote(beta.id);
check('delete works', (await NotesManager.listNotes()).length === 1);

// 10. Workflows resolver still works after refactor (regression)
const wfRoot = await StorageManager.getWorkflowRoot();
check('workflow root created under Other Bookmarks', wfRoot && wfRoot.title === 'TabPaladin Workflows' && wfRoot.parentId === '2');
check('workflow root id persisted', storageData.settings.workflowRootBookmarkId === wfRoot.id);

// 11. Server push includes both roots and serializes notes intact
let pushedBody = null;
globalThis.fetch = async (url, opts) => {
    pushedBody = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ timestamp: '2026-01-01T00:00:00Z' }) };
};
const { BackendSync } = await import('../src/utils/backendSync.js');
await BackendSync.push(
    { url: 'http://test', token: 't' },
    [],
    storageData.settings.workflowRootBookmarkId,
    storageData.settings.notesRootBookmarkId
);
const snapOther = pushedBody.snapshot.children.find(c => /other/i.test(c.title));
const snapTitles = (snapOther.children || []).map(c => c.title);
check('snapshot includes workflows root', snapTitles.includes('TabPaladin Workflows'));
check('snapshot includes notes root', snapTitles.includes('TabPaladin Notes'));
const snapNotes = snapOther.children.find(c => c.title === 'TabPaladin Notes');
check('notes serialized as data-url bookmarks',
    snapNotes.children.length === 1 && snapNotes.children.every(c => c.type === 'bookmark' && c.url.startsWith('data:application/json,')));
const roundTripped = JSON.parse(decodeURIComponent(snapNotes.children[0].url.slice('data:application/json,'.length)));
check('note content survives snapshot round-trip', roundTripped.content === 'new content [[Gamma]]');

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
