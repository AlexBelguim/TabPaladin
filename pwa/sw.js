// Minimal service worker — network-first for the app shell so updates roll
// out immediately; the cache is only an offline fallback. API/LLM calls
// always go to the network.
// Release ritual: bump v11 here AND the ?v=11 queries in index.html together.
const SHELL_CACHE = 'tp-shell-v11';
const SHELL = [
    '/',
    '/index.html',
    '/app.css?v=11',
    '/app.js?v=11',
    '/manifest.webmanifest',
    '/icons/icon128.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then(keys => Promise.all(keys.filter(k => k !== SHELL_CACHE).map(k => caches.delete(k))))
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
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
