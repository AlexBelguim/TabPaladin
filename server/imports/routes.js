// HTTP surface for importers.
//
// Every route that takes a source id resolves it with getSource(id, userId):
// another account's source and a removed one are both a plain 404, so ids
// cannot be probed across accounts.

import crypto from 'node:crypto';
import * as reddit from './reddit.js';
import { runSource } from './runner.js';
import { classify, isManualProvider } from './manual.js';
import { escapeHtml } from '../security.js';

// Only Reddit can be created by hand; the manual archives create themselves the
// first time something is shared into them.
const PROVIDERS = new Set(['reddit']);

function callbackUri(req) {
    return `${req.protocol}://${req.get('host')}/api/imports/reddit/callback`;
}

// Never let the client see clientSecret or anything credential-shaped.
export function publicSource(store, source) {
    const counts = store.countItems(source.id);
    return {
        id: source.id,
        provider: source.provider,
        label: source.label,
        enabled: source.enabled,
        intervalMinutes: source.intervalMinutes,
        lastRun: source.lastRun,
        lastStatus: source.lastStatus,
        lastError: source.lastError,
        // Manual sources are never "connected" in the OAuth sense and have
        // nothing to sweep; clients use this to drop those controls.
        manual: isManualProvider(source.provider),
        connected: isManualProvider(source.provider) || store.hasCredentials(source.id),
        listTitle: source.config.listTitle || 'Saved',
        hasClientId: Boolean(source.config.clientId),
        items: counts.total,
        goneFromSource: counts.goneFromSource,
        filed: counts.filed,
        dismissed: store.countDismissed(source.id),
        removed: Boolean(source.deletedAt),
        removedAt: source.deletedAt || null
    };
}

function resultPage(title, body) {
    return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; min-height: 100vh;
         display: grid; place-items: center; background: #14161a; color: #e7e9ee; }
  .card { max-width: 32rem; padding: 2rem; text-align: center; }
  code { background: #22252b; padding: .15em .4em; border-radius: 4px; }
</style>
<div class="card">${body}</div>`;
}

// The confirm page's form posts urlencoded. The global body parser only reads
// JSON, so this reads the small form itself rather than pulling in another
// middleware for one route.
function readForm(req) {
    if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) {
        return Promise.resolve(new URLSearchParams(Object.entries(req.body).map(([k, v]) => [k, String(v)])));
    }
    return new Promise((resolve, reject) => {
        let raw = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
            raw += chunk;
            if (raw.length > 4096) { reject(new Error('Form too large')); req.destroy(); }
        });
        req.on('end', () => resolve(new URLSearchParams(raw)));
        req.on('error', reject);
    });
}

// Shared by the delete and file verbs: resolve a request body's externalIds
// against one source's archive rows.
function rowsForExternalIds(store, sourceId, externalIds) {
    if (!Array.isArray(externalIds) || externalIds.length === 0) return null;
    const wanted = new Set(externalIds.map(String));
    return store.itemsFor(sourceId).filter(r => wanted.has(String(r.external_id)));
}

// Capture a shared link into the archive it belongs to, for one account.
// Shared by POST /api/imports/capture and the share inbox (shares.js), which
// archives X and Instagram shares on arrival exactly as the capture route
// always has. Returns {result, sourceId, externalId}: `result` is the
// capture route's JSON, unchanged; the ids say which archive row it is.
export function captureLink(store, userId, { url, title }) {
    const hit = classify(url);
    if (!hit) return { result: { ok: true, captured: false, reason: 'not a manual import source' }, sourceId: null, externalId: null };

    // This account's active source for the provider, created on first use.
    let source = store.listSources(userId).find(s => s.provider === hit.provider);
    if (!source) {
        source = store.createSource({
            provider: hit.provider,
            label: hit.label,
            config: { listTitle: 'Saved' },
            intervalMinutes: 60,
            userId
        });
    }

    // Already archived. Not an error — sharing the same post twice is a
    // normal thing to do — and deliberately not re-upserted, so its capture
    // date and therefore its month folder stay put.
    if (store.itemByExternal(source.id, hit.externalId)) {
        return {
            result: { ok: true, captured: true, duplicate: true, provider: hit.provider, items: store.countItems(source.id).total },
            sourceId: source.id, externalId: hit.externalId
        };
    }

    // Deleted before, deliberately. Honour that rather than silently
    // resurrecting it; re-sharing is a clear enough signal to undo it.
    store.undismiss(source.id, [hit.externalId]);

    // No date is available from a share, so capture time it is. It is
    // written once and never updated, which is what keeps the monthly
    // grouping stable.
    const now = new Date().toISOString();
    store.upsertItem(source.id, {
        externalId: hit.externalId,
        url: hit.url,
        title: title || hit.url,
        container: hit.container,
        createdUtc: now,
        extra: { capturedVia: 'share' }
    });

    return {
        result: {
            ok: true, captured: true, duplicate: false,
            provider: hit.provider, sourceId: source.id,
            items: store.countItems(source.id).total
        },
        sourceId: source.id, externalId: hit.externalId
    };
}

export function attachRoutes(app, { store, requireAuth, accountName = () => null }) {
    // ?includeRemoved=1 adds removed sources (flagged `removed`), whose
    // archives are kept until purged.
    app.get('/api/imports', requireAuth, (req, res) => {
        const includeRemoved = req.query.includeRemoved === '1';
        res.json({ ok: true, sources: store.listSources(req.user.id, { includeRemoved }).map(s => publicSource(store, s)) });
    });

    app.post('/api/imports', requireAuth, (req, res) => {
        const { provider, label, clientId, clientSecret, listTitle, intervalMinutes } = req.body || {};
        if (!PROVIDERS.has(provider)) {
            return res.status(400).json({ error: `Unsupported provider. Supported: ${[...PROVIDERS].join(', ')}` });
        }
        if (!clientId || !clientSecret) {
            return res.status(400).json({ error: 'clientId and clientSecret are required — create an app at reddit.com/prefs/apps.' });
        }
        const source = store.createSource({
            provider,
            label: label || 'Reddit saved',
            config: { clientId, clientSecret, listTitle: listTitle || 'Saved' },
            intervalMinutes: Math.max(5, Number(intervalMinutes) || 60),
            userId: req.user.id
        });
        res.json({ ok: true, source: publicSource(store, source) });
    });

    app.patch('/api/imports/:id', requireAuth, (req, res) => {
        const source = store.getSource(req.params.id, req.user.id);
        if (!source) return res.status(404).json({ error: 'Source not found' });

        const body = req.body || {};
        const patch = {};
        if (body.label !== undefined) patch.label = body.label;
        if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
        if (body.intervalMinutes !== undefined) patch.intervalMinutes = Math.max(5, Number(body.intervalMinutes) || 60);
        if (body.clientId || body.clientSecret || body.listTitle) {
            patch.config = {
                ...source.config,
                ...(body.clientId ? { clientId: body.clientId } : {}),
                ...(body.clientSecret ? { clientSecret: body.clientSecret } : {}),
                ...(body.listTitle ? { listTitle: body.listTitle } : {})
            };
        }
        res.json({ ok: true, source: publicSource(store, store.updateSource(source.id, req.user.id, patch)) });
    });

    // Deleting a source keeps its archived items unless ?purge=1. The archive is
    // the only copy of anything Reddit has already dropped, so losing it must be
    // an explicit choice rather than a side effect of removing a connection.
    // Without purge the source is only marked removed; purge also reaches
    // sources already removed.
    app.delete('/api/imports/:id', requireAuth, (req, res) => {
        const purge = req.query.purge === '1';
        const source = store.getSource(req.params.id, req.user.id, { includeRemoved: purge });
        if (!source) return res.status(404).json({ error: 'Source not found' });
        store.deleteSource(source.id, req.user.id, { purge });
        res.json({ ok: true, purged: purge });
    });

    app.post('/api/imports/:id/restore', requireAuth, (req, res) => {
        const source = store.getSource(req.params.id, req.user.id, { includeRemoved: true });
        if (!source) return res.status(404).json({ error: 'Source not found' });
        const restored = source.deletedAt ? store.restoreSource(source.id, req.user.id) : source;
        res.json({ ok: true, source: publicSource(store, restored) });
    });

    app.get('/api/imports/:id/items', requireAuth, (req, res) => {
        const source = store.getSource(req.params.id, req.user.id);
        if (!source) return res.status(404).json({ error: 'Source not found' });
        const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
        const offset = Math.max(0, Number(req.query.offset) || 0);
        const rows = store.pageItems(source.id, { limit, offset });
        res.json({
            ok: true,
            total: store.countItems(source.id).total,
            items: rows.map(r => ({
                externalId: r.external_id,
                url: r.url,
                title: r.title,
                author: r.author,
                container: r.container,
                createdUtc: r.created_utc,
                importedAt: r.imported_at,
                goneFromSource: Boolean(r.removed_at_source),
                filed: Boolean(r.filed_at)
            }))
        });
    });

    app.post('/api/imports/:id/run', requireAuth, async (req, res) => {
        const source = store.getSource(req.params.id, req.user.id);
        if (!source) return res.status(404).json({ error: 'Source not found' });
        if (!store.hasCredentials(source.id)) {
            return res.status(409).json({ error: 'Connect the account first.' });
        }
        const result = await runSource(store, source);
        if (!result.ok) return res.status(502).json(result);
        res.json(result);
    });

    // Delete items from the archive. This used to be inferred from what a
    // pushed bookmark tree no longer contained; now it is a verb, which is the
    // only kind of delete that cannot be triggered by a stale device.
    //
    // Unrecoverable by design — anything past Reddit's 1000-item window cannot
    // be fetched again. The tombstone left behind is what stops the next sweep
    // from simply re-importing a post that is still saved at the source.
    app.post('/api/imports/:id/items/delete', requireAuth, (req, res) => {
        const source = store.getSource(req.params.id, req.user.id);
        if (!source) return res.status(404).json({ error: 'Source not found' });
        const rows = rowsForExternalIds(store, source.id, (req.body || {}).externalIds);
        if (!rows) return res.status(400).json({ error: 'externalIds must be a non-empty array.' });
        const purged = store.purgeItems(rows);
        res.json({ ok: true, purged });
    });

    // The user copied these into their own tree. The archive row stays — the
    // item still counts and still came from the source — but it stops being
    // drawn into the virtual folder, so it does not show up twice.
    app.post('/api/imports/:id/items/file', requireAuth, (req, res) => {
        const source = store.getSource(req.params.id, req.user.id);
        if (!source) return res.status(404).json({ error: 'Source not found' });
        const rows = rowsForExternalIds(store, source.id, (req.body || {}).externalIds);
        if (!rows) return res.status(400).json({ error: 'externalIds must be a non-empty array.' });
        const filed = store.markFiled(rows.map(r => r.id));
        res.json({
            ok: true,
            filed,
            items: rows.map(r => ({ externalId: r.external_id, url: r.url, title: r.title }))
        });
    });

    // Forget which items the user deleted, so a later sweep may bring back any
    // that are still saved at the source. The only way back from a delete —
    // the archived copy itself is gone for good.
    app.post('/api/imports/:id/undismiss', requireAuth, (req, res) => {
        const source = store.getSource(req.params.id, req.user.id);
        if (!source) return res.status(404).json({ error: 'Source not found' });
        const cleared = store.undismiss(source.id);
        res.json({ ok: true, cleared, note: 'Only items still present at the source will return.' });
    });

    // Capture a shared link into the archive it belongs to.
    //
    // This is what the Android share sheet hits. X and Instagram cannot be
    // swept — no free API on one, no personal saved list on the other — so
    // sharing a post to the app is the only way either archive ever gets filled.
    // The source is created on first use so there is nothing to set up.
    //
    // A link that belongs to neither returns captured:false rather than an
    // error, so the client can fall back to the ordinary shared-links inbox.
    app.post('/api/imports/capture', requireAuth, (req, res) => {
        const { url, title } = req.body || {};
        if (!url || typeof url !== 'string') return res.status(400).json({ error: 'Missing url' });
        res.json(captureLink(store, req.user.id, { url, title }).result);
    });

    // --- Reddit OAuth ---

    app.get('/api/imports/:id/authorize', requireAuth, (req, res) => {
        const source = store.getSource(req.params.id, req.user.id);
        if (!source) return res.status(404).json({ error: 'Source not found' });
        if (source.provider !== 'reddit') return res.status(400).json({ error: 'Unsupported provider' });
        if (!source.config.clientId) return res.status(400).json({ error: 'Source has no clientId configured.' });

        const state = store.createOAuthState(source.id);
        res.json({
            ok: true,
            url: reddit.authorizeUrl({
                clientId: source.config.clientId,
                redirectUri: callbackUri(req),
                state
            }),
            redirectUri: callbackUri(req)
        });
    });

    // No bearer auth: this is a browser redirect coming back from Reddit and it
    // cannot carry one. The one-shot `state` row is what authenticates it, the
    // same trade the /llm/:token routes already make.
    //
    // The state proves which source started the flow, not who completed
    // Reddit's consent — anyone can be sent someone else's consent link. So
    // nothing is stored as the connection here: the tokens wait as a pending
    // connection, and this page asks the person in front of it to confirm
    // which TabPaladin account receives which Reddit account.
    app.get('/api/imports/reddit/callback', async (req, res) => {
        const { code, state, error } = req.query;
        if (error) {
            return res.status(400).type('html').send(resultPage('Connection refused',
                `<h2>Reddit declined</h2><p><code>${escapeHtml(String(error).slice(0, 100))}</code></p>`));
        }
        if (!code || !state) {
            return res.status(400).type('html').send(resultPage('Bad callback',
                '<h2>Missing code or state</h2>'));
        }

        const sourceId = store.consumeOAuthState(String(state));
        if (!sourceId) {
            return res.status(400).type('html').send(resultPage('Expired',
                '<h2>That link expired</h2><p>Start the connection again from TabPaladin settings.</p>'));
        }

        const source = store.getSourceUnscoped(sourceId);
        if (!source || source.deletedAt) {
            return res.status(404).type('html').send(resultPage('Gone', '<h2>That source no longer exists</h2>'));
        }

        try {
            const tokens = await reddit.exchangeCode({
                clientId: source.config.clientId,
                clientSecret: source.config.clientSecret,
                redirectUri: callbackUri(req),
                code: String(code)
            });
            const username = await reddit.whoami({ accessToken: tokens.accessToken });
            const nonce = crypto.randomBytes(32).toString('hex');
            store.setPendingCredentials(source.id, { creds: { ...tokens, username }, username, nonce });
            res.type('html').send(confirmPage({
                redditName: username || '?',
                account: accountName(source.userId) || `#${source.userId}`,
                nonce
            }));
        } catch (e) {
            store.markRun(source.id, { status: 'error', error: String(e && e.message || e) });
            res.status(502).type('html').send(resultPage('Failed',
                `<h2>Could not complete the connection</h2><p><code>${escapeHtml(String(e && e.message || e).slice(0, 300))}</code></p>`));
        }
    });

    // The confirm page's form lands here, with the one-time nonce only that
    // page holds. Connect moves the pending tokens into place; Cancel drops
    // them. Either way the nonce is spent.
    app.post('/api/imports/reddit/confirm', async (req, res) => {
        let form;
        try { form = await readForm(req); } catch (e) {
            return res.status(400).type('html').send(resultPage('Bad request', '<h2>That request was not understood</h2>'));
        }
        const nonce = form.get('nonce') || '';
        const accept = form.get('accept') === '1';
        const pending = store.pendingFor(nonce);
        if (!pending) {
            return res.status(400).type('html').send(resultPage('Expired',
                '<h2>That confirmation expired</h2><p>Start the connection again from TabPaladin settings. Nothing was connected.</p>'));
        }
        const account = accountName(pending.source.userId) || `#${pending.source.userId}`;
        if (!accept) {
            store.clearPending(pending.source.id);
            return res.type('html').send(resultPage('Cancelled',
                `<h2>Not connected</h2><p>Nothing was stored for TabPaladin account <strong>${escapeHtml(account)}</strong>. You can close this tab.</p>`));
        }
        store.confirmPending(nonce);
        store.markRun(pending.source.id, { status: 'connected' });
        res.type('html').send(resultPage('Connected',
            `<h2>Connected u/${escapeHtml(pending.username || '?')} to ${escapeHtml(account)}</h2>
             <p>TabPaladin will sweep these saved posts every ${pending.source.intervalMinutes} minutes.</p>
             <p>You can close this tab.</p>`));
    });
}

function confirmPage({ redditName, account, nonce }) {
    return resultPage('Confirm connection', `
        <h2>Connect Reddit u/${escapeHtml(redditName)} to TabPaladin account <strong>${escapeHtml(account)}</strong>?</h2>
        <p>Its saved posts will be archived into that account. If that is not your TabPaladin account, cancel.</p>
        <form method="post" action="/api/imports/reddit/confirm" style="display:flex; gap:12px; justify-content:center; margin-top:1.5rem;">
          <input type="hidden" name="nonce" value="${escapeHtml(nonce)}">
          <button type="submit" name="accept" value="1" style="font:inherit; padding:.6em 1.4em; border-radius:8px; border:0; background:#3b82f6; color:#fff;">Connect</button>
          <button type="submit" name="accept" value="0" style="font:inherit; padding:.6em 1.4em; border-radius:8px; border:1px solid #444; background:transparent; color:inherit;">Cancel</button>
        </form>`);
}

export { runSource };
