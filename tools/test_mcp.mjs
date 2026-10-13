// Tests for the MCP endpoint (server/mcp.js) and its tokens, against a live
// server, through the official SDK's client as an MCP client would connect
// and with plain requests for what a client should never get away with.
//
// What this locks down:
//   1. Tokens: only a signed-in session makes, lists and revokes them (not
//      the legacy AUTH_TOKEN, not an MCP token); a token is shown once and
//      only its SHA-256 hash is stored; names are required; last use is kept.
//   2. The protocol: initialize (stateless: no session id), tools/list with
//      every read and propose tool, read tools marked read-only, the
//      instructions saying nothing changes before approval; GET and DELETE
//      answer 405; an unsupported protocol version is refused.
//   3. Tool calls: search, folder index and views (by id and by path), one
//      bookmark, notes listed, read (a huge one cut short) and searched;
//      every propose_* tool files a pending proposal with a preview that
//      changes nothing, list_my_proposals shows this token's only, and bad
//      requests come back as tool errors with the reasons.
//   4. Auth: no token, a wrong one, a session token, a token in the URL and
//      a revoked one are 401 (with WWW-Authenticate); an MCP token opens
//      nothing under /api; a password change revokes the account's tokens,
//      and deleting an account kills its tokens; a browser Origin is 403
//      unless MCP_ALLOWED_ORIGINS lists it.
//   5. Isolation: another account's token never sees, names or proposes
//      against this account's items, and its proposals never show up here.
//   6. Limits: requests per token per minute (429 with Retry-After), bad
//      tokens per IP, and the body size (413).
//   3b. Long answers: every answer, errors included, at most 100 KB of
//      UTF-8 — a note of short lines read in parts with offset, a refusal
//      naming 10000 unknown ids, list_my_proposals paged.
//   And CORS for an origin MCP_ALLOWED_ORIGINS lists (preflight answered by
//   /mcp, even when CORS_ORIGIN lists it too), and a password change ending
//   the account's share links as well as its tokens.
//   And the stdio bridge (tools/mcp_bridge.mjs) carries a stdio client, as
//   Claude Desktop starts one, to the endpoint and back.
//
// Run: node tools/test_mcp.mjs [--port 18991]
// Starts this checkout's server on the port with a throwaway data directory.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from '../server/node_modules/better-sqlite3/lib/index.js';
import { Client } from '../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import { StdioClientTransport } from '../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback = null) => {
    const i = process.argv.indexOf('--' + name);
    return i === -1 ? fallback : process.argv[i + 1];
};
const PORT = Number(arg('port') || 18991);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'correct horse battery';
const LEGACY = 'legacy-token-' + 'x'.repeat(40);
const PER_MINUTE = 60;
const BAD_TOKENS = 12;
const ALLOWED_ORIGIN = 'https://inspector.example';

let failures = 0;
function check(name, cond, detail) {
    if (cond) console.log(`  ok  ${name}`);
    else { failures++; console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-mcp-'));
const env = { ...process.env };
for (const k of Object.keys(env)) if (/^(AUTH_TOKEN|ADMIN_|TENANCY_OWNER|IMPORT_|MAX_|MCP_)/.test(k)) delete env[k];
const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
        ...env, PORT: String(PORT), DATA_DIR: dataDir, PWA_DIR: path.join(ROOT, 'pwa'), ADMIN_USERNAME: 'alex', ADMIN_PASSWORD: PASSWORD,
        IMPORTS_SCHEDULER: 'off', AUTH_TOKEN: LEGACY, MCP_RATE_LIMIT_PER_MINUTE: String(PER_MINUTE),
        MCP_AUTH_MAX_FAILURES: String(BAD_TOKENS), MCP_ALLOWED_ORIGINS: ALLOWED_ORIGIN, CORS_ORIGIN: ALLOWED_ORIGIN
    },
    stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
const exited = new Promise(r => server.on('exit', r));
const ready = new Promise((resolve, reject) => {
    const onData = (d) => { serverLog += d; if (/Server listening/.test(serverLog)) resolve(); };
    server.stdout.on('data', onData);
    server.stderr.on('data', onData);
    exited.then(() => reject(new Error(serverLog)));
    setTimeout(() => reject(new Error('server did not start: ' + serverLog)), 20000);
});

async function api(p, { method = 'GET', token, body, headers = {} } = {}) {
    const res = await fetch(BASE + p, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
        body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
}

// A raw MCP request, as a client would POST it.
const MCP_HEADERS = { Accept: 'application/json, text/event-stream' };
let rpcId = 0;
const rpc = (token, method, params = {}, headers = {}) => api('/mcp', {
    method: 'POST', token, headers: { ...MCP_HEADERS, ...headers }, body: { jsonrpc: '2.0', id: ++rpcId, method, params }
});

async function connect(token) {
    const client = new Client({ name: 'tabpaladin-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(BASE + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + token } } });
    await client.connect(transport);
    return { client, transport };
}
// A tool's answer: {error, data}.
async function tool(client, name, args = {}) {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content && r.content[0] && r.content[0].text) || '';
    let data = null;
    try { data = JSON.parse(text); } catch (e) { /* not json */ }
    return { isError: Boolean(r.isError), data, text };
}

const T = '2026-10-01T00:00:00.000Z';
const bm = (id, title, url) => ({ id, kind: 'bookmark', title, url });
const folder = (id, title, children = [], extra = {}) => ({ id, kind: 'folder', title, children, ...extra });

const clients = [];
try {
    await ready;
    const login = async (username, password = PASSWORD) => (await api('/api/login', { method: 'POST', body: { username, password } })).json.token;
    const A = await login('alex');
    for (const [name, pw] of [['sam', 'sam-password-1'], ['kim', 'kim-password-1']]) {
        const made = await api('/api/users', { method: 'POST', token: A, body: { username: name, password: pw, role: 'user', currentPassword: PASSWORD } });
        if (made.status !== 200) throw new Error('could not make ' + name + ': ' + made.text);
    }
    const S = await login('sam', 'sam-password-1');
    const K = await login('kim', 'kim-password-1');

    const t0 = (await api('/api/tree', { token: A })).json;
    const root = t0.roots.find(r => r.role === 'bookmarks');
    const huge = '# Huge\n\n' + 'lorem ipsum '.repeat(15000);
    const roots = [
        folder(root.id, 'Bookmarks', [
            folder('f-tech', 'Tech', [folder('f-ai', 'AI', [bm('b-paper', 'Attention paper', 'https://arxiv.org/abs/1706.03762')]),
                bm('b-hn', 'Hacker News', 'https://news.ycombinator.com')]),
            folder('f-inbox', 'Inbox', [bm('b-mdn', 'MDN Web Docs', 'https://developer.mozilla.org')])
        ], { role: 'bookmarks' }),
        folder('f-notes', 'Notes', [
            { id: 'n-diary', kind: 'note', title: 'Diary', payload: { content: '# Diary\n\nWent hiking in the Ardennes.', createdAt: T, updatedAt: '2026-10-02T00:00:00.000Z' } },
            folder('f-work', 'Work', [{ id: 'n-huge', kind: 'note', title: 'Huge', payload: { content: huge, createdAt: T, updatedAt: T } }])
        ], { role: 'notes' })
    ];
    if ((await api('/api/tree', { method: 'PUT', token: A, body: { roots, baseVersion: t0.version } })).status !== 200) throw new Error('alex push');
    const ts = (await api('/api/tree', { token: S })).json;
    const samRoots = [folder('s-bm', 'Bookmarks', [folder('s-f1', 'Sam private', [bm('s-b1', 'Sam secret page', 'https://sam-secret.example')])], { role: 'bookmarks' })];
    if ((await api('/api/tree', { method: 'PUT', token: S, body: { roots: samRoots, baseVersion: ts.version } })).status !== 200) throw new Error('sam push');

    console.log('\n1. Tokens');
    check('listing tokens needs a session', (await api('/api/mcp/tokens')).status === 401);
    const none = await api('/api/mcp/tokens', { token: A });
    check('a session lists none yet, with the endpoint', none.status === 200 && none.json.tokens.length === 0 && none.json.endpoint === `${BASE}/mcp`, none.text);
    check('the legacy AUTH_TOKEN cannot make one', (await api('/api/mcp/tokens', { method: 'POST', token: LEGACY, body: { name: 'x' } })).status === 403);
    check('a token needs a name of at most 60 characters', (await api('/api/mcp/tokens', { method: 'POST', token: A, body: { name: '  ' } })).status === 400
        && (await api('/api/mcp/tokens', { method: 'POST', token: A, body: { name: 'x'.repeat(61) } })).status === 400);
    const madeA = (await api('/api/mcp/tokens', { method: 'POST', token: A, body: { name: 'Laptop Claude Code' } })).json;
    const madeA2 = (await api('/api/mcp/tokens', { method: 'POST', token: A, body: { name: 'Second' } })).json;
    const madeS = (await api('/api/mcp/tokens', { method: 'POST', token: S, body: { name: 'Sam' } })).json;
    const madeK = (await api('/api/mcp/tokens', { method: 'POST', token: K, body: { name: 'Kim' } })).json;
    const TA = madeA.token;
    const TA2 = madeA2.token;
    const TS = madeS.token;
    const TK = madeK.token;
    check('a new token is shown once, tpm_ and 43 more characters, scope read + propose',
        /^tpm_[A-Za-z0-9_-]{43}$/.test(TA) && madeA.scope === 'read propose' && madeA.prefix === TA.slice(0, 10) && madeA.endpoint === `${BASE}/mcp`, JSON.stringify(madeA));
    const listed = (await api('/api/mcp/tokens', { token: A })).json.tokens;
    check('the list has names, dates and prefixes, never the token', listed.length === 2 && listed[0].name === 'Laptop Claude Code'
        && listed[0].lastUsedAt === null && !JSON.stringify(listed).includes(TA) && !JSON.stringify(listed).includes(TA2));
    check('an MCP token cannot manage tokens', (await api('/api/mcp/tokens', { token: TA })).status === 401
        && (await api('/api/mcp/tokens', { method: 'POST', token: TA, body: { name: 'y' } })).status === 401);
    {
        const db = new Database(path.join(dataDir, 'sync.db'), { readonly: true, fileMustExist: true });
        const rows = db.prepare('SELECT * FROM mcp_tokens ORDER BY id').all();
        const dump = JSON.stringify(rows);
        db.close();
        check('only the SHA-256 hash is stored', rows.length === 4 && rows[0].token_hash === crypto.createHash('sha256').update(TA).digest('hex')
            && ![TA, TA2, TS, TK].some(t => dump.includes(t)), dump.slice(0, 200));
    }

    console.log('\n2. The protocol');
    const { client } = await connect(TA);
    clients.push(client);
    const info = client.getServerVersion();
    check('initialize names the server and says nothing changes before approval', info.name === 'tabpaladin'
        && /changes NOTHING/.test(client.getInstructions() || '') && /approve/.test(client.getInstructions() || ''), JSON.stringify(info));
    const init = await rpc(TA, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw', version: '1' } });
    check('stateless: initialize answers JSON with no session id', init.status === 200 && init.json.result.protocolVersion === '2025-11-25'
        && !init.headers.get('mcp-session-id') && /application\/json/.test(init.headers.get('content-type')), init.text.slice(0, 200));
    const old = await rpc(TA, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'raw', version: '1' } });
    check('an older client gets its own version', old.status === 200 && old.json.result.protocolVersion === '2025-03-26');
    const tools = (await client.listTools()).tools;
    const names = tools.map(t => t.name);
    const want = ['search_bookmarks', 'list_folders', 'list_folder', 'get_bookmark', 'list_notes', 'read_note', 'search_notes',
        'propose_create_folder', 'propose_add_bookmarks', 'propose_move', 'propose_rename', 'propose_delete', 'propose_changes',
        'propose_note', 'propose_note_order', 'list_my_proposals'];
    check('tools/list has every read and propose tool', want.every(n => names.includes(n)) && names.length === want.length, names.join(', '));
    check('  read tools are marked read-only, propose tools are not', tools.filter(t => !t.name.startsWith('propose_')).every(t => t.annotations.readOnlyHint === true)
        && tools.filter(t => t.name.startsWith('propose_')).every(t => t.annotations.readOnlyHint === false && t.annotations.destructiveHint === false));
    check('a raw tools/list works without initialize (stateless)', (await rpc(TA, 'tools/list', {}, { 'MCP-Protocol-Version': '2025-11-25' })).json?.result?.tools?.length === want.length);
    const badVersion = await rpc(TA, 'tools/list', {}, { 'MCP-Protocol-Version': '1999-01-01' });
    check('an unsupported MCP-Protocol-Version is refused (400)', badVersion.status === 400, badVersion.text);
    const noSse = await api('/mcp', { method: 'POST', token: TA, headers: { Accept: 'application/json' }, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    check('a client that does not accept both content types is refused (406)', noSse.status === 406, noSse.text);
    const get = await api('/mcp', { token: TA, headers: { Accept: 'text/event-stream' } });
    const delR = await api('/mcp', { method: 'DELETE', token: TA });
    check('GET and DELETE answer 405 (no stream, no session)', get.status === 405 && delR.status === 405 && get.headers.get('allow') === 'POST');
    const note = await api('/mcp', { method: 'POST', token: TA, headers: MCP_HEADERS, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
    check('a notification is accepted with 202', note.status === 202, String(note.status));

    console.log('\n3. Tool calls');
    let r = await tool(client, 'search_bookmarks', { query: 'hacker' });
    check('search_bookmarks finds by title, with id, address and folder', !r.isError && r.data.total === 1 && r.data.results[0].id === 'b-hn'
        && r.data.results[0].url === 'https://news.ycombinator.com' && r.data.results[0].folderPath === 'Bookmarks / Tech', r.text);
    r = await tool(client, 'search_bookmarks', { query: 'arxiv', folderId: 'f-tech' });
    check('  inside a folder and its subfolders', r.data.total === 1 && r.data.results[0].id === 'b-paper');
    check('  a folder that is not there is a tool error', (await tool(client, 'search_bookmarks', { query: 'x', folderId: 'nope' })).isError);
    r = await tool(client, 'list_folders', {});
    check('list_folders is the folder index, with paths', !r.isError && r.data.total === 4
        && r.data.folders.map(f => f.path).join('|') === 'Bookmarks|Bookmarks / Tech|Bookmarks / Tech / AI|Bookmarks / Inbox', r.text);
    r = await tool(client, 'list_folder', { path: 'bookmarks / tech' });
    check('list_folder by path (any case) lists subfolders and bookmarks', !r.isError && r.data.folder.id === 'f-tech'
        && r.data.subfolders[0].id === 'f-ai' && r.data.bookmarks[0].id === 'b-hn', r.text);
    r = await tool(client, 'list_folder', {});
    check('  with nothing, the top level', !r.isError && r.data.folder === null && r.data.subfolders[0].id === root.id);
    check('  an unknown one is a tool error', (await tool(client, 'list_folder', { folderId: 'nope' })).isError);
    r = await tool(client, 'get_bookmark', { id: 'b-mdn' });
    check('get_bookmark', !r.isError && r.data.title === 'MDN Web Docs' && r.data.folderId === 'f-inbox');
    check('  a folder id gives the folder', (await tool(client, 'get_bookmark', { id: 'f-ai' })).data.folder.path === 'Bookmarks / Tech / AI');
    r = await tool(client, 'list_notes', {});
    check('list_notes: titles and notebooks, newest edits first, no text', !r.isError && r.data.total === 2 && r.data.notes[0].id === 'n-diary'
        && r.data.notes[1].notebook === 'Work' && !r.text.includes('Ardennes'), r.text);
    check('  in one notebook', (await tool(client, 'list_notes', { notebook: 'work' })).data.notes.map(n => n.id).join() === 'n-huge');
    r = await tool(client, 'read_note', { title: 'diary' });
    check('read_note by title', !r.isError && r.data.content.includes('Ardennes'));
    r = await tool(client, 'read_note', { id: 'n-huge' });
    check('  a huge note is cut short, and says so', !r.isError && r.data.truncated === true && r.data.characters === huge.length
        && r.text.length <= 100 * 1024, String(r.text.length));
    r = await tool(client, 'search_notes', { query: 'hiking' });
    check('search_notes with a snippet', !r.isError && r.data.results[0].id === 'n-diary' && /hiking/.test(r.data.results[0].snippet));

    const reviewA = async () => (await api('/api/proposals/review', { token: A })).json.proposals;
    const treeA = async () => (await api('/api/tree', { token: A })).json;
    const before = await treeA();
    const props = {};
    for (const [name, args] of [
        ['propose_create_folder', { parentId: 'f-tech', path: 'Reading / Later', reason: 'A place for long reads' }],
        ['propose_add_bookmarks', { folderId: 'f-inbox', bookmarks: [{ title: 'Node', url: 'https://nodejs.org' }] }],
        ['propose_move', { ids: ['b-mdn'], toFolderId: 'f-tech' }],
        ['propose_rename', { id: 'f-inbox', title: 'Reading inbox' }],
        ['propose_delete', { ids: ['b-hn'] }],
        ['propose_changes', { changes: [{ op: 'create_folder', parentId: root.id, path: 'Docs', ref: 'd' }, { op: 'move', ids: ['b-mdn'], toFolderRef: 'd' }] }],
        ['propose_note', { title: 'From Claude', content: '# From Claude\n\nhello', notebook: 'Work' }],
        ['propose_note_order', { order: ['Diary', 'Huge'] }]
    ]) {
        r = await tool(client, name, args);
        props[name] = r.data;
        check(`${name} files a pending proposal`, !r.isError && r.data.status === 'pending_approval' && Number.isInteger(r.data.id)
            && /Nothing has changed yet/.test(r.data.message), r.text);
    }
    check('  with a preview of what it would do', props.propose_create_folder.preview.join('|') === 'New folder “Reading” in Bookmarks / Tech|New folder “Later” in Bookmarks / Tech / Reading'
        && /^DELETE bookmark “Hacker News”/.test(props.propose_delete.preview[0]), JSON.stringify(props.propose_create_folder));
    const afterProps = await treeA();
    check('  and nothing changed', afterProps.version === before.version && JSON.stringify(afterProps.roots) === JSON.stringify(before.roots));
    const review = await reviewA();
    const viaMcp = review.filter(p => p.source === 'mcp');
    check('they wait for alex in the web app, marked MCP with the token\'s name', viaMcp.length === 8
        && viaMcp.every(p => p.tokenName === 'Laptop Claude Code') && review.find(p => p.id === props.propose_create_folder.id).reason === 'A place for long reads');
    check('  the note and the order also in the old list, as before',
        (await api('/api/proposals', { token: A })).json.proposals.map(p => p.kind).sort().join() === 'note,reorder');
    r = await tool(client, 'list_my_proposals', {});
    check('list_my_proposals lists them, pending, with previews', !r.isError && r.data.pending.length === 8
        && r.data.pending.every(p => p.status === 'pending') && r.data.pending.some(p => p.preview && p.preview[0].startsWith('DELETE')), r.text.slice(0, 300));
    for (const [name, args, want] of [
        ['propose_move', { ids: ['nope'], toFolderId: 'f-tech' }, /no bookmark or folder with id nope/],
        ['propose_move', { ids: ['b-hn'], toFolderId: 'f-notes' }, /inside Notes/],
        ['propose_add_bookmarks', { folderId: 'f-tech', bookmarks: [{ url: 'javascript:alert(1)' }] }, /http\(s\)/],
        ['propose_rename', { id: 'f-tech' }, /non-empty name/],
        ['propose_note', { title: '', content: 'x' }, /title/]
    ]) {
        r = await tool(client, name, args);
        check(`a bad ${name} is a tool error with the reason`, r.isError && want.test(r.text), r.text);
    }
    const approve = await api(`/api/proposals/${props.propose_changes.id}/approve`, { method: 'POST', token: A });
    const approved = await treeA();
    check('approved in the web app, it applies', approve.status === 200 && JSON.stringify(approved.roots).includes('"Docs"'));
    r = await tool(client, 'list_my_proposals', {});
    check('  and leaves list_my_proposals; one made stale by it says so', r.data.pending.length === 7
        && r.data.pending.find(p => p.id === props.propose_move.id).status === 'stale'
        && r.data.pending.find(p => p.id === props.propose_move.id).outOfDate.some(s => /MDN Web Docs/.test(s)), r.text.slice(0, 400));
    const second = await connect(TA2);
    clients.push(second.client);
    check('another token of the same account lists only its own', (await tool(second.client, 'list_my_proposals', {})).data.pending.length === 0);
    const lastUsed = (await api('/api/mcp/tokens', { token: A })).json.tokens.find(t => t.name === 'Laptop Claude Code').lastUsedAt;
    check('the token\'s last use is kept', typeof lastUsed === 'string' && Date.now() - Date.parse(lastUsed) < 60000, String(lastUsed));

    console.log('\n3b. Long answers');
    const bytes = (s) => Buffer.byteLength(s, 'utf8');
    // Short lines: every newline is two characters once escaped as JSON.
    const lines = '# Lines\n\n' + Array.from({ length: 5000 }, (_, i) => `- [ ] item ${String(i).padStart(4, '0')} todo`).join('\n') + '\n- [ ] ünïcødé 😀 end\n';
    {
        const t = await treeA();
        t.roots.find(r => r.role === 'notes').children.push({ id: 'n-lines', kind: 'note', title: 'Lines', payload: { content: lines, createdAt: T, updatedAt: T } });
        if ((await api('/api/tree', { method: 'PUT', token: A, body: { roots: t.roots, baseVersion: t.version } })).status !== 200) throw new Error('push lines');
    }
    const parts = [];
    let offset = 0;
    for (let i = 0; i < 10; i++) {
        const p = await tool(client, 'read_note', { id: 'n-lines', ...(offset ? { offset } : {}) });
        parts.push(p);
        if (p.isError || p.data.nextOffset === undefined) break;
        offset = p.data.nextOffset;
    }
    check('a long note of short lines is read in parts, each under 100 KB, together the whole note',
        parts.length > 1 && parts.every(p => !p.isError && bytes(p.text) <= 100 * 1024) && parts[0].data.truncated === true
        && parts[0].data.characters === lines.length && parts.map(p => p.data.content).join('') === lines,
        JSON.stringify(parts.map(p => [p.isError, bytes(p.text), p.data && p.data.offset, p.data && p.data.nextOffset])));
    r = await tool(client, 'read_note', { id: 'n-lines', offset: 100, limit: 50 });
    check('  from any offset, as much as asked', !r.isError && r.data.content === lines.slice(100, 150) && r.data.nextOffset === 150);
    const bulky = await tool(client, 'propose_changes', { changes: Array.from({ length: 50 }, (_, i) => ({
        op: 'move', ids: Array.from({ length: 200 }, (_, j) => `x${i}_${j}`), toFolderId: 'f-tech' })) });
    check('a proposal naming 10000 unknown ids is refused in an answer under 100 KB, with a count of the rest',
        bulky.isError && bytes(bulky.text) <= 100 * 1024 && bulky.data.problems.length <= 51
        && /more problems/.test(bulky.data.problems[bulky.data.problems.length - 1]), `${bytes(bulky.text)} ${bulky.text.slice(0, 200)}`);
    const all = (await tool(client, 'list_my_proposals', {})).data;
    const page1 = (await tool(client, 'list_my_proposals', { limit: 3 })).data;
    const pageLast = (await tool(client, 'list_my_proposals', { offset: all.total - 1, limit: 3 })).data;
    check('list_my_proposals is paged', all.total === 7 && all.pending.length === 7 && all.nextOffset === null
        && page1.pending.length === 3 && page1.nextOffset === 3 && page1.pending[0].id === all.pending[0].id
        && pageLast.pending.length === 1 && pageLast.nextOffset === null && pageLast.pending[0].id === all.pending[6].id,
        JSON.stringify([all.total, page1.nextOffset, pageLast.nextOffset]));

    console.log('\n4. Isolation');
    const sam = await connect(TS);
    clients.push(sam.client);
    check('sam\'s token finds none of alex\'s bookmarks', (await tool(sam.client, 'search_bookmarks', { query: 'hacker' })).data.total === 0
        && (await tool(sam.client, 'search_bookmarks', { query: 'secret' })).data.results[0].id === 's-b1');
    check('  cannot read them by id', (await tool(sam.client, 'get_bookmark', { id: 'b-hn' })).isError
        && (await tool(sam.client, 'list_folder', { folderId: 'f-tech' })).isError
        && (await tool(sam.client, 'read_note', { id: 'n-diary' })).isError);
    check('  sees only sam\'s folders and notes', (await tool(sam.client, 'list_folders', {})).data.folders.every(f => f.id.startsWith('s-'))
        && (await tool(sam.client, 'list_notes', {})).data.total === 0);
    r = await tool(sam.client, 'propose_delete', { ids: ['b-hn'] });
    check('  cannot propose against alex\'s ids', r.isError && /no bookmark or folder with id b-hn/.test(r.text));
    r = await tool(sam.client, 'propose_rename', { id: 's-b1', title: 'Renamed by sams chat' });
    check('  its own proposals wait for sam, never for alex', !r.isError
        && (await api('/api/proposals/review', { token: S })).json.proposals.some(p => p.id === r.data.id)
        && !(await reviewA()).some(p => p.id === r.data.id) && (await tool(sam.client, 'list_my_proposals', {})).data.pending.length === 1);
    check('  and alex\'s token never sees sam\'s', (await tool(client, 'search_bookmarks', { query: 'secret' })).data.total === 0
        && !(await tool(client, 'list_my_proposals', {})).text.includes('Renamed by sams chat'));
    check('sam cannot revoke alex\'s token', (await api(`/api/mcp/tokens/${madeA.id}`, { method: 'DELETE', token: S })).status === 404
        && (await rpc(TA, 'tools/list')).status === 200);

    console.log('\n4b. Through the stdio bridge (tools/mcp_bridge.mjs, for Claude Desktop)');
    const bridgeTo = (tokenValue) => new StdioClientTransport({
        command: process.execPath,
        args: [path.join(ROOT, 'tools', 'mcp_bridge.mjs'), `${BASE}/mcp`],
        env: { TABPALADIN_MCP_TOKEN: tokenValue },
        stderr: 'pipe'
    });
    const bridged = new Client({ name: 'bridged', version: '1' });
    await bridged.connect(bridgeTo(TS));
    clients.push(bridged);
    check('a stdio client reaches the tools through the bridge', bridged.getServerVersion().name === 'tabpaladin'
        && (await bridged.listTools()).tools.length === want.length
        && (await tool(bridged, 'search_bookmarks', { query: 'secret' })).data.results[0].id === 's-b1');
    const badBridge = new Client({ name: 'bridged-bad', version: '1' });
    let bridgeRefused = null;
    try { await badBridge.connect(bridgeTo('tpm_' + 'Z'.repeat(43))); } catch (e) { bridgeRefused = e; }
    try { await badBridge.close(); } catch (e) { /* closed */ }
    check('  a wrong token through it is refused, with the server\'s reason', bridgeRefused !== null && /refused/.test(String(bridgeRefused)), String(bridgeRefused));

    console.log('\n5. Auth');
    const noAuth = await rpc(null, 'tools/list');
    check('no token: 401 with WWW-Authenticate', noAuth.status === 401 && /^Bearer realm="TabPaladin"$/.test(noAuth.headers.get('www-authenticate') || ''), noAuth.text);
    const wrong = await rpc('tpm_' + 'A'.repeat(43), 'tools/list');
    check('a wrong token: 401 invalid_token', wrong.status === 401 && /error="invalid_token"/.test(wrong.headers.get('www-authenticate') || ''));
    check('a session token is not an MCP token', (await rpc(A, 'tools/list')).status === 401);
    check('neither is the legacy AUTH_TOKEN', (await rpc(LEGACY, 'tools/list')).status === 401);
    const inUrl = await api(`/mcp?token=${encodeURIComponent(TA)}`, { method: 'POST', headers: MCP_HEADERS, body: { jsonrpc: '2.0', id: 9, method: 'tools/list' } });
    check('a token in the URL is not accepted', inUrl.status === 401);
    check('an MCP token opens nothing under /api', (await api('/api/tree', { token: TA })).status === 401
        && (await api('/api/proposals', { token: TA })).status === 401 && (await api('/api/share', { method: 'POST', token: TA })).status === 401);
    const evil = await rpc(TA, 'tools/list', {}, { Origin: 'https://evil.example' });
    check('a request from a web page (Origin) is refused with 403', evil.status === 403 && evil.json?.error && evil.json.id === null, evil.text);
    check('  unless MCP_ALLOWED_ORIGINS lists it', (await rpc(TA, 'tools/list', {}, { Origin: ALLOWED_ORIGIN })).status === 200);
    check('  and the server\'s own origin is no exception', (await rpc(TA, 'tools/list', {}, { Origin: BASE })).status === 403);
    const preflight = await api('/mcp', { method: 'OPTIONS', headers: { Origin: ALLOWED_ORIGIN, 'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type,mcp-protocol-version' } });
    const allowHeaders = (preflight.headers.get('access-control-allow-headers') || '').toLowerCase();
    check('a listed origin\'s preflight is answered by /mcp, with the MCP headers allowed',
        preflight.status === 204 && preflight.headers.get('access-control-allow-origin') === ALLOWED_ORIGIN
        && /\bpost\b/i.test(preflight.headers.get('access-control-allow-methods') || '')
        && ['authorization', 'content-type', 'mcp-protocol-version', 'mcp-session-id'].every(h => allowHeaders.includes(h)),
        `${preflight.status} ${[...preflight.headers].join(' | ')}`);
    const fromPage = await rpc(TA, 'tools/list', {}, { Origin: ALLOWED_ORIGIN, 'MCP-Protocol-Version': '2025-11-25' });
    check('  and its requests can be read by it', fromPage.status === 200 && fromPage.headers.get('access-control-allow-origin') === ALLOWED_ORIGIN
        && /mcp-session-id/i.test(fromPage.headers.get('access-control-expose-headers') || ''));
    const evilPre = await api('/mcp', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
    check('  another origin\'s preflight gets no CORS', evilPre.status === 403 && !evilPre.headers.get('access-control-allow-origin'));
    const linkA = new URL((await api('/api/share', { method: 'POST', token: A })).json.url).pathname;
    check('alex\'s share link works before the password change', (await api(linkA)).status === 200);
    const revoked = await api(`/api/mcp/tokens/${madeA2.id}`, { method: 'DELETE', token: A });
    check('a revoked token stops working at once', revoked.status === 200 && (await rpc(TA2, 'tools/list')).status === 401
        && (await api('/api/mcp/tokens', { token: A })).json.tokens.length === 1);
    let failedCall = null;
    try { await second.client.listTools(); } catch (e) { failedCall = e; }
    check('  also for a client already connected with it', failedCall !== null, String(failedCall));
    const pw = await api('/api/auth/password', { method: 'POST', token: A, body: { currentPassword: PASSWORD, newPassword: 'battery staple horse' } });
    check('a password change revokes the account\'s tokens', pw.status === 200 && (await rpc(TA, 'tools/list')).status === 401
        && (await api('/api/mcp/tokens', { token: pw.json.token })).json.tokens.length === 0, pw.text);
    check('  and ends its share links: the page, search and proposals', (await api(linkA)).status === 410
        && (await api(linkA + '/search?q=hacker')).status === 410
        && (await api(linkA + '/propose', { method: 'POST', body: { title: 'x', content: 'y' } })).status === 410);
    const A2 = pw.json.token;
    const users = (await api('/api/users', { token: A2 })).json.users;
    const kimId = users.find(u => u.username === 'kim').id;
    check('kim\'s token works before kim is deleted', (await rpc(TK, 'tools/list')).status === 200);
    const delK = await api(`/api/users/${kimId}/delete`, { method: 'POST', token: A2, body: { confirm: 'kim', currentPassword: 'battery staple horse' } });
    check('deleting an account kills its tokens', delK.status === 200 && delK.json.deleted.mcp_tokens === 1 && (await rpc(TK, 'tools/list')).status === 401, delK.text);

    console.log('\n6. Limits');
    const big = await api('/mcp', { method: 'POST', token: TS, headers: MCP_HEADERS,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'propose_note', arguments: { title: 'x', content: 'y'.repeat(300 * 1024) } } }) });
    check('a body over 256 KB is refused (413)', big.status === 413, big.text.slice(0, 200));
    const garbled = await api('/mcp', { method: 'POST', token: TS, headers: MCP_HEADERS, body: '{"jsonrpc": "2.0", nope' });
    check('malformed JSON is a JSON-RPC parse error (400, -32700)', garbled.status === 400 && garbled.json?.error?.code === -32700, garbled.text);
    const TS2 = (await api('/api/mcp/tokens', { method: 'POST', token: S, body: { name: 'Sam two' } })).json.token;
    let limited = null;
    for (let i = 0; i < PER_MINUTE + 5 && !limited; i++) {
        const x = await rpc(TS, 'ping');
        if (x.status === 429) limited = x;
    }
    check(`more than ${PER_MINUTE} requests a minute with one token get 429 with Retry-After`,
        limited !== null && Number(limited.headers.get('retry-after')) > 0, limited ? limited.text : 'never limited');
    check('  and only that token: another one still works', (await rpc(TS, 'ping')).status === 429 && (await rpc(TS2, 'ping')).status === 200);
    let blocked = null;
    for (let i = 0; i < BAD_TOKENS + 2 && !blocked; i++) {
        const x = await rpc('tpm_bad' + i, 'tools/list');
        if (x.status === 429) blocked = x;
    }
    check(`after ${BAD_TOKENS} bad tokens from one address, it is told to wait`, blocked !== null && Number(blocked.headers.get('retry-after')) > 0);
} catch (e) {
    failures++;
    console.error('FAIL  run stopped:', e, '\n' + serverLog);
} finally {
    for (const c of clients) { try { await c.close(); } catch (e) { /* closed */ } }
    server.kill();
    await exited;
    try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) { /* temp */ }
}

if (/TypeError|ReferenceError|SyntaxError|MCP tool failed|MCP request failed/.test(serverLog)) {
    failures++;
    console.error('FAIL  the server logged an error:\n' + serverLog);
}
console.log(failures === 0 ? '\nAll MCP tests passed.\n' : `\n${failures} test(s) failed.\n`);
process.exitCode = failures === 0 ? 0 : 1;
