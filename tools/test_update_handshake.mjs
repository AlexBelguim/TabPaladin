// Headless test: the update handshake (runtime.onUpdateAvailable).
//
// Applying an update reloads the extension and ends every extension page;
// what a page held only in memory would go with it. What this locks down
// (src/background/background.js over tools/fake_extension.mjs, and the
// page side in src/utils/pageMessages.js):
//   1. With two pages open, the background asks both to write what they
//      hold, and reloads only once both have answered — not before.
//   2. A page that never answers holds the update back 5 s at most.
//   3. With no page open, the update is applied at once; asked twice, it is
//      applied once.
//   4. Where the browser cannot count the pages, it waits for the first
//      answer and a moment more.
//   5. A page acts on 'tp:prepare-update' only from this extension itself:
//      never from a content script or another extension. Only the pages'
//      own answers count, never one sent from a content script.
//   6. The app page wires it to TreeStore, ExpandState and the note's live
//      draft.
//
// Run: node tools/test_update_handshake.mjs

import fs from 'node:fs';
import path from 'node:path';
import { makeBrowser, ROOT, EXT_ID, BASE, sleep, until } from './fake_extension.mjs';

let failures = 0;
function check(name, cond, detail) {
    if (cond) {
        console.log(`  ok  ${name}`);
    } else {
        failures++;
        console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

const { listenForUpdate, isFromThisExtension } = await import('../src/utils/pageMessages.js');

// An extension page of `b`: it hears what the worker sends to pages, and its
// own messages reach the worker as from the app page.
function openPage(b, prepare) {
    const runtime = {
        id: EXT_ID,
        getURL: (p) => BASE + String(p || ''),
        onMessage: { addListener: (fn) => b.pageApi.runtime.onMessage.fns.push(fn) },
        sendMessage: (msg) => b.message(msg, b.senders.appPage)
    };
    listenForUpdate(prepare, { runtime });
}

console.log('\n1. Two pages: the update waits for both');
{
    const b = makeBrowser();
    b.setContexts([{ contextType: 'TAB' }, { contextType: 'TAB' }]);
    b.bootWorker();
    const prepared = [];
    openPage(b, async () => { await sleep(40); prepared.push('a'); });
    openPage(b, async () => { await sleep(200); prepared.push('b'); });
    b.fire('updateAvailable', { version: '1.0.2' });
    await sleep(120);
    check('both pages are asked, and the first to finish does not release the update',
        b.runtimeSent.some(m => m.type === 'tp:prepare-update' && /^[0-9a-f]{32}$/.test(m.nonce))
        && JSON.stringify(prepared) === '["a"]' && b.reloads === 0, JSON.stringify({ prepared, reloads: b.reloads }));
    await until(() => b.reloads === 1, 2000);
    check('once both have written what they hold, the update is applied', JSON.stringify(prepared) === '["a","b"]' && b.reloads === 1);
    b.fire('updateAvailable', { version: '1.0.2' });
    await sleep(300);
    check('asked again, it is not applied twice', b.reloads === 1);
}

console.log('\n2. A page that never answers');
{
    const b = makeBrowser({ timeScale: 0.02 });
    b.setContexts([{ contextType: 'TAB' }, { contextType: 'TAB' }]);
    b.bootWorker();
    openPage(b, async () => {});
    openPage(b, () => new Promise(() => {})); // hangs
    const started = Date.now();
    b.fire('updateAvailable', { version: '1.0.2' });
    await until(() => b.reloads === 1, 2000);
    check('holds the update back no longer than the 5 s limit', b.reloads === 1 && Date.now() - started < 1000, `${Date.now() - started} ms (scaled)`);
}

console.log('\n3. No page open');
{
    const b = makeBrowser();
    b.setContexts([]);
    b.bootWorker();
    const started = Date.now();
    b.fire('updateAvailable', { version: '1.0.2' });
    await until(() => b.reloads === 1, 2000);
    check('the update is applied at once', b.reloads === 1 && Date.now() - started < 200, `${Date.now() - started} ms`);

    const quiet = makeBrowser();
    quiet.bootWorker(); // cannot count pages, and none listens
    quiet.fire('updateAvailable', {});
    await until(() => quiet.reloads === 1, 2000);
    check('without a way to count pages, nobody listening applies it at once too', quiet.reloads === 1);
}

console.log('\n4. Pages that cannot be counted');
{
    const b = makeBrowser();
    b.bootWorker();
    let prepared = 0;
    openPage(b, async () => { await sleep(30); prepared++; });
    b.fire('updateAvailable', {});
    await sleep(100);
    check('after the first answer it waits a moment more', prepared === 1 && b.reloads === 0);
    await until(() => b.reloads === 1, 2000);
    check('then applies the update', b.reloads === 1);
}

console.log('\n5. Only this extension may ask, and only its pages answer');
{
    const b = makeBrowser();
    b.bootWorker();
    let prepared = 0;
    openPage(b, async () => { prepared++; });
    const ask = (sender) => {
        for (const fn of b.pageApi.runtime.onMessage.fns) fn({ type: 'tp:prepare-update', nonce: 'x' }, sender, () => {});
    };
    ask(b.senders.contentScript);
    ask(b.senders.otherExtension);
    ask({ id: EXT_ID });
    await sleep(30);
    check('a content script, another extension or a sender without a URL cannot make a page prepare', prepared === 0);
    ask({ id: EXT_ID, url: BASE + 'src/background/background.js' });
    await sleep(30);
    check('the background can', prepared === 1);
    check('isFromThisExtension: a Firefox page on the extension origin', isFromThisExtension(
        { id: 'tabpaladin@extension', url: 'moz-extension://abc-123/src/app/app.html' },
        { id: 'tabpaladin@extension', getURL: (p) => 'moz-extension://abc-123/' + p }));

    // A forged answer from a web page does not release a waiting update.
    const w = makeBrowser();
    w.setContexts([{ contextType: 'TAB' }]);
    w.bootWorker();
    let nonce = null;
    w.pageApi.runtime.onMessage.fns.push((msg) => { nonce = msg.nonce; return true; }); // a page that is slow to answer
    w.fire('updateAvailable', {});
    await until(() => nonce !== null);
    await w.message({ type: 'tp:update-ready', nonce }, w.senders.contentScript);
    await sleep(100);
    check('an answer sent from a content script does not count', w.reloads === 0);
    await w.message({ type: 'tp:update-ready', nonce: 'wrong' });
    await sleep(100);
    check('nor one for another request', w.reloads === 0);
    await w.message({ type: 'tp:update-ready', nonce, page: 'p1' });
    await until(() => w.reloads === 1);
    check('the page\'s own answer does', w.reloads === 1);
}

console.log('\n6. The app page writes everything it holds');
{
    const app = fs.readFileSync(path.join(ROOT, 'src/app/app.js'), 'utf8');
    const wired = (app.match(/listenForUpdate\(([\s\S]*?)\);\n/) || [])[1] || '';
    check('app.js answers the handshake with TreeStore.flush, ExpandState.flush and the live draft',
        /TreeStore\.flush\(\)/.test(wired) && /ExpandState\.flush\(\)/.test(wired) && /saveLiveDraft\(\)/.test(wired), wired);
}

console.log(failures === 0 ? '\nAll update handshake tests passed.\n' : `\n${failures} update handshake test(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
