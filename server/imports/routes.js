// HTTP surface for importers.

import * as reddit from './reddit.js';
import { runSource, sweepSource, projectSource } from './runner.js';
import { classify, isManualProvider } from './manual.js';

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
        dismissed: store.countDismissed(source.id)
    };
}

function resultPage(title, body) {
    return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; min-height: 100vh;
         display: grid; place-items: center; background: #14161a; color: #e7e9ee; }
  .card { max-width: 32rem; padding: 2rem; text-align: center; }
  code { background: #22252b; padding: .15em .4em; border-radius: 4px; }
</style>
<div class="card">${body}</div>`;
}

export function attachRoutes(app, { store, requireAuth, latestSnapshot, commitSnapshot }) {
    const ctx = { latestSnapshot, commitSnapshot };

    app.get('/api/imports', requireAuth, (req, res) => {
        res.json({ ok: true, sources: store.listSources().map(s => publicSource(store, s)) });
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
            intervalMinutes: Math.max(5, Number(intervalMinutes) || 60)
        });
        res.json({ ok: true, source: publicSource(store, source) });
    });

    app.patch('/api/imports/:id', requireAuth, (req, res) => {
        const source = store.getSource(req.params.id);
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
        res.json({ ok: true, source: publicSource(store, store.updateSource(source.id, patch)) });
    });

    // Deleting a source keeps its archived items unless ?purge=1. The archive is
    // the only copy of anything Reddit has already dropped, so losing it must be
    // an explicit choice rather than a side effect of removing a connection.
    app.delete('/api/imports/:id', requireAuth, (req, res) => {
        const source = store.getSource(req.params.id);
        if (!source) return res.status(404).json({ error: 'Source not found' });
        store.deleteSource(source.id, { purge: req.query.purge === '1' });
        res.json({ ok: true });
    });

    app.get('/api/imports/:id/items', requireAuth, (req, res) => {
        const source = store.getSource(req.params.id);
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
                goneFromSource: Boolean(r.removed_at_source)
            }))
        });
    });

    app.post('/api/imports/:id/run', requireAuth, async (req, res) => {
        const source = store.getSource(req.params.id);
        if (!source) return res.status(404).json({ error: 'Source not found' });
        if (!store.hasCredentials(source.id)) {
            return res.status(409).json({ error: 'Connect the account first.' });
        }
        const result = await runSource(store, source, ctx);
        if (!result.ok) return res.status(502).json(result);
        res.json(result);
    });

    // Rebuild the bookmark folder from the archive without touching the network.
    // The repair hatch for a snapshot that lost the folder to an out-of-order
    // push.
    app.post('/api/imports/:id/reproject', requireAuth, (req, res) => {
        const source = store.getSource(req.params.id);
        if (!source) return res.status(404).json({ error: 'Source not found' });
        res.json({ ok: true, ...projectSource(store, source, ctx) });
    });

    // Forget which items the user deleted, so a later sweep may bring back any
    // that are still saved at the source. The only way back from a delete —
    // the archived copy itself is gone for good.
    app.post('/api/imports/:id/undismiss', requireAuth, (req, res) => {
        const source = store.getSource(req.params.id);
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

        const hit = classify(url);
        if (!hit) return res.json({ ok: true, captured: false, reason: 'not a manual import source' });

        let source = store.listSources().find(s => s.provider === hit.provider);
        if (!source) {
            source = store.createSource({
                provider: hit.provider,
                label: hit.label,
                config: { listTitle: 'Saved' },
                // Nothing to poll; the interval only paces the projection pass
                // that redraws the folder.
                intervalMinutes: 60
            });
        }

        // Already archived. Not an error — sharing the same post twice is a
        // normal thing to do — and deliberately not re-upserted, so its capture
        // date and therefore its month folder stay put.
        const existing = store.itemsFor(source.id).find(i => i.external_id === hit.externalId);
        if (existing) {
            return res.json({ ok: true, captured: true, duplicate: true, provider: hit.provider, items: store.countItems(source.id).total });
        }

        // Deleted before, deliberately. Honour that rather than silently
        // resurrecting it; re-sharing is a clear enough signal to undo it.
        store.undismiss(source.id, [hit.externalId]);

        // No date is available from a share, so capture time it is. It is
        // written once and never updated, which is what keeps the monthly
        // grouping stable across re-projections.
        const now = new Date().toISOString();
        store.upsertItem(source.id, {
            externalId: hit.externalId,
            url: hit.url,
            title: title || hit.url,
            container: hit.container,
            createdUtc: now,
            extra: { capturedVia: 'share' }
        });

        const projected = projectSource(store, store.getSource(source.id), ctx);
        res.json({
            ok: true, captured: true, duplicate: false,
            provider: hit.provider, sourceId: source.id,
            items: store.countItems(source.id).total,
            projected: Boolean(projected.projected)
        });
    });

    // --- Reddit OAuth ---

    app.get('/api/imports/:id/authorize', requireAuth, (req, res) => {
        const source = store.getSource(req.params.id);
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
    app.get('/api/imports/reddit/callback', async (req, res) => {
        const { code, state, error } = req.query;
        if (error) {
            return res.status(400).type('html').send(resultPage('Connection refused',
                `<h2>Reddit declined</h2><p><code>${String(error).slice(0, 100)}</code></p>`));
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

        const source = store.getSource(sourceId);
        if (!source) {
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
            store.writeCredentials(source.id, { ...tokens, username });
            store.markRun(source.id, { status: 'connected' });

            res.type('html').send(resultPage('Connected',
                `<h2>Connected as u/${username || '?'}</h2>
                 <p>TabPaladin will sweep your saved posts every ${source.intervalMinutes} minutes.</p>
                 <p>You can close this tab.</p>`));
        } catch (e) {
            store.markRun(source.id, { status: 'error', error: String(e && e.message || e) });
            res.status(502).type('html').send(resultPage('Failed',
                `<h2>Could not complete the connection</h2><p><code>${String(e && e.message || e).slice(0, 300)}</code></p>`));
        }
    });
}

export { sweepSource, projectSource, runSource };
