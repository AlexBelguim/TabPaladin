// The web app's working copy, kept on this device between starts.
//
// Until now the copy lived in memory, with a snapshot in Cache Storage
// ('tp-data', /__tp_tree) written on a pull, a push, a filing and when the
// app went to the background. It now lives in IndexedDB — database
// 'tabpaladin', store 'kv', key 'tpTree' — written a moment after every change
// and at once when the app is hidden or goes away. The record keeps the
// extension's tpTree shape (baseVersion, roots, dirty, owner, editCount,
// copyId, rev, seq…), so the shared TreeStore can read it once the web app
// moves onto it, plus what only the web app keeps: the import links and
// server ids of the copy, the folder it was showing, and a note set aside by
// a sign-out. The note being written is kept beside it as it is typed, under
// 'tpLiveDraft', in the extension's shape too ({[page]: draft}).
//
// tp-data is still written for one more release, so going back to the
// previous release finds the copy where it looks for it. The first start of
// this release fills IndexedDB from it, and a later one takes it again when
// it is newer — written by the previous release after a step back. A copy
// the previous release cleared after a step back is not brought back; one
// with work in it is set aside in the shared core's format (stashEntry).
//
// Only one window of the app edits the copy at a time: the one holding the
// Web Lock 'tp-primary' (createPrimaryGuard). Another window says the app is
// open elsewhere and offers 'Use here', which asks the holder to write down
// what it has and let go. Where Web Locks are missing (a plain-http address,
// which is not a secure context) a BroadcastChannel stands in. Every write
// first checks, in the same IndexedDB transaction, that no other window has
// claimed the copy since this one did, so a window that lost the lock without
// noticing (frozen in the background, then robbed) never writes over the copy
// another window has taken on; and a claim never replaces one made since, so
// of two windows that claimed at once exactly one goes on writing.
//
// Nothing here touches the DOM: app.js wires it in, and the tests drive it
// with stand-ins for IndexedDB, Web Locks and BroadcastChannel.
//
// Since the web app runs on the shared core (pwa/lib/treeStore.js over
// pwa/platform.js), the record in 'tpTree' is TreeStore's own, written by
// TreeStore under its lock 'tp-working-copy' from any number of windows. It
// stays a superset of the last release's (decorateCoreRecord: savedAt,
// importIds, serverIds, pathIds, keptDraft), so stepping back finds the copy
// as it left it, and tp-data's '/__tp_tree' is still written beside it in the
// last release's shape (toV1Record). The first start of this release turns
// what the last one kept into TreeStore's record (planMigration): the copy,
// a newer one in tp-data after a step back, a note set aside by a sign-out
// (now a parked draft, as the extension parks them: tp_notes_parked_v1), and
// the drafts kept with set-aside copies. Single-window mode (the guard below)
// remains where Web Locks are missing.

export const DB_NAME = 'tabpaladin';
export const STORE = 'kv';
export const TREE_KEY = 'tpTree';
export const DRAFT_KEY = 'tpLiveDraft';
export const CLAIM_KEY = 'tpPrimary';
export const LOCK_NAME = 'tp-primary';
export const CHANNEL_NAME = 'tp-primary';

export function newId() {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

// --- IndexedDB: a small key-value store ----------------------------------------
//
// One object store of out-of-line keys, as storage.local is in the extension.
// Opened at whatever version the database has: a later release may add
// stores, and a step back to this one must still open it. A missing store is
// added with a version of its own.

export function createKv(factory, { name = DB_NAME, store = STORE } = {}) {
    let dbPromise = null;

    function openAt(version) {
        return new Promise((resolve, reject) => {
            let req;
            try {
                req = version ? factory.open(name, version) : factory.open(name);
            } catch (e) {
                reject(e);
                return;
            }
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error || new Error('IndexedDB could not be opened'));
            // Another tab holds an older version open: the open waits for it.
            req.onblocked = () => {};
        });
    }

    function open() {
        if (!factory || typeof factory.open !== 'function') {
            const e = new Error('IndexedDB is not available here');
            e.name = 'NotSupportedError';
            return Promise.reject(e);
        }
        if (!dbPromise) {
            dbPromise = (async () => {
                let db = await openAt(0);
                if (!db.objectStoreNames.contains(store)) {
                    const next = db.version + 1;
                    db.close();
                    db = await openAt(next);
                }
                // A later release upgrading the database: let it, and open
                // again on the next call.
                db.onversionchange = () => {
                    try { db.close(); } catch (e) { /* closed */ }
                    dbPromise = null;
                };
                db.onclose = () => { dbPromise = null; };
                return db;
            })();
            dbPromise.catch(() => { dbPromise = null; });
        }
        return dbPromise;
    }

    // Run `fn(objectStore, out)` in one transaction; resolves with `out` once
    // it has committed, rejects with the reason it did not (a full disk is a
    // QuotaExceededError).
    async function run(mode, fn) {
        const db = await open();
        return new Promise((resolve, reject) => {
            let tx;
            try {
                tx = mode === 'readwrite'
                    ? db.transaction(store, mode, { durability: 'strict' })
                    : db.transaction(store, mode);
            } catch (e) {
                // Closed under us by a version change: open again next time.
                dbPromise = null;
                reject(e);
                return;
            }
            const out = {};
            tx.oncomplete = () => resolve(out);
            tx.onabort = () => reject(tx.error || out.error || abortError());
            tx.onerror = (e) => {
                out.error = (e && e.target && e.target.error) || tx.error || out.error;
            };
            try {
                fn(tx.objectStore(store), out);
            } catch (e) {
                out.error = e;
                try { tx.abort(); } catch (x) { /* finished */ }
            }
        });
    }

    function get(key) {
        return run('readonly', (os, out) => {
            const r = os.get(key);
            r.onsuccess = () => { out.value = r.result; };
        }).then(out => out.value);
    }

    function getMany(keys) {
        return run('readonly', (os, out) => {
            out.values = {};
            for (const k of keys) {
                const r = os.get(k);
                r.onsuccess = () => { out.values[k] = r.result; };
            }
        }).then(out => out.values);
    }

    // Put (or, for null and undefined, delete) every entry in one
    // transaction. With `fence` ({id, at}: the window and when it claimed
    // the copy), only while no other window has claimed it since: resolves
    // {fenced: true, holder} having written nothing when one has.
    function write(entries, { fence = null } = {}) {
        return run('readwrite', (os, out) => {
            out.fenced = false;
            const apply = () => {
                for (const [k, v] of Object.entries(entries)) {
                    if (v === null || v === undefined) os.delete(k);
                    else os.put(v, k);
                }
            };
            if (!fence) {
                apply();
                return;
            }
            const r = os.get(CLAIM_KEY);
            r.onsuccess = () => {
                const claim = r.result;
                if (claimedSince(claim, fence)) {
                    out.fenced = true;
                    out.holder = claim;
                    return;
                }
                apply();
            };
        }).then(out => ({ fenced: Boolean(out.fenced), holder: out.holder || null }));
    }

    // This window edits the copy from now on: { id, at }. In the same
    // transaction, a claim another window made since stands: two windows
    // that claimed at once (without Web Locks) never both go on editing,
    // whichever committed last. Resolves { claimed, holder }: claimed false,
    // having written nothing, when another's stands — this window then
    // stops. A claim from the future is the clock set back since, not a
    // later window: it is written over.
    function claim(c) {
        const mine = { id: c.id, at: Number(c.at) || Date.now() };
        return run('readwrite', (os, out) => {
            const r = os.get(CLAIM_KEY);
            r.onsuccess = () => {
                const cur = r.result;
                if (claimedSince(cur, mine) && !(Number(cur.at) > Date.now())) {
                    out.holder = cur;
                    return;
                }
                os.put(mine, CLAIM_KEY);
                out.claimed = true;
            };
        }).then(out => ({ claimed: Boolean(out.claimed), holder: out.holder || null }));
    }

    return { open, get, getMany, write, claim };
}

// Has another window claimed the copy since `fence` ({id, at}) did? A claim
// older than this window's own is a window from before it, whose claim this
// one could not write over (a full disk): not a reason to stop.
export function claimedSince(claim, fence) {
    if (!claim || !claim.id || !fence || claim.id === fence.id) return false;
    return (Number(claim.at) || 0) >= (Number(fence.at) || 0);
}

function abortError() {
    const e = new Error('The write was not committed');
    e.name = 'AbortError';
    return e;
}

// --- The record ------------------------------------------------------------------
//
// app.js builds the copy as it always has (a 'v: 1' record: account, roots,
// version, dirty, editCount, importIds, serverIds, nv, keptDraft, pathIds,
// savedAt), which is also exactly what goes into tp-data. These turn it into
// the IndexedDB record and the live draft, and back.

function ownerOf(account) {
    const a = account || {};
    return {
        url: String(a.url || '').replace(/\/+$/, ''),
        userId: a.userId === undefined ? null : a.userId,
        username: a.username || null,
        serverId: a.serverId || null
    };
}

// `meta`: what the page knows of the copy beyond the record — its copyId,
// the write's place in line (seq) and the last sync.
export function toKvRecord(rec, meta = {}) {
    return {
        baseVersion: Number(rec.version) || 0,
        roots: Array.isArray(rec.roots) ? rec.roots : [],
        dirty: Boolean(rec.dirty),
        lastSyncAt: meta.lastSyncAt || null,
        lastSyncKind: meta.lastSyncKind || null,
        owner: ownerOf(rec.account),
        origin: null,
        editCount: Number(rec.editCount) || 0,
        copyId: meta.copyId || newId(),
        restoredFrom: [],
        rev: newId(),
        seq: Number(meta.seq) || 1,
        baseId: null,
        // The web app's own.
        savedAt: rec.savedAt || new Date().toISOString(),
        importIds: Array.isArray(rec.importIds) ? rec.importIds.slice() : [],
        serverIds: Array.isArray(rec.serverIds) ? rec.serverIds.slice() : [],
        pathIds: Array.isArray(rec.pathIds) ? rec.pathIds.slice() : [],
        keptDraft: rec.keptDraft || null
    };
}

// The note open in the editor (`nv`, the app's notes state), as the live
// draft map holds it: under this page's id, in the extension's fields, with
// the app's own editor state alongside to put it back exactly. Null when no
// note is open.
export function liveDraftsFor(nv, account, pageId, at = new Date().toISOString()) {
    if (!nv || !nv.editing) return null;
    const content = nv.draft == null ? '' : String(nv.draft);
    return {
        [pageId]: {
            owner: ownerOf(account),
            origin: null,
            noteId: nv.isNew ? null : nv.noteId || null,
            notebookId: nv.newParentId || null,
            title: '',
            content,
            loaded: { title: '', content: nv.loaded == null ? '' : String(nv.loaded) },
            at,
            nv: { ...nv }
        }
    };
}

export function sameOwner(a, b) {
    if (!a || !b) return false;
    const ua = String(a.url || '').replace(/\/+$/, '');
    const ub = String(b.url || '').replace(/\/+$/, '');
    if (ua !== ub) return false;
    if (a.serverId && b.serverId && a.serverId !== b.serverId) return false;
    if (a.userId !== null && a.userId !== undefined && b.userId !== null && b.userId !== undefined) {
        return Number(a.userId) === Number(b.userId);
    }
    const na = String(a.username || '').normalize('NFKC').toLowerCase();
    return Boolean(na) && na === String(b.username || '').normalize('NFKC').toLowerCase();
}

// The newest draft in the map written for this owner's copy, or null.
export function newestDraft(drafts, owner) {
    if (!drafts || typeof drafts !== 'object') return null;
    let best = null;
    for (const d of Object.values(drafts)) {
        if (!d || typeof d !== 'object' || !sameOwner(d.owner, owner)) continue;
        if (!best || String(d.at || '') > String(best.at || '')) best = d;
    }
    return best;
}

// The editor state a draft puts back: the app's own when it wrote one, else
// rebuilt from the extension's fields.
function nvOfDraft(d) {
    if (!d) return null;
    if (d.nv && typeof d.nv === 'object') return { ...d.nv, editing: true };
    if (typeof d.content !== 'string') return null;
    return {
        pane: 'note',
        noteId: d.noteId || null,
        editing: true,
        isNew: !d.noteId,
        newParentId: d.notebookId || null,
        draft: d.content,
        loaded: d.loaded && typeof d.loaded.content === 'string' ? d.loaded.content : ''
    };
}

// The IndexedDB record (and its live drafts) as app.js reads a kept copy.
export function fromKvRecord(kv, drafts = null) {
    if (!kv || typeof kv !== 'object' || !Array.isArray(kv.roots)) return null;
    const owner = kv.owner || {};
    return {
        v: 1,
        savedAt: kv.savedAt || null,
        account: ownerOf(owner),
        roots: kv.roots,
        version: Number(kv.baseVersion) || 0,
        dirty: Boolean(kv.dirty),
        editCount: Number(kv.editCount) || 0,
        importIds: Array.isArray(kv.importIds) ? kv.importIds : [],
        serverIds: Array.isArray(kv.serverIds) ? kv.serverIds : [],
        nv: nvOfDraft(newestDraft(drafts, owner)),
        keptDraft: kv.keptDraft || null,
        pathIds: Array.isArray(kv.pathIds) ? kv.pathIds : [],
        copyId: kv.copyId || null,
        seq: Number(kv.seq) || 0,
        lastSyncAt: kv.lastSyncAt || null,
        lastSyncKind: kv.lastSyncKind || null
    };
}

const timeOf = (rec) => {
    const t = rec && rec.savedAt ? Date.parse(rec.savedAt) : NaN;
    return Number.isNaN(t) ? null : t;
};

// Which kept copy a start takes: { rec, from: 'kv' | 'tp-data', seed, drop }.
//   - IndexedDB's, unless tp-data's is later: the previous release wrote it
//     after a step back. A record that cannot say when it was written loses
//     to none.
//   - tp-data's when IndexedDB has none: the first start of this release,
//     or a browser where IndexedDB failed. `seed`: write it into IndexedDB.
//   - none (`drop`) when tp-data is gone although this release last wrote
//     it with that very record: the previous release cleared the copy after
//     a step back (a clean sign-out, a deliberate discard, another account
//     signing in over a clean copy). Brought back, it would offer as unpushed
//     edits what was pushed or thrown away since. The caller sets it aside
//     rather than lose it (stashEntry).
// `tpWrittenAt`: the savedAt this release last wrote into tp-data (kept in
// localStorage), or null when it never did or cannot say.
// `clearedAt`: left by a clear (a sign-out, another account signing in over
// a clean copy, a deliberate discard) that one of the two places refused —
// IndexedDB failing while Cache Storage works, say. Whatever either holds
// that was kept then or before was cleared, and never comes back.
export function chooseKept({ kv, tp, tpWrittenAt = null, clearedAt = null }) {
    const cleared = clearedAt ? Date.parse(clearedAt) : NaN;
    const live = (rec) => {
        if (!rec || Number.isNaN(cleared)) return rec;
        const t = timeOf(rec);
        return t !== null && t > cleared ? rec : null;
    };
    const kvRec = live(kv || null);
    const tpRec = live(tp && tp.v === 1 && Array.isArray(tp.roots) ? tp : null);
    if (kvRec && tpRec) {
        const a = timeOf(kvRec);
        const b = timeOf(tpRec);
        if (a !== null && b !== null && b > a) return { rec: tpRec, from: 'tp-data', seed: true, drop: false };
        return { rec: kvRec, from: 'kv', seed: false, drop: false };
    }
    if (kvRec) {
        if (tpWrittenAt && kvRec.savedAt && tpWrittenAt === kvRec.savedAt) return { rec: null, from: null, seed: false, drop: true };
        return { rec: kvRec, from: 'kv', seed: false, drop: false };
    }
    if (tpRec) return { rec: tpRec, from: 'tp-data', seed: true, drop: false };
    return { rec: null, from: null, seed: false, drop: false };
}

// A copy this release will not bring back but must not lose, as a set-aside
// copy in the shared core's format (treeStore.js writeStash: the key
// 'tpTreeStash:<url>|<userId>', listed in 'tpTreeStashIndex'), where the
// release that moves the web app onto it lists it to restore or discard. The
// web app's own parts ride along. `index`: the keys taken already; `why`:
// what set it aside.
export const STASH_PREFIX = 'tpTreeStash:';
export const STASH_INDEX_KEY = 'tpTreeStashIndex';

export function stashEntry(kvRec, drafts, index = [], now = Date.now(), why = 'cleared-by-previous-release') {
    const owner = kvRec.owner ? ownerOf(kvRec.owner) : null;
    const url = String(owner ? owner.url : '').replace(/\/$/, '');
    const base = STASH_PREFIX + `${url}|${owner ? owner.userId : 'legacy'}`;
    let key = base;
    for (let n = 0; index.includes(key); n++) key = `${base}#${now}${n ? `-${n}` : ''}`;
    return {
        key,
        value: {
            roots: Array.isArray(kvRec.roots) ? kvRec.roots : [],
            baseVersion: Number(kvRec.baseVersion) || 0,
            dirty: Boolean(kvRec.dirty),
            editCount: Number(kvRec.editCount) || 0,
            lastSyncAt: kvRec.lastSyncAt || null,
            owner,
            origin: owner ? null : kvRec.origin || 'local',
            url,
            username: owner ? owner.username : null,
            setAsideAt: new Date(now).toISOString(),
            focusedFolderIds: [],
            expanded: {},
            pendingRemovals: [],
            restoredFrom: Array.isArray(kvRec.restoredFrom) ? kvRec.restoredFrom : [],
            copyId: kvRec.copyId || null,
            fromRev: kvRec.rev || null,
            // The web app's own.
            savedAt: kvRec.savedAt || null,
            importIds: Array.isArray(kvRec.importIds) ? kvRec.importIds : [],
            serverIds: Array.isArray(kvRec.serverIds) ? kvRec.serverIds : [],
            keptDraft: kvRec.keptDraft || null,
            liveDrafts: drafts && typeof drafts === 'object' ? drafts : null,
            why
        }
    };
}

// --- The shared core's record (this release) --------------------------------------
//
// TreeStore writes 'tpTree' itself; the page adds to each write what the last
// release reads (decorateCoreRecord, through the platform's decorator), and
// mirrors it into tp-data in the last release's shape (toV1Record). `pwa`
// says a record was written on the shared core: one without it was written by
// the last release (the first start of this one, or after a step back).

export const PWA_RECORD = 33;

const arr = (v) => (Array.isArray(v) ? v.slice() : []);
const trimUrl = (u) => String(u || '').replace(/\/+$/, '');
const nameKey = (n) => String(n || '').normalize('NFKC').toLowerCase();

export function isCoreRecord(kv) {
    return Boolean(kv && typeof kv === 'object' && Number(kv.pwa) >= PWA_RECORD && Array.isArray(kv.roots));
}

// A copy kept only so that nothing is lost — one an earlier release cleared
// after a step back (it pushed it, or let it go on purpose), or one another
// window of that release set aside — never comes back on its own: set aside
// under nobody's stamp, so TreeStore never picks it to bring back when its
// account signs in (and offers it to the server's owner alone), with the
// account it was kept for beside it (`ownerWas`), for Settings to offer it
// back to that account by hand, or to export or discard.
export function keptAsideOnly(value) {
    if (!value || typeof value !== 'object' || !value.owner) return value;
    return { ...value, ownerWas: value.owner, owner: null, origin: 'set-aside' };
}

const asideStash = (entry) => (entry ? { key: entry.key, value: keptAsideOnly(entry.value) } : entry);

// The last release's kept copy ('v: 1': what fromKvRecord gives, or tp-data
// holds) as TreeStore's record. Its account is the copy's owner; a copy that
// never learned its account's id (a session from before ids) takes it from
// `identity` (who this device's session is) when the address and the name
// agree, and is otherwise a copy from before accounts — the server owner's to
// adopt, set aside for anyone else, never anyone's by guess. `seq`: the place
// in line of the record it replaces.
export function toCoreRecord(rec, { identity = null, seq = 0 } = {}) {
    const acct = rec && rec.account ? rec.account : {};
    const url = trimUrl(acct.url);
    let userId = acct.userId === null || acct.userId === undefined || acct.userId === '' ? null : Number(acct.userId);
    if ((userId === null || !Number.isFinite(userId)) && identity && identity.userId !== null && identity.userId !== undefined
        && url && trimUrl(identity.url) === url && nameKey(acct.username) && nameKey(acct.username) === nameKey(identity.username)) {
        userId = Number(identity.userId);
    }
    const owner = url && userId !== null && Number.isFinite(userId)
        ? { url, userId, username: acct.username || null, serverId: acct.serverId || null }
        : null;
    const dirty = Boolean(rec.dirty);
    return {
        baseVersion: Number(rec.version) || 0,
        roots: Array.isArray(rec.roots) ? rec.roots : [],
        dirty,
        lastSyncAt: rec.lastSyncAt || null,
        lastSyncKind: rec.lastSyncKind || null,
        owner,
        origin: owner ? null : 'pre-accounts',
        editCount: dirty ? Math.max(1, Number(rec.editCount) || 0) : 0,
        copyId: rec.copyId || newId(),
        restoredFrom: [],
        rev: newId(),
        seq: (Number(seq) || 0) + 1,
        baseId: newId(),
        meta: { importIds: arr(rec.importIds), serverIds: arr(rec.serverIds) },
        savedAt: rec.savedAt || null,
        pathIds: arr(rec.pathIds),
        keptDraft: null,
        pwa: PWA_RECORD
    };
}

// What every write of the working copy carries for the last release, which
// reads these fields of it (fromKvRecord) after a step back. `keptDraft`: a
// note parked with this copy (the newest), which the last release puts back
// into its editor as it did the one a sign-out set aside — it never reads the
// parked list.
export function decorateCoreRecord(rec, { savedAt, pathIds = [], keptDraft = null } = {}) {
    if (!rec || typeof rec !== 'object') return rec;
    const meta = rec.meta && typeof rec.meta === 'object' ? rec.meta : {};
    return {
        ...rec,
        savedAt: savedAt || rec.savedAt || new Date().toISOString(),
        pwa: PWA_RECORD,
        importIds: arr(meta.importIds),
        serverIds: arr(meta.serverIds),
        pathIds: arr(pathIds),
        keptDraft: keptDraft && keptDraft.editing ? { ...keptDraft } : null
    };
}

// The same copy in the last release's tp-data shape, or null for one that
// holds nothing of anyone's (an empty copy nobody owns: what a clean
// sign-out leaves, which the last release kept as no copy at all).
export function toV1Record(rec, { nv = null } = {}) {
    if (!rec || !Array.isArray(rec.roots)) return null;
    if (!rec.owner && !rec.roots.length && !rec.dirty) return null;
    const meta = rec.meta && typeof rec.meta === 'object' ? rec.meta : {};
    return {
        v: 1,
        savedAt: rec.savedAt || new Date().toISOString(),
        account: ownerOf(rec.owner || {}),
        roots: rec.roots,
        version: Number(rec.baseVersion) || 0,
        dirty: Boolean(rec.dirty),
        editCount: Number(rec.editCount) || 0,
        importIds: arr(meta.importIds),
        serverIds: arr(meta.serverIds),
        nv: nv && nv.editing ? { ...nv } : null,
        keptDraft: rec.keptDraft && rec.keptDraft.editing ? { ...rec.keptDraft } : null,
        pathIds: arr(rec.pathIds),
        copyId: rec.copyId || null,
        seq: Number(rec.seq) || 0,
        lastSyncAt: rec.lastSyncAt || null,
        lastSyncKind: rec.lastSyncKind || null
    };
}

// What a start does with what is kept, before TreeStore reads it:
//   { action: 'none' }                       the shared core's record, current
//   { action: 'convert', record, from, nv, keptDraft, account }
//       the last release's copy (from IndexedDB, or tp-data written later
//       after a step back), as TreeStore's record; the note open in it
//       (`nv`, only tp-data's carries one: IndexedDB's is in tpLiveDraft
//       already) and one a sign-out set aside, to be parked
//   { action: 'drop', stash }                the last release cleared tp-data
//       after this one wrote it with that very record: not brought back, but
//       set aside (stash: {key, value}) when it held work
//   { action: 'clear' }                      a record the last release
//       cleared (its clearedAt mark): never brought back
// The rules for which copy are the last release's (chooseKept).
export function planMigration({ kvRaw = null, drafts = null, tp = null, tpWrittenAt = null, clearedAt = null, stashIndex = [], identity = null, now = Date.now() } = {}) {
    const tpRec = tp && tp.v === 1 && Array.isArray(tp.roots) ? tp : null;
    if (isCoreRecord(kvRaw)) {
        // Written by this release. tp-data later still: the last release
        // ran after a step back with IndexedDB failing, and kept it there.
        // Cleared by the last release, where IndexedDB refused the clear
        // (its mark), or by an older one that knew only tp-data (gone,
        // although this release last wrote it with this very record): not
        // brought back — set aside, when it holds work.
        const pick = chooseKept({ kv: { ...kvRaw, v: 1 }, tp: tpRec, tpWrittenAt, clearedAt });
        if (pick.drop) {
            const holdsWork = Boolean(kvRaw.dirty || (drafts && Object.keys(drafts).length));
            return { action: 'drop', stash: holdsWork ? asideStash(stashEntry(kvRaw, drafts, stashIndex, now)) : null };
        }
        if (!pick.rec) return { action: 'clear' };
        if (pick.from === 'tp-data' && tpRec && tpRec.savedAt !== kvRaw.savedAt) {
            return { action: 'convert', record: toCoreRecord(tpRec, { identity, seq: kvRaw.seq }), from: 'tp-data',
                nv: tpRec.nv || null, keptDraft: tpRec.keptDraft || null, account: tpRec.account || null };
        }
        return { action: 'none' };
    }
    const fromKv = fromKvRecord(kvRaw, drafts);
    const pick = chooseKept({ kv: fromKv, tp: tpRec, tpWrittenAt, clearedAt });
    if (pick.drop) {
        const holdsWork = Boolean(fromKv && (fromKv.dirty || fromKv.nv || fromKv.keptDraft));
        return { action: 'drop', stash: holdsWork ? asideStash(stashEntry(kvRaw, drafts, stashIndex, now)) : null };
    }
    if (pick.rec) {
        return {
            action: 'convert',
            record: toCoreRecord(pick.rec, { identity, seq: kvRaw && kvRaw.seq }),
            from: pick.from,
            nv: pick.from === 'tp-data' ? pick.rec.nv || null : null,
            keptDraft: pick.rec.keptDraft || null,
            account: pick.rec.account || null
        };
    }
    return kvRaw ? { action: 'clear' } : { action: 'none' };
}

// A copy the last release set aside (stashEntry) carried the web app's own
// parts beside it: its import links and server ids, which go into its meta,
// and the notes being written in it, which are parked with its owner so they
// come back when it does. Null for one that needs nothing (TreeStore's own,
// or one done already).
export function migrateStash(value) {
    if (!value || typeof value !== 'object' || Number(value.pwa) >= PWA_RECORD) return null;
    const own = ['importIds', 'serverIds', 'keptDraft', 'liveDrafts', 'why', 'savedAt'].some(k => value[k] !== undefined);
    if (!own) return null;
    const owner = value.owner || value.ownerWas || null;
    const stamp = { owner, origin: owner ? null : value.origin || 'pre-accounts' };
    const drafts = [];
    const at = value.setAsideAt || new Date().toISOString();
    const nvs = [];
    if (value.keptDraft && value.keptDraft.editing) nvs.push(value.keptDraft);
    if (value.liveDrafts && typeof value.liveDrafts === 'object') {
        for (const d of Object.values(value.liveDrafts)) {
            const nv = nvOfDraft(d);
            if (nv) nvs.push(nv);
        }
    }
    for (const nv of nvs) {
        const d = draftFromNv(nv, stamp, at);
        if (d) drafts.push(d);
    }
    const meta = value.meta && typeof value.meta === 'object' ? { ...value.meta } : {};
    if (!meta.importIds) meta.importIds = arr(value.importIds);
    if (!meta.serverIds) meta.serverIds = arr(value.serverIds);
    const out = { ...value, meta, pwa: PWA_RECORD };
    return { value: value.why ? keptAsideOnly(out) : out, drafts };
}

// --- Parked drafts ------------------------------------------------------------------
//
// A note being written when its copy goes — signed out of, set aside for
// another account, replaced in another window — is parked on the device under
// the copy's stamp ({owner, origin}), in the extension's format
// (tp_notes_parked_v1 in this origin's localStorage), with the app's own editor
// state beside it (`nv`). It comes back into the editor, unsaved, when that
// copy is the working copy again: for its account, or with the copy brought
// back from being set aside under that stamp (TreeStore's restoredFrom).

export const PARKED_KEY = 'tp_notes_parked_v1';
export const PARKED_AT_KEY = 'tp_notes_parked_at_v1';

function ownerKey(owner) {
    let url = trimUrl(owner && owner.url);
    try {
        const u = new URL(url);
        url = u.origin + u.pathname.replace(/\/$/, '');
    } catch (e) { /* as typed */ }
    return `${url}|${Number(owner && owner.userId)}`;
}

function sameStampOwner(a, b) {
    if (!a || !b) return !a && !b;
    if (a.serverId && b.serverId && a.serverId !== b.serverId) return false;
    return ownerKey(a) === ownerKey(b);
}

// Stamps as notesView.js compares them: an account, or for an unstamped copy
// where it came from.
export function sameStamp(a, b) {
    if (a.owner || b.owner) return sameStampOwner(a.owner, b.owner);
    return !a.origin || !b.origin || a.origin === b.origin;
}

// The stamps the working copy answers to (TreeStore.status()): its own, then
// those it was set aside under before.
export function stampsOfStatus(st) {
    if (!st) return [];
    const own = { owner: st.owner || null, origin: st.owner ? null : st.origin || null };
    const earlier = (st.restoredFrom || []).map(s => (s.userId === null || s.userId === undefined
        ? { owner: null, origin: s.origin || null }
        : { owner: { url: s.url, userId: s.userId, serverId: s.serverId || null }, origin: null }));
    return [own, ...earlier];
}

export function draftAnswersTo(draft, stamps) {
    const own = { owner: draft && draft.owner ? draft.owner : null, origin: draft ? draft.origin || null : null };
    return (stamps || []).some(s => sameStamp(own, s));
}

// The editor (`nv`) as a parked draft of the copy stamped `stamp`.
export function draftFromNv(nv, stamp, at = new Date().toISOString()) {
    if (!nv || !nv.editing) return null;
    const content = nv.draft == null ? '' : String(nv.draft);
    const owner = stamp && stamp.owner ? stamp.owner : null;
    return {
        owner: owner ? { url: trimUrl(owner.url), userId: owner.userId, username: owner.username || null, serverId: owner.serverId || null } : null,
        origin: owner ? null : (stamp && stamp.origin) || 'pre-accounts',
        noteId: nv.isNew ? null : nv.noteId || null,
        notebookId: nv.newParentId || null,
        title: '',
        content,
        loaded: { title: '', content: nv.loaded == null ? '' : String(nv.loaded) },
        parkedAt: at,
        nv: { ...nv, editing: true }
    };
}

// The editor a parked draft puts back.
export function nvOfParked(d) {
    return nvOfDraft(d);
}

export function readParked(ls) {
    try {
        const list = JSON.parse((ls && ls.getItem(PARKED_KEY)) || '[]');
        return Array.isArray(list) ? list.filter(d => d && typeof d.content === 'string') : [];
    } catch (e) {
        return [];
    }
}

// False when localStorage refused it.
export function writeParked(ls, list) {
    try {
        if (list.length) ls.setItem(PARKED_KEY, JSON.stringify(list));
        else ls.removeItem(PARKED_KEY);
        ls.setItem(PARKED_AT_KEY, JSON.stringify(Date.now()));
        return true;
    } catch (e) {
        return false;
    }
}

// The same draft parked twice (a start that stopped halfway, a step back and
// forward again) is one draft.
export function sameDraft(a, b) {
    return Boolean(a && b) && a.content === b.content && (a.noteId || null) === (b.noteId || null)
        && sameStamp({ owner: a.owner || null, origin: a.origin || null }, { owner: b.owner || null, origin: b.origin || null });
}

// --- One window edits the copy ----------------------------------------------------
//
// mode 'locks': the window holding the Web Lock 'tp-primary' edits. A window
//   that starts while another holds it waits a moment (the page a reload
//   replaces may still be letting go), then says the app is open elsewhere.
// mode 'channel': no Web Locks (not a secure context). A starting window asks
//   over BroadcastChannel whether one is editing, and edits when none answers.
//   Two asking at the same moment hear each other, and the one with the
//   lower id edits: never both.
// mode 'none': neither (an old browser): every window edits, as before.
//
// take() makes this window the one. It asks the holder to write down what it
// has and let go (the holder's onYield), and the holder says at once that it
// is on it ('busy'), so a slow write is waited for, never cut short. A holder
// that cannot write (onYield false) refuses and keeps the copy. One that
// never answers is a window frozen in the background, which wrote everything
// down when it was hidden: the lock is taken from it, and it hears onLost
// when it wakes.
//
// env: { locks, BroadcastChannel, secure, id, onYield, onLost, onYielded,
//        setTimeout, clearTimeout, waitMs: { probe, grace, answer, busy } }

export function createPrimaryGuard(env) {
    const id = env.id || newId();
    const locks = env.locks && typeof env.locks.request === 'function' ? env.locks : null;
    const Channel = typeof env.BroadcastChannel === 'function' ? env.BroadcastChannel : null;
    const mode = locks ? 'locks' : (Channel && env.secure === false ? 'channel' : 'none');
    const wait = { probe: 400, grace: 1000, answer: 2000, busy: 15000, ...(env.waitMs || {}) };
    const later = env.setTimeout || setTimeout;
    const cancel = env.clearTimeout || clearTimeout;
    const ROUNDS = 3;

    let primary = mode === 'none';
    let release = null;      // lets go of the held lock
    let yielding = false;
    let channel = null;
    const waiters = new Set();
    // Channel mode: asking whether a window edits, and the others asking
    // at the same moment.
    let probing = false;
    const rivals = new Set();

    if (mode !== 'none' && Channel) {
        try {
            channel = new Channel(CHANNEL_NAME);
            channel.onmessage = (e) => { onMessage(e && e.data); };
        } catch (e) {
            channel = null;
        }
    }

    function post(msg) {
        if (!channel) return;
        try { channel.postMessage({ ...msg, from: id }); } catch (e) { /* closed */ }
    }

    // Resolves with the first message of one of these types addressed to
    // this window, or null after `ms`.
    function waitFor(types, ms) {
        return new Promise((resolve) => {
            let timer = null;
            const w = {
                types: new Set([].concat(types)),
                done: (msg) => {
                    if (timer) cancel(timer);
                    waiters.delete(w);
                    resolve(msg);
                }
            };
            waiters.add(w);
            timer = later(() => w.done(null), ms);
        });
    }

    function onMessage(msg) {
        if (!msg || typeof msg !== 'object' || msg.from === id) return;
        if (msg.to && msg.to !== id) return;
        for (const w of [...waiters]) if (w.types.has(msg.t)) w.done(msg);
        if (msg.t === 'probe') {
            if (primary) post({ t: 'here', to: msg.from });
            else if (probing) {
                // Asking too: each learns of the other, whichever asked first.
                rivals.add(msg.from);
                post({ t: 'probing', to: msg.from });
            }
        }
        if (msg.t === 'probing' && probing) rivals.add(msg.from);
        if (msg.t === 'yield' && primary) {
            post({ t: 'busy', to: msg.from });
            if (!yielding) yieldTo(msg.from);
        }
    }

    // onYield answers true, or false / { ok: false, reason } to keep the copy.
    async function yieldTo(to) {
        yielding = true;
        try {
            let answer = false;
            try { answer = await env.onYield(); } catch (e) { answer = false; }
            if (!primary) return;
            if (answer !== true && !(answer && answer.ok)) {
                post({ t: 'refused', to, reason: (answer && answer.reason) || null });
                return;
            }
            // Written down: from here this window writes nothing.
            primary = false;
            const r = release;
            release = null;
            if (r) r();
            post({ t: 'yielded', to });
            if (env.onYielded) env.onYielded();
        } finally {
            yielding = false;
        }
    }

    // Ask for the lock: { ifAvailable } answers at once, { steal } takes it
    // from whoever holds it, otherwise it waits, up to `waitMs` when given.
    // `result` resolves true once this window holds it; `stop()` gives up a
    // request still waiting.
    function acquire({ ifAvailable = false, steal = false, waitMs = 0 } = {}) {
        let settled = false;
        let gaveUp = false;
        let timer = null;
        let finish;
        const result = new Promise((resolve) => { finish = resolve; });
        const settle = (v) => {
            if (settled) return;
            settled = true;
            if (timer) cancel(timer);
            finish(v);
        };
        const ac = !ifAvailable && !steal && typeof AbortController === 'function' ? new AbortController() : null;
        const stop = () => {
            if (settled) return;
            gaveUp = true;
            if (ac) { try { ac.abort(); } catch (e) { /* done */ } }
            settle(false);
        };
        const options = steal ? { steal: true } : ifAvailable ? { ifAvailable: true } : ac ? { signal: ac.signal } : {};
        let held = false;
        let p;
        try {
            p = locks.request(LOCK_NAME, options, (lock) => {
                if (!lock || gaveUp) {
                    settle(false);
                    return undefined;
                }
                held = true;
                primary = true;
                settle(true);
                // Held until this window lets go, or it is taken.
                return new Promise((r) => { release = r; });
            });
        } catch (e) {
            settle(false);
            return { result, stop };
        }
        Promise.resolve(p).then(() => {}, () => {
            // Taken: another window stole the lock this one held.
            if (held && primary) {
                primary = false;
                release = null;
                if (env.onLost) env.onLost('stolen');
            }
            settle(false);
        });
        if (waitMs) timer = later(stop, waitMs);
        return { result, stop };
    }

    // Channel mode: does a window edit? 'here' when one answers; 'rival'
    // when none does but another asked at the same moment and goes first
    // (the lower id); else 'free', and this window edits from now on.
    async function probe() {
        probing = true;
        rivals.clear();
        try {
            const here = waitFor('here', wait.probe);
            post({ t: 'probe' });
            if (await here) return 'here';
            if ([...rivals].some(r => String(r) < String(id))) return 'rival';
            primary = true;
            return 'free';
        } finally {
            probing = false;
            rivals.clear();
        }
    }

    async function start({ take: takeOver = false } = {}) {
        if (mode === 'none') return 'primary';
        if (mode === 'locks') {
            if (await acquire({ ifAvailable: true }).result) return 'primary';
            if (takeOver) return (await take()).ok ? 'primary' : 'secondary';
            // A reload: the page it replaces may still be letting go.
            if (await acquire({ waitMs: wait.grace }).result) return 'primary';
            return 'secondary';
        }
        // channel
        const seen = await probe();
        if (seen === 'free') return 'primary';
        if (takeOver) {
            // The window that went first edits once its own asking is over:
            // asked before then, it would not answer.
            if (seen === 'rival') await new Promise(r => later(r, wait.probe + 100));
            return (await take()).ok ? 'primary' : 'secondary';
        }
        return 'secondary';
    }

    // Become the window that edits. Resolves { ok: true, how } — how: 'free'
    // (nobody held it), 'yielded' (the holder wrote down and let go), 'taken'
    // (nobody answered) — or { ok: false, how: 'refused' } when the holder
    // could not write what it has.
    let lastTake = null;
    async function take() {
        lastTake = await takeOnce();
        return lastTake;
    }

    async function takeOnce() {
        if (primary) return { ok: true, how: 'free' };
        if (mode === 'none') {
            primary = true;
            return { ok: true, how: 'free' };
        }
        if (mode === 'locks' && await acquire({ ifAvailable: true }).result) return { ok: true, how: 'free' };
        // Each round asks whoever holds the copy now: after a round in which
        // another window took it first, that one is asked next.
        for (let round = 0; round < ROUNDS; round++) {
            const asking = mode === 'locks' ? acquire() : null;
            const got = asking ? asking.result.then(g => (g ? 'got' : 'lost')) : new Promise(() => {});
            const answered = waitFor(['busy', 'refused', 'yielded'], wait.answer);
            post({ t: 'yield' });
            let reason = null;
            const typeOf = (m) => {
                if (m && m.t === 'refused') reason = m.reason || null;
                return m ? m.t : null;
            };
            let outcome = await Promise.race([got, answered.then(m => typeOf(m) || 'silent')]);
            if (outcome === 'busy') {
                // On it: wait for it to let go, or to say it cannot.
                const after = waitFor(['refused', 'yielded'], wait.busy);
                outcome = await Promise.race([got, after.then(m => typeOf(m) || 'slow')]);
            }
            if (outcome === 'got') return { ok: true, how: 'yielded' };
            if (outcome === 'yielded' && mode === 'channel') {
                primary = true;
                return { ok: true, how: 'yielded' };
            }
            if (outcome === 'yielded' && asking) {
                // Let go: the lock follows unless another window was in line first.
                if (await Promise.race([asking.result, new Promise(r => later(() => r(false), wait.answer))])) {
                    return { ok: true, how: 'yielded' };
                }
            }
            if (asking) asking.stop();
            if (outcome === 'refused') return { ok: false, how: 'refused', reason };
            if (outcome === 'silent') {
                // Nobody answered: a window frozen in the background, which
                // wrote everything down when it was hidden.
                if (mode === 'channel') {
                    primary = true;
                    return { ok: true, how: 'taken' };
                }
                if (await acquire({ steal: true }).result) return { ok: true, how: 'taken' };
                return { ok: false, how: 'failed' };
            }
            // 'slow', or the lock went to another window in line: ask again.
        }
        return { ok: false, how: 'failed' };
    }

    // Edit here if nobody does: the window that held the copy closed. Never
    // asks a holder to let go. True when this window edits now.
    async function takeIfFree() {
        if (primary) return true;
        if (mode === 'locks') return acquire({ ifAvailable: true }).result;
        if (mode === 'channel') return (await probe()) === 'free';
        primary = true;
        return true;
    }

    // Back in the foreground in channel mode: a window that edited while this
    // one was frozen answers, and this one stops. (With locks, a window
    // robbed of its lock hears it from the lock itself.)
    async function recheck() {
        if (mode !== 'channel' || !primary) return;
        const here = waitFor('here', wait.probe);
        post({ t: 'probe' });
        if ((await here) && primary) {
            primary = false;
            if (env.onLost) env.onLost('superseded');
        }
    }

    // A write found another window's claim on the copy: this one is not the
    // one any more.
    function lost(why = 'fenced') {
        if (mode === 'none' || !primary) return;
        primary = false;
        const r = release;
        release = null;
        if (r) r();
        if (env.onLost) env.onLost(why);
    }

    function close() {
        try { if (channel) channel.close(); } catch (e) { /* closed */ }
        channel = null;
    }

    return {
        id,
        mode,
        start,
        take,
        takeIfFree,
        recheck,
        lost,
        close,
        isPrimary: () => primary,
        // What the last take() came to: a start that took over says why not.
        lastTake: () => lastTake,
        // Writes are fenced with this window's claim, except where every
        // window edits (mode 'none').
        fence: () => (mode === 'none' ? null : id)
    };
}

// --- Persistent storage ------------------------------------------------------------
//
// Best-effort storage may be cleared by the browser when space runs low;
// persisted storage is not. persist() may prompt (Firefox) and is granted on
// engagement or installation elsewhere, so the app asks from a click.

export async function storageStatus(storage) {
    const out = { supported: false, persisted: null, usage: null, quota: null };
    if (!storage) return out;
    out.supported = typeof storage.persist === 'function';
    try {
        if (typeof storage.persisted === 'function') out.persisted = Boolean(await storage.persisted());
    } catch (e) {
        out.persisted = null;
    }
    try {
        if (typeof storage.estimate === 'function') {
            const est = await storage.estimate();
            out.usage = Number.isFinite(est && est.usage) ? est.usage : null;
            out.quota = Number.isFinite(est && est.quota) ? est.quota : null;
        }
    } catch (e) { /* no estimate */ }
    return out;
}

// { ok, how: 'granted' | 'declined' | 'unsupported' | 'error', error? }
export async function askPersist(storage) {
    if (!storage || typeof storage.persist !== 'function') return { ok: false, how: 'unsupported' };
    try {
        const granted = await storage.persist();
        return { ok: Boolean(granted), how: granted ? 'granted' : 'declined' };
    } catch (e) {
        return { ok: false, how: 'error', error: e };
    }
}

export function isQuotaError(e) {
    if (!e) return false;
    const name = String(e.name || '');
    return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' || /quota/i.test(String(e.message || ''));
}
