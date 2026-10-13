// The share sheet in the PWA, end to end: pwa/app.js and pwa/shareSheet.js in
// a minimal DOM, against a real server, with a stand-in for Cache Storage so
// the worker's outbox and the kept working copy are the real code paths.
//
// What this locks down:
//   1. A share the worker kept opens the sheet by its id, the address is
//      cleaned, and the chips come from the account's own copy: the folders
//      holding links from that app, never notes, workflows or the archive.
//   2. One tap files the link there at once (on the server, and in the copy,
//      which moves to the filing's version); a second chip files it into a
//      second folder; Undo takes both back; Done closes the sheet; Enter on
//      a focused button is that button's, not Done. A folder the worker
//      filed the share into first is this tap's: saved, with Undo.
//   3. A link filed elsewhere meanwhile is folded into a push instead of a
//      conflict prompt; the phone's own edits go up with it; a push whose
//      copy the phone's own filing moved on meanwhile goes again, asking
//      nothing.
//   4. Offline, a tap is queued with the share (the amber line), a second
//      tap adds to it, and coming back online files both, the open sheet
//      saying so. Two taps online, the second while the first is on its
//      way, are both filed.
//   5. A folder made on the phone and never pushed can be filed into: it goes
//      up with its own id, and the next push matches it rather than
//      duplicating it; so can a new folder made inside it in the picker.
//   6. The copy and a half-written note are kept when the app goes to the
//      background: a share that reloads the window brings them back, says so,
//      and does not pull over unpushed edits.
//   7. A share captured as another account is shown, never filed or sent
//      without a yes; nobody's folders are offered for it, and it is never
//      offered at a start as shared while signed out. A window still on
//      alex's session when another signs in as sam sends none of sam's
//      shares with alex's token, and writes nothing over sam's session.
//   8. Pins saved from the sheet come first next time, and reach the
//      server's prefs.
//   9. The Inbox lists what waits, the same link shared twice as one row,
//      and a share a forced push erased with its note; a share both
//      uploaded and still on the phone is listed and counted once.
//  10. The copy kept on the phone is its account's: kept over a sign-out with
//      unpushed edits (and brought back for that account only, nobody else
//      signing in over it), gone with a clean sign-out, never shown to the
//      next account.
//  11. Sheets opened over the share sheet (Sign in, Settings, the Inbox)
//      are drawn over it.
//  12. Save as note signed out keeps the text on the phone and on screen.
//  13. Unpushed changes kept for another account survive a clean sign-out
//      of the account signed in, and come back when theirs signs in.
//  14. Number keys pick the chips as drawn, the starter first.
//  15. A filing answered after another account signed in goes into the
//      first account's tree only, never into the second's copy.
//
// Run: node tools/test_share_pwa.mjs [--port 18986]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const arg = (name, fallback = null) => {
    const i = process.argv.indexOf('--' + name);
    return i === -1 ? fallback : process.argv[i + 1];
};
const PORT = Number(arg('port') || 18986);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'correct horse battery';

let failures = 0;
function check(name, cond, detail) {
    if (cond) console.log(`  ok  ${name}`);
    else { failures++; console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// --- A permissive DOM (as in test_pwa_accounts.mjs) ---------------------------------

const created = [];
function classList() {
    const set = new Set();
    return {
        add: (...c) => c.forEach(x => set.add(x)),
        remove: (...c) => c.forEach(x => set.delete(x)),
        toggle: (c, on) => { const want = on === undefined ? !set.has(c) : Boolean(on); if (want) set.add(c); else set.delete(c); return want; },
        contains: (c) => set.has(c)
    };
}
function makeElement(id = null, tag = 'div') {
    const listeners = {};
    const el = {
        id, tagName: tag.toUpperCase(), style: { setProperty() {}, removeProperty() {}, getPropertyValue() { return ''; } }, dataset: {}, children: [],
        value: '', textContent: '', innerHTML: '', checked: false, disabled: false, title: '', href: '', open: false, offsetHeight: 0, scrollTop: 0,
        className: '', classList: classList(),
        addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
        removeEventListener() {},
        async fire(ev, extra = {}) {
            const event = { preventDefault() {}, stopPropagation() {}, target: el, key: '', ...extra };
            await Promise.all((listeners[ev] || []).map(fn => fn(event)));
        },
        appendChild(c) { el.children.push(c); return c; },
        insertBefore(c) { return c; },
        append() {}, prepend() {}, remove() {}, replaceWith() {}, replaceChildren() {}, insertAdjacentHTML() {},
        _qs: {},
        querySelector(sel) { return el._qs[sel] || (el._qs[sel] = makeElement()); },
        querySelectorAll() { return []; },
        closest() { return makeElement(); },
        setAttribute() {}, getAttribute() { return null; }, removeAttribute() {}, hasAttribute() { return false; },
        scrollIntoView() {}, focus() {}, select() {}, blur() {}, click() { return el.fire('click'); },
        matches() { return false; }, toggleAttribute() { return false; }, cloneNode() { return makeElement(); }, after() {}, before() {},
        setSelectionRange() {}, scrollTo() {}, contains() { return false; },
        getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
    };
    created.push(el);
    return el;
}
const elements = new Map();
const byId = (id) => {
    if (!elements.has(id)) {
        const el = makeElement(id);
        if (/sheet$|^users-block$|^auth-discard$|^menu$|^inbox-fab$/.test(id)) el.classList.add('hidden');
        elements.set(id, el);
    }
    return elements.get(id);
};
const storage = new Map();
const localStorageShim = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
    clear: () => storage.clear()
};
const windowListeners = {};
const fireWindow = (ev, e = {}) => { for (const fn of windowListeners[ev] || []) fn(e); return e; };
const documentListeners = {};
const fireDocument = (ev, e = {}) => { for (const fn of documentListeners[ev] || []) fn(e); return e; };
const dialogs = { confirm: [], prompt: [], alert: [] };
const answers = { confirm: [], prompt: [] };
let visibility = 'visible';
let closedWindow = 0;

const H = { entries: [{ state: null, url: BASE + '/' }], index: 0 };
const entry = () => H.entries[H.index];
const currentUrl = () => new URL(entry().url);
const historyShim = {
    get state() { return entry().state; },
    get length() { return H.entries.length; },
    pushState(s, t, url) {
        H.entries = H.entries.slice(0, H.index + 1);
        H.entries.push({ state: s == null ? null : structuredClone(s), url: new URL(url ?? entry().url, entry().url).href });
        H.index++;
    },
    replaceState(s, t, url) { H.entries[H.index] = { state: s == null ? null : structuredClone(s), url: new URL(url ?? entry().url, entry().url).href }; },
    back() { historyShim.go(-1); },
    go(n) {
        const to = H.index + n;
        if (!n || to < 0 || to >= H.entries.length) return;
        H.index = to;
        const st = entry().state;
        setTimeout(() => fireWindow('popstate', { state: st }), 0);
    }
};

// Cache Storage, as the browser gives the page and the worker one of: named
// caches of Responses, keyed by path.
const cacheStores = new Map();
const cachesShim = {
    async open(name) {
        if (!cacheStores.has(name)) cacheStores.set(name, new Map());
        const m = cacheStores.get(name);
        const key = (k) => (typeof k === 'string' ? k : new URL(k.url).pathname);
        return {
            match: async (k) => { const r = m.get(key(k)); return r ? r.clone() : undefined; },
            put: async (k, v) => { m.set(key(k), v); },
            delete: async (k) => m.delete(key(k)),
            keys: async () => [...m.keys()]
        };
    },
    async keys() { return [...cacheStores.keys()]; },
    async delete(name) { return cacheStores.delete(name); }
};

Object.assign(globalThis, {
    window: globalThis,
    document: {
        getElementById: byId,
        createElement: (tag) => makeElement(null, tag),
        createTextNode: (t) => ({ textContent: t }),
        body: makeElement('body'),
        documentElement: makeElement('html'),
        addEventListener(ev, fn) { (documentListeners[ev] = documentListeners[ev] || []).push(fn); },
        querySelector: () => null,
        querySelectorAll: () => [],
        get visibilityState() { return visibility; }
    },
    localStorage: localStorageShim,
    location: {
        get search() { return currentUrl().search; },
        get pathname() { return currentUrl().pathname; },
        get hash() { return currentUrl().hash; },
        get origin() { return currentUrl().origin; },
        get protocol() { return currentUrl().protocol; },
        get href() { return currentUrl().href; }
    },
    history: historyShim,
    caches: cachesShim,
    confirm: (msg) => { dialogs.confirm.push(msg); return answers.confirm.length ? answers.confirm.shift() : false; },
    prompt: (msg) => { dialogs.prompt.push(msg); return answers.prompt.length ? answers.prompt.shift() : null; },
    alert: (msg) => { dialogs.alert.push(msg); },
    scrollTo() {},
    innerHeight: 800,
    open() {},
    close() { closedWindow++; }
});
globalThis.addEventListener = (ev, fn) => { (windowListeners[ev] = windowListeners[ev] || []).push(fn); };
globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((fn) => setTimeout(fn, 0));
globalThis.cancelAnimationFrame = globalThis.cancelAnimationFrame || ((id) => clearTimeout(id));
globalThis.innerWidth = 375;
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: null }, configurable: true });
new Function('self', fs.readFileSync(path.join(REPO, 'pwa', 'shareCore.js'), 'utf8'))(globalThis);
const Share = globalThis.TPShare;

// Every request the app makes; while `offline`, those matching it fail as if
// the phone had no network.
const requests = [];
const realFetch = globalThis.fetch;
let inFlight = 0;
let lastActivity = Date.now();
let offline = null; // a RegExp over 'METHOD /path'
// One request matching `re` waits for `fn` before it goes (holdRequest), or
// is answered only once `fn` is done (holdAnswer): what happens meanwhile
// is the test.
let holdRequest = null;
let holdAnswer = null;
globalThis.fetch = async (url, opts = {}) => {
    const line = `${(opts.method || 'GET').toUpperCase()} ${String(url).replace(BASE, '')}`;
    requests.push(line);
    if (offline && offline.test(line)) throw new TypeError('Failed to fetch');
    if (holdRequest && holdRequest.re.test(line)) { const h = holdRequest; holdRequest = null; await h.fn(); }
    inFlight++;
    let res;
    try { res = await realFetch(url, opts); } finally { inFlight--; lastActivity = Date.now(); }
    if (holdAnswer && holdAnswer.re.test(line)) { const h = holdAnswer; holdAnswer = null; await h.fn(); }
    return res;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function settle() {
    for (let i = 0; i < 100; i++) {
        await new Promise(r => setTimeout(r, 40));
        if (inFlight === 0 && Date.now() - lastActivity > 200) return;
    }
}

// --- The server ---------------------------------------------------------------------

async function api(p, { method = 'GET', token, body } = {}) {
    const res = await realFetch(BASE + p, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await res.json(); } catch (e) { /* empty */ }
    return { status: res.status, json };
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-share-pwa-'));
const env = { ...process.env };
for (const k of Object.keys(env)) if (/^(AUTH_TOKEN|ADMIN_|TENANCY_OWNER|IMPORT_|MAX_)/.test(k)) delete env[k];
const server = spawn(process.execPath, [path.join(REPO, 'server', 'index.js')], {
    env: { ...env, PORT: String(PORT), DATA_DIR: dataDir, PWA_DIR: path.join(REPO, 'pwa'), ADMIN_USERNAME: 'alex', ADMIN_PASSWORD: PASSWORD, IMPORTS_SCHEDULER: 'off' },
    stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', d => { serverLog += d; });
server.stderr.on('data', d => { serverLog += d; });
const serverExited = new Promise(r => server.on('exit', r));

// --- Helpers ----------------------------------------------------------------------------

// The account's own tree, without the virtual archive the server draws in.
const stripVirtual = (nodes) => (nodes || []).filter(n => !n.virtual && !n.readOnly)
    .map(n => (n.children ? { ...n, children: stripVirtual(n.children) } : n));
const tree = async (token) => {
    const json = (await api('/api/tree', { token })).json;
    return { ...json, roots: stripVirtual(json.roots) };
};
const find = (nodes, test) => {
    for (const n of nodes || []) {
        if (test(n)) return n;
        const hit = find(n.children, test);
        if (hit) return hit;
    }
    return null;
};
const byTitle = (roots, title) => find(roots, n => n.title === title);
const sheetOpen = () => !byId('share-sheet').classList.contains('hidden');
const since = (mark) => created.slice(mark);
const chip = (folderId, mark = 0) => [...since(mark)].reverse().find(e => /\bshare-chip\b/.test(e.className) && e.dataset.folderId === folderId);
const chipsDrawn = (mark = 0) => {
    // The last grid drawn: its chips in order.
    const grids = since(mark).filter(e => e.className === 'share-chips');
    const grid = grids[grids.length - 1];
    return grid ? grid.children.filter(c => /\bshare-chip\b/.test(c.className)) : [];
};
const button = (text, mark = 0) => [...since(mark)].reverse().find(e => e.tagName === 'BUTTON' && e.textContent === text);
const drawnText = (text, mark = 0) => since(mark).some(e => [e.textContent, e.value].some(s => typeof s === 'string' && s.includes(text)));
const lastToast = () => [...document.body.children].reverse().find(c => c.id === 'tp-toast')?.textContent || '';
const outbox = Share.cacheOutbox(cachesShim);
const kept = async () => {
    const c = await cachesShim.open('tp-data');
    const hit = await c.match('/__tp_tree');
    return hit ? hit.json() : null;
};

// The worker's half of a share: kept in the outbox, then the app opened on it.
async function shareFromWorker(fields, account) {
    const e = Share.makeEntry({ fields, account, source: 'share' });
    await outbox.put(e);
    return e;
}

let starts = 0;
async function coldStart(url) {
    elements.clear();
    for (const k of Object.keys(windowListeners)) delete windowListeners[k];
    for (const k of Object.keys(documentListeners)) delete documentListeners[k];
    H.entries = [{ state: null, url }];
    H.index = 0;
    await import(pathToFileURL(path.join(REPO, 'pwa', 'app.js')).href + '?start=' + (++starts));
    for (const fn of windowListeners.DOMContentLoaded || []) await fn();
    await settle();
}

async function signInStorage(username, password) {
    const login = (await api('/api/login', { method: 'POST', body: { username, password } })).json;
    localStorageShim.setItem('tp_pwa_url', BASE);
    localStorageShim.setItem('tp_pwa_token', login.token);
    localStorageShim.setItem('tp_pwa_user', login.username);
    localStorageShim.setItem('tp_pwa_userid', String(login.user.id));
    localStorageShim.setItem('tp_pwa_serverid', login.serverId);
    return login;
}

const accountOf = (login) => ({ url: BASE, userId: login.user.id, username: login.username, serverId: login.serverId });

// Signing in through Settings, as a person would.
async function signIn(username, password) {
    byId('cfg-url').value = BASE;
    byId('cfg-username').value = username;
    byId('cfg-password').value = password;
    byId('auth-error').textContent = '';
    await byId('auth-submit').fire('click');
    await settle();
}

try {
    for (let i = 0; i < 100; i++) {
        try { if ((await realFetch(BASE + '/api/health')).ok) break; } catch (e) { /* not yet */ }
        await new Promise(r => setTimeout(r, 100));
    }
    const alexLogin = await signInStorage('alex', PASSWORD);
    const A = alexLogin.token;
    // alex's tree: X links in AI and Fun, notes and a workflow full of X links.
    const t0 = await tree(A);
    const bmRoot = t0.roots.find(r => r.role === 'bookmarks');
    const x = (n) => `https://x.com/u${n}/status/${n}`;
    bmRoot.children = [
        { id: 'f-ai', kind: 'folder', title: 'AI', children: [
            { id: 'ai-1', kind: 'bookmark', title: 'X 1', url: x(1) }, { id: 'ai-2', kind: 'bookmark', title: 'X 2', url: x(2) },
            { id: 'f-papers', kind: 'folder', title: 'Papers', children: [{ id: 'p-1', kind: 'bookmark', title: 'Paper', url: 'https://arxiv.org/abs/1' }] }
        ] },
        { id: 'f-fun', kind: 'folder', title: 'Fun', children: [{ id: 'fun-1', kind: 'bookmark', title: 'X 3', url: x(3) }] },
        { id: 'f-misc', kind: 'folder', title: 'Misc', children: [] }
    ];
    const roots0 = [bmRoot,
        { id: 'f-notes', kind: 'folder', role: 'notes', title: 'Notes', children: [{ id: 'n-1', kind: 'note', title: 'Diary', payload: { content: '# Diary\n\nPRIVATE' } }] },
        { id: 'f-wf', kind: 'folder', role: 'workflows', title: 'Workflows', children: [{ id: 'wf-1', kind: 'folder', title: 'Doomscroll',
            children: Array.from({ length: 30 }, (_, i) => ({ id: `wf-x-${i}`, kind: 'bookmark', title: 't', url: x(100 + i) })) }] }];
    const put0 = await api('/api/tree', { method: 'PUT', token: A, body: { roots: roots0, baseVersion: t0.version, deviceId: 'laptop' } });
    if (put0.status !== 200) throw new Error('could not set up the tree: ' + JSON.stringify(put0.json));

    console.log('\n1. A share the worker kept opens the sheet');
    const s1 = await shareFromWorker({ title: '', text: 'Look at this https://x.com/nasa/status/42?s=20', url: '' }, accountOf(alexLogin));
    let mark = created.length;
    await coldStart(`${BASE}/?share=${s1.sid}`);
    check('the sheet opens on it, and the address is cleaned', sheetOpen() && currentUrl().search === '' && drawnText('From X', mark));
    const order = chipsDrawn(mark).map(c => c.dataset.folderId);
    check('its chips are the folders holding X links, most first — not the workflow full of them, nor notes',
        order[0] === 'f-ai' && order[1] === 'f-fun' && !order.includes('wf-1') && !order.includes('f-notes') && !drawnText('Doomscroll', mark),
        JSON.stringify(order));
    check('the share went up from the page as well (the worker is not running here)', (await api(`/api/shares/${s1.sid}`, { token: A })).status === 200);

    console.log('\n2. One tap files it');
    mark = created.length;
    await chip('f-ai').fire('click');
    await settle();
    let t = await tree(A);
    check('one tap: on the server, at the end of AI, titled with the words around the link',
        byTitle(t.roots, 'AI').children.at(-1).url === 'https://x.com/nasa/status/42' && byTitle(t.roots, 'AI').children.at(-1).title === 'Look at this',
        JSON.stringify(byTitle(t.roots, 'AI').children.at(-1)));
    check('  the chip says saved, with Undo', /\bsaved\b/.test(chip('f-ai', mark).className) && drawnText('✓ Saved to AI', mark) && Boolean(button('Undo', mark)));
    check('  the share is filed', (await api(`/api/shares/${s1.sid}`, { token: A })).json.share.status === 'filed');
    // A desktop keyboard: Enter on the focused Undo is that button's, not Done.
    const enterOnUndo = { key: 'Enter', target: button('Undo', mark), preventDefault() {}, stopImmediatePropagation() {} };
    for (const fn of documentListeners.keydown || []) fn(enterOnUndo);
    await settle();
    check('Enter on a focused button does what that button does: the sheet does not close as Done', sheetOpen());
    mark = created.length;
    await chip('f-fun').fire('click');
    await settle();
    t = await tree(A);
    check('a second chip files it into a second folder', byTitle(t.roots, 'Fun').children.at(-1).url === 'https://x.com/nasa/status/42'
        && (await api(`/api/shares/${s1.sid}`, { token: A })).json.share.filings.length === 2);
    mark = created.length;
    await button('Undo').fire('click');
    await settle();
    t = await tree(A);
    const after2 = (await api(`/api/shares/${s1.sid}`, { token: A })).json.share;
    // An X link goes back to its archive, where it waited on arrival.
    check('Undo takes both back', !JSON.stringify(t.roots).includes('nasa/status/42') && after2.status === 'archived' && after2.filings.length === 0,
        JSON.stringify(after2) + ' ' + requests.filter(r => /unfile/.test(r)).join(','));
    await chip('f-ai').fire('click');
    await settle();
    mark = created.length;
    await button('Done').fire('click');
    await settle();
    check('filed again, Done closes the sheet and says where it went', !sheetOpen() && /Saved to AI/.test(lastToast())
        && JSON.stringify((await tree(A)).roots).includes('nasa/status/42'),
        JSON.stringify({ open: sheetOpen(), toast: lastToast(), filed: JSON.stringify((await tree(A)).roots).includes('nasa/status/42'), req: requests.slice(-8) }));
    check('  the share is off the phone', !(await outbox.get(s1.sid)));

    console.log('\n2b. The worker filed it first');
    const s2b = await shareFromWorker({ text: 'https://x.com/first/status/77' }, accountOf(alexLogin));
    mark = created.length;
    await coldStart(`${BASE}/?share=${s2b.sid}`);
    // The worker's request for the same tap lands first.
    await api(`/api/shares/${s2b.sid}/file`, { method: 'POST', token: A, body: { targets: [{ folderId: 'f-fun' }] } });
    mark = created.length;
    await chip('f-fun').fire('click');
    await settle();
    check('a folder this share was just filed into by the worker is saved by this tap, with Undo and Done, not "already here"',
        /\bsaved\b/.test(chip('f-fun', mark).className) && Boolean(button('Undo', mark)) && Boolean(button('Done', mark)) && !drawnText('✓ already here', mark),
        JSON.stringify({ cls: chip('f-fun', mark) && chip('f-fun', mark).className, done: Boolean(button('Done', mark)) }));
    await button('Done', mark).fire('click');
    await settle();

    console.log('\n3. A push after a link was filed elsewhere');
    // The copy moved with each filing, so a push now goes straight through.
    answers.prompt.push('Phone folder');
    await byId('newFolderBtn').fire('click');
    await settle();
    t = await tree(A);
    check('after filing, an edit on the phone pushes without a conflict, keeping the filed link',
        Boolean(byTitle(t.roots, 'Phone folder')) && JSON.stringify(t.roots).includes('nasa/status/42') && dialogs.confirm.length === 0,
        dialogs.confirm.join(' | '));
    // The laptop's share sheet files a link meanwhile.
    await api('/api/shares', { method: 'POST', token: A, body: { sid: 'laptop-share-0000000001', url: 'https://example.com/from-laptop' } });
    await api('/api/shares/laptop-share-0000000001/file', { method: 'POST', token: A, body: { targets: [{ folderId: 'f-misc' }] } });
    answers.prompt.push('Second phone folder');
    const confirms3 = dialogs.confirm.length;
    await byId('newFolderBtn').fire('click');
    await settle();
    t = await tree(A);
    check('a push that meets a link filed elsewhere folds it in and goes through, asking nothing',
        Boolean(byTitle(t.roots, 'Second phone folder')) && byTitle(t.roots, 'Misc').children.some(c => c.url === 'https://example.com/from-laptop')
        && dialogs.confirm.length === confirms3 && requests.some(r => r.startsWith('GET /api/tree/ops?since=')), dialogs.confirm.slice(confirms3).join(' | '));

    console.log('\n3b. A push that meets the phone\'s own filing on its way');
    // A choice made offline goes up when the network is back, while a push
    // of an edit is on its way: the filing moves the copy on before the push
    // hears its 409.
    const s3b = Share.makeEntry({ fields: { text: 'https://example.com/during-a-push' }, account: accountOf(alexLogin) });
    await outbox.put({ ...s3b, file: Share.makeIntent([{ folderId: 'f-misc', label: 'Misc' }], [], { at: new Date().toISOString() }) });
    const confirms3b = dialogs.confirm.length;
    holdRequest = {
        re: /^PUT \/api\/tree$/,
        fn: async () => {
            fireWindow('online');
            for (let i = 0; i < 100 && (await outbox.get(s3b.sid)); i++) await sleep(40);
            await sleep(150);
        }
    };
    answers.prompt.push('Pushed during a filing');
    await byId('newFolderBtn').fire('click');
    await settle();
    t = await tree(A);
    check('the push goes again from where the filing moved the copy, asking nothing',
        dialogs.confirm.length === confirms3b && Boolean(byTitle(t.roots, 'Pushed during a filing'))
        && byTitle(t.roots, 'Misc').children.some(c => c.url === 'https://example.com/during-a-push') && !holdRequest,
        JSON.stringify({ confirms: dialogs.confirm.slice(confirms3b), status: byId('status').textContent, toast: lastToast() }));

    console.log('\n4. Offline');
    offline = /\/api\/shares/;
    const s4 = await shareFromWorker({ title: 'Offline read', text: 'https://blog.example/offline-read', url: '' }, accountOf(alexLogin));
    mark = created.length;
    await coldStart(`${BASE}/?share=${s4.sid}`);
    check('offline, the sheet still opens, from the phone', sheetOpen() && drawnText('Offline read', mark));
    mark = created.length;
    await chip('f-ai').fire('click');
    await settle();
    const queued = await outbox.get(s4.sid);
    check('a tap is kept with the share, and the sheet says when it goes', queued && queued.file && queued.file.targets[0].folderId === 'f-ai'
        && drawnText("Will save to AI when you're back online", mark) && !JSON.stringify((await tree(A)).roots).includes('offline-read'));
    mark = created.length;
    await chip('f-fun').fire('click');
    await settle();
    const queued2 = await outbox.get(s4.sid);
    check('  a second tap adds its folder to the first, kept and said', JSON.stringify(Share.intentKeys(queued2.file)) === '["f-ai","f-fun"]'
        && drawnText("Will save to AI, Fun when you're back online", mark), JSON.stringify(queued2 && queued2.file));
    offline = null;
    mark = created.length;
    fireWindow('online');
    await settle();
    const t4 = await tree(A);
    check('back online, both are filed and it leaves the phone', byTitle(t4.roots, 'AI').children.some(c => c.url === 'https://blog.example/offline-read')
        && byTitle(t4.roots, 'Fun').children.some(c => c.url === 'https://blog.example/offline-read') && !(await outbox.get(s4.sid))
        && (await api(`/api/shares/${s4.sid}`, { token: A })).json.share.filings.length === 2);
    check('  and the open sheet says so: saved, with Undo and Done, nothing waiting', Boolean(button('Done', mark)) && Boolean(button('Undo', mark))
        && /\bsaved\b/.test(chip('f-ai', mark).className) && /\bsaved\b/.test(chip('f-fun', mark).className) && !drawnText('Will save to', mark));
    await button('Done', mark).fire('click');
    await settle();

    console.log('\n4b. Two taps while the first is on its way');
    const s4b = await shareFromWorker({ text: 'https://blog.example/two-quick-taps' }, accountOf(alexLogin));
    await coldStart(`${BASE}/?share=${s4b.sid}`);
    let releaseA = null;
    holdRequest = { re: /\/file$/, fn: () => new Promise(r => { releaseA = r; }) };
    mark = created.length;
    const tapA = chip('f-ai').fire('click');
    await sleep(200);
    const tapB = chip('f-fun').fire('click');
    await sleep(200);
    releaseA();
    await Promise.all([tapA, tapB]);
    await settle();
    const t4b = await tree(A);
    check('the second tap, made while the first was on its way, is filed too',
        byTitle(t4b.roots, 'AI').children.some(c => c.url === 'https://blog.example/two-quick-taps')
        && byTitle(t4b.roots, 'Fun').children.some(c => c.url === 'https://blog.example/two-quick-taps') && !(await outbox.get(s4b.sid)),
        JSON.stringify(requests.filter(r => /two|file/.test(r)).slice(-6)));
    check('  and both chips say saved', /\bsaved\b/.test(chip('f-ai', mark).className) && /\bsaved\b/.test(chip('f-fun', mark).className),
        JSON.stringify([chip('f-ai', mark)?.className, chip('f-fun', mark)?.className]));
    await button('Done', mark).fire('click');
    await settle();

    console.log('\n5. A folder made on the phone and never pushed');
    offline = /^PUT \/api\/tree$/;
    answers.prompt.push('Made offline');
    await byId('newFolderBtn').fire('click');
    await settle();
    offline = null;
    check('the folder is only on the phone', !JSON.stringify((await tree(A)).roots).includes('Made offline'));
    const s5 = await shareFromWorker({ text: 'https://example.com/into-a-phone-folder' }, accountOf(alexLogin));
    mark = created.length;
    // A share reloads the window: the copy with the unpushed folder comes back with it.
    visibility = 'hidden';
    fireDocument('visibilitychange');
    await settle();
    visibility = 'visible';
    await coldStart(`${BASE}/?share=${s5.sid}`);
    await button('Other folder or several…').fire('click');
    const search = [...created].reverse().find(e => e.className === 'share-search');
    search.value = 'made off';
    await search.fire('input');
    const row = [...created].reverse().find(e => /\bshare-row\b/.test(e.className) && e.tagName === 'LABEL' && JSON.stringify(e.children.map(c => c.textContent)).length >= 0
        && textOf(e).includes('Made offline'));
    await row.children[0].fire('change');
    await button('Save to 1 folder').fire('click');
    await settle();
    t = await tree(A);
    const made = byTitle(t.roots, 'Made offline');
    check('filed into it: the folder goes up with the phone\'s own id, holding the link', made && made.children.some(c => c.url === 'https://example.com/into-a-phone-folder'));
    await button('Done').fire('click');
    await settle();
    await byId('pushBtn').fire('click');
    await settle();
    t = await tree(A);
    check('  and the phone\'s next push matches it instead of making a second one',
        JSON.stringify(t.roots).split('"Made offline"').length === 2 && byTitle(t.roots, 'Made offline').children.length === 1, JSON.stringify(t.roots).slice(0, 300));

    console.log('\n5b. A new folder made in the picker inside a folder never pushed');
    offline = /^PUT \/api\/tree$/;
    answers.prompt.push('Recipes');
    await byId('newFolderBtn').fire('click');
    await settle();
    offline = null;
    const s5b = await shareFromWorker({ text: 'https://example.com/soup' }, accountOf(alexLogin));
    visibility = 'hidden';
    fireDocument('visibilitychange');
    await settle();
    visibility = 'visible';
    const mark5b = created.length;
    await coldStart(`${BASE}/?share=${s5b.sid}`);
    await button('Other folder or several…').fire('click');
    const search5b = [...created].reverse().find(e => e.className === 'share-search');
    search5b.value = 'Soups';
    await search5b.fire('input');
    const parentSelect = [...created].reverse().find(e => e.className === 'share-parent');
    const recipesOption = parentSelect && parentSelect.children.find(o => /Recipes/.test(o.textContent));
    parentSelect.value = recipesOption ? recipesOption.value : parentSelect.value;
    await button('+ Create "Soups" in').fire('click');
    await button('Save to 1 folder').fire('click');
    await settle();
    t = await tree(A);
    const recipes = byTitle(t.roots, 'Recipes');
    const soups = recipes && recipes.children.find(c => c.title === 'Soups');
    check('it is made where it was asked for, with the folder it sits in, and the link filed into it',
        Boolean(recipesOption) && soups && soups.children.some(c => c.url === 'https://example.com/soup') && !drawnText('deleted on another device', mark5b),
        JSON.stringify({ recipes: recipes && recipes.children.map(c => c.title), message: [...created].reverse().find(e => e.className === 'share-message')?.textContent }));
    await button('Done').fire('click');
    await settle();
    await byId('pushBtn').fire('click');
    await settle();
    t = await tree(A);
    check('  and the next push keeps one of each', JSON.stringify(t.roots).split('"Recipes"').length === 2 && JSON.stringify(t.roots).split('"Soups"').length === 2);

    console.log('\n6. A share reloads the window over unpushed edits and a half-written note');
    offline = /^PUT \/api\/tree$/;
    answers.prompt.push('Unpushed when shared');
    await byId('newFolderBtn').fire('click');
    await settle();
    offline = null;
    await byId('notesBtn').fire('click');
    const tNote = { dataset: { nv: 'new-note' }, closest: (sel) => (sel === '[data-nv]' ? tNote : null) };
    await byId('content').fire('click', { target: tNote });
    await settle();
    await byId('content').fire('input', { target: { id: 'note-body-input', value: '# Half\n\nHALF WRITTEN', style: {}, scrollHeight: 0 } });
    visibility = 'hidden';
    fireDocument('visibilitychange');
    await settle();
    visibility = 'visible';
    const keptRec = await kept();
    check('going to the background keeps the copy, dirty, and the note being written', keptRec && keptRec.dirty
        && JSON.stringify(keptRec.roots).includes('Unpushed when shared') && keptRec.nv && /HALF WRITTEN/.test(keptRec.nv.draft));
    const s6 = await shareFromWorker({ text: 'https://example.com/while-writing' }, accountOf(alexLogin));
    const pullsBefore = requests.filter(r => r === 'GET /api/tree').length;
    mark = created.length;
    await coldStart(`${BASE}/?share=${s6.sid}`);
    check('the reload brings both back and says so, without pulling over them',
        /Restored unpushed changes from/.test(byId('status').textContent) && requests.filter(r => r === 'GET /api/tree').length === pullsBefore
        && [...created].reverse().find(e => e.tagName === 'TEXTAREA')?.value.includes('HALF WRITTEN') && sheetOpen(), byId('status').textContent);
    const chip6 = chipsDrawn(mark)[0];
    await chip6.fire('click');
    await settle();
    await button('Done', mark).fire('click');
    await settle();
    // ✓ Done on the note, which saves it and pushes the copy with it.
    const tDone = { dataset: { nv: 'done' }, closest: (sel) => (sel === '[data-nv]' ? tDone : null) };
    await byId('content').fire('click', { target: tDone });
    await settle();
    await byId('pushBtn').fire('click');
    await settle();
    t = await tree(A);
    const into6 = find(t.roots, n => n.id === chip6.dataset.folderId);
    check('  then the link files, and the restored edit and note push, all kept', Boolean(byTitle(t.roots, 'Unpushed when shared'))
        && into6 && into6.children.some(c => c.url === 'https://example.com/while-writing') && JSON.stringify(t.roots).includes('HALF WRITTEN'),
        JSON.stringify({ unpushed: Boolean(byTitle(t.roots, 'Unpushed when shared')), into: into6 && into6.children.map(c => c.url),
            req: requests.slice(-12), confirms: dialogs.confirm.slice(-3), status: byId('status').textContent, toast: lastToast() }));

    console.log('\n7. A share captured as another account');
    const sam = await api('/api/users', { method: 'POST', token: A, body: { username: 'sam', password: 'sam-password-1', role: 'user', currentPassword: PASSWORD } });
    const samLogin = (await api('/api/login', { method: 'POST', body: { username: 'sam', password: 'sam-password-1' } })).json;
    const s7 = await shareFromWorker({ text: 'https://example.com/sams-link' }, accountOf(samLogin));
    mark = created.length;
    await coldStart(`${BASE}/?share=${s7.sid}`);
    check('opened while alex is signed in: shown as sam\'s, with no folders of alex\'s to file into',
        sam.status === 200 && sheetOpen() && drawnText('Shared while signed in as sam.', mark) && chipsDrawn(mark).length === 0 && Boolean(button('Upload to alex', mark)));
    check('  and nothing was sent to either account', (await api(`/api/shares/${s7.sid}`, { token: A })).status === 404
        && (await api(`/api/shares/${s7.sid}`, { token: samLogin.token })).status === 404);
    await button('Later').fire('click');
    await settle();
    check('Later leaves it on the phone, still sam\'s', (await outbox.get(s7.sid))?.account.username === 'sam');

    console.log('\n7b. Another window signs in as sam while this one is still alex\'s');
    // The other window writes sam's session to the shared localStorage; this
    // page still holds alex's token in memory.
    const samSession = (await api('/api/login', { method: 'POST', body: { username: 'sam', password: 'sam-password-1' } })).json;
    const alexStored = Object.fromEntries(['tp_pwa_token', 'tp_pwa_user', 'tp_pwa_userid', 'tp_pwa_serverid'].map(k => [k, localStorageShim.getItem(k)]));
    localStorageShim.setItem('tp_pwa_token', samSession.token);
    localStorageShim.setItem('tp_pwa_user', 'sam');
    localStorageShim.setItem('tp_pwa_userid', String(samSession.user.id));
    fireWindow('online');
    await settle();
    check('coming online, this page sends none of sam\'s shares with alex\'s token: nothing lands in either inbox',
        (await api(`/api/shares/${s7.sid}`, { token: A })).status === 404 && (await api(`/api/shares/${s7.sid}`, { token: samSession.token })).status === 404
        && (await outbox.get(s7.sid))?.uploaded === false);
    await byId('settingsBtn').fire('click');
    await settle();
    check('  and asking the server who it is writes nothing over the other window\'s session',
        localStorageShim.getItem('tp_pwa_userid') === String(samSession.user.id) && localStorageShim.getItem('tp_pwa_token') === samSession.token,
        JSON.stringify([localStorageShim.getItem('tp_pwa_userid'), localStorageShim.getItem('tp_pwa_user')]));
    byId('settings-sheet').classList.add('hidden');
    for (const [k, v] of Object.entries(alexStored)) localStorageShim.setItem(k, v);
    await api('/api/logout', { method: 'POST', token: samSession.token });

    console.log('\n8. Pins');
    const confirms8 = dialogs.confirm.length;
    const s8 = await shareFromWorker({ text: 'https://x.com/a/status/8' }, accountOf(alexLogin));
    mark = created.length;
    await coldStart(`${BASE}/?share=${s8.sid}`);
    await chip('f-misc', mark)?.fire('contextmenu');
    let pinItem = button('Pin for X');
    if (!pinItem) {
        // Misc is not among the chips: pin it from Edit.
        await button('✎ Edit').fire('click');
        pinItem = [...created].reverse().find(e => e.tagName === 'BUTTON' && e.textContent === '📌 Pin');
    }
    await pinItem.fire('click');
    await settle();
    const prefs = (await api('/api/prefs/share', { token: A })).json;
    check('a pin is saved to the server\'s prefs', prefs && prefs.value && prefs.value.apps && (prefs.value.apps.x.pinned || []).length === 1, JSON.stringify(prefs));
    await button('Later').fire('click');
    await settle();
    const pinned = prefs.value.apps.x.pinned[0];
    const s8b = await shareFromWorker({ text: 'https://x.com/b/status/9' }, accountOf(alexLogin));
    mark = created.length;
    await coldStart(`${BASE}/?share=${s8b.sid}`);
    check('  and the pinned folder is the first chip next time', chipsDrawn(mark)[0]?.dataset.folderId === pinned, JSON.stringify(chipsDrawn(mark).map(c => c.dataset.folderId)));
    await button('Later').fire('click');
    await settle();
    check('a share kept for sam is never offered to alex at a start as "shared while signed out"',
        !dialogs.confirm.slice(confirms8).some(m => /shared while signed out/.test(m)) && (await outbox.get(s7.sid))?.account.username === 'sam',
        dialogs.confirm.slice(confirms8).join(' | '));

    console.log('\n9. The Inbox');
    for (const sid of ['twin-share-00000000001', 'twin-share-00000000002']) {
        await api('/api/shares', { method: 'POST', token: A, body: { sid, url: 'https://example.com/twice', urlKey: 'example.com/twice' } });
    }
    await api('/api/shares', { method: 'POST', token: A, body: { sid: 'erased-share-000000001', url: 'https://example.com/erased' } });
    const before9 = await tree(A);
    await api('/api/shares/erased-share-000000001/file', { method: 'POST', token: A, body: { targets: [{ folderId: 'f-misc' }] } });
    await api('/api/tree', { method: 'PUT', token: A, body: { roots: before9.roots.filter(r => !r.virtual), baseVersion: before9.version, force: true, deviceId: 'old-laptop' } });
    mark = created.length;
    await byId('bottom-nav').fire('click', { target: { closest: () => ({ dataset: { nav: 'inbox' } }) } });
    await settle();
    const rows = byId('inbox-list').children.filter(r => r.className === 'inbox-row');
    const rowText = rows.map(textOf);
    check('the same link shared twice is one row, saying so', rowText.filter(s => s.includes('example.com/twice') || s.includes('twice')).length >= 1
        && rowText.some(s => /shared 2×/.test(s)), rowText.join(' || ').slice(0, 600));
    check('a share a forced push erased is back, with why', rowText.some(s => /Removed by a forced push from old-laptop/.test(s)));
    check('a share captured as sam waits, offered to alex', rowText.some(s => s.includes('sams link') && /Shared as sam/.test(s)), rowText.join(' || ').slice(0, 800));
    const badge = Number(byId('inbox-count').textContent || 0);
    check('the Inbox counts what waits', badge >= 3, String(badge));
    // A share the worker uploaded, the app left without Later: on the server
    // and still on the phone. The Inbox lists it once, and counts it once.
    await api('/api/shares', { method: 'POST', token: A, body: { sid: 'left-on-phone-00000001', url: 'https://example.com/left-on-phone' } });
    const left9 = Share.makeEntry({ fields: { url: 'https://example.com/left-on-phone' }, account: accountOf(alexLogin), sid: 'left-on-phone-00000001' });
    await outbox.put({ ...left9, uploaded: true, uploadedAt: new Date().toISOString(), share: { sid: left9.sid } });
    await byId('bottom-nav').fire('click', { target: { closest: () => ({ dataset: { nav: 'inbox' } }) } });
    await settle();
    const withEntry = Number(byId('inbox-count').textContent || 0);
    const listed9 = byId('inbox-list').children.filter(r => r.className === 'inbox-row').map(textOf).filter(x => /left.on.phone/.test(x)).length;
    await outbox.remove(left9.sid);
    await byId('bottom-nav').fire('click', { target: { closest: () => ({ dataset: { nav: 'inbox' } }) } });
    await settle();
    const withoutEntry = Number(byId('inbox-count').textContent || 0);
    check('  a share both uploaded and still on the phone is listed once and counted once', listed9 === 1 && withEntry === withoutEntry && withEntry > 0,
        JSON.stringify({ withEntry, withoutEntry, listed9 }));

    console.log('\n10. The copy kept on the phone is its account\'s');
    byId('inbox-sheet').classList.add('hidden');
    // Up to date first: section 9 changed the tree behind the phone's back.
    await byId('pullBtn').fire('click');
    await settle();
    offline = /^PUT \/api\/tree$/;
    answers.prompt.push('Kept for alex');
    await byId('newFolderBtn').fire('click');
    await settle();
    offline = null;
    answers.confirm.push(true); // "Sign out anyway?" — the edit stays for alex
    await byId('auth-signout').fire('click');
    await settle();
    const keptOut = await kept();
    check('signing out with an unpushed edit keeps the copy on the phone, as alex\'s', keptOut && keptOut.dirty
        && keptOut.account.username === 'alex' && JSON.stringify(keptOut.roots).includes('Kept for alex'));
    const pulls10 = requests.filter(r => r === 'GET /api/tree').length;
    await coldStart(`${BASE}/`);
    check('the next start, signed out, brings it back for alex without showing it', /Restored unpushed changes .* sign in as alex/.test(byId('status').textContent)
        && /Signed out/.test(byId('content').innerHTML), byId('status').textContent);
    await signIn('sam', 'sam-password-1');
    check('sam cannot sign in over it', /unpushed edit/.test(byId('auth-error').textContent) && /for alex/.test(byId('auth-error').textContent)
        && !localStorageShim.getItem('tp_pwa_token'), byId('auth-error').textContent);
    await signIn('alex', PASSWORD);
    await byId('pushBtn').fire('click');
    await settle();
    // The sign-out above ended the session the test held; a fresh one.
    const A10 = (await api('/api/login', { method: 'POST', body: { username: 'alex', password: PASSWORD } })).json.token;
    check('alex signs in to it, nothing pulled over it, and pushes it', requests.filter(r => r === 'GET /api/tree').length === pulls10
        && Boolean(byTitle((await tree(A10)).roots, 'Kept for alex')), byId('status').textContent);
    const outAt = new Date().toISOString();
    await byId('auth-signout').fire('click');
    await settle();
    const left10 = await kept();
    check('a clean sign-out leaves no copy on the phone', !left10,
        JSON.stringify({ outAt, savedAt: left10 && left10.savedAt, dirty: left10 && left10.dirty, status: byId('status').textContent, confirms: dialogs.confirm.slice(-2) }));
    await signIn('sam', 'sam-password-1');
    const mark10 = created.length;
    await coldStart(`${BASE}/`);
    const samKept = await kept();
    check('so sam\'s next start shows none of alex\'s tree, and keeps only his own',
        !drawnText('Kept for alex', mark10) && !drawnText('Phone folder', mark10)
        && (!samKept || (samKept.account.username === 'sam' && !JSON.stringify(samKept.roots).includes('Kept for alex'))), JSON.stringify(samKept && samKept.account));

    console.log('\n11. Sheets opened over the share sheet');
    const css = fs.readFileSync(path.join(REPO, 'pwa', 'app.css'), 'utf8');
    const zOf = (selector) => {
        const m = css.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{[^}]*?z-index:\\s*(\\d+)'));
        return m ? Number(m[1]) : null;
    };
    const zShare = zOf('.share-sheet');
    const zOver = zOf('body.share-open .sheet:not(.share-sheet)');
    check('Settings, the Inbox and every other sheet open over the share sheet, still under the tab bar',
        zShare !== null && zOver !== null && zOver > zShare && zOver < 40, JSON.stringify({ zShare, zOver }));

    console.log('\n12. Save as note with nobody signed in');
    await byId('auth-signout').fire('click');
    await settle();
    const s13 = await shareFromWorker({ title: '', text: 'A thought with no link in it', url: '' }, null);
    mark = created.length;
    await coldStart(`${BASE}/?share=${s13.sid}`);
    check('signed out, a share with no link offers Save as note', sheetOpen() && drawnText('No link in what you shared', mark));
    mark = created.length;
    await button('Save as note').fire('click');
    await settle();
    check('  which keeps the text, on the phone and on screen, when the note cannot open',
        Boolean(await outbox.get(s13.sid)) && sheetOpen() && drawnText('Not saved as a note yet', mark), lastToast());
    answers.confirm.push(true);
    await button('Discard').fire('click');
    await settle();

    console.log('\n13. Unpushed changes kept for another account');
    // Another window of alex's left his copy on the phone with an edit in it.
    const alexNow = (await api('/api/login', { method: 'POST', body: { username: 'alex', password: PASSWORD } })).json;
    const alexTree = await tree(alexNow.token);
    const idsIn = (nodes, out = []) => { for (const n of nodes || []) { out.push(n.id); idsIn(n.children, out); } return out; };
    const alexRoots = JSON.parse(JSON.stringify(alexTree.roots));
    alexRoots.find(r => r.role === 'bookmarks').children.push({ id: 'aaaaaaaaaaaaaa14', kind: 'folder', title: 'Alex unpushed elsewhere', children: [] });
    await (await cachesShim.open('tp-data')).put('/__tp_tree', new Response(JSON.stringify({
        v: 1, savedAt: new Date().toISOString(), account: accountOf(alexNow), roots: alexRoots, version: alexTree.version,
        dirty: true, editCount: 1, importIds: [], serverIds: idsIn(alexTree.roots), nv: null, keptDraft: null, pathIds: []
    }), { headers: { 'Content-Type': 'application/json' } }));
    await signInStorage('sam', 'sam-password-1');
    const toasts14 = document.body.children.length;
    await coldStart(`${BASE}/`);
    check('sam\'s start says the phone keeps alex\'s unpushed changes', document.body.children.slice(toasts14)
        .some(c => c.id === 'tp-toast' && /keeps unpushed changes for alex/.test(c.textContent)));
    await byId('auth-signout').fire('click');
    await settle();
    const kept14 = await kept();
    check('  sam\'s clean sign-out leaves them on the phone', kept14 && kept14.dirty && kept14.account.username === 'alex'
        && JSON.stringify(kept14.roots).includes('Alex unpushed elsewhere'), JSON.stringify(kept14 && kept14.account));
    await signIn('alex', PASSWORD);
    check('  and alex signing in has them back, saying so', /Restored unpushed changes/.test(byId('status').textContent), byId('status').textContent);
    await byId('pushBtn').fire('click');
    await settle();
    const alexAfter = await tree((await api('/api/login', { method: 'POST', body: { username: 'alex', password: PASSWORD } })).json.token);
    check('  to push them', Boolean(byTitle(alexAfter.roots, 'Alex unpushed elsewhere')), byId('status').textContent);

    console.log('\n14. Number keys follow the chips as drawn');
    const s11 = await shareFromWorker({ text: 'https://github.com/someone/project' }, accountOf(alexNow));
    mark = created.length;
    await coldStart(`${BASE}/?share=${s11.sid}`);
    const first11 = chipsDrawn(mark)[0];
    check('a first GitHub link: the starter is drawn first, numbered 1', first11 && /share-chip-new/.test(first11.className) && first11.dataset.n === '1',
        JSON.stringify(chipsDrawn(mark).map(c => [c.className, c.dataset.n])));
    const key1 = { key: '1', target: document.body, preventDefault() {}, stopImmediatePropagation() {} };
    for (const fn of documentListeners.keydown || []) fn(key1);
    await settle();
    const keysTree = await tree((await api('/api/login', { method: 'POST', body: { username: 'alex', password: PASSWORD } })).json.token);
    const gh = byTitle(keysTree.roots, 'GitHub');
    check('  and 1 makes the GitHub folder with the link in it', gh && gh.children.some(c => c.url === 'https://github.com/someone/project'),
        JSON.stringify(keysTree.roots).slice(0, 400));
    await button('Done').fire('click');
    await settle();

    console.log('\n15. A filing answered after another account signed in');
    const s15 = Share.makeEntry({ fields: { text: 'https://example.com/alex-filed-late' }, account: { ...accountOf(alexNow) } });
    await outbox.put({ ...s15, file: Share.makeIntent([{ folderId: 'f-misc', label: 'Misc' }], [], { at: new Date().toISOString() }) });
    holdAnswer = {
        re: /\/file$/,
        fn: async () => {
            await byId('auth-signout').fire('click');
            await settle();
            await signIn('sam', 'sam-password-1');
        }
    };
    fireWindow('online');
    await settle();
    await settle();
    const samKept15 = await kept();
    const alexFiled = await tree((await api('/api/login', { method: 'POST', body: { username: 'alex', password: PASSWORD } })).json.token);
    check('alex\'s filing went into alex\'s tree, and none of it into sam\'s copy',
        !holdAnswer && byTitle(alexFiled.roots, 'Misc').children.some(c => c.url === 'https://example.com/alex-filed-late')
        && localStorageShim.getItem('tp_pwa_user') === 'sam' && samKept15 && samKept15.account.username === 'sam'
        && !JSON.stringify(samKept15.roots).includes('alex-filed-late'),
        JSON.stringify({ held: Boolean(holdAnswer), who: localStorageShim.getItem('tp_pwa_user'), kept: samKept15 && samKept15.account }));
} catch (e) {
    failures++;
    console.error('FAIL  run stopped:', e, '\n' + serverLog.slice(-2000));
} finally {
    server.kill();
    await serverExited;
    try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) { /* temp */ }
}

function textOf(el) {
    return [el.textContent || '', ...(el.children || []).map(textOf)].join(' ');
}

console.log(failures === 0 ? '\nAll share-sheet tests passed.\n' : `\n${failures} test(s) failed.\n`);
process.exitCode = failures === 0 ? 0 : 1;
