(() => {
    'use strict';
    const H = globalThis.TPHelper;
    const api = H.api;
    const SNAPSHOTS = 'tpHelperSnapshots';
    const RECENT = 'tpHelperRecentlyClosed';
    const MAX_URL = 8192;
    const LAST_TABS = 'tpHelperLastActiveTabs';
    // Long enough to pick tabs, name a workflow or drag a few groups on the
    // Board; every tab is still rechecked against the browser at close time.
    const SNAPSHOT_TTL = 60 * 60 * 1000;
    // Firefox can create a tab already unloaded (and titled), so it costs
    // nothing until it is clicked; Chrome needs the tab discarded once its
    // address has committed.
    const CREATE_DISCARDED = typeof browser !== 'undefined' && Boolean(api.runtime && api.runtime.getBrowserInfo);
    let lastNormalWindow = null;
    H.urlAllowed = value => {
        if (typeof value !== 'string' || !value || value.length > MAX_URL || /[\u0000-\u0020\\]/.test(value)) return false;
        try {
            const url = new URL(value);
            return !url.username && !url.password && (url.protocol === 'http:' || url.protocol === 'https:'
                || (url.protocol === 'file:' && (!url.hostname || url.hostname === 'localhost') && !/^\/{2}/.test(url.pathname)));
        } catch (_) { return false; }
    };
    H.isServer = (url, config) => { try { return new URL(url).origin === config.serverOrigin; } catch (_) { return false; } };
    const normal = win => win && win.type === 'normal' && !win.incognito;
    const getWindow = async id => { try { return await api.windows.get(id); } catch (_) { return null; } };
    const allowedTab = (tab, ctx) => tab && !tab.incognito && tab.id !== ctx.sender.tab.id
        && !H.isServer(tab.url, ctx.config) && H.urlAllowed(tab.url);
    // The same document: a page that only moved to another #fragment since
    // the snapshot (in-page navigation) is still the page that was saved.
    const samePage = (a, b) => {
        if (a === b) return true;
        try {
            const x = new URL(a), y = new URL(b);
            x.hash = ''; y.hash = '';
            return x.href === y.href;
        } catch (_) { return false; }
    };
    const view = tab => ({ tabId: tab.id, url: tab.url, title: String(tab.title || ''),
        pinned: Boolean(tab.pinned), active: Boolean(tab.active), index: tab.index, saveable: true });

    async function normalWindow(ctx, requested) {
        if (requested != null && (!Number.isInteger(requested) || requested < 0)) H.fail('bad-args', 'Invalid window.');
        const own = await getWindow(requested == null ? ctx.sender.tab.windowId : requested);
        if (normal(own)) return own;
        if (requested != null) H.fail('bad-args', 'Choose a normal, non-private browser window.');
        const recent = lastNormalWindow == null ? null : await getWindow(lastNormalWindow);
        if (normal(recent)) return recent;
        const all = await api.windows.getAll({ windowTypes: ['normal'] });
        const win = all.find(w => normal(w) && w.focused) || all.find(normal);
        if (!win) H.fail('bad-args', 'Open a normal browser window first.');
        return win;
    }
    H.normalWindow = normalWindow;
    if (api.windows.onFocusChanged) api.windows.onFocusChanged.addListener(id => {
        getWindow(id).then(win => { if (normal(win)) lastNormalWindow = win.id; }).catch(() => {});
    });

    H.handlers['tabs.listWindow'] = async (body, ctx) => {
        const win = await normalWindow(ctx, body.windowId);
        const tabs = (await api.tabs.query({ windowId: win.id })).filter(t => allowedTab(t, ctx));
        if (tabs.length > 500) H.fail('too-many', 'Select a window with at most 500 tabs.');
        return { windowId: win.id, type: win.type, tabs: tabs.map(view) };
    };
    H.handlers['windows.list'] = async (_body, ctx) => {
        const windows = await api.windows.getAll({ windowTypes: ['normal'], populate: true });
        return windows.filter(normal).map(win => {
            const tabs = (win.tabs || []).filter(t => allowedTab(t, ctx));
            return { windowId: win.id, type: win.type, tabCount: tabs.length,
                title: String((tabs.find(t => t.active) || {}).title || '').slice(0, 2000) };
        });
    };
    H.handlers['tabs.active'] = async (_body, ctx) => {
        const win = await normalWindow(ctx);
        const tabs = await api.tabs.query({ windowId: win.id, active: true });
        const tab = tabs.find(t => allowedTab(t, ctx));
        if (tab) return view(tab);
        // A web-app tab is active while its Pin button is clicked. Remember
        // the browser tab that was active just before the user selected it.
        const remembered = (await H.temporary.get(LAST_TABS))[LAST_TABS] || {};
        let previous;
        try { previous = await api.tabs.get(remembered[win.id]); } catch (_) { /* no previous tab */ }
        if (previous && previous.windowId === win.id && allowedTab(previous, ctx)) return view(previous);
        for (const other of await api.windows.getAll({ windowTypes: ['normal'] })) {
            if (!normal(other) || other.id === win.id) continue;
            const candidate = (await api.tabs.query({ windowId: other.id, active: true })).find(t => allowedTab(t, ctx));
            if (candidate) return view(candidate);
        }
        return null;
    };
    H.handlers['tabs.snapshot'] = async (body, ctx) => {
        if (body.purpose !== 'save-window' && body.purpose !== 'file') H.fail('bad-args', 'Invalid snapshot purpose.');
        const listed = await H.handlers['tabs.listWindow'](body, ctx);
        const snapshot = { ...listed, snapshotId: H.randomId(), purpose: body.purpose,
            scope: H.scope(ctx), until: Date.now() + SNAPSHOT_TTL };
        await H.serialized(async () => {
            await H.assertContext(ctx);
            const snapshots = (await H.temporary.get(SNAPSHOTS))[SNAPSHOTS] || {};
            for (const [id, value] of Object.entries(snapshots)) if (value.until < Date.now()) delete snapshots[id];
            if (Object.keys(snapshots).length >= 100) H.fail('too-many', 'Too many pending snapshots. Try again in five minutes.');
            snapshots[snapshot.snapshotId] = snapshot;
            await H.temporary.set({ [SNAPSHOTS]: snapshots });
        });
        return { snapshotId: snapshot.snapshotId, windowId: snapshot.windowId, tabs: snapshot.tabs };
    };

    H.handlers['tabs.closeSnapshot'] = (body, ctx) => H.serialized(async () => {
        await H.assertContext(ctx);
        const snapshots = (await H.temporary.get(SNAPSHOTS))[SNAPSHOTS] || {};
        const snapshot = snapshots[body.snapshotId];
        if (!snapshot || snapshot.scope !== H.scope(ctx) || snapshot.until < Date.now()) {
            H.fail('no-such-snapshot', 'This snapshot expired or belongs to another document. Take a fresh snapshot.');
        }
        if (!Array.isArray(body.tabIds) || body.tabIds.length > 500 || body.tabIds.some(id => !Number.isInteger(id))
            || new Set(body.tabIds).size !== body.tabIds.length || body.expectedCount !== body.tabIds.length) {
            H.fail('count-mismatch', 'Saved tab count does not match; all tabs were kept.');
        }
        if (body.tabIds.some(id => !snapshot.tabs.some(t => t.tabId === id))) H.fail('bad-args', 'A tab was not in this snapshot.');
        const kept = [], closed = [];
        const batchId = H.randomId();
        for (const id of body.tabIds) {
            const saved = snapshot.tabs.find(t => t.tabId === id);
            let tab;
            try { tab = await api.tabs.get(id); } catch (_) { kept.push({ tabId: id, reason: 'gone' }); continue; }
            let reason = null;
            if (id === ctx.sender.tab.id) reason = 'caller';
            else if (H.isServer(tab.url, ctx.config)) reason = 'server';
            else if (tab.incognito || !H.urlAllowed(tab.url) || !normal(await getWindow(tab.windowId))) reason = 'privileged';
            else if (!samePage(tab.url, saved.url) || tab.windowId !== snapshot.windowId) reason = 'navigated';
            else if (snapshot.purpose === 'file' && tab.pinned) reason = 'pinned';
            else if (snapshot.purpose === 'file' && tab.active) reason = 'active';
            if (reason) { kept.push({ tabId: id, reason }); continue; }
            const remaining = await api.tabs.query({ windowId: tab.windowId });
            if (remaining.length === 1) await api.tabs.create({ windowId: tab.windowId, url: 'about:blank', active: false });
            // Save the recovery record before closing. A full disk keeps tabs.
            const recent = ((await api.storage.local.get(RECENT))[RECENT] || [])
                .filter(e => e.at > Date.now() - 24 * 60 * 60 * 1000);
            recent.push({ url: tab.url, title: String(tab.title || '').slice(0, 2000), windowId: tab.windowId,
                at: Date.now(), batchId, origin: ctx.config.serverOrigin, pinScope: H.pinScope(ctx.config) });
            await api.storage.local.set({ [RECENT]: recent.slice(-500) });
            await H.assertContext(ctx);
            // Recheck after the recovery write: navigation during a slow
            // storage operation must leave the new page open.
            let current;
            try { current = await api.tabs.get(id); } catch (_) { kept.push({ tabId: id, reason: 'gone' }); continue; }
            if (!samePage(current.url, tab.url) || current.incognito || current.windowId !== tab.windowId) {
                kept.push({ tabId: id, reason: 'navigated' }); continue;
            }
            if (snapshot.purpose === 'file' && (current.pinned || current.active)) {
                kept.push({ tabId: id, reason: current.pinned ? 'pinned' : 'active' }); continue;
            }
            try { await api.tabs.remove(id); closed.push(id); }
            catch (_) { kept.push({ tabId: id, reason: 'gone' }); }
        }
        delete snapshots[body.snapshotId];
        await H.temporary.set({ [SNAPSHOTS]: snapshots });
        return { closed, kept };
    });

    function checkedUrls(urls) {
        if (!Array.isArray(urls) || !urls.length) H.fail('bad-args', 'At least one URL is required.');
        if (urls.length > 500) H.fail('too-many', 'At most 500 URLs can be opened at once.');
        if (urls.some(url => !H.urlAllowed(url))) H.fail('invalid-url', 'Only web addresses and local file URLs can be opened.');
        return urls;
    }

    // Opening a workflow or "Open All" creates every tab, but only the window's
    // first tab loads; the rest stay asleep until they are clicked, so dozens
    // of tabs do not all load at once.
    async function createSleeping(windowId, item) {
        if (CREATE_DISCARDED) {
            try {
                return await api.tabs.create({ windowId, url: item.url, active: false, discarded: true,
                    ...(item.title ? { title: String(item.title).slice(0, 300) } : {}) });
            } catch (_) { /* an older Firefox: create it awake below */ }
        }
        const tab = await api.tabs.create({ windowId, url: item.url, active: false });
        discardOnceCommitted(tab.id);
        return tab;
    }

    // Chrome cannot create a tab discarded; discarding before its address has
    // committed can leave it blank, so wait for the first update that carries
    // the real URL. A tab the user switches to in the meantime just loads.
    function discardOnceCommitted(tabId) {
        if (!api.tabs.discard || !api.tabs.onUpdated) return;
        let done = false;
        const stop = () => { done = true; api.tabs.onUpdated.removeListener(onUpdated); clearTimeout(timer); };
        const attempt = async tab => {
            if (done || !tab) return;
            if (tab.active) { stop(); return; }
            if (!tab.url || tab.url === 'about:blank' || !H.urlAllowed(tab.url)) return;
            stop();
            let slept = null;
            try { slept = await api.tabs.discard(tabId); } catch (_) { return; /* it loads normally */ }
            // Some Chrome versions give a discarded tab a new id; keep its
            // workflow tracking pointing at the tab that is really there.
            if (slept && Number.isInteger(slept.id) && slept.id !== tabId) {
                await H.serialized(async () => {
                    const map = await H.getTrackMap();
                    if (map[tabId]) { map[slept.id] = map[tabId]; delete map[tabId]; await H.setTrackMap(map); }
                }).catch(() => {});
            }
        };
        const onUpdated = (id, info, tab) => { if (id === tabId && (info.url || info.status)) attempt(tab); };
        api.tabs.onUpdated.addListener(onUpdated);
        const timer = setTimeout(stop, 30000);
        api.tabs.get(tabId).then(attempt).catch(stop);
    }

    async function openItems(items, mode, ctx, tracking) {
        checkedUrls(items.map(item => item.url));
        let win = mode === 'new-window' ? null : await normalWindow(ctx);
        const opened = [], failed = [];
        for (const item of items) {
            await H.assertContext(ctx);
            let tab;
            try {
                if (!win) {
                    win = await api.windows.create({ url: item.url, type: 'normal', incognito: false });
                    if (!normal(win)) H.fail('bad-args', 'A private or app window cannot be used.');
                    tab = (win.tabs || [])[0] || (await api.tabs.query({ windowId: win.id }))[0];
                } else tab = await createSleeping(win.id, item);
                if (!tab || tab.incognito || !Number.isInteger(tab.id)) throw new Error('The browser did not return a tab.');
                if (tracking) {
                    const map = await H.getTrackMap();
                    map[tab.id] = { workflowId: tracking.workflowId, bookmarkId: item.bookmarkId, url: item.url,
                        account: tracking.account, origin: ctx.config.serverOrigin, pinScope: H.pinScope(ctx.config),
                        target: 'web', at: Date.now() };
                    await H.setTrackMap(map);
                }
                opened.push({ tabId: tab.id, ...(tracking ? { bookmarkId: item.bookmarkId } : {}) });
            } catch (error) { failed.push({ ...(tracking ? { bookmarkId: item.bookmarkId } : {}), url: item.url, error: error.message }); }
        }
        return { windowId: win && win.id, opened, failed };
    }
    H.handlers['windows.openWorkflow'] = (body, ctx) => H.serialized(async () => {
        await H.assertContext(ctx);
        const account = H.account(body.account, ctx.config);
        if (typeof body.workflowId !== 'string' || !body.workflowId || body.workflowId.length > 200
            || !['new-window', 'current'].includes(body.target) || !Array.isArray(body.items)
            || body.items.some(i => !i || typeof i.bookmarkId !== 'string' || !i.bookmarkId || i.bookmarkId.length > 200)
            || new Set(body.items.map(i => i.bookmarkId)).size !== body.items.length) H.fail('bad-args', 'Invalid workflow.');
        return openItems(body.items, body.target, ctx, { workflowId: body.workflowId, account });
    });
    H.handlers['windows.openUrls'] = (body, ctx) => H.serialized(async () => {
        await H.assertContext(ctx);
        if (!['new-window', 'background'].includes(body.mode)) H.fail('bad-args', 'Invalid opening mode.');
        checkedUrls(body.urls);
        return openItems(body.urls.map(url => ({ url })), body.mode, ctx, null);
    });
    H.reopenClosed = () => H.serialized(async () => {
        const config = await H.getConfig();
        if (!config.enabled || !config.pin) H.fail('not-configured', 'Reconnect the helper before reopening its closed tabs.');
        const all = ((await api.storage.local.get(RECENT))[RECENT] || []).filter(e => e.at > Date.now() - 24 * 60 * 60 * 1000);
        const own = all.filter(e => e.origin === config.serverOrigin && e.pinScope === H.pinScope(config));
        if (!own.length) return { opened: [] };
        const batch = own[own.length - 1].batchId;
        const opened = [];
        for (const entry of own.filter(e => e.batchId === batch && H.urlAllowed(e.url))) {
            // This is an extension-menu/options action, never a web-page read.
            const win = await getWindow(entry.windowId);
            const tab = await api.tabs.create({ url: entry.url, ...(normal(win) ? { windowId: win.id } : {}) });
            opened.push(tab.id);
        }
        await api.storage.local.set({ [RECENT]: all.filter(e => e.batchId !== batch) });
        return { opened };
    });
    H.ops.push('tabs.listWindow', 'windows.list', 'tabs.active', 'tabs.snapshot', 'tabs.closeSnapshot', 'windows.openWorkflow', 'windows.openUrls');
    H.handleOp = (op, body, ctx) => {
        if (!H.handlers[op]) H.fail('unsupported-op', 'This helper does not support that operation.');
        return H.handlers[op](body || {}, ctx);
    };

    const changedTimers = new Map();
    const changed = windowId => {
        clearTimeout(changedTimers.get(windowId));
        changedTimers.set(windowId, setTimeout(async () => {
            changedTimers.delete(windowId);
            if (!H.attached || !H.sendEvent) return;
            for (const [tabId, a] of H.attached) {
                if (!a.visible) continue;
                try {
                    const tab = await api.tabs.get(tabId);
                    const win = await getWindow(tab.windowId);
                    if (tab.windowId === windowId && tab.active && !tab.incognito && win && win.focused && !win.incognito) {
                        await H.sendEvent(tabId, 'tabs.changed', { windowId });
                    }
                } catch (_) { /* the receiver closed */ }
            }
        }, 300));
    };
    if (api.tabs.onCreated) api.tabs.onCreated.addListener(t => { if (!t.incognito) changed(t.windowId); });
    if (api.tabs.onUpdated) api.tabs.onUpdated.addListener((_id, _info, tab) => { if (!tab.incognito) changed(tab.windowId); });
    const rememberActive = tab => H.serialized(async () => {
        if (!tab || !Number.isInteger(tab.id) || !tab.active || tab.incognito || !H.urlAllowed(tab.url)) return;
        const config = await H.getConfig();
        if (H.isServer(tab.url, config) || !normal(await getWindow(tab.windowId))) return;
        const remembered = (await H.temporary.get(LAST_TABS))[LAST_TABS] || {};
        remembered[tab.windowId] = tab.id;
        await H.temporary.set({ [LAST_TABS]: remembered });
    });
    if (api.tabs.onActivated) api.tabs.onActivated.addListener(info => {
        changed(info.windowId);
        api.tabs.get(info.tabId).then(rememberActive).catch(() => {});
    });
    api.tabs.query({ active: true }).then(tabs => Promise.all(tabs.map(rememberActive))).catch(() => {});
    api.tabs.onRemoved.addListener((_id, info) => changed(info.windowId));
})();
