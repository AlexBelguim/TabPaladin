// Service worker: the app shell, and shares.
//
// Release ritual: bump the version here AND the ?v= queries in index.html
// together — SHELL_CACHE, the SHELL entries and the importScripts below
// included. Miss one and the phone keeps serving the old bundle from cache
// while the desktop looks fixed. tools/test_pwa_release.mjs checks they agree.
importScripts('shareCore.js?v=29');

const SHELL_CACHE = 'tp-shell-v29';

// Server URL, session token and who it is, mirrored here by the app: workers
// cannot read localStorage, where the config actually lives. Cache Storage
// rather than IndexedDB because both sides use it in a few lines, as they do
// for the outbox (tp-outbox) and the app's working copy (tp-data).
const CONFIG_CACHE = 'tp-config';
const CONFIG_KEY = '/__tp_config';
const SHELL = [
    '/',
    '/index.html',
    '/app.css?v=29',
    '/app.js?v=29',
    '/shareCore.js?v=29',
    '/shareSheet.js',
    '/bookmarksHtml.js',
    '/notesModel.js',
    '/manifest.webmanifest',
    '/icons/icon192.png'
];

// How long a share's upload may take before the worker gives up on it; it
// stays in the outbox and goes with the next flush.
const UPLOAD_TIMEOUT_MS = 6000;
// How long a navigation waits on the network before the cached shell.
const NAVIGATION_TIMEOUT_MS = 3000;

const Share = self.TPShare;
// One outbox for the worker's lifetime, so its changes to an entry run one at
// a time across flushes, as the page's do.
let workerOutbox = null;
const outbox = () => (workerOutbox = workerOutbox || Share.cacheOutbox(caches));

// One SHELL file failing (a 404 mid-deploy) must not leave nothing cached.
self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(SHELL_CACHE).then(c => Promise.allSettled(SHELL.map(u => c.add(u)))));
    self.skipWaiting();
});

// Only older shells go. tp-config, tp-outbox and tp-data are not versions:
// dropping one would sign the share handler out, lose shares not yet
// uploaded, or the working copy kept for a reload.
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then(keys => Promise.all(
            keys.filter(k => k.startsWith('tp-shell-') && k !== SHELL_CACHE).map(k => caches.delete(k))
        ))
    );
    self.clients.claim();
});

async function readConfig() {
    try {
        const cache = await caches.open(CONFIG_CACHE);
        const hit = await cache.match(CONFIG_KEY);
        if (!hit) return null;
        const cfg = await hit.json();
        return cfg && cfg.url && cfg.token ? cfg : null;
    } catch (e) {
        return null;
    }
}

// Upload what waits in the outbox, for the account signed in now, and tell
// any open window what happened, and as whom (it folds filed links into its
// copy only when that copy is the same account's).
async function flush(opts = {}) {
    const cfg = await readConfig();
    if (!cfg) return null;
    const result = await Share.flushOutbox({ outbox: outbox(), cfg, fetch: (u, o) => fetch(u, o), timeoutMs: UPLOAD_TIMEOUT_MS, ...opts });
    try {
        const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const w of wins) w.postMessage({ type: 'tp-outbox', result, account: Share.accountOf(cfg) });
    } catch (e) { /* no window to tell */ }
    return result;
}

// The app's old way in, carrying all three fields: used only when the share
// could not be kept here, so the app can keep it instead.
function legacyRedirect(fields) {
    const params = new URLSearchParams({ share: '1', url: fields.url || '', title: fields.title || '', text: fields.text || '' });
    return Response.redirect(new URL('/?' + params, self.location.origin).href, 303);
}

// A share arrives here, from the manifest's share_target. It is written to
// the outbox before anything touches the network, then uploaded in the
// background, and the app opens on it with only its id in the address — the
// link itself never goes into a URL. Whatever the upload does (offline,
// signed out, refused, never answering) the share stays in the outbox, and
// the app shows it at once from there.
async function handleShare(event) {
    let fields = { title: '', text: '', url: '' };
    try {
        const form = await event.request.formData();
        fields = {
            title: String(form.get('title') || ''),
            text: String(form.get('text') || ''),
            url: String(form.get('url') || '')
        };
    } catch (e) {
        return legacyRedirect(fields);
    }
    const cfg = await readConfig();
    let entry;
    try {
        entry = Share.makeEntry({ fields, account: Share.accountOf(cfg), source: 'share' });
        await outbox().put(entry);
    } catch (e) {
        return legacyRedirect(fields);
    }
    if (cfg && entry.url) event.waitUntil(flush({ sids: [entry.sid] }).catch(() => {}));
    return Response.redirect(new URL('/?share=' + encodeURIComponent(entry.sid), self.location.origin).href, 303);
}

async function cachedShell() {
    const cache = await caches.open(SHELL_CACHE);
    return (await cache.match('/')) || (await cache.match('/index.html')) || null;
}

// The shell is cached under '/' only, never under a navigation's query
// string: /?share=… must not leave a copy per share behind.
async function keepShell(res) {
    if (!res || !res.ok) return;
    try { await (await caches.open(SHELL_CACHE)).put('/', res); } catch (e) { /* cache full: not fatal */ }
}

async function navigation(event, url) {
    const share = url.searchParams.get('share');
    if (share && share !== '1') {
        // A share opening the app: paint from cache at once, and refresh the
        // cached shell in the background for next time.
        const hit = await cachedShell();
        const fresh = fetch('/').then(res => keepShell(res.clone()).then(() => res));
        if (hit) {
            event.waitUntil(fresh.catch(() => {}));
            return hit;
        }
        return fresh;
    }
    let timer = null;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), NAVIGATION_TIMEOUT_MS); });
    const net = fetch(event.request);
    try {
        const res = await Promise.race([net, timeout]);
        if (res.ok && (url.pathname === '/' || url.pathname === '/index.html')) await keepShell(res.clone());
        return res;
    } catch (e) {
        const hit = await cachedShell();
        if (hit) return hit;
        return net;
    } finally {
        clearTimeout(timer);
    }
}

self.addEventListener('fetch', (event) => {
    const req = event.request;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;
    if (req.method === 'POST' && url.pathname === '/share') {
        event.respondWith(handleShare(event));
        return;
    }
    if (req.method !== 'GET') return;
    // API calls and LLM share links always go to the network.
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/llm/')) return;
    if (req.mode === 'navigate') {
        event.respondWith(navigation(event, url));
        return;
    }
    // Everything else, network-first: fresh files when online, cached when
    // not.
    event.respondWith(
        fetch(req)
            .then(res => {
                if (res.ok) {
                    const copy = res.clone();
                    event.waitUntil(caches.open(SHELL_CACHE).then(c => c.put(req, copy)).catch(() => {}));
                }
                return res;
            })
            .catch(() => caches.match(req).then(hit => hit || Response.error()))
    );
});

// Background Sync (Chromium): the app registers 'tp-outbox' when a share
// could not go up; the browser wakes this when the network is back.
self.addEventListener('sync', (event) => {
    if (event.tag === 'tp-outbox') event.waitUntil(flush());
});

// The app asks for a flush on start, on 'online' and after a sign-in.
self.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.type === 'flush') event.waitUntil(flush(Array.isArray(data.sids) ? { sids: data.sids } : {}));
});
