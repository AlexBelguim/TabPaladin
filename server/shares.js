// Shared links: each account's inbox of links shared to the app, and where
// they were filed.
//
// A share arrives from the phone's share sheet (or a pasted or clipboard
// link) with a client id, `sid`, made on the phone before anything touched the
// network. Taking it in is idempotent on (account, sid): a retry after a lost
// response, or the service worker and the page both uploading the same share,
// lands one row. X and Instagram shares are archived on arrival, exactly as
// POST /api/imports/capture always did, and wait in the archive (status
// 'archived'); everything else waits in the inbox ('pending').
//
// Filing is a small append on the server (items.appendToFolders): a bookmark
// at the end of each chosen folder, new folders created on the way, one
// version bump, logged in tree_ops so the other devices fold it into their
// working copies instead of meeting a conflict. It never carries the phone's
// other unpushed edits. share_filings remembers each filing — the guard that
// makes a retried filing a no-op, the per-app statistics the share sheet
// suggests folders from, and what an undo or a forced push works from.
//
// Nothing in shared_links is hard-deleted: Later, ✕ and the legacy DELETE
// routes only change its status, so every share can come back.
//
// Every statement names user_id (tools/test_tenancy.mjs scans for it), and
// every folder id is resolved in the caller's own tree.
//
// Top-level on purpose: the Dockerfile copies server/*.js and server/imports
// only, and a module in a new subdirectory would crash-loop the container.

import { classify } from './imports/manual.js';
import { captureLink } from './imports/routes.js';
import { ensureOwnerGuards } from './tenancy.js';

export const STATUSES = ['pending', 'filed', 'archived', 'dismissed'];
const SID_RE = /^[A-Za-z0-9_-]{16,64}$/;
// A share without a client id (taken in by the legacy POST /api/shared) is
// addressed by its row id as 'id-<n>': too short to be a sid, so the two
// can never be confused.
const ROW_REF_RE = /^id-(\d{1,12})$/;
const APP_RE = /^[a-z0-9:._-]{1,80}$/;
const SOURCES = new Set(['share', 'clipboard', 'paste', 'legacy']);
export const MAX_URL = 4096;
export const MAX_TITLE = 1000;
export const MAX_RAW = 10 * 1024;
const MAX_TARGETS = 16;
const STATS_DAYS = 365;

const COLUMNS = [
    ['sid', 'TEXT'],
    ['url_key', 'TEXT'],
    ['app', 'TEXT'],
    ['source', 'TEXT'],
    ['raw', 'TEXT'],
    ['status', "TEXT NOT NULL DEFAULT 'pending'"],
    ['note', 'TEXT'],
    ['updated_at', 'TEXT'],
    ['filed_at', 'TEXT']
];

// --- Schema ------------------------------------------------------------------
//
// Additive and idempotent, one transaction, after the ownership migration (so
// shared_links already names its accounts) and after the boot backup. Every
// column is added only when PRAGMA table_info says it is missing; existing rows
// keep every value they had and read as the pending shares they are — exactly
// the inbox they were.
export function migrateShares(db) {
    return db.transaction(() => {
        const have = db.prepare('PRAGMA table_info(shared_links)').all().map(c => c.name);
        if (!have.length) throw new Error('shared_links is missing');
        if (!have.includes('user_id')) throw new Error('shared_links has no user_id yet: the ownership migration has to run first');
        const added = [];
        for (const [name, type] of COLUMNS) {
            if (have.includes(name)) continue;
            db.exec(`ALTER TABLE shared_links ADD COLUMN ${name} ${type}`);
            added.push(name);
        }
        db.exec(`
            CREATE TABLE IF NOT EXISTS share_filings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                share_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                app TEXT,
                folder_id TEXT NOT NULL,
                bookmark_id TEXT NOT NULL,
                url TEXT NOT NULL,
                folder_created INTEGER NOT NULL DEFAULT 0,
                created_ids TEXT,
                tree_version INTEGER NOT NULL,
                filed_at TEXT NOT NULL,
                UNIQUE (share_id, folder_id)
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_shared_user_sid ON shared_links(user_id, sid) WHERE sid IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_shared_user_status ON shared_links(user_id, status, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_share_filings_user_app ON share_filings(user_id, app, filed_at DESC);
            CREATE INDEX IF NOT EXISTS idx_share_filings_user_share ON share_filings(user_id, share_id);
        `);
        ensureOwnerGuards(db, ['share_filings']);
        return { added };
    })();
}

// --- Validation -----------------------------------------------------------------

// The URL as given, when it is an http(s) link of a sane length; else null.
// javascript:, data: and the rest are refused: the PWA renders these as links.
export function httpUrl(value) {
    if (typeof value !== 'string') return null;
    const s = value.trim();
    if (!s || s.length > MAX_URL) return null;
    try {
        const u = new URL(s);
        return u.protocol === 'http:' || u.protocol === 'https:' ? s : null;
    } catch (e) {
        return null;
    }
}

// The app a link counts towards when the client did not say: its host. The
// clients group hosts into apps (X, YouTube, …) with the same fallback. A
// www., m. or mobile. that is the site's own name (mobile.de, m.me) stays.
function appFallback(url) {
    try {
        const full = new URL(url).hostname.toLowerCase();
        const stripped = full.replace(/^(www|m|mobile)\./, '');
        const host = stripped.includes('.') ? stripped : full;
        const app = 'site:' + host;
        return APP_RE.test(app) ? app : 'site:unknown';
    } catch (e) {
        return 'site:unknown';
    }
}

class BadRequest extends Error {
    constructor(message) { super(message); this.status = 400; }
}

// `raw` is only context (what the phone's share target received), never a
// reason to refuse the link it came with: past MAX_RAW its text is cut, then
// its title, and what still does not fit is dropped.
function fitRaw(value) {
    if (value == null) return null;
    const size = (v) => Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v), 'utf8');
    if (size(value) <= MAX_RAW) return typeof value === 'string' ? value : JSON.stringify(value);
    if (typeof value !== 'object' || Array.isArray(value)) return null;
    const o = { ...value };
    for (const key of ['text', 'title']) {
        if (typeof o[key] !== 'string') continue;
        // The most of it that fits, by code points, never half a character.
        const chars = Array.from(o[key]);
        let lo = 0;
        let hi = chars.length;
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (size({ ...o, [key]: chars.slice(0, mid).join('') }) <= MAX_RAW) lo = mid;
            else hi = mid - 1;
        }
        o[key] = chars.slice(0, lo).join('');
        if (size(o) <= MAX_RAW) return JSON.stringify(o);
    }
    return null;
}

function parseIntake(body, { legacy = false } = {}) {
    const b = body && typeof body === 'object' ? body : {};
    const url = httpUrl(b.url);
    if (!url) throw new BadRequest(typeof b.url === 'string' && b.url.length > MAX_URL
        ? `url: at most ${MAX_URL} characters.` : 'url: an http(s) link is required.');
    let title = b.title == null ? '' : b.title;
    if (typeof title !== 'string') throw new BadRequest('title: a string.');
    if (title.length > MAX_TITLE) {
        // An old client never knew the limit: cut, rather than lose its link.
        if (!legacy) throw new BadRequest(`title: at most ${MAX_TITLE} characters.`);
        title = title.slice(0, MAX_TITLE);
    }
    if (legacy) return { sid: null, url, title: title || null, app: appFallback(url), urlKey: url, source: 'legacy', raw: null };

    if (typeof b.sid !== 'string' || !SID_RE.test(b.sid)) throw new BadRequest('sid: 16-64 letters, digits, - or _.');
    if (b.app != null && (typeof b.app !== 'string' || !APP_RE.test(b.app))) throw new BadRequest('app: 1-80 of a-z, 0-9 and :._-');
    if (b.urlKey != null && (typeof b.urlKey !== 'string' || b.urlKey.length > MAX_URL)) throw new BadRequest(`urlKey: at most ${MAX_URL} characters.`);
    if (b.source != null && !SOURCES.has(b.source)) throw new BadRequest(`source: one of ${[...SOURCES].join(', ')}.`);
    const raw = fitRaw(b.raw);
    return {
        sid: b.sid, url, title: title || null, app: b.app || appFallback(url), urlKey: b.urlKey || url,
        source: b.source || 'share', raw
    };
}

function parseFolderSpec(f) {
    return f && typeof f === 'object'
        ? { id: String(f.id || ''), title: String(f.title || ''), parentId: String(f.parentId || '') }
        : null;
}

function parseFiling(body) {
    const b = body && typeof body === 'object' ? body : {};
    if (!Array.isArray(b.targets) || b.targets.length === 0 || b.targets.length > MAX_TARGETS) {
        throw new BadRequest(`targets: 1-${MAX_TARGETS} folders.`);
    }
    const targets = b.targets.map((t) => {
        if (t && typeof t.folderId === 'string' && t.folderId && t.folderId.length <= 64) return { folderId: t.folderId };
        if (t && t.newFolder && typeof t.newFolder === 'object') return { newFolder: parseFolderSpec(t.newFolder), existing: Boolean(t.existing) };
        throw new BadRequest('targets: each one is {folderId} or {newFolder: {id, title, parentId}}.');
    });
    const folders = Array.isArray(b.folders) ? b.folders.slice(0, MAX_TARGETS).map(parseFolderSpec).filter(Boolean) : [];
    let url = null;
    if (b.url != null) {
        url = httpUrl(b.url);
        if (!url) throw new BadRequest('url: an http(s) link of at most 4096 characters.');
    }
    if (b.title != null && (typeof b.title !== 'string' || b.title.length > MAX_TITLE)) throw new BadRequest(`title: at most ${MAX_TITLE} characters.`);
    if (b.app != null && (typeof b.app !== 'string' || !APP_RE.test(b.app))) throw new BadRequest('app: 1-80 of a-z, 0-9 and :._-');
    return { targets, folders, url, title: b.title ? b.title.trim() : null, app: b.app || null };
}

// Every target failed: nothing is kept, not even a folder made on the way.
class NothingFiled extends Error {
    constructor(failed) { super('Nothing was filed.'); this.failed = failed; }
}

// --- The store ----------------------------------------------------------------------

export function makeSharesStore(db, { items, importsStore = null, maxPending = 5000 } = {}) {
    function forUser(uid) {
        const userId = Number(uid);
        const tree = items.forUser(userId); // throws for an account that does not exist
        const now = () => new Date().toISOString();

        const byRef = (ref) => {
            const s = String(ref || '');
            const m = s.match(ROW_REF_RE);
            if (m) return db.prepare('SELECT * FROM shared_links WHERE user_id = ? AND id = ?').get(userId, Number(m[1])) || null;
            if (!SID_RE.test(s)) return null;
            return db.prepare('SELECT * FROM shared_links WHERE user_id = ? AND sid = ?').get(userId, s) || null;
        };

        const filingsOf = (shareIds) => {
            const out = new Map(shareIds.map(id => [id, []]));
            for (let i = 0; i < shareIds.length; i += 400) {
                const chunk = shareIds.slice(i, i + 400);
                const rows = db.prepare(`
                    SELECT f.*,
                        (SELECT COUNT(*) FROM items i WHERE i.user_id = f.user_id AND i.id = f.bookmark_id AND i.kind = 'bookmark') AS present,
                        (SELECT title FROM items i WHERE i.user_id = f.user_id AND i.id = f.folder_id) AS folder_title
                    FROM share_filings f
                    WHERE f.user_id = ? AND f.share_id IN (${chunk.map(() => '?').join(',')})
                    ORDER BY f.filed_at, f.id
                `).all(userId, ...chunk);
                for (const r of rows) out.get(r.share_id).push(r);
            }
            return out;
        };

        const shape = (r, filings = []) => {
            let raw = null;
            try { raw = r.raw ? JSON.parse(r.raw) : null; } catch (e) { raw = null; }
            return {
                id: r.id,
                sid: r.sid || `id-${r.id}`,
                url: r.url,
                title: r.title || '',
                text: raw && typeof raw.text === 'string' ? raw.text : '',
                app: r.app || appFallback(r.url),
                urlKey: r.url_key || r.url,
                source: r.source || 'legacy',
                status: r.status || 'pending',
                note: r.note || null,
                createdAt: r.created_at,
                updatedAt: r.updated_at || r.created_at,
                filedAt: r.filed_at || null,
                filings: filings.map(f => ({
                    folderId: f.folder_id,
                    folderTitle: f.folder_title ?? null,
                    bookmarkId: f.bookmark_id,
                    filedAt: f.filed_at,
                    present: Boolean(f.present)
                }))
            };
        };

        const shapeOne = (row) => (row ? shape(row, filingsOf([row.id]).get(row.id)) : null);

        const pendingCount = () => db.prepare("SELECT COUNT(*) AS n FROM shared_links WHERE user_id = ? AND status = 'pending'").get(userId).n;

        // This account's archive row for an X or Instagram link, or null.
        const archiveItem = (url) => {
            const hit = classify(url);
            if (!hit || !importsStore) return null;
            const source = importsStore.listSources(userId).find(s => s.provider === hit.provider);
            return source ? importsStore.itemByExternal(source.id, hit.externalId) : null;
        };
        const restingStatus = (url) => (classify(url) ? 'archived' : 'pending');

        const insertRow = (p, status) => {
            const ts = now();
            const info = db.prepare(`
                INSERT INTO shared_links (url, title, created_at, user_id, sid, url_key, app, source, raw, status, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(p.url, p.title, ts, userId, p.sid, p.urlKey, p.app, p.source, p.raw, status, ts);
            return db.prepare('SELECT * FROM shared_links WHERE user_id = ? AND id = ?').get(userId, info.lastInsertRowid);
        };

        return {
            // Take a share in. Idempotent on sid: a repeat returns the row
            // already there (created:false), whatever has happened to it since.
            intake(body) {
                const p = parseIntake(body);
                return db.transaction(() => {
                    const existing = byRef(p.sid);
                    if (existing) return { created: false, share: shapeOne(existing), archived: null };
                    const hit = classify(p.url);
                    if (hit && importsStore) {
                        const cap = captureLink(importsStore, userId, { url: p.url, title: p.title || '' });
                        const row = insertRow(p, 'archived');
                        return { created: true, share: shapeOne(row), archived: { provider: hit.provider, duplicate: Boolean(cap.result.duplicate) } };
                    }
                    const held = pendingCount();
                    if (held >= maxPending) {
                        const e = new Error(`Your inbox already holds ${held} links, the most it keeps. File or clear some first.`);
                        e.status = 429;
                        throw e;
                    }
                    return { created: true, share: shapeOne(insertRow(p, 'pending')), archived: null };
                })();
            },

            get(ref) {
                return shapeOne(byRef(ref));
            },

            // status: one of STATUSES (default pending). Newest first; filed
            // ones by when they were filed. `before` pages by row id.
            list({ status = 'pending', limit = 50, before = null } = {}) {
                const st = STATUSES.includes(status) ? status : 'pending';
                const n = Math.min(100, Math.max(1, Number(limit) || 50));
                const rows = st === 'filed'
                    ? db.prepare(`SELECT * FROM shared_links WHERE user_id = ? AND status = 'filed'
                                  ORDER BY COALESCE(filed_at, created_at) DESC, id DESC LIMIT ?`).all(userId, n)
                    : db.prepare(`SELECT * FROM shared_links WHERE user_id = ? AND status = ? AND (? IS NULL OR id < ?)
                                  ORDER BY id DESC LIMIT ?`).all(userId, st, before == null ? null : Number(before), before == null ? null : Number(before), n);
                const filings = filingsOf(rows.map(r => r.id));
                return rows.map(r => shape(r, filings.get(r.id)));
            },

            // File a share into folders. One transaction: the append, the
            // filings, the share's status, its twins (other pending shares of
            // the same link) and its archive row. 404 for no such share, 422
            // (NothingFiled) when every target failed — then nothing changed.
            file(ref, body) {
                const p = parseFiling(body);
                try {
                    return db.transaction(() => {
                        const share = byRef(ref);
                        if (!share) return null;
                        const prior = new Map(db.prepare('SELECT folder_id, bookmark_id FROM share_filings WHERE user_id = ? AND share_id = ?')
                            .all(userId, share.id).map(f => [f.folder_id, f.bookmark_id]));
                        const url = p.url || share.url;
                        const title = (p.title || share.title || url).slice(0, MAX_TITLE);
                        const res = tree.appendToFolders({ targets: p.targets, folders: p.folders, bookmark: { title, url }, skip: prior });
                        if (!res.filed.length && !res.already.length) throw new NothingFiled(res.failed);
                        const ts = now();
                        const app = share.app || p.app || appFallback(url);
                        const insert = db.prepare(`
                            INSERT INTO share_filings (share_id, user_id, app, folder_id, bookmark_id, url, folder_created, created_ids, tree_version, filed_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        `);
                        for (const f of res.filed) {
                            insert.run(share.id, userId, app, f.folderId, f.bookmarkId, url,
                                f.createdFolderIds.includes(f.folderId) ? 1 : 0, JSON.stringify(f.createdFolderIds), res.version, ts);
                        }
                        db.prepare(`
                            UPDATE shared_links SET status = 'filed', filed_at = ?, updated_at = ?, note = NULL, url = ?, title = ?, app = ?
                            WHERE user_id = ? AND id = ?
                        `).run(ts, ts, url, title, app, userId, share.id);
                        // The same link shared again and still waiting: it is filed now too.
                        db.prepare(`
                            UPDATE shared_links SET status = 'filed', filed_at = ?, updated_at = ?, note = ?
                            WHERE user_id = ? AND status = 'pending' AND id <> ?
                              AND (url_key = ? OR (url_key IS NULL AND url = ?) OR url = ?)
                        `).run(ts, ts, `filed with ${share.sid || `id-${share.id}`}`, userId, share.id, share.url_key || share.url, share.url, url);
                        const item = archiveItem(url) || archiveItem(share.url);
                        if (item && importsStore) importsStore.markFiled([item.id]);
                        return {
                            baseVersion: res.baseVersion, version: res.version, share: shapeOne(byRef(ref)),
                            created: res.created, already: res.already, failed: res.failed
                        };
                    })();
                } catch (e) {
                    if (e instanceof NothingFiled) return { refused: true, failed: e.failed };
                    throw e;
                }
            },

            // Take a filing back: the bookmarks this share made (only while
            // unchanged) and the folders it made for them (only while empty).
            // folderIds limits it to those folders; without, every filing goes.
            // With none left the share waits again, as it did on arrival.
            unfile(ref, { folderIds = null } = {}) {
                return db.transaction(() => {
                    const share = byRef(ref);
                    if (!share) return null;
                    let filings = db.prepare('SELECT * FROM share_filings WHERE user_id = ? AND share_id = ?').all(userId, share.id);
                    if (Array.isArray(folderIds)) {
                        const want = new Set(folderIds.map(String));
                        filings = filings.filter(f => want.has(f.folder_id));
                    }
                    const baseVersion = tree.version();
                    if (!filings.length) return { baseVersion, version: baseVersion, share: shapeOne(share), removed: [], kept: [] };
                    const created = new Set();
                    for (const f of filings) {
                        try { for (const id of JSON.parse(f.created_ids || '[]')) created.add(String(id)); } catch (e) { /* none */ }
                    }
                    const folders = [...created].map(id => ({ id, depth: tree.depthOf(id) }))
                        .sort((a, b) => b.depth - a.depth).map(({ id }) => ({ id, kind: 'folder' }));
                    const res = tree.removeAppended([
                        ...filings.map(f => ({ id: f.bookmark_id, kind: 'bookmark', url: f.url })),
                        ...folders
                    ]);
                    const del = db.prepare('DELETE FROM share_filings WHERE user_id = ? AND id = ?');
                    for (const f of filings) del.run(userId, f.id);
                    const left = db.prepare('SELECT COUNT(*) AS n FROM share_filings WHERE user_id = ? AND share_id = ?').get(userId, share.id).n;
                    if (!left) {
                        const ts = now();
                        db.prepare('UPDATE shared_links SET status = ?, filed_at = NULL, updated_at = ?, note = NULL WHERE user_id = ? AND id = ?')
                            .run(restingStatus(share.url), ts, userId, share.id);
                        // Its twins were filed along with it; they wait again too.
                        db.prepare("UPDATE shared_links SET status = 'pending', filed_at = NULL, updated_at = ?, note = NULL WHERE user_id = ? AND status = 'filed' AND note = ?")
                            .run(ts, userId, `filed with ${share.sid || `id-${share.id}`}`);
                        const item = archiveItem(share.url);
                        if (item && importsStore) importsStore.unmarkFiled([item.id]);
                    }
                    return {
                        baseVersion: res.baseVersion, version: res.version, share: shapeOne(byRef(ref)),
                        removed: res.removed, kept: res.kept
                    };
                })();
            },

            // Later / ✕: out of the inbox (or the archive's waiting list), never
            // deleted. A filed share stays filed.
            dismiss(ref) {
                const share = byRef(ref);
                if (!share) return null;
                db.prepare("UPDATE shared_links SET status = 'dismissed', updated_at = ? WHERE user_id = ? AND id = ? AND status IN ('pending', 'archived')")
                    .run(now(), userId, share.id);
                return shapeOne(byRef(ref));
            },

            restore(ref) {
                const share = byRef(ref);
                if (!share) return null;
                db.prepare("UPDATE shared_links SET status = ?, updated_at = ? WHERE user_id = ? AND id = ? AND status = 'dismissed'")
                    .run(restingStatus(share.url), now(), userId, share.id);
                return shapeOne(byRef(ref));
            },

            // Where links from each app were filed over the last year:
            // {app: [{folderId, n, last}]}, most used first.
            stats({ days = STATS_DAYS } = {}) {
                const since = new Date(Date.now() - days * 86400000).toISOString();
                const apps = {};
                for (const r of db.prepare(`
                    SELECT app, folder_id, COUNT(*) AS n, MAX(filed_at) AS last FROM share_filings
                    WHERE user_id = ? AND filed_at >= ? GROUP BY app, folder_id ORDER BY n DESC, last DESC
                `).all(userId, since)) {
                    const app = r.app || 'site:unknown';
                    (apps[app] = apps[app] || []).push({ folderId: r.folder_id, n: r.n, last: r.last });
                }
                return apps;
            },

            // Before a forced push from an older base, in its transaction: the
            // filings made since that base whose bookmark is in the tree now —
            // the only ones the push can erase. One whose bookmark is already
            // gone was deleted by a device that saw it, and stays as it is.
            filingsAtRisk({ baseVersion = 0 } = {}) {
                return db.prepare(`
                    SELECT f.id FROM share_filings f
                    WHERE f.user_id = ? AND f.tree_version > ?
                      AND EXISTS (SELECT 1 FROM items i WHERE i.user_id = f.user_id AND i.id = f.bookmark_id)
                `).all(userId, Number(baseVersion) || 0).map(r => r.id);
            },

            // After that push, in the same transaction: of those filings, the
            // ones whose bookmark is gone now were erased by it, not deleted by
            // anyone who saw them. They go, and a share left with none waits in
            // the inbox again, saying why. Filings the pusher had seen, and
            // bookmarks deleted on purpose before it, are left alone.
            reopenAfterForce({ filingIds = [], deviceId = null } = {}) {
                const erased = db.prepare(`
                    SELECT f.id, f.share_id FROM share_filings f
                    WHERE f.user_id = ? AND f.id = ?
                      AND NOT EXISTS (SELECT 1 FROM items i WHERE i.user_id = f.user_id AND i.id = f.bookmark_id)
                `);
                const rows = (filingIds || []).map(id => erased.get(userId, Number(id))).filter(Boolean);
                if (!rows.length) return { reopened: 0, dropped: 0 };
                const del = db.prepare('DELETE FROM share_filings WHERE user_id = ? AND id = ?');
                for (const r of rows) del.run(userId, r.id);
                const who = String(deviceId || 'another device').replace(/[^\w .:@-]/g, '').slice(0, 64) || 'another device';
                const ts = now();
                let reopened = 0;
                for (const shareId of new Set(rows.map(r => r.share_id))) {
                    const left = db.prepare('SELECT COUNT(*) AS n FROM share_filings WHERE user_id = ? AND share_id = ?').get(userId, shareId).n;
                    if (left) continue;
                    const share = db.prepare('SELECT * FROM shared_links WHERE user_id = ? AND id = ?').get(userId, shareId);
                    if (!share) continue;
                    db.prepare("UPDATE shared_links SET status = 'pending', filed_at = NULL, updated_at = ?, note = ? WHERE user_id = ? AND id = ?")
                        .run(ts, `Removed by a forced push from ${who}`, userId, shareId);
                    const item = archiveItem(share.url);
                    if (item && importsStore) importsStore.unmarkFiled([item.id]);
                    reopened++;
                }
                return { reopened, dropped: rows.length };
            },

            // --- The legacy routes' views of the same rows ---

            legacyList() {
                return db.prepare(`SELECT id, url, title, created_at FROM shared_links WHERE user_id = ? AND status = 'pending'
                                   ORDER BY created_at DESC, id ASC`).all(userId);
            },

            legacyIntake(body) {
                const p = parseIntake(body, { legacy: true });
                return db.transaction(() => {
                    const held = pendingCount();
                    if (held >= maxPending) {
                        const e = new Error(`Your inbox already holds ${held} links, the most it keeps. File or clear some first.`);
                        e.status = 429;
                        throw e;
                    }
                    return insertRow(p, 'pending');
                })();
            },

            legacyDismiss(id) {
                return db.prepare("UPDATE shared_links SET status = 'dismissed', updated_at = ? WHERE user_id = ? AND id = ? AND status = 'pending'")
                    .run(now(), userId, Number(id)).changes;
            },

            legacyDismissAll() {
                return db.prepare("UPDATE shared_links SET status = 'dismissed', updated_at = ? WHERE user_id = ? AND status = 'pending'")
                    .run(now(), userId).changes;
            }
        };
    }

    return { forUser };
}

// --- Routes -------------------------------------------------------------------------

export function attachShareRoutes(app, { store, items, requireAuth, serverId = null }) {
    const fail = (res, e) => {
        if (e && (e.status === 400 || e.status === 429)) return res.status(e.status).json({ error: e.message });
        console.error('[TabPaladin] Share request failed:', e);
        return res.status(500).json({ error: 'The share could not be saved.' });
    };
    const mine = (req) => store.forUser(req.user.id);
    // The account (and server) the client means, when it says: a share kept
    // on a phone for one account is never taken in, filed or changed under
    // another — a page still holding an older session's token, say. 412, as
    // PUT /api/tree answers a copy of another account's; the client leaves
    // the share as it was.
    const refusedAccount = (req, res) => {
        const b = req.body || {};
        const otherUser = b.expectUserId !== undefined && b.expectUserId !== null && Number(b.expectUserId) !== req.user.id;
        const otherServer = b.expectServerId !== undefined && b.expectServerId !== null && serverId && String(b.expectServerId) !== serverId;
        if (!otherUser && !otherServer) return false;
        res.status(412).json({ error: 'This share belongs to another account.', code: 'wrong-account', userId: req.user.id, serverId });
        return true;
    };

    app.post('/api/shares', requireAuth, (req, res) => {
        if (refusedAccount(req, res)) return;
        try {
            const out = mine(req).intake(req.body);
            res.json({ ok: true, created: out.created, share: out.share, archived: out.archived });
        } catch (e) { fail(res, e); }
    });

    app.get('/api/shares', requireAuth, (req, res) => {
        const status = req.query.status === undefined ? 'pending' : String(req.query.status);
        if (!STATUSES.includes(status)) return res.status(400).json({ error: `status: one of ${STATUSES.join(', ')}.` });
        try {
            res.json({ ok: true, shares: mine(req).list({ status, limit: req.query.limit, before: req.query.before ?? null }) });
        } catch (e) { fail(res, e); }
    });

    app.get('/api/shares/stats', requireAuth, (req, res) => {
        try { res.json({ ok: true, apps: mine(req).stats() }); } catch (e) { fail(res, e); }
    });

    app.get('/api/shares/:sid', requireAuth, (req, res) => {
        const share = mine(req).get(req.params.sid);
        if (!share) return res.status(404).json({ error: 'No such share.' });
        res.json({ ok: true, share });
    });

    // A filing and its undo say whose tree they changed, as /api/tree/ops
    // does: a client folds them only into that account's copy.
    app.post('/api/shares/:sid/file', requireAuth, (req, res) => {
        if (refusedAccount(req, res)) return;
        try {
            const out = mine(req).file(req.params.sid, req.body);
            if (!out) return res.status(404).json({ error: 'No such share.' });
            if (out.refused) return res.status(422).json({ error: 'None of those folders can take it.', failed: out.failed });
            res.json({ ok: true, ...out, userId: req.user.id, serverId });
        } catch (e) { fail(res, e); }
    });

    app.post('/api/shares/:sid/unfile', requireAuth, (req, res) => {
        if (refusedAccount(req, res)) return;
        const folderIds = (req.body || {}).folderIds;
        if (folderIds !== undefined && (!Array.isArray(folderIds) || folderIds.length > 64)) {
            return res.status(400).json({ error: 'folderIds: an array of folder ids.' });
        }
        try {
            const out = mine(req).unfile(req.params.sid, { folderIds: folderIds || null });
            if (!out) return res.status(404).json({ error: 'No such share.' });
            res.json({ ok: true, ...out, userId: req.user.id, serverId });
        } catch (e) { fail(res, e); }
    });

    for (const verb of ['dismiss', 'restore']) {
        app.post(`/api/shares/:sid/${verb}`, requireAuth, (req, res) => {
            if (refusedAccount(req, res)) return;
            const share = mine(req)[verb](req.params.sid);
            if (!share) return res.status(404).json({ error: 'No such share.' });
            res.json({ ok: true, share });
        });
    }

    // What a working copy based on `since` missed, when that was only links
    // filed (and taken back) from the share sheet. See items.opsSince.
    app.get('/api/tree/ops', requireAuth, (req, res) => {
        const out = items.forUser(req.user.id).opsSince(Number(req.query.since));
        res.json({ ok: true, ...out, userId: req.user.id, serverId });
    });

    // --- Legacy routes, for cached service workers and PWAs from before ---
    // The same rows: GET lists the pending ones in the old shape, POST takes
    // one in without a sid, and the DELETEs only dismiss.

    app.get('/api/shared', requireAuth, (req, res) => {
        res.json({ ok: true, links: mine(req).legacyList() });
    });

    app.post('/api/shared', requireAuth, (req, res) => {
        const { url } = req.body || {};
        if (!url || typeof url !== 'string') return res.status(400).json({ error: 'Missing url' });
        try {
            const row = mine(req).legacyIntake(req.body);
            res.json({ ok: true, id: row.id, createdAt: row.created_at });
        } catch (e) { fail(res, e); }
    });

    app.delete('/api/shared/:id', requireAuth, (req, res) => {
        mine(req).legacyDismiss(req.params.id);
        res.json({ ok: true });
    });

    // The caller's inbox only, and only what is still waiting.
    app.delete('/api/shared', requireAuth, (req, res) => {
        mine(req).legacyDismissAll();
        res.json({ ok: true });
    });
}
