import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { attachImports } from './imports/index.js';
import { buildImportsTree } from './imports/project.js';
import { makeItemsStore } from './items.js';
import {
    authTokenProblem, hashPassword, verifyPassword, makeRateLimiter
} from './security.js';
import {
    backupDatabase, migrateUsers, setSchemaVersion, bootstrapAdmin, userCount as countUsers,
    userByName, publicUser, presentedToken, identify, MIN_PASSWORD_LENGTH
} from './users.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 18921);
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PWA_DIR = process.env.PWA_DIR || path.resolve(__dirname, '..', 'pwa');
const MAX_SNAPSHOTS = Number(process.env.MAX_SNAPSHOTS || 200);

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

// Before any migration below touches the data: a consistent copy next to it,
// sync.db.bak-<timestamp>. Taken whenever the schema is about to change and
// otherwise at most daily; the newest BACKUP_KEEP are kept.
const backup = backupDatabase(db, DB_PATH, { keep: Math.max(1, Number(process.env.BACKUP_KEEP || 7)) });
if (backup) console.log(`[TabPaladin] Backed up the database to ${backup}`);

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

// The canonical tree. On the first boot after the upgrade this converts the
// newest browser-tree snapshot into rows, so nothing is lost switching over.
const items = makeItemsStore(db, { maxSnapshots: MAX_SNAPSHOTS });
const migration = items.migrateFromLatestSnapshotIfNeeded();
if (migration.migrated) {
    console.log(`[TabPaladin] Migrated latest snapshot into the items table (${migration.nodes} nodes).`);
}

const healed = items.healDuplicateRoles();
if (healed.healed) {
    console.log(`[TabPaladin] Merged duplicate role folders: ${healed.roles.join(', ')}.`);
}

// One bookmarks folder, called Bookmarks, holding everything else. Idempotent:
// a tree that already has one is left exactly as the user arranged it.
const bookmarksRoot = items.ensureBookmarksRoot();
if (bookmarksRoot.created) {
    console.log('[TabPaladin] Created the Bookmarks root.');
} else if (bookmarksRoot.renamedFrom) {
    console.log(`[TabPaladin] Designated "${bookmarksRoot.renamedFrom}" as the Bookmarks root`
        + (bookmarksRoot.moved ? ` and moved ${bookmarksRoot.moved} top-level folder(s) into it.` : '.'));
}

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
setSchemaVersion(db);

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

// Failed sign-in attempts per client IP.
const authLimiter = makeRateLimiter({
    max: Number(process.env.AUTH_MAX_FAILURES || 10),
    windowMs: Number(process.env.AUTH_WINDOW_MINUTES || 15) * 60 * 1000
});

function rateLimited(req, res) {
    const wait = authLimiter.retryAfter(req.ip);
    if (!wait) return false;
    res.set('Retry-After', String(wait));
    res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} minute(s).` });
    return true;
}

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
// as the first admin — for scripts, and so an extension that hasn't signed in
// yet keeps syncing while you migrate. Sets req.user = { id, username, role }.
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

app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ ok: true, user: publicUser(req.user) });
});

// A real hash to check against when the username is unknown, so a missing
// account and a wrong password cost the same and can't be told apart.
const DUMMY_HASH = await hashPassword(crypto.randomBytes(16).toString('hex'));

app.post('/api/login', async (req, res) => {
    try {
        if (rateLimited(req, res)) return;
        const { username, password } = req.body || {};
        if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });

        const row = userByName(db, String(username).trim());
        const ok = await verifyPassword(password, row ? row.password_hash : DUMMY_HASH);
        if (!row || !ok) {
            authLimiter.fail(req.ip);
            return res.status(401).json({ error: 'Wrong username or password.' });
        }
        authLimiter.reset(req.ip);

        const session = issueSession(row.username);
        res.json({ ok: true, username: row.username, user: publicUser(row), ...session });
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
        if (rateLimited(req, res)) return;
        const { currentPassword, newPassword } = req.body || {};
        if (!newPassword || String(newPassword).length < MIN_PASSWORD_LENGTH) {
            return res.status(400).json({ error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
        }
        const row = userByName(db, req.user.username);
        if (!row) return res.status(400).json({ error: 'No account to change.' });
        if (!(await verifyPassword(currentPassword, row.password_hash))) {
            authLimiter.fail(req.ip);
            return res.status(401).json({ error: 'Current password is wrong.' });
        }
        const hash = await hashPassword(newPassword);
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, row.id);
        db.prepare('DELETE FROM sessions WHERE username = ?').run(row.username);
        const session = issueSession(row.username);
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

// --- Importers ---
// Attached before the tree routes so /api/tree can append the virtual imports
// subtree, and before the static handler so /api/imports/* wins over the PWA
// catch-all.
const { store: importsStore } = attachImports(app, { db, requireAuth });

// --- The tree ---
//
// GET returns the user's tree plus a virtual, read-only imports subtree that is
// composed from the archive at read time and never stored. PUT replaces the
// user's tree wholesale — git-style: the client edits a local working copy and
// pushes it, and a push whose baseVersion is stale is refused so it cannot
// silently overwrite what another device pushed in between.
app.get('/api/tree', requireAuth, (req, res) => {
    const { version, roots } = items.readTree();
    const importsTree = buildImportsTree(importsStore);
    if (importsTree) {
        // The archive belongs inside Bookmarks, not beside it — it is a
        // collection of bookmarks like any other, and a top-level sibling made
        // it look like a separate account. Falls back to the top level only if
        // there is somehow no bookmarks root to hold it.
        const rootId = items.bookmarksRootId();
        const host = rootId ? findNode(roots, rootId) : null;
        if (host) {
            host.children = [...(host.children || []), importsTree];
        } else {
            roots.push(importsTree);
        }
    }
    res.json({ ok: true, version, roots });
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
    res.json({ ok: true, version: items.version() });
});

app.put('/api/tree', requireAuth, jsonTree, (req, res) => {
    const { roots, baseVersion, deviceId, force } = req.body || {};
    if (!Array.isArray(roots)) {
        return res.status(400).json({ error: 'Missing roots (array of top-level nodes).' });
    }
    const current = items.version();
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
    const version = items.writeTree(roots, { deviceId: deviceId || null });
    res.json({ ok: true, version });
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
    const rows = db.prepare('SELECT id, timestamp, device_id FROM snapshots ORDER BY timestamp DESC LIMIT 100').all();
    res.json({ ok: true, snapshots: rows });
});

app.get('/api/history/:id', requireAuth, (req, res) => {
    const row = db.prepare('SELECT timestamp, device_id, json FROM snapshots WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, timestamp: row.timestamp, deviceId: row.device_id, snapshot: JSON.parse(row.json) });
});

// --- Shared links inbox (for PWA "Share to TabPaladin" + manual paste) ---
app.get('/api/shared', requireAuth, (req, res) => {
    const rows = db.prepare('SELECT id, url, title, created_at FROM shared_links ORDER BY created_at DESC').all();
    res.json({ ok: true, links: rows });
});

app.post('/api/shared', requireAuth, (req, res) => {
    const { url, title } = req.body || {};
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'Missing url' });
    const ts = new Date().toISOString();
    const info = db.prepare('INSERT INTO shared_links (url, title, created_at) VALUES (?, ?, ?)').run(url, title || null, ts);
    res.json({ ok: true, id: info.lastInsertRowid, createdAt: ts });
});

app.delete('/api/shared/:id', requireAuth, (req, res) => {
    db.prepare('DELETE FROM shared_links WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
});

app.delete('/api/shared', requireAuth, (req, res) => {
    db.prepare('DELETE FROM shared_links').run();
    res.json({ ok: true });
});

const SHARE_TTL_MS = Math.max(1, Number(process.env.SHARE_TTL_MINUTES || 60)) * 60 * 1000;

function getValidShareToken(req, res) {
    const row = db.prepare('SELECT token, expires_at FROM share_tokens WHERE token = ?').get(req.params.token);
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
    db.prepare('DELETE FROM share_tokens WHERE expires_at <= ?').run(new Date().toISOString());
    const token = crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SHARE_TTL_MS);
    db.prepare('INSERT INTO share_tokens (token, created_at, expires_at) VALUES (?, ?, ?)')
        .run(token, now.toISOString(), expiresAt.toISOString());
    res.json({ ok: true, url: `${req.protocol}://${req.get('host')}/llm/${token}`, expiresAt: expiresAt.toISOString() });
});

app.get('/llm/:token', (req, res) => {
    if (!getValidShareToken(req, res)) return;
    // Straight out of the items table — notes used to be decoded out of a
    // pushed browser-tree blob here.
    const notes = items.listNotes();
    // Group notebooks together, loose notes first, keeping each group's order.
    const groupOrder = [];
    const groups = new Map();
    for (const n of notes) {
        const key = n.notebook || '';
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
    if (!getValidShareToken(req, res)) return;
    const { title, content, notebook, action, order } = req.body || {};

    // Reorder proposal: {"action":"reorder","order":["Title 1","Title 2",...]}
    if (action === 'reorder') {
        if (!Array.isArray(order) || order.length === 0 || order.length > 500
            || !order.every(t => typeof t === 'string' && t.trim() && t.length <= 200)) {
            return res.status(400).json({ error: 'Invalid "order" (array of 1-500 note titles).' });
        }
        db.prepare('INSERT INTO note_proposals (title, content, notebook, kind, created_at) VALUES (?, ?, ?, ?, ?)')
            .run('Reorder notes', JSON.stringify(order.map(t => t.trim())), null, 'reorder', new Date().toISOString());
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
    db.prepare('INSERT INTO note_proposals (title, content, notebook, kind, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(title.trim(), content, notebook ? notebook.trim() : null, 'note', new Date().toISOString());
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
    const rows = db.prepare('SELECT id, title, content, notebook, kind, created_at FROM note_proposals ORDER BY created_at DESC').all();
    res.json({ ok: true, proposals: rows });
});

app.post('/api/proposals/:id/approve', requireAuth, (req, res) => {
    const prop = db.prepare('SELECT id, title, content, notebook, kind FROM note_proposals WHERE id = ?').get(req.params.id);
    if (!prop) return res.status(404).json({ error: 'Proposal not found' });
    const result = items.applyNoteProposal(prop);
    if (!result.ok) return res.status(400).json({ error: result.error });
    db.prepare('DELETE FROM note_proposals WHERE id = ?').run(prop.id);
    res.json({ ok: true, version: items.version() });
});

app.post('/api/proposals/:id/reject', requireAuth, (req, res) => {
    db.prepare('DELETE FROM note_proposals WHERE id = ?').run(req.params.id);
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
    if (AUTH_TOKEN) modes.push('AUTH_TOKEN as first admin');
    console.log(`[TabPaladin] Server listening on :${PORT} (${userCount()} account(s); auth: ${modes.join(' + ')})`);
    if (AUTH_TOKEN) {
        console.log('[TabPaladin] AUTH_TOKEN is on: anyone holding it acts as the first admin. Remove it once every client has signed in, unless scripts need it.');
    }
    console.log(`[TabPaladin] PWA served from ${PWA_DIR}`);
    console.log(`[TabPaladin] Data dir ${DATA_DIR}`);
});
