import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 18921);
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PWA_DIR = process.env.PWA_DIR || path.resolve(__dirname, '..', 'pwa');
const MAX_SNAPSHOTS = Number(process.env.MAX_SNAPSHOTS || 200);

if (!AUTH_TOKEN) {
    console.warn('[TabPaladin] WARNING: AUTH_TOKEN env var is empty — every request will be rejected.');
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'sync.db'));
db.pragma('journal_mode = WAL');

db.exec(`
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
`);

const app = express();
app.set('trust proxy', true); // so req.protocol reflects X-Forwarded-Proto behind a reverse proxy
app.use(cors({ origin: true, credentials: false }));
app.use(express.json({ limit: '50mb' }));

// Defensive: ensure intermediaries (Cloudflare, etc.) don't cache sync responses.
app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
});

// --- Auth middleware (bearer token) ---
function requireAuth(req, res, next) {
    if (!AUTH_TOKEN) return res.status(503).json({ error: 'Server not configured (AUTH_TOKEN missing).' });
    const hdr = req.headers.authorization || '';
    const m = hdr.match(/^Bearer\s+(.+)$/);
    if (!m || m[1] !== AUTH_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// --- Health (no auth) ---
app.get('/api/health', (req, res) => {
    res.json({ ok: true, version: 1, configured: Boolean(AUTH_TOKEN) });
});

// --- Snapshots: push & pull ---
app.post('/api/push', requireAuth, (req, res) => {
    const snapshot = req.body && req.body.snapshot;
    const deviceId = (req.body && req.body.deviceId) || null;
    if (!snapshot || typeof snapshot !== 'object') {
        return res.status(400).json({ error: 'Missing snapshot' });
    }
    const ts = new Date().toISOString();
    const json = JSON.stringify(snapshot);
    db.prepare('INSERT INTO snapshots (timestamp, device_id, json) VALUES (?, ?, ?)').run(ts, deviceId, json);

    // Trim history beyond MAX_SNAPSHOTS.
    db.prepare(`
        DELETE FROM snapshots WHERE id NOT IN (
            SELECT id FROM snapshots ORDER BY timestamp DESC LIMIT ?
        )
    `).run(MAX_SNAPSHOTS);

    res.json({ ok: true, timestamp: ts });
});

app.get('/api/pull', requireAuth, (req, res) => {
    const row = db.prepare('SELECT timestamp, device_id, json FROM snapshots ORDER BY timestamp DESC LIMIT 1').get();
    if (!row) return res.json({ ok: true, snapshot: null, timestamp: null });
    res.json({
        ok: true,
        timestamp: row.timestamp,
        deviceId: row.device_id,
        snapshot: JSON.parse(row.json)
    });
});

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

// --- Notes helpers (same data model as pwa/app.js and the extension) ---
// Notes are bookmarks in the "TabPaladin Notes" folder whose url is a
// data:application/json payload: {v:1, content, createdAt, updatedAt}.
const NOTES_ROOT_TITLE = 'TabPaladin Notes';
const NOTE_DATA_PREFIX = 'data:application/json,';
const SHARE_TTL_MS = Math.max(1, Number(process.env.SHARE_TTL_MINUTES || 60)) * 60 * 1000;

function findNotesFolder(snapshot) {
    if (!snapshot) return null;
    for (const rootChild of snapshot.children || []) {
        if (isNotesFolderNode(rootChild)) return rootChild;
        for (const c of rootChild.children || []) {
            if (isNotesFolderNode(c)) return c;
        }
    }
    return null;
}

function isNotesFolderNode(node) {
    return node && (node.type === 'folder' || node.type === 'root') && node.title === NOTES_ROOT_TITLE;
}

function isNoteBookmark(b) {
    return b && b.type === 'bookmark' && typeof b.url === 'string'
        && b.url.startsWith(NOTE_DATA_PREFIX) && b.title !== '__tabpaladin_meta__';
}

function decodeNote(b) {
    try {
        const p = JSON.parse(decodeURIComponent(b.url.slice(NOTE_DATA_PREFIX.length)));
        return { content: p.content || '', createdAt: p.createdAt || null, updatedAt: p.updatedAt || null };
    } catch (e) {
        return { content: '', createdAt: null, updatedAt: null };
    }
}

function encodeNoteUrl({ content, createdAt, updatedAt }) {
    return NOTE_DATA_PREFIX + encodeURIComponent(JSON.stringify({ v: 1, content, createdAt, updatedAt }));
}

function latestSnapshot() {
    const row = db.prepare('SELECT json FROM snapshots ORDER BY timestamp DESC LIMIT 1').get();
    return row ? JSON.parse(row.json) : null;
}

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
    const snapshot = latestSnapshot();
    const folder = findNotesFolder(snapshot);
    const notes = folder ? (folder.children || []).filter(isNoteBookmark) : [];
    const proposeUrl = `${req.protocol}://${req.get('host')}/llm/${req.params.token}/propose`;

    // Plain text, not text/markdown: some LLM fetch tools refuse text/markdown responses.
    let md = `# TabPaladin Notes — shared context for an LLM assistant\n\n`;
    md += `!!! TO CREATE OR EDIT A NOTE, SEND THIS REQUEST (this is the ONLY way to write) !!!\n\n`;
    md += `POST ${proposeUrl}\n`;
    md += `Content-Type: application/json\n\n`;
    md += `{"title": "Note Title", "content": "# Note Title\\n\\n...full note body..."}\n\n`;
    md += `(A POST to this page's own URL with the same JSON body also works.)\n\n`;
    md += `---\n\n## Instructions (READ CAREFULLY BEFORE DOING ANYTHING)\n\n`;
    md += `- You are viewing the user's personal note collection via a temporary link.\n`;
    md += `- Notes are plain markdown-ish text. A line starting with \`# \` is the note's title; notes reference each other with wikilinks like [[Note Title]]. Keep this styling when writing notes.\n`;
    md += `- You CANNOT create or edit notes directly. ALWAYS ask the user for approval first:\n`;
    md += `  1. Tell the user what you want to write and get their confirmation.\n`;
    md += `  2. POST the proposal to ${proposeUrl} as shown at the top of this page.\n`;
    md += `     - "title": max 200 chars. "content": max 100 KB, start it with a \`# <title>\` heading line.\n`;
    md += `     - If a note with the same title already exists, the proposal REPLACES its content upon approval — include the full new content, not a diff.\n`;
    md += `  3. After posting, tell the user the note is waiting for their approval in the TabPaladin app. NEVER claim a note was saved or changed before the user approves it there.\n`;
    md += `- If your tools cannot send POST requests, output the full note (title + content) as a markdown code block so the user can paste it into the app themselves.\n\n`;
    md += `---\n\n## Existing notes (${notes.length})\n\n`;
    if (notes.length === 0) md += `(no notes yet)\n\n`;
    for (const n of notes) {
        const meta = decodeNote(n);
        md += `### ${n.title || 'Untitled'}\n\n${meta.content || '(empty)'}\n\n---\n\n`;
    }
    res.type('text/plain; charset=utf-8').send(md);
});

function handleProposal(req, res) {
    if (!getValidShareToken(req, res)) return;
    const { title, content } = req.body || {};
    if (typeof title !== 'string' || !title.trim() || title.length > 200) {
        return res.status(400).json({ error: 'Missing or invalid "title" (non-empty string, max 200 chars).' });
    }
    if (typeof content !== 'string' || content.length > 100 * 1024) {
        return res.status(400).json({ error: 'Missing or invalid "content" (string, max 100 KB).' });
    }
    db.prepare('INSERT INTO note_proposals (title, content, created_at) VALUES (?, ?, ?)')
        .run(title.trim(), content, new Date().toISOString());
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
    const rows = db.prepare('SELECT id, title, content, created_at FROM note_proposals ORDER BY created_at DESC').all();
    res.json({ ok: true, proposals: rows });
});

app.post('/api/proposals/:id/approve', requireAuth, (req, res) => {
    const prop = db.prepare('SELECT id, title, content FROM note_proposals WHERE id = ?').get(req.params.id);
    if (!prop) return res.status(404).json({ error: 'Proposal not found' });
    const snapshot = latestSnapshot();
    if (!snapshot) return res.status(409).json({ error: 'No snapshot on server yet.' });

    let folder = findNotesFolder(snapshot);
    if (!folder) {
        // Put it under the "Other Bookmarks" equivalent, falling back to the last root.
        const roots = snapshot.children || [];
        const parent = roots.find(r => /other|unfiled/i.test(r.title || '')) || roots[roots.length - 1];
        if (!parent) return res.status(409).json({ error: 'Snapshot has no root folder.' });
        folder = { type: 'folder', title: NOTES_ROOT_TITLE, children: [] };
        parent.children = parent.children || [];
        parent.children.push(folder);
    }

    const now = new Date().toISOString();
    const existing = (folder.children || []).find(c => isNoteBookmark(c) && c.title === prop.title);
    if (existing) {
        const meta = decodeNote(existing);
        existing.url = encodeNoteUrl({ content: prop.content, createdAt: meta.createdAt || now, updatedAt: now });
    } else {
        folder.children = folder.children || [];
        folder.children.push({ type: 'bookmark', title: prop.title, url: encodeNoteUrl({ content: prop.content, createdAt: now, updatedAt: now }) });
    }

    // Store as a new snapshot so history keeps the pre-approval state.
    db.prepare('INSERT INTO snapshots (timestamp, device_id, json) VALUES (?, ?, ?)')
        .run(now, 'llm-proposal', JSON.stringify(snapshot));
    db.prepare(`
        DELETE FROM snapshots WHERE id NOT IN (
            SELECT id FROM snapshots ORDER BY timestamp DESC LIMIT ?
        )
    `).run(MAX_SNAPSHOTS);
    db.prepare('DELETE FROM note_proposals WHERE id = ?').run(prop.id);
    res.json({ ok: true });
});

app.post('/api/proposals/:id/reject', requireAuth, (req, res) => {
    db.prepare('DELETE FROM note_proposals WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
});

// --- PWA static files ---
if (fs.existsSync(PWA_DIR)) {
    app.use('/', express.static(PWA_DIR));
} else {
    app.get('/', (req, res) => {
        res.type('text/plain').send('TabPaladin Sync server. PWA directory not found at ' + PWA_DIR);
    });
}

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[TabPaladin] Server listening on :${PORT} (auth ${AUTH_TOKEN ? 'configured' : 'MISSING'})`);
    console.log(`[TabPaladin] PWA served from ${PWA_DIR}`);
    console.log(`[TabPaladin] Data dir ${DATA_DIR}`);
});
