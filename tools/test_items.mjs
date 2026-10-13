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
//   6. Appends from the share sheet: at the end of each folder, one version
//      bump, logged in tree_ops with no history snapshot, never into notes,
//      workflows, pins or the archive; undo takes back only what is
//      unchanged; and the ops log is complete only for a gap made of appends
//      — every whole-tree change raises the floor, which starts at an
//      existing account's current version.
//
// Every database here is a single-account one that has been through the
// ownership migration, and the store is that account's (forUser(1)). What
// changes when there are two accounts is tools/test_tenancy.mjs's business.
//
// Run: node tools/test_items.mjs

import Database from '../server/node_modules/better-sqlite3/lib/index.js';
import { makeItemsStore, TREE_FORMAT } from '../server/items.js';
import { migrateUsers } from '../server/users.js';
import { migrateOwnership } from '../server/tenancy.js';
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

// A pre-multi-user database holding one account and, optionally, legacy
// history rows, upgraded the way the server boots it. Returns the account's
// store.
function freshDb(legacySnapshots = []) {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL, device_id TEXT, json TEXT NOT NULL
    );
    CREATE TABLE users (username TEXT PRIMARY KEY, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);`);
    db.prepare("INSERT INTO users VALUES ('alex', 'scrypt:x:y', '2026-01-01T00:00:00Z')").run();
    migrateUsers(db);
    for (const snap of legacySnapshots) {
        db.prepare('INSERT INTO snapshots (timestamp, device_id, json) VALUES (?, ?, ?)')
            .run(snap.timestamp, snap.deviceId, JSON.stringify(snap.json));
    }
    const store = makeItemsStore(db, { maxSnapshots: 10 });
    migrateOwnership(db, { env: {} });
    return { db, items: store.forUser(1) };
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
    const { db, items } = freshDb([{ timestamp: '2026-08-01T00:00:00Z', deviceId: 'extension', json: oldSnap }]);
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
    const enc2 = (o) => 'data:application/json,' + encodeURIComponent(JSON.stringify(o));
    const { db, items } = freshDb([{
        timestamp: '2026-08-01T00:00:00Z', deviceId: 'ext', json: {
            type: 'root', children: [
                { type: 'folder', title: 'Bookmarks Bar', children: [{ type: 'bookmark', title: 'HN', url: 'https://hn' }] },
                { type: 'folder', title: 'Other Bookmarks', children: [
                    { type: 'folder', title: 'Dev', children: [{ type: 'bookmark', title: 'MDN', url: 'https://mdn' }] },
                    { type: 'folder', title: 'TabPaladin Notes', children: [{ type: 'bookmark', title: 'N', url: enc2({ v: 1, content: 'x' }) }] }
                ] },
                { type: 'folder', title: 'Trash', children: [{ type: 'bookmark', title: 'junk', url: 'https://junk' }] }
            ]
        }
    }]);
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
    const { db, items } = freshDb();
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
        const { db: fresh, items: store } = freshDb();
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
    const { db, items } = freshDb();
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
    const { db, items } = freshDb();
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

console.log('\n7. Duplicate role folders are merged, nothing dropped');
{
    const { db, items } = freshDb();
    items.writeTree([
        { id: 'w1', kind: 'folder', title: 'TabPaladin Workflows', role: 'workflows', children: [
            { id: 'wf1', kind: 'folder', title: 'Old', children: [] }
        ]},
        { id: 'w2', kind: 'folder', title: 'TabPaladin Workflows', role: 'workflows', children: [
            { id: 'wf2', kind: 'folder', title: 'Yesterday', children: [
                { id: 't1', kind: 'bookmark', title: 't', url: 'https://t.example' }
            ]}
        ]}
    ]);
    const roots = items.readTree().roots;
    const wfRoots = allNodes(roots).filter(n => n.role === 'workflows');
    check('one workflows root remains', wfRoots.length === 1);
    check('both workflows live under it',
        wfRoots[0].children.map(c => c.title).join() === 'Old,Yesterday');
    check('the merged workflow kept its tabs', JSON.stringify(roots).includes('t.example'));

    // A database that already holds duplicates (written before the merge
    // existed) is healed at boot.
    db.prepare("INSERT INTO items (id, parent_id, position, kind, role, title, user_id) VALUES ('w3', NULL, 9, 'folder', 'workflows', 'Dup', 1)").run();
    db.prepare("INSERT INTO items (id, parent_id, position, kind, title, url, user_id) VALUES ('t3', 'w3', 0, 'bookmark', 'x', 'https://x3.example', 1)").run();
    const healed = items.healDuplicateRoles();
    const after = allNodes(items.readTree().roots);
    check('boot heal merges stored duplicates',
        healed.healed && after.filter(n => n.role === 'workflows').length === 1);
    check('boot heal keeps the duplicate\'s children', after.some(n => n.url === 'https://x3.example'));
    check('a clean tree is left alone', items.healDuplicateRoles().healed === false);
    db.close();
}

console.log('\n8. Appends from the share sheet, and the ops log');
{
    const { db, items } = freshDb();
    const meta = (key) => (db.prepare('SELECT value FROM user_tree_meta WHERE user_id = 1 AND key = ?').get(key) || {}).value ?? null;
    const opsRows = () => db.prepare('SELECT version, base_version, kind FROM tree_ops WHERE user_id = 1 ORDER BY version').all();
    const snaps = () => db.prepare('SELECT COUNT(*) AS n FROM snapshots WHERE user_id = 1').get().n;
    items.writeTree([
        { id: 'bm', kind: 'folder', role: 'bookmarks', title: 'Bookmarks', children: [
            { id: 'ai', kind: 'folder', title: 'AI', children: [
                { id: 'p1', kind: 'bookmark', title: 'Paper 1', url: 'https://arxiv.org/abs/1' },
                { id: 'p2', kind: 'bookmark', title: 'Paper 2', url: 'https://arxiv.org/abs/2' }
            ] },
            { id: 'dev', kind: 'folder', title: 'Dev', children: [] }
        ] },
        { id: 'nr', kind: 'folder', role: 'notes', title: 'Notes', children: [{ id: 'nb', kind: 'folder', title: 'Book', children: [] }] },
        { id: 'wf', kind: 'folder', role: 'workflows', title: 'Workflows', children: [{ id: 'wf1', kind: 'folder', title: 'Morning', children: [] }] },
        { id: 'pn', kind: 'folder', role: 'pins', title: 'Pinned', children: [] }
    ]);
    check('a whole-tree write sets the ops floor to its version', Number(meta('opsFloor')) === items.version());
    const v0 = items.version();
    const snaps0 = snaps();

    const r = items.appendToFolders({ targets: [{ folderId: 'ai' }, { folderId: 'dev' }], bookmark: { title: 'Paper 3', url: 'https://arxiv.org/abs/3' } });
    const ai = findFolder(items.readTree().roots, 'AI');
    check('appendToFolders files at the end of each folder, read back in place',
        r.created.length === 2 && ai.children.map(c => c.title).join() === 'Paper 1,Paper 2,Paper 3'
        && findFolder(items.readTree().roots, 'Dev').children[0].url === 'https://arxiv.org/abs/3');
    const positions = db.prepare("SELECT position FROM items WHERE user_id = 1 AND parent_id = 'ai' ORDER BY position").all().map(p => p.position);
    check('  at the next position', JSON.stringify(positions) === '[0,1,2]', JSON.stringify(positions));
    check('  bumping the version exactly once', r.baseVersion === v0 && r.version === items.version() && r.version > v0);
    check('  as one logged append and no history snapshot', opsRows().length === 1 && opsRows()[0].kind === 'append'
        && opsRows()[0].base_version === v0 && snaps() === snaps0);

    const again = items.appendToFolders({ targets: [{ folderId: 'ai' }], bookmark: { title: 'Paper 3', url: 'https://arxiv.org/abs/3' } });
    check('a folder already holding the URL is "already", with no version bump',
        again.created.length === 0 && again.already.length === 1 && again.version === r.version && items.version() === r.version);

    const refused = items.appendToFolders({
        targets: [{ folderId: 'nb' }, { folderId: 'wf1' }, { folderId: 'pn' }, { folderId: 'p1' }, { folderId: 'nowhere' }, { folderId: 'imp:src:1' }],
        bookmark: { title: 'x', url: 'https://x.example/' }
    });
    check('notes, workflows, pins, a bookmark, a missing id and the virtual archive are refused, saying why',
        refused.created.length === 0 && JSON.stringify(refused.failed.map(f => f.reason))
            === '["read-only","read-only","read-only","not-a-folder","missing","read-only"]', JSON.stringify(refused.failed));

    const made = items.appendToFolders({
        targets: [{ newFolder: { id: 'aaaaaaaaaaaaaaaa', title: 'Talks', parentId: 'bm' } }],
        bookmark: { title: 'Talk', url: 'https://youtube.com/watch?v=1' }
    });
    const madeAgain = items.appendToFolders({
        targets: [{ newFolder: { id: 'aaaaaaaaaaaaaaaa', title: 'Talks', parentId: 'bm' } }],
        bookmark: { title: 'Talk 2', url: 'https://youtube.com/watch?v=2' }
    });
    check('a new folder is created with the client\'s id, and a retry with that id reuses it',
        made.created.map(n => n.kind).join() === 'folder,bookmark' && madeAgain.created.map(n => n.kind).join() === 'bookmark'
        && findFolder(items.readTree().roots, 'Talks').children.length === 2
        && db.prepare("SELECT COUNT(*) AS n FROM items WHERE user_id = 1 AND title = 'Talks'").get().n === 1);
    const clash = items.appendToFolders({
        targets: [{ newFolder: { id: 'aaaaaaaaaaaaaaaa', title: 'Not talks', parentId: 'bm' } }],
        bookmark: { title: 'x', url: 'https://x.example/2' }
    });
    check('  the same id with another title is a conflict, not a rename', clash.created.length === 0 && clash.failed[0].reason === 'conflict');

    // The log: complete only for a gap made of appends.
    const full = items.opsSince(v0);
    check('opsSince from before the appends is complete, in order, folders before bookmarks',
        full.complete && full.ops.length === 3 && full.ops.every(o => o.kind === 'append')
        && full.ops[1].payload.nodes.map(n => n.kind).join() === 'folder,bookmark', JSON.stringify(full));
    check('  and from the current version there is nothing to miss', items.opsSince(items.version()).complete
        && items.opsSince(items.version()).ops.length === 0);
    check('  a version older than the floor, or one never held, is incomplete',
        !items.opsSince(v0 - 1).complete && !items.opsSince(items.version() + 5).complete && !items.opsSince('x').complete);

    const un = items.removeAppended([
        { id: made.created[1].id, kind: 'bookmark', url: 'https://youtube.com/watch?v=1' },
        { id: madeAgain.created[0].id, kind: 'bookmark', url: 'https://changed.example/' },
        { id: 'aaaaaaaaaaaaaaaa', kind: 'folder' }
    ]);
    check('removeAppended takes back an unchanged bookmark, keeps a changed one and a folder that is not empty',
        un.removed.length === 1 && JSON.stringify(un.kept) === JSON.stringify([madeAgain.created[0].id, 'aaaaaaaaaaaaaaaa'])
        && findFolder(items.readTree().roots, 'Talks').children.length === 1);
    check('  logged as an unappend, still a complete gap', opsRows().at(-1).kind === 'unappend' && items.opsSince(v0).complete
        && items.opsSince(v0).ops.length === 4);

    const top = items.appendToFolders({
        targets: [{ newFolder: { id: 'bbbbbbbbbbbbbbbb', title: 'Made at the top on the phone', parentId: '' }, existing: true }],
        bookmark: { title: 'Top', url: 'https://top.example/' }
    });
    const topRoots = items.readTree().roots;
    check('a folder a client made at the top level goes there, its link in it, and is not undone with the link',
        top.created.map(n => n.kind).join() === 'folder,bookmark' && topRoots.at(-1).id === 'bbbbbbbbbbbbbbbb'
        && topRoots.at(-1).children[0].url === 'https://top.example/' && top.filed[0].createdFolderIds.length === 0);
    check('  a new folder whose parent is not a folder of this tree is refused',
        items.appendToFolders({ targets: [{ newFolder: { id: 'cccccccccccccccc', title: 'x', parentId: 'nowhere' } }], bookmark: { title: 'x', url: 'https://x.example/3' } }).failed[0].reason === 'missing'
        && items.appendToFolders({ targets: [{ newFolder: { id: 'cccccccccccccccc', title: 'x', parentId: 'nb' } }], bookmark: { title: 'x', url: 'https://x.example/3' } }).failed[0].reason === 'missing');

    // A whole-tree change in the gap makes it incomplete, raises the floor
    // and forgets the log below it.
    for (const [what, change] of [
        ['writeTree', () => items.writeTree(items.readTree().roots, { deviceId: 'pc' })],
        ['upsertNote', () => items.applyNoteProposal({ kind: 'note', title: 'N', content: 'x', notebook: null })],
        ['reorderNotes', () => items.applyNoteProposal({ kind: 'reorder', content: JSON.stringify(['N']) })]
    ]) {
        const before = items.version();
        items.appendToFolders({ targets: [{ folderId: 'dev' }], bookmark: { title: what, url: `https://${what.toLowerCase()}.example/` } });
        change();
        check(`${what} raises the floor to its version and prunes the log`,
            Number(meta('opsFloor')) === items.version() && opsRows().length === 0, `${meta('opsFloor')} vs ${items.version()}`);
        check(`  so a gap across it is incomplete`, !items.opsSince(before).complete);
    }
    db.close();
}
{
    // A database from before this release: its accounts have versions but
    // no floor, and no log — nothing before now may look complete.
    const { db, items } = freshDb();
    items.writeTree([{ id: 'f', kind: 'folder', title: 'F', children: [] }]);
    const v1 = items.version();
    items.writeTree([{ id: 'f', kind: 'folder', title: 'F2', children: [] }]);
    db.prepare("DELETE FROM user_tree_meta WHERE key = 'opsFloor'").run();
    const store = makeItemsStore(db);
    check('initOpsFloors sets the floor of an existing account to its current version',
        store.initOpsFloors() === 1 && Number(db.prepare("SELECT value FROM user_tree_meta WHERE user_id = 1 AND key = 'opsFloor'").get().value) === items.version());
    check('  so the gap from before it is incomplete', !items.opsSince(v1).complete && items.opsSince(items.version()).complete);
    check('  and running it again changes nothing', store.initOpsFloors() === 0);
    db.close();
}

console.log(failures === 0 ? '\nAll items tests passed.\n' : `\n${failures} test(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
