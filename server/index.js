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

// Migrations for existing databases.
try { db.prepare('ALTER TABLE note_proposals ADD COLUMN notebook TEXT').run(); } catch (e) { /* column already exists */ }
try { db.prepare("ALTER TABLE note_proposals ADD COLUMN kind TEXT NOT NULL DEFAULT 'note'").run(); } catch (e) { /* column already exists */ }

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

// All notes under a folder, recursively, tagged with their notebook (subfolder title).
function collectNotes(folder, notebook, out = []) {
    for (const c of folder.children || []) {
        if (isNoteBookmark(c)) out.push({ notebook, bookmark: c });
        else if (c && (c.type === 'folder' || c.type === 'root')) collectNotes(c, c.title || notebook, out);
    }
    return out;
}

// Sort note children in every folder under (and including) the notes root to
// match the given list of titles; unlisted notes keep their relative order last.
function applyNoteOrder(notesRoot, order) {
    const idx = new Map(order.map((t, i) => [t, i]));
    const rank = (n) => (idx.has(n.title) ? idx.get(n.title) : Infinity);
    const sortFolder = (folder) => {
        const kids = folder.children || [];
        const sortedNotes = kids.filter(isNoteBookmark).sort((a, b) => rank(a) - rank(b));
        let ni = 0;
        folder.children = kids.map(c => isNoteBookmark(c) ? sortedNotes[ni++] : c);
        for (const c of folder.children) {
            if (c && (c.type === 'folder' || c.type === 'root')) sortFolder(c);
        }
    };
    sortFolder(notesRoot);
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
    const entries = folder ? collectNotes(folder, null) : [];
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
    md += `---\n\n## Existing notes (${entries.length})\n\n`;
    if (entries.length === 0) md += `(no notes yet)\n\n`;
    let lastNotebook;
    for (const e of entries) {
        if (e.notebook !== lastNotebook) {
            md += `### 📓 Notebook: ${e.notebook || '(none)'}\n\n`;
            lastNotebook = e.notebook;
        }
        const meta = decodeNote(e.bookmark);
        md += `#### ${e.bookmark.title || 'Untitled'}\n\n${meta.content || '(empty)'}\n\n---\n\n`;
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

    if (prop.kind === 'reorder') {
        let order = null;
        try { order = JSON.parse(prop.content); } catch (e) { /* corrupt */ }
        if (!Array.isArray(order)) return res.status(400).json({ error: 'Corrupt reorder proposal.' });
        applyNoteOrder(folder, order);
    } else {
        // File into the requested notebook (subfolder), creating it if missing.
        let target = folder;
        if (prop.notebook) {
            target = (folder.children || []).find(c => (c.type === 'folder' || c.type === 'root') && c.title === prop.notebook);
            if (!target) {
                target = { type: 'folder', title: prop.notebook, children: [] };
                folder.children = folder.children || [];
                folder.children.push(target);
            }
        }

        const existing = (target.children || []).find(c => isNoteBookmark(c) && c.title === prop.title)
            || collectNotes(folder, null).find(e => e.bookmark.title === prop.title)?.bookmark;
        if (existing) {
            const meta = decodeNote(existing);
            existing.url = encodeNoteUrl({ content: prop.content, createdAt: meta.createdAt || now, updatedAt: now });
        } else {
            target.children = target.children || [];
            target.children.push({ type: 'bookmark', title: prop.title, url: encodeNoteUrl({ content: prop.content, createdAt: now, updatedAt: now }) });
        }
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
