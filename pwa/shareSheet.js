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
//   applyUnfiled(result)
//   prefs: {get() -> value|null, update(fn) -> Promise}    the 'share' pref
//   stats() -> {apps} | null
//   clipboardLinks() -> [{url,title}], forgetClipboardLink(url)
//   toast(msg), openSettings(), saveAsNote(text), openFolder(folderId),
//   done({label}), onClose(), onInboxCount(n), isDesktop(), newId()
// }
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
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
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
            pending: new Set(), queued: new Set(), failed: new Map(),
            lastLabels: [], message: null, picker: null, menu: null
        };
        (s.share && s.share.filings || []).forEach(f => s.saved.set(f.folderId, { bookmarkId: f.bookmarkId, already: true, label: f.folderTitle || '' }));
        root.classList.remove('hidden');
        document.body.classList.add('share-open');
        computeChips();
        render();
        // The worker uploads a share as it arrives; a pasted link, or one
        // shared while the worker was not in charge, goes up from here.
        if (entry.url && accountOk() && !entry.uploaded) upload();
        else if (accountOk() && entry.uploaded) watchArchived();
        return true;
    }

    async function upload() {
        const sid = s.sid;
        let res = null;
        try { res = await ctx.flush([sid]); } catch (e) { /* stays in the outbox */ }
        if (!s || s.sid !== sid) return;
        const e = await ctx.outbox.get(sid).catch(() => null);
        if (e) { s.entry = e; if (e.share) s.share = e.share; }
        if (res && res.stopped === 'network') s.offline = true;
        render();
    }

    function watchArchived() { /* the share came with its status; nothing to fetch */ }

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
    // without a yes.
    async function claim() {
        const account = ctx.account();
        if (!account) return;
        const e = await ctx.outbox.update(s.sid, (c) => ({ ...c, account }));
        if (e) s.entry = e;
        else s.entry = { ...s.entry, account };
        render();
        if (s.entry.url) upload();
    }

    async function discard() {
        if (!confirm('Discard what you shared? It is not kept anywhere else.')) return;
        await ctx.outbox.remove(s.sid).catch(() => {});
        if (s.share && accountOk()) {
            try { await ctx.api(`/api/shares/${encodeURIComponent(ref())}/dismiss`, { method: 'POST', body: '{}' }); } catch (e) { /* kept dismissed locally */ }
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

    async function file(targets, labels) {
        if (!s || !accountOk()) return;
        const c = ctx.copy();
        const body = { targets: [], folders: [] };
        const keys = [];
        for (const t of targets) {
            if (t.folderId && c.ready && !c.serverIds.has(t.folderId)) {
                const chain = localChain(t.folderId, c);
                if (!chain || !chain.length) {
                    s.failed.set(t.folderId, 'unpushed');
                    continue;
                }
                for (const f of chain.slice(0, -1)) if (!body.folders.some(x => x.id === f.id)) body.folders.push(f);
                body.targets.push({ newFolder: chain[chain.length - 1], existing: true });
                keys.push(t.folderId);
            } else {
                body.targets.push(t);
                keys.push(t.folderId || (t.newFolder && t.newFolder.id));
            }
        }
        if (!body.targets.length) { render(); return; }
        keys.forEach(k => { s.pending.add(k); s.failed.delete(k); });
        s.message = null;
        render();
        const intent = { targets: body.targets, folders: body.folders, title: s.title || undefined, labels, at: new Date().toISOString() };
        const sid = s.sid;
        let entry = await ctx.outbox.update(sid, (e) => ({ ...e, file: intent, later: false })).catch(() => null);
        if (!entry) {
            // Filed once already from this sheet, so it left the outbox: back
            // in, as the uploaded share it is, with this choice.
            entry = await ctx.outbox.put({ ...s.entry, uploaded: Boolean(s.share) || s.entry.uploaded, share: s.share, file: intent, later: false }).catch(() => null);
        }
        let res = null;
        try { res = await ctx.flush([sid]); } catch (e) { res = null; }
        if (!s || s.sid !== sid) return;
        keys.forEach(k => s.pending.delete(k));
        const done = res && res.filed.find(f => f.sid === sid);
        if (done) {
            const r = done.result;
            s.share = r.share || s.share;
            const savedLabels = [];
            for (const n of r.created || []) {
                if (n.kind !== 'bookmark') continue;
                const key = keys.find(k => k === n.parentId) || n.parentId;
                const name = (c.ready && c.index.folders.get(n.parentId) && c.index.folders.get(n.parentId).title) || labelFor(body.targets, n.parentId);
                s.saved.set(key, { bookmarkId: n.id, already: false, label: name });
                savedLabels.push(name);
            }
            for (const a of r.already || []) {
                if (!s.saved.has(a.folderId)) s.saved.set(a.folderId, { bookmarkId: a.bookmarkId, already: true, label: labelFor(body.targets, a.folderId) });
            }
            for (const f of r.failed || []) s.failed.set(f.folderId || f.newFolderId, f.reason);
            if (savedLabels.length) {
                s.lastLabels = savedLabels;
                if (navigator.vibrate) { try { navigator.vibrate(15); } catch (e) { /* not on this device */ } }
            }
            s.message = failedMessage(r.failed || [], savedLabels.length);
            s.queued.clear();
        } else {
            const e = await ctx.outbox.get(sid).catch(() => null);
            if (e && e.lastError && e.lastError.failed) {
                for (const f of e.lastError.failed) s.failed.set(f.folderId || f.newFolderId, f.reason);
                s.message = failedMessage(e.lastError.failed, 0);
            } else if (e && e.file) {
                keys.forEach(k => s.queued.add(k));
                s.offline = true;
                ctx.registerSync();
            } else if (e && e.lastError) {
                s.message = `Couldn't save: ${e.lastError.message}`;
            }
        }
        render();
        refreshInbox();
    }

    function labelFor(targets, folderId) {
        const t = targets.find(x => (x.folderId || (x.newFolder && x.newFolder.id)) === folderId);
        return (t && t.newFolder && t.newFolder.title) || folderId;
    }

    function failedMessage(failed, savedCount) {
        if (!failed.length) return null;
        const c = ctx.copy();
        const names = failed.map(f => {
            const id = f.folderId || f.newFolderId;
            const folder = c.ready ? c.index.folders.get(id) : null;
            const why = f.reason === 'missing' ? 'deleted on another device'
                : f.reason === 'read-only' ? 'not a bookmark folder'
                    : f.reason === 'conflict' ? 'a different folder has that id' : f.reason;
            return `${folder ? folder.title : 'a folder'} (${why})`;
        });
        return `Couldn't save to ${names.join(', ')}.` + (savedCount ? ` Saved to the other ${savedCount}.` : '');
    }

    async function undo() {
        if (!s) return;
        const folderIds = [...s.saved.entries()].filter(([, v]) => !v.already).map(([k]) => k);
        if (!folderIds.length) return;
        try {
            const res = await ctx.api(`/api/shares/${encodeURIComponent(ref())}/unfile`, { method: 'POST', body: JSON.stringify({ folderIds }) });
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

    function done() {
        if (!s) return;
        const labels = [...s.saved.values()].filter(v => !v.already).map(v => v.label);
        const fromShare = s.fromShare;
        close();
        ctx.done({ label: labels.length ? labels.join(', ') : '', fromShare });
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

    function render() {
        if (!s) return;
        // Where the link is in the copy now: filings and undos change it.
        const c = ctx.copy();
        s.holding = c.ready && s.urlKey ? c.index.holding(s.urlKey).map(f => f.id) : [];
        clear(root);
        if (s.view === 'picker') return renderPicker();
        if (s.view === 'edit') return renderEdit();
        renderMain();
    }

    function header(title, { back = null, closeAs = 'Later' } = {}) {
        return h('div', { class: 'sheet-header share-header' },
            back ? h('button', { class: 'ghost share-back', type: 'button', title: 'Back', onclick: back, text: '←' }) : null,
            h('strong', { id: 'share-title', text: title }),
            h('button', { class: 'ghost share-close', type: 'button', title: closeAs, 'aria-label': closeAs, onclick: () => later(), text: '✕' }));
    }

    function linkCard() {
        const titleInput = h('input', {
            class: 'share-title-input', type: 'text', value: s.title, placeholder: 'Title', 'aria-label': 'Title',
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
            const grid = h('div', { class: 'share-chips', role: 'list' });
            if (s.starter && !savedCount()) grid.appendChild(starterChip());
            (s.chips || []).forEach((chip, i) => grid.appendChild(chipEl(chip, i, c)));
            body.appendChild(grid);
        }
        if (s.queued.size) {
            const names = [...s.queued].map(id => (c.ready && c.index.folders.get(id) ? c.index.folders.get(id).title : 'the new folder'));
            body.appendChild(h('p', { class: 'share-offline', text: `Will save to ${names.join(', ')} when you're back online.` }));
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

    function starterChip() {
        const st = s.starter;
        const text = st.kind === 'app-folder' ? `+ New "${st.title}" folder` : '+ New folder…';
        return h('button', {
            class: 'share-chip share-chip-new', type: 'button', role: 'listitem',
            onclick: () => {
                if (st.kind === 'app-folder' && st.parentId) {
                    const id = ctx.newId();
                    file([{ newFolder: { id, title: st.title, parentId: st.parentId } }], [st.title]);
                } else {
                    openPicker({ create: true });
                }
            }
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

    function saveAsNote() {
        const text = [s.entry.fields.title, s.entry.text].filter(Boolean).join('\n\n');
        const sid = s.sid;
        close();
        ctx.outbox.remove(sid).catch(() => {});
        ctx.saveAsNote(text);
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
        const n = Number(e.key);
        if (Number.isInteger(n) && n >= 1 && n <= 8 && s.chips && s.chips[n - 1]) {
            e.preventDefault();
            const chip = s.chips[n - 1];
            const f = ctx.copy().ready && ctx.copy().index.folders.get(chip.folderId);
            if (f && !s.saved.has(chip.folderId)) file([{ folderId: chip.folderId }], [f.title]);
            return true;
        }
        if (e.key === 'Enter' && savedCount()) { e.preventDefault(); done(); return true; }
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

    function inboxCount() {
        const mine = inbox.entries.filter(e => !e.uploaded || e.file || (e.lastError && e.lastError.permanent) || !e.url);
        const sids = new Set(inbox.entries.map(e => e.sid));
        return inbox.pending.filter(x => !sids.has(x.sid)).length + mine.length;
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
        const me = ctx.account();
        const paste = h('input', {
            id: 'inbox-paste', type: 'text', placeholder: 'Paste a link', autocomplete: 'off', spellcheck: 'false',
            onkeydown: (e) => { if (e.key === 'Enter') takePaste(e.target); },
            onpaste: (e) => {
                const text = (e.clipboardData || window.clipboardData || { getData: () => '' }).getData('text');
                if (text) { e.preventDefault(); e.target.value = text; takePaste(e.target); }
            }
        });
        inboxList.appendChild(h('div', { class: 'inbox-paste' }, paste));

        const theirs = (e) => !me || !S().sameAccount(e.account, { ...me, token: 'x' });
        const waiting = inbox.entries.filter(e => !e.url || !e.uploaded || e.file || (e.lastError && e.lastError.permanent) || theirs(e));
        if (waiting.length) {
            inboxList.appendChild(h('div', { class: 'share-section', text: 'Waiting to upload' }));
            for (const e of waiting) {
                const foreign = theirs(e);
                const why = !e.url ? 'No link — save it as a note or discard it'
                    : foreign ? (e.account && e.account.username ? `Shared as ${e.account.username}` : 'Shared while signed out')
                        : e.lastError ? `⏳ ${e.lastError.message}` : e.file ? `⏳ Will save to ${(e.file.labels || []).join(', ')}` : '⏳ Not uploaded yet';
                const actions = [];
                if (foreign && signedIn && e.url) {
                    actions.push(h('button', {
                        type: 'button', class: 'ghost', text: `Upload to ${ctx.username()}`,
                        onclick: async () => {
                            if (refusedSignedOut()) return;
                            // Into the inbox, where it shows under To file.
                            await ctx.outbox.update(e.sid, (x) => ({ ...x, account: ctx.account(), later: true }));
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
        const local = new Set(waiting.map(e => e.sid));
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
                                const res = await ctx.api(`/api/shares/${encodeURIComponent(x.sid)}/unfile`, { method: 'POST', body: '{}' });
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
            for (const x of list) await ctx.api(`/api/shares/${encodeURIComponent(x.sid)}/dismiss`, { method: 'POST', body: '{}' });
        } catch (e) {
            ctx.toast(`Couldn't remove it: ${e.message}`);
            return;
        }
        inbox.pending = inbox.pending.filter(p => !list.includes(p));
        ctx.onInboxCount(inboxCount());
        drawInbox();
        ctx.toastUndo('Removed from the inbox.', async () => {
            for (const x of list) {
                try { await ctx.api(`/api/shares/${encodeURIComponent(x.sid)}/restore`, { method: 'POST', body: '{}' }); } catch (e) { /* stays dismissed */ }
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
        openInbox, refreshInbox, loadInbox, drawInbox, inboxCount, entryFromShare,
        // For the app: the open sheet's share id, if any.
        current: () => (s ? s.sid : null)
    };
}
