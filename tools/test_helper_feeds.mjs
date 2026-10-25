// The helper's feeds: feed.open (X and Instagram, src/helper/feed.js) and
// youtube.playlist (Shorts, src/helper/save.js), with the page messages that
// step through them, over a small fake browser.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (name, ok, detail) => { console.log((ok ? '  ok  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : ' — ' + JSON.stringify(detail))); if (!ok) failures++; };

const session = {};
const registered = new Set(['tp-feed', 'tp-youtube-save']);
const tabs = [];
const msgListeners = [];
const api = {
    runtime: { id: 'ext', onMessage: { addListener: fn => msgListeners.push(fn) } },
    storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } },
    permissions: { contains: async () => true, onAdded: { addListener() {} }, onRemoved: { addListener() {} } },
    scripting: {
        getRegisteredContentScripts: async ({ ids }) => ids.filter(id => registered.has(id)).map(id => ({ id })),
        registerContentScripts: async () => {}, unregisterContentScripts: async () => {}, executeScript: async () => {}
    },
    tabs: { create: async (p) => { const t = { id: 500 + tabs.length, ...p }; tabs.push(t); return t; }, query: async () => [], onRemoved: { addListener() {} } },
    windows: { get: async () => ({ id: 1, type: 'normal', incognito: false }), getLastFocused: async () => ({}), create: async () => ({}) }
};
const H = {
    api, handlers: {}, ops: [],
    temporary: { get: async (k) => ({ [k]: session[k] }), set: async (o) => Object.assign(session, JSON.parse(JSON.stringify(o))) },
    assertContext: async () => {}, getConfig: async () => ({}),
    fail: (code, message) => { const e = new Error(message); e.code = code; throw e; }
};
const sandbox = { TPHelper: H, console, URL, URLSearchParams, setTimeout, Date };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of ['src/helper/save.js', 'src/helper/feed.js']) vm.runInContext(fs.readFileSync(root + '/' + f, 'utf8'), sandbox, { filename: f });

const ctx = { sender: { tab: { id: 9, windowId: 1 } } };
const send = (msg, url, tabId) => new Promise((resolve) => {
    const sender = { id: 'ext', frameId: 0, url, tab: { id: tabId, incognito: false } };
    for (const fn of msgListeners) { const kept = fn(msg, sender, resolve); if (kept === true) return; }
    resolve(undefined);
});

// X and Instagram
const opened = await H.handlers['feed.open']({ title: 'X saves', urls: [
    'https://x.com/nasa/status/111?s=20', 'https://twitter.com/a/status/222', 'https://x.com/nasa/status/111/photo/1',
    'https://www.instagram.com/p/AbCdE1/', 'https://www.instagram.com/someone/reel/ZyXwV2/', 'https://example.com/not-a-post'] }, ctx);
const tab = tabs.at(-1);
check('feed.open opens the first post in a new active tab, duplicates and non-posts left out',
    tab.url === 'https://x.com/i/status/111' && tab.active === true && opened.count === 4, { tab, opened });
let r = await send({ channel: 'tp-feed', op: 'get', url: 'https://x.com/nasa/status/111' }, 'https://x.com/i/status/111', tab.id);
check('the page learns where it is: 1 of 4', r.ok && r.feed && r.feed.index === 0 && r.feed.count === 4 && r.feed.title === 'X saves', r);
r = await send({ channel: 'tp-feed', op: 'go', dir: 1, url: 'https://x.com/nasa/status/111' }, 'https://x.com/i/status/111', tab.id);
check('next is the second post, as an x.com link', r.url === 'https://x.com/i/status/222', r);
r = await send({ channel: 'tp-feed', op: 'go', to: 3, url: 'https://x.com/i/status/222' }, 'https://x.com/i/status/222', tab.id);
check('a typed number goes to that post (an Instagram reel)', r.url === 'https://www.instagram.com/reel/ZyXwV2/', r);
r = await send({ channel: 'tp-feed', op: 'get', url: 'https://www.instagram.com/reel/ZyXwV2/' }, 'https://www.instagram.com/reel/ZyXwV2/', tab.id);
check('on the reel, the page is 4 of 4', r.feed && r.feed.index === 3, r);
r = await send({ channel: 'tp-feed', op: 'go', dir: 1, url: 'https://www.instagram.com/reel/ZyXwV2/' }, 'https://www.instagram.com/reel/ZyXwV2/', tab.id);
check('past the last post: the end, no address', r.ok && r.end === true && !r.url, r);
r = await send({ channel: 'tp-feed', op: 'get', url: 'https://x.com/other/status/999' }, 'https://x.com/other/status/999', tab.id);
check('a post not in the folder: no panel', r.ok && r.feed === null, r);
r = await send({ channel: 'tp-feed', op: 'get', url: 'https://x.com/nasa/status/111' }, 'https://x.com/nasa/status/111', 12345);
check('another tab has no feed', r.ok && r.feed === null, r);
r = await send({ channel: 'tp-feed', op: 'get', url: 'https://x.com/nasa/status/111' }, 'https://evil.example/x', tab.id);
check('a page on another site is refused', r && r.ok === false, r);
registered.delete('tp-feed');
let off = null;
try { await H.handlers['feed.open']({ title: 'X', urls: ['https://x.com/a/status/1'] }, ctx); } catch (e) { off = e.code; }
check('with feeds switched off, feed.open says so (feeds-off)', off === 'feeds-off', off);

// YouTube Shorts
const yt = await H.handlers['youtube.playlist']({ title: 'funny', ids: ['aaaaaa1', 'bbbbbb2', 'bbbbbb2', 'bad id!'] }, ctx);
const ytTab = tabs.at(-1);
check('youtube.playlist opens the first Short, duplicates and bad ids left out', ytTab.url === 'https://www.youtube.com/shorts/aaaaaa1' && yt.count === 2, { ytTab, yt });
r = await send({ channel: 'tp-youtube-playlist', op: 'get', url: 'https://www.youtube.com/shorts/aaaaaa1' }, 'https://www.youtube.com/shorts/aaaaaa1', ytTab.id);
check('the Short learns it is 1 of 2', r.playlist && r.playlist.index === 0 && r.playlist.count === 2, r);
r = await send({ channel: 'tp-youtube-playlist', op: 'go', to: 1, url: 'https://www.youtube.com/shorts/aaaaaa1' }, 'https://www.youtube.com/shorts/aaaaaa1', ytTab.id);
check('a typed number goes to that Short', r.url === 'https://www.youtube.com/shorts/bbbbbb2', r);

// A folder of videos and Shorts: each opens where it belongs.
const mixed = await H.handlers['youtube.playlist']({ title: 'music', videos: [{ id: 'vvvvvv1', short: false }, { id: 'ssssss2', short: true }, { id: 'vvvvvv3', short: false }] }, ctx);
const mixedTab = tabs.at(-1);
check('a video opens on the video page, not as a Short', mixedTab.url === 'https://www.youtube.com/watch?v=vvvvvv1' && mixed.count === 3, mixedTab);
r = await send({ channel: 'tp-youtube-playlist', op: 'get', url: 'https://www.youtube.com/watch?v=vvvvvv1&t=3' }, 'https://www.youtube.com/watch?v=vvvvvv1&t=3', mixedTab.id);
check('the video page learns it is 1 of 3', r.playlist && r.playlist.index === 0 && r.playlist.count === 3, r);
r = await send({ channel: 'tp-youtube-playlist', op: 'go', dir: 1, url: 'https://www.youtube.com/watch?v=vvvvvv1' }, 'https://www.youtube.com/watch?v=vvvvvv1', mixedTab.id);
check('next is the Short, in the Shorts player', r.url === 'https://www.youtube.com/shorts/ssssss2', r);
r = await send({ channel: 'tp-youtube-playlist', op: 'go', dir: 1, url: 'https://www.youtube.com/shorts/ssssss2' }, 'https://www.youtube.com/shorts/ssssss2', mixedTab.id);
check('and then the next video on the video page', r.url === 'https://www.youtube.com/watch?v=vvvvvv3', r);

console.log(failures ? `\n${failures} failed` : '\nAll helper feed checks passed');
process.exit(failures ? 1 : 0);
