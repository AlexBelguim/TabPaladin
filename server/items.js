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
import crypto from 'node:crypto';

export const KINDS = new Set(['folder', 'bookmark', 'note']);
export const ROLES = new Set(['bookmarks', 'pins', 'notes', 'workflows']);
export const TREE_FORMAT = 2;

export function newId() {
    return crypto.randomBytes(8).toString('hex');
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

        CREATE TABLE IF NOT EXISTS tree_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
    `);

    const getMeta = (key) => {
        const row = db.prepare('SELECT value FROM tree_meta WHERE key = ?').get(key);
        return row ? row.value : null;
    };
    const setMeta = (key, value) => {
        db.prepare('INSERT INTO tree_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
            .run(key, String(value));
    };

    function version() {
        return Number(getMeta('treeVersion') || 0);
    }

    // Every tree change funnels through here so history and the version counter
    // can never drift apart. History rows reuse the old snapshots table; new
    // entries are tagged with format 2 so a client browsing history can tell
    // them from pre-migration browser-tree blobs.
    function recordHistory(roots, deviceId) {
        const ts = new Date().toISOString();
        db.prepare('INSERT INTO snapshots (timestamp, device_id, json) VALUES (?, ?, ?)')
            .run(ts, deviceId || null, JSON.stringify({ format: TREE_FORMAT, roots }));
        db.prepare(`
            DELETE FROM snapshots WHERE id NOT IN (
                SELECT id FROM snapshots ORDER BY timestamp DESC LIMIT ?
            )
        `).run(maxSnapshots);
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
        return (Array.isArray(roots) ? roots : []).map(clean).filter(Boolean);
    }

    // --- Tree <-> rows ------------------------------------------------------

    function readTree() {
        const rows = db.prepare('SELECT * FROM items ORDER BY parent_id, position, id').all();
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

    const writeTx = db.transaction((roots, deviceId) => {
        db.prepare('DELETE FROM items').run();
        const now = new Date().toISOString();
        const insert = db.prepare(`
            INSERT INTO items (id, parent_id, position, kind, role, title, url, payload, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const walk = (node, parentId, position) => {
            insert.run(
                node.id, parentId, position, node.kind, node.role || null,
                node.title, node.url || null,
                node.payload ? JSON.stringify(node.payload) : null,
                now, now
            );
            if (node.kind === 'folder') {
                (node.children || []).forEach((c, i) => walk(c, node.id, i));
            }
        };
        roots.forEach((r, i) => walk(r, null, i));
        setMeta('treeVersion', version() + 1);
        recordHistory(roots, deviceId);
    });

    // Replace the tree. Returns the new version.
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
        return db.prepare("SELECT * FROM items WHERE kind = 'folder' AND role = ? ORDER BY created_at LIMIT 1").get(role)
            || null;
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
        const kids = db.prepare('SELECT id FROM items WHERE parent_id = ?').all(id);
        return kids.reduce((n, k) => n + 1 + descendantCount(k.id), 0);
    }

    const ensureBookmarksRoot = db.transaction(() => {
        const existing = findRoleRow('bookmarks');
        if (existing) return { id: existing.id, created: false };

        const tops = db.prepare("SELECT * FROM items WHERE parent_id IS NULL AND kind = 'folder'").all();
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
            const max = db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM items WHERE parent_id IS NULL').get().p;
            db.prepare(`
                INSERT INTO items (id, parent_id, position, kind, role, title, created_at, updated_at)
                VALUES (?, NULL, ?, 'folder', 'bookmarks', 'Bookmarks', ?, ?)
            `).run(id, max + 1, now, now);
            setMeta('treeVersion', version() + 1);
            return { id, created: true };
        }

        db.prepare("UPDATE items SET role = 'bookmarks', title = 'Bookmarks', updated_at = ? WHERE id = ?")
            .run(now, chosen.id);

        // Any other ordinary top-level folder becomes a child of it, so the top
        // level is the app's own sections rather than a browser's leftovers.
        // Noise roots are left where they are: they are hidden, not owned.
        let moved = 0;
        const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM items WHERE parent_id = ?').get(chosen.id).p;
        let pos = maxPos + 1;
        for (const c of candidates) {
            if (c.id === chosen.id) continue;
            db.prepare('UPDATE items SET parent_id = ?, position = ?, updated_at = ? WHERE id = ?')
                .run(chosen.id, pos++, now, c.id);
            moved++;
        }
        setMeta('treeVersion', version() + 1);
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
        const rows = db.prepare("SELECT * FROM items WHERE kind = 'note' ORDER BY position, id").all();
        const folders = new Map(
            db.prepare("SELECT id, parent_id, title FROM items WHERE kind = 'folder'").all().map(r => [r.id, r])
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
        const max = db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM items WHERE parent_id IS NULL').get().p;
        db.prepare(`
            INSERT INTO items (id, parent_id, position, kind, role, title, created_at, updated_at)
            VALUES (?, NULL, ?, 'folder', 'notes', 'Notes', ?, ?)
        `).run(id, max + 1, now, now);
        return id;
    }

    function insertFolder(parentId, title) {
        const now = new Date().toISOString();
        const id = newId();
        const max = db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM items WHERE parent_id = ?').get(parentId).p;
        db.prepare(`
            INSERT INTO items (id, parent_id, position, kind, title, created_at, updated_at)
            VALUES (?, ?, ?, 'folder', ?, ?, ?)
        `).run(id, parentId, max + 1, title, now, now);
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
        for (const r of db.prepare("SELECT id, parent_id, title FROM items WHERE kind = 'folder' ORDER BY position, id").all()) {
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
    // title"), so it searches every note, not just the requested notebook —
    // but when two notes share the title, the one already in the requested
    // notebook wins over a same-named note elsewhere.
    const upsertNote = db.transaction((title, content, notebook) => {
        const now = new Date().toISOString();
        const rootId = ensureNotesRoot();
        const targetId = notebook ? ensureNotebook(rootId, notebook) : rootId;

        const existing = db.prepare(`
            SELECT * FROM items WHERE kind = 'note' AND title = ?
            ORDER BY (parent_id = ?) DESC, position, id LIMIT 1
        `).get(title, targetId);
        if (existing) {
            // Merge into the stored payload: fields a client added (pinned,
            // say) are not the proposal's to drop.
            const old = noteFromRow(existing);
            let raw = {};
            try { raw = JSON.parse(existing.payload || '{}'); } catch (e) { /* corrupt */ }
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
            db.prepare('UPDATE items SET payload = ?, updated_at = ? WHERE id = ?').run(
                JSON.stringify({ ...raw, content, createdAt: old.createdAt || now, updatedAt: now }), now, existing.id
            );
        } else {
            const max = db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM items WHERE parent_id = ?').get(targetId).p;
            db.prepare(`
                INSERT INTO items (id, parent_id, position, kind, title, payload, created_at, updated_at)
                VALUES (?, ?, ?, 'note', ?, ?, ?, ?)
            `).run(newId(), targetId, max + 1, title,
                JSON.stringify({ content, createdAt: now, updatedAt: now }), now, now);
        }
        setMeta('treeVersion', version() + 1);
    });

    // Reorder notes to match a list of titles, per parent folder; notes not in
    // the list keep their relative order after the listed ones.
    const reorderNotes = db.transaction((order) => {
        const rank = new Map(order.map((t, i) => [t, i]));
        const parents = db.prepare("SELECT DISTINCT parent_id FROM items WHERE kind = 'note'").all();
        for (const { parent_id } of parents) {
            const kids = db.prepare('SELECT id, kind, title FROM items WHERE parent_id IS ? ORDER BY position, id').all(parent_id);
            const notes = kids.filter(k => k.kind === 'note');
            const sorted = notes.slice().sort((a, b) => {
                const ra = rank.has(a.title) ? rank.get(a.title) : Infinity;
                const rb = rank.has(b.title) ? rank.get(b.title) : Infinity;
                return ra - rb;
            });
            let ni = 0;
            const stmt = db.prepare('UPDATE items SET position = ? WHERE id = ?');
            kids.forEach((k, i) => {
                stmt.run(i, k.kind === 'note' ? sorted[ni++].id : k.id);
            });
        }
        setMeta('treeVersion', version() + 1);
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
    // Runs once, on the first boot after the upgrade, when the items table is
    // empty but the snapshots table is not. Converts the newest browser-tree
    // blob:
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
        const already = db.prepare('SELECT COUNT(*) AS n FROM items').get().n;
        if (already > 0) return { migrated: false, reason: 'items table not empty' };
        const row = db.prepare('SELECT json, timestamp FROM snapshots ORDER BY timestamp DESC LIMIT 1').get();
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
        recordHistory
    };
}
