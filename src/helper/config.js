// Shared helpers are classic scripts in both extension backgrounds.
(() => {
    const H = globalThis.TPHelper = globalThis.TPHelper || {};
    H.api = typeof browser !== 'undefined' ? browser : chrome;
    H.session = H.api.storage.session || H.api.storage.local;
    H.attached = new Map();
    H.fail = (code, message, retryable = false) => { throw Object.assign(new Error(message), { code, retryable }); };
    H.randomId = () => crypto.randomUUID();
    H.originOf = value => { try { return new URL(value).origin; } catch (_) { return ''; } };
    H.parseOrigin = (value, insecureAck = false) => {
        let u;
        try { u = new URL(String(value).trim()); } catch (_) { H.fail('bad-origin', 'Enter a complete server origin, including https://.'); }
        if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) {
            H.fail('bad-origin', 'Use only the server origin, without a path, credentials, query or fragment.');
        }
        if (u.hostname.includes('*')) H.fail('bad-origin', 'Choose one server host, not a wildcard.');
        if (u.hostname.endsWith('.')) u.hostname = u.hostname.slice(0, -1);
        const host = u.hostname;
        const octets = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host.split('.').map(Number) : null;
        const loopback = host === 'localhost' || host.endsWith('.localhost') || Boolean(octets && octets[0] === 127) || host === '[::1]';
        const privateV4 = octets && (octets[0] === 10 || octets[0] === 192 && octets[1] === 168
            || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31
            || octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127);
        const privateV6 = /^\[(?:f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i.test(host);
        const localName = !host.includes('.') && !host.includes(':') || /\.(local|lan|internal)$/.test(host);
        if (u.protocol === 'http:' && !loopback && !(insecureAck && (privateV4 || privateV6 || localName))) {
            H.fail('bad-origin', 'Use HTTPS, or acknowledge unencrypted HTTP for a private network address.');
        }
        // Extension match patterns do not carry ports; the router checks the exact origin.
        return { serverOrigin: u.origin, pattern: `${u.protocol}//${u.hostname}/*`, insecureAck: Boolean(insecureAck) };
    };
    H.getConfig = async () => {
        const { tpHelper } = await H.api.storage.local.get('tpHelper');
        return { windowClosePolicy: 'keep', enabled: false, ...(tpHelper || {}) };
    };
    let configChain = Promise.resolve();
    H.configure = (origin, insecureAck, { repin = false } = {}) => {
        const run = configChain.then(async () => {
            const next = H.parseOrigin(origin, insecureAck);
            const old = await H.getConfig();
            if (!await H.api.permissions.contains({ origins: [next.pattern] })) H.fail('permission-missing', 'Grant access to this server from the Connect button.');
            // Gate the old document before changing anything, even if the new server is unreachable.
            await H.api.storage.local.set({ tpHelper: { ...old, enabled: false } });
            if (H.stopBridge) await H.stopBridge('Server connection is changing.');
            const identity = await H.fetchIdentity(next.serverOrigin);
            const knownPin = old.serverOrigin === next.serverOrigin ? old.pin : old.pins?.[next.serverOrigin];
            if (knownPin && !repin && !H.sameIdentity(knownPin, identity)) {
                H.fail('identity-mismatch', 'The server identity changed. Check your server and explicitly pin its new identity in Settings.');
            }
            const pin = { serverId: identity.serverId, publicKeyJwk: identity.publicKeyJwk, pinnedAt: Date.now() };
            const pins = { ...(old.pins || {}), ...(old.serverOrigin && old.pin ? { [old.serverOrigin]: old.pin } : {}), [next.serverOrigin]: pin };
            const config = { ...old, ...next, pin, pins, enabled: true, setupAt: old.setupAt || Date.now(), session: null, identityError: null };
            await H.session.remove(['tpHelperIdentityCheck', 'tpHelperDedup']);
            await H.api.storage.local.set({ tpHelper: config, tpHelperSession: null });
            if (old.pattern && old.pattern !== next.pattern) {
                // A new address retains its old data, but no longer needs its old host grant.
                await H.api.permissions.remove({ origins: [old.pattern] });
            }
            if (H.ensureBridge) await H.ensureBridge();
            return config;
        });
        configChain = run.catch(() => {});
        return run;
    };
    H.disconnect = async () => {
        const config = await H.getConfig();
        await H.api.storage.local.set({ tpHelper: { ...config, enabled: false, session: null }, tpHelperSession: null });
        if (H.stopBridge) await H.stopBridge('Disconnected. Use Reconnect in helper Settings.');
        return { disconnected: true };
    };
})();
