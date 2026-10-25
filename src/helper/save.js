// Save a link: a page's right-click menu and the YouTube button open the web
// app's Save link sheet (its share entry, /?share=1) in a small popup window.
// The sheet files the link in the web app's own copy, so nothing is written
// here; the window closes itself once the link is filed.
//
// The YouTube button is optional, like video seek: a content script for
// youtube.com, registered only while helper Settings has it switched on and
// that site's access is granted.
(() => {
    'use strict';
    const H = globalThis.TPHelper;
    const api = H.api;
    const YOUTUBE_ID = 'tp-youtube-save';
    const YOUTUBE_KEY = 'tpYouTubeSave';
    const YOUTUBE = { origins: ['https://www.youtube.com/*', 'https://m.youtube.com/*'] };
    let lastOpen = 0;

    H.openSave = async ({ url, title } = {}) => {
        let link;
        try { link = new URL(String(url || '')); } catch (_) { H.fail('bad-args', 'Nothing to save on this page.'); }
        if (!/^https?:$/.test(link.protocol) || link.href.length > 4096) H.fail('bad-args', 'Only web pages can be saved.');
        const config = await H.getConfig();
        if (!config || !config.serverOrigin || !config.pin) {
            await api.runtime.openOptionsPage();
            H.fail('not-configured', 'Connect your server in Settings first.');
        }
        if (Date.now() - lastOpen < 1000) H.fail('rate-limited', 'Already opening.');
        lastOpen = Date.now();
        const query = new URLSearchParams({ share: '1', url: link.href, title: String(title || '').slice(0, 500) });
        const target = config.serverOrigin + '/?' + query.toString();
        const props = { url: target, type: 'popup', width: 480, height: 720 };
        try {
            const current = await api.windows.getLastFocused();
            if (current && Number.isFinite(current.left)) {
                props.left = Math.max(0, current.left + (current.width || 1200) - props.width - 40);
                props.top = Math.max(0, (current.top || 0) + 80);
            }
        } catch (_) { /* default placement */ }
        await api.windows.create(props);
        return { opened: true };
    };

    // The YouTube button asks from its own page; only that page's link is saved.
    api.runtime.onMessage.addListener((message, sender, reply) => {
        if (!message || message.channel !== 'tp-youtube-save') return;
        const ok = sender && sender.id === api.runtime.id && sender.tab && !sender.tab.incognito && sender.frameId === 0
            && /^https:\/\/(www|m)\.youtube\.com\//.test(String(sender.url || ''));
        if (!ok) { reply({ ok: false, message: 'Not allowed here.' }); return; }
        let url = String(sender.url);
        try { if (new URL(message.url).origin === new URL(url).origin) url = message.url; } catch (_) { /* keep the page's own */ }
        H.openSave({ url, title: message.title }).then(() => reply({ ok: true }), e => reply({ ok: false, message: e.message }));
        return true;
    });

    async function tellYouTubeTabs(type) {
        let tabs = [];
        try { tabs = await api.tabs.query({ url: YOUTUBE.origins }); } catch (_) { return; }
        for (const t of tabs) {
            try { const sent = api.tabs.sendMessage(t.id, { type }); if (sent && sent.catch) sent.catch(() => {}); } catch (_) { /* no script */ }
        }
    }
    let run = Promise.resolve();
    async function syncNow() {
        if (!api.scripting || !api.scripting.registerContentScripts) return;
        try {
            const wanted = Boolean((await api.storage.local.get(YOUTUBE_KEY))[YOUTUBE_KEY]);
            const granted = await api.permissions.contains(YOUTUBE);
            const existing = await api.scripting.getRegisteredContentScripts({ ids: [YOUTUBE_ID] });
            if (wanted && granted && !existing.length) {
                const script = { id: YOUTUBE_ID, matches: YOUTUBE.origins, js: ['src/content/youtubeSave.js'], runAt: 'document_idle' };
                try { await api.scripting.registerContentScripts([{ ...script, persistAcrossSessions: true }]); }
                catch (_) { await api.scripting.registerContentScripts([script]); }
                // Open YouTube tabs get the button without a reload.
                for (const t of await api.tabs.query({ url: YOUTUBE.origins })) {
                    try { await api.scripting.executeScript({ target: { tabId: t.id }, files: ['src/content/youtubeSave.js'] }); } catch (_) { /* a page it cannot reach */ }
                }
            } else if ((!wanted || !granted) && existing.length) {
                await api.scripting.unregisterContentScripts({ ids: [YOUTUBE_ID] });
                await tellYouTubeTabs('tp-youtube-save-off');
            }
        } catch (e) {
            console.warn('TabPaladin: could not update the YouTube button', e);
        }
    }
    const sync = () => { run = run.then(syncNow, syncNow); return run; };
    sync();
    api.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes[YOUTUBE_KEY]) sync(); });
    if (api.permissions && api.permissions.onAdded) {
        api.permissions.onAdded.addListener(sync);
        api.permissions.onRemoved.addListener(sync);
    }

    // --- A YouTube folder as a Shorts playlist ------------------------------
    //
    // The web app hands over a folder's Shorts (youtube.playlist, from a
    // click). The tab opened for it keeps that list: on its pages the YouTube
    // script steps through the folder with the Shorts arrows, the wheel and
    // the arrow keys instead of YouTube's feed. Only video ids are kept, in
    // session storage, and only for that tab.
    const PLAYLISTS = 'tpYouTubePlaylists';
    const ID = /^[A-Za-z0-9_-]{6,20}$/;
    const videoId = (raw) => {
        try {
            const u = new URL(raw);
            let id = null;
            if (u.hostname === 'youtu.be') id = u.pathname.split('/')[1];
            else if (/(^|\.)youtube\.com$/.test(u.hostname)) {
                if (u.pathname === '/watch') id = u.searchParams.get('v');
                else { const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([^/?#]+)/); if (m) id = m[1]; }
            }
            return id && ID.test(id) ? id : null;
        } catch (_) { return null; }
    };
    let playlistChain = Promise.resolve();
    const withPlaylists = (fn) => {
        const run = playlistChain.then(async () => {
            const all = (await H.temporary.get(PLAYLISTS))[PLAYLISTS] || {};
            const out = await fn(all);
            await H.temporary.set({ [PLAYLISTS]: all });
            return out;
        });
        playlistChain = run.catch(() => {});
        return run;
    };

    // A video opens where it belongs: a Short in the Shorts player, the rest
    // on the video page.
    const watchUrl = (pl, i) => pl.shorts && pl.shorts[i] === false
        ? 'https://www.youtube.com/watch?v=' + pl.ids[i] : 'https://www.youtube.com/shorts/' + pl.ids[i];

    H.handlers['youtube.playlist'] = async (body, ctx) => {
        await H.assertContext(ctx);
        // videos: [{id, short}]; ids: Shorts only (helper 1.10's web app).
        const given = Array.isArray(body.videos) ? body.videos : Array.isArray(body.ids) ? body.ids.map(id => ({ id, short: true })) : [];
        const ids = [], shorts = [];
        for (const v of given) {
            if (!v || typeof v.id !== 'string' || !ID.test(v.id) || ids.includes(v.id)) continue;
            ids.push(v.id);
            shorts.push(v.short !== false);
            if (ids.length >= 5000) break;
        }
        if (!ids.length) H.fail('bad-args', 'No YouTube videos in this folder.');
        const registered = api.scripting && api.scripting.getRegisteredContentScripts
            && (await api.scripting.getRegisteredContentScripts({ ids: [YOUTUBE_ID] })).length;
        if (!registered) H.fail('youtube-off', 'Turn on the YouTube button in helper Settings first.');
        const win = await api.windows.get(ctx.sender.tab.windowId);
        const tab = await api.tabs.create({ url: watchUrl({ ids, shorts }, 0), active: true,
            ...(win && win.type === 'normal' && !win.incognito ? { windowId: win.id } : {}) });
        const title = String(body.title || '').slice(0, 200);
        await withPlaylists((all) => {
            for (const k of Object.keys(all)) if (Date.now() - all[k].at > 7 * 24 * 3600 * 1000) delete all[k];
            all[tab.id] = { title, ids, shorts, index: 0, at: Date.now() };
        });
        return { tabId: tab.id, count: ids.length };
    };
    H.ops.push('youtube.playlist');

    // The YouTube script asks where its page is in the tab's folder ('get'),
    // and for the next or previous video ('go').
    api.runtime.onMessage.addListener((message, sender, reply) => {
        if (!message || message.channel !== 'tp-youtube-playlist') return;
        const ok = sender && sender.id === api.runtime.id && sender.tab && !sender.tab.incognito && sender.frameId === 0
            && /^https:\/\/(www|m)\.youtube\.com\//.test(String(sender.url || ''));
        if (!ok) { reply({ ok: false }); return; }
        // The page's own address: YouTube moves between videos without a load.
        let id = null;
        try { if (new URL(message.url).origin === new URL(sender.url).origin) id = videoId(message.url); } catch (_) { /* not a URL */ }
        if (!id) id = videoId(sender.url);
        withPlaylists((all) => {
            const pl = all[sender.tab.id];
            if (!pl) return { playlist: null };
            const at = pl.ids.indexOf(id);
            if (message.op === 'get') {
                if (at < 0) return { playlist: null };
                pl.index = at;
                pl.at = Date.now();
                return { playlist: { title: pl.title, index: at, count: pl.ids.length } };
            }
            if (message.op === 'go') {
                // dir: one step; to: a place in the folder, typed into the panel.
                const next = Number.isInteger(message.to) ? message.to : (at >= 0 ? at : pl.index) + (message.dir === -1 ? -1 : 1);
                if (next < 0 || next >= pl.ids.length) return { end: true };
                pl.index = next;
                pl.at = Date.now();
                return { url: watchUrl(pl, next) };
            }
            return {};
        }).then(r => reply({ ok: true, ...r }), e => reply({ ok: false, message: e.message }));
        return true;
    });
    api.tabs.onRemoved.addListener((tabId) => {
        withPlaylists((all) => { delete all[tabId]; }).catch(() => {});
    });
})();
