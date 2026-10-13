// Runs a source: refresh token -> sweep the listing -> archive.
//
// There is no projection step any more. The archive is served straight out of
// import_items as a virtual subtree on every tree pull, so a sweep's only job
// is to keep the table current.

import * as reddit from './reddit.js';
import { isManualProvider } from './manual.js';

const TICK_MS = 60 * 1000;

// Refresh a little early so a sweep never starts with a token that expires
// halfway through its ten requests.
const TOKEN_SKEW_MS = 60 * 1000;

async function redditAccessToken(store, source) {
    const creds = store.readCredentials(source.id);
    if (!creds.refreshToken) throw new Error('Not connected to Reddit yet.');

    const stillValid = creds.accessToken && creds.expiresAt
        && Date.parse(creds.expiresAt) - TOKEN_SKEW_MS > Date.now();
    if (stillValid) return { accessToken: creds.accessToken, username: creds.username, creds };

    const { clientId, clientSecret } = source.config;
    if (!clientId || !clientSecret) throw new Error('Source is missing its Reddit client credentials.');

    const fresh = await reddit.refreshAccessToken({
        clientId, clientSecret,
        refreshToken: creds.refreshToken,
        username: creds.username
    });
    const merged = { ...creds, accessToken: fresh.accessToken, expiresAt: fresh.expiresAt };
    store.writeCredentials(source.id, merged);
    return { accessToken: fresh.accessToken, username: merged.username, creds: merged };
}

// Fetch + archive.
export async function sweepSource(store, source) {
    if (source.provider !== 'reddit') {
        throw new Error(`Unknown importer provider: ${source.provider}`);
    }

    const { accessToken, username, creds } = await redditAccessToken(store, source);
    const who = username || await reddit.whoami({ accessToken });
    if (!who) throw new Error('Could not determine the Reddit username for this account.');
    if (!username) store.writeCredentials(source.id, { ...creds, username: who });

    const { items, pages, complete } = await reddit.fetchSaved({ accessToken, username: who });

    let added = 0;
    for (const item of items) {
        if (store.upsertItem(source.id, item)) added++;
    }

    // Only a complete sweep may decide what is missing. A partial one — a rate
    // limit or a network blip mid-walk — would stamp most of the archive as gone
    // from the source on no evidence at all.
    let missing = 0;
    if (complete) {
        missing = store.markMissing(source.id, items.map(i => i.externalId));
    }

    return { fetched: items.length, added, missing, pages };
}

export async function runSource(store, source) {
    try {
        const swept = await sweepSource(store, source);
        store.markRun(source.id, { status: 'ok' });
        return { ok: true, ...swept };
    } catch (e) {
        store.markRun(source.id, { status: 'error', error: String(e && e.message || e) });
        return { ok: false, error: String(e && e.message || e) };
    }
}

function isDue(source) {
    if (!source.enabled) return false;
    if (!source.lastRun) return true;
    const elapsed = Date.now() - Date.parse(source.lastRun);
    return elapsed >= source.intervalMinutes * 60 * 1000;
}

// One pass over every account's due sources. Returns the ids it swept.
//
// Only confirmed credentials count: a Reddit connection still waiting for its
// confirm click has nothing in `credentials` yet, so it is skipped.
export async function runDueSources(store) {
    const swept = [];
    for (const source of store.listAllSources()) {
        if (!isDue(source)) continue;
        // Manual sources have nothing to fetch — they fill from shares —
        // and nothing to redraw either, since the subtree is built fresh
        // on every read.
        if (isManualProvider(source.provider)) continue;
        if (!store.hasCredentials(source.id)) continue;
        const result = await runSource(store, source);
        swept.push(source.id);
        if (!result.ok) {
            console.warn(`[TabPaladin Imports] ${source.provider}#${source.id} failed: ${result.error}`);
        } else if (result.added) {
            console.log(`[TabPaladin Imports] ${source.provider}#${source.id}: +${result.added} new, ${result.fetched} seen`);
        }
    }
    return swept;
}

// A plain interval rather than a cron dependency — the server is already a
// long-lived process, and the schedule is "every N minutes" with no calendar
// semantics to get wrong.
export function startScheduler(store) {
    let running = false;
    const tick = async () => {
        if (running) return; // a slow sweep must not stack on the next tick
        running = true;
        try {
            await runDueSources(store);
        } catch (e) {
            console.warn('[TabPaladin Imports] scheduler tick failed:', e);
        } finally {
            running = false;
        }
    };

    const timer = setInterval(tick, TICK_MS);
    if (timer.unref) timer.unref(); // never hold the process open on its own
    return () => clearInterval(timer);
}
