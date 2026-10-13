// Headless test for the service worker: shares, and the app shell.
//
// A share arrives at the worker as the share target's POST. It must be kept
// on the phone before anything touches the network, and the app must open on
// it — by its id, never with the link in a URL — whatever the network does.
// That path needs a real installed PWA and an Android share intent to run for
// real, so sw.js is loaded here with stubbed worker globals (Cache Storage,
// fetch, clients) and importScripts evaluating the real shareCore.js.
//
// What this locks down:
//   1. The outbox entry is written before any fetch, and the answer is a 303
//      to /?share=<sid> with no link in the Location header.
//   2. Offline, signed out, a 401, a 500, and a fetch that never answers
//      (given up on after the upload timeout) all keep the entry and still
//      answer the same 303. A share with no link is kept for the app too.
//   3. When the outbox cannot be written, the old redirect carries url, title
//      and text, so the app can keep the share instead.
//   4. Two flushes at once send a share once; a share captured as one
//      account is never uploaded as another.
//   5. The shell: a navigation is cached under '/' only, never under its
//      query; a share navigation is served from cache first; install survives
//      one shell file failing; activate removes only older shells.
//
// Run: node tools/test_share_sw.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PWA = path.join(__dirname, '..', 'pwa');
const SW_SRC = fs.readFileSync(path.join(PWA, 'sw.js'), 'utf8');
const CORE_SRC = fs.readFileSync(path.join(PWA, 'shareCore.js'), 'utf8');
// The shell version moves with every release; read it rather than pin it.
const V = (SW_SRC.match(/const SHELL_CACHE = 'tp-shell-v(\d+)'/) || [])[1];
const SHELL_NAME = `tp-shell-v${V}`;
const ORIGIN = 'https://tab.example';

let failures = 0;
function check(name, cond, detail) {
    if (cond) console.log(`  ok  ${name}`);
    else { failures++; console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// --- Worker globals -----------------------------------------------------------

function makeCaches({ failPut = null } = {}) {
    const stores = new Map();
    const key = (k) => {
        const s = typeof k === 'string' ? k : k.url;
        return s.startsWith('/') ? s : new URL(s).pathname + new URL(s).search;
    };
    const api = {
        stores,
        failPut,
        async open(name) {
            if (!stores.has(name)) stores.set(name, new Map());
            const m = stores.get(name);
            return {
                match: async (k) => { const r = m.get(key(k)); return r ? r.clone() : undefined; },
                put: async (k, v) => {
                    if (api.failPut && api.failPut(name, key(k))) throw new Error('QuotaExceededError');
                    m.set(key(k), v);
                },
                add: async (k) => {
                    const res = await api.fetchForAdd(k);
                    if (!res.ok) throw new TypeError('add failed: ' + k);
                    m.set(key(k), res);
                },
                delete: async (k) => m.delete(key(k)),
                keys: async () => [...m.keys()]
            };
        },
        keys: async () => [...stores.keys()],
        delete: async (name) => stores.delete(name),
        match: async (k) => {
            for (const m of stores.values()) { const r = m.get(key(k)); if (r) return r.clone(); }
            return undefined;
        },
        fetchForAdd: async () => new Response('shell', { status: 200 })
    };
    return api;
}

async function putConfig(caches, cfg) {
    const c = await caches.open('tp-config');
    await c.put('/__tp_config', new Response(JSON.stringify(cfg), { headers: { 'Content-Type': 'application/json' } }));
}

// Loads sw.js as a worker would, with importScripts evaluating shareCore.js
// into the same `self`. `timeoutMs` replaces the upload timeout.
function loadWorker({ caches, fetchImpl, timeoutMs = null }) {
    const listeners = {};
    const posted = [];
    const self = {
        addEventListener: (type, fn) => { listeners[type] = fn; },
        skipWaiting: () => {},
        clients: { claim: () => {}, matchAll: async () => [{ postMessage: (m) => posted.push(m) }] },
        location: { origin: ORIGIN },
        crypto: globalThis.crypto
    };
    const importScripts = (url) => {
        if (!/^shareCore\.js\?v=\d+$/.test(url)) throw new Error('unexpected importScripts ' + url);
        new Function('self', CORE_SRC)(self);
    };
    const src = timeoutMs === null ? SW_SRC : SW_SRC.replace(/const UPLOAD_TIMEOUT_MS = \d+;/, `const UPLOAD_TIMEOUT_MS = ${timeoutMs};`);
    new Function('self', 'caches', 'fetch', 'importScripts', 'Response', 'URL', 'URLSearchParams', 'console', src)(
        self, caches, fetchImpl, importScripts, Response, URL, URLSearchParams, console);
    return { self, listeners, posted };
}

// A fetch event as the browser dispatches one; resolves to the response and
// waits for everything the worker kept alive with waitUntil.
async function dispatchFetch(worker, request, { mode = 'no-cors' } = {}) {
    const extended = [];
    let responded = null;
    // A Request's mode is set by the browser; a plain stand-in carries it.
    const req = { url: request.url, method: request.method, headers: request.headers, mode, formData: () => request.formData() };
    const event = {
        request: req,
        respondWith: (p) => { responded = Promise.resolve(p); },
        waitUntil: (p) => { extended.push(Promise.resolve(p)); }
    };
    worker.listeners.fetch(event);
    const res = responded ? await responded : null;
    // waitUntil may be called from inside the respondWith promise: settle twice.
    await Promise.allSettled(extended);
    await Promise.allSettled(extended);
    return { res, extended };
}

function shareRequest(fields) {
    return new Request(ORIGIN + '/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString()
    });
}

function recordingFetch(responder) {
    const calls = [];
    const fn = async (url, opts = {}) => {
        calls.push({ url: String(url).replace(ORIGIN, ''), body: opts.body ? JSON.parse(opts.body) : null, auth: (opts.headers || {}).Authorization });
        return responder(String(url).replace(ORIGIN, ''), opts, calls.length);
    };
    fn.calls = calls;
    return fn;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const intakeOk = (p, o) => json({ ok: true, created: true, share: { sid: JSON.parse(o.body).sid, status: 'pending', filings: [] }, archived: null });
const ALEX = { url: ORIGIN, token: 'tok', userId: 1, username: 'alex', serverId: 'srv' };

async function outboxEntries(caches) {
    const m = caches.stores.get('tp-outbox');
    if (!m) return [];
    return Promise.all([...m.values()].map(r => r.clone().json()));
}

const sidOf = (res) => new URL(res.headers.get('location')).searchParams.get('share');

// --- Tests -----------------------------------------------------------------------

async function main() {
    console.log('\n1. A share is kept, then the app opens on its id');
    {
        const caches = makeCaches();
        await putConfig(caches, ALEX);
        let atFirstFetch = null;
        const fetchImpl = recordingFetch(async (p, o) => {
            if (atFirstFetch === null) atFirstFetch = await outboxEntries(caches);
            return intakeOk(p, o);
        });
        const w = loadWorker({ caches, fetchImpl });
        const { res } = await dispatchFetch(w, shareRequest({ title: '', text: 'Look at this https://x.com/nasa/status/42?s=20', url: '' }));
        const loc = res.headers.get('location');
        check('answered 303 to /?share=<sid>', res.status === 303 && /^https:\/\/tab\.example\/\?share=[A-Za-z0-9_-]{16,64}$/.test(loc), `${res.status} ${loc}`);
        check('  with no link in the Location header', !/x\.com|nasa|status/.test(loc));
        check('the outbox entry was written before any fetch', atFirstFetch && atFirstFetch.length === 1 && atFirstFetch[0].sid === sidOf(res)
            && atFirstFetch[0].url === 'https://x.com/nasa/status/42');
        check('then uploaded with its sid, the cleaned link and the session token', fetchImpl.calls.length === 1 && fetchImpl.calls[0].url === '/api/shares'
            && fetchImpl.calls[0].body.sid === sidOf(res) && fetchImpl.calls[0].body.url === 'https://x.com/nasa/status/42'
            && fetchImpl.calls[0].body.app === 'x' && fetchImpl.calls[0].auth === 'Bearer tok');
        const [entry] = await outboxEntries(caches);
        check('and the entry stays, uploaded, for the app to read', entry && entry.uploaded === true && entry.phase === 'uploaded'
            && entry.account.userId === 1 && entry.fields.text.includes('nasa'));
        check('open windows are told, and as whom it flushed', w.posted.some(m => m.type === 'tp-outbox' && m.result.uploaded.includes(entry.sid)
            && m.account && m.account.userId === 1 && m.account.username === entry.account.username));
    }

    console.log('\n2. Whatever the network does, the share is kept and the app opens on it');
    const failing = [
        ['offline', () => { throw new TypeError('Failed to fetch'); }, ALEX],
        ['not signed in (no config mirrored)', () => json({}), null],
        ['a 401', () => new Response('{}', { status: 401 }), ALEX],
        ['an inbox 500', () => json({ error: 'boom' }, 500), ALEX],
        ['a fetch that never answers', () => new Promise(() => {}), ALEX]
    ];
    for (const [what, responder, cfg] of failing) {
        const caches = makeCaches();
        if (cfg) await putConfig(caches, cfg);
        const fetchImpl = recordingFetch(responder);
        const w = loadWorker({ caches, fetchImpl, timeoutMs: 40 });
        const t0 = Date.now();
        const { res } = await dispatchFetch(w, shareRequest({ url: 'https://example.com/keep-me', title: 'Keep me' }));
        const entries = await outboxEntries(caches);
        check(`${what}: still a 303 to the share's id, the entry kept and not uploaded`,
            res.status === 303 && entries.length === 1 && entries[0].sid === sidOf(res) && entries[0].uploaded === false
            && entries[0].url === 'https://example.com/keep-me' && Date.now() - t0 < 3000, `${res.status} ${JSON.stringify(entries)}`);
    }
    {
        const caches = makeCaches();
        await putConfig(caches, ALEX);
        const fetchImpl = recordingFetch(intakeOk);
        const w = loadWorker({ caches, fetchImpl });
        const { res } = await dispatchFetch(w, shareRequest({ text: 'Just a thought, no link' }));
        const [entry] = await outboxEntries(caches);
        check('a share with no link is kept for the app (Save as note / Discard) and not uploaded',
            res.status === 303 && entry && entry.url === null && entry.text === 'Just a thought, no link' && fetchImpl.calls.length === 0);
    }

    console.log('\n3. When the outbox cannot be written');
    {
        const caches = makeCaches({ failPut: (name) => name === 'tp-outbox' });
        await putConfig(caches, ALEX);
        const fetchImpl = recordingFetch(intakeOk);
        const w = loadWorker({ caches, fetchImpl });
        const { res } = await dispatchFetch(w, shareRequest({ url: '', title: 'A title', text: 'Look https://x.com/a/status/9' }));
        const loc = new URL(res.headers.get('location'));
        check('the old redirect carries url, title and text into the app', res.status === 303 && loc.pathname === '/'
            && loc.searchParams.get('share') === '1' && loc.searchParams.get('title') === 'A title'
            && loc.searchParams.get('text') === 'Look https://x.com/a/status/9' && loc.searchParams.has('url'), loc.href);
        check('  and nothing was sent', fetchImpl.calls.length === 0);
    }

    console.log('\n4. Flushing');
    {
        const caches = makeCaches();
        await putConfig(caches, ALEX);
        let release = null;
        const gate = new Promise(r => { release = r; });
        const fetchImpl = recordingFetch(async (p, o) => { await gate; return intakeOk(p, o); });
        const w = loadWorker({ caches, fetchImpl });
        const shared = dispatchFetch(w, shareRequest({ url: 'https://example.com/once' }));
        await new Promise(r => setTimeout(r, 20));
        const ext = [];
        w.listeners.message({ data: { type: 'flush' }, waitUntil: (p) => ext.push(p) });
        w.listeners.sync({ tag: 'tp-outbox', waitUntil: (p) => ext.push(p) });
        await new Promise(r => setTimeout(r, 20));
        release();
        await shared;
        await Promise.all(ext);
        check('the share upload, a flush message and a background sync at once send the share once',
            fetchImpl.calls.filter(c => c.url === '/api/shares').length === 1, String(fetchImpl.calls.length));
    }
    {
        const caches = makeCaches();
        await putConfig(caches, ALEX);
        const w0 = loadWorker({ caches, fetchImpl: recordingFetch(() => { throw new TypeError('offline'); }) });
        await dispatchFetch(w0, shareRequest({ url: 'https://example.com/alex-only' }));
        await putConfig(caches, { ...ALEX, token: 'sam-tok', userId: 2, username: 'sam' });
        const fetchImpl = recordingFetch(intakeOk);
        const w = loadWorker({ caches, fetchImpl });
        const ext = [];
        w.listeners.sync({ tag: 'tp-outbox', waitUntil: (p) => ext.push(p) });
        await Promise.all(ext);
        const [entry] = await outboxEntries(caches);
        check('a share captured as alex is not uploaded once sam is signed in', fetchImpl.calls.length === 0 && entry && !entry.uploaded
            && entry.account.username === 'alex');
        await putConfig(caches, ALEX);
        const w2 = loadWorker({ caches, fetchImpl });
        const ext2 = [];
        w2.listeners.message({ data: { type: 'flush' }, waitUntil: (p) => ext2.push(p) });
        await Promise.all(ext2);
        check('  and goes up once alex is again', fetchImpl.calls.length === 1 && fetchImpl.calls[0].body.url === 'https://example.com/alex-only');
    }

    console.log('\n5. The shell');
    {
        const caches = makeCaches();
        const served = [];
        const fetchImpl = async (req) => {
            const u = typeof req === 'string' ? req : req.url;
            served.push(u.replace(ORIGIN, ''));
            return new Response('<html>shell ' + served.length + '</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
        };
        const w = loadWorker({ caches, fetchImpl });
        await dispatchFetch(w, new Request(ORIGIN + '/?share=1&url=https%3A%2F%2Fsecret.example%2Fx&title=t'), { mode: 'navigate' });
        await dispatchFetch(w, new Request(ORIGIN + '/?ref=home'), { mode: 'navigate' });
        const shellKeys = [...(caches.stores.get(SHELL_NAME) || new Map()).keys()];
        check('navigations are cached under / only, never under their query', JSON.stringify(shellKeys) === '["/"]', JSON.stringify(shellKeys));
        check('  so no shared link sits in Cache Storage', ![...caches.stores.values()].some(m => [...m.keys()].some(k => k.includes('secret'))));
        const before = served.length;
        const { res } = await dispatchFetch(w, new Request(ORIGIN + '/?share=AbCdEfGhIjKlMnOpQrStUv'), { mode: 'navigate' });
        check('a share navigation is served from the cached shell first', (await res.text()) === '<html>shell 2</html>');
        check('  and the shell is refreshed in the background, under /', served.length === before + 1 && served[served.length - 1] === '/'
            && (await (await (await caches.open(SHELL_NAME)).match('/')).text()) === '<html>shell 3</html>');
        const slow = loadWorker({ caches, fetchImpl: () => new Promise(() => {}) });
        const t0 = Date.now();
        const { res: offline } = await dispatchFetch(slow, new Request(ORIGIN + '/'), { mode: 'navigate' });
        check('a navigation the network does not answer falls back to the cached shell', offline && (await offline.text()).startsWith('<html>shell')
            && Date.now() - t0 < 5000);
    }
    {
        const caches = makeCaches();
        caches.fetchForAdd = async (u) => new Response('x', { status: u === '/notesModel.js' ? 404 : 200 });
        const w = loadWorker({ caches, fetchImpl: async () => new Response('x') });
        const ext = [];
        w.listeners.install({ waitUntil: (p) => ext.push(p) });
        await Promise.all(ext);
        const keys = [...caches.stores.get(SHELL_NAME).keys()];
        check('install caches every other shell file when one fails', keys.length >= 8 && !keys.includes('/notesModel.js')
            && keys.includes(`/app.js?v=${V}`) && keys.includes(`/shareCore.js?v=${V}`), JSON.stringify(keys));
        for (const name of [`tp-shell-v${V - 1}`, `tp-shell-v${V - 2}`, 'tp-config', 'tp-outbox', 'tp-data', 'other-app-cache']) await caches.open(name);
        const ext2 = [];
        w.listeners.activate({ waitUntil: (p) => ext2.push(p) });
        await Promise.all(ext2);
        check('activate removes older shells only, keeping tp-config, tp-outbox and tp-data',
            JSON.stringify([...caches.stores.keys()].sort()) === JSON.stringify(['other-app-cache', 'tp-config', 'tp-data', 'tp-outbox', SHELL_NAME]),
            JSON.stringify([...caches.stores.keys()]));
    }
    {
        const caches = makeCaches();
        const fetchImpl = recordingFetch(() => json({}));
        const w = loadWorker({ caches, fetchImpl });
        const api = await dispatchFetch(w, new Request(ORIGIN + '/api/tree'));
        const llm = await dispatchFetch(w, new Request(ORIGIN + '/llm/token'));
        check('API calls and LLM links are left to the network', api.res === null && llm.res === null);
    }

    console.log(failures === 0 ? '\nAll share-worker tests passed.\n' : `\n${failures} test(s) failed.\n`);
    process.exitCode = failures === 0 ? 0 : 1;
}

main().catch(e => { console.error(e); process.exit(1); });
