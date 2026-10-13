// The canonical bookmark store.
//
// The tree used to live in the browser: every client serialized its own
// bookmark tree and pushed it wholesale, and the server's only copy was that
// blob. That meant every sync had to map browser-specific root folders onto
// each other ("Other Bookmarks" vs "Unfiled Bookmarks" vs Opera's "Unsorted
// Bookmarks"), and a mismatch either duplicated subtrees or deleted them.
//
// Now the server owns the tree in this table and clients hold working copies.
// Nodes have server-side string ids that survive push/pull, so a client can
// remember "the pins folder is item ab12cd34" and be right forever. There are
// no browser roots: the top level is just folders.
//
// Node kinds:
//   folder    — may carry a `role` ('pins' | 'notes' | 'workflows') marking it
//               as an app-managed root. Roles replace magic folder titles.
//   bookmark  — title + url.
//   note      — title + payload {content, createdAt, updatedAt}. Notes used to
//               be bookmarks with a data:application/json url; they are rows
//               now, which is what lets /llm and proposals read them with SQL
//               instead of tree-walking a blob.
//
// Every account's tree lives in the same table, told apart by user_id. The
// only way in is forUser(uid), whose every statement is scoped to that
// account, so no caller can read or replace someone else's tree by forgetting
// a WHERE clause.
import crypto from 'node:crypto';
import { bumpTreeVersion } from './tenancy.js';

export const KINDS = new Set(['folder', 'bookmark', 'note']);
export const ROLES = new Set(['bookmarks', 'pins', 'notes', 'workflows']);
export const TREE_FORMAT = 2;

export function newId() {
    return crypto.randomBytes(8).toString('hex');
}

// A push that names ids already stored under another account. Item ids are a
// global primary key, so this is either a working copy that belongs to
// someone else or a stale one from before an account switch; either way it is
// refused whole rather than re-minted, which would fork the other account's
// items into this tree.
export class ForeignIdError extends Error {
    constructor(count) {
        super(`${count} item(s) in this push belong to another account.`);
        this.name = 'ForeignIdError';
        this.code = 'foreign-ids';
        this.count = count;
    }
}

// --- Old-snapshot constants, needed only by the migration ---
const DATA_PREFIX = 'data:application/json,';
const ROOT_MARKER_TITLE = '__tabpaladin_root__';
const META_TITLE = '__tabpaladin_meta__';
const IMPORTS_ROOT_TITLE = 'TabPaladin Imports';
const ROLE_BY_TITLE = new Map([
    ['TabPaladin Pinned', 'pins'],
    ['TabPaladin Notes', 'notes'],
    ['TabPaladin Workflows', 'workflows']
]);

function decodeDataJson(url) {
    try {
        return JSON.parse(decodeURIComponent(url.slice(DATA_PREFIX.length)));
    } catch (e) {
        try { return JSON.parse(url.slice(DATA_PREFIX.length)); } catch (e2) { return null; }
    }
}

// CREATE TABLE only: user_id and its guards are added by the ownership
// migration (tenancy.js), and every statement is prepared at call time, so
// this can run before that migration does.
export function makeItemsStore(db, { maxSnapshots = 200 } = {}) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS items (
            id TEXT PRIMARY KEY,
            parent_id TEXT,
            position INTEGER NOT NULL DEFAULT 0,
            kind TEXT NOT NULL,
            role TEXT,
            title TEXT NOT NULL DEFAULT '',
            url TEXT,
            payload TEXT,
            created_at TEXT,
            updated_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_items_parent ON items(parent_id, position);

        -- The single-user metadata, frozen since accounts were separated;
        -- user_tree_meta holds the live per-account values.
        CREATE TABLE IF NOT EXISTS tree_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
    `);

    function forUser(uid) {
        const userId = Number(uid);
        if (!Number.isInteger(userId) || userId <= 0) throw new Error(`Not an account id: ${uid}`);
        if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) throw new Error(`No account with id ${userId}`);
        return makeUserStore(db, userId, { maxSnapshots });
    }

    // Boot-time heal of duplicate role folders, per account and role: two
    // accounts each having a notes root is not a duplicate, and merging them
    // would hand one account's notes to the other.
    function healAllUsers() {
        const rows = db.prepare(`
            SELECT user_id, role FROM items
            WHERE kind = 'folder' AND role IS NOT NULL AND user_id IN (SELECT id FROM users)
            GROUP BY user_id, role HAVING COUNT(*) > 1
        `).all();
        const users = [];
        for (const userId of new Set(rows.map(r => r.user_id))) {
            const healed = forUser(userId).healDuplicateRoles();
            if (healed.healed) users.push({ userId, roles: healed.roles });
        }
        return { healed: users.length > 0, users };
    }

    return { forUser, healAllUsers };
}

// One account's view of the store. Reached only through forUser, which has
// already checked that the account exists.
function makeUserStore(db, userId, { maxSnapshots }) {
    const getMeta = (key) => {
        const row = db.prepare('SELECT value FROM user_tree_meta WHERE user_id = ? AND key = ?').get(userId, key);
        return row ? row.value : null;
    };
    const setMeta = (key, value) => {
        db.prepare(`
            INSERT INTO user_tree_meta (user_id, key, value) VALUES (?, ?, ?)
            ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
        `).run(userId, key, String(value));
    };

    function version() {
        return Number(getMeta('treeVersion') || 0);
    }

    // The next value of the server-wide version sequence, now this account's.
    const bumpVersion = () => bumpTreeVersion(db, userId);

    // Every tree change funnels through here so history and the version counter
    // can never drift apart. History rows reuse the old snapshots table; new
    // entries are tagged with format 2 so a client browsing history can tell
    // them from pre-migration browser-tree blobs. Pruned per account, so one
    // account's pushes never evict another's history.
    function recordHistory(roots, deviceId) {
        const ts = new Date().toISOString();
        db.prepare('INSERT INTO snapshots (timestamp, device_id, json, user_id) VALUES (?, ?, ?, ?)')
            .run(ts, deviceId || null, JSON.stringify({ format: TREE_FORMAT, roots }), userId);
        db.prepare(`
            DELETE FROM snapshots WHERE user_id = ? AND id NOT IN (
                SELECT id FROM snapshots WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?
            )
        `).run(userId, userId, maxSnapshots);
        return ts;
    }

    // --- Normalization -----------------------------------------------------
    //
    // A pushed tree is whatever a client managed to build, so everything is
    // re-derived here: ids are deduplicated (first occurrence keeps its id),
    // kinds are validated, and anything virtual — the imports subtree the
    // server itself appended to the last pull — is stripped rather than stored.
    function normalizeRoots(roots) {
        const seen = new Set();
        const clean = (node) => {
            if (!node || typeof node !== 'object') return null;
            if (node.virtual || (typeof node.id === 'string' && (node.id.startsWith('imp:') || node.id === 'imports:root'))) {
                return null;
            }
            let kind = node.kind;
            // Tolerate the old serializer's names so a half-updated client fails soft.
            if (kind === 'root') kind = 'folder';
            if (!KINDS.has(kind)) kind = node.url ? 'bookmark' : 'folder';

            let id = typeof node.id === 'string' && node.id.trim() ? node.id.trim() : newId();
            if (seen.has(id)) id = newId();
            seen.add(id);

            const out = {
                id,
                kind,
                title: String(node.title || '')
            };
            if (kind === 'bookmark') {
                if (typeof node.url !== 'string' || !node.url) return null;
                out.url = node.url;
            }
            if (kind === 'folder' && ROLES.has(node.role)) out.role = node.role;
            if (node.payload && typeof node.payload === 'object') out.payload = node.payload;
            if (kind === 'folder') {
                out.children = (Array.isArray(node.children) ? node.children : [])
                    .map(clean)
                    .filter(Boolean);
            }
            return out;
        };
        const out = (Array.isArray(roots) ? roots : []).map(clean).filter(Boolean);
        mergeDuplicateRoles(out);
        return out;
    }

    // A role is meant to be unique, but nothing on a client enforces it: a
    // working copy that never pulled creates its own workflows root, and a
    // force push then lands a second one beside the server's. Clients use the
    // first one they find, so whatever was saved into the other was invisible.
    // Fold every later copy's children into the first; nothing is dropped
    // except the empty husk.
    function mergeDuplicateRoles(roots) {
        const first = new Map();
        const walk = (siblings) => {
            for (let i = 0; i < siblings.length; i++) {
                const n = siblings[i];
                if (n.kind !== 'folder') continue;
                if (n.role) {
                    const keep = first.get(n.role);
                    if (keep && keep !== n) {
                        keep.children.push(...n.children);
                        siblings.splice(i--, 1);
                        continue;
                    }
                    first.set(n.role, n);
                }
                walk(n.children);
            }
        };
        walk(roots);
        return roots;
    }

    // Heal a stored tree that already has duplicate role folders. Runs at boot.
    function healDuplicateRoles() {
        const dupes = db.prepare(
            "SELECT role, COUNT(*) AS n FROM items WHERE user_id = ? AND kind = 'folder' AND role IS NOT NULL GROUP BY role HAVING n > 1"
        ).all(userId);
        if (!dupes.length) return { healed: false };
        writeTree(readTree().roots, { deviceId: 'heal-duplicate-roles' });
        return { healed: true, roles: dupes.map(d => d.role) };
    }

    // --- Tree <-> rows ------------------------------------------------------

    function readTree() {
        const rows = db.prepare('SELECT * FROM items WHERE user_id = ? ORDER BY parent_id, position, id').all(userId);
        const byParent = new Map();
        for (const r of rows) {
            const key = r.parent_id || '';
            if (!byParent.has(key)) byParent.set(key, []);
            byParent.get(key).push(r);
        }
        const build = (row) => {
            const node = { id: row.id, kind: row.kind, title: row.title };
            if (row.url) node.url = row.url;
            if (row.role) node.role = row.role;
            if (row.payload) {
                try { node.payload = JSON.parse(row.payload); } catch (e) { /* corrupt payload */ }
            }
            if (row.kind === 'folder') {
                node.children = (byParent.get(row.id) || []).map(build);
            }
            return node;
        };
        return { version: version(), roots: (byParent.get('') || []).map(build) };
    }

    // Ids stored under any other account — or under none: 'IS NOT' rather
    // than '<>', which would miss a NULL-owned row.
    function foreignIdCount(ids) {
        let n = 0;
        for (let i = 0; i < ids.length; i += 500) {
            const chunk = ids.slice(i, i + 500);
            n += db.prepare(`SELECT COUNT(*) AS n FROM items WHERE id IN (${chunk.map(() => '?').join(',')}) AND user_id IS NOT ?`)
                .get(...chunk, userId).n;
        }
        return n;
    }

    const writeTx = db.transaction((roots, deviceId) => {
        const ids = [];
        const collect = (node) => { ids.push(node.id); (node.children || []).forEach(collect); };
        roots.forEach(collect);
        const foreign = foreignIdCount(ids);
        if (foreign) throw new ForeignIdError(foreign);

        db.prepare('DELETE FROM items WHERE user_id = ?').run(userId);
        const now = new Date().toISOString();
        const insert = db.prepare(`
            INSERT INTO items (id, parent_id, position, kind, role, title, url, payload, created_at, updated_at, user_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const walk = (node, parentId, position) => {
            insert.run(
                node.id, parentId, position, node.kind, node.role || null,
                node.title, node.url || null,
                node.payload ? JSON.stringify(node.payload) : null,
                now, now, userId
            );
            if (node.kind === 'folder') {
                (node.children || []).forEach((c, i) => walk(c, node.id, i));
            }
        };
        roots.forEach((r, i) => walk(r, null, i));
        bumpVersion();
        recordHistory(roots, deviceId);
    });

    // Replace this account's tree. Returns the new version. Throws
    // ForeignIdError, having written nothing, when the push names another
    // account's ids.
    function writeTree(roots, { deviceId = null } = {}) {
        const clean = normalizeRoots(roots);
        writeTx(clean, deviceId);
        return version();
    }

    function countNodes(roots) {
        let n = 0;
        const walk = (node) => { n++; (node.children || []).forEach(walk); };
        (roots || []).forEach(walk);
        return n;
    }

    // --- Role lookups -------------------------------------------------------

    function findRoleRow(role) {
        return db.prepare("SELECT * FROM items WHERE user_id = ? AND kind = 'folder' AND role = ? ORDER BY parent_id IS NOT NULL, position LIMIT 1")
            .get(userId, role) || null;
    }

    // --- The main bookmarks root -------------------------------------------
    //
    // With the tree in a database there is no reason to keep a browser's idea
    // of "Other Bookmarks" as a top-level sibling of everything else: there is
    // one bookmarks folder, it is called Bookmarks, and imports live inside it
    // like any other collection.
    //
    // Runs once. A tree that already has a bookmarks-role folder is left alone,
    // so this cannot fight the user renaming or reorganising it later.
    const NOISE_TITLES = new Set([
        'trash', 'prullenbak', 'papierkorb', 'corbeille',
        'speed dials', 'speeddial', 'pinboard', 'unsynchronized pinboard',
        'imported bookmarks', 'geïmporteerde bladwijzers'
    ]);

    function descendantCount(id) {
        const kids = db.prepare('SELECT id FROM items WHERE user_id = ? AND parent_id = ?').all(userId, id);
        return kids.reduce((n, k) => n + 1 + descendantCount(k.id), 0);
    }

    const ensureBookmarksRoot = db.transaction(() => {
        const existing = findRoleRow('bookmarks');
        if (existing) return { id: existing.id, created: false };

        const tops = db.prepare("SELECT * FROM items WHERE user_id = ? AND parent_id IS NULL AND kind = 'folder'").all(userId);
        const candidates = tops.filter(t => !t.role && !NOISE_TITLES.has((t.title || '').toLowerCase().trim()));

        const now = new Date().toISOString();
        // The biggest ordinary root is the one holding the user's bookmarks;
        // "Other Bookmarks" wins ties because that is what it was called.
        let chosen = null;
        let best = -1;
        for (const c of candidates) {
            const n = descendantCount(c.id) + (/other|unfiled|bookmark/i.test(c.title || '') ? 1e6 : 0);
            if (n > best) { best = n; chosen = c; }
        }

        if (!chosen) {
            const id = newId();
            const max = db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM items WHERE user_id = ? AND parent_id IS NULL').get(userId).p;
            db.prepare(`
                INSERT INTO items (id, parent_id, position, kind, role, title, created_at, updated_at, user_id)
                VALUES (?, NULL, ?, 'folder', 'bookmarks', 'Bookmarks', ?, ?, ?)
            `).run(id, max + 1, now, now, userId);
            bumpVersion();
            return { id, created: true };
        }

        db.prepare("UPDATE items SET role = 'bookmarks', title = 'Bookmarks', updated_at = ? WHERE id = ? AND user_id = ?")
            .run(now, chosen.id, userId);

        // Any other ordinary top-level folder becomes a child of it, so the top
        // level is the app's own sections rather than a browser's leftovers.
        // Noise roots are left where they are: they are hidden, not owned.
        let moved = 0;
        const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM items WHERE user_id = ? AND parent_id = ?').get(userId, chosen.id).p;
        let pos = maxPos + 1;
        for (const c of candidates) {
            if (c.id === chosen.id) continue;
            db.prepare('UPDATE items SET parent_id = ?, position = ?, updated_at = ? WHERE id = ? AND user_id = ?')
                .run(chosen.id, pos++, now, c.id, userId);
            moved++;
        }
        bumpVersion();
        return { id: chosen.id, created: false, renamedFrom: chosen.title, moved };
    });

    function bookmarksRootId() {
        const row = findRoleRow('bookmarks');
        return row ? row.id : null;
    }

    // --- Notes (used by /llm share pages and proposal approval) -------------

    function noteFromRow(row) {
        let payload = {};
        try { payload = JSON.parse(row.payload || '{}'); } catch (e) { /* corrupt */ }
        return {
            id: row.id,
            title: row.title,
            content: payload.content || '',
            createdAt: payload.createdAt || row.created_at || null,
            updatedAt: payload.updatedAt || payload.createdAt || null,
            notebook: null
        };
    }

    // All notes, tagged with their notebook (the folder between the notes root
    // and the note, when there is one). Notes outside the notes root still
    // count — a note the user filed elsewhere should not vanish from the LLM
    // share page.
    function listNotes() {
        const root = findRoleRow('notes');
        const rows = db.prepare("SELECT * FROM items WHERE user_id = ? AND kind = 'note' ORDER BY position, id").all(userId);
        const parentTitle = new Map(
            db.prepare("SELECT id, title FROM items WHERE user_id = ? AND kind = 'folder'").all(userId).map(r => [r.id, r.title])
        );
        return rows.map(r => {
            const note = noteFromRow(r);
            if (root && r.parent_id && r.parent_id !== root.id && parentTitle.has(r.parent_id)) {
                note.notebook = parentTitle.get(r.parent_id);
            }
            return note;
        });
    }

    function ensureNotesRoot() {
        const existing = findRoleRow('notes');
        if (existing) return existing.id;
        const now = new Date().toISOString();
        const id = newId();
        const max = db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM items WHERE user_id = ? AND parent_id IS NULL').get(userId).p;
        db.prepare(`
            INSERT INTO items (id, parent_id, position, kind, role, title, created_at, updated_at, user_id)
            VALUES (?, NULL, ?, 'folder', 'notes', 'Notes', ?, ?, ?)
        `).run(id, max + 1, now, now, userId);
        return id;
    }

    function ensureNotebook(rootId, name) {
        const existing = db.prepare(
            "SELECT id FROM items WHERE user_id = ? AND kind = 'folder' AND parent_id = ? AND title = ?"
        ).get(userId, rootId, name);
        if (existing) return existing.id;
        const now = new Date().toISOString();
        const id = newId();
        const max = db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM items WHERE user_id = ? AND parent_id = ?').get(userId, rootId).p;
        db.prepare(`
            INSERT INTO items (id, parent_id, position, kind, title, created_at, updated_at, user_id)
            VALUES (?, ?, ?, 'folder', ?, ?, ?, ?)
        `).run(id, rootId, max + 1, name, now, now, userId);
        return id;
    }

    // Create or replace the note with this title. Same-title matching is what
    // the LLM contract promises ("a proposal REPLACES the note with that
    // title"), so it searches every note of this account, not just the
    // requested notebook —
    // but when two notes share the title, the one already in the requested
    // notebook wins over a same-named note elsewhere.
    const upsertNote = db.transaction((title, content, notebook) => {
        const now = new Date().toISOString();
        const rootId = ensureNotesRoot();
        const targetId = notebook ? ensureNotebook(rootId, notebook) : rootId;

        const existing = db.prepare(`
            SELECT * FROM items WHERE user_id = ? AND kind = 'note' AND title = ?
            ORDER BY (parent_id = ?) DESC, position, id LIMIT 1
        `).get(userId, title, targetId);
        if (existing) {
            const old = noteFromRow(existing);
            db.prepare('UPDATE items SET payload = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(
                JSON.stringify({ content, createdAt: old.createdAt || now, updatedAt: now }), now, existing.id, userId
            );
        } else {
            const max = db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM items WHERE user_id = ? AND parent_id = ?').get(userId, targetId).p;
            db.prepare(`
                INSERT INTO items (id, parent_id, position, kind, title, payload, created_at, updated_at, user_id)
                VALUES (?, ?, ?, 'note', ?, ?, ?, ?, ?)
            `).run(newId(), targetId, max + 1, title,
                JSON.stringify({ content, createdAt: now, updatedAt: now }), now, now, userId);
        }
        bumpVersion();
    });

    // Reorder notes to match a list of titles, per parent folder; notes not in
    // the list keep their relative order after the listed ones.
    const reorderNotes = db.transaction((order) => {
        const rank = new Map(order.map((t, i) => [t, i]));
        const parents = db.prepare("SELECT DISTINCT parent_id FROM items WHERE user_id = ? AND kind = 'note'").all(userId);
        for (const { parent_id } of parents) {
            const kids = db.prepare('SELECT id, kind, title FROM items WHERE user_id = ? AND parent_id IS ? ORDER BY position, id')
                .all(userId, parent_id);
            const notes = kids.filter(k => k.kind === 'note');
            const sorted = notes.slice().sort((a, b) => {
                const ra = rank.has(a.title) ? rank.get(a.title) : Infinity;
                const rb = rank.has(b.title) ? rank.get(b.title) : Infinity;
                return ra - rb;
            });
            let ni = 0;
            const stmt = db.prepare('UPDATE items SET position = ? WHERE id = ? AND user_id = ?');
            kids.forEach((k, i) => {
                stmt.run(i, k.kind === 'note' ? sorted[ni++].id : k.id, userId);
            });
        }
        bumpVersion();
    });

    function applyNoteProposal(prop) {
        if (prop.kind === 'reorder') {
            let order = null;
            try { order = JSON.parse(prop.content); } catch (e) { /* corrupt */ }
            if (!Array.isArray(order)) return { ok: false, error: 'Corrupt reorder proposal.' };
            reorderNotes(order);
        } else {
            upsertNote(prop.title, prop.content, prop.notebook || null);
        }
        recordHistory(readTree().roots, 'llm-proposal');
        return { ok: true };
    }

    // --- Migration from a pre-format-2 snapshot -----------------------------
    //
    // Runs once, on the first boot after the upgrade, when this account has no
    // items but does have history. Converts its newest browser-tree blob:
    //   - browser roots ("Bookmarks Bar", "Other Bookmarks", ...) become plain
    //     top-level folders,
    //   - the three magic-title folders get their role tags, duplicates merged,
    //   - data:application/json bookmarks become note rows,
    //   - __tabpaladin_root__ markers are dropped and __tabpaladin_meta__
    //     sentinels fold into their folder's payload,
    //   - the "TabPaladin Imports" subtree is skipped entirely: the archive
    //     already lives in import_items, and the tree copy was only ever a
    //     projection of it.
    function migrateFromLatestSnapshotIfNeeded() {
        const already = db.prepare('SELECT COUNT(*) AS n FROM items WHERE user_id = ?').get(userId).n;
        if (already > 0) return { migrated: false, reason: 'items table not empty' };
        const row = db.prepare('SELECT json, timestamp FROM snapshots WHERE user_id = ? ORDER BY timestamp DESC LIMIT 1').get(userId);
        if (!row) {
            setMeta('treeVersion', version() || 0);
            return { migrated: false, reason: 'no snapshots' };
        }
        let snapshot;
        try { snapshot = JSON.parse(row.json); } catch (e) {
            return { migrated: false, reason: 'latest snapshot unreadable' };
        }
        if (snapshot && snapshot.format === TREE_FORMAT) {
            // Already-new history entry (a restored backup, say): load it directly.
            const v = writeTree(snapshot.roots, { deviceId: 'migration' });
            setMeta('migratedFrom', row.timestamp);
            return { migrated: true, version: v, nodes: countNodes(snapshot.roots) };
        }

        const roleFolders = new Map(); // role -> node (first one wins, later ones merge in)

        const convert = (node) => {
            if (!node || typeof node !== 'object') return null;
            if (node.url) {
                if (node.title === ROOT_MARKER_TITLE) return null;
                if (node.url.startsWith(DATA_PREFIX)) {
                    if (node.title === META_TITLE) return null; // handled by the folder pass
                    const p = decodeDataJson(node.url) || {};
                    return {
                        id: newId(), kind: 'note', title: node.title || 'Untitled',
                        payload: {
                            content: p.content || '',
                            createdAt: p.createdAt || null,
                            updatedAt: p.updatedAt || p.createdAt || null
                        }
                    };
                }
                return { id: newId(), kind: 'bookmark', title: node.title || node.url, url: node.url };
            }

            if (node.title === IMPORTS_ROOT_TITLE) return null;

            const meta = (node.children || []).find(c => c && c.title === META_TITLE && typeof c.url === 'string');
            const children = (node.children || []).map(convert).filter(Boolean);
            const folder = { id: newId(), kind: 'folder', title: node.title || '', children };
            if (meta) {
                const p = decodeDataJson(meta.url);
                if (p && p.createdAt) folder.payload = { createdAt: p.createdAt };
            }

            const role = ROLE_BY_TITLE.get(node.title);
            if (role) {
                const existing = roleFolders.get(role);
                if (existing) {
                    // The historic duplicate-roots bug, healed at the door: the
                    // second copy's children join the first, the husk is dropped.
                    existing.children.push(...children);
                    return null;
                }
                folder.role = role;
                roleFolders.set(role, folder);
            }
            return folder;
        };

        // Old shape: { type: 'root', children: [browser roots...] }.
        const roots = (snapshot.children || [])
            .map(convert)
            .filter(Boolean)
            .filter(f => f.kind !== 'folder' || (f.children || []).length > 0 || f.role);

        const v = writeTree(roots, { deviceId: 'migration' });
        setMeta('migratedFrom', row.timestamp);
        return { migrated: true, version: v, nodes: countNodes(roots) };
    }

    return {
        userId,
        version,
        ensureBookmarksRoot,
        bookmarksRootId,
        readTree,
        writeTree,
        normalizeRoots,
        countNodes,
        listNotes,
        applyNoteProposal,
        migrateFromLatestSnapshotIfNeeded,
        healDuplicateRoles,
        recordHistory
    };
}
