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
const pageSource = fs.readFileSync(root + '/src/content/unlockPage.js', 'utf8');
const bare = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
check('the locker scripts use no extension API', [unlockSource, pageSource].every(s => !/\b(chrome|browser)\s*\./.test(bare(s)) && !/storage\.|sendMessage|runtime\./.test(bare(s))));

// The page's side, in a pretend page: it does nothing until handed the link
// and the secret on the root element, whichever of the two runs first, and
// then reports only on events named with the secret.
const fakePage = () => {
    const said = [], listeners = {};
    class EventTarget {}
    EventTarget.prototype.addEventListener = function (t, fn) { (listeners[t] = listeners[t] || []).push(fn); };
    EventTarget.prototype.removeEventListener = function (t, fn) { listeners[t] = (listeners[t] || []).filter(f => f !== fn); };
    EventTarget.prototype.dispatchEvent = function (ev) {
        said.push({ event: ev.type, ...(typeof ev.detail === 'string' && ev.detail.startsWith('{') ? JSON.parse(ev.detail) : {}) });
        for (const fn of listeners[ev.type] || []) fn(ev);
        return true;
    };
    class Element extends EventTarget {}
    const attrs = {};
    Element.prototype.getAttribute = (k) => (k in attrs ? attrs[k] : null);
    Element.prototype.removeAttribute = (k) => { delete attrs[k]; };
    const root = new Element();
    const document = new EventTarget();
    Object.assign(document, { documentElement: root, querySelectorAll: () => [], querySelector: () => null, referrer: '' });
    class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } }
    class HTMLAnchorElement {}
    HTMLAnchorElement.prototype.click = () => {};
    const NativeSocket = function () {};
    const win = { fetch: () => new Promise(() => {}), open: () => null, WebSocket: NativeSocket };
    const box = { window: win, document, EventTarget, Element, CustomEvent, HTMLAnchorElement, JSON, Promise, String, Number, Math, Date, Array, Error,
        navigator: { userAgent: 'x' }, crypto: { randomUUID: () => 'u' }, location: { href: 'https://linkvertise.com/1/a' }, setTimeout: () => 0, setInterval: () => 0 };
    vm.createContext(box);
    return { box, said, attrs, root, document, win, NativeSocket, CustomEvent, run: () => vm.runInContext(pageSource, box, { filename: 'src/content/unlockPage.js' }) };
};
for (const [site, first] of [['linkvertise', 'page'], ['lootlabs', 'content']]) {
    const p = fakePage();
    const hand = JSON.stringify({ n: 'abc123', link: { site, userId: '1', url: 'a' } });
    let error = null;
    try {
        if (first === 'content') { p.attrs['data-tp-unlock'] = hand; p.run(); }
        else { p.run(); p.attrs['data-tp-unlock'] = hand; p.document.dispatchEvent(new p.CustomEvent('tp-unlock-hello')); }
    } catch (e) { error = e; }
    await new Promise(r => setTimeout(r, 0));
    const stub = p.win.open('https://ads.example/');
    const reports = p.said.filter(m => m.event !== 'tp-unlock-hello');
    check(`the page's side takes the hand-over (${first} script first) and reports on the secret event (${site})`,
        !error && !('data-tp-unlock' in p.attrs) && reports.length >= 2 && reports.every(m => m.event === 'tp-unlock-abc123')
        && reports[0].type === 'alive' && !reports.some(m => m.type === 'fail')
        && stub && typeof stub.close === 'function' && reports.some(m => m.type === 'log' && /popup/.test(m.text))
        && (site === 'linkvertise' || p.win.WebSocket !== p.NativeSocket), error ? error.message : p.said);
}
// What the Unlock button opens is the destination, opened by TabPaladin in
// this tab, also once the page is shown (by hand or at the human check):
// there the page would open its own redirect page in a new tab instead.
{
    const p = fakePage();
    const opened = [];
    p.win.open = (url) => { opened.push(url); return null; };
    p.attrs['data-tp-unlock'] = JSON.stringify({ n: 'abc123', link: { site: 'lootlabs', userId: '1', url: 'a' } });
    p.run();
    const unlockButton = { closest: (sel) => (/unlock-btn/.test(sel) ? {} : null) };
    const clickUnlock = () => p.document.dispatchEvent({ type: 'click', target: unlockButton });
    const doneWith = (url) => p.said.some(m => m.type === 'done' && m.url === url);
    clickUnlock();
    p.win.open('https://lootdest.example/before');
    check('before the page is shown, what Unlock opens is TabPaladin\'s to open', doneWith('https://lootdest.example/before') && opened.length === 0, opened);
    const realNow = Date.now;
    Date.now = () => realNow() + 5000;
    p.document.dispatchEvent(new p.CustomEvent('tp-unlock-in-abc123', { detail: 'shown' }));
    p.win.open('https://offer.example/');
    check('once shown, the page\'s own popups are the user\'s again', opened.length === 1 && opened[0] === 'https://offer.example/' && !doneWith('https://offer.example/'), opened);
    Date.now = () => realNow() + 10000;
    clickUnlock();
    p.win.open('https://lootdest.example/after');
    Date.now = realNow;
    check('once shown, what Unlock opens is still TabPaladin\'s to open, not a new tab', doneWith('https://lootdest.example/after') && opened.length === 1, opened);
}
{
    const p = fakePage();
    p.run();
    p.document.dispatchEvent(new p.CustomEvent('tp-unlock-hello'));
    check('without a hand-over the page\'s side does nothing', p.said.every(m => m.event === 'tp-unlock-hello') && p.win.open('x') === null);
}
check('the content side hands over on the root element and listens on the secret event',
    /setAttribute\('data-tp-unlock'/.test(unlockSource) && /'tp-unlock-' \+ secret/.test(unlockSource) && !/createElement\('script'\)/.test(unlockSource));
const hostsIn = (file, re) => [...fs.readFileSync(root + '/' + file, 'utf8').match(re)[0].matchAll(/'([a-z0-9.-]+\.[a-z]+)'/g)].map(m => m[1]).sort();
const lockerHosts = [...U.LINKVERTISE, ...U.LOOTLABS].sort();
check('the helper, Settings and the script name the same sites',
    same(hostsIn('src/helper/unwrap.js', /const HOSTS[\s\S]*?const LOCKERS/), lockerHosts)
    && same(hostsIn('src/helper/options.js', /const UNLOCK_ORIGINS[\s\S]*?\.map/), lockerHosts));

// Registered only while switched on and granted; off unregisters it.
const store = {}, granted = { on: false, rentry: false }, registered = [], storeListeners = [], permListeners = [];
const refuse = { main: false };
const regApi = {
    tabs: { onUpdated: { addListener() {} }, update: async () => {} },
    storage: { local: { get: async k => ({ [k]: store[k] }) }, onChanged: { addListener: fn => storeListeners.push(fn) } },
    permissions: {
        contains: async p => p.origins.length === lockerHosts.length ? granted.on
            : same(p.origins, ['https://*.rentry.co/*', 'https://*.rentry.org/*']) ? granted.rentry : false,
        onAdded: { addListener: fn => permListeners.push(fn) }, onRemoved: { addListener: fn => permListeners.push(fn) }
    },
    scripting: {
        registerContentScripts: async list => {
            if (refuse.main && list.some(s => s.world === 'MAIN')) throw new Error('world is not supported');
            registered.push(...list);
        },
        unregisterContentScripts: async ({ ids }) => { for (const id of ids) registered.splice(registered.findIndex(s => s.id === id), 1); },
        getRegisteredContentScripts: async ({ ids }) => registered.filter(s => ids.includes(s.id))
    }
};
const H2 = { api: regApi };
const warned = [];
const regBox = { TPHelper: H2, URL, atob, TextDecoder, Uint8Array, console: { warn: (...a) => warned.push(a.join(' ')) } };
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
const byId = id => registered.find(s => s.id === id);
const lockerScript = (s) => s && s.runAt === 'document_start' && s.matches.length === lockerHosts.length
    && s.matches.every(m => /^https:\/\/\*\.[a-z0-9.-]+\/\*$/.test(m)) && !s.allFrames;
check('switched on and granted: both scripts run at document start on the locker sites only, the page\'s side in the page\'s world',
    registered.length === 2 && lockerScript(byId('tp-unlock')) && same(byId('tp-unlock').js, ['src/content/unlock.js']) && !byId('tp-unlock').world
    && lockerScript(byId('tp-unlock-page')) && same(byId('tp-unlock-page').js, ['src/content/unlockPage.js']) && byId('tp-unlock-page').world === 'MAIN', registered);
// An update from 1.13.0, which registered only the content side.
registered.splice(registered.findIndex(s => s.id === 'tp-unlock-page'), 1);
await H2.syncLockers();
check('after an update, the missing page\'s side is added', registered.length === 2 && !!byId('tp-unlock-page'));
// A browser that refuses the page's world still gets the content side.
registered.length = 0;
refuse.main = true;
await H2.syncLockers();
check('a browser that refuses the page\'s world still gets the content side', registered.length === 1 && !!byId('tp-unlock') && warned.some(w => /tp-unlock-page/.test(w)));
refuse.main = false;
await H2.syncLockers();
granted.on = false;
await H2.syncLockers();
check('access taken back while on: unregistered', registered.length === 0);
granted.on = true;
await H2.syncLockers();
store.tpUnlock = false;
await H2.syncLockers();
check('switched off: unregistered', registered.length === 0);
check('it follows the switch and the permission', storeListeners.length === 1 && permListeners.length === 2);

// rentry.co without new tabs: its own switch and its own sites.
store.tpNoNewTabs = true;
await H2.syncLockers();
check('rentry switched on without access: nothing', registered.length === 0);
granted.rentry = true;
await H2.syncLockers();
const rentry = byId('tp-no-new-tabs');
check('rentry switched on and granted: its script runs in the page\'s world at document start on rentry.co and rentry.org only',
    registered.length === 1 && rentry && same(rentry.js, ['src/content/noNewTabs.js']) && rentry.world === 'MAIN' && rentry.runAt === 'document_start'
    && same(rentry.matches, ['https://*.rentry.co/*', 'https://*.rentry.org/*']) && !rentry.allFrames, registered);
store.tpUnlock = true;
granted.on = true;
await H2.syncLockers();
store.tpNoNewTabs = false;
await H2.syncLockers();
check('switching rentry off leaves the locker scripts alone', registered.length === 2 && !byId('tp-no-new-tabs') && !!byId('tp-unlock'));
store.tpNoNewTabs = true;
storeListeners[0]({ tpNoNewTabs: { newValue: true } }, 'local');
for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));
const onAfterEvent = !!byId('tp-no-new-tabs');
store.tpNoNewTabs = false;
storeListeners[0]({ tpNoNewTabs: { newValue: false } }, 'local');
for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));
check('flipping the rentry switch in storage registers and unregisters it', onAfterEvent && !byId('tp-no-new-tabs') && !!byId('tp-unlock'));
check('Settings asks for the same rentry sites',
    /const NO_TABS_ORIGINS = \['rentry\.co', 'rentry\.org'\]\.map\(h => `https:\/\/\*\.\$\{h\}\/\*`\)/.test(fs.readFileSync(root + '/src/helper/options.js', 'utf8')));

// The rentry script, in a pretend page.
{
    const noTabsSource = fs.readFileSync(root + '/src/content/noNewTabs.js', 'utf8');
    check('the rentry script uses no extension API', !/\b(chrome|browser)\s*\./.test(bare(noTabsSource)) && !/storage\.|sendMessage|runtime\./.test(bare(noTabsSource)));
    const opened = [], clicked = [], submitted = [], listeners = [];
    class HTMLAnchorElement {
        constructor(attrs = {}) { this.attrs = { ...attrs }; }
        get target() { return this.attrs.target || ''; }
        getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
        setAttribute(k, v) { this.attrs[k] = v; }
        hasAttribute(k) { return k in this.attrs; }
        closest() { return this; }
    }
    HTMLAnchorElement.prototype.click = function () { clicked.push(this.attrs.href); };
    class HTMLFormElement { constructor(target) { this.target = target; } }
    HTMLFormElement.prototype.submit = function () { submitted.push(this.target); };
    const assigned = [], timers = [], navigateListeners = [];
    const win = { open: (u) => { opened.push(u); return {}; }, addEventListener: (t, fn, capture) => listeners.push({ t, fn, capture }),
        navigation: { addEventListener: (t, fn) => { if (t === 'navigate') navigateListeners.push(fn); } } };
    const box = { window: win, document: { querySelector: () => null }, HTMLAnchorElement, HTMLFormElement, URL,
        location: { origin: 'https://rentry.co', assign: (u) => assigned.push(u) }, setTimeout: (fn) => timers.push(fn) };
    vm.createContext(box);
    vm.runInContext(noTabsSource, box, { filename: 'src/content/noNewTabs.js' });
    const popup = win.open('https://ads.example/');
    new HTMLAnchorElement({ href: 'https://ads.example/a', target: '_blank' }).click();
    new HTMLAnchorElement({ href: 'https://example.com/same', target: '_self' }).click();
    new HTMLAnchorElement({ href: 'blob:x', target: '_blank', download: 'f.txt' }).click();
    new HTMLFormElement('_blank').submit();
    new HTMLFormElement('').submit();
    check('scripts\' popups, new-tab link clicks and new-tab forms are stopped; same-tab ones and downloads go through',
        opened.length === 0 && popup && popup.closed === true && same(clicked, ['https://example.com/same', 'blob:x']) && same(submitted, ['']));
    const click = listeners.find(l => l.t === 'click' && l.capture);
    // The page's own handlers run after this one; `pageCancels` is one of them calling preventDefault.
    const fire = (a, ev = {}) => {
        const e = { target: a, isTrusted: true, button: 0, ctrlKey: false, shiftKey: false, metaKey: false, altKey: false, defaultPrevented: false, ...ev, preventDefault() { this.defaultPrevented = true; } };
        click.fn(e);
        if (ev.pageCancels) e.preventDefault();
        while (timers.length) timers.shift()();
        return e.defaultPrevented;
    };
    const plain = new HTMLAnchorElement({ href: 'https://mega.example/x', target: '_blank' });
    plain.href = plain.attrs.href;
    fire(plain);
    const ctrl = new HTMLAnchorElement({ href: 'https://mega.example/y', target: '_blank' });
    fire(ctrl, { ctrlKey: true });
    const fake = new HTMLAnchorElement({ href: 'https://ads.example/b', target: '_blank' });
    const stopped = fire(fake, { isTrusted: false });
    check('a plain click on a link opens it in the same tab; Ctrl-click still opens a new tab; a made-up click opens nothing',
        plain.getAttribute('target') === '_self' && ctrl.getAttribute('target') === '_blank' && stopped === true && assigned.length === 0, assigned);
    const cancelled = new HTMLAnchorElement({ href: 'https://www.gigafans.example/', target: '_blank' });
    cancelled.href = cancelled.attrs.href;
    fire(cancelled, { pageCancels: true });
    check('a plain click the page\'s ad script cancels still opens the link, here and once', same(assigned, ['https://www.gigafans.example/']), assigned);

    const navigate = navigateListeners[0];
    const go = (url, ev = {}) => { let prevented = false; navigate({ cancelable: true, userInitiated: false, navigationType: 'push', destination: { url }, ...ev, preventDefault: () => { prevented = true; } }); return prevented; };
    check('a script sending the tab to another site is stopped; to the link just clicked, within rentry, by the user, or back and forth it is not',
        navigateListeners.length === 1 && go('https://lightindividual.example/ad') === true && go('https://lightindividual.example/ad', { navigationType: 'replace' }) === true
        && go('https://www.gigafans.example/') === false && go('https://rentry.co/other') === false
        && go('https://t.example/', { userInitiated: true }) === false && go('https://t.example/', { navigationType: 'traverse' }) === false
        && go('https://t.example/', { cancelable: false }) === false);
}

if (failures) { console.error(failures + ' failed'); process.exit(1); }
console.log('all passed');
