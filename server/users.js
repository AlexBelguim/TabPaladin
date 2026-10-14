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
import { initTenancySchema, nextUserId, bumpTreeVersion, getServerMeta } from './tenancy.js';

// Bumped whenever a boot-time migration changes the schema; a database below
// it is backed up before anything touches it. 3: every row names its account.
// 4: shared links are a per-account inbox with filings (shares.js), and the
// tree logs its appends (tree_ops). 5 (AI access): proposals gain bookmark
// changes and where they came from (proposals.js), and MCP tokens get a
// table (mcp.js).
export const SCHEMA_VERSION = 5;

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 256;

// --- Backup ---
//
// VACUUM INTO writes a consistent copy including anything still in the WAL,
// which a plain file copy of sync.db would miss.
//
// Two kinds, under their own prefixes so neither can rotate the other away:
//   sync.db.pre-v<N>-<ts>  before a schema step to version N. Never pruned —
//                          it is the rollback point — and not taken again
//                          within ten minutes while the step has not
//                          happened, so a container stuck restarting does not
//                          pile them up.
//   sync.db.bak-<ts>       otherwise at most once per `intervalMs`, newest
//                          `keep` kept. Skipped while a schema step is
//                          pending, so a crash loop below the new version
//                          cannot replace every older daily copy with
//                          identical pre-upgrade ones.
const SCHEMA_BACKUP_REUSE_MS = 10 * 60 * 1000;

export function backupDatabase(db, dbPath, { keep = 7, intervalMs = 24 * 3600 * 1000, now = new Date() } = {}) {
    const userVersion = db.pragma('user_version', { simple: true });
    const hasData = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n > 0;
    if (!hasData) return null; // brand-new database: nothing to lose

    if (userVersion < SCHEMA_VERSION) {
        const label = `pre-v${SCHEMA_VERSION}`;
        const recent = listBackups(dbPath, label + '-')
            .some(f => now.getTime() - f.at >= 0 && now.getTime() - f.at < SCHEMA_BACKUP_REUSE_MS);
        if (recent) return null;
        return backupNow(db, dbPath, label, { keep: 0, now });
    }

    const existing = listBackups(dbPath, 'bak-');
    const newestAt = existing.length ? existing[existing.length - 1].at : 0;
    if (now.getTime() - newestAt < intervalMs) return null;
    return backupNow(db, dbPath, 'bak', { keep, now });
}

// A copy right now, as sync.db.<label>-<timestamp>. With `keep`, prunes the
// oldest files under `prunePrefix` (default: this label) beyond that many,
// never the one just written. Throws if the copy cannot be written.
export function backupNow(db, dbPath, label, { keep = 0, prunePrefix = label + '-', now = new Date() } = {}) {
    const dir = path.dirname(dbPath);
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const name = `${path.basename(dbPath)}.${label}-${stamp}`;
    const target = path.join(dir, name);
    db.prepare('VACUUM INTO ?').run(target);

    if (keep > 0) {
        const all = listBackups(dbPath, prunePrefix);
        for (const f of all.slice(0, Math.max(0, all.length - keep))) {
            if (f.name === name) continue;
            try { fs.unlinkSync(path.join(dir, f.name)); } catch (e) { /* already gone */ }
        }
    }
    return target;
}

// Backups whose name starts with sync.db.<prefix>, oldest first by the
// timestamp that ends every name.
export function listBackups(dbPath, prefix) {
    const dir = path.dirname(dbPath);
    const base = path.basename(dbPath) + '.' + prefix;
    return fs.readdirSync(dir)
        .filter(f => f.startsWith(base))
        .map(name => ({ name, at: stampTime(name.slice(-24)) }))
        .sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
}

export function latestBackup(dbPath, prefix) {
    const all = listBackups(dbPath, prefix);
    return all.length ? path.join(path.dirname(dbPath), all[all.length - 1].name) : null;
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

export function validatePassword(value) {
    const password = String(value ?? '');
    if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
        return { error: `Password: ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters.` };
    }
    return { password };
}

// An existing or deleted account whose name differs from this one only by
// case. Signing in to an empty "Alex" instead of "alex" looks exactly like
// "all my bookmarks are gone" and invites a force push, so such names are
// refused. Returns the clashing name, or null.
export function usernameClash(db, username) {
    initTenancySchema(db);
    const want = String(username).normalize('NFKC').toLowerCase();
    const names = [
        ...db.prepare('SELECT username FROM users').all(),
        ...db.prepare('SELECT username FROM deleted_users').all()
    ].map(r => r.username);
    return names.find(n => String(n).normalize('NFKC').toLowerCase() === want) || null;
}

export async function createUser(db, { username, password, role = 'user' }) {
    return insertUser(db, { username, passwordHash: await hashPassword(password), role });
}

// Synchronous, so a caller can repeat its own checks in the same transaction.
// The id comes from a counter that never goes back, so a new account cannot
// inherit a deleted one's rows or sessions. Once accounts are separated, a new
// one starts at a fresh tree version from the global sequence.
export function insertUser(db, { username, passwordHash, role = 'user' }) {
    initTenancySchema(db);
    return db.transaction(() => {
        const clash = usernameClash(db, username);
        if (clash) {
            const err = new Error(clash === username
                ? `"${username}" already exists or belonged to a deleted account.`
                : `"${username}" is too close to existing "${clash}".`);
            err.code = 'name-clash';
            throw err;
        }
        const id = nextUserId(db);
        db.prepare('INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(id, username, passwordHash, role, new Date().toISOString());
        if (getServerMeta(db, 'tenancy_owner_id') !== null) bumpTreeVersion(db, id);
        return userById(db, id);
    })();
}

export const userCount = (db) => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
export const userById = (db, id) => db.prepare('SELECT id, username, role, password_hash FROM users WHERE id = ?').get(id);
export const userByName = (db, username) =>
    db.prepare('SELECT id, username, role, password_hash FROM users WHERE username = ?').get(String(username));
export const firstAdmin = (db) =>
    db.prepare("SELECT id, username, role, password_hash FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();

export const publicUser = (u) => u && { id: u.id, username: u.username, role: u.role };

// Who held the data before accounts were separated, and who the legacy
// AUTH_TOKEN acts as. Both are written once, by the ownership migration, and
// only change by hand (see the README), which needs a restart — so a value,
// once found, is cached.
const metaCache = new WeakMap();
function cachedMeta(db, key) {
    let cache = metaCache.get(db);
    if (!cache) metaCache.set(db, cache = new Map());
    if (cache.has(key)) return cache.get(key);
    const value = getServerMeta(db, key);
    if (value === null) return null;
    cache.set(key, Number(value));
    return Number(value);
}
export const tenancyOwnerId = (db) => cachedMeta(db, 'tenancy_owner_id');
export const legacyTokenUserId = (db) => cachedMeta(db, 'legacy_token_user_id');

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
// A session token from /api/login, or the legacy AUTH_TOKEN (for scripts and
// clients that predate logins). The token acts as the account the ownership
// migration pinned it to — the one that owned the data it used to reach — and
// never moves to whichever admin happens to have the lowest id. If that
// account is gone the token is refused. Only before the migration has run does
// it fall back to the first admin. Bearer tokens, not cookies: the extension
// calls cross-origin.
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
        const pinned = legacyTokenUserId(db);
        const user = pinned !== null ? userById(db, pinned) : firstAdmin(db);
        return user ? { ...publicUser(user), via: 'token' } : null;
    }
    return null;
}
