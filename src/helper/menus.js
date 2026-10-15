(() => {
    'use strict';
    const H = globalThis.TPHelper;
    const api = H.api;
    const ACTIONS = 'tpHelperPendingActions';
    const BOOKMARKS = 'tpBrowserBookmarks';
    const routes = new Set(['', '#/signin', '#/workflows/save', '#/import-browser']);

    H.openWebApp = async (hash = '', { requireBridge = false } = {}) => {
        if (!routes.has(hash)) H.fail('bad-args', 'Unknown TabPaladin page.');
        const config = await H.getConfig();
        if (!config || !config.serverOrigin || !config.pin || requireBridge && !config.enabled) {
            await api.runtime.openOptionsPage();
            H.fail('not-configured', 'Connect your server in Settings first.');
        }
        if (!await api.permissions.contains({ origins: [config.pattern] })) H.fail('permission-missing', 'Reconnect the helper in Settings to grant server access.');
        await H.verifyIdentity(config);
        if (config.enabled && !await H.ensureBridge()) H.fail('not-configured', 'Reconnect the helper in Settings first.');
        const assertCurrent = async () => {
            const current = await H.getConfig();
            if (requireBridge && !current.enabled || !current.pin || H.pinScope(current) !== H.pinScope(config)) {
                H.fail('not-configured', 'The helper connection changed. Reconnect in Settings.');
            }
        };
        const all = await api.tabs.query({});
        const eligible = [];
        for (const tab of all) {
            if (tab.incognito || !H.isServer(tab.url, config)) continue;
            try {
                const url = new URL(tab.url);
                const win = await api.windows.get(tab.windowId);
                if (url.pathname === '/' && win.type === 'normal' && !win.incognito) eligible.push({ tab, win });
            } catch (_) { /* no longer open */ }
        }
        const match = eligible.find(e => e.win.focused) || eligible[0];
        if (match) {
            await assertCurrent();
            const props = { active: true };
            if (hash) props.url = config.serverOrigin + '/' + hash;
            const tab = await api.tabs.update(match.tab.id, props);
            await api.windows.update(match.tab.windowId, { focused: true });
            return tab && Number.isInteger(tab.id) ? tab : match.tab;
        }
        const win = (await api.windows.getAll({ windowTypes: ['normal'] })).find(w => !w.incognito && w.focused)
            || (await api.windows.getAll({ windowTypes: ['normal'] })).find(w => !w.incognito);
        if (!win) {
            await assertCurrent();
            const opened = await api.windows.create({ url: config.serverOrigin + '/' + hash, type: 'normal', incognito: false });
            return (opened.tabs || [])[0] || (await api.tabs.query({ windowId: opened.id }))[0];
        }
        await assertCurrent();
        return api.tabs.create({ windowId: win.id, url: config.serverOrigin + '/' + hash, active: true });
    };

    function sameDestination(value, ctx) {
        return value && value.until > Date.now() && value.forTabId === ctx.sender.tab.id
            && value.pinScope === H.pinScope(ctx.config) && (!value.scope || value.scope === H.scope(ctx));
    }
    async function notify(tabId, event) { if (H.sendEvent) await H.sendEvent(tabId, event, {}).catch(() => {}); }
    function attachedScope(tabId, config) {
        const attached = H.attached && H.attached.get(tabId);
        return attached && attached.origin === config.serverOrigin
            ? H.scope({ config, sender: { tab: { id: tabId } }, documentKey: attached.documentKey }) : null;
    }
    H.stageSave = async clickedTab => {
        if (!clickedTab) clickedTab = (await api.tabs.query({ active: true, lastFocusedWindow: true }))[0];
        if (!clickedTab || clickedTab.incognito || !Number.isInteger(clickedTab.windowId)) H.fail('bad-args', 'Choose a normal browser window.');
        const win = await api.windows.get(clickedTab.windowId);
        if (win.incognito || win.type !== 'normal') H.fail('bad-args', 'Choose a normal browser window.');
        const tab = await H.openWebApp('#/workflows/save', { requireBridge: true });
        const config = await H.getConfig();
        const action = { actionId: H.randomId(), windowId: win.id, at: Date.now(), until: Date.now() + 2 * 60 * 1000,
            forTabId: tab.id, origin: config.serverOrigin, pinScope: H.pinScope(config), scope: attachedScope(tab.id, config) };
        await H.serialized(async () => {
            const actions = ((await H.temporary.get(ACTIONS))[ACTIONS] || []).filter(a => a.until > Date.now());
            if (actions.length >= 20) H.fail('too-many', 'Finish the pending saves first.');
            actions.push(action);
            await H.temporary.set({ [ACTIONS]: actions });
        });
        await notify(tab.id, 'action.pending');
        return { actionId: action.actionId };
    };

    H.handlers['actions.take'] = (_body, ctx) => H.serialized(async () => {
        await H.assertContext(ctx);
        const actions = ((await H.temporary.get(ACTIONS))[ACTIONS] || []).filter(a => a.until > Date.now());
        const own = actions.filter(a => sameDestination(a, ctx));
        own.forEach(a => { a.scope = H.scope(ctx); a.issued = true; });
        await H.temporary.set({ [ACTIONS]: actions });
        return own.map(a => ({ actionId: a.actionId, windowId: a.windowId, at: a.at, type: 'save-window' }));
    });
    H.handlers['actions.done'] = (body, ctx) => H.serialized(async () => {
        await H.assertContext(ctx);
        const ids = body.actionIds || [body.actionId];
        if (!Array.isArray(ids) || !ids.length || ids.length > 20 || ids.some(id => typeof id !== 'string')) H.fail('bad-args', 'Expected save-request ids.');
        const actions = (await H.temporary.get(ACTIONS))[ACTIONS] || [];
        for (const id of ids) {
            const action = actions.find(a => a.actionId === id);
            if (!sameDestination(action, ctx) || action.scope !== H.scope(ctx) || !action.issued) H.fail('bad-args', 'This save request was not delivered to this document.');
        }
        await H.temporary.set({ [ACTIONS]: actions.filter(a => !ids.includes(a.actionId)) });
        return { acknowledged: true };
    });

    // Called only by the extension options page after its one getTree read.
    // Copy typed browser fields: arbitrary objects/credentials are not staged.
    function cleanTree(tree) {
        let count = 0;
        const clean = (node, depth) => {
            if (!node || depth > 100 || ++count > 100000) H.fail('too-large', 'The bookmark tree is too large. Export an HTML file instead.');
            if (String(node.title || '').length > 4096 || typeof node.url === 'string' && node.url.length > 8192) {
                H.fail('too-large', 'A bookmark is too long for the bridge. Export an HTML file instead.');
            }
            const out = { id: String(node.id || '').slice(0, 200), title: String(node.title || '') };
            if (['folder', 'bookmark', 'separator'].includes(node.type)) out.type = node.type;
            if (typeof node.url === 'string') out.url = node.url;
            if (Array.isArray(node.children)) out.children = node.children.map(child => clean(child, depth + 1));
            return out;
        };
        if (!Array.isArray(tree)) H.fail('bad-args', 'Expected a browser bookmark tree.');
        const result = tree.map(node => clean(node, 0));
        if (JSON.stringify(result).length > 750000) H.fail('too-large', 'The bookmark tree is too large for the bridge. Export an HTML file instead.');
        return result;
    }
    H.stageBookmarks = async (tree, browserName = 'Browser') => {
        const cleaned = cleanTree(tree);
        const tab = await H.openWebApp('#/import-browser', { requireBridge: true });
        const config = await H.getConfig();
        const stage = { stageId: H.randomId(), tree: cleaned, browser: String(browserName || 'Browser').slice(0, 80),
            stagedAt: Date.now(), until: Date.now() + 10 * 60 * 1000, forTabId: tab.id,
            pinScope: H.pinScope(config), origin: config.serverOrigin, scope: attachedScope(tab.id, config) };
        await H.serialized(() => H.temporary.set({ [BOOKMARKS]: stage }));
        await notify(tab.id, 'bookmarks.staged');
        return { stageId: stage.stageId, forTabId: tab.id };
    };
    H.handlers['bookmarks.take'] = (_body, ctx) => H.serialized(async () => {
        await H.assertContext(ctx);
        const stage = (await H.temporary.get(BOOKMARKS))[BOOKMARKS];
        if (stage && stage.until < Date.now()) await H.temporary.remove(BOOKMARKS);
        if (!sameDestination(stage, ctx)) return null;
        stage.scope = H.scope(ctx);
        stage.issued = true;
        await H.temporary.set({ [BOOKMARKS]: stage });
        return { stageId: stage.stageId, tree: stage.tree, browser: stage.browser, stagedAt: stage.stagedAt };
    });
    H.handlers['bookmarks.ack'] = (body, ctx) => H.serialized(async () => {
        await H.assertContext(ctx);
        const stage = (await H.temporary.get(BOOKMARKS))[BOOKMARKS];
        if (!sameDestination(stage, ctx) || !stage.issued || stage.scope !== H.scope(ctx) || body.stageId !== stage.stageId) {
            H.fail('bad-args', 'This bookmark import was not delivered to this document.');
        }
        await H.temporary.remove(BOOKMARKS);
        return { acknowledged: true };
    });
    // The first attached document in a freshly opened target tab owns the
    // handoff, even if it reloads before the user presses Import or Save.
    H.bindDelivery = ctx => H.serialized(async () => {
        const data = await H.temporary.get([ACTIONS, BOOKMARKS]);
        const actions = (data[ACTIONS] || []).filter(a => a.until > Date.now());
        for (const action of actions) if (!action.scope && sameDestination(action, ctx)) action.scope = H.scope(ctx);
        const stage = data[BOOKMARKS];
        if (stage && !stage.scope && sameDestination(stage, ctx)) stage.scope = H.scope(ctx);
        await H.temporary.set({ [ACTIONS]: actions, ...(stage && stage.until > Date.now() ? { [BOOKMARKS]: stage } : {}) });
        if (stage && stage.until <= Date.now()) await H.temporary.remove(BOOKMARKS);
    });
    H.pendingFor = async ctx => {
        const [local, temp] = await Promise.all([api.storage.local.get('tpHelperRemovals'), H.temporary.get([ACTIONS, BOOKMARKS])]);
        return {
            removals: (local.tpHelperRemovals || []).filter(e => e.pinScope === H.pinScope(ctx.config)).length,
            actions: (temp[ACTIONS] || []).filter(a => sameDestination(a, ctx)).length,
            bookmarksStaged: sameDestination(temp[BOOKMARKS], ctx)
        };
    };

    H.handleOptions = async (op, body = {}) => {
        if (op === 'open') { const tab = await H.openWebApp(body.hash || ''); return { tabId: tab.id }; }
        if (op === 'reopen') return H.reopenClosed();
        if (op === 'stageBookmarks') return H.stageBookmarks(body.tree, body.browser);
        if (op === 'stopTracking') return H.serialized(async () => {
            // Explicit extension Settings action; queued work is preserved.
            await H.setTrackMap({});
            return { stopped: true };
        });
        if (op === 'policy') {
            if (!['keep', 'remove'].includes(body.windowClosePolicy)) H.fail('bad-args', 'Invalid window-close policy.');
            return H.serialized(async () => {
                const config = await H.getConfig();
                config.windowClosePolicy = body.windowClosePolicy;
                await api.storage.local.set({ tpHelper: config });
                return { windowClosePolicy: config.windowClosePolicy };
            });
        }
        H.fail('unsupported-op', 'Unknown helper setting.');
    };
    H.ops.push('actions.take', 'actions.done', 'bookmarks.take', 'bookmarks.ack');
    if (api.runtime.onStartup) api.runtime.onStartup.addListener(() => {
        H.serialized(() => H.temporary.remove([ACTIONS, BOOKMARKS, 'tpHelperSnapshots', 'tpHelperRemovalReceipts', 'tpHelperLastActiveTabs'])).catch(() => {});
    });

    const menus = api.contextMenus || api.menus;
    if (!menus) return;
    const context = api.action ? 'action' : 'browser_action';
    const install = async () => {
        await menus.removeAll();
        for (const [id, title] of [['tp-helper-open', 'Open TabPaladin'],
            ['tp-helper-save', 'Save this window\'s tabs as a workflow…'],
            ['tp-helper-reopen', 'Reopen tabs TabPaladin closed'], ['tp-helper-settings', 'Settings']]) {
            menus.create({ id, title, contexts: [context] });
        }
    };
    api.runtime.onInstalled.addListener(() => install().catch(() => {}));
    if (api.runtime.onStartup) api.runtime.onStartup.addListener(() => install().catch(() => {}));
    menus.onClicked.addListener((info, tab) => {
        if (tab && tab.incognito) return;
        let run;
        if (info.menuItemId === 'tp-helper-settings') run = api.runtime.openOptionsPage();
        if (info.menuItemId === 'tp-helper-open') run = H.openWebApp();
        if (info.menuItemId === 'tp-helper-save') run = H.stageSave(tab);
        if (info.menuItemId === 'tp-helper-reopen') run = H.reopenClosed();
        if (run && run.catch) run.catch(() => api.runtime.openOptionsPage());
    });
})();
