// The MCP endpoint: AI chats (Claude Code, Claude Desktop through a bridge,
// any MCP client) read this account's bookmarks and notes and propose
// changes, which wait for the account's approval in the web app like every
// other proposal (proposals.js). Read + propose only: no tool here changes
// the tree, and an MCP token opens nothing else on this server.
//
// Transport: MCP Streamable HTTP, stateless (no Mcp-Session-Id), JSON
// responses, POST /mcp only, served by the official SDK
// (@modelcontextprotocol/sdk): every request gets its own server and
// transport, made for the account its token belongs to. GET and DELETE answer
// 405: there is no server-initiated stream and no session to end.
//
// Auth: per-account tokens made in the web app's Settings
// (POST /api/mcp/tokens, signed in), shown once, stored only as a SHA-256
// hash, with a name, when it was made and when it was last used. Sent as
// Authorization: Bearer tpm_…, never in the URL. A token is refused once it is
// revoked, its account deleted, or the account's password changed. Sessions
// and the legacy AUTH_TOKEN are not accepted here, and MCP tokens are not
// accepted anywhere else (requireAuth only knows sessions and AUTH_TOKEN).
//
// Limits: requests per token per minute, failed tokens per client IP, the
// body size, and every tool's answer (lists are paged and capped).
//
// Origin: browsers send one, MCP clients do not. A request carrying an Origin
// header is refused (403) unless MCP_ALLOWED_ORIGINS lists it, as the MCP
// transport spec asks against DNS rebinding — a page in the user's browser
// has no business calling this, with or without a token.
//
// Top-level on purpose: the Dockerfile copies server/*.js and server/imports.

import crypto from 'node:crypto';
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ensureOwnerGuards } from './tenancy.js';
import { makeRateLimiter } from './security.js';
import { requireSession } from './admin.js';
import { indexTree, pathText, folderByPath, folderContents, searchBookmarks, searchNotes, notePath } from './library.js';
import { parseProposal } from './proposals.js';
import { ChangeError, TREE_OPS } from './treeChanges.js';

export const TOKEN_PREFIX = 'tpm_';
export const MAX_TOKENS_PER_USER = 20;
export const MAX_TOKEN_NAME = 60;
export const MAX_TOOL_TEXT = 100 * 1024;
export const MCP_BODY_LIMIT = '256kb';
const LAST_USED_EVERY_MS = 60 * 1000;
const SERVER_INFO = { name: 'tabpaladin', title: 'TabPaladin', version: '1.0.0' };

// One table, born per account: guarded like every other (tenancy.js) and
// removed with its account. Additive and idempotent.
export function migrateMcpTokens(db) {
    return db.transaction(() => {
        db.exec(`
            CREATE TABLE IF NOT EXISTS mcp_tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                token_hash TEXT NOT NULL UNIQUE,
                prefix TEXT NOT NULL,
                scope TEXT NOT NULL DEFAULT 'read propose',
                created_at TEXT NOT NULL,
                last_used_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_mcp_tokens_user ON mcp_tokens(user_id, created_at);
        `);
        ensureOwnerGuards(db, ['mcp_tokens']);
        return { ok: true };
    })();
}

const hashToken = (token) => crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');

export function makeMcpTokenStore(db) {
    const shape = (r) => ({
        id: r.id, name: r.name, prefix: r.prefix, scope: r.scope, createdAt: r.created_at, lastUsedAt: r.last_used_at || null
    });
    return {
        list(userId) {
            return db.prepare('SELECT * FROM mcp_tokens WHERE user_id = ? ORDER BY created_at, id').all(userId).map(shape);
        },
        // {token, meta} — the token itself only ever leaves here, once.
        create(userId, name) {
            return db.transaction(() => {
                const n = db.prepare('SELECT COUNT(*) AS n FROM mcp_tokens WHERE user_id = ?').get(userId).n;
                if (n >= MAX_TOKENS_PER_USER) return { full: true };
                const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
                const id = db.prepare(`
                    INSERT INTO mcp_tokens (user_id, name, token_hash, prefix, scope, created_at)
                    VALUES (?, ?, ?, ?, 'read propose', ?)
                `).run(userId, name, hashToken(token), token.slice(0, TOKEN_PREFIX.length + 6), new Date().toISOString()).lastInsertRowid;
                const row = db.prepare('SELECT * FROM mcp_tokens WHERE id = ? AND user_id = ?').get(id, userId);
                return { token, meta: shape(row) };
            })();
        },
        revoke(userId, id) {
            return db.prepare('DELETE FROM mcp_tokens WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
        },
        revokeAll(userId) {
            return db.prepare('DELETE FROM mcp_tokens WHERE user_id = ?').run(userId).changes;
        },
        // The token's row and its (existing) account, or null.
        find(token) {
            if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX) || token.length > 200) return null;
            return db.prepare(`
                SELECT t.id, t.user_id, t.name, t.scope, t.last_used_at, u.username
                FROM mcp_tokens t JOIN users u ON u.id = t.user_id
                WHERE t.token_hash = ?`).get(hashToken(token)) || null;
        },
        touch(row) {
            const last = row.last_used_at ? Date.parse(row.last_used_at) : 0;
            if (Date.now() - last < LAST_USED_EVERY_MS) return;
            db.prepare('UPDATE mcp_tokens SET last_used_at = ? WHERE id = ? AND user_id = ?').run(new Date().toISOString(), row.id, row.user_id);
        }
    };
}

// --- Tools ------------------------------------------------------------------------

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const int = (description, min, max, def) => ({ type: 'integer', description, minimum: min, maximum: max, default: def });
const idArray = (description) => ({ type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 200, description });
const reason = str('One or two sentences for the user: why you propose this. Shown next to the proposal.', { maxLength: 1000 });
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const PROPOSE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const CHANGE_ITEM = {
    type: 'object',
    description: 'One change. "op" is one of create_folder, add_bookmarks, move, rename, delete; the other fields are those of the matching propose_* tool. '
        + 'A create_folder may set "ref" (a short name); later changes in the same list can then use parentRef / folderRef / toFolderRef instead of an id.',
    properties: {
        op: { type: 'string', enum: TREE_OPS },
        parentId: { type: 'string' }, parentRef: { type: 'string' }, path: { type: 'string' }, ref: { type: 'string' },
        folderId: { type: 'string' }, folderRef: { type: 'string' },
        bookmarks: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string' } }, required: ['url'] } },
        ids: { type: 'array', items: { type: 'string' } }, toFolderId: { type: 'string' }, toFolderRef: { type: 'string' },
        id: { type: 'string' }, title: { type: 'string' }
    },
    required: ['op']
};

export const TOOLS = [
    {
        name: 'search_bookmarks', title: 'Search bookmarks',
        description: 'Find bookmarks whose title, address or folder path contains every word of the query. Returns ids, titles, addresses and the folder each is in.',
        inputSchema: { type: 'object', properties: {
            query: str('Words to look for.'),
            folderId: str('Only look inside this folder and its subfolders.'),
            limit: int('How many to return.', 1, 100, 30)
        }, required: ['query'] },
        annotations: READ
    },
    {
        name: 'list_folders', title: 'List bookmark folders',
        description: 'Every bookmark folder with its id, full path and how many folders and bookmarks it holds directly, in tree order. Folders marked readOnly (Pinned, Workflows) cannot be changed by proposals.',
        inputSchema: { type: 'object', properties: {
            offset: int('Skip this many.', 0, 1000000, 0),
            limit: int('How many to return.', 1, 500, 200)
        } },
        annotations: READ
    },
    {
        name: 'list_folder', title: 'List a folder',
        description: 'The subfolders and bookmarks in one folder, named by id or by path ("Bookmarks / Tech"). With neither, the top level.',
        inputSchema: { type: 'object', properties: {
            folderId: str('The folder\'s id.'),
            path: str('The folder\'s path, titles joined by " / ".'),
            offset: int('Skip this many bookmarks.', 0, 1000000, 0),
            limit: int('How many bookmarks to return.', 1, 500, 200)
        } },
        annotations: READ
    },
    {
        name: 'get_bookmark', title: 'Get a bookmark',
        description: 'One bookmark (or folder) by id: its title, address and folder.',
        inputSchema: { type: 'object', properties: { id: str('The bookmark\'s id.') }, required: ['id'] },
        annotations: READ
    },
    {
        name: 'list_notes', title: 'List notes',
        description: 'The notes, newest edits first: id, title, notebook and size, without their text. Use read_note for the text.',
        inputSchema: { type: 'object', properties: {
            notebook: str('Only notes in this notebook ("Parent / Child" for a nested one).'),
            offset: int('Skip this many.', 0, 1000000, 0),
            limit: int('How many to return.', 1, 200, 50)
        } },
        annotations: READ
    },
    {
        name: 'read_note', title: 'Read a note',
        description: 'One note\'s full text, by id or by title.',
        inputSchema: { type: 'object', properties: { id: str('The note\'s id.'), title: str('The note\'s title.') } },
        annotations: READ
    },
    {
        name: 'search_notes', title: 'Search notes',
        description: 'Notes whose title or text contains every word of the query, with a snippet of each.',
        inputSchema: { type: 'object', properties: {
            query: str('Words to look for.'),
            limit: int('How many to return.', 1, 50, 20)
        }, required: ['query'] },
        annotations: READ
    },
    {
        name: 'propose_create_folder', title: 'Propose a new folder',
        description: 'Propose new folder(s) inside an existing folder. "path" may be "A / B" for nested folders; existing ones are reused. Changes nothing until the user approves it in the TabPaladin app.',
        inputSchema: { type: 'object', properties: {
            parentId: str('The id of the folder to create it in.'),
            path: str('The new folder\'s name, or "A / B" for nested folders.'),
            reason
        }, required: ['parentId', 'path'] },
        annotations: PROPOSE
    },
    {
        name: 'propose_add_bookmarks', title: 'Propose new bookmarks',
        description: 'Propose adding bookmarks (http or https, at most 100) to a folder. Ones already in that folder are skipped. Changes nothing until the user approves it.',
        inputSchema: { type: 'object', properties: {
            folderId: str('The id of the folder to add them to.'),
            bookmarks: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', properties: {
                title: { type: 'string' }, url: { type: 'string' } }, required: ['url'] } },
            reason
        }, required: ['folderId', 'bookmarks'] },
        annotations: PROPOSE
    },
    {
        name: 'propose_move', title: 'Propose moving bookmarks or folders',
        description: 'Propose moving bookmarks and/or folders (with everything in them) into another folder. Changes nothing until the user approves it.',
        inputSchema: { type: 'object', properties: {
            ids: idArray('The ids of the bookmarks and folders to move.'),
            toFolderId: str('The id of the folder to move them into.'),
            reason
        }, required: ['ids', 'toFolderId'] },
        annotations: PROPOSE
    },
    {
        name: 'propose_rename', title: 'Propose renaming a bookmark or folder',
        description: 'Propose a new name for one bookmark or folder. Changes nothing until the user approves it.',
        inputSchema: { type: 'object', properties: {
            id: str('The id of the bookmark or folder.'),
            title: str('The new name.'),
            reason
        }, required: ['id', 'title'] },
        annotations: PROPOSE
    },
    {
        name: 'propose_delete', title: 'Propose deleting bookmarks or folders',
        description: 'Propose deleting bookmarks and/or folders; a folder goes with everything in it. The user sees it flagged as a DELETE. Only use it when the user asked for a deletion. Changes nothing until the user approves it.',
        inputSchema: { type: 'object', properties: {
            ids: idArray('The ids of the bookmarks and folders to delete.'),
            reason
        }, required: ['ids'] },
        annotations: PROPOSE
    },
    {
        name: 'propose_changes', title: 'Propose several bookmark changes at once',
        description: 'Propose up to 50 changes the user approves or rejects as a whole, applied in order: for example create a folder (with "ref": "x") and move bookmarks into it ("toFolderRef": "x"). Changes nothing until the user approves it.',
        inputSchema: { type: 'object', properties: {
            changes: { type: 'array', minItems: 1, maxItems: 50, items: CHANGE_ITEM },
            reason
        }, required: ['changes'] },
        annotations: PROPOSE
    },
    {
        name: 'propose_note', title: 'Propose a note',
        description: 'Propose a new note, or new text for the note with this title (the whole text, not a diff). Start the content with a "# <title>" line; notes link to each other with [[Note Title]]. Changes nothing until the user approves it.',
        inputSchema: { type: 'object', properties: {
            title: str('The note\'s title (max 200 characters).'),
            content: str('The note\'s full markdown text (max 100 KB).'),
            notebook: str('Optional notebook to file it in ("Parent / Child" for a nested one); made if missing.')
        }, required: ['title', 'content'] },
        annotations: PROPOSE
    },
    {
        name: 'propose_note_order', title: 'Propose an order for the notes',
        description: 'Propose a new order for the notes: every note title, in the order wanted. Changes nothing until the user approves it.',
        inputSchema: { type: 'object', properties: {
            order: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 500, description: 'Note titles in the new order.' }
        }, required: ['order'] },
        annotations: PROPOSE
    },
    {
        name: 'list_my_proposals', title: 'List my pending proposals',
        description: 'The proposals made with this connection that still wait for the user: what each would do and whether it is out of date. Approved or rejected ones are no longer listed.',
        inputSchema: { type: 'object', properties: {} },
        annotations: READ
    }
];

const INSTRUCTIONS = [
    'TabPaladin holds this user\'s bookmarks and notes.',
    'Read them with search_bookmarks, list_folders, list_folder, get_bookmark, list_notes, read_note and search_notes.',
    'Propose changes with the propose_* tools. A proposal changes NOTHING: it waits until the user approves it in the TabPaladin app',
    '(Home › Suggested changes for bookmarks, Notes for notes). Never tell the user something was saved, moved or deleted before they approve it;',
    'tell them it is waiting for their approval. Name bookmarks and folders by the ids the tools return, never by guesses.',
    'Ask before proposing anything, and propose deletions only when the user asked for one.'
].join(' ');

class ToolError extends Error {}

const clamp = (v, min, max, def) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : def;
};
const opt = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

function text(value) {
    let out = JSON.stringify(value, null, 1);
    if (out.length > MAX_TOOL_TEXT) {
        out = JSON.stringify({ error: 'The answer was too large to send. Ask for less: use offset and limit, or a narrower folder or query.' });
        return { content: [{ type: 'text', text: out }], isError: true };
    }
    return { content: [{ type: 'text', text: out }] };
}
const failed = (message, extra = {}) => ({
    content: [{ type: 'text', text: JSON.stringify({ error: message, ...extra }, null, 1) }],
    isError: true
});

const bookmarkOut = (b) => ({ id: b.id, title: b.title, url: b.url, folderId: b.parentId, folderPath: pathText(b.path), ...(b.readOnly ? { readOnly: true } : {}) });
const folderOut = (f) => ({ id: f.id, title: f.title, path: pathText(f.path), folders: f.folders, bookmarks: f.bookmarks, ...(f.readOnly ? { readOnly: true } : {}) });

function makeToolRunner({ items, proposals }) {
    const PROPOSALS = {
        propose_create_folder: (a) => ({ action: 'create_folder', parentId: a.parentId, path: a.path, reason: a.reason }),
        propose_add_bookmarks: (a) => ({ action: 'add_bookmarks', folderId: a.folderId, bookmarks: a.bookmarks, reason: a.reason }),
        propose_move: (a) => ({ action: 'move', ids: a.ids, toFolderId: a.toFolderId, reason: a.reason }),
        propose_rename: (a) => ({ action: 'rename', id: a.id, title: a.title, reason: a.reason }),
        propose_delete: (a) => ({ action: 'delete', ids: a.ids, reason: a.reason }),
        propose_changes: (a) => ({ action: 'changes', changes: a.changes, reason: a.reason }),
        propose_note: (a) => ({ title: a.title, content: a.content, notebook: a.notebook }),
        propose_note_order: (a) => ({ action: 'reorder', order: a.order })
    };

    return function run(ctx, name, args) {
        const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
        const store = items.forUser(ctx.userId);
        const index = () => indexTree(store.readTree().roots);

        if (name === 'search_bookmarks') {
            const query = opt(a.query);
            if (!query) throw new ToolError('"query": the words to look for.');
            const idx = index();
            const folderId = opt(a.folderId);
            if (folderId && !idx.folderById.get(folderId)) throw new ToolError(`No folder with id ${folderId}.`);
            const r = searchBookmarks(idx, query.slice(0, 200), { limit: clamp(a.limit, 1, 100, 30), folderId });
            return text({ query, total: r.total, results: r.results.map(bookmarkOut) });
        }
        if (name === 'list_folders') {
            const idx = index();
            const offset = clamp(a.offset, 0, 1e6, 0);
            const page = idx.folders.slice(offset, offset + clamp(a.limit, 1, 500, 200));
            return text({
                total: idx.folders.length, offset,
                nextOffset: offset + page.length < idx.folders.length ? offset + page.length : null,
                folders: page.map(folderOut)
            });
        }
        if (name === 'list_folder') {
            const idx = index();
            let id = opt(a.folderId);
            if (!id && opt(a.path)) {
                const f = folderByPath(idx, a.path);
                if (!f) throw new ToolError(`No folder at path "${a.path}". list_folders shows every folder's path.`);
                id = f.id;
            }
            const view = folderContents(idx, id, { offset: clamp(a.offset, 0, 1e6, 0), limit: clamp(a.limit, 1, 500, 200) });
            if (!view) throw new ToolError(`No folder with id ${id}.`);
            return text({
                folder: view.folder ? folderOut(view.folder) : null,
                subfolders: view.subfolders.map(folderOut),
                bookmarks: view.bookmarks.map(b => ({ id: b.id, title: b.title, url: b.url })),
                totalBookmarks: view.total, offset: view.offset, nextOffset: view.nextOffset
            });
        }
        if (name === 'get_bookmark') {
            const id = opt(a.id);
            if (!id) throw new ToolError('"id": the bookmark\'s id.');
            const idx = index();
            const b = idx.bookmarkById.get(id);
            if (b) return text(bookmarkOut(b));
            const f = idx.folderById.get(id);
            if (f) return text({ folder: folderOut(f) });
            throw new ToolError(`No bookmark or folder with id ${id}.`);
        }
        if (name === 'list_notes') {
            let notes = store.listNotes();
            const nb = opt(a.notebook);
            if (nb) notes = notes.filter(n => notePath(n).toLowerCase() === nb.toLowerCase());
            notes.sort((x, y) => String(y.updatedAt || '').localeCompare(String(x.updatedAt || '')));
            const offset = clamp(a.offset, 0, 1e6, 0);
            const page = notes.slice(offset, offset + clamp(a.limit, 1, 200, 50));
            return text({
                total: notes.length, offset,
                nextOffset: offset + page.length < notes.length ? offset + page.length : null,
                notes: page.map(n => ({ id: n.id, title: n.title, notebook: notePath(n) || null, updatedAt: n.updatedAt, characters: (n.content || '').length }))
            });
        }
        if (name === 'read_note') {
            const notes = store.listNotes();
            const id = opt(a.id);
            const title = opt(a.title);
            if (!id && !title) throw new ToolError('"id" or "title" of the note.');
            const n = id ? notes.find(x => x.id === id)
                : notes.find(x => x.title === title) || notes.find(x => String(x.title).toLowerCase() === title.toLowerCase());
            if (!n) throw new ToolError(`No note ${id ? `with id ${id}` : `titled "${title}"`}.`);
            const content = String(n.content || '');
            const cap = MAX_TOOL_TEXT - 4096;
            return text({
                id: n.id, title: n.title, notebook: notePath(n) || null, updatedAt: n.updatedAt,
                content: content.length > cap ? content.slice(0, cap) : content,
                ...(content.length > cap ? { truncated: true, characters: content.length } : {})
            });
        }
        if (name === 'search_notes') {
            const query = opt(a.query);
            if (!query) throw new ToolError('"query": the words to look for.');
            const r = searchNotes(store.listNotes(), query.slice(0, 200), { limit: clamp(a.limit, 1, 50, 20) });
            return text({
                query, total: r.total,
                results: r.results.map(({ note, snippet }) => ({ id: note.id, title: note.title, notebook: notePath(note) || null, snippet }))
            });
        }
        if (PROPOSALS[name]) {
            let parsed;
            try {
                parsed = parseProposal(PROPOSALS[name](a));
            } catch (e) {
                if (e instanceof ChangeError) throw new ToolError(e.message);
                throw e;
            }
            const out = proposals.forUser(ctx.userId).propose(parsed, { source: 'mcp', tokenId: ctx.tokenId });
            if (!out.ok) return failed(out.error, out.problems ? { problems: out.problems } : {});
            return text({
                id: out.id,
                status: 'pending_approval',
                summary: out.summary,
                ...(out.preview ? { preview: out.preview.map(p => p.text) } : {}),
                message: 'Stored as a proposal. Nothing has changed yet: tell the user it is waiting for their approval in the TabPaladin app'
                    + (out.kind === 'tree' ? ' (Home › Suggested changes).' : ' (Notes).')
            });
        }
        if (name === 'list_my_proposals') {
            const list = proposals.forUser(ctx.userId).list({ tokenId: ctx.tokenId });
            return text({
                pending: list.map(p => ({
                    id: p.id, kind: p.kind, title: p.title, createdAt: p.createdAt, status: p.status,
                    ...(p.stale && p.stale.length ? { outOfDate: p.stale } : {}),
                    ...(p.preview && p.preview.length ? { preview: p.preview.map(x => x.text) } : {}),
                    ...(p.notebook ? { notebook: p.notebook } : {})
                })),
                note: 'Only proposals still waiting are listed; approved and rejected ones are gone.'
            });
        }
        throw new ToolError(`Unknown tool ${name}.`);
    };
}

// --- Routes -----------------------------------------------------------------------

const rpcError = (res, status, code, message, headers = {}) => {
    for (const [k, v] of Object.entries(headers)) res.set(k, v);
    res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
};

export function attachMcp(app, { db, items, proposals, requireAuth, env = process.env }) {
    const tokens = makeMcpTokenStore(db);
    const run = makeToolRunner({ items, proposals });
    const allowedOrigins = new Set(String(env.MCP_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean));
    const perMinute = Math.max(1, Number(env.MCP_RATE_LIMIT_PER_MINUTE || 120));
    const requests = makeRateLimiter({ max: perMinute, windowMs: 60 * 1000 });
    const badTokens = makeRateLimiter({ max: Math.max(1, Number(env.MCP_AUTH_MAX_FAILURES || 20)), windowMs: 15 * 60 * 1000 });
    const json = express.json({ limit: MCP_BODY_LIMIT });

    // --- Tokens, managed from the web app (a signed-in session only) ---
    const manage = [requireAuth, requireSession];
    app.get('/api/mcp/tokens', ...manage, (req, res) => {
        res.json({ ok: true, tokens: tokens.list(req.user.id), endpoint: `${req.protocol}://${req.get('host')}/mcp` });
    });
    app.post('/api/mcp/tokens', ...manage, (req, res) => {
        const raw = (req.body || {}).name;
        const name = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
        if (!name || name.length > MAX_TOKEN_NAME) {
            return res.status(400).json({ error: `Name: 1-${MAX_TOKEN_NAME} characters, so you can tell your tokens apart.` });
        }
        const made = tokens.create(req.user.id, name);
        if (made.full) return res.status(429).json({ error: `At most ${MAX_TOKENS_PER_USER} tokens per account; revoke one first.` });
        res.json({ ok: true, token: made.token, ...made.meta, endpoint: `${req.protocol}://${req.get('host')}/mcp` });
    });
    app.delete('/api/mcp/tokens/:id', ...manage, (req, res) => {
        const gone = tokens.revoke(req.user.id, Number(req.params.id));
        if (!gone) return res.status(404).json({ error: 'No such token.' });
        res.json({ ok: true });
    });

    // --- The endpoint ---
    app.all('/mcp', (req, res, next) => {
        res.set('Cache-Control', 'no-store');
        const origin = req.headers.origin;
        if (origin !== undefined && !allowedOrigins.has(origin)) {
            return rpcError(res, 403, -32000, 'Forbidden: requests from a web page (Origin header) are not accepted here.');
        }
        if (req.method !== 'POST') {
            return rpcError(res, 405, -32000, 'Method not allowed: this MCP endpoint is stateless and only takes POST.', { Allow: 'POST' });
        }
        const wait = badTokens.retryAfter(req.ip);
        if (wait) return rpcError(res, 429, -32000, 'Too many failed tokens. Try again later.', { 'Retry-After': String(wait) });
        const m = String(req.headers.authorization || '').match(/^Bearer\s+(\S+)\s*$/i);
        const row = m ? tokens.find(m[1]) : null;
        if (!row) {
            if (m) badTokens.fail(req.ip);
            return rpcError(res, 401, -32001, m
                ? 'Unauthorized: this token is unknown or was revoked. Make a new one in TabPaladin › Settings › AI chats.'
                : 'Unauthorized: send Authorization: Bearer <token>. Make a token in TabPaladin › Settings › AI chats.',
            { 'WWW-Authenticate': m ? 'Bearer realm="TabPaladin", error="invalid_token"' : 'Bearer realm="TabPaladin"' });
        }
        const key = `t${row.id}`;
        const busy = requests.retryAfter(key);
        if (busy) return rpcError(res, 429, -32000, 'Too many requests with this token. Slow down.', { 'Retry-After': String(busy) });
        requests.fail(key);
        tokens.touch(row);
        req.mcp = { userId: row.user_id, tokenId: row.id };
        json(req, res, (err) => {
            if (err) {
                const big = err.type === 'entity.too.large';
                return rpcError(res, big ? 413 : 400, big ? -32600 : -32700, big ? `Request body larger than ${MCP_BODY_LIMIT}.` : 'Parse error: invalid JSON.');
            }
            next();
        });
    }, async (req, res) => {
        const ctx = req.mcp;
        const server = new Server(SERVER_INFO, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
        server.setRequestHandler(CallToolRequestSchema, async (request) => {
            try {
                return run(ctx, request.params.name, request.params.arguments);
            } catch (e) {
                if (e instanceof ToolError) return failed(e.message);
                // The account went away under the token, or a bug: say
                // nothing more than that to the chat.
                if (/^No account with id/.test(e && e.message)) return failed('This account no longer exists.');
                console.error('[TabPaladin] MCP tool failed:', e);
                return failed('The tool failed on the server.');
            }
        });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on('close', () => {
            transport.close().catch(() => {});
            server.close().catch(() => {});
        });
        try {
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        } catch (e) {
            console.error('[TabPaladin] MCP request failed:', e);
            if (!res.headersSent) rpcError(res, 500, -32603, 'Internal error.');
        }
    });

    return { tokens };
}
