// Tests for the share inbox and filing (server/shares.js), the tree's ops log
// as clients see it (/api/tree/ops), and the forced-push safety net.
//
// What this locks down:
//   1. The migration: on a database that already holds inbox rows, the new
//      columns are added, every value the rows had is unchanged, they are
//      the owner's, pending, and come back from the legacy GET /api/shared
//      exactly as before. Running it again is a no-op.
//   2. Intake: idempotent on sid; only http(s) links; oversized fields
//      refused, except raw, which is cut to fit; accounts never see or touch
//      each other's shares, and a share meant for another account (or
//      server) is refused with 412; an X link is archived on arrival, as the
//      capture route always did.
//   3. Filing: a bookmark at the end of each folder, one version bump, one
//      logged append and no history snapshot; a retry is "already" and moves
//      nothing; missing folders are reported, all-missing is a 422 that
//      changes nothing; notes, workflows and the virtual archive refuse; a
//      new folder is made with the client's id and reused on retry; the same
//      link shared again is filed with it; an X share's archive row is
//      marked filed.
//   4. Undo takes back only what is unchanged — bookmarks still carrying
//      the URL, folders still empty — logs an unappend, and gives an X share
//      back to its archive.
//   5. Dismiss and restore, statistics, and the legacy routes, whose DELETEs
//      only dismiss the caller's waiting links.
//   6. A forced push from an older base that erases a filed link puts the
//      share back in the inbox, saying why; a push that saw the bookmark and
//      deleted it leaves the share filed, marked not present, and so does
//      every later forced push, which did not erase it.
//   7. The rehearsal: a database the schema-3 server (with accounts, before
//      this inbox) wrote through its own API is upgraded by this one. A
//      pre-upgrade copy is taken first; every table's rows are still there;
//      each account's tree (same version), history, inbox, proposals,
//      archives and prefs read back identically; the inbox rows are pending
//      shares on the new routes; and a client pushes and pulls unchanged.
//
// Run: node tools/test_shares.mjs [--port 18985] [--old-port 18987] [--schema3-rev 2d7eec3]
//
// Starts this checkout's server on the port, on throwaway data directories:
// one made from a database written the way the server before accounts wrote
// it, and one written by the schema-3 server read out of git (skipped without
// git).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from '../server/node_modules/better-sqlite3/lib/index.js';
import { hashPassword } from '../server/security.js';
import { migrateUsers, SCHEMA_VERSION } from '../server/users.js';
import { migrateOwnership, digestTables } from '../server/tenancy.js';
import { makeItemsStore } from '../server/items.js';
import { migrateShares } from '../server/shares.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const arg = (name, fallback = null) => {
    const i = process.argv.indexOf('--' + name);
    return i === -1 ? fallback : process.argv[i + 1];
};
const PORT = Number(arg('port') || 18985);
const BASE = `http://127.0.0.1:${PORT}`;
const OLD_PORT = Number(arg('old-port') || 18987);
const SCHEMA3_REV = arg('schema3-rev') || '2d7eec3';
const PASSWORD = 'correct horse battery';
const T = '2026-09-01T00:00:00.000Z';

let failures = 0;
function check(name, cond, detail) {
    if (cond) console.log(`  ok  ${name}`);
    else { failures++; console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// --- A database as the server before accounts left it --------------------------

async function legacyDb(file) {
    const db = new Database(file);
    db.exec(`
        CREATE TABLE snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, device_id TEXT, json TEXT NOT NULL);
        CREATE TABLE shared_links (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, title TEXT, created_at TEXT NOT NULL);
        CREATE INDEX idx_shared_created ON shared_links(created_at DESC);
        CREATE TABLE share_tokens (token TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
        CREATE TABLE note_proposals (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL,
            notebook TEXT, kind TEXT NOT NULL DEFAULT 'note');
        CREATE TABLE users (username TEXT PRIMARY KEY, password_hash TEXT NOT NULL, created_at TEXT NOT NULL,
            id INTEGER, role TEXT NOT NULL DEFAULT 'user');
        CREATE UNIQUE INDEX idx_users_id ON users(id);
        CREATE TABLE sessions (token TEXT PRIMARY KEY, username TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
        CREATE TABLE items (id TEXT PRIMARY KEY, parent_id TEXT, position INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL, role TEXT,
            title TEXT NOT NULL DEFAULT '', url TEXT, payload TEXT, created_at TEXT, updated_at TEXT);
        CREATE TABLE tree_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    db.prepare("INSERT INTO users VALUES ('alex', ?, ?, 1, 'admin')").run(await hashPassword(PASSWORD), T);
    const item = db.prepare('INSERT INTO items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    item.run('bm', null, 0, 'folder', 'bookmarks', 'Bookmarks', null, null, T, T);
    item.run('ai', 'bm', 0, 'folder', null, 'AI', null, null, T, T);
    item.run('p1', 'ai', 0, 'bookmark', null, 'Paper 1', 'https://arxiv.org/abs/1', null, T, T);
    item.run('p2', 'ai', 1, 'bookmark', null, 'Paper 2', 'https://arxiv.org/abs/2', null, T, T);
    item.run('dev', 'bm', 1, 'folder', null, 'Dev', null, null, T, T);
    item.run('nr', null, 1, 'folder', 'notes', 'Notes', null, null, T, T);
    item.run('nb', 'nr', 0, 'folder', null, 'Book', null, null, T, T);
    item.run('wf', null, 2, 'folder', 'workflows', 'Workflows', null, null, T, T);
    item.run('wf1', 'wf', 0, 'folder', null, 'Morning', null, null, T, T);
    db.prepare("INSERT INTO tree_meta VALUES ('treeVersion', '41')").run();
    db.prepare('INSERT INTO snapshots (timestamp, device_id, json) VALUES (?, ?, ?)').run(T, 'pwa', JSON.stringify({ format: 2, roots: [] }));
    db.prepare("INSERT INTO shared_links (url, title, created_at) VALUES ('https://inbox-1.example/a', 'One', '2026-09-01T00:00:01.000Z'), ('https://inbox-2.example/b', NULL, '2026-09-01T00:00:02.000Z')").run();
    db.pragma('user_version = 2');
    return db;
}

// --- 1. The migration, headless ---------------------------------------------------

async function migrationTests() {
    console.log('\n1. The migration keeps every inbox row as it was');
    const db = await legacyDb(':memory:');
    const before = db.prepare('SELECT id, url, title, created_at FROM shared_links ORDER BY id').all();
    migrateUsers(db);
    const items = makeItemsStore(db);
    migrateOwnership(db, { env: {} });
    const digest = digestTables(db, ['shared_links']);
    const first = migrateShares(db);
    check('the new columns are added', ['sid', 'url_key', 'app', 'source', 'raw', 'status', 'note', 'updated_at', 'filed_at']
        .every(c => first.added.includes(c)), JSON.stringify(first.added));
    const after = digestTables(db, ['shared_links'], { like: digest });
    check('every value the rows had is unchanged', after.shared_links.sha256 === digest.shared_links.sha256 && after.shared_links.n === 2);
    const rows = db.prepare('SELECT * FROM shared_links ORDER BY id').all();
    check('they are the owner\'s and pending', rows.every(r => r.user_id === 1 && r.status === 'pending' && r.sid === null));
    check('  and read back as they were',
        JSON.stringify(rows.map(r => ({ id: r.id, url: r.url, title: r.title, created_at: r.created_at }))) === JSON.stringify(before));
    const schema = () => db.prepare("SELECT name, sql FROM sqlite_master WHERE tbl_name IN ('shared_links', 'share_filings') ORDER BY name").all();
    const s1 = JSON.stringify(schema());
    const again = migrateShares(db);
    check('running it again is a no-op', again.added.length === 0 && JSON.stringify(schema()) === s1
        && JSON.stringify(db.prepare('SELECT * FROM shared_links ORDER BY id').all()) === JSON.stringify(rows));
    check('share_filings has its owner guard', Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'share_filings_owner_insert'").get()));
    items.initOpsFloors();
    db.close();

    const bare = new Database(':memory:');
    bare.exec('CREATE TABLE shared_links (id INTEGER PRIMARY KEY, url TEXT NOT NULL, title TEXT, created_at TEXT NOT NULL)');
    let refused = null;
    try { migrateShares(bare); } catch (e) { refused = e; }
    check('before the ownership migration it refuses, changing nothing',
        refused && /ownership migration/.test(refused.message) && bare.prepare('PRAGMA table_info(shared_links)').all().length === 4);
    bare.close();
}

// --- The live server ----------------------------------------------------------------

function startServer(dataDir, { entry = path.join(REPO, 'server', 'index.js'), port = PORT } = {}) {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^(AUTH_TOKEN|TABPALADIN_TOKEN|ADMIN_|TENANCY_OWNER|IMPORT_|MAX_)/.test(k)) delete env[k];
    const child = spawn(process.execPath, [entry], {
        env: { ...env, PORT: String(port), DATA_DIR: dataDir, PWA_DIR: path.join(REPO, 'pwa'), IMPORTS_SCHEDULER: 'off',
            ADMIN_USERNAME: 'alex', ADMIN_PASSWORD: PASSWORD, MAX_INBOX_PER_USER: '50' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    child.stdout.on('data', d => { log += d; });
    child.stderr.on('data', d => { log += d; });
    let exitCode;
    const exited = new Promise(r => child.on('exit', code => { exitCode = code; r(code); }));
    const base = `http://127.0.0.1:${port}`;
    return {
        base,
        log: () => log,
        async ready() {
            for (let i = 0; i < 150; i++) {
                if (exitCode !== undefined) throw new Error(`server exited (${exitCode}):\n${log}`);
                try { if ((await fetch(base + '/api/health')).ok) return; } catch (e) { /* not yet */ }
                await new Promise(r => setTimeout(r, 100));
            }
            throw new Error('server did not come up:\n' + log);
        },
        async stop() { if (exitCode === undefined) child.kill(); await exited; }
    };
}

async function http(p, { method = 'GET', token, body, base = BASE } = {}) {
    const res = await fetch(base + p, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await res.json(); } catch (e) { /* not JSON */ }
    return { status: res.status, json };
}

const sid = (n) => `test-share-${String(n).padStart(8, '0')}`;
const findNode = (nodes, id) => {
    for (const n of nodes || []) {
        if (n.id === id) return n;
        const hit = findNode(n.children, id);
        if (hit) return hit;
    }
    return null;
};
const titlesIn = (tree, id) => (findNode(tree.roots, id)?.children || []).map(c => c.title);

async function liveTests() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-shares-'));
    const legacy = await legacyDb(path.join(dataDir, 'sync.db'));
    const oldInbox = legacy.prepare('SELECT id, url, title, created_at FROM shared_links ORDER BY created_at DESC').all();
    legacy.close();
    let srv = startServer(dataDir);
    try {
        await srv.ready();
        const raw = () => new Database(path.join(dataDir, 'sync.db'), { readonly: true });

        console.log('\n2. The upgrade, booted for real');
        check('a pre-upgrade copy was taken first', fs.readdirSync(dataDir).some(f => /^sync\.db\.pre-v\d+-/.test(f)), fs.readdirSync(dataDir).join(', '));
        check('the boot log says what the inbox gained', /Share inbox: added sid, url_key/.test(srv.log()), srv.log());
        const A = (await http('/api/login', { method: 'POST', body: { username: 'alex', password: PASSWORD } })).json.token;
        const legacyGet = await http('/api/shared', { token: A });
        check('the legacy GET /api/shared serves the same inbox, in the same shape',
            JSON.stringify(legacyGet.json) === JSON.stringify({ ok: true, links: oldInbox }), JSON.stringify(legacyGet.json));
        const pending0 = (await http('/api/shares', { token: A })).json.shares;
        check('and GET /api/shares lists them as pending legacy shares, addressable by row',
            pending0.length === 2 && pending0.every(s => s.status === 'pending' && s.source === 'legacy' && /^id-\d+$/.test(s.sid)), JSON.stringify(pending0));

        for (const [method, p] of [['GET', '/api/shares'], ['POST', '/api/shares'], ['GET', '/api/shares/stats'], ['GET', `/api/shares/${sid(1)}`],
            ['POST', `/api/shares/${sid(1)}/file`], ['POST', `/api/shares/${sid(1)}/unfile`], ['POST', `/api/shares/${sid(1)}/dismiss`],
            ['POST', `/api/shares/${sid(1)}/restore`], ['GET', '/api/tree/ops?since=1'], ['GET', '/api/prefs/share'], ['PUT', '/api/prefs/share'],
            ['GET', '/api/shared']]) {
            const r = await http(p, { method, body: method === 'GET' ? undefined : {} });
            check(`${method} ${p.replace(sid(1), ':sid')} without a token -> 401`, r.status === 401, `HTTP ${r.status}`);
        }

        console.log('\n3. Intake');
        const intake = (token, n, extra = {}) => http('/api/shares', { method: 'POST', token, body: {
            sid: sid(n), url: `https://example.com/page-${n}`, title: `Page ${n}`, app: 'site:example.com',
            urlKey: `example.com/page-${n}`, source: 'share', raw: { title: `Page ${n}`, text: '', url: `https://example.com/page-${n}?utm_source=x` }, ...extra
        } });
        const s1 = await intake(A, 1);
        check('a share is taken in', s1.status === 200 && s1.json.created === true && s1.json.share.sid === sid(1)
            && s1.json.share.status === 'pending' && s1.json.share.filings.length === 0, JSON.stringify(s1.json));
        const s1again = await intake(A, 1, { title: 'Changed on retry' });
        check('a retry with the same sid returns the same row, unchanged', s1again.json.created === false && s1again.json.share.id === s1.json.share.id
            && s1again.json.share.title === 'Page 1');
        const one = await http(`/api/shares/${sid(1)}`, { token: A });
        check('GET /api/shares/:sid returns it', one.status === 200 && one.json.share.url === 'https://example.com/page-1');
        for (const [what, extra] of [
            ['a javascript: URL', { url: 'javascript:alert(1)' }],
            ['a data: URL', { url: 'data:text/html,<script>alert(1)</script>' }],
            ['an over-long URL', { url: 'https://example.com/' + 'x'.repeat(5000) }],
            ['an over-long title', { title: 't'.repeat(1001) }],
            ['a malformed sid', { sid: 'short' }],
            ['a malformed app', { app: 'Not An App!' }],
            ['an unknown source', { source: 'carrier-pigeon' }]
        ]) {
            const r = await intake(A, 900 + Math.floor(Math.random() * 99), extra);
            check(`${what} is refused with 400`, r.status === 400, `HTTP ${r.status} ${JSON.stringify(r.json)}`);
        }
        // raw is only context: past 10 KB it is cut to fit, never a reason to
        // lose the link. 3,500 CJK characters and a long subject are over it.
        const rawOf = (n) => { const d = raw(); const r = d.prepare('SELECT raw FROM shared_links WHERE user_id = 1 AND sid = ?').get(sid(n)); d.close(); return r && r.raw; };
        const big = await intake(A, 880, { raw: { title: 'Т'.repeat(3000), text: '中'.repeat(3500), url: 'https://example.com/page-880' } });
        const bigRaw = rawOf(880);
        check('an over-large raw is taken in, its text cut to fit', big.status === 200 && big.json.created === true && bigRaw
            && Buffer.byteLength(bigRaw, 'utf8') <= 10 * 1024 && JSON.parse(bigRaw).url === 'https://example.com/page-880'
            && /^中+$/.test(JSON.parse(bigRaw).text) && JSON.parse(bigRaw).text.length < 3500 && JSON.parse(bigRaw).title.length === 3000,
            `HTTP ${big.status} ${bigRaw && Buffer.byteLength(bigRaw, 'utf8')}`);
        const huge = await intake(A, 881, { raw: { title: 't'.repeat(11 * 1024), text: 'r'.repeat(11 * 1024) } });
        const hugeRaw = rawOf(881);
        check('  and its title too when the text alone is not enough', huge.status === 200 && hugeRaw && JSON.parse(hugeRaw).text === ''
            && Buffer.byteLength(hugeRaw, 'utf8') <= 10 * 1024 && JSON.parse(hugeRaw).title.length > 0, `HTTP ${huge.status}`);
        const blob = await intake(A, 882, { raw: 'x'.repeat(11 * 1024) });
        check('  and a raw string that does not fit is dropped', blob.status === 200 && rawOf(882) === null, `HTTP ${blob.status}`);

        // A share kept on a phone for one account is never taken in by another.
        const me = (await http('/api/auth/me', { token: A })).json;
        const otherUser = await intake(A, 883, { expectUserId: 999 });
        const otherServer = await intake(A, 884, { expectServerId: 'another-server' });
        check('a share meant for another account or server: 412 wrong-account, nothing taken in',
            otherUser.status === 412 && otherUser.json.code === 'wrong-account' && otherServer.status === 412
            && (await http(`/api/shares/${sid(883)}`, { token: A })).status === 404 && (await http(`/api/shares/${sid(884)}`, { token: A })).status === 404,
            JSON.stringify([otherUser.json, otherServer.json]));
        const rightOne = await intake(A, 885, { expectUserId: me.user.id, expectServerId: me.serverId });
        check('  and one meant for this account goes in', rightOne.status === 200 && rightOne.json.created === true, JSON.stringify(rightOne.json));
        const xs = await http('/api/shares', { method: 'POST', token: A, body: { sid: sid(2), url: 'https://x.com/nasa/status/123', title: 'Post by @nasa', app: 'x', urlKey: 'x.com/nasa/status/123' } });
        check('an X link is archived on arrival', xs.json.share.status === 'archived' && xs.json.archived && xs.json.archived.provider === 'x'
            && xs.json.archived.duplicate === false, JSON.stringify(xs.json));
        const xSource = (await http('/api/imports', { token: A })).json.sources.find(s => s.provider === 'x');
        check('  into the account\'s X archive', xSource && xSource.items === 1);

        // A second account.
        const made = await http('/api/users', { method: 'POST', token: A, body: { username: 'sam', password: 'sam-password-1', role: 'user', currentPassword: PASSWORD } });
        const S = (await http('/api/login', { method: 'POST', body: { username: 'sam', password: 'sam-password-1' } })).json.token;
        check('sam sees none of alex\'s shares', made.status === 200 && (await http('/api/shares', { token: S })).json.shares.length === 0
            && (await http('/api/shares?status=archived', { token: S })).json.shares.length === 0);
        check('  and gets 404 for each of them, whatever the verb',
            (await http(`/api/shares/${sid(1)}`, { token: S })).status === 404
            && (await http(`/api/shares/${sid(1)}/file`, { method: 'POST', token: S, body: { targets: [{ folderId: 'dev' }] } })).status === 404
            && (await http(`/api/shares/${sid(1)}/dismiss`, { method: 'POST', token: S })).status === 404
            && (await http(`/api/shares/id-${pending0[0].id}/dismiss`, { method: 'POST', token: S })).status === 404);
        const samSame = await intake(S, 1);
        check('the same sid from sam is sam\'s own share', samSame.json.created === true && samSame.json.share.id !== s1.json.share.id
            && (await http(`/api/shares/${sid(1)}`, { token: A })).json.share.id === s1.json.share.id);
        const samInto = await http(`/api/shares/${sid(1)}/file`, { method: 'POST', token: S, body: { targets: [{ folderId: 'dev' }] } });
        check('sam filing into alex\'s folder id: 422, it is not in his tree', samInto.status === 422 && samInto.json.failed[0].reason === 'missing');

        console.log('\n4. Filing');
        const db0 = raw();
        const snaps = () => { const d = raw(); const n = d.prepare('SELECT COUNT(*) AS n FROM snapshots WHERE user_id = 1').get().n; d.close(); return n; };
        const opsOf = () => { const d = raw(); const r = d.prepare('SELECT version, base_version, kind FROM tree_ops WHERE user_id = 1 ORDER BY version').all(); d.close(); return r; };
        db0.close();
        const v0 = (await http('/api/tree/version', { token: A })).json.version;
        // The log may already hold the source's YouTube folder; these count what filing adds.
        const opsSince = () => opsOf().filter(o => o.version > v0);
        const snaps0 = snaps();
        const f1 = await http(`/api/shares/${sid(1)}/file`, { method: 'POST', token: A, body: { targets: [{ folderId: 'ai' }, { folderId: 'dev' }] } });
        const tree1 = (await http('/api/tree', { token: A })).json;
        check('filing appends at the end of each folder', f1.status === 200 && f1.json.created.length === 2
            && JSON.stringify(titlesIn(tree1, 'ai')) === '["Paper 1","Paper 2","Page 1"]' && JSON.stringify(titlesIn(tree1, 'dev')) === '["Page 1"]',
            JSON.stringify(f1.json));
        check('  bumping the version exactly once', f1.json.baseVersion === v0 && f1.json.version === tree1.version && tree1.version > v0
            && opsSince().length === 1 && opsSince()[0].base_version === v0 && opsSince()[0].version === tree1.version);
        check('  as a logged append, with no history snapshot', opsSince()[0].kind === 'append' && snaps() === snaps0);
        check('  and the share is filed, with both filings present', f1.json.share.status === 'filed' && f1.json.share.filedAt
            && f1.json.share.filings.length === 2 && f1.json.share.filings.every(f => f.present));
        check('  the answer says whose tree it changed, on which server', f1.json.userId === 1 && typeof f1.json.serverId === 'string' && f1.json.serverId.length > 0,
            JSON.stringify({ userId: f1.json.userId, serverId: f1.json.serverId }));
        const ops1 = await http(`/api/tree/ops?since=${v0}`, { token: A });
        check('/api/tree/ops from before it is complete, naming the account and the server', ops1.json.complete === true && ops1.json.ops.length === 1
            && ops1.json.ops[0].payload.nodes.length === 2 && ops1.json.userId === 1 && typeof ops1.json.serverId === 'string', JSON.stringify(ops1.json));
        const f1again = await http(`/api/shares/${sid(1)}/file`, { method: 'POST', token: A, body: { targets: [{ folderId: 'ai' }, { folderId: 'dev' }] } });
        check('a retry is "already" for both, and moves nothing', f1again.status === 200 && f1again.json.created.length === 0
            && f1again.json.already.length === 2 && f1again.json.version === f1.json.version
            && (await http('/api/tree/version', { token: A })).json.version === f1.json.version && opsSince().length === 1);

        await intake(A, 3);
        const vBefore3 = (await http('/api/tree/version', { token: A })).json.version;
        const wrongFile = await http(`/api/shares/${sid(3)}/file`, { method: 'POST', token: A, body: { targets: [{ folderId: 'dev' }], expectUserId: 999 } });
        check('a filing meant for another account: 412, nothing filed', wrongFile.status === 412 && wrongFile.json.code === 'wrong-account'
            && (await http(`/api/shares/${sid(3)}`, { token: A })).json.share.status === 'pending'
            && (await http('/api/tree/version', { token: A })).json.version === vBefore3);
        const missing = await http(`/api/shares/${sid(3)}/file`, { method: 'POST', token: A, body: { targets: [{ folderId: 'nowhere' }] } });
        check('a missing folder: 422, failed[] says why, nothing changes', missing.status === 422 && missing.json.failed[0].reason === 'missing'
            && (await http(`/api/shares/${sid(3)}`, { token: A })).json.share.status === 'pending'
            && (await http('/api/tree/version', { token: A })).json.version === vBefore3);
        const ro = await http(`/api/shares/${sid(3)}/file`, { method: 'POST', token: A,
            body: { targets: [{ folderId: 'nr' }, { folderId: 'nb' }, { folderId: 'wf1' }, { folderId: 'imp:src:1' }, { folderId: 'imports:root' }] } });
        check('notes, a notebook, a workflow and the virtual archive are refused as read-only',
            ro.status === 422 && ro.json.failed.length === 5 && ro.json.failed.every(f => f.reason === 'read-only'), JSON.stringify(ro.json));
        const partial = await http(`/api/shares/${sid(3)}/file`, { method: 'POST', token: A,
            body: { targets: [{ folderId: 'dev' }, { folderId: 'gone-folder' }] } });
        check('one good and one missing target: filed where it can be, the other reported',
            partial.status === 200 && partial.json.created.length === 1 && partial.json.failed[0].folderId === 'gone-folder');

        await intake(A, 4);
        const nf = { newFolder: { id: 'bbbbbbbbbbbbbbbb', title: 'Talks', parentId: 'bm' } };
        const f4 = await http(`/api/shares/${sid(4)}/file`, { method: 'POST', token: A, body: { targets: [nf] } });
        await intake(A, 5);
        const f5 = await http(`/api/shares/${sid(5)}/file`, { method: 'POST', token: A, body: { targets: [nf] } });
        const tree5 = (await http('/api/tree', { token: A })).json;
        check('a new folder is made with the client\'s id, inside its parent', f4.json.created.map(n => n.kind).join() === 'folder,bookmark'
            && findNode(tree5.roots, 'bbbbbbbbbbbbbbbb')?.title === 'Talks' && findNode(tree5.roots, 'bm').children.some(c => c.id === 'bbbbbbbbbbbbbbbb'));
        check('  and the same id again reuses it', f5.json.created.map(n => n.kind).join() === 'bookmark'
            && JSON.stringify(titlesIn(tree5, 'bbbbbbbbbbbbbbbb')) === '["Page 4","Page 5"]');

        // The same link shared twice: filing one files the other.
        for (const n of [6, 7]) {
            await http('/api/shares', { method: 'POST', token: A, body: { sid: sid(n), url: 'https://twin.example/post', urlKey: 'twin.example/post', app: 'site:twin.example' } });
        }
        await http(`/api/shares/${sid(6)}/file`, { method: 'POST', token: A, body: { targets: [{ folderId: 'dev' }] } });
        const twin = (await http(`/api/shares/${sid(7)}`, { token: A })).json.share;
        check('another pending share of the same link is filed with it', twin.status === 'filed' && twin.note === `filed with ${sid(6)}`, JSON.stringify(twin));

        const fx = await http(`/api/shares/${sid(2)}/file`, { method: 'POST', token: A, body: { targets: [{ folderId: 'dev' }] } });
        const xItems = (await http(`/api/imports/${xSource.id}/items`, { token: A })).json.items;
        const archiveDrawn = () => http('/api/tree', { token: A }).then(r => JSON.stringify(findNode(r.json.roots, 'imports:root') || {}));
        check('filing an X share marks its archive row filed, so it is not drawn twice', fx.status === 200 && fx.json.share.status === 'filed'
            && xItems[0].filed === true && !(await archiveDrawn()).includes('nasa/status/123'), JSON.stringify(xItems));

        console.log('\n5. Undo');
        const ux = await http(`/api/shares/${sid(2)}/unfile`, { method: 'POST', token: A, body: {} });
        check('undoing the X share takes the bookmark back and returns it to its archive', ux.status === 200 && ux.json.removed.length === 1
            && ux.json.share.status === 'archived' && (await http(`/api/imports/${xSource.id}/items`, { token: A })).json.items[0].filed === false
            && (await archiveDrawn()).includes('nasa/status/123'));
        check('  logged as an unappend', opsOf().at(-1).kind === 'unappend');

        await intake(A, 8);
        const f8 = await http(`/api/shares/${sid(8)}/file`, { method: 'POST', token: A,
            body: { targets: [{ newFolder: { id: 'cccccccccccccccc', title: 'Made by the sheet', parentId: 'bm' } }] } });
        const u8 = await http(`/api/shares/${sid(8)}/unfile`, { method: 'POST', token: A, body: {} });
        const tree8 = (await http('/api/tree', { token: A })).json;
        check('undo takes back the bookmark and the folder it made, still empty', f8.status === 200 && u8.json.removed.length === 2
            && !findNode(tree8.roots, 'cccccccccccccccc') && u8.json.share.status === 'pending' && u8.json.share.filings.length === 0);

        await intake(A, 9);
        await http(`/api/shares/${sid(9)}/file`, { method: 'POST', token: A,
            body: { targets: [{ newFolder: { id: 'dddddddddddddddd', title: 'Edited later', parentId: 'bm' } }] } });
        // Another device pulls, changes the filed bookmark's URL and pushes.
        const t9 = (await http('/api/tree', { token: A })).json;
        const bm9 = findNode(t9.roots, 'dddddddddddddddd').children[0];
        bm9.url = 'https://example.com/edited-elsewhere';
        await http('/api/tree', { method: 'PUT', token: A, body: { roots: t9.roots, baseVersion: t9.version, deviceId: 'laptop' } });
        const u9 = await http(`/api/shares/${sid(9)}/unfile`, { method: 'POST', token: A, body: {} });
        const tree9 = (await http('/api/tree', { token: A })).json;
        check('a bookmark changed since is kept, and so is its folder, no longer empty', u9.json.removed.length === 0
            && u9.json.kept.length === 2 && findNode(tree9.roots, 'dddddddddddddddd').children.length === 1, JSON.stringify(u9.json));
        check('  the share waits again all the same', u9.json.share.status === 'pending');

        const u1 = await http(`/api/shares/${sid(1)}/unfile`, { method: 'POST', token: A, body: { folderIds: ['dev'] } });
        check('undo can name one folder; the other filing stays', u1.json.removed.length === 1 && u1.json.share.status === 'filed'
            && u1.json.share.filings.length === 1 && u1.json.share.filings[0].folderId === 'ai');

        console.log('\n6. Dismiss, restore, statistics and the legacy routes');
        await intake(A, 10);
        const d10 = await http(`/api/shares/${sid(10)}/dismiss`, { method: 'POST', token: A });
        check('dismiss takes a share out of the inbox without deleting it', d10.json.share.status === 'dismissed'
            && !(await http('/api/shares', { token: A })).json.shares.some(s => s.sid === sid(10))
            && (await http('/api/shares?status=dismissed', { token: A })).json.shares.some(s => s.sid === sid(10))
            && !(await http('/api/shared', { token: A })).json.links.some(l => l.url === 'https://example.com/page-10'));
        const r10 = await http(`/api/shares/${sid(10)}/restore`, { method: 'POST', token: A });
        check('  and restore brings it back', r10.json.share.status === 'pending');
        const stats = (await http('/api/shares/stats', { token: A })).json.apps;
        const ex = stats['site:example.com'] || [];
        check('stats count filings per app and folder, most used first', ex.length >= 2 && ex[0].n >= ex[1].n
            && ex.some(f => f.folderId === 'ai' && f.n === 1) && ex.every(f => f.last), JSON.stringify(stats));
        check('  and sam\'s are his own', Object.keys((await http('/api/shares/stats', { token: S })).json.apps).length === 0);
        check('GET /api/shares?status=filed lists filed shares with their filings',
            (await http('/api/shares?status=filed', { token: A })).json.shares.some(s => s.sid === sid(1) && s.filings[0].folderId === 'ai'));

        const legacyBad = await http('/api/shared', { method: 'POST', token: A, body: { url: 'javascript:alert(1)' } });
        const legacyOk = await http('/api/shared', { method: 'POST', token: A, body: { url: 'https://legacy-client.example/', title: 'Old app' } });
        check('the legacy POST /api/shared refuses a non-http link and takes an http one in the old shape',
            legacyBad.status === 400 && legacyOk.status === 200 && Number.isInteger(legacyOk.json.id) && legacyOk.json.createdAt
            && (await http('/api/shared', { token: A })).json.links.some(l => l.id === legacyOk.json.id));
        await http(`/api/shared/${pending0[0].id}`, { method: 'DELETE', token: A });
        const d = raw();
        const kept = d.prepare('SELECT status FROM shared_links WHERE user_id = 1 AND id = ?').get(pending0[0].id);
        d.close();
        check('the legacy DELETE /api/shared/:id only dismisses', kept && kept.status === 'dismissed'
            && !(await http('/api/shared', { token: A })).json.links.some(l => l.id === pending0[0].id));
        const alexPendingBefore = (await http('/api/shares', { token: A })).json.shares.length;
        await http('/api/shared', { method: 'DELETE', token: S });
        check('sam\'s DELETE /api/shared leaves alex\'s inbox alone', (await http('/api/shares', { token: A })).json.shares.length === alexPendingBefore
            && alexPendingBefore > 0);
        await http('/api/shared', { method: 'DELETE', token: A });
        const d2 = raw();
        const statuses = d2.prepare('SELECT status, COUNT(*) AS n FROM shared_links WHERE user_id = 1 GROUP BY status').all();
        const samRows = d2.prepare('SELECT status FROM shared_links WHERE user_id = ?').all(made.json.user.id);
        d2.close();
        check('alex\'s DELETE /api/shared dismisses his waiting links and deletes none', (await http('/api/shared', { token: A })).json.links.length === 0
            && !statuses.some(s => s.status === 'pending') && statuses.find(s => s.status === 'dismissed').n >= alexPendingBefore
            && samRows.every(r => r.status === 'dismissed') && samRows.length === 1, JSON.stringify(statuses));

        console.log('\n7. A forced push that erases a filed link');
        await intake(A, 11);
        const base11 = (await http('/api/tree', { token: A })).json;
        const f11 = await http(`/api/shares/${sid(11)}/file`, { method: 'POST', token: A, body: { targets: [{ folderId: 'dev' }] } });
        // A device that last pulled before the filing forces its copy up.
        const forced = await http('/api/tree', { method: 'PUT', token: A, body: { roots: base11.roots, baseVersion: base11.version, force: true, deviceId: 'old-laptop' } });
        const s11 = (await http(`/api/shares/${sid(11)}`, { token: A })).json.share;
        check('the share is back in the inbox, saying why', f11.status === 200 && forced.status === 200 && s11.status === 'pending'
            && s11.note === 'Removed by a forced push from old-laptop' && s11.filings.length === 0, JSON.stringify(s11));
        check('  and the ops log no longer reaches past the push', !(await http(`/api/tree/ops?since=${f11.json.baseVersion}`, { token: A })).json.complete);

        await intake(A, 12);
        const f12 = await http(`/api/shares/${sid(12)}/file`, { method: 'POST', token: A, body: { targets: [{ folderId: 'ai' }] } });
        const t12 = (await http('/api/tree', { token: A })).json;
        const ai12 = findNode(t12.roots, 'ai');
        ai12.children = ai12.children.filter(c => c.id !== f12.json.created[0].id);
        const deliberate = await http('/api/tree', { method: 'PUT', token: A, body: { roots: t12.roots, baseVersion: t12.version, deviceId: 'phone' } });
        const s12 = (await http(`/api/shares/${sid(12)}`, { token: A })).json.share;
        check('a push that saw the bookmark and deleted it leaves the share filed, marked not present',
            deliberate.status === 200 && s12.status === 'filed' && s12.filings.length === 1 && s12.filings[0].present === false, JSON.stringify(s12));
        // A device that last pulled before both the filing and that delete
        // forces its copy up: it erased nothing of 12's, which was gone already.
        const laterForce = await http('/api/tree', { method: 'PUT', token: A, body: { roots: (await http('/api/tree', { token: A })).json.roots.filter(r => !r.virtual),
            baseVersion: f12.json.baseVersion, force: true, deviceId: 'laptop-b' } });
        const s12b = (await http(`/api/shares/${sid(12)}`, { token: A })).json.share;
        check('a later forced push from before the filing leaves a link deleted on purpose deleted: still filed, no note',
            laterForce.status === 200 && s12b.status === 'filed' && s12b.filings.length === 1 && !s12b.note, JSON.stringify(s12b));
        const fresh = await http('/api/tree', { method: 'PUT', token: A, body: { roots: (await http('/api/tree', { token: A })).json.roots.filter(r => !r.virtual),
            force: true, deviceId: 'fresh-install' } });
        const s12c = (await http(`/api/shares/${sid(12)}`, { token: A })).json.share;
        check('  and so does a forced push with no base at all that erases nothing', fresh.status === 200 && s12c.status === 'filed' && !s12c.note,
            JSON.stringify(s12c));
        await intake(A, 13);
        const t13 = (await http('/api/tree', { token: A })).json;
        const f13 = await http(`/api/shares/${sid(13)}/file`, { method: 'POST', token: A, body: { targets: [{ folderId: 'dev' }] } });
        const forced13 = await http('/api/tree', { method: 'PUT', token: A, body: { roots: t13.roots.filter(r => !r.virtual), force: true, deviceId: 'fresh-install' } });
        const s13 = (await http(`/api/shares/${sid(13)}`, { token: A })).json.share;
        check('  while one that does erase a filed link still gives it back', f13.status === 200 && forced13.status === 200 && s13.status === 'pending'
            && s13.note === 'Removed by a forced push from fresh-install', JSON.stringify(s13));

        console.log('\n8. Later boots');
        await srv.stop();
        srv = startServer(dataDir);
        await srv.ready();
        check('a restart adds nothing and keeps every share', !/Share inbox: added/.test(srv.log())
            && (await http(`/api/shares/${sid(12)}`, { token: A })).json.share.status === 'filed');
    } catch (e) {
        failures++;
        console.error('FAIL  run stopped:', e, '\n' + srv.log());
    } finally {
        await srv.stop();
        try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) { /* temp */ }
    }
}

// --- 9. The rehearsal: a schema-3 server's database, upgraded -----------------------

// The server at `rev`, read out of git into a temporary directory, its bare
// imports pointed at this checkout's node_modules (nothing installed).
function serverFromGit(rev) {
    try {
        const files = execFileSync('git', ['-C', REPO, 'ls-tree', '-r', '--name-only', rev, '--', 'server'], { encoding: 'utf8' })
            .split('\n').filter(f => /^server\/.*\.js$/.test(f));
        if (!files.length) return null;
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-schema3-server-'));
        const req = createRequire(path.join(REPO, 'server', 'package.json'));
        const bare = (name) => pathToFileURL(req.resolve(name)).href;
        for (const f of files) {
            let src = execFileSync('git', ['-C', REPO, 'show', `${rev}:${f}`], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
            src = src.replace(/from '(express|cors|better-sqlite3)'/g, (_, name) => `from '${bare(name)}'`);
            const out = path.join(dir, f);
            fs.mkdirSync(path.dirname(out), { recursive: true });
            fs.writeFileSync(out, src);
        }
        return { dir, entry: path.join(dir, 'server', 'index.js') };
    } catch (e) {
        return null;
    }
}

async function rehearsal() {
    console.log(`\n9. Rehearsal: a database the schema-3 server (${SCHEMA3_REV}) wrote, upgraded`);
    const old = serverFromGit(SCHEMA3_REV);
    if (!old) {
        console.log(`  SKIP  could not read server/ at ${SCHEMA3_REV} from git`);
        return;
    }
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-rehearsal-'));
    let srv = null;
    const TABLES = ['items', 'snapshots', 'shared_links', 'share_tokens', 'note_proposals', 'import_sources', 'import_items',
        'users', 'sessions', 'user_prefs', 'user_tree_meta'];
    const counts = () => {
        const d = new Database(path.join(dataDir, 'sync.db'), { readonly: true });
        const out = {};
        for (const t of TABLES) out[t] = d.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
        const v = d.pragma('user_version', { simple: true });
        d.close();
        return { rows: out, version: v };
    };
    try {
        srv = startServer(dataDir, { entry: old.entry, port: OLD_PORT });
        await srv.ready();
        const B = srv.base;
        const login = async (username, password, base) => (await http('/api/login', { method: 'POST', body: { username, password }, base })).json.token;
        const A = await login('alex', PASSWORD, B);
        const t0 = (await http('/api/tree', { token: A, base: B })).json;
        const bm = t0.roots.find(r => r.role === 'bookmarks');
        bm.children = [{ id: 'r-ai', kind: 'folder', title: 'AI', children: [{ id: 'r-b1', kind: 'bookmark', title: 'HN', url: 'https://news.ycombinator.com' }] }];
        const roots = [bm, { id: 'r-notes', kind: 'folder', role: 'notes', title: 'Notes', children: [
            { id: 'r-n1', kind: 'note', title: 'Diary', payload: { content: '# Diary', createdAt: T, updatedAt: T } }] }];
        await http('/api/tree', { method: 'PUT', token: A, base: B, body: { roots, baseVersion: t0.version, deviceId: 'laptop' } });
        await http('/api/shared', { method: 'POST', token: A, base: B, body: { url: 'https://inbox.example/1', title: 'One' } });
        await http('/api/shared', { method: 'POST', token: A, base: B, body: { url: 'https://inbox.example/2' } });
        await http('/api/imports/capture', { method: 'POST', token: A, base: B, body: { url: 'https://x.com/a/status/1' } });
        const llm = (await http('/api/share', { method: 'POST', token: A, base: B })).json;
        await http(new URL(llm.url).pathname + '/propose', { method: 'POST', base: B, body: { title: 'Idea', content: '# Idea' } });
        await http('/api/prefs/share.targets', { method: 'PUT', token: A, base: B, body: { value: { v: 1 } } });
        const made = await http('/api/users', { method: 'POST', token: A, base: B,
            body: { username: 'sam', password: 'sam-password-1', role: 'user', currentPassword: PASSWORD } });
        const S = await login('sam', 'sam-password-1', B);
        await http('/api/shared', { method: 'POST', token: S, base: B, body: { url: 'https://sam.example/1', title: 'Sams' } });
        const views = async (base) => ({
            tree: (await http('/api/tree', { token: A, base })).json,
            history: (await http('/api/history', { token: A, base })).json,
            inbox: (await http('/api/shared', { token: A, base })).json,
            proposals: (await http('/api/proposals', { token: A, base })).json,
            imports: (await http('/api/imports', { token: A, base })).json,
            prefs: (await http('/api/prefs', { token: A, base })).json,
            'sam\'s tree': (await http('/api/tree', { token: S, base })).json,
            'sam\'s inbox': (await http('/api/shared', { token: S, base })).json
        });
        const before = await views(B);
        await srv.stop();
        srv = null;
        const c0 = counts();
        check('the schema-3 server wrote a schema-3 database with two accounts', c0.version === 3 && made.status === 200 && c0.rows.users === 2,
            JSON.stringify(c0));

        srv = startServer(dataDir);
        await srv.ready();
        const files = fs.readdirSync(dataDir);
        // Schema 3 straight to this build's schema: one pre-upgrade copy, named
        // for the version it upgrades to.
        const pre = `pre-v${SCHEMA_VERSION}`;
        check('this server takes a pre-upgrade copy before anything else, then adds the inbox\'s columns',
            files.some(f => f.startsWith(`sync.db.${pre}-`))
            && new RegExp(`Backed up the database to \\S+sync\\.db\\.${pre}-`).test(srv.log())
            && srv.log().indexOf(pre) < srv.log().indexOf('Share inbox: added sid'), srv.log());
        const c1 = counts();
        check(`every table keeps every row, and the schema is ${SCHEMA_VERSION}`, JSON.stringify(Object.fromEntries(TABLES.filter(t => t !== 'user_tree_meta').map(t => [t, c1.rows[t]])))
            === JSON.stringify(Object.fromEntries(TABLES.filter(t => t !== 'user_tree_meta').map(t => [t, c0.rows[t]]))) && c1.version === SCHEMA_VERSION,
            JSON.stringify([c0, c1]));
        const after = await views(BASE);
        for (const k of Object.keys(before)) {
            check(`  ${k} reads back identically`, JSON.stringify(after[k]) === JSON.stringify(before[k]),
                `${JSON.stringify(before[k]).slice(0, 200)} vs ${JSON.stringify(after[k]).slice(0, 200)}`);
        }
        const pending = (await http('/api/shares', { token: A })).json.shares;
        check('alex\'s inbox rows are his pending shares on the new routes, sam\'s are sam\'s', pending.length === 2
            && pending.every(x => x.status === 'pending' && x.source === 'legacy')
            && (await http('/api/shares', { token: S })).json.shares.map(x => x.url).join() === 'https://sam.example/1');
        const push = await http('/api/tree', { method: 'PUT', token: A, body: {
            roots: after.tree.roots, baseVersion: after.tree.version, baseUserId: after.tree.userId, baseServerId: after.tree.serverId, deviceId: 'extension' } });
        check('a client pushes and pulls as before', push.status === 200
            && (await http('/api/tree', { token: A })).json.version === push.json.version, JSON.stringify(push.json));
    } catch (e) {
        failures++;
        console.error('FAIL  rehearsal stopped:', e, srv ? '\n' + srv.log() : '');
    } finally {
        if (srv) await srv.stop();
        for (const d of [dataDir, old.dir]) {
            try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) { /* temp */ }
        }
    }
}

await migrationTests();
await liveTests();
await rehearsal();

console.log(failures === 0 ? '\nAll share tests passed.\n' : `\n${failures} test(s) failed.\n`);
process.exitCode = failures === 0 ? 0 : 1;
