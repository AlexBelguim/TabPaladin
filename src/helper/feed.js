// A folder of saved X or Instagram posts as a feed: the web app hands over
// the folder's post links (feed.open, from a click), the helper opens the
// first in a new tab and keeps the list for that tab, and the feed script
// (src/content/feed.js) shows where in the folder you are, with next and
// previous going through it. Like the YouTube button, the script is
// optional: registered only while helper Settings has feeds switched on and
// those sites' access is granted. Only post links are kept, in session
// storage, and only for that tab.
(() => {
    'use strict';
    const H = globalThis.TPHelper;
    const api = H.api;
    const FEED_ID = 'tp-feed';
    const FEED_KEY = 'tpFeeds';
    const SITES = { origins: ['https://x.com/*', 'https://twitter.com/*', 'https://www.instagram.com/*'] };
    const FEEDS = 'tpFeedLists';

    // A post's identity whatever form its link takes: an X status id, an
    // Instagram shortcode (posts, reels and tv, with or without a username).
    const postKey = (raw) => {
        try {
            const u = new URL(raw);
            const host = u.hostname.replace(/^(www|mobile)\./, '');
            if (host === 'x.com' || host === 'twitter.com') {
                const m = u.pathname.match(/\/status(?:es)?\/(\d{1,25})/);
                return m ? 'x:' + m[1] : null;
            }
            if (host === 'instagram.com') {
                const m = u.pathname.match(/^\/(?:[^/]+\/)?(p|reels?|tv)\/([A-Za-z0-9_-]{5,40})/);
                return m ? 'ig:' + m[1].replace('reels', 'reel') + ':' + m[2] : null;
            }
            return null;
        } catch (_) { return null; }
    };
    const urlFor = (key) => {
        const [site, a, b] = key.split(':');
        return site === 'x' ? 'https://x.com/i/status/' + a : 'https://www.instagram.com/' + a + '/' + b + '/';
    };
    const sameKey = (a, b) => a && b && a.replace(/^ig:[a-z]+:/, 'ig:') === b.replace(/^ig:[a-z]+:/, 'ig:');

    let chain = Promise.resolve();
    const withFeeds = (fn) => {
        const run = chain.then(async () => {
            const all = (await H.temporary.get(FEEDS))[FEEDS] || {};
            const out = await fn(all);
            await H.temporary.set({ [FEEDS]: all });
            return out;
        });
        chain = run.catch(() => {});
        return run;
    };

    H.handlers['feed.open'] = async (body, ctx) => {
        await H.assertContext(ctx);
        const keys = [];
        for (const url of Array.isArray(body.urls) ? body.urls : []) {
            const key = typeof url === 'string' && url.length <= 2048 ? postKey(url) : null;
            if (key && !keys.some(k => sameKey(k, key))) keys.push(key);
            if (keys.length >= 1000) break;
        }
        if (!keys.length) H.fail('bad-args', 'No X or Instagram posts in this folder.');
        const registered = api.scripting && api.scripting.getRegisteredContentScripts
            && (await api.scripting.getRegisteredContentScripts({ ids: [FEED_ID] })).length;
        if (!registered) H.fail('feeds-off', 'Turn on feeds for X and Instagram in helper Settings first.');
        const win = await api.windows.get(ctx.sender.tab.windowId);
        const tab = await api.tabs.create({ url: urlFor(keys[0]), active: true,
            ...(win && win.type === 'normal' && !win.incognito ? { windowId: win.id } : {}) });
        const title = String(body.title || '').slice(0, 200);
        await withFeeds((all) => {
            for (const k of Object.keys(all)) if (Date.now() - all[k].at > 7 * 24 * 3600 * 1000) delete all[k];
            all[tab.id] = { title, keys, index: 0, at: Date.now() };
        });
        return { tabId: tab.id, count: keys.length };
    };
    H.ops.push('feed.open');

    // The feed script asks where its page is in the tab's folder ('get'), and
    // for the next, the previous, or a numbered post ('go').
    api.runtime.onMessage.addListener((message, sender, reply) => {
        if (!message || message.channel !== 'tp-feed') return;
        const ok = sender && sender.id === api.runtime.id && sender.tab && !sender.tab.incognito && sender.frameId === 0
            && /^https:\/\/(x\.com|twitter\.com|www\.instagram\.com)\//.test(String(sender.url || ''));
        if (!ok) { reply({ ok: false }); return; }
        // The page's own address: both sites move between posts without a load.
        let key = null;
        try { if (new URL(message.url).origin === new URL(sender.url).origin) key = postKey(message.url); } catch (_) { /* not a URL */ }
        if (!key) key = postKey(sender.url);
        withFeeds((all) => {
            const feed = all[sender.tab.id];
            if (!feed) return { feed: null };
            const at = feed.keys.findIndex(k => sameKey(k, key));
            if (message.op === 'get') {
                if (at < 0) return { feed: null };
                feed.index = at;
                feed.at = Date.now();
                return { feed: { title: feed.title, index: at, count: feed.keys.length } };
            }
            if (message.op === 'go') {
                const next = Number.isInteger(message.to) ? message.to : (at >= 0 ? at : feed.index) + (message.dir === -1 ? -1 : 1);
                if (next < 0 || next >= feed.keys.length) return { end: true };
                feed.index = next;
                feed.at = Date.now();
                return { url: urlFor(feed.keys[next]) };
            }
            return {};
        }).then(r => reply({ ok: true, ...r }), e => reply({ ok: false, message: e.message }));
        return true;
    });
    api.tabs.onRemoved.addListener((tabId) => {
        withFeeds((all) => { delete all[tabId]; }).catch(() => {});
    });

    // The switch: the script runs only while it is on and access is granted.
    async function tellTabs() {
        let tabs = [];
        try { tabs = await api.tabs.query({ url: SITES.origins }); } catch (_) { return; }
        for (const t of tabs) {
            try { const sent = api.tabs.sendMessage(t.id, { type: 'tp-feed-off' }); if (sent && sent.catch) sent.catch(() => {}); } catch (_) { /* no script */ }
        }
    }
    let run = Promise.resolve();
    async function syncNow() {
        if (!api.scripting || !api.scripting.registerContentScripts) return;
        try {
            const wanted = Boolean((await api.storage.local.get(FEED_KEY))[FEED_KEY]);
            const granted = await api.permissions.contains(SITES);
            const existing = await api.scripting.getRegisteredContentScripts({ ids: [FEED_ID] });
            if (wanted && granted && !existing.length) {
                const script = { id: FEED_ID, matches: SITES.origins, js: ['src/content/feed.js'], runAt: 'document_idle' };
                try { await api.scripting.registerContentScripts([{ ...script, persistAcrossSessions: true }]); }
                catch (_) { await api.scripting.registerContentScripts([script]); }
            } else if ((!wanted || !granted) && existing.length) {
                await api.scripting.unregisterContentScripts({ ids: [FEED_ID] });
                await tellTabs();
            }
        } catch (e) {
            console.warn('TabPaladin: could not update feeds', e);
        }
    }
    const sync = () => { run = run.then(syncNow, syncNow); return run; };
    sync();
    api.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes[FEED_KEY]) sync(); });
    if (api.permissions && api.permissions.onAdded) {
        api.permissions.onAdded.addListener(sync);
        api.permissions.onRemoved.addListener(sync);
    }
})();
