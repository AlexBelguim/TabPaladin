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
})();
