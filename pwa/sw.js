// Minimal service worker — network-first for the app shell so updates roll
// out immediately; the cache is only an offline fallback. API/LLM calls
// always go to the network.
// Release ritual: bump the version here AND the ?v= queries in index.html
// together — all four numbers below included. Miss one and the phone keeps
// serving the old bundle from cache while the desktop looks fixed.
const SHELL_CACHE = 'tp-shell-v25';

// Server URL + session token, mirrored here by the app.
//
// A share is handled entirely in this worker so that sharing a post does not
// launch the app — see the fetch handler below. Workers cannot read
// localStorage, where the config actually lives, so the app copies it into this
// cache on every save. Cache Storage rather than IndexedDB purely because both
// sides can use it in a few lines.
const CONFIG_CACHE = 'tp-config';
const CONFIG_KEY = '/__tp_config';
const SHELL = [
    '/',
    '/index.html',
    '/app.css?v=25',
    '/app.js?v=25',
    '/manifest.webmanifest',
    '/icons/icon192.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then(keys => Promise.all(
            // CONFIG_CACHE is not a shell version — dropping it would log the
            // share handler out on every release.
            keys.filter(k => k !== SHELL_CACHE && k !== CONFIG_CACHE).map(k => caches.delete(k))
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

// Handle a shared link without launching the app.
//
// The Web Share Target spec always navigates to the target, so the only way to
// avoid the app booting is to answer that navigation here. A 204 tells the
// browser there is nothing to display, so the share completes and you stay in
// X or Instagram.
//
// Anything that stops this worker from finishing the job — no config mirrored
// yet, server unreachable — redirects into the app instead, which handles the
// same share the long way. Losing the link would be far worse than opening a
// window.
async function handleShare(request) {
    // Absolute on purpose: Response.redirect resolves a relative URL against
    // the worker's base in a browser, but that is a subtlety worth not relying
    // on when the cost of being explicit is one URL constructor.
    const fallback = (url, title) => Response.redirect(
        new URL('/?' + new URLSearchParams({ share: '1', url: url || '', title: title || '' }),
            self.location.origin).href,
        303
    );

    let url = '';
    let title = '';
    try {
        const form = await request.formData();
        url = String(form.get('url') || '');
        title = String(form.get('title') || '');
        const text = String(form.get('text') || '');
        // Android apps vary in which field carries the link; X puts it in text.
        if (!url && /https?:\/\//.test(text)) {
            const m = text.match(/https?:\/\/\S+/);
            if (m) url = m[0];
        }
        if (!url && text) title = title || text;
    } catch (e) {
        return fallback('', '');
    }

    if (!url) return fallback(url, title);

    const cfg = await readConfig();
    if (!cfg) return fallback(url, title);

    const post = (path, body) => fetch(cfg.url.replace(/\/$/, '') + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.token },
        body: JSON.stringify(body)
    });

    try {
        const res = await post('/api/imports/capture', { url, title });
        if (res.ok) {
            const data = await res.json();
            // Not X or Instagram — still worth keeping, just in the inbox.
            if (!data.captured) await post('/api/shared', { url, title });
            return new Response(null, { status: 204 });
        }
        // An older server has no capture route; the inbox still works.
        if (res.status === 404) {
            const inbox = await post('/api/shared', { url, title });
            if (inbox.ok) return new Response(null, { status: 204 });
        }
    } catch (e) {
        // Offline or the server is down — fall through.
    }
    return fallback(url, title);
}

self.addEventListener('fetch', (event) => {
    const req = event.request;
    const shareUrl = new URL(req.url);
    // The share target posts here. Answering it in the worker is what keeps the
    // app from launching.
    if (req.method === 'POST' && shareUrl.pathname === '/share') {
        event.respondWith(handleShare(req));
        return;
    }
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    // Never cache API calls or LLM share links — always go to network.
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/llm/')) return;
    // Network-first: fresh files when online, cached copy when offline.
    event.respondWith(
        fetch(req)
            .then(res => {
                if (res.ok && url.origin === self.location.origin) {
                    const copy = res.clone();
                    caches.open(SHELL_CACHE).then(c => c.put(req, copy));
                }
                return res;
            })
            .catch(() => caches.match(req).then(hit => hit || caches.match('/index.html')))
    );
});
