// The share sheet: Save link (one tap on a chip files the link there), the
// folder picker, the per-app edit screen, and the Inbox — every way a shared,
// pasted or copied link gets filed.
//
// Everything about the tree, the account and the network comes from the app
// through `ctx`; what is decided here is only what the sheet shows and what a
// tap asks for. The pure parts (what was shared, which folders to suggest,
// search) are in shareCore.js, which the page loads before this module.
//
// ctx = {
//   outbox                      the share outbox (shareCore cacheOutbox/localOutbox)
//   signedIn() -> bool
//   account() -> {url,userId,username,serverId} | null    who is signed in now
//   username() -> string
//   copy() -> {ready, index, serverIds}                    the working copy's folders
//   flush(sids) -> flushOutbox result                      uploads and files; the app
//                                                          folds filed links into its copy
//   api(path, opts)                                        the app's fetch with auth
//   applyFiled(result), applyUnfiled(result)               a filing or undo into the copy
//   registerSync()                                         Background Sync, where there is one
//   prefs: {get() -> value|null, update(fn, app) -> Promise}  the 'share' pref
//   stats() -> {apps} | null
//   clipboardLinks() -> [{url,title}], forgetClipboardLink(url), dismissClipboardLink(url)
//   toast(msg), toastUndo(msg, undo), openSettings(),
//   saveAsNote(text) -> Promise<bool>                      true once the note editor holds it
//   openFolder(folderId), done({label, fromShare}), onClose(),
//   onInboxCount(n), isDesktop(), newId()
// }
//
// Every flush the app runs (this sheet's, coming online, the worker's) is
// handed back through onFlushed(result): what it filed for the open share
// is saved here, whoever filed it.
//
// The DOM is built with createElement and listeners on what was built, never
// innerHTML from data: titles and URLs come from other apps.

const S = () => window.TPShare;

function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = String(v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k.startsWith('on')) { if (typeof v === 'function') el.addEventListener(k.slice(2), v); }
        else if (['value', 'type', 'placeholder', 'disabled', 'title', 'checked', 'href', 'target', 'rel', 'src', 'alt', 'id', 'tabIndex'].includes(k)) el[k] = v;
        else el.setAttribute(k, String(v));
    }
    for (const kid of kids.flat(3)) {
        if (kid === null || kid === undefined || kid === false) continue;
        el.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    }
    return el;
}

function clear(el) {
    el.textContent = '';
    return el;
}

function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

function favicon(url) {
    const host = hostOf(url);
    if (!host) return h('span', { class: 'share-fav share-fav-none', text: '🔖' });
    const img = h('img', { class: 'share-fav', alt: '', src: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64` });
    img.referrerPolicy = 'no-referrer';
    return img;
}

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

// The title, with each search word's first place in it marked.
function highlighted(title, ranges) {
    if (!ranges || !ranges.length) return [title];
    const out = [];
    let at = 0;
    for (const [a, b] of ranges) {
        if (a < at) continue;
        if (a > at) out.push(title.slice(at, a));
        out.push(h('mark', { text: title.slice(a, b) }));
        at = b;
    }
    if (at < title.length) out.push(title.slice(at));
    return out;
}

export function createShareSheet(ctx) {
    const root = document.getElementById('share-sheet');
    const inboxList = document.getElementById('inbox-list');
    let s = null;          // the open sheet's state, or null
    let inbox = { pending: [], filed: [], entries: [], loadedAt: 0 };
    let pressTimer = null;

    const appOf = () => (s && (s.app || (s.url ? S().appOf(s.url) : null))) || 'site:unknown';
    const label = () => S().appLabel(appOf());
    const ref = () => (s.share && s.share.sid) || s.sid;
    const isOpen = () => Boolean(s) && !root.classList.contains('hidden');
    // The account the open share is kept for: every change the sheet asks of
    // the server names it, and the server refuses one meant for another.
    const expectOf = (account) => {
        const a = account || {};
        return {
            expectUserId: a.userId === null || a.userId === undefined ? undefined : a.userId,
            expectServerId: a.serverId || undefined
        };
    };
    const expect = () => expectOf((s && s.entry && s.entry.account) || ctx.account());
    // The Inbox's server rows are the signed-in account's.
    const asMe = () => JSON.stringify(expectOf(ctx.account()));
    // A share the server refused for good: nothing chosen for it is waiting.
    const refusedForGood = (e) => Boolean(e && !e.uploaded && e.lastError && e.lastError.permanent);

    // --- Opening -------------------------------------------------------------------

    // An outbox entry, or a share from the server as an entry would hold it.
    function entryFromShare(share) {
        return {
            v: 1, sid: share.sid, createdAt: share.createdAt, account: ctx.account(),
            fields: { title: share.title || '', text: share.text || '', url: share.url },
            url: share.url, rawUrl: share.url, title: share.title || S().fallbackTitle(share.url, share.app), text: share.text || '',
            others: [], app: share.app || S().appOf(share.url), urlKey: share.urlKey || S().dedupeKey(share.url), source: share.source || 'share',
            uploaded: true, share, archived: share.status === 'archived' ? { provider: share.app } : null,
            file: null, later: false, dismiss: false, attempts: 0, lastError: null
        };
    }

    function open(entry, { fromShare = false } = {}) {
        s = {
            entry, sid: entry.sid, share: entry.share || null, url: entry.url, title: entry.title || '', app: entry.app,
            urlKey: entry.urlKey, fromShare, view: 'main', chips: null, firstTime: false, starter: null,
            saved: new Map(),    // folderId -> {bookmarkId, already, label}
            asked: new Map(),    // folder key -> the target a tap asked for (its label, a new folder)
            pending: new Set(),  // tapped, a flush of this sheet on its way with it
            queued: new Set(),   // chosen and kept with the share, not filed yet
            queuedWhy: null, failed: new Map(),
            lastLabels: [], message: null, picker: null, menu: null
        };
        (s.share && s.share.filings || []).forEach(f => s.saved.set(f.folderId, { bookmarkId: f.bookmarkId, already: true, label: f.folderTitle || '' }));
        // A choice made earlier (offline, say), still waiting with the share.
        syncEntry(entry);
        root.classList.remove('hidden');
        document.body.classList.add('share-open');
        computeChips();
        render();
        // The worker uploads a share as it arrives; a pasted link, or one
        // shared while the worker was not in charge, goes up from here.
        if (entry.url && accountOk() && (!entry.uploaded || entry.file)) upload();
        return true;
    }

    // The outbox entry as it is now: what is still waiting to be filed shows
    // as waiting, whoever chose it (this sheet, an earlier one, offline).
    function syncEntry(e) {
        if (!s) return;
        if (e) {
            s.entry = e;
            if (e.share) s.share = e.share;
        }
        const waiting = e && !refusedForGood(e) ? S().intentKeys(e.file) : [];
        s.queued = new Set(waiting.filter(k => !s.saved.has(k)));
        for (const t of (e && e.file && e.file.targets) || []) {
            const k = S().targetKey(t);
            if (k && !s.asked.has(k)) s.asked.set(k, t);
        }
        s.queuedWhy = !s.queued.size ? null
            : e && e.lastError && e.lastError.status ? e.lastError.message : 'offline';
    }

    // Flush the open share. A flush of this page already holding it files
    // what was added meanwhile, or leaves it; then this one goes.
    async function flushNow(sid) {
        let res = null;
        for (let i = 0; i < 3; i++) {
            try { res = await ctx.flush([sid]); } catch (e) { return null; }
            if (!res || !res.skipped.includes(sid) || !S().busy(sid)) return res;
            await S().whenIdle(sid);
        }
        return res;
    }

    async function upload() {
        const sid = s.sid;
        await flushNow(sid);
        if (!s || s.sid !== sid) return;
        const e = await ctx.outbox.get(sid).catch(() => null);
        if (!s || s.sid !== sid) return;
        syncEntry(e);
        render();
    }

    // Whatever flushed — this sheet, the app coming back online or to the
    // front, the worker's Background Sync: the folders it filed for the open
    // share are saved here (with Undo and Done), and what is left waits.
    async function onFlushed(res) {
        if (!s || !res) return;
        const sid = s.sid;
        const filed = (res.filed || []).filter(f => f.sid === sid);
        const touched = filed.length || [...(res.uploaded || []), ...(res.removed || []), ...(res.failed || []).map(f => f.sid)].includes(sid);
        if (!touched) return;
        // Filed in turns, it says everything this flush saved.
        const labels = filed.flatMap(f => took(f.result));
        if (labels.length) s.lastLabels = labels;
        const e = await ctx.outbox.get(sid).catch(() => null);
        if (!s || s.sid !== sid) return;
        syncEntry(e);
        render();
    }

    async function openForSid(sid) {
        let entry = await ctx.outbox.get(sid).catch(() => null);
        if (!entry && ctx.signedIn()) {
            try { entry = entryFromShare((await ctx.api('/api/shares/' + encodeURIComponent(sid))).share); } catch (e) { entry = null; }
        }
        if (!entry) { ctx.toast('That share is no longer on this phone or the server.'); return false; }
        return open(entry);
    }

    // A pasted or copied link: kept in the outbox like a share, then opened.
    async function openLink(url, source = 'paste', title = '') {
        const entry = S().makeEntry({ fields: { url, title, text: '' }, account: ctx.account(), source });
        if (!entry.url) { ctx.toast('That is not a link.'); return false; }
        try { await ctx.outbox.put(entry); } catch (e) { /* opened all the same; it uploads from memory */ }
        return open(entry);
    }

    function close() {
        clearTimeout(pressTimer);
        s = null;
        root.classList.add('hidden');
        document.body.classList.remove('share-open');
        clear(root);
        ctx.onClose();
    }

    // --- Who it belongs to ------------------------------------------------------------

    function accountOk() {
        if (!s || !ctx.signedIn()) return false;
        const cfg = ctx.account();
        return Boolean(cfg) && S().sameAccount(s.entry.account, { ...cfg, token: 'x' });
    }

    // Sharing as nobody, or as another account: never uploaded to this one
    // without a yes. Taken over, it is new for this account: another
    // account's upload of it and folders chosen in its tree stay behind.
    async function claim() {
        const account = ctx.account();
        if (!account) return;
        const e = await ctx.outbox.update(s.sid, (c) => ({ ...S().claimEntry(c, account), later: c.later }));
        s.entry = e || S().claimEntry(s.entry, account);
        s.share = null;
        s.saved = new Map();
        s.failed = new Map();
        syncEntry(s.entry);
        computeChips();
        render();
        if (s.entry.url) upload();
    }

    async function discard() {
        if (!confirm('Discard what you shared? It is not kept anywhere else.')) return;
        await ctx.outbox.remove(s.sid).catch(() => {});
        if (s.share && accountOk()) {
            try { await ctx.api(`/api/shares/${encodeURIComponent(ref())}/dismiss`, { method: 'POST', body: JSON.stringify(expect()) }); } catch (e) { /* kept dismissed locally */ }
        }
        close();
        refreshInbox();
    }

    // --- Chips ---------------------------------------------------------------------------

    function computeChips() {
        if (!s || !s.url) return;
        const c = ctx.copy();
        if (!c.ready) return;
        const r = S().suggest(appOf(), { index: c.index, prefs: ctx.prefs.get(), stats: ctx.stats() });
        s.firstTime = r.firstTime;
        s.starter = r.starter;
        s.slots = r.slots;
        s.holding = c.index.holding(s.urlKey).map(f => f.id);
        if (!s.chips) {
            s.chips = r.chips;
            return;
        }
        // Drawn once, never reordered: what arrives late only fills a slot.
        const have = new Set(s.chips.map(x => x.folderId));
        for (const chip of r.chips) {
            if (s.chips.length >= r.slots) break;
            if (!have.has(chip.folderId)) s.chips.push(chip);
        }
    }

    function chipMeta(chip, folder) {
        if (chip.reason === 'pinned') return '📌 pinned';
        if (chip.reason === 'last') return 'last used';
        if (chip.reason === 'recent') return 'recent';
        if (chip.reason === 'named') return 'your folder';
        if (chip.reason === 'count') return `${chip.count} ${label()} link${chip.count === 1 ? '' : 's'}`;
        if (chip.reason === 'biggest') return plural(folder.directCount, 'link');
        return '';
    }

    // --- Filing ---------------------------------------------------------------------------

    // A folder made on this phone and never pushed: the server has never
    // heard of it, so it goes as a new folder with its own id (and its
    // never-pushed ancestors with it), which the next push then matches.
    function localChain(folderId, c) {
        const chain = [];
        let f = c.index.folders.get(folderId);
        while (f && !c.serverIds.has(f.id)) {
            chain.unshift({ id: f.id, title: f.title, parentId: f.parentId || null });
            // A top-level folder of the phone's own: made at the top there too.
            if (!f.parentId) return chain;
            f = c.index.folders.get(f.parentId);
        }
        return f ? chain : null;
    }

    // The most the server takes for a title.
    const MAX_TITLE = 1000;

    // Tap after tap: each one's folders are added to what the share already
    // waits to be filed into (never replacing an earlier choice still on its
    // way or queued offline), and a flush goes.
    async function file(targets, labels) {
        if (!s || !accountOk()) return;
        const c = ctx.copy();
        const want = [];
        const folders = [];
        const keys = [];
        const refused = [];
        const addChain = (chain) => { for (const f of chain) if (!folders.some(x => x.id === f.id)) folders.push(f); };
        targets.forEach((t, i) => {
            const label = (labels && labels[i]) || '';
            if (t.folderId && c.ready && !c.serverIds.has(t.folderId)) {
                const chain = localChain(t.folderId, c);
                if (!chain || !chain.length) {
                    s.failed.set(t.folderId, 'unpushed');
                    refused.push({ folderId: t.folderId, reason: 'unpushed' });
                    return;
                }
                addChain(chain.slice(0, -1));
                want.push({ newFolder: chain[chain.length - 1], existing: true, label });
                keys.push(t.folderId);
            } else if (t.newFolder && t.newFolder.parentId && c.ready && !c.serverIds.has(t.newFolder.parentId)) {
                // A new folder inside one made on this phone and never
                // pushed: that one, and its never-pushed ancestors, go first.
                const chain = localChain(t.newFolder.parentId, c);
                if (!chain) {
                    s.failed.set(t.newFolder.id, 'unpushed');
                    refused.push({ newFolderId: t.newFolder.id, reason: 'unpushed', title: t.newFolder.title });
                    return;
                }
                addChain(chain);
                want.push({ ...t, label });
                keys.push(t.newFolder.id);
            } else {
                want.push({ ...t, label });
                keys.push(S().targetKey(t));
            }
        });
        if (!want.length) {
            s.message = failedMessage(refused, 0);
            render();
            return;
        }
        keys.forEach(k => { s.pending.add(k); s.failed.delete(k); });
        want.forEach(t => s.asked.set(S().targetKey(t), t));
        s.message = null;
        render();
        const title = String(s.title || '').trim().slice(0, MAX_TITLE) || undefined;
        const intent = S().makeIntent(want, folders, { title, at: new Date().toISOString() });
        const sid = s.sid;
        let entry = await ctx.outbox.update(sid, (e) => ({ ...e, file: S().mergeIntent(e.file, intent), later: false })).catch(() => null);
        if (!entry && s && s.sid === sid) {
            // Filed once already from this sheet, so it left the outbox: back
            // in, as the uploaded share it is, with this choice.
            entry = await ctx.outbox.put({
                ...s.entry, uploaded: Boolean(s.share) || s.entry.uploaded, share: s.share, file: intent, later: false, lastError: null
            }).catch(() => null);
        }
        let res = null;
        if (entry) {
            res = await flushNow(sid);
        } else if (s && s.sid === sid && s.share) {
            // Nowhere on the phone to keep the choice (storage refused it):
            // straight to the server, or not at all.
            try {
                const r = await ctx.api(`/api/shares/${encodeURIComponent(ref())}/file`, {
                    method: 'POST',
                    body: JSON.stringify({ targets: want.map(({ label: l, ...t }) => t), folders, title, app: s.app || undefined, ...expect() })
                });
                ctx.applyFiled(r);
                if (s && s.sid === sid) took(r);
            } catch (e) {
                if (s && s.sid === sid) s.message = `Couldn't save: ${(e.body && e.body.error) || e.message}`;
            }
        }
        if (!s || s.sid !== sid) return;
        keys.forEach(k => s.pending.delete(k));
        // What the flush filed is saved already (onFlushed); the rest says why.
        const e = entry ? await ctx.outbox.get(sid).catch(() => null) : null;
        if (!s || s.sid !== sid) return;
        if (entry) syncEntry(e);
        const errors = res ? res.failed.filter(f => f.sid === sid).map(f => f.error).filter(Boolean) : [];
        const notTaken = errors.flatMap(er => er.failed || []).filter(f => keys.includes(f.folderId || f.newFolderId));
        const unsaved = keys.filter(k => !s.saved.has(k));
        if (notTaken.length) {
            for (const f of notTaken) s.failed.set(f.folderId || f.newFolderId, f.reason);
            s.message = failedMessage(notTaken, keys.filter(k => s.saved.has(k)).length);
        } else if (refusedForGood(e)) {
            s.message = `Couldn't save to ${unsaved.map(labelOf).join(', ')} — the server did not take this link: ${e.lastError.message}`;
        } else if (!ctx.signedIn() && unsaved.some(k => s.queued.has(k))) {
            // The session ended on the way: kept with the share, filed after
            // the next sign-in.
            s.message = 'Your session ended — sign in again, and it is saved then.';
        } else if (unsaved.some(k => s.queued.has(k))) {
            ctx.registerSync();
        } else if (unsaved.length && errors.length) {
            s.message = `Couldn't save: ${errors[errors.length - 1].message}`;
        }
        if (refused.length && !s.message) s.message = failedMessage(refused, keys.filter(k => s.saved.has(k)).length);
        // Saved everywhere this tap asked, with nothing failed or waiting: the
        // sheet's job is done, so it closes, and Undo moves to the toast.
        if (keys.length && keys.every(k => s.saved.has(k)) && !s.message && !s.queued.size) {
            const shareRef = ref(), asWho = expect();
            const undone = keys.filter(k => !s.saved.get(k).already);
            refreshInbox();
            done(undone.length ? () => unfileAfterClose(shareRef, asWho, undone) : null);
            return;
        }
        render();
        refreshInbox();
    }

    // Undo from the toast, once the sheet has closed.
    async function unfileAfterClose(shareRef, asWho, folderIds) {
        try {
            const res = await ctx.api(`/api/shares/${encodeURIComponent(shareRef)}/unfile`, { method: 'POST', body: JSON.stringify({ folderIds, ...asWho }) });
            ctx.applyUnfiled(res);
            ctx.toast((res.kept || []).length ? 'Undone, except what was changed since.' : 'Undone.');
        } catch (e) {
            ctx.toast(`Couldn't undo: ${e.message}`);
        }
        refreshInbox();
    }

    // What a filing's answer means for the sheet: chips saved (or already
    // there, or failed), the bar, and a new folder kept on screen as a chip.
    // A folder this share was filed into already — the worker's request, or a
    // retry after a lost answer, got there first — is this tap's all the
    // same: saved, with Undo.
    function took(r) {
        const c = ctx.copy();
        s.share = r.share || s.share;
        const own = new Map(((r.share && r.share.filings) || []).map(f => [f.folderId, f.bookmarkId]));
        const savedLabels = [];
        for (const n of r.created || []) {
            if (n.kind === 'folder') {
                const asked = s.asked.get(n.id);
                if (s.chips && c.ready && !s.chips.some(x => x.folderId === n.id) && asked && asked.newFolder) {
                    s.chips.push({ folderId: n.id, reason: 'new' });
                }
                continue;
            }
            const name = labelOf(n.parentId);
            s.saved.set(n.parentId, { bookmarkId: n.id, already: false, label: name });
            savedLabels.push(name);
        }
        for (const a of r.already || []) {
            if (s.saved.has(a.folderId)) continue;
            const mine = own.get(a.folderId) === a.bookmarkId;
            const name = labelOf(a.folderId);
            s.saved.set(a.folderId, { bookmarkId: a.bookmarkId, already: !mine, label: name });
            if (mine) savedLabels.push(name);
        }
        for (const f of r.failed || []) s.failed.set(f.folderId || f.newFolderId, f.reason);
        if (savedLabels.length) {
            s.lastLabels = savedLabels;
            if (navigator.vibrate) { try { navigator.vibrate(15); } catch (e) { /* not on this device */ } }
        }
        s.message = failedMessage(r.failed || [], savedLabels.length);
        for (const k of s.saved.keys()) { s.queued.delete(k); s.pending.delete(k); }
        return savedLabels;
    }

    // A folder's name for the sheet: from the copy, else as the tap asked for it.
    function labelOf(folderId) {
        const c = ctx.copy();
        const f = c.ready ? c.index.folders.get(folderId) : null;
        if (f) return f.title;
        const t = s && s.asked.get(folderId);
        return (t && (t.label || (t.newFolder && t.newFolder.title))) || 'a folder';
    }

    function failedMessage(failed, savedCount) {
        if (!failed.length) return null;
        const names = failed.map(f => {
            const id = f.folderId || f.newFolderId;
            const why = f.reason === 'missing' ? 'deleted on another device'
                : f.reason === 'read-only' ? 'not a bookmark folder'
                    : f.reason === 'conflict' ? 'a different folder has that id'
                        : f.reason === 'unpushed' ? 'push first: the server has not seen it' : f.reason;
            return `${f.title || labelOf(id)} (${why})`;
        });
        return `Couldn't save to ${names.join(', ')}.` + (savedCount ? ` Saved to the other ${savedCount}.` : '');
    }

    async function undo() {
        if (!s) return;
        const folderIds = [...s.saved.entries()].filter(([, v]) => !v.already).map(([k]) => k);
        if (!folderIds.length) return;
        try {
            const res = await ctx.api(`/api/shares/${encodeURIComponent(ref())}/unfile`, { method: 'POST', body: JSON.stringify({ folderIds, ...expect() }) });
            ctx.applyUnfiled(res);
            folderIds.forEach(k => s.saved.delete(k));
            s.share = res.share || s.share;
            s.lastLabels = [];
            s.message = (res.kept || []).length ? 'Undone, except what was changed since.' : null;
            render();
            refreshInbox();
        } catch (e) {
            ctx.toast(`Couldn't undo: ${e.message}`);
        }
    }

    const savedCount = () => [...s.saved.values()].filter(v => !v.already).length;

    async function later() {
        if (!s) return;
        if (savedCount()) return done();
        const sid = s.sid;
        if (s.url) {
            const mine = accountOk();
            const e = await ctx.outbox.update(sid, (c) => ({ ...c, later: true })).catch(() => null);
            close();
            if (e && mine) await ctx.flush([sid]).catch(() => {});
        } else {
            // No link: the text stays in the outbox until Save as note or Discard.
            close();
        }
        refreshInbox();
    }

    function done(undo = null) {
        if (!s) return;
        const labels = [...s.saved.values()].filter(v => !v.already).map(v => v.label);
        const fromShare = s.fromShare;
        close();
        ctx.done({ label: labels.length ? labels.join(', ') : '', fromShare, undo: typeof undo === 'function' ? undo : null });
    }

    // --- Prefs: pins, hides, slots ------------------------------------------------------

    function appPrefs(value, app) {
        const v = value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : { v: 1, slots: 4, apps: {} };
        v.v = 1;
        v.apps = v.apps || {};
        v.apps[app] = v.apps[app] || { pinned: [], hidden: [] };
        v.apps[app].pinned = v.apps[app].pinned || [];
        v.apps[app].hidden = v.apps[app].hidden || [];
        return v;
    }

    async function changePrefs(fn) {
        const app = appOf();
        await ctx.prefs.update((value) => { const v = appPrefs(value, app); fn(v, v.apps[app]); return v; }, app);
        if (s) {
            s.chips = null;
            computeChips();
            render();
        }
    }

    const pin = (id) => changePrefs((v, a) => { a.hidden = a.hidden.filter(x => x !== id); if (!a.pinned.includes(id)) a.pinned.push(id); });
    const unpin = (id) => changePrefs((v, a) => { a.pinned = a.pinned.filter(x => x !== id); });
    const hide = (id) => changePrefs((v, a) => { a.pinned = a.pinned.filter(x => x !== id); if (!a.hidden.includes(id)) a.hidden.push(id); });
    const movePin = (id, by) => changePrefs((v, a) => {
        const i = a.pinned.indexOf(id);
        const j = i + by;
        if (i < 0 || j < 0 || j >= a.pinned.length) return;
        [a.pinned[i], a.pinned[j]] = [a.pinned[j], a.pinned[i]];
    });
    const setSlots = (n) => changePrefs((v) => { v.slots = Math.min(8, Math.max(2, n)); });
    const isPinned = (id) => {
        const v = ctx.prefs.get();
        return Boolean(v && v.apps && v.apps[appOf()] && (v.apps[appOf()].pinned || []).includes(id));
    };

    // --- Rendering -----------------------------------------------------------------------

    // Drawn again from scratch on every change (a filing, the folders or
    // prefs arriving): the title being typed, or the picker's search, keeps
    // its focus and caret, so the keyboard stays up mid-word.
    const KEEPS_FOCUS = ['share-title-input', 'share-search'];

    function render() {
        if (!s) return;
        const active = document.activeElement;
        const keep = active && root.contains && root.contains(active) && active.classList
            ? KEEPS_FOCUS.find(cls => active.classList.contains(cls)) : null;
        let caret = null;
        try { caret = keep && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null; } catch (e) { caret = null; }
        // Where the link is in the copy now: filings and undos change it.
        const c = ctx.copy();
        s.holding = c.ready && s.urlKey ? c.index.holding(s.urlKey).map(f => f.id) : [];
        clear(root);
        if (s.view === 'picker') renderPicker();
        else if (s.view === 'edit') renderEdit();
        else renderMain();
        if (!keep) return;
        const again = root.querySelector('.' + keep);
        if (!again || !again.focus) return;
        again.focus();
        if (caret && again.setSelectionRange) { try { again.setSelectionRange(caret[0], caret[1]); } catch (e) { /* not a text field */ } }
    }

    function header(title, { back = null, closeAs = 'Later' } = {}) {
        return h('div', { class: 'sheet-header share-header' },
            back ? h('button', { class: 'ghost share-back', type: 'button', title: 'Back', onclick: back, text: '←' }) : null,
            h('strong', { id: 'share-title', text: title }),
            h('button', { class: 'ghost share-close', type: 'button', title: closeAs, 'aria-label': closeAs, onclick: () => later(), text: '✕' }));
    }

    function linkCard() {
        const titleInput = h('input', {
            class: 'share-title-input', type: 'text', value: s.title, placeholder: 'Title', 'aria-label': 'Title', maxlength: MAX_TITLE,
            oninput: (e) => { s.title = e.target.value; }
        });
        const urlLine = h('button', {
            class: 'share-url', type: 'button', title: 'Copy the link', text: s.url,
            onclick: async () => {
                try { await navigator.clipboard.writeText(s.url); ctx.toast('Link copied.'); } catch (e) { /* no clipboard here */ }
            }
        });
        const c = ctx.copy();
        // Already there before this sheet filed it anywhere.
        const holding = (s.holding || []).filter(id => !s.saved.has(id) || s.saved.get(id).already)
            .map(id => c.ready ? c.index.folders.get(id) : null).filter(Boolean);
        const archived = (s.share && s.share.status === 'archived') || s.entry.archived
            || (s.share && s.share.status === 'filed' && ['x', 'instagram'].includes(appOf()));
        return h('div', { class: 'share-card' },
            h('div', { class: 'share-card-top' }, favicon(s.url), titleInput),
            h('div', { class: 'share-card-meta' }, urlLine, h('span', { class: 'share-pill', text: `From ${label()}` })),
            holding.length ? h('div', { class: 'share-already', text: `Already in: ${holding.map(f => S().fullPath(f, c.index)).join(' · ')}` }) : null,
            archived && ['x', 'instagram'].includes(appOf()) ? h('div', { class: 'share-archived', text: `Kept in your ${label()} archive` }) : null,
            s.share && s.share.note ? h('div', { class: 'share-note', text: s.share.note }) : null);
    }

    function renderMain() {
        root.appendChild(header('Save link'));
        const body = h('div', { class: 'share-body' });
        root.appendChild(body);

        if (!s.url) {
            body.appendChild(h('div', { class: 'share-nolink' },
                h('p', { class: 'share-state', text: 'No link in what you shared' }),
                h('blockquote', { class: 'share-text', text: s.entry.text || s.entry.fields.title || '' }),
                s.message ? h('p', { class: 'share-message', text: s.message }) : null,
                h('div', { class: 'share-actions' },
                    h('button', { class: 'primary', type: 'button', text: 'Save as note', onclick: () => saveAsNote() }),
                    h('button', { class: 'ghost-block danger', type: 'button', text: 'Discard', onclick: () => discard() }))));
            return;
        }
        body.appendChild(linkCard());

        if (!ctx.signedIn()) {
            body.appendChild(h('div', { class: 'share-signin' },
                h('p', { class: 'share-state', text: 'Kept on this phone: sign in to file it.' }),
                h('button', { class: 'primary', type: 'button', text: 'Sign in', onclick: () => ctx.openSettings() })));
            return;
        }
        if (!accountOk()) {
            const who = s.entry.account && s.entry.account.username;
            body.appendChild(h('div', { class: 'share-claim' },
                h('p', { class: 'share-state', text: who ? `Shared while signed in as ${who}.` : 'Shared while nobody was signed in.' }),
                h('div', { class: 'share-actions' },
                    h('button', { class: 'primary', type: 'button', text: `Upload to ${ctx.username()}`, onclick: () => claim() }),
                    h('button', { class: 'ghost-block danger', type: 'button', text: 'Discard', onclick: () => discard() }))));
            return;
        }

        // Not on the server yet: say why, in the server's words when it
        // refused (a full inbox, say). It stays on the phone either way.
        if (!s.entry.uploaded && !s.share && s.entry.lastError) {
            body.appendChild(h('p', { class: 'share-offline share-refused', text: s.entry.lastError.status
                ? `Kept on this phone — the server did not take it: ${s.entry.lastError.message}`
                : 'Kept on this phone — the server could not be reached. It goes up when it can.' }));
        }
        const c = ctx.copy();
        if (s.firstTime && !savedCount()) {
            body.appendChild(h('p', { class: 'share-first', text: `First ${label()} link: pick a folder, and next time it's one tap.` }));
        }
        body.appendChild(h('div', { class: 'share-to-head' },
            h('span', { text: 'Save to' }),
            c.ready ? h('button', { class: 'ghost share-edit', type: 'button', text: '✎ Edit', onclick: () => { s.view = 'edit'; render(); } }) : null));

        if (!c.ready) {
            body.appendChild(h('p', { class: 'hint share-loading', text: 'Loading your folders…' }));
        } else {
            // In the order the number keys pick them: the starter first.
            const grid = h('div', { class: 'share-chips', role: 'list' });
            const shown = visibleChips();
            shown.forEach((chip, i) => grid.appendChild(chip === STARTER ? starterChip(i) : chipEl(chip, i, c)));
            body.appendChild(grid);
        }
        const waiting = [...s.queued].filter(k => !s.pending.has(k));
        if (waiting.length) {
            const names = waiting.map(labelOf).map(n => (n === 'a folder' ? 'the new folder' : n));
            body.appendChild(h('p', { class: 'share-offline', text: s.queuedWhy && s.queuedWhy !== 'offline'
                ? `Will save to ${names.join(', ')} — the server could not take it just now (${s.queuedWhy}); it tries again.`
                : `Will save to ${names.join(', ')} when you're back online.` }));
        }
        if (s.message) body.appendChild(h('p', { class: 'share-message', text: s.message }));

        if (s.lastLabels.length && savedCount()) {
            body.appendChild(h('div', { class: 'share-bar', role: 'status' },
                h('span', { text: `✓ Saved to ${s.lastLabels.join(', ')}` }),
                h('button', { class: 'ghost share-undo', type: 'button', text: 'Undo', onclick: () => undo() })));
        }

        const saved = savedCount() > 0;
        root.appendChild(h('div', { class: 'sheet-footer share-footer' },
            h('button', {
                class: saved ? 'primary share-done' : 'ghost-block share-later', type: 'button',
                text: saved ? 'Done' : 'Later', onclick: () => (saved ? done() : later())
            }),
            c.ready ? h('button', {
                class: 'ghost share-more', type: 'button', text: saved ? 'Add to another folder…' : 'Other folder or several…',
                onclick: () => openPicker()
            }) : null));
    }

    // The chips as drawn: the starter (a first link from an app) first.
    const STARTER = { starter: true };
    const visibleChips = () => [...(s.starter && !savedCount() ? [STARTER] : []), ...(s.chips || [])];

    function useStarter() {
        const st = s && s.starter;
        if (!st) return;
        if (st.kind === 'app-folder' && st.parentId) {
            const id = ctx.newId();
            file([{ newFolder: { id, title: st.title, parentId: st.parentId } }], [st.title]);
        } else {
            openPicker({ create: true });
        }
    }

    function starterChip(i = 0) {
        const st = s.starter;
        const text = st.kind === 'app-folder' ? `+ New "${st.title}" folder` : '+ New folder…';
        return h('button', {
            class: 'share-chip share-chip-new', type: 'button', role: 'listitem', dataset: { n: String(i + 1) },
            onclick: () => useStarter()
        }, h('span', { class: 'share-chip-name', text }), h('span', { class: 'share-chip-path', text: st.kind === 'app-folder' ? 'in Bookmarks' : 'name it, pick where' }));
    }

    function chipEl(chip, i, c) {
        const folder = c.index.folders.get(chip.folderId);
        if (!folder) return h('span', { class: 'share-chip share-chip-gone' });
        const saved = s.saved.get(chip.folderId);
        const already = !saved && (s.holding || []).includes(chip.folderId);
        const failed = s.failed.get(chip.folderId);
        const pending = s.pending.has(chip.folderId);
        const queued = s.queued.has(chip.folderId);
        const cls = ['share-chip',
            saved ? (saved.already ? 'already' : 'saved') : '', already ? 'already' : '',
            failed ? 'missing' : '', pending ? 'pending' : '', queued ? 'queued' : '',
            chip.reason === 'pinned' ? 'pinned' : ''].filter(Boolean).join(' ');
        const meta = saved ? (saved.already ? '✓ already here' : '✓ Saved') : already ? '✓ already here'
            : failed ? 'not saved' : queued ? '⏳ when online' : chipMeta(chip, folder);
        const el = h('button', {
            class: cls, type: 'button', role: 'listitem', disabled: Boolean(saved || already || pending),
            dataset: { folderId: chip.folderId, n: String(i + 1) },
            title: S().fullPath(folder, c.index),
            onclick: () => { if (!saved && !already && !pending) file([{ folderId: chip.folderId }], [folder.title]); },
            oncontextmenu: (e) => { e.preventDefault(); openMenu(chip.folderId); }
        },
        h('span', { class: 'share-chip-name', text: folder.title || '(unnamed)' }),
        h('span', { class: 'share-chip-path', text: S().parentPath(folder, c.index) || 'Bookmarks' }),
        h('span', { class: 'share-chip-meta', text: meta }));
        // Long-press on a phone opens the same menu as a right-click.
        el.addEventListener('touchstart', () => { clearTimeout(pressTimer); pressTimer = setTimeout(() => openMenu(chip.folderId), 550); }, { passive: true });
        for (const ev of ['touchend', 'touchmove', 'touchcancel']) el.addEventListener(ev, () => clearTimeout(pressTimer), { passive: true });
        return el;
    }

    function openMenu(folderId) {
        if (!s) return;
        const pinned = isPinned(folderId);
        const items = [
            [pinned ? `Unpin for ${label()}` : `Pin for ${label()}`, () => (pinned ? unpin(folderId) : pin(folderId))],
            [`Don't suggest for ${label()}`, () => hide(folderId)],
            ['Open folder', () => { const id = folderId; close(); ctx.openFolder(id); }]
        ];
        const existing = root.querySelector && root.querySelector('.share-menu');
        if (existing && existing.remove) existing.remove();
        const menu = h('div', { class: 'share-menu', role: 'menu' },
            items.map(([text, fn]) => h('button', { type: 'button', role: 'menuitem', text, onclick: () => { menu.remove && menu.remove(); fn(); } })),
            h('button', { type: 'button', class: 'ghost', text: 'Cancel', onclick: () => menu.remove && menu.remove() }));
        root.appendChild(menu);
    }

    // The text is only on this phone (a share with no link never goes up):
    // it leaves the outbox once the note editor holds it, and not before —
    // signed out, offline with nothing pulled, or a note being written that
    // the user keeps, it stays here and in the Inbox.
    async function saveAsNote() {
        if (!s) return;
        const text = [s.entry.fields.title, s.entry.text].filter(Boolean).join('\n\n');
        const sid = s.sid;
        let opened = false;
        try { opened = Boolean(await ctx.saveAsNote(text)); } catch (e) { opened = false; }
        if (!opened) {
            if (s && s.sid === sid) {
                s.message = 'Not saved as a note yet — it stays here, and in the Inbox, until you save it or discard it.';
                render();
            }
            return;
        }
        await ctx.outbox.remove(sid).catch(() => {});
        if (s && s.sid === sid) close();
        refreshInbox();
    }

    // --- Screen 2: the folder picker --------------------------------------------------------

    function openPicker({ create = false, single = null } = {}) {
        const c = ctx.copy();
        if (!c.ready) return;
        s.view = 'picker';
        s.picker = { query: '', selected: new Set(), creating: [], single, focus: 0 };
        render();
        if (create) createFolder();
    }

    function defaultParent(c) {
        const r = S().suggest(appOf(), { index: c.index, prefs: ctx.prefs.get(), stats: ctx.stats() });
        const top = r.chips[0] && c.index.folders.get(r.chips[0].folderId);
        return (top && top.parentId && c.index.folders.has(top.parentId) ? top.parentId : null) || c.index.bookmarksRootId
            || (c.index.list[0] && c.index.list[0].id) || null;
    }

    function createFolder(name = null, parentId = null) {
        const c = ctx.copy();
        const title = (name === null ? prompt('Name of the new folder:') : name) || '';
        if (!title.trim()) return;
        const parent = parentId || defaultParent(c);
        if (!parent) { ctx.toast('There is no folder to put it in yet.'); return; }
        const spec = { id: ctx.newId(), title: title.trim().slice(0, 200), parentId: parent };
        s.picker.creating.push(spec);
        s.picker.selected.add(spec.id);
        s.picker.query = '';
        render();
    }

    function pickerRow(folder, c, { ranges = null, indent = false } = {}) {
        const p = s.picker;
        const on = p.selected.has(folder.id);
        const saved = s.saved.get(folder.id);
        const count = folder.apps[appOf()] || 0;
        const toggle = () => {
            if (p.single) { p.single(folder.id); return; }
            if (saved) return;
            if (on) p.selected.delete(folder.id); else p.selected.add(folder.id);
            render();
        };
        return h('label', {
            class: 'share-row' + (on ? ' on' : '') + (saved ? ' saved' : ''), dataset: { folderId: folder.id },
            style: indent ? `padding-left:${12 + Math.min(folder.depth, 8) * 14}px` : null
        },
        p.single ? null : h('input', { type: 'checkbox', checked: on || Boolean(saved), disabled: Boolean(saved), onchange: toggle }),
        h('span', { class: 'share-row-text' },
            h('span', { class: 'share-row-name' }, highlighted(folder.title || '(unnamed)', ranges)),
            h('span', { class: 'share-row-path', text: S().parentPath(folder, c.index, { max: 4 }) })),
        count ? h('span', { class: 'share-row-count', text: String(count) }) : null,
        p.single ? h('button', { type: 'button', class: 'ghost', text: 'Choose', onclick: toggle }) : null);
    }

    function renderPicker() {
        const c = ctx.copy();
        const p = s.picker;
        const n = p.selected.size;
        root.appendChild(header(p.single ? 'Pin a folder' : 'Save to folders', { back: () => { s.view = p.single ? 'edit' : 'main'; s.picker = null; render(); } }));
        const search = h('input', {
            class: 'share-search', type: 'search', placeholder: 'Search folders', value: p.query, 'aria-label': 'Search folders',
            oninput: (e) => { p.query = e.target.value; renderPickerList(list, c); }
        });
        const list = h('div', { class: 'share-picker-list' });
        root.appendChild(h('div', { class: 'share-body share-picker' },
            h('div', { class: 'share-picker-top' },
                search,
                p.single ? null : h('span', { class: 'share-count', text: n ? `${n} selected` : '' })),
            list));
        renderPickerList(list, c);
        if (!p.single) {
            root.appendChild(h('div', { class: 'sheet-footer share-footer share-picker-footer' },
                h('button', {
                    class: 'primary share-save', type: 'button', disabled: n === 0,
                    text: n ? `Save to ${plural(n, 'folder')}` : 'Pick folders', onclick: () => savePicked()
                })));
        }
        if (ctx.isDesktop()) setTimeout(() => search.focus && search.focus(), 0);
    }

    function renderPickerList(list, c) {
        const p = s.picker;
        clear(list);
        const q = p.query.trim();
        if (!p.single) {
            list.appendChild(h('button', { class: 'share-row share-new', type: 'button', text: '+ New folder', onclick: () => createFolder() }));
            for (const spec of p.creating) {
                const parent = c.index.folders.get(spec.parentId);
                list.appendChild(h('label', { class: 'share-row on share-creating' },
                    h('input', {
                        type: 'checkbox', checked: p.selected.has(spec.id),
                        onchange: () => { if (p.selected.has(spec.id)) p.selected.delete(spec.id); else p.selected.add(spec.id); render(); }
                    }),
                    h('span', { class: 'share-row-text' },
                        h('span', { class: 'share-row-name', text: `${spec.title} (new)` }),
                        h('span', { class: 'share-row-path', text: parent ? S().fullPath(parent, c.index) : '' }))));
            }
        }
        if (q) {
            const hits = S().searchFolders(c.index, q);
            if (!p.single && !hits.some(x => x.folder.title.trim().toLowerCase() === q.toLowerCase())) {
                const parentSelect = h('select', { class: 'share-parent', 'aria-label': 'Create it in' },
                    c.index.list.map(f => h('option', { value: f.id, text: S().fullPath(f, c.index) || f.title })));
                parentSelect.value = defaultParent(c);
                list.appendChild(h('div', { class: 'share-row share-create' },
                    h('button', { type: 'button', class: 'ghost', text: `+ Create "${q}" in`, onclick: () => createFolder(q, parentSelect.value) }),
                    parentSelect));
            }
            if (!hits.length) list.appendChild(h('p', { class: 'hint', text: 'No folder matches.' }));
            hits.forEach(hit => list.appendChild(pickerRow(hit.folder, c, { ranges: hit.ranges })));
            return;
        }
        const r = S().suggest(appOf(), { index: c.index, prefs: ctx.prefs.get(), stats: ctx.stats() });
        if (r.chips.length) {
            list.appendChild(h('div', { class: 'share-section', text: `For ${label()}` }));
            r.chips.forEach(chip => {
                const f = c.index.folders.get(chip.folderId);
                if (!f) return;
                const row = pickerRow(f, c);
                if (!p.single) {
                    const pinned = isPinned(f.id);
                    row.appendChild(h('button', {
                        type: 'button', class: 'ghost share-pin' + (pinned ? ' on' : ''), title: pinned ? 'Unpin' : `Pin for ${label()}`,
                        text: '📌', onclick: (e) => { e.preventDefault(); (pinned ? unpin(f.id) : pin(f.id)); }
                    }));
                }
                list.appendChild(row);
            });
        }
        const recent = S().recentFolders(ctx.stats()).map(x => c.index.folders.get(x.folderId)).filter(Boolean).slice(0, 8);
        if (recent.length) {
            list.appendChild(h('div', { class: 'share-section', text: 'Recent' }));
            recent.forEach(f => list.appendChild(pickerRow(f, c)));
        }
        list.appendChild(h('div', { class: 'share-section', text: 'All folders' }));
        c.index.list.forEach(f => list.appendChild(pickerRow(f, c, { indent: true })));
    }

    function savePicked() {
        const c = ctx.copy();
        const p = s.picker;
        const targets = [];
        const labels = [];
        for (const id of p.selected) {
            const spec = p.creating.find(x => x.id === id);
            if (spec) { targets.push({ newFolder: spec }); labels.push(spec.title); continue; }
            const f = c.index.folders.get(id);
            if (f && !s.saved.has(id)) { targets.push({ folderId: id }); labels.push(f.title); }
        }
        s.view = 'main';
        s.picker = null;
        // A folder picked here is on screen from now on, as a chip.
        for (const t of targets) {
            if (t.folderId && !s.chips.some(x => x.folderId === t.folderId)) s.chips.push({ folderId: t.folderId, reason: 'picked' });
        }
        if (targets.length) file(targets, labels);
        else render();
    }

    // --- Screen 3: edit the chips for this app -------------------------------------------------

    function renderEdit() {
        const c = ctx.copy();
        root.appendChild(header(`Edit for ${label()}`, { back: () => { s.view = 'main'; s.chips = null; computeChips(); render(); } }));
        const body = h('div', { class: 'share-body share-edit-body' });
        root.appendChild(body);
        const v = ctx.prefs.get();
        const a = (v && v.apps && v.apps[appOf()]) || { pinned: [], hidden: [] };
        const r = S().suggest(appOf(), { index: c.index, prefs: v, stats: ctx.stats() });
        body.appendChild(h('p', { class: 'hint', text: 'Pinned folders come first, in this order. Hidden ones are never suggested for this app.' }));
        const shown = r.chips.map(x => x.folderId);
        const ids = [...new Set([...(a.pinned || []), ...shown])].filter(id => c.index.folders.has(id));
        for (const id of ids) {
            const f = c.index.folders.get(id);
            const pinned = (a.pinned || []).includes(id);
            body.appendChild(h('div', { class: 'share-edit-row' + (pinned ? ' pinned' : '') },
                h('span', { class: 'share-row-text' },
                    h('span', { class: 'share-row-name', text: f.title }),
                    h('span', { class: 'share-row-path', text: S().parentPath(f, c.index) })),
                pinned ? h('button', { type: 'button', class: 'ghost', title: 'Earlier', text: '◀', onclick: () => movePin(id, -1) }) : null,
                pinned ? h('button', { type: 'button', class: 'ghost', title: 'Later', text: '▶', onclick: () => movePin(id, 1) }) : null,
                h('button', { type: 'button', class: 'ghost share-pin' + (pinned ? ' on' : ''), text: pinned ? '📌 Unpin' : '📌 Pin', onclick: () => (pinned ? unpin(id) : pin(id)) }),
                h('button', { type: 'button', class: 'ghost', text: 'Hide', onclick: () => hide(id) })));
        }
        const hidden = (a.hidden || []).map(id => c.index.folders.get(id)).filter(Boolean);
        if (hidden.length) {
            body.appendChild(h('div', { class: 'share-section', text: 'Hidden' }));
            for (const f of hidden) {
                body.appendChild(h('div', { class: 'share-edit-row hidden-folder' },
                    h('span', { class: 'share-row-name', text: f.title }),
                    h('button', {
                        type: 'button', class: 'ghost', text: 'Show again',
                        onclick: () => changePrefs((pv, pa) => { pa.hidden = pa.hidden.filter(x => x !== f.id); })
                    })));
            }
        }
        body.appendChild(h('button', {
            type: 'button', class: 'ghost-block', text: '+ Pin a folder',
            onclick: () => openPicker({ single: (id) => { s.view = 'edit'; s.picker = null; pin(id); } })
        }));
        const slots = r.slots;
        body.appendChild(h('div', { class: 'share-stepper' },
            h('span', { text: 'Show' }),
            h('button', { type: 'button', class: 'ghost', text: '−', disabled: slots <= 2, onclick: () => setSlots(slots - 1) }),
            h('strong', { text: String(slots) }),
            h('button', { type: 'button', class: 'ghost', text: '+', disabled: slots >= 8, onclick: () => setSlots(slots + 1) }),
            h('span', { text: 'suggestions' })));
    }

    // --- Keyboard (desktop) ------------------------------------------------------------------

    function onKey(e) {
        if (!isOpen()) return false;
        // A sheet opened over it (Settings, the Inbox, a user's) has the keys:
        // Esc closes that one, typing goes into its fields.
        const over = ['settings-sheet', 'inbox-sheet', 'user-sheet'].some((id) => {
            const el = document.getElementById(id);
            return el && el.classList && !el.classList.contains('hidden');
        });
        if (over) return false;
        const typing = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT');
        if (e.key === 'Escape') {
            e.preventDefault();
            if (s.view !== 'main') { s.view = 'main'; s.picker = null; render(); } else later();
            return true;
        }
        if (s.view === 'picker') {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); savePicked(); return true; }
            if (e.key === '/' && !typing) { e.preventDefault(); const el = root.querySelector('.share-search'); if (el && el.focus) el.focus(); return true; }
            if (e.key === 'Enter' && typing && s.picker.query.trim()) {
                const hit = S().searchFolders(ctx.copy().index, s.picker.query)[0];
                if (hit) {
                    e.preventDefault();
                    if (s.picker.single) { s.picker.single(hit.folder.id); return true; }
                    if (s.picker.selected.has(hit.folder.id)) s.picker.selected.delete(hit.folder.id); else s.picker.selected.add(hit.folder.id);
                    s.picker.query = '';
                    render();
                    return true;
                }
            }
            return false;
        }
        if (s.view !== 'main' || typing || e.ctrlKey || e.metaKey || e.altKey) return false;
        // 1-9 pick the chips in the order they are drawn, the starter first.
        const n = Number(e.key);
        const shown = ctx.copy().ready && s.url && accountOk() ? visibleChips() : [];
        if (Number.isInteger(n) && n >= 1 && n <= 9 && shown[n - 1]) {
            e.preventDefault();
            const chip = shown[n - 1];
            if (chip === STARTER) { useStarter(); return true; }
            const f = ctx.copy().index.folders.get(chip.folderId);
            if (f && !s.saved.has(chip.folderId) && !s.pending.has(chip.folderId) && !(s.holding || []).includes(chip.folderId)) {
                file([{ folderId: chip.folderId }], [f.title]);
            }
            return true;
        }
        // Enter is Done only when nothing that takes Enter itself has the
        // focus: on Undo, a chip or a link it does what that one does.
        const own = e.target && (['BUTTON', 'A', 'SUMMARY'].includes(e.target.tagName)
            || (e.target.getAttribute && ['button', 'link', 'menuitem'].includes(e.target.getAttribute('role'))));
        if (e.key === 'Enter' && savedCount() && !own) { e.preventDefault(); done(); return true; }
        // Typing a name goes straight to the picker's search.
        if (e.key.length === 1 && /\S/.test(e.key) && ctx.copy().ready && s.url && accountOk()) {
            e.preventDefault();
            openPicker();
            s.picker.query = e.key;
            render();
            return true;
        }
        return false;
    }

    // --- Screen 4: the Inbox -----------------------------------------------------------------

    // What the Inbox lists under Waiting: not on the server yet (or refused,
    // or with folders still to file into), with no link, or kept for another
    // account. The count is the same rows the Inbox draws: these, and the
    // server's waiting shares not among them.
    function waitingEntries() {
        const me = ctx.account();
        const theirs = (e) => !me || !S().sameAccount(e.account, { ...me, token: 'x' });
        return inbox.entries.filter(e => !e.url || !e.uploaded || e.file || (e.lastError && e.lastError.permanent) || theirs(e))
            .map(e => ({ e, foreign: theirs(e) }));
    }

    function inboxCount() {
        const waiting = waitingEntries();
        const local = new Set(waiting.map(w => w.e.sid));
        return inbox.pending.filter(x => !local.has(x.sid)).length + waiting.length;
    }

    async function loadInbox() {
        let entries = [];
        try { entries = await ctx.outbox.list(); } catch (e) { entries = []; }
        const signedIn = ctx.signedIn();
        let pending = inbox.pending;
        let filed = inbox.filed;
        if (signedIn) {
            try { pending = (await ctx.api('/api/shares?status=pending&limit=100')).shares || []; } catch (e) { /* keep what was shown */ }
            try { filed = (await ctx.api('/api/shares?status=filed&limit=20')).shares || []; } catch (e) { /* keep */ }
        } else {
            pending = [];
            filed = [];
        }
        inbox = { pending, filed, entries, loadedAt: Date.now() };
        ctx.onInboxCount(inboxCount());
        return inbox;
    }

    async function refreshInbox() {
        await loadInbox();
        if (inboxList && document.getElementById('inbox-sheet') && !document.getElementById('inbox-sheet').classList.contains('hidden')) drawInbox();
    }

    async function openInbox() {
        document.getElementById('inbox-sheet').classList.remove('hidden');
        drawInbox();
        await loadInbox();
        drawInbox();
    }

    function inboxRow({ url, title, sub, note, onOpen, actions = [] }) {
        return h('div', { class: 'inbox-row' },
            h('button', { type: 'button', class: 'inbox-open', onclick: onOpen },
                favicon(url || ''),
                h('span', { class: 'share-row-text' },
                    h('span', { class: 'share-row-name', text: title || url || '' }),
                    h('span', { class: 'share-row-path', text: sub || hostOf(url) }),
                    note ? h('span', { class: 'inbox-note', text: note }) : null)),
            actions);
    }

    function drawInbox() {
        if (!inboxList) return;
        clear(inboxList);
        const signedIn = ctx.signedIn();
        const c = ctx.copy();
        const paste = h('input', {
            id: 'inbox-paste', type: 'text', placeholder: 'Paste a link', autocomplete: 'off', spellcheck: 'false',
            onkeydown: (e) => { if (e.key === 'Enter') takePaste(e.target); },
            onpaste: (e) => {
                const text = (e.clipboardData || window.clipboardData || { getData: () => '' }).getData('text');
                if (text) { e.preventDefault(); e.target.value = text; takePaste(e.target); }
            }
        });
        inboxList.appendChild(h('div', { class: 'inbox-paste' }, paste));

        const waiting = waitingEntries();
        if (waiting.length) {
            inboxList.appendChild(h('div', { class: 'share-section', text: 'Waiting to upload' }));
            for (const { e, foreign } of waiting) {
                const why = !e.url ? 'No link — save it as a note or discard it'
                    : foreign ? (e.account && e.account.username ? `Shared as ${e.account.username}` : 'Shared while signed out')
                        : e.lastError ? `⏳ ${e.lastError.message}` : e.file ? `⏳ Will save to ${(e.file.labels || []).join(', ')}` : '⏳ Not uploaded yet';
                const actions = [];
                if (foreign && signedIn && e.url) {
                    actions.push(h('button', {
                        type: 'button', class: 'ghost', text: `Upload to ${ctx.username()}`,
                        onclick: async () => {
                            if (refusedSignedOut()) return;
                            // Into the inbox, where it shows under To file:
                            // new for this account, nothing of the last one's.
                            await ctx.outbox.update(e.sid, (x) => ({ ...S().claimEntry(x, ctx.account()), later: true }));
                            await ctx.flush([e.sid]).catch(() => null);
                            refreshInbox();
                        }
                    }));
                } else if (!foreign && e.url) {
                    actions.push(h('button', { type: 'button', class: 'ghost', text: 'Retry', onclick: async () => { await ctx.flush([e.sid]).catch(() => null); refreshInbox(); } }));
                }
                actions.push(h('button', {
                    type: 'button', class: 'ghost remove', title: 'Discard', text: '✕',
                    onclick: async () => {
                        if (refusedSignedOut()) return;
                        if (!confirm('Discard this share? It is not on the server, so it cannot be brought back.')) return;
                        await ctx.outbox.remove(e.sid);
                        refreshInbox();
                    }
                }));
                inboxList.appendChild(inboxRow({
                    url: e.url, title: e.title || e.text, sub: why,
                    onOpen: () => { hideInbox(); open(e); }, actions
                }));
            }
        }

        // The same link shared more than once is one row.
        const groups = new Map();
        const local = new Set(waiting.map(w => w.e.sid));
        for (const x of inbox.pending) {
            if (local.has(x.sid)) continue;
            const key = x.urlKey || x.url;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(x);
        }
        inboxList.appendChild(h('div', { class: 'share-section', text: 'To file' }));
        if (!signedIn) {
            inboxList.appendChild(h('p', { class: 'hint', text: 'Sign in to see your inbox.' }));
        } else if (!groups.size) {
            inboxList.appendChild(h('p', { class: 'hint', text: 'Nothing waiting. Share a link to TabPaladin from any app, or paste one above.' }));
        }
        for (const list of groups.values()) {
            const x = list[0];
            const holding = c.ready ? c.index.holding(x.urlKey || S().dedupeKey(x.url)) : [];
            const sub = [hostOf(x.url), list.length > 1 ? `shared ${list.length}×` : '',
                holding.length ? `Already in: ${holding.map(f => S().fullPath(f, c.index)).join(' · ')}` : ''].filter(Boolean).join(' · ');
            inboxList.appendChild(inboxRow({
                url: x.url, title: x.title || S().fallbackTitle(x.url, x.app), sub,
                note: x.note && /forced push/.test(x.note) ? `${x.note}: file again` : null,
                onOpen: () => { hideInbox(); open(entryFromShare(x)); },
                actions: [h('button', {
                    type: 'button', class: 'ghost remove', title: 'Remove from the inbox', text: '✕',
                    onclick: () => dismissShares(list)
                })]
            }));
        }

        const clip = signedIn ? ctx.clipboardLinks() : [];
        if (clip.length) {
            inboxList.appendChild(h('div', { class: 'share-section', text: 'From clipboard' }));
            for (const item of clip) {
                inboxList.appendChild(inboxRow({
                    url: item.url, title: item.title && item.title !== item.url ? item.title : hostOf(item.url) || item.url, sub: item.url,
                    onOpen: () => {
                        if (refusedSignedOut()) return;
                        hideInbox();
                        ctx.forgetClipboardLink(item.url);
                        openLink(item.url, 'clipboard');
                    },
                    actions: [h('button', {
                        type: 'button', class: 'ghost remove', title: 'Skip', text: '✕',
                        onclick: () => { if (refusedSignedOut()) return; ctx.dismissClipboardLink(item.url); drawInbox(); }
                    })]
                }));
            }
        }

        if (inbox.filed.length) {
            const details = h('details', { class: 'inbox-filed' }, h('summary', { class: 'share-section', text: `Recently filed (${inbox.filed.length})` }));
            const dayAgo = Date.now() - 24 * 3600 * 1000;
            for (const x of inbox.filed) {
                const where = (x.filings || []).map(f => f.folderTitle || 'a folder').join(', ');
                const gone = (x.filings || []).some(f => !f.present);
                const actions = [];
                if (Date.parse(x.filedAt) > dayAgo && (x.filings || []).length) {
                    actions.push(h('button', {
                        type: 'button', class: 'ghost', text: 'Undo',
                        onclick: async () => {
                            if (refusedSignedOut()) return;
                            try {
                                const res = await ctx.api(`/api/shares/${encodeURIComponent(x.sid)}/unfile`, { method: 'POST', body: asMe() });
                                ctx.applyUnfiled(res);
                                ctx.toast('Back in the inbox.');
                            } catch (e) { ctx.toast(`Couldn't undo: ${e.message}`); }
                            refreshInbox();
                        }
                    }));
                }
                details.appendChild(inboxRow({
                    url: x.url, title: x.title || x.url, sub: (where ? `→ ${where}` : x.note || '') + (gone ? ' · ⚠ no longer in your tree' : ''),
                    onOpen: () => { hideInbox(); open(entryFromShare(x)); }, actions
                }));
            }
            inboxList.appendChild(details);
        }
    }

    async function dismissShares(list) {
        if (refusedSignedOut()) return;
        try {
            for (const x of list) await ctx.api(`/api/shares/${encodeURIComponent(x.sid)}/dismiss`, { method: 'POST', body: asMe() });
        } catch (e) {
            ctx.toast(`Couldn't remove it: ${e.message}`);
            return;
        }
        inbox.pending = inbox.pending.filter(p => !list.includes(p));
        ctx.onInboxCount(inboxCount());
        drawInbox();
        ctx.toastUndo('Removed from the inbox.', async () => {
            for (const x of list) {
                try { await ctx.api(`/api/shares/${encodeURIComponent(x.sid)}/restore`, { method: 'POST', body: asMe() }); } catch (e) { /* stays dismissed */ }
            }
            refreshInbox();
        });
    }

    // Signed out, nothing in the Inbox acts: the lists are an account's, and
    // whoever holds the phone now may not be its owner.
    function refusedSignedOut() {
        if (ctx.signedIn()) return false;
        ctx.toast('Sign in first — links are filed into your account.');
        return true;
    }

    function takePaste(input) {
        let text = String(input.value || '').trim();
        if (!text) return;
        if (refusedSignedOut()) return;
        const x = S().extractShare({ text });
        if (!x.url) { ctx.toast('That is not a link.'); return; }
        input.value = '';
        hideInbox();
        openLink(x.url, 'paste', x.title !== S().fallbackTitle(x.url, x.app) ? x.title : '');
    }

    function hideInbox() {
        const el = document.getElementById('inbox-sheet');
        if (el) el.classList.add('hidden');
    }

    return {
        open, openForSid, openLink, close, isOpen, later, onKey,
        // Draw again with what the app has now. `reset`: the account changed,
        // so nothing drawn from the last one's copy or inbox may stay.
        refresh({ reset = false } = {}) {
            if (reset) inbox = { pending: [], filed: [], entries: inbox.entries, loadedAt: 0 };
            if (!s) return;
            if (reset) { s.chips = null; s.picker = null; s.view = 'main'; s.holding = []; s.queued.clear(); s.pending.clear(); }
            computeChips();
            render();
        },
        openInbox, refreshInbox, loadInbox, drawInbox, inboxCount, entryFromShare, onFlushed,
        // For the app: the open sheet's share id, if any.
        current: () => (s ? s.sid : null)
    };
}
