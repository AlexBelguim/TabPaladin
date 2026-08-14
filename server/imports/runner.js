// Runs a source: refresh token -> sweep the listing -> archive -> project.

import * as reddit from './reddit.js';
import { buildProviderFolder, applyProviderFolder } from './project.js';

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

// Fetch + archive. Split out from projection so tests can drive one without the
// other, and so a projection repair does not need to hit the network.
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

// Rebuild this source's subtree from the archive and commit only if it changed.
// Committing unconditionally would burn a slot in the snapshot history every
// tick and push a pointless pull at every device.
export function projectSource(store, source, { latestSnapshot, commitSnapshot }) {
    const snapshot = latestSnapshot();
    if (!snapshot) return { projected: false, reason: 'no snapshot on server yet' };

    const items = store.itemsFor(source.id);
    const listTitle = source.config.listTitle || 'Saved';
    const folder = buildProviderFolder({ provider: source.provider, listTitle, items });

    if (!applyProviderFolder(snapshot, folder)) return { projected: false, reason: 'no change' };

    commitSnapshot(snapshot, 'importer');
    return { projected: true, items: items.length };
}

export async function runSource(store, source, ctx) {
    try {
        const swept = await sweepSource(store, source);
        const projected = projectSource(store, source, ctx);
        store.markRun(source.id, { status: 'ok' });
        return { ok: true, ...swept, ...projected };
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

// A plain interval rather than a cron dependency — the server is already a
// long-lived process, and the schedule is "every N minutes" with no calendar
// semantics to get wrong.
export function startScheduler(store, ctx) {
    let running = false;
    const tick = async () => {
        if (running) return; // a slow sweep must not stack on the next tick
        running = true;
        try {
            for (const source of store.listSources()) {
                if (!isDue(source)) continue;
                if (!store.hasCredentials(source.id)) continue;
                const result = await runSource(store, source, ctx);
                if (!result.ok) {
                    console.warn(`[TabPaladin Imports] ${source.provider}#${source.id} failed: ${result.error}`);
                } else if (result.added || result.projected) {
                    console.log(`[TabPaladin Imports] ${source.provider}#${source.id}: +${result.added} new, ${result.fetched} seen`);
                }
            }
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
