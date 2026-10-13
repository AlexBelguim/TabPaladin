// POST /api/workflows: save one workflow (a browser window's tabs) straight
// into the server's tree.
//
// The extension saves a workflow into its working copy and pushes the whole
// copy, with whatever else is unpushed in it. This verb lets a client send
// just the workflow instead: one folder and its tabs, appended under the
// account's existing workflows root as one 'append' op (items.appendWorkflow),
// exactly as a link filed from the share sheet is. Other devices fold it in
// through GET /api/tree/ops; the client that sent it already holds every id
// and skips them all. Nothing uses it yet: the web app's Create Workflow does,
// from the release that adds the browser helper.
//
//   POST /api/workflows
//   {workflow: {id, title, createdAt, tabs: [{id, title, url}]}, rootId,
//    expectUserId?, expectServerId?}
//
//   200 {ok, baseVersion, version, created: [node], already: [id], userId, serverId}
//   400 a malformed request, a refused URL, too many tabs
//   409 {code: 'no-root', rootId}  no workflows root here, or not that one:
//                                  nothing is written and no root is made
//   409 {code: 'conflict', ids}    an id is already something else here (or
//                                  another account's): nothing is written
//   412 {code: 'wrong-account'}    expectUserId / expectServerId name another
//                                  account or server, as PUT /api/tree does
//
// Ids are the client's, so a retry after a lost answer changes nothing and
// answers with the same ids under `already`.
//
// Tab URLs pass the same allowlist the browser helper opens tabs through:
// http, https, and file: on this computer only. javascript:, data:,
// view-source:, the browsers' own pages and extension pages are refused, and
// so is a file: URL naming another machine (\\server\share), which Windows
// would try to reach and hand the user's NTLM hash to.
//
// Top-level on purpose: the Dockerfile copies server/*.js and server/imports
// only, and a module in a new subdirectory would crash-loop the container.

import express from 'express';

export const MAX_TABS = 500;
export const MAX_URL_BYTES = 8 * 1024;
export const MAX_TITLE = 1000;
// Same shape as the ids appendToFolders takes from clients (items.js).
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
// The body may carry MAX_TABS URLs of MAX_URL_BYTES each, with titles.
export const BODY_LIMIT = '6mb';

// Why a tab URL may not be saved (or opened), or null when it may.
export function tabUrlProblem(url) {
    if (typeof url !== 'string' || !url) return 'not a URL';
    if (Buffer.byteLength(url, 'utf8') > MAX_URL_BYTES) return `longer than ${MAX_URL_BYTES} bytes`;
    if (/[\u0000-\u001f\u007f]/.test(url)) return 'holds control characters';
    if (url !== url.trim()) return 'starts or ends with spaces';
    let u;
    try { u = new URL(url); } catch (e) { return 'not a URL'; }
    if (u.protocol === 'http:' || u.protocol === 'https:') return null;
    if (u.protocol === 'file:') {
        // This computer's own files only: no host ('localhost' parses to
        // none), and no path that turns into one (//server/share, \\server).
        if (u.host) return 'a file on another machine';
        let decoded = u.pathname;
        try { decoded = decodeURIComponent(u.pathname); } catch (e) { return 'not a URL'; }
        if (/^\/?[\\/]{2}/.test(u.pathname) || /^\/?[\\/]{2}/.test(decoded)) return 'a file on another machine';
        return null;
    }
    return `${u.protocol} URLs are not saved`;
}

class BadRequest extends Error {
    constructor(message) { super(message); this.status = 400; }
}

// The request as items.appendWorkflow takes it, or a BadRequest.
export function parseWorkflowRequest(body) {
    const b = body && typeof body === 'object' ? body : {};
    if (typeof b.rootId !== 'string' || !b.rootId || b.rootId.length > 64) throw new BadRequest('rootId: the id of your workflows folder.');
    const w = b.workflow && typeof b.workflow === 'object' ? b.workflow : null;
    if (!w) throw new BadRequest('workflow: {id, title, createdAt, tabs}.');
    if (typeof w.id !== 'string' || !CLIENT_ID_RE.test(w.id)) throw new BadRequest('workflow.id: 8-64 letters, digits, - or _.');
    if (typeof w.title !== 'string' || !w.title.trim()) throw new BadRequest('workflow.title: a name.');
    if (w.title.length > MAX_TITLE) throw new BadRequest(`workflow.title: at most ${MAX_TITLE} characters.`);
    let createdAt = new Date().toISOString();
    if (w.createdAt !== undefined && w.createdAt !== null) {
        if (typeof w.createdAt !== 'string' || w.createdAt.length > 40 || !Number.isFinite(Date.parse(w.createdAt))) {
            throw new BadRequest('workflow.createdAt: an ISO date.');
        }
        createdAt = w.createdAt;
    }
    if (!Array.isArray(w.tabs)) throw new BadRequest('workflow.tabs: an array of {id, title, url}.');
    if (w.tabs.length > MAX_TABS) throw new BadRequest(`workflow.tabs: at most ${MAX_TABS}.`);
    const ids = new Set([w.id]);
    const tabs = w.tabs.map((t, i) => {
        if (!t || typeof t !== 'object') throw new BadRequest(`workflow.tabs[${i}]: {id, title, url}.`);
        if (typeof t.id !== 'string' || !CLIENT_ID_RE.test(t.id)) throw new BadRequest(`workflow.tabs[${i}].id: 8-64 letters, digits, - or _.`);
        if (ids.has(t.id)) throw new BadRequest(`workflow.tabs[${i}].id: used twice.`);
        ids.add(t.id);
        const problem = tabUrlProblem(t.url);
        if (problem) throw new BadRequest(`workflow.tabs[${i}].url: ${problem}.`);
        if (t.title !== undefined && t.title !== null && typeof t.title !== 'string') throw new BadRequest(`workflow.tabs[${i}].title: a string.`);
        if (typeof t.title === 'string' && t.title.length > MAX_TITLE) throw new BadRequest(`workflow.tabs[${i}].title: at most ${MAX_TITLE} characters.`);
        // An untitled tab is saved under its URL, as saveWorkflow does.
        return { id: t.id, title: t.title || t.url, url: t.url };
    });
    return { rootId: b.rootId, workflow: { id: w.id, title: w.title, createdAt, tabs } };
}

export function attachWorkflowRoutes(app, { items, requireAuth, serverId = null }) {
    app.post('/api/workflows', requireAuth, express.json({ limit: BODY_LIMIT }), (req, res) => {
        const b = req.body || {};
        const otherUser = b.expectUserId !== undefined && b.expectUserId !== null && Number(b.expectUserId) !== req.user.id;
        const otherServer = b.expectServerId !== undefined && b.expectServerId !== null && serverId && String(b.expectServerId) !== serverId;
        if (otherUser || otherServer) {
            return res.status(412).json({
                error: otherServer ? 'This workflow belongs to an account on another server.' : 'This workflow belongs to another account.',
                code: 'wrong-account', userId: req.user.id, serverId
            });
        }
        let request;
        try {
            request = parseWorkflowRequest(b);
        } catch (e) {
            if (e.status === 400) return res.status(400).json({ error: e.message });
            throw e;
        }
        try {
            const out = items.forUser(req.user.id).appendWorkflow(request);
            if (!out.ok && out.code === 'no-root') {
                return res.status(409).json({
                    error: 'There is no such workflows folder on the server. Nothing was saved.',
                    code: 'no-root', rootId: out.rootId, userId: req.user.id, serverId
                });
            }
            if (!out.ok) {
                return res.status(409).json({
                    error: 'Some of these ids are already something else on the server. Nothing was saved.',
                    code: 'conflict', ids: out.ids, userId: req.user.id, serverId
                });
            }
            res.json({
                ok: true, baseVersion: out.baseVersion, version: out.version,
                created: out.created, already: out.already, userId: req.user.id, serverId
            });
        } catch (e) {
            console.error('[TabPaladin] Saving a workflow failed:', e);
            res.status(500).json({ error: 'The workflow could not be saved.' });
        }
    });
}
