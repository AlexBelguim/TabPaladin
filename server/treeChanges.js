// Changes an AI chat may propose to the bookmark tree: checked when they are
// proposed, checked again against the tree as it is whenever they are shown
// and when they are approved, and turned into the writes approving them makes.
//
// A proposal is an ordered list of changes, applied together or not at all:
//
//   {op: 'create_folder', parentId | parentRef, path: 'Name' | 'A / B', ref?}
//   {op: 'add_bookmarks', folderId | folderRef, bookmarks: [{title, url}]}
//   {op: 'move',          ids: [id], toFolderId | toFolderRef}
//   {op: 'rename',        id, title}
//   {op: 'delete',        ids: [id]}
//
// Existing nodes are named by their stable item id, which the share page and
// the MCP tools show. A folder created earlier in the same proposal is named
// by the `ref` its create_folder gave it, since it has no id yet.
//
// Only the bookmark side of the tree can change this way: never a role folder
// (Bookmarks, Notes, Workflows, Pinned) itself, nothing inside Notes,
// Workflows or Pinned, never a note, and never the imported archive, which is
// not stored in the tree at all. Notes have their own proposals.
//
// Staleness: when a proposal is made, every existing node it names is
// fingerprinted (kind, title, parent, address), and a folder it deletes also
// by what is in it (every id below it). Later, a node that is gone or whose
// fingerprint no longer matches makes the whole proposal stale: it is shown
// as such and approving it is refused, so it is never half-applied onto a
// tree the chat did not see, and a delete never takes more than it showed.
//
// Previews: one line per change. Every DELETE line is always shown (there
// are at most MAX_DELETES); other lines past MAX_PREVIEW are counted in a
// last "… and N more" line. `danger` says whether anything is deleted at
// all, from the whole plan. `reviewKey` is a hash of the whole preview: the
// web app sends back the one it showed, and approving is refused when the
// plan now reads otherwise.
//
// Pure: no database. planChanges takes the account's rows and returns what
// would happen; items.applyTreeChanges does the writing.

import crypto from 'node:crypto';

export const MAX_CHANGES = 50;
export const MAX_IDS = 200;
export const MAX_DELETES = 200;
export const MAX_NEW_BOOKMARKS = 100;
export const MAX_NEW_NODES = 500;
export const MAX_FOLDER_TITLE = 200;
export const MAX_BOOKMARK_TITLE = 1000;
export const MAX_URL_BYTES = 8 * 1024;
export const MAX_PATH_SEGMENTS = 10;
export const MAX_REASON = 1000;
export const MAX_PREVIEW = 60;
// What a preview line shows of a title, an address and a folder path.
const SHOWN_TITLE = 200;
const SHOWN_URL = 300;
const SHOWN_PATH = 400;

export const TREE_OPS = ['create_folder', 'add_bookmarks', 'move', 'rename', 'delete'];
const OP_ALIASES = new Map([
    ['create_folder', 'create_folder'], ['create_folders', 'create_folder'], ['new_folder', 'create_folder'],
    ['add_bookmarks', 'add_bookmarks'], ['add_bookmark', 'add_bookmarks'],
    ['move', 'move'], ['move_bookmarks', 'move'], ['move_bookmark', 'move'], ['move_folder', 'move'],
    ['rename', 'rename'],
    ['delete', 'delete'], ['remove', 'delete']
]);

// Where AI chats may look but not change anything.
export const READ_ONLY_ROLES = new Set(['notes', 'workflows', 'pins']);
const ROLE_NAMES = { bookmarks: 'Bookmarks', notes: 'Notes', workflows: 'Workflows', pins: 'Pinned' };

const REF_RE = /^[A-Za-z0-9_-]{1,40}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export class ChangeError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ChangeError';
        this.status = 400;
    }
}

// --- Shape ----------------------------------------------------------------------

// The op a request names, or null when it names none of ours.
export function treeOp(value) {
    return OP_ALIASES.get(String(value || '').trim().toLowerCase()) || null;
}

function nodeId(value, at) {
    if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
    if (typeof value !== 'string' || !value.trim() || value.length > 100 || CONTROL_RE.test(value)) {
        throw new ChangeError(`${at}: an item id (as shown in brackets on the share page, or by the tools).`);
    }
    return value.trim();
}

function idList(value, at) {
    const list = Array.isArray(value) ? value : (value === undefined || value === null ? [] : [value]);
    if (!list.length) throw new ChangeError(`${at}: one or more item ids.`);
    if (list.length > MAX_IDS) throw new ChangeError(`${at}: at most ${MAX_IDS} ids.`);
    const ids = [...new Set(list.map((v, i) => nodeId(v, `${at}[${i}]`)))];
    return ids;
}

function title(value, max, at, { fallback = null } = {}) {
    if ((value === undefined || value === null || value === '') && fallback !== null) value = fallback;
    if (typeof value !== 'string' || !value.trim()) throw new ChangeError(`${at}: a non-empty name.`);
    const t = value.replace(/\s+/g, ' ').trim();
    if (t.length > max) throw new ChangeError(`${at}: at most ${max} characters.`);
    return t;
}

function folderPath(value, at) {
    const raw = Array.isArray(value) ? value : (typeof value === 'string' ? value.split(/\s+\/\s+/) : null);
    if (!raw) throw new ChangeError(`${at}: the new folder's name, or a path like "Parent / Child".`);
    const segments = raw.map((s, i) => title(s, MAX_FOLDER_TITLE, `${at}[${i}]`));
    if (!segments.length) throw new ChangeError(`${at}: the new folder's name.`);
    if (segments.length > MAX_PATH_SEGMENTS) throw new ChangeError(`${at}: at most ${MAX_PATH_SEGMENTS} levels.`);
    return segments;
}

// The address as given when it is an http(s) link of a sane length.
export function bookmarkUrl(value) {
    if (typeof value !== 'string') return null;
    const s = value.trim();
    if (!s || Buffer.byteLength(s, 'utf8') > MAX_URL_BYTES || CONTROL_RE.test(s)) return null;
    try {
        const u = new URL(s);
        return u.protocol === 'http:' || u.protocol === 'https:' ? s : null;
    } catch (e) {
        return null;
    }
}

// {<idKey>: id} or {<refKey>: ref}: exactly one, and a ref must have been
// made by an earlier create_folder in the same proposal.
function target(c, idKey, refKey, at, refs) {
    const hasId = c[idKey] !== undefined && c[idKey] !== null && c[idKey] !== '';
    const hasRef = c[refKey] !== undefined && c[refKey] !== null && c[refKey] !== '';
    if (hasId === hasRef) throw new ChangeError(`${at}: either "${idKey}" (an existing folder's id) or "${refKey}" (the ref of a folder created earlier in this proposal).`);
    if (hasId) return { [idKey]: nodeId(c[idKey], `${at}.${idKey}`) };
    const ref = String(c[refKey]).trim();
    if (!refs.has(ref)) throw new ChangeError(`${at}.${refKey}: no earlier create_folder in this proposal has ref "${ref}".`);
    return { [refKey]: ref };
}

function normalizeOne(c, i, refs) {
    const at = `changes[${i}]`;
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new ChangeError(`${at}: an object with "op".`);
    const op = treeOp(c.op || c.action);
    if (!op) throw new ChangeError(`${at}.op: one of ${TREE_OPS.join(', ')}.`);
    if (op === 'create_folder') {
        const parent = target(c, 'parentId', 'parentRef', at, refs);
        const path = folderPath(c.path !== undefined ? c.path : c.title, `${at}.path`);
        const out = { op, ...parent, path };
        if (c.ref !== undefined && c.ref !== null && c.ref !== '') {
            const ref = String(c.ref).trim();
            if (!REF_RE.test(ref)) throw new ChangeError(`${at}.ref: 1-40 letters, digits, - or _.`);
            if (refs.has(ref)) throw new ChangeError(`${at}.ref: "${ref}" is used twice.`);
            refs.add(ref);
            out.ref = ref;
        }
        return out;
    }
    if (op === 'add_bookmarks') {
        const folder = target(c, 'folderId', 'folderRef', at, refs);
        const list = Array.isArray(c.bookmarks) ? c.bookmarks
            : (c.url !== undefined ? [{ title: c.title, url: c.url }] : (c.bookmark ? [c.bookmark] : null));
        if (!list || !list.length) throw new ChangeError(`${at}.bookmarks: a list of {title, url}.`);
        if (list.length > MAX_NEW_BOOKMARKS) throw new ChangeError(`${at}.bookmarks: at most ${MAX_NEW_BOOKMARKS}.`);
        const bookmarks = list.map((b, j) => {
            const where = `${at}.bookmarks[${j}]`;
            if (!b || typeof b !== 'object') throw new ChangeError(`${where}: {title, url}.`);
            const url = bookmarkUrl(b.url);
            if (!url) throw new ChangeError(`${where}.url: an http(s) address of at most ${MAX_URL_BYTES} bytes.`);
            return { title: title(b.title, MAX_BOOKMARK_TITLE, `${where}.title`, { fallback: url }), url };
        });
        return { op, ...folder, bookmarks };
    }
    if (op === 'move') {
        const ids = idList(c.ids !== undefined ? c.ids : c.id, `${at}.ids`);
        const dest = target(c, 'toFolderId', 'toFolderRef', at, refs);
        return { op, ids, ...dest };
    }
    if (op === 'rename') {
        const id = nodeId(c.id, `${at}.id`);
        return { op, id, title: title(c.title !== undefined ? c.title : c.newTitle, MAX_BOOKMARK_TITLE, `${at}.title`) };
    }
    return { op, ids: idList(c.ids !== undefined ? c.ids : c.id, `${at}.ids`) };
}

// The proposal's changes, validated for shape only (the tree is checked by
// planChanges). Throws ChangeError.
export function normalizeChanges(list) {
    if (!Array.isArray(list) || !list.length) throw new ChangeError(`"changes": a list of 1-${MAX_CHANGES} changes.`);
    if (list.length > MAX_CHANGES) throw new ChangeError(`"changes": at most ${MAX_CHANGES} in one proposal.`);
    const refs = new Set();
    const out = list.map((c, i) => normalizeOne(c, i, refs));
    // Every deletion is listed for the user before approving, so they are
    // capped as a whole, not per change.
    const deletes = out.reduce((n, c) => n + (c.op === 'delete' ? c.ids.length : 0), 0);
    if (deletes > MAX_DELETES) {
        throw new ChangeError(`"changes": at most ${MAX_DELETES} bookmarks and folders deleted in one proposal (a folder goes with everything in it); split it up.`);
    }
    return out;
}

export function normalizeReason(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string') throw new ChangeError('"reason": a short text for the user.');
    const r = value.trim();
    if (r.length > MAX_REASON) throw new ChangeError(`"reason": at most ${MAX_REASON} characters.`);
    return r || null;
}

// --- Against the tree -------------------------------------------------------------

const fingerprintOf = (row) => ({ k: row.kind, t: row.title, p: row.parent_id || null, u: row.url || null });

const quote = (s) => `“${clip(String(s), SHOWN_TITLE)}”`;
const shownUrl = (u) => clip(String(u), SHOWN_URL);
const shownPath = (p) => (p.length > SHOWN_PATH ? '…' + p.slice(-(SHOWN_PATH - 1)) : p);
const hashOf = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('base64url').slice(0, 22);
const kindName = (kind) => (kind === 'folder' ? 'folder' : kind === 'bookmark' ? 'bookmark' : kind);

// What approving `changes` would do to a tree made of `rows` (this account's
// items: id, parent_id, kind, role, title, url, ordered by parent and
// position). With `fingerprints` (what the proposal saw), anything they name
// that changed since makes the result stale.
//
// Returns {ok, problems, stale, preview: [{op, text, danger?}], actions,
// fingerprints, counts, summary, danger, reviewKey}. `actions` are the
// writes, in order:
// {type: 'folder' | 'bookmark', id, parentId, title, url?},
// {type: 'move', id, parentId}, {type: 'rename', id, title},
// {type: 'delete', ids}.
export function planChanges(rows, changes, { fingerprints = null, newId }) {
    const original = new Map();
    const nodes = new Map();
    const kids = new Map();
    for (const r of rows) {
        original.set(r.id, r);
        nodes.set(r.id, { id: r.id, parentId: r.parent_id || null, kind: r.kind, role: r.role || null, title: String(r.title || ''), url: r.url || null });
    }
    for (const r of rows) {
        const key = r.parent_id || '';
        if (!kids.has(key)) kids.set(key, []);
        kids.get(key).push(r.id);
    }
    // The tree as it was, whatever the changes below do to `kids`.
    const originalKids = new Map([...kids].map(([k, v]) => [k, v.slice()]));
    // What is in a folder of the original tree: how many items, and a hash
    // of their ids. Part of a deleted folder's fingerprint.
    const contentsOf = (id) => {
        const seen = new Set([id]);
        const ids = [];
        const walk = (x) => {
            for (const c of originalKids.get(x) || []) {
                if (seen.has(c)) continue;
                seen.add(c);
                ids.push(c);
                walk(c);
            }
        };
        walk(id);
        ids.sort();
        return { n: ids.length, h: hashOf(ids.join('\n')) };
    };
    const childrenOf = (id) => kids.get(id || '') || [];
    const get = (id) => nodes.get(id) || null;
    const zone = (id) => {
        let cur = get(id);
        for (let hops = 0; cur && hops < 1000; hops++) {
            if (cur.role && READ_ONLY_ROLES.has(cur.role)) return cur.role;
            cur = cur.parentId ? get(cur.parentId) : null;
        }
        return null;
    };
    const pathOf = (id) => {
        const titles = [];
        let cur = get(id);
        for (let hops = 0; cur && hops < 1000; hops++) {
            titles.unshift(cur.title || '(untitled)');
            cur = cur.parentId ? get(cur.parentId) : null;
        }
        return shownPath(titles.join(' / ')) || '(top level)';
    };
    const within = (id, ancestorId) => {
        let cur = get(id);
        for (let hops = 0; cur && hops < 1000; hops++) {
            if (cur.id === ancestorId) return true;
            cur = cur.parentId ? get(cur.parentId) : null;
        }
        return false;
    };
    const subtree = (id) => {
        const out = [];
        const walk = (x) => { out.push(x); for (const c of childrenOf(x)) walk(c); };
        walk(id);
        return out;
    };
    const detach = (id) => {
        const n = get(id);
        const list = kids.get(n.parentId || '');
        if (list) {
            const i = list.indexOf(id);
            if (i >= 0) list.splice(i, 1);
        }
    };
    const attach = (id, parentId) => {
        get(id).parentId = parentId;
        if (!kids.has(parentId || '')) kids.set(parentId || '', []);
        kids.get(parentId || '').push(id);
    };
    const add = (node) => {
        nodes.set(node.id, node);
        attach(node.id, node.parentId);
    };

    const problems = [];
    const stale = [];
    const preview = [];
    const actions = [];
    const fps = {};
    const refIds = new Map();
    // Ids an earlier delete in this proposal took away: {title, folder},
    // folder being the deleted folder's title when it went with one.
    const deleted = new Map();
    const counts = { folders: 0, bookmarks: 0, moved: 0, renamed: 0, deleted: 0, skipped: 0 };

    if (fingerprints) {
        for (const [id, fp] of Object.entries(fingerprints)) {
            const r = original.get(id);
            const label = `${kindName(fp.k)} ${quote(fp.t)}`;
            if (!r) { stale.push(`The ${label} is no longer there.`); continue; }
            if (r.kind !== fp.k) { stale.push(`The ${label} is no longer a ${kindName(fp.k)}.`); continue; }
            if (r.title !== fp.t) stale.push(`The ${label} was renamed to ${quote(r.title)}.`);
            if ((r.parent_id || null) !== (fp.p || null)) stale.push(`The ${label} was moved (it is now in ${pathOf(r.parent_id)}).`);
            if ((r.url || null) !== (fp.u || null)) stale.push(`The ${label} now points to another address.`);
            if (fp.c && r.kind === 'folder') {
                const now = contentsOf(id);
                if (now.h !== fp.c.h) {
                    stale.push(`What is in the ${label} changed since (${fp.c.n} item(s) then, ${now.n} now), so deleting it would delete other things than were proposed.`);
                }
            }
        }
    }
    const remember = (id) => {
        if (!fingerprints && original.has(id) && !fps[id]) fps[id] = fingerprintOf(original.get(id));
    };

    // An existing or just-created folder that may receive changes; null after
    // noting the problem.
    const writableFolder = (c, idKey, refKey, at) => {
        if (c[refKey]) {
            const id = refIds.get(c[refKey]);
            if (!id) problems.push(`${at}: the folder with ref "${c[refKey]}" was not created.`);
            return id || null;
        }
        const id = c[idKey];
        remember(id);
        if (id.startsWith('imp:') || id === 'imports:root') {
            problems.push(`${at}: the imported archive is read-only.`);
            return null;
        }
        if (deleted.has(id)) {
            problems.push(`${at}: ${quote(deleted.get(id).title)} is deleted by an earlier change in this proposal.`);
            return null;
        }
        const n = get(id);
        if (!n) { problems.push(`${at}: there is no folder with id ${id}.`); return null; }
        if (n.kind !== 'folder') { problems.push(`${at}: ${id} is a ${kindName(n.kind)} (${quote(n.title)}), not a folder.`); return null; }
        const z = zone(id);
        if (z) { problems.push(`${at}: folder ${quote(n.title)} is inside ${ROLE_NAMES[z]}, which AI chats cannot change.`); return null; }
        return id;
    };

    // An existing bookmark or folder that may be moved, renamed or deleted.
    const changeable = (id, at, verb) => {
        remember(id);
        if (id.startsWith('imp:') || id === 'imports:root') {
            problems.push(`${at}: ${id} is in the imported archive, which is read-only.`);
            return null;
        }
        if (deleted.has(id)) {
            problems.push(`${at}: ${quote(deleted.get(id).title)} is deleted by an earlier change in this proposal.`);
            return null;
        }
        const n = get(id);
        if (!n) { problems.push(`${at}: there is no bookmark or folder with id ${id}.`); return null; }
        if (n.kind === 'note') { problems.push(`${at}: ${quote(n.title)} is a note; notes are changed with note proposals.`); return null; }
        if (n.kind !== 'folder' && n.kind !== 'bookmark') { problems.push(`${at}: ${id} cannot be ${verb}.`); return null; }
        if (n.role) { problems.push(`${at}: ${quote(n.title)} is the app's own ${ROLE_NAMES[n.role] || n.role} folder and cannot be ${verb}.`); return null; }
        const z = zone(id);
        if (z) { problems.push(`${at}: ${quote(n.title)} is inside ${ROLE_NAMES[z]}, which AI chats cannot change.`); return null; }
        return n;
    };

    changes.forEach((c, i) => {
        const at = `Change ${i + 1}`;
        if (c.op === 'create_folder') {
            const parent = writableFolder(c, 'parentId', 'parentRef', at);
            if (!parent) return;
            let cur = parent;
            let made = 0;
            for (const segment of c.path) {
                const folders = childrenOf(cur).map(get).filter(n => n && n.kind === 'folder');
                const hit = folders.find(n => n.title === segment)
                    || folders.find(n => n.title.toLowerCase() === segment.toLowerCase());
                if (hit && !(hit.role && READ_ONLY_ROLES.has(hit.role))) { cur = hit.id; continue; }
                const id = newId();
                add({ id, parentId: cur, kind: 'folder', role: null, title: segment, url: null });
                actions.push({ type: 'folder', id, parentId: cur, title: segment });
                preview.push({ op: 'create_folder', text: `New folder ${quote(segment)} in ${pathOf(cur)}` });
                counts.folders++;
                made++;
                cur = id;
            }
            if (!made) {
                preview.push({ op: 'skip', text: `Folder ${pathOf(cur)} is already there, nothing to create` });
                counts.skipped++;
            }
            if (c.ref) refIds.set(c.ref, cur);
            return;
        }
        if (c.op === 'add_bookmarks') {
            const folder = writableFolder(c, 'folderId', 'folderRef', at);
            if (!folder) return;
            for (const b of c.bookmarks) {
                const there = childrenOf(folder).map(get).find(n => n && n.kind === 'bookmark' && n.url === b.url);
                if (there) {
                    preview.push({ op: 'skip', text: `${quote(b.title)} is already in ${pathOf(folder)}` });
                    counts.skipped++;
                    continue;
                }
                const id = newId();
                add({ id, parentId: folder, kind: 'bookmark', role: null, title: b.title, url: b.url });
                actions.push({ type: 'bookmark', id, parentId: folder, title: b.title, url: b.url });
                preview.push({ op: 'add_bookmark', text: `Add ${quote(b.title)} (${shownUrl(b.url)}) to ${pathOf(folder)}` });
                counts.bookmarks++;
            }
            return;
        }
        if (c.op === 'move') {
            const dest = writableFolder(c, 'toFolderId', 'toFolderRef', at);
            for (const id of c.ids) {
                const n = changeable(id, at, 'moved');
                if (!n || !dest) continue;
                if (n.kind === 'folder' && (id === dest || within(dest, id))) {
                    problems.push(`${at}: folder ${quote(n.title)} cannot be moved into itself.`);
                    continue;
                }
                if (n.parentId === dest) {
                    preview.push({ op: 'skip', text: `${quote(n.title)} is already in ${pathOf(dest)}` });
                    counts.skipped++;
                    continue;
                }
                const from = pathOf(n.parentId);
                detach(id);
                attach(id, dest);
                actions.push({ type: 'move', id, parentId: dest });
                preview.push({ op: 'move', text: `Move ${kindName(n.kind)} ${quote(n.title)} from ${from} to ${pathOf(dest)}` });
                counts.moved++;
            }
            return;
        }
        if (c.op === 'rename') {
            const n = changeable(c.id, at, 'renamed');
            if (!n) return;
            if (n.kind === 'folder' && c.title.length > MAX_FOLDER_TITLE) {
                problems.push(`${at}: a folder name has at most ${MAX_FOLDER_TITLE} characters.`);
                return;
            }
            if (n.title === c.title) {
                preview.push({ op: 'skip', text: `${quote(n.title)} already has that name` });
                counts.skipped++;
                return;
            }
            preview.push({ op: 'rename', text: `Rename ${kindName(n.kind)} ${quote(n.title)} to ${quote(c.title)} (in ${pathOf(n.parentId)})` });
            n.title = c.title;
            actions.push({ type: 'rename', id: c.id, title: c.title });
            counts.renamed++;
            return;
        }
        if (c.op === 'delete') {
            for (const id of c.ids) {
                // Already gone with a folder deleted before it, or by an
                // earlier delete: said, not refused.
                const gone = deleted.get(id);
                if (gone) {
                    remember(id);
                    preview.push({ op: 'skip', text: gone.folder
                        ? `${quote(gone.title)} goes with the folder ${quote(gone.folder)}, deleted above`
                        : `${quote(gone.title)} is already deleted above` });
                    counts.skipped++;
                    continue;
                }
                const n = changeable(id, at, 'deleted');
                if (!n) continue;
                const ids = subtree(id);
                const inside = ids.slice(1).map(get);
                const notes = inside.filter(x => x.kind === 'note').length;
                const roles = inside.filter(x => x.role).length;
                if (notes || roles) {
                    problems.push(`${at}: folder ${quote(n.title)} holds ${notes ? `${notes} note(s)` : 'an app folder'}; only bookmarks and folders can be deleted this way.`);
                    continue;
                }
                const where = pathOf(n.parentId);
                if (n.kind === 'folder') {
                    const bms = inside.filter(x => x.kind === 'bookmark').length;
                    const fls = inside.filter(x => x.kind === 'folder').length;
                    preview.push({ op: 'delete', danger: true,
                        text: `DELETE folder ${quote(n.title)} from ${where}${inside.length ? ` with everything in it: ${bms} bookmark(s), ${fls} folder(s)` : ' (empty)'}` });
                } else {
                    preview.push({ op: 'delete', danger: true, text: `DELETE bookmark ${quote(n.title)} (${shownUrl(n.url)}) from ${where}` });
                }
                // What it holds is part of what the user is shown and asked
                // about: anything added to or taken from it since makes the
                // proposal stale.
                if (!fingerprints && n.kind === 'folder' && original.has(id) && fps[id] && !fps[id].c) fps[id].c = contentsOf(id);
                detach(id);
                for (const x of ids) {
                    deleted.set(x, { title: get(x).title, folder: x === id ? null : n.title });
                    nodes.delete(x);
                }
                actions.push({ type: 'delete', ids });
                counts.deleted++;
            }
        }
    });

    const created = actions.filter(a => a.type === 'folder' || a.type === 'bookmark').length;
    if (created > MAX_NEW_NODES) problems.push(`This would add ${created} items; at most ${MAX_NEW_NODES} in one proposal.`);
    if (!actions.length && !problems.length) problems.push('Nothing would change: everything asked for is already so.');
    if (fingerprints && problems.length) stale.push(...problems.splice(0));

    // Every DELETE line, and the first MAX_PREVIEW of the others.
    const shown = [];
    let others = 0;
    for (const p of preview) {
        if (p.danger) shown.push(p);
        else if (others < MAX_PREVIEW) { shown.push(p); others++; }
    }
    if (shown.length < preview.length) {
        shown.push({ op: 'more', text: `… and ${preview.length - shown.length} more, none of them a deletion` });
    }
    return {
        ok: problems.length === 0 && stale.length === 0,
        problems,
        stale,
        preview: shown,
        actions,
        fingerprints: fingerprints || fps,
        counts,
        summary: summarize(preview, counts),
        danger: counts.deleted > 0,
        reviewKey: hashOf(JSON.stringify(preview.map(p => [p.op, p.text])))
    };
}

// One line for the proposal's title.
export function summarize(preview, counts) {
    const real = preview.filter(p => p.op !== 'skip' && p.op !== 'more');
    if (real.length === 1) return clip(real[0].text, 200);
    const parts = [];
    if (counts.folders) parts.push(`${counts.folders} new folder${counts.folders === 1 ? '' : 's'}`);
    if (counts.bookmarks) parts.push(`${counts.bookmarks} new bookmark${counts.bookmarks === 1 ? '' : 's'}`);
    if (counts.moved) parts.push(`${counts.moved} moved`);
    if (counts.renamed) parts.push(`${counts.renamed} renamed`);
    if (counts.deleted) parts.push(`${counts.deleted} DELETED`);
    return clip(`${real.length} changes: ${parts.join(', ') || 'none'}`, 200);
}

function clip(s, n) {
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
