(() => {
    const H = globalThis.TPHelper;
    const api = H.api;
    const readsVisible = op => op.startsWith('tabs.') || op.startsWith('windows.') || ['actions.take', 'bookmarks.take', 'vault.get'].includes(op);
    // move.manifest starts a hand-over (and binds its document) only from a
    // click; its parts and ack are bound to that document and bundle (move.js).
    const gestureOps = new Set(['tabs.snapshot', 'tabs.active', 'tabs.closeSnapshot', 'windows.openWorkflow', 'windows.openUrls', 'windows.list', 'bookmarks.take', 'options.open', 'move.manifest', 'youtube.playlist', 'feed.open']);
    const mutations = new Set(['windows.openWorkflow', 'windows.openUrls', 'youtube.playlist', 'feed.open', 'tabs.closeSnapshot', 'removals.ack', 'actions.done', 'bookmarks.ack', 'track.untrack', 'vault.put', 'vault.clear', 'move.ack']);
    const requestRates = new Map();
    const inFlight = new Map();
    let mutationChain = Promise.resolve();
    let logChain = Promise.resolve();
    const resultError = error => ({ ok: false, error: { code: error.code || 'internal', message: error.code ? error.message : 'The helper could not complete this request.', retryable: Boolean(error.retryable) } });
    H.errorResult = resultError;
    function typedRequest(message) {
        if (!message || message.channel !== 'tp-bridge' || typeof message.inst !== 'string' || !/^[a-f0-9-]{32,36}$/i.test(message.inst)) H.fail('bad-args', 'Invalid bridge instance.');
        const req = message.req;
        if (!req || req.v !== 1) H.fail('proto-mismatch', 'Update the web app or the TabPaladin helper.');
        if (typeof req.id !== 'string' || !/^[a-f0-9-]{32,36}$/i.test(req.id) || typeof req.op !== 'string' || req.op.length > 64
            || !req.body || typeof req.body !== 'object' || Array.isArray(req.body)) H.fail('bad-args', 'Invalid bridge request.');
        let raw;
        try { raw = JSON.stringify(req.body); } catch (_) { H.fail('bad-args', 'Invalid request arguments.'); }
        if (raw.length > 1024 * 1024) H.fail('too-large', 'Bridge requests are limited to 1 MiB.');
        if (/"(?:token|password|authorization|cookie|[a-z]*apiKey|secret)"\s*:/i.test(raw)) H.fail('bad-args', 'Credentials must never cross the helper bridge.');
        return req;
    }
    H.checkSender = async (sender, message) => {
        if (!sender || sender.id !== api.runtime.id || !sender.tab || sender.frameId !== 0
            || sender.tab.incognito || (sender.documentLifecycle && sender.documentLifecycle !== 'active')) H.fail('bad-origin', 'This document may not use the helper.');
        const origin = H.originOf(sender.url);
        if (!/^https?:\/\//.test(origin) || (sender.origin && sender.origin !== origin)) H.fail('bad-origin', 'This document has an invalid origin.');
        const path = new URL(sender.url).pathname;
        if (/^\/(api|llm)(\/|$)/.test(path) || path.startsWith('/share')) H.fail('bad-origin', 'This page may not use the helper.');
        const config = await H.getConfig();
        if (!config.enabled || !config.pin || !config.serverOrigin) H.fail('not-configured', 'Reconnect in the helper Settings.');
        if (config.serverOrigin !== origin) H.fail('bad-origin', 'This document is not on the configured server origin.');
        if (!await api.permissions.contains({ origins: [config.pattern] })) {
            await H.stopBridge('Server permission was removed.');
            H.fail('permission-missing', 'Grant access to this server in helper Settings.');
        }
        await H.verifyIdentity(config);
        // A disconnect/address switch may finish during the identity fetch.
        const current = await H.getConfig();
        if (!current.enabled || current.serverOrigin !== origin || !H.sameIdentity(current.pin, config.pin)) H.fail('not-configured', 'The helper connection changed. Reconnect.');
        return { sender, config: current, inst: message.inst, documentKey: sender.documentId || message.inst };
    };
    function rateLimit(tabId, req) {
        const now = Date.now();
        let rate = requestRates.get(tabId);
        if (!rate) { rate = { requests: [], opens: [], lastClose: 0 }; requestRates.set(tabId, rate); }
        rate.requests = rate.requests.filter(at => now - at < 1000);
        if (rate.requests.length >= 60) H.fail('rate-limited', 'Too many helper requests. Try again in a moment.', true);
        rate.requests.push(now);
        if (req.op === 'tabs.closeSnapshot') {
            if (now - rate.lastClose < 1000) H.fail('rate-limited', 'Wait a second before closing another set of tabs.', true);
            rate.lastClose = now;
        }
        if (req.op === 'windows.openWorkflow' || req.op === 'windows.openUrls') {
            const count = Array.isArray(req.body.items) ? req.body.items.length : Array.isArray(req.body.urls) ? req.body.urls.length : 0;
            rate.opens = rate.opens.filter(entry => now - entry.at < 60000);
            if (rate.opens.reduce((sum, entry) => sum + entry.count, 0) + count > 2000) H.fail('rate-limited', 'Too many opened URLs. Wait a minute.', true);
            rate.opens.push({ at: now, count });
        }
    }
    async function gate(ctx, message, req) {
        let gesture = gestureOps.has(req.op);
        if (req.op === 'tabs.listWindow' && (await api.windows.get(ctx.sender.tab.windowId)).type !== 'normal') gesture = true;
        if (req.op === 'tabs.listWindow' && req.body.windowId != null && req.body.windowId !== ctx.sender.tab.windowId) gesture = true;
        if (gesture) {
            const limit = req.op === 'tabs.closeSnapshot' ? 30000 : 10000;
            if (!Number.isFinite(message.gestureAgeMs) || message.gestureAgeMs < 0 || message.gestureAgeMs > limit) H.fail('needs-gesture', 'Click inside the web app to use this action.');
        }
        if (readsVisible(req.op) || gesture) {
            const tab = await api.tabs.get(ctx.sender.tab.id);
            const win = await api.windows.get(tab.windowId);
            if (!message.visible || !tab.active || tab.incognito || !win.focused || win.incognito) H.fail('needs-visible', 'Keep the web app visible in the focused window.');
            if (H.originOf(tab.url) !== ctx.config.serverOrigin) H.fail('bad-origin', 'This tab navigated away from the web app.');
        }
    }
    function logCall(origin, op) {
        logChain = logChain.then(async () => {
            const data = await api.storage.local.get('tpHelperCalls');
            const calls = Array.isArray(data.tpHelperCalls) ? data.tpHelperCalls : [];
            await api.storage.local.set({ tpHelperCalls: [...calls.slice(-49), { origin, op, at: Date.now() }] });
        }).catch(() => {});
    }
    async function legacySummary(config) {
        const { tpTree: tree, tpMove: move } = await api.storage.local.get(['tpTree', 'tpMove']);
        if (!tree || !Array.isArray(tree.roots)) return null;
        // Moved: what the move carried is the web app's to settle now.
        // Unpushed edits at a version it did not carry (the old UI used again
        // after going back to 1.1.0) are only here: still reported, and the
        // move looks again (move.js recheck), so the toolbar offers it.
        const moved = Boolean(move && move.state === 'done');
        if (moved && (tree.dirty !== true || !H.moveCarried || H.moveCarried(move, tree))) return null;
        let username = '';
        if (tree.owner) {
            if (H.originOf(tree.owner.url) !== config.serverOrigin || tree.owner.serverId && tree.owner.serverId !== config.pin.serverId) return null;
            username = typeof tree.owner.username === 'string' ? tree.owner.username.slice(0, 200) : '';
        } else {
            const { settings } = await api.storage.local.get('settings');
            if (!settings || !settings.backend || H.originOf(settings.backend.url) !== config.serverOrigin) return null;
            // Unstamped trees have no reliable account owner; do not borrow a username.
        }
        if (moved && H.recheckMove) H.recheckMove();
        let items = 0;
        const pending = [...tree.roots];
        while (pending.length && items < 1000000) {
            const node = pending.pop();
            if (!node || node.virtual) continue;
            items++;
            if (Array.isArray(node.children)) for (const child of node.children) pending.push(child);
        }
        return { owner: username, dirty: tree.dirty === true, editCount: Math.max(0, Number(tree.editCount) || 0), items };
    }
    async function handle(req, ctx) {
        if (req.op === 'cs.attach') {
            const win = await api.windows.get(ctx.sender.tab.windowId);
            if (H.bindDelivery) await H.bindDelivery(ctx);
            const pending = H.pendingFor ? await H.pendingFor(ctx) : { removals: 0, actions: 0, bookmarksStaged: false };
            return {
                protocol: { min: 1, max: 1 }, helperId: api.runtime.id, helperVersion: api.runtime.getManifest().version,
                browser: typeof browser !== 'undefined' ? 'Firefox' : 'Chromium',
                ops: [...new Set(['session.report', 'options.open', 'videoSeek.status', ...(H.ops || [])])],
                self: { tabId: ctx.sender.tab.id, windowId: ctx.sender.tab.windowId, windowType: win.type },
                serverOrigin: ctx.config.serverOrigin, serverId: ctx.config.pin.serverId,
                perms: { bookmarks: await api.permissions.contains({ permissions: ['bookmarks'] }), allSites: await api.permissions.contains({ origins: ['<all_urls>'] }) },
                pending, legacy: await legacySummary(ctx.config),
                move: H.moveHello ? await H.moveHello(ctx) : null
            };
        }
        if (req.op === 'session.report') {
            if (typeof req.body.signedIn !== 'boolean') H.fail('bad-args', 'Invalid sign-in status.');
            if (req.body.signedIn === false && req.body.signedOut === true) return H.disconnect();
            // Display only: never use these fields to authorize a workflow or removal.
            const session = { signedIn: req.body.signedIn, username: typeof req.body.username === 'string' ? req.body.username.slice(0, 200) : '', userId: ['string', 'number'].includes(typeof req.body.userId) ? String(req.body.userId).slice(0, 256) : '', at: Date.now() };
            await api.storage.local.set({ tpHelperSession: { ...session, origin: ctx.config.serverOrigin, serverId: ctx.config.pin.serverId } });
            // A hint only: the move signs the old UI's own session out once
            // the web app has one, and goes by the server's answer (move.js).
            if (H.onSessionReport) H.onSessionReport(session);
            return { reported: true };
        }
        if (req.op === 'options.open') {
            const section = req.body.section || 'settings';
            if (!['settings', 'setup', 'connection', 'import', 'recent', 'calls'].includes(section)) H.fail('bad-args', 'Unknown helper Settings section.');
            await api.runtime.openOptionsPage();
            return { opened: true };
        }
        if (req.op === 'videoSeek.status') return { enabled: Boolean((await api.storage.local.get('tpVideoSeek')).tpVideoSeek) };
        if (!H.handleOp || !(H.ops || []).includes(req.op)) H.fail('unsupported-op', 'This helper does not support that action.');
        return H.handleOp(req.op, req.body, ctx);
    }
    async function withDedup(req, ctx, fn) {
        const requestId = typeof req.body.requestId === 'string' ? req.body.requestId : req.id;
        if (!/^[a-f0-9-]{32,36}$/i.test(requestId)) H.fail('bad-args', 'Invalid operation request ID.');
        const key = JSON.stringify([ctx.config.serverOrigin, ctx.config.pin.serverId, ctx.sender.tab.id, ctx.documentKey, req.op, requestId]);
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(req.body)))), x => x.toString(16).padStart(2, '0')).join('');
        const underway = inFlight.get(key);
        if (underway) {
            if (underway.digest !== digest) H.fail('bad-args', 'A request ID was reused with different arguments.');
            return underway.promise;
        }
        const promise = mutationChain.then(async () => {
            const stored = await H.session.get('tpHelperDedup');
            const records = stored.tpHelperDedup || {};
            for (const [id, record] of Object.entries(records)) if (Date.now() - record.at > 600000) delete records[id];
            const existing = records[key];
            if (existing) {
                if (existing.digest !== digest) H.fail('bad-args', 'A request ID was reused with different arguments.');
                if (existing.state === 'pending') H.fail('restarting', 'The helper restarted during this action. Check the result before trying a new action.', true);
                if (!existing.result.ok) throw Object.assign(new Error(existing.result.error.message), existing.result.error);
                return existing.result.data;
            }
            // Persist BEFORE touching tabs. A worker stopped after this point must never repeat the action.
            records[key] = { at: Date.now(), digest, state: 'pending' };
            await H.session.set({ tpHelperDedup: records });
            let result;
            try { result = { ok: true, data: await fn() }; } catch (error) { result = resultError(error); }
            records[key] = { at: Date.now(), digest, state: 'done', result };
            await H.session.set({ tpHelperDedup: records });
            if (!result.ok) throw Object.assign(new Error(result.error.message), result.error);
            return result.data;
        });
        mutationChain = promise.catch(() => {});
        inFlight.set(key, { digest, promise });
        try { return await promise; } finally { inFlight.delete(key); }
    }
    H.handleBridgeMessage = async (message, sender) => {
        try {
            const req = typedRequest(message);
            const ctx = await H.checkSender(sender, message);
            await gate(ctx, message, req);
            H.attached.set(sender.tab.id, { origin: ctx.config.serverOrigin, inst: ctx.inst, documentKey: ctx.documentKey, documentId: sender.documentId, visible: message.visible === true });
            logCall(ctx.config.serverOrigin, req.op);
            const execute = async () => {
                // Queued mutations must still belong to the live configuration when they run.
                const current = await H.getConfig();
                if (!current.enabled || current.serverOrigin !== ctx.config.serverOrigin || !H.sameIdentity(current.pin, ctx.config.pin)) H.fail('not-configured', 'The helper connection changed.');
                rateLimit(sender.tab.id, req);
                return handle(req, ctx);
            };
            const data = mutations.has(req.op) ? await withDedup(req, ctx, execute) : await execute();
            return { ok: true, data };
        } catch (error) { return resultError(error); }
    };
    H.fromExtensionPage = sender => Boolean(sender && sender.id === api.runtime.id && typeof sender.url === 'string' && sender.url.startsWith(api.runtime.getURL('')));
    H.handleOptionsMessage = async (message, sender) => {
        try {
            if (!H.fromExtensionPage(sender) || sender.tab && sender.tab.incognito) H.fail('bad-origin', 'Only helper Settings may change its connection.');
            if (sender.url.split(/[?#]/)[0] !== api.runtime.getURL('src/helper/options.html')) H.fail('bad-origin', 'Open the helper Settings page.');
            const body = message.body || {};
            let data;
            if (message.op === 'configure') data = await H.configure(body.origin, body.insecureAck, { repin: body.repin === true });
            else if (message.op === 'disconnect') data = await H.disconnect();
            else if (message.op === 'policy') {
                if (!['keep', 'remove'].includes(body.windowClosePolicy)) H.fail('bad-args', 'Unknown window-close policy.');
                await api.storage.local.set({ tpHelper: { ...await H.getConfig(), windowClosePolicy: body.windowClosePolicy } });
                data = { saved: true };
            } else if (H.handleOptions) data = await H.handleOptions(message.op, body, sender);
            else H.fail('unsupported-op', 'Unknown helper Settings action.');
            return { ok: true, data };
        } catch (error) { return resultError(error); }
    };
    api.runtime.onMessage.addListener((message, sender, reply) => {
        if (!message || !['tp-bridge', 'tp-helper-options'].includes(message.channel)) return;
        const work = message.channel === 'tp-bridge' ? H.handleBridgeMessage(message, sender) : H.handleOptionsMessage(message, sender);
        work.then(reply, error => reply(resultError(error)));
        return true;
    });
    const refresh = () => H.ensureBridge().catch(error => console.warn('TabPaladin helper connection:', error.message));
    const connectionKey = config => JSON.stringify(config && [config.serverOrigin, config.pattern, config.pin, config.enabled, config.insecureAck, config.identityError]);
    api.storage.onChanged.addListener((changes, area) => {
        const change = area === 'local' && changes.tpHelper;
        // session.report is display only: it must not create an attach/hello/report loop.
        if (change && connectionKey(change.oldValue) !== connectionKey(change.newValue)) refresh();
    });
    if (api.runtime.onStartup) api.runtime.onStartup.addListener(refresh);
    if (api.runtime.onInstalled) api.runtime.onInstalled.addListener(refresh);
    if (api.permissions.onAdded) api.permissions.onAdded.addListener(refresh);
    if (api.permissions.onRemoved) api.permissions.onRemoved.addListener(refresh);
    // A fresh MV3 worker must rebuild its attachment table as well as registration.
    refresh();
})();
