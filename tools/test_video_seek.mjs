// Headless test: video scroll-seek reads nothing from the extension.
//
// What this locks down:
//   1. The content script (src/content/videoSeek.js), which runs on every
//      site, never touches extension storage (where the sync session lives)
//      and never messages the extension. Its registration is the switch; a
//      'tp-video-seek-off' message turns it off in pages that loaded it
//      earlier, but only from the extension itself, never from a page.
//   2. The background registers it by its own key, tpVideoSeek, and the
//      all-sites permission: an earlier version's settings.videoSeek is
//      carried over once, a later settings write does nothing, and turning
//      it off unregisters it and tells open tabs.
//   3. StorageManager's switch writes tpVideoSeek, and settings.videoSeek too
//      so an older version still finds it.
//
// Run: node tools/test_video_seek.mjs

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { makeBrowser, ROOT, EXT_ID, sleep, until } from './fake_extension.mjs';

let failures = 0;
function check(name, cond, detail) {
    if (cond) {
        console.log(`  ok  ${name}`);
    } else {
        failures++;
        console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

console.log('\n1. The content script reads and sends nothing');
{
    const source = fs.readFileSync(path.join(ROOT, 'src/content/videoSeek.js'), 'utf8');
    // Comments may say what it does not do; the code may not do it.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    check('its code names no storage and no sendMessage', !/storage/.test(code) && !/sendMessage/.test(code));

    // Run it in a page whose extension API records every touch.
    const touched = [];
    const listeners = [];
    const spy = (name, value) => new Proxy(value, {
        get(target, prop) {
            touched.push(`${name}.${String(prop)}`);
            return target[prop];
        }
    });
    const ext = spy('chrome', {
        runtime: spy('runtime', { id: EXT_ID, onMessage: { addListener: (fn) => listeners.push(fn) }, sendMessage() { touched.push('SENT'); } }),
        storage: spy('storage', { local: { get: async () => ({ settings: { backend: { token: 'SECRET' } } }) }, onChanged: { addListener() {} } })
    });
    const video = { tagName: 'VIDEO', paused: false, readyState: 4, duration: 600, currentTime: 100, querySelector: () => null };
    const docListeners = {};
    const document = {
        fullscreenElement: video,
        addEventListener: (t, fn) => { docListeners[t] = fn; },
        getElementById: () => null,
        createElement: () => ({ style: {}, remove() {} }),
        querySelectorAll: () => [video],
        head: { appendChild() {} },
        body: { appendChild() {} }
    };
    const page = { chrome: ext, document, setTimeout: () => 0, console, Date };
    page.window = page;
    vm.createContext(page);
    vm.runInContext(source, page);
    const wheel = (deltaY) => docListeners.wheel({ deltaY, preventDefault() {}, stopPropagation() {} });

    wheel(10);
    check('while registered, the wheel seeks a fullscreen video', video.currentTime === 103, String(video.currentTime));
    check('it never touched storage or sent a message',
        !touched.some(t => t.startsWith('chrome.storage') || t.startsWith('storage.') || t === 'SENT'), JSON.stringify(touched));

    for (const [who, sender] of [['a web page (a content script sender)', { id: EXT_ID, tab: { id: 3 } }],
        ['another extension', { id: 'someoneelse' }], ['no sender', null]]) {
        const expected = video.currentTime + 3;
        listeners.forEach(fn => fn({ type: 'tp-video-seek-off' }, sender));
        wheel(10);
        check(`'off' from ${who} is ignored`, video.currentTime === expected, String(video.currentTime));
    }
    const before = video.currentTime;
    listeners.forEach(fn => fn({ type: 'tp-video-seek-off' }, { id: EXT_ID, url: `chrome-extension://${EXT_ID}/src/background/background.js` }));
    wheel(10);
    check("'off' from the extension's background turns it off", video.currentTime === before, String(video.currentTime));
    listeners.forEach(fn => fn({ type: 'tp-video-seek-on' }, { id: EXT_ID }));
    wheel(10);
    check("'on' turns it back on", video.currentTime === before + 3, String(video.currentTime));
}

console.log('\n2. The background registers it by tpVideoSeek');
{
    const b = makeBrowser({ timeScale: 0.02 });
    const registered = () => b.registered.has('tp-video-seek');
    b.storage.set('settings', { videoSeek: true, backend: { url: 'https://s.example', token: 't' } });
    b.granted.add('<all_urls>');
    b.tabs.set(1, { id: 1, url: 'https://video.example/watch' });
    b.tabs.set(2, { id: 2, url: 'chrome://settings' });
    b.bootWorker();
    await until(() => registered());
    check("an earlier version's settings.videoSeek is carried over to tpVideoSeek", b.storage.get('tpVideoSeek') === true);
    check('and the script is registered for every site, from the packaged file',
        registered() && JSON.stringify(b.registered.get('tp-video-seek').js) === '["src/content/videoSeek.js"]');

    b.sentToTabs.length = 0;
    await b.pageApi.storage.local.set({ tpVideoSeek: false });
    await until(() => !registered());
    await sleep(30);
    check('switching it off unregisters it', !registered());
    check('and tells open web pages', b.sentToTabs.some(s => s.tabId === 1 && s.msg.type === 'tp-video-seek-off')
        && !b.sentToTabs.some(s => s.tabId === 2), JSON.stringify(b.sentToTabs));

    await b.pageApi.storage.local.set({ settings: { videoSeek: true } });
    await sleep(60);
    check('a settings write does not switch it on any more', !registered());

    await b.pageApi.storage.local.set({ tpVideoSeek: true });
    await until(() => registered());
    check('switching it on registers it again', registered());
    b.granted.delete('<all_urls>');
    b.fire('permRemoved', { origins: ['<all_urls>'] });
    await until(() => !registered());
    check('losing the all-sites permission unregisters it', !registered());

    b.bootWorker();
    await sleep(60);
    check('a later wake keeps tpVideoSeek as it is (no second carry-over)', b.storage.get('tpVideoSeek') === true && !registered());
}

console.log('\n3. The switch in Settings');
{
    const b = makeBrowser();
    globalThis.chrome = b.pageApi;
    const { StorageManager } = await import('../src/utils/storageManager.js');
    b.storage.set('settings', { videoSeek: true, focusedFolderIds: ['x'] });
    check('an install from before reads as on', (await StorageManager.getVideoSeek()) === true);
    await StorageManager.setVideoSeek(false);
    check('switching it off writes tpVideoSeek and settings.videoSeek, keeping the rest of settings',
        b.storage.get('tpVideoSeek') === false && b.storage.get('settings').videoSeek === false
        && JSON.stringify(b.storage.get('settings').focusedFolderIds) === '["x"]');
    check('and reads back off', (await StorageManager.getVideoSeek()) === false);
}

console.log(failures === 0 ? '\nAll video seek tests passed.\n' : `\n${failures} video seek test(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
