// Linkvertise "dynamic" links carry their destination, base64-encoded, in
// ?r=. A tab that lands on one goes straight to it.
// Other Linkvertise and Lootlabs link pages are skipped by the link-locker
// scripts (src/content/unlock.js, and src/content/unlockPage.js in the page's
// own world), registered only while helper Settings has them switched on and
// those sites' access is granted.
(() => {
    const H = globalThis.TPHelper, api = H.api;
    const HOSTS = ['linkvertise.com', 'link-to.net', 'up-to-down.net', 'direct-link.net', 'link-center.net', 'link-hub.net', 'link-target.net', 'file-link.net'];
    const LOOT_HOSTS = ['speedy-links.com', 'loot-link.com', 'loot-links.com', 'lootlink.org', 'lootlinks.co', 'lootdest.org', 'lootdest.com', 'lootdest.info', 'links-loot.com', 'linksloot.net', 'best-links.org'];
    const LOCKERS = { origins: [...HOSTS, ...LOOT_HOSTS].map(h => `https://*.${h}/*`) };
    const UNLOCK_KEY = 'tpUnlock';
    // The page's side runs in the page's own world, where the page's security
    // policy cannot stop it (Chrome; Firefox 128 and later).
    const UNLOCK_SCRIPTS = [
        { id: 'tp-unlock', matches: LOCKERS.origins, js: ['src/content/unlock.js'], runAt: 'document_start' },
        { id: 'tp-unlock-page', matches: LOCKERS.origins, js: ['src/content/unlockPage.js'], runAt: 'document_start', world: 'MAIN' }
    ];
    const UNLOCK_IDS = UNLOCK_SCRIPTS.map(s => s.id);
    H.unwrapLink = (value) => {
        let u;
        try { u = new URL(value); } catch (_) { return null; }
        const host = u.hostname.replace(/^www\./, '');
        if (!HOSTS.includes(host) || !/\/dynamic\/?$/.test(u.pathname)) return null;
        // A raw + in the query reads back as a space.
        const r = (u.searchParams.get('r') || '').replace(/[ -]/g, '+').replace(/_/g, '/');
        if (!r) return null;
        let dest;
        try {
            const bytes = Uint8Array.from(atob(r), c => c.charCodeAt(0));
            dest = new URL(new TextDecoder().decode(bytes).trim());
        } catch (_) { return null; }
        return ['http:', 'https:'].includes(dest.protocol) ? dest.href : null;
    };
    if (api.tabs.onUpdated) api.tabs.onUpdated.addListener((tabId, info, tab) => {
        const dest = info.url && !(tab && tab.incognito) && H.unwrapLink(info.url);
        if (dest) api.tabs.update(tabId, { url: dest }).catch(() => {});
    });

    // The switch: the locker scripts run only while it is on and access is
    // granted. Pages already open keep them until they are reloaded. Each
    // script is registered on its own, so one this browser refuses (the
    // page's side, before Firefox 128) does not keep out the other, and an
    // update that adds a script registers just that one.
    let run = Promise.resolve();
    async function syncNow() {
        if (!api.scripting || !api.scripting.registerContentScripts) return;
        try {
            const wanted = Boolean((await api.storage.local.get(UNLOCK_KEY))[UNLOCK_KEY]);
            const granted = await api.permissions.contains(LOCKERS);
            const existing = (await api.scripting.getRegisteredContentScripts({ ids: UNLOCK_IDS })).map(s => s.id);
            if (wanted && granted) {
                for (const script of UNLOCK_SCRIPTS.filter(s => !existing.includes(s.id))) {
                    try { await api.scripting.registerContentScripts([{ ...script, persistAcrossSessions: true }]); }
                    catch (_) {
                        try { await api.scripting.registerContentScripts([script]); }
                        catch (e) { console.warn('TabPaladin: could not register ' + script.id, e); }
                    }
                }
            } else if (existing.length) {
                await api.scripting.unregisterContentScripts({ ids: existing });
            }
        } catch (e) {
            console.warn('TabPaladin: could not update link lockers', e);
        }
    }
    const sync = () => { run = run.then(syncNow, syncNow); return run; };
    H.syncLockers = sync;
    sync();
    if (api.storage && api.storage.onChanged) api.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes[UNLOCK_KEY]) sync(); });
    if (api.permissions && api.permissions.onAdded) {
        api.permissions.onAdded.addListener(sync);
        api.permissions.onRemoved.addListener(sync);
    }
})();
