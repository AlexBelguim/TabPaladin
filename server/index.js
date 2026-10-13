import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { attachImports, initSchema as initImportsSchema } from './imports/index.js';
import { buildImportsTree } from './imports/project.js';
import { makeItemsStore, ForeignIdError } from './items.js';
import {
    authTokenProblem, hashPassword, verifyPassword, makeRateLimiter
} from './security.js';
import {
    backupDatabase, backupNow, latestBackup, migrateUsers, setSchemaVersion, bootstrapAdmin,
    userCount as countUsers, userById, userByName, publicUser, presentedToken, identify,
    tenancyOwnerId, legacyTokenUserId, MIN_PASSWORD_LENGTH, SCHEMA_VERSION
} from './users.js';
import {
    initTenancySchema, migrateOwnership, preflight, writeRefusal, checkOwnership, serverId
} from './tenancy.js';
import { attachPrefs } from './prefs.js';
import { attachUserAdmin } from './admin.js';
import { migrateShares, makeSharesStore, attachShareRoutes } from './shares.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 18921);
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PWA_DIR = process.env.PWA_DIR || path.resolve(__dirname, '..', 'pwa');
const MAX_SNAPSHOTS = Number(process.env.MAX_SNAPSHOTS || 200);
// Per-account caps. They refuse new rows and never prune existing ones: one
// account filling the disk would otherwise make everyone's pushes fail. The
// inbox cap counts the links still waiting to be filed.
const MAX_INBOX_PER_USER = Math.max(1, Number(process.env.MAX_INBOX_PER_USER || 5000));
const MAX_PROPOSALS_PER_USER = Math.max(1, Number(process.env.MAX_PROPOSALS_PER_USER || 200));

// Refuse to run with a guessable legacy token: real deployments are reachable
// from the internet, and "authenticated" with a published value is worse than
// off.
const tokenProblem = authTokenProblem(AUTH_TOKEN);
if (tokenProblem) {
    console.error(`[TabPaladin] Refusing to start: ${tokenProblem}`);
    console.error('[TabPaladin] Or remove AUTH_TOKEN / TABPALADIN_TOKEN entirely to use account logins only.');
    process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
// The image runs as the unprivileged `node` user now; a data directory written
// by an older image running as root is not writable until it is handed over.
// Say so plainly rather than die on an SQLite "readonly database" later.
for (const f of ['', 'sync.db', 'sync.db-wal', 'sync.db-shm']) {
    const p = path.join(DATA_DIR, f);
    if (f && !fs.existsSync(p)) continue;
    try {
        fs.accessSync(p, fs.constants.W_OK);
    } catch (e) {
        const uid = typeof process.getuid === 'function' ? process.getuid() : '?';
        console.error(`[TabPaladin] Refusing to start: ${p} is not writable by uid ${uid}.`);
        console.error(`[TabPaladin] On the host, run once: sudo chown -R ${uid}:${uid} <your data directory>`);
        process.exit(1);
    }
}
const DB_PATH = path.join(DATA_DIR, 'sync.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// --- Boot ---
//
// The order matters and each step says why:
//   1. preflight, before anything is written — a database from a newer build,
//      a migration refused on an earlier boot, or too little disk all stop
//      here, without taking yet another backup;
//   2. the boot backup;
//   3. the schema: CREATE IF NOT EXISTS and additive ALTERs only;
//   4. the first admin, so a token-only database has an owner to migrate to;
//   5. the ownership migration, one transaction, refused rather than guessed,
//      then the share inbox's columns and the tree's ops floors (additive,
//      idempotent, after the ownership migration has named every row's owner);
//   6. the schema version and, the first time, a post-migration copy;
//   7. ownership warnings, then the owner's own boot steps;
//   8. routes and the import scheduler, then listen.
const pre = preflight(db, DB_PATH, { schemaVersion: SCHEMA_VERSION });
if (!pre.ok) {
    console.error(`[TabPaladin] Refusing to start: ${pre.error}`);
    process.exit(1);
}

// Before any migration below touches the data: a consistent copy next to it.
// sync.db.pre-v<N>-<timestamp> before a schema step (kept, never rotated), and
// otherwise sync.db.bak-<timestamp> at most daily, the newest BACKUP_KEEP kept.
try {
    const backup = backupDatabase(db, DB_PATH, { keep: Math.max(1, Number(process.env.BACKUP_KEEP || 7)) });
    if (backup) console.log(`[TabPaladin] Backed up the database to ${backup}`);
} catch (e) {
    console.error(`[TabPaladin] Refusing to start: the boot backup failed (${e.message}). Nothing was changed.`);
    process.exit(1);
}
const schemaBackup = latestBackup(DB_PATH, `pre-v${SCHEMA_VERSION}-`);

db.exec(`
    -- History of the tree. Rows written before the items table existed hold
    -- whole browser-tree blobs; rows written since hold {format: 2, roots}.
    CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        device_id TEXT,
        json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON snapshots(timestamp DESC);

    CREATE TABLE IF NOT EXISTS shared_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        title TEXT,
        created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_shared_created ON shared_links(created_at DESC);

    CREATE TABLE IF NOT EXISTS share_tokens (
        token TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS note_proposals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
    );

    -- Login. Single account in practice, but a table so the constraint is the
    -- product decision rather than the schema.
    CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
    );

    -- Sessions issued by /api/login. Long-lived on purpose: this is a personal
    -- sync server on a private tailnet, and being logged out of your phone
    -- every week is how people end up disabling auth altogether.
    CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
`);

// Migrations for existing databases.
try { db.prepare('ALTER TABLE note_proposals ADD COLUMN notebook TEXT').run(); } catch (e) { /* column already exists */ }
try { db.prepare("ALTER TABLE note_proposals ADD COLUMN kind TEXT NOT NULL DEFAULT 'note'").run(); } catch (e) { /* column already exists */ }
migrateUsers(db);
initTenancySchema(db);
initImportsSchema(db);
// The canonical tree. CREATE TABLE only here; everything that reads or writes
// it goes through items.forUser(id).
const items = makeItemsStore(db, { maxSnapshots: MAX_SNAPSHOTS });

// --- Accounts ---
//
// The first admin is created here, from ADMIN_USERNAME / ADMIN_PASSWORD, on the
// first start with no users; after that the environment is ignored. There is
// no way to claim a server over HTTP.
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 180);
const userCount = () => countUsers(db);

const boot = await bootstrapAdmin(db, process.env);
if (!boot.ok) {
    console.error(`[TabPaladin] Refusing to start: ${boot.error}`);
    process.exit(1);
}
if (boot.created) {
    console.log(`[TabPaladin] Created admin account "${boot.created.username}"`
        + (boot.fromToken ? ' with AUTH_TOKEN as its password (no ADMIN_PASSWORD was set).' : ' from ADMIN_PASSWORD.'));
}

// --- Ownership ---
//
// Every row names the account it belongs to. The first boot of this version
// assigns everything to the one account that existed (or to TENANCY_OWNER),
// proves nothing else changed, and is refused — rolled back, marker written,
// server stopped — rather than guessing. See tenancy.js.
let tenancy;
try {
    tenancy = migrateOwnership(db, {
        env: process.env,
        bootstrappedUserIds: boot.created ? [boot.created.id] : []
    });
} catch (e) {
    const marker = writeRefusal(DATA_DIR, e, schemaBackup);
    console.error(`[TabPaladin] Tenancy migration refused, nothing changed, backup at ${schemaBackup || '(none)'}: ${e.message}`);
    console.error(`[TabPaladin] Fix the cause, delete ${marker}, and restart.`);
    process.exit(1);
}
// The inbox becomes per-account shares with filings (shares.js). One
// transaction of additive steps: refused like the ownership migration, with
// nothing changed, rather than half-applied.
try {
    const shares = migrateShares(db);
    if (shares.added.length) console.log(`[TabPaladin] Share inbox: added ${shares.added.join(', ')} to shared_links.`);
    const floors = items.initOpsFloors();
    if (floors) console.log(`[TabPaladin] Started the tree ops log for ${floors} account(s).`);
} catch (e) {
    const marker = writeRefusal(DATA_DIR, e, schemaBackup);
    console.error(`[TabPaladin] Share inbox migration refused, nothing changed, backup at ${schemaBackup || '(none)'}: ${e.message}`);
    console.error(`[TabPaladin] Fix the cause, delete ${marker}, and restart.`);
    process.exit(1);
}
setSchemaVersion(db);
if (tenancy.migrated) {
    // A frozen copy of the database right after the migration, before any
    // client can push: verify_tenancy.js compares it with the pre-v3 copy.
    // A brand-new database had nothing to compare, so it gets none.
    let postCopy = '(none)';
    if (schemaBackup) {
        try {
            postCopy = backupNow(db, DB_PATH, `post-v${SCHEMA_VERSION}`);
        } catch (e) {
            console.warn(`[TabPaladin] Could not write the post-migration copy: ${e.message}`);
        }
    }
    db.pragma('wal_checkpoint(TRUNCATE)');
    console.log(`[TabPaladin] Tenancy migration: assigned ${tenancy.total} rows to ${tenancy.owner.username} (#${tenancy.owner.id}); `
        + `recovered ${tenancy.recovered} removed import source(s); `
        + `pre-upgrade copy ${schemaBackup ? path.basename(schemaBackup) : '(none)'}; post-upgrade copy ${path.basename(postCopy)}`);
} else if (tenancy.adoptedTotal) {
    console.warn(`[TabPaladin] Adopted ${tenancy.adoptedTotal} unowned row(s) as ${tenancy.adoptedTo.username}'s: `
        + Object.entries(tenancy.adopted).map(([t, n]) => `${t} ${n}`).join(', '));
}
for (const warning of checkOwnership(db)) console.warn(`[TabPaladin] Ownership: ${warning}`);
// Sent with every sign-in and tree response, so a client can tell this
// server's accounts from another server's with the same ids (see tenancy.js).
const SERVER_ID = serverId(db);

// The owner's boot steps, only while the owner exists: rows for an account
// that is gone would be refused by the guards anyway.
const ownerId = tenancyOwnerId(db);
if (ownerId !== null && userById(db, ownerId)) {
    const ownerItems = items.forUser(ownerId);
    // On the first boot after the items table arrived, this converts the
    // newest browser-tree snapshot into rows, so nothing is lost switching over.
    const migration = ownerItems.migrateFromLatestSnapshotIfNeeded();
    if (migration.migrated) {
        console.log(`[TabPaladin] Migrated latest snapshot into the items table (${migration.nodes} nodes).`);
    }
    // One bookmarks folder, called Bookmarks, holding everything else.
    // Idempotent: a tree that already has one is left exactly as arranged.
    const bookmarksRoot = ownerItems.ensureBookmarksRoot();
    if (bookmarksRoot.created) {
        console.log('[TabPaladin] Created the Bookmarks root.');
    } else if (bookmarksRoot.renamedFrom) {
        console.log(`[TabPaladin] Designated "${bookmarksRoot.renamedFrom}" as the Bookmarks root`
            + (bookmarksRoot.moved ? ` and moved ${bookmarksRoot.moved} top-level folder(s) into it.` : '.'));
    }
} else {
    console.warn('[TabPaladin] The tenancy owner account no longer exists; skipping its boot steps.');
}
const healed = items.healAllUsers();
for (const h of healed.users) {
    console.log(`[TabPaladin] Merged duplicate role folders for account #${h.userId}: ${h.roles.join(', ')}.`);
}
if (AUTH_TOKEN && legacyTokenUserId(db) !== null && !userById(db, legacyTokenUserId(db))) {
    console.warn('[TabPaladin] AUTH_TOKEN is set but the account it acts as no longer exists; requests with it get 401.');
}

const app = express();
// So req.protocol and req.ip reflect X-Forwarded-* behind a reverse proxy. Not
// `true`: that trusts a client-supplied X-Forwarded-For when the server is hit
// directly, which would let anyone dodge the login rate limit by inventing
// IPs. The default trusts proxies on loopback and private networks — a reverse
// proxy or tunnel container on the same host or LAN. Set TRUST_PROXY to
// anything Express accepts ("true", a hop count, a subnet list) otherwise.
const TRUST_PROXY = process.env.TRUST_PROXY || 'loopback, uniquelocal';
app.set('trust proxy', /^(true|false)$/.test(TRUST_PROXY) ? TRUST_PROXY === 'true'
    : /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY);

// CORS: the PWA is served from this origin and needs none. The browser
// extension calls cross-origin from chrome-extension:// / moz-extension://
// with a bearer token, so those are always allowed; any other origin (a
// separately hosted client) must be listed in CORS_ORIGIN. No cookies are
// used, so credentials stay off.
const CORS_ORIGINS = new Set((process.env.CORS_ORIGIN || '').split(',').map(o => o.trim()).filter(Boolean));
const EXTENSION_ORIGIN = /^(chrome-extension|moz-extension|safari-web-extension):\/\/[\w.-]+$/;
app.use(cors((req, cb) => {
    const origin = req.headers.origin;
    let allowed = !origin || EXTENSION_ORIGIN.test(origin) || CORS_ORIGINS.has(origin);
    if (!allowed) {
        try { allowed = new URL(origin).host === req.get('host'); } catch (e) { /* malformed */ }
    }
    cb(null, {
        origin: allowed,
        credentials: false,
        allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key']
    });
}));

// Small bodies everywhere except a tree push, which carries the whole tree.
const jsonSmall = express.json({ limit: '1mb' });
const jsonTree = express.json({ limit: process.env.TREE_BODY_LIMIT || '50mb' });
app.use((req, res, next) => (req.method === 'PUT' && req.path === '/api/tree' ? next() : jsonSmall(req, res, next)));

// Defensive: ensure intermediaries (Cloudflare, etc.) don't cache sync responses.
app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
});

// Failed sign-in attempts per client IP and username, so a household behind
// one NAT does not share a single budget — one person's typos must not lock
// out everyone else — plus a looser ceiling per IP against a guesser cycling
// through usernames.
const AUTH_MAX_FAILURES = Number(process.env.AUTH_MAX_FAILURES || 10);
const AUTH_WINDOW_MS = Number(process.env.AUTH_WINDOW_MINUTES || 15) * 60 * 1000;
const authLimiter = makeRateLimiter({ max: AUTH_MAX_FAILURES, windowMs: AUTH_WINDOW_MS });
const ipLimiter = makeRateLimiter({
    max: Number(process.env.AUTH_IP_MAX_FAILURES || AUTH_MAX_FAILURES * 5),
    windowMs: AUTH_WINDOW_MS
});
const limiterKey = (req, username) => `${req.ip}:${String(username || '').trim().toLowerCase()}`;

function rateLimited(req, res, username) {
    const wait = Math.max(authLimiter.retryAfter(limiterKey(req, username)), ipLimiter.retryAfter(req.ip));
    if (!wait) return false;
    res.set('Retry-After', String(wait));
    res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} minute(s).` });
    return true;
}
function authFailed(req, username) {
    authLimiter.fail(limiterKey(req, username));
    ipLimiter.fail(req.ip);
}
const authOk = (req, username) => authLimiter.reset(limiterKey(req, username));

function issueSession(username) {
    const token = crypto.randomBytes(32).toString('hex');
    const now = new Date();
    const expires = new Date(now.getTime() + SESSION_DAYS * 86400000);
    db.prepare('INSERT INTO sessions (token, username, created_at, expires_at) VALUES (?, ?, ?, ?)')
        .run(token, username, now.toISOString(), expires.toISOString());
    // Opportunistic cleanup — no scheduler needed for a handful of rows.
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now.toISOString());
    return { token, expiresAt: expires.toISOString() };
}

// --- Auth middleware ---
//
// Accepts a session token from /api/login, or the legacy AUTH_TOKEN, which acts
// as the account that owned the data before accounts were separated — for
// scripts, and so an extension that hasn't signed in yet keeps syncing while
// you migrate. Sets req.user = { id, username, role, via }.
// Bearer tokens only, never cookies, so cross-origin requests can't ride on a
// browser's ambient credentials.
function requireAuth(req, res, next) {
    const user = identify(db, AUTH_TOKEN, presentedToken(req));
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    req.user = user;
    next();
}

// --- Auth endpoints ---

// Unauthenticated on purpose: a client needs to know whether the server is
// usable before it has any credentials.
app.get('/api/auth/status', (req, res) => {
    res.json({
        ok: true,
        hasAccount: userCount() > 0,
        legacyTokenEnabled: Boolean(AUTH_TOKEN)
    });
});

// The old over-the-network first-run claim. Gone: whoever reached a fresh
// server first owned it. Accounts come from the environment now.
app.post('/api/auth/setup', (req, res) => res.status(410).json({
    error: 'Accounts are no longer created from the app. Set ADMIN_USERNAME and ADMIN_PASSWORD in the server\'s .env and restart it, then sign in.'
}));

// tenancyOwner is about the caller only: whether this account holds the data
// from before accounts were separated. Clients use it to decide whether an
// unstamped working copy (or an older per-device list) is this account's.
const userFor = (u) => ({ ...publicUser(u), tenancyOwner: u.id === tenancyOwnerId(db) });

app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ ok: true, user: userFor(req.user), serverId: SERVER_ID });
});

// The caller as things stand now. requireAuth looked before the handler's
// awaits (scrypt), and a reset, a delete or a sign-out everywhere may have
// landed in between. Call it in the same synchronous step as the write it
// guards, so nothing else can land between the check and the write.
const stillSignedIn = (req) => {
    const now = identify(db, AUTH_TOKEN, presentedToken(req));
    return Boolean(now && now.id === req.user.id);
};

// A real hash to check against when the username is unknown, so a missing
// account and a wrong password cost the same and can't be told apart.
const DUMMY_HASH = await hashPassword(crypto.randomBytes(16).toString('hex'));

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body || {};
        if (rateLimited(req, res, username)) return;
        if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });

        const row = userByName(db, String(username).trim());
        const ok = await verifyPassword(password, row ? row.password_hash : DUMMY_HASH);
        // The account as it is after the await, not as it was before: a reset
        // or a delete that landed meanwhile signed it out everywhere, and a
        // sign-in with the password it replaced must not outlive it. Checked
        // and issued in one transaction, so neither can land in between.
        const session = row && ok ? db.transaction(() => {
            const now = userByName(db, row.username);
            return now && now.password_hash === row.password_hash ? issueSession(now.username) : null;
        })() : null;
        if (!session) {
            authFailed(req, username);
            return res.status(401).json({ error: 'Wrong username or password.' });
        }
        authOk(req, username);
        res.json({ ok: true, username: row.username, user: userFor(row), serverId: SERVER_ID, ...session });
    } catch (e) {
        console.error('[TabPaladin] Login failed:', e);
        res.status(500).json({ error: 'Sign in failed.' });
    }
});

app.post('/api/logout', requireAuth, (req, res) => {
    if (req.user.via === 'session') {
        db.prepare('DELETE FROM sessions WHERE token = ?').run(presentedToken(req));
    }
    res.json({ ok: true });
});

app.post('/api/auth/password', requireAuth, async (req, res) => {
    try {
        if (rateLimited(req, res, req.user.username)) return;
        const { currentPassword, newPassword } = req.body || {};
        if (!newPassword || String(newPassword).length < MIN_PASSWORD_LENGTH) {
            return res.status(400).json({ error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
        }
        const row = userByName(db, req.user.username);
        if (!row) return res.status(400).json({ error: 'No account to change.' });
        if (!(await verifyPassword(currentPassword, row.password_hash))) {
            authFailed(req, req.user.username);
            return res.status(401).json({ error: 'Current password is wrong.' });
        }
        const hash = await hashPassword(newPassword);
        // Same rule as a sign-in: an admin reset, a delete or a sign-out that
        // landed during the awaits wins, rather than being overwritten here.
        const session = db.transaction(() => {
            const now = userByName(db, row.username);
            if (!now || now.password_hash !== row.password_hash || !stillSignedIn(req)) return null;
            db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, row.id);
            db.prepare('DELETE FROM sessions WHERE username = ?').run(row.username);
            return issueSession(row.username);
        })();
        if (!session) return res.status(401).json({ error: 'Your password or session changed meanwhile. Sign in again.' });
        res.json({ ok: true, ...session });
    } catch (e) {
        console.error('[TabPaladin] Password change failed:', e);
        res.status(500).json({ error: 'Password change failed.' });
    }
});

// --- Health (no auth) ---
app.get('/api/health', (req, res) => {
    res.json({ ok: true, version: 2, configured: userCount() > 0 });
});

// --- Accounts and preferences ---
// Before the static handler, so /api/users and /api/prefs win over the PWA.
attachUserAdmin(app, {
    db, requireAuth, dbPath: DB_PATH, authToken: AUTH_TOKEN,
    limiter: { limited: rateLimited, fail: authFailed, ok: authOk }
});
attachPrefs(app, { db, requireAuth });

// --- Importers ---
// Attached before the tree routes so /api/tree can append the virtual imports
// subtree, and before the static handler so /api/imports/* wins over the PWA
// catch-all.
const { store: importsStore } = attachImports(app, {
    db, requireAuth,
    // The Reddit confirm page names the TabPaladin account receiving the connection.
    accountName: (id) => (userById(db, id) || {}).username || null
});

// --- Shared links ---
// The share sheet's inbox and filing (/api/shares*), the tree's ops log
// (/api/tree/ops) and the old /api/shared routes over the same rows.
// After the importers, because X and Instagram shares go to their archive.
const shares = makeSharesStore(db, { items, importsStore, maxPending: MAX_INBOX_PER_USER });
attachShareRoutes(app, { store: shares, items, requireAuth, serverId: SERVER_ID });

// --- The tree ---
//
// GET returns the caller's tree plus a virtual, read-only imports subtree that
// is composed from the archive at read time and never stored. PUT replaces the
// caller's tree wholesale — git-style: the client edits a local working copy
// and pushes it, and a push whose baseVersion is stale is refused so it cannot
// silently overwrite what another device pushed in between.
//
// Both carry userId and serverId, so a client can stamp its working copy with
// the account it belongs to and never push one account's tree into another's.
app.get('/api/tree', requireAuth, (req, res) => {
    const store = items.forUser(req.user.id);
    const { version, roots } = store.readTree();
    const importsTree = buildImportsTree(importsStore, req.user.id);
    if (importsTree) {
        // The archive belongs inside Bookmarks, not beside it — it is a
        // collection of bookmarks like any other, and a top-level sibling made
        // it look like a separate account. Falls back to the top level only if
        // there is no bookmarks root to hold it (a new account, until it makes
        // one).
        const rootId = store.bookmarksRootId();
        const host = rootId ? findNode(roots, rootId) : null;
        if (host) {
            host.children = [...(host.children || []), importsTree];
        } else {
            roots.push(importsTree);
        }
    }
    res.json({ ok: true, version, roots, userId: req.user.id, serverId: SERVER_ID });
});

function findNode(nodes, id) {
    for (const n of nodes) {
        if (n.id === id) return n;
        const hit = n.children ? findNode(n.children, id) : null;
        if (hit) return hit;
    }
    return null;
}

// Cheap freshness probe so clients can show "the server has newer" without
// downloading the whole tree.
app.get('/api/tree/version', requireAuth, (req, res) => {
    res.json({ ok: true, version: items.forUser(req.user.id).version(), userId: req.user.id, serverId: SERVER_ID });
});

// 412, not 409, when the working copy belongs to another account: clients turn
// a 409 into "pull or force", and both would be wrong here — a pull discards
// that account's edits, a force writes them into this one. Force does not
// override it. A copy from another server is another account too, even when
// the id matches: ids start at 1 everywhere.
const WRONG_ACCOUNT = 'This working copy belongs to another account.';

app.put('/api/tree', requireAuth, jsonTree, (req, res) => {
    const { roots, baseVersion, baseUserId, baseServerId, deviceId, force } = req.body || {};
    if (!Array.isArray(roots)) {
        return res.status(400).json({ error: 'Missing roots (array of top-level nodes).' });
    }
    const otherServer = baseServerId !== undefined && baseServerId !== null && String(baseServerId) !== SERVER_ID;
    if (otherServer || (baseUserId !== undefined && baseUserId !== null && Number(baseUserId) !== req.user.id)) {
        return res.status(412).json({
            error: otherServer ? 'This working copy belongs to an account on another server.' : WRONG_ACCOUNT,
            code: 'wrong-account', userId: req.user.id, serverId: SERVER_ID
        });
    }
    const store = items.forUser(req.user.id);
    const current = store.version();
    if (!force) {
        if (baseVersion === undefined || baseVersion === null) {
            return res.status(400).json({ error: 'Missing baseVersion — pull first, or pass force:true to overwrite.' });
        }
        if (Number(baseVersion) !== current) {
            return res.status(409).json({
                error: 'The tree changed on the server since your last pull. Pull, then push again.',
                version: current
            });
        }
    }
    // A forced push from an older base may erase links filed from the phone
    // since (they were never in the pusher's copy): those shares go back to
    // the inbox, in the same transaction as the push.
    const base = Number(baseVersion);
    const erasesUnseen = Boolean(force) && !(Number.isFinite(base) && base >= current);
    let version;
    try {
        version = db.transaction(() => {
            const v = store.writeTree(roots, { deviceId: deviceId || null });
            if (erasesUnseen) {
                shares.forUser(req.user.id).reopenAfterForce({ baseVersion: Number.isFinite(base) ? base : 0, deviceId: deviceId || null });
            }
            return v;
        })();
    } catch (e) {
        if (e instanceof ForeignIdError) {
            return res.status(412).json({ error: WRONG_ACCOUNT, code: 'foreign-ids', count: e.count, userId: req.user.id, serverId: SERVER_ID });
        }
        throw e;
    }
    res.json({ ok: true, version, userId: req.user.id, serverId: SERVER_ID });
});

// The old whole-browser-tree sync. Gone for good reason: it required mapping
// browser-specific root folders across vendors, and a mismatch deleted or
// duplicated data. A 410 with directions beats a 404 for any straggler client.
const goneHandler = (req, res) => res.status(410).json({
    error: 'Snapshot push/pull was replaced by /api/tree. Update the TabPaladin extension/PWA.'
});
app.post('/api/push', requireAuth, goneHandler);
app.get('/api/pull', requireAuth, goneHandler);

app.get('/api/history', requireAuth, (req, res) => {
    const rows = db.prepare('SELECT id, timestamp, device_id FROM snapshots WHERE user_id = ? ORDER BY timestamp DESC LIMIT 100')
        .all(req.user.id);
    res.json({ ok: true, snapshots: rows });
});

app.get('/api/history/:id', requireAuth, (req, res) => {
    const row = db.prepare('SELECT timestamp, device_id, json FROM snapshots WHERE id = ? AND user_id = ?')
        .get(req.params.id, req.user.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, timestamp: row.timestamp, deviceId: row.device_id, snapshot: JSON.parse(row.json) });
});

// The shared-links inbox lives in shares.js now (/api/shares*, and the old
// /api/shared routes over the same rows).

const SHARE_TTL_MS = Math.max(1, Number(process.env.SHARE_TTL_MINUTES || 60)) * 60 * 1000;

// The token and the account it shares. A token whose account was deleted is
// as dead as an expired one.
function getValidShareToken(req, res) {
    const row = db.prepare(`
        SELECT t.token, t.expires_at, t.user_id FROM share_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token = ?`).get(req.params.token);
    if (!row || Date.parse(row.expires_at) <= Date.now()) {
        res.status(410).json({ error: 'Share link expired or invalid.' });
        return null;
    }
    return row;
}

// --- LLM share links ---
// POST /api/share creates a 1-hour link the user can paste into any LLM chat.
// GET /llm/:token (no auth) serves the notes + instructions as plain text.
// POST /llm/:token/propose (no auth, also POST /llm/:token) queues a note for human approval.
app.post('/api/share', requireAuth, (req, res) => {
    // Every account's expired tokens: they are dead whoever they belonged to.
    db.prepare('DELETE FROM share_tokens WHERE expires_at <= ?').run(new Date().toISOString());
    const token = crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SHARE_TTL_MS);
    db.prepare('INSERT INTO share_tokens (token, created_at, expires_at, user_id) VALUES (?, ?, ?, ?)')
        .run(token, now.toISOString(), expiresAt.toISOString(), req.user.id);
    res.json({ ok: true, url: `${req.protocol}://${req.get('host')}/llm/${token}`, expiresAt: expiresAt.toISOString() });
});

app.get('/llm/:token', (req, res) => {
    const share = getValidShareToken(req, res);
    if (!share) return;
    // Straight out of the items table — notes used to be decoded out of a
    // pushed browser-tree blob here. Only the notes of the account that made
    // the link.
    const notes = items.forUser(share.user_id).listNotes();
    // Group notebooks together, loose notes first, keeping each group's order.
    // A nested notebook is headed by its path ('Work / Meetings'), so two
    // 'Meetings' under different parents no longer merge into one group; a
    // top-level one is headed exactly as before.
    const groupOrder = [];
    const groups = new Map();
    for (const n of notes) {
        const key = (n.notebookPath && n.notebookPath.length ? n.notebookPath.join(' / ') : n.notebook) || '';
        if (!groups.has(key)) { groups.set(key, []); groupOrder.push(key); }
        groups.get(key).push(n);
    }
    groupOrder.sort((a, b) => (a === '') === (b === '') ? 0 : (a === '' ? -1 : 1));

    const origin = `${req.protocol}://${req.get('host')}`;
    const proposeUrl = `${origin}/llm/${req.params.token}/propose`;

    // Plain text, not text/markdown: some LLM fetch tools refuse text/markdown responses.
    let md = `# TabPaladin Notes — shared context for an LLM assistant\n\n`;
    md += `!!! TO CREATE OR EDIT A NOTE, SEND THIS REQUEST (the only way to write automatically) !!!\n\n`;
    md += `POST ${proposeUrl}\n`;
    md += `Content-Type: application/json\n\n`;
    md += `{"title": "Note Title", "content": "# Note Title\\n\\n...full note body...", "notebook": "optional notebook name"}\n\n`;
    md += `(A POST to this page's own URL with the same JSON body also works.)\n\n`;
    md += `---\n\n## Instructions (READ CAREFULLY BEFORE DOING ANYTHING)\n\n`;
    md += `- You are viewing the user's personal note collection via a temporary link.\n`;
    md += `- Notes are plain markdown-ish text. A line starting with \`# \` is the note's title; notes reference each other with wikilinks like [[Note Title]]. Keep this styling when writing notes.\n`;
    md += `- Notes are organized into notebooks (named groups). When the user asks for a note about a topic, file it in the matching notebook via the optional "notebook" field (max 100 chars; created if missing). Omit it if no notebook fits.\n`;
    md += `- A notebook inside another is listed as "Parent / Child"; pass that whole path as "notebook" to file into it.\n`;
    md += `- You CANNOT create or edit notes directly. ALWAYS ask the user for approval first:\n`;
    md += `  1. Tell the user what you want to write and get their confirmation.\n`;
    md += `  2. POST the proposal to ${proposeUrl} as shown at the top of this page.\n`;
    md += `     - "title": max 200 chars. "content": max 100 KB, start it with a \`# <title>\` heading line.\n`;
    md += `     - If a note with the same title already exists, the proposal REPLACES its content upon approval — include the full new content, not a diff.\n`;
    md += `  3. After posting, tell the user the note is waiting for their approval in the TabPaladin app. NEVER claim a note was saved or changed before the user approves it there.\n`;
    md += `- To REORDER existing notes, POST to the same URL: {"action": "reorder", "order": ["Title 1", "Title 2", "..."]} — every note title in the desired order (per notebook and for loose notes). Also requires user approval.\n`;
    md += `- If your tools cannot send POST requests, give the user a clickable review link instead. Formats:\n`;
    md += `  - One note: ${origin}/#note=<the full note markdown, percent-encoded>\n`;
    md += `  - Multiple notes at once: ${origin}/#notes=<percent-encoded JSON array like [{"content":"# Title\\n\\nbody","notebook":"optional"},...]>\n`;
    md += `  - Reorder notes: ${origin}/#reorder=<percent-encoded JSON array of note titles, e.g. ["Title 1","Title 2"]>\n`;
    md += `  - Start each note's markdown with a \`# <title>\` heading. Percent-encode AT MINIMUM: % as %25, newline as %0A, space as %20, & as %26, # as %23, ? as %3F.\n`;
    md += `  - Optionally append &notebook=<name> (also percent-encoded) to file the note in a notebook.\n`;
    md += `  - Example: ${origin}/#note=%23%20Shopping%0A%0A-%20milk&notebook=Recipes\n`;
    md += `  - The link opens a review screen in the user's app; nothing is saved until they press Save. Present it as a clickable markdown link like [Review and save this note](URL).\n\n`;
    md += `---\n\n## Existing notes (${notes.length})\n\n`;
    if (notes.length === 0) md += `(no notes yet)\n\n`;
    for (const key of groupOrder) {
        md += `### 📓 Notebook: ${key || '(none)'}\n\n`;
        for (const n of groups.get(key)) {
            md += `#### ${n.title || 'Untitled'}\n\n${n.content || '(empty)'}\n\n---\n\n`;
        }
    }
    res.type('text/plain; charset=utf-8').send(md);
});

function handleProposal(req, res) {
    const share = getValidShareToken(req, res);
    if (!share) return;
    const { title, content, notebook, action, order } = req.body || {};

    // Anyone holding the link can post here without signing in, so pending
    // proposals are capped per account. Refused, never pruned.
    const pending = db.prepare('SELECT COUNT(*) AS n FROM note_proposals WHERE user_id = ?').get(share.user_id).n;
    if (pending >= MAX_PROPOSALS_PER_USER) {
        return res.status(429).json({
            error: `There are already ${pending} proposals waiting for the user's approval. Ask them to review those first.`
        });
    }

    // Reorder proposal: {"action":"reorder","order":["Title 1","Title 2",...]}
    if (action === 'reorder') {
        if (!Array.isArray(order) || order.length === 0 || order.length > 500
            || !order.every(t => typeof t === 'string' && t.trim() && t.length <= 200)) {
            return res.status(400).json({ error: 'Invalid "order" (array of 1-500 note titles).' });
        }
        db.prepare('INSERT INTO note_proposals (title, content, notebook, kind, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?)')
            .run('Reorder notes', JSON.stringify(order.map(t => t.trim())), null, 'reorder', new Date().toISOString(), share.user_id);
        return res.json({
            ok: true,
            status: 'pending_approval',
            message: 'Reorder proposal stored. It only applies after the user approves it in the TabPaladin app — tell them it is waiting for approval.'
        });
    }

    if (typeof title !== 'string' || !title.trim() || title.length > 200) {
        return res.status(400).json({ error: 'Missing or invalid "title" (non-empty string, max 200 chars).' });
    }
    if (typeof content !== 'string' || content.length > 100 * 1024) {
        return res.status(400).json({ error: 'Missing or invalid "content" (string, max 100 KB).' });
    }
    if (notebook != null && (typeof notebook !== 'string' || !notebook.trim() || notebook.length > 100)) {
        return res.status(400).json({ error: 'Invalid "notebook" (string, max 100 chars).' });
    }
    db.prepare('INSERT INTO note_proposals (title, content, notebook, kind, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?)')
        .run(title.trim(), content, notebook ? notebook.trim() : null, 'note', new Date().toISOString(), share.user_id);
    res.json({
        ok: true,
        status: 'pending_approval',
        message: 'Proposal stored. It only becomes a note after the user approves it in the TabPaladin app — tell them it is waiting for approval.'
    });
}

app.post('/llm/:token/propose', express.json({ limit: '1mb' }), handleProposal);
// Some LLMs guess POST on the share URL itself — accept it as an alias.
app.post('/llm/:token', express.json({ limit: '1mb' }), handleProposal);

// --- Note proposals (auth, consumed by the PWA) ---
app.get('/api/proposals', requireAuth, (req, res) => {
    const rows = db.prepare('SELECT id, title, content, notebook, kind, created_at FROM note_proposals WHERE user_id = ? ORDER BY created_at DESC')
        .all(req.user.id);
    res.json({ ok: true, proposals: rows });
});

app.post('/api/proposals/:id/approve', requireAuth, (req, res) => {
    const prop = db.prepare('SELECT id, title, content, notebook, kind FROM note_proposals WHERE id = ? AND user_id = ?')
        .get(req.params.id, req.user.id);
    if (!prop) return res.status(404).json({ error: 'Proposal not found' });
    const store = items.forUser(req.user.id);
    const result = store.applyNoteProposal(prop);
    if (!result.ok) return res.status(400).json({ error: result.error });
    db.prepare('DELETE FROM note_proposals WHERE id = ? AND user_id = ?').run(prop.id, req.user.id);
    res.json({ ok: true, version: store.version() });
});

app.post('/api/proposals/:id/reject', requireAuth, (req, res) => {
    db.prepare('DELETE FROM note_proposals WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
    res.json({ ok: true });
});

// --- Share target fallback ---
//
// The manifest posts shares to /share so the service worker can answer them
// without launching the app. This route only runs when that worker is not
// there to intercept — during its first install, or if it failed to register —
// and hands the share to the app the long way instead of 404ing and losing the
// link. Unauthenticated because a share target navigation carries no token; it
// only bounces the parameters back to the client.
app.post('/share', express.urlencoded({ extended: false }), (req, res) => {
    const { url = '', title = '', text = '' } = req.body || {};
    const params = new URLSearchParams({ share: '1', url, title, text });
    res.redirect(303, '/?' + params);
});

// --- PWA static files ---
if (fs.existsSync(PWA_DIR)) {
    // no-cache: browsers/proxies may store but must revalidate (ETag → cheap
    // 304s). Prevents stale app shells; deploys must show up immediately.
    app.use('/', express.static(PWA_DIR, {
        setHeaders: (res) => {
            res.set('Cache-Control', 'no-cache');
        }
    }));
} else {
    app.get('/', (req, res) => {
        res.type('text/plain').send('TabPaladin Sync server. PWA directory not found at ' + PWA_DIR);
    });
}

app.listen(PORT, '0.0.0.0', () => {
    const modes = ['login'];
    const tokenUser = AUTH_TOKEN ? userById(db, legacyTokenUserId(db)) : null;
    if (AUTH_TOKEN) modes.push(`AUTH_TOKEN as ${tokenUser ? tokenUser.username : 'nobody'}`);
    console.log(`[TabPaladin] Server listening on :${PORT} (${userCount()} account(s); auth: ${modes.join(' + ')})`);
    if (AUTH_TOKEN) {
        console.log(`[TabPaladin] AUTH_TOKEN is on: anyone holding it acts as ${tokenUser ? tokenUser.username : 'nobody'}. Remove it once every client has signed in, unless scripts need it.`);
    }
    console.log(`[TabPaladin] PWA served from ${PWA_DIR}`);
    console.log(`[TabPaladin] Data dir ${DATA_DIR}`);
});
