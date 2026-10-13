// Headless test for the service worker's share handler.
//
// Sharing a post must not launch the app, so the worker answers the share-target
// POST itself and replies 204. That path cannot be exercised in a normal page —
// it needs a real installed PWA and an Android share intent — so the handler is
// loaded here with stubbed worker globals and driven directly.
//
// What this locks down:
//   1. A recognised link is captured and answered 204, so nothing opens.
//   2. Every way the job can fail redirects into the app instead of dropping
//      the link. Losing what you shared is the one unacceptable outcome.
//   3. The URL is found wherever the sharing app puts it — X uses `text`.
//   4. Where the worker hands a share to the app and the app cannot deliver
//      it either (signed out, a revoked session), the app queues it on the
//      phone; after sign-in the same account's queued shares are delivered
//      and anyone else's wait for a yes.
//
// Run: node tools/test_share_sw.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makePendingShares, PENDING_SHARES_KEY } from '../pwa/pendingShares.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SW_SRC = fs.readFileSync(path.join(__dirname, '..', 'pwa', 'sw.js'), 'utf8');

let failures = 0;
function check(name, cond, detail) {
    if (cond) console.log(`  ok  ${name}`);
    else { failures++; console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// --- Worker globals ------------------------------------------------------

function makeCaches(config) {
    const store = new Map();
    if (config) {
        store.set('/__tp_config', new Response(JSON.stringify(config), {
            headers: { 'Content-Type': 'application/json' }
        }));
    }
    return {
        open: async () => ({
            match: async (k) => store.get(k),
            put: async (k, v) => store.set(k, v),
            delete: async (k) => store.delete(k),
            addAll: async () => {}
        }),
        keys: async () => ['tp-config'],
        delete: async () => true,
        match: async () => undefined
    };
}

// Loads sw.js with worker globals injected and hands back its handleShare.
function loadHandleShare({ config, fetchImpl }) {
    const self = {
        addEventListener: () => {},
        skipWaiting: () => {},
        clients: { claim: () => {} },
        location: { origin: 'https://tab.example' }
    };
    const factory = new Function(
        'self', 'caches', 'fetch', 'Response', 'URL', 'URLSearchParams', 'console',
        SW_SRC + '\n;return handleShare;'
    );
    return factory(self, makeCaches(config), fetchImpl, Response, URL, URLSearchParams, console);
}

// A share arrives as a urlencoded POST, exactly as the manifest declares.
function shareRequest(fields) {
    return new Request('https://tab.example/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString()
    });
}

const CONFIG = { url: 'https://tab.example', token: 'tok' };

function recordingFetch(responder) {
    const calls = [];
    const fn = async (url, opts = {}) => {
        calls.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : null, opts });
        return responder(String(url), calls.length);
    };
    fn.calls = calls;
    return fn;
}

const ok = (body) => new Response(JSON.stringify(body), {
    status: 200, headers: { 'Content-Type': 'application/json' }
});

// --- Tests ---------------------------------------------------------------

async function main() {
    console.log('\n1. A recognised link is captured, and nothing opens');
    {
        const fetchImpl = recordingFetch(() => ok({ ok: true, captured: true, provider: 'x', items: 7 }));
        const handleShare = loadHandleShare({ config: CONFIG, fetchImpl });
        const res = await handleShare(shareRequest({ url: 'https://x.com/nasa/status/1', title: 'Hi' }));
        check('answered 204 — the app never launches', res.status === 204, `status=${res.status}`);
        check('called the capture endpoint',
            fetchImpl.calls[0].url === 'https://tab.example/api/imports/capture', fetchImpl.calls[0].url);
        check('sent the shared url', fetchImpl.calls[0].body.url === 'https://x.com/nasa/status/1');
        check('sent the auth token',
            fetchImpl.calls[0].opts.headers.Authorization === 'Bearer tok');
        check('made exactly one request', fetchImpl.calls.length === 1, `${fetchImpl.calls.length}`);
    }

    console.log('\n2. An unrecognised link still lands, in the inbox');
    {
        const fetchImpl = recordingFetch((url) => url.includes('/capture')
            ? ok({ ok: true, captured: false })
            : ok({ ok: true }));
        const handleShare = loadHandleShare({ config: CONFIG, fetchImpl });
        const res = await handleShare(shareRequest({ url: 'https://example.com/post' }));
        check('still 204', res.status === 204, `status=${res.status}`);
        check('fell through to the inbox',
            fetchImpl.calls[1] && fetchImpl.calls[1].url.endsWith('/api/shared'),
            fetchImpl.calls.map(c => c.url).join(', '));
    }

    console.log('\n3. X puts the link in `text` — it is still found');
    {
        const fetchImpl = recordingFetch(() => ok({ ok: true, captured: true, provider: 'x', items: 1 }));
        const handleShare = loadHandleShare({ config: CONFIG, fetchImpl });
        await handleShare(shareRequest({ text: 'Look at this https://x.com/nasa/status/2', title: 'NASA' }));
        check('url extracted from text',
            fetchImpl.calls[0].body.url === 'https://x.com/nasa/status/2', fetchImpl.calls[0].body.url);
    }

    console.log('\n4. Every failure opens the app rather than dropping the link');
    const redirected = (res) => res.status >= 300 && res.status < 400;

    {
        // Not signed in yet, so the worker has no server to talk to.
        const fetchImpl = recordingFetch(() => ok({}));
        const handleShare = loadHandleShare({ config: null, fetchImpl });
        const res = await handleShare(shareRequest({ url: 'https://x.com/a/status/3' }));
        check('no mirrored config -> redirect', redirected(res), `status=${res.status}`);
        check('and the link is carried into the app',
            res.headers.get('location').includes(encodeURIComponent('https://x.com/a/status/3')),
            res.headers.get('location'));
        check('nothing was requested', fetchImpl.calls.length === 0);
    }
    {
        // Server unreachable.
        const fetchImpl = recordingFetch(() => { throw new Error('offline'); });
        const handleShare = loadHandleShare({ config: CONFIG, fetchImpl });
        const res = await handleShare(shareRequest({ url: 'https://x.com/a/status/4' }));
        check('network failure -> redirect', redirected(res), `status=${res.status}`);
    }
    {
        // Session expired.
        const fetchImpl = recordingFetch(() => new Response('nope', { status: 401 }));
        const handleShare = loadHandleShare({ config: CONFIG, fetchImpl });
        const res = await handleShare(shareRequest({ url: 'https://x.com/a/status/5' }));
        check('401 -> redirect', redirected(res), `status=${res.status}`);
    }
    {
        // A share with no link at all.
        const fetchImpl = recordingFetch(() => ok({}));
        const handleShare = loadHandleShare({ config: CONFIG, fetchImpl });
        const res = await handleShare(shareRequest({ title: 'just text' }));
        check('no url -> redirect', redirected(res), `status=${res.status}`);
    }
    {
        // An older server that predates the capture route.
        const fetchImpl = recordingFetch((url) => url.includes('/capture')
            ? new Response('not found', { status: 404 })
            : ok({ ok: true }));
        const handleShare = loadHandleShare({ config: CONFIG, fetchImpl });
        const res = await handleShare(shareRequest({ url: 'https://x.com/a/status/6' }));
        check('old server -> inbox, still 204', res.status === 204, `status=${res.status}`);
        check('used the inbox route',
            fetchImpl.calls[1] && fetchImpl.calls[1].url.endsWith('/api/shared'),
            fetchImpl.calls.map(c => c.url).join(', '));
    }

    console.log('\n5. The redirect target is absolute');
    {
        const fetchImpl = recordingFetch(() => { throw new Error('offline'); });
        const handleShare = loadHandleShare({ config: CONFIG, fetchImpl });
        const res = await handleShare(shareRequest({ url: 'https://x.com/a/status/7' }));
        const loc = res.headers.get('location');
        check('absolute url, not a bare path', /^https?:\/\//.test(loc), loc);
        check('lands on the app root with share=1', loc.includes('/?share=1'), loc);
    }

    await pendingShareTests();

    console.log(failures === 0 ? '\nAll share-worker tests passed.\n' : `\n${failures} test(s) failed.\n`);
    process.exit(failures === 0 ? 0 : 1);
}

// --- The app's side: a share it cannot deliver is queued, never dropped ----

function fakeStorage() {
    const m = new Map();
    return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
        raw: m
    };
}

async function pendingShareTests() {
    console.log('\n6. The app queues what it cannot deliver');
    const storage = fakeStorage();
    const pending = makePendingShares({ storage });
    const unauthorized = async () => { const e = new Error('Signed out'); e.status = 401; throw e; };

    const after401 = await pending.take({ url: 'https://x.com/a/status/8', title: 't', userId: 1 }, { canDeliver: true, deliver: unauthorized });
    check('a share whose delivery gets 401 is queued', after401.queued && !after401.delivered);
    check('  in tp_pending_shares, with the account it was shared under',
        JSON.parse(storage.getItem(PENDING_SHARES_KEY)).some(s => s.url === 'https://x.com/a/status/8' && s.userId === 1));
    await pending.take({ url: 'https://example.com/signed-out', userId: null }, { canDeliver: false, deliver: unauthorized });
    check('a share made while signed out is queued without trying', pending.list().length === 2);
    const delivered = [];
    const ok = await pending.take({ url: 'https://example.com/fine', userId: 1 }, { canDeliver: true, deliver: async (s) => { delivered.push(s.url); return { captured: null }; } });
    check('a share that can be delivered is not queued as well', ok.delivered && !ok.queued && pending.list().length === 2);

    console.log('\n7. Draining after sign-in');
    await pending.take({ url: 'https://example.com/sams', userId: 2 }, { canDeliver: false });
    let asked = null;
    const sent = [];
    const held = await pending.drain({
        userId: 1,
        deliver: async (s) => { sent.push(s.url); },
        ask: async (shares) => { asked = shares.map(s => s.url); return 'keep'; }
    });
    check('the same account\'s shares are delivered without asking', sent.join() === 'https://x.com/a/status/8' && held.added === 1);
    check('everyone else\'s are asked about, not delivered',
        JSON.stringify(asked) === JSON.stringify(['https://example.com/signed-out', 'https://example.com/sams']));
    check('kept ones stay queued', pending.list().map(s => s.url).join() === 'https://example.com/signed-out,https://example.com/sams');

    const failing = await pending.drain({ userId: 2, deliver: unauthorized, ask: async () => 'add' });
    check('a delivery that fails again keeps the share', failing.added === 0 && pending.list().length === 2);

    const sent2 = [];
    const added = await pending.drain({ userId: 2, deliver: async (s) => { sent2.push(s.url); }, ask: async () => 'add' });
    check('sam\'s own share goes in, and the signed-out one when he says add',
        added.added === 2 && sent2.includes('https://example.com/sams') && sent2.includes('https://example.com/signed-out'));
    check('the queue is empty afterwards', pending.list().length === 0 && storage.getItem(PENDING_SHARES_KEY) === null);

    await pending.take({ url: 'https://example.com/unwanted', userId: null }, { canDeliver: false });
    const dropped = await pending.drain({ userId: 1, deliver: async () => {}, ask: async () => 'discard' });
    check('discarding is an explicit answer', dropped.discarded === 1 && pending.list().length === 0);
}

main().catch(e => { console.error(e); process.exit(1); });
