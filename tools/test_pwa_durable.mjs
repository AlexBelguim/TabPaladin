// The web app's working copy, kept on the device (pwa/durableCopy.js, and the
// shared core's TreeStore on pwa/platform.js, wired in by pwa/app.js): first
// the module on its own, then the app in a minimal DOM against a real server,
// with in-memory stand-ins for IndexedDB, Cache Storage, Web Locks (shared and
// exclusive), BroadcastChannel and navigator.storage (Node has no IndexedDB,
// and fake-indexeddb is not a dependency).
//
// What this locks down:
//   1. The store: one transaction per write, all of it or nothing (a full
//      disk is a QuotaExceededError and writes nothing), a write fenced by
//      another window's later claim writes nothing, a database a later
//      release opened at a higher version still opens, and no IndexedDB at
//      all is said plainly.
//   2. The record keeps the extension's tpTree shape plus the web app's own
//      parts, the live draft the extension's {[page]: draft} map, and a draft
//      comes back only with its own account's copy. Which kept copy a start
//      takes: IndexedDB's, tp-data's when it is newer (a step back) or the
//      only one (the first start: seeded), and none — set aside — when the
//      previous release cleared tp-data after this one last wrote it.
//   3. One window edits (the guard, where Web Locks are missing, and the last
//      release's windows): a second waits, then says so; 'Use here' has the
//      holder write down and let go; a holder that cannot write refuses; a
//      slow writer is waited for; a frozen one is robbed and hears it; with
//      no Web Locks a BroadcastChannel stands in, and a window that edited
//      while another was frozen makes that one stop when it wakes.
//   4. persist(): granted, declined, failing, or not offered.
//   5. The first start of this release, from what the last one kept in
//      tp-data: a dirty copy with a half-written note comes back without a
//      pull, goes into IndexedDB as TreeStore's record, the note back in its
//      editor, and tp-data keeps being written beside it.
//   6. A reload (no hide, no pagehide: the app killed) keeps unpushed edits
//      and the note being typed, from IndexedDB, over an older tp-data.
//   7. A step back and forward again: tp-data written later by the previous
//      release wins; a copy the previous release cleared is not offered
//      again as unpushed edits, and is set aside rather than lost.
//   8. Two windows (Web Locks): each edits the one copy and hears the other —
//      an edit in one is drawn in the other as it lands, never under a note
//      being typed, and both are kept; another window bringing another
//      account's copy in parks the note open here for its account, sets the
//      copy aside, and both come back with it. A window of the last release
//      that edits is asked to write down and let go before this one edits,
//      and its later writes are fenced; one that cannot write keeps the copy
//      (this one says so, and Use here asks again); one starting later waits
//      and is refused the copy.
//   9. Accounts: a copy kept over a sign-out comes back for its account
//      only; someone else signing in sets it aside, never over it; a clean
//      sign-out leaves nobody's copy on the device; a copy the last release
//      kept for another account, with that account's note, is set aside and
//      parked at the start, never drawn, and comes back, note and all, when
//      that account signs in.
//  10. Storage trouble: a full disk says so once, keeps the edits in the
//      window (closing asks first, freezing lets go of nothing), and the next
//      write that fits keeps them and clears the warning; a write that failed
//      here while another window wrote keeps both; IndexedDB full but Cache
//      Storage not keeps the copy there, unwarned, and the next start takes it
//      back into IndexedDB; without IndexedDB the app keeps the copy in Cache
//      Storage (and tp-data) as before; Settings › Storage shows where the
//      copy is and whether the browser may clear it, and 'Keep my data on
//      this phone' asks from the click and says what the browser answered.
//  11. Without Web Locks, losing the copy part-way: a start that hands the
//      copy over stops (no pull, no question behind the card); Use here asked
//      again while it claims stays behind the card; a window robbed while a
//      dialog held it up pushes nothing and writes nothing; an import link
//      arriving while the window comes back from being away is opened, or
//      brings the copy back with it.
//  12. A clear that did not reach IndexedDB never brings that copy back at the
//      next start; a copy set aside is discarded only from Settings, with its
//      name typed, and then stays gone.
//  13. Without Web Locks (a plain-http address): two windows that claimed at
//      once never both write; one back after another claimed the copy and
//      closed starts again from what is kept; back with nobody having
//      claimed it, it edits on in place.
//  14. The upgrade from the last release with everything it kept in
//      IndexedDB — a dirty copy, a half-written note of a window that is gone,
//      a note a sign-out set aside, an import link held by the copy, another
//      account's set-aside copy with its note — comes through whole, without
//      a pull; and a step back to the last release (its fromKvRecord and
//      chooseKept, over IndexedDB and tp-data) finds the same copy, link and
//      notes.
//  15. A push of a copy that is another account's (412) is never forced and
//      never pulled over: Cancel changes nothing, OK sets it aside and pulls
//      this account's tree.
//
// Run: node tools/test_pwa_durable.mjs [--port 18987]

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
const PORT = Number(arg('port') || 18987);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'correct horse battery';

let failures = 0;
function check(name, cond, detail) {
    if (cond) console.log(`  ok  ${name}`);
    else { failures++; console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// When anything the app waits on last moved: the network, IndexedDB, Cache
// Storage. settle() waits for all of it to be quiet: a start works through
// IndexedDB and Cache Storage before its first request.
let lastActivity = Date.now();
const touch = () => { lastActivity = Date.now(); };
async function until(cond, ms = 6000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await cond()) return true;
        await sleep(25);
    }
    return Boolean(await cond());
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- Stand-ins ---------------------------------------------------------------------

// IndexedDB, as much of it as a key-value store uses: databases with versions
// and an upgrade step, object stores of out-of-line keys, and transactions
// that run one at a time, see their own writes, and commit all or nothing.
// `ctl.quotaFull` makes every write's commit fail as a full disk does;
// `ctl.failOpen` makes opening fail; `ctl.delay` holds every transaction up
// that many ms, as a busy disk does.
function makeFakeIndexedDB() {
    const dbs = new Map();
    const ctl = { quotaFull: false, failOpen: null, commits: 0, delay: 0 };
    const conns = new Set();
    let line = Promise.resolve();
    const err = (name, message = name) => Object.assign(new Error(message), { name });
    const soon = (fn) => setTimeout(fn, 0);

    function open(name, version) {
        const req = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
        touch();
        soon(() => {
            touch();
            if (ctl.failOpen) {
                req.error = err(ctl.failOpen);
                if (req.onerror) req.onerror({ target: req });
                return;
            }
            const rec = dbs.get(name) || { version: 0, stores: new Map() };
            const target = version === undefined ? Math.max(1, rec.version) : version;
            if (target < rec.version) {
                req.error = err('VersionError');
                if (req.onerror) req.onerror({ target: req });
                return;
            }
            dbs.set(name, rec);
            const conn = connection(name, rec);
            req.result = conn;
            if (target > rec.version) {
                for (const c of conns) if (c !== conn && c.name === name && !c.closed && c.onversionchange) c.onversionchange({});
                rec.version = target;
                conn.version = target;
                conn.upgrading = true;
                try { if (req.onupgradeneeded) req.onupgradeneeded({ target: req }); } finally { conn.upgrading = false; }
            }
            if (req.onsuccess) req.onsuccess({ target: req });
        });
        return req;
    }

    function connection(name, rec) {
        const conn = {
            name, version: rec.version, closed: false, upgrading: false, onversionchange: null, onclose: null,
            createObjectStore(n) {
                if (!conn.upgrading) throw err('InvalidStateError');
                rec.stores.set(n, new Map());
                return {};
            },
            close() { conn.closed = true; conns.delete(conn); },
            transaction(storeName, mode = 'readonly') {
                if (conn.closed) throw err('InvalidStateError', 'The database connection is closing.');
                if (!rec.stores.has(storeName)) throw err('NotFoundError');
                return transaction(rec.stores.get(storeName), mode);
            }
        };
        Object.defineProperty(conn, 'objectStoreNames', { get: () => ({ contains: (n) => rec.stores.has(n), length: rec.stores.size }) });
        conns.add(conn);
        return conn;
    }

    function transaction(data, mode) {
        const tx = { mode, error: null, oncomplete: null, onabort: null, onerror: null };
        const pending = [];
        const overlay = new Map();
        let finished = false;
        const read = (k) => {
            if (overlay.has(k)) { const o = overlay.get(k); return o.deleted ? undefined : structuredClone(o.value); }
            return data.has(k) ? structuredClone(data.get(k)) : undefined;
        };
        const request = (op) => {
            if (finished) throw err('TransactionInactiveError');
            const req = { result: undefined, error: null, onsuccess: null, onerror: null };
            pending.push({ op, req });
            return req;
        };
        const store = {
            get: (k) => request(() => read(k)),
            put: (v, k) => {
                if (mode !== 'readwrite') throw err('ReadOnlyError');
                const c = structuredClone(v);
                return request(() => { overlay.set(k, { value: c }); return k; });
            },
            delete: (k) => {
                if (mode !== 'readwrite') throw err('ReadOnlyError');
                return request(() => { overlay.set(k, { deleted: true }); });
            }
        };
        const abortNow = (e) => {
            if (finished) return;
            finished = true;
            tx.error = e || null;
            if (tx.onabort) tx.onabort({ target: tx });
        };
        tx.objectStore = () => store;
        tx.abort = () => abortNow(null);
        touch();
        line = line.then(() => new Promise((resolve) => setTimeout(async () => {
            touch();
            try {
                while (pending.length && !finished) {
                    const { op, req } = pending.shift();
                    req.result = op();
                    try { if (req.onsuccess) req.onsuccess({ target: req }); } catch (e) { abortNow(e); }
                    await null;
                }
                if (finished) return;
                if (mode === 'readwrite' && overlay.size) {
                    if (ctl.quotaFull) { abortNow(err('QuotaExceededError', 'The quota has been exceeded.')); return; }
                    for (const [k, o] of overlay) { if (o.deleted) data.delete(k); else data.set(k, o.value); }
                    ctl.commits++;
                }
                finished = true;
                if (tx.oncomplete) tx.oncomplete({ target: tx });
            } finally {
                touch();
                resolve();
            }
        }, ctl.delay || 0)));
        return tx;
    }

    const storeOf = (db, s) => dbs.get(db) && dbs.get(db).stores.get(s);
    return {
        factory: { open },
        ctl,
        peek: (key, db = 'tabpaladin', s = 'kv') => { const m = storeOf(db, s); return m && m.has(key) ? structuredClone(m.get(key)) : undefined; },
        poke: (key, value, db = 'tabpaladin', s = 'kv') => { storeOf(db, s).set(key, structuredClone(value)); },
        keys: (db = 'tabpaladin', s = 'kv') => [...((storeOf(db, s) || new Map()).keys())],
        version: (db = 'tabpaladin') => (dbs.get(db) || { version: 0 }).version,
        stores: (db = 'tabpaladin') => [...((dbs.get(db) || { stores: new Map() }).stores.keys())]
    };
}

// Web Locks for several windows: each window asks through its own facade, and
// a window that goes away (closeTag) lets go of what it held, with nobody
// told, as a closed page does. Exclusive and shared, as browsers have them:
// this release's windows hold 'tp-primary' together (shared), the last
// release's alone; a steal takes it from every holder.
function makeLockHub() {
    const held = new Map();   // name -> [{ tag, mode, done, reject }]
    const queues = new Map(); // name -> [request]
    const abortErr = (m = 'aborted') => Object.assign(new Error(m), { name: 'AbortError' });
    const queue = (name) => queues.get(name) || (queues.set(name, []), queues.get(name));
    const holding = (name) => held.get(name) || [];
    const canGrant = (name, mode) => {
        const h = holding(name);
        if (!h.length) return true;
        return mode === 'shared' && h.every(e => e.mode === 'shared');
    };

    function grant(name, r) {
        const entry = { tag: r.tag, mode: r.mode, done: false, reject: r.reject };
        held.set(name, [...holding(name), entry]);
        r.granted = true;
        queueMicrotask(() => {
            let ret;
            try { ret = r.cb({ name, mode: r.mode }); } catch (e) { finish(e, true); return; }
            Promise.resolve(ret).then(v => finish(v, false), e => finish(e, true));
        });
        function finish(v, failed) {
            if (entry.done) return;
            entry.done = true;
            release(name, entry);
            if (failed) r.reject(v); else r.resolve(v);
        }
    }
    function release(name, entry) {
        const left = holding(name).filter(e => e !== entry);
        if (left.length) held.set(name, left);
        else held.delete(name);
        next(name);
    }
    function next(name) {
        const q = queue(name);
        while (q.length) {
            const r = q[0];
            if (r.aborted) { q.shift(); continue; }
            if (!canGrant(name, r.mode)) return;
            q.shift();
            grant(name, r);
            if (r.mode !== 'shared') return;
        }
    }
    function forTag(tag) {
        return {
            request(name, opts, cb) {
                if (typeof opts === 'function') { cb = opts; opts = {}; }
                const mode = opts.mode === 'shared' ? 'shared' : 'exclusive';
                return new Promise((resolve, reject) => {
                    const r = { tag, cb, mode, resolve, reject, aborted: false, granted: false };
                    if (opts.steal) {
                        for (const cur of holding(name)) {
                            cur.done = true;
                            cur.reject(abortErr('The lock was stolen'));
                        }
                        held.delete(name);
                        grant(name, r);
                        return;
                    }
                    if (opts.ifAvailable) {
                        if (!canGrant(name, mode) || queue(name).length) {
                            queueMicrotask(() => {
                                let v;
                                try { v = cb(null); } catch (e) { reject(e); return; }
                                Promise.resolve(v).then(resolve, reject);
                            });
                            return;
                        }
                        grant(name, r);
                        return;
                    }
                    if (opts.signal) {
                        if (opts.signal.aborted) { reject(abortErr()); return; }
                        opts.signal.addEventListener('abort', () => {
                            if (r.granted) return;
                            r.aborted = true;
                            const q = queue(name);
                            const i = q.indexOf(r);
                            if (i >= 0) q.splice(i, 1);
                            reject(abortErr());
                        });
                    }
                    if (canGrant(name, mode) && !queue(name).length) grant(name, r);
                    else queue(name).push(r);
                });
            },
            // As browsers report it: who holds what, and who waits.
            async query() {
                const held2 = [];
                for (const [name, list] of held) for (const e of list) held2.push({ name, mode: e.mode, clientId: e.tag });
                const pending = [];
                for (const [name, q] of queues) for (const r of q) if (!r.aborted) pending.push({ name, mode: r.mode, clientId: r.tag });
                return { held: held2, pending };
            }
        };
    }
    function closeTag(tag) {
        for (const [name, q] of queues) queues.set(name, q.filter(r => r.tag !== tag));
        for (const [name, list] of [...held]) {
            for (const e of list) {
                if (e.tag !== tag) continue;
                e.done = true;
                release(name, e);
            }
        }
    }
    // The tag holding a lock alone, or the first of those holding it
    // together; and all of them.
    const holder = (name = 'tp-primary') => (holding(name)[0] || {}).tag || null;
    const holders = (name = 'tp-primary') => holding(name).map(e => e.tag);
    return { forTag, closeTag, holder, holders };
}

// BroadcastChannel for several windows. A frozen window gets nothing.
function makeChannelHub() {
    const open = new Set();
    const frozen = new Set();
    function classFor(tag) {
        return class FakeChannel {
            constructor(name) { this.name = name; this.tag = tag; this.onmessage = null; this.closed = false; open.add(this); }
            postMessage(data) {
                if (this.closed) throw new Error('closed');
                const msg = structuredClone(data);
                for (const c of open) {
                    if (c === this || c.name !== this.name || c.closed || frozen.has(c.tag)) continue;
                    setTimeout(() => { if (!c.closed && !frozen.has(c.tag) && c.onmessage) c.onmessage({ data: msg }); }, 0);
                }
            }
            close() { this.closed = true; open.delete(this); }
        };
    }
    return {
        classFor,
        closeTag: (tag) => { for (const c of [...open]) if (c.tag === tag) c.close(); },
        freeze: (tag, on = true) => { if (on) frozen.add(tag); else frozen.delete(tag); }
    };
}

// navigator.storage, with the browser's answer to persist() set by the test.
function makeStorageManager() {
    const sm = {
        answer: 'no',      // 'yes' | 'no' | 'throw'
        persistedNow: false,
        asked: 0,
        async persisted() { return sm.persistedNow; },
        async persist() {
            sm.asked++;
            if (sm.answer === 'throw') throw new Error('Permission dismissed');
            if (sm.answer === 'yes') sm.persistedNow = true;
            return sm.persistedNow;
        },
        async estimate() { return { usage: 3 * 1024 * 1024, quota: 2 * 1024 * 1024 * 1024 }; }
    };
    return sm;
}

const DC = await import(pathToFileURL(path.join(REPO, 'pwa', 'durableCopy.js')).href);
const Platform = await import(pathToFileURL(path.join(REPO, 'pwa', 'platform.js')).href);

// =====================================================================================
// Part one: durableCopy.js on its own
// =====================================================================================

console.log('\n1. The store');
{
    const idb = makeFakeIndexedDB();
    const kv = DC.createKv(idb.factory);
    await kv.write({ a: { x: 1 }, b: [1, 2] });
    check('a write puts every entry, and a read gets them back', same(await kv.get('a'), { x: 1 })
        && same(await kv.getMany(['a', 'b', 'c']), { a: { x: 1 }, b: [1, 2], c: undefined }));
    await kv.write({ a: null });
    check('null deletes', (await kv.get('a')) === undefined && same(await kv.get('b'), [1, 2]));
    check('the database is tabpaladin, the store kv', idb.stores().includes('kv') && idb.version() === 1);

    idb.ctl.quotaFull = true;
    let full = null;
    try { await kv.write({ a: 'new', b: 'new' }); } catch (e) { full = e; }
    idb.ctl.quotaFull = false;
    check('a full disk rejects with QuotaExceededError, and writes nothing of it', full && full.name === 'QuotaExceededError'
        && DC.isQuotaError(full) && (await kv.get('a')) === undefined && same(await kv.get('b'), [1, 2]), String(full));

    await kv.claim({ id: 'w1', at: 1000 });
    const own = await kv.write({ t: 1 }, { fence: { id: 'w1', at: 1000 } });
    await kv.claim({ id: 'w2', at: 2000 });
    const fenced = await kv.write({ t: 2 }, { fence: { id: 'w1', at: 1000 } });
    check('a window writes under its own claim', !own.fenced);
    check('and writes nothing once another has claimed the copy since', fenced.fenced && fenced.holder.id === 'w2' && (await kv.get('t')) === 1);
    const newer = await kv.write({ t: 3 }, { fence: { id: 'w3', at: 3000 } });
    check('an older claim (one this window could not write over) does not stop it', !newer.fenced && (await kv.get('t')) === 3);

    // Two windows claimed at once (no Web Locks): the later claim committed
    // first. The earlier one, committing last, does not replace it.
    const idbC = makeFakeIndexedDB();
    const kc = DC.createKv(idbC.factory);
    const late = await kc.claim({ id: 'late', at: 5000 });
    const early = await kc.claim({ id: 'early', at: 4000 });
    check('a claim never replaces one another window made since: it says so, and writes nothing', late.claimed && !early.claimed
        && early.holder && early.holder.id === 'late' && (await kc.get('tpPrimary')).id === 'late', JSON.stringify({ late, early }));
    const wLate = await kc.write({ x: 1 }, { fence: { id: 'late', at: 5000 } });
    const wEarly = await kc.write({ x: 2 }, { fence: { id: 'early', at: 4000 } });
    check('  so of two windows that claimed at once, only one writes', !wLate.fenced && wEarly.fenced && (await kc.get('x')) === 1);
    check('  a later claim takes over as before', (await kc.claim({ id: 'early', at: 6000 })).claimed && (await kc.get('tpPrimary')).id === 'early');
    idbC.poke('tpPrimary', { id: 'future', at: Date.now() + 3600e3 });
    check('  and one from the future (the clock set back since) does not stand in the way',
        (await kc.claim({ id: 'now', at: Date.now() })).claimed && (await kc.get('tpPrimary')).id === 'now');

    let missing = null;
    try { await DC.createKv(undefined).get('a'); } catch (e) { missing = e; }
    check('no IndexedDB at all is said plainly', missing && missing.name === 'NotSupportedError');
    idb.ctl.failOpen = 'SecurityError';
    let refused = null;
    try { await DC.createKv(idb.factory).get('a'); } catch (e) { refused = e; }
    idb.ctl.failOpen = null;
    check('an IndexedDB that will not open is said too', refused && refused.name === 'SecurityError');

    // A later release opened the database at a higher version, with a store
    // of its own: this one still opens it, and adds its store when missing.
    const idb2 = makeFakeIndexedDB();
    const later = DC.createKv(idb2.factory, { store: 'moves' });
    await later.write({ m: 1 });
    const mine = DC.createKv(idb2.factory);
    await mine.write({ k: 'v' });
    check('a database without the kv store gets it, at a version of its own', idb2.version() === 2
        && idb2.stores().includes('kv') && idb2.peek('m', 'tabpaladin', 'moves') === 1 && (await mine.get('k')) === 'v');
    await new Promise((resolve) => {
        const req = idb2.factory.open('tabpaladin', 5);
        req.onupgradeneeded = () => req.result.createObjectStore('later');
        req.onsuccess = () => resolve();
    });
    check('one a later release opened at version 5 still opens, and its data stays', (await DC.createKv(idb2.factory).get('k')) === 'v');
}

console.log('\n2. The record');
{
    const account = { url: 'https://sync.example/', userId: 1, username: 'alex', serverId: 'srv-1' };
    const nv = { pane: 'note', scope: 'all', noteId: null, editing: true, isNew: true, newParentId: 'nb1', draft: '# Hi\n\nHALF', loaded: '' };
    const tp = {
        v: 1, savedAt: '2026-10-13T10:00:00.000Z', account,
        roots: [{ id: 'r', kind: 'folder', title: 'Bookmarks', role: 'bookmarks', children: [] }],
        version: 7, dirty: true, editCount: 2, importIds: ['imp'], serverIds: ['r'], nv, keptDraft: null, pathIds: ['r']
    };
    const rec = DC.toKvRecord(tp, { copyId: 'c1', seq: 4, lastSyncAt: 'L', lastSyncKind: 'pull' });
    check('the IndexedDB record has the extension\'s tpTree shape', rec.baseVersion === 7 && rec.dirty === true && rec.editCount === 2
        && same(rec.owner, { url: 'https://sync.example', userId: 1, username: 'alex', serverId: 'srv-1' }) && rec.origin === null
        && rec.copyId === 'c1' && rec.seq === 4 && typeof rec.rev === 'string' && Array.isArray(rec.restoredFrom)
        && rec.lastSyncAt === 'L' && rec.lastSyncKind === 'pull' && same(rec.roots, tp.roots), JSON.stringify(rec));
    check('  plus the web app\'s own parts, and no editor of its own', same(rec.importIds, ['imp']) && same(rec.serverIds, ['r'])
        && same(rec.pathIds, ['r']) && rec.savedAt === tp.savedAt && !('nv' in rec));
    const drafts = DC.liveDraftsFor(nv, account, 'page-1', 'AT');
    const d = drafts['page-1'];
    check('the live draft is the extension\'s map by page', Object.keys(drafts).length === 1 && d.content === '# Hi\n\nHALF'
        && d.owner.username === 'alex' && d.noteId === null && d.notebookId === 'nb1' && d.loaded.content === '' && d.at === 'AT');
    check('no open note, no draft', DC.liveDraftsFor(null, account, 'p') === null && DC.liveDraftsFor({ editing: false }, account, 'p') === null);
    const back = DC.fromKvRecord(rec, drafts);
    check('read back as the app keeps a copy, with its note', back.v === 1 && back.version === 7 && back.dirty && back.editCount === 2
        && back.account.userId === 1 && back.nv && back.nv.draft === '# Hi\n\nHALF' && back.nv.editing && back.copyId === 'c1' && back.seq === 4);
    const sams = DC.liveDraftsFor(nv, { ...account, userId: 2, username: 'sam' }, 'page-2');
    check('a draft written for another account\'s copy does not come back with this one', DC.fromKvRecord(rec, sams).nv === null);
    const two = { a: { owner: rec.owner, at: '2026-01-01', content: 'old' }, b: { owner: rec.owner, at: '2026-02-01', content: 'new' } };
    check('the newest of two drafts', DC.newestDraft(two, rec.owner).content === 'new');
    const extOnly = DC.fromKvRecord(rec, { x: { owner: rec.owner, noteId: 'n1', content: 'FROM THE EXTENSION', loaded: { content: 'was' }, at: 'A' } });
    check('a draft without the app\'s editor state comes back from the extension\'s fields',
        extOnly.nv.noteId === 'n1' && extOnly.nv.draft === 'FROM THE EXTENSION' && extOnly.nv.loaded === 'was' && !extOnly.nv.isNew);

    const kvOld = { ...back, savedAt: '2026-10-13T10:00:00.000Z' };
    const tpNew = { ...tp, savedAt: '2026-10-13T11:00:00.000Z' };
    let p = DC.chooseKept({ kv: kvOld, tp: tpNew });
    check('tp-data written later (a step back) is taken, and seeds IndexedDB', p.from === 'tp-data' && p.seed && p.rec === tpNew);
    p = DC.chooseKept({ kv: { ...back, savedAt: '2026-10-13T12:00:00.000Z' }, tp: tpNew });
    check('otherwise IndexedDB\'s', p.from === 'kv' && !p.seed);
    p = DC.chooseKept({ kv: { ...back, savedAt: null }, tp: tpNew });
    check('a record that cannot say when it was written is not beaten by tp-data', p.from === 'kv');
    p = DC.chooseKept({ kv: null, tp });
    check('tp-data alone (the first start) is taken and seeds IndexedDB', p.from === 'tp-data' && p.seed);
    p = DC.chooseKept({ kv: back, tp: null, tpWrittenAt: 'something older' });
    check('IndexedDB alone is taken', p.from === 'kv' && !p.drop);
    p = DC.chooseKept({ kv: back, tp: null, tpWrittenAt: back.savedAt });
    check('tp-data gone after this release wrote it with that very record: none, set aside', p.rec === null && p.drop);
    const st = DC.stashEntry(rec, drafts, ['tpTreeStash:https://sync.example|1'], 1234);
    check('  as a set-aside copy in the shared core\'s format', st.key === 'tpTreeStash:https://sync.example|1#1234'
        && st.value.dirty && same(st.value.roots, rec.roots) && st.value.owner.userId === 1 && st.value.liveDrafts === drafts
        && Array.isArray(st.value.pendingRemovals) && typeof st.value.setAsideAt === 'string');
    check('nothing kept, nothing taken', DC.chooseKept({ kv: null, tp: null }).rec === null);

    // A clear one of the two places refused: what either kept up to it was
    // cleared, and never comes back.
    const clearedAt = '2026-10-13T10:30:00.000Z';
    p = DC.chooseKept({ kv: kvOld, tp: null, clearedAt });
    check('a clear IndexedDB refused: what it kept up to then does not come back', p.rec === null && !p.drop);
    p = DC.chooseKept({ kv: null, tp: { ...tp, savedAt: '2026-10-13T10:00:00.000Z' }, clearedAt });
    check('  nor what tp-data kept, when it refused', p.rec === null);
    p = DC.chooseKept({ kv: kvOld, tp: tpNew, clearedAt });
    check('  what was kept after it does', p.rec === tpNew && p.from === 'tp-data' && p.seed);
    p = DC.chooseKept({ kv: { ...back, savedAt: '2026-10-13T12:00:00.000Z' }, tp: { ...tp, savedAt: '2026-10-13T10:00:00.000Z' }, clearedAt });
    check('  from IndexedDB too', p.from === 'kv' && p.rec.savedAt === '2026-10-13T12:00:00.000Z');
    check('  and a record that cannot say when it was written counts as cleared', DC.chooseKept({ kv: { ...back, savedAt: null }, tp: null, clearedAt }).rec === null);
}

const W = { probe: 200, grace: 200, answer: 400, busy: 3000 };
function makeGuard(hub, bc, tag, { secure = true, locks = true } = {}) {
    const events = [];
    const g = DC.createPrimaryGuard({
        locks: locks ? hub.forTag(tag) : null,
        BroadcastChannel: bc.classFor(tag),
        secure,
        id: tag,
        waitMs: W,
        onYield: () => { events.push('yield'); return g.answer(); },
        onYielded: () => events.push('yielded'),
        onLost: (why) => events.push('lost:' + why)
    });
    g.events = events;
    g.answer = async () => true;
    return g;
}

console.log('\n3. One window edits');
{
    const hub = makeLockHub();
    const bc = makeChannelHub();
    const g1 = makeGuard(hub, bc, 'g1');
    check('the first window edits (Web Locks)', g1.mode === 'locks' && (await g1.start()) === 'primary' && g1.isPrimary() && hub.holder() === 'g1');
    const g2 = makeGuard(hub, bc, 'g2');
    const t2 = Date.now();
    check('a second waits a moment for a page being replaced, then does not', (await g2.start()) === 'secondary'
        && Date.now() - t2 >= W.grace - 30 && !g2.isPrimary());
    let r = await g2.take();
    check('Use here: the first writes down and lets go, and the second edits', r.ok && r.how === 'yielded' && g2.isPrimary()
        && !g1.isPrimary() && g1.events.join() === 'yield,yielded' && hub.holder() === 'g2', JSON.stringify({ r, ev: g1.events }));

    const g3 = makeGuard(hub, bc, 'g3');
    g2.answer = async () => false;
    r = await g3.take();
    check('a holder that cannot write what it has refuses, and keeps the copy', !r.ok && r.how === 'refused' && g2.isPrimary()
        && !g3.isPrimary() && hub.holder() === 'g2', JSON.stringify(r));
    g2.answer = async () => ({ ok: false, reason: 'foreign' });
    r = await g3.take();
    check('  and can say why', !r.ok && r.how === 'refused' && r.reason === 'foreign' && g3.lastTake() === r, JSON.stringify(r));
    check('  while a window that only looks whether it is free never asks it', !(await g3.takeIfFree()) && g2.isPrimary()
        && g2.events.filter(e => e === 'yield').length === 2);
    g2.answer = () => sleep(W.answer * 3).then(() => true);
    const t3 = Date.now();
    r = await g3.take();
    check('a slow writer is waited for, never cut short', r.ok && r.how === 'yielded' && Date.now() - t3 >= W.answer * 3 - 30
        && !g2.events.some(e => e.startsWith('lost')) && hub.holder() === 'g3', JSON.stringify({ r, ev: g2.events }));

    bc.freeze('g3');
    const g4 = makeGuard(hub, bc, 'g4');
    r = await g4.take();
    await sleep(10);
    check('a holder that never answers (frozen) is taken from, and hears it', r.ok && r.how === 'taken' && g4.isPrimary()
        && !g3.isPrimary() && g3.events.includes('lost:stolen') && hub.holder() === 'g4', JSON.stringify({ r, ev: g3.events }));
    bc.freeze('g3', false);

    const g5 = makeGuard(hub, bc, 'g5');
    check('a window opened with work in it takes over at start', (await g5.start({ take: true })) === 'primary' && !g4.isPrimary());
    g5.lost('fenced');
    await sleep(0);
    check('a window whose write met a later claim stops, and lets go', !g5.isPrimary() && g5.events.includes('lost:fenced') && hub.holder() === null);
    const g6 = makeGuard(hub, bc, 'g6');
    check('  so the next one edits at once', (await g6.start()) === 'primary');
    const g7 = makeGuard(hub, bc, 'g7');
    check('(a second window waits)', (await g7.start()) === 'secondary');
    hub.closeTag('g6');
    check('a window that goes away lets go of the lock: the one waiting edits once it looks', await g7.takeIfFree()
        && g7.isPrimary() && hub.holder() === 'g7');
    for (const g of [g1, g2, g3, g4, g5, g6, g7]) g.close();

    // No Web Locks: not a secure context.
    const c1 = makeGuard(hub, bc, 'c1', { secure: false, locks: false });
    check('without Web Locks a BroadcastChannel stands in, and the first window edits', c1.mode === 'channel' && (await c1.start()) === 'primary');
    const c2 = makeGuard(hub, bc, 'c2', { secure: false, locks: false });
    check('  a second is told one edits', (await c2.start()) === 'secondary');
    r = await c2.take();
    check('  Use here: the first writes down and lets go', r.ok && r.how === 'yielded' && c2.isPrimary() && !c1.isPrimary()
        && c1.events.join() === 'yield,yielded');
    bc.freeze('c2');
    const c3 = makeGuard(hub, bc, 'c3', { secure: false, locks: false });
    check('  a window starting while the one editing is frozen edits', (await c3.start()) === 'primary');
    bc.freeze('c2', false);
    await c2.recheck();
    check('  and the frozen one stops when it wakes', !c2.isPrimary() && c2.events.includes('lost:superseded') && c3.isPrimary());
    check('  and does not edit again while that one does', !(await c2.takeIfFree()));
    c3.close();
    check('  but does once it is gone', await c2.takeIfFree());
    for (const g of [c1, c2, c3]) g.close();

    // Two windows starting at the same moment, each asking while the other
    // does: one edits, never both — the lower id, whichever asked first.
    for (const [first, second] of [['c4', 'c5'], ['c7', 'c6']]) {
        const a = makeGuard(hub, bc, first, { secure: false, locks: false });
        const pa = a.start();
        await sleep(W.probe / 2);
        const b = makeGuard(hub, bc, second, { secure: false, locks: false });
        const pb = b.start();
        const roles = [await pa, await pb];
        const winner = [first, second].sort()[0];
        check(`  two windows starting at once (${first} asking first): one edits, never both`, roles.filter(r => r === 'primary').length === 1
            && a.isPrimary() !== b.isPrimary() && (a.isPrimary() ? first : second) === winner, JSON.stringify(roles));
        a.close();
        b.close();
    }
    // Two behind the card, looking at once whether they may edit: one does.
    const d0 = makeGuard(hub, bc, 'd0', { secure: false, locks: false });
    await d0.start();
    const d1 = makeGuard(hub, bc, 'd1', { secure: false, locks: false });
    const d2 = makeGuard(hub, bc, 'd2', { secure: false, locks: false });
    check('  (two windows wait behind the card)', (await d1.start()) === 'secondary' && (await d2.start()) === 'secondary');
    d0.close();
    const looks = await Promise.all([d2.takeIfFree(), d1.takeIfFree()]);
    check('  the one editing gone, two looking at once: one edits', looks.filter(Boolean).length === 1 && d1.isPrimary() && !d2.isPrimary(),
        JSON.stringify(looks));
    // One opened with work in it, starting while another asks at the same
    // moment: it waits for that one to edit, then has it let go.
    const e8 = makeGuard(hub, bc, 'e1', { secure: false, locks: false });
    d1.close();
    d2.close();
    const pe8 = e8.start();
    await sleep(W.probe / 2);
    const e9 = makeGuard(hub, bc, 'e2', { secure: false, locks: false });
    const r9 = await e9.start({ take: true });
    await pe8;
    check('  one opened with work in it, starting as another does: that one edits first, then lets go to it', r9 === 'primary'
        && e9.isPrimary() && !e8.isPrimary() && e8.events.join() === 'yield,yielded', JSON.stringify({ r9, ev: e8.events }));
    for (const g of [e8, e9]) g.close();

    const none = DC.createPrimaryGuard({ locks: null, BroadcastChannel: bc.classFor('n'), id: 'n', onYield: async () => true });
    check('neither (an old browser, or no secure-context answer): every window edits, unfenced', none.mode === 'none'
        && none.isPrimary() && none.fence() === null && (await none.start()) === 'primary');
}

console.log('\n4. persist()');
{
    const sm = makeStorageManager();
    let s = await DC.storageStatus(sm);
    check('the status: offered, not persisted, and what is used', s.supported && s.persisted === false && s.usage === 3 * 1024 * 1024);
    check('declined', same(await DC.askPersist(sm), { ok: false, how: 'declined' }));
    sm.answer = 'throw';
    const failed = await DC.askPersist(sm);
    check('failing', !failed.ok && failed.how === 'error' && /dismissed/.test(failed.error.message));
    sm.answer = 'yes';
    check('granted', same(await DC.askPersist(sm), { ok: true, how: 'granted' }) && (await DC.storageStatus(sm)).persisted === true);
    check('not offered', same(await DC.askPersist(null), { ok: false, how: 'unsupported' }) && !(await DC.storageStatus(undefined)).supported
        && same(await DC.askPersist({}), { ok: false, how: 'unsupported' }));
}

// =====================================================================================
// Part two: the app
// =====================================================================================

// --- A permissive DOM (as in test_share_pwa.mjs) -------------------------------------

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
        id, tagName: tag.toUpperCase(), style: { setProperty() {}, removeProperty() {}, getPropertyValue() { return ''; } }, dataset: {}, children: [],
        value: '', textContent: '', innerHTML: '', checked: false, disabled: false, title: '', href: '', open: false, offsetHeight: 0, scrollTop: 0,
        className: '', classList: classList(),
        addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
        removeEventListener() {},
        async fire(ev, extra = {}) {
            const event = { preventDefault() {}, stopPropagation() {}, target: el, key: '', ...extra };
            await Promise.all((listeners[ev] || []).map(fn => fn(event)));
        },
        appendChild(c) { el.children.push(c); return c; },
        insertBefore(c) { return c; },
        append(...c) { el.children.push(...c); }, prepend() {}, remove() {}, replaceWith() {}, replaceChildren() {}, insertAdjacentHTML() {},
        _qs: {},
        querySelector(sel) { return el._qs[sel] || (el._qs[sel] = makeElement()); },
        querySelectorAll() { return []; },
        closest() { return makeElement(); },
        setAttribute() {}, getAttribute() { return null; }, removeAttribute() {}, hasAttribute() { return false; },
        scrollIntoView() {}, focus() {}, select() {}, blur() {}, click() { return el.fire('click'); },
        matches() { return false; }, toggleAttribute() { return false; }, cloneNode() { return makeElement(); }, after() {}, before() {},
        setSelectionRange() {}, scrollTo() {}, contains() { return false; },
        getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
    };
    created.push(el);
    return el;
}
const elements = new Map();
const byId = (id) => {
    if (!elements.has(id)) {
        const el = makeElement(id);
        if (/sheet$|^users-block$|^auth-discard$|^menu$|^inbox-fab$|^primary-guard$|^storage-persist$|^storage-error$/.test(id)) el.classList.add('hidden');
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
const documentListeners = {};
const fireDocument = (ev, e = {}) => { for (const fn of documentListeners[ev] || []) fn(e); return e; };
const dialogs = { confirm: [], prompt: [], alert: [] };
const answers = { confirm: [], prompt: [] };
let visibility = 'visible';
let reloads = 0;

const H = { entries: [{ state: null, url: BASE + '/' }], index: 0 };
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
    replaceState(s, t, url) { H.entries[H.index] = { state: s == null ? null : structuredClone(s), url: new URL(url ?? entry().url, entry().url).href }; },
    back() { historyShim.go(-1); },
    go(n) {
        const to = H.index + n;
        if (!n || to < 0 || to >= H.entries.length) return;
        H.index = to;
        const st = entry().state;
        setTimeout(() => fireWindow('popstate', { state: st }), 0);
    }
};

// Cache Storage, for tp-data and the share outbox. `cachesFull` makes every
// put fail, as a full disk does; `cachesFailDelete` every delete.
let cachesFull = false;
let cachesFailDelete = false;
const cacheStores = new Map();
const cachesShim = {
    async open(name) {
        touch();
        if (!cacheStores.has(name)) cacheStores.set(name, new Map());
        const m = cacheStores.get(name);
        const key = (k) => (typeof k === 'string' ? k : new URL(k.url).pathname);
        return {
            match: async (k) => { const r = m.get(key(k)); return r ? r.clone() : undefined; },
            put: async (k, v) => {
                if (cachesFull) throw Object.assign(new Error('Quota exceeded'), { name: 'QuotaExceededError' });
                m.set(key(k), v);
            },
            delete: async (k) => {
                if (cachesFailDelete) throw Object.assign(new Error('The operation failed'), { name: 'UnknownError' });
                return m.delete(key(k));
            },
            keys: async () => [...m.keys()]
        };
    },
    async keys() { return [...cacheStores.keys()]; },
    async delete(name) { return cacheStores.delete(name); }
};

const idb = makeFakeIndexedDB();
const lockHub = makeLockHub();
const channelHub = makeChannelHub();
const storageManager = makeStorageManager();

Object.assign(globalThis, {
    window: globalThis,
    document: {
        getElementById: byId,
        createElement: (tag) => makeElement(null, tag),
        createTextNode: (t) => ({ textContent: t }),
        body: makeElement('body'),
        documentElement: makeElement('html'),
        addEventListener(ev, fn) { (documentListeners[ev] = documentListeners[ev] || []).push(fn); },
        querySelector: () => null,
        querySelectorAll: () => [],
        get visibilityState() { return visibility; }
    },
    localStorage: localStorageShim,
    location: {
        get search() { return currentUrl().search; },
        get pathname() { return currentUrl().pathname; },
        get hash() { return currentUrl().hash; },
        get origin() { return currentUrl().origin; },
        get protocol() { return currentUrl().protocol; },
        get href() { return currentUrl().href; },
        reload() { reloads++; }
    },
    history: historyShim,
    caches: cachesShim,
    indexedDB: idb.factory,
    isSecureContext: true,
    // An answer may be a function: what happens while the dialog is up.
    confirm: (msg) => {
        dialogs.confirm.push(msg);
        const a = answers.confirm.length ? answers.confirm.shift() : false;
        return typeof a === 'function' ? a(msg) : a;
    },
    prompt: (msg) => {
        dialogs.prompt.push(msg);
        const a = answers.prompt.length ? answers.prompt.shift() : null;
        return typeof a === 'function' ? a(msg) : a;
    },
    alert: (msg) => { dialogs.alert.push(msg); },
    scrollTo() {},
    innerHeight: 800,
    open() {},
    close() {}
});
globalThis.addEventListener = (ev, fn) => { (windowListeners[ev] = windowListeners[ev] || []).push(fn); };
globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((fn) => setTimeout(fn, 0));
globalThis.cancelAnimationFrame = globalThis.cancelAnimationFrame || ((id) => clearTimeout(id));
globalThis.innerWidth = 375;
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
new Function('self', fs.readFileSync(path.join(REPO, 'pwa', 'shareCore.js'), 'utf8'))(globalThis);
const Share = globalThis.TPShare;

// Each window has its own navigator (its Web Locks) and BroadcastChannel.
// `withLocks` false: a plain-http address, where there are no Web Locks.
let currentTag = null;
let withStorageManager = true;
let withLocks = true;
function enterWindow(tag) {
    Object.defineProperty(globalThis, 'navigator', {
        value: { clipboard: null, ...(withLocks ? { locks: lockHub.forTag(tag) } : {}), ...(withStorageManager ? { storage: storageManager } : {}) },
        configurable: true
    });
    globalThis.BroadcastChannel = channelHub.classFor(tag);
}

const requests = [];
const realFetch = globalThis.fetch;
let inFlight = 0;
let offline = null;
// { re, ms }: requests matching `re` answer `ms` later, as a slow network.
let slow = null;
globalThis.fetch = async (url, opts = {}) => {
    const line = `${(opts.method || 'GET').toUpperCase()} ${String(url).replace(BASE, '')}`;
    requests.push(line);
    if (offline && offline.test(line)) throw new TypeError('Failed to fetch');
    inFlight++;
    try {
        if (slow && slow.re.test(line)) await sleep(slow.ms);
        return await realFetch(url, opts);
    } finally { inFlight--; lastActivity = Date.now(); }
};
async function settle() {
    for (let i = 0; i < 100; i++) {
        await sleep(40);
        if (inFlight === 0 && Date.now() - lastActivity > 200) return;
    }
}
// Past the copy's write debounce (150 ms) and the live draft's (500 ms).
const pastCopyWrite = () => sleep(350);
const pastDraftWrite = () => sleep(700);

// --- The server ------------------------------------------------------------------------

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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-pwa-durable-'));
const env = { ...process.env };
for (const k of Object.keys(env)) if (/^(AUTH_TOKEN|ADMIN_|TENANCY_OWNER|IMPORT_|MAX_)/.test(k)) delete env[k];
const server = spawn(process.execPath, [path.join(REPO, 'server', 'index.js')], {
    env: { ...env, PORT: String(PORT), DATA_DIR: dataDir, PWA_DIR: path.join(REPO, 'pwa'), ADMIN_USERNAME: 'alex', ADMIN_PASSWORD: PASSWORD, IMPORTS_SCHEDULER: 'off' },
    stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', d => { serverLog += d; });
server.stderr.on('data', d => { serverLog += d; });
const serverExited = new Promise(r => server.on('exit', r));

// --- Helpers -----------------------------------------------------------------------------

const stripVirtual = (nodes) => (nodes || []).filter(n => !n.virtual && !n.readOnly)
    .map(n => (n.children ? { ...n, children: stripVirtual(n.children) } : n));
const tree = async (token) => {
    const json = (await api('/api/tree', { token })).json;
    return { ...json, roots: stripVirtual(json.roots) };
};
const find = (nodes, test) => {
    for (const n of nodes || []) {
        if (test(n)) return n;
        const hit = find(n.children, test);
        if (hit) return hit;
    }
    return null;
};
const byTitle = (roots, title) => find(roots, n => n.title === title);
const idsIn = (nodes, out = []) => { for (const n of nodes || []) { out.push(n.id); idsIn(n.children, out); } return out; };
const has = (rec, title) => Boolean(rec && JSON.stringify(rec.roots || []).includes(JSON.stringify(title)));
const kvTree = () => idb.peek('tpTree');
const kvDrafts = () => idb.peek('tpLiveDraft');
const draftTexts = () => Object.values(kvDrafts() || {}).map(d => d.content);
const tpData = async () => {
    const c = await cachesShim.open('tp-data');
    const hit = await c.match('/__tp_tree');
    return hit ? hit.json() : null;
};
const putTpData = async (rec) => {
    const c = await cachesShim.open('tp-data');
    if (rec === null) await c.delete('/__tp_tree');
    else await c.put('/__tp_tree', new Response(JSON.stringify(rec), { headers: { 'Content-Type': 'application/json' } }));
};
const pulls = () => requests.filter(r => r === 'GET /api/tree').length;
const lastToast = () => [...document.body.children].reverse().find(c => c.id === 'tp-toast')?.textContent || '';
const toastsSince = (mark) => document.body.children.filter(c => c.id === 'tp-toast').slice(mark).map(c => c.textContent);
const toastMark = () => document.body.children.length;
const lastEditorText = () => [...created].reverse().find(e => e.tagName === 'TEXTAREA')?.value ?? null;
const unloadAsks = () => fireWindow('beforeunload', { prevented: false, preventDefault() { this.prevented = true; } }).prevented;
const guardShown = () => !byId('primary-guard').classList.contains('hidden');
const sheetOpen = () => !byId('share-sheet').classList.contains('hidden');
const statusText = () => byId('status').textContent;
async function clickNv(nv) {
    const t = { dataset: { nv }, closest: (sel) => (sel === '[data-nv]' ? t : null) };
    await byId('content').fire('click', { target: t });
    await settle();
}
async function typeNote(text) {
    await byId('content').fire('input', { target: { id: 'note-body-input', value: text, style: {}, scrollHeight: 0 } });
}
async function newFolder(title) {
    answers.prompt.push(title);
    await byId('newFolderBtn').fire('click');
    await settle();
}
async function hideAndClose() {
    // What a closing page does: hidden, then pagehide.
    visibility = 'hidden';
    fireDocument('visibilitychange');
    fireWindow('pagehide');
    await sleep(50);
    visibility = 'visible';
}

async function signInStorage(username, password) {
    const login = (await api('/api/login', { method: 'POST', body: { username, password } })).json;
    localStorageShim.setItem('tp_pwa_url', BASE);
    localStorageShim.setItem('tp_pwa_token', login.token);
    localStorageShim.setItem('tp_pwa_user', login.username);
    localStorageShim.setItem('tp_pwa_userid', String(login.user.id));
    localStorageShim.setItem('tp_pwa_serverid', login.serverId);
    return login;
}
function forgetStorageSession() {
    for (const k of ['tp_pwa_token', 'tp_pwa_user', 'tp_pwa_userid', 'tp_pwa_role', 'tp_pwa_owner', 'tp_pwa_serverid']) localStorageShim.removeItem(k);
}
const accountOf = (login) => ({ url: BASE, userId: login.user.id, username: login.username, serverId: login.serverId });
async function signIn(username, password) {
    byId('cfg-url').value = BASE;
    byId('cfg-username').value = username;
    byId('cfg-password').value = password;
    byId('auth-error').textContent = '';
    await byId('auth-submit').fire('click');
    await settle();
}

// A window of the app opened at `url`, the one before gone (closed, or killed:
// what it did on the way out is the caller's). Resolves once it has started:
// edited, or shown the card.
let starts = 0;
async function coldStart(url, { tag = `w${starts + 1}`, wait = true } = {}) {
    touch();
    // The page before is gone: it hears, reads and writes nothing more.
    closePage();
    if (currentTag) {
        lockHub.closeTag(currentTag);
        channelHub.closeTag(currentTag);
    }
    currentTag = tag;
    enterWindow(tag);
    elements.clear();
    for (const k of Object.keys(windowListeners)) delete windowListeners[k];
    for (const k of Object.keys(documentListeners)) delete documentListeners[k];
    H.entries = [{ state: null, url }];
    H.index = 0;
    await import(pathToFileURL(path.join(REPO, 'pwa', 'app.js')).href + '?start=' + (++starts));
    for (const fn of windowListeners.DOMContentLoaded || []) await fn();
    if (wait) await settle();
}

// A window of the app without Web Locks: it asks over the channel first, a
// wait settle() cannot see, so this waits for the claim it makes once it edits.
async function coldStartChannel(url, opts) {
    const before = JSON.stringify(idb.peek('tpPrimary') || null);
    await coldStart(url, opts);
    await until(() => JSON.stringify(idb.peek('tpPrimary') || null) !== before, 3000);
    await settle();
}

// Another window, as only its claim on the copy: it asks for the lock the way
// the app does, and writes the copy down (or cannot) when asked. `channel`:
// without Web Locks.
function otherWindow(tag, { channel = false } = {}) {
    const events = [];
    const g = DC.createPrimaryGuard({
        locks: channel ? null : lockHub.forTag(tag),
        BroadcastChannel: channelHub.classFor(tag),
        secure: !channel,
        id: tag,
        onYield: () => { events.push('yield'); return g.answer(); },
        onYielded: () => events.push('yielded'),
        onLost: (why) => events.push('lost:' + why)
    });
    g.events = events;
    g.answer = async () => true;
    return g;
}

// Another window of this release, as its working copy: its own platform
// over the same IndexedDB and Cache Storage, its own BroadcastChannel, and
// its own TreeStore — the shared core the app runs on — with nothing drawn.
let coreWindows = 0;
async function otherCoreWindow(tag) {
    const page = globalThis.__tpPlatform;
    const platform = Platform.createPlatform({ indexedDB: idb.factory, caches: cachesShim, BroadcastChannel: channelHub.classFor(tag), id: tag });
    globalThis.__tpPlatform = platform;
    try {
        const { TreeStore: T } = await import(pathToFileURL(path.join(REPO, 'pwa', 'lib', 'treeStore.js')).href + `?window=${tag}-${++coreWindows}`);
        await T.load();
        return { platform, T, close: () => { platform.close(); channelHub.closeTag(tag); } };
    } finally {
        globalThis.__tpPlatform = page;
    }
}
const drawnSince = (mark, text) => created.slice(mark).some(e => [e.value, e.textContent, e.innerHTML].some(s => typeof s === 'string' && s.includes(text)));
const parkedNotes = () => JSON.parse(localStorageShim.getItem('tp_notes_parked_v1') || '[]');
const bodyHasEditing = () => document.body.classList.contains('nv-editing');
const kvStashes = () => (idb.peek('tpTreeStashIndex') || []).map(k => idb.peek(k)).filter(Boolean);

try {
    for (let i = 0; i < 100; i++) {
        try { if ((await realFetch(BASE + '/api/health')).ok) break; } catch (e) { /* not yet */ }
        await sleep(100);
    }
    const alexLogin = await signInStorage('alex', PASSWORD);
    const A = alexLogin.token;
    const madeSam = await api('/api/users', { method: 'POST', token: A, body: { username: 'sam', password: 'sam-password-1', role: 'user', currentPassword: PASSWORD } });
    if (madeSam.status !== 200) throw new Error('could not create sam: ' + JSON.stringify(madeSam.json));
    const t0 = await tree(A);
    const bm = t0.roots.find(r => r.role === 'bookmarks');
    bm.children = [{ id: 'f-server', kind: 'folder', title: 'Server folder', children: [{ id: 'b-1', kind: 'bookmark', title: 'One', url: 'https://one.example/' }] }];
    const roots0 = [bm, { id: 'f-notes', kind: 'folder', role: 'notes', title: 'Notes', children: [] }];
    const put0 = await api('/api/tree', { method: 'PUT', token: A, body: { roots: roots0, baseVersion: t0.version, deviceId: 'laptop' } });
    if (put0.status !== 200) throw new Error('could not set up the tree: ' + JSON.stringify(put0.json));
    const t1 = await tree(A);

    // =================================================================================
    console.log('\n5. The first start of this release, from what the last one kept in tp-data');
    const seededRoots = JSON.parse(JSON.stringify(t1.roots));
    seededRoots.find(r => r.role === 'bookmarks').children.push({ id: 'aaaaaaaaaaaa0005', kind: 'folder', title: 'From v31', children: [] });
    const seededAt = new Date(Date.now() - 60000).toISOString();
    await putTpData({
        v: 1, savedAt: seededAt, account: accountOf(alexLogin), roots: seededRoots, version: t1.version, dirty: true, editCount: 1,
        importIds: [], serverIds: idsIn(t1.roots), keptDraft: null, pathIds: [],
        nv: { pane: 'note', scope: 'all', noteId: null, editing: true, isNew: true, newParentId: null, pendingNotebookName: null,
            query: '', from: 'Notes', draft: '# Seeded\n\nSEEDED DRAFT', loaded: '', importId: null }
    });
    let pullsBefore = pulls();
    await coldStart(`${BASE}/`);
    check('the dirty copy comes back, saying so, without a pull over it', /Restored unpushed changes/.test(statusText())
        && pulls() === pullsBefore, statusText());
    check('  with its half-written note in the editor', /SEEDED DRAFT/.test(lastEditorText() || ''), lastEditorText());
    await sleep(50);
    const seeded = kvTree();
    check('IndexedDB now holds it, as it was: whose, dirty, when', seeded && has(seeded, 'From v31') && seeded.dirty
        && seeded.owner.username === 'alex' && seeded.owner.userId === alexLogin.user.id && seeded.savedAt === seededAt
        && seeded.baseVersion === t1.version, JSON.stringify(seeded && { owner: seeded.owner, dirty: seeded.dirty, savedAt: seeded.savedAt }));
    check('  and the note, as a live draft', draftTexts().some(t => /SEEDED DRAFT/.test(t)), JSON.stringify(kvDrafts()));
    await clickNv('done');
    await pastCopyWrite();
    let t = await tree(A);
    check('✓ Done saves the note and pushes it with the edit', Boolean(byTitle(t.roots, 'From v31')) && Boolean(byTitle(t.roots, 'Seeded')));
    const afterDone = kvTree();
    const tpAfterDone = await tpData();
    check('  the copy kept is clean now, and the draft is gone with the save', afterDone && !afterDone.dirty && kvDrafts() === undefined
        && has(afterDone, 'Seeded'), JSON.stringify({ dirty: afterDone && afterDone.dirty, drafts: kvDrafts() }));
    check('tp-data is still written beside it, the same record in the last release\'s shape', tpAfterDone && tpAfterDone.v === 1
        && tpAfterDone.savedAt === afterDone.savedAt && !tpAfterDone.dirty && tpAfterDone.nv === null && has(tpAfterDone, 'Seeded')
        && tpAfterDone.account.username === 'alex' && localStorageShim.getItem('tp_copy_tpdata_at') === afterDone.savedAt);

    // =================================================================================
    console.log('\n6. A reload, the app killed: nothing hidden, nothing flushed');
    offline = /^PUT \/api\/tree$/;
    await newFolder('Kept in IndexedDB');
    offline = null;
    await pastCopyWrite();
    const kept6 = kvTree();
    check('an edit the server did not take is in IndexedDB a moment later, unasked', kept6 && kept6.dirty && has(kept6, 'Kept in IndexedDB'));
    // tp-data holds an older write than IndexedDB: the one the app starts from
    // is IndexedDB's.
    await putTpData({ ...(await tpData()), savedAt: new Date(Date.parse(kept6.savedAt) - 5000).toISOString(),
        roots: (await tpData()).roots.filter(r => !JSON.stringify(r).includes('Kept in IndexedDB')) });
    await clickNv('new-note'); // Notes is open from section 5
    await typeNote('# Typed\n\nTYPED BEFORE THE CRASH');
    await pastDraftWrite();
    check('the note being typed is in IndexedDB once typing pauses', draftTexts().some(x => /TYPED BEFORE THE CRASH/.test(x)), JSON.stringify(kvDrafts()));
    pullsBefore = pulls();
    await coldStart(`${BASE}/`);
    check('the next start has the edit back, from IndexedDB, without a pull', /Restored unpushed changes/.test(statusText())
        && pulls() === pullsBefore, JSON.stringify({ st: statusText(), pulls: pulls() - pullsBefore, guard: guardShown(),
            holder: lockHub.holder(), kvDirty: kvTree() && kvTree().dirty, folder: has(kvTree(), 'Kept in IndexedDB'), req: requests.slice(-8) }));
    check('  and the note, in its editor', /TYPED BEFORE THE CRASH/.test(lastEditorText() || ''), lastEditorText());
    await typeNote('# Typed\n\nTYPED BEFORE THE CRASH, and after');
    await clickNv('done');
    await pastCopyWrite();
    t = await tree(A);
    check('  ✓ Done pushes both', Boolean(byTitle(t.roots, 'Kept in IndexedDB'))
        && JSON.stringify(t.roots).includes('TYPED BEFORE THE CRASH, and after') && kvDrafts() === undefined && !kvTree().dirty);

    // =================================================================================
    console.log('\n7. A step back to the last release, and forward again');
    // The last release ran meanwhile and wrote tp-data later than IndexedDB.
    const k7 = kvTree();
    const stepBackRoots = JSON.parse(JSON.stringify(k7.roots));
    stepBackRoots.find(r => r.role === 'bookmarks').children.push({ id: 'aaaaaaaaaaaa0007', kind: 'folder', title: 'Made after a step back', children: [] });
    await putTpData({
        v: 1, savedAt: new Date(Date.now() + 1000).toISOString(), account: accountOf(alexLogin), roots: stepBackRoots, version: k7.baseVersion,
        dirty: true, editCount: 1, importIds: [], serverIds: k7.serverIds, nv: null, keptDraft: null, pathIds: []
    });
    pullsBefore = pulls();
    await coldStart(`${BASE}/`);
    await sleep(50);
    check('tp-data written later by the last release is the copy taken', /Restored unpushed changes/.test(statusText())
        && pulls() === pullsBefore && has(kvTree(), 'Made after a step back'), statusText());
    await byId('pushBtn').fire('click');
    await settle();
    t = await tree(A);
    check('  and it pushes', Boolean(byTitle(t.roots, 'Made after a step back')));

    // Now an edit kept here, then the last release pushes it and signs out
    // cleanly, which clears tp-data.
    offline = /^PUT \/api\/tree$/;
    await newFolder('Pushed by the last release');
    offline = null;
    await hideAndClose();
    const k7b = kvTree();
    check('(an unpushed edit kept, tp-data written with the same record)', k7b.dirty && has(k7b, 'Pushed by the last release')
        && localStorageShim.getItem('tp_copy_tpdata_at') === k7b.savedAt);
    const t7 = await tree(A);
    const pushedRoots = JSON.parse(JSON.stringify(t7.roots));
    pushedRoots.find(r => r.role === 'bookmarks').children.push({ id: 'aaaaaaaaaaa0007b', kind: 'folder', title: 'Pushed by the last release', children: [] });
    await api('/api/tree', { method: 'PUT', token: A, body: { roots: pushedRoots, baseVersion: t7.version, deviceId: 'pwa' } });
    await putTpData(null);
    forgetStorageSession();
    await coldStart(`${BASE}/`);
    await sleep(50);
    const index7 = idb.peek('tpTreeStashIndex') || [];
    const stash7 = index7.length ? idb.peek(index7[0]) : null;
    check('a copy the last release cleared is not offered again as unpushed edits', !/Restored unpushed changes/.test(statusText())
        && kvTree() === undefined, statusText());
    check('  but set aside, in the shared core\'s format, rather than lost', index7.length === 1
        && index7[0] === `tpTreeStash:${BASE}|${alexLogin.user.id}` && stash7 && stash7.dirty && has(stash7, 'Pushed by the last release')
        && localStorageShim.getItem('tp_copy_tpdata_at') === null, JSON.stringify(index7));
    await signIn('alex', PASSWORD);
    check('  and signing in pulls as usual', pulls() > pullsBefore && kvTree() && kvTree().owner.username === 'alex' && !kvTree().dirty);

    // =================================================================================
    console.log('\n8. Two windows: each edits the one copy, and hears the other');
    const A8 = (await api('/api/login', { method: 'POST', body: { username: 'alex', password: PASSWORD } })).json.token;
    await coldStart(`${BASE}/`, { tag: 'v8' });
    check('this release\'s window edits with Web Locks, beside any other: no card, \'tp-primary\' held with the others (shared)',
        !guardShown() && lockHub.holders('tp-primary').includes('v8'), JSON.stringify(lockHub.holders('tp-primary')));
    const x8 = await otherCoreWindow('x8');
    const bm8 = x8.T.roots().find(r => r.role === 'bookmarks');
    offline = /^PUT \/api\/tree$/;
    await newFolder('Edited in this window');
    offline = null;
    let mark8 = created.length;
    const made8 = await x8.T.createNode({ parentId: null, kind: 'folder', title: 'Edited in the other window' });
    await x8.T.createNode({ parentId: made8.id, kind: 'bookmark', title: 'Its link', url: 'https://other-window.example/' });
    await x8.T.createNode({ parentId: bm8.id, kind: 'folder', title: 'Also there' });
    await x8.T.flush();
    check('another window\'s edit is drawn here as it lands, without a reload', await until(() => drawnSince(mark8, 'Edited in the other window'), 3000)
        && reloads === 0);
    await pastCopyWrite();
    check('  both windows\' edits are kept, in IndexedDB and in both windows', has(kvTree(), 'Edited in this window') && has(kvTree(), 'Edited in the other window')
        && kvTree().dirty && (await x8.T.bookmarks.search({ title: 'Edited in this window' })).length === 1);
    // A note being written here while the other window edits: never redrawn
    // under the typing.
    await byId('notesBtn').fire('click');
    await clickNv('new-note');
    await typeNote('# Two windows\n\nTYPED WHILE ANOTHER EDITS');
    mark8 = created.length;
    await x8.T.createNode({ parentId: bm8.id, kind: 'folder', title: 'Edited while this one types' });
    await x8.T.flush();
    await pastDraftWrite();
    check('  a note being written here is not redrawn under the typing, and is kept as it is typed',
        await until(() => has(kvTree(), 'Edited while this one types')) && !created.slice(mark8).some(e => e.tagName === 'TEXTAREA')
        && draftTexts().some(t => /TYPED WHILE ANOTHER EDITS/.test(t)), JSON.stringify(kvDrafts()));
    // The other window brings another account's copy in (sam signed in there).
    const samLogin = (await api('/api/login', { method: 'POST', body: { username: 'sam', password: 'sam-password-1' } })).json;
    const toasts8 = toastMark();
    mark8 = created.length;
    await x8.T.switchAccount({ ...accountOf(samLogin), previousUsername: 'alex' });
    await until(() => !bodyHasEditing() && toastsSince(toasts8).some(m => /Another window switched/.test(m)), 3000);
    const parked8 = parkedNotes().find(d => /TYPED WHILE ANOTHER EDITS/.test(d.content));
    const alexAside8 = kvStashes().find(s => s.owner && s.owner.username === 'alex' && s.dirty && has(s, 'Edited in this window'));
    check('another window switching to another account\'s copy: the note open here is parked for alex, not lost, not drawn over sam\'s copy',
        Boolean(parked8) && parked8.owner && parked8.owner.username === 'alex' && !bodyHasEditing()
        && !drawnSince(mark8, 'Edited in this window'), JSON.stringify(parkedNotes().map(d => d.owner)));
    check('  alex\'s copy, with both windows\' edits, is set aside on the device', Boolean(alexAside8) && has(alexAside8, 'Edited in the other window'));
    await x8.T.switchAccount({ ...accountOf(alexLogin), previousUsername: 'sam' });
    await until(() => /TYPED WHILE ANOTHER EDITS/.test(lastEditorText() || '') && bodyHasEditing(), 3000);
    check('  and when alex\'s copy comes back (switched back there), so does the note, in its editor here',
        bodyHasEditing() && /TYPED WHILE ANOTHER EDITS/.test(lastEditorText() || '') && has(kvTree(), 'Edited in this window'),
        JSON.stringify({ editing: bodyHasEditing(), editor: lastEditorText(), kv: has(kvTree(), 'Edited in this window'), owner: kvTree().owner, parked: parkedNotes().length }));
    await clickNv('done');
    await byId('pushBtn').fire('click');
    await settle();
    let t8 = await tree(A8);
    check('  and everything both windows made pushes from here', ['Edited in this window', 'Edited in the other window', 'Also there', 'Edited while this one types']
        .every(title => Boolean(byTitle(t8.roots, title))) && JSON.stringify(t8.roots).includes('TYPED WHILE ANOTHER EDITS'));
    x8.close();

    // A window of the last release, which edits alone under 'tp-primary'.
    // (This window closes first: the last release's window starts on its own.)
    closePage();
    lockHub.closeTag(currentTag);
    channelHub.closeTag(currentTag);
    const old8 = otherWindow('old8');
    check('(a window of the last release edits, holding \'tp-primary\' alone)', (await old8.start()) === 'primary');
    await coldStart(`${BASE}/`, { tag: 'v8b' });
    check('a window of this release starting beside it asks it to write down what it holds and let go, then edits',
        old8.events.join() === 'yield,yielded' && !old8.isPrimary() && !guardShown() && lockHub.holders('tp-primary').includes('v8b'),
        JSON.stringify({ ev: old8.events, holders: lockHub.holders('tp-primary') }));
    const fenced8 = await DC.createKv(idb.factory).write({ fenced: 1 }, { fence: { id: 'old8', at: 1 } });
    check('  and its claim stops any write the last release\'s window still had on its way', fenced8.fenced && idb.peek('fenced') === undefined);
    const old8b = otherWindow('old8b');
    check('  a window of the last release starting now waits (no editing beside this release\'s)', (await old8b.start()) === 'secondary');
    const took8 = await old8b.take();
    check('  and is refused the copy if it asks (Use here there): this release\'s windows never hand it back',
        !took8.ok && took8.how === 'refused' && took8.reason === 'newer' && !old8b.isPrimary() && !guardShown(), JSON.stringify(took8));
    old8.close();
    old8b.close();
    lockHub.closeTag('old8b');

    // One that cannot write what it holds (a full disk there) keeps it.
    lockHub.closeTag('v8b');
    const old8c = otherWindow('old8c');
    check('(another window of the last release edits)', (await old8c.start()) === 'primary');
    old8c.answer = async () => ({ ok: false, reason: 'storage' });
    await coldStart(`${BASE}/`, { tag: 'v8c', wait: false });
    await until(() => guardShown(), 8000);
    check('a window of the last release that cannot write what it holds keeps the copy: this one waits behind the card, saying so',
        guardShown() && /from before an update/.test(byId('primary-guard-title').textContent) && /could not save/.test(byId('primary-guard-note').textContent)
        && old8c.isPrimary(), JSON.stringify({ title: byId('primary-guard-title').textContent, note: byId('primary-guard-note').textContent }));
    old8c.answer = async () => true;
    await byId('primary-take').fire('click');
    await until(() => !guardShown(), 8000);
    await settle();
    check('  Use here asks again, and works once it can', !guardShown() && !old8c.isPrimary() && lockHub.holders('tp-primary').includes('v8c'));
    old8c.close();

    // One frozen in the background never answers: it wrote everything down
    // when it was hidden, and the copy is taken from it, as its own windows do.
    closePage();
    lockHub.closeTag(currentTag);
    channelHub.closeTag(currentTag);
    const old8d = otherWindow('old8d');
    check('(another window of the last release edits)', (await old8d.start()) === 'primary');
    channelHub.freeze('old8d');
    await coldStart(`${BASE}/`, { tag: 'v8d', wait: false });
    await until(() => lockHub.holders('tp-primary').includes('v8d'), 10000);
    await settle();
    check('a window of the last release frozen in the background is taken from: this one edits, and it hears so when it wakes',
        !guardShown() && lockHub.holders('tp-primary').includes('v8d') && old8d.events.includes('lost:stolen'), JSON.stringify(old8d.events));
    channelHub.freeze('old8d', false);
    old8d.close();

    // =================================================================================
    console.log('\n9. A copy belongs to its account');
    await coldStart(`${BASE}/`, { tag: 'w9' });
    check('(the next window edits, from the last good write)', !guardShown() && lockHub.holders('tp-primary').includes('w9'));
    await byId('pullBtn').fire('click');
    await settle();
    offline = /^PUT \/api\/tree$/;
    await newFolder('Kept for alex');
    offline = null;
    answers.confirm.push(true); // "Sign out anyway?"
    await byId('auth-signout').fire('click');
    await settle();
    check('signing out with an unpushed edit keeps the copy in IndexedDB, as alex\'s', kvTree() && kvTree().dirty
        && kvTree().owner.username === 'alex' && has(kvTree(), 'Kept for alex'));
    await coldStart(`${BASE}/`, { tag: 'w9b' });
    check('the next start, signed out, has it back for alex', /Restored unpushed changes .* sign in as alex/.test(statusText()),
        JSON.stringify({ st: statusText(), guard: guardShown(), req: requests.slice(-6) }));
    await signIn('sam', 'sam-password-1');
    const aside9 = () => kvStashes().find(s => s.owner && s.owner.username === 'alex' && s.dirty && has(s, 'Kept for alex'));
    check('sam signing in sets it aside in IndexedDB, never over it: sam has a copy of his own', Boolean(localStorageShim.getItem('tp_pwa_token'))
        && Boolean(aside9()) && kvTree().owner.username === 'sam' && !has(kvTree(), 'Kept for alex'));
    pullsBefore = pulls();
    await signIn('alex', PASSWORD);
    await byId('pushBtn').fire('click');
    await settle();
    const A9 = (await api('/api/login', { method: 'POST', body: { username: 'alex', password: PASSWORD } })).json.token;
    check('alex has it back without a pull over it, and pushes it', pulls() === pullsBefore && Boolean(byTitle((await tree(A9)).roots, 'Kept for alex'))
        && !aside9());
    await byId('auth-signout').fire('click');
    await settle();
    await pastCopyWrite();
    check('a clean sign-out leaves no copy of anyone\'s in IndexedDB or tp-data', kvTree() && !kvTree().owner && !kvTree().dirty
        && kvTree().roots.length === 0 && kvDrafts() === undefined && (await tpData()) === null && localStorageShim.getItem('tp_copy_tpdata_at') === null,
        JSON.stringify(kvTree() && { owner: kvTree().owner, roots: kvTree().roots.length, dirty: kvTree().dirty }));
    await signIn('sam', 'sam-password-1');
    await pastCopyWrite();
    check('sam signs in and his copy is kept as his', kvTree() && kvTree().owner.username === 'sam' && !has(kvTree(), 'Kept for alex'));

    // A copy the last release kept for alex, with work in it and his note,
    // while sam is signed in.
    const alexNow = (await api('/api/login', { method: 'POST', body: { username: 'alex', password: PASSWORD } })).json;
    const alexTree = await tree(alexNow.token);
    const alexRoots = JSON.parse(JSON.stringify(alexTree.roots));
    alexRoots.find(r => r.role === 'bookmarks').children.push({ id: 'aaaaaaaaaaaa0009', kind: 'folder', title: 'Alex elsewhere', children: [] });
    idb.poke('tpTree', DC.toKvRecord({ v: 1, savedAt: new Date().toISOString(), account: accountOf(alexNow), roots: alexRoots,
        version: alexTree.version, dirty: true, editCount: 1, importIds: [], serverIds: idsIn(alexTree.roots), pathIds: [] }, { seq: 1 }));
    idb.poke('tpLiveDraft', DC.liveDraftsFor({ editing: true, isNew: true, draft: 'ALEX DRAFT ELSEWHERE', loaded: '' }, accountOf(alexNow), 'p-other'));
    await putTpData(null);
    const mark9 = toastMark();
    const drawn9 = created.length;
    await coldStart(`${BASE}/`, { tag: 'w9c' });
    await pastCopyWrite();
    check('sam\'s start says the device keeps alex\'s unpushed changes', toastsSince(mark9).some(m => /keeps unpushed changes for alex/.test(m)),
        JSON.stringify(toastsSince(mark9)));
    const alexKept9 = () => kvStashes().find(s => s.owner && s.owner.username === 'alex' && s.dirty && has(s, 'Alex elsewhere'));
    const alexNote9 = () => parkedNotes().find(d => d.content === 'ALEX DRAFT ELSEWHERE' && d.owner && d.owner.username === 'alex');
    check('  sam\'s pull is not written over them, nor over alex\'s note: set aside, and parked, for alex',
        Boolean(alexKept9()) && Boolean(alexNote9()) && kvTree().owner.username === 'sam' && !has(kvTree(), 'Alex elsewhere'),
        JSON.stringify({ stashes: kvStashes().map(s => s.owner && s.owner.username), parked: parkedNotes().map(d => d.content) }));
    check('  and none of it is drawn for sam', !drawnSince(drawn9, 'Alex elsewhere') && !drawnSince(drawn9, 'ALEX DRAFT ELSEWHERE'));
    // sam's own edits are kept on the device meanwhile, beside alex's.
    offline = /^PUT \/api\/tree$/;
    await newFolder('Sam unpushed');
    offline = null;
    await pastCopyWrite();
    check('  sam\'s own unpushed edit is kept in IndexedDB beside them', has(kvTree(), 'Sam unpushed') && kvTree().dirty && Boolean(alexKept9()));
    await byId('pushBtn').fire('click');
    await settle();
    const S9 = (await api('/api/login', { method: 'POST', body: { username: 'sam', password: 'sam-password-1' } })).json.token;
    check('  and pushes into sam\'s tree only', Boolean(byTitle((await tree(S9)).roots, 'Sam unpushed'))
        && !JSON.stringify((await tree(S9)).roots).includes('Alex elsewhere'));
    await byId('auth-signout').fire('click');
    await settle();
    check('  sam\'s clean sign-out leaves them', Boolean(alexKept9()) && Boolean(alexNote9()));
    await signIn('alex', PASSWORD);
    check('  and alex has them back, with his note in its editor', /ALEX DRAFT ELSEWHERE/.test(lastEditorText() || '') && has(kvTree(), 'Alex elsewhere')
        && kvTree().owner.username === 'alex', JSON.stringify({ st: statusText(), editor: lastEditorText() }));
    await clickNv('done');
    await byId('pushBtn').fire('click');
    await settle();
    t = await tree((await api('/api/login', { method: 'POST', body: { username: 'alex', password: PASSWORD } })).json.token);
    check('  to push them', Boolean(byTitle(t.roots, 'Alex elsewhere')) && JSON.stringify(t.roots).includes('ALEX DRAFT ELSEWHERE')
        && !alexNote9());

    // =================================================================================
    console.log('\n10. Storage trouble, and Settings › Storage');
    await byId('settingsBtn').fire('click');
    await settle();
    await sleep(50);
    check('Settings says where the copy is, and that the browser may clear it', /database on this phone/.test(byId('storage-status').textContent)
        && /may clear it/.test(byId('storage-status').textContent), byId('storage-status').textContent);
    check('  and offers to keep it', !byId('storage-persist').classList.contains('hidden')
        && byId('storage-persist').textContent === 'Keep my data on this phone');
    const askedBefore = storageManager.asked;
    storageManager.answer = 'no';
    await byId('storage-persist').fire('click');
    check('Keep my data: asked from the click, and a no is said', storageManager.asked === askedBefore + 1 && /said no/.test(lastToast())
        && /said no for now/.test(byId('storage-status').textContent), lastToast());
    storageManager.answer = 'throw';
    await byId('storage-persist').fire('click');
    check('  a failure is said', /Could not ask the browser: Permission dismissed/.test(lastToast()), lastToast());
    storageManager.answer = 'yes';
    await byId('storage-persist').fire('click');
    check('  a yes is said, and the button goes', /Kept: the browser will not clear/.test(lastToast())
        && byId('storage-persist').classList.contains('hidden') && /will not clear it/.test(byId('storage-status').textContent), lastToast());
    byId('settings-sheet').classList.add('hidden');

    await byId('pullBtn').fire('click');
    await settle();
    idb.ctl.quotaFull = true;
    cachesFull = true;
    const mark10 = toastMark();
    offline = /^PUT \/api\/tree$/;
    await newFolder('Edit on a full disk');
    await pastCopyWrite();
    await newFolder('Second edit on a full disk');
    offline = null;
    await pastCopyWrite();
    const fullToasts = toastsSince(mark10).filter(m => /out of storage/.test(m));
    check('a full disk is said, once', fullToasts.length === 1 && !has(kvTree(), 'Edit on a full disk'), JSON.stringify(toastsSince(mark10)));
    check('  the edits stay in this window, and closing it asks first', unloadAsks());
    fireDocument('freeze');
    await sleep(50);
    fireDocument('resume');
    await sleep(50);
    check('  frozen meanwhile and back, it still holds them: nothing is let go of (with Web Locks every window edits)',
        !guardShown() && unloadAsks() && lockHub.holders('tp-primary').includes(currentTag));
    await byId('settingsBtn').fire('click');
    await settle();
    await sleep(50);
    check('  Settings says the last save failed', !byId('storage-error').classList.contains('hidden')
        && /out of storage/.test(byId('storage-error').textContent) && /2 unpushed edits/.test(byId('storage-status').textContent),
        byId('storage-status').textContent);
    byId('settings-sheet').classList.add('hidden');
    idb.ctl.quotaFull = false;
    cachesFull = false;
    offline = /^PUT \/api\/tree$/;
    await newFolder('After space came back');
    offline = null;
    await pastCopyWrite();
    check('the next write that fits keeps them all, and clears the warning', has(kvTree(), 'Edit on a full disk')
        && has(kvTree(), 'Second edit on a full disk') && has(kvTree(), 'After space came back'));
    await byId('settingsBtn').fire('click');
    await settle();
    await sleep(50);
    check('  in Settings too', byId('storage-error').classList.contains('hidden'));
    byId('settings-sheet').classList.add('hidden');

    // A write that fails here while another window writes its own edit: when
    // this one can write again, it takes the other's in first and makes its
    // own again on top — neither written over.
    idb.ctl.quotaFull = true;
    cachesFull = true;
    offline = /^PUT \/api\/tree$/;
    await newFolder('Held through a full disk');
    offline = null;
    await pastCopyWrite();
    check('(the write failed: the edit is held in this window)', !has(kvTree(), 'Held through a full disk') && unloadAsks());
    idb.ctl.quotaFull = false;
    cachesFull = false;
    const x10 = await otherCoreWindow('x10');
    await x10.T.createNode({ parentId: null, kind: 'folder', title: 'Kept by the other window' });
    await x10.T.flush();
    check('(meanwhile another window keeps an edit of its own)', has(kvTree(), 'Kept by the other window') && !has(kvTree(), 'Held through a full disk'));
    offline = /^PUT \/api\/tree$/;
    await newFolder('After the other window');
    offline = null;
    await pastCopyWrite();
    check('  this window\'s next write keeps all of it: what it held, the other window\'s, and its own new edit',
        has(kvTree(), 'Held through a full disk') && has(kvTree(), 'Kept by the other window') && has(kvTree(), 'After the other window')
        && (await x10.T.bookmarks.search({ title: 'Held through a full disk' })).length === 1);
    x10.close();

    // IndexedDB failing, Cache Storage not: kept in tp-data, and the next
    // start takes it from there.
    idb.ctl.quotaFull = true;
    const mark10b = toastMark();
    offline = /^PUT \/api\/tree$/;
    await newFolder('Only in tp-data');
    offline = null;
    await pastCopyWrite();
    idb.ctl.quotaFull = false;
    check('IndexedDB full but tp-data not: kept there, and nothing to warn about', has(await tpData(), 'Only in tp-data')
        && !has(kvTree(), 'Only in tp-data') && !toastsSince(mark10b).some(m => /out of storage/.test(m)));
    await coldStart(`${BASE}/`, { tag: 'w10' });
    await sleep(50);
    check('  the next start takes it from tp-data, and IndexedDB has it again', /Restored unpushed changes/.test(statusText())
        && has(kvTree(), 'Only in tp-data'), statusText());

    // No IndexedDB at all: the copy lives in tp-data, as before.
    await hideAndClose();
    globalThis.indexedDB = undefined;
    await coldStart(`${BASE}/`, { tag: 'w10b' });
    check('without IndexedDB the app starts from tp-data as before', /Restored unpushed changes/.test(statusText()), statusText());
    offline = /^PUT \/api\/tree$/;
    await newFolder('Without IndexedDB');
    offline = null;
    await pastCopyWrite();
    check('  and keeps edits there', has(await tpData(), 'Without IndexedDB'));
    await byId('settingsBtn').fire('click');
    await settle();
    await sleep(50);
    check('  Settings says so', /cache storage/.test(byId('storage-status').textContent), byId('storage-status').textContent);
    byId('settings-sheet').classList.add('hidden');
    await hideAndClose();
    globalThis.indexedDB = idb.factory;
    withStorageManager = false;
    await coldStart(`${BASE}/`, { tag: 'w10c' });
    await sleep(50);
    check('IndexedDB back: the later tp-data copy is taken and goes into it', has(kvTree(), 'Without IndexedDB'));
    await byId('settingsBtn').fire('click');
    await settle();
    await sleep(50);
    check('a browser that cannot be asked to keep data: no button, and it says so', byId('storage-persist').classList.contains('hidden')
        && /cannot be asked to keep it/.test(byId('storage-status').textContent), byId('storage-status').textContent);
    byId('settings-sheet').classList.add('hidden');
    withStorageManager = true;
    await byId('pushBtn').fire('click');
    await settle();
    t = await tree((await api('/api/login', { method: 'POST', body: { username: 'alex', password: PASSWORD } })).json.token);
    check('everything kept through it pushes', ['Edit on a full disk', 'Second edit on a full disk', 'After space came back',
        'Held through a full disk', 'Kept by the other window', 'After the other window', 'Only in tp-data', 'Without IndexedDB'].every(title => Boolean(byTitle(t.roots, title))));

    // =================================================================================
    console.log('\n11. Losing the copy part-way (without Web Locks: one window edits at a time)');
    withLocks = false;
    globalThis.isSecureContext = false;
    // A link shared while nobody was signed in: a start asks about it.
    const unclaimed11 = Share.makeEntry({ fields: { title: '', text: '', url: 'https://example.com/shared-signed-out' }, account: null, source: 'share' });
    await Share.cacheOutbox(cachesShim).put(unclaimed11);
    pullsBefore = pulls();
    const confirms11 = dialogs.confirm.length;
    const reqMark11 = requests.length;
    slow = { re: /^GET \/api\/auth\/me$/, ms: 600 };
    await coldStart(`${BASE}/`, { tag: 'b11', wait: false });
    await until(() => requests.slice(reqMark11).includes('GET /api/auth/me'), 4000);
    const x11 = otherWindow('x11', { channel: true });
    const took11 = await x11.take();
    await sleep(700);
    slow = null;
    await settle();
    check('a start that hands the copy over before it is done goes no further: no pull, no question, behind the card', took11.ok
        && guardShown() && pulls() === pullsBefore && dialogs.confirm.length === confirms11 && x11.isPrimary(),
        JSON.stringify({ took11, pulls: pulls() - pullsBefore, confirms: dialogs.confirm.slice(confirms11), guard: guardShown() }));
    await Share.cacheOutbox(cachesShim).remove(unclaimed11.sid);

    // A window that never edited, Use here, and while it claims the copy a
    // third window asks for it: it stays behind the card.
    await coldStart(`${BASE}/`, { tag: 'q11' });
    await until(() => guardShown(), 3000);
    check('(a window starts behind the card)', guardShown() && x11.isPrimary());
    idb.ctl.delay = 300;
    const using11 = byId('primary-take').fire('click');
    await until(() => !x11.isPrimary(), 4000);
    await sleep(100);
    const x11c = otherWindow('x11c', { channel: true });
    const took11c = await x11c.take();
    await using11;
    idb.ctl.delay = 0;
    await settle();
    check('Use here, asked for the copy again while it claims it: it stays behind the card, and starts nothing', took11c.ok
        && guardShown() && x11c.isPrimary() && pulls() === pullsBefore, JSON.stringify({ took11c, guard: guardShown(), pulls: pulls() - pullsBefore }));
    for (const g of [x11, x11c]) g.close();
    channelHub.closeTag('x11');
    channelHub.closeTag('x11c');

    // A dialog holds the window up while another takes the copy (it could
    // not answer): nothing it then does goes to the server, or the device.
    await coldStartChannel(`${BASE}/`, { tag: 'p11' });
    check('(a window edits)', !guardShown());
    const putsBefore11 = requests.filter(r => r === 'PUT /api/tree').length;
    answers.prompt.push(() => {
        const claim = { id: 'thief', at: Date.now() };
        idb.poke('tpPrimary', claim);
        localStorageShim.setItem('tp_copy_claim', JSON.stringify(claim));
        return 'Made while robbed';
    });
    await byId('newFolderBtn').fire('click');
    await settle();
    await pastCopyWrite();
    const A11 = (await api('/api/login', { method: 'POST', body: { username: 'alex', password: PASSWORD } })).json.token;
    check('a window robbed of the copy while a dialog held it up pushes nothing when the dialog returns',
        requests.filter(r => r === 'PUT /api/tree').length === putsBefore11 && !byTitle((await tree(A11)).roots, 'Made while robbed'));
    check('  and stops, behind the card, writing nothing of it', guardShown() && !has(kvTree(), 'Made while robbed'));

    // An import link that arrives while the window is on its way back from
    // being frozen (its hashchange comes before the channel has answered).
    idb.poke('tpPrimary', null);
    localStorageShim.removeItem('tp_copy_claim');
    await coldStartChannel(`${BASE}/`, { tag: 'r11' });
    check('(a window edits)', !guardShown());
    fireDocument('freeze');
    await sleep(50);
    let reloadsBefore = reloads;
    fireDocument('resume');
    historyShim.pushState(null, '', `${BASE}/#note=` + encodeURIComponent('# Linked on the way back\n\nLINKED WHILE COMING BACK'));
    fireWindow('hashchange');
    await until(() => /LINKED WHILE COMING BACK/.test(lastEditorText() || ''), 3000);
    await settle();
    check('an import link arriving while the window comes back is opened once it is back', /LINKED WHILE COMING BACK/.test(lastEditorText() || '')
        && !location.hash && reloads === reloadsBefore && !guardShown(),
        JSON.stringify({ hash: location.hash, reloads: reloads - reloadsBefore, pending: localStorageShim.getItem('tp_pending_import') }));
    answers.confirm.push(true); // Discard unsaved changes?
    await clickNv('cancel-edit');
    fireDocument('freeze');
    await sleep(50);
    const x11d = otherWindow('x11d', { channel: true });
    check('(frozen again, and another window takes the copy)', (await x11d.take()).ok);
    reloadsBefore = reloads;
    fireDocument('resume');
    historyShim.pushState(null, '', `${BASE}/#note=` + encodeURIComponent('# Moves it\n\nLINK MOVES THE COPY BACK'));
    fireWindow('hashchange');
    await until(() => reloads > reloadsBefore, 5000);
    check('  one arriving while another window took the copy meanwhile brings the copy back, the link with it', reloads === reloadsBefore + 1
        && x11d.events.includes('yielded') && /LINK MOVES THE COPY BACK/.test(decodeURIComponent(location.hash)),
        JSON.stringify({ reloads: reloads - reloadsBefore, ev: x11d.events, hash: location.hash }));
    x11d.close();
    channelHub.closeTag('x11d');
    withLocks = true;
    globalThis.isSecureContext = true;

    // =================================================================================
    console.log('\n12. A clear that did not reach both places');
    await coldStart(`${BASE}/`, { tag: 'w12' });
    offline = /^PUT \/api\/tree$/;
    await newFolder('Stale in IndexedDB');
    offline = null;
    await pastCopyWrite();
    check('(an unpushed edit kept in IndexedDB)', kvTree().dirty && has(kvTree(), 'Stale in IndexedDB'));
    const cacheKv = async (key) => {
        const hit = await (await cachesShim.open('tp-data')).match('/__tp_kv/' + encodeURIComponent(key));
        return hit ? hit.json() : undefined;
    };
    idb.ctl.quotaFull = true;
    await byId('pushBtn').fire('click');
    await settle();
    await pastCopyWrite();
    check('(pushed while IndexedDB fails: the clean copy is kept in Cache Storage, IndexedDB still holds the dirty one)',
        !(await tpData()).dirty && kvTree().dirty && (await cacheKv('tpTree')) && !(await cacheKv('tpTree')).dirty);
    await byId('auth-signout').fire('click');
    await settle();
    await pastCopyWrite();
    idb.ctl.quotaFull = false;
    const leftAside12 = await cacheKv('tpTree');
    check('(a clean sign-out with IndexedDB refusing: it still holds the stale dirty copy, Cache Storage the later, clean one)',
        kvTree() && kvTree().dirty && leftAside12 && !leftAside12.dirty && leftAside12.seq > kvTree().seq && !(await tpData()).dirty,
        JSON.stringify({ kvDirty: kvTree() && kvTree().dirty, aside: leftAside12 && { dirty: leftAside12.dirty, seq: leftAside12.seq }, kvSeq: kvTree() && kvTree().seq }));
    await coldStart(`${BASE}/`, { tag: 'w12b' });
    check('the next start does not bring back the stale copy IndexedDB could not let go of: the later one goes into it',
        !/Restored unpushed changes/.test(statusText()) && !guardShown() && !kvTree().dirty && (await cacheKv('tpTree')) === undefined,
        JSON.stringify({ st: statusText(), kvDirty: kvTree().dirty, aside: Boolean(await cacheKv('tpTree')) }));
    await signIn('sam', 'sam-password-1');
    check('  nor does it keep anyone else from signing in', Boolean(localStorageShim.getItem('tp_pwa_token'))
        && localStorageShim.getItem('tp_pwa_user') === 'sam', byId('auth-error').textContent);
    await pastCopyWrite();
    check('  and sam\'s copy is kept as his', kvTree() && kvTree().owner.username === 'sam'
        && !kvTree().dirty && localStorageShim.getItem('tp_copy_cleared_at') === null);

    // A deliberate discard of sam's unpushed edits: set aside when alex
    // signs in, then discarded from Settings with sam's name typed.
    offline = /^PUT \/api\/tree$/;
    await newFolder('Sam discards this');
    offline = null;
    answers.confirm.push(true); // Sign out anyway?
    await byId('auth-signout').fire('click');
    await settle();
    check('(sam\'s unpushed edit kept over a sign-out)', kvTree().dirty && kvTree().owner.username === 'sam' && (await tpData()).dirty);
    await signIn('alex', PASSWORD);
    const samAside12 = () => kvStashes().find(s => s.owner && s.owner.username === 'sam' && s.dirty && has(s, 'Sam discards this'));
    check('(alex signing in sets it aside, never over it)', Boolean(samAside12()) && kvTree().owner.username === 'alex');
    const mark12 = created.length;
    await byId('settingsBtn').fire('click');
    await settle();
    await sleep(50);
    const row12 = [...created.slice(mark12)].reverse().find(e => typeof e.className === 'string' && e.className.includes('stash-row')
        && /\|2(#|$)/.test(e.dataset.key || ''));
    const discard12 = row12 && row12.children[2] && row12.children[2].children.find(b => b.dataset && b.dataset.stashAct === 'discard');
    check('Settings lists the copy set aside, with Discard', Boolean(discard12) && /sam/.test(row12.children[0].children[0].textContent)
        && /1 unpushed edit/.test(row12.children[1].textContent), row12 ? row12.children[1].textContent : 'no row');
    answers.prompt.push('someone else');
    await discard12.fire('click');
    await settle();
    check('  discarding asks for its name: a wrong one discards nothing', Boolean(samAside12()));
    answers.prompt.push('sam');
    await discard12.fire('click');
    await settle();
    check('  the right one discards it, for good', !samAside12() && /Discard .*sam.*Type sam to confirm/s.test(dialogs.prompt[dialogs.prompt.length - 1]));
    byId('settings-sheet').classList.add('hidden');
    await coldStart(`${BASE}/`, { tag: 'w12c' });
    check('the next start does not bring back the copy discarded on purpose', !/Restored unpushed changes/.test(statusText())
        && !has(kvTree(), 'Sam discards this') && !samAside12(), statusText());

    // =================================================================================
    console.log('\n13. Without Web Locks (a plain-http address)');
    withLocks = false;
    globalThis.isSecureContext = false;
    await coldStartChannel(`${BASE}/`, { tag: 'h13' });
    check('without Web Locks the app edits, the channel standing in', !guardShown() && Boolean(kvTree()) && !kvTree().dirty
        && (idb.peek('tpPrimary') || {}).id !== undefined);
    // Another window took the copy while this one could not answer, claimed
    // it and closed; no freeze event came: back, nobody answers, but the claim
    // is not this window's — it starts again rather than lose its next edit.
    idb.poke('tpPrimary', { id: 'other13', at: Date.now() });
    reloadsBefore = reloads;
    visibility = 'visible';
    fireDocument('visibilitychange');
    await until(() => reloads > reloadsBefore, 3000);
    check('back after another window claimed the copy and closed: it starts again from what is kept', reloads === reloadsBefore + 1);
    await coldStartChannel(`${BASE}/`, { tag: 'h13b' });
    fireWindow('pagehide', { persisted: true });
    await pastCopyWrite();
    const o13 = otherWindow('o13', { channel: true });
    check('into the back-forward cache, it lets go of the copy: a window starting meanwhile edits', (await o13.start()) === 'primary');
    idb.poke('tpPrimary', { id: 'o13', at: Date.now() });
    o13.close();
    reloadsBefore = reloads;
    fireWindow('pageshow', { persisted: true });
    await until(() => reloads > reloadsBefore, 3000);
    check('  back, that one having claimed the copy and closed: it starts again from what is kept', reloads === reloadsBefore + 1);
    await coldStartChannel(`${BASE}/`, { tag: 'h13c' });
    fireWindow('pagehide', { persisted: true });
    await pastCopyWrite();
    reloadsBefore = reloads;
    fireWindow('pageshow', { persisted: true });
    await sleep(700);
    offline = /^PUT \/api\/tree$/;
    await newFolder('Edited on in place without Web Locks');
    offline = null;
    await pastCopyWrite();
    check('  back with nobody having claimed it: it edits on in place', reloads === reloadsBefore && !guardShown()
        && has(kvTree(), 'Edited on in place without Web Locks'));

    // Work the device could not keep (a full disk) is never let go of.
    await coldStartChannel(`${BASE}/`, { tag: 'h13d' });
    idb.ctl.quotaFull = true;
    cachesFull = true;
    offline = /^PUT \/api\/tree$/;
    await newFolder('Unkept without Web Locks');
    offline = null;
    await pastCopyWrite();
    check('(a full disk: the edit is held in this window only)', !has(kvTree(), 'Unkept without Web Locks') && unloadAsks());
    fireDocument('freeze');
    await sleep(50);
    const o13d = otherWindow('o13d', { channel: true });
    check('  frozen meanwhile, it keeps the copy: a window starting meanwhile is told one edits', (await o13d.start()) === 'secondary' && !guardShown());
    fireDocument('resume');
    channelHub.freeze(currentTag);
    const r13d = await o13d.take();
    channelHub.freeze(currentTag, false);
    visibility = 'visible';
    fireDocument('visibilitychange');
    await until(() => guardShown(), 3000);
    check('  robbed anyway (it could not answer), it keeps them behind the card, saying so, and closing asks first', r13d.ok
        && guardShown() && /could not keep/.test(byId('primary-guard-note').textContent) && unloadAsks(), byId('primary-guard-note').textContent);
    idb.ctl.quotaFull = false;
    cachesFull = false;
    reloadsBefore = reloads;
    await byId('primary-take').fire('click');
    await until(() => !guardShown(), 4000);
    await pastCopyWrite();
    check('  Use here carries on with them in place, not starting again, and they are kept now', !guardShown() && reloads === reloadsBefore
        && o13d.events.includes('yielded') && has(kvTree(), 'Unkept without Web Locks'), JSON.stringify(o13d.events));
    o13d.close();
    channelHub.closeTag('o13d');
    withLocks = true;
    globalThis.isSecureContext = true;
    // =================================================================================
    console.log('\n14. The upgrade from the last release, with everything it kept, and a step back to it');
    // What the last release kept in IndexedDB: alex's copy with two unpushed
    // edits, a note half-written in it (its live draft, of a window that is
    // gone), a note a sign-out set aside in it, an import link whose note is
    // in it, and a copy of sam's it set aside, with a note of sam's.
    closePage();
    lockHub.closeTag(currentTag);
    channelHub.closeTag(currentTag);
    const A14 = (await api('/api/login', { method: 'POST', body: { username: 'alex', password: PASSWORD } })).json.token;
    const t14 = await tree(A14);
    const roots14 = JSON.parse(JSON.stringify(t14.roots));
    roots14.find(r => r.role === 'bookmarks').children.push({ id: 'aaaaaaaaaaaa0014', kind: 'folder', title: 'Unpushed in the last release', children: [
        { id: 'aaaaaaaaaaab0014', kind: 'bookmark', title: 'Kept link', url: 'https://kept.example/14' }] });
    const link14 = 'link-held-14';
    localStorageShim.setItem('tp_pending_import', JSON.stringify([{ id: link14, hash: '#note=' + encodeURIComponent('# Held\n\nHELD BY THE COPY'),
        at: new Date().toISOString(), account: `${BASE}|name:alex` }]));
    const savedAt14 = new Date(Date.now() - 2000).toISOString();
    idb.poke('tpTree', DC.toKvRecord({
        v: 1, savedAt: savedAt14, account: accountOf(alexLogin), roots: roots14, version: t14.version, dirty: true, editCount: 2,
        importIds: [link14], serverIds: idsIn(t14.roots), pathIds: [],
        keptDraft: { pane: 'note', editing: true, isNew: true, draft: '# Kept by a sign-out\n\nKEPT BY THE LAST RELEASE', loaded: '' }
    }, { copyId: 'copy-of-the-last-release', seq: 3 }));
    idb.poke('tpLiveDraft', DC.liveDraftsFor({ pane: 'note', editing: true, isNew: true, draft: '# Half\n\nHALF IN THE LAST RELEASE', loaded: '' },
        accountOf(alexLogin), 'window-of-the-last-release', savedAt14));
    const samLogin14 = (await api('/api/login', { method: 'POST', body: { username: 'sam', password: 'sam-password-1' } })).json;
    const samRec14 = DC.toKvRecord({ v: 1, savedAt: savedAt14, account: accountOf(samLogin14), roots: [{ id: 'aaaaaaaaaaac0014', kind: 'folder', title: 'Sam set aside', children: [] }],
        version: 1, dirty: true, editCount: 1, importIds: [], serverIds: [], pathIds: [] }, { copyId: 'sams-copy-14', seq: 2 });
    const index14 = idb.peek('tpTreeStashIndex') || [];
    const samStash14 = DC.stashEntry(samRec14, DC.liveDraftsFor({ pane: 'note', editing: true, isNew: true, draft: 'SAMS NOTE IN HIS COPY', loaded: '' },
        accountOf(samLogin14), 'sams-window'), index14, Date.now(), 'set-aside-by-another-window');
    idb.poke(samStash14.key, samStash14.value);
    idb.poke('tpTreeStashIndex', [...index14, samStash14.key]);
    await putTpData(null);
    localStorageShim.removeItem('tp_copy_tpdata_at');
    localStorageShim.removeItem('tp_copy_cleared_at');
    await signInStorage('alex', PASSWORD);
    pullsBefore = pulls();
    await coldStart(`${BASE}/`, { tag: 'u14' });
    await pastDraftWrite();
    const up14 = kvTree();
    check('the copy comes through: TreeStore\'s record now, the same copy, alex\'s, with both unpushed edits, and no pull over it',
        pulls() === pullsBefore && /Restored unpushed changes/.test(statusText()) && up14.pwa >= 33 && up14.copyId === 'copy-of-the-last-release'
        && up14.dirty && up14.editCount === 2 && up14.owner.username === 'alex' && has(up14, 'Unpushed in the last release') && has(up14, 'Kept link'),
        JSON.stringify({ st: statusText(), pulls: pulls() - pullsBefore, pwa: up14.pwa, copyId: up14.copyId, editCount: up14.editCount }));
    check('  the import link whose note is in it stays held by it, kept on the phone and not offered again',
        JSON.stringify(up14.meta.importIds) === JSON.stringify([link14]) && JSON.stringify(up14.importIds) === JSON.stringify([link14])
        && JSON.parse(localStorageShim.getItem('tp_pending_import') || '[]').some(p => p.id === link14) && !/HELD BY THE COPY/.test(lastEditorText() || ''),
        JSON.stringify({ meta: up14.meta.importIds, ids: up14.importIds, pending: localStorageShim.getItem('tp_pending_import'), ed: lastEditorText() }));
    check('  the half-written note is back in its editor, kept as this window\'s own live draft now',
        /HALF IN THE LAST RELEASE/.test(lastEditorText() || '') && bodyHasEditing() && draftTexts().some(t => /HALF IN THE LAST RELEASE/.test(t))
        && !(kvDrafts() || {})['window-of-the-last-release'], JSON.stringify(Object.keys(kvDrafts() || {})));
    check('  the note a sign-out set aside is parked for alex, to come back when the editor is free',
        parkedNotes().some(d => /KEPT BY THE LAST RELEASE/.test(d.content) && d.owner && d.owner.username === 'alex'));
    const sam14 = idb.peek(samStash14.key);
    check('  sam\'s set-aside copy stays set aside, with its unpushed edit; its note parked for sam; kept from coming back on its own',
        sam14 && sam14.dirty && has(sam14, 'Sam set aside') && sam14.ownerWas && sam14.ownerWas.username === 'sam' && !sam14.owner
        && parkedNotes().some(d => d.content === 'SAMS NOTE IN HIS COPY' && d.owner && d.owner.username === 'sam'));
    // A step back to the last release: what it reads finds the copy as it is.
    const back14 = DC.fromKvRecord(kvTree(), kvDrafts());
    const tp14 = await tpData();
    const pick14 = DC.chooseKept({ kv: back14, tp: tp14, tpWrittenAt: localStorageShim.getItem('tp_copy_tpdata_at'), clearedAt: localStorageShim.getItem('tp_copy_cleared_at') });
    check('a step back to the last release reads the copy: alex\'s, dirty, with its edits, its import link, the note being written and the one set aside',
        back14 && back14.v === 1 && back14.dirty && back14.account.username === 'alex' && back14.account.userId === alexLogin.user.id
        && has(back14, 'Unpushed in the last release') && JSON.stringify(back14.importIds) === JSON.stringify([link14])
        && back14.nv && /HALF IN THE LAST RELEASE/.test(back14.nv.draft) && back14.keptDraft && /KEPT BY THE LAST RELEASE/.test(back14.keptDraft.draft)
        && pick14.rec && !pick14.drop && has(pick14.rec, 'Unpushed in the last release'),
        JSON.stringify({ from: pick14.from, drop: pick14.drop, acct: back14 && back14.account, ids: back14 && back14.importIds, kept: back14 && back14.keptDraft }));
    check('  and tp-data holds the same copy in its shape, for one older still', tp14 && tp14.v === 1 && tp14.savedAt === kvTree().savedAt
        && tp14.dirty && tp14.account.username === 'alex' && has(tp14, 'Unpushed in the last release') && JSON.stringify(tp14.importIds) === JSON.stringify([link14])
        && tp14.keptDraft && /KEPT BY THE LAST RELEASE/.test(tp14.keptDraft.draft),
        JSON.stringify({ tp: tp14 && { v: tp14.v, savedAt: tp14.savedAt, dirty: tp14.dirty, acct: tp14.account }, kv: kvTree().savedAt }));
    await clickNv('done');
    await byId('pushBtn').fire('click');
    await settle();
    const after14 = await tree(A14);
    check('everything it kept pushes from here, and the held link goes with the push', Boolean(byTitle(after14.roots, 'Unpushed in the last release'))
        && JSON.stringify(after14.roots).includes('HALF IN THE LAST RELEASE') && !kvTree().dirty
        && !JSON.parse(localStorageShim.getItem('tp_pending_import') || '[]').some(p => p.id === link14));
    reloadsBefore = reloads;
    await coldStart(`${BASE}/`, { tag: 'u14b' });
    check('  and the note the sign-out set aside comes back into the editor at the next start', /KEPT BY THE LAST RELEASE/.test(lastEditorText() || '')
        && bodyHasEditing() && !parkedNotes().some(d => /KEPT BY THE LAST RELEASE/.test(d.content)), lastEditorText());
    answers.confirm.push(true); // Discard unsaved changes?
    await clickNv('cancel-edit');
    // =================================================================================
    console.log('\n15. A push of a copy that is another account\'s (412): set aside, never pulled over or forced');
    // Another window brings sam's copy in and edits it; this window is
    // still signed in as alex, and pushes.
    const x15 = await otherCoreWindow('x15');
    const sam15 = (await api('/api/login', { method: 'POST', body: { username: 'sam', password: 'sam-password-1' } })).json;
    await x15.T.switchAccount({ ...accountOf(sam15), previousUsername: 'alex' });
    await x15.T.createNode({ parentId: null, kind: 'folder', title: 'Sams unpushed folder' });
    await x15.T.flush();
    await until(() => has(kvTree(), 'Sams unpushed folder'), 3000);
    await settle();
    const alexBefore15 = await tree(A14);
    const samBefore15 = await tree(sam15.token);
    let mark15 = created.length;
    answers.confirm.push(false); // This working copy belongs to another account: Cancel
    await byId('pushBtn').fire('click');
    await settle();
    check('this window (alex) pushing the copy another window made sam\'s is refused (412), never drawn as alex\'s, and Cancel changes nothing',
        /another account/.test(statusText()) && kvTree().owner.username === 'sam' && has(kvTree(), 'Sams unpushed folder') && kvTree().dirty
        && (await tree(A14)).version === alexBefore15.version && (await tree(sam15.token)).version === samBefore15.version
        && !drawnSince(mark15, 'Sams unpushed folder'), statusText());
    mark15 = created.length;
    answers.confirm.push(true); // Set it aside and pull this account's tree
    await byId('pushBtn').fire('click');
    await settle();
    await pastCopyWrite();
    const aside15 = kvStashes().find(s => s.owner && s.owner.username === 'sam' && has(s, 'Sams unpushed folder'));
    const alexAfter15 = await tree(A14);
    check('  OK sets sam\'s copy aside with its unpushed edit, and pulls alex\'s tree: nothing goes into either account',
        Boolean(aside15) && aside15.dirty && kvTree().owner.username === 'alex' && !kvTree().dirty && !has(kvTree(), 'Sams unpushed folder')
        && alexAfter15.version === alexBefore15.version && (await tree(sam15.token)).version === samBefore15.version
        && /set aside/.test(statusText()) && !drawnSince(mark15, 'Sams unpushed folder'),
        JSON.stringify({ st: statusText(), owner: kvTree().owner, aside: Boolean(aside15) }));
    check('  and the other window has alex\'s copy now too, sam\'s kept for sam', await until(() => Boolean(x15.T.status().owner) && x15.T.status().owner.username === 'alex', 3000));
    x15.close();
} catch (e) {
    failures++;
    console.error('FAIL  run stopped:', e, '\n' + serverLog.slice(-2000));
} finally {
    server.kill();
    await serverExited;
    try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) { /* temp */ }
}

console.log(failures === 0 ? '\nAll durable-copy tests passed.\n' : `\n${failures} test(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
