// Accounts, first-run bootstrap and the boot-time backup. Kept out of index.js
// so they can be tested against a throwaway database (tools/test_users.mjs).
//
// Accounts follow PulseReader's model: the first admin comes from
// ADMIN_USERNAME / ADMIN_PASSWORD in the environment on first start and the
// environment is ignored after that, so editing .env later changes nobody's
// password. There is no way to claim a server over HTTP.

import fs from 'node:fs';
import path from 'node:path';
import { hashPassword, sameSecret } from './security.js';

// Bumped whenever a boot-time migration changes the schema; a database below
// it is backed up before anything touches it.
export const SCHEMA_VERSION = 2;

export const MIN_PASSWORD_LENGTH = 8;

// --- Backup ---
//
// VACUUM INTO writes a consistent copy including anything still in the WAL,
// which a plain file copy of sync.db would miss. One is taken when the schema
// is about to change, and otherwise at most once per `intervalMs`, so a
// container stuck restarting can't rotate the pre-upgrade copy away.
export function backupDatabase(db, dbPath, { keep = 7, intervalMs = 24 * 3600 * 1000, now = new Date() } = {}) {
    const dir = path.dirname(dbPath);
    const base = path.basename(dbPath) + '.bak-';
    const existing = fs.readdirSync(dir).filter(f => f.startsWith(base)).sort(); // timestamps sort lexically

    const userVersion = db.pragma('user_version', { simple: true });
    const hasData = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n > 0;
    if (!hasData) return null; // brand-new database: nothing to lose

    const newest = existing[existing.length - 1];
    const newestAt = newest ? stampTime(newest.slice(base.length)) : 0;
    const due = userVersion < SCHEMA_VERSION || now.getTime() - newestAt >= intervalMs;
    if (!due) return null;

    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const target = path.join(dir, base + stamp);
    db.prepare('VACUUM INTO ?').run(target);

    // Prune the oldest beyond `keep`, never the one just written.
    const all = [...existing, base + stamp].sort();
    for (const f of all.slice(0, Math.max(0, all.length - keep))) {
        try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* already gone */ }
    }
    return target;
}

// 2026-01-01T00-00-00-000Z -> ms; 0 for anything unparseable, which only makes
// a backup due sooner.
function stampTime(stamp) {
    const m = stamp.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/);
    return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) || 0 : 0;
}

// --- Schema ---
//
// Additive only. The users table predates roles and numeric ids; existing
// rows keep their username, password and sessions and gain an id (their
// rowid, which VACUUM may renumber — hence a real column) and a role. The
// oldest account becomes the admin, so an upgraded single-user server keeps
// working exactly as before.
export function migrateUsers(db) {
    const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
    db.transaction(() => {
        if (!cols.includes('id')) db.exec('ALTER TABLE users ADD COLUMN id INTEGER');
        if (!cols.includes('role')) db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
        db.exec('UPDATE users SET id = rowid WHERE id IS NULL');
        db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_id ON users(id)');
        const hasAdmin = db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get();
        if (!hasAdmin) {
            db.exec(`UPDATE users SET role = 'admin'
                     WHERE id = (SELECT id FROM users ORDER BY created_at, id LIMIT 1)`);
        }
    })();
}

export function setSchemaVersion(db) {
    if (db.pragma('user_version', { simple: true }) < SCHEMA_VERSION) {
        db.pragma(`user_version = ${SCHEMA_VERSION}`);
    }
}

export function validateUsername(name) {
    const username = String(name ?? '').trim();
    if (!/^[\p{L}\p{N}._@-]{1,64}$/u.test(username)) {
        return { error: 'Username: 1-64 letters, numbers, dots, dashes, underscores or @.' };
    }
    return { username };
}

export async function createUser(db, { username, password, role = 'user' }) {
    const nextId = db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM users').get().n;
    db.prepare('INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(nextId, username, await hashPassword(password), role, new Date().toISOString());
    return userById(db, nextId);
}

export const userCount = (db) => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
export const userById = (db, id) => db.prepare('SELECT id, username, role, password_hash FROM users WHERE id = ?').get(id);
export const userByName = (db, username) =>
    db.prepare('SELECT id, username, role, password_hash FROM users WHERE username = ?').get(String(username));
export const firstAdmin = (db) =>
    db.prepare("SELECT id, username, role, password_hash FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();

export const publicUser = (u) => u && { id: u.id, username: u.username, role: u.role };

// --- First run ---
//
// Creates the first admin from ADMIN_USERNAME / ADMIN_PASSWORD when there are
// no users, falling back to the legacy AUTH_TOKEN as the password so a
// token-only deployment can sign in with what it already has. Ignored once
// any user exists. Returns { ok, created?, error? }.
export async function bootstrapAdmin(db, env) {
    if (userCount(db) > 0) return { ok: true };
    const password = env.ADMIN_PASSWORD || env.AUTH_TOKEN;
    if (!password) {
        return { ok: false, error: 'No account yet. Set ADMIN_PASSWORD (and optionally ADMIN_USERNAME, default "admin") to create the first admin, then restart.' };
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
        return { ok: false, error: `ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.` };
    }
    const { username, error } = validateUsername(env.ADMIN_USERNAME || 'admin');
    if (error) return { ok: false, error: `ADMIN_USERNAME: ${error}` };
    const user = await createUser(db, { username, password, role: 'admin' });
    return { ok: true, created: user, fromToken: !env.ADMIN_PASSWORD };
}

// --- Who is calling ---
//
// A session token from /api/login, or the legacy AUTH_TOKEN acting as the
// first admin (for scripts and clients that predate logins). Bearer tokens,
// not cookies: the extension calls cross-origin.
export function presentedToken(req) {
    const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/);
    return m ? m[1] : (req.headers['x-api-key'] || null);
}

export function identify(db, authToken, token) {
    if (!token) return null;
    const row = db.prepare(`
        SELECT s.expires_at, u.id, u.username, u.role
        FROM sessions s JOIN users u ON u.username = s.username
        WHERE s.token = ?`).get(token);
    if (row) {
        if (new Date(row.expires_at).getTime() < Date.now()) {
            db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
            return null;
        }
        return { id: row.id, username: row.username, role: row.role, via: 'session' };
    }
    if (authToken && sameSecret(token, authToken)) {
        const admin = firstAdmin(db);
        return admin ? { ...publicUser(admin), via: 'token' } : null;
    }
    return null;
}
