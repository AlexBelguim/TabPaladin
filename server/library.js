// Read-only views of one account's tree for AI chats: the LLM share page
// (llmShare.js) and the MCP tools (mcp.js).
//
// Pure: they take the roots items.forUser(id).readTree() returned, which are
// that account's alone, and the notes listNotes() returned. Nothing here
// touches the database.
//
// The bookmark side is everything outside the Notes root: the Bookmarks root
// and its folders, plus Pinned and Workflows, which are listed but marked
// read-only (proposals cannot change them). Notes are listed separately. The
// imported archive (Reddit, X, Instagram) is not in the stored tree and is not
// shown.

import { READ_ONLY_ROLES } from './treeChanges.js';

export const ROLE_LABEL = { bookmarks: 'Bookmarks', notes: 'Notes', workflows: 'Workflows', pins: 'Pinned' };

// {folders: [folder], bookmarks: [bookmark], folderById, bookmarkById}, in
// tree order.
//   folder    {id, title, path: [titles], parentId, role, readOnly,
//             folders, bookmarks}  (direct subfolders / bookmarks)
//   bookmark  {id, title, url, parentId, path: [titles of its folder], readOnly}
export function indexTree(roots) {
    const folders = [];
    const bookmarks = [];
    const folderById = new Map();
    const bookmarkById = new Map();
    const walk = (node, path, parentId, readOnly) => {
        if (!node || typeof node !== 'object') return;
        if (node.kind === 'folder') {
            if (node.role === 'notes') return;
            const ro = readOnly || READ_ONLY_ROLES.has(node.role);
            const entry = {
                id: node.id,
                title: node.title || '(untitled)',
                path: [...path, node.title || '(untitled)'],
                parentId,
                role: node.role || null,
                readOnly: ro,
                folders: 0,
                bookmarks: 0
            };
            folders.push(entry);
            folderById.set(entry.id, entry);
            for (const c of node.children || []) {
                if (c && c.kind === 'folder' && c.role !== 'notes') entry.folders++;
                if (c && c.kind === 'bookmark') entry.bookmarks++;
                walk(c, entry.path, entry.id, ro);
            }
        } else if (node.kind === 'bookmark') {
            const entry = { id: node.id, title: node.title || node.url, url: node.url, parentId, path, readOnly };
            bookmarks.push(entry);
            bookmarkById.set(entry.id, entry);
        }
    };
    for (const r of roots || []) walk(r, [], null, false);
    return { folders, bookmarks, folderById, bookmarkById };
}

export const pathText = (path) => (path && path.length ? path.join(' / ') : '(top level)');

// The folder at a path like "Bookmarks / Tech / AI" (or ['Bookmarks', ...]),
// matching titles exactly first, then ignoring case. null when none.
export function folderByPath(index, value) {
    const want = (Array.isArray(value) ? value : String(value || '').split(/\s+\/\s+/)).map(s => String(s).trim()).filter(Boolean);
    if (!want.length) return null;
    const exact = index.folders.find(f => f.path.length === want.length && f.path.every((t, i) => t === want[i]));
    if (exact) return exact;
    const lower = want.map(s => s.toLowerCase());
    return index.folders.find(f => f.path.length === want.length && f.path.every((t, i) => t.toLowerCase() === lower[i])) || null;
}

// What a folder holds: {folder, subfolders: [folder], bookmarks: [bookmark],
// total, offset, nextOffset}. `id` null: the top level.
export function folderContents(index, id, { offset = 0, limit = 200 } = {}) {
    const folder = id ? index.folderById.get(id) || null : null;
    if (id && !folder) return null;
    const parentId = folder ? folder.id : null;
    const subfolders = index.folders.filter(f => f.parentId === parentId);
    const bms = index.bookmarks.filter(b => b.parentId === parentId);
    const start = Math.max(0, Number(offset) || 0);
    const page = bms.slice(start, start + limit);
    return {
        folder,
        subfolders,
        bookmarks: page,
        total: bms.length,
        offset: start,
        nextOffset: start + page.length < bms.length ? start + page.length : null
    };
}

const terms = (q) => String(q || '').toLowerCase().split(/\s+/).map(t => t.trim()).filter(Boolean).slice(0, 12);

// Bookmarks whose title, address or folder path holds every word of the query,
// title hits first. `folderId` narrows it to that folder and everything in it.
export function searchBookmarks(index, query, { limit = 50, folderId = null } = {}) {
    const words = terms(query);
    if (!words.length) return { results: [], total: 0 };
    let pool = index.bookmarks;
    if (folderId) {
        const f = index.folderById.get(folderId);
        if (!f) return { results: [], total: 0, missingFolder: true };
        pool = pool.filter(b => isUnder(index, b.parentId, f.id));
    }
    const scored = [];
    for (const b of pool) {
        const title = String(b.title || '').toLowerCase();
        const hay = `${title} ${String(b.url || '').toLowerCase()} ${b.path.join(' ').toLowerCase()}`;
        if (!words.every(w => hay.includes(w))) continue;
        scored.push({ b, score: words.filter(w => title.includes(w)).length });
    }
    scored.sort((x, y) => y.score - x.score);
    return { results: scored.slice(0, limit).map(s => s.b), total: scored.length };
}

// Folders whose title holds every word of the query.
export function searchFolders(index, query, { limit = 20 } = {}) {
    const words = terms(query);
    if (!words.length) return [];
    return index.folders.filter(f => words.every(w => pathText(f.path).toLowerCase().includes(w))).slice(0, limit);
}

function isUnder(index, folderId, ancestorId) {
    let cur = folderId ? index.folderById.get(folderId) : null;
    for (let hops = 0; cur && hops < 1000; hops++) {
        if (cur.id === ancestorId) return true;
        cur = cur.parentId ? index.folderById.get(cur.parentId) : null;
    }
    return false;
}

export const notePath = (n) => (n.notebookPath && n.notebookPath.length ? n.notebookPath.join(' / ') : (n.notebook || ''));

// Notes whose title or text holds every word, title hits first, each with a
// short snippet around its first hit.
export function searchNotes(notes, query, { limit = 20 } = {}) {
    const words = terms(query);
    if (!words.length) return { results: [], total: 0 };
    const hits = [];
    for (const n of notes) {
        const title = String(n.title || '').toLowerCase();
        const text = String(n.content || '');
        const lower = text.toLowerCase();
        if (!words.every(w => title.includes(w) || lower.includes(w))) continue;
        const first = Math.min(...words.map(w => lower.indexOf(w)).filter(i => i >= 0), Infinity);
        const at = Number.isFinite(first) ? first : 0;
        const snippet = text.slice(Math.max(0, at - 80), at + 160).replace(/\s+/g, ' ').trim();
        hits.push({ n, snippet, score: words.filter(w => title.includes(w)).length });
    }
    hits.sort((a, b) => b.score - a.score);
    return { results: hits.slice(0, limit).map(h => ({ note: h.n, snippet: h.snippet })), total: hits.length };
}
