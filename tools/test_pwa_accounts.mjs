// The PWA against a real server, through a minimal DOM: what happens to the
// phone's working copy, queued shares and per-account lists when people sign
// in and out.
//
// What this locks down:
//   1. A share made while signed out is kept on the phone (the outbox), not
//      lost, and the share sheet opens on it; after sign-in it goes to that
//      account only once the account says yes — in the sheet, or asked at
//      sign-in for one an earlier build queued.
//   2. Unpushed edits survive a revoked session: signing in as someone else
//      sets them aside on the phone (nothing of theirs is pulled over the
//      edits, none of the edits goes into theirs), signing back in as the
//      same account brings them back without a pull, and Push then keeps the
//      edits. (The working copy is the shared core's: TreeStore's set-aside
//      copies stand where an earlier build refused the sign-in.)
//   3. A clean copy switches accounts cleanly, and the per-device lists from
//      before accounts are adopted by the server's owner only.
//   4. Admins see the Users block; plain users do not.
//   5. A share the server refuses while you are signed in (a full inbox) is
//      kept on the phone, the share sheet says why, and it goes up once there
//      is room.
//   6. Signing out with unpushed edits asks first and keeps them: anyone else
//      signing in sets them aside, never over them (and at another address
//      the same id is not taken on trust), the same account gets them back
//      without a pull, and nothing (a bookmarks file import) adds to them
//      meanwhile. Closing the app while they are kept asks first.
//   7. Nothing of the notes screen crosses accounts. An unsaved note counts
//      as unpushed work: signing out asks, it is parked on the phone for its
//      account and reopens only for it, and whoever else signs in, even after
//      an expired session, never sees it. A clean sign-out or account switch
//      closes any open note, the import review and the server's lists, so the
//      next account can neither see the last one's text nor save it into its
//      own tree. Opening a new notebook or note and cancelling leaves nothing
//      to push. The sign-out unwinds the notes screen's history entries
//      without wiping the status that says what it kept. A 409 asks to pull
//      the server's tree or, after a second yes, to force.
//   8. An LLM proposal (a note or an order) is never approved over unpushed
//      edits or a note open in the editor, since the approval's pull would
//      replace them: the app says to push (or save) first, offers ⬆️ Push,
//      and the proposal keeps waiting. With the copy clean it approves and
//      pulls as before. The bottom bar counts each on its own tab: proposals
//      on Notes, unpushed edits on Home (index.html's bar, in its order).
//   9. An import link is kept on the phone the moment it arrives, never in
//      the URL or a history entry, until it is imported or dismissed: tapped
//      while signed out (with Notes opened before the sign-in), on a start
//      that cannot pull, after a session expired and someone else signs in,
//      while another note is being written, or two at once. One tapped (or
//      opened) while an account is signed in waits for that account through
//      a sign-out, not for whoever signs in next.
//  10. Nothing writes into a copy while nobody is signed in: neither after a
//      session expired (a copied link in the Inbox, a task, rename, delete,
//      move, paste, a workflow) nor over edits kept by a sign-out (the
//      clipboard scan and the Inbox).
//  11. Back and forward never reopen another account's notes: the entries an
//      account change leaves in the stack read as Home.
//  12. A link that opens the app is nobody's until the server has confirmed
//      the session it found, and an account's key is the same before and
//      after the server says its id: from a session older than ids it opens
//      for that account, on that start or a later one; with a session that
//      expired while the app was closed it goes to whoever signs in next.
//  13. A link is kept on the phone until the push that carries what it
//      imported succeeds: through a failed push and the app being closed, out
//      of the waiting block and not opened twice meanwhile, and back for
//      review when a pull throws the copy holding it away.
//  14. A note open in the editor, changed or not, holds back an approval: a
//      clean editor would otherwise save its old text over the approved one.
//      One opened while the approval is on its way holds back its pull.
//  15. Bookmark changes an AI chat suggested wait on Home with the server's
//      preview, where they came from and why; approving one follows the same
//      push-first rule and pulls; one gone out of date can only be rejected;
//      a delete is flagged and asked about; a #changes= review link is filed
//      as a suggestion only after a yes, and applies nothing. Approve asks
//      the server again first and applies only what was drawn: a delete whose
//      folder another device filled since is shown out of date, one whose
//      lines read otherwise is redrawn, and the approval names the preview it
//      approved; a push, and coming back to the app, redraw what changed.
//
// Run: node tools/test_pwa_accounts.mjs [--port 18982]
//
// Starts this checkout's server on the port with a throwaway data directory.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
// Every start of the app is a page of its own: modules of its own.
import { closePage } from './fresh_page.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const arg = (name, fallback = null) => {
    const i = process.argv.indexOf('--' + name);
    return i === -1 ? fallback : process.argv[i + 1];
};
const PORT = Number(arg('port') || 18982);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'correct horse battery';

let failures = 0;
function check(name, cond, detail) {
    if (cond) console.log(`  ok  ${name}`);
    else { failures++; console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// --- A permissive DOM -------------------------------------------------------
//
// Just enough for app.js to run its sign-in, sync and settings paths. Elements
// accept anything; rendering is not what is under test here, beyond what got
// drawn: every element is kept, so a check can look for text it must not show.
// querySelector hands back the same element per selector, so a listener the
// app wires onto one (an Approve button) can be fired.

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
        id, tagName: tag.toUpperCase(), style: { setProperty() {}, removeProperty() {}, getPropertyValue() { return ''; } }, dataset: {}, children: [], value: '', textContent: '', innerHTML: '',
        checked: false, disabled: false, title: '', href: '', open: false, offsetHeight: 0, scrollTop: 0, className: '',
        classList: classList(),
        addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
        removeEventListener() {},
        async fire(ev, extra = {}) {
            const event = { preventDefault() {}, stopPropagation() {}, target: el, key: '', ...extra };
            await Promise.all((listeners[ev] || []).map(fn => fn(event)));
        },
        appendChild(c) { el.children.push(c); return c; },
        insertBefore(c) { return c; },
        append() {}, prepend() {}, remove() {}, replaceWith() {}, replaceChildren() {}, insertAdjacentHTML() {},
        // Rendering code wires listeners onto what it just rendered; hand it
        // something to wire onto.
        _qs: {},
        querySelector(sel) { return el._qs[sel] || (el._qs[sel] = makeElement()); },
        querySelectorAll() { return []; },
        closest() { return makeElement(); },
        setAttribute() {}, getAttribute() { return null; }, removeAttribute() {}, hasAttribute() { return false; },
        scrollIntoView() {}, focus() {}, select() {}, blur() {}, click() { return el.fire('click'); },
        matches() { return false; }, toggleAttribute() { return false; }, cloneNode() { return makeElement(); }, after() {}, before() {},
        setSelectionRange() {}, scrollTo() {},
        contains() { return false; },
        getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
    };
    created.push(el);
    return el;
}

// Whether anything drawn since `mark` carries this text.
const drawnSince = (mark, text) => created.slice(mark)
    .some(e => [e.value, e.textContent, e.innerHTML].some(s => typeof s === 'string' && s.includes(text)));
// The note editor's text as last drawn.
const lastEditorText = () => [...created].reverse().find(e => e.tagName === 'TEXTAREA')?.value ?? null;

// The bottom tab bar as index.html draws it, so that the app's selectors find
// what a browser's would, in document order: Home's badge (the count of
// unpushed edits) comes before Notes' (proposals waiting for approval), and
// both are .bn-badge.
function makeBottomNav() {
    const html = fs.readFileSync(path.join(REPO, 'pwa', 'index.html'), 'utf8');
    const markup = (html.match(/<nav id="bottom-nav">([\s\S]*?)<\/nav>/) || [])[1] || '';
    const nav = makeElement('bottom-nav', 'nav');
    const buttons = [];
    const spans = [];
    for (const m of markup.matchAll(/<button\b[^>]*data-nav="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g)) {
        const b = makeElement(null, 'button');
        b.dataset.nav = m[1];
        buttons.push(b);
        for (const s of m[2].matchAll(/<span class="([^"]*)"/g)) {
            const classes = s[1].split(/\s+/).filter(Boolean);
            const el = makeElement(null, 'span');
            el.className = s[1];
            el.classList.add(...classes);
            spans.push({ nav: m[1], el, classes });
        }
    }
    // '.a.b' or 'button[data-nav=x] .a', as the app asks.
    const matching = (sel) => {
        const m = String(sel).trim().match(/^(?:button\[data-nav=["']?([\w-]+)["']?\]\s+)?((?:\.[\w-]+)+)$/);
        if (!m) throw new Error(`the bottom bar's stand-in does not know the selector ${sel}`);
        const want = m[2].split('.').filter(Boolean);
        return spans.filter(s => (!m[1] || s.nav === m[1]) && want.every(c => s.classes.includes(c))).map(s => s.el);
    };
    nav.querySelector = (sel) => matching(sel)[0] || null;
    nav.querySelectorAll = (sel) => (/^button\[data-nav\]$/.test(String(sel).trim()) ? buttons : matching(sel));
    return nav;
}

const elements = new Map();
const byId = (id) => {
    if (!elements.has(id)) {
        const el = id === 'bottom-nav' ? makeBottomNav() : makeElement(id);
        // Sheets and blocks start hidden, as in index.html.
        if (/sheet$|^users-block$|^auth-discard$|^menu$/.test(id)) el.classList.add('hidden');
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
// The document's own listeners: a tap anywhere is the app's cue to scan the
// clipboard for unfiled links.
const documentListeners = {};
const fireDocument = (ev, e = {}) => { for (const fn of documentListeners[ev] || []) fn(e); return e; };
const dialogs = { confirm: [], prompt: [], alert: [] };
const answers = { confirm: [], prompt: [] };

// A browser's session history: entries with a state and a URL, where go()
// lands a moment later and fires popstate. A sign-out that unwinds the notes
// screen's entries runs the same popstate here as on a phone.
const H = { entries: [{ state: null, url: BASE + '/?share=1&url=' + encodeURIComponent('https://example.com/shared-while-out') + '&title=Shared' }], index: 0 };
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
    replaceState(s, t, url) {
        H.entries[H.index] = { state: s == null ? null : structuredClone(s), url: new URL(url ?? entry().url, entry().url).href };
    },
    back() { historyShim.go(-1); },
    go(n) {
        const to = H.index + n;
        if (!n || to < 0 || to >= H.entries.length) return;
        H.index = to;
        const st = entry().state;
        setTimeout(() => fireWindow('popstate', { state: st }), 0);
    }
};
// The app (re)opened at this URL, in the entry it is on.
const openAt = (url, state = null) => { H.entries[H.index] = { state, url }; };

Object.assign(globalThis, {
    window: globalThis,
    document: {
        getElementById: byId,
        createElement: (tag) => makeElement(null, tag),
        // Kept with the elements, so a check for text that must not be drawn
        // also sees what a renderer put in as a text node (the note preview).
        createTextNode: (t) => { const n = { nodeType: 3, textContent: String(t) }; created.push(n); return n; },
        body: makeElement('body'),
        documentElement: makeElement('html'),
        addEventListener(ev, fn) { (documentListeners[ev] = documentListeners[ev] || []).push(fn); },
        querySelector: () => null,
        querySelectorAll: () => []
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
    confirm: (msg) => { dialogs.confirm.push(msg); return answers.confirm.length ? answers.confirm.shift() : false; },
    prompt: (msg) => { dialogs.prompt.push(msg); return answers.prompt.length ? answers.prompt.shift() : null; },
    alert: (msg) => { dialogs.alert.push(msg); },
    scrollTo() {},
    innerHeight: 800,
    open() {}
});
globalThis.addEventListener = (ev, fn) => { (windowListeners[ev] = windowListeners[ev] || []).push(fn); };
// The notes screen watches sheets to sync the bottom bar, which does not
// matter to the account flows tested here.
globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((fn) => setTimeout(fn, 0));
globalThis.cancelAnimationFrame = globalThis.cancelAnimationFrame || ((id) => clearTimeout(id));
globalThis.innerWidth = 375;
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: null }, configurable: true });
// The share core, as index.html loads it: a classic script before app.js.
new Function('self', fs.readFileSync(path.join(REPO, 'pwa', 'shareCore.js'), 'utf8'))(globalThis);

// Every request the app makes, so the test can tell a pull from no pull. One
// can be made to fail as if the phone were offline.
const requests = [];
// Each request's body, at the same index as its line in `requests`.
const requestBodies = [];
const realFetch = globalThis.fetch;
let inFlight = 0;
let lastActivity = Date.now();
let failNext = null; // e.g. 'PUT /api/tree'
// One request held on its way until the test lets it go: { match, until }.
let holdNext = null;
globalThis.fetch = async (url, opts = {}) => {
    const line = `${(opts.method || 'GET').toUpperCase()} ${String(url).replace(BASE, '')}`;
    requests.push(line);
    requestBodies.push(typeof opts.body === 'string' ? opts.body : null);
    if (failNext && line.startsWith(failNext)) {
        failNext = null;
        throw new TypeError('Failed to fetch');
    }
    // Not counted as in flight until let go, so the test can settle meanwhile.
    if (holdNext && line.startsWith(holdNext.match)) {
        const { until } = holdNext;
        holdNext = null;
        await until;
    }
    inFlight++;
    try { return await realFetch(url, opts); } finally { inFlight--; lastActivity = Date.now(); }
};
async function settle() {
    // The app fires some of its work without awaiting it (bootstrap after a
    // sign-in); wait until the network has been quiet for a moment.
    for (let i = 0; i < 100; i++) {
        await new Promise(r => setTimeout(r, 50));
        if (inFlight === 0 && Date.now() - lastActivity > 250) return;
    }
}

// --- The server -----------------------------------------------------------------

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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-pwa-accounts-'));
const env = { ...process.env };
for (const k of Object.keys(env)) if (/^(AUTH_TOKEN|ADMIN_|TENANCY_OWNER|IMPORT_|MAX_)/.test(k)) delete env[k];
const server = spawn(process.execPath, [path.join(REPO, 'server', 'index.js')], {
    env: {
        ...env, PORT: String(PORT), DATA_DIR: dataDir, PWA_DIR: path.join(REPO, 'pwa'), ADMIN_USERNAME: 'alex', ADMIN_PASSWORD: PASSWORD,
        IMPORTS_SCHEDULER: 'off', MAX_INBOX_PER_USER: '2'
    },
    stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', d => { serverLog += d; });
server.stderr.on('data', d => { serverLog += d; });
const serverExited = new Promise(r => server.on('exit', r));

async function signIn(username, password, url = BASE) {
    byId('cfg-url').value = url;
    byId('cfg-username').value = username;
    byId('cfg-password').value = password;
    byId('auth-error').textContent = '';
    await byId('auth-submit').fire('click');
    await settle();
}

const treeTitles = async (token) => JSON.stringify((await api('/api/tree', { token })).json.roots);

// The share outbox as kept on the phone (localStorage: no Cache Storage
// here), the share sheet, and what it and the Inbox drew.
const outboxEntries = () => Object.values(JSON.parse(localStorageShim.getItem('tp_outbox') || '{}'));
const sheetOpen = () => !byId('share-sheet').classList.contains('hidden');
const lastButton = (text) => [...created].reverse().find(e => e.tagName === 'BUTTON' && e.textContent === text);
const textOf = (el) => [el.textContent || '', ...(el.children || []).map(textOf)].join(' ');
const inboxRowWith = (text) => [...byId('inbox-list').children].reverse().find(r => r.className === 'inbox-row' && textOf(r).includes(text));
const inboxPaste = () => [...byId('inbox-list').children].reverse().find(r => r.className === 'inbox-paste')?.children[0];
const waitingLinks = async (token) => (await api('/api/shared', { token })).json.links.map(l => l.url);

// A tap on something the notes screen drew, by its data-nv action.
async function clickNv(nv, id = null) {
    const t = { dataset: { nv, ...(id ? { id } : {}) }, closest: (sel) => (sel === '[data-nv]' ? t : null) };
    await byId('content').fire('click', { target: t });
    await settle();
}
// Typing into the open note's editor.
async function typeNote(text) {
    await byId('content').fire('input', { target: { id: 'note-body-input', value: text, style: {}, scrollHeight: 0 } });
}
const bodyHas = (c) => document.body.classList.contains(c);
// The bottom bar's badges: Notes' (proposals waiting), Home's (unpushed edits).
const badgeShown = () => !byId('bottom-nav').querySelector('button[data-nav=notes] .bn-badge').classList.contains('hidden');
const syncBadge = () => byId('bottom-nav').querySelector('.sync-badge');
const syncBadgeShown = () => !syncBadge().classList.contains('hidden');
const lastToast = () => [...document.body.children].reverse().find(c => c.id === 'tp-toast')?.textContent || '';
// Every toast shown since a mark (a count of document.body's toasts).
const toastCount = () => document.body.children.filter(c => c.id === 'tp-toast').length;
const toastsSince = (mark) => document.body.children.filter(c => c.id === 'tp-toast').slice(mark).map(c => c.textContent);
// Unpushed edits on the phone, as the ⬆️ button shows them.
const dirtyShown = () => byId('pushBtn').classList.contains('dirty');
// Whether closing or reloading the app now would ask first.
const unloadAsks = () => fireWindow('beforeunload', { prevented: false, preventDefault() { this.prevented = true; } }).prevented;
// A link tapped while the app is open: the browser adds an entry for it,
// lands on it and fires hashchange.
async function tapLink(hash) {
    historyShim.pushState(null, '', '/' + hash);
    fireWindow('popstate', { state: null });
    fireWindow('hashchange');
    await settle();
}
// Every note of a tree from the server: { parent (its folder's title), title, content }.
function notesOf(roots) {
    const out = [];
    const walk = (list, parent) => list.forEach(n => {
        if (n.kind === 'note') out.push({ parent, title: n.title, content: n.payload && n.payload.content });
        else walk(n.children || [], n.title);
    });
    walk(roots, null);
    return out;
}

async function propose(token, body) {
    const share = (await api('/api/share', { method: 'POST', token })).json;
    const res = await api(new URL(share.url).pathname + '/propose', { method: 'POST', body });
    if (res.status !== 200) throw new Error('could not propose: ' + JSON.stringify(res.json));
}
// A proposal as last drawn in Notes, by its title.
const findProposal = (title) => [...created].reverse()
    .find(e => e.className === 'proposal' && e.innerHTML.includes(`class="title">${title}`));
const approvals = () => requests.filter(r => /^POST \/api\/proposals\/\d+\/approve$/.test(r)).length;
const pulls = () => requests.filter(r => r === 'GET /api/tree').length;
// Import links kept on the phone, and one as last drawn in Notes' waiting block.
const pendingLinks = () => JSON.parse(localStorageShim.getItem('tp_pending_import') || '[]');
const pendingHolds = (text) => pendingLinks().some(p => decodeURIComponent(p.hash).includes(text));
const waitingRow = (title) => [...created].reverse()
    .find(e => e.className === 'proposal pending-import' && e.innerHTML.includes(title));
const noteLink = (title, body) => '#note=' + encodeURIComponent(`# ${title}\n\n${body}`);
// The note editor's text as drawn since a mark (a count of `created`).
const editorSince = (mark) => [...created.slice(mark)].reverse().find(e => e.tagName === 'TEXTAREA')?.value ?? null;
// The working copies set aside on the phone, as the page keeps them (in its
// platform: this browser has neither IndexedDB nor Cache Storage, so in
// memory, as the copy itself), and the notes parked on the phone.
const setAside = async () => {
    const p = globalThis.__tpPlatform;
    const index = (await p.getRaw(['tpTreeStashIndex'])).tpTreeStashIndex || [];
    const got = index.length ? await p.getRaw(index) : {};
    return index.map(k => got[k]).filter(Boolean);
};
const parkedNotes = () => JSON.parse(localStorageShim.getItem('tp_notes_parked_v1') || '[]');

// The app started afresh at a URL, as after the phone's OS closed it: a new
// page with nothing in memory, only what the phone kept in localStorage. The
// last page is gone with its listeners, and its elements are no longer the
// document's.
let starts = 0;
async function coldStart(url) {
    // The page before is gone: it hears, reads and writes nothing more.
    closePage();
    elements.clear();
    for (const k of Object.keys(windowListeners)) delete windowListeners[k];
    for (const k of Object.keys(documentListeners)) delete documentListeners[k];
    H.entries = [{ state: null, url }];
    H.index = 0;
    await import(pathToFileURL(path.join(REPO, 'pwa', 'app.js')).href + '?start=' + (++starts));
    for (const fn of windowListeners.DOMContentLoaded || []) await fn();
    await settle();
}

try {
    for (let i = 0; i < 100; i++) {
        try { if ((await realFetch(BASE + '/api/health')).ok) break; } catch (e) { /* not yet */ }
        await new Promise(r => setTimeout(r, 100));
    }
    const alexAdmin = (await api('/api/login', { method: 'POST', body: { username: 'alex', password: PASSWORD } })).json.token;
    const madeSam = await api('/api/users', { method: 'POST', token: alexAdmin, body: { username: 'sam', password: 'sam-password-1', role: 'user', currentPassword: PASSWORD } });
    if (madeSam.status !== 200) throw new Error('could not create sam: ' + JSON.stringify(madeSam.json));
    const madeKim = await api('/api/users', { method: 'POST', token: alexAdmin, body: { username: 'kim', password: 'kim-password-1', role: 'user', currentPassword: PASSWORD } });
    if (madeKim.status !== 200) throw new Error('could not create kim: ' + JSON.stringify(madeKim.json));

    // The per-device lists from before accounts, and a share an earlier build
    // queued on the phone while nobody was signed in.
    localStorageShim.setItem('tp_dismissed_urls', JSON.stringify(['https://legacy-dismissed.example']));
    const OLD_QUEUED = 'https://example.com/queued-by-an-earlier-build';
    localStorageShim.setItem('tp_pending_shares', JSON.stringify([{ url: OLD_QUEUED, title: 'Old queue', at: '2026-10-01T10:00:00.000Z', userId: null }]));

    await import(pathToFileURL(path.join(REPO, 'pwa', 'app.js')).href);
    for (const fn of windowListeners.DOMContentLoaded || []) await fn();
    await settle();

    console.log('\n1. A share made while signed out');
    const SHARED = 'https://example.com/shared-while-out';
    const kept1 = outboxEntries();
    check('is kept on the phone, as nobody\'s, and the URL is cleaned afterwards',
        kept1.some(e => e.url === SHARED && e.account === null && e.title === 'Shared') && currentUrl().search === '', JSON.stringify(kept1));
    check('a share an earlier build queued is moved into the outbox, the old queue gone',
        !localStorageShim.getItem('tp_pending_shares') && kept1.some(e => e.url === OLD_QUEUED && e.account === null));
    check('the share sheet opens on it, saying to sign in', sheetOpen() && created.some(e => e.textContent === 'Kept on this phone: sign in to file it.'));

    answers.confirm.push(true); // "add it to alex's inbox?" — the earlier build's share
    await signIn('alex', PASSWORD);
    const asked1 = dialogs.confirm.filter(m => /shared while signed out/.test(m));
    check('after alex signs in he is asked about the queued one', asked1.length === 1 && /alex/.test(asked1[0]) && /^1 link was/.test(asked1[0]),
        dialogs.confirm.join(' | '));
    check('  and it lands in his inbox', (await waitingLinks(alexAdmin)).includes(OLD_QUEUED));
    check('the open sheet asks for its own share instead, and nothing of it was sent', sheetOpen() && Boolean(lastButton('Upload to alex'))
        && !(await waitingLinks(alexAdmin)).includes(SHARED));
    await lastButton('Upload to alex').fire('click');
    await settle();
    check('Upload to alex sends it to his inbox', (await waitingLinks(alexAdmin)).includes(SHARED));
    await lastButton('Later').fire('click');
    await settle();
    check('Later closes the sheet; the share waits in his inbox and is off the phone', !sheetOpen()
        && (await waitingLinks(alexAdmin)).includes(SHARED) && !outboxEntries().some(e => e.url === SHARED || e.url === OLD_QUEUED),
        JSON.stringify(outboxEntries()));
    check('the session knows who it is', localStorageShim.getItem('tp_pwa_userid') === '1' && localStorageShim.getItem('tp_pwa_owner') === '1');
    check('the owner adopts the per-device dismissed list',
        localStorageShim.getItem('tp_dismissed_urls:1') !== null && localStorageShim.getItem('tp_dismissed_urls') === null);

    console.log('\n2. Unpushed edits survive a revoked session');
    answers.prompt.push('Phone folder');
    await byId('newFolderBtn').fire('click');
    await settle();
    check('an edit pushes as alex', (await treeTitles(alexAdmin)).includes('Phone folder'));
    // Alex changes his password on another device: every session, the
    // phone's included, is revoked.
    const changed = await api('/api/auth/password', { method: 'POST', token: alexAdmin, body: { currentPassword: PASSWORD, newPassword: 'new horse battery' } });
    const alexNew = changed.json.token;
    answers.prompt.push('Offline edit');
    await byId('newFolderBtn').fire('click');
    await settle();
    check('the next push meets a 401 and the token is dropped', !localStorageShim.getItem('tp_pwa_token')
        && dialogs.alert.some(m => /Signed out/.test(m)), dialogs.alert.join(' | '));
    check('the edit is not on the server', !(await treeTitles(alexNew)).includes('Offline edit'));

    const mark2 = created.length;
    const toasts2 = toastCount();
    await signIn('sam', 'sam-password-1');
    const samFirst = (await api('/api/login', { method: 'POST', body: { username: 'sam', password: 'sam-password-1' } })).json.token;
    const aside2 = (await setAside()).find(s => s.owner && s.owner.username === 'alex');
    check('signing in as sam sets alex\'s unpushed edits aside on the phone, never over them',
        localStorageShim.getItem('tp_pwa_userid') === '2' && aside2 && aside2.dirty && JSON.stringify(aside2.roots).includes('Offline edit'),
        JSON.stringify(aside2 && aside2.owner));
    check('  and says so', toastsSince(toasts2).some(t => /keeps unpushed changes for alex/.test(t)), toastsSince(toasts2).join(' | '));
    check('  nothing of them is drawn for sam, or goes into his tree', !drawnSince(mark2, 'Offline edit')
        && !(await treeTitles(samFirst)).includes('Offline edit') && !(await treeTitles(samFirst)).includes('Phone folder'));
    const pullsBefore = requests.filter(r => r === 'GET /api/tree').length;

    await signIn('alex', 'new horse battery');
    check('signing back in as alex brings them back, and does not pull over the edits', requests.filter(r => r === 'GET /api/tree').length === pullsBefore
        && dirtyShown());
    check('and says what to do', /Restored unpushed changes.*Push to keep them/.test(byId('status').textContent), byId('status').textContent);
    await byId('pushBtn').fire('click');
    await settle();
    check('Push then keeps them', (await treeTitles(alexNew)).includes('Offline edit'));

    console.log('\n3. A clean copy switches accounts');
    localStorageShim.setItem('tp_dismissed_urls', JSON.stringify(['https://someone-elses.example']));
    await signIn('sam', 'sam-password-1');
    check('sam signs in and pulls his own (empty) tree', localStorageShim.getItem('tp_pwa_userid') === '2'
        && requests.filter(r => r === 'GET /api/tree').length === pullsBefore + 1);
    check('sam does not adopt a per-device list', localStorageShim.getItem('tp_dismissed_urls:2') === null
        && localStorageShim.getItem('tp_dismissed_urls') !== null);
    answers.prompt.push('Sam folder');
    await byId('newFolderBtn').fire('click');
    await settle();
    const samToken = (await api('/api/login', { method: 'POST', body: { username: 'sam', password: 'sam-password-1' } })).json.token;
    check('sam\'s edit lands in sam\'s tree only', (await treeTitles(samToken)).includes('Sam folder')
        && !(await treeTitles(alexNew)).includes('Sam folder') && !(await treeTitles(samToken)).includes('Phone folder'));

    console.log('\n4. The Users block');
    await byId('settingsBtn').fire('click');
    await settle();
    check('a plain user does not see it', byId('users-block').classList.contains('hidden'));
    await signIn('alex', 'new horse battery');
    await byId('settingsBtn').fire('click');
    await settle();
    check('an admin does', !byId('users-block').classList.contains('hidden') && /sam/.test(byId('users-list').innerHTML)
        && /pill owner/.test(byId('users-list').innerHTML), byId('users-list').innerHTML.slice(0, 200));
    check('labelled as admin and owner', byId('auth-role-label').textContent === ' (admin, owner)', byId('auth-role-label').textContent);

    console.log('\n5. A share the inbox has no room for');
    // alex's inbox holds the links from section 1, which fill it (2).
    await api('/api/shared', { method: 'POST', token: alexNew, body: { url: 'https://example.com/filler' } });
    check('alex\'s inbox is full', (await waitingLinks(alexNew)).length === 2);
    const ARTICLE = 'https://blog.example/an-article-i-want-to-keep';
    openAt(BASE + '/?share=1&url=' + encodeURIComponent(ARTICLE) + '&title=Article');
    const mark5 = created.length;
    await signIn('alex', 'new horse battery'); // any start runs the share through
    const keptFull = outboxEntries().find(e => e.url === ARTICLE);
    check('a link the full inbox refuses is kept on the phone, as alex\'s', keptFull && keptFull.account && keptFull.account.userId === 1
        && !keptFull.uploaded && keptFull.lastError && keptFull.lastError.status === 429, JSON.stringify(keptFull));
    check('  and the share sheet says why, in the server\'s words', sheetOpen() && drawnSince(mark5, 'inbox already holds 2 links'),
        created.slice(mark5).map(e => e.textContent).filter(Boolean).join(' | ').slice(0, 400));
    const full = (await api('/api/shared', { token: alexNew })).json.links;
    await api(`/api/shared/${full.find(l => l.url === SHARED).id}`, { method: 'DELETE', token: alexNew });
    await signIn('alex', 'new horse battery');
    check('once there is room, the next start sends it', (await waitingLinks(alexNew)).includes(ARTICLE)
        && outboxEntries().find(e => e.url === ARTICLE)?.uploaded === true);
    await lastButton('Later').fire('click');
    await settle();
    check('  and Later leaves it in the inbox, off the phone', !sheetOpen() && !outboxEntries().some(e => e.url === ARTICLE)
        && (await waitingLinks(alexNew)).includes(ARTICLE));

    console.log('\n6. Signing out with unpushed edits');
    // Another device pushes, so the phone's next push meets a 409 and the
    // edit stays unpushed.
    const before = (await api('/api/tree', { token: alexNew })).json;
    await api('/api/tree', { method: 'PUT', token: alexNew, body: { roots: before.roots, baseVersion: before.version, deviceId: 'laptop' } });
    answers.prompt.push('Unpushed at sign-out');
    answers.confirm.push(false); // "Another device pushed… overwrite?" No.
    await byId('newFolderBtn').fire('click');
    await settle();
    check('an edit the server did not take stays on the phone', !(await treeTitles(alexNew)).includes('Unpushed at sign-out'));
    const asked = dialogs.confirm.length;
    answers.confirm.push(false); // "Sign out anyway?" No.
    await byId('auth-signout').fire('click');
    await settle();
    check('signing out asks first, and Cancel stays signed in',
        /unpushed edit/.test(dialogs.confirm[asked] || '') && Boolean(localStorageShim.getItem('tp_pwa_token')), dialogs.confirm[asked]);
    answers.confirm.push(true);
    await byId('auth-signout').fire('click');
    await settle();
    check('OK signs out and says the edits stay on the phone',
        !localStorageShim.getItem('tp_pwa_token') && /stays? on this phone until alex signs in/.test(byId('status').textContent), byId('status').textContent);
    check('  and closing the app now asks first', unloadAsks());
    // Settings stays open over the sign-out; a bookmarks file imported from
    // it must not land in the copy kept for alex, to go up with his push.
    const BOOKMARKS_FILE = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<DL><p>\n<DT><H3>Stranger</H3>\n<DL><p>\n'
        + '<DT><A HREF="https://stranger.example/">Stranger link</A>\n</DL><p>\n</DL><p>\n';
    const askedImport = dialogs.confirm.length;
    answers.confirm.push(true); // "Import 1 item(s)…?", were it asked
    await byId('bm-import-file').fire('change', { target: { files: [{ text: async () => BOOKMARKS_FILE }], value: 'bookmarks.html' } });
    await settle();
    const importAsked = dialogs.confirm.length > askedImport;
    if (!importAsked) answers.confirm.pop();
    check('a bookmarks file imported while signed out is refused, not added to the kept copy',
        !importAsked && /Sign in first/.test(lastToast()), lastToast());
    const pullsAtSignOut = requests.filter(r => r === 'GET /api/tree').length;
    const keptAt6 = async () => (await setAside()).find(s => s.owner && s.owner.username === 'alex' && s.owner.url === BASE && s.dirty
        && JSON.stringify(s.roots).includes('Unpushed at sign-out'));
    const mark6 = created.length;
    await signIn('sam', 'sam-password-1');
    check('sam signing in sets alex\'s unpushed edits aside on the phone, never over them, and shows none of them',
        localStorageShim.getItem('tp_pwa_userid') === '2' && Boolean(await keptAt6()) && !drawnSince(mark6, 'Unpushed at sign-out'));
    // The same account id at another address is not taken on trust either.
    await signIn('alex', 'new horse battery', `http://localhost:${PORT}`);
    check('nor is alex #1 at another server address given them on trust: they stay set aside for the address they came from',
        localStorageShim.getItem('tp_pwa_userid') === '1' && localStorageShim.getItem('tp_pwa_url') === `http://localhost:${PORT}`
        && Boolean(await keptAt6()) && !drawnSince(mark6, 'Unpushed at sign-out') && !dirtyShown());
    const pullsBack = requests.filter(r => r === 'GET /api/tree').length;
    await signIn('alex', 'new horse battery');
    check('alex signs back in to his edits, with no pull over them',
        requests.filter(r => r === 'GET /api/tree').length === pullsBack && pullsBack >= pullsAtSignOut && dirtyShown()
        && /Restored unpushed changes/.test(byId('status').textContent), byId('status').textContent);

    console.log('\n7. Notes never cross accounts');
    // The laptop's push from section 6: not pulled over, overwritten.
    answers.confirm.push(false); // "Pull the server's tree now (… discarded)?" No.
    answers.confirm.push(true); // "Force-push this phone's version…?" Yes.
    await byId('pushBtn').fire('click');
    await settle();
    check('alex\'s push carries his edits and nothing imported while he was out',
        (await treeTitles(alexNew)).includes('Unpushed at sign-out') && !(await treeTitles(alexNew)).includes('stranger.example'));
    // alex keeps a diary, and an LLM has a note waiting for his approval.
    const t7 = (await api('/api/tree', { token: alexNew })).json;
    await api('/api/tree', { method: 'PUT', token: alexNew, body: { baseVersion: t7.version, deviceId: 'laptop', roots: [...t7.roots,
        { id: 'alex-notes-root', kind: 'folder', title: 'Notes', role: 'notes', children: [
            { id: 'alex-diary', kind: 'note', title: 'Diary', payload: { content: '# Diary\n\nALEX PRIVATE TEXT' } }
        ] }] } });
    await propose(alexNew, { title: 'From the LLM', content: '# From the LLM\n\nproposed text', notebook: 'LLM inbox' });
    await signIn('alex', 'new horse battery');
    check('alex\'s proposal and inbox show on the phone', badgeShown() && !byId('inbox-fab').classList.contains('hidden'));
    check('  the proposal is counted on the Notes tab, and Home\'s count of unpushed edits stays hidden over a clean copy',
        byId('bottom-nav').querySelector('button[data-nav=notes] .bn-badge').textContent === '1' && !syncBadgeShown() && !dirtyShown(),
        JSON.stringify({ notes: byId('bottom-nav').querySelector('button[data-nav=notes] .bn-badge').textContent, home: syncBadge().textContent, homeShown: syncBadgeShown() }));

    await byId('notesBtn').fire('click');
    await clickNv('open-note', 'alex-diary');
    await clickNv('edit');
    await typeNote('# Diary\n\nALEX PRIVATE TEXT\nhalf-written thought');
    let asked7 = dialogs.confirm.length;
    answers.confirm.push(false); // "Sign out anyway?" No.
    await byId('auth-signout').fire('click');
    await settle();
    check('signing out with an unsaved note asks first, and Cancel stays signed in',
        /an unsaved note for alex/.test(dialogs.confirm[asked7] || '') && Boolean(localStorageShim.getItem('tp_pwa_token')), dialogs.confirm[asked7]);
    answers.confirm.push(true);
    await byId('auth-signout').fire('click');
    await settle();
    check('OK signs out, closes the note and says it is kept',
        !localStorageShim.getItem('tp_pwa_token') && !bodyHas('view-notes') && !bodyHas('nv-editing')
        && /unsaved note stays on this phone until alex signs in/.test(byId('status').textContent), byId('status').textContent);
    check('  back on the Home entry, so back leaves the app', H.index === 0 && !(entry().state && entry().state.tp === 'nv'),
        JSON.stringify({ index: H.index, state: entry().state }));
    const parkedHalf = () => parkedNotes().find(d => /half-written thought/.test(d.content) && d.owner && d.owner.username === 'alex');
    check('  and the note is kept on the phone, parked for alex: closing the app loses nothing', Boolean(parkedHalf()) && !unloadAsks(),
        JSON.stringify(parkedNotes().map(d => d.owner)));
    check('  and nothing of alex\'s is on screen: no copy, proposals or inbox',
        /Signed out|Open Settings/.test(byId('content').innerHTML) && !/ALEX PRIVATE|Diary/.test(byId('content').innerHTML)
        && !badgeShown() && byId('inbox-fab').classList.contains('hidden'), byId('content').innerHTML);
    const mark7a = created.length;
    await signIn('sam', 'sam-password-1');
    check('sam signing in never sees alex\'s unsaved note, which stays parked for alex',
        localStorageShim.getItem('tp_pwa_userid') === '2' && !bodyHas('nv-editing') && !drawnSince(mark7a, 'half-written thought')
        && !drawnSince(mark7a, 'ALEX PRIVATE') && Boolean(parkedHalf()));
    await signIn('alex', 'new horse battery');
    check('alex signs back in to his note, still open with his text',
        bodyHas('nv-editing') && /half-written thought/.test(lastEditorText() || ''), lastEditorText());
    await clickNv('done');
    check('  and ✓ Done saves it to alex\'s tree', (await treeTitles(alexNew)).includes('half-written thought'));
    check('  after which closing the app asks nothing', !unloadAsks());

    // A clean sign-out with the note open in the editor, then sam.
    await clickNv('edit');
    asked7 = dialogs.confirm.length;
    await byId('auth-signout').fire('click');
    await settle();
    check('a clean sign-out asks nothing', dialogs.confirm.length === asked7 && byId('status').textContent === 'Signed out.',
        dialogs.confirm.slice(asked7).join(' | '));
    let mark = created.length;
    await signIn('sam', 'sam-password-1');
    const samNow = (await api('/api/login', { method: 'POST', body: { username: 'sam', password: 'sam-password-1' } })).json.token;
    check('sam signs in to Home, with no note of alex\'s open or drawn',
        localStorageShim.getItem('tp_pwa_userid') === '2' && !bodyHas('view-notes') && !bodyHas('nv-editing')
        && !drawnSince(mark, 'ALEX PRIVATE') && !drawnSince(mark, 'From the LLM'));
    await clickNv('done');
    check('  and nothing of alex\'s can be saved into sam\'s tree', !(await treeTitles(samNow)).includes('ALEX PRIVATE'));

    // kim has never used notes: a notebook prompt or a new note, cancelled.
    await signIn('kim', 'kim-password-1');
    await byId('notesBtn').fire('click');
    await clickNv('new-notebook'); // the name prompt is cancelled
    await clickNv('new-note');
    await clickNv('cancel-edit');
    asked7 = dialogs.confirm.length;
    await byId('auth-signout').fire('click');
    await settle();
    check('opening a notebook prompt or a new note and cancelling leaves nothing to push',
        dialogs.confirm.length === asked7 && byId('status').textContent === 'Signed out.', dialogs.confirm.slice(asked7).join(' | '));

    // alex's session expires in the middle of an edit.
    await signIn('alex', 'new horse battery');
    await byId('notesBtn').fire('click');
    await clickNv('open-note', 'alex-diary');
    await clickNv('edit');
    await typeNote('# Diary\n\nALEX PRIVATE TEXT\nmid-session thought');
    const alex3 = (await api('/api/auth/password', { method: 'POST', token: alexNew, body: { currentPassword: 'new horse battery', newPassword: 'third horse battery' } })).json.token;
    await byId('pullBtn').fire('click');
    await settle();
    check('the session expires under an open edit', !localStorageShim.getItem('tp_pwa_token') && bodyHas('nv-editing'));
    const parkedMid = () => parkedNotes().find(d => /mid-session thought/.test(d.content) && d.owner && d.owner.username === 'alex');
    mark = created.length;
    await signIn('sam', 'sam-password-1');
    check('sam signing in over the note alex was writing parks it for alex: neither discarded nor sam\'s',
        localStorageShim.getItem('tp_pwa_userid') === '2' && Boolean(parkedMid()) && !bodyHas('view-notes') && !bodyHas('nv-editing'),
        JSON.stringify(parkedNotes().map(d => [d.owner && d.owner.username, d.content.slice(-20)])));
    check('then sam is signed in, with nothing of alex\'s drawn', !drawnSince(mark, 'ALEX PRIVATE') && !drawnSince(mark, 'mid-session'));
    await clickNv('done');
    check('  or saved into sam\'s tree', !/ALEX PRIVATE|mid-session/.test(await treeTitles(samNow)));

    // alex's password and session from here on: several sections let his
    // session expire on purpose.
    let alexPw = 'third horse battery';
    let alexTok = alex3;
    const expireAlex = async (newPassword) => {
        alexTok = (await api('/api/auth/password', { method: 'POST', token: alexTok, body: { currentPassword: alexPw, newPassword } })).json.token;
        alexPw = newPassword;
        await byId('pullBtn').fire('click'); // the phone's next request meets the 401
        await settle();
    };
    const serverProposals = async () => ((await api('/api/proposals', { token: alexTok })).json.proposals || []).map(p => p.title);

    console.log('\n8. Approving a proposal waits for a clean copy');
    await propose(alexTok, { action: 'reorder', order: ['From the LLM', 'Diary'] });
    await signIn('alex', alexPw);
    check('(alex signing in has the note he was writing back, in its editor)', bodyHas('nv-editing')
        && /mid-session thought/.test(lastEditorText() || '') && !parkedMid(), lastEditorText());
    // Thrown away on purpose, here: ✕, and yes.
    answers.confirm.push(true); // "Discard unsaved changes?"
    await clickNv('cancel-edit');
    await byId('brand-home').fire('click');
    await settle();
    check('(discarded on purpose, it is gone)', !bodyHas('nv-editing') && !parkedMid()
        && !/mid-session/.test(await treeTitles(alexTok)));
    failNext = 'PUT /api/tree'; // the phone is offline for this push
    answers.prompt.push('Offline folder');
    await byId('newFolderBtn').fire('click');
    await settle();
    check('an edit that could not be pushed stays on the phone, and says so', !(await treeTitles(alexTok)).includes('Offline folder')
        && dirtyShown() && dialogs.alert.some(m => /^Push failed: .*the folder is kept on this phone, use ⬆️ to retry/.test(m)), JSON.stringify(dialogs.alert.slice(-1)));
    check('  Home\'s badge counts it (one unpushed edit), whatever the proposals waiting on the Notes tab',
        syncBadgeShown() && syncBadge().textContent === '1' && badgeShown()
        && byId('bottom-nav').querySelector('button[data-nav=notes] .bn-badge').textContent === '2',
        JSON.stringify({ home: syncBadge().textContent, homeShown: syncBadgeShown(), notes: byId('bottom-nav').querySelector('button[data-nav=notes] .bn-badge').textContent }));
    await byId('notesBtn').fire('click');
    check('alex\'s note and order proposals wait in Notes, under a word to push first, with a ⬆️ Push',
        Boolean(findProposal('From the LLM')) && Boolean(findProposal('🔀 Reorder notes'))
        && created.some(e => e.className === 'proposal proposals-push-hint' && /Push your changes first, then approve/.test(e.innerHTML)
            && /⬆️ Push</.test(e.innerHTML)));
    let asked8 = dialogs.confirm.length;
    const approvals8 = approvals();
    const pulls8 = pulls();
    for (const title of ['From the LLM', '🔀 Reorder notes']) {
        answers.confirm.push(false); // "Push your changes first, then approve." Cancel.
        await findProposal(title).querySelector('.proposal-approve').fire('click');
        await settle();
    }
    const asks8 = dialogs.confirm.slice(asked8);
    check('approving a note or an order over an unpushed edit asks to push first, and Cancel approves nothing',
        asks8.length === 2 && asks8.every(m => /^Push your changes first, then approve\./.test(m) && /1 unpushed edit\b/.test(m) && /OK = ⬆️ Push now/.test(m))
        && approvals() === approvals8 && pulls() === pulls8, asks8.join(' | '));
    const waiting8 = await serverProposals();
    check('  both proposals still wait, on the server and on the phone',
        waiting8.includes('From the LLM') && waiting8.includes('Reorder notes') && Boolean(findProposal('From the LLM')), JSON.stringify(waiting8));
    check('  and the unpushed edit is untouched', dirtyShown() && !(await treeTitles(alexTok)).includes('Offline folder'));
    answers.confirm.push(true); // OK = ⬆️ Push now
    await findProposal('From the LLM').querySelector('.proposal-approve').fire('click');
    await settle();
    check('OK pushes the edit, and still approves nothing', (await treeTitles(alexTok)).includes('Offline folder') && !dirtyShown()
        && approvals() === approvals8 && (await serverProposals()).length === 2,
        JSON.stringify({ dirty: dirtyShown(), pushed: (await treeTitles(alexTok)).includes('Offline folder'), approvals: approvals() - approvals8,
            waiting: (await serverProposals()).length, status: byId('status').textContent, toast: lastToast(), asks: dialogs.confirm.slice(-2) }));
    asked8 = dialogs.confirm.length;
    await findProposal('From the LLM').querySelector('.proposal-approve').fire('click');
    await settle();
    await findProposal('🔀 Reorder notes').querySelector('.proposal-approve').fire('click');
    await settle();
    const approved8 = await treeTitles(alexTok);
    check('with the copy clean, Approve approves and pulls, asking nothing', dialogs.confirm.length === asked8
        && approvals() === approvals8 + 2 && pulls() === pulls8 + 2 && (await serverProposals()).length === 0
        && approved8.includes('From the LLM') && approved8.includes('Offline folder'), dialogs.confirm.slice(asked8).join(' | '));

    await propose(alexTok, { title: 'While writing', content: '# While writing\n\nLLM WHILE WRITING' });
    await signIn('alex', alexPw); // the same account, clean: it pulls, and the proposal arrives
    await byId('notesBtn').fire('click');
    await clickNv('open-note', 'alex-diary');
    await clickNv('edit');
    await typeNote('# Diary\n\nALEX PRIVATE TEXT\nwritten while a proposal waits');
    const alerted8 = dialogs.alert.length;
    const approvals8b = approvals();
    await findProposal('While writing').querySelector('.proposal-approve').fire('click');
    await settle();
    check('approving while a note is being written approves nothing, and says to save it first',
        /^Save or close your note first, then approve\./.test(dialogs.alert[alerted8] || '') && approvals() === approvals8b
        && bodyHas('nv-editing'), dialogs.alert.slice(alerted8).join(' | '));
    check('  and the proposal still waits', (await serverProposals()).includes('While writing'));
    await clickNv('done'); // the text typed above is what gets saved: nothing was lost
    await findProposal('While writing').querySelector('.proposal-approve').fire('click');
    await settle();
    const approved8b = await treeTitles(alexTok);
    check('once the note is saved, Approve goes through and the note keeps its text',
        approvals() === approvals8b + 1 && approved8b.includes('LLM WHILE WRITING') && approved8b.includes('written while a proposal waits'));

    console.log('\n9. Import links wait on the phone until imported or dismissed');
    const historyHoldsNoLink = () => H.entries.every(e => !new URL(e.url).hash && !(e.state && e.state.tp === 'import-pending'));
    await byId('auth-signout').fire('click'); // a clean copy: nothing to ask
    await settle();
    let toasts9 = toastCount();
    await tapLink(noteLink('Tapped while out', 'TAPPED LINK BODY'));
    check('a link tapped while signed out is kept on the phone, with when it came, and says so',
        pendingLinks().length === 1 && pendingHolds('TAPPED LINK BODY') && !Number.isNaN(Date.parse(pendingLinks()[0].at))
        && toastsSince(toasts9).some(t => /Sign in to import this link/.test(t)), JSON.stringify(pendingLinks()));
    check('  and neither the URL nor any history entry holds it any more', !location.hash && historyHoldsNoLink());
    let mark9 = created.length;
    await byId('notesBtn').fire('click');
    check('Notes, opened before anyone signs in, shows it waiting, with Review and Dismiss',
        Boolean(waitingRow('Tapped while out')) && created.slice(mark9).includes(waitingRow('Tapped while out')));
    await signIn('kim', 'kim-password-1');
    check('  the next sign-in opens it for review', bodyHas('nv-editing') && /TAPPED LINK BODY/.test(lastEditorText() || ''), lastEditorText());
    check('  and it is still kept while under review', pendingHolds('TAPPED LINK BODY'));
    await clickNv('done');
    const kim = (await api('/api/login', { method: 'POST', body: { username: 'kim', password: 'kim-password-1' } })).json.token;
    check('  ✓ Done files it for that account, and it is kept no longer',
        (await treeTitles(kim)).includes('TAPPED LINK BODY') && pendingLinks().length === 0, JSON.stringify(pendingLinks()));

    // A start with no copy yet and no way to pull one.
    await byId('auth-signout').fire('click');
    await settle();
    failNext = 'GET /api/tree';
    await signIn('alex', alexPw);
    await byId('brand-home').fire('click');
    check('alex signs in while the tree cannot be pulled', localStorageShim.getItem('tp_pwa_userid') === '1'
        && /Nothing loaded yet/.test(byId('content').innerHTML), byId('content').innerHTML);
    openAt(BASE + '/' + noteLink('Offline link', 'OFFLINE LINK BODY'));
    failNext = 'GET /api/tree';
    toasts9 = toastCount();
    await byId('cfg-save').fire('click'); // the app starts again, from the link
    await settle();
    check('a link that opens the app while the tree cannot be pulled is kept, and says so',
        pendingHolds('OFFLINE LINK BODY') && !location.hash && !bodyHas('nv-editing')
        && toastsSince(toasts9).some(t => /opens after the next ⬇️ Pull/.test(t)), toastsSince(toasts9).join(' | '));
    await byId('pullBtn').fire('click');
    await settle();
    check('  the next pull opens it for review', bodyHas('nv-editing') && /OFFLINE LINK BODY/.test(lastEditorText() || ''), lastEditorText());
    await clickNv('done');
    check('  and ✓ Done files it for alex', (await treeTitles(alexTok)).includes('OFFLINE LINK BODY') && pendingLinks().length === 0);

    // alex's session expires deep in his notes; a link is tapped; sam signs in.
    const stamp9 = new Date().toISOString();
    const t9 = (await api('/api/tree', { token: alexTok })).json;
    t9.roots.find(r => r.role === 'notes').children.push({ id: 'nb-work', kind: 'folder', title: 'Workzz', children: [
        { id: 'plan-z', kind: 'note', title: 'Planzz', payload: { content: '# Planzz\n\nALEX PLAN TEXT\n- [ ] alex task', createdAt: stamp9, updatedAt: stamp9 } }] });
    t9.roots.push({ id: 'wf-root', kind: 'folder', role: 'workflows', title: 'TabPaladin Workflows', children: [
        { id: 'wf-morning', kind: 'folder', title: 'Morning', children: [{ id: 'wf-tab', kind: 'bookmark', title: 'News', url: 'https://news.example/' }] }] });
    await api('/api/tree', { method: 'PUT', token: alexTok, body: { roots: t9.roots, baseVersion: t9.version, deviceId: 'laptop' } });
    await byId('pullBtn').fire('click');
    await settle();
    const deepIntoWork = async () => {
        await byId('notesBtn').fire('click');
        await clickNv('open-nb', 'nb-work');
        await clickNv('open-note', 'plan-z');
    };
    await deepIntoWork();
    await expireAlex('fourth horse battery');
    check('alex\'s session expires three screens deep in his notes', !localStorageShim.getItem('tp_pwa_token') && bodyHas('view-notes'));
    toasts9 = toastCount();
    await tapLink(noteLink('After expiry', 'EXPIRY LINK BODY'));
    check('a link tapped then is kept for whoever signs in', pendingHolds('EXPIRY LINK BODY')
        && toastsSince(toasts9).some(t => /Sign in to import this link/.test(t)) && historyHoldsNoLink());
    mark9 = created.length;
    await signIn('sam', 'sam-password-1');
    check('sam signs in over the clean copy, and the link opens for him to review', localStorageShim.getItem('tp_pwa_userid') === '2'
        && bodyHas('nv-editing') && /EXPIRY LINK BODY/.test(lastEditorText() || ''), lastEditorText());
    check('  with nothing of alex\'s drawn, not even a back label', !['Workzz', 'Planzz', 'ALEX PLAN', 'ALEX PRIVATE'].some(t => drawnSince(mark9, t)),
        ['Workzz', 'Planzz', 'ALEX PLAN', 'ALEX PRIVATE'].filter(t => drawnSince(mark9, t)).join(', '));
    await clickNv('done');
    check('  ✓ Done files it for sam', (await treeTitles(samNow)).includes('EXPIRY LINK BODY') && pendingLinks().length === 0);

    // A link while another note is being written.
    await clickNv('new-note');
    await typeNote('# Sam writing\n\nSAM HALF NOTE');
    const asked9 = dialogs.confirm.length;
    toasts9 = toastCount();
    await tapLink(noteLink('Waiting link', 'WAITING LINK BODY'));
    check('a link tapped while a note is being written waits, and the note is not asked about',
        dialogs.confirm.length === asked9 && bodyHas('nv-editing') && /SAM HALF NOTE/.test(lastEditorText() || '')
        && pendingHolds('WAITING LINK BODY') && toastsSince(toasts9).some(t => /finish what is open/.test(t)), toastsSince(toasts9).join(' | '));
    mark9 = created.length;
    await clickNv('done');
    check('  once the note is saved, it waits in Notes', (await treeTitles(samNow)).includes('SAM HALF NOTE')
        && created.slice(mark9).includes(waitingRow('Waiting link')));
    answers.confirm.push(false); // "Dismiss this link?" Cancel.
    await waitingRow('Waiting link').querySelector('.pending-import-dismiss').fire('click');
    check('Dismiss asks first, and Cancel keeps it', /^Dismiss this link/.test(dialogs.confirm[dialogs.confirm.length - 1]) && pendingHolds('WAITING LINK BODY'));
    answers.confirm.push(true);
    await waitingRow('Waiting link').querySelector('.pending-import-dismiss').fire('click');
    await settle();
    check('  OK dismisses it for good', pendingLinks().length === 0 && !(await treeTitles(samNow)).includes('WAITING LINK BODY'));

    // Two links while signed out; the second is reviewed from Notes, then discarded.
    await byId('auth-signout').fire('click');
    await settle();
    await tapLink(noteLink('First of two', 'FIRST LINK BODY'));
    await tapLink(noteLink('Second of two', 'SECOND LINK BODY'));
    check('two links tapped while signed out are both kept', pendingLinks().length === 2);
    await signIn('kim', 'kim-password-1');
    check('  the next sign-in opens the first', bodyHas('nv-editing') && /FIRST LINK BODY/.test(lastEditorText() || ''), lastEditorText());
    mark9 = created.length;
    await clickNv('done');
    check('  ✓ Done files it, and the second waits in Notes', (await treeTitles(kim)).includes('FIRST LINK BODY')
        && pendingLinks().length === 1 && created.slice(mark9).includes(waitingRow('Second of two')));
    await waitingRow('Second of two').querySelector('.pending-import-review').fire('click');
    await settle();
    check('Review opens the second', bodyHas('nv-editing') && /SECOND LINK BODY/.test(lastEditorText() || ''), lastEditorText());
    answers.confirm.push(true); // "Discard unsaved changes?"
    await clickNv('cancel-edit');
    check('  and discarding it in the editor dismisses it', pendingLinks().length === 0 && !bodyHas('nv-editing')
        && !(await treeTitles(kim)).includes('SECOND LINK BODY'));

    // Links tapped while alex is signed in are his, opened or still waiting,
    // through a sign-out.
    await byId('auth-signout').fire('click');
    await settle();
    await signIn('alex', alexPw);
    await byId('notesBtn').fire('click');
    await clickNv('open-note', 'alex-diary');
    await clickNv('edit');
    await typeNote('# Diary\n\nALEX PRIVATE TEXT\nwritten while links arrive');
    await tapLink('#notes=' + encodeURIComponent(JSON.stringify([{ content: '# Batch one\n\nALEX BATCH BODY' }])));
    check('a #notes= link tapped while alex writes a note opens its review beside the note',
        created.some(e => e.className === 'import-list' && /Batch one/.test(e.innerHTML)) && bodyHas('nv-editing'));
    toasts9 = toastCount();
    await tapLink('#reorder=' + encodeURIComponent(JSON.stringify(['From the LLM', 'Diary'])));
    check('  a #reorder= link tapped then waits, the review block being taken', pendingLinks().length === 2
        && toastsSince(toasts9).some(t => /finish what is open/.test(t)));
    await clickNv('done');
    await byId('auth-signout').fire('click'); // a clean copy: the review is no unsaved edit
    await settle();
    mark9 = created.length;
    await signIn('sam', 'sam-password-1');
    await byId('notesBtn').fire('click');
    check('sam, signing in next, sees neither, under review or waiting in Notes', localStorageShim.getItem('tp_pwa_userid') === '2'
        && !['Batch one', 'ALEX BATCH', 'New order for'].some(t => drawnSince(mark9, t)) && pendingLinks().length === 2);
    await byId('auth-signout').fire('click');
    await settle();
    await signIn('alex', alexPw);
    await byId('notesBtn').fire('click');
    const importBtn = [...created].reverse().find(e => e.tagName === 'BUTTON' && e.textContent === 'Import');
    check('alex signs back in to his review, the order waiting below it', Boolean(importBtn)
        && created.some(e => e.className === 'import-list' && /Batch one/.test(e.innerHTML)) && Boolean(waitingRow('New order for 2 notes')));
    if (importBtn) await importBtn.fire('click');
    await settle();
    check('  Import files it for alex alone, and it is kept no longer', (await treeTitles(alexTok)).includes('ALEX BATCH BODY')
        && !(await treeTitles(samNow)).includes('ALEX BATCH BODY') && pendingLinks().length === 1);
    await waitingRow('New order for 2 notes').querySelector('.pending-import-review').fire('click');
    await settle();
    const discardBtn = [...created].reverse().find(e => e.tagName === 'BUTTON' && e.textContent === 'Discard');
    check('  Review opens the order', created.some(e => e.className === 'import-list' && /From the LLM/.test(e.innerHTML)) && Boolean(discardBtn));
    if (discardBtn) await discardBtn.fire('click');
    check('  and Discard dismisses it', pendingLinks().length === 0);

    console.log('\n10. Nothing writes into a copy while nobody is signed in');
    let clip = '';
    navigator.clipboard = { readText: async () => clip, writeText: async () => {} };
    clip = 'https://stranger.example/expired';
    await byId('clipBtn').fire('click');
    await settle();
    const clipRow = inboxRowWith('stranger.example/expired');
    check('alex has a copied link waiting in the Inbox', Boolean(clipRow) && !byId('inbox-sheet').classList.contains('hidden'));
    await deepIntoWork();
    await expireAlex('fifth horse battery');
    check('his session expires with the sheet and a note open', !localStorageShim.getItem('tp_pwa_token') && bodyHas('view-notes'));
    const prompts10 = dialogs.prompt.length;
    const confirms10 = dialogs.confirm.length;
    const toasts10 = toastCount();
    const outbox10 = JSON.stringify(outboxEntries());
    await clipRow.children[0].fire('click');
    await byId('content').fire('click', { target: { closest: (sel) => (sel === '.note-task-box' ? { dataset: { line: '3' } } : null) } });
    await clickNv('rename-note');
    await clickNv('delete-note');
    await clickNv('move-note');
    await byId('move-list').fire('click', { target: { closest: () => ({ disabled: false, dataset: { target: '' } }) } });
    await settle();
    const paste10 = inboxPaste();
    paste10.value = 'https://stranger.example/pasted';
    await paste10.fire('keydown', { key: 'Enter' });
    await byId('brand-home').fire('click');
    await settle();
    const wfRow = [...created].reverse().find(e => e.className === 'row workflow-row');
    if (wfRow) await wfRow.querySelector('.wf-del').fire('click');
    await settle();
    const refusals10 = toastsSince(toasts10).filter(t => /^Sign in first/.test(t));
    check('signed out, nothing is filed from the Inbox, ticked, renamed, deleted, moved, pasted or deleted from workflows',
        Boolean(wfRow) && refusals10.length === 7 && !dirtyShown() && dialogs.prompt.length === prompts10 && dialogs.confirm.length === confirms10
        && JSON.stringify(outboxEntries()) === outbox10 && !sheetOpen(),
        `${refusals10.length}: ${toastsSince(toasts10).join(' | ')}`);
    const pasteKept = paste10.value === 'https://stranger.example/pasted';
    check('  a refused paste stays in the box, without a word about it not being a link', pasteKept
        && !toastsSince(toasts10).some(t => /not a link|valid URL/.test(t)));
    await signIn('alex', alexPw);
    const after10 = await treeTitles(alexTok);
    check('  and alex signs back in to his tree as he left it', !after10.includes('stranger.example') && after10.includes('- [ ] alex task')
        && after10.includes('"title":"Planzz"') && after10.includes('"title":"Morning"'));

    // Signed out on purpose, with an unpushed edit kept for alex.
    failNext = 'PUT /api/tree';
    answers.prompt.push('Kept folder');
    await byId('newFolderBtn').fire('click');
    await settle();
    answers.confirm.push(true); // "Sign out anyway?"
    await byId('auth-signout').fire('click');
    await settle();
    check('alex signs out with his edit kept', !localStorageShim.getItem('tp_pwa_token') && /stays on this phone until alex signs in/.test(byId('status').textContent),
        byId('status').textContent);
    byId('settings-sheet').classList.add('hidden'); // closed after signing out
    const listsBefore = JSON.stringify([...storage.entries()].filter(([k]) => /scanned|dismissed/.test(k)));
    clip = 'https://stranger.example/kept';
    await new Promise(r => setTimeout(r, 3100)); // past the clipboard scan's once-in-3s throttle
    fireDocument('click', { target: { closest: () => null } });
    await settle();
    const toasts10b = toastCount();
    clip = 'not a url';
    await byId('clipBtn').fire('click');
    await settle();
    check('a tap scans no clipboard into anyone\'s lists, and the Inbox will not open',
        JSON.stringify([...storage.entries()].filter(([k]) => /scanned|dismissed/.test(k))) === listsBefore
        && ![...storage.values()].some(v => v.includes('stranger.example/kept'))
        && byId('inbox-sheet').classList.contains('hidden') && toastsSince(toasts10b).some(t => /^Sign in first/.test(t)),
        toastsSince(toasts10b).join(' | '));
    await signIn('alex', alexPw);
    await byId('pushBtn').fire('click');
    await settle();
    const pushed10 = await treeTitles(alexTok);
    check('alex signs back in and pushes his own edit, and nothing else', pushed10.includes('Kept folder') && !pushed10.includes('stranger.example'));

    console.log('\n11. Back and forward never reopen another account\'s notes');
    const home11 = H.index;
    await deepIntoWork();
    await expireAlex('sixth horse battery');
    await signIn('sam', 'sam-password-1');
    check('sam signs in over alex\'s clean copy, back on the Home entry', localStorageShim.getItem('tp_pwa_userid') === '2'
        && !bodyHas('view-notes') && H.index === home11, JSON.stringify({ index: H.index, home11 }));
    const mark11 = created.length;
    for (let i = 0; i < 3; i++) { historyShim.go(1); await settle(); }
    check('forward into the screens alex left reads as Home: none of his notes, notebooks or labels',
        H.index === home11 + 3 && !bodyHas('view-notes') && !['Workzz', 'Planzz', 'ALEX PLAN'].some(t => drawnSince(mark11, t)),
        ['Workzz', 'Planzz', 'ALEX PLAN'].filter(t => drawnSince(mark11, t)).join(', '));
    historyShim.go(-1);
    await settle();
    check('  and so does back', !bodyHas('view-notes') && !drawnSince(mark11, 'Workzz'));
    await byId('notesBtn').fire('click');
    historyShim.go(-1);
    await settle();
    historyShim.go(1);
    await settle();
    check('  while sam\'s own Notes entry still opens as Notes', bodyHas('view-notes'));

    console.log('\n12. A link that opens the app is nobody\'s until the server confirms the session');
    const loginAlex = async () => (await api('/api/login', { method: 'POST', body: { username: 'alex', password: alexPw } })).json.token;
    // A session from before ids: the phone knows alex's name and token, not his id.
    const preIdsSession = async () => {
        for (const k of ['tp_pwa_userid', 'tp_pwa_role', 'tp_pwa_owner']) localStorageShim.removeItem(k);
        localStorageShim.setItem('tp_pwa_url', BASE);
        localStorageShim.setItem('tp_pwa_user', 'alex');
        localStorageShim.setItem('tp_pwa_token', await loginAlex());
    };
    check('no link is waiting to begin with', pendingLinks().length === 0, JSON.stringify(pendingLinks()));
    await preIdsSession();
    let mark12 = created.length;
    await coldStart(BASE + '/' + noteLink('Cold start', 'COLD START BODY'));
    check('a link that starts a session from before ids opens for alex once the server says who he is',
        localStorageShim.getItem('tp_pwa_userid') === '1' && bodyHas('nv-editing') && /COLD START BODY/.test(editorSince(mark12) || ''),
        JSON.stringify({ userId: localStorageShim.getItem('tp_pwa_userid'), editor: editorSince(mark12), pending: pendingLinks() }));
    check('  kept for alex under the key his session has with or without its id',
        pendingLinks().length === 1 && pendingLinks()[0].account === `${BASE}|name:alex`, JSON.stringify(pendingLinks()));
    await clickNv('done');
    check('  ✓ Done files it for alex, and it is kept no longer', (await treeTitles(alexTok)).includes('COLD START BODY') && pendingLinks().length === 0);

    // alex's session ends while the app is closed (his password changed on
    // another device); a link starts the app; sam signs in.
    localStorageShim.setItem('tp_pwa_token', await loginAlex());
    alexTok = (await api('/api/auth/password', { method: 'POST', token: alexTok, body: { currentPassword: alexPw, newPassword: 'seventh horse battery' } })).json.token;
    alexPw = 'seventh horse battery';
    const toasts12 = toastCount();
    mark12 = created.length;
    await coldStart(BASE + '/' + noteLink('Stale start', 'STALE START BODY'));
    check('a link that starts the app on a session that ended meanwhile is kept for nobody in particular',
        !localStorageShim.getItem('tp_pwa_token') && pendingLinks().length === 1 && pendingLinks()[0].account === null
        && toastsSince(toasts12).some(t => /Sign in to import this link/.test(t)) && !bodyHas('nv-editing'),
        JSON.stringify({ pending: pendingLinks(), toasts: toastsSince(toasts12) }));
    await signIn('sam', 'sam-password-1');
    check('  so sam, signing in next, gets it to review', localStorageShim.getItem('tp_pwa_userid') === '2'
        && bodyHas('nv-editing') && /STALE START BODY/.test(editorSince(mark12) || ''), editorSince(mark12));
    await clickNv('done');
    check('  and ✓ Done files it for sam alone', (await treeTitles(samNow)).includes('STALE START BODY')
        && !(await treeTitles(alexTok)).includes('STALE START BODY') && pendingLinks().length === 0);

    // A session from before ids starts while the server cannot say who it is.
    await byId('auth-signout').fire('click');
    await settle();
    await preIdsSession();
    failNext = 'GET /api/auth/me';
    await coldStart(BASE + '/#notes=' + encodeURIComponent(JSON.stringify([{ content: '# Pre-ids batch\n\nPREIDS BATCH BODY' }])));
    mark12 = created.length;
    await byId('notesBtn').fire('click');
    check('a batch opened for review while the server cannot say who alex is',
        localStorageShim.getItem('tp_pwa_userid') === null && created.slice(mark12).some(e => e.className === 'import-list' && /Pre-ids batch/.test(e.innerHTML))
        && pendingLinks().length === 1 && pendingLinks()[0].account === `${BASE}|name:alex`, JSON.stringify(pendingLinks()));
    await coldStart(BASE + '/'); // closed unimported; the next start reaches the server
    mark12 = created.length;
    await byId('notesBtn').fire('click');
    const import12 = [...created.slice(mark12)].reverse().find(e => e.tagName === 'BUTTON' && e.textContent === 'Import');
    check('  is still alex\'s on a later start that learns his id', localStorageShim.getItem('tp_pwa_userid') === '1'
        && Boolean(import12) && created.slice(mark12).some(e => e.className === 'import-list' && /Pre-ids batch/.test(e.innerHTML)),
        JSON.stringify(pendingLinks()));
    if (import12) await import12.fire('click');
    await settle();
    check('  and Import files it for him', (await treeTitles(alexTok)).includes('PREIDS BATCH BODY') && pendingLinks().length === 0);

    // Links an earlier build kept for alex: under his id, and under his name
    // from a session before ids (the ones that could never be seen again).
    const at12 = new Date().toISOString();
    localStorageShim.setItem('tp_pending_import', JSON.stringify([
        { id: 'legacy-by-id', hash: noteLink('Legacy by id', 'LEGACY ID BODY'), at: at12, account: `${BASE}|1` },
        { id: 'legacy-by-name', hash: noteLink('Legacy by name', 'LEGACY NAME BODY'), at: at12, account: `${BASE}|alex` }
    ]));
    await byId('auth-signout').fire('click');
    await settle();
    mark12 = created.length;
    await signIn('sam', 'sam-password-1');
    await byId('notesBtn').fire('click');
    check('links an earlier build kept for alex are not sam\'s', localStorageShim.getItem('tp_pwa_userid') === '2'
        && !bodyHas('nv-editing') && !['Legacy by', 'LEGACY'].some(t => drawnSince(mark12, t)) && pendingLinks().length === 2);
    await byId('auth-signout').fire('click');
    await settle();
    mark12 = created.length;
    await signIn('alex', alexPw);
    check('  but alex\'s: the one kept under his id opens when he signs in', bodyHas('nv-editing') && /LEGACY ID BODY/.test(editorSince(mark12) || ''),
        editorSince(mark12));
    await clickNv('done');
    mark12 = created.length;
    await byId('notesBtn').fire('click');
    const legacyRow = created.slice(mark12).find(e => e.className === 'proposal pending-import' && e.innerHTML.includes('Legacy by name'));
    check('  and the one kept under his name waits in Notes', Boolean(legacyRow));
    if (legacyRow) await legacyRow.querySelector('.pending-import-review').fire('click');
    await settle();
    await clickNv('done');
    const legacyTree = await treeTitles(alexTok);
    check('  both file into his tree, and are kept no longer', legacyTree.includes('LEGACY ID BODY') && legacyTree.includes('LEGACY NAME BODY')
        && pendingLinks().length === 0, JSON.stringify(pendingLinks()));

    console.log('\n13. A link stays on the phone until the push that carries it succeeds');
    await tapLink(noteLink('Offline done', 'OFFLINE DONE BODY'));
    check('a link tapped opens for review', bodyHas('nv-editing') && /OFFLINE DONE BODY/.test(lastEditorText() || ''), lastEditorText());
    failNext = 'PUT /api/tree'; // offline for this push
    let toasts13 = toastCount();
    await clickNv('done');
    check('✓ Done whose push fails keeps the link on the phone, its note in the unpushed copy',
        pendingHolds('OFFLINE DONE BODY') && dirtyShown() && toastsSince(toasts13).some(t => /Push failed/.test(t))
        && !(await treeTitles(alexTok)).includes('OFFLINE DONE BODY'), JSON.stringify(pendingLinks()));
    let mark13 = created.length;
    await byId('notesBtn').fire('click');
    await byId('brand-home').fire('click');
    await settle();
    check('  not waiting in Notes or counted on Home meanwhile: its note is in the copy',
        !created.slice(mark13).some(e => e.className === 'proposal pending-import') && !drawnSince(mark13, 'waiting to be imported'));
    toasts13 = toastCount();
    await tapLink(noteLink('Offline done', 'OFFLINE DONE BODY'));
    check('  and tapped again it is not opened a second time', !bodyHas('nv-editing') && pendingLinks().length === 1
        && toastsSince(toasts13).some(t => /in your notes already/.test(t)), toastsSince(toasts13).join(' | '));
    mark13 = created.length;
    await coldStart(BASE + '/'); // the phone closes the app before any push
    check('the app closed before a push got through: the next start opens the link again',
        bodyHas('nv-editing') && /OFFLINE DONE BODY/.test(editorSince(mark13) || ''), editorSince(mark13));
    await clickNv('done');
    const filed13 = notesOf(JSON.parse(await treeTitles(alexTok))).filter(n => /OFFLINE DONE BODY/.test(n.content || ''));
    check('  ✓ Done with the server reachable files it once, and then it goes', filed13.length === 1 && pendingLinks().length === 0,
        JSON.stringify({ filed13, pending: pendingLinks() }));

    await tapLink('#notes=' + encodeURIComponent(JSON.stringify([{ content: '# Held batch\n\nHELD BATCH BODY' }])));
    await byId('notesBtn').fire('click');
    const import13 = [...created].reverse().find(e => e.tagName === 'BUTTON' && e.textContent === 'Import');
    failNext = 'PUT /api/tree';
    const alerts13 = dialogs.alert.length;
    if (import13) await import13.fire('click');
    await settle();
    check('a batch whose Import cannot be pushed keeps its link as well', Boolean(import13) && pendingHolds('HELD BATCH BODY') && dirtyShown()
        && dialogs.alert.slice(alerts13).some(m => /Import failed/.test(m)), dialogs.alert.slice(alerts13).join(' | '));
    await byId('pushBtn').fire('click');
    await settle();
    check('  until ⬆️ Push gets it to the server', (await treeTitles(alexTok)).includes('HELD BATCH BODY') && pendingLinks().length === 0 && !dirtyShown());

    await tapLink(noteLink('Pulled away', 'PULLED AWAY BODY'));
    failNext = 'PUT /api/tree';
    await clickNv('done');
    answers.confirm.push(true); // "Pull anyway?" — the unpushed copy is thrown away
    mark13 = created.length;
    await byId('pullBtn').fire('click');
    await settle();
    check('a pull that throws away the copy holding an imported note gives its link back, for review',
        bodyHas('nv-editing') && /PULLED AWAY BODY/.test(editorSince(mark13) || '') && pendingHolds('PULLED AWAY BODY'), editorSince(mark13));
    answers.confirm.push(true); // "Discard unsaved changes?"
    await clickNv('cancel-edit');
    check('  where ✕ dismisses it', pendingLinks().length === 0 && !(await treeTitles(alexTok)).includes('PULLED AWAY BODY'));

    console.log('\n14. A note open in the editor holds back an approval, changed or not');
    await propose(alexTok, { title: 'Diary', content: '# Diary\n\nLLM REWRITE OF DIARY' });
    await signIn('alex', alexPw); // the same account, clean: it pulls, and the proposal arrives
    await byId('notesBtn').fire('click');
    await clickNv('open-note', 'alex-diary');
    await clickNv('edit');
    const alerts14 = dialogs.alert.length;
    const approvals14 = approvals();
    await findProposal('Diary').querySelector('.proposal-approve').fire('click');
    await settle();
    check('approving with a note open, unchanged, approves nothing and says to save or close it first',
        /^Save or close your note first, then approve\./.test(dialogs.alert[alerts14] || '') && approvals() === approvals14
        && bodyHas('nv-editing') && (await serverProposals()).includes('Diary'), dialogs.alert.slice(alerts14).join(' | '));
    const asked14 = dialogs.confirm.length;
    await clickNv('cancel-edit');
    await findProposal('Diary').querySelector('.proposal-approve').fire('click');
    await settle();
    check('  closed (nothing asked), Approve goes through', dialogs.confirm.length === asked14 && approvals() === approvals14 + 1
        && /LLM REWRITE OF DIARY/.test(await treeTitles(alexTok)));
    await clickNv('edit');
    check('  and the editor opens on the approved text', /LLM REWRITE OF DIARY/.test(lastEditorText() || ''), lastEditorText());
    await typeNote((lastEditorText() || '') + '\nadded after the approval');
    await clickNv('done');
    const diary14 = notesOf(JSON.parse(await treeTitles(alexTok))).find(n => n.title === 'Diary');
    check('  so saving it keeps what was approved', Boolean(diary14) && /LLM REWRITE OF DIARY/.test(diary14.content || '')
        && /added after the approval/.test(diary14.content || ''), JSON.stringify(diary14));

    await propose(alexTok, { title: 'Late approval', content: '# Late approval\n\nLATE APPROVAL BODY' });
    await signIn('alex', alexPw);
    await byId('notesBtn').fire('click');
    let letGo = null;
    holdNext = { match: 'POST /api/proposals/', until: new Promise(r => { letGo = r; }) };
    const pulls14 = pulls();
    const toasts14 = toastCount();
    const approving = findProposal('Late approval').querySelector('.proposal-approve').fire('click');
    await clickNv('open-note', 'alex-diary');
    await clickNv('edit');
    letGo();
    await approving;
    await settle();
    check('a note opened while an approval is on its way holds back the pull, and says so',
        (await treeTitles(alexTok)).includes('LATE APPROVAL BODY') && pulls() === pulls14 && bodyHas('nv-editing')
        && toastsSince(toasts14).some(t => /not pulled here under your open note/.test(t)), toastsSince(toasts14).join(' | '));
    await clickNv('cancel-edit');

    console.log('\n15. Bookmark changes from AI chats wait on Home, previewed, for a clean copy');
    const goHomeTap = async () => {
        const t = { dataset: { nav: 'home' }, closest: () => t };
        await byId('bottom-nav').fire('click', { target: t });
        await settle();
    };
    const review = async () => (await api('/api/proposals/review', { token: alexTok })).json.proposals.filter(p => p.kind === 'tree');
    // The change as last drawn on Home, its title, and its buttons.
    const changeItem = (id) => [...created].reverse().find(e => typeof e.className === 'string' && /^change\b/.test(e.className) && e.dataset.id === String(id));
    const changeButton = (id, cls) => [...created].reverse().find(e => e.tagName === 'BUTTON' && e.className.includes(cls) && e.dataset.id === String(id));
    const alexTree = async () => (await api('/api/tree', { token: alexTok })).json;
    let t15 = await alexTree();
    let bm15 = t15.roots.find(r => r.role === 'bookmarks');
    if (!bm15) throw new Error('alex has no Bookmarks root');
    await propose(alexTok, { action: 'create_folder', parentId: bm15.id, path: 'From the chat', reason: 'For the reading list' });
    await signIn('alex', alexPw);
    await goHomeTap();
    let [c15] = await review();
    check('a suggested folder is drawn on Home with what it would do, where it came from and why',
        Boolean(c15) && Boolean(changeItem(c15.id)) && drawnSince(0, 'New folder “From the chat” in Bookmarks')
        && drawnSince(0, '“For the reading list”') && drawnSince(0, 'Share link'), JSON.stringify(c15));
    failNext = 'PUT /api/tree';
    answers.prompt.push('Offline folder 15');
    await byId('newFolderBtn').fire('click');
    await settle();
    const approvals15 = approvals();
    answers.confirm.push(false); // "Push your changes first, then approve." Cancel.
    await changeButton(c15.id, 'proposal-approve').fire('click');
    await settle();
    check('approving it over an unpushed edit asks to push first, and Cancel approves nothing',
        /^Push your changes first, then approve\./.test(dialogs.confirm[dialogs.confirm.length - 1] || '') && approvals() === approvals15
        && (await review()).length === 1);
    answers.confirm.push(true); // OK = ⬆️ Push now
    const pushMark15 = requests.length;
    await changeButton(c15.id, 'proposal-approve').fire('click');
    await settle();
    check('  OK pushes, and asks for the suggestions again after the push',
        requests.slice(pushMark15).includes('PUT /api/tree') && requests.slice(requests.indexOf('PUT /api/tree', pushMark15)).includes('GET /api/proposals/review')
        && approvals() === approvals15, requests.slice(pushMark15).join(' | '));
    const pulls15 = pulls();
    await changeButton(c15.id, 'proposal-approve').fire('click');
    await settle();
    t15 = await alexTree();
    bm15 = t15.roots.find(r => r.role === 'bookmarks');
    const made15 = (bm15.children || []).find(c => c.title === 'From the chat');
    check('pushed, Approve applies it on the server and pulls it here',
        approvals() === approvals15 + 1 && pulls() === pulls15 + 1 && Boolean(made15) && (await review()).length === 0
        && JSON.stringify(t15).includes('Offline folder 15'), JSON.stringify(bm15).slice(0, 300));

    // Out of date: the folder it renames is renamed elsewhere first.
    await propose(alexTok, { action: 'rename', id: made15.id, title: 'Renamed by the chat' });
    made15.title = 'Renamed on the laptop';
    const put15 = await api('/api/tree', { method: 'PUT', token: alexTok, body: { roots: t15.roots, baseVersion: t15.version } });
    if (put15.status !== 200) throw new Error('could not rename: ' + JSON.stringify(put15.json));
    await signIn('alex', alexPw);
    await goHomeTap();
    [c15] = await review();
    const approvals15b = approvals();
    const toasts15 = toastCount();
    await changeButton(c15.id, 'proposal-approve').fire('click');
    await settle();
    check('a suggestion whose folder changed since is drawn out of date, and Approve sends nothing',
        c15.status === 'stale' && /\bstale\b/.test(changeItem(c15.id).className) && changeButton(c15.id, 'proposal-approve').disabled === true
        && approvals() === approvals15b && toastsSince(toasts15).some(t => /out of date/.test(t))
        && drawnSince(0, 'was renamed to “Renamed on the laptop”'), JSON.stringify(c15));
    await changeButton(c15.id, 'proposal-reject').fire('click');
    await settle();
    check('  Reject drops it', (await review()).length === 0 && JSON.stringify(await alexTree()).includes('Renamed on the laptop'));

    // A delete is flagged and asked about.
    await propose(alexTok, { action: 'delete', ids: [made15.id] });
    await signIn('alex', alexPw);
    await goHomeTap();
    [c15] = await review();
    const asked15 = dialogs.confirm.length;
    answers.confirm.push(false);
    await changeButton(c15.id, 'proposal-approve').fire('click');
    await settle();
    check('a suggested delete is flagged, and approving it asks first; No deletes nothing',
        c15.danger === true && /\bdanger\b/.test(changeItem(c15.id).className)
        && /DELETES/.test(dialogs.confirm[asked15] || '') && approvals() === approvals15b
        && JSON.stringify(await alexTree()).includes('Renamed on the laptop'), dialogs.confirm.slice(asked15).join(' | '));
    await changeButton(c15.id, 'proposal-reject').fire('click');
    await settle();

    // Approve applies what was drawn, nothing else: it asks the server again first.
    const find15 = (roots, id) => { for (const n of roots) { if (n.id === id) return n; const h = find15(n.children || [], id); if (h) return h; } return null; };
    const push15 = async (change) => {
        const t = await alexTree();
        change(t.roots, t.roots.find(r => r.role === 'bookmarks'));
        const r = await api('/api/tree', { method: 'PUT', token: alexTok, body: { roots: t.roots, baseVersion: t.version } });
        if (r.status !== 200) throw new Error('push: ' + JSON.stringify(r.json));
    };
    await push15((roots, bm) => bm.children.push(
        { id: 'f15-empty', kind: 'folder', title: 'Drawn empty', children: [] },
        { id: 'f15-gp', kind: 'folder', title: 'Grandparent', children: [{ id: 'f15-parent', kind: 'folder', title: 'Parent before', children: [
            { id: 'f15-dest', kind: 'folder', title: 'Dest', children: [] }] }] },
        { id: 'b15-mover', kind: 'bookmark', title: 'Mover', url: 'https://mover.example/' }));
    await propose(alexTok, { action: 'delete', ids: ['f15-empty'] });
    await signIn('alex', alexPw);
    await goHomeTap();
    [c15] = await review();
    const drawnEmpty = drawnSince(0, 'DELETE folder “Drawn empty” from Bookmarks (empty)');
    await push15((roots) => find15(roots, 'f15-empty').children.push({ id: 'b15-late', kind: 'bookmark', title: 'From the laptop', url: 'https://laptop.example/late' }));
    let approvalsMark = approvals();
    let asksMark = dialogs.confirm.length;
    let toastsMark = toastCount();
    await changeButton(c15.id, 'proposal-approve').fire('click');
    await settle();
    check('a delete drawn as empty that another device filled since: Approve asks the server, deletes nothing, asks nothing, shows it out of date',
        drawnEmpty && approvals() === approvalsMark && dialogs.confirm.length === asksMark
        && toastsSince(toastsMark).some(t => /out of date now/.test(t)) && /\bstale\b/.test(changeItem(c15.id).className)
        && drawnSince(0, 'What is in the folder “Drawn empty” changed since') && JSON.stringify(await alexTree()).includes('laptop.example/late'),
        toastsSince(toastsMark).join(' | '));
    await changeButton(c15.id, 'proposal-reject').fire('click');
    await settle();

    await propose(alexTok, { action: 'move', ids: ['b15-mover'], toFolderId: 'f15-dest' });
    await signIn('alex', alexPw);
    await goHomeTap();
    [c15] = await review();
    const drawnBefore = drawnSince(0, 'Move bookmark “Mover” from Bookmarks to Bookmarks / Grandparent / Parent before / Dest');
    await push15((roots) => { find15(roots, 'f15-parent').title = 'Parent after'; });
    let drawnMark = created.length;
    approvalsMark = approvals();
    toastsMark = toastCount();
    await changeButton(c15.id, 'proposal-approve').fire('click');
    await settle();
    check('a suggestion whose lines read otherwise since (a folder above renamed): Approve redraws it, says so and sends nothing',
        drawnBefore && approvals() === approvalsMark && toastsSince(toastsMark).some(t => /changed since it was shown/.test(t))
        && drawnSince(drawnMark, 'to Bookmarks / Grandparent / Parent after / Dest') && !/\bstale\b/.test(changeItem(c15.id).className),
        toastsSince(toastsMark).join(' | '));
    const shown15 = (await review()).find(p => p.id === c15.id);
    await changeButton(c15.id, 'proposal-approve').fire('click');
    await settle();
    const approveAt = requests.lastIndexOf(`POST /api/proposals/${c15.id}/approve`);
    check('  tapped again, it approves what is shown now, naming that preview to the server',
        approvals() === approvalsMark + 1 && approveAt >= 0 && JSON.parse(requestBodies[approveAt] || '{}').reviewed === shown15.reviewKey
        && find15((await alexTree()).roots, 'f15-dest').children.some(c => c.id === 'b15-mover'), requestBodies[approveAt]);

    // A redraw when only the lines changed: coming back to the app asks again.
    await propose(alexTok, { action: 'move', ids: ['b15-mover'], toFolderId: 'f15-gp' });
    await signIn('alex', alexPw);
    await goHomeTap();
    [c15] = await review();
    // Where it comes from reads otherwise; nothing it names changed.
    await push15((roots) => { find15(roots, 'f15-parent').title = 'Parent again'; });
    drawnMark = created.length;
    approvalsMark = approvals();
    fireWindow('focus');
    await settle();
    const redrawn = drawnSince(drawnMark, 'Move bookmark “Mover” from Bookmarks / Grandparent / Parent again / Dest to Bookmarks / Grandparent');
    toastsMark = toastCount();
    await changeButton(c15.id, 'proposal-approve').fire('click');
    await settle();
    check('a suggestion whose lines changed but not its status is redrawn when the app comes back, and then approves at once',
        redrawn && approvals() === approvalsMark + 1 && !toastsSince(toastsMark).some(t => /changed since/.test(t))
        && (await review()).length === 0, toastsSince(toastsMark).join(' | '));

    // A review link from a chat that cannot POST: offered, then filed as a suggestion.
    const link15 = '#changes=' + encodeURIComponent(JSON.stringify({ reason: 'Via a link', changes: [{ op: 'create_folder', parentId: bm15.id, path: 'Linked folder' }] }));
    answers.confirm.push(true);
    await tapLink(link15);
    await settle();
    const linked15 = await review();
    check('a #changes= link asks, then files the suggestion for review; nothing is applied',
        /suggested 1 change to your bookmarks/.test(dialogs.confirm[dialogs.confirm.length - 1] || '') && linked15.length === 1
        && linked15[0].reason === 'Via a link' && !JSON.stringify(await alexTree()).includes('Linked folder')
        && !localStorageShim.getItem('tp_pending_changes'), JSON.stringify(linked15));
    await changeButton(linked15[0].id, 'proposal-reject').fire('click');
    await settle();
} catch (e) {
    failures++;
    console.error('FAIL  run stopped:', e, '\n' + serverLog);
} finally {
    server.kill();
    await serverExited;
    try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) { /* temp */ }
}

console.log(failures === 0 ? '\nAll PWA account tests passed.\n' : `\n${failures} test(s) failed.\n`);
process.exitCode = failures === 0 ? 0 : 1;
