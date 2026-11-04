// The Linkvertise redirect (src/helper/unwrap.js): a tab that lands on a
// "dynamic" link goes to the address in its ?r=, and nothing else moves.
// The link-locker script (src/content/unlock.js): which pages it takes, how
// it reads Lootlabs' link, that it touches no extension API, and that the
// helper registers it only while it is switched on and its sites granted.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (name, ok, detail) => { console.log((ok ? '  ok  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : ' — ' + JSON.stringify(detail))); if (!ok) failures++; };

const listeners = [];
const updates = [];
const api = { tabs: { onUpdated: { addListener: fn => listeners.push(fn) }, update: async (id, p) => { updates.push({ id, ...p }); } } };
const H = { api };
const sandbox = { TPHelper: H, URL, atob, TextDecoder, Uint8Array };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(root + '/src/helper/unwrap.js', 'utf8'), sandbox, { filename: 'src/helper/unwrap.js' });

const b64 = s => Buffer.from(s).toString('base64');
check('an /access/.../dynamic link gives its address',
    H.unwrapLink('https://linkvertise.com/access/337950/482236/dynamic?r=aHR0cHM6Ly9yZW50cnkuY28vbml6dmZ0ZWQ%3D') === 'https://rentry.co/nizvfted');
check('a fractional id and the plain /id/dynamic form work too',
    H.unwrapLink('https://linkvertise.com/access/337950/328.31574427894475/dynamic?r=aHR0cHM6Ly9yZW50cnkuY28vdmJ4dDd3cWM%3D') === 'https://rentry.co/vbxt7wqc'
    && H.unwrapLink('https://linkvertise.com/337950/dynamic?r=' + b64('https://example.com/a?b=1')) === 'https://example.com/a?b=1');
check('Linkvertise\'s other domains and www. count', H.unwrapLink('https://www.link-to.net/1/dynamic?r=' + b64('https://example.com/')) === 'https://example.com/');
check('a raw + in ?r= is still read as base64', H.unwrapLink('https://linkvertise.com/1/dynamic?r=aHR0cHM6Ly9leGFtcGxlLmNvbS8/cT0+Pj5+fn4=') === 'https://example.com/?q=%3E%3E%3E~~~');
check('UTF-8 in the address survives', H.unwrapLink('https://linkvertise.com/1/dynamic?r=' + encodeURIComponent(b64('https://example.com/ö'))) === 'https://example.com/%C3%B6');
check('only http and https destinations', H.unwrapLink('https://linkvertise.com/1/dynamic?r=' + b64('javascript:alert(1)')) === null
    && H.unwrapLink('https://linkvertise.com/1/dynamic?r=' + b64('data:text/html,hi')) === null);
check('other sites, other Linkvertise pages and junk are left alone',
    H.unwrapLink('https://example.com/1/dynamic?r=' + b64('https://evil.test/')) === null
    && H.unwrapLink('https://linkvertise.com.evil.test/1/dynamic?r=' + b64('https://evil.test/')) === null
    && H.unwrapLink('https://linkvertise.com/337950/some-name') === null
    && H.unwrapLink('https://linkvertise.com/1/dynamic?r=%%%') === null
    && H.unwrapLink('https://linkvertise.com/1/dynamic') === null
    && H.unwrapLink('not a url') === null);

const fire = (id, info, tab = {}) => listeners.forEach(fn => fn(id, info, tab));
fire(7, { url: 'https://linkvertise.com/access/337950/482236/dynamic?r=aHR0cHM6Ly9yZW50cnkuY28vbml6dmZ0ZWQ%3D' });
fire(8, { status: 'complete' });
fire(9, { url: 'https://example.com/' });
fire(10, { url: 'https://linkvertise.com/1/dynamic?r=' + b64('https://example.com/') }, { incognito: true });
await Promise.resolve();
check('the tab that landed on the link is sent on; the others are not', JSON.stringify(updates) === JSON.stringify([{ id: 7, url: 'https://rentry.co/nizvfted' }]), updates);

// The locker script's own rules, loaded where there is no page.
const unlockSource = fs.readFileSync(root + '/src/content/unlock.js', 'utf8');
const pageBox = { URL, atob, decodeURIComponent };
pageBox.globalThis = pageBox;
vm.createContext(pageBox);
vm.runInContext(unlockSource, pageBox, { filename: 'src/content/unlock.js' });
const U = pageBox.TPUnlock;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
check('Linkvertise link pages are taken in all three forms',
    same(U.classify('https://linkvertise.com/access/5973997/R1NTT1PvyGij'), { site: 'linkvertise', userId: '5973997', url: 'R1NTT1PvyGij' })
    && same(U.classify('https://linkvertise.com/514008/hydrogen-gateway-1'), { site: 'linkvertise', userId: '514008', url: 'hydrogen-gateway-1' })
    && same(U.classify('https://www.link-target.net/514008/hydrogen-gateway-1/1?o=sharing'), { site: 'linkvertise', userId: '514008', url: 'hydrogen-gateway-1' }));
check('a Lootlabs locker is taken', same(U.classify('https://speedy-links.com/s?QJn5lIft&data=uzdm4tQ4Qi7Ezt2IhnsjSGK0ZDac//sjDhnZ%2BLJQ6Vw%3D'), { site: 'lootlabs' })
    && same(U.classify('https://loot-link.com/s?abc123'), { site: 'lootlabs' }));
check('dynamic links, other pages, other sites and http are left alone',
    U.classify('https://linkvertise.com/access/337950/482236/dynamic?r=abc') === null
    && U.classify('https://linkvertise.com/access/337950/dynamic?r=abc') === null
    && U.classify('https://linkvertise.com/337950/dynamic?r=abc') === null
    && U.classify('https://linkvertise.com/explore') === null
    && U.classify('https://linkvertise.com/settings/profile') === null
    && U.classify('https://linkvertise.com/') === null
    && U.classify('https://speedy-links.com/') === null
    && U.classify('https://speedy-links.com/s') === null
    && U.classify('https://linkvertise.com.evil.test/1/a') === null
    && U.classify('https://example.com/s?abc') === null
    && U.classify('http://linkvertise.com/1/a') === null
    && U.classify('not a url') === null);
const lootPayload = (url, key = 'Kq7#z') => {
    const plain = encodeURIComponent(url);
    let x = '';
    for (let i = 0; i < plain.length; i++) x += String.fromCharCode(plain.charCodeAt(i) ^ key.charCodeAt(i % 5));
    return Buffer.from(key + x, 'latin1').toString('base64');
};
check('the Lootlabs link is read the way its page reads it', U.decodeLoot(lootPayload('https://www.gigafans.net/a?b=1&c=ö')) === 'https://www.gigafans.net/a?b=1&c=%C3%B6');
check('a Lootlabs link that is not a web address, or junk, gives nothing',
    U.decodeLoot(lootPayload('javascript:alert(1)')) === null && U.decodeLoot('%%%') === null && U.decodeLoot('') === null && U.decodeLoot(Buffer.from('abc').toString('base64')) === null);
const code = unlockSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
check('the locker script uses no extension API', !/\b(chrome|browser)\s*\./.test(code) && !/storage\.|sendMessage|runtime\./.test(code));
// The page worker is injected as text, so it must run with nothing from the
// script around it: here, in a page that has only the browser's globals.
for (const site of ['linkvertise', 'lootlabs']) {
    const said = [], listeners = {};
    const channel = { addEventListener: (t, fn) => { listeners[t] = fn; } };
    class EventTarget {}
    EventTarget.prototype.dispatchEvent = function (ev) { said.push(JSON.parse(ev.detail)); return true; };
    class CustomEvent { constructor(type, init) { this.type = type; this.detail = init.detail; } }
    class HTMLAnchorElement {}
    HTMLAnchorElement.prototype.click = () => {};
    const NativeSocket = function () {};
    const win = { fetch: () => new Promise(() => {}), open: () => null, WebSocket: NativeSocket };
    const box = {
        window: win, document: { currentScript: channel, addEventListener() {}, querySelectorAll: () => [], referrer: '' },
        EventTarget, CustomEvent, HTMLAnchorElement, JSON, Promise, String, Number, Math, Date, Array, Error,
        navigator: { userAgent: 'x' }, crypto: { randomUUID: () => 'u' }, location: { href: 'https://linkvertise.com/1/a' },
        setTimeout: () => 0, setInterval: () => 0
    };
    vm.createContext(box);
    let error = null;
    try { vm.runInContext('(' + U.pageWorker.toString() + ')(' + JSON.stringify({ link: { site, userId: '1', url: 'a' } }) + ')', box); } catch (e) { error = e; }
    await new Promise(r => setTimeout(r, 0));
    const stub = win.open('https://ads.example/');
    check(`the page worker runs on its own (${site})`, !error && said[0] && said[0].type === 'alive' && !said.some(m => m.type === 'fail')
        && stub && typeof stub.close === 'function' && said.some(m => m.type === 'log' && /popup/.test(m.text))
        && (site === 'linkvertise' || win.WebSocket !== NativeSocket) && typeof listeners['tp-unlock-in'] === 'function', error ? error.message : said);
}
const hostsIn = (file, re) => [...fs.readFileSync(root + '/' + file, 'utf8').match(re)[0].matchAll(/'([a-z0-9.-]+\.[a-z]+)'/g)].map(m => m[1]).sort();
const lockerHosts = [...U.LINKVERTISE, ...U.LOOTLABS].sort();
check('the helper, Settings and the script name the same sites',
    same(hostsIn('src/helper/unwrap.js', /const HOSTS[\s\S]*?const LOCKERS/), lockerHosts)
    && same(hostsIn('src/helper/options.js', /const UNLOCK_ORIGINS[\s\S]*?\.map/), lockerHosts));

// Registered only while switched on and granted; off unregisters it.
const store = {}, granted = { on: false }, registered = [], storeListeners = [], permListeners = [];
const regApi = {
    tabs: { onUpdated: { addListener() {} }, update: async () => {} },
    storage: { local: { get: async k => ({ [k]: store[k] }) }, onChanged: { addListener: fn => storeListeners.push(fn) } },
    permissions: {
        contains: async p => granted.on && p.origins.length === lockerHosts.length,
        onAdded: { addListener: fn => permListeners.push(fn) }, onRemoved: { addListener: fn => permListeners.push(fn) }
    },
    scripting: {
        registerContentScripts: async list => { registered.push(...list); },
        unregisterContentScripts: async ({ ids }) => { for (const id of ids) registered.splice(registered.findIndex(s => s.id === id), 1); },
        getRegisteredContentScripts: async ({ ids }) => registered.filter(s => ids.includes(s.id))
    }
};
const H2 = { api: regApi };
const regBox = { TPHelper: H2, URL, atob, TextDecoder, Uint8Array, console };
regBox.globalThis = regBox;
vm.createContext(regBox);
vm.runInContext(fs.readFileSync(root + '/src/helper/unwrap.js', 'utf8'), regBox, { filename: 'src/helper/unwrap.js' });
await H2.syncLockers();
check('off by default: nothing registered', registered.length === 0);
store.tpUnlock = true;
await H2.syncLockers();
check('switched on without access: still nothing', registered.length === 0);
granted.on = true;
await H2.syncLockers();
const reg = registered[0];
check('switched on and granted: the script runs at document start on the locker sites only',
    registered.length === 1 && reg.id === 'tp-unlock' && same(reg.js, ['src/content/unlock.js']) && reg.runAt === 'document_start'
    && reg.matches.length === lockerHosts.length && reg.matches.every(m => /^https:\/\/\*\.[a-z0-9.-]+\/\*$/.test(m)) && !reg.allFrames, reg);
granted.on = false;
await H2.syncLockers();
check('access taken back while on: unregistered', registered.length === 0);
granted.on = true;
await H2.syncLockers();
store.tpUnlock = false;
await H2.syncLockers();
check('switched off: unregistered', registered.length === 0);
check('it follows the switch and the permission', storeListeners.length === 1 && permListeners.length === 2);

if (failures) { console.error(failures + ' failed'); process.exit(1); }
console.log('all passed');
