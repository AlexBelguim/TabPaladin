// What a saved link points at, for links whose own title cannot say it.
//
// A MEGA link's page title is only "MEGA": the folder's name, and the names
// and sizes inside it, are encrypted, and the key is the part of the link
// after '#'. MEGA's public API hands out the encrypted listing to anyone with
// the folder's handle; the key from the saved link decrypts it here, so the
// web app can show "Holiday photos · 4.2 GB" instead of the link. The key goes
// no further than this server, which already holds the link in the tree.
//
// POST /api/link-info {urls: [...]} -> {info: {[url]: {kind, name, size,
// files, folders} | {error}}}, error being 'gone' (deleted or taken down),
// 'bad-key' (the key does not decrypt it) or 'failed' (try again later).
// Links that are not MEGA links are left out of the answer.

import crypto from 'node:crypto';

const API = 'https://g.api.mega.co.nz/cs';
const MAX_URLS = 20;
const TIMEOUT_MS = 20000;
// A folder's contents change; a few hours is fresh enough for a label. A
// failure is asked again sooner.
const FRESH_MS = 6 * 3600 * 1000;
const RETRY_MS = 10 * 60 * 1000;
const MAX_CACHED = 2000;
// At most this many MEGA requests at once, however many pages ask.
const PARALLEL = 3;

const HANDLE = '[A-Za-z0-9_-]{8}';
const b64 = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// The folder or file a MEGA link names: its public handle, its key, and the
// folder or file inside it that a deeper link opens on. Both link styles:
//   https://mega.nz/folder/H#K[/folder/S | /file/S]   https://mega.nz/file/H#K
//   https://mega.nz/#F!H!K[!S | ?S]                    https://mega.nz/#!H!K
export function parseMega(url) {
    let u;
    try { u = new URL(String(url)); } catch (e) { return null; }
    if (!/^https?:$/.test(u.protocol) || !/(^|\.)mega\.(nz|co\.nz)$/.test(u.hostname)) return null;
    const hash = u.hash;
    let m = u.pathname.match(new RegExp(`^/(folder|file)/(${HANDLE})/?$`));
    let kind, handle, key, sub = null;
    if (m) {
        [, kind, handle] = m;
        const h = hash.match(new RegExp(`^#([A-Za-z0-9_-]{22,43})(?:/(?:folder|file)/(${HANDLE}))?`));
        if (!h) return null;
        [, key, sub] = h;
    } else if ((m = hash.match(new RegExp(`^#F!(${HANDLE})!([A-Za-z0-9_-]{22})(?:[!?](${HANDLE}))?`)))) {
        kind = 'folder'; [, handle, key, sub] = m;
    } else if ((m = hash.match(new RegExp(`^#!(${HANDLE})!([A-Za-z0-9_-]{43})`)))) {
        kind = 'file'; [, handle, key] = m;
    } else {
        return null;
    }
    const raw = b64(key);
    if (raw.length !== (kind === 'folder' ? 16 : 32)) return null;
    return { kind, handle, key: raw, sub: sub || null, id: `${kind}:${handle}:${key}:${sub || ''}` };
}

const decipher = (mode, key, data, iv = null) => {
    const d = crypto.createDecipheriv(mode, key, iv);
    d.setAutoPadding(false);
    return Buffer.concat([d.update(data), d.final()]);
};
// A file's 32-byte key folds into the 16 bytes its attributes use.
const fold = (k) => k.length === 32 ? Buffer.from(k.subarray(0, 16).map((b, i) => b ^ k[16 + i])) : k;

// A node's name, from its attributes ("MEGA{json}" padded with zeroes) and
// its own key; null when they do not decrypt.
function nodeName(attrs, nodeKey) {
    try {
        const key = fold(nodeKey);
        const raw = b64(attrs);
        const text = decipher('aes-128-cbc', key, raw.subarray(0, raw.length - raw.length % 16), Buffer.alloc(16)).toString('utf8').replace(/\0+$/, '');
        return text.startsWith('MEGA{') ? String(JSON.parse(text.slice(4)).n || '') || null : null;
    } catch (e) {
        return null;
    }
}

// A node's name in a folder listing. Its key is encrypted with the folder's
// key, as 'owner:key'; a folder shared on by others carries several, joined
// by '/', and only one is the link's (often the last): each is tried.
function folderNodeName(node, folderKey) {
    for (const part of String(node.k || '').split('/')) {
        try {
            const k = b64(part.split(':').pop());
            if (k.length !== 16 && k.length !== 32) continue;
            const name = nodeName(node.a, decipher('aes-128-ecb', folderKey, k));
            if (name) return name;
        } catch (e) { /* not this one */ }
    }
    return null;
}

class MegaError extends Error {
    constructor(code) { super(`MEGA error ${code}`); this.code = code; }
}

// MEGA tells requests apart by their id: two at once with the same one fail.
let sequence = crypto.randomInt(1e9);
// MEGA's "busy, try again" and "too many requests".
const AGAIN = new Set([-3, -4]);

async function call(fetchImpl, command, handle, tries = 0) {
    const qs = `?id=${sequence++}` + (handle ? `&n=${handle}` : '');
    const res = await fetchImpl(API + qs, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([command]),
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`MEGA answered ${res.status}`);
    const data = await res.json();
    const answer = Array.isArray(data) ? data[0] : data;
    if (typeof answer === 'number') {
        if (AGAIN.has(answer) && tries < 2) {
            await new Promise(r => setTimeout(r, 1500 * 2 ** tries));
            return call(fetchImpl, command, handle, tries + 1);
        }
        throw new MegaError(answer);
    }
    return answer;
}

// Every node in a shared folder, however deep.
async function listFolder(fetchImpl, handle) {
    const got = await call(fetchImpl, { a: 'f', c: 1, ca: 1, r: 1 }, handle);
    return Array.isArray(got.f) ? got.f : [];
}

// {kind, name, size, files, folders} for a parsed link. listing(handle)
// gives a folder's nodes: makeLinkInfo's shares one between the links into
// the same folder, which MEGA will not list twice at once.
export async function lookupMega(link, { fetch: fetchImpl = globalThis.fetch, listing = (h) => listFolder(fetchImpl, h) } = {}) {
    if (link.kind === 'file') {
        const got = await call(fetchImpl, { a: 'g', p: link.handle });
        const name = nodeName(got.at, link.key);
        if (!name) return { error: 'bad-key' };
        return { kind: 'file', name, size: Number(got.s) || 0, files: 1, folders: 0 };
    }
    const nodes = await listing(link.handle);
    const handles = new Set(nodes.map(n => n.h));
    const top = link.sub ? nodes.find(n => n.h === link.sub) : nodes.find(n => !handles.has(n.p));
    if (!top) return { error: 'gone' };
    const name = folderNodeName(top, link.key);
    if (!name) return { error: 'bad-key' };
    if (top.t === 0) return { kind: 'file', name, size: Number(top.s) || 0, files: 1, folders: 0 };
    // Everything under the folder the link opens on, however deep.
    const children = new Map();
    for (const n of nodes) {
        if (!children.has(n.p)) children.set(n.p, []);
        children.get(n.p).push(n);
    }
    let size = 0, files = 0, folders = 0;
    const stack = [top.h];
    while (stack.length) {
        for (const n of children.get(stack.pop()) || []) {
            if (n.t === 0) { files++; size += Number(n.s) || 0; }
            else if (n.t === 1) { folders++; stack.push(n.h); }
        }
    }
    return { kind: 'folder', name, size, files, folders };
}

// MEGA's codes for a link that no longer works: no such handle, not found,
// no access, taken down, expired.
const GONE = new Set([-2, -9, -11, -16, -8]);

export function makeLinkInfo({ fetch: fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    const cache = new Map(); // link id -> {at, value}
    const running = new Map(); // link id -> promise, so one lookup serves every caller
    const listings = new Map(); // folder handle -> its listing on the way
    const listing = (handle) => {
        if (!listings.has(handle)) listings.set(handle, listFolder(fetchImpl, handle).finally(() => listings.delete(handle)));
        return listings.get(handle);
    };
    let active = 0;
    const waiting = [];
    const slot = () => active < PARALLEL ? (active++, Promise.resolve()) : new Promise(r => waiting.push(r));
    const release = () => { const next = waiting.shift(); if (next) next(); else active--; };

    async function fetchOne(link) {
        await slot();
        try {
            return await lookupMega(link, { fetch: fetchImpl, listing });
        } catch (e) {
            if (e instanceof MegaError && GONE.has(e.code)) return { error: 'gone' };
            return { error: 'failed' };
        } finally {
            release();
        }
    }

    async function info(url) {
        const link = parseMega(url);
        if (!link) return null;
        const hit = cache.get(link.id);
        if (hit && now() - hit.at < (hit.value.error === 'failed' ? RETRY_MS : FRESH_MS)) return hit.value;
        if (!running.has(link.id)) {
            running.set(link.id, fetchOne(link).then((value) => {
                cache.delete(link.id);
                cache.set(link.id, { at: now(), value });
                if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
                return value;
            }).finally(() => running.delete(link.id)));
        }
        return running.get(link.id);
    }
    return { info };
}

export function attachLinkInfo(app, { requireAuth, linkInfo = makeLinkInfo() }) {
    app.post('/api/link-info', requireAuth, async (req, res) => {
        const urls = (req.body || {}).urls;
        if (!Array.isArray(urls) || !urls.length || urls.length > MAX_URLS || urls.some(u => typeof u !== 'string' || u.length > 2048)) {
            return res.status(400).json({ error: `urls: 1 to ${MAX_URLS} links.` });
        }
        const info = {};
        await Promise.all([...new Set(urls)].map(async (url) => {
            const value = await linkInfo.info(url);
            if (value) info[url] = value;
        }));
        res.json({ ok: true, info });
    });
}
