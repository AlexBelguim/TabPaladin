// Importer persistence — sources, their credentials, and the archive itself.
//
// The archive lives here rather than in the snapshot because /api/push replaces
// the snapshot wholesale with whatever tree a browser sends. A device that
// pushes before it pulls would drop the whole import folder from the newest
// snapshot, and for anything Reddit has already forgotten past its 1000-item
// listing cap that snapshot is the only copy. Keeping items in their own table
// makes the bookmark tree a projection that can always be rebuilt.

import crypto from 'node:crypto';

// --- Credential encryption ---
//
// Session tokens already sit in this database in plaintext, but a Reddit
// refresh token is a different thing: it is long-lived and it grants access to
// an account elsewhere. sync.db is exactly the kind of file that ends up in a
// backup or gets copied off a NAS, so the refresh token is sealed with a key
// that lives in the environment instead — .env is already gitignored and is not
// part of DATA_DIR.
const IMPORT_SECRET = process.env.IMPORT_SECRET || '';
const SEALED_PREFIX = 'gcm:';

function keyFromSecret() {
    // scrypt rather than a raw hash so a short hand-typed secret still costs
    // something to brute-force.
    return crypto.scryptSync(IMPORT_SECRET, 'tabpaladin-imports', 32);
}

export function credentialsAreEncrypted() {
    return Boolean(IMPORT_SECRET);
}

export function seal(obj) {
    const plain = JSON.stringify(obj || {});
    if (!IMPORT_SECRET) return plain;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', keyFromSecret(), iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return SEALED_PREFIX + [iv, tag, body].map(b => b.toString('base64')).join('.');
}

export function unseal(stored) {
    if (!stored) return {};
    const s = String(stored);
    if (!s.startsWith(SEALED_PREFIX)) {
        // Written while IMPORT_SECRET was unset, or the secret was added later.
        try { return JSON.parse(s); } catch (e) { return {}; }
    }
    if (!IMPORT_SECRET) {
        throw new Error('IMPORT_SECRET is not set but stored credentials are encrypted with it.');
    }
    try {
        const [iv, tag, body] = s.slice(SEALED_PREFIX.length).split('.').map(p => Buffer.from(p, 'base64'));
        const decipher = crypto.createDecipheriv('aes-256-gcm', keyFromSecret(), iv);
        decipher.setAuthTag(tag);
        const plain = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
        return JSON.parse(plain);
    } catch (e) {
        throw new Error('Could not decrypt stored credentials — has IMPORT_SECRET changed?');
    }
}

export function initSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS import_sources (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            provider TEXT NOT NULL,
            label TEXT,
            config TEXT NOT NULL DEFAULT '{}',
            credentials TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            interval_minutes INTEGER NOT NULL DEFAULT 60,
            last_run TEXT,
            last_status TEXT,
            last_error TEXT,
            created_at TEXT NOT NULL
        );

        -- The archive. Append-only: rows are never deleted by a sync, only by an
        -- explicit purge, because an item vanishing from a listing is
        -- indistinguishable from one that fell off the far end of it.
        CREATE TABLE IF NOT EXISTS import_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_id INTEGER NOT NULL,
            external_id TEXT NOT NULL,
            url TEXT NOT NULL,
            title TEXT,
            author TEXT,
            container TEXT,
            created_utc TEXT,
            imported_at TEXT NOT NULL,
            removed_at_source TEXT,
            extra TEXT,
            UNIQUE (source_id, external_id)
        );
        CREATE INDEX IF NOT EXISTS idx_import_items_source ON import_items(source_id, created_utc DESC);

        -- Correlates an OAuth redirect back to the source that started it. The
        -- callback is a browser navigation and cannot carry a bearer token, so
        -- this one-shot value is what authenticates it.
        CREATE TABLE IF NOT EXISTS import_oauth_state (
            state TEXT PRIMARY KEY,
            source_id INTEGER NOT NULL,
            created_at TEXT NOT NULL
        );
    `);
}

const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

export function makeStore(db) {
    const rowToSource = (row) => {
        if (!row) return null;
        let config = {};
        try { config = JSON.parse(row.config || '{}'); } catch (e) { /* corrupt config */ }
        return {
            id: row.id,
            provider: row.provider,
            label: row.label,
            config,
            enabled: Boolean(row.enabled),
            intervalMinutes: row.interval_minutes,
            lastRun: row.last_run,
            lastStatus: row.last_status,
            lastError: row.last_error,
            createdAt: row.created_at,
            // Raw, still sealed. Callers that need it use readCredentials.
            credentials: row.credentials
        };
    };

    return {
        listSources() {
            const rows = db.prepare('SELECT * FROM import_sources ORDER BY id').all();
            return rows.map(rowToSource);
        },

        getSource(id) {
            return rowToSource(db.prepare('SELECT * FROM import_sources WHERE id = ?').get(id));
        },

        createSource({ provider, label, config = {}, intervalMinutes = 60 }) {
            const info = db.prepare(`
                INSERT INTO import_sources (provider, label, config, interval_minutes, created_at)
                VALUES (?, ?, ?, ?, ?)
            `).run(provider, label || provider, JSON.stringify(config), intervalMinutes, new Date().toISOString());
            return this.getSource(info.lastInsertRowid);
        },

        updateSource(id, patch) {
            const current = this.getSource(id);
            if (!current) return null;
            const next = {
                label: patch.label !== undefined ? patch.label : current.label,
                config: patch.config !== undefined ? patch.config : current.config,
                enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : (current.enabled ? 1 : 0),
                intervalMinutes: patch.intervalMinutes !== undefined ? patch.intervalMinutes : current.intervalMinutes
            };
            db.prepare(`
                UPDATE import_sources SET label = ?, config = ?, enabled = ?, interval_minutes = ?
                WHERE id = ?
            `).run(next.label, JSON.stringify(next.config), next.enabled, next.intervalMinutes, id);
            return this.getSource(id);
        },

        deleteSource(id, { purge = false } = {}) {
            if (purge) db.prepare('DELETE FROM import_items WHERE source_id = ?').run(id);
            db.prepare('DELETE FROM import_oauth_state WHERE source_id = ?').run(id);
            db.prepare('DELETE FROM import_sources WHERE id = ?').run(id);
        },

        readCredentials(id) {
            const row = db.prepare('SELECT credentials FROM import_sources WHERE id = ?').get(id);
            return row ? unseal(row.credentials) : {};
        },

        writeCredentials(id, creds) {
            db.prepare('UPDATE import_sources SET credentials = ? WHERE id = ?').run(seal(creds), id);
        },

        hasCredentials(id) {
            const row = db.prepare('SELECT credentials FROM import_sources WHERE id = ?').get(id);
            return Boolean(row && row.credentials);
        },

        markRun(id, { status, error = null }) {
            db.prepare('UPDATE import_sources SET last_run = ?, last_status = ?, last_error = ? WHERE id = ?')
                .run(new Date().toISOString(), status, error, id);
        },

        // Insert-or-touch. An item already in the archive keeps its original
        // imported_at and gets its metadata refreshed; seeing it again also
        // clears any removed_at_source, since it is evidently back in the
        // listing. Returns true when the row is new.
        upsertItem(sourceId, item) {
            const now = new Date().toISOString();
            const existing = db.prepare('SELECT id FROM import_items WHERE source_id = ? AND external_id = ?')
                .get(sourceId, item.externalId);
            if (existing) {
                db.prepare(`
                    UPDATE import_items
                    SET url = ?, title = ?, author = ?, container = ?, created_utc = ?, extra = ?, removed_at_source = NULL
                    WHERE id = ?
                `).run(item.url, item.title || null, item.author || null, item.container || null,
                    item.createdUtc || null, item.extra ? JSON.stringify(item.extra) : null, existing.id);
                return false;
            }
            db.prepare(`
                INSERT INTO import_items
                    (source_id, external_id, url, title, author, container, created_utc, imported_at, extra)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(sourceId, item.externalId, item.url, item.title || null, item.author || null,
                item.container || null, item.createdUtc || null, now,
                item.extra ? JSON.stringify(item.extra) : null);
            return true;
        },

        // Stamp everything the latest sweep didn't see. Deliberately not a
        // delete: falling off the end of Reddit's 1000-item window looks exactly
        // like being un-saved, and guessing wrong loses the archive.
        markMissing(sourceId, seenExternalIds) {
            const now = new Date().toISOString();
            const rows = db.prepare('SELECT id, external_id FROM import_items WHERE source_id = ? AND removed_at_source IS NULL')
                .all(sourceId);
            const seen = new Set(seenExternalIds);
            const stmt = db.prepare('UPDATE import_items SET removed_at_source = ? WHERE id = ?');
            let n = 0;
            for (const row of rows) {
                if (!seen.has(row.external_id)) { stmt.run(now, row.id); n++; }
            }
            return n;
        },

        itemsFor(sourceId) {
            return db.prepare('SELECT * FROM import_items WHERE source_id = ? ORDER BY created_utc DESC, id DESC')
                .all(sourceId);
        },

        pageItems(sourceId, { limit = 100, offset = 0 } = {}) {
            return db.prepare(`
                SELECT * FROM import_items WHERE source_id = ?
                ORDER BY created_utc DESC, id DESC LIMIT ? OFFSET ?
            `).all(sourceId, limit, offset);
        },

        countItems(sourceId) {
            const row = db.prepare(`
                SELECT COUNT(*) AS total,
                       SUM(CASE WHEN removed_at_source IS NOT NULL THEN 1 ELSE 0 END) AS gone
                FROM import_items WHERE source_id = ?
            `).get(sourceId);
            return { total: row.total || 0, goneFromSource: row.gone || 0 };
        },

        // --- OAuth handshake state ---
        createOAuthState(sourceId) {
            const state = crypto.randomBytes(32).toString('hex');
            db.prepare('DELETE FROM import_oauth_state WHERE created_at < ?')
                .run(new Date(Date.now() - OAUTH_STATE_TTL_MS).toISOString());
            db.prepare('INSERT INTO import_oauth_state (state, source_id, created_at) VALUES (?, ?, ?)')
                .run(state, sourceId, new Date().toISOString());
            return state;
        },

        // One-shot: consuming the state also deletes it, so a replayed callback
        // cannot re-enter the token exchange.
        consumeOAuthState(state) {
            const row = db.prepare('SELECT source_id, created_at FROM import_oauth_state WHERE state = ?').get(state);
            if (!row) return null;
            db.prepare('DELETE FROM import_oauth_state WHERE state = ?').run(state);
            if (Date.now() - Date.parse(row.created_at) > OAUTH_STATE_TTL_MS) return null;
            return row.source_id;
        }
    };
}
