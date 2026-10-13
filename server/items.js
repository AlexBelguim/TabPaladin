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

        -- The changes to an account's tree that did not replace it: links
        -- filed from the share sheet (append) and their undo (unappend). Each
        -- row names the version it applies to and the one it made, so a client
        -- can tell a gap made only of these from one it has to pull. See
        -- opsSince. user_id and its guards are added like everyone else's.
        CREATE TABLE IF NOT EXISTS tree_ops (
            user_id INTEGER NOT NULL,
            version INTEGER NOT NULL,
            base_version INTEGER NOT NULL,
            kind TEXT NOT NULL,
            payload TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (user_id, version)
        );
    `);

    function forUser(uid) {
        const userId = Number(uid);
        if (!Number.isInteger(userId) || userId <= 0) throw new Error(`Not an account id: ${uid}`);
        if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) throw new Error(`No account with id ${userId}`);
        return makeUserStore(db, userId, { maxSnapshots });
    }

    // Boot: every account's ops floor, where it has none yet. Before this
    // release nothing was logged, so a gap below an account's current version
    // must never look like one made only of appends.
    function initOpsFloors() {
        let n = 0;
        for (const { id } of db.prepare('SELECT id FROM users ORDER BY id').all()) {
            if (forUser(id).initOpsFloor()) n++;
        }
        return n;
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

    return { forUser, healAllUsers, initOpsFloors };
}

// Roles whose folders hold app-managed things — notes, saved workflows,
// pins — that a shared link is never filed into.
const NOT_A_FILING_TARGET = new Set(['notes', 'workflows', 'pins']);

// The ops log keeps at most this many rows per account. A client further
// behind than that gets an incomplete answer and pulls, as it would anyway.
const MAX_OPS_PER_USER = 1000;

const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

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

    // Every change to the tree takes the next value of the server-wide version
    // sequence, through here. A change that replaces the tree ('replace', or
    // 'system' for the server's own boot steps) raises the ops floor to the
    // new version and forgets the log below it: a client older than that has
    // to pull. An 'append' or 'unappend' is logged instead, with the version
    // it applied to, so the log says exactly what a client missed.
    function bump(kind, payload = null) {
        const base = version();
        const next = bumpTreeVersion(db, userId);
        if (kind === 'append' || kind === 'unappend') {
            // An account whose floor was never set (made since the boot that
            // set everyone's): nothing before this is known to be in the log.
            if (getMeta('opsFloor') === null) setMeta('opsFloor', base);
            db.prepare('INSERT INTO tree_ops (user_id, version, base_version, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)')
                .run(userId, next, base, kind, JSON.stringify(payload || {}), new Date().toISOString());
            db.prepare(`
                DELETE FROM tree_ops WHERE user_id = ? AND version NOT IN (
                    SELECT version FROM tree_ops WHERE user_id = ? ORDER BY version DESC LIMIT ?
                )
            `).run(userId, userId, MAX_OPS_PER_USER);
        } else {
            setMeta('opsFloor', next);
            db.prepare('DELETE FROM tree_ops WHERE user_id = ? AND version <= ?').run(userId, next);
        }
        return next;
    }

    // An account with no tree version yet has nothing to protect: its first
    // change sets the floor (see bump), so no row is written for it here.
    function initOpsFloor() {
        if (getMeta('opsFloor') !== null || getMeta('treeVersion') === null) return false;
        setMeta('opsFloor', version());
        return true;
    }

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
        bump('replace');
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
            bump('system');
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
        bump('system');
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
    //   notebook      the immediate folder's title, as it always was;
    //   notebookPath  the titles from the notes root down (['Work', 'Meetings']),
    //                 so same-named notebooks under different parents stay
    //                 apart. A note outside the notes root keeps [notebook].
    function listNotes() {
        const root = findRoleRow('notes');
        const rows = db.prepare("SELECT * FROM items WHERE user_id = ? AND kind = 'note' ORDER BY position, id").all(userId);
        const folders = new Map(
            db.prepare("SELECT id, parent_id, title FROM items WHERE user_id = ? AND kind = 'folder'").all(userId).map(r => [r.id, r])
        );
        const pathOf = (folderId) => {
            const titles = [];
            let id = folderId;
            while (id && id !== root.id && folders.has(id) && titles.length < 1000) {
                titles.unshift(folders.get(id).title);
                id = folders.get(id).parent_id;
            }
            return id === root.id ? titles : null; // null: outside the notes root
        };
        return rows.map(r => {
            const note = noteFromRow(r);
            note.notebookPath = [];
            if (root && r.parent_id && r.parent_id !== root.id && folders.has(r.parent_id)) {
                note.notebook = folders.get(r.parent_id).title;
                note.notebookPath = pathOf(r.parent_id) || [note.notebook];
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

    function insertFolder(parentId, title) {
        const now = new Date().toISOString();
        const id = newId();
        const max = db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM items WHERE user_id = ? AND parent_id = ?').get(userId, parentId).p;
        db.prepare(`
            INSERT INTO items (id, parent_id, position, kind, title, created_at, updated_at, user_id)
            VALUES (?, ?, ?, 'folder', ?, ?, ?, ?)
        `).run(id, parentId, max + 1, title, now, now, userId);
        return id;
    }

    // The notebook a proposal names, found the way the clients' import links
    // find it (resolveNotebookByName in notesModel.js), so the same name lands
    // in the same place from either. Order: an exact top-level title; an exact
    // nested title that itself contains ' / '; an 'A / B' path, creating what
    // is missing below the deepest match; a unique nested title; otherwise a
    // new top-level notebook. Matching ignores case, preferring an exact-case
    // match among equals. Only ever adds folders.
    function ensureNotebook(rootId, name) {
        const wanted = String(name).trim();
        const kids = new Map();
        for (const r of db.prepare("SELECT id, parent_id, title FROM items WHERE user_id = ? AND kind = 'folder' ORDER BY position, id").all(userId)) {
            if (!kids.has(r.parent_id)) kids.set(r.parent_id, []);
            kids.get(r.parent_id).push({ id: r.id, title: String(r.title || '') });
        }
        const childrenOf = (id) => kids.get(id) || [];
        const same = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
        const pick = (list, t) => list.find(b => b.title.trim() === t) || list[0];

        const roots = childrenOf(rootId);
        const top = roots.filter(b => same(b.title, wanted));
        if (top.length) return pick(top, wanted).id;

        const nested = [];
        const walk = (list) => {
            for (const b of list) {
                const below = childrenOf(b.id);
                nested.push(...below);
                walk(below);
            }
        };
        walk(roots);

        let parentId = rootId;
        let segments = [wanted];
        if (wanted.includes(' / ')) {
            const literal = nested.filter(b => same(b.title, wanted));
            if (literal.length) return pick(literal, wanted).id;
            segments = wanted.split(/\s+\/\s+/).map(t => t.trim()).filter(Boolean);
            let level = roots;
            let i = 0;
            for (; i < segments.length; i++) {
                const hits = level.filter(b => same(b.title, segments[i]));
                if (!hits.length) break;
                parentId = pick(hits, segments[i]).id;
                level = childrenOf(parentId);
            }
            segments = segments.slice(i);
        } else {
            const hits = nested.filter(b => same(b.title, wanted));
            if (hits.length === 1) return hits[0].id;
        }
        for (const segment of segments) parentId = insertFolder(parentId, segment);
        return parentId;
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
            // Merge into the stored payload: fields a client added (pinned,
            // say) are not the proposal's to drop.
            const old = noteFromRow(existing);
            let raw = {};
            try { raw = JSON.parse(existing.payload || '{}'); } catch (e) { /* corrupt */ }
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
            db.prepare('UPDATE items SET payload = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(
                JSON.stringify({ ...raw, content, createdAt: old.createdAt || now, updatedAt: now }), now, existing.id, userId
            );
        } else {
            const max = db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM items WHERE user_id = ? AND parent_id = ?').get(userId, targetId).p;
            db.prepare(`
                INSERT INTO items (id, parent_id, position, kind, title, payload, created_at, updated_at, user_id)
                VALUES (?, ?, ?, 'note', ?, ?, ?, ?, ?)
            `).run(newId(), targetId, max + 1, title,
                JSON.stringify({ content, createdAt: now, updatedAt: now }), now, now, userId);
        }
        bump('replace');
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
        bump('replace');
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

    // --- Appends: links filed from the share sheet ---------------------------
    //
    // The one write besides a full push that adds to the tree, like saving a
    // workflow is an exception to push/pull on the extension's side: a filed
    // link lands at once instead of waiting for the phone to push its whole
    // copy. It only ever adds — new folders, and a bookmark at the end of each
    // — and is logged in tree_ops rather than as a history snapshot, so a
    // phone's shares cannot push the restore points out of the window.

    // What the log holds after `since`: complete only when every change from
    // `since` up to the current version is in it — a chain of appends and
    // unappends with nothing between them. Anything else (a push, a proposal,
    // an older version than the floor, or one this account never had) is
    // incomplete, and the client pulls.
    function opsSince(since) {
        const current = version();
        const raw = getMeta('opsFloor');
        const floor = raw === null ? current : Number(raw);
        const n = Number(since);
        const incomplete = { version: current, floor, complete: false, ops: [] };
        if (!Number.isInteger(n) || n < 0 || n > current) return incomplete;
        if (n === current) return { version: current, floor, complete: true, ops: [] };
        if (n < floor) return incomplete;
        const rows = db.prepare('SELECT version, base_version, kind, payload FROM tree_ops WHERE user_id = ? AND version > ? ORDER BY version')
            .all(userId, n);
        const ops = [];
        let at = n;
        for (const r of rows) {
            if (Number(r.base_version) !== at) return incomplete;
            let payload;
            try { payload = JSON.parse(r.payload); } catch (e) { return incomplete; }
            ops.push({ version: Number(r.version), kind: r.kind, payload });
            at = Number(r.version);
        }
        if (at !== current) return incomplete;
        return { version: current, floor, complete: true, ops };
    }

    // Can a link be filed into folder `id`? {ok, row} or {ok:false, reason}:
    // 'missing' (no such folder in this account's tree), 'not-a-folder', or
    // 'read-only' (inside notes, workflows or pins, or the virtual imports
    // archive, which is never stored).
    function folderTarget(id) {
        const key = String(id || '');
        if (!key) return { ok: false, reason: 'missing' };
        if (key.startsWith('imp:') || key === 'imports:root') return { ok: false, reason: 'read-only' };
        const row = db.prepare('SELECT id, parent_id, kind, role, title FROM items WHERE user_id = ? AND id = ?').get(userId, key);
        if (!row) return { ok: false, reason: 'missing' };
        if (row.kind !== 'folder') return { ok: false, reason: 'not-a-folder' };
        const up = db.prepare('SELECT id, parent_id, role FROM items WHERE user_id = ? AND id = ?');
        let cur = row;
        for (let hops = 0; cur && hops < 1000; hops++) {
            if (cur.role && NOT_A_FILING_TARGET.has(cur.role)) return { ok: false, reason: 'read-only' };
            cur = cur.parent_id ? up.get(userId, cur.parent_id) : null;
        }
        return { ok: true, row };
    }

    const nextPosition = (parentId) => db.prepare(
        'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM items WHERE user_id = ? AND parent_id IS ?'
    ).get(userId, parentId).p;

    // File one bookmark into folders, creating the ones that do not exist yet.
    //
    //   targets   [{folderId} | {newFolder: {id, title, parentId}, existing?}]
    //             the folders to file into. A newFolder is created when its
    //             id is not there yet; `existing` says the client already has
    //             it (a folder made on the phone and never pushed), so an undo
    //             leaves it alone.
    //   folders   [{id, title, parentId}] created first and not filed into:
    //             the never-pushed ancestors of a newFolder target.
    //   bookmark  {title, url}
    //   skip      Map folderId -> bookmarkId of folders that already hold this
    //             link for the caller (an earlier filing of the same share).
    //
    // A retry with a folder id that is already there with the same title and
    // parent reuses it. A folder already holding this exact URL is reported
    // under `already` and gets no second copy. The version moves once, and
    // only when something was created; the change is logged as one 'append'
    // and no history snapshot is written. Returns {baseVersion, version,
    // created: [node], already: [{folderId, bookmarkId}], failed: [{folderId |
    // newFolderId, reason}], filed: [{folderId, bookmarkId, createdFolderIds}]}.
    const appendToFolders = db.transaction(({ targets = [], folders = [], bookmark, skip = new Map() }) => {
        const baseVersion = version();
        const now = new Date().toISOString();
        const created = [];
        const failed = [];
        const already = [];
        const filed = [];
        const madeHere = new Set();      // folders created or reused in this request
        const removable = new Set();     // ... of which an undo may take back
        const foreign = db.prepare('SELECT 1 FROM items WHERE id = ? AND user_id IS NOT ?');
        const own = db.prepare('SELECT id, kind, title, parent_id FROM items WHERE user_id = ? AND id = ?');

        const writableParent = (parentId) => madeHere.has(parentId) || folderTarget(parentId).ok;

        // {ok, id} or {ok:false, reason}. No parent: a top-level folder,
        // which only a folder the client made itself at the top level is.
        const ensureFolder = (spec, { undoable }) => {
            const id = spec && typeof spec.id === 'string' ? spec.id.trim() : '';
            const title = spec && typeof spec.title === 'string' ? spec.title.trim().slice(0, 200) : '';
            const parentId = spec && typeof spec.parentId === 'string' && spec.parentId ? spec.parentId : null;
            if (!CLIENT_ID_RE.test(id) || !title) return { ok: false, reason: 'invalid' };
            if (parentId !== null && !writableParent(parentId)) return { ok: false, reason: 'missing' };
            const row = own.get(userId, id);
            if (row) {
                if (row.kind === 'folder' && row.title === title && row.parent_id === parentId) {
                    madeHere.add(id);
                    return { ok: true, id };
                }
                return { ok: false, reason: 'conflict' };
            }
            if (foreign.get(id, userId)) return { ok: false, reason: 'conflict' };
            db.prepare(`
                INSERT INTO items (id, parent_id, position, kind, title, created_at, updated_at, user_id)
                VALUES (?, ?, ?, 'folder', ?, ?, ?, ?)
            `).run(id, parentId, nextPosition(parentId), title, now, now, userId);
            created.push({ id, parentId, kind: 'folder', title });
            madeHere.add(id);
            if (undoable) removable.add(id);
            return { ok: true, id };
        };

        for (const spec of folders) {
            const made = ensureFolder(spec, { undoable: false });
            if (!made.ok) failed.push({ newFolderId: spec && spec.id ? String(spec.id) : null, reason: made.reason });
        }

        const into = [];
        for (const t of targets) {
            if (t && t.newFolder) {
                const made = ensureFolder(t.newFolder, { undoable: !t.existing });
                if (made.ok) into.push(made.id);
                else failed.push({ newFolderId: t.newFolder.id ? String(t.newFolder.id) : null, reason: made.reason });
                continue;
            }
            const folderId = t && typeof t.folderId === 'string' ? t.folderId : '';
            if (madeHere.has(folderId)) { into.push(folderId); continue; }
            const check = folderTarget(folderId);
            if (check.ok) into.push(folderId);
            else failed.push({ folderId, reason: check.reason });
        }

        const url = String(bookmark.url);
        const title = String(bookmark.title || url);
        const sameUrl = db.prepare("SELECT id FROM items WHERE user_id = ? AND parent_id = ? AND kind = 'bookmark' AND url = ? LIMIT 1");
        for (const folderId of [...new Set(into)]) {
            if (skip.has(folderId)) {
                already.push({ folderId, bookmarkId: skip.get(folderId) });
                continue;
            }
            const there = sameUrl.get(userId, folderId, url);
            if (there) {
                already.push({ folderId, bookmarkId: there.id });
                continue;
            }
            const id = newId();
            db.prepare(`
                INSERT INTO items (id, parent_id, position, kind, title, url, created_at, updated_at, user_id)
                VALUES (?, ?, ?, 'bookmark', ?, ?, ?, ?, ?)
            `).run(id, folderId, nextPosition(folderId), title, url, now, now, userId);
            created.push({ id, parentId: folderId, kind: 'bookmark', title, url });
            filed.push({ folderId, bookmarkId: id, createdFolderIds: [...removable] });
        }

        const v = created.length ? bump('append', { nodes: created }) : baseVersion;
        return { baseVersion, version: v, created, already, failed, filed };
    });

    // Take back what appendToFolders added: [{id, kind:'bookmark', url} |
    // {id, kind:'folder'}], in order (bookmarks first, then folders deepest
    // first). A bookmark goes only while it is still a bookmark with that URL;
    // a folder only while it is empty. Anything changed since is kept. The
    // version moves once when something went, logged as one 'unappend'.
    // Returns {baseVersion, version, removed: [item], kept: [id], gone: [id]}.
    const removeAppended = db.transaction((list) => {
        const baseVersion = version();
        const removed = [];
        const kept = [];
        const gone = [];
        const get = db.prepare('SELECT id, kind, url FROM items WHERE user_id = ? AND id = ?');
        const kids = db.prepare('SELECT COUNT(*) AS n FROM items WHERE user_id = ? AND parent_id = ?');
        const del = db.prepare('DELETE FROM items WHERE user_id = ? AND id = ?');
        for (const it of list || []) {
            const id = String(it && it.id || '');
            const row = id ? get.get(userId, id) : null;
            if (!row) { gone.push(id); continue; }
            const same = it.kind === 'bookmark'
                ? row.kind === 'bookmark' && row.url === String(it.url)
                : row.kind === 'folder' && kids.get(userId, id).n === 0;
            if (!same) { kept.push(id); continue; }
            del.run(userId, id);
            removed.push(it.kind === 'bookmark' ? { id, kind: 'bookmark', url: row.url } : { id, kind: 'folder' });
        }
        const v = removed.length ? bump('unappend', { items: removed }) : baseVersion;
        return { baseVersion, version: v, removed, kept, gone };
    });

    // How deep a folder sits, for removing created folders children first.
    function depthOf(id) {
        const up = db.prepare('SELECT parent_id FROM items WHERE user_id = ? AND id = ?');
        let depth = 0;
        let cur = up.get(userId, id);
        while (cur && cur.parent_id && depth < 1000) {
            depth++;
            cur = up.get(userId, cur.parent_id);
        }
        return depth;
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
        recordHistory,
        initOpsFloor,
        opsSince,
        folderTarget,
        appendToFolders,
        removeAppended,
        depthOf
    };
}
