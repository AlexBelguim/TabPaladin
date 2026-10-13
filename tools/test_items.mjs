// Headless regression test for the server's canonical tree store.
//
// What this locks down:
//   1. The one-time migration: a browser-tree snapshot becomes rows — roles
//      tagged, duplicate magic-title roots merged, notes decoded out of their
//      data: urls, sentinels dropped, the imports subtree skipped.
//   2. Round-trip stability: ids survive write -> read -> write unchanged, so
//      clients can hold onto them forever.
//   3. Versioning: every write bumps the version and lands in history.
//   4. Virtual nodes (the imports subtree a pull appends) are stripped on
//      write, never stored.
//   5. Notes SQL: listing with notebooks (and their paths), proposal
//      upsert-by-title that keeps unknown payload fields, notebook names
//      resolved the way the clients resolve them, reorder.
//
// Run: node tools/test_items.mjs

import Database from '../server/node_modules/better-sqlite3/lib/index.js';
import { makeItemsStore, TREE_FORMAT } from '../server/items.js';
import * as NM from '../src/utils/notesModel.js';

let failures = 0;
function check(name, cond, detail) {
    if (cond) {
        console.log(`  ok  ${name}`);
    } else {
        failures++;
        console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

const enc = (o) => 'data:application/json,' + encodeURIComponent(JSON.stringify(o));

function freshDb() {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL, device_id TEXT, json TEXT NOT NULL
    );`);
    return db;
}

function findFolder(roots, title) {
    for (const r of roots) {
        if (r.kind === 'folder' && r.title === title) return r;
        const hit = r.children ? findFolder(r.children, title) : null;
        if (hit) return hit;
    }
    return null;
}

function allNodes(roots, out = []) {
    for (const r of roots) {
        out.push(r);
        if (r.children) allNodes(r.children, out);
    }
    return out;
}

console.log('\n1. Migration from a browser-tree snapshot');
{
    const db = freshDb();
    const oldSnap = {
        version: 1, type: 'root', title: '',
        children: [
            { type: 'folder', title: 'Bookmarks Bar', nativeId: '1', children: [
                { type: 'bookmark', title: 'HN', url: 'https://news.ycombinator.com' }
            ]},
            { type: 'folder', title: 'Other Bookmarks', nativeId: '2', children: [
                { type: 'folder', title: 'TabPaladin Notes', children: [
                    { type: 'bookmark', title: '__tabpaladin_root__', url: enc({ v: 1, rootId: 'x' }) },
                    { type: 'bookmark', title: 'Groceries', url: enc({ v: 1, content: '# Groceries\n- [ ] milk', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' }) },
                    { type: 'folder', title: 'Recipes', children: [
                        { type: 'bookmark', title: 'Pasta', url: enc({ v: 1, content: '# Pasta', createdAt: '2026-01-03T00:00:00Z' }) }
                    ]}
                ]},
                { type: 'folder', title: 'TabPaladin Pinned', children: [
                    { type: 'bookmark', title: 'GitHub', url: 'https://github.com' }
                ]},
                { type: 'folder', title: 'TabPaladin Workflows', children: [
                    { type: 'folder', title: 'Research', children: [
                        { type: 'bookmark', title: '__tabpaladin_meta__', url: enc({ createdAt: '2026-02-01T00:00:00Z' }) },
                        { type: 'bookmark', title: 'MDN', url: 'https://developer.mozilla.org' }
                    ]}
                ]},
                { type: 'folder', title: 'TabPaladin Imports', children: [
                    { type: 'folder', title: 'Reddit', children: [{ type: 'bookmark', title: 'x', url: 'https://reddit.com/x' }] }
                ]}
            ]},
            // Duplicate notes root — the historic bug. Its children must merge in.
            { type: 'folder', title: 'TabPaladin Notes', children: [
                { type: 'bookmark', title: 'PhoneNote', url: enc({ v: 1, content: 'from phone' }) }
            ]},
            // Opera junk: an empty root is dropped.
            { type: 'folder', title: 'Trash', children: [] }
        ]
    };
    db.prepare('INSERT INTO snapshots (timestamp, device_id, json) VALUES (?, ?, ?)')
        .run('2026-08-01T00:00:00Z', 'extension', JSON.stringify(oldSnap));

    const items = makeItemsStore(db, { maxSnapshots: 10 });
    const mig = items.migrateFromLatestSnapshotIfNeeded();
    check('migration ran', mig.migrated === true, mig.reason);

    const { version, roots } = items.readTree();
    check('version is 1 after migration', version === 1, String(version));
    check('two top-level folders (dupe merged, Trash dropped)', roots.length === 2,
        roots.map(r => r.title).join(', '));

    const notes = findFolder(roots, 'TabPaladin Notes');
    check('notes root tagged with role', notes && notes.role === 'notes');
    check('root marker dropped', !(notes.children || []).some(c => c.title === '__tabpaladin_root__'));
    check('duplicate root children merged in',
        (notes.children || []).some(c => c.title === 'PhoneNote'));
    const groceries = (notes.children || []).find(c => c.title === 'Groceries');
    check('note decoded into a payload', groceries && groceries.kind === 'note'
        && groceries.payload.content.includes('milk'));

    const pins = findFolder(roots, 'TabPaladin Pinned');
    check('pins root tagged', pins && pins.role === 'pins');

    const wf = findFolder(roots, 'TabPaladin Workflows');
    check('workflows root tagged', wf && wf.role === 'workflows');
    const research = (wf.children || [])[0];
    check('meta sentinel folded into folder payload',
        research && !((research.children || []).some(c => c.title === '__tabpaladin_meta__'))
        && research.payload && research.payload.createdAt === '2026-02-01T00:00:00Z');

    check('imports subtree skipped entirely', findFolder(roots, 'TabPaladin Imports') === null);

    check('running migration again is a no-op',
        items.migrateFromLatestSnapshotIfNeeded().migrated === false);

    console.log('\n2. Round trip keeps ids; every write bumps the version');
    const idsBefore = allNodes(roots).map(n => n.id);
    check('every node has an id', idsBefore.every(id => typeof id === 'string' && id.length > 0));
    const v2 = items.writeTree(roots, { deviceId: 'test' });
    check('version bumped', v2 === version + 1, String(v2));
    const after = items.readTree();
    check('ids identical after round trip',
        JSON.stringify(allNodes(after.roots).map(n => n.id)) === JSON.stringify(idsBefore));

    const history = db.prepare('SELECT device_id, json FROM snapshots ORDER BY id DESC LIMIT 1').get();
    check('write recorded in history with new format',
        history.device_id === 'test' && JSON.parse(history.json).format === TREE_FORMAT);

    console.log('\n3. Virtual nodes are stripped on write');
    const withVirtual = [...after.roots, {
        id: 'imports:root', kind: 'folder', title: 'TabPaladin Imports', virtual: true, readOnly: true,
        children: [{ id: 'imp:1:t3_9', kind: 'bookmark', title: 'x', url: 'https://x', virtual: true }]
    }];
    items.writeTree(withVirtual, { deviceId: 'test' });
    check('virtual subtree not stored',
        findFolder(items.readTree().roots, 'TabPaladin Imports') === null);

    console.log('\n4. Notes SQL');
    const list = items.listNotes();
    check('all notes listed', list.length === 3, list.map(n => n.title).join(', '));
    check('notebook derived from parent folder',
        list.find(n => n.title === 'Pasta').notebook === 'Recipes');
    check('loose notes carry no notebook',
        list.find(n => n.title === 'Groceries').notebook === null);

    const vBefore = items.version();
    items.applyNoteProposal({ kind: 'note', title: 'Groceries', content: 'replaced body', notebook: null });
    check('same-title proposal replaces, not duplicates',
        items.listNotes().filter(n => n.title === 'Groceries').length === 1);
    check('replacement took', items.listNotes().find(n => n.title === 'Groceries').content === 'replaced body');
    check('proposal bumped the version', items.version() > vBefore);

    items.applyNoteProposal({ kind: 'note', title: 'NewNote', content: 'hi', notebook: 'Recipes' });
    check('new note filed into the requested notebook',
        items.listNotes().find(n => n.title === 'NewNote').notebook === 'Recipes');

    items.applyNoteProposal({ kind: 'note', title: 'Brand New Book', content: 'x', notebook: 'Journal' });
    check('missing notebook created on demand',
        items.listNotes().find(n => n.title === 'Brand New Book').notebook === 'Journal');

    items.applyNoteProposal({ kind: 'reorder', content: JSON.stringify(['PhoneNote', 'Groceries']) });
    const loose = items.listNotes().filter(n => !n.notebook).map(n => n.title);
    check('reorder applied to loose notes', loose[0] === 'PhoneNote', loose.join(', '));

    db.close();
}

console.log('\n4b. The Bookmarks root');
{
    const db = freshDb();
    const enc2 = (o) => 'data:application/json,' + encodeURIComponent(JSON.stringify(o));
    db.prepare('INSERT INTO snapshots (timestamp, device_id, json) VALUES (?, ?, ?)')
        .run('2026-08-01T00:00:00Z', 'ext', JSON.stringify({
            type: 'root', children: [
                { type: 'folder', title: 'Bookmarks Bar', children: [{ type: 'bookmark', title: 'HN', url: 'https://hn' }] },
                { type: 'folder', title: 'Other Bookmarks', children: [
                    { type: 'folder', title: 'Dev', children: [{ type: 'bookmark', title: 'MDN', url: 'https://mdn' }] },
                    { type: 'folder', title: 'TabPaladin Notes', children: [{ type: 'bookmark', title: 'N', url: enc2({ v: 1, content: 'x' }) }] }
                ] },
                { type: 'folder', title: 'Trash', children: [{ type: 'bookmark', title: 'junk', url: 'https://junk' }] }
            ]
        }));
    const items = makeItemsStore(db, { maxSnapshots: 10 });
    items.migrateFromLatestSnapshotIfNeeded();
    const r = items.ensureBookmarksRoot();

    check('the busiest ordinary root becomes Bookmarks', r.renamedFrom === 'Other Bookmarks', r.renamedFrom);
    const roots = items.readTree().roots;
    const bm = roots.find(n => n.role === 'bookmarks');
    check('it is titled Bookmarks', bm && bm.title === 'Bookmarks', bm && bm.title);
    check('other ordinary roots move inside it',
        (bm.children || []).some(c => c.title === 'Bookmarks Bar'));
    check('noise roots are left alone, not adopted',
        roots.some(n => n.title === 'Trash') && !(bm.children || []).some(c => c.title === 'Trash'));
    check('nothing is lost in the move',
        JSON.stringify(bm).includes('MDN') && JSON.stringify(bm).includes('HN'));
    check('bookmarksRootId points at it', items.bookmarksRootId() === bm.id);

    // Idempotent: a second call must not rename or move anything again.
    const before = JSON.stringify(items.readTree().roots);
    const again = items.ensureBookmarksRoot();
    check('a second call is a no-op', again.created === false && again.renamedFrom === undefined);
    check('the tree is untouched', JSON.stringify(items.readTree().roots) === before);

    // A user rename must stick.
    const rows = db.prepare("SELECT id FROM items WHERE role = 'bookmarks'").all();
    db.prepare("UPDATE items SET title = 'My stuff' WHERE id = ?").run(rows[0].id);
    items.ensureBookmarksRoot();
    check('a renamed root is not renamed back',
        items.readTree().roots.find(n => n.role === 'bookmarks').title === 'My stuff');
    db.close();
}

// Work > Meetings and Recipes > Meetings share a leaf name; Elsewhere is
// outside the notes root.
function nestedNotesTree() {
    const note = (id, title, extra = {}) => ({ id, kind: 'note', title, payload: { content: `# ${title}`, createdAt: '2026-01-01T00:00:00Z', ...extra } });
    return [
        { id: 'nr', kind: 'folder', title: 'TabPaladin Notes', role: 'notes', children: [
            note('n-loose', 'Loose'),
            { id: 'nb-work', kind: 'folder', title: 'Work', children: [
                note('n-standup', 'Standup', { pinned: true }),
                { id: 'nb-wmeet', kind: 'folder', title: 'Meetings', children: [note('n-q4', 'Q4 planning')] },
                { id: 'nb-sprint', kind: 'folder', title: 'Sprint', children: [] }
            ] },
            { id: 'nb-recipes', kind: 'folder', title: 'Recipes', children: [
                { id: 'nb-rmeet', kind: 'folder', title: 'Meetings', children: [note('n-bake', 'Bake-off')] }
            ] },
            { id: 'nb-journal', kind: 'folder', title: 'Journal', children: [note('n-day', 'Day 1')] }
        ] },
        { id: 'elsewhere', kind: 'folder', title: 'Elsewhere', children: [note('n-stray', 'Stray')] }
    ];
}

console.log('\n4c. Nested notebooks: paths in listNotes, proposals resolve like the clients');
{
    const db = freshDb();
    const items = makeItemsStore(db, { maxSnapshots: 10 });
    items.writeTree(nestedNotesTree());
    const byTitle = (t) => items.listNotes().find(n => n.title === t);
    const parentOf = (t) => db.prepare("SELECT parent_id FROM items WHERE kind = 'note' AND title = ?").get(t).parent_id;
    const folderCount = () => db.prepare("SELECT COUNT(*) AS n FROM items WHERE kind = 'folder'").get().n;

    check('nested note keeps its leaf notebook', byTitle('Q4 planning').notebook === 'Meetings');
    check('... and gains its path', JSON.stringify(byTitle('Q4 planning').notebookPath) === '["Work","Meetings"]');
    check('same-named notebooks get distinct paths', byTitle('Bake-off').notebookPath.join(' / ') === 'Recipes / Meetings');
    check('top-level notebook path is just its title', JSON.stringify(byTitle('Standup').notebookPath) === '["Work"]');
    check('a loose note has an empty path', byTitle('Loose').notebook === null && byTitle('Loose').notebookPath.length === 0);
    check('a note outside the notes root keeps its folder as its path',
        byTitle('Stray').notebook === 'Elsewhere' && JSON.stringify(byTitle('Stray').notebookPath) === '["Elsewhere"]');

    let before = folderCount();
    items.applyNoteProposal({ kind: 'note', title: 'Retro', content: 'x', notebook: 'Work / Meetings' });
    check('an "A / B" path files into the existing nested notebook', parentOf('Retro') === 'nb-wmeet');
    items.applyNoteProposal({ kind: 'note', title: 'Velocity', content: 'x', notebook: 'sprint' });
    check('a unique nested name (any case) files into it', parentOf('Velocity') === 'nb-sprint');
    items.applyNoteProposal({ kind: 'note', title: 'Diary', content: 'x', notebook: 'journal' });
    check('a top-level name matches ignoring case', parentOf('Diary') === 'nb-journal');
    check('none of those created a folder', folderCount() === before, `${before} -> ${folderCount()}`);

    items.applyNoteProposal({ kind: 'note', title: 'Agenda', content: 'x', notebook: 'Meetings' });
    const topMeet = db.prepare("SELECT id FROM items WHERE kind = 'folder' AND parent_id = 'nr' AND title = 'Meetings'").get();
    check('an ambiguous nested name creates a top-level notebook', topMeet && parentOf('Agenda') === topMeet.id);
    items.applyNoteProposal({ kind: 'note', title: 'Agenda 2', content: 'x', notebook: 'Meetings' });
    check('... which the next proposal finds first', parentOf('Agenda 2') === topMeet.id);

    before = folderCount();
    items.applyNoteProposal({ kind: 'note', title: 'Jan', content: 'x', notebook: 'Journal / 2026' });
    const y2026 = db.prepare("SELECT id, parent_id FROM items WHERE kind = 'folder' AND title = '2026'").get();
    check('a partly missing path creates only the missing part, inside the match',
        y2026 && y2026.parent_id === 'nb-journal' && parentOf('Jan') === y2026.id && folderCount() === before + 1);
    items.applyNoteProposal({ kind: 'note', title: 'Idea', content: 'x', notebook: 'Garden / Beds' });
    const garden = db.prepare("SELECT id, parent_id FROM items WHERE kind = 'folder' AND title = 'Garden'").get();
    const beds = db.prepare("SELECT id, parent_id FROM items WHERE kind = 'folder' AND title = 'Beds'").get();
    check('a wholly missing path is created top-down', garden && garden.parent_id === 'nr' && beds && beds.parent_id === garden.id
        && parentOf('Idea') === beds.id);

    items.applyNoteProposal({ kind: 'note', title: 'Standup', content: 'new body', notebook: 'Work' });
    const standup = JSON.parse(db.prepare("SELECT payload FROM items WHERE id = 'n-standup'").get().payload);
    check('a replacing proposal keeps the payload fields it does not own',
        standup.pinned === true && standup.content === 'new body' && standup.createdAt === '2026-01-01T00:00:00Z');
    check('... and stamps the edit', typeof standup.updatedAt === 'string');
    db.close();

    // The server and the clients' import links must send the same name to the
    // same notebook, or an LLM proposal and an import link disagree.
    const adapter = {
        children: (n) => n.children || [], isFolder: (n) => n.kind === 'folder', isNote: (n) => n.kind === 'note',
        id: (n) => n.id, title: (n) => n.title || '', fields: (n) => n.payload || {}
    };
    const lib = NM.buildLibrary(nestedNotesTree()[0], adapter);
    for (const name of ['Work', 'work', 'Work / Meetings', 'recipes / meetings', 'Sprint', 'Meetings', 'Journal / 2026', 'Nowhere']) {
        const fresh = freshDb();
        const store = makeItemsStore(fresh, { maxSnapshots: 10 });
        store.writeTree(nestedNotesTree());
        store.applyNoteProposal({ kind: 'note', title: 'Probe', content: 'x', notebook: name });
        const serverId = fresh.prepare("SELECT parent_id FROM items WHERE title = 'Probe'").get().parent_id;
        const client = NM.resolveNotebookByName(lib, name);
        // A created chain must match the client's segments, under its parent.
        const createdChain = () => {
            const titles = [];
            let id = serverId;
            for (let i = 0; i < client.create.segments.length; i++) {
                const row = fresh.prepare('SELECT title, parent_id FROM items WHERE id = ?').get(id);
                titles.unshift(row.title);
                id = row.parent_id;
            }
            return !lib.notebooks.has(serverId) && id === (client.create.parentId || lib.rootId)
                && JSON.stringify(titles) === JSON.stringify(client.create.segments);
        };
        const agree = client.id ? serverId === client.id : createdChain();
        check(`server and clients agree on "${name}"`, agree, `server ${serverId}, client ${JSON.stringify(client)}`);
        fresh.close();
    }
}

console.log('\n5. Empty server: no snapshot, nothing to migrate');
{
    const db = freshDb();
    const items = makeItemsStore(db, { maxSnapshots: 10 });
    const mig = items.migrateFromLatestSnapshotIfNeeded();
    check('no snapshots -> no migration', mig.migrated === false);
    check('version starts at 0', items.version() === 0);
    const v = items.writeTree([{ kind: 'folder', title: 'Stuff', children: [] }]);
    check('first write is version 1', v === 1);
    check('missing ids are generated', typeof items.readTree().roots[0].id === 'string');

    // A proposal against an empty tree creates the notes root itself.
    items.applyNoteProposal({ kind: 'note', title: 'First', content: 'x', notebook: null });
    check('notes root created on demand', items.listNotes().length === 1);
    db.close();
}

console.log('\n6. Normalization guards');
{
    const db = freshDb();
    const items = makeItemsStore(db, { maxSnapshots: 10 });
    items.writeTree([
        { id: 'dup', kind: 'folder', title: 'A', children: [{ id: 'dup', kind: 'bookmark', title: 'x', url: 'https://x' }] },
        { kind: 'bookmark', title: 'no url' },              // dropped: bookmark without url
        { kind: 'folder', title: 'B', role: 'bogus-role' }  // invalid role dropped
    ]);
    const { roots } = items.readTree();
    const nodes = allNodes(roots);
    check('duplicate ids deduplicated', new Set(nodes.map(n => n.id)).size === nodes.length);
    check('url-less bookmark dropped', !nodes.some(n => n.title === 'no url'));
    check('invalid role not stored', !nodes.some(n => n.role));
    db.close();
}

console.log(failures === 0 ? '\nAll items tests passed.\n' : `\n${failures} test(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
