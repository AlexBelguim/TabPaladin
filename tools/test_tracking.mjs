// Headless test: workflow tab tracking in the background script
// (src/background/background.js, run in a vm over tools/fake_extension.mjs).
//
// What this locks down:
//   1. Only the extension's own pages are listened to: a content script (this
//      extension, but inside a web page), another extension, or a sender
//      without a URL cannot track or untrack anything. The app page, which
//      runs in a tab, can.
//   2. The tracking map survives an extension update (onInstalled 'update',
//      and a browser update) and is cleared only on a fresh install and on
//      browser startup, when every tab gets a new id.
//   3. Closing 20 tracked tabs at once queues exactly 20 removals, in the old
//      tpPendingRemovals format, and untracks all 20: none lost to handlers
//      overwriting each other.
//   4. Closing a whole workflow window keeps its tabs in the workflow: 20
//      tabs closing with the window queue nothing, and are untracked.
//   5. On each wake, entries whose tab is gone are dropped without queueing a
//      removal — except one whose close is what woke the worker.
//   6. A page taking the queue while the background appends to it (both under
//      the 'tp-pending-removals' lock) never loses an id: every closed tab's
//      bookmark leaves the live working copy.
//
// Run: node tools/test_tracking.mjs [--background <path>]   (default: the shipped one)

import path from 'node:path';
import { makeBrowser, ROOT, sleep, until } from './fake_extension.mjs';

const argBg = process.argv.indexOf('--background');
const BACKGROUND = argBg === -1 ? path.join(ROOT, 'src/background/background.js') : path.resolve(process.argv[argBg + 1]);

let failures = 0;
function check(name, cond, detail) {
    if (cond) {
        console.log(`  ok  ${name}`);
    } else {
        failures++;
        console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

const b = makeBrowser({ timeScale: 0.02 });
const boot = () => b.bootWorker({ file: BACKGROUND });
const map = () => b.storage.get('tpOpenWorkflowTabs') || {};
const queue = () => b.storage.get('tpPendingRemovals') || [];
// Let the worker's chain (and its wake-up prune) run out.
const settle = () => sleep(120);

function openWorkflowWindow(n, { from = 1, workflowId = 'wf1' } = {}) {
    const entries = [];
    for (let i = from; i < from + n; i++) {
        b.tabs.set(i, { id: i, url: `https://site${i}.example/`, windowId: 9 });
        entries.push({ tabId: i, bookmarkId: `bm${i}` });
    }
    return b.message({ type: 'TP_TRACK_WORKFLOW_TABS', workflowId, entries });
}

function closeTabs(ids, { isWindowClosing = false } = {}) {
    // All in the same tick, as the browser does when a window closes.
    for (const id of ids) {
        b.tabs.delete(id);
        b.fire('removed', id, { windowId: 9, isWindowClosing });
    }
}

console.log('\n1. Who may track tabs');
{
    boot();
    await settle();
    const ok = await openWorkflowWindow(3);
    check('the app page (in a tab) tracks a workflow window', ok && ok.ok === true && Object.keys(map()).length === 3, JSON.stringify(map()));

    for (const [who, sender] of [['a content script inside a web page', b.senders.contentScript],
        ['another extension', b.senders.otherExtension], ['a sender with no URL', b.senders.noUrl]]) {
        const before = JSON.stringify(map());
        const r1 = await b.message({ type: 'TP_TRACK_WORKFLOW_TABS', workflowId: 'evil', entries: [{ tabId: 42, bookmarkId: 'victim' }] }, sender);
        const r2 = await b.message({ type: 'TP_UNTRACK_WORKFLOW', workflowId: 'wf1' }, sender);
        await settle();
        check(`${who} can neither track nor untrack`, r1 === undefined && r2 === undefined && JSON.stringify(map()) === before,
            JSON.stringify(map()));
    }
    const un = await b.message({ type: 'TP_UNTRACK_WORKFLOW', workflowId: 'wf1' });
    check('the app page untracks its workflow', un && un.ok === true && Object.keys(map()).length === 0);
}

console.log('\n2. The map across updates, installs and restarts');
{
    for (const i of [1, 2, 3]) b.tabs.delete(i);
    await openWorkflowWindow(4, { from: 11 });
    boot(); // the new version's worker
    b.fire('installed', { reason: 'update', previousVersion: '1.0.0' });
    await settle();
    check('an extension update keeps the tracking map', Object.keys(map()).sort().join() === '11,12,13,14', JSON.stringify(map()));
    b.fire('installed', { reason: 'chrome_update' });
    await settle();
    check('a browser update keeps it too', Object.keys(map()).length === 4);
    closeTabs([12]);
    await until(() => queue().length === 1 && !map()[12]);
    check('after the update a closed tab still leaves its workflow', JSON.stringify(queue()) === '["bm12"]' && !map()[12],
        JSON.stringify({ queue: queue(), map: map() }));
    b.storage.delete('tpPendingRemovals');

    boot();
    b.fire('startup');
    await settle();
    check('a browser restart clears it (every tab has a new id)', Object.keys(map()).length === 0);

    await openWorkflowWindow(2, { from: 21 });
    boot();
    b.fire('installed', { reason: 'install' });
    await settle();
    check('a fresh install clears it', Object.keys(map()).length === 0);
    for (const i of [11, 13, 14, 21, 22]) b.tabs.delete(i);
}

console.log('\n3. Closing many tracked tabs at once');
{
    boot();
    await settle();
    await openWorkflowWindow(20, { from: 101 });
    check('20 tabs tracked', Object.keys(map()).length === 20);
    closeTabs(Array.from({ length: 20 }, (_, i) => 101 + i));
    await until(() => Object.keys(map()).length === 0 && queue().length === 20);
    const q = queue();
    check('exactly 20 removals queued, none lost', q.length === 20 && new Set(q).size === 20
        && q.every(id => /^bm1(0[1-9]|1\d|20)$/.test(id)), JSON.stringify(q));
    check('the queue keeps the old format (bookmark ids)', q.every(id => typeof id === 'string'));
    check('and all 20 are untracked', Object.keys(map()).length === 0, JSON.stringify(map()));
    b.storage.delete('tpPendingRemovals');
}

console.log('\n4. Closing a whole workflow window keeps the workflow');
{
    await openWorkflowWindow(20, { from: 201 });
    closeTabs(Array.from({ length: 20 }, (_, i) => 201 + i), { isWindowClosing: true });
    await until(() => Object.keys(map()).length === 0);
    await settle();
    check('20 tabs closing with their window queue nothing', queue().length === 0, JSON.stringify(queue()));
    check('and are untracked', Object.keys(map()).length === 0);
}

console.log('\n5. Pruning on wake');
{
    await openWorkflowWindow(5, { from: 301 });
    // While no worker runs: 303 and 304 close unseen; 305's close is what wakes it.
    b.tabs.delete(303);
    b.tabs.delete(304);
    b.tabs.delete(305);
    boot();
    b.fire('removed', 305, { windowId: 9, isWindowClosing: false });
    await until(() => Object.keys(map()).length === 2);
    await settle();
    check('entries of tabs that are gone are dropped on wake', Object.keys(map()).sort().join() === '301,302', JSON.stringify(map()));
    check('without queueing their removal (dropping only keeps a bookmark)',
        JSON.stringify(queue()) === '["bm305"]', JSON.stringify(queue()));
    b.storage.delete('tpPendingRemovals');
    for (const i of [301, 302]) b.tabs.delete(i);
    await b.message({ type: 'TP_UNTRACK_WORKFLOW', workflowId: 'wf1' });
}

console.log('\n6. A live page takes the queue while the background appends to it');
{
    // The page's own TreeStore, over the same storage.
    globalThis.chrome = b.pageApi;
    const n = 30;
    const kids = Array.from({ length: n }, (_, i) => ({ id: `bm${401 + i}`, kind: 'bookmark', title: `t${i}`, url: `https://site${401 + i}.example/` }));
    b.storage.set('tpTree', {
        baseVersion: 1, dirty: false, editCount: 0, rev: 'seed', seq: 1, copyId: 'c1', origin: 'local',
        roots: [{ id: 'wfroot', kind: 'folder', title: 'TabPaladin Workflows', role: 'workflows', children: [
            { id: 'wf4', kind: 'folder', title: 'Research', payload: { createdAt: '2026-10-01T00:00:00Z' }, children: kids }
        ] }]
    });
    const { TreeStore } = await import('../src/utils/treeStore.js');
    await TreeStore.load();
    boot();
    await settle();
    await openWorkflowWindow(n, { from: 401, workflowId: 'wf4' });
    // One at a time, a few ms apart: each append raises a storage event that
    // has the page take the queue while the next append is on its way.
    for (let i = 0; i < n; i++) {
        closeTabs([401 + i]);
        await sleep(Math.floor(Math.random() * 4));
    }
    await until(async () => (await TreeStore.getNode('wf4')).children.length === 0 && queue().length === 0, 5000);
    const left = (await TreeStore.getNode('wf4')).children.map(c => c.id);
    check(`all ${n} closed tabs left the workflow in the live copy`, left.length === 0, JSON.stringify(left));
    check('and the queue is empty', queue().length === 0, JSON.stringify(queue()));
    await TreeStore.flush();
}

console.log(failures === 0 ? '\nAll tracking tests passed.\n' : `\n${failures} tracking test(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
