// Importer persistence — sources, their credentials, and the archive itself.
//
// The archive is append-only and lives only here. For anything Reddit has
// already forgotten past its 1000-item listing cap, this table is the only
// copy. Clients see it as a virtual subtree composed at read time and can only
// change it through explicit verbs, never by pushing a tree.
//
// Sources belong to an account (import_sources.user_id); the archive rows,
// tombstones and OAuth state belong to a source. That is only sound because a
// source row is never hard-deleted except by an explicit purge that takes all
// of those with it — removing a source is a soft delete that keeps its
// archive, still owned, behind "Show removed sources".
//
// Lookups that take a user id return only that account's sources. The ones
// that take a bare source id (credentials, markRun, the archive itself) are
// for callers that already resolved the id through getSource(id, userId) or
// listAllSources(); getSourceUnscoped is for the OAuth callback and confirm
// pages only, which carry no bearer token and are authenticated by a one-time
// value instead.

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

        -- Items the user deleted out of the import folder. The archive row and
        -- everything in it is gone; only the source's own id for it is kept.
        --
        -- Without this, deleting achieves nothing: the post is still saved on
        -- Reddit, so the next sweep re-imports it and it reappears within the
        -- hour. A tombstone is what makes a delete stick, and it holds no
        -- content — no title, no url, nothing to leak in a backup.
        CREATE TABLE IF NOT EXISTS import_dismissed (
            source_id INTEGER NOT NULL,
            external_id TEXT NOT NULL,
            dismissed_at TEXT NOT NULL,
            PRIMARY KEY (source_id, external_id)
        );
    `);

    // filed_at marks an item the user copied into their own tree: still
    // archived and still counted, but no longer drawn into the virtual imports
    // subtree, because showing it there too would duplicate it.
    try { db.prepare('ALTER TABLE import_items ADD COLUMN filed_at TEXT').run(); } catch (e) { /* column already exists */ }
}

const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;
const PENDING_TTL_MS = 15 * 60 * 1000;

const hashNonce = (nonce) => crypto.createHash('sha256').update(String(nonce)).digest('hex');

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
            userId: row.user_id,
            deletedAt: row.deleted_at || null,
            // Raw, still sealed. Callers that need it use readCredentials.
            credentials: row.credentials
        };
    };

    return {
        // One account's sources. Removed ones only when asked for, flagged by
        // deletedAt.
        listSources(userId, { includeRemoved = false } = {}) {
            const rows = includeRemoved
                ? db.prepare('SELECT * FROM import_sources WHERE user_id = ? ORDER BY id').all(userId)
                : db.prepare('SELECT * FROM import_sources WHERE user_id = ? AND deleted_at IS NULL ORDER BY id').all(userId);
            return rows.map(rowToSource);
        },

        // Every account's active sources: the scheduler and the boot warning.
        listAllSources() {
            return db.prepare('SELECT * FROM import_sources WHERE deleted_at IS NULL ORDER BY id').all().map(rowToSource);
        },

        // null for another account's source, and for a removed one unless
        // includeRemoved — both look like "not found" to the routes.
        getSource(id, userId, { includeRemoved = false } = {}) {
            const row = includeRemoved
                ? db.prepare('SELECT * FROM import_sources WHERE id = ? AND user_id = ?').get(id, userId)
                : db.prepare('SELECT * FROM import_sources WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(id, userId);
            return rowToSource(row);
        },

        getSourceUnscoped(id) {
            return rowToSource(db.prepare('SELECT * FROM import_sources WHERE id = ?').get(id));
        },

        createSource({ provider, label, config = {}, intervalMinutes = 60, userId }) {
            if (!Number.isInteger(Number(userId)) || Number(userId) <= 0) throw new Error('createSource needs the owning userId');
            const info = db.prepare(`
                INSERT INTO import_sources (provider, label, config, interval_minutes, created_at, user_id)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(provider, label || provider, JSON.stringify(config), intervalMinutes, new Date().toISOString(), Number(userId));
            return this.getSource(info.lastInsertRowid, Number(userId));
        },

        updateSource(id, userId, patch) {
            const current = this.getSource(id, userId);
            if (!current) return null;
            const next = {
                label: patch.label !== undefined ? patch.label : current.label,
                config: patch.config !== undefined ? patch.config : current.config,
                enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : (current.enabled ? 1 : 0),
                intervalMinutes: patch.intervalMinutes !== undefined ? patch.intervalMinutes : current.intervalMinutes
            };
            db.prepare(`
                UPDATE import_sources SET label = ?, config = ?, enabled = ?, interval_minutes = ?
                WHERE id = ? AND user_id = ?
            `).run(next.label, JSON.stringify(next.config), next.enabled, next.intervalMinutes, id, userId);
            return this.getSource(id, userId);
        },

        // Without purge this only removes the connection: the source is marked
        // removed and disabled, its credentials, any pending connection and
        // client secret are dropped, and the archive stays, still this
        // account's. Removing a source used to delete its row and leave the
        // archive pointing at nothing. With purge, the archive, its
        // tombstones, OAuth state and the source row all go. Returns whether
        // anything of this account's was there to remove.
        deleteSource(id, userId, { purge = false } = {}) {
            return db.transaction(() => {
                const row = db.prepare('SELECT id, config FROM import_sources WHERE id = ? AND user_id = ?').get(id, userId);
                if (!row) return false;
                if (purge) {
                    db.prepare('DELETE FROM import_items WHERE source_id = ? AND source_id IN (SELECT id FROM import_sources WHERE user_id = ?)').run(id, userId);
                    db.prepare('DELETE FROM import_dismissed WHERE source_id = ? AND source_id IN (SELECT id FROM import_sources WHERE user_id = ?)').run(id, userId);
                    db.prepare('DELETE FROM import_oauth_state WHERE source_id = ? AND source_id IN (SELECT id FROM import_sources WHERE user_id = ?)').run(id, userId);
                    db.prepare('DELETE FROM import_sources WHERE id = ? AND user_id = ?').run(id, userId);
                    return true;
                }
                let config = {};
                try { config = JSON.parse(row.config || '{}'); } catch (e) { /* corrupt config */ }
                delete config.clientSecret;
                db.prepare('DELETE FROM import_oauth_state WHERE source_id = ?').run(id);
                db.prepare(`
                    UPDATE import_sources
                    SET deleted_at = COALESCE(deleted_at, ?), enabled = 0, credentials = NULL, config = ?,
                        pending_credentials = NULL, pending_username = NULL, pending_nonce_hash = NULL
                    WHERE id = ? AND user_id = ?
                `).run(new Date().toISOString(), JSON.stringify(config), id, userId);
                return true;
            })();
        },

        // Back from "removed". It comes back disabled and disconnected — a
        // Reddit source needs authorising again — but with its archive intact.
        restoreSource(id, userId) {
            const changed = db.prepare('UPDATE import_sources SET deleted_at = NULL WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL')
                .run(id, userId).changes;
            return changed > 0 ? this.getSource(id, userId) : null;
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

        // --- A Reddit connection waiting for its owner's confirm click ---
        //
        // The OAuth callback cannot tell who completed Reddit's consent: anyone
        // can be sent a consent link for someone else's source. So the tokens
        // it obtains wait here, sealed, until the browser that completed the
        // flow confirms which TabPaladin account should receive them — with a
        // one-time nonce only that page holds. Nothing reaches `credentials`,
        // and so nothing is swept, before that.
        setPendingCredentials(id, { creds, username, nonce }) {
            const expiresAt = new Date(Date.now() + PENDING_TTL_MS).toISOString();
            db.prepare(`
                UPDATE import_sources SET pending_credentials = ?, pending_username = ?, pending_nonce_hash = ?
                WHERE id = ? AND deleted_at IS NULL
            `).run(seal({ creds, expiresAt }), username || null, hashNonce(nonce), id);
        },

        // The source a confirm nonce belongs to, with its unsealed pending
        // connection, or null when unknown or expired (an expired one is
        // cleared on the way).
        pendingFor(nonce) {
            if (!nonce) return null;
            const row = db.prepare('SELECT * FROM import_sources WHERE pending_nonce_hash = ? AND deleted_at IS NULL').get(hashNonce(nonce));
            if (!row) return null;
            let pending = {};
            try { pending = unseal(row.pending_credentials); } catch (e) { pending = {}; }
            if (!pending.creds || !(Date.parse(pending.expiresAt) > Date.now())) {
                this.clearPending(row.id);
                return null;
            }
            return { source: rowToSource(row), creds: pending.creds, username: row.pending_username };
        },

        confirmPending(nonce) {
            const hit = this.pendingFor(nonce);
            if (!hit) return null;
            this.writeCredentials(hit.source.id, hit.creds);
            this.clearPending(hit.source.id);
            return hit;
        },

        clearPending(id) {
            db.prepare('UPDATE import_sources SET pending_credentials = NULL, pending_username = NULL, pending_nonce_hash = NULL WHERE id = ?')
                .run(id);
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

            // Only into a source that still exists and has not been removed —
            // a sweep or capture racing a removal must not write into an
            // archive nobody can see.
            const live = db.prepare('SELECT 1 FROM import_sources WHERE id = ? AND deleted_at IS NULL').get(sourceId);
            if (!live) return false;

            // Deleted by the user. It is very likely still saved at the source,
            // so without this check every sweep would resurrect it.
            const dismissed = db.prepare('SELECT 1 FROM import_dismissed WHERE source_id = ? AND external_id = ?')
                .get(sourceId, item.externalId);
            if (dismissed) return false;

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

        // What the virtual subtree draws: everything except items the user has
        // already filed into their own tree.
        activeItemsFor(sourceId) {
            return db.prepare('SELECT * FROM import_items WHERE source_id = ? AND filed_at IS NULL ORDER BY created_utc DESC, id DESC')
                .all(sourceId);
        },

        // The user copied these into their own tree. Keep the archive row —
        // the item still counts and still came from Reddit — but stop drawing
        // it into the virtual subtree, or it would show up twice.
        markFiled(ids) {
            if (!ids.length) return 0;
            const now = new Date().toISOString();
            const stmt = db.prepare('UPDATE import_items SET filed_at = ? WHERE id = ?');
            const run = db.transaction((list) => { for (const id of list) stmt.run(now, id); });
            run(ids);
            return ids.length;
        },

        // The user deleted these. The row goes entirely — unrecoverable by
        // design, since anything past Reddit's 1000-item window cannot be
        // fetched again — and a contentless tombstone stays behind so a later
        // sweep does not simply import it all over again.
        purgeItems(rows) {
            if (!rows.length) return 0;
            const now = new Date().toISOString();
            const del = db.prepare('DELETE FROM import_items WHERE id = ?');
            const tomb = db.prepare('INSERT OR IGNORE INTO import_dismissed (source_id, external_id, dismissed_at) VALUES (?, ?, ?)');
            const run = db.transaction((list) => {
                for (const r of list) { tomb.run(r.source_id, r.external_id, now); del.run(r.id); }
            });
            run(rows);
            return rows.length;
        },

        // Undo a delete for items still present at the source: drops the
        // tombstone so the next sweep is free to bring them back.
        undismiss(sourceId, externalIds = null) {
            if (externalIds === null) {
                return db.prepare('DELETE FROM import_dismissed WHERE source_id = ?').run(sourceId).changes;
            }
            const stmt = db.prepare('DELETE FROM import_dismissed WHERE source_id = ? AND external_id = ?');
            const run = db.transaction((list) => { for (const e of list) stmt.run(sourceId, e); });
            run(externalIds);
            return externalIds.length;
        },

        countDismissed(sourceId) {
            return db.prepare('SELECT COUNT(*) AS n FROM import_dismissed WHERE source_id = ?').get(sourceId).n;
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
                       SUM(CASE WHEN removed_at_source IS NOT NULL THEN 1 ELSE 0 END) AS gone,
                       SUM(CASE WHEN filed_at IS NOT NULL THEN 1 ELSE 0 END) AS filed
                FROM import_items WHERE source_id = ?
            `).get(sourceId);
            return { total: row.total || 0, goneFromSource: row.gone || 0, filed: row.filed || 0 };
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
