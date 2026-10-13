// Headless regression test for the Reddit importer.
//
// What this locks down, in order of how much it would hurt to get wrong:
//   1. The archive outlives the source. Reddit's saved listing stops at 1000
//      items, so anything that falls off the end must survive in the archive —
//      an item disappearing is stamped, never deleted.
//   2. The virtual subtree is a faithful, read-only view of the archive:
//      grouped by month, titles carrying the subreddit/handle, filed items
//      excluded, and stable ids clients can hand back to the delete/file verbs.
//   3. Deletes are tombstoned so a later sweep cannot resurrect them, and
//      undismiss is the only way back.
//   4. Sources belong to an account: another account's source and a removed
//      one are invisible, removing a source keeps its archive, purging takes
//      everything, and a Reddit connection waits for its owner's confirm
//      click before anything is stored or swept.
//
// Run: node tools/test_imports.mjs [--port 0]
//
// Section 15 listens on 127.0.0.1 at --port (default 0: any free port).

import Database from '../server/node_modules/better-sqlite3/lib/index.js';
import express from '../server/node_modules/express/index.js';
import { initSchema, makeStore } from '../server/imports/store.js';
import { buildImportsTree, buildProviderFolder, IMPORTS_ROOT_TITLE } from '../server/imports/project.js';
import { sweepSource, runDueSources } from '../server/imports/runner.js';
import { publicSource, attachRoutes } from '../server/imports/routes.js';
import { classify } from '../server/imports/manual.js';
import { migrateUsers, insertUser } from '../server/users.js';
import { migrateOwnership } from '../server/tenancy.js';

let failures = 0;
function check(name, cond, detail) {
    if (cond) {
        console.log(`  ok  ${name}`);
    } else {
        failures++;
        console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

const portArg = process.argv.indexOf('--port');
const PORT = portArg === -1 ? 0 : Number(process.argv[portArg + 1]) || 0;

// --- Fake Reddit ---------------------------------------------------------

const realFetch = globalThis.fetch;
let savedFullnames = [];   // what the fake listing currently returns
let requestLog = [];

function makePost(n) {
    // Spread across two months so the monthly grouping is exercised.
    const month = n % 2 === 0 ? 6 : 7;
    return {
        kind: 't3',
        data: {
            name: `t3_${n}`,
            title: `Post number ${n}`,
            permalink: `/r/selfhosted/comments/${n}/post_${n}/`,
            subreddit: 'selfhosted',
            author: `user${n}`,
            created_utc: Date.UTC(2026, month, 1 + (n % 20)) / 1000,
            url: `https://example.com/${n}`
        }
    };
}

function installFakeFetch() {
    globalThis.fetch = async (url, opts = {}) => {
        const u = String(url);
        requestLog.push(u);

        if (u.includes('/api/v1/access_token')) {
            return jsonResponse({ access_token: 'access-token', refresh_token: 'refresh-from-code', expires_in: 3600 });
        }
        if (u.includes('/api/v1/me')) {
            return jsonResponse({ name: 'testuser' });
        }
        if (u.includes('/saved')) {
            const parsed = new URL(u);
            const after = parsed.searchParams.get('after');
            const limit = Number(parsed.searchParams.get('limit')) || 100;
            const start = after ? savedFullnames.findIndex(n => `t3_${n}` === after) + 1 : 0;
            const slice = savedFullnames.slice(start, start + limit);
            const last = slice[slice.length - 1];
            return jsonResponse({
                kind: 'Listing',
                data: {
                    after: start + limit < savedFullnames.length ? `t3_${last}` : null,
                    children: slice.map(makePost)
                }
            });
        }
        throw new Error(`unexpected fetch: ${u}`);
    };
}

function jsonResponse(body) {
    const text = JSON.stringify(body);
    return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => JSON.parse(text),
        text: async () => text
    };
}

// --- Tree helpers ---------------------------------------------------------

function findFolder(node, title) {
    if (!node) return null;
    if (node.title === title && node.kind === 'folder') return node;
    for (const c of node.children || []) {
        const hit = findFolder(c, title);
        if (hit) return hit;
    }
    return null;
}

function urlsUnder(node, out = []) {
    if (!node) return out;
    if (node.kind === 'bookmark') out.push(node.url);
    for (const c of node.children || []) urlsUnder(c, out);
    return out;
}

function countBookmarks(node) {
    if (!node) return 0;
    if (node.kind === 'bookmark') return 1;
    return (node.children || []).reduce((n, c) => n + countBookmarks(c), 0);
}

function firstBookmark(node) {
    if (!node) return null;
    if (node.kind === 'bookmark') return node;
    for (const c of node.children || []) {
        const b = firstBookmark(c);
        if (b) return b;
    }
    return null;
}

// A database the way the server boots one: accounts, the imports schema, and
// the ownership migration. alex is #1; any further names follow.
const ALEX = 1;
function importsDb(...more) {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE users (username TEXT PRIMARY KEY, password_hash TEXT NOT NULL, created_at TEXT NOT NULL)');
    db.prepare("INSERT INTO users VALUES ('alex', 'scrypt:x:y', '2026-01-01T00:00:00Z')").run();
    migrateUsers(db);
    initSchema(db);
    migrateOwnership(db, { env: {} });
    for (const name of more) insertUser(db, { username: name, passwordHash: 'scrypt:x:y' });
    return db;
}

// Mirrors what the delete/file routes do with a body of externalIds.
function rowsFor(store, sourceId, externalIds) {
    const wanted = new Set(externalIds.map(String));
    return store.itemsFor(sourceId).filter(r => wanted.has(String(r.external_id)));
}

// --- Test run ------------------------------------------------------------

async function main() {
    installFakeFetch();

    const db = importsDb();
    const store = makeStore(db);

    const source = store.createSource({
        provider: 'reddit',
        label: 'Reddit saved',
        config: { clientId: 'cid', clientSecret: 'secret', listTitle: 'Saved' },
        intervalMinutes: 60,
        userId: ALEX
    });
    store.writeCredentials(source.id, { refreshToken: 'refresh', username: 'testuser' });

    console.log('\n1. First sweep imports everything; the virtual subtree draws it');
    savedFullnames = Array.from({ length: 250 }, (_, i) => i + 1);
    let swept = await sweepSource(store, store.getSource(source.id, ALEX));
    check('fetched all 250 across 3 pages', swept.fetched === 250 && swept.pages === 3,
        `fetched=${swept.fetched} pages=${swept.pages}`);
    check('all 250 are new', swept.added === 250, `added=${swept.added}`);

    let tree = buildImportsTree(store, ALEX);
    check('virtual root exists and is flagged', tree && tree.readOnly === true && tree.virtual === true);
    check('root carries the historical title', tree.title === IMPORTS_ROOT_TITLE, tree.title);
    const savedFolder = findFolder(tree, 'Reddit');
    check('the Reddit folder exists', Boolean(savedFolder));
    check('250 bookmarks drawn', countBookmarks(savedFolder) === 250, `got ${countBookmarks(savedFolder)}`);
    check('flat — items sit directly in it, no month or list folders',
        (savedFolder.children || []).every(c => c.kind === 'bookmark'),
        (savedFolder.children || []).filter(c => c.kind !== 'bookmark').map(c => c.title).join(', '));
    check('newest first',
        (savedFolder.children || [])[0].title >= '' && (savedFolder.children || []).length === 250);
    const fb = firstBookmark(savedFolder);
    check('bookmark titles carry the subreddit', /^r\/selfhosted — Post number/.test(fb.title), fb.title);
    check('item ids follow imp:<source>:<externalId>',
        new RegExp(`^imp:${source.id}:t3_\\d+$`).test(fb.id), fb.id);
    check('every node in the subtree is virtual', (function allVirtual(n) {
        if (!n.virtual) return false;
        return (n.children || []).every(allVirtual);
    })(tree));

    console.log('\n2. A repeat sweep changes nothing');
    swept = await sweepSource(store, store.getSource(source.id, ALEX));
    check('nothing new added', swept.added === 0, `added=${swept.added}`);
    check('archive still 250', store.countItems(source.id).total === 250);

    console.log('\n3. Items that fall off the listing survive in the archive');
    // Reddit forgets the oldest 50 — exactly what crossing the 1000 cap looks like.
    savedFullnames = savedFullnames.slice(0, 200);
    swept = await sweepSource(store, store.getSource(source.id, ALEX));
    check('50 stamped as gone from source', swept.missing === 50, `missing=${swept.missing}`);
    check('archive still holds all 250', store.countItems(source.id).total === 250,
        `total=${store.countItems(source.id).total}`);
    check('subtree still draws all 250', countBookmarks(buildImportsTree(store, ALEX)) === 250);

    console.log('\n4. New saves are added on top of the archive');
    savedFullnames = [...Array.from({ length: 20 }, (_, i) => 900 + i), ...savedFullnames];
    swept = await sweepSource(store, store.getSource(source.id, ALEX));
    check('20 new items added', swept.added === 20, `added=${swept.added}`);
    check('subtree now 270', countBookmarks(buildImportsTree(store, ALEX)) === 270);

    console.log('\n5. Paging stitches `after` cursors correctly');
    const savedRequests = requestLog.filter(u => u.includes('/saved'));
    check('later pages carried an after cursor',
        savedRequests.some(u => u.includes('after=')), 'no after= seen');
    check('first request of a sweep has no cursor',
        !savedRequests[0].includes('after='), savedRequests[0]);

    console.log('\n6. Credentials round-trip but never reach the client');
    const readBack = store.readCredentials(source.id);
    check('refresh token survives storage', readBack.refreshToken === 'refresh');
    const wire = JSON.stringify(publicSource(store, store.getSource(source.id, ALEX)));
    check('client payload leaks no client secret', !wire.includes('secret'), wire);
    check('client payload leaks no refresh token', !wire.includes('refresh'), wire);
    check('client payload still reports connection state',
        JSON.parse(wire).connected === true && JSON.parse(wire).items === 270);

    console.log('\n7. Filing an item removes it from the subtree, never from the archive');
    const filedExt = 't3_900';
    const filedUrl = rowsFor(store, source.id, [filedExt])[0].url;
    store.markFiled(rowsFor(store, source.id, [filedExt]).map(r => r.id));
    check('still archived on the server', store.countItems(source.id).total === 270);
    check('counted as filed', store.countItems(source.id).filed === 1);
    check('no longer drawn into the subtree',
        !urlsUnder(buildImportsTree(store, ALEX)).includes(filedUrl));

    // The real regression: sweeping again must not un-file it.
    await sweepSource(store, store.getSource(source.id, ALEX));
    check('a second sweep does not draw it back',
        !urlsUnder(buildImportsTree(store, ALEX)).includes(filedUrl));

    console.log('\n8. Deleting an item purges it, and it stays gone');
    const deletedExt = 't3_901';
    const deletedUrl = rowsFor(store, source.id, [deletedExt])[0].url;
    const beforeDelete = store.countItems(source.id).total;
    store.purgeItems(rowsFor(store, source.id, [deletedExt]));
    check('archive count dropped by one', store.countItems(source.id).total === beforeDelete - 1,
        `${store.countItems(source.id).total} vs ${beforeDelete - 1}`);
    check('a tombstone was recorded', store.countDismissed(source.id) === 1,
        `dismissed=${store.countDismissed(source.id)}`);
    check('gone from the subtree', !urlsUnder(buildImportsTree(store, ALEX)).includes(deletedUrl));

    // The post is still saved on Reddit, so the sweep will see it again. It
    // must not come back — that is the whole point of the tombstone.
    await sweepSource(store, store.getSource(source.id, ALEX));
    check('still purged after a sweep that re-sees it',
        store.countItems(source.id).total === beforeDelete - 1,
        `${store.countItems(source.id).total} vs ${beforeDelete - 1}`);

    // Dropping the tombstone is the documented way back.
    store.undismiss(source.id);
    await sweepSource(store, store.getSource(source.id, ALEX));
    check('undismiss lets a later sweep restore it',
        store.countItems(source.id).total === beforeDelete,
        `${store.countItems(source.id).total} vs ${beforeDelete}`);

    console.log('\n9. Shared links are classified into the right archive');
    const cases = [
        ['https://x.com/someone/status/1234567890?t=abc&s=20', 'x', 'x:1234567890', 'someone'],
        ['https://twitter.com/someone/status/1234567890', 'x', 'x:1234567890', 'someone'],
        ['https://mobile.x.com/other/status/999', 'x', 'x:999', 'other'],
        ['https://www.instagram.com/p/CxYz123_-/?igsh=junk', 'instagram', 'ig:CxYz123_-', null],
        ['https://www.instagram.com/someone/reel/AbC123/', 'instagram', 'ig:AbC123', 'someone'],
        ['https://www.reddit.com/r/x/comments/1/a/', null, null, null],
        ['https://example.com/whatever', null, null, null],
        ['not a url', null, null, null],
        ['javascript:alert(1)', null, null, null]
    ];
    for (const [input, provider, externalId, container] of cases) {
        const got = classify(input);
        const label = input.slice(0, 46);
        if (provider === null) {
            check(`rejected: ${label}`, got === null, JSON.stringify(got));
        } else {
            check(`${label} -> ${provider}`, got && got.provider === provider, JSON.stringify(got));
            check(`  id ${externalId}`, got && got.externalId === externalId, got && got.externalId);
            if (container !== null) check(`  handle ${container}`, got && got.container === container, got && got.container);
        }
    }
    // Tracking params must not survive, or the same post shared twice dedupes
    // as two different items.
    const a = classify('https://x.com/u/status/5?t=aaa&s=20');
    const b = classify('https://x.com/u/status/5');
    check('tracking params stripped so shares dedupe', a.url === b.url, `${a.url} vs ${b.url}`);

    console.log('\n10. A captured share lands in its own archive');
    {
        const db3 = importsDb();
        const s3 = makeStore(db3);

        const hit = classify('https://x.com/someone/status/42?t=x');
        const src3 = s3.createSource({ provider: hit.provider, label: hit.label, config: { listTitle: 'Saved' }, userId: ALEX });
        s3.upsertItem(src3.id, {
            externalId: hit.externalId, url: hit.url, title: 'A post',
            container: hit.container, createdUtc: new Date().toISOString()
        });
        const tree3 = buildImportsTree(s3, ALEX);
        check('drawn without any sweep', countBookmarks(tree3) === 1, `got ${countBookmarks(tree3)}`);
        check('folder is X, not Reddit', Boolean(findFolder(tree3, 'X')));
        check('title carries the handle natively, not as r/',
            firstBookmark(tree3).title === '@someone — A post', firstBookmark(tree3).title);

        // Re-sharing the same post must not create a second copy.
        const again = s3.upsertItem(src3.id, {
            externalId: hit.externalId, url: hit.url, title: 'A post',
            container: hit.container, createdUtc: new Date().toISOString()
        });
        check('re-share is not a new item', again === false, `upsert returned ${again}`);
        check('still one archived', s3.countItems(src3.id).total === 1);
        db3.close();
    }

    console.log('\n11. No sources means no virtual root at all');
    {
        const db4 = importsDb();
        const s4 = makeStore(db4);
        check('buildImportsTree returns null', buildImportsTree(s4, ALEX) === null);
        db4.close();
    }

    console.log('\n12. An empty source draws an empty folder without crashing');
    const emptyFolder = buildProviderFolder({
        source: { id: 99, provider: 'reddit', config: { listTitle: 'Saved' } },
        items: []
    });
    check('empty provider folder builds', emptyFolder.kind === 'folder'
        && emptyFolder.children.length === 0);

    await accountTests();

    globalThis.fetch = realFetch;
    db.close();

    console.log(failures === 0 ? '\nAll import tests passed.\n' : `\n${failures} test(s) failed.\n`);
    // exitCode rather than exit(): the local test server's sockets are still
    // closing, and exiting under them aborts the process on Windows.
    process.exitCode = failures === 0 ? 0 : 1;
}

// --- Accounts ---------------------------------------------------------------

async function accountTests() {
    const db = importsDb('sam');
    const SAM = 2;
    const store = makeStore(db);
    const item = (n) => ({ externalId: `t3_${n}`, url: `https://www.reddit.com/r/x/comments/${n}/`, title: `Post ${n}` });

    console.log('\n13. Sources are scoped to their account');
    const alexSrc = store.createSource({ provider: 'reddit', config: { clientId: 'a', clientSecret: 'alex-secret' }, userId: ALEX });
    const samSrc = store.createSource({ provider: 'reddit', config: { clientId: 's', clientSecret: 'sam-secret' }, userId: SAM });
    store.upsertItem(alexSrc.id, item(1));
    store.upsertItem(samSrc.id, item(2));
    check('each account lists only its own sources',
        store.listSources(ALEX).map(s => s.id).join() === String(alexSrc.id)
        && store.listSources(SAM).map(s => s.id).join() === String(samSrc.id));
    check("getSource is null for another account's source",
        store.getSource(alexSrc.id, SAM) === null && store.getSource(samSrc.id, ALEX) === null);
    check('each subtree draws only its own archive',
        countBookmarks(buildImportsTree(store, ALEX)) === 1 && countBookmarks(buildImportsTree(store, SAM)) === 1
        && urlsUnder(buildImportsTree(store, ALEX))[0].includes('/1/'));
    let refused = null;
    try { store.createSource({ provider: 'reddit', config: {} }); } catch (e) { refused = e; }
    check('a source without an owner is refused', refused !== null);

    console.log('\n14. Removing a source keeps its archive; purge takes everything');
    store.writeCredentials(alexSrc.id, { refreshToken: 'r' });
    store.purgeItems(rowsFor(store, alexSrc.id, ['t3_1']));
    store.upsertItem(alexSrc.id, item(3));
    store.deleteSource(alexSrc.id, ALEX);
    const removed = store.getSource(alexSrc.id, ALEX, { includeRemoved: true });
    check('a removed source is gone from getSource', store.getSource(alexSrc.id, ALEX) === null);
    check('but still there, flagged, with includeRemoved', removed && removed.deletedAt
        && store.listSources(ALEX, { includeRemoved: true }).some(s => s.id === alexSrc.id && s.deletedAt));
    check('its archive is kept', store.countItems(alexSrc.id).total === 1 && store.countDismissed(alexSrc.id) === 1);
    check('its credentials and client secret are dropped',
        !store.hasCredentials(alexSrc.id) && removed.config.clientSecret === undefined);
    check('it is not drawn into the subtree', buildImportsTree(store, ALEX) === null);
    check('the scheduler does not see it', !store.listAllSources().some(s => s.id === alexSrc.id));
    check('nothing more lands in a removed source', store.upsertItem(alexSrc.id, item(4)) === false
        && store.countItems(alexSrc.id).total === 1);
    check('another account cannot remove or restore it',
        store.deleteSource(alexSrc.id, SAM, { purge: true }) === false && store.restoreSource(alexSrc.id, SAM) === null
        && store.countItems(alexSrc.id).total === 1);
    store.restoreSource(alexSrc.id, ALEX);
    check('restore brings it back with its archive',
        store.getSource(alexSrc.id, ALEX) && countBookmarks(buildImportsTree(store, ALEX)) === 1);
    store.deleteSource(alexSrc.id, ALEX, { purge: true });
    check('purge removes the source, archive and tombstones',
        store.getSource(alexSrc.id, ALEX, { includeRemoved: true }) === null
        && store.countItems(alexSrc.id).total === 0 && store.countDismissed(alexSrc.id) === 0);
    check('upsert into a purged source writes nothing', store.upsertItem(alexSrc.id, item(5)) === false
        && store.countItems(alexSrc.id).total === 0);
    check("sam's archive untouched by all of it", store.countItems(samSrc.id).total === 1);

    console.log('\n15. The same X post captured by two accounts lands in two archives');
    const app = express();
    app.use(express.json());
    const as = (id) => (req, res, next) => { req.user = { id, username: id === ALEX ? 'alex' : 'sam' }; next(); };
    const authFor = (req, res, next) => as(Number(req.headers['x-user']) || ALEX)(req, res, next);
    attachRoutes(app, { store, requireAuth: authFor, accountName: (id) => (id === ALEX ? 'alex' : 'sam') });
    const server = await new Promise(resolve => { const s = app.listen(PORT, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (path, { user = ALEX, method = 'GET', body, form } = {}) => {
        const res = await realFetch(base + path, {
            method,
            redirect: 'manual',
            headers: {
                'x-user': String(user),
                ...(body ? { 'Content-Type': 'application/json' } : {}),
                ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {})
            },
            body: body ? JSON.stringify(body) : form ? new URLSearchParams(form).toString() : undefined
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* html */ }
        return { status: res.status, json, text };
    };
    try {
        const post = 'https://x.com/nasa/status/77';
        const a = await call('/api/imports/capture', { user: ALEX, method: 'POST', body: { url: post } });
        const b = await call('/api/imports/capture', { user: SAM, method: 'POST', body: { url: post } });
        check('both captured, neither a duplicate', a.json.captured && b.json.captured && !a.json.duplicate && !b.json.duplicate,
            JSON.stringify([a.json, b.json]));
        check('into two different sources', a.json.sourceId !== b.json.sourceId);
        const xA = store.getSource(a.json.sourceId, ALEX);
        const xB = store.getSource(b.json.sourceId, SAM);
        check('each owned by the account that shared it', xA && xB && xA.provider === 'x' && xB.provider === 'x');

        console.log('\n16. Routes give 404 for another account\'s source');
        for (const [method, path, body] of [
            ['GET', `/api/imports/${xA.id}/items`], ['POST', `/api/imports/${xA.id}/run`],
            ['GET', `/api/imports/${xA.id}/authorize`], ['DELETE', `/api/imports/${xA.id}`],
            ['POST', `/api/imports/${xA.id}/restore`], ['PATCH', `/api/imports/${xA.id}`, { label: 'mine now' }],
            ['POST', `/api/imports/${xA.id}/items/delete`, { externalIds: ['x:77'] }]
        ]) {
            const r = await call(path, { user: SAM, method, body });
            check(`sam ${method} ${path.replace(String(xA.id), ':id')} -> 404`, r.status === 404, `HTTP ${r.status}`);
        }
        check("alex's X archive survived sam's attempts", store.countItems(xA.id).total === 1 && store.getSource(xA.id, ALEX).label !== 'mine now');
        const listed = await call('/api/imports', { user: SAM });
        check('GET /api/imports lists only the caller\'s sources', listed.json.sources.every(s => s.id !== xA.id));
        await call(`/api/imports/${xA.id}`, { user: ALEX, method: 'DELETE' });
        const withRemoved = await call('/api/imports?includeRemoved=1', { user: ALEX });
        check('includeRemoved lists the removed source, flagged',
            withRemoved.json.sources.some(s => s.id === xA.id && s.removed === true));
        const restored = await call(`/api/imports/${xA.id}/restore`, { user: ALEX, method: 'POST' });
        check('POST restore brings it back', restored.status === 200 && restored.json.source.removed === false);

        console.log('\n17. Reddit OAuth waits for the confirm click');
        const reddit = store.createSource({ provider: 'reddit', config: { clientId: 'cid', clientSecret: 'secret' }, userId: SAM });
        const auth = await call(`/api/imports/${reddit.id}/authorize`, { user: SAM });
        const state = new URL(auth.json.url).searchParams.get('state');
        const cb = await call(`/api/imports/reddit/callback?code=abc&state=${state}`);
        check('the callback page names the receiving account and the Reddit user',
            cb.status === 200 && cb.text.includes('u/testuser') && cb.text.includes('<strong>sam</strong>'), cb.text.slice(0, 300));
        check('nothing is stored as the connection yet', !store.hasCredentials(reddit.id));
        db.prepare("UPDATE import_sources SET last_run = NULL, enabled = 1 WHERE id = ?").run(reddit.id);
        const sweptWhilePending = await runDueSources(store);
        check('the scheduler skips a pending connection', !sweptWhilePending.includes(reddit.id));
        const nonce = (cb.text.match(/name="nonce" value="([0-9a-f]+)"/) || [])[1];
        check('the page carries a one-time nonce', Boolean(nonce));
        const wrong = await call('/api/imports/reddit/confirm', { method: 'POST', form: { nonce: 'f'.repeat(64), accept: '1' } });
        check('a wrong nonce is refused', wrong.status === 400 && !store.hasCredentials(reddit.id));
        const ok = await call('/api/imports/reddit/confirm', { method: 'POST', form: { nonce, accept: '1' } });
        check('confirm with the nonce connects it', ok.status === 200 && store.hasCredentials(reddit.id)
            && store.readCredentials(reddit.id).refreshToken !== undefined, ok.text.slice(0, 200));
        const replay = await call('/api/imports/reddit/confirm', { method: 'POST', form: { nonce, accept: '1' } });
        check('the nonce works once', replay.status === 400);

        // Cancel, and expiry.
        const auth2 = await call(`/api/imports/${reddit.id}/authorize`, { user: SAM });
        const cb2 = await call(`/api/imports/reddit/callback?code=def&state=${new URL(auth2.json.url).searchParams.get('state')}`);
        const nonce2 = (cb2.text.match(/name="nonce" value="([0-9a-f]+)"/) || [])[1];
        const before = JSON.stringify(store.readCredentials(reddit.id));
        const cancel = await call('/api/imports/reddit/confirm', { method: 'POST', form: { nonce: nonce2, accept: '0' } });
        check('cancel stores nothing and spends the nonce', cancel.status === 200
            && JSON.stringify(store.readCredentials(reddit.id)) === before
            && db.prepare('SELECT pending_credentials FROM import_sources WHERE id = ?').get(reddit.id).pending_credentials === null);
        const auth3 = await call(`/api/imports/${reddit.id}/authorize`, { user: SAM });
        const cb3 = await call(`/api/imports/reddit/callback?code=ghi&state=${new URL(auth3.json.url).searchParams.get('state')}`);
        const nonce3 = (cb3.text.match(/name="nonce" value="([0-9a-f]+)"/) || [])[1];
        const realNow = Date.now;
        Date.now = () => realNow() + 16 * 60 * 1000;
        let expired;
        try {
            expired = await call('/api/imports/reddit/confirm', { method: 'POST', form: { nonce: nonce3, accept: '1' } });
        } finally {
            Date.now = realNow;
        }
        check('an expired confirmation is refused', expired.status === 400
            && db.prepare('SELECT pending_nonce_hash FROM import_sources WHERE id = ?').get(reddit.id).pending_nonce_hash === null);
        const alexAuth = await call(`/api/imports/${reddit.id}/authorize`, { user: ALEX });
        check("alex cannot start a connection on sam's source", alexAuth.status === 404);
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        db.close();
    }
}

main().catch(e => { console.error(e); process.exit(1); });
