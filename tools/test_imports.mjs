// Headless regression test for the Reddit importer.
//
// What this locks down, in order of how much it would hurt to get wrong:
//   1. The archive outlives the source. Reddit's saved listing stops at 1000
//      items, so anything that falls off the end must survive in the archive —
//      an item disappearing is stamped, never deleted.
//   2. Projection is idempotent. An unchanged sweep must not write a snapshot,
//      or every scheduler tick burns a slot in MAX_SNAPSHOTS history and pushes
//      a pointless pull at every device.
//   3. Projection self-heals. A browser that pushes a tree predating the import
//      folder must not permanently destroy it.
//
// Run: node tools/test_imports.mjs

import Database from '../server/node_modules/better-sqlite3/lib/index.js';
import { initSchema, makeStore } from '../server/imports/store.js';
import { buildProviderFolder, applyProviderFolder, findOrCreateImportsRoot } from '../server/imports/project.js';
import { sweepSource, projectSource } from '../server/imports/runner.js';
import { publicSource } from '../server/imports/routes.js';

let failures = 0;
function check(name, cond, detail) {
    if (cond) {
        console.log(`  ok  ${name}`);
    } else {
        failures++;
        console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

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
            return jsonResponse({ access_token: 'access-token', expires_in: 3600 });
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

// --- Fake snapshot store -------------------------------------------------

function freshSnapshot() {
    return {
        type: 'root',
        title: '',
        children: [
            { type: 'folder', title: 'Bookmarks Bar', nativeId: '1', children: [] },
            { type: 'folder', title: 'Other Bookmarks', nativeId: '2', children: [] }
        ]
    };
}

function makeSnapshotStore() {
    const commits = [];
    let current = freshSnapshot();
    return {
        commits,
        latestSnapshot: () => JSON.parse(JSON.stringify(current)),
        commitSnapshot: (snap, deviceId) => {
            current = JSON.parse(JSON.stringify(snap));
            commits.push({ deviceId, snapshot: current });
        },
        // Simulates a browser pushing a tree that predates the import folder.
        pushWithoutImports: () => { current = freshSnapshot(); }
    };
}

function findFolder(node, title) {
    if (!node) return null;
    if (node.title === title && node.type !== 'bookmark') return node;
    for (const c of node.children || []) {
        const hit = findFolder(c, title);
        if (hit) return hit;
    }
    return null;
}

function countBookmarks(node) {
    if (!node) return 0;
    if (node.type === 'bookmark') return 1;
    return (node.children || []).reduce((n, c) => n + countBookmarks(c), 0);
}

// --- Test run ------------------------------------------------------------

async function main() {
    installFakeFetch();

    const db = new Database(':memory:');
    initSchema(db);
    const store = makeStore(db);
    const snapshots = makeSnapshotStore();
    const ctx = { latestSnapshot: snapshots.latestSnapshot, commitSnapshot: snapshots.commitSnapshot };

    const source = store.createSource({
        provider: 'reddit',
        label: 'Reddit saved',
        config: { clientId: 'cid', clientSecret: 'secret', listTitle: 'Saved' },
        intervalMinutes: 60
    });
    store.writeCredentials(source.id, { refreshToken: 'refresh', username: 'testuser' });

    console.log('\n1. First sweep imports everything and projects it');
    savedFullnames = Array.from({ length: 250 }, (_, i) => i + 1);
    let swept = await sweepSource(store, store.getSource(source.id));
    check('fetched all 250 across 3 pages', swept.fetched === 250 && swept.pages === 3,
        `fetched=${swept.fetched} pages=${swept.pages}`);
    check('all 250 are new', swept.added === 250, `added=${swept.added}`);

    let projected = projectSource(store, store.getSource(source.id), ctx);
    check('projection committed', projected.projected === true, projected.reason);
    check('committed as importer', snapshots.commits[0].deviceId === 'importer');

    const tree = snapshots.latestSnapshot();
    const savedFolder = findFolder(tree, 'Saved');
    check('TabPaladin Imports / Reddit / Saved exists', Boolean(savedFolder));
    check('250 bookmarks projected', countBookmarks(savedFolder) === 250,
        `got ${countBookmarks(savedFolder)}`);
    check('grouped into two month folders', (savedFolder.children || []).length === 2,
        `got ${(savedFolder.children || []).map(c => c.title).join(', ')}`);
    check('bookmark titles carry the subreddit',
        /^r\/selfhosted — Post number/.test(savedFolder.children[0].children[0].title),
        savedFolder.children[0].children[0].title);

    console.log('\n2. An unchanged sweep writes no new snapshot');
    const commitsBefore = snapshots.commits.length;
    swept = await sweepSource(store, store.getSource(source.id));
    projected = projectSource(store, store.getSource(source.id), ctx);
    check('nothing new added', swept.added === 0, `added=${swept.added}`);
    check('projection reported no change', projected.projected === false, projected.reason);
    check('no snapshot written', snapshots.commits.length === commitsBefore,
        `${snapshots.commits.length} vs ${commitsBefore}`);

    console.log('\n3. Items that fall off the listing survive in the archive');
    // Reddit forgets the oldest 50 — exactly what crossing the 1000 cap looks like.
    savedFullnames = savedFullnames.slice(0, 200);
    swept = await sweepSource(store, store.getSource(source.id));
    check('50 stamped as gone from source', swept.missing === 50, `missing=${swept.missing}`);
    check('archive still holds all 250', store.countItems(source.id).total === 250,
        `total=${store.countItems(source.id).total}`);

    projected = projectSource(store, store.getSource(source.id), ctx);
    check('projection unchanged — dropped items keep their bookmarks',
        projected.projected === false, projected.reason);
    check('still 250 bookmarks in the tree',
        countBookmarks(findFolder(snapshots.latestSnapshot(), 'Saved')) === 250);

    console.log('\n4. New saves are added on top of the archive');
    savedFullnames = [...Array.from({ length: 20 }, (_, i) => 900 + i), ...savedFullnames];
    swept = await sweepSource(store, store.getSource(source.id));
    check('20 new items added', swept.added === 20, `added=${swept.added}`);
    projected = projectSource(store, store.getSource(source.id), ctx);
    check('projection committed the growth', projected.projected === true, projected.reason);
    check('archive now 270', countBookmarks(findFolder(snapshots.latestSnapshot(), 'Saved')) === 270,
        `got ${countBookmarks(findFolder(snapshots.latestSnapshot(), 'Saved'))}`);

    console.log('\n5. A push that drops the import folder is healed');
    snapshots.pushWithoutImports();
    check('folder really is gone', findFolder(snapshots.latestSnapshot(), 'Saved') === null);
    projected = projectSource(store, store.getSource(source.id), ctx);
    check('reprojection committed', projected.projected === true, projected.reason);
    check('all 270 bookmarks restored',
        countBookmarks(findFolder(snapshots.latestSnapshot(), 'Saved')) === 270,
        `got ${countBookmarks(findFolder(snapshots.latestSnapshot(), 'Saved'))}`);

    console.log('\n6. Paging stitches `after` cursors correctly');
    const savedRequests = requestLog.filter(u => u.includes('/saved'));
    check('later pages carried an after cursor',
        savedRequests.some(u => u.includes('after=')), 'no after= seen');
    check('first request of a sweep has no cursor',
        !savedRequests[0].includes('after='), savedRequests[0]);

    console.log('\n7. Credentials round-trip but never reach the client');
    const readBack = store.readCredentials(source.id);
    check('refresh token survives storage', readBack.refreshToken === 'refresh');
    const wire = JSON.stringify(publicSource(store, store.getSource(source.id)));
    check('client payload leaks no client secret', !wire.includes('secret'), wire);
    check('client payload leaks no refresh token', !wire.includes('refresh'), wire);
    check('client payload still reports connection state',
        JSON.parse(wire).connected === true && JSON.parse(wire).items === 270);

    console.log('\n8. Imports root lands under Other Bookmarks');
    const fresh = freshSnapshot();
    const root = findOrCreateImportsRoot(fresh);
    check('created under Other Bookmarks',
        fresh.children[1].children.includes(root),
        'went somewhere else');
    check('finding it again returns the same node', findOrCreateImportsRoot(fresh) === root);

    console.log('\n9. Empty archive projects an empty folder without crashing');
    const emptyFolder = buildProviderFolder({ provider: 'reddit', listTitle: 'Saved', items: [] });
    const snap = freshSnapshot();
    check('applies cleanly', applyProviderFolder(snap, emptyFolder) === true);
    check('second apply is a no-op', applyProviderFolder(snap, emptyFolder) === false);

    globalThis.fetch = realFetch;
    db.close();

    console.log(failures === 0 ? '\nAll import tests passed.\n' : `\n${failures} test(s) failed.\n`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
