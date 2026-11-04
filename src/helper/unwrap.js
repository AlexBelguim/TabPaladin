// Linkvertise "dynamic" links carry their destination, base64-encoded, in
// ?r=. A tab that lands on one goes straight to it.
(() => {
    const H = globalThis.TPHelper, api = H.api;
    const HOSTS = ['linkvertise.com', 'link-to.net', 'up-to-down.net', 'direct-link.net', 'link-center.net', 'link-hub.net', 'link-target.net', 'file-link.net'];
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
})();
