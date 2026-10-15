// Web workflows never enter tpPendingRemovals: that belongs to the old UI.
(() => {
    'use strict';
    const H = globalThis.TPHelper;
    const api = H.api;
    const QUEUE = 'tpHelperRemovals';
    const ISSUED = 'tpHelperRemovalReceipts';
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    H.handlers = H.handlers || Object.create(null);
    H.ops = H.ops || [];
    H.temporary = api.storage.session || api.storage.local;
    H.randomId = () => crypto.randomUUID();
    H.pinScope = config => JSON.stringify([config.serverOrigin, config.pin.serverId,
        config.pin.publicKeyJwk.x, config.pin.publicKeyJwk.y]);
    H.scope = ctx => JSON.stringify([H.pinScope(ctx.config), ctx.sender.tab.id, ctx.documentKey]);
    H.assertContext = async ctx => {
        const current = await H.getConfig();
        if (!current.enabled || !current.pin || H.pinScope(current) !== H.pinScope(ctx.config)) {
            H.fail('not-configured', 'The helper connection changed. Reconnect before using tab features.');
        }
    };
    H.account = (value, config) => {
        if (!value || value.url !== config.serverOrigin || value.serverId !== config.pin.serverId
            || !['string', 'number'].includes(typeof value.userId) || !String(value.userId)
            || String(value.userId).length > 200) H.fail('bad-args', 'The workflow account must match the pinned server.');
        return { url: config.serverOrigin, serverId: config.pin.serverId, userId: String(value.userId) };
    };
    H.sameAccount = (a, b) => a && b && a.url === b.url && a.serverId === b.serverId
        && String(a.userId) === String(b.userId);
    const fresh = list => (Array.isArray(list) ? list : []).filter(e => e && e.closedAt > Date.now() - THIRTY_DAYS).slice(-10000);
    const own = (entry, ctx) => entry.origin === ctx.config.serverOrigin && entry.pinScope === H.pinScope(ctx.config);

    // Called from the background's existing serialized onRemoved writer.
    H.queueWebRemoval = async (entry, info) => {
        if (!entry.account || !entry.pinScope || !entry.url) return;
        const data = await api.storage.local.get(QUEUE);
        const queue = fresh(data[QUEUE]);
        queue.push({ qid: H.randomId(), workflowId: entry.workflowId, bookmarkId: entry.bookmarkId,
            url: entry.url, account: entry.account, origin: entry.origin, pinScope: entry.pinScope,
            closedAt: Date.now(), windowClosing: Boolean(info && info.isWindowClosing) });
        await api.storage.local.set({ [QUEUE]: queue.slice(-10000) });
        // Hints contain no account data; pulling remains the durable path.
        if (H.attached && H.sendEvent) for (const [tabId, attachment] of H.attached) {
            if (attachment.origin === entry.origin) H.sendEvent(tabId, 'removals.available', {}).catch(() => {});
        }
    };

    H.handlers['removals.take'] = (body, ctx) => H.serialized(async () => {
        await H.assertContext(ctx);
        const account = H.account(body.account, ctx.config);
        const data = await api.storage.local.get(QUEUE);
        const queue = fresh(data[QUEUE]);
        const result = queue.filter(e => own(e, ctx) && H.sameAccount(e.account, account));
        const issued = (await H.temporary.get(ISSUED))[ISSUED] || {};
        for (const [key, value] of Object.entries(issued)) if (value.until < Date.now()) delete issued[key];
        issued[H.scope(ctx)] = { qids: result.map(e => e.qid), until: Date.now() + 10 * 60 * 1000 };
        await H.temporary.set({ [ISSUED]: issued });
        if (queue.length !== (data[QUEUE] || []).length) await api.storage.local.set({ [QUEUE]: queue });
        return result.map(({ pinScope, ...entry }) => entry);
    });

    H.handlers['removals.ack'] = (body, ctx) => H.serialized(async () => {
        await H.assertContext(ctx);
        if (!Array.isArray(body.qids) || body.qids.length > 10000 || body.qids.some(id => typeof id !== 'string')) {
            H.fail('bad-args', 'Expected removal receipt ids.');
        }
        const issued = (await H.temporary.get(ISSUED))[ISSUED] || {};
        const receipt = issued[H.scope(ctx)];
        if (!receipt || receipt.until < Date.now() || body.qids.some(id => !receipt.qids.includes(id))) {
            H.fail('bad-args', 'These removals were not delivered to this document.');
        }
        const qids = new Set(body.qids);
        const queue = (await api.storage.local.get(QUEUE))[QUEUE] || [];
        await api.storage.local.set({ [QUEUE]: queue.filter(e => !own(e, ctx) || !qids.has(e.qid)) });
        receipt.qids = receipt.qids.filter(id => !qids.has(id));
        await H.temporary.set({ [ISSUED]: issued });
        return { acknowledged: qids.size };
    });

    H.handlers['track.untrack'] = (body, ctx) => H.serialized(async () => {
        await H.assertContext(ctx);
        const account = H.account(body.account, ctx.config);
        if (typeof body.workflowId !== 'string' || !body.workflowId) H.fail('bad-args', 'A workflow is required.');
        const map = await H.getTrackMap();
        let count = 0;
        for (const [id, entry] of Object.entries(map)) {
            if (entry.target === 'web' && own(entry, ctx) && entry.workflowId === body.workflowId
                && H.sameAccount(entry.account, account)) { delete map[id]; count++; }
        }
        await H.setTrackMap(map);
        return { untracked: count };
    });
    H.ops.push('removals.take', 'removals.ack', 'track.untrack');
})();
