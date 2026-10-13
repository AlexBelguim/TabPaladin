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
//   5. Notes SQL: listing with notebooks, proposal upsert-by-title, reorder.
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

console.log(failures === 0 ? '\nAll items tests passed.\n' : `\n${failures} test(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
