// LLM share links: a 1-hour link the user pastes into any AI chat that can
// browse. The chat reads the account's notes and bookmarks through it and
// proposes changes, which wait for the user's approval in the web app
// (proposals.js). Nothing is ever changed through a link.
//
//   POST /api/share                 (signed in) make a link: {url, expiresAt}
//   GET  /llm/:token                instructions, the folder index, the first
//                                   page of bookmarks, and every note
//   GET  /llm/:token/bookmarks      every bookmark, ?page=N (BOOKMARKS_PER_PAGE each)
//   GET  /llm/:token/folder/:id     one folder's subfolders and bookmarks, ?offset=N
//   GET  /llm/:token/search?q=…     bookmarks, folders and notes holding every word
//   POST /llm/:token/propose        a proposal: a note, an order, or bookmark
//   POST /llm/:token                changes (the same, for chats that POST to the page)
//
// Plain text, not text/markdown: some LLM fetch tools refuse text/markdown
// responses. Every page is bounded; the main page says how to read the rest.
// The link is the only credential: unguessable, expiring, and dead with its
// account.

import crypto from 'node:crypto';
import express from 'express';
import { indexTree, pathText, folderContents, searchBookmarks, searchFolders, searchNotes, notePath } from './library.js';
import { parseProposal } from './proposals.js';
import { ChangeError } from './treeChanges.js';

export const FOLDERS_ON_PAGE = 1000;
export const BOOKMARKS_ON_PAGE = 300;
export const BOOKMARKS_PER_PAGE = 500;
export const FOLDER_PAGE = 1000;
const URL_SHOWN = 500;

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const shownUrl = (u) => {
    const s = oneLine(u);
    return s.length > URL_SHOWN ? s.slice(0, URL_SHOWN) + '… (address cut short here)' : s;
};

export function attachLlmShareRoutes(app, { db, items, proposals, requireAuth, ttlMs }) {
    // The token and the account it shares. A token whose account was deleted
    // is as dead as an expired one.
    function validShare(req, res) {
        const row = db.prepare(`
            SELECT t.token, t.expires_at, t.user_id FROM share_tokens t JOIN users u ON u.id = t.user_id
            WHERE t.token = ?`).get(req.params.token);
        if (!row || Date.parse(row.expires_at) <= Date.now()) {
            res.status(410).json({ error: 'Share link expired or invalid.' });
            return null;
        }
        return row;
    }

    const originOf = (req) => `${req.protocol}://${req.get('host')}`;
    const baseOf = (req) => `${originOf(req)}/llm/${req.params.token}`;
    const send = (res, text) => res.type('text/plain; charset=utf-8').send(text);

    app.post('/api/share', requireAuth, (req, res) => {
        // Every account's expired tokens: they are dead whoever they belonged to.
        db.prepare('DELETE FROM share_tokens WHERE expires_at <= ?').run(new Date().toISOString());
        const token = crypto.randomUUID();
        const now = new Date();
        const expiresAt = new Date(now.getTime() + ttlMs);
        db.prepare('INSERT INTO share_tokens (token, created_at, expires_at, user_id) VALUES (?, ?, ?, ?)')
            .run(token, now.toISOString(), expiresAt.toISOString(), req.user.id);
        res.json({ ok: true, url: `${originOf(req)}/llm/${token}`, expiresAt: expiresAt.toISOString() });
    });

    const folderLine = (f) => {
        const parts = [];
        if (f.folders) parts.push(`${f.folders} folder${f.folders === 1 ? '' : 's'}`);
        if (f.bookmarks) parts.push(`${f.bookmarks} bookmark${f.bookmarks === 1 ? '' : 's'}`);
        return `[${f.id}] ${oneLine(pathText(f.path))}${parts.length ? ` (${parts.join(', ')})` : ' (empty)'}${f.readOnly ? ' — read-only' : ''}`;
    };
    const bookmarkLine = (b) => `- [${b.id}] ${oneLine(b.title)} — ${shownUrl(b.url)}`;

    // Bookmarks grouped under their folder's path, in tree order.
    function bookmarkBlock(index, list) {
        let out = '';
        let last = undefined;
        for (const b of list) {
            if (b.parentId !== last) {
                const f = b.parentId ? index.folderById.get(b.parentId) : null;
                out += `\n### ${oneLine(f ? pathText(f.path) : '(top level)')}${f ? ` [${f.id}]` : ''}${b.readOnly ? ' — read-only' : ''}\n`;
                last = b.parentId;
            }
            out += bookmarkLine(b) + '\n';
        }
        return out;
    }

    function notesSection(notes) {
        // Group notebooks together, loose notes first, keeping each group's
        // order. A nested notebook is headed by its path ('Work / Meetings').
        const groupOrder = [];
        const groups = new Map();
        for (const n of notes) {
            const key = (n.notebookPath && n.notebookPath.length ? n.notebookPath.join(' / ') : n.notebook) || '';
            if (!groups.has(key)) { groups.set(key, []); groupOrder.push(key); }
            groups.get(key).push(n);
        }
        groupOrder.sort((a, b) => (a === '') === (b === '') ? 0 : (a === '' ? -1 : 1));
        let md = `## Existing notes (${notes.length})\n\n`;
        if (notes.length === 0) md += `(no notes yet)\n\n`;
        for (const key of groupOrder) {
            md += `### 📓 Notebook: ${key || '(none)'}\n\n`;
            for (const n of groups.get(key)) {
                md += `#### ${n.title || 'Untitled'}\n\n${n.content || '(empty)'}\n\n---\n\n`;
            }
        }
        return md;
    }

    app.get('/llm/:token', (req, res) => {
        const share = validShare(req, res);
        if (!share) return;
        const store = items.forUser(share.user_id);
        const notes = store.listNotes();
        const index = indexTree(store.readTree().roots);
        const origin = originOf(req);
        const base = baseOf(req);
        const proposeUrl = `${base}/propose`;
        const writable = index.folders.find(f => f.role === 'bookmarks') || index.folders.find(f => !f.readOnly) || null;
        const exampleFolder = writable ? writable.id : '<folder id>';

        let md = `# TabPaladin — notes and bookmarks shared with an AI assistant\n\n`;
        md += `This temporary link works until ${share.expires_at} (UTC). You can READ the user's notes and bookmarks here and PROPOSE changes. `;
        md += `Nothing changes until the user approves it in the TabPaladin app.\n\n`;
        md += `!!! TO CREATE OR EDIT A NOTE, OR TO CHANGE BOOKMARKS, SEND A REQUEST LIKE THIS (the only way to write automatically) !!!\n\n`;
        md += `POST ${proposeUrl}\n`;
        md += `Content-Type: application/json\n\n`;
        md += `{"title": "Note Title", "content": "# Note Title\\n\\n...full note body...", "notebook": "optional notebook name"}\n\n`;
        md += `{"action": "create_folder", "parentId": "${exampleFolder}", "path": "New folder", "reason": "one line for the user: why"}\n\n`;
        md += `(A POST to this page's own URL with the same JSON body also works. Every bookmark change is described under "Bookmark changes" below.)\n\n`;
        md += `---\n\n## Instructions (READ CAREFULLY BEFORE DOING ANYTHING)\n\n`;
        md += `- You are viewing the user's personal note collection and bookmarks via a temporary link.\n`;
        md += `- Notes are plain markdown-ish text. A line starting with \`# \` is the note's title; notes reference each other with wikilinks like [[Note Title]]. Keep this styling when writing notes.\n`;
        md += `- Notes are organized into notebooks (named groups). When the user asks for a note about a topic, file it in the matching notebook via the optional "notebook" field (max 100 chars; created if missing). Omit it if no notebook fits.\n`;
        md += `- A notebook inside another is listed as "Parent / Child"; pass that whole path as "notebook" to file into it.\n`;
        md += `- You CANNOT create or edit notes or bookmarks directly. ALWAYS ask the user for approval first:\n`;
        md += `  1. Tell the user what you want to write or change and get their confirmation.\n`;
        md += `  2. POST the proposal to ${proposeUrl} as shown at the top of this page.\n`;
        md += `     - Notes: "title": max 200 chars. "content": max 100 KB, start it with a \`# <title>\` heading line.\n`;
        md += `     - If a note with the same title already exists, the proposal REPLACES its content upon approval — include the full new content, not a diff.\n`;
        md += `  3. After posting, tell the user the proposal is waiting for their approval in the TabPaladin app. NEVER claim a note or bookmark was saved or changed before the user approves it there.\n`;
        md += `- To REORDER existing notes, POST to the same URL: {"action": "reorder", "order": ["Title 1", "Title 2", "..."]} — every note title in the desired order (per notebook and for loose notes). Also requires user approval.\n`;
        md += `- If your tools cannot send POST requests, give the user a clickable review link instead. Formats:\n`;
        md += `  - One note: ${origin}/#note=<the full note markdown, percent-encoded>\n`;
        md += `  - Multiple notes at once: ${origin}/#notes=<percent-encoded JSON array like [{"content":"# Title\\n\\nbody","notebook":"optional"},...]>\n`;
        md += `  - Reorder notes: ${origin}/#reorder=<percent-encoded JSON array of note titles, e.g. ["Title 1","Title 2"]>\n`;
        md += `  - Bookmark changes: ${origin}/#changes=<percent-encoded JSON object {"changes":[...],"reason":"..."} as described below>\n`;
        md += `  - Start each note's markdown with a \`# <title>\` heading. Percent-encode AT MINIMUM: % as %25, newline as %0A, space as %20, & as %26, # as %23, ? as %3F.\n`;
        md += `  - Optionally append &notebook=<name> (also percent-encoded) to file the note in a notebook.\n`;
        md += `  - Example: ${origin}/#note=%23%20Shopping%0A%0A-%20milk&notebook=Recipes\n`;
        md += `  - The link opens a review screen in the user's app; nothing is saved until they approve it. Present it as a clickable markdown link like [Review and save this note](URL).\n\n`;

        md += `---\n\n## Bookmark changes\n\n`;
        md += `- Bookmarks and folders are named by the id in [brackets] below. Use those ids exactly; never guess one.\n`;
        md += `- Each POST is one proposal the user approves or rejects as a whole. Add "reason" (max 1000 chars) to say why; the user sees it.\n`;
        md += `- Kinds (POST each as JSON to ${proposeUrl}):\n`;
        md += `  - New folder: {"action": "create_folder", "parentId": "<folder id>", "path": "Name"} — "path" may be "A / B" to make nested folders; existing ones are reused.\n`;
        md += `  - Add bookmarks: {"action": "add_bookmarks", "folderId": "<folder id>", "bookmarks": [{"title": "Page title", "url": "https://…"}]} — http(s) only, max 100.\n`;
        md += `  - Move bookmarks or folders: {"action": "move", "ids": ["<id>", "…"], "toFolderId": "<folder id>"}\n`;
        md += `  - Rename a bookmark or folder: {"action": "rename", "id": "<id>", "title": "New name"}\n`;
        md += `  - Delete bookmarks or folders: {"action": "delete", "ids": ["<id>"]} — shown to the user as a DELETE; a folder goes with everything in it. Only propose this when the user asked for it.\n`;
        md += `  - Several at once, applied together: {"action": "changes", "reason": "…", "changes": [{"op": "create_folder", "parentId": "<folder id>", "path": "Reading", "ref": "reading"}, {"op": "move", "ids": ["<id>"], "toFolderRef": "reading"}]}\n`;
        md += `    ("op" takes the same kinds; "ref" names a folder created earlier in the same proposal, used as parentRef / folderRef / toFolderRef.)\n`;
        md += `- Read-only: folders marked "read-only" (Pinned, Workflows), the Notes notebooks (use note proposals) and imported archives (not shown).\n`;
        md += `- If something a proposal names changes before the user approves it, the proposal is marked out of date and nothing of it is applied.\n`;
        md += `- After posting, tell the user it is waiting in the TabPaladin app under Home › Suggested changes.\n\n`;

        md += `## Reading more\n\n`;
        md += `- Every bookmark, page by page (${BOOKMARKS_PER_PAGE} per page): GET ${base}/bookmarks?page=1\n`;
        md += `- One folder's contents: GET ${base}/folder/<folder id>\n`;
        md += `- Search bookmarks, folders and notes: GET ${base}/search?q=<words>\n\n`;

        const shownFolders = index.folders.slice(0, FOLDERS_ON_PAGE);
        md += `## Bookmark folders (${index.folders.length})\n\n`;
        if (!index.folders.length) md += `(no folders yet)\n`;
        for (const f of shownFolders) md += folderLine(f) + '\n';
        if (index.folders.length > shownFolders.length) {
            md += `\n(Only the first ${shownFolders.length} of ${index.folders.length} folders are listed here. Open a folder with GET ${base}/folder/<folder id> to see the ones inside it, or search.)\n`;
        }
        const first = index.bookmarks.slice(0, BOOKMARKS_ON_PAGE);
        md += `\n## Bookmarks (${index.bookmarks.length}${index.bookmarks.length > first.length ? `, the first ${first.length} shown` : ''})\n`;
        if (!index.bookmarks.length) md += `\n(no bookmarks yet)\n`;
        md += bookmarkBlock(index, first);
        if (index.bookmarks.length > first.length) {
            const pages = Math.ceil(index.bookmarks.length / BOOKMARKS_PER_PAGE);
            md += `\n(TRUNCATED: ${index.bookmarks.length - first.length} more bookmarks are not on this page. Read them all with GET ${base}/bookmarks?page=1 … ?page=${pages}, open a folder with GET ${base}/folder/<folder id>, or search with GET ${base}/search?q=<words>.)\n`;
        }
        md += `\n---\n\n`;
        md += notesSection(notes);
        send(res, md);
    });

    app.get('/llm/:token/bookmarks', (req, res) => {
        const share = validShare(req, res);
        if (!share) return;
        const index = indexTree(items.forUser(share.user_id).readTree().roots);
        const pages = Math.max(1, Math.ceil(index.bookmarks.length / BOOKMARKS_PER_PAGE));
        const page = Math.min(Math.max(1, parseInt(req.query.page, 10) || 1), pages);
        const list = index.bookmarks.slice((page - 1) * BOOKMARKS_PER_PAGE, page * BOOKMARKS_PER_PAGE);
        const base = baseOf(req);
        let md = `# TabPaladin bookmarks — page ${page} of ${pages} (${index.bookmarks.length} bookmarks)\n\n`;
        md += `Read-only. Ids are in [brackets]; to propose changes, see ${base}\n`;
        md += bookmarkBlock(index, list);
        if (!list.length) md += `\n(no bookmarks)\n`;
        md += page < pages ? `\nNext page: GET ${base}/bookmarks?page=${page + 1}\n` : `\n(This is the last page.)\n`;
        send(res, md);
    });

    app.get('/llm/:token/folder/:id', (req, res) => {
        const share = validShare(req, res);
        if (!share) return;
        const index = indexTree(items.forUser(share.user_id).readTree().roots);
        const base = baseOf(req);
        const view = folderContents(index, req.params.id, { offset: req.query.offset, limit: FOLDER_PAGE });
        if (!view) return send(res.status(404), `No folder with id ${oneLine(req.params.id)}. The folder index is at ${base}\n`);
        let md = `# Folder ${oneLine(pathText(view.folder.path))} [${view.folder.id}]${view.folder.readOnly ? ' — read-only' : ''}\n\n`;
        md += `## Folders in it (${view.subfolders.length})\n\n`;
        for (const f of view.subfolders) md += folderLine(f) + '\n';
        if (!view.subfolders.length) md += `(none)\n`;
        md += `\n## Bookmarks in it (${view.total}${view.total > view.bookmarks.length ? `, ${view.offset + 1}-${view.offset + view.bookmarks.length} shown` : ''})\n\n`;
        for (const b of view.bookmarks) md += bookmarkLine(b) + '\n';
        if (!view.total) md += `(none)\n`;
        if (view.nextOffset !== null) md += `\nMore: GET ${base}/folder/${encodeURIComponent(view.folder.id)}?offset=${view.nextOffset}\n`;
        md += `\nTo propose changes, see ${base}\n`;
        send(res, md);
    });

    app.get('/llm/:token/search', (req, res) => {
        const share = validShare(req, res);
        if (!share) return;
        const store = items.forUser(share.user_id);
        const q = oneLine(req.query.q).slice(0, 200);
        const base = baseOf(req);
        if (!q) return send(res, `Add ?q=<words> to search bookmarks, folders and notes. Example: GET ${base}/search?q=python%20tutorial\n`);
        const index = indexTree(store.readTree().roots);
        const bms = searchBookmarks(index, q, { limit: 100 });
        const folders = searchFolders(index, q, { limit: 30 });
        const notes = searchNotes(store.listNotes(), q, { limit: 30 });
        let md = `# Search for "${q}"\n\n`;
        md += `## Folders (${folders.length})\n\n`;
        for (const f of folders) md += folderLine(f) + '\n';
        if (!folders.length) md += `(none)\n`;
        md += `\n## Bookmarks (${bms.total}${bms.total > bms.results.length ? `, the first ${bms.results.length} shown` : ''})\n\n`;
        for (const b of bms.results) md += `${bookmarkLine(b)}  (in ${oneLine(pathText(b.path))})\n`;
        if (!bms.results.length) md += `(none)\n`;
        md += `\n## Notes (${notes.total}${notes.total > notes.results.length ? `, the first ${notes.results.length} shown` : ''})\n\n`;
        for (const { note, snippet } of notes.results) {
            md += `- ${oneLine(note.title || 'Untitled')}${notePath(note) ? ` (notebook: ${oneLine(notePath(note))})` : ''}: ${snippet}\n`;
        }
        if (!notes.results.length) md += `(none)\n`;
        md += `\nRead-only. To propose changes, see ${base}\n`;
        send(res, md);
    });

    function handleProposal(req, res) {
        const share = validShare(req, res);
        if (!share) return;
        let parsed;
        try {
            parsed = parseProposal(req.body);
        } catch (e) {
            if (e instanceof ChangeError) {
                // Anyone holding the link can post here: a full queue says
                // so before what is wrong with the request.
                const full = proposals.forUser(share.user_id).full();
                if (full) return res.status(429).json({ error: `There are already ${full} proposals waiting for the user's approval. Ask them to review those first.` });
                return res.status(400).json({ error: e.message });
            }
            throw e;
        }
        const out = proposals.forUser(share.user_id).propose(parsed, { source: 'link' });
        if (!out.ok) {
            return res.status(out.status || 400).json({ error: out.error, ...(out.problems ? { problems: out.problems } : {}) });
        }
        if (parsed.type === 'reorder') {
            return res.json({
                ok: true,
                status: 'pending_approval',
                message: 'Reorder proposal stored. It only applies after the user approves it in the TabPaladin app — tell them it is waiting for approval.'
            });
        }
        if (parsed.type === 'note') {
            return res.json({
                ok: true,
                status: 'pending_approval',
                message: 'Proposal stored. It only becomes a note after the user approves it in the TabPaladin app — tell them it is waiting for approval.'
            });
        }
        res.json({
            ok: true,
            status: 'pending_approval',
            id: out.id,
            summary: out.summary,
            preview: out.preview.map(p => p.text),
            message: 'Proposal stored. Nothing changes until the user approves it in the TabPaladin app (Home › Suggested changes) — tell them it is waiting for approval.'
        });
    }

    app.post('/llm/:token/propose', express.json({ limit: '1mb' }), handleProposal);
    // Some LLMs guess POST on the share URL itself — accept it as an alias.
    app.post('/llm/:token', express.json({ limit: '1mb' }), handleProposal);
}
