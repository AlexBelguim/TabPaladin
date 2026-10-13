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
//      second folder; Undo takes both back; Done closes the sheet.
//   3. A link filed elsewhere meanwhile is folded into a push instead of a
//      conflict prompt; the phone's own edits go up with it.
//   4. Offline, a tap is queued with the share (the amber line), and coming
//      back online files it.
//   5. A folder made on the phone and never pushed can be filed into: it goes
//      up with its own id, and the next push matches it rather than
//      duplicating it.
//   6. The copy and a half-written note are kept when the app goes to the
//      background: a share that reloads the window brings them back, says so,
//      and does not pull over unpushed edits.
//   7. A share captured as another account is shown, never filed or sent
//      without a yes; nobody's folders are offered for it.
//   8. Pins saved from the sheet come first next time, and reach the
//      server's prefs.
//   9. The Inbox lists what waits, the same link shared twice as one row,
//      and a share a forced push erased with its note.
//  10. The copy kept on the phone is its account's: kept over a sign-out with
//      unpushed edits (and brought back for that account only, nobody else
//      signing in over it), gone with a clean sign-out, never shown to the
//      next account.
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
globalThis.fetch = async (url, opts = {}) => {
    const line = `${(opts.method || 'GET').toUpperCase()} ${String(url).replace(BASE, '')}`;
    requests.push(line);
    if (offline && offline.test(line)) throw new TypeError('Failed to fetch');
    inFlight++;
    try { return await realFetch(url, opts); } finally { inFlight--; lastActivity = Date.now(); }
};
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
    offline = null;
    fireWindow('online');
    await settle();
    check('back online, it is filed and leaves the phone', JSON.stringify((await tree(A)).roots).includes('offline-read') && !(await outbox.get(s4.sid))
        && (await api(`/api/shares/${s4.sid}`, { token: A })).json.share.status === 'filed');
    await button('Done').fire('click');
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

    console.log('\n8. Pins');
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
