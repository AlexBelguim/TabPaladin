// Headless regression test for the extension's tree working copy.
//
// Replaces test_notes_headless.mjs, test_consolidate.mjs and
// test_pull_safety.mjs: the browser bookmark tree, the root-identity markers
// and the destructive pull those tests guarded are gone. What matters now:
//   1. The managers (notes, pins, workflows) work against the working copy,
//      with roles instead of magic-title roots.
//   2. The chrome.bookmarks facade holds up for the sidepanel's call sites,
//      including notes appearing as data: bookmarks.
//   3. Git-style sync: pull replaces, push sends baseVersion, a conflict is
//      surfaced instead of silently overwriting, virtual nodes never push.
//   4. The imports subtree is read-only, with delete/file going through the
//      explicit server verbs.
//
// Run: node tools/test_treestore.mjs

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
function fireStorageChange(changes) {
    for (const fn of storageListeners) fn(changes, 'local');
}
globalThis.chrome = {
    storage: {
        local: {
            get: async (keys) => {
                const out = {};
                const list = Array.isArray(keys) ? keys : [keys];
                for (const k of list) if (storageData.has(k)) out[k] = storageData.get(k);
                return out;
            },
            set: async (obj) => {
                const changes = {};
                for (const [k, v] of Object.entries(obj)) {
                    changes[k] = { oldValue: storageData.get(k), newValue: JSON.parse(JSON.stringify(v)) };
                    storageData.set(k, changes[k].newValue);
                }
                fireStorageChange(changes);
            },
            remove: async (k) => { storageData.delete(k); fireStorageChange({ [k]: { newValue: undefined } }); }
        },
        onChanged: { addListener: (fn) => storageListeners.push(fn) }
    },
    bookmarks: {
        // Only importFromBrowser reads this.
        getTree: async () => [{
            id: '0', title: '',
            children: [
                { id: '1', title: 'Bookmarks Bar', children: [
                    { id: '10', title: 'HN', url: 'https://news.ycombinator.com' },
                    { id: '11', title: 'Old note', url: 'data:application/json,' + encodeURIComponent(JSON.stringify({ v: 1, content: 'legacy' })) },
                    { id: '12', title: '__tabpaladin_root__', url: 'data:application/json,%7B%7D' }
                ]},
                { id: '2', title: 'Other Bookmarks', children: [
                    { id: '20', title: 'TabPaladin Imports', children: [{ id: '21', title: 'x', url: 'https://x' }] }
                ]}
            ]
        }]
    }
};

// --- fake server ----------------------------------------------------------

const server = {
    version: 5,
    roots: [
        { id: 'f1', kind: 'folder', title: 'Stuff', children: [
            { id: 'b1', kind: 'bookmark', title: 'Example', url: 'https://example.com' }
        ]},
        { id: 'nr', kind: 'folder', title: 'TabPaladin Notes', role: 'notes', children: [
            { id: 'note1', kind: 'note', title: 'Groceries', payload: { content: '# Groceries\n- [ ] milk\nSee [[Pasta]]', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-05T00:00:00Z' } },
            { id: 'nb1', kind: 'folder', title: 'Recipes', children: [
                { id: 'note2', kind: 'note', title: 'Pasta', payload: { content: '# Pasta', createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' } }
            ]}
        ]},
        { id: 'imports:root', kind: 'folder', title: 'TabPaladin Imports', virtual: true, readOnly: true, children: [
            { id: 'imp:src:1', kind: 'folder', title: 'Reddit', virtual: true, children: [
                { id: 'imp:1:t3_1', kind: 'bookmark', title: 'r/x — Post', url: 'https://reddit.com/1', virtual: true },
                { id: 'imp:1:t3_2', kind: 'bookmark', title: 'r/x — Post 2', url: 'https://reddit.com/2', virtual: true }
            ]}
        ]}
    ]
};
const serverLog = [];

globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    serverLog.push(`${method} ${u}`);
    const json = (body, status = 200) => ({
        ok: status < 400, status, statusText: status === 409 ? 'Conflict' : 'OK',
        json: async () => body, text: async () => JSON.stringify(body)
    });

    if (u.endsWith('/api/health')) return json({ ok: true, version: 2, configured: true });
    if (u.endsWith('/api/tree/version')) return json({ ok: true, version: server.version });
    if (u.endsWith('/api/tree') && method === 'GET') {
        return json({ ok: true, version: server.version, roots: JSON.parse(JSON.stringify(server.roots)) });
    }
    if (u.endsWith('/api/tree') && method === 'PUT') {
        const body = JSON.parse(opts.body);
        if (!body.force && Number(body.baseVersion) !== server.version) {
            return json({ error: 'The tree changed on the server since your last pull. Pull, then push again.', version: server.version }, 409);
        }
        server.pushedRoots = body.roots;
        server.version += 1;
        // The server keeps the virtual subtree out of storage; mimic by storing
        // user roots and re-serving the virtual one on top.
        server.roots = [...body.roots, server.roots.find(r => r.id === 'imports:root')].filter(Boolean);
        return json({ ok: true, version: server.version });
    }
    if (/\/api\/imports\/1\/items\/(delete|file)$/.test(u) && method === 'POST') {
        const body = JSON.parse(opts.body);
        serverLog.push(`verb:${u.endsWith('delete') ? 'delete' : 'file'}:${body.externalIds.join(',')}`);
        return json({ ok: true });
    }
    throw new Error('unexpected fetch: ' + method + ' ' + u);
};

const cfg = { url: 'https://server.test', token: 'tok' };

// --- run ------------------------------------------------------------------

const { TreeStore } = await import('../src/utils/treeStore.js');
const { NotesManager } = await import('../src/utils/notesManager.js');
const { PinsManager } = await import('../src/utils/pinsManager.js');
const { StorageManager } = await import('../src/utils/storageManager.js');

console.log('\n1. Pull populates the working copy');
await TreeStore.sync.pull(cfg);
let status = TreeStore.status();
check('baseVersion tracks the server', status.baseVersion === 5, String(status.baseVersion));
check('not dirty after pull', status.dirty === false);

console.log('\n2. Managers work against roles, not magic titles');
const notes = await NotesManager.listNotes();
check('both notes listed', notes.length === 2, notes.map(n => n.title).join(', '));
check('notebook tagged', notes.find(n => n.title === 'Pasta').notebook === 'Recipes');
check('newest first', notes[0].title === 'Groceries');

const backlinks = await NotesManager.getBacklinks('Pasta');
check('backlinks found', backlinks.length === 1 && backlinks[0].title === 'Groceries');

const created = await NotesManager.createNote('Todo', '- [ ] thing');
check('created note has content', created.content === '- [ ] thing');
await NotesManager.updateNote(created.id, { title: 'Tasks' });
check('rename rewrites nothing when unlinked', (await NotesManager.listNotes()).length === 3);

// Rename with backlink rewrite
await NotesManager.updateNote('note2', { title: 'Pasta Carbonara' });
const groceries = (await NotesManager.listNotes()).find(n => n.title === 'Groceries');
check('rename rewrote [[wikilinks]] in other notes',
    groceries.content.includes('[[Pasta Carbonara]]'), groceries.content);

// Notebooks at any depth. Every operation is a local tree edit; none pushes.
const tick = () => new Promise(r => setTimeout(r, 5));
const pushesBefore = serverLog.filter(l => l.startsWith('PUT')).length;
const lib0 = await NotesManager.getLibrary();
check('library sees the existing notebook', lib0.notebooks.has('nb1') && lib0.notebooks.get('nb1').totalCount === 1);
const nbWork = await NotesManager.createNotebook('Work');
const nbMeet = await NotesManager.createNotebook('Meetings', nbWork.id);
await tick();
const q4 = await NotesManager.createNote('Q4 planning', '# Q4 planning\n- [ ] budget', { parentId: nbMeet.id });
check('createNote files into a nested notebook', (await TreeStore.getNode(nbMeet.id)).children.some(c => c.id === q4.id));
let listed = await NotesManager.listNotes();
const q4row = listed.find(n => n.id === q4.id);
check('nested notes are listed, tagged with their immediate notebook (back-compat)', q4row && q4row.notebook === 'Meetings');
check('listNotes adds notebookId and notebookPath',
    q4row.notebookId === nbMeet.id && JSON.stringify(q4row.notebookPath) === '["Work","Meetings"]');
check('listNotes is still newest first', listed[0].id === q4.id, listed.map(n => n.title).join(', '));
check('root notes have no notebook', listed.find(n => n.title === 'Groceries').notebookId === null);
const nbRecipesMeet = await NotesManager.createNotebook('Meetings', 'nb1');
const lib1 = await NotesManager.getLibrary();
check('same-named notebooks under different parents stay apart',
    nbRecipesMeet.id !== nbMeet.id
    && JSON.stringify(lib1.notebooks.get(nbRecipesMeet.id).path) === '["Recipes","Meetings"]'
    && lib1.notebooks.get(nbWork.id).totalCount === 1);

let refusedOp = null;
try { await NotesManager.createNotebook('work'); } catch (e) { refusedOp = e; }
check('a duplicate sibling notebook name is refused, ignoring case', refusedOp !== null);
refusedOp = null;
try { await NotesManager.createNotebook('   '); } catch (e) { refusedOp = e; }
check('a blank notebook name is refused', refusedOp !== null);
refusedOp = null;
try { await NotesManager.renameNotebook(nbWork.id, 'RECIPES'); } catch (e) { refusedOp = e; }
check('a rename onto a sibling name is refused', refusedOp !== null && (await TreeStore.getNode(nbWork.id)).title === 'Work');
await NotesManager.renameNotebook(nbWork.id, 'Work');
check('renaming a notebook to its own name is fine', (await TreeStore.getNode(nbWork.id)).title === 'Work');
refusedOp = null;
try { await NotesManager.createNote('Stray', '', { parentId: 'f1' }); } catch (e) { refusedOp = e; }
check('createNote refuses a parent outside the notes root', refusedOp !== null);

const q4Stamp = (await TreeStore.getNode(q4.id)).payload.updatedAt;
await tick();
await NotesManager.moveNote(q4.id, null);
check('moveNote to Unfiled re-parents', (await NotesManager.getLibrary()).notes.find(n => n.id === q4.id).notebookId === null);
check('moveNote leaves updatedAt unchanged', (await TreeStore.getNode(q4.id)).payload.updatedAt === q4Stamp);
await NotesManager.moveNote(q4.id, nbMeet.id);
check('moveNote back into the notebook', (await NotesManager.getLibrary()).notes.find(n => n.id === q4.id).notebookId === nbMeet.id);
refusedOp = null;
try { await NotesManager.moveNote(q4.id, 'f1'); } catch (e) { refusedOp = e; }
check('moveNote refuses a target outside the notes root', refusedOp !== null);

refusedOp = null;
try { await NotesManager.moveNotebook(nbWork.id, nbMeet.id); } catch (e) { refusedOp = e; }
check('moving a notebook into its descendant is refused', refusedOp !== null);
refusedOp = null;
try { await NotesManager.moveNotebook(nbWork.id, nbWork.id); } catch (e) { refusedOp = e; }
check('moving a notebook into itself is refused', refusedOp !== null);
refusedOp = null;
try { await NotesManager.moveNotebook(nbMeet.id, 'f1'); } catch (e) { refusedOp = e; }
check('moving a notebook outside the notes root is refused', refusedOp !== null);
refusedOp = null;
try { await NotesManager.moveNotebook(nbRecipesMeet.id, nbWork.id); } catch (e) { refusedOp = e; }
check('moving next to a same-named notebook is refused', refusedOp !== null);
await NotesManager.moveNotebook(nbRecipesMeet.id, null);
check('a notebook can move to the top level',
    JSON.stringify((await NotesManager.getLibrary()).notebooks.get(nbRecipesMeet.id).path) === '["Meetings"]');
await NotesManager.moveNotebook(nbRecipesMeet.id, 'nb1');

// Lift-delete: Work holds [Meetings (Q4 planning), Standup].
const standup = await NotesManager.createNote('Standup', 'daily', { parentId: nbWork.id });
const notesRootNode = await NotesManager.findNotesRoot();
const beforeIds = notesRootNode.children.map(c => c.id);
const workIndex = beforeIds.indexOf(nbWork.id);
const noteCount = (await NotesManager.listNotes()).length;
const lift = await NotesManager.deleteNotebook(nbWork.id);
const afterIds = (await NotesManager.findNotesRoot()).children.map(c => c.id);
check('deleteNotebook reports what moved', lift.moved === 2);
check('deleteNotebook lifts its children into its place, in order',
    JSON.stringify(afterIds) === JSON.stringify([
        ...beforeIds.slice(0, workIndex), nbMeet.id, standup.id, ...beforeIds.slice(workIndex + 1)
    ]), afterIds.join(','));
check('deleteNotebook keeps every note and id', (await NotesManager.listNotes()).length === noteCount
    && (await TreeStore.getNode(q4.id)) !== null && (await TreeStore.getNode(standup.id)) !== null
    && (await TreeStore.getNode(nbWork.id)) === null);
check('the lifted sub-notebook keeps its notes', (await TreeStore.getNode(nbMeet.id)).children.some(c => c.id === q4.id));

// Payload merge and rename side effects.
const q4Node = await TreeStore.getNode(q4.id);
await TreeStore.updateNode(q4.id, { payload: { ...q4Node.payload, pinned: true } });
await NotesManager.updateNote(q4.id, { content: '# Q4 planning\n- [x] budget' });
check('an unknown payload field survives an edit', (await TreeStore.getNode(q4.id)).payload.pinned === true);
check('the edit itself landed', (await TreeStore.getNode(q4.id)).payload.content.includes('[x] budget'));
const linker = await NotesManager.createNote('Linker', 'see [[Q4 planning]]');
const linkerNode = await TreeStore.getNode(linker.id);
await TreeStore.updateNode(linker.id, { payload: { ...linkerNode.payload, pinned: true } });
const linkerStamp = (await TreeStore.getNode(linker.id)).payload.updatedAt;
await tick();
await NotesManager.updateNote(q4.id, { title: 'Q4 plan' });
const linkerAfter = await TreeStore.getNode(linker.id);
check('a rename rewrites the link in the linking note', linkerAfter.payload.content === 'see [[Q4 plan]]', linkerAfter.payload.content);
check("a rename leaves the linking note's updatedAt unchanged", linkerAfter.payload.updatedAt === linkerStamp);
check("a rename keeps the linking note's other payload fields", linkerAfter.payload.pinned === true);
check('notebook and note operations never pushed', serverLog.filter(l => l.startsWith('PUT')).length === pushesBefore);
check('they left the working copy dirty for an explicit push', TreeStore.status().dirty === true);

check('no pins root yet -> empty list', (await PinsManager.list()).length === 0);
await PinsManager.add('github.com', 'GitHub');
const pins = await PinsManager.list();
check('pin added with https scheme', pins.length === 1 && pins[0].url === 'https://github.com');
let dup = null;
try { await PinsManager.add('https://github.com'); } catch (e) { dup = e; }
check('duplicate pin refused', dup !== null);

const wf = await StorageManager.saveWorkflow('Research', [
    { title: 'MDN', url: 'https://developer.mozilla.org' },
    { title: 'skipped', url: '' }
]);
check('workflow saved with one tab', wf.tabs.length === 1 && wf.name === 'Research');
const wfs = await StorageManager.getWorkflows();
check('workflow listed', wfs.length === 1 && wfs[0].tabs[0].url === 'https://developer.mozilla.org');
await StorageManager.removeTabFromWorkflow(wfs[0].tabs[0].id);
check('tab removed from workflow', (await StorageManager.getWorkflows())[0].tabs.length === 0);

console.log('\n3. The chrome.bookmarks facade');
const Tree = TreeStore.bookmarks;
const tree = await Tree.getTree();
check('virtual root wrapper has id 0', tree[0].id === '0');
const topTitles = tree[0].children.map(c => c.title);
check('top level lists all roots incl. virtual imports',
    topTitles.includes('Stuff') && topTitles.includes('TabPaladin Imports'), topTitles.join(', '));

const noteView = (await Tree.get('note1'))[0];
check('notes appear as data: bookmarks through the facade',
    noteView.url && noteView.url.startsWith('data:application/json,'));

const made = await Tree.create({ parentId: 'f1', title: 'Sub' });
check('folder created', made.parentId === 'f1' && made.kind === 'folder');
await Tree.move('b1', { parentId: made.id });
check('bookmark moved', (await Tree.getChildren(made.id)).some(c => c.id === 'b1'));
let cycle = null;
try { await Tree.move('f1', { parentId: made.id }); } catch (e) { cycle = e; }
check('cannot move a folder into its descendant', cycle !== null);

const found = await Tree.search({ title: 'Example' });
check('exact-title search works', found.length === 1 && found[0].id === 'b1');

const dataUrlNote = await Tree.create({
    parentId: 'nr', title: 'ViaFacade',
    url: 'data:application/json,' + encodeURIComponent(JSON.stringify({ v: 1, content: 'body' }))
});
check('creating a data: bookmark stores a real note',
    (await TreeStore.getNode(dataUrlNote.id)).kind === 'note'
    && (await TreeStore.getNode(dataUrlNote.id)).payload.content === 'body');

console.log('\n4. The imports subtree is read-only; verbs work');
let refused = null;
try { await Tree.remove('imp:1:t3_1'); } catch (e) { refused = e; }
check('direct remove inside imports refused', refused !== null);
refused = null;
try { await Tree.create({ parentId: 'imp:src:1', title: 'x', url: 'https://y' }); } catch (e) { refused = e; }
check('creating inside imports refused', refused !== null);

await TreeStore.imports.deleteItems(cfg, ['imp:1:t3_1']);
check('delete verb hit the server', serverLog.some(l => l === 'verb:delete:t3_1'));
check('deleted item gone locally', (await TreeStore.getNode('imp:1:t3_1')) === null);

await TreeStore.imports.fileItems(cfg, ['imp:1:t3_2'], 'f1');
check('file verb hit the server', serverLog.some(l => l === 'verb:file:t3_2'));
check('filed copy landed in the target folder',
    (await Tree.getChildren('f1')).some(c => c.url === 'https://reddit.com/2'));
check('filed item left the virtual subtree', (await TreeStore.getNode('imp:1:t3_2')) === null);

console.log('\n5. Git-style push');
status = TreeStore.status();
check('local edits marked dirty', status.dirty === true);
const pushed = await TreeStore.sync.push(cfg);
check('push bumped the version', pushed.version === 6, String(pushed.version));
check('dirty cleared after push', TreeStore.status().dirty === false);
const pushedIds = JSON.stringify(server.pushedRoots).match(/imp:|imports:root/);
check('virtual nodes never pushed', pushedIds === null);
check('note payload pushed, not a data: url',
    JSON.stringify(server.pushedRoots).includes('"kind":"note"')
    && !JSON.stringify(server.pushedRoots).includes('data:application/json'));

console.log('\n6. A stale push conflicts instead of overwriting');
server.version = 99; // someone else pushed
await Tree.create({ parentId: 'f1', title: 'local edit', url: 'https://local' });
let conflict = null;
try { await TreeStore.sync.push(cfg); } catch (e) { conflict = e; }
check('push refused with 409', conflict && conflict.status === 409, conflict && conflict.message);
check('server version surfaced', conflict && conflict.serverVersion === 99);
const forced = await TreeStore.sync.push(cfg, { force: true });
check('force push goes through', forced.version === 100);

console.log('\n6b. Legacy top-level ids and the background removal queue');
const viaLegacy = await Tree.getChildren('2');
check('getChildren("2") reads the top level', viaLegacy.length > 0
    && JSON.stringify(viaLegacy.map(c => c.id)) === JSON.stringify((await Tree.getChildren('0')).map(c => c.id)));
const legacySub = await Tree.getSubTree('2');
check('getSubTree("2") wraps the top level', Array.isArray(legacySub[0].children) && legacySub[0].children.length > 0);
check('get("2") returns a synthetic folder view', (await Tree.get('2'))[0].kind === 'folder');

// The background script queues removals instead of editing the tree; the
// storage event delivers the queue to this (live) context, which applies it
// against its own current copy — no read-modify-write race.
const doomed = await Tree.create({ parentId: 'f1', title: 'doomed', url: 'https://doomed' });
await chrome.storage.local.set({ tpPendingRemovals: [doomed.id, 'nonexistent'] });
await new Promise(r => setTimeout(r, 20));
check('queued removal applied to the live tree', (await TreeStore.getNode(doomed.id)) === null);
check('queue cleared after applying', !(await chrome.storage.local.get('tpPendingRemovals')).tpPendingRemovals);
check('unknown ids in the queue are ignored without error', true);

console.log('\n6c. Legacy/stale ids resolve or report absent, never silently empty');
check('unknown id is absent, not an exception', (await TreeStore.getNode('347')) === null);
const allBm = await Tree.getSubTree('2');
check('the top-level fallback card has a name', allBm[0].title === 'All bookmarks');
check('the top-level fallback exposes every root',
    allBm[0].children.length === (await Tree.getChildren('0')).length);

console.log('\n6d. Top level exposes roles, so "show everything" can skip app roots');
const top = await Tree.getChildren('0');
check('top level is reachable via id 0', top.length > 0);
check('app-managed roots are identifiable by role',
    top.some(n => n.role === 'notes'), top.map(n => `${n.title}:${n.role||'-'}`).join(', '));
const browsable = top.filter(n => n.kind === 'folder'
    && n.role !== 'pins' && n.role !== 'notes' && n.role !== 'workflows');
check('ordinary folders survive the filter used by the empty-focus default',
    browsable.some(n => n.title === 'Stuff'), browsable.map(n => n.title).join(', '));
check('the imports subtree is still offered for browsing',
    browsable.some(n => n.readOnly));

console.log('\n7. Import from the browser (one-time)');
const imported = await TreeStore.importFromBrowser();
check('items imported', imported.imported > 0, String(imported.imported));
const importedFolder = await TreeStore.getNode(imported.folderId);
check('the folder is named after the browser it came from',
    /bookmarks$/i.test(importedFolder.title), importedFolder.title);
const bmRoot = await TreeStore.findRoleRoot('bookmarks');
check('it lands inside the Bookmarks root, not at the top level',
    bmRoot && (bmRoot.children || []).some(c => c.id === imported.folderId));
const second = await TreeStore.importFromBrowser();
check('importing twice does not collide or merge',
    second.folderId !== imported.folderId
    && (await TreeStore.getNode(second.folderId)).title !== importedFolder.title,
    (await TreeStore.getNode(second.folderId)).title);
const flat = JSON.stringify(importedFolder);
check('legacy data: note converted to a note node', flat.includes('"kind":"note"') && flat.includes('legacy'));
check('sentinels dropped', !flat.includes('__tabpaladin_root__'));
check('browser TabPaladin Imports folder skipped', !flat.includes('TabPaladin Imports'));
check('plain bookmarks came through', flat.includes('news.ycombinator.com'));

console.log(failures === 0 ? '\nAll tree-store tests passed.\n' : `\n${failures} test(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
