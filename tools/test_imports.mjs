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
import { classify } from '../server/imports/manual.js';

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
    // Snapshots carry a timestamp on the server; the reconcile guard depends on
    // it, so the fake has to model it too.
    let stamp = new Date('2026-01-01T00:00:00.000Z').toISOString();
    return {
        commits,
        get timestamp() { return stamp; },
        setTimestamp: (t) => { stamp = t; },
        latestSnapshot: () => ({ snapshot: JSON.parse(JSON.stringify(current)), timestamp: stamp }),
        commitSnapshot: (snap, deviceId) => {
            current = JSON.parse(JSON.stringify(snap));
            stamp = new Date().toISOString();
            commits.push({ deviceId, snapshot: current });
        },
        // Simulates a browser pushing a tree that predates the import folder.
        pushWithoutImports: () => { current = freshSnapshot(); stamp = new Date().toISOString(); },
        // Direct edits to the live tree, standing in for the user rearranging
        // bookmarks in a browser and pushing the result.
        edit: (fn) => { fn(current); stamp = new Date().toISOString(); },
        tree: () => current
    };
}

// Remove a bookmark by URL from anywhere in the tree; returns the node.
function removeByUrl(node, url) {
    for (const c of node.children || []) {
        if (c.type === 'bookmark' && c.url === url) {
            node.children = node.children.filter(x => x !== c);
            return c;
        }
        const hit = removeByUrl(c, url);
        if (hit) return hit;
    }
    return null;
}

function urlsUnder(node, out = []) {
    if (!node) return out;
    if (node.type === 'bookmark') out.push(node.url);
    for (const c of node.children || []) urlsUnder(c, out);
    return out;
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

function findFirstTitle(node) {
    if (!node) return '';
    if (node.type === 'bookmark') return node.title;
    for (const c of node.children || []) {
        const t = findFirstTitle(c);
        if (t) return t;
    }
    return '';
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

    const tree = snapshots.tree();
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
        countBookmarks(findFolder(snapshots.tree(), 'Saved')) === 250);

    console.log('\n4. New saves are added on top of the archive');
    savedFullnames = [...Array.from({ length: 20 }, (_, i) => 900 + i), ...savedFullnames];
    swept = await sweepSource(store, store.getSource(source.id));
    check('20 new items added', swept.added === 20, `added=${swept.added}`);
    projected = projectSource(store, store.getSource(source.id), ctx);
    check('projection committed the growth', projected.projected === true, projected.reason);
    check('archive now 270', countBookmarks(findFolder(snapshots.tree(), 'Saved')) === 270,
        `got ${countBookmarks(findFolder(snapshots.tree(), 'Saved'))}`);

    console.log('\n5. A push that drops the import folder is healed');
    snapshots.pushWithoutImports();
    check('folder really is gone', findFolder(snapshots.tree(), 'Saved') === null);
    projected = projectSource(store, store.getSource(source.id), ctx);
    check('reprojection committed', projected.projected === true, projected.reason);
    check('all 270 bookmarks restored',
        countBookmarks(findFolder(snapshots.tree(), 'Saved')) === 270,
        `got ${countBookmarks(findFolder(snapshots.tree(), 'Saved'))}`);

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

    console.log('\n7b. Moving an import out files it — no duplicate on the next sweep');
    const movedUrl = 'https://www.reddit.com/r/selfhosted/comments/900/post_900/';
    snapshots.edit(tree => {
        const node = removeByUrl(tree, movedUrl);
        if (!node) throw new Error('fixture: could not find ' + movedUrl);
        // Into a folder of the user's own, as if they filed it.
        tree.children[0].children.push({ type: 'folder', title: 'My reading', children: [node] });
    });
    projected = projectSource(store, store.getSource(source.id), ctx);
    check('item marked filed', projected.filed === 1, `filed=${projected.filed}`);
    check('nothing purged', projected.purged === 0, `purged=${projected.purged}`);
    check('still archived on the server', store.countItems(source.id).total === 270,
        `total=${store.countItems(source.id).total}`);
    check('not re-added to the import folder',
        !urlsUnder(findFolder(snapshots.tree(), 'Saved')).includes(movedUrl));
    check('still where the user put it',
        urlsUnder(findFolder(snapshots.tree(), 'My reading')).includes(movedUrl));

    // The real regression: sweeping again must not resurrect it.
    await sweepSource(store, store.getSource(source.id));
    projectSource(store, store.getSource(source.id), ctx);
    check('a second sweep does not put it back',
        !urlsUnder(findFolder(snapshots.tree(), 'Saved')).includes(movedUrl));
    check('and it is not duplicated anywhere',
        urlsUnder(snapshots.tree()).filter(u => u === movedUrl).length === 1);

    console.log('\n7c. Deleting an import purges it, and it stays gone');
    const deletedUrl = 'https://www.reddit.com/r/selfhosted/comments/901/post_901/';
    const beforeDelete = store.countItems(source.id).total;
    snapshots.edit(tree => { removeByUrl(tree, deletedUrl); });
    projected = projectSource(store, store.getSource(source.id), ctx);
    check('purged from the archive', projected.purged === 1, `purged=${projected.purged}`);
    check('archive count dropped by one', store.countItems(source.id).total === beforeDelete - 1,
        `${store.countItems(source.id).total} vs ${beforeDelete - 1}`);
    check('a tombstone was recorded', store.countDismissed(source.id) === 1,
        `dismissed=${store.countDismissed(source.id)}`);

    // The post is still saved on Reddit, so the sweep will see it again. It
    // must not come back — that is the whole point of the tombstone.
    await sweepSource(store, store.getSource(source.id));
    projectSource(store, store.getSource(source.id), ctx);
    check('still purged after a sweep that re-sees it',
        store.countItems(source.id).total === beforeDelete - 1,
        `${store.countItems(source.id).total} vs ${beforeDelete - 1}`);
    check('and it is nowhere in the tree',
        !urlsUnder(snapshots.tree()).includes(deletedUrl));

    // Dropping the tombstone is the documented way back.
    store.undismiss(source.id);
    await sweepSource(store, store.getSource(source.id));
    projectSource(store, store.getSource(source.id), ctx);
    check('undismiss lets a later sweep restore it',
        store.countItems(source.id).total === beforeDelete,
        `${store.countItems(source.id).total} vs ${beforeDelete}`);

    console.log('\n7d. GUARD: a stale device cannot purge items it never saw');
    // A device pushes a tree whose import folder predates the last 20 sweeps.
    const staleCount = store.countItems(source.id).total;
    snapshots.edit(tree => {
        const saved = findFolder(tree, 'Saved');
        // Wipe most of the folder, as an old copy would look...
        saved.children = saved.children.slice(0, 1);
    });
    // ...but stamp the snapshot as OLDER than everything in the archive.
    snapshots.setTimestamp(new Date('2020-01-01T00:00:00.000Z').toISOString());
    projected = projectSource(store, store.getSource(source.id), ctx);
    check('nothing purged from a stale snapshot', projected.purged === 0, `purged=${projected.purged}`);
    check('nothing filed from a stale snapshot', projected.filed === 0, `filed=${projected.filed}`);
    check('archive intact', store.countItems(source.id).total === staleCount,
        `${store.countItems(source.id).total} vs ${staleCount}`);

    console.log('\n7d2. GUARD: items swept but never projected are never purged');
    // The window that actually bit: a sweep lands items, then a browser pushes
    // before the projection runs. The folder exists and the new items are not
    // in it, but they were never put there — absence proves nothing yet.
    {
        const db2 = new Database(':memory:');
        initSchema(db2);
        const s2 = makeStore(db2);
        const snaps2 = makeSnapshotStore();
        const ctx2 = { latestSnapshot: snaps2.latestSnapshot, commitSnapshot: snaps2.commitSnapshot };
        const src2 = s2.createSource({ provider: 'reddit', config: { listTitle: 'Saved' } });

        // An existing, already-projected folder…
        s2.upsertItem(src2.id, { externalId: 't3_a', url: 'https://r/a', title: 'A', createdUtc: '2026-07-01T00:00:00.000Z' });
        projectSource(s2, s2.getSource(src2.id), ctx2);

        // …then three items land in the archive, and a device pushes before the
        // next projection. Backdate them so an imported_at-based guard misses.
        for (const n of ['b', 'c', 'd']) {
            s2.upsertItem(src2.id, { externalId: 't3_' + n, url: 'https://r/' + n, title: n.toUpperCase(), createdUtc: '2026-07-01T00:00:00.000Z' });
        }
        db2.prepare("UPDATE import_items SET imported_at = '2000-01-01T00:00:00.000Z' WHERE external_id != 't3_a'").run();
        snaps2.setTimestamp(new Date().toISOString());

        const r2 = projectSource(s2, s2.getSource(src2.id), ctx2);
        check('nothing purged', r2.purged === 0, `purged=${r2.purged}`);
        check('all four still archived', s2.countItems(src2.id).total === 4,
            `total=${s2.countItems(src2.id).total}`);
        check('no tombstones written', s2.countDismissed(src2.id) === 0,
            `dismissed=${s2.countDismissed(src2.id)}`);
        check('and they are now in the folder',
            countBookmarks(findFolder(snaps2.tree(), 'Saved')) === 4,
            `got ${countBookmarks(findFolder(snaps2.tree(), 'Saved'))}`);
        db2.close();
    }

    console.log('\n7e. GUARD: a missing folder heals instead of purging');
    const beforeHeal = store.countItems(source.id).total;
    snapshots.pushWithoutImports();
    projected = projectSource(store, store.getSource(source.id), ctx);
    check('nothing purged when the folder is absent', projected.purged === 0, `purged=${projected.purged}`);
    check('archive intact', store.countItems(source.id).total === beforeHeal);
    check('folder restored', Boolean(findFolder(snapshots.tree(), 'Saved')));

    console.log('\n7f. A bookmark filed into the archive is ejected, not swallowed');
    const mine = 'https://example.com/mine';
    snapshots.edit(tree => {
        findFolder(tree, 'Saved').children.push({ type: 'bookmark', title: 'Mine', url: mine });
    });
    projected = projectSource(store, store.getSource(source.id), ctx);
    check('one bookmark ejected', projected.ejected === 1, `ejected=${projected.ejected}`);
    check('no longer inside the archive',
        !urlsUnder(findFolder(snapshots.tree(), 'TabPaladin Imports')).includes(mine));
    check('but still in the tree — nothing lost',
        urlsUnder(snapshots.tree()).includes(mine));
    check('landed beside the imports root',
        urlsUnder(findFolder(snapshots.tree(), 'Other Bookmarks')).includes(mine));
    check('not mistaken for an archived item', store.countItems(source.id).total === beforeHeal,
        `${store.countItems(source.id).total} vs ${beforeHeal}`);
    check('and exactly one copy exists',
        urlsUnder(snapshots.tree()).filter(u => u === mine).length === 1);

    // Re-running must not shuffle it again.
    projected = projectSource(store, store.getSource(source.id), ctx);
    check('a second pass ejects nothing', (projected.ejected || 0) === 0, `ejected=${projected.ejected}`);

    console.log('\n7g. Shared links are classified into the right archive');
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

    console.log('\n7h. A captured share lands in its own archive');
    {
        const db3 = new Database(':memory:');
        initSchema(db3);
        const s3 = makeStore(db3);
        const snaps3 = makeSnapshotStore();
        const ctx3 = { latestSnapshot: snaps3.latestSnapshot, commitSnapshot: snaps3.commitSnapshot };

        const hit = classify('https://x.com/someone/status/42?t=x');
        const src3 = s3.createSource({ provider: hit.provider, label: hit.label, config: { listTitle: 'Saved' } });
        s3.upsertItem(src3.id, {
            externalId: hit.externalId, url: hit.url, title: 'A post',
            container: hit.container, createdUtc: new Date().toISOString()
        });
        const r3 = projectSource(s3, s3.getSource(src3.id), ctx3);
        check('projected without any sweep', r3.projected === true, r3.reason);
        check('folder is X, not Reddit', Boolean(findFolder(snaps3.tree(), 'X')));
        const savedX = findFolder(snaps3.tree(), 'Saved');
        check('one bookmark archived', countBookmarks(savedX) === 1, `got ${countBookmarks(savedX)}`);
        check('title carries the handle natively, not as r/',
            findFirstTitle(savedX) === '@someone — A post', findFirstTitle(savedX));

        // Re-sharing the same post must not create a second copy.
        const again = s3.upsertItem(src3.id, {
            externalId: hit.externalId, url: hit.url, title: 'A post',
            container: hit.container, createdUtc: new Date().toISOString()
        });
        check('re-share is not a new item', again === false, `upsert returned ${again}`);
        check('still one archived', s3.countItems(src3.id).total === 1);
        db3.close();
    }

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
