// Headless tests for accounts: the additive users migration, first-admin
// bootstrap from the environment, who-is-calling resolution, and the
// boot-time database backup.
//
// What this locks down:
//   1. An upgraded single-user database keeps its user, password hash and
//      sessions, and that user becomes the admin with a stable numeric id.
//   2. ADMIN_USERNAME / ADMIN_PASSWORD create the first admin only when there
//      are no users; the environment is ignored afterwards.
//   3. A session token resolves to { id, username, role }; the legacy token
//      acts as the account the ownership migration pinned it to (the first
//      admin only before that migration); anything else resolves to nobody.
//   4. A schema step writes its own sync.db.pre-v<N>-* copy, once, and never
//      touches the daily sync.db.bak-* rotation — so a crash loop below the
//      new version cannot rotate the older daily copies away. Daily copies
//      are not repeated within the interval and are pruned to `keep`.
//   5. Account ids are never reused, names that differ only by case are
//      refused (against deleted accounts too), and password bounds hold.
//
// Run: node tools/test_users.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from '../server/node_modules/better-sqlite3/lib/index.js';
import {
    migrateUsers, bootstrapAdmin, identify, backupDatabase, setSchemaVersion, createUser, SCHEMA_VERSION,
    validatePassword, listBackups
} from '../server/users.js';
import { migrateOwnership, deleteUserData } from '../server/tenancy.js';
import { verifyPassword } from '../server/security.js';

let failures = 0;
function check(name, cond, detail) {
    if (cond) {
        console.log(`  ok  ${name}`);
    } else {
        failures++;
        console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

// The schema as the previous server version created it.
function legacyDb(file = ':memory:') {
    const db = new Database(file);
    db.exec(`
        CREATE TABLE users (username TEXT PRIMARY KEY, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE sessions (token TEXT PRIMARY KEY, username TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
    `);
    return db;
}
const future = new Date(Date.now() + 86400000).toISOString();
const TOKEN = 'a'.repeat(64);

// --- 1. Upgrade ---
console.log('upgrade');
{
    const db = legacyDb();
    db.prepare("INSERT INTO users VALUES ('alex', 'scrypt:salt:hash', '2025-01-01T00:00:00Z')").run();
    db.prepare("INSERT INTO sessions VALUES ('sess1', 'alex', '2025-01-01', ?)").run(future);
    migrateUsers(db);
    const u = db.prepare('SELECT * FROM users').get();
    check('existing user kept', u.username === 'alex' && u.password_hash === 'scrypt:salt:hash');
    check('existing user becomes admin', u.role === 'admin', u.role);
    check('existing user gets a numeric id', Number.isInteger(u.id) && u.id > 0, String(u.id));
    migrateUsers(db);
    check('migration is idempotent', db.prepare('SELECT COUNT(*) n FROM users').get().n === 1
        && db.prepare('SELECT role FROM users').get().role === 'admin');

    const who = identify(db, '', 'sess1');
    check('existing session still resolves', who && who.username === 'alex' && who.role === 'admin' && who.id === u.id,
        JSON.stringify(who));

    const second = await createUser(db, { username: 'sam', password: 'sam-password', role: 'user' });
    check('new users get the next id and role user', second.id === u.id + 1 && second.role === 'user', JSON.stringify(second));
    migrateUsers(db);
    check('a second migration leaves only the one admin',
        db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin'").get().n === 1);
}

// --- 2. Bootstrap ---
console.log('bootstrap');
{
    const db = legacyDb();
    migrateUsers(db);
    const none = await bootstrapAdmin(db, {});
    check('no users and no ADMIN_PASSWORD refuses', !none.ok && /ADMIN_PASSWORD/.test(none.error));
    const short = await bootstrapAdmin(db, { ADMIN_PASSWORD: 'short' });
    check('short ADMIN_PASSWORD refused', !short.ok);
    const bad = await bootstrapAdmin(db, { ADMIN_USERNAME: 'has space', ADMIN_PASSWORD: 'long-enough-pw' });
    check('invalid ADMIN_USERNAME refused', !bad.ok);

    const made = await bootstrapAdmin(db, { ADMIN_USERNAME: 'owner', ADMIN_PASSWORD: 'first-password' });
    check('first admin created from env', made.ok && made.created?.username === 'owner' && made.created?.role === 'admin');
    const row = db.prepare("SELECT password_hash FROM users WHERE username = 'owner'").get();
    check('admin password works', await verifyPassword('first-password', row.password_hash));

    const again = await bootstrapAdmin(db, { ADMIN_USERNAME: 'owner', ADMIN_PASSWORD: 'changed-in-env' });
    const row2 = db.prepare("SELECT password_hash FROM users WHERE username = 'owner'").get();
    check('env ignored once users exist', again.ok && !again.created && row2.password_hash === row.password_hash);

    const db2 = legacyDb();
    migrateUsers(db2);
    const viaToken = await bootstrapAdmin(db2, { AUTH_TOKEN: TOKEN });
    check('token-only deployment gets an admin with the token as password',
        viaToken.ok && viaToken.fromToken && viaToken.created.username === 'admin');
}

// --- 3. Identify ---
console.log('identify');
{
    const db = legacyDb();
    migrateUsers(db);
    await bootstrapAdmin(db, { ADMIN_USERNAME: 'owner', ADMIN_PASSWORD: 'first-password' });
    await createUser(db, { username: 'sam', password: 'sam-password' });
    db.prepare("INSERT INTO sessions VALUES ('samsess', 'sam', 'x', ?)").run(future);
    db.prepare("INSERT INTO sessions VALUES ('old', 'sam', 'x', '2000-01-01T00:00:00Z')").run();

    const sam = identify(db, TOKEN, 'samsess');
    check('session resolves to its own user', sam?.username === 'sam' && sam.role === 'user' && sam.via === 'session');
    const viaToken = identify(db, TOKEN, TOKEN);
    check('legacy token acts as the first admin', viaToken?.username === 'owner' && viaToken.role === 'admin' && viaToken.via === 'token');
    check('legacy token off when unset', identify(db, '', TOKEN) === null);
    check('unknown token resolves to nobody', identify(db, TOKEN, 'b'.repeat(64)) === null);
    check('expired session resolves to nobody and is deleted',
        identify(db, TOKEN, 'old') === null && !db.prepare("SELECT 1 FROM sessions WHERE token = 'old'").get());
}

console.log('legacy token after the ownership migration');
{
    // Two accounts, so the migration has to be told whose data this is.
    const db = legacyDb();
    db.prepare("INSERT INTO users VALUES ('first', 'h', '2025-01-01')").run();
    db.prepare("INSERT INTO users VALUES ('alex', 'h', '2025-02-01')").run();
    migrateUsers(db);
    migrateOwnership(db, { env: { TENANCY_OWNER: 'alex' } });
    const alex = db.prepare("SELECT id FROM users WHERE username = 'alex'").get().id;
    db.prepare("UPDATE users SET role = 'user' WHERE username = 'alex'").run();
    db.prepare("UPDATE users SET role = 'admin' WHERE username = 'first'").run();
    const who = identify(db, TOKEN, TOKEN);
    check('the token acts as the pinned owner, even demoted and with a lower-id admin around',
        who?.username === 'alex' && who.id === alex && who.via === 'token', JSON.stringify(who));
    deleteUserData(db, alex);
    check('a token whose pinned account is gone resolves to nobody', identify(db, TOKEN, TOKEN) === null);
}

// --- 4. Backup ---
console.log('backup');
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-users-'));
    const file = path.join(dir, 'sync.db');
    const db = legacyDb(file);
    db.pragma('journal_mode = WAL');
    db.prepare("INSERT INTO users VALUES ('alex', 'h', '2025-01-01')").run();
    const bak = () => listBackups(file, 'bak-').map(f => f.name);
    const pre = () => listBackups(file, `pre-v${SCHEMA_VERSION}-`).map(f => f.name);

    // Seven older daily copies, as a server that has been running a while has.
    const t0 = new Date('2026-01-10T00:00:00Z');
    setSchemaVersion(db);
    for (let i = 7; i >= 1; i--) {
        backupDatabase(db, file, { keep: 7, intervalMs: 0, now: new Date(t0.getTime() - i * 86400000) });
    }
    db.pragma('user_version = 2');
    const daily = bak();
    check('seven daily copies to start with', daily.length === 7, daily.join(', '));

    const first = backupDatabase(db, file, { now: t0 });
    check('a schema step writes sync.db.pre-v3-*', first && path.basename(first).startsWith(`sync.db.pre-v${SCHEMA_VERSION}-`), first);
    const copy = new Database(first, { readonly: true });
    check('the copy holds the data (including WAL contents)',
        copy.prepare('SELECT username FROM users').get()?.username === 'alex');
    copy.close();

    // A container crash-looping below the new version: eight boots, a minute apart.
    for (let i = 1; i <= 8; i++) {
        backupDatabase(db, file, { keep: 7, now: new Date(t0.getTime() + i * 60000) });
    }
    check('a crash loop keeps every older daily copy', JSON.stringify(bak()) === JSON.stringify(daily), bak().join(', '));
    check('and does not pile up pre-upgrade copies within ten minutes', pre().length === 1, pre().join(', '));
    backupDatabase(db, file, { now: new Date(t0.getTime() + 11 * 60000) });
    check('a later attempt, still below the version, takes a fresh one', pre().length === 2);

    setSchemaVersion(db);
    check('schema version recorded', db.pragma('user_version', { simple: true }) === SCHEMA_VERSION);
    const later = new Date(t0.getTime() + 3600000);
    check('no daily copy within the interval of the last one',
        backupDatabase(db, file, { now: new Date(t0.getTime() - 86400000 + 1000) }) === null);
    for (let i = 1; i <= 4; i++) {
        backupDatabase(db, file, { keep: 3, intervalMs: 0, now: new Date(later.getTime() + i * 60000) });
    }
    check('daily copies pruned to keep', bak().length === 3, bak().join(', '));
    check('oldest pruned first', !bak().includes(daily[0]) && !bak().includes(daily[6]));
    check('pruning never touches the pre-upgrade copies', pre().length === 2);

    const empty = new Database(path.join(dir, 'fresh.db'));
    check('brand-new database is not backed up', backupDatabase(empty, path.join(dir, 'fresh.db')) === null);
    empty.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
}

// --- 5. Ids, names, passwords ---
console.log('ids, names, passwords');
{
    const db = legacyDb();
    db.prepare("INSERT INTO users VALUES ('alex', 'h', '2025-01-01')").run();
    migrateUsers(db);
    migrateOwnership(db, { env: {} });
    const sam = await createUser(db, { username: 'sam', password: 'sam-password' });
    const kim = await createUser(db, { username: 'kim', password: 'kim-password' });
    deleteUserData(db, kim.id);
    const lee = await createUser(db, { username: 'lee', password: 'lee-password' });
    check('the highest id is not reused after its account is deleted', lee.id === kim.id + 1, `${kim.id} -> ${lee.id}`);
    check('a new account starts at a fresh tree version',
        Number(db.prepare("SELECT value FROM user_tree_meta WHERE user_id = ? AND key = 'treeVersion'").get(lee.id)?.value) > 0);

    const clash = async (name) => { try { await createUser(db, { username: name, password: 'long-enough' }); return null; } catch (e) { return e; } };
    const upper = await clash('Alex');
    check('"Alex" refused when "alex" exists', upper && upper.code === 'name-clash' && /too close to existing "alex"/.test(upper.message),
        upper && upper.message);
    check('a deleted account\'s name is refused, in any case', (await clash('KIM'))?.code === 'name-clash' && (await clash('kim'))?.code === 'name-clash');
    check('the exact same name is refused', (await clash('sam'))?.code === 'name-clash');
    check('a refused name created nothing', db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 3);
    void sam;

    check('7-character password refused', Boolean(validatePassword('1234567').error));
    check('8-character password accepted', validatePassword('12345678').password === '12345678');
    check('256-character password accepted', !validatePassword('x'.repeat(256)).error);
    check('257-character password refused', Boolean(validatePassword('x'.repeat(257)).error));
}

console.log(failures === 0 ? '\nAll users tests passed.\n' : `\n${failures} test(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
