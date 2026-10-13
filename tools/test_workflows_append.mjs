// POST /api/workflows: one workflow appended under the account's workflows
// root, as one logged 'append', without the rest of a client's copy.
//
// What this locks down:
//   1. The tab URL allowlist (the one the browser helper opens tabs through):
//      http, https and this computer's file: URLs; javascript:, data:,
//      view-source:, browser and extension pages, and file: URLs naming
//      another machine (UNC, which would leak an NTLM hash) are refused;
//      control characters and URLs over 8 KB too.
//   2. The request: ids, titles, createdAt, at most 500 tabs, no id twice.
//   3. items.appendWorkflow: the folder lands at the end of the workflows
//      root with payload {createdAt}, its tabs in order; exactly one 'append'
//      op is logged and no history snapshot; a retry with the same ids
//      changes nothing; 'no-root' (none, or another one) writes nothing and
//      never makes a root; an id that is something else here, or another
//      account's, is a conflict and writes nothing.
//   4. The route on a live server (--port): auth, the 412 for another
//      account, the 409s, a 400 for each refused URL and for 501 tabs, 500
//      tabs of 8 KB URLs accepted (past the 1 MB default body limit), the
//      tree and /api/tree/ops afterwards, a second account kept out of the
//      first one's root, and shareCore.applyOps folding the op into a copy
//      pulled before it so that the copy matches the server's tree.
//
// Run: node tools/test_workflows_append.mjs [--port 18989]
// Starts this checkout's server on the port with a throwaway data directory.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from '../server/node_modules/better-sqlite3/lib/index.js';
import { makeItemsStore } from '../server/items.js';
import { migrateUsers, insertUser } from '../server/users.js';
import { migrateOwnership } from '../server/tenancy.js';
import { tabUrlProblem, parseWorkflowRequest, MAX_TABS, MAX_URL_BYTES } from '../server/workflows.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback = null) => {
    const i = process.argv.indexOf('--' + name);
    return i === -1 ? fallback : process.argv[i + 1];
};
const PORT = Number(arg('port') || 18989);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'correct horse battery';

let failures = 0;
function check(name, cond, detail) {
    if (cond) console.log(`  ok  ${name}`);
    else { failures++; console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const throwsMsg = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

// --- 1. URLs ------------------------------------------------------------------------
console.log('\n1. The tab URL allowlist');
for (const ok of ['https://example.com/a?b=1#c', 'http://localhost:3000/', 'file:///C:/Users/me/notes.txt', 'file:///home/me/a.pdf',
    'file://localhost/C:/x.txt', 'https://xn--bcher-kva.example/']) {
    check(`takes ${ok}`, tabUrlProblem(ok) === null, tabUrlProblem(ok));
}
for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,<script>alert(1)</script>', 'view-source:https://a.com',
    'chrome://settings', 'edge://flags', 'about:blank', 'chrome-extension://abcdef/app.html', 'moz-extension://abc/x.html', 'opera://about',
    'blob:https://a.com/1', 'ftp://a.com/x', 'file://server/share/x.txt', 'file:////server/share/x.txt', 'file:///%5C%5Cserver%5Cshare',
    'file:///%2F%2Fserver/share', 'file://127.0.0.1/c$/x', 'https://a.com/\nx', ' https://a.com', 'not a url', '', null, 42,
    'https://a.com/' + 'x'.repeat(MAX_URL_BYTES)]) {
    check(`refuses ${JSON.stringify(typeof bad === 'string' ? bad.slice(0, 60) : bad)}`, tabUrlProblem(bad) !== null);
}
check('8 KB exactly is allowed', tabUrlProblem('https://a.com/' + 'x'.repeat(MAX_URL_BYTES - 'https://a.com/'.length)) === null);

// --- 2. The request ---------------------------------------------------------------------
console.log('\n2. The request');
const wf = (over = {}) => ({
    rootId: 'wf-root',
    workflow: { id: 'wf-0000001', title: 'Research', createdAt: '2026-10-01T09:30:00.000Z',
        tabs: [{ id: 'tab-000001', title: 'One', url: 'https://one.example/' }, { id: 'tab-000002', title: '', url: 'https://two.example/' }], ...over }
});
const parsed = parseWorkflowRequest(wf());
check('a good request parses; an untitled tab is named by its URL', parsed.rootId === 'wf-root' && parsed.workflow.tabs[1].title === 'https://two.example/'
    && parsed.workflow.createdAt === '2026-10-01T09:30:00.000Z', JSON.stringify(parsed));
check('no createdAt: now', Number.isFinite(Date.parse(parseWorkflowRequest(wf({ createdAt: undefined })).workflow.createdAt)));
for (const [name, body] of [
    ['no rootId', { ...wf(), rootId: '' }],
    ['no workflow', { rootId: 'r' }],
    ['a bad workflow id', wf({ id: 'x' })],
    ['an empty title', wf({ title: '  ' })],
    ['a 1001-character title', wf({ title: 'x'.repeat(1001) })],
    ['a bad createdAt', wf({ createdAt: 'yesterday' })],
    ['tabs not an array', wf({ tabs: 'x' })],
    [`${MAX_TABS + 1} tabs`, wf({ tabs: Array.from({ length: MAX_TABS + 1 }, (_, i) => ({ id: `tab-${String(i).padStart(6, '0')}`, url: 'https://a.com/' })) })],
    ['a tab id used twice', wf({ tabs: [{ id: 'tab-000001', url: 'https://a.com/' }, { id: 'tab-000001', url: 'https://b.com/' }] })],
    ['a tab with the workflow\'s id', wf({ tabs: [{ id: 'wf-0000001', url: 'https://a.com/' }] })],
    ['a javascript: tab', wf({ tabs: [{ id: 'tab-000001', url: 'javascript:alert(1)' }] })],
    ['a UNC tab', wf({ tabs: [{ id: 'tab-000001', url: 'file://server/share/x' }] })],
    ['a tab title that is no string', wf({ tabs: [{ id: 'tab-000001', title: 5, url: 'https://a.com/' }] })]
]) {
    check(`refused: ${name}`, throwsMsg(() => parseWorkflowRequest(body)) !== null);
}

// --- 3. The store -------------------------------------------------------------------------
console.log('\n3. items.appendWorkflow');
function freshDb() {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, device_id TEXT, json TEXT NOT NULL);
        CREATE TABLE users (username TEXT PRIMARY KEY, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);`);
    db.prepare("INSERT INTO users VALUES ('alex', 'scrypt:x:y', '2026-01-01T00:00:00Z')").run();
    migrateUsers(db);
    const store = makeItemsStore(db, { maxSnapshots: 10 });
    migrateOwnership(db, { env: {} });
    const sam = insertUser(db, { username: 'sam', passwordHash: 'scrypt:x:y' });
    return { db, store, alex: store.forUser(1), sam: store.forUser(sam.id ?? sam) };
}
{
    const { db, alex, sam } = freshDb();
    alex.writeTree([
        { id: 'bookmarks-root', kind: 'folder', role: 'bookmarks', title: 'Bookmarks', children: [] },
        { id: 'wf-root', kind: 'folder', role: 'workflows', title: 'TabPaladin Workflows', children: [
            { id: 'older-wf', kind: 'folder', title: 'Older', payload: { createdAt: '2026-01-01T00:00:00.000Z' }, children: [] }
        ] }
    ]);
    const history = () => db.prepare('SELECT COUNT(*) AS n FROM snapshots WHERE user_id = 1').get().n;
    const ops = () => db.prepare('SELECT * FROM tree_ops WHERE user_id = 1 ORDER BY version').all();
    const snapshotsBefore = history();
    const v0 = alex.version();
    const r = alex.appendWorkflow(parseWorkflowRequest(wf()));
    const tree = alex.readTree();
    const root = tree.roots.find(x => x.id === 'wf-root');
    const added = root.children.at(-1);
    check('the workflow lands at the end of the workflows root, tabs in order', r.ok && added.id === 'wf-0000001' && root.children.length === 2
        && added.children.map(c => c.id).join() === 'tab-000001,tab-000002' && added.children[1].title === 'https://two.example/', JSON.stringify(root));
    check('  its folder carries payload {createdAt}, its tabs none', eq(added.payload, { createdAt: '2026-10-01T09:30:00.000Z' })
        && added.children.every(c => !c.payload));
    check('  the version moves once, and the answer says from where to where', r.baseVersion === v0 && r.version === alex.version() && r.version > v0
        && r.created.length === 3 && r.already.length === 0);
    const log = ops();
    check('  exactly one \'append\' op is logged, with the folder\'s payload', log.length === 1 && log[0].kind === 'append'
        && log[0].base_version === v0 && log[0].version === r.version
        && eq(JSON.parse(log[0].payload).nodes[0], { id: 'wf-0000001', parentId: 'wf-root', kind: 'folder', title: 'Research', payload: { createdAt: '2026-10-01T09:30:00.000Z' } }),
        JSON.stringify(log));
    check('  opsSince serves it as a complete gap', (() => { const o = alex.opsSince(v0); return o.complete && o.ops.length === 1 && o.ops[0].payload.nodes.length === 3; })());
    check('  and no history snapshot is written', history() === snapshotsBefore);

    const retry = alex.appendWorkflow(parseWorkflowRequest(wf()));
    check('a retry with the same ids changes nothing and says so', retry.ok && retry.created.length === 0 && retry.version === r.version
        && retry.already.sort().join() === 'tab-000001,tab-000002,wf-0000001' && alex.version() === r.version && ops().length === 1);
    const plusOne = alex.appendWorkflow(parseWorkflowRequest(wf({ tabs: [...wf().workflow.tabs, { id: 'tab-000003', url: 'https://three.example/' }] })));
    check('  a retry that names one more tab adds just that one', plusOne.ok && plusOne.created.length === 1 && plusOne.created[0].id === 'tab-000003'
        && ops().length === 2);

    const before = JSON.stringify(alex.readTree());
    const vBefore = alex.version();
    const clash = alex.appendWorkflow(parseWorkflowRequest(wf({ id: 'wf-0000002', tabs: [{ id: 'tab-000001', url: 'https://elsewhere.example/' }] })));
    check('a tab id that is already another tab here is a conflict, and nothing is written', !clash.ok && clash.code === 'conflict'
        && eq(clash.ids, ['tab-000001']) && JSON.stringify(alex.readTree()) === before && alex.version() === vBefore);
    const renamed = alex.appendWorkflow(parseWorkflowRequest(wf({ title: 'Renamed' })));
    check('  so is the workflow id under another title', !renamed.ok && renamed.code === 'conflict' && renamed.ids.includes('wf-0000001'));
    const asTab = alex.appendWorkflow(parseWorkflowRequest(wf({ id: 'bookmarks-root', tabs: [] })));
    check('  and an id that is a root here', !asTab.ok && asTab.code === 'conflict' && JSON.stringify(alex.readTree()) === before);

    const wrongRoot = alex.appendWorkflow({ ...parseWorkflowRequest(wf({ id: 'wf-0000003' })), rootId: 'bookmarks-root' });
    check('another folder than the workflows root is \'no-root\', naming the real one, and writes nothing',
        !wrongRoot.ok && wrongRoot.code === 'no-root' && wrongRoot.rootId === 'wf-root' && JSON.stringify(alex.readTree()) === before);

    // Sam has no workflows root at all, and alex's ids are not his.
    const samVersion = sam.version();
    const none = sam.appendWorkflow(parseWorkflowRequest(wf({ id: 'wf-sam-0001', tabs: [] })));
    check('an account with no workflows root gets \'no-root\', and no root is made', !none.ok && none.code === 'no-root' && none.rootId === null
        && !JSON.stringify(sam.readTree()).includes('workflows') && sam.version() === samVersion);
    const into = sam.appendWorkflow(parseWorkflowRequest(wf()));
    check('  naming another account\'s root is \'no-root\' too', !into.ok && into.code === 'no-root');
    sam.writeTree([{ id: 'sam-wf-root', kind: 'folder', role: 'workflows', title: 'TabPaladin Workflows', children: [] }]);
    const stolen = sam.appendWorkflow({ ...parseWorkflowRequest(wf()), rootId: 'sam-wf-root' });
    check('  and alex\'s ids under sam\'s own root are a conflict, not a copy', !stolen.ok && stolen.code === 'conflict'
        && stolen.ids.length === 3 && JSON.stringify(alex.readTree()) === before);
    db.close();
}

// --- 4. The route on a live server --------------------------------------------------------------
console.log('\n4. The route on a live server');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-workflows-'));
const env = { ...process.env };
for (const k of Object.keys(env)) if (/^(AUTH_TOKEN|ADMIN_|TENANCY_OWNER|IMPORT_|MAX_)/.test(k)) delete env[k];
const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...env, PORT: String(PORT), DATA_DIR: dataDir, PWA_DIR: path.join(ROOT, 'pwa'), ADMIN_USERNAME: 'alex', ADMIN_PASSWORD: PASSWORD, IMPORTS_SCHEDULER: 'off' },
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

async function api(p, { method = 'GET', token, body, raw } = {}) {
    const res = await fetch(BASE + p, {
        method,
        headers: { ...(body || raw ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: raw ?? (body ? JSON.stringify(body) : undefined)
    });
    let json = null;
    try { json = await res.json(); } catch (e) { /* not json */ }
    return { status: res.status, json };
}

try {
    await ready;
    const login = async (username) => (await api('/api/login', { method: 'POST', body: { username, password: PASSWORD } })).json;
    const alex = await login('alex');
    const token = alex.token;
    check('unauthenticated: 401', (await api('/api/workflows', { method: 'POST', body: wf() })).status === 401);

    const noRoot = await api('/api/workflows', { method: 'POST', token, body: wf() });
    check('a fresh account has no workflows root: 409 no-root, and nothing is made', noRoot.status === 409 && noRoot.json.code === 'no-root'
        && noRoot.json.rootId === null && !JSON.stringify((await api('/api/tree', { token })).json.roots).includes('"workflows"'), JSON.stringify(noRoot.json));

    // The extension (or a phone) pushes a tree with a workflows root.
    let pulled = (await api('/api/tree', { token })).json;
    const roots = [...pulled.roots, { id: 'wf-root', kind: 'folder', role: 'workflows', title: 'TabPaladin Workflows', children: [] }];
    const pushed = await api('/api/tree', { method: 'PUT', token, body: { roots, baseVersion: pulled.version } });
    check('(a pushed tree with a workflows root)', pushed.status === 200, JSON.stringify(pushed.json));
    pulled = (await api('/api/tree', { token })).json;
    const copy = JSON.parse(JSON.stringify(pulled.roots));
    const base = pulled.version;
    const history = async () => (await api('/api/history', { token })).json.snapshots.length;
    const historyBefore = await history();

    const other = await api('/api/workflows', { method: 'POST', token, body: { ...wf(), expectUserId: alex.user.id + 1 } });
    check('a request for another account: 412, nothing written', other.status === 412 && other.json.code === 'wrong-account');
    const otherServer = await api('/api/workflows', { method: 'POST', token, body: { ...wf(), expectServerId: 'another-server' } });
    check('  or for another server', otherServer.status === 412 && otherServer.json.code === 'wrong-account');
    for (const [name, body] of [
        ['a javascript: tab', wf({ tabs: [{ id: 'tab-000001', url: 'javascript:alert(1)' }] })],
        ['a data: tab', wf({ tabs: [{ id: 'tab-000001', url: 'data:text/html,x' }] })],
        ['a UNC tab', wf({ tabs: [{ id: 'tab-000001', url: 'file:////server/share/x' }] })],
        ['a browser page', wf({ tabs: [{ id: 'tab-000001', url: 'chrome://settings' }] })],
        [`${MAX_TABS + 1} tabs`, wf({ tabs: Array.from({ length: MAX_TABS + 1 }, (_, i) => ({ id: `tab-${String(i).padStart(6, '0')}`, url: 'https://a.com/' })) })]
    ]) {
        const r = await api('/api/workflows', { method: 'POST', token, body });
        check(`refused with a 400: ${name}`, r.status === 400 && typeof r.json.error === 'string', JSON.stringify(r.json).slice(0, 200));
    }
    check('  none of that wrote anything', (await api('/api/tree/version', { token })).json.version === base);
    const wrongRoot = await api('/api/workflows', { method: 'POST', token, body: { ...wf(), rootId: 'bm-root-or-anything' } });
    check('another rootId: 409 no-root naming this account\'s root', wrongRoot.status === 409 && wrongRoot.json.code === 'no-root' && wrongRoot.json.rootId === 'wf-root');

    const saved = await api('/api/workflows', { method: 'POST', token, body: { ...wf(), expectUserId: alex.user.id, expectServerId: alex.serverId } });
    check('saved: 200 with the versions, the created nodes and whose tree it is', saved.status === 200 && saved.json.baseVersion === base
        && saved.json.version > base && saved.json.created.length === 3 && saved.json.userId === alex.user.id && saved.json.serverId === alex.serverId,
        JSON.stringify(saved.json));
    const tree = (await api('/api/tree', { token })).json;
    const wfNode = tree.roots.find(r => r.id === 'wf-root').children.find(c => c.id === 'wf-0000001');
    check('  the tree has it, with payload {createdAt}', wfNode && wfNode.payload && wfNode.payload.createdAt === '2026-10-01T09:30:00.000Z'
        && wfNode.children.length === 2);
    const ops = (await api(`/api/tree/ops?since=${base}`, { token })).json;
    check('  /api/tree/ops has exactly one append for it', ops.complete && ops.ops.length === 1 && ops.ops[0].kind === 'append'
        && ops.ops[0].payload.nodes.length === 3 && ops.ops[0].payload.nodes[0].payload.createdAt === '2026-10-01T09:30:00.000Z', JSON.stringify(ops));
    check('  and no history snapshot', (await history()) === historyBefore);

    // A copy pulled before folds the op in and matches the server's tree.
    const sandbox = { self: {} };
    new Function('self', fs.readFileSync(path.join(ROOT, 'pwa', 'shareCore.js'), 'utf8'))(sandbox.self);
    const S = sandbox.self.TPShare;
    const folded = S.applyOps(ops.ops, S.wireAdapter(copy));
    // Key order aside: the same nodes, fields and order of children.
    const canon = (v) => (Array.isArray(v) ? v.filter(n => !(n && n.virtual)).map(canon)
        : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v);
    check('  a copy pulled before folds it in (shareCore.applyOps) and then matches the server, payload and all',
        folded.applied === 3 && JSON.stringify(canon(copy)) === JSON.stringify(canon(tree.roots)),
        `${JSON.stringify(folded)}\n      ${JSON.stringify(canon(copy))}\n      ${JSON.stringify(canon(tree.roots))}`);
    const refold = S.applyOps(ops.ops, S.wireAdapter(copy));
    check('  folding it again skips every id', refold.applied === 0 && refold.skipped === 3);

    const retry = await api('/api/workflows', { method: 'POST', token, body: wf() });
    check('a retry: 200, nothing created, the same version, every id already there', retry.status === 200 && retry.json.created.length === 0
        && retry.json.version === saved.json.version && retry.json.already.length === 3);
    const clash = await api('/api/workflows', { method: 'POST', token, body: wf({ id: 'wf-0000002', tabs: [{ id: 'tab-000002', url: 'https://x.example/' }] }) });
    check('an id already used for something else: 409 conflict naming it, nothing written', clash.status === 409 && clash.json.code === 'conflict'
        && eq(clash.json.ids, ['tab-000002']) && (await api('/api/tree/version', { token })).json.version === saved.json.version);

    // 500 tabs of 8 KB URLs: about 4 MB, past the 1 MB every other route takes.
    const long = (i) => {
        const head = `https://long.example/${String(i).padStart(4, '0')}/`;
        return head + 'x'.repeat(MAX_URL_BYTES - head.length);
    };
    const big = wf({ id: 'wf-big-0001', title: 'Big', tabs: Array.from({ length: MAX_TABS }, (_, i) => ({ id: `big-${String(i).padStart(6, '0')}`, title: `Tab ${i}`, url: long(i) })) });
    check('(the big request\'s URLs are 8 KB each)', Buffer.byteLength(big.workflow.tabs[0].url) === MAX_URL_BYTES && tabUrlProblem(big.workflow.tabs[0].url) === null);
    const bigRes = await api('/api/workflows', { method: 'POST', token, body: big });
    check(`${MAX_TABS} tabs of 8 KB URLs are taken (${(JSON.stringify(big).length / 1048576).toFixed(1)} MB)`, bigRes.status === 200 && bigRes.json.created.length === MAX_TABS + 1,
        `${bigRes.status} ${JSON.stringify(bigRes.json).slice(0, 200)}`);
    const tooBig = await api('/api/shares', { method: 'POST', token, raw: JSON.stringify({ sid: 'x'.repeat(20), url: 'https://a.com/', pad: 'y'.repeat(1.2 * 1048576) }) });
    check('  while every other route keeps its 1 MB limit', tooBig.status === 413, String(tooBig.status));

    // A second account never reaches into alex's tree.
    const users = await api('/api/users', { method: 'POST', token, body: { username: 'sam', password: PASSWORD, role: 'user', currentPassword: PASSWORD } });
    check('(a second account)', users.status === 200 || users.status === 201, JSON.stringify(users.json));
    const sam = await login('sam');
    const samTry = await api('/api/workflows', { method: 'POST', token: sam.token, body: wf({ id: 'wf-sam-0001', tabs: [] }) });
    check('sam naming alex\'s root gets no-root, with no root of his own made', samTry.status === 409 && samTry.json.code === 'no-root' && samTry.json.rootId === null
        && !JSON.stringify((await api('/api/tree', { token: sam.token })).json.roots).includes('wf-sam-0001'));
    check('  and alex\'s tree is as it was', (await api('/api/tree/version', { token })).json.version === bigRes.json.version);
} catch (e) {
    failures++;
    console.error(`FAIL  live server: ${e.stack || e}\n${serverLog}`);
} finally {
    server.kill();
    await exited;
    fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nAll workflow-append tests passed.\n' : `\n${failures} test(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
