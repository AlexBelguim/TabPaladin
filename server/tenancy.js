// Per-user data separation.
//
// Every row of user data names the account it belongs to (user_id). This file
// holds what has to see every table at once: the one-time ownership migration
// that assigns a single-user database to its owner, the triggers that keep any
// later row from being written without an existing owner, account ids and the
// global tree-version sequence, and deleting or summarising one account.
//
// Kept out of index.js so it can be driven against throwaway databases
// (tools/test_tenancy.mjs), and so verify_tenancy.js can share the digests.
// It deliberately imports nothing from users.js, which imports from here.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Tables whose rows carry user_id themselves.
export const OWNED_TABLES = ['items', 'snapshots', 'shared_links', 'share_tokens', 'note_proposals', 'import_sources'];

// Every table holding one account's data, including those born per-user:
// tree metadata, prefs, the tree's ops log, where shared links were filed and
// the AI chats' MCP tokens. import_items, import_dismissed and
// import_oauth_state are scoped through their source_id instead: a source row
// is never hard-deleted except by an explicit purge, which takes its archive
// with it.
export const PER_USER_TABLES = [...OWNED_TABLES, 'user_tree_meta', 'user_prefs', 'tree_ops', 'share_filings', 'mcp_tokens'];

// Everything that existed before accounts were separated. The migration may
// only add columns to these; their content must come out byte-identical.
export const DIGEST_TABLES = [
    'items', 'snapshots', 'shared_links', 'share_tokens', 'note_proposals',
    'import_sources', 'import_items', 'import_dismissed', 'import_oauth_state',
    'users', 'sessions', 'tree_meta'
];

// Columns the migration adds. Left out of every digest so before and after
// compare like for like.
export const TENANCY_COLUMNS = ['user_id', 'deleted_at', 'pending_credentials', 'pending_username', 'pending_nonce_hash'];

const SOURCE_SCOPED = ['import_items', 'import_dismissed', 'import_oauth_state'];

// Written when a migration is refused. Later boots stop before taking another
// backup, so a container stuck in a restart loop cannot rotate good copies away.
export const MARKER_FILE = 'MIGRATION_REFUSED';

const PROVIDER_NAMES = { reddit: 'Reddit', x: 'X', instagram: 'Instagram' };

// --- Small helpers ---------------------------------------------------------

const tableExists = (db, table) =>
    Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));

const columnNames = (db, table) => db.prepare(`PRAGMA table_info("${table}")`).all().map(c => c.name);

const hasColumn = (db, table, column) => tableExists(db, table) && columnNames(db, table).includes(column);

export function initTenancySchema(db) {
    db.exec(`
        -- Server-wide facts: who owned the data before accounts were separated,
        -- who the legacy AUTH_TOKEN acts as, the next account id, and the one
        -- sequence every tree version is drawn from.
        CREATE TABLE IF NOT EXISTS server_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        -- Per-account tree metadata (treeVersion, migratedFrom). tree_meta is
        -- kept as a frozen copy of the single-user values.
        CREATE TABLE IF NOT EXISTS user_tree_meta (
            user_id INTEGER NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            PRIMARY KEY (user_id, key)
        );

        -- Small per-account preferences the clients share (GET/PUT /api/prefs).
        CREATE TABLE IF NOT EXISTS user_prefs (
            user_id INTEGER NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (user_id, key)
        );

        -- Tombstones for deleted accounts: their ids are never handed out
        -- again and their names cannot be re-registered.
        CREATE TABLE IF NOT EXISTS deleted_users (
            id INTEGER PRIMARY KEY,
            username TEXT NOT NULL,
            deleted_at TEXT NOT NULL,
            deleted_by INTEGER,
            counts TEXT
        );
    `);
}

export function getServerMeta(db, key) {
    if (!tableExists(db, 'server_meta')) return null;
    const row = db.prepare('SELECT value FROM server_meta WHERE key = ?').get(key);
    return row ? row.value : null;
}

export function setServerMeta(db, key, value) {
    db.prepare('INSERT INTO server_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, String(value));
}

// --- Columns, triggers, indexes ---------------------------------------------

function ensureOwnershipColumns(db) {
    for (const table of OWNED_TABLES) {
        if (!tableExists(db, table)) continue;
        if (!hasColumn(db, table, 'user_id')) db.exec(`ALTER TABLE ${table} ADD COLUMN user_id INTEGER`);
    }
    if (tableExists(db, 'import_sources')) {
        for (const col of ['deleted_at', 'pending_credentials', 'pending_username', 'pending_nonce_hash']) {
            if (!hasColumn(db, 'import_sources', col)) db.exec(`ALTER TABLE import_sources ADD COLUMN ${col} TEXT`);
        }
    }
}

// A row whose owner does not exist is refused at the database, not just in
// the routes: a forgotten user_id becomes a 500 instead of a row nobody can
// see, and a write that raced an account deletion cannot land afterwards.
// The same guards for tables made after the ownership migration ran on this
// boot (share_filings, by migrateShares). Idempotent.
export function ensureOwnerGuards(db, tables) {
    for (const table of tables) {
        if (!PER_USER_TABLES.includes(table)) throw new Error(`${table} is not a per-account table`);
        if (!tableExists(db, table)) continue;
        const when = `WHEN NEW.user_id IS NULL OR NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id)`;
        const body = `BEGIN SELECT RAISE(ABORT, '${table}.user_id must name an existing user'); END`;
        db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_owner_insert BEFORE INSERT ON ${table} ${when} ${body};`);
        db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_owner_update BEFORE UPDATE OF user_id ON ${table} ${when} ${body};`);
    }
}

function ensureGuards(db) {
    ensureOwnerGuards(db, PER_USER_TABLES);
    const indexes = [
        ['items', 'CREATE INDEX IF NOT EXISTS idx_items_user_parent ON items(user_id, parent_id, position)'],
        ['snapshots', 'CREATE INDEX IF NOT EXISTS idx_snapshots_user_ts ON snapshots(user_id, timestamp DESC)'],
        ['shared_links', 'CREATE INDEX IF NOT EXISTS idx_shared_user ON shared_links(user_id, created_at DESC)'],
        ['note_proposals', 'CREATE INDEX IF NOT EXISTS idx_proposals_user ON note_proposals(user_id, created_at DESC)'],
        ['import_sources', 'CREATE INDEX IF NOT EXISTS idx_import_sources_user ON import_sources(user_id, deleted_at)']
    ];
    for (const [table, sql] of indexes) if (tableExists(db, table)) db.exec(sql);
}

// --- Digests -----------------------------------------------------------------
//
// COUNT plus sha256 over every row in primary-key order. Streamed, because the
// snapshots table holds hundreds of full-tree JSON rows and loading it whole
// could take more memory than the NAS has.

function primaryKey(db, table) {
    const pk = db.prepare(`PRAGMA table_info("${table}")`).all()
        .filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
    return pk.length ? pk : ['rowid'];
}

export function digestTable(db, table, { columns = null, excludeIds = null, idColumn = 'id' } = {}) {
    const cols = columns || columnNames(db, table).filter(c => !TENANCY_COLUMNS.includes(c));
    const order = primaryKey(db, table).map(c => `"${c}"`).join(', ');
    const select = [...cols, ...(excludeIds ? [idColumn] : [])].map(c => `"${c}"`).join(', ');
    const stmt = db.prepare(`SELECT ${select} FROM "${table}" ORDER BY ${order}`).raw();
    const hash = crypto.createHash('sha256');
    let n = 0;
    for (const row of stmt.iterate()) {
        if (excludeIds) {
            if (excludeIds.has(row[row.length - 1])) continue;
            row.length = cols.length;
        }
        hash.update(JSON.stringify(row));
        hash.update('\n');
        n++;
    }
    return { n, sha256: hash.digest('hex'), columns: cols };
}

// { table: {n, sha256, columns} } for the tables that exist. `like` reuses
// another digest's column lists, so a table that gained a column still
// compares on the columns it had; `exclude` drops rows by id per table.
export function digestTables(db, tables = DIGEST_TABLES, { like = null, exclude = {} } = {}) {
    const out = {};
    for (const table of tables) {
        if (!tableExists(db, table)) continue;
        const ids = exclude[table];
        out[table] = digestTable(db, table, {
            columns: like && like[table] ? like[table].columns : null,
            excludeIds: ids && ids.size ? ids : null
        });
    }
    return out;
}

// --- Ownership migration -------------------------------------------------------

function resolveUser(db, ref) {
    const want = String(ref).trim();
    return /^\d+$/.test(want)
        ? db.prepare('SELECT id, username FROM users WHERE id = ?').get(Number(want))
        : db.prepare('SELECT id, username FROM users WHERE username = ?').get(want);
}

// Whose data is this? Never a guess: exactly one account, or the one
// TENANCY_OWNER names. Two accounts and no answer refuses, because handing
// every bookmark to whichever has the lowest id would be silent and permanent.
function pickOwner(db, env) {
    const want = env.TENANCY_OWNER && String(env.TENANCY_OWNER).trim();
    if (want) {
        const user = resolveUser(db, want);
        if (!user) throw new Error(`TENANCY_OWNER=${want} names no existing account`);
        return user;
    }
    const users = db.prepare('SELECT id, username FROM users ORDER BY id').all();
    if (users.length === 1) return users[0];
    if (!users.length) throw new Error('No account exists yet to own the data; set ADMIN_PASSWORD and restart');
    throw new Error(`${users.length} accounts exist; set TENANCY_OWNER=<username> to say whose data this is`);
}

// Archive rows whose source row is gone. Removing a source used to delete only
// its import_sources row, leaving its archive behind with nothing pointing at
// it; those rows are adopted rather than stranded.
function findOrphanSourceIds(db) {
    if (!tableExists(db, 'import_sources')) return [];
    const parts = SOURCE_SCOPED.filter(t => tableExists(db, t))
        .map(t => `SELECT source_id FROM ${t} WHERE source_id NOT IN (SELECT id FROM import_sources)`);
    if (!parts.length) return [];
    return db.prepare(`${parts.join(' UNION ')} ORDER BY 1`).all().map(r => r.source_id);
}

function providerFromHost(url) {
    let host = '';
    try { host = new URL(String(url)).hostname.toLowerCase().replace(/^www\./, ''); } catch (e) { return null; }
    if (host === 'reddit.com' || host.endsWith('.reddit.com') || host === 'redd.it') return 'reddit';
    if (['x.com', 'twitter.com', 'mobile.twitter.com', 'mobile.x.com'].includes(host)) return 'x';
    if (host === 'instagram.com' || host.endsWith('.instagram.com')) return 'instagram';
    return null;
}

function providerFromExternalId(externalId) {
    const id = String(externalId || '');
    if (id.startsWith('x:')) return 'x';
    if (id.startsWith('ig:')) return 'instagram';
    if (/^t[13]_/.test(id)) return 'reddit';
    return null;
}

function inferProvider(db, sourceId) {
    if (tableExists(db, 'import_items')) {
        const row = db.prepare('SELECT url, external_id FROM import_items WHERE source_id = ? ORDER BY id LIMIT 1').get(sourceId);
        const hit = row && (providerFromExternalId(row.external_id) || providerFromHost(row.url));
        if (hit) return hit;
    }
    if (tableExists(db, 'import_dismissed')) {
        const row = db.prepare('SELECT external_id FROM import_dismissed WHERE source_id = ? LIMIT 1').get(sourceId);
        const hit = row && providerFromExternalId(row.external_id);
        if (hit) return hit;
    }
    return 'unknown';
}

function countUnowned(db) {
    const out = {};
    let total = 0;
    for (const table of PER_USER_TABLES) {
        if (!hasColumn(db, table, 'user_id')) continue;
        const n = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id IS NULL`).get().n;
        if (n) { out[table] = n; total += n; }
    }
    return { byTable: out, total };
}

function unresolvedSourceRows(db) {
    if (!tableExists(db, 'import_sources')) return 0;
    return SOURCE_SCOPED.filter(t => tableExists(db, t)).reduce((n, t) =>
        n + db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE source_id NOT IN (SELECT id FROM import_sources)`).get().n, 0);
}

function treeVersionOf(db, userId) {
    const row = db.prepare("SELECT value FROM user_tree_meta WHERE user_id = ? AND key = 'treeVersion'").get(userId);
    return row ? row.value : null;
}

function legacyTreeVersion(db) {
    if (!tableExists(db, 'tree_meta')) return null;
    const row = db.prepare("SELECT value FROM tree_meta WHERE key = 'treeVersion'").get();
    return row ? row.value : null;
}

// Runs at every boot, after bootstrapAdmin. The first time — no
// tenancy_owner_id recorded yet — it assigns every row to the owner and proves
// nothing else changed; later boots only make sure the guards exist and adopt
// stray NULL-owned rows when that is unambiguous. One transaction either way:
// any throw rolls back everything, the ALTERs included.
//
// `failAt` injects a failure for tests: 'after-alter' or 'before-commit'.
export function migrateOwnership(db, { env = process.env, failAt = null, bootstrappedUserIds = [] } = {}) {
    initTenancySchema(db);
    return db.transaction(() => {
        const recorded = getServerMeta(db, 'tenancy_owner_id');
        if (recorded !== null) return laterBoot(db, Number(recorded), env);
        return firstMigration(db, { env, failAt, bootstrappedUserIds });
    })();
}

// No digests and no tree-version comparison here: the owner has pushed since
// the migration, and comparing against the frozen tree_meta would fail on the
// second restart and crash-loop the server.
function laterBoot(db, ownerId, env) {
    ensureOwnershipColumns(db);
    ensureGuards(db);
    const unowned = countUnowned(db);
    if (!unowned.total) return { migrated: false };

    const users = db.prepare('SELECT id, username FROM users').all();
    let adoptTo = null;
    if (env.TENANCY_OWNER) {
        adoptTo = resolveUser(db, env.TENANCY_OWNER);
        if (!adoptTo) throw new Error(`TENANCY_OWNER=${env.TENANCY_OWNER} names no existing account`);
    } else if (users.length === 1 && users[0].id === ownerId) {
        adoptTo = users[0];
    }
    if (!adoptTo) {
        throw new Error(`${unowned.total} unowned rows and ${users.length} accounts: restore the pre-upgrade copy (sync.db.pre-v…) or set TENANCY_OWNER`);
    }
    for (const table of Object.keys(unowned.byTable)) {
        db.prepare(`UPDATE ${table} SET user_id = ? WHERE user_id IS NULL`).run(adoptTo.id);
    }
    return { migrated: false, adopted: unowned.byTable, adoptedTotal: unowned.total, adoptedTo: adoptTo };
}

function firstMigration(db, { env, failAt, bootstrappedUserIds }) {
    const owner = pickOwner(db, env);
    const tables = DIGEST_TABLES.filter(t => tableExists(db, t));
    const before = digestTables(db, tables);
    const orphanIds = findOrphanSourceIds(db);

    ensureOwnershipColumns(db);
    if (failAt === 'after-alter') throw new Error('Injected failure after ALTER TABLE');

    // Each orphaned archive gets a removed placeholder source, so it is owned,
    // counted, deletable with its account, and visible again behind "Show
    // removed sources".
    const now = new Date().toISOString();
    for (const id of orphanIds) {
        const provider = inferProvider(db, id);
        db.prepare(`
            INSERT INTO import_sources (id, provider, label, config, enabled, interval_minutes, created_at, deleted_at, user_id)
            VALUES (?, ?, ?, '{}', 0, 60, ?, ?, ?)
        `).run(id, provider, `Removed ${PROVIDER_NAMES[provider] || 'import'} source #${id}`, now, now, owner.id);
    }

    const assigned = {};
    let total = 0;
    for (const table of OWNED_TABLES) {
        if (!tableExists(db, table)) continue;
        const n = db.prepare(`UPDATE ${table} SET user_id = ? WHERE user_id IS NULL`).run(owner.id).changes;
        assigned[table] = n;
        total += n;
    }

    ensureGuards(db);
    if (tableExists(db, 'tree_meta')) {
        db.prepare('INSERT OR IGNORE INTO user_tree_meta (user_id, key, value) SELECT ?, key, value FROM tree_meta').run(owner.id);
    }

    const versions = db.prepare("SELECT value FROM user_tree_meta WHERE key = 'treeVersion'").all()
        .map(r => Number(r.value) || 0);
    const legacyVersion = Number(legacyTreeVersion(db)) || 0;
    const digest = {
        at: now,
        owner: owner.id,
        tables: before,
        orphanSourceIds: orphanIds,
        bootstrappedUserIds: bootstrappedUserIds.filter(Boolean)
    };
    setServerMeta(db, 'tenancy_owner_id', owner.id);
    setServerMeta(db, 'legacy_token_user_id', owner.id);
    setServerMeta(db, 'tenancy_migrated_at', now);
    setServerMeta(db, 'next_user_id', nextUserIdFloor(db));
    setServerMeta(db, 'tree_version_seq', Math.max(legacyVersion, ...versions, 0));
    setServerMeta(db, 'tenancy_digest', JSON.stringify(digest));

    // Prove it. Every pre-existing table compares equal on the columns it had
    // (import_sources minus the placeholders just added), nothing is left
    // unowned, the owner's tree version is the one their devices hold, and
    // every archive row resolves to a source.
    const after = digestTables(db, tables, { like: before, exclude: { import_sources: new Set(orphanIds) } });
    for (const table of tables) {
        const a = before[table];
        const b = after[table];
        if (!b || a.n !== b.n || a.sha256 !== b.sha256) {
            throw new Error(`Verification failed: ${table} changed during the migration (${a.n} rows before, ${b ? b.n : 'none'} after)`);
        }
    }
    const left = countUnowned(db);
    if (left.total) throw new Error(`Verification failed: ${left.total} rows still have no owner`);
    if (treeVersionOf(db, owner.id) !== legacyTreeVersion(db)) {
        throw new Error(`Verification failed: tree version ${treeVersionOf(db, owner.id)} does not match ${legacyTreeVersion(db)}`);
    }
    const unresolved = unresolvedSourceRows(db);
    if (unresolved) throw new Error(`Verification failed: ${unresolved} archive rows have no source`);
    if (orphanIds.length) {
        const n = db.prepare(`SELECT COUNT(*) AS n FROM import_sources WHERE id IN (${orphanIds.map(() => '?').join(',')})`).get(...orphanIds).n;
        if (n !== orphanIds.length) throw new Error(`Verification failed: ${n} of ${orphanIds.length} removed sources recovered`);
    }
    if (failAt === 'before-commit') throw new Error('Injected failure before COMMIT');

    return { migrated: true, owner, assigned, total, recovered: orphanIds.length, orphanSourceIds: orphanIds };
}

// The marker a refused migration leaves behind, and the message the next boot
// prints instead of trying again.
export function writeRefusal(dataDir, error, backupPath) {
    const file = path.join(dataDir, MARKER_FILE);
    const text = [
        `Refused at ${new Date().toISOString()}: ${error && error.message ? error.message : error}`,
        `Nothing was changed. Backup taken before the attempt: ${backupPath || '(none)'}`,
        'Fix the cause, delete this file, and restart.'
    ].join('\n');
    try { fs.writeFileSync(file, text + '\n'); } catch (e) { /* the log line still says it */ }
    return file;
}

// Run before the boot backup. Returns { ok } or { ok:false, error }.
export function preflight(db, dbPath, { schemaVersion, statfs = fs.statfsSync } = {}) {
    const dataDir = path.dirname(dbPath);
    const userVersion = db.pragma('user_version', { simple: true });
    if (userVersion > schemaVersion) {
        return {
            ok: false,
            error: `this database was upgraded by a newer TabPaladin (schema ${userVersion}, this build knows ${schemaVersion}); `
                + `restore sync.db.pre-v${userVersion}-… to roll back`
        };
    }
    const marker = path.join(dataDir, MARKER_FILE);
    if (fs.existsSync(marker)) {
        let text = '';
        try { text = fs.readFileSync(marker, 'utf8').trim(); } catch (e) { /* unreadable: still refuse */ }
        return { ok: false, error: `a previous migration was refused, so nothing was retried:\n${text}\n(${marker})` };
    }
    if (userVersion < schemaVersion && typeof statfs === 'function') {
        const size = (f) => { try { return fs.statSync(f).size; } catch (e) { return 0; } };
        const used = size(dbPath) + size(dbPath + '-wal');
        const need = Math.ceil(used * 2.5);
        let free = Infinity;
        try {
            const st = statfs(dataDir);
            free = Number(st.bavail) * Number(st.bsize);
        } catch (e) { /* unknown: do not block on it */ }
        if (free < need) {
            const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
            return {
                ok: false,
                error: `not enough disk for the upgrade: the database is ${mb(used)}, the backups and migration need ${mb(need)}, `
                    + `and ${mb(free)} is free in ${dataDir}`
            };
        }
    }
    return { ok: true };
}

// Boot-time warnings only; nothing here changes data.
export function checkOwnership(db) {
    const warnings = [];
    const unowned = countUnowned(db);
    for (const [table, n] of Object.entries(unowned.byTable)) warnings.push(`${n} row(s) in ${table} have no owner`);
    for (const table of PER_USER_TABLES) {
        if (!hasColumn(db, table, 'user_id')) continue;
        const n = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id IS NOT NULL AND user_id NOT IN (SELECT id FROM users)`).get().n;
        if (n) warnings.push(`${n} row(s) in ${table} belong to an account that no longer exists`);
    }
    const unresolved = unresolvedSourceRows(db);
    if (unresolved) warnings.push(`${unresolved} archive row(s) have no import source`);
    return warnings;
}

// --- Account ids and tree versions ------------------------------------------

function nextUserIdFloor(db) {
    let max = 0;
    const take = (sql) => { const v = db.prepare(sql).get().m; if (Number(v) > max) max = Number(v); };
    if (tableExists(db, 'users') && hasColumn(db, 'users', 'id')) take('SELECT MAX(id) AS m FROM users');
    if (tableExists(db, 'deleted_users')) take('SELECT MAX(id) AS m FROM deleted_users');
    for (const table of PER_USER_TABLES) {
        if (hasColumn(db, table, 'user_id')) take(`SELECT MAX(user_id) AS m FROM ${table}`);
    }
    return max + 1;
}

// Ids are never reused: a new account must not inherit rows, sessions or a
// cached AUTH_TOKEN mapping left behind by a deleted one.
export function nextUserId(db) {
    initTenancySchema(db);
    const id = Math.max(Number(getServerMeta(db, 'next_user_id')) || 0, nextUserIdFloor(db));
    setServerMeta(db, 'next_user_id', id + 1);
    return id;
}

// A random name for this server's data, made once and never changed. Account
// ids start at 1 on every server and the first admin is "admin" by default, so
// a client cannot tell "admin #1 here" from "admin #1 on another server" by id
// and name; it compares this instead, and the server refuses a push stamped
// with another server's id (see PUT /api/tree).
export function serverId(db) {
    initTenancySchema(db);
    db.prepare("INSERT OR IGNORE INTO server_meta (key, value) VALUES ('server_id', ?)")
        .run(crypto.randomBytes(12).toString('hex'));
    return getServerMeta(db, 'server_id');
}

// Every version bump, for every account, draws from one server-wide sequence,
// so a stale baseVersion from another account can never match. Clients compare
// versions only for equality, so the owner's numbers jumping when someone else
// pushes is harmless.
export function bumpTreeVersion(db, userId) {
    const stored = getServerMeta(db, 'tree_version_seq');
    const highest = stored !== null ? Number(stored) || 0
        : db.prepare("SELECT COALESCE(MAX(CAST(value AS INTEGER)), 0) AS m FROM user_tree_meta WHERE key = 'treeVersion'").get().m;
    // Never below this account's own version, so it only ever moves forward.
    const own = Number(treeVersionOf(db, userId)) || 0;
    const next = Math.max(highest, own) + 1;
    setServerMeta(db, 'tree_version_seq', next);
    db.prepare(`
        INSERT INTO user_tree_meta (user_id, key, value) VALUES (?, 'treeVersion', ?)
        ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
    `).run(userId, String(next));
    return next;
}

// --- One account's data --------------------------------------------------------

export function userStats(db, userId) {
    const one = (sql, ...args) => (db.prepare(sql).get(...args) || {}).n || 0;
    // The inbox is what waits to be filed: links filed or dismissed stay in
    // the table (nothing in it is hard-deleted) but are not in the inbox.
    const inboxSql = hasColumn(db, 'shared_links', 'status')
        ? "SELECT COUNT(*) AS n FROM shared_links WHERE user_id = ? AND status = 'pending'"
        : 'SELECT COUNT(*) AS n FROM shared_links WHERE user_id = ?';
    return {
        bookmarks: one("SELECT COUNT(*) AS n FROM items WHERE user_id = ? AND kind = 'bookmark'", userId),
        notes: one("SELECT COUNT(*) AS n FROM items WHERE user_id = ? AND kind = 'note'", userId),
        workflows: one(`
            SELECT COUNT(*) AS n FROM items w
            WHERE w.user_id = ? AND w.kind = 'folder' AND w.parent_id IN (
                SELECT id FROM items WHERE user_id = ? AND kind = 'folder' AND role = 'workflows')`, userId, userId),
        imports: one('SELECT COUNT(*) AS n FROM import_sources WHERE user_id = ? AND deleted_at IS NULL', userId),
        removedImports: one('SELECT COUNT(*) AS n FROM import_sources WHERE user_id = ? AND deleted_at IS NOT NULL', userId),
        // Removed sources' archives included: they are still this account's.
        archived: one('SELECT COUNT(*) AS n FROM import_items WHERE source_id IN (SELECT id FROM import_sources WHERE user_id = ?)', userId),
        inbox: one(inboxSql, userId),
        proposals: one('SELECT COUNT(*) AS n FROM note_proposals WHERE user_id = ?', userId),
        mcpTokens: hasColumn(db, 'mcp_tokens', 'user_id') ? one('SELECT COUNT(*) AS n FROM mcp_tokens WHERE user_id = ?', userId) : 0,
        history: one('SELECT COUNT(*) AS n FROM snapshots WHERE user_id = ?', userId),
        prefs: one('SELECT COUNT(*) AS n FROM user_prefs WHERE user_id = ?', userId)
    };
}

// Removes exactly one account: its archive (every source it ever had, removed
// ones included, with their tombstones and OAuth state), its tree and history,
// inbox, share links, proposals, MCP tokens, prefs and sessions, then the account itself,
// leaving a tombstone so the id and name are never handed out again. One
// transaction. Returns the per-table counts.
export function deleteUserData(db, userId, { deletedBy = null } = {}) {
    return db.transaction(() => {
        const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId);
        if (!user) throw new Error(`No user with id ${userId}`);
        const counts = {};
        const run = (key, sql, ...args) => {
            // Every table exists on a booted server; a bare test database may lack some.
            if (!tableExists(db, key) || (key.startsWith('import_') && !tableExists(db, 'import_sources'))) return;
            counts[key] = db.prepare(sql).run(...args).changes;
        };
        run('import_items', 'DELETE FROM import_items WHERE source_id IN (SELECT id FROM import_sources WHERE user_id = ?)', userId);
        run('import_dismissed', 'DELETE FROM import_dismissed WHERE source_id IN (SELECT id FROM import_sources WHERE user_id = ?)', userId);
        run('import_oauth_state', 'DELETE FROM import_oauth_state WHERE source_id IN (SELECT id FROM import_sources WHERE user_id = ?)', userId);
        run('import_sources', 'DELETE FROM import_sources WHERE user_id = ?', userId);
        run('items', 'DELETE FROM items WHERE user_id = ?', userId);
        run('user_tree_meta', 'DELETE FROM user_tree_meta WHERE user_id = ?', userId);
        run('snapshots', 'DELETE FROM snapshots WHERE user_id = ?', userId);
        run('share_filings', 'DELETE FROM share_filings WHERE user_id = ?', userId);
        run('shared_links', 'DELETE FROM shared_links WHERE user_id = ?', userId);
        run('tree_ops', 'DELETE FROM tree_ops WHERE user_id = ?', userId);
        run('share_tokens', 'DELETE FROM share_tokens WHERE user_id = ?', userId);
        run('note_proposals', 'DELETE FROM note_proposals WHERE user_id = ?', userId);
        run('mcp_tokens', 'DELETE FROM mcp_tokens WHERE user_id = ?', userId);
        run('user_prefs', 'DELETE FROM user_prefs WHERE user_id = ?', userId);
        run('sessions', 'DELETE FROM sessions WHERE username = ?', user.username);
        run('users', 'DELETE FROM users WHERE id = ?', userId);
        db.prepare('INSERT INTO deleted_users (id, username, deleted_at, deleted_by, counts) VALUES (?, ?, ?, ?, ?)')
            .run(user.id, user.username, new Date().toISOString(), deletedBy, JSON.stringify(counts));
        return counts;
    })();
}
