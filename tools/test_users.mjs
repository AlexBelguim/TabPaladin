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
//      acts as the first admin; anything else resolves to nobody.
//   4. A backup is written before a schema change, not again within the
//      interval, and pruned to `keep`.
//
// Run: node tools/test_users.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from '../server/node_modules/better-sqlite3/lib/index.js';
import {
    migrateUsers, bootstrapAdmin, identify, backupDatabase, setSchemaVersion, createUser, SCHEMA_VERSION
} from '../server/users.js';
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

// --- 4. Backup ---
console.log('backup');
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-users-'));
    const file = path.join(dir, 'sync.db');
    const db = legacyDb(file);
    db.pragma('journal_mode = WAL');
    db.prepare("INSERT INTO users VALUES ('alex', 'h', '2025-01-01')").run();
    const list = () => fs.readdirSync(dir).filter(f => f.startsWith('sync.db.bak-')).sort();

    const t0 = new Date('2026-01-01T00:00:00Z');
    const first = backupDatabase(db, file, { now: t0 });
    check('pre-migration backup written', first && list().length === 1);
    const copy = new Database(first, { readonly: true });
    check('backup holds the data (including WAL contents)',
        copy.prepare('SELECT username FROM users').get()?.username === 'alex');
    copy.close();

    setSchemaVersion(db);
    check('schema version recorded', db.pragma('user_version', { simple: true }) === SCHEMA_VERSION);
    check('no second backup within the interval', backupDatabase(db, file, { now: new Date(t0.getTime() + 1000) }) === null);

    for (let i = 1; i <= 4; i++) {
        backupDatabase(db, file, { keep: 3, intervalMs: 0, now: new Date(t0.getTime() + i * 60000) });
    }
    check('pruned to keep', list().length === 3, list().join(', '));
    check('oldest pruned first', !list().includes(path.basename(first)));

    const empty = new Database(path.join(dir, 'fresh.db'));
    check('brand-new database is not backed up', backupDatabase(empty, path.join(dir, 'fresh.db')) === null);
    empty.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nAll users tests passed.\n' : `\n${failures} test(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
