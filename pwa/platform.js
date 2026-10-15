// The web app's platform: what the shared core (pwa/lib/*, byte-identical to
// the extension's src/utils/*) asks of the browser, given the shape of the
// extension API it was written against. Each shared module opens with
//
//   const api = globalThis.__tpPlatform || (typeof browser !== 'undefined' ? browser : chrome);
//
// so this module installs itself as globalThis.__tpPlatform when a page
// imports it, before the shared modules load (app.js imports it first).
//
//   storage.local get/set/remove — over IndexedDB: database 'tabpaladin',
//     store 'kv' (durableCopy.js's createKv), each set one transaction with
//     strict durability. Where IndexedDB cannot be opened at all (blocked
//     site data, a browser without it) over Cache Storage ('tp-data', which
//     no release of the worker ever drops), and failing that in memory.
//   storage.onChanged — {key: {oldValue, newValue}}, 'local': fired in this
//     page once a write has committed, and in every other page of the app
//     through the BroadcastChannel 'tp-kv'. A message that never arrives
//     costs nothing: TreeStore reads the copy from storage under its lock
//     before it acts on it (reconcile).
//   bookmarks.getTree — the browser's bookmarks, which only a helper
//     extension can read: until one stages them, an empty tree.
//
// Web Locks are used as they are (navigator.locks): TreeStore takes them
// itself. Without them (a plain-http address is not a secure context) the
// app runs in one window at a time and fences every write with that window's
// claim (setFence), so a window that lost the copy never writes over it.
//
// What only the web app needs rides on the same object: the record decorator
// (setDecorator: what is added to the working copy as it is written, so the
// previous release can still read it), hooks after each write (onWrite), the
// settings overlay (the session token lives in localStorage, never here), and
// close() for a page that is going away.

import { createKv, newId, CLAIM_KEY, claimedSince, claimRecord, DRAFT_KEY, WINDOW_DRAFTS_KEY } from './durableCopy.js';

export const KV_CHANNEL = 'tp-kv';
export const DATA_CACHE = 'tp-data';
export const CACHE_PREFIX = '/__tp_kv/';
const SETTINGS_KEY = 'settings';

const json = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function closedError() {
    const e = new Error('This page of the app has closed.');
    e.name = 'InvalidStateError';
    return e;
}

export function fencedError(holder = null) {
    const e = new Error('Another window of the app edits the copy now: nothing was written here.');
    e.name = 'FencedError';
    e.holder = holder;
    return e;
}

// --- Backends: one key-value store each --------------------------------------
//
// { kind, open(), getMany(keys) -> {key: value}, write(entries, {fence}) ->
//   {fenced, holder}, claim({id, at}) -> {claimed, holder} }. write puts every
// entry, or removes it for null/undefined, all or nothing where the store can.

export function memoryBackend(map = new Map()) {
    return {
        kind: 'memory',
        map,
        async open() {},
        async getMany(keys) {
            const out = {};
            for (const k of keys) if (map.has(k)) out[k] = json(map.get(k));
            return out;
        },
        async write(entries, { fence = null } = {}) {
            if (fence) {
                const claim = map.get(CLAIM_KEY);
                if (claimedSince(claim, fence)) return { fenced: true, holder: json(claim) };
            }
            for (const [k, v] of Object.entries(entries)) {
                if (v === null || v === undefined) map.delete(k);
                else map.set(k, json(v));
            }
            return { fenced: false, holder: null };
        },
        async claim(c) {
            const cur = map.get(CLAIM_KEY);
            if (claimedSince(cur, { ...claimRecord(c), shared: Boolean(c.shared) }) && !(Number(cur.at) > Date.now())) {
                return { claimed: false, holder: json(cur) };
            }
            map.set(CLAIM_KEY, claimRecord(c));
            return { claimed: true, holder: null };
        }
    };
}

export function idbBackend(factory) {
    const kv = createKv(factory);
    return {
        kind: 'indexeddb',
        open: () => kv.open(),
        getMany: (keys) => kv.getMany(keys),
        write: (entries, opts) => kv.write(entries, opts),
        claim: (c) => kv.claim(c)
    };
}

// One entry per key in Cache Storage. Not one transaction: each key is put
// on its own, which is what this browser offers when IndexedDB is missing.
export function cacheBackend(cacheStorage) {
    const keyOf = (k) => CACHE_PREFIX + encodeURIComponent(k);
    const open = () => cacheStorage.open(DATA_CACHE);
    async function read(c, k) {
        const hit = await c.match(keyOf(k));
        return hit ? hit.json() : undefined;
    }
    return {
        kind: 'cache',
        open: async () => { await open(); },
        async getMany(keys) {
            const c = await open();
            const out = {};
            for (const k of keys) {
                const v = await read(c, k);
                if (v !== undefined) out[k] = v;
            }
            return out;
        },
        async write(entries, { fence = null } = {}) {
            const c = await open();
            if (fence) {
                const claim = await read(c, CLAIM_KEY);
                if (claimedSince(claim, fence)) return { fenced: true, holder: claim };
            }
            for (const [k, v] of Object.entries(entries)) {
                if (v === null || v === undefined) await c.delete(keyOf(k));
                else await c.put(keyOf(k), new Response(JSON.stringify(v), { headers: { 'Content-Type': 'application/json' } }));
            }
            return { fenced: false, holder: null };
        },
        async claim(cl) {
            const c = await open();
            const cur = await read(c, CLAIM_KEY);
            if (claimedSince(cur, { ...claimRecord(cl), shared: Boolean(cl.shared) }) && !(Number(cur.at) > Date.now())) {
                return { claimed: false, holder: cur };
            }
            await c.put(keyOf(CLAIM_KEY), new Response(JSON.stringify(claimRecord(cl)), { headers: { 'Content-Type': 'application/json' } }));
            return { claimed: true, holder: null };
        }
    };
}

// IndexedDB that cannot be opened at all, as against one that opened and
// then refused a write (a full disk): only the first is a reason to keep the
// copy somewhere else.
function unopenable(e) {
    return Boolean(e) && ['NotSupportedError', 'SecurityError', 'InvalidStateError', 'UnknownError', 'NotFoundError'].includes(e.name);
}

// The working copy, and its place in line: every write of it is one more
// than the version it was written over (TreeStore's seq).
const TREE_KEY = 'tpTree';
const seqOf = (v) => (v && typeof v === 'object' ? Number(v.seq) || 0 : -1);

// Is the copy kept in Cache Storage (`aside`, written by this release when a
// full IndexedDB refused it) later than IndexedDB's (`kept`)? Further in line
// (seq) — unless IndexedDB's was written after it by the last release, after
// a step back: that release knew nothing of Cache Storage, so it went on from
// an older version than this one, and its line is behind although its copy
// is the later one (when it was written says so: savedAt).
function asideIsLater(aside, kept) {
    if (aside === undefined || aside === null) return false;
    if (kept === undefined || kept === null) return true;
    const lastRelease = typeof kept === 'object' && !(Number(kept.pwa) >= 33);
    const at = (v) => Date.parse((v && v.savedAt) || '') || 0;
    if (lastRelease && at(kept) > at(aside)) return false;
    return seqOf(aside) > seqOf(kept);
}

// What an IndexedDB store takes in from Cache Storage when it opens: what
// was kept there while IndexedDB could not be opened, or (the working copy)
// could not be written. The later working copy wins; a key IndexedDB lacks
// comes over; the live drafts and the list of set-aside copies are merged;
// anything else IndexedDB holds stays as it is.
async function foldInFromCache(b, cacheStorage) {
    if (!cacheStorage || typeof cacheStorage.open !== 'function') return { tree: false };
    let c;
    let keys;
    try {
        c = await cacheStorage.open(DATA_CACHE);
        if (typeof c.keys !== 'function') return { tree: false };
        keys = (await c.keys())
            .map(k => (typeof k === 'string' ? k : new URL(k.url).pathname))
            .filter(k => k.startsWith(CACHE_PREFIX))
            .map(k => decodeURIComponent(k.slice(CACHE_PREFIX.length)));
    } catch (e) {
        return { tree: false };
    }
    if (!keys.length) return { tree: false };
    const cached = await cacheBackend(cacheStorage).getMany(keys);
    const have = await b.getMany(keys);
    const entries = {};
    for (const k of keys) {
        const v = cached[k];
        if (v === undefined || k === CLAIM_KEY) continue;
        const cur = have[k];
        if (k === TREE_KEY) {
            if (asideIsLater(v, cur)) entries[k] = v;
        } else if ((k === DRAFT_KEY || k === WINDOW_DRAFTS_KEY) && cur && typeof cur === 'object' && v && typeof v === 'object') {
            entries[k] = { ...v, ...cur };
        } else if (k === 'tpTreeStashIndex' && Array.isArray(cur) && Array.isArray(v)) {
            entries[k] = [...cur, ...v.filter(x => !cur.includes(x))];
        } else if (cur === undefined) {
            entries[k] = v;
        }
    }
    try {
        if (Object.keys(entries).length) await b.write(entries);
    } catch (e) {
        // Not taken in: it stays where it is, and the copy is read from it
        // whenever it is the later one (see get).
        return { tree: TREE_KEY in cached };
    }
    for (const k of keys) {
        try { await c.delete(CACHE_PREFIX + encodeURIComponent(k)); } catch (e) { /* next time */ }
    }
    return { tree: false };
}

function isQuota(e) {
    if (!e) return false;
    const name = String(e.name || '');
    return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' || /quota/i.test(String(e.message || ''));
}

// --- The platform ---------------------------------------------------------------
//
// env: { indexedDB, caches, BroadcastChannel, backend (a backend to use as
//   is), session: () => ({url, token}) | null, id }

export function createPlatform(env = {}) {
    const id = env.id || newId();
    let stagedBookmarks = null;
    const listeners = new Set();
    let closed = false;
    let fence = () => null;
    // While it says so, this page reads, writes and hears nothing of the
    // store through storage.local (setGate): it lost the copy to a window
    // that writes without reading first, and what it holds stays in memory.
    let gate = () => false;
    const gated = () => {
        try { return Boolean(gate()); } catch (e) { return false; }
    };
    let decorate = null;
    const writeHooks = new Set();
    const fencedHooks = new Set();
    // Each key's value as this page last read, wrote or heard it: the
    // oldValue of the next change.
    const known = new Map();

    // Which backend: the one given, else IndexedDB, else Cache Storage, else
    // memory. Chosen at the first use and kept for the page's life.
    let chosen = null;
    // A working copy kept in Cache Storage because IndexedDB refused it (a
    // full disk) — by this window or another: read whenever it is the later
    // one, and gone once IndexedDB takes a later one again. True while one is
    // known to be there.
    let treeFallback = false;
    function backend() {
        if (!chosen) {
            chosen = (async () => {
                if (env.backend) {
                    await env.backend.open();
                    return env.backend;
                }
                const factory = env.indexedDB;
                if (factory && typeof factory.open === 'function') {
                    const b = idbBackend(factory);
                    try {
                        await b.open();
                        treeFallback = (await foldInFromCache(b, env.caches)).tree;
                        return b;
                    } catch (e) {
                        if (!unopenable(e)) throw e;
                    }
                }
                if (env.caches && typeof env.caches.open === 'function') {
                    const b = cacheBackend(env.caches);
                    try {
                        await b.open();
                        return b;
                    } catch (e) { /* none either */ }
                }
                return memoryBackend();
            })();
            chosen.catch(() => { chosen = null; });
        }
        return chosen;
    }

    let channel = null;
    const Channel = typeof env.BroadcastChannel === 'function' ? env.BroadcastChannel : null;
    if (Channel) {
        try {
            channel = new Channel(KV_CHANNEL);
            channel.onmessage = (e) => {
                const msg = e && e.data;
                if (closed || gated() || !msg || typeof msg !== 'object' || msg.from === id || !msg.changes) return;
                const changes = {};
                for (const [k, c] of Object.entries(msg.changes)) {
                    changes[k] = { oldValue: known.get(k), newValue: c ? c.newValue : undefined };
                    if (c && c.newValue !== undefined) known.set(k, c.newValue);
                    else known.delete(k);
                }
                fire(changes);
            };
            // (Node: a channel does not keep a test's process alive.)
            if (typeof channel.unref === 'function') channel.unref();
        } catch (e) {
            channel = null;
        }
    }

    // Each listener gets its own copy of what changed, as browsers hand them
    // out — made when it first looks, since most look at one key only.
    function fire(changes) {
        for (const fn of [...listeners]) {
            const own = {};
            for (const [k, c] of Object.entries(changes)) {
                const cache = {};
                own[k] = {
                    get newValue() {
                        if (!('n' in cache)) cache.n = json(c.newValue);
                        return cache.n;
                    },
                    get oldValue() {
                        if (!('o' in cache)) cache.o = json(c.oldValue);
                        return cache.o;
                    }
                };
            }
            try { fn(own, 'local'); } catch (e) { console.warn('[TabPaladin] storage listener failed', e); }
        }
    }

    function keysOf(keys) {
        if (keys === null || keys === undefined) return null;
        if (typeof keys === 'string') return [keys];
        if (Array.isArray(keys)) return keys.map(String);
        if (typeof keys === 'object') return Object.keys(keys);
        return [String(keys)];
    }

    // Settings keep the extension's shape; the session is the web app's
    // localStorage's, overlaid on read and never stored here.
    function overlay(key, value) {
        if (key !== SETTINGS_KEY || typeof env.session !== 'function') return value;
        const s = env.session();
        if (!s) return value;
        const base = value && typeof value === 'object' ? value : {};
        return { ...base, backend: { ...(base.backend || {}), url: s.url || '', token: s.token || '' } };
    }

    function strip(key, value) {
        if (key !== SETTINGS_KEY || !value || typeof value !== 'object' || !value.backend) return value;
        const { token, ...rest } = value.backend;
        return { ...value, backend: rest };
    }

    // The working copy is read from both places, whichever window put it in
    // Cache Storage: a window that kept reading IndexedDB's while another's
    // later writes went there would take the older one for another window's
    // write, and write over the later one.
    async function getMany(b, list) {
        const got = await b.getMany(list);
        if (list.includes(TREE_KEY) && b.kind === 'indexeddb' && env.caches && typeof env.caches.open === 'function') {
            try {
                const kept = (await cacheBackend(env.caches).getMany([TREE_KEY]))[TREE_KEY];
                treeFallback = kept !== undefined;
                if (asideIsLater(kept, got[TREE_KEY])) got[TREE_KEY] = kept;
            } catch (e) { /* IndexedDB's, then */ }
        }
        return got;
    }

    function gateError() {
        const e = fencedError(null);
        e.message = 'This window lost the copy to another: nothing is read or written here until it has it back.';
        return e;
    }

    async function get(keys) {
        if (closed) throw closedError();
        if (gated()) throw gateError();
        const b = await backend();
        const list = keysOf(keys);
        if (list === null) throw new Error('Listing every key is not offered here.');
        const got = await getMany(b, list);
        const out = {};
        for (const k of list) {
            if (got[k] !== undefined) {
                known.set(k, got[k]);
                out[k] = overlay(k, got[k]);
            } else if (k === SETTINGS_KEY && typeof env.session === 'function' && env.session()) {
                out[k] = overlay(k, {});
            } else if (keys && typeof keys === 'object' && !Array.isArray(keys) && keys[k] !== undefined) {
                out[k] = json(keys[k]);
            }
        }
        return out;
    }

    // The working copy, refused by a full IndexedDB, kept in Cache Storage
    // instead where that still has room. True once it is kept there.
    async function keepTreeAside(b, entries) {
        const keys = Object.keys(entries);
        if (b.kind !== 'indexeddb' || keys.length !== 1 || keys[0] !== TREE_KEY || !entries[TREE_KEY]) return false;
        if (!env.caches || typeof env.caches.open !== 'function') return false;
        try {
            await cacheBackend(env.caches).write(entries);
            treeFallback = true;
            return true;
        } catch (e) {
            return false;
        }
    }

    async function write(entries) {
        if (closed) throw closedError();
        const b = await backend();
        if (gated()) {
            const e = gateError();
            for (const fn of writeHooks) { try { fn({ entries, error: e, backend: b.kind }); } catch (x) { /* hook */ } }
            throw e;
        }
        const f = fence();
        let res;
        let aside = false;
        try {
            res = await b.write(entries, { fence: f });
        } catch (e) {
            aside = isQuota(e) && await keepTreeAside(b, entries);
            if (!aside) {
                for (const fn of writeHooks) { try { fn({ entries, error: e, backend: b.kind }); } catch (x) { /* hook */ } }
                throw e;
            }
            res = { fenced: false, holder: null };
        }
        if (res && res.fenced) {
            for (const fn of fencedHooks) { try { fn(res.holder); } catch (x) { /* hook */ } }
            throw fencedError(res.holder);
        }
        if (!aside && treeFallback && b.kind === 'indexeddb' && entries[TREE_KEY]) {
            // IndexedDB has the later copy again.
            treeFallback = false;
            try { await (await env.caches.open(DATA_CACHE)).delete(CACHE_PREFIX + encodeURIComponent(TREE_KEY)); } catch (e) { treeFallback = true; }
        }
        if (closed) return;
        const changes = {};
        for (const [k, v] of Object.entries(entries)) {
            changes[k] = { oldValue: known.get(k), newValue: v === null ? undefined : v };
            if (v === null || v === undefined) known.delete(k);
            else known.set(k, v);
        }
        for (const fn of writeHooks) { try { fn({ entries, error: null, backend: b.kind, aside }); } catch (x) { /* hook */ } }
        fire(changes);
        if (channel) {
            const msg = {};
            for (const [k, c] of Object.entries(changes)) msg[k] = { newValue: c.newValue };
            try { channel.postMessage({ from: id, changes: msg }); } catch (e) { /* closed, or too large: the next locked read has it */ }
        }
    }

    async function set(obj) {
        // As the browser does: what is set is taken as it is now.
        const entries = json(obj || {});
        for (const k of Object.keys(entries)) {
            if (decorate) entries[k] = decorate(k, entries[k]);
            entries[k] = strip(k, entries[k]);
        }
        await write(entries);
    }

    async function remove(keys) {
        const list = keysOf(keys) || [];
        await write(Object.fromEntries(list.map(k => [k, null])));
    }

    const platform = {
        id,
        storage: {
            local: { get, set, remove },
            onChanged: {
                addListener: (fn) => { listeners.add(fn); },
                removeListener: (fn) => { listeners.delete(fn); },
                hasListener: (fn) => listeners.has(fn)
            }
        },
        // Until a helper stages the browser's bookmarks, there are none.
        bookmarks: {
            async getTree() {
                return stagedBookmarks ? json(stagedBookmarks) : [{ id: '0', title: '', children: [] }];
            }
        },
        setStagedBookmarks(tree) {
            stagedBookmarks = Array.isArray(tree) ? json(tree) : null;
        },
        // Where the copy is kept: 'indexeddb', 'cache' or 'memory' (null
        // until the first use has chosen).
        async backendKind() {
            try { return (await backend()).kind; } catch (e) { return null; }
        },
        // This window's claim on the copy, for a write to check first, or
        // null where every window may write (see the header).
        setFence(fn) {
            fence = typeof fn === 'function' ? fn : () => null;
        },
        // () => true while this page may neither read nor write the store
        // through storage.local, nor hear of it (see `gate` above). getRaw,
        // putRaw and claim stay open: the page takes the copy back with them.
        setGate(fn) {
            gate = typeof fn === 'function' ? fn : () => false;
        },
        onFenced(fn) {
            fencedHooks.add(fn);
            return () => fencedHooks.delete(fn);
        },
        async claim(c) {
            if (closed) throw closedError();
            return (await backend()).claim(c);
        },
        // (key, value) -> the value written, for every set.
        setDecorator(fn) {
            decorate = typeof fn === 'function' ? fn : null;
        },
        // After every write, committed ({entries}) or refused ({entries, error}).
        onWrite(fn) {
            writeHooks.add(fn);
            return () => writeHooks.delete(fn);
        },
        // Read without the settings overlay or a listener hearing of it.
        async getRaw(keys) {
            if (closed) throw closedError();
            const b = await backend();
            return getMany(b, keysOf(keys) || []);
        },
        // Write as is: no decorator, no fence. For moving what an earlier
        // release kept into place before anything else reads it. A working
        // copy a full IndexedDB refuses goes to Cache Storage, as every write
        // of it does (keepTreeAside), with what came with it: {aside: true}.
        async putRaw(entries) {
            if (closed) throw closedError();
            const b = await backend();
            const clean = json(entries);
            try {
                return await b.write(clean);
            } catch (e) {
                if (!isQuota(e) || b.kind !== 'indexeddb' || !clean[TREE_KEY] || !env.caches || typeof env.caches.open !== 'function') throw e;
                const kept = Object.fromEntries(Object.entries(clean).filter(([, v]) => v !== null && v !== undefined));
                try {
                    await cacheBackend(env.caches).write(kept);
                } catch (x) {
                    throw e;
                }
                treeFallback = true;
                return { fenced: false, holder: null, aside: true };
            }
        },
        closed: () => closed,
        // The page is going away: nothing more is read, written or heard.
        close() {
            closed = true;
            listeners.clear();
            try { if (channel) channel.close(); } catch (e) { /* closed */ }
            channel = null;
        }
    };
    return platform;
}

// The page's platform, installed before any shared module reads it.
function install() {
    const g = globalThis;
    if (typeof g.document === 'undefined' && typeof g.window === 'undefined') return null;
    let indexedDB = null;
    try { indexedDB = g.indexedDB || null; } catch (e) { indexedDB = null; }
    const platform = createPlatform({
        indexedDB,
        caches: typeof g.caches !== 'undefined' ? g.caches : null,
        BroadcastChannel: typeof g.BroadcastChannel === 'function' ? g.BroadcastChannel : null,
        session: () => {
            try {
                const ls = g.localStorage;
                if (!ls) return null;
                const origin = g.location?.origin || '';
                const saved = ls.getItem('tp_pwa_url') || origin;
                return { url: origin, token: saved.replace(/\/+$/, '') === origin ? ls.getItem('tp_pwa_token') || '' : '' };
            } catch (e) {
                return null;
            }
        }
    });
    g.__tpPlatform = platform;
    return platform;
}

export const pagePlatform = install();
