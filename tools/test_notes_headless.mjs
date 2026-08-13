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
        // Needed since resolveRootFolder merges duplicate roots by moving their
        // children across.
        move: async (id, { parentId }) => {
            const n = nodes.get(String(id));
            if (!n) throw new Error('not found');
            n.parentId = String(parentId);
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
// The root now also carries a __tabpaladin_root__ identity marker, which is
// itself a data: bookmark. It is bookkeeping, not a note, and is filtered out
// here exactly as parseNoteNode filters it in the app.
const snapNoteBookmarks = (snapNotes.children || []).filter(c => c.title !== '__tabpaladin_root__');
check('notes serialized as data-url bookmarks',
    snapNoteBookmarks.length === 1 && snapNoteBookmarks.every(c => c.type === 'bookmark' && c.url.startsWith('data:application/json,')));
const roundTripped = JSON.parse(decodeURIComponent(snapNoteBookmarks[0].url.slice('data:application/json,'.length)));
check('note content survives snapshot round-trip', roundTripped.content === 'new content [[Gamma]]');

// --- Root-folder identity ------------------------------------------------
// A bookmark id is only meaningful inside the tree that produced it. These
// cover the states where the extension used to bind to the wrong folder and
// silently show no notes while the PWA showed them all.

// 12. A persisted id that now points at an unrelated folder must be rejected.
const notesRootId = storageData.settings.notesRootBookmarkId;
const decoy = makeNode({ parentId: '2', title: 'Recipes' });
makeNode({ parentId: decoy.id, title: 'Soup', url: 'https://soup.example/' });
storageData.settings = { ...storageData.settings, notesRootBookmarkId: decoy.id };
StorageManager.resetRootCache();
const reresolved = await NotesManager.findNotesRoot();
check('stale root id pointing at a foreign folder is rejected',
    reresolved && reresolved.id === notesRootId && reresolved.title === 'TabPaladin Notes');
check('rejected id is replaced by the real one in settings',
    storageData.settings.notesRootBookmarkId === notesRootId);
check('notes are still visible after the mixup',
    (await NotesManager.listNotes()).some(n => n.title === 'Alpha'));
const afterMixup = await NotesManager.createNote('Filed correctly', 'x');
check('new notes land in the notes root, not the foreign folder',
    childrenOf(notesRootId).some(c => c.id === afterMixup.id) &&
    !childrenOf(decoy.id).some(c => c.id === afterMixup.id));
await NotesManager.deleteNote(afterMixup.id);

// 13. A second "TabPaladin Notes" folder (extension and PWA each made one)
// must not hide either side's notes.
const strayRoot = makeNode({ parentId: '1', title: 'TabPaladin Notes' });
makeNode({
    parentId: strayRoot.id,
    title: 'Phone Note',
    url: 'data:application/json,' + encodeURIComponent(JSON.stringify(
        { v: 1, content: 'written on the phone', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }))
});
StorageManager.resetRootCache();
const merged = await NotesManager.listNotes();
check('notes from a duplicate root are listed too',
    merged.some(n => n.title === 'Phone Note') && merged.some(n => n.title === 'Alpha'));
// Behaviour change: duplicates used to be tolerated and read around, so this
// asserted that all three were *reported*. resolveRootFolder now merges them
// the moment it sees them, so by the time anything lists notes there is one
// root left — which is why the Consolidate warning stopped coming back. The
// stray's notes are not lost; they moved, as the check above proves.
check('duplicate roots are merged away, not merely reported',
    (await NotesManager.findAllNotesRoots()).length === 1);
check('canonical root is still the persisted one',
    (await NotesManager.findNotesRoot()).id === notesRootId);
check('no duplicate note entries', new Set(merged.map(n => n.id)).size === merged.length);

// --- Markdown task lists -------------------------------------------------

// 14. Parsing
check('parses an unchecked task', (() => {
    const t = NotesManager.parseTaskLine('- [ ] buy milk');
    return t && t.checked === false && t.label === 'buy milk' && t.indent === 0;
})());
check('parses a checked task (lower and upper case)',
    NotesManager.parseTaskLine('- [x] done').checked === true &&
    NotesManager.parseTaskLine('- [X] done').checked === true);
check('parses * bullets and indentation', (() => {
    const t = NotesManager.parseTaskLine('    * [ ] nested');
    return t && t.indent === 4 && t.label === 'nested';
})());
check('a plain bullet is not a task', NotesManager.parseTaskLine('- just a bullet') === null);
check('prose mentioning [ ] is not a task', NotesManager.parseTaskLine('an array [ ] literal') === null);

// 15. Toggling writes back without disturbing the rest of the note
const doc = [
    '# Shopping',
    '',
    '- [ ] milk',
    '- [x] eggs',
    '  - [ ] the good ones',
    '- not a task',
    'trailing prose with [[Link]]'
].join('\n');
const t1 = NotesManager.toggleTaskAtLine(doc, 2);
check('unchecked -> checked', t1.split('\n')[2] === '- [x] milk');
check('toggle leaves every other line byte-identical', (() => {
    const a = doc.split('\n'), b = t1.split('\n');
    return a.length === b.length && a.every((l, i) => i === 2 || l === b[i]);
})());
const t2 = NotesManager.toggleTaskAtLine(t1, 3);
check('checked -> unchecked', t2.split('\n')[3] === '- [ ] eggs');
const t3 = NotesManager.toggleTaskAtLine(doc, 4);
check('indented task keeps its indentation', t3.split('\n')[4] === '  - [x] the good ones');
check('toggling a non-task line is a no-op', NotesManager.toggleTaskAtLine(doc, 5) === doc);
check('toggling out of range is a no-op',
    NotesManager.toggleTaskAtLine(doc, 99) === doc && NotesManager.toggleTaskAtLine(doc, -1) === doc);
check('round trip returns the original', NotesManager.toggleTaskAtLine(t1, 2) === doc);
check('empty content is safe', NotesManager.toggleTaskAtLine('', 0) === '' && NotesManager.toggleTaskAtLine(null, 0) === '');
check('* bullet toggles too', NotesManager.toggleTaskAtLine('* [ ] a', 0) === '* [x] a');
check('CRLF content keeps its carriage returns',
    NotesManager.toggleTaskAtLine('- [ ] a\r\n- [ ] b', 0) === '- [x] a\r\n- [ ] b');
check('label content is untouched by the toggle',
    NotesManager.toggleTaskAtLine('- [ ] pay $5 [50%] — see [[Note]]', 0) ===
    '- [x] pay $5 [50%] — see [[Note]]');

// 16. A toggle persisted through the store survives the round trip
const taskNote = await NotesManager.createNote('Tasks', '- [ ] one\n- [ ] two');
await NotesManager.updateNote(taskNote.id, {
    content: NotesManager.toggleTaskAtLine(taskNote.content, 1)
});
const storedTasks = (await NotesManager.listNotes()).find(n => n.id === taskNote.id);
check('toggled task persists through create/update/list', storedTasks.content === '- [ ] one\n- [x] two');

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
