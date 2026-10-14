// The web app's working copy, kept on the device (pwa/durableCopy.js and its
// wiring in pwa/app.js): first the module on its own, then the app in a
// minimal DOM against a real server, with in-memory stand-ins for IndexedDB,
// Cache Storage, Web Locks, BroadcastChannel and navigator.storage (Node has
// no IndexedDB, and fake-indexeddb is not a dependency).
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
//   3. One window edits: a second waits, then says so; 'Use here' has the
//      holder write down and let go; a holder that cannot write refuses; a
//      slow writer is waited for; a frozen one is robbed and hears it; with
//      no Web Locks a BroadcastChannel stands in, and a window that edited
//      while another was frozen makes that one stop when it wakes.
//   4. persist(): granted, declined, failing, or not offered.
//   5. The app, seeded from tp-data on its first start: a dirty copy with a
//      half-written note comes back without a pull, goes into IndexedDB as it
//      was, and tp-data keeps being written beside it.
//   6. A reload (no hide, no pagehide: the app killed) keeps unpushed edits
//      and the note being typed, from IndexedDB, over an older tp-data.
//   7. A step back and forward again: tp-data written later by the previous
//      release wins; a copy the previous release cleared is not offered
//      again as unpushed edits, and is set aside rather than lost.
//   8. Two windows: the one asked to let go writes down an edit still in its
//      debounce and the note being typed, then shows 'open in another tab'
//      and writes nothing more; a window starting meanwhile waits behind the
//      card and touches nothing; 'Use here' brings the copy and the note
//      over; coming back to a window behind the card once the other closed
//      makes it edit again; a share or an import link takes over at once; a
//      refusal is said; a frozen holder is taken from; a write fenced by a
//      later claim writes nothing and stops the window.
//   9. Accounts: a copy kept over a sign-out comes back for its account
//      only; a clean sign-out clears it from IndexedDB and tp-data; a copy
//      kept for another account is never written over by the one signed in,
//      and a window holding that one's unpushed edits (which the device
//      cannot keep meanwhile) refuses to hand them over, saying why.
//  10. Storage trouble: a full disk says so once, keeps the edits in the
//      window (closing asks first), and the next write that fits clears the
//      warning; without IndexedDB the app keeps the copy in tp-data as
//      before; Settings › Storage shows where the copy is and whether the
//      browser may clear it, and 'Keep my data on this phone' asks from the
//      click and says what the browser answered. Work the device could not
//      keep (a full disk, or another account's copy kept) is never let go
//      of: frozen, the window keeps the copy; robbed anyway, it keeps the
//      work behind the card (closing asks), and Use here or the other window
//      closing carries on with it in place, another window's kept work set
//      aside, not written over.
//  11. Losing the copy part-way: a start that hands the copy over stops (no
//      pull, no question behind the card); Use here asked again while it
//      claims stays behind the card; a window robbed while a dialog held it
//      up pushes nothing; an import link arriving while the window comes back
//      from being away is opened, or brings the copy back with it.
//  12. A clear that did not reach both places (IndexedDB refusing, or Cache
//      Storage) never brings that copy back at the next start.
//  13. Without Web Locks (a plain-http address): two windows that claimed at
//      once never both write; one back after another claimed the copy and
//      closed starts again from what is kept; back with nobody having
//      claimed it, it edits on in place.
//
// Run: node tools/test_pwa_durable.mjs [--port 18987]

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
// told, as a closed page does.
function makeLockHub() {
    const held = new Map();   // name -> { tag, done, reject }
    const queues = new Map(); // name -> [request]
    const abortErr = (m = 'aborted') => Object.assign(new Error(m), { name: 'AbortError' });
    const queue = (name) => queues.get(name) || (queues.set(name, []), queues.get(name));

    function grant(name, r) {
        const entry = { tag: r.tag, done: false, reject: r.reject };
        held.set(name, entry);
        r.granted = true;
        queueMicrotask(() => {
            let ret;
            try { ret = r.cb({ name, mode: 'exclusive' }); } catch (e) { finish(e, true); return; }
            Promise.resolve(ret).then(v => finish(v, false), e => finish(e, true));
        });
        function finish(v, failed) {
            if (entry.done) return;
            entry.done = true;
            if (held.get(name) === entry) { held.delete(name); next(name); }
            if (failed) r.reject(v); else r.resolve(v);
        }
    }
    function next(name) {
        if (held.has(name)) return;
        const q = queue(name);
        while (q.length) {
            const r = q.shift();
            if (!r.aborted) { grant(name, r); return; }
        }
    }
    function forTag(tag) {
        return {
            request(name, opts, cb) {
                if (typeof opts === 'function') { cb = opts; opts = {}; }
                return new Promise((resolve, reject) => {
                    const r = { tag, cb, resolve, reject, aborted: false, granted: false };
                    if (opts.steal) {
                        const cur = held.get(name);
                        if (cur) {
                            cur.done = true;
                            held.delete(name);
                            cur.reject(abortErr('The lock was stolen'));
                        }
                        grant(name, r);
                        return;
                    }
                    if (opts.ifAvailable) {
                        if (held.has(name) || queue(name).length) {
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
                    if (!held.has(name) && !queue(name).length) grant(name, r);
                    else queue(name).push(r);
                });
            }
        };
    }
    function closeTag(tag) {
        for (const [name, q] of queues) queues.set(name, q.filter(r => r.tag !== tag));
        for (const [name, e] of [...held]) {
            if (e.tag !== tag) continue;
            e.done = true;
            held.delete(name);
            next(name);
        }
    }
    return { forTag, closeTag, holder: (name = 'tp-primary') => (held.get(name) || {}).tag || null };
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
    console.log('\n8. Two windows');
    const A8 = (await api('/api/login', { method: 'POST', body: { username: 'alex', password: PASSWORD } })).json.token;
    await byId('notesBtn').fire('click');
    await clickNv('new-note');
    await typeNote('# Mid-note\n\nHANDED OVER MID-NOTE');
    offline = /^PUT \/api\/tree$/;
    answers.prompt.push('Edited before the hand-over');
    const editing = byId('newFolderBtn').fire('click');
    await sleep(10);
    // Another window asks for the copy at once: the edit is still in its
    // debounce, the note has not paused.
    const commitsBefore = idb.ctl.commits;
    const x = otherWindow('x1');
    const took = await x.take();
    await editing;
    offline = null;
    check('another window asks: this one writes down what it holds, and lets go', took.ok && took.how === 'yielded'
        && x.isPrimary() && lockHub.holder() === 'x1', JSON.stringify(took));
    check('  the edit still in its debounce is written', has(kvTree(), 'Edited before the hand-over') && kvTree().dirty);
    check('  and the note being typed', draftTexts().some(s => /HANDED OVER MID-NOTE/.test(s)), JSON.stringify(kvDrafts()));
    check('this window says the app is open in another tab', guardShown() && /open in another tab/.test(byId('primary-guard-title').textContent)
        && byId('primary-guard-text').textContent.length > 0);
    const commitsAfterYield = idb.ctl.commits;
    visibility = 'hidden';
    fireDocument('visibilitychange');
    fireWindow('pagehide');
    await sleep(100);
    visibility = 'visible';
    check('  and writes nothing more, hidden or closing', idb.ctl.commits === commitsAfterYield && commitsAfterYield > commitsBefore);
    check('  and closing it asks nothing: what it held is the other window\'s now', !unloadAsks());

    pullsBefore = pulls();
    const commits8 = idb.ctl.commits;
    await coldStart(`${BASE}/`, { tag: 'v8' });
    await until(() => guardShown(), 3000);
    check('a window started meanwhile waits behind the card, and touches nothing', guardShown() && pulls() === pullsBefore
        && idb.ctl.commits === commits8 && lockHub.holder() === 'x1');
    await byId('primary-take').fire('click');
    await until(() => !guardShown() && /Restored/.test(statusText()), 4000);
    check('Use here: the other window lets go, and this one has the copy, the edit and the note', !guardShown()
        && x.events.includes('yielded') && lockHub.holder() === 'v8' && /Restored unpushed changes/.test(statusText())
        && pulls() === pullsBefore && /HANDED OVER MID-NOTE/.test(lastEditorText() || ''), JSON.stringify({ st: statusText(), ev: x.events }));
    check('  without reloading itself', reloads === 0);
    await clickNv('done');
    await byId('pushBtn').fire('click');
    await settle();
    t = await tree(A8);
    check('  and both push from here', Boolean(byTitle(t.roots, 'Edited before the hand-over')) && JSON.stringify(t.roots).includes('HANDED OVER MID-NOTE'));

    // The window that took the copy closes (a share filed, say): coming back
    // to this one, it edits again — after starting afresh, its memory being
    // from before.
    const x1b = otherWindow('x1b');
    check('(another window takes the copy)', (await x1b.take()).ok && guardShown());
    let reloadsBefore = reloads;
    visibility = 'visible';
    fireDocument('visibilitychange');
    await sleep(100);
    check('coming back while the other window edits changes nothing', guardShown() && reloads === reloadsBefore && lockHub.holder() === 'x1b');
    lockHub.closeTag('x1b');
    channelHub.closeTag('x1b');
    fireDocument('visibilitychange');
    await until(() => reloads > reloadsBefore, 3000);
    check('coming back once it closed: this window edits again, starting afresh', reloads === reloadsBefore + 1 && lockHub.holder() === 'v8');

    // A share opens a window while another edits: it takes over at once.
    await coldStart(`${BASE}/`, { tag: 'v8b' });
    const x2 = otherWindow('x2');
    check('(another window takes the copy)', (await x2.take()).ok && guardShown());
    const shared8 = Share.makeEntry({ fields: { title: '', text: '', url: 'https://example.com/shared-into-another-window' }, account: accountOf(alexLogin), source: 'share' });
    await Share.cacheOutbox(cachesShim).put(shared8);
    await coldStart(`${BASE}/?share=${shared8.sid}`, { tag: 'u8' });
    await until(() => sheetOpen(), 4000);
    check('a window a share opens takes the copy over at once, and shows the share', sheetOpen() && !guardShown()
        && x2.events.includes('yielded') && lockHub.holder() === 'u8');
    // An import link tapped in a window that does not edit: the copy moves there.
    const x2b = otherWindow('x2b');
    check('(another window takes the copy)', (await x2b.take()).ok && guardShown());
    H.entries.push({ state: null, url: `${BASE}/#note=` + encodeURIComponent('# Linked\n\nLINKED INTO A WAITING WINDOW') });
    H.index++;
    reloadsBefore = reloads;
    fireWindow('hashchange');
    await until(() => reloads > reloadsBefore, 4000);
    check('an import link tapped in a window behind the card brings the copy there (this window held it before: it starts again)',
        reloads === reloadsBefore + 1 && x2b.events.includes('yielded') && lockHub.holder() === 'u8');

    // A window that cannot write what it holds refuses.
    const x3 = otherWindow('x3');
    await coldStart(`${BASE}/`, { tag: 'u8b' });
    check('(another window takes the copy)', (await x3.take()).ok);
    x3.answer = async () => false;
    const shared8b = Share.makeEntry({ fields: { title: '', text: '', url: 'https://example.com/refused' }, account: accountOf(alexLogin), source: 'share' });
    await Share.cacheOutbox(cachesShim).put(shared8b);
    await coldStart(`${BASE}/?share=${shared8b.sid}`, { tag: 't8', wait: false });
    await until(() => guardShown(), 8000);
    check('a holder that cannot write keeps the copy: the window the share opened waits behind the card, saying why', guardShown()
        && lockHub.holder() === 'x3' && x3.events.includes('yield') && /could not save/.test(byId('primary-guard-note').textContent),
        byId('primary-guard-note').textContent);
    byId('primary-guard-note').textContent = '';
    await byId('primary-take').fire('click');
    await until(() => /could not save/.test(byId('primary-guard-note').textContent), 4000);
    check('  Use here says why it could not', /could not save/.test(byId('primary-guard-note').textContent) && guardShown(),
        byId('primary-guard-note').textContent);
    x3.answer = async () => true;
    await byId('primary-take').fire('click');
    await until(() => !guardShown(), 4000);
    await settle();
    check('  and works once it can', !guardShown() && lockHub.holder() === 't8' && sheetOpen());

    // A holder frozen in the background never answers: it is taken from.
    const x4 = otherWindow('x4');
    check('(another window takes the copy)', (await x4.take()).ok);
    channelHub.freeze('x4');
    const shared8c = Share.makeEntry({ fields: { title: '', text: '', url: 'https://example.com/frozen' }, account: accountOf(alexLogin), source: 'share' });
    await Share.cacheOutbox(cachesShim).put(shared8c);
    await coldStart(`${BASE}/?share=${shared8c.sid}`, { tag: 's8', wait: false });
    await until(() => sheetOpen() && !guardShown(), 10000);
    check('a holder that never answers (frozen) is taken from, and hears it when it wakes', sheetOpen() && !guardShown()
        && lockHub.holder() === 's8' && x4.events.includes('lost:stolen'), JSON.stringify(x4.events));
    channelHub.freeze('x4', false);

    // A window that never edited, waiting behind the card while another
    // edits: once that one is gone, coming back to it starts it, in place.
    const x5 = otherWindow('x5');
    check('(another window takes the copy)', (await x5.take()).ok);
    pullsBefore = pulls();
    await coldStart(`${BASE}/`, { tag: 'q8' });
    await until(() => guardShown(), 3000);
    check('(a window starts behind the card)', guardShown() && pulls() === pullsBefore);
    lockHub.closeTag('x5');
    channelHub.closeTag('x5');
    reloadsBefore = reloads;
    fireWindow('focus');
    await until(() => !guardShown(), 3000);
    await settle();
    check('the other window gone, coming back to this one starts it there, without a reload', !guardShown()
        && lockHub.holder() === 'q8' && reloads === reloadsBefore && Boolean(kvTree()));

    // Away (the back-forward cache, frozen in the background) a window lets
    // go of the copy; back, it edits on in place when nobody claimed it.
    offline = /^PUT \/api\/tree$/;
    await newFolder('Written before going away');
    offline = null;
    fireWindow('pagehide', { persisted: true });
    await pastCopyWrite();
    check('a window going into the back-forward cache writes down, and lets go of the copy', lockHub.holder() === null
        && has(kvTree(), 'Written before going away') && !guardShown());
    fireWindow('pageshow', { persisted: true });
    await until(() => lockHub.holder() === 'q8', 2000);
    offline = /^PUT \/api\/tree$/;
    await newFolder('Written after coming back');
    offline = null;
    await pastCopyWrite();
    check('  back, nobody having claimed it, it edits on in place', lockHub.holder() === 'q8' && reloads === reloadsBefore
        && !guardShown() && has(kvTree(), 'Written after coming back'));
    fireDocument('freeze');
    await sleep(50);
    const away = otherWindow('x6');
    check('(frozen, it lets go too, and another window takes the copy at once)', lockHub.holder() === null
        && (await away.take()).ok && away.isPrimary());
    fireDocument('resume');
    await until(() => guardShown(), 2000);
    check('  back while that one edits: this one shows the card', guardShown() && lockHub.holder() === 'x6' && reloads === reloadsBefore);
    away.close();
    lockHub.closeTag('x6');
    fireWindow('focus');
    await until(() => reloads > reloadsBefore, 2000);
    check('  and starts again from what is kept once it is gone', reloads === reloadsBefore + 1 && lockHub.holder() === 'q8');
    await coldStart(`${BASE}/`, { tag: 'q8b' });
    // Away, and another window claims the copy and closes again meanwhile.
    fireWindow('pagehide', { persisted: true });
    await pastCopyWrite();
    idb.poke('tpPrimary', { id: 'meanwhile', at: Date.now() });
    reloadsBefore = reloads;
    fireWindow('pageshow', { persisted: true });
    await until(() => reloads > reloadsBefore, 2000);
    check('back after another window claimed the copy (and closed): it starts again from what is kept', reloads === reloadsBefore + 1);
    await coldStart(`${BASE}/`, { tag: 'q8c' });
    check('(the next window edits)', lockHub.holder() === 'q8c' && !guardShown());

    // Another window claimed the copy since (a window that took it while this
    // one was frozen): this one's next write writes nothing, and it stops.
    idb.poke('tpPrimary', { id: 'ghost', at: Date.now() });
    offline = /^PUT \/api\/tree$/;
    await newFolder('Never written');
    offline = null;
    await pastCopyWrite();
    check('a write that meets a later claim writes nothing, and this window stops editing', !has(kvTree(), 'Never written')
        && guardShown() && lockHub.holder() === null);

    // =================================================================================
    console.log('\n9. A copy belongs to its account');
    await coldStart(`${BASE}/`, { tag: 'w9' });
    check('(the next window edits, from the last good write)', !guardShown() && lockHub.holder() === 'w9' && !has(kvTree(), 'Never written'));
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
        JSON.stringify({ st: statusText(), guard: guardShown(), holder: lockHub.holder(), req: requests.slice(-6) }));
    await signIn('sam', 'sam-password-1');
    check('sam cannot sign in over it', /for alex/.test(byId('auth-error').textContent) && !localStorageShim.getItem('tp_pwa_token')
        && kvTree().owner.username === 'alex');
    pullsBefore = pulls();
    await signIn('alex', PASSWORD);
    await byId('pushBtn').fire('click');
    await settle();
    const A9 = (await api('/api/login', { method: 'POST', body: { username: 'alex', password: PASSWORD } })).json.token;
    check('alex has it back without a pull over it, and pushes it', pulls() === pullsBefore && Boolean(byTitle((await tree(A9)).roots, 'Kept for alex')));
    await byId('auth-signout').fire('click');
    await settle();
    await pastCopyWrite();
    check('a clean sign-out clears the copy from IndexedDB and tp-data', kvTree() === undefined && kvDrafts() === undefined
        && (await tpData()) === null && localStorageShim.getItem('tp_copy_tpdata_at') === null);
    await signIn('sam', 'sam-password-1');
    await pastCopyWrite();
    check('sam signs in and his copy is kept as his', kvTree() && kvTree().owner.username === 'sam' && !has(kvTree(), 'Kept for alex'));

    // A copy kept for alex, with work in it, while sam is signed in.
    const alexNow = (await api('/api/login', { method: 'POST', body: { username: 'alex', password: PASSWORD } })).json;
    const alexTree = await tree(alexNow.token);
    const alexRoots = JSON.parse(JSON.stringify(alexTree.roots));
    alexRoots.find(r => r.role === 'bookmarks').children.push({ id: 'aaaaaaaaaaaa0009', kind: 'folder', title: 'Alex elsewhere', children: [] });
    idb.poke('tpTree', DC.toKvRecord({ v: 1, savedAt: new Date().toISOString(), account: accountOf(alexNow), roots: alexRoots,
        version: alexTree.version, dirty: true, editCount: 1, importIds: [], serverIds: idsIn(alexTree.roots), pathIds: [] }, { seq: 1 }));
    idb.poke('tpLiveDraft', DC.liveDraftsFor({ editing: true, isNew: true, draft: 'ALEX DRAFT ELSEWHERE', loaded: '' }, accountOf(alexNow), 'p-other'));
    await putTpData(null);
    const mark9 = toastMark();
    await coldStart(`${BASE}/`, { tag: 'w9c' });
    await pastCopyWrite();
    check('sam\'s start says the device keeps alex\'s unpushed changes', toastsSince(mark9).some(m => /keeps unpushed changes for alex/.test(m)));
    check('  and sam\'s pull is not written over them, nor over alex\'s note', kvTree().owner.username === 'alex' && kvTree().dirty
        && has(kvTree(), 'Alex elsewhere') && draftTexts().includes('ALEX DRAFT ELSEWHERE'));
    // sam's own edits cannot be kept on the device meanwhile: this window
    // keeps them rather than hand them to another.
    offline = /^PUT \/api\/tree$/;
    await newFolder('Sam unpushed');
    offline = null;
    await pastCopyWrite();
    const x9 = otherWindow('x9');
    const r9 = await x9.take();
    check('  so asked for the copy while sam has unpushed edits, this window refuses, saying why', !r9.ok && r9.how === 'refused'
        && r9.reason === 'foreign' && !guardShown() && lockHub.holder() === 'w9c' && kvTree().owner.username === 'alex', JSON.stringify(r9));
    x9.close();
    // Frozen while it holds them, it keeps the copy: a window started
    // meanwhile would start from without them, and nobody asks this one.
    fireDocument('freeze');
    await sleep(50);
    check('  frozen while it holds them, it keeps the copy', lockHub.holder() === 'w9c' && !guardShown());
    fireDocument('resume');
    await sleep(50);
    check('  and edits on when back', lockHub.holder() === 'w9c' && !guardShown() && unloadAsks());
    // Robbed anyway (frozen, it could not answer): they stay here.
    channelHub.freeze('w9c');
    const x9b = otherWindow('x9b');
    const r9b = await x9b.take();
    channelHub.freeze('w9c', false);
    await sleep(20);
    check('  robbed of the copy anyway, it keeps them behind the card, saying so, and closing asks first', r9b.ok && r9b.how === 'taken'
        && guardShown() && /could not keep/.test(byId('primary-guard-note').textContent) && unloadAsks(),
        JSON.stringify({ r9b, note: byId('primary-guard-note').textContent }));
    x9b.close();
    lockHub.closeTag('x9b');
    channelHub.closeTag('x9b');
    reloadsBefore = reloads;
    fireWindow('focus');
    await until(() => !guardShown(), 3000);
    check('  the other window gone, it carries on with them in place, rather than start again without them', !guardShown()
        && reloads === reloadsBefore && lockHub.holder() === 'w9c' && unloadAsks() && kvTree().owner.username === 'alex'
        && has(kvTree(), 'Alex elsewhere'));
    await byId('pushBtn').fire('click');
    await settle();
    const S9 = (await api('/api/login', { method: 'POST', body: { username: 'sam', password: 'sam-password-1' } })).json.token;
    check('  and pushes them', Boolean(byTitle((await tree(S9)).roots, 'Sam unpushed')));
    await byId('auth-signout').fire('click');
    await settle();
    check('  sam\'s clean sign-out leaves them', kvTree() && kvTree().owner.username === 'alex' && draftTexts().includes('ALEX DRAFT ELSEWHERE'));
    await signIn('alex', PASSWORD);
    check('  and alex has them back, with his note', /Restored unpushed changes/.test(statusText()) || /ALEX DRAFT ELSEWHERE/.test(lastEditorText() || ''),
        statusText());
    await clickNv('done');
    await byId('pushBtn').fire('click');
    await settle();
    t = await tree((await api('/api/login', { method: 'POST', body: { username: 'alex', password: PASSWORD } })).json.token);
    check('  to push them', Boolean(byTitle(t.roots, 'Alex elsewhere')) && JSON.stringify(t.roots).includes('ALEX DRAFT ELSEWHERE'));

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
    check('  frozen meanwhile, it keeps the copy: what it holds is nowhere else', lockHub.holder() === currentTag);
    fireDocument('resume');
    channelHub.freeze(currentTag);
    const x10 = otherWindow('x10');
    const r10 = await x10.take();
    channelHub.freeze(currentTag, false);
    await sleep(20);
    check('  robbed anyway (frozen, it could not answer), it keeps them behind the card, saying so', r10.ok && guardShown()
        && /could not keep/.test(byId('primary-guard-note').textContent) && unloadAsks());
    reloadsBefore = reloads;
    await byId('primary-take').fire('click');
    await until(() => !guardShown(), 4000);
    check('  Use here brings the copy back to them, in place', !guardShown() && reloads === reloadsBefore
        && lockHub.holder() === currentTag && x10.events.includes('yielded'), JSON.stringify(x10.events));
    x10.close();
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

    // Away with a write still to come that then fails (nothing had failed
    // when it let go): back after another window claimed the copy, kept an
    // edit of its own and closed, it carries on with what it holds rather
    // than start again without it, and sets that window's edit aside.
    idb.ctl.quotaFull = true;
    cachesFull = true;
    offline = /^PUT \/api\/tree$/;
    answers.prompt.push('Held through going away');
    await byId('newFolderBtn').fire('click');
    offline = null;
    fireDocument('freeze');
    await sleep(100);
    check('(it let go of the copy while away, and the write failed)', lockHub.holder() === null && !has(kvTree(), 'Held through going away'));
    const others10 = JSON.parse(JSON.stringify(kvTree().roots));
    others10.find(r => r.role === 'bookmarks').children.push({ id: 'aaaaaaaaaaaa0010', kind: 'folder', title: 'Kept by the other window', children: [] });
    idb.poke('tpTree', DC.toKvRecord({ v: 1, savedAt: new Date().toISOString(), account: accountOf(alexLogin), roots: others10,
        version: kvTree().baseVersion, dirty: true, editCount: 1, importIds: [], serverIds: kvTree().serverIds, pathIds: [] }, { seq: 1 }));
    idb.poke('tpPrimary', { id: 'meanwhile10', at: Date.now() });
    idb.ctl.quotaFull = false;
    cachesFull = false;
    reloadsBefore = reloads;
    const stashesBefore = (idb.peek('tpTreeStashIndex') || []).length;
    fireDocument('resume');
    await until(() => lockHub.holder() === currentTag, 2000);
    await pastCopyWrite();
    const index10 = idb.peek('tpTreeStashIndex') || [];
    const stash10 = index10.length > stashesBefore ? idb.peek(index10[index10.length - 1]) : null;
    check('  back after another window claimed the copy: it carries on with what it holds, not starting again', reloads === reloadsBefore
        && !guardShown() && has(kvTree(), 'Held through going away') && !has(kvTree(), 'Kept by the other window'),
        JSON.stringify({ reloads: reloads - reloadsBefore, guard: guardShown() }));
    check('  that window\'s kept edit is set aside, not written over', index10.length === stashesBefore + 1 && stash10
        && stash10.dirty && has(stash10, 'Kept by the other window') && stash10.why === 'set-aside-by-another-window', JSON.stringify(index10));

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
        'Held through going away', 'Only in tp-data', 'Without IndexedDB'].every(title => Boolean(byTitle(t.roots, title))));

    // =================================================================================
    console.log('\n11. Losing the copy part-way');
    // A link shared while nobody was signed in: a start asks about it.
    const unclaimed11 = Share.makeEntry({ fields: { title: '', text: '', url: 'https://example.com/shared-signed-out' }, account: null, source: 'share' });
    await Share.cacheOutbox(cachesShim).put(unclaimed11);
    pullsBefore = pulls();
    const confirms11 = dialogs.confirm.length;
    const reqMark11 = requests.length;
    slow = { re: /^GET \/api\/auth\/me$/, ms: 600 };
    await coldStart(`${BASE}/`, { tag: 'b11', wait: false });
    await until(() => requests.slice(reqMark11).includes('GET /api/auth/me'), 4000);
    const x11 = otherWindow('x11');
    const took11 = await x11.take();
    await sleep(700);
    slow = null;
    await settle();
    check('a start that hands the copy over before it is done goes no further: no pull, no question, behind the card', took11.ok
        && guardShown() && pulls() === pullsBefore && dialogs.confirm.length === confirms11 && lockHub.holder() === 'x11',
        JSON.stringify({ took11, pulls: pulls() - pullsBefore, confirms: dialogs.confirm.slice(confirms11), guard: guardShown() }));
    await Share.cacheOutbox(cachesShim).remove(unclaimed11.sid);

    // A window that never edited, Use here, and while it claims the copy a
    // third window asks for it: it stays behind the card.
    await coldStart(`${BASE}/`, { tag: 'q11' });
    await until(() => guardShown(), 3000);
    check('(a window starts behind the card)', guardShown() && lockHub.holder() === 'x11');
    idb.ctl.delay = 300;
    const using11 = byId('primary-take').fire('click');
    await until(() => lockHub.holder() === 'q11', 4000);
    const x11c = otherWindow('x11c');
    const took11c = await x11c.take();
    await using11;
    idb.ctl.delay = 0;
    await settle();
    check('Use here, asked for the copy again while it claims it: it stays behind the card, and starts nothing', took11c.ok
        && guardShown() && lockHub.holder() === 'x11c' && pulls() === pullsBefore, JSON.stringify({ took11c, guard: guardShown(),
            holder: lockHub.holder(), pulls: pulls() - pullsBefore }));
    for (const g of [x11, x11c]) g.close();
    lockHub.closeTag('x11c');

    // A dialog holds the window up while another takes the copy (it could
    // not answer): nothing it then does goes to the server.
    await coldStart(`${BASE}/`, { tag: 'p11' });
    check('(a window edits)', lockHub.holder() === 'p11' && !guardShown());
    const putsBefore11 = requests.filter(r => r === 'PUT /api/tree').length;
    answers.prompt.push(() => {
        lockHub.forTag('thief').request('tp-primary', { steal: true }, () => new Promise(() => {}));
        const claim = { id: 'thief', at: Date.now() };
        idb.poke('tpPrimary', claim);
        localStorageShim.setItem('tp_copy_claim', JSON.stringify(claim));
        return 'Made while robbed';
    });
    await byId('newFolderBtn').fire('click');
    await settle();
    const A11 = (await api('/api/login', { method: 'POST', body: { username: 'alex', password: PASSWORD } })).json.token;
    check('a window robbed of the copy while a dialog held it up pushes nothing when the dialog returns',
        requests.filter(r => r === 'PUT /api/tree').length === putsBefore11 && !byTitle((await tree(A11)).roots, 'Made while robbed'));
    check('  and stops, behind the card, keeping nothing of it', guardShown() && !has(kvTree(), 'Made while robbed'));
    lockHub.closeTag('thief');

    // An import link that arrives while the window is on its way back from
    // being frozen (its hashchange comes before the lock has answered).
    await coldStart(`${BASE}/`, { tag: 'r11' });
    check('(a window edits)', lockHub.holder() === 'r11' && !guardShown());
    fireDocument('freeze');
    await sleep(50);
    check('(frozen, it lets go of the copy)', lockHub.holder() === null);
    reloadsBefore = reloads;
    fireDocument('resume');
    historyShim.pushState(null, '', `${BASE}/#note=` + encodeURIComponent('# Linked on the way back\n\nLINKED WHILE COMING BACK'));
    fireWindow('hashchange');
    await until(() => /LINKED WHILE COMING BACK/.test(lastEditorText() || ''), 3000);
    await settle();
    check('an import link arriving while the window comes back is opened once it is back', /LINKED WHILE COMING BACK/.test(lastEditorText() || '')
        && !location.hash && reloads === reloadsBefore && lockHub.holder() === 'r11' && !guardShown(),
        JSON.stringify({ hash: location.hash, reloads: reloads - reloadsBefore, holder: lockHub.holder(), pending: localStorageShim.getItem('tp_pending_import') }));
    answers.confirm.push(true); // Discard unsaved changes?
    await clickNv('cancel-edit');
    fireDocument('freeze');
    await sleep(50);
    const x11d = otherWindow('x11d');
    check('(frozen again, and another window takes the copy)', (await x11d.take()).ok);
    reloadsBefore = reloads;
    fireDocument('resume');
    historyShim.pushState(null, '', `${BASE}/#note=` + encodeURIComponent('# Moves it\n\nLINK MOVES THE COPY BACK'));
    fireWindow('hashchange');
    await until(() => reloads > reloadsBefore, 5000);
    check('  one arriving while another window took the copy meanwhile brings the copy back, the link with it', reloads === reloadsBefore + 1
        && x11d.events.includes('yielded') && lockHub.holder() === 'r11' && /LINK MOVES THE COPY BACK/.test(decodeURIComponent(location.hash)),
        JSON.stringify({ reloads: reloads - reloadsBefore, ev: x11d.events, hash: location.hash }));
    x11d.close();
    lockHub.closeTag('x11d');

    // =================================================================================
    console.log('\n12. A clear that did not reach both places');
    await coldStart(`${BASE}/`, { tag: 'w12' });
    offline = /^PUT \/api\/tree$/;
    await newFolder('Stale in IndexedDB');
    offline = null;
    await pastCopyWrite();
    check('(an unpushed edit kept in IndexedDB)', kvTree().dirty && has(kvTree(), 'Stale in IndexedDB'));
    idb.ctl.quotaFull = true;
    await byId('pushBtn').fire('click');
    await settle();
    check('(pushed while IndexedDB fails: tp-data has the clean copy, IndexedDB still the dirty one)', !(await tpData()).dirty && kvTree().dirty);
    await byId('auth-signout').fire('click');
    await settle();
    idb.ctl.quotaFull = false;
    check('(a clean sign-out: tp-data cleared, IndexedDB refused to)', (await tpData()) === null && kvTree() && kvTree().dirty
        && Boolean(localStorageShim.getItem('tp_copy_cleared_at')));
    await coldStart(`${BASE}/`, { tag: 'w12b' });
    check('the next start does not bring back what the clear could not remove from IndexedDB', !/Restored unpushed changes/.test(statusText())
        && !guardShown(), statusText());
    await signIn('sam', 'sam-password-1');
    check('  nor does it keep anyone else from signing in', Boolean(localStorageShim.getItem('tp_pwa_token'))
        && !/for alex/.test(byId('auth-error').textContent), byId('auth-error').textContent);
    await pastCopyWrite();
    check('  and the first write reaching both places replaces it, the mark gone', kvTree() && kvTree().owner.username === 'sam'
        && !kvTree().dirty && localStorageShim.getItem('tp_copy_cleared_at') === null);

    // The other way round: IndexedDB clears, Cache Storage refuses — a
    // deliberate discard of sam's unpushed edits.
    offline = /^PUT \/api\/tree$/;
    await newFolder('Sam discards this');
    offline = null;
    answers.confirm.push(true); // Sign out anyway?
    await byId('auth-signout').fire('click');
    await settle();
    check('(sam\'s unpushed edit kept over a sign-out)', kvTree().dirty && kvTree().owner.username === 'sam' && (await tpData()).dirty);
    await signIn('alex', PASSWORD);
    check('(alex cannot sign in over it)', /for sam/.test(byId('auth-error').textContent) && !byId('auth-discard').classList.contains('hidden'));
    cachesFailDelete = true;
    answers.prompt.push('sam');
    await byId('auth-discard').fire('click');
    await settle();
    cachesFailDelete = false;
    check('(discarded: IndexedDB cleared, tp-data refused to)', kvTree() === undefined && (await tpData()) && (await tpData()).dirty
        && Boolean(localStorageShim.getItem('tp_copy_cleared_at')));
    await coldStart(`${BASE}/`, { tag: 'w12c' });
    check('the next start does not bring back the copy discarded on purpose, from tp-data either', !/Restored unpushed changes/.test(statusText())
        && kvTree() === undefined, statusText());
    await signIn('alex', PASSWORD);
    check('  and alex signs in', Boolean(localStorageShim.getItem('tp_pwa_token')) && !/for sam/.test(byId('auth-error').textContent),
        byId('auth-error').textContent);

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
    withLocks = true;
    globalThis.isSecureContext = true;
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
