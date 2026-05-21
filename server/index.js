import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
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
`);

const app = express();
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

// --- Public share-target endpoint (NO auth so mobile browsers can POST without a token).
// The PWA receives this redirect on share, then POSTs to /api/shared with the auth header.
// For direct "share to URL" without the PWA running, we accept here too — but only with a
// public path token in the URL query for minimal protection. Optional.

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
