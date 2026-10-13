// The PWA against a real server, through a minimal DOM: what happens to the
// phone's working copy, queued shares and per-account lists when people sign
// in and out.
//
// What this locks down:
//   1. A share made while signed out is queued on the phone, not lost, and
//      delivered after sign-in once the account says yes.
//   2. Unpushed edits survive a revoked session: signing in as someone else
//      is refused (nothing of theirs is pulled over the edits), signing back
//      in as the same account does not pull, and Push then keeps the edits.
//   3. A clean copy switches accounts cleanly, and the per-device lists from
//      before accounts are adopted by the server's owner only.
//   4. Admins see the Users block; plain users do not.
//   5. A share the server refuses while you are signed in (a full inbox) is
//      kept on the phone, the app says why, and it is delivered once there is
//      room.
//   6. Signing out with unpushed edits asks first and keeps them: nobody else
//      can sign in over them, and the same account gets them back.
//
// Run: node tools/test_pwa_accounts.mjs [--port 18982]
//
// Starts this checkout's server on the port with a throwaway data directory.

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
// accept anything; rendering is not what is under test here.

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
        id, tagName: tag.toUpperCase(), style: {}, dataset: {}, children: [], value: '', textContent: '', innerHTML: '',
        checked: false, disabled: false, title: '', href: '', open: false, offsetHeight: 0, scrollTop: 0, className: '',
        classList: classList(),
        addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
        removeEventListener() {},
        async fire(ev) {
            const event = { preventDefault() {}, stopPropagation() {}, target: el, key: '' };
            await Promise.all((listeners[ev] || []).map(fn => fn(event)));
        },
        appendChild(c) { el.children.push(c); return c; },
        insertBefore(c) { return c; },
        append() {}, prepend() {}, remove() {}, replaceWith() {}, replaceChildren() {}, insertAdjacentHTML() {},
        // Rendering code wires listeners onto what it just rendered; hand it
        // something to wire onto.
        querySelector() { return makeElement(); },
        querySelectorAll() { return []; },
        closest() { return makeElement(); },
        setAttribute() {}, getAttribute() { return null; }, removeAttribute() {}, hasAttribute() { return false; },
        scrollIntoView() {}, focus() {}, select() {}, blur() {}, click() { return el.fire('click'); },
        contains() { return false; },
        getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
    };
    return el;
}

const elements = new Map();
const byId = (id) => {
    if (!elements.has(id)) {
        const el = makeElement(id);
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
let currentUrl = new URL(BASE + '/?share=1&url=' + encodeURIComponent('https://example.com/shared-while-out') + '&title=Shared');
const dialogs = { confirm: [], prompt: [], alert: [] };
const answers = { confirm: [], prompt: [] };

Object.assign(globalThis, {
    window: globalThis,
    document: {
        getElementById: byId,
        createElement: (tag) => makeElement(null, tag),
        createTextNode: (t) => ({ textContent: t }),
        body: makeElement('body'),
        documentElement: makeElement('html'),
        addEventListener() {},
        querySelector: () => null,
        querySelectorAll: () => []
    },
    localStorage: localStorageShim,
    location: {
        get search() { return currentUrl.search; },
        get pathname() { return currentUrl.pathname; },
        get hash() { return currentUrl.hash; },
        get origin() { return currentUrl.origin; },
        get protocol() { return currentUrl.protocol; },
        get href() { return currentUrl.href; }
    },
    history: { replaceState: (a, b, url) => { currentUrl = new URL(url, currentUrl); } },
    confirm: (msg) => { dialogs.confirm.push(msg); return answers.confirm.length ? answers.confirm.shift() : false; },
    prompt: (msg) => { dialogs.prompt.push(msg); return answers.prompt.length ? answers.prompt.shift() : null; },
    alert: (msg) => { dialogs.alert.push(msg); },
    scrollTo() {},
    innerHeight: 800,
    open() {}
});
globalThis.addEventListener = (ev, fn) => { (windowListeners[ev] = windowListeners[ev] || []).push(fn); };
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: null }, configurable: true });

// Every request the app makes, so the test can tell a pull from no pull.
const requests = [];
const realFetch = globalThis.fetch;
let inFlight = 0;
let lastActivity = Date.now();
globalThis.fetch = async (url, opts = {}) => {
    requests.push(`${(opts.method || 'GET').toUpperCase()} ${String(url).replace(BASE, '')}`);
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

async function signIn(username, password) {
    byId('cfg-url').value = BASE;
    byId('cfg-username').value = username;
    byId('cfg-password').value = password;
    byId('auth-error').textContent = '';
    await byId('auth-submit').fire('click');
    await settle();
}

const treeTitles = async (token) => JSON.stringify((await api('/api/tree', { token })).json.roots);

try {
    for (let i = 0; i < 100; i++) {
        try { if ((await realFetch(BASE + '/api/health')).ok) break; } catch (e) { /* not yet */ }
        await new Promise(r => setTimeout(r, 100));
    }
    const alexAdmin = (await api('/api/login', { method: 'POST', body: { username: 'alex', password: PASSWORD } })).json.token;
    const madeSam = await api('/api/users', { method: 'POST', token: alexAdmin, body: { username: 'sam', password: 'sam-password-1', role: 'user', currentPassword: PASSWORD } });
    if (madeSam.status !== 200) throw new Error('could not create sam: ' + JSON.stringify(madeSam.json));

    // The per-device lists from before accounts.
    localStorageShim.setItem('tp_dismissed_urls', JSON.stringify(['https://legacy-dismissed.example']));

    await import(pathToFileURL(path.join(REPO, 'pwa', 'app.js')).href);
    for (const fn of windowListeners.DOMContentLoaded || []) await fn();
    await settle();

    console.log('\n1. A share made while signed out');
    const queued = JSON.parse(localStorageShim.getItem('tp_pending_shares') || '[]');
    check('is queued on the phone', queued.length === 1 && queued[0].url === 'https://example.com/shared-while-out' && queued[0].userId === null,
        JSON.stringify(queued));
    check('and the URL is cleaned afterwards', currentUrl.search === '');

    answers.confirm.push(true); // "add them to alex's inbox?"
    await signIn('alex', PASSWORD);
    check('after alex signs in he is asked about it', dialogs.confirm.some(m => /shared while signed out/.test(m) && /alex/.test(m)), dialogs.confirm.join(' | '));
    const inbox = (await api('/api/shared', { token: alexAdmin })).json.links;
    check('and it lands in his inbox', inbox.some(l => l.url === 'https://example.com/shared-while-out'));
    check('the queue is empty', !localStorageShim.getItem('tp_pending_shares'));
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

    const pullsBefore = requests.filter(r => r === 'GET /api/tree').length;
    await signIn('sam', 'sam-password-1');
    check('signing in as sam is refused while alex\'s edits are unpushed',
        /unpushed edit/.test(byId('auth-error').textContent) && /for alex/.test(byId('auth-error').textContent), byId('auth-error').textContent);
    check('  with a way to discard them deliberately', !byId('auth-discard').classList.contains('hidden') && /alex/.test(byId('auth-discard').textContent));
    check('  and nothing of sam\'s was pulled or stored', !localStorageShim.getItem('tp_pwa_token')
        && requests.filter(r => r === 'GET /api/tree').length === pullsBefore);

    await signIn('alex', 'new horse battery');
    check('signing back in as alex does not pull over the edits', requests.filter(r => r === 'GET /api/tree').length === pullsBefore);
    check('and says what to do', /unpushed edits from before you were signed out/.test(byId('status').textContent), byId('status').textContent);
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
    // alex's inbox holds the link from section 1; one more fills it.
    await api('/api/shared', { method: 'POST', token: alexNew, body: { url: 'https://example.com/filler' } });
    const ARTICLE = 'https://blog.example/an-article-i-want-to-keep';
    currentUrl = new URL(BASE + '/?share=1&url=' + encodeURIComponent(ARTICLE) + '&title=Article');
    await signIn('alex', 'new horse battery'); // any start runs the share through
    const keptFull = JSON.parse(localStorageShim.getItem('tp_pending_shares') || '[]');
    check('a link the full inbox refuses is kept on the phone, as alex\'s', keptFull.some(s => s.url === ARTICLE && s.userId === 1),
        JSON.stringify(keptFull));
    check('  and the app says why, in the server\'s words', dialogs.alert.some(m => /inbox already holds 2 links/.test(m)),
        dialogs.alert.join(' | '));
    const filler = (await api('/api/shared', { token: alexNew })).json.links.find(l => l.url === 'https://example.com/filler');
    await api(`/api/shared/${filler.id}`, { method: 'DELETE', token: alexNew });
    await signIn('alex', 'new horse battery');
    check('once there is room, the next start delivers it',
        (await api('/api/shared', { token: alexNew })).json.links.some(l => l.url === ARTICLE) && !localStorageShim.getItem('tp_pending_shares'));

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
    const pullsAtSignOut = requests.filter(r => r === 'GET /api/tree').length;
    await signIn('sam', 'sam-password-1');
    check('sam cannot sign in over alex\'s unpushed edits',
        /unpushed edit/.test(byId('auth-error').textContent) && /for alex/.test(byId('auth-error').textContent)
        && !localStorageShim.getItem('tp_pwa_token'), byId('auth-error').textContent);
    await signIn('alex', 'new horse battery');
    check('alex signs back in to his edits, with no pull over them',
        requests.filter(r => r === 'GET /api/tree').length === pullsAtSignOut
        && /unpushed edits from before you were signed out/.test(byId('status').textContent), byId('status').textContent);
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
