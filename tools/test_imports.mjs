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
//
// Run: node tools/test_imports.mjs

import Database from '../server/node_modules/better-sqlite3/lib/index.js';
import { initSchema, makeStore } from '../server/imports/store.js';
import { buildImportsTree, buildProviderFolder, IMPORTS_ROOT_TITLE } from '../server/imports/project.js';
import { sweepSource } from '../server/imports/runner.js';
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

// Mirrors what the delete/file routes do with a body of externalIds.
function rowsFor(store, sourceId, externalIds) {
    const wanted = new Set(externalIds.map(String));
    return store.itemsFor(sourceId).filter(r => wanted.has(String(r.external_id)));
}

// --- Test run ------------------------------------------------------------

async function main() {
    installFakeFetch();

    const db = new Database(':memory:');
    initSchema(db);
    const store = makeStore(db);

    const source = store.createSource({
        provider: 'reddit',
        label: 'Reddit saved',
        config: { clientId: 'cid', clientSecret: 'secret', listTitle: 'Saved' },
        intervalMinutes: 60
    });
    store.writeCredentials(source.id, { refreshToken: 'refresh', username: 'testuser' });

    console.log('\n1. First sweep imports everything; the virtual subtree draws it');
    savedFullnames = Array.from({ length: 250 }, (_, i) => i + 1);
    let swept = await sweepSource(store, store.getSource(source.id));
    check('fetched all 250 across 3 pages', swept.fetched === 250 && swept.pages === 3,
        `fetched=${swept.fetched} pages=${swept.pages}`);
    check('all 250 are new', swept.added === 250, `added=${swept.added}`);

    let tree = buildImportsTree(store);
    check('virtual root exists and is flagged', tree && tree.readOnly === true && tree.virtual === true);
    check('root carries the historical title', tree.title === IMPORTS_ROOT_TITLE, tree.title);
    const savedFolder = findFolder(tree, 'Saved');
    check('Reddit / Saved exists', Boolean(savedFolder));
    check('250 bookmarks drawn', countBookmarks(savedFolder) === 250, `got ${countBookmarks(savedFolder)}`);
    check('grouped into two month folders', (savedFolder.children || []).length === 2,
        `got ${(savedFolder.children || []).map(c => c.title).join(', ')}`);
    const fb = firstBookmark(savedFolder);
    check('bookmark titles carry the subreddit', /^r\/selfhosted — Post number/.test(fb.title), fb.title);
    check('item ids follow imp:<source>:<externalId>',
        new RegExp(`^imp:${source.id}:t3_\\d+$`).test(fb.id), fb.id);
    check('every node in the subtree is virtual', (function allVirtual(n) {
        if (!n.virtual) return false;
        return (n.children || []).every(allVirtual);
    })(tree));

    console.log('\n2. A repeat sweep changes nothing');
    swept = await sweepSource(store, store.getSource(source.id));
    check('nothing new added', swept.added === 0, `added=${swept.added}`);
    check('archive still 250', store.countItems(source.id).total === 250);

    console.log('\n3. Items that fall off the listing survive in the archive');
    // Reddit forgets the oldest 50 — exactly what crossing the 1000 cap looks like.
    savedFullnames = savedFullnames.slice(0, 200);
    swept = await sweepSource(store, store.getSource(source.id));
    check('50 stamped as gone from source', swept.missing === 50, `missing=${swept.missing}`);
    check('archive still holds all 250', store.countItems(source.id).total === 250,
        `total=${store.countItems(source.id).total}`);
    check('subtree still draws all 250', countBookmarks(buildImportsTree(store)) === 250);

    console.log('\n4. New saves are added on top of the archive');
    savedFullnames = [...Array.from({ length: 20 }, (_, i) => 900 + i), ...savedFullnames];
    swept = await sweepSource(store, store.getSource(source.id));
    check('20 new items added', swept.added === 20, `added=${swept.added}`);
    check('subtree now 270', countBookmarks(buildImportsTree(store)) === 270);

    console.log('\n5. Paging stitches `after` cursors correctly');
    const savedRequests = requestLog.filter(u => u.includes('/saved'));
    check('later pages carried an after cursor',
        savedRequests.some(u => u.includes('after=')), 'no after= seen');
    check('first request of a sweep has no cursor',
        !savedRequests[0].includes('after='), savedRequests[0]);

    console.log('\n6. Credentials round-trip but never reach the client');
    const readBack = store.readCredentials(source.id);
    check('refresh token survives storage', readBack.refreshToken === 'refresh');
    const wire = JSON.stringify(publicSource(store, store.getSource(source.id)));
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
        !urlsUnder(buildImportsTree(store)).includes(filedUrl));

    // The real regression: sweeping again must not un-file it.
    await sweepSource(store, store.getSource(source.id));
    check('a second sweep does not draw it back',
        !urlsUnder(buildImportsTree(store)).includes(filedUrl));

    console.log('\n8. Deleting an item purges it, and it stays gone');
    const deletedExt = 't3_901';
    const deletedUrl = rowsFor(store, source.id, [deletedExt])[0].url;
    const beforeDelete = store.countItems(source.id).total;
    store.purgeItems(rowsFor(store, source.id, [deletedExt]));
    check('archive count dropped by one', store.countItems(source.id).total === beforeDelete - 1,
        `${store.countItems(source.id).total} vs ${beforeDelete - 1}`);
    check('a tombstone was recorded', store.countDismissed(source.id) === 1,
        `dismissed=${store.countDismissed(source.id)}`);
    check('gone from the subtree', !urlsUnder(buildImportsTree(store)).includes(deletedUrl));

    // The post is still saved on Reddit, so the sweep will see it again. It
    // must not come back — that is the whole point of the tombstone.
    await sweepSource(store, store.getSource(source.id));
    check('still purged after a sweep that re-sees it',
        store.countItems(source.id).total === beforeDelete - 1,
        `${store.countItems(source.id).total} vs ${beforeDelete - 1}`);

    // Dropping the tombstone is the documented way back.
    store.undismiss(source.id);
    await sweepSource(store, store.getSource(source.id));
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
        const db3 = new Database(':memory:');
        initSchema(db3);
        const s3 = makeStore(db3);

        const hit = classify('https://x.com/someone/status/42?t=x');
        const src3 = s3.createSource({ provider: hit.provider, label: hit.label, config: { listTitle: 'Saved' } });
        s3.upsertItem(src3.id, {
            externalId: hit.externalId, url: hit.url, title: 'A post',
            container: hit.container, createdUtc: new Date().toISOString()
        });
        const tree3 = buildImportsTree(s3);
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
        const db4 = new Database(':memory:');
        initSchema(db4);
        const s4 = makeStore(db4);
        check('buildImportsTree returns null', buildImportsTree(s4) === null);
        db4.close();
    }

    console.log('\n12. An empty source draws an empty folder without crashing');
    const emptyFolder = buildProviderFolder({
        source: { id: 99, provider: 'reddit', config: { listTitle: 'Saved' } },
        items: []
    });
    check('empty provider folder builds', emptyFolder.kind === 'folder'
        && emptyFolder.children[0].title === 'Saved'
        && emptyFolder.children[0].children.length === 0);

    globalThis.fetch = realFetch;
    db.close();

    console.log(failures === 0 ? '\nAll import tests passed.\n' : `\n${failures} test(s) failed.\n`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
