// Proposals from AI chats, waiting for the account's approval.
//
// Two ways in, one queue: the 1-hour LLM share link (/llm/:token/propose,
// llmShare.js) and the MCP endpoint (/mcp, mcp.js). Neither can change
// anything: a proposal is a row in note_proposals until the account approves
// it in the web app, which applies it on the server in one transaction (and
// pulls), or rejects it, which drops the row.
//
// Kinds:
//   note     create or replace a note by title (as always)
//   reorder  a new order for the notes (as always)
//   tree     changes to the bookmark tree: new folders, new bookmarks,
//            moves, renames, deletes (treeChanges.js), applied together or
//            not at all. The changes and the fingerprints of every node they
//            name are kept in `payload`; a proposal whose nodes changed since
//            is stale, shown as such and never applied. Its title and preview
//            are planned again against the tree whenever it is listed, and
//            the web app approves the preview it showed (`reviewed`): one
//            that now reads otherwise is refused (409 changed).
//
// The table predates this: its additive columns are added here (schema 5).
// GET /api/proposals keeps its old answer, note and reorder rows only, for
// clients that know no other kind; GET /api/proposals/review has everything,
// with a preview of each and whether it is stale.

import { newId } from './items.js';
import { normalizeChanges, normalizeReason, planChanges, ChangeError, treeOp } from './treeChanges.js';

const COLUMNS = [
    ['payload', 'TEXT'],          // tree: {v: 1, changes, fingerprints}
    ['reason', 'TEXT'],           // why the chat proposes it, shown to the user
    ['source', 'TEXT'],           // 'link' (share link) | 'mcp'; NULL on older rows: the link
    ['token_id', 'INTEGER'],      // the MCP token that made it
    ['base_version', 'INTEGER']   // the tree version it was made against
];

export const NOTE_KINDS = ['note', 'reorder'];
export const MAX_NOTE_TITLE = 200;
export const MAX_NOTE_BYTES = 100 * 1024;
export const MAX_NOTEBOOK = 100;
// How many of a refused proposal's problems, and of a stale one's reasons,
// are sent back: enough to act on, never megabytes of them.
export const MAX_PROBLEMS = 50;
export const MAX_STALE = 20;

// The first `max` of a list of messages, and one more saying how many were left out.
export function capMessages(list, max, what) {
    if (!Array.isArray(list) || list.length <= max) return list;
    return [...list.slice(0, max), `… and ${list.length - max} more ${what}.`];
}

// Additive and idempotent, one transaction; runs after the ownership
// migration has given note_proposals its user_id.
export function migrateProposals(db) {
    return db.transaction(() => {
        const have = db.prepare('PRAGMA table_info(note_proposals)').all().map(c => c.name);
        if (!have.length) throw new Error('note_proposals is missing');
        if (!have.includes('user_id')) throw new Error('note_proposals has no user_id yet: the ownership migration has to run first');
        const added = [];
        for (const [name, type] of COLUMNS) {
            if (have.includes(name)) continue;
            db.exec(`ALTER TABLE note_proposals ADD COLUMN ${name} ${type}`);
            added.push(name);
        }
        return { added };
    })();
}

// --- What a chat sends ----------------------------------------------------------

// {type: 'note', title, content, notebook} | {type: 'reorder', order} |
// {type: 'tree', changes, reason}, from a share-link POST body or an MCP tool.
// Throws ChangeError (400) with a message meant for the chat.
//
// A body carrying a note's text ("content") is a note whatever its "action"
// says, unless it is a reorder or carries a "changes" list, as the link took
// it before bookmark changes existed: chats that guessed an action for a
// note ("create", "update", …) keep working.
export function parseProposal(body) {
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    if (b.action === 'reorder') {
        const order = b.order;
        if (!Array.isArray(order) || order.length === 0 || order.length > 500
            || !order.every(t => typeof t === 'string' && t.trim() && t.length <= 200)) {
            throw new ChangeError('Invalid "order" (array of 1-500 note titles).');
        }
        return { type: 'reorder', order: order.map(t => t.trim()) };
    }
    const noteShaped = typeof b.content === 'string' && !Array.isArray(b.changes);
    if (!noteShaped && (Array.isArray(b.changes) || b.action === 'changes')) {
        return { type: 'tree', changes: normalizeChanges(b.changes), reason: normalizeReason(b.reason) };
    }
    if (!noteShaped && treeOp(b.action)) {
        const { action, reason, ...rest } = b;
        return { type: 'tree', changes: normalizeChanges([{ ...rest, op: action }]), reason: normalizeReason(reason) };
    }
    if (!noteShaped && b.action !== undefined && b.action !== null && b.action !== '' && b.action !== 'note') {
        throw new ChangeError('Unknown "action": use create_folder, add_bookmarks, move, rename, delete, changes or reorder, or send a note as {"title", "content"}.');
    }
    const { title, content, notebook } = b;
    if (typeof title !== 'string' || !title.trim() || title.length > MAX_NOTE_TITLE) {
        throw new ChangeError('Missing or invalid "title" (non-empty string, max 200 chars).');
    }
    if (typeof content !== 'string' || content.length > MAX_NOTE_BYTES) {
        throw new ChangeError('Missing or invalid "content" (string, max 100 KB).');
    }
    if (notebook != null && (typeof notebook !== 'string' || !notebook.trim() || notebook.length > MAX_NOTEBOOK)) {
        throw new ChangeError('Invalid "notebook" (string, max 100 chars).');
    }
    return { type: 'note', title: title.trim(), content, notebook: notebook ? notebook.trim() : null };
}

// --- The queue ------------------------------------------------------------------

export function makeProposalsStore(db, { items, maxPending = 200 }) {
    function forUser(uid) {
        const userId = Number(uid);
        const tree = items.forUser(userId); // throws for an account that is gone

        const pendingCount = () => db.prepare('SELECT COUNT(*) AS n FROM note_proposals WHERE user_id = ?').get(userId).n;
        const insert = (p, origin) => db.prepare(`
            INSERT INTO note_proposals (title, content, notebook, kind, created_at, user_id, payload, reason, source, token_id, base_version)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(p.title, p.content, p.notebook || null, p.kind, new Date().toISOString(), userId,
            p.payload || null, p.reason || null, origin.source || 'link', origin.tokenId || null, tree.version()).lastInsertRowid;
        const del = (id) => db.prepare('DELETE FROM note_proposals WHERE id = ? AND user_id = ?').run(id, userId).changes;
        const tokenNames = () => {
            const out = new Map();
            for (const r of db.prepare('SELECT id, name FROM mcp_tokens WHERE user_id = ?').all(userId)) out.set(r.id, r.name);
            return out;
        };

        // Anyone holding a share link, or a token, can add here without
        // signing in, so pending proposals are capped per account. Refused,
        // never pruned. {full: n} when there is no room.
        function full() {
            const n = pendingCount();
            return n >= maxPending ? n : 0;
        }

        // `parsed` from parseProposal; `origin` {source: 'link' | 'mcp',
        // tokenId?}. {ok, id, kind, summary, preview?} or {ok: false,
        // status, error, problems?}.
        function propose(parsed, origin = { source: 'link' }) {
            const n = full();
            if (n) {
                return { ok: false, status: 429, error: `There are already ${n} proposals waiting for the user's approval. Ask them to review those first.` };
            }
            if (parsed.type === 'reorder') {
                const id = insert({ title: 'Reorder notes', content: JSON.stringify(parsed.order), kind: 'reorder' }, origin);
                return { ok: true, id: Number(id), kind: 'reorder', summary: 'Reorder notes' };
            }
            if (parsed.type === 'note') {
                const id = insert({ title: parsed.title, content: parsed.content, notebook: parsed.notebook, kind: 'note' }, origin);
                return { ok: true, id: Number(id), kind: 'note', summary: `Note ${parsed.title}` };
            }
            const plan = planChanges(tree.treeRows(), parsed.changes, { newId });
            if (!plan.ok) {
                return {
                    ok: false, status: 400, error: 'These changes do not fit the tree as it is now. Nothing was stored.',
                    problems: capMessages(plan.problems, MAX_PROBLEMS, 'problems')
                };
            }
            const payload = JSON.stringify({ v: 1, changes: parsed.changes, fingerprints: plan.fingerprints });
            const id = insert({ title: plan.summary, content: '', kind: 'tree', payload, reason: parsed.reason }, origin);
            return { ok: true, id: Number(id), kind: 'tree', summary: plan.summary, preview: plan.preview, counts: plan.counts, danger: plan.danger };
        }

        // A tree proposal against the tree as it is: {status, stale, preview,
        // counts, danger, reviewKey, summary}, or a corrupt one marked stale.
        // `danger` comes from the whole plan, never from the shortened preview.
        function review(row, rows) {
            let payload = null;
            try { payload = JSON.parse(row.payload || 'null'); } catch (e) { /* corrupt */ }
            if (!payload || !Array.isArray(payload.changes)) {
                return { status: 'stale', stale: ['This proposal could not be read. Reject it.'], preview: [], counts: {}, danger: false, reviewKey: null, summary: null };
            }
            const plan = planChanges(rows, payload.changes, { fingerprints: payload.fingerprints || {}, newId });
            return {
                status: plan.ok ? 'pending' : 'stale',
                stale: capMessages(plan.stale, MAX_STALE, 'reasons'),
                preview: plan.preview,
                counts: plan.counts,
                danger: plan.danger,
                reviewKey: plan.reviewKey,
                summary: plan.summary
            };
        }

        function shape(row, rows, names) {
            const out = {
                id: row.id,
                kind: row.kind,
                title: row.title,
                createdAt: row.created_at,
                source: row.source || 'link',
                tokenName: row.token_id ? (names.get(row.token_id) || null) : null,
                tokenId: row.token_id || null,
                reason: row.reason || null,
                baseVersion: row.base_version === null ? null : Number(row.base_version)
            };
            if (row.kind === 'tree') {
                // Titled by what it would do now; one out of date keeps the
                // title it was made with, which says what was proposed.
                const { summary, ...r } = review(row, rows);
                return { ...out, ...r, title: r.status === 'pending' && summary ? summary : row.title };
            }
            return { ...out, content: row.content, notebook: row.notebook, status: 'pending', stale: [], preview: [] };
        }

        // Every pending proposal, newest first, with previews; `tokenId`
        // narrows it to one MCP token's.
        function list({ tokenId = null } = {}) {
            const rows = tokenId === null
                ? db.prepare('SELECT * FROM note_proposals WHERE user_id = ? ORDER BY created_at DESC, id DESC').all(userId)
                : db.prepare('SELECT * FROM note_proposals WHERE user_id = ? AND token_id = ? ORDER BY created_at DESC, id DESC').all(userId, tokenId);
            const needTree = rows.some(r => r.kind === 'tree');
            const treeRows = needTree ? tree.treeRows() : [];
            const names = rows.some(r => r.token_id) ? tokenNames() : new Map();
            return rows.map(r => shape(r, treeRows, names));
        }

        // The old answer: notes and orders only, as the rows always were.
        function legacyList() {
            return db.prepare(`
                SELECT id, title, content, notebook, kind, created_at FROM note_proposals
                WHERE user_id = ? AND kind IN ('note', 'reorder') ORDER BY created_at DESC
            `).all(userId);
        }

        // {ok, version, kind} | {ok: false, status, error, code?, stale?}.
        // One transaction: the change, the version, history and the row.
        // `reviewed`: the reviewKey of the preview the user approved; when
        // given, a plan that now reads otherwise is refused (409 changed),
        // so nothing is applied that the user was not shown.
        function approve(id, { reviewed = null } = {}) {
            const row = db.prepare('SELECT id, title, content, notebook, kind, payload FROM note_proposals WHERE id = ? AND user_id = ?')
                .get(id, userId);
            if (!row) return { ok: false, status: 404, error: 'Proposal not found' };
            if (row.kind === 'tree') {
                let payload = null;
                try { payload = JSON.parse(row.payload || 'null'); } catch (e) { /* corrupt */ }
                if (!payload || !Array.isArray(payload.changes)) return { ok: false, status: 400, error: 'Corrupt proposal.' };
                const out = tree.applyTreeChanges(
                    (rows) => {
                        const plan = planChanges(rows, payload.changes, { fingerprints: payload.fingerprints || {}, newId });
                        if (plan.ok && reviewed && plan.reviewKey !== reviewed) return { ok: false, changed: true };
                        return plan;
                    },
                    { deviceId: 'ai-proposal', after: () => del(row.id) }
                );
                if (!out.ok && out.changed) {
                    return {
                        ok: false, status: 409, code: 'changed',
                        error: 'This suggestion would now do something other than what you were shown, so nothing was applied. Look at it again.'
                    };
                }
                if (!out.ok) {
                    return {
                        ok: false, status: 409, code: 'stale', stale: capMessages(out.stale || [], MAX_STALE, 'reasons'),
                        error: 'The tree changed since this was proposed, so nothing was applied. Reject it and ask again.'
                    };
                }
                return { ok: true, kind: 'tree', version: out.version, counts: out.counts };
            }
            const result = db.transaction(() => {
                const r = tree.applyNoteProposal(row);
                if (r.ok) del(row.id);
                return r;
            })();
            if (!result.ok) return { ok: false, status: 400, error: result.error };
            return { ok: true, kind: row.kind, version: tree.version() };
        }

        function reject(id) {
            del(id);
            return { ok: true };
        }

        return { userId, propose, list, legacyList, approve, reject, full };
    }
    return { forUser };
}

// --- Routes for the web app -------------------------------------------------------

export function attachProposalRoutes(app, { store, requireAuth }) {
    const fail = (res, out) => res.status(out.status || 400).json({
        error: out.error, ...(out.code ? { code: out.code } : {}), ...(out.stale ? { stale: out.stale } : {}),
        ...(out.problems ? { problems: out.problems } : {})
    });

    app.get('/api/proposals', requireAuth, (req, res) => {
        res.json({ ok: true, proposals: store.forUser(req.user.id).legacyList() });
    });

    app.get('/api/proposals/review', requireAuth, (req, res) => {
        res.json({ ok: true, proposals: store.forUser(req.user.id).list() });
    });

    // Changes a chat handed the user as a review link (#changes=… in the web
    // app), for chats that cannot POST: the signed-in app files them here,
    // as a proposal like any other. Tree changes only; notes have their own
    // review links.
    app.post('/api/proposals', requireAuth, (req, res) => {
        let parsed;
        try {
            parsed = parseProposal(req.body);
        } catch (e) {
            if (e instanceof ChangeError) return res.status(400).json({ error: e.message });
            throw e;
        }
        if (parsed.type !== 'tree') return res.status(400).json({ error: 'Only bookmark changes are filed here.' });
        const out = store.forUser(req.user.id).propose(parsed, { source: 'link' });
        if (!out.ok) return fail(res, out);
        res.json(out);
    });

    // Body (optional): {reviewed: <the reviewKey of the preview shown>}.
    app.post('/api/proposals/:id/approve', requireAuth, (req, res) => {
        const r = (req.body || {}).reviewed;
        const reviewed = typeof r === 'string' && r && r.length <= 100 ? r : null;
        const out = store.forUser(req.user.id).approve(req.params.id, { reviewed });
        if (!out.ok) return fail(res, out);
        res.json(out);
    });

    app.post('/api/proposals/:id/reject', requireAuth, (req, res) => {
        res.json(store.forUser(req.user.id).reject(req.params.id));
    });
}
