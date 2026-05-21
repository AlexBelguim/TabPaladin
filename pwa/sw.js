// Minimal service worker — caches the app shell, lets the network handle data.
const SHELL_CACHE = 'tp-shell-v1';
const SHELL = [
    '/',
    '/index.html',
    '/app.css',
    '/app.js',
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
    // Never cache API calls — always go to network.
    if (url.pathname.startsWith('/api/')) return;
    event.respondWith(
        caches.match(req).then(hit => hit || fetch(req).catch(() => caches.match('/index.html')))
    );
});
