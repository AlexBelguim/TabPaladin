// Tests for per-account data separation: the ownership migration, the scoped
// stores, account deletion, and an end-to-end upgrade of a database written by
// the server as it was before accounts were separated.
//
// What this locks down, in order of how much it would hurt to get wrong:
//   1. Upgrading a single-account database loses nothing. Every table that
//      existed before comes out of the migration identical apart from the new
//      columns, every row is owned by the one account, archives whose source
//      had been removed are adopted rather than stranded, and the owner's
//      devices keep the tree version they hold.
//   2. The migration refuses rather than guesses (two accounts and no
//      TENANCY_OWNER, a newer schema), a refusal rolls everything back, and
//      the marker it leaves stops a restart loop from rotating backups away.
//   3. Two accounts never see or overwrite each other's tree, notes, inbox,
//      history, imports or prefs, and their tree versions never coincide.
//   4. Deleting an account removes exactly its data, and its id is never
//      handed out again.
//   5. No SQL statement in the server touches an account-owned table without
//      naming user_id, except an explicit allowlist, each entry with a reason.
//   6. End to end: the pre-multi-user server, checked out of git history, fills
//      a data directory through its own API; this server upgrades it, serves
//      the same data to the right account, verify_tenancy.js proves the
//      copies match, the legacy AUTH_TOKEN still acts as the owner, and a
//      second account sees none of it.
//
// Run: node tools/test_tenancy.mjs [--ports 18983,18984] [--legacy-rev <commit>]
//
// Section 6 starts real servers on the two ports (defaults above) and needs
// git to read the old server out of history; without git it is skipped.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from '../server/node_modules/better-sqlite3/lib/index.js';
import { makeItemsStore, ForeignIdError } from '../server/items.js';
import { hashPassword } from '../server/security.js';
import { initSchema as initImportsSchema, makeStore as makeImportsStore } from '../server/imports/store.js';
import { buildImportsTree } from '../server/imports/project.js';
import {
    migrateUsers, bootstrapAdmin, setSchemaVersion, insertUser, SCHEMA_VERSION
} from '../server/users.js';
import {
    initTenancySchema, migrateOwnership, digestTables, preflight, writeRefusal, checkOwnership,
    deleteUserData, nextUserId, bumpTreeVersion, userStats, serverId, DIGEST_TABLES, PER_USER_TABLES, MARKER_FILE
} from '../server/tenancy.js';
import { migrateShares, makeSharesStore } from '../server/shares.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const SERVER = path.join(REPO, 'server');

const arg = (name, fallback = null) => {
    const i = process.argv.indexOf('--' + name);
    return i === -1 ? fallback : process.argv[i + 1];
};
const [OLD_PORT, NEW_PORT] = (arg('ports') || '18983,18984').split(',').map(Number);
// main as it was before accounts were separated — the code the owner's
// database was last written by.
const LEGACY_REV = arg('legacy-rev') || '4c285f5';

let failures = 0;
function check(name, cond, detail) {
    if (cond) {
        console.log(`  ok  ${name}`);
    } else {
        failures++;
        console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
}
const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };

// --- A frozen pre-multi-user database ---------------------------------------
//
// The schema exactly as the server before this change created it (index.js,
// items.js, users.js migrateUsers, imports/store.js), user_version 2, holding
// one of everything: a tree, a legacy browser-tree history blob plus format-2
// history, an inbox, proposals, share tokens, a Reddit source with
// credentials, OAuth state and tombstones, an X source, and two orphaned
// archives — rows whose source had been removed, which is what removing a
// source used to leave behind.

const T = '2026-09-01T00:00:00.000Z';
const FUTURE = '2099-01-01T00:00:00.000Z';

function v2Fixture(file = ':memory:', { users = ['alex'] } = {}) {
    const db = new Database(file);
    db.exec(`
        CREATE TABLE snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, device_id TEXT, json TEXT NOT NULL);
        CREATE INDEX idx_snapshots_ts ON snapshots(timestamp DESC);
        CREATE TABLE shared_links (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, title TEXT, created_at TEXT NOT NULL);
        CREATE INDEX idx_shared_created ON shared_links(created_at DESC);
        CREATE TABLE share_tokens (token TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
        CREATE TABLE note_proposals (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL,
            notebook TEXT, kind TEXT NOT NULL DEFAULT 'note');
        CREATE TABLE users (username TEXT PRIMARY KEY, password_hash TEXT NOT NULL, created_at TEXT NOT NULL,
            id INTEGER, role TEXT NOT NULL DEFAULT 'user');
        CREATE UNIQUE INDEX idx_users_id ON users(id);
        CREATE TABLE sessions (token TEXT PRIMARY KEY, username TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
        CREATE INDEX idx_sessions_expires ON sessions(expires_at);
        CREATE TABLE items (id TEXT PRIMARY KEY, parent_id TEXT, position INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL, role TEXT,
            title TEXT NOT NULL DEFAULT '', url TEXT, payload TEXT, created_at TEXT, updated_at TEXT);
        CREATE INDEX idx_items_parent ON items(parent_id, position);
        CREATE TABLE tree_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE import_sources (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, label TEXT,
            config TEXT NOT NULL DEFAULT '{}', credentials TEXT, enabled INTEGER NOT NULL DEFAULT 1,
            interval_minutes INTEGER NOT NULL DEFAULT 60, last_run TEXT, last_status TEXT, last_error TEXT, created_at TEXT NOT NULL);
        CREATE TABLE import_items (id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER NOT NULL, external_id TEXT NOT NULL,
            url TEXT NOT NULL, title TEXT, author TEXT, container TEXT, created_utc TEXT, imported_at TEXT NOT NULL,
            removed_at_source TEXT, extra TEXT, filed_at TEXT, UNIQUE (source_id, external_id));
        CREATE INDEX idx_import_items_source ON import_items(source_id, created_utc DESC);
        CREATE TABLE import_oauth_state (state TEXT PRIMARY KEY, source_id INTEGER NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE import_dismissed (source_id INTEGER NOT NULL, external_id TEXT NOT NULL, dismissed_at TEXT NOT NULL,
            PRIMARY KEY (source_id, external_id));
    `);
    users.forEach((name, i) => {
        db.prepare("INSERT INTO users (username, password_hash, created_at, id, role) VALUES (?, 'scrypt:x:y', ?, ?, ?)")
            .run(name, T, i + 1, i === 0 ? 'admin' : 'user');
    });
    if (users.length) db.prepare("INSERT INTO sessions VALUES ('sess-alex', ?, ?, ?)").run(users[0], T, FUTURE);
    const item = db.prepare('INSERT INTO items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    item.run('bm', null, 0, 'folder', 'bookmarks', 'Bookmarks', null, null, T, T);
    item.run('b1', 'bm', 0, 'bookmark', null, 'HN', 'https://news.ycombinator.com', null, T, T);
    item.run('nr', null, 1, 'folder', 'notes', 'Notes', null, null, T, T);
    item.run('n1', 'nr', 0, 'note', null, 'Groceries', null, JSON.stringify({ content: '# Groceries\n- milk', createdAt: T, updatedAt: T }), T, T);
    item.run('nb', 'nr', 1, 'folder', null, 'Recipes', null, null, T, T);
    item.run('n2', 'nb', 0, 'note', null, 'Pasta', null, JSON.stringify({ content: '# Pasta', createdAt: T, updatedAt: T }), T, T);
    item.run('wf', null, 2, 'folder', 'workflows', 'TabPaladin Workflows', null, null, T, T);
    item.run('wf1', 'wf', 0, 'folder', null, 'Research', null, JSON.stringify({ createdAt: T }), T, T);
    item.run('wt1', 'wf1', 0, 'bookmark', null, 'MDN', 'https://developer.mozilla.org', null, T, T);
    db.prepare("INSERT INTO tree_meta VALUES ('treeVersion', '41'), ('migratedFrom', '2026-08-01T00:00:00Z')").run();
    const snap = db.prepare('INSERT INTO snapshots (timestamp, device_id, json) VALUES (?, ?, ?)');
    snap.run('2026-08-01T00:00:00Z', 'extension', JSON.stringify({ type: 'root', children: [{ type: 'folder', title: 'Other Bookmarks', children: [] }] }));
    snap.run('2026-09-01T00:00:00Z', 'migration', JSON.stringify({ format: 2, roots: [] }));
    snap.run('2026-09-02T00:00:00Z', 'pwa', JSON.stringify({ format: 2, roots: [{ id: 'bm', kind: 'folder', title: 'Bookmarks', children: [] }] }));
    db.prepare("INSERT INTO shared_links (url, title, created_at) VALUES ('https://a.example', 'A', ?), ('https://b.example', NULL, ?)").run(T, T);
    db.prepare("INSERT INTO share_tokens VALUES ('tok-live', ?, ?), ('tok-dead', ?, ?)").run(T, FUTURE, T, T);
    db.prepare("INSERT INTO note_proposals (title, content, created_at, notebook, kind) VALUES ('Idea', '# Idea', ?, 'Recipes', 'note'), ('Reorder notes', '[\"Pasta\"]', ?, NULL, 'reorder')").run(T, T);
    db.prepare(`INSERT INTO import_sources (id, provider, label, config, credentials, created_at)
        VALUES (1, 'reddit', 'Reddit saved', '{"clientId":"cid","clientSecret":"sec"}', '{"refreshToken":"r"}', ?),
               (2, 'x', 'X saved', '{"listTitle":"Saved"}', NULL, ?)`).run(T, T);
    const ii = db.prepare('INSERT INTO import_items (source_id, external_id, url, title, imported_at) VALUES (?, ?, ?, ?, ?)');
    ii.run(1, 't3_1', 'https://www.reddit.com/r/a/comments/1/', 'Post 1', T);
    ii.run(1, 't3_2', 'https://www.reddit.com/r/a/comments/2/', 'Post 2', T);
    ii.run(2, 'x:100', 'https://x.com/a/status/100', 'Tweet', T);
    ii.run(7, 'x:200', 'https://x.com/b/status/200', 'Orphaned tweet', T);
    ii.run(7, 'x:201', 'https://x.com/b/status/201', 'Orphaned tweet 2', T);
    const tomb = db.prepare('INSERT INTO import_dismissed VALUES (?, ?, ?)');
    tomb.run(1, 't3_9', T);
    tomb.run(7, 'x:202', T);
    tomb.run(9, 't3_77', T);
    db.prepare("INSERT INTO import_oauth_state VALUES ('state-1', 1, ?)").run(T);
    db.pragma('user_version = 2');
    return db;
}

// What the server does at boot, headless: the schema block, the first admin,
// the migration, the share inbox's columns and ops floors, the version.
async function upgrade(db, env = {}, { failAt = null, maxSnapshots = 200 } = {}) {
    migrateUsers(db);
    initTenancySchema(db);
    initImportsSchema(db);
    const store = makeItemsStore(db, { maxSnapshots });
    const boot = await bootstrapAdmin(db, env);
    if (!boot.ok) throw new Error(boot.error);
    const result = migrateOwnership(db, { env, failAt, bootstrappedUserIds: boot.created ? [boot.created.id] : [] });
    migrateShares(db);
    store.initOpsFloors();
    setSchemaVersion(db);
    return { store, result, boot };
}

const hasColumn = (db, table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
const nullOwners = (db) => PER_USER_TABLES.reduce((n, t) =>
    n + (hasColumn(db, t, 'user_id') ? db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id IS NULL`).get().n : 0), 0);
const ownersOf = (db) => [...new Set(PER_USER_TABLES.flatMap(t =>
    hasColumn(db, t, 'user_id') ? db.prepare(`SELECT DISTINCT user_id FROM ${t}`).all().map(r => r.user_id) : []))];

// Everything one account owns, hashed: if this does not move, nothing of
// theirs was read into or written over by anyone else.
function accountDigest(db, uid) {
    const h = crypto.createHash('sha256');
    const dump = (sql) => h.update(JSON.stringify(db.prepare(sql).raw().all(uid)));
    dump('SELECT * FROM items WHERE user_id = ? ORDER BY id');
    dump('SELECT * FROM snapshots WHERE user_id = ? ORDER BY id');
    dump('SELECT * FROM shared_links WHERE user_id = ? ORDER BY id');
    dump('SELECT * FROM share_tokens WHERE user_id = ? ORDER BY token');
    dump('SELECT * FROM note_proposals WHERE user_id = ? ORDER BY id');
    dump('SELECT * FROM import_sources WHERE user_id = ? ORDER BY id');
    dump('SELECT * FROM import_items WHERE source_id IN (SELECT id FROM import_sources WHERE user_id = ?) ORDER BY id');
    dump('SELECT * FROM import_dismissed WHERE source_id IN (SELECT id FROM import_sources WHERE user_id = ?) ORDER BY source_id, external_id');
    dump('SELECT * FROM user_tree_meta WHERE user_id = ? ORDER BY key');
    dump('SELECT * FROM user_prefs WHERE user_id = ? ORDER BY key');
    return h.digest('hex');
}

const sameDigests = (a, b) => Object.keys(a).every(t => b[t] && a[t].n === b[t].n && a[t].sha256 === b[t].sha256);

// --- 1. The migration -----------------------------------------------------------

async function migrationTests() {
    console.log('\n1. Upgrading a single-account database loses nothing');
    {
        const db = v2Fixture();
        const before = digestTables(db, DIGEST_TABLES);
        const { result } = await upgrade(db);
        check('the migration ran', result.migrated === true);
        check('everything assigned to alex', result.owner.username === 'alex' && result.total > 0, JSON.stringify(result.assigned));
        const after = digestTables(db, DIGEST_TABLES, { like: before, exclude: { import_sources: new Set([7, 9]) } });
        for (const t of DIGEST_TABLES) {
            check(`${t}: ${before[t].n} rows, identical after`, after[t] && after[t].n === before[t].n && after[t].sha256 === before[t].sha256,
                `${before[t].n} vs ${after[t] && after[t].n}`);
        }
        check('no row is left without an owner', nullOwners(db) === 0);
        check('alex owns every row', JSON.stringify(ownersOf(db)) === '[1]', JSON.stringify(ownersOf(db)));
        const placeholders = db.prepare('SELECT id, provider, label, deleted_at, enabled, user_id FROM import_sources WHERE id IN (7, 9) ORDER BY id').all();
        check('both orphaned archives adopted as removed sources',
            placeholders.length === 2 && placeholders.every(p => p.deleted_at && p.enabled === 0 && p.user_id === 1), JSON.stringify(placeholders));
        check('their provider is inferred', placeholders[0].provider === 'x' && placeholders[1].provider === 'reddit'
            && placeholders[0].label === 'Removed X source #7', JSON.stringify(placeholders));
        check('every archive row resolves to a source', checkOwnership(db).length === 0, checkOwnership(db).join('; '));
        const v = db.prepare("SELECT value FROM user_tree_meta WHERE user_id = 1 AND key = 'treeVersion'").get();
        check("alex keeps tree version 41, so devices don't see a conflict", v && v.value === '41');
        check('the version sequence starts there', db.prepare("SELECT value FROM server_meta WHERE key = 'tree_version_seq'").get().value === '41');
        check('the legacy token is pinned to alex', db.prepare("SELECT value FROM server_meta WHERE key = 'legacy_token_user_id'").get().value === '1');
        const recorded = JSON.parse(db.prepare("SELECT value FROM server_meta WHERE key = 'tenancy_digest'").get().value);
        check('the digest is recorded with the recovered ids', recorded.tables.items.n === before.items.n
            && JSON.stringify(recorded.orphanSourceIds) === '[7,9]');
        check(`schema version is ${SCHEMA_VERSION}`, db.pragma('user_version', { simple: true }) === SCHEMA_VERSION && SCHEMA_VERSION >= 3);

        const imports = makeImportsStore(db);
        check('removed sources stay out of the tree but are listed on request',
            !JSON.stringify(buildImportsTree(imports, 1)).includes('Orphaned')
            && imports.listSources(1, { includeRemoved: true }).filter(s => s.deletedAt).length === 2);
        check('and count towards the owner\'s archive', userStats(db, 1).archived === 5 && userStats(db, 1).removedImports === 2,
            JSON.stringify(userStats(db, 1)));

        // A later boot, after the owner has pushed: no digests, no frozen
        // version comparison, no crash loop.
        bumpTreeVersion(db, 1);
        const again = throws(() => migrateOwnership(db, { env: {} }));
        check('a second run after a push is a no-op, not a crash', again === null, again && again.message);
        check('and reports nothing migrated', migrateOwnership(db, { env: {} }).migrated === false);
        const id = serverId(db);
        check('the server gets an id of its own, made once', /^[0-9a-f]{24}$/.test(id) && serverId(db) === id
            && digestTables(db, DIGEST_TABLES, { like: before, exclude: { import_sources: new Set([7, 9]) } }).items.sha256 === before.items.sha256);
        db.close();
    }

    console.log('\n2. A refused migration changes nothing');
    for (const failAt of ['after-alter', 'before-commit']) {
        const db = v2Fixture();
        const before = digestTables(db, DIGEST_TABLES);
        let err = null;
        try { await upgrade(db, {}, { failAt }); } catch (e) { err = e; }
        check(`an injected failure (${failAt}) throws`, err && /Injected/.test(err.message), err && err.message);
        check('  the ALTERs are rolled back', !hasColumn(db, 'items', 'user_id') && !hasColumn(db, 'import_sources', 'deleted_at'));
        check('  no owner was recorded', !db.prepare("SELECT 1 FROM server_meta WHERE key = 'tenancy_owner_id'").get());
        check('  no placeholder sources remain', !db.prepare('SELECT 1 FROM import_sources WHERE id IN (7, 9)').get());
        check('  every table identical', sameDigests(before, digestTables(db, DIGEST_TABLES)));
        check('  schema version unchanged', db.pragma('user_version', { simple: true }) === 2);
        db.close();
    }
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-tenancy-'));
        const file = path.join(dir, 'sync.db');
        const db = v2Fixture(file);
        const marker = writeRefusal(dir, new Error('2 accounts exist'), path.join(dir, 'sync.db.pre-v3-x'));
        check('a refusal leaves a marker naming the error and the backup',
            fs.readFileSync(marker, 'utf8').includes('2 accounts exist') && fs.readFileSync(marker, 'utf8').includes('sync.db.pre-v3-x'));
        const pre = preflight(db, file, { schemaVersion: SCHEMA_VERSION });
        check('the next boot stops at preflight because of it', !pre.ok && /previous migration was refused/.test(pre.error), pre.error);
        fs.unlinkSync(marker);
        check('without the marker preflight passes', preflight(db, file, { schemaVersion: SCHEMA_VERSION }).ok);
        const tight = preflight(db, file, { schemaVersion: SCHEMA_VERSION, statfs: () => ({ bavail: 1, bsize: 1024 }) });
        check('too little disk refuses with the sizes', !tight.ok && /not enough disk/.test(tight.error) && /MB/.test(tight.error), tight.error);
        const NEXT = SCHEMA_VERSION + 1;
        db.pragma(`user_version = ${NEXT}`);
        const newer = preflight(db, file, { schemaVersion: SCHEMA_VERSION });
        check(`a database from a newer build (user_version ${NEXT}) is refused`, !newer.ok && /newer TabPaladin/.test(newer.error)
            && new RegExp(`sync\\.db\\.pre-v${NEXT}-`).test(newer.error), newer.error);
        db.close();
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }

    console.log('\n3. Ownership is never guessed');
    {
        const db = v2Fixture(':memory:', { users: ['first', 'alex'] });
        const before = digestTables(db, DIGEST_TABLES);
        let err = null;
        try { await upgrade(db, {}); } catch (e) { err = e; }
        check('two accounts and no TENANCY_OWNER refuses', err && /2 accounts exist; set TENANCY_OWNER/.test(err.message), err && err.message);
        check('  and changes nothing', !hasColumn(db, 'items', 'user_id') && sameDigests(before, digestTables(db, DIGEST_TABLES)));
        const { result } = await upgrade(db, { TENANCY_OWNER: 'alex' });
        check('TENANCY_OWNER=alex migrates to alex, not to the lower id', result.migrated && result.owner.username === 'alex'
            && JSON.stringify(ownersOf(db)) === '[2]', JSON.stringify(ownersOf(db)));
        db.close();

        const db2 = v2Fixture(':memory:', { users: ['alex'] });
        let err2 = null;
        try { await upgrade(db2, { TENANCY_OWNER: 'nobody' }); } catch (e) { err2 = e; }
        check('a TENANCY_OWNER that names no account refuses', err2 && /names no existing account/.test(err2.message));
        db2.close();
    }
    {
        // A token-only server from before accounts: no users at all. The
        // first admin is created from AUTH_TOKEN, then owns everything.
        const db = v2Fixture(':memory:', { users: [] });
        const { result, boot } = await upgrade(db, { AUTH_TOKEN: 'k'.repeat(40) });
        check('a token-only database migrates to the admin bootstrapped from AUTH_TOKEN',
            boot.created && result.migrated && result.owner.id === boot.created.id
            && JSON.stringify(ownersOf(db)) === `[${boot.created.id}]` && nullOwners(db) === 0);
        db.close();
    }

    console.log('\n4. Unowned rows on a later boot');
    for (const accounts of [1, 2]) {
        const db = v2Fixture();
        await upgrade(db);
        if (accounts === 2) insertUser(db, { username: 'sam', passwordHash: 'x' });
        // What a rolled-back image could leave if someone dropped the guards
        // to make it start: rows with no owner.
        db.exec('DROP TRIGGER items_owner_insert; DROP TRIGGER shared_links_owner_insert');
        db.prepare("INSERT INTO items (id, parent_id, position, kind, title) VALUES ('stray', NULL, 9, 'folder', 'Stray')").run();
        db.prepare("INSERT INTO shared_links (url, created_at) VALUES ('https://stray.example', ?)").run(T);
        const err = throws(() => migrateOwnership(db, { env: {} }));
        if (accounts === 1) {
            check('one account: they are adopted by the owner', err === null
                && db.prepare("SELECT user_id FROM items WHERE id = 'stray'").get().user_id === 1 && nullOwners(db) === 0, err && err.message);
            check('and the guards are back', Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'items_owner_insert'").get()));
        } else {
            check('two accounts: the boot is refused, rows untouched',
                err && /2 unowned rows and 2 accounts/.test(err.message)
                && db.prepare("SELECT user_id FROM items WHERE id = 'stray'").get().user_id === null, err && err.message);
            check('TENANCY_OWNER settles it explicitly', throws(() => migrateOwnership(db, { env: { TENANCY_OWNER: 'alex' } })) === null
                && nullOwners(db) === 0);
        }
        db.close();
    }
}

// --- 2. Isolation ---------------------------------------------------------------

async function isolationTests() {
    console.log('\n5. Two accounts never see or overwrite each other\'s data');
    const db = v2Fixture();
    const { store } = await upgrade(db, {}, { maxSnapshots: 4 });
    const sam = insertUser(db, { username: 'sam', passwordHash: 'x' });
    const alexItems = store.forUser(1);
    const samItems = store.forUser(sam.id);

    const samVersion0 = samItems.version();
    check('a new account starts at a fresh version, not 0 and not alex\'s', samVersion0 > 41 && samVersion0 !== alexItems.version(),
        `${samVersion0} vs ${alexItems.version()}`);
    check('a new account starts with an empty tree', samItems.readTree().roots.length === 0);
    check('another account\'s notes are not listed', samItems.listNotes().length === 0 && alexItems.listNotes().length === 2);
    check('migrating from history is scoped: sam has none', samItems.migrateFromLatestSnapshotIfNeeded().migrated === false
        && samItems.readTree().roots.length === 0);

    const versions = new Set([alexItems.version(), samVersion0]);
    for (let i = 0; i < 6; i++) {
        versions.add(samItems.writeTree([{ id: `s-root-${i}`, kind: 'folder', title: `Sam ${i}`, children: [] }], { deviceId: 'sam' }));
    }
    versions.add(alexItems.writeTree(alexItems.readTree().roots, { deviceId: 'alex' }));
    check('versions come from one sequence and never coincide', versions.size === 9, [...versions].join(','));
    check('sam\'s pushes leave alex\'s tree as it was', JSON.stringify(alexItems.readTree().roots.map(r => r.id)) === '["bm","nr","wf"]');
    check('history is pruned per account (sam kept 4, alex kept all of his)',
        db.prepare('SELECT COUNT(*) AS n FROM snapshots WHERE user_id = ?').get(sam.id).n === 4
        && db.prepare('SELECT COUNT(*) AS n FROM snapshots WHERE user_id = 1').get().n === 4, // 3 legacy + 1 push, at the 4 cap
        `${db.prepare('SELECT COUNT(*) AS n FROM snapshots WHERE user_id = 1').get().n}`);

    // From here on alex does nothing, so nothing of his may change at all.
    const alexBaseline = accountDigest(db, 1);

    // Both accounts get a notes root of their own. Not duplicates.
    samItems.applyNoteProposal({ kind: 'note', title: 'Groceries', content: 'sam\'s list', notebook: null });
    check('a same-titled note lands in sam\'s own tree', samItems.listNotes().find(n => n.title === 'Groceries')?.content === 'sam\'s list');
    check('alex\'s note with that title is untouched', alexItems.listNotes().find(n => n.title === 'Groceries')?.content.includes('milk'));
    const healed = store.healAllUsers();
    check('the boot heal leaves two accounts\' notes roots alone', healed.healed === false
        && db.prepare("SELECT COUNT(*) AS n FROM items WHERE role = 'notes'").get().n === 2);
    samItems.applyNoteProposal({ kind: 'note', title: 'Pasta', content: 'sam pasta', notebook: null });
    samItems.applyNoteProposal({ kind: 'reorder', content: JSON.stringify(['Pasta', 'Groceries']) });
    check('a reorder only moves the account\'s own notes',
        samItems.listNotes().map(n => n.title).join() === 'Pasta,Groceries'
        && alexItems.listNotes().map(n => n.title).join() === 'Groceries,Pasta');
    // Sam has ordinary top-level folders, so one of his becomes his Bookmarks;
    // alex's existing one is not a candidate and not touched.
    const samRoot = samItems.ensureBookmarksRoot();
    check('ensureBookmarksRoot picks one of sam\'s own folders', samRoot.id && samRoot.id !== 'bm'
        && samItems.bookmarksRootId() === samRoot.id && alexItems.bookmarksRootId() === 'bm'
        && samItems.readTree().roots.some(r => r.id === samRoot.id && r.role === 'bookmarks'), JSON.stringify(samRoot));

    // Pushing another account's ids: refused whole, nothing written, nothing re-minted.
    const samSnapshot = JSON.stringify(samItems.readTree());
    const v = samItems.version();
    const foreign = throws(() => samItems.writeTree([{ id: 'b1', kind: 'bookmark', title: 'stolen', url: 'https://x' }]));
    check('pushing alex\'s ids is refused with ForeignIdError', foreign instanceof ForeignIdError && foreign.count === 1, foreign && foreign.message);
    check('  and nothing was written', JSON.stringify(samItems.readTree()) === samSnapshot && samItems.version() === v);
    db.exec('DROP TRIGGER items_owner_insert');
    db.prepare("INSERT INTO items (id, parent_id, position, kind, title) VALUES ('nullrow', NULL, 0, 'folder', 'x')").run();
    db.exec(`CREATE TRIGGER items_owner_insert BEFORE INSERT ON items
        WHEN NEW.user_id IS NULL OR NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id)
        BEGIN SELECT RAISE(ABORT, 'items.user_id must name an existing user'); END`);
    const nullHit = throws(() => samItems.writeTree([{ id: 'nullrow', kind: 'folder', title: 'mine?', children: [] }]));
    check('an id held by a NULL-owned row is foreign too (IS NOT, not <>)', nullHit instanceof ForeignIdError);
    db.prepare("DELETE FROM items WHERE id = 'nullrow'").run();

    // Inbox, history, proposals, imports, prefs.
    db.prepare("INSERT INTO shared_links (url, created_at, user_id) VALUES ('https://sam.example', ?, ?)").run(T, sam.id);
    db.prepare('DELETE FROM shared_links WHERE user_id = ?').run(sam.id); // what sam's "clear inbox" runs
    check('clearing sam\'s inbox leaves alex\'s', db.prepare('SELECT COUNT(*) AS n FROM shared_links WHERE user_id = 1').get().n === 2);
    const imports = makeImportsStore(db);
    const samX = imports.createSource({ provider: 'x', config: {}, userId: sam.id });
    imports.upsertItem(samX.id, { externalId: 'x:100', url: 'https://x.com/a/status/100', title: 'Same tweet' });
    check('the same post in two accounts is two archive rows',
        db.prepare("SELECT COUNT(*) AS n FROM import_items WHERE external_id = 'x:100'").get().n === 2);
    check('each account\'s subtree draws only its own archive',
        JSON.stringify(buildImportsTree(imports, sam.id)).includes('Same tweet') && !JSON.stringify(buildImportsTree(imports, 1)).includes('Same tweet'));
    check('getSource will not hand alex\'s source to sam', imports.getSource(1, sam.id) === null && imports.getSource(2, sam.id) === null);
    db.prepare("INSERT INTO user_prefs VALUES (?, 'share.targets', '{\"v\":1}', ?)").run(sam.id, T);
    check('prefs are per account', !db.prepare("SELECT 1 FROM user_prefs WHERE user_id = 1").get());

    // Shares: sam's inbox, filed into sam's own tree, and never into alex's.
    const shares = makeSharesStore(db, { items: store, importsStore: imports });
    const SAM_SID = 'sam-share-0000000001';
    shares.forUser(sam.id).intake({ sid: SAM_SID, url: 'https://sam-share.example/a', app: 'site:sam-share.example' });
    const intoAlex = shares.forUser(sam.id).file(SAM_SID, { targets: [{ folderId: 'bm' }] });
    check('sam cannot file a share into alex\'s folder: it is not in his tree', intoAlex.refused && intoAlex.failed[0].reason === 'missing',
        JSON.stringify(intoAlex));
    const intoOwn = shares.forUser(sam.id).file(SAM_SID, { targets: [{ folderId: samRoot.id }] });
    check('  but files it into his own', intoOwn && intoOwn.created.length === 1 && samItems.readTree().roots.some(r => JSON.stringify(r).includes('sam-share.example')));
    check('alex sees nothing of sam\'s share, by sid or in any list', shares.forUser(1).get(SAM_SID) === null
        && ['pending', 'filed'].every(s => shares.forUser(1).list({ status: s }).every(x => x.sid !== SAM_SID))
        && Object.keys(shares.forUser(1).stats()).length === 0);
    check('a sid alex reuses is his own share, not sam\'s', shares.forUser(1).intake({ sid: SAM_SID, url: 'https://alex.example/' }).created === true
        && shares.forUser(sam.id).get(SAM_SID).url === 'https://sam-share.example/a');
    db.prepare('DELETE FROM shared_links WHERE user_id = 1 AND sid = ?').run(SAM_SID);
    const samOps = store.forUser(sam.id).opsSince(intoOwn.baseVersion);
    check('the filing is in sam\'s ops log only', samOps.complete && samOps.ops.length === 1
        && db.prepare('SELECT COUNT(*) AS n FROM tree_ops WHERE user_id = 1').get().n === 0);

    samItems.writeTree([{ id: 'late', kind: 'folder', title: 'late', children: [] }]);
    check('after all of sam\'s activity, alex\'s data is byte-identical', accountDigest(db, 1) === alexBaseline);

    console.log('\n6. The guards refuse rows for accounts that do not exist');
    for (const [table, sql, args] of [
        ['items', "INSERT INTO items (id, kind, title, user_id) VALUES ('ghost', 'folder', 'g', ?)", [999]],
        ['snapshots', 'INSERT INTO snapshots (timestamp, json, user_id) VALUES (?, ?, ?)', [T, '{}', 999]],
        ['shared_links', 'INSERT INTO shared_links (url, created_at, user_id) VALUES (?, ?, ?)', ['https://g', T, 999]],
        ['share_tokens', "INSERT INTO share_tokens VALUES ('g', ?, ?, ?)", [T, FUTURE, 999]],
        ['note_proposals', "INSERT INTO note_proposals (title, content, created_at, user_id) VALUES ('g', 'g', ?, ?)", [T, 999]],
        ['import_sources', "INSERT INTO import_sources (provider, created_at, user_id) VALUES ('x', ?, ?)", [T, 999]],
        ['user_tree_meta', "INSERT INTO user_tree_meta VALUES (?, 'treeVersion', '1')", [999]],
        ['user_prefs', "INSERT INTO user_prefs VALUES (?, 'k', '1', ?)", [999, T]],
        ['tree_ops', "INSERT INTO tree_ops (user_id, version, base_version, kind, payload, created_at) VALUES (?, 1, 0, 'append', '{}', ?)", [999, T]],
        ['share_filings', "INSERT INTO share_filings (share_id, user_id, folder_id, bookmark_id, url, tree_version, filed_at) VALUES (1, ?, 'f', 'b', 'https://g', 1, ?)", [999, T]]
    ]) {
        const e = throws(() => db.prepare(sql).run(...args));
        check(`${table}: an insert for a missing account is refused`, e && /must name an existing user/.test(e.message), e && e.message);
    }
    const nullInsert = throws(() => db.prepare("INSERT INTO shared_links (url, created_at) VALUES ('https://g', ?)").run(T));
    check('an insert with no owner at all (the old image\'s shape) is refused', nullInsert && /must name an existing user/.test(nullInsert.message));
    const move = throws(() => db.prepare('UPDATE items SET user_id = 999 WHERE id = ?').run('b1'));
    check('moving a row to a missing account is refused', move && /must name an existing user/.test(move.message));
    const oldStyle = throws(() => db.transaction(() => {
        db.prepare('DELETE FROM items').run();
        db.prepare("INSERT INTO items (id, kind, title) VALUES ('x', 'folder', 'x')").run();
    })());
    check('an old image\'s DELETE-everything-then-INSERT is rolled back by the guard',
        oldStyle && db.prepare('SELECT COUNT(*) AS n FROM items WHERE user_id = 1').get().n > 0);

    console.log('\n7. Deleting an account removes exactly its data');
    // Give sam a removed source with an archive, a tombstone and stale OAuth
    // state, plus one of everything else.
    db.prepare("INSERT INTO import_dismissed VALUES (?, 'x:9', ?)").run(samX.id, T);
    imports.deleteSource(samX.id, sam.id);
    db.prepare("INSERT INTO import_oauth_state VALUES ('sam-state', ?, ?)").run(samX.id, T);
    db.prepare("INSERT INTO share_tokens VALUES ('sam-tok', ?, ?, ?)").run(T, FUTURE, sam.id);
    db.prepare("INSERT INTO note_proposals (title, content, created_at, user_id) VALUES ('s', 's', ?, ?)").run(T, sam.id);
    db.prepare("INSERT INTO sessions VALUES ('sam-sess', 'sam', ?, ?)").run(T, FUTURE);
    const alexKept = accountDigest(db, 1);
    const totalBefore = DIGEST_TABLES.reduce((n, t) => n + db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0);
    const counts = deleteUserData(db, sam.id, { deletedBy: 1 });
    check('the removed source\'s archive, tombstones and OAuth state went with it',
        counts.import_items === 1 && counts.import_dismissed === 1 && counts.import_oauth_state === 1 && counts.import_sources === 1,
        JSON.stringify(counts));
    // user_tree_meta: his tree version and the floor of his tree's ops log.
    check('as did its tree, history, tokens, proposals, prefs, session and account',
        counts.items > 0 && counts.snapshots > 0 && counts.share_tokens === 1 && counts.note_proposals === 1
        && counts.user_prefs === 1 && counts.sessions === 1 && counts.users === 1 && counts.user_tree_meta === 2, JSON.stringify(counts));
    check('and its shares with where they were filed', counts.shared_links === 1 && counts.share_filings === 1 && counts.tree_ops === 0,
        JSON.stringify(counts));
    const removedTotal = ['import_items', 'import_dismissed', 'import_oauth_state', 'import_sources', 'items', 'snapshots',
        'shared_links', 'share_tokens', 'note_proposals', 'sessions', 'users'].reduce((n, t) => n + (counts[t] || 0), 0);
    const totalAfter = DIGEST_TABLES.reduce((n, t) => n + db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0);
    check('nothing else was removed', totalBefore - totalAfter === removedTotal, `${totalBefore} - ${totalAfter} vs ${removedTotal}`);
    check('alex\'s data is byte-identical', accountDigest(db, 1) === alexKept);
    check('nothing of sam\'s is left anywhere', !ownersOf(db).includes(sam.id) && checkOwnership(db).length === 0, checkOwnership(db).join('; '));
    const tomb = db.prepare('SELECT * FROM deleted_users WHERE id = ?').get(sam.id);
    check('a tombstone records who and what', tomb && tomb.username === 'sam' && tomb.deleted_by === 1 && JSON.parse(tomb.counts).items > 0);
    check('the id is never handed out again', nextUserId(db) > sam.id);
    check('the account store refuses a deleted account', throws(() => store.forUser(sam.id)) !== null);
    db.close();
}

// --- 3. The static scan ---------------------------------------------------------
//
// Every db.prepare(...) / db.exec(...) string literal in the server that
// reads or writes an account-owned table must name user_id. Exceptions are
// listed with the reason they are safe; an exception that no longer matches
// anything fails too, so the list cannot rot.

const OWNED = /\b(?:FROM|INTO|UPDATE|JOIN)\s+"?(items|snapshots|shared_links|share_filings|share_tokens|note_proposals|import_sources|user_tree_meta|user_prefs|tree_ops)\b/i;
const SCAN_SKIP = new Set(['server/tenancy.js']); // operates across accounts by design: the migration, deletion, stats
const ALLOWED = [
    ['server/llmShare.js', 'DELETE FROM share_tokens WHERE expires_at <= ?', 'expiry sweep: dead tokens are dead whoever owned them'],
    ['server/imports/store.js', 'SELECT * FROM import_sources WHERE deleted_at IS NULL ORDER BY id', 'listAllSources: the scheduler and the boot warning'],
    ['server/imports/store.js', 'SELECT * FROM import_sources WHERE id = ?', 'getSourceUnscoped: OAuth callback, authenticated by its one-shot state'],
    ['server/imports/store.js', 'SELECT credentials FROM import_sources WHERE id = ?', 'by primary key, after getSource(id, userId) or listAllSources'],
    ['server/imports/store.js', 'UPDATE import_sources SET credentials = ? WHERE id = ?', 'by primary key, after getSource(id, userId) or listAllSources'],
    ['server/imports/store.js', 'UPDATE import_sources SET last_run = ?, last_status = ?, last_error = ? WHERE id = ?', 'by primary key, after getSource(id, userId) or listAllSources'],
    ['server/imports/store.js', 'UPDATE import_sources SET pending_credentials = ?, pending_username = ?, pending_nonce_hash = ? WHERE id = ? AND deleted_at IS NULL', 'OAuth callback, after the one-shot state resolved the source'],
    ['server/imports/store.js', 'SELECT * FROM import_sources WHERE pending_nonce_hash = ? AND deleted_at IS NULL', 'confirm page: found by an unguessable one-time nonce'],
    ['server/imports/store.js', 'UPDATE import_sources SET pending_credentials = NULL, pending_username = NULL, pending_nonce_hash = NULL WHERE id = ?', 'clears a pending connection already resolved by nonce'],
    ['server/imports/store.js', 'SELECT 1 FROM import_sources WHERE id = ? AND deleted_at IS NULL', 'upsertItem: is the source still there at all']
].map(([file, sql, why]) => ({ file, sql, why, used: 0 }));

function sqlLiterals(src) {
    const out = [];
    const re = /\.(?:prepare|exec)\(\s*/g;
    let m;
    while ((m = re.exec(src))) {
        const start = re.lastIndex;
        const q = src[start];
        if (q !== "'" && q !== '"' && q !== '`') continue;
        let j = start + 1;
        let text = '';
        while (j < src.length && src[j] !== q) {
            if (src[j] === '\\') { text += src.slice(j, j + 2); j += 2; continue; }
            if (q === '`' && src[j] === '$' && src[j + 1] === '{') {
                let depth = 1;
                j += 2;
                while (j < src.length && depth) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; j++; }
                text += '${…}';
                continue;
            }
            text += src[j++];
        }
        out.push({ sql: text.replace(/\s+/g, ' ').trim(), line: src.slice(0, start).split('\n').length });
    }
    return out;
}

function staticScan() {
    console.log('\n8. Every statement on an account-owned table names user_id');
    const files = [
        ...fs.readdirSync(SERVER).filter(f => f.endsWith('.js')).map(f => `server/${f}`),
        ...fs.readdirSync(path.join(SERVER, 'imports')).filter(f => f.endsWith('.js')).map(f => `server/imports/${f}`)
    ];
    let scanned = 0;
    const violations = [];
    for (const file of files) {
        if (SCAN_SKIP.has(file)) continue;
        const src = fs.readFileSync(path.join(REPO, file), 'utf8');
        for (const { sql, line } of sqlLiterals(src)) {
            scanned++;
            if (!OWNED.test(sql) || /\buser_id\b/.test(sql)) continue;
            const allowed = ALLOWED.find(a => a.file === file && a.sql === sql);
            if (allowed) { allowed.used++; continue; }
            violations.push(`${file}:${line}  ${sql}`);
        }
    }
    check(`scanned the server's SQL (${scanned} statements)`, scanned > 80, String(scanned));
    check('no statement touches an owned table without user_id', violations.length === 0, '\n      ' + violations.join('\n      '));
    const stale = ALLOWED.filter(a => a.used === 0);
    check('every allowlist entry still matches a statement', stale.length === 0, stale.map(a => a.sql).join(' | '));
}

// --- 4. End to end ----------------------------------------------------------------

function legacyServerDir() {
    try {
        const files = execFileSync('git', ['-C', REPO, 'ls-tree', '-r', '--name-only', LEGACY_REV, '--', 'server'], { encoding: 'utf8' })
            .split('\n').filter(f => /^server\/.*\.js$/.test(f));
        if (!files.length) return null;
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-legacy-server-'));
        // The old server's bare imports resolve against this checkout's
        // server/node_modules by absolute URL, so nothing is linked or installed.
        const req = createRequire(path.join(SERVER, 'package.json'));
        const bare = (name) => pathToFileURL(req.resolve(name)).href;
        for (const f of files) {
            let src = execFileSync('git', ['-C', REPO, 'show', `${LEGACY_REV}:${f}`], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
            src = src.replace(/from '(express|cors|better-sqlite3)'/g, (_, name) => `from '${bare(name)}'`);
            const out = path.join(dir, f);
            fs.mkdirSync(path.dirname(out), { recursive: true });
            fs.writeFileSync(out, src);
        }
        return path.join(dir, 'server');
    } catch (e) {
        return null;
    }
}

const PASSWORD = 'correct horse battery';
const TOKEN = 'e2e-legacy-token-' + 'x'.repeat(32);

function serverEnv(port, dataDir, extra = {}) {
    const env = { ...process.env };
    for (const k of Object.keys(env)) {
        if (/^(AUTH_TOKEN|TABPALADIN_TOKEN|ADMIN_|TENANCY_OWNER|IMPORT_|MAX_|BACKUP_KEEP|AUTH_|TRUST_PROXY|CORS_ORIGIN|SESSION_DAYS)/.test(k)) delete env[k];
    }
    return {
        ...env, PORT: String(port), DATA_DIR: dataDir, PWA_DIR: path.join(REPO, 'pwa'),
        ADMIN_USERNAME: 'alex', ADMIN_PASSWORD: PASSWORD, AUTH_TOKEN: TOKEN, IMPORTS_SCHEDULER: 'off', ...extra
    };
}

function startServer(entry, port, dataDir, extra = {}) {
    const child = spawn(process.execPath, [entry], { env: serverEnv(port, dataDir, extra), stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', d => { log += d; });
    child.stderr.on('data', d => { log += d; });
    let exitCode;
    const exited = new Promise(resolve => child.on('exit', code => { exitCode = code; resolve(code); }));
    const base = `http://127.0.0.1:${port}`;
    return {
        base,
        log: () => log,
        exited,
        async ready() {
            for (let i = 0; i < 150; i++) {
                if (exitCode !== undefined) throw new Error(`server exited (${exitCode}):\n${log}`);
                try { if ((await fetch(base + '/api/health')).ok) return; } catch (e) { /* not yet */ }
                await new Promise(r => setTimeout(r, 100));
            }
            throw new Error(`server did not come up:\n${log}`);
        },
        async stop() {
            if (exitCode === undefined) child.kill();
            await exited;
        }
    };
}

async function bootToExit(entry, port, dataDir, extra = {}) {
    const s = startServer(entry, port, dataDir, extra);
    const timer = setTimeout(() => s.stop(), 15000);
    const code = await s.exited;
    clearTimeout(timer);
    return { code, log: s.log() };
}

async function http(base, p, { method = 'GET', token, body } = {}) {
    const res = await fetch(base + p, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
    return { status: res.status, json, text };
}

const withoutKeys = (o, keys) => JSON.parse(JSON.stringify(o, (k, v) => (keys.includes(k) ? undefined : v)));

async function endToEnd() {
    console.log(`\n9. End to end: the pre-multi-user server (${LEGACY_REV}) writes, this one upgrades`);
    const legacy = legacyServerDir();
    if (!legacy) {
        console.log(`  SKIP  could not read server/ at ${LEGACY_REV} from git`);
        return;
    }
    const OLD = path.join(legacy, 'index.js');
    const NEW = path.join(SERVER, 'index.js');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-e2e-'));
    const crashDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-e2e-crash-'));
    const running = [];
    const start = (entry, port, dir, extra) => { const s = startServer(entry, port, dir, extra); running.push(s); return s; };
    try {
        // --- The old server fills a database through its own API.
        const old = start(OLD, OLD_PORT, dataDir);
        await old.ready();
        const login = await http(old.base, '/api/login', { method: 'POST', body: { username: 'alex', password: PASSWORD } });
        const tok = login.json.token;
        let tree = await http(old.base, '/api/tree', { token: tok });
        const bm = tree.json.roots.find(r => r.role === 'bookmarks');
        const roots = [
            { ...bm, children: [{ id: 'e2e-b1', kind: 'bookmark', title: 'HN', url: 'https://news.ycombinator.com' }] },
            { id: 'e2e-notes', kind: 'folder', role: 'notes', title: 'Notes', children: [
                { id: 'e2e-n1', kind: 'note', title: 'Groceries', payload: { content: '# Groceries\n- milk', createdAt: T, updatedAt: T } }
            ] },
            { id: 'e2e-wf', kind: 'folder', role: 'workflows', title: 'Workflows', children: [
                { id: 'e2e-wf1', kind: 'folder', title: 'Research', payload: { createdAt: T }, children: [
                    { id: 'e2e-wt1', kind: 'bookmark', title: 'MDN', url: 'https://developer.mozilla.org' }
                ] }
            ] }
        ];
        let put = await http(old.base, '/api/tree', { method: 'PUT', token: tok, body: { roots, baseVersion: tree.json.version, deviceId: 'e2e' } });
        await http(old.base, '/api/shared', { method: 'POST', token: tok, body: { url: 'https://inbox-1.example', title: 'One' } });
        await http(old.base, '/api/shared', { method: 'POST', token: tok, body: { url: 'https://inbox-2.example' } });
        const share = await http(old.base, '/api/share', { method: 'POST', token: tok });
        const shareToken = share.json.url.split('/llm/')[1];
        await http(old.base, `/llm/${shareToken}/propose`, { method: 'POST', body: { title: 'Idea', content: '# Idea\nbody' } });
        const cap1 = await http(old.base, '/api/imports/capture', { method: 'POST', token: tok, body: { url: 'https://x.com/a/status/1' } });
        // Remove the X source the way both clients do — no purge — then
        // capture again: the first archive row is left with no source.
        await http(old.base, `/api/imports/${cap1.json.sourceId}`, { method: 'DELETE', token: tok });
        const cap2 = await http(old.base, '/api/imports/capture', { method: 'POST', token: tok, body: { url: 'https://x.com/a/status/2' } });
        const reddit = await http(old.base, '/api/imports', { method: 'POST', token: tok, body: { provider: 'reddit', clientId: 'cid', clientSecret: 'sec' } });
        await http(old.base, `/api/imports/${reddit.json.source.id}/authorize`, { token: tok });
        put = await http(old.base, '/api/tree', { method: 'PUT', token: tok, body: { roots, baseVersion: put.json.version, deviceId: 'e2e' } });
        check('the old server accepted the writes', put.status === 200 && cap2.json.captured && reddit.status === 200,
            JSON.stringify([put.status, cap2.json, reddit.status]));

        const oldView = {
            tree: (await http(old.base, '/api/tree', { token: tok })).json,
            history: (await http(old.base, '/api/history', { token: tok })).json,
            shared: (await http(old.base, '/api/shared', { token: tok })).json,
            proposals: (await http(old.base, '/api/proposals', { token: tok })).json,
            imports: (await http(old.base, '/api/imports', { token: tok })).json,
            items: (await http(old.base, `/api/imports/${cap2.json.sourceId}/items`, { token: tok })).json,
            llm: (await http(old.base, `/llm/${shareToken}`)).text
        };
        await old.stop();
        const raw = new Database(path.join(dataDir, 'sync.db'));
        const orphanRows = raw.prepare('SELECT COUNT(*) AS n FROM import_items WHERE source_id NOT IN (SELECT id FROM import_sources)').get().n;
        const rawDigest = digestTables(raw, DIGEST_TABLES);
        raw.close();
        check('the old server left an orphaned archive row behind, as reproduced', orphanRows === 1);

        // --- This server boots on the same directory.
        let srv = start(NEW, NEW_PORT, dataDir);
        await srv.ready();
        // Both copies are named after the schema this build upgrades to: the
        // ownership migration and every later step run on the same boot.
        const V = SCHEMA_VERSION;
        check('the boot log names the owner, the recovered source and both copies',
            new RegExp(`Tenancy migration: assigned \\d+ rows to alex \\(#1\\); recovered 1 removed import source\\(s\\); pre-upgrade copy sync\\.db\\.pre-v${V}-\\S+; post-upgrade copy sync\\.db\\.post-v${V}-`).test(srv.log()),
            srv.log());
        const files = fs.readdirSync(dataDir);
        const preCopy = files.find(f => f.startsWith(`sync.db.pre-v${V}-`));
        const postCopy = files.find(f => f.startsWith(`sync.db.post-v${V}-`));
        const verify = spawnSync(process.execPath, [path.join(SERVER, 'verify_tenancy.js'), path.join(dataDir, preCopy), path.join(dataDir, postCopy)],
            { encoding: 'utf8' });
        check('verify_tenancy.js proves the pre and post copies match', verify.status === 0, verify.stdout + verify.stderr);
        const preDb = new Database(path.join(dataDir, preCopy), { readonly: true });
        check('the pre-upgrade copy is exactly what the old server left', sameDigests(rawDigest, digestTables(preDb, DIGEST_TABLES)));
        preDb.close();

        const tok2 = (await http(srv.base, '/api/login', { method: 'POST', body: { username: 'alex', password: PASSWORD } })).json.token;
        const newView = {
            tree: (await http(srv.base, '/api/tree', { token: tok })).json,
            history: (await http(srv.base, '/api/history', { token: tok })).json,
            shared: (await http(srv.base, '/api/shared', { token: tok })).json,
            proposals: (await http(srv.base, '/api/proposals', { token: tok })).json,
            imports: (await http(srv.base, '/api/imports', { token: tok })).json,
            items: (await http(srv.base, `/api/imports/${cap2.json.sourceId}/items`, { token: tok })).json,
            llm: (await http(srv.base, `/llm/${shareToken}`)).text
        };
        check('the old session still works', newView.tree && newView.tree.ok === true);
        check('the tree is identical, at the same version, stamped with alex\'s id and the server\'s',
            JSON.stringify(withoutKeys(newView.tree, ['userId', 'serverId'])) === JSON.stringify(oldView.tree) && newView.tree.userId === 1
            && /^[0-9a-f]{24}$/.test(newView.tree.serverId));
        for (const k of ['history', 'shared', 'proposals', 'items']) {
            check(`${k} identical`, JSON.stringify(newView[k]) === JSON.stringify(oldView[k]));
        }
        check('import sources identical (removed ones hidden by default)',
            JSON.stringify(withoutKeys(newView.imports, ['removed', 'removedAt'])) === JSON.stringify(oldView.imports));
        // The page has since gained instructions and the bookmarks (the AI
        // chats release); every note and notebook heading must be unchanged.
        const notesPart = (page) => page.slice(page.indexOf('## Existing notes ('));
        check('the LLM share page serves the same notes',
            oldView.llm.includes('## Existing notes (') && newView.llm.includes('## Existing notes (')
            && notesPart(newView.llm).split(srv.base).join('BASE') === notesPart(oldView.llm).split(old.base).join('BASE'));
        const removed = (await http(srv.base, '/api/imports?includeRemoved=1', { token: tok })).json.sources.filter(s => s.removed);
        check('the orphaned X archive is back, as a removed source', removed.length === 1 && removed[0].provider === 'x' && removed[0].items === 1,
            JSON.stringify(removed));

        const me = await http(srv.base, '/api/auth/me', { token: TOKEN });
        check('the legacy AUTH_TOKEN still acts as the owner', me.json?.user?.username === 'alex' && me.json.user.tenancyOwner === true,
            JSON.stringify(me.json));
        const tokenTree = await http(srv.base, '/api/tree', { token: TOKEN });
        check('and reaches the owner\'s tree', tokenTree.json?.version === oldView.tree.version);

        // --- A second account, through the admin API.
        const made = await http(srv.base, '/api/users', { method: 'POST', token: tok2,
            body: { username: 'sam', password: 'sam-password-1', role: 'user', currentPassword: PASSWORD } });
        check('alex creates sam', made.status === 200 && made.json.user.username === 'sam', JSON.stringify(made.json));
        const samTok = (await http(srv.base, '/api/login', { method: 'POST', body: { username: 'sam', password: 'sam-password-1' } })).json.token;
        await http(srv.base, '/api/prefs/share.targets', { method: 'PUT', token: tok, body: { value: { v: 1, owner: 'alex' } } });
        // From here on alex does nothing, so nothing of his may change.
        const raw2 = new Database(path.join(dataDir, 'sync.db'), { readonly: true });
        const alexDigest = accountDigest(raw2, 1);
        raw2.close();
        const samTree = await http(srv.base, '/api/tree', { token: samTok });
        check('sam starts empty, at a version of his own', samTree.json.roots.length === 0 && samTree.json.version !== oldView.tree.version
            && samTree.json.userId === made.json.user.id, JSON.stringify(samTree.json));
        const steal = await http(srv.base, '/api/tree', { method: 'PUT', token: samTok,
            body: { roots: oldView.tree.roots, baseVersion: samTree.json.version, deviceId: 'sam' } });
        check('pushing alex\'s tree as sam is refused (foreign ids)', steal.status === 412 && steal.json.code === 'foreign-ids', JSON.stringify(steal.json));
        const forced = await http(srv.base, '/api/tree', { method: 'PUT', token: samTok,
            body: { roots: [], baseUserId: 1, force: true, deviceId: 'sam' } });
        check('a working copy stamped for alex is refused for sam, even forced', forced.status === 412 && forced.json.code === 'wrong-account');
        check('sam sees no inbox, history or proposals of alex\'s',
            (await http(srv.base, '/api/shared', { token: samTok })).json.links.length === 0
            && (await http(srv.base, '/api/history', { token: samTok })).json.snapshots.length === 0
            && (await http(srv.base, '/api/proposals', { token: samTok })).json.proposals.length === 0);
        check('sam gets 404 for alex\'s history entry', (await http(srv.base, `/api/history/${oldView.history.snapshots[0].id}`, { token: samTok })).status === 404);
        await http(srv.base, '/api/shared', { method: 'DELETE', token: samTok });
        check('sam clearing his inbox leaves alex\'s', (await http(srv.base, '/api/shared', { token: tok })).json.links.length === 2);
        check('sam gets 404 on alex\'s import source', (await http(srv.base, `/api/imports/${cap2.json.sourceId}/items`, { token: samTok })).status === 404
            && (await http(srv.base, '/api/imports', { token: samTok })).json.sources.length === 0);
        const samShare = await http(srv.base, '/api/share', { method: 'POST', token: samTok });
        const samLlm = await http(srv.base, `/llm/${samShare.json.url.split('/llm/')[1]}`);
        check('sam\'s LLM link shows none of alex\'s notes', samLlm.status === 200 && !samLlm.text.includes('Groceries') && samLlm.text.includes('Existing notes (0)'));
        const samPref = await http(srv.base, '/api/prefs/share.targets', { token: samTok });
        await http(srv.base, '/api/prefs/share.targets', { method: 'PUT', token: samTok, body: { value: { v: 1, owner: 'sam' } } });
        const alexPref = await http(srv.base, '/api/prefs/share.targets', { token: tok });
        check('prefs are per account', samPref.status === 404 && alexPref.json.value.owner === 'alex');
        const samPush = await http(srv.base, '/api/tree', { method: 'PUT', token: samTok,
            body: { roots: [{ id: 'sam-root', kind: 'folder', title: 'Sam', children: [] }], baseVersion: samTree.json.version, baseUserId: samTree.json.userId } });
        check('sam can push his own tree', samPush.status === 200 && samPush.json.userId === samTree.json.userId);
        const raw3 = new Database(path.join(dataDir, 'sync.db'), { readonly: true });
        const alexAfterSam = accountDigest(raw3, 1);
        raw3.close();
        check('none of sam\'s activity changed a byte of alex\'s data', alexAfterSam === alexDigest);

        const del = await http(srv.base, `/api/users/${made.json.user.id}/delete`, { method: 'POST', token: tok2,
            body: { confirm: 'sam', currentPassword: PASSWORD } });
        check('alex deletes sam, with a backup', del.status === 200 && /^sync\.db\.predelete-\d+-/.test(del.json.backup), JSON.stringify(del.json));
        const raw4 = new Database(path.join(dataDir, 'sync.db'), { readonly: true });
        check('alex\'s data is byte-identical after sam is deleted', accountDigest(raw4, 1) === alexAfterSam);
        raw4.close();
        check('sam can no longer sign in', (await http(srv.base, '/api/login', { method: 'POST', body: { username: 'sam', password: 'sam-password-1' } })).status === 401);

        // --- Later boots: no migration, no crash loop, even after pushes.
        await srv.stop();
        srv = start(NEW, NEW_PORT, dataDir);
        await srv.ready();
        const v = (await http(srv.base, '/api/tree/version', { token: tok })).json.version;
        const pushAgain = await http(srv.base, '/api/tree', { method: 'PUT', token: tok, body: { roots, baseVersion: v, baseUserId: 1 } });
        check('a second boot runs no migration and accepts pushes', !/Tenancy migration/.test(srv.log()) && pushAgain.status === 200);
        await srv.stop();
        srv = start(NEW, NEW_PORT, dataDir);
        await srv.ready();
        check('a third boot after a push still starts (no frozen-version check)', !/refused/i.test(srv.log()), srv.log());
        await srv.stop();

        // --- The owner gone: boot steps skipped, the token refused.
        // Not possible over HTTP; this is what a hand edit on the server could do.
        const raw5 = new Database(path.join(dataDir, 'sync.db'));
        const kim = insertUser(raw5, { username: 'kim', passwordHash: await hashPassword('kim-password-1'), role: 'admin' });
        deleteUserData(raw5, 1);
        raw5.close();
        srv = start(NEW, NEW_PORT, dataDir);
        await srv.ready();
        check('with the owner deleted the server still starts and skips its boot steps',
            /owner account no longer exists; skipping/.test(srv.log()) && /AUTH_TOKEN is set but the account it acts as no longer exists/.test(srv.log()), srv.log());
        check('and the legacy token gets 401', (await http(srv.base, '/api/tree', { token: TOKEN })).status === 401);
        // kim is now the only admin, and not the owner. Nobody changes their
        // own role, so she cannot leave the server without an admin.
        const kimTok = (await http(srv.base, '/api/login', { method: 'POST', body: { username: 'kim', password: 'kim-password-1' } })).json.token;
        const lastAdmin = await http(srv.base, `/api/users/${kim.id}`, { method: 'PUT', token: kimTok,
            body: { role: 'user', currentPassword: 'kim-password-1' } });
        check('the last admin cannot demote herself', lastAdmin.status === 400 && lastAdmin.json.code === 'self'
            && (await http(srv.base, '/api/auth/me', { token: kimTok })).json.user.role === 'admin', JSON.stringify(lastAdmin.json));
        await srv.stop();
        const raw6 = new Database(path.join(dataDir, 'sync.db'), { readonly: true });
        check('no rows were written for the missing owner', !ownersOf(raw6).includes(1));
        raw6.close();

        // --- A refused migration in a restart loop.
        console.log('\n10. A restart loop on a refused migration');
        const old2 = start(OLD, OLD_PORT, crashDir);
        await old2.ready();
        await old2.stop();
        const c = new Database(path.join(crashDir, 'sync.db'));
        c.prepare("INSERT INTO users (username, password_hash, created_at, id, role) VALUES ('leftover', 'x', ?, 2, 'user')").run(T);
        c.close();
        const dailies = ['2026-01-01', '2026-01-02', '2026-01-03'].map(d => `sync.db.bak-${d}T00-00-00-000Z`);
        for (const f of dailies) fs.copyFileSync(path.join(crashDir, 'sync.db'), path.join(crashDir, f));
        const codes = [];
        let firstLog = '';
        let lastLog = '';
        for (let i = 0; i < 8; i++) {
            const r = await bootToExit(NEW, NEW_PORT, crashDir);
            codes.push(r.code);
            if (i === 0) firstLog = r.log;
            lastLog = r.log;
        }
        check('eight boots, eight refusals', codes.every(code => code === 1), codes.join(','));
        check('the first says why and where the backup is', new RegExp(`Tenancy migration refused, nothing changed, backup at \\S*sync\\.db\\.pre-v${SCHEMA_VERSION}-`).test(firstLog)
            && /2 accounts exist; set TENANCY_OWNER/.test(firstLog), firstLog);
        check('later ones stop at the marker', /a previous migration was refused/.test(lastLog), lastLog);
        const after = fs.readdirSync(crashDir);
        check('every older daily backup is still there', dailies.every(f => after.includes(f)) && after.filter(f => f.startsWith('sync.db.bak-')).length === 3,
            after.join(', '));
        check('exactly one pre-upgrade copy was taken', after.filter(f => f.startsWith(`sync.db.pre-v${SCHEMA_VERSION}-`)).length === 1, after.join(', '));
        check('the marker is there', after.includes(MARKER_FILE));
        const c2 = new Database(path.join(crashDir, 'sync.db'), { readonly: true });
        check('the database is untouched (no columns, still version 2)', !hasColumn(c2, 'items', 'user_id') && c2.pragma('user_version', { simple: true }) === 2);
        c2.close();
        const stillRefused = await bootToExit(NEW, NEW_PORT, crashDir, { TENANCY_OWNER: 'alex' });
        check('setting TENANCY_OWNER alone does not bypass the marker', stillRefused.code === 1);
        fs.unlinkSync(path.join(crashDir, MARKER_FILE));
        const fixed = start(NEW, NEW_PORT, crashDir, { TENANCY_OWNER: 'alex' });
        await fixed.ready();
        await fixed.stop();
        const c3 = new Database(path.join(crashDir, 'sync.db'), { readonly: true });
        check('with the marker removed and TENANCY_OWNER=alex it migrates to alex', JSON.stringify(ownersOf(c3)) === '[1]' && nullOwners(c3) === 0);
        c3.close();
    } catch (e) {
        failures++;
        console.error('FAIL  end-to-end run stopped:', e);
    } finally {
        for (const s of running) await s.stop().catch(() => {});
        for (const d of [dataDir, crashDir, path.dirname(legacy)]) {
            try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) { /* temp */ }
        }
    }
}

await migrationTests();
await isolationTests();
staticScan();
await endToEnd();

console.log(failures === 0 ? '\nAll tenancy tests passed.\n' : `\n${failures} test(s) failed.\n`);
// exitCode rather than exit(): sockets to the stopped servers may still be
// closing, and exiting under them aborts the process on Windows.
process.exitCode = failures === 0 ? 0 : 1;
