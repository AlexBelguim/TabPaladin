(() => {
    const H = globalThis.TPHelper;
    const canonicalKey = k => JSON.stringify(k && { kty: k.kty, crv: k.crv, x: k.x, y: k.y });
    H.sameIdentity = (a, b) => a && b && a.serverId === b.serverId && canonicalKey(a.publicKeyJwk) === canonicalKey(b.publicKeyJwk);
    H.fetchIdentity = async origin => {
        const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), x => x.toString(16).padStart(2, '0')).join('');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        let response;
        try {
            response = await fetch(`${origin}/api/identity?nonce=${nonce}`, {
                redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal
            });
        } catch (_) {
            H.fail('identity-unreachable', 'The server identity could not be checked. Check its address and connection.', true);
        } finally { clearTimeout(timer); }
        if (!response.ok) H.fail('identity-unavailable', 'The server did not provide its identity. Check the server before reconnecting.', true);
        let data;
        try { data = await response.json(); } catch (_) { H.fail('identity-mismatch', 'The server identity response is invalid.'); }
        const k = data && data.publicKeyJwk;
        if (!data || data.app !== 'tabpaladin' || data.alg !== 'ES256' || data.nonce !== nonce
            || typeof data.serverId !== 'string' || !data.serverId || data.serverId.length > 256
            || !k || k.kty !== 'EC' || k.crv !== 'P-256' || typeof k.x !== 'string' || typeof k.y !== 'string'
            || k.d || typeof data.sig !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(data.sig)) {
            H.fail('identity-mismatch', 'The server identity response is invalid.');
        }
        let valid = false;
        try {
            const key = await crypto.subtle.importKey('jwk', { kty: k.kty, crv: k.crv, x: k.x, y: k.y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
            const signature = Uint8Array.from(atob(data.sig.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
            valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature,
                new TextEncoder().encode(`tp-identity|1|${nonce}|${data.serverId}`));
        } catch (_) { /* invalid keys and signatures are identity failures */ }
        if (!valid) H.fail('identity-mismatch', 'The server identity signature is wrong. Check the server before connecting.');
        return { serverId: data.serverId, publicKeyJwk: { kty: k.kty, crv: k.crv, x: k.x, y: k.y } };
    };
    H.verifyIdentity = async (config, { force = false } = {}) => {
        if (!config.serverOrigin || !config.pin) H.fail('not-configured', 'Connect to and pin a server in helper Settings.');
        if (config.identityError) H.fail('identity-mismatch', config.identityError);
        const cache = (await H.session.get('tpHelperIdentityCheck')).tpHelperIdentityCheck;
        if (!force && cache && cache.origin === config.serverOrigin && H.sameIdentity(cache, config.pin) && Date.now() - cache.at < 600000) return config.pin;
        try {
            const identity = await H.fetchIdentity(config.serverOrigin);
            if (!H.sameIdentity(config.pin, identity)) H.fail('identity-mismatch', 'The pinned server identity changed. Check your server, then explicitly pin its new identity in Settings.');
            await H.session.set({ tpHelperIdentityCheck: { ...identity, origin: config.serverOrigin, at: Date.now() } });
            return config.pin;
        } catch (error) {
            if (error.code === 'identity-unreachable' && config.serverOrigin.startsWith('https://')) return { ...config.pin, offline: true };
            if (error.code === 'identity-mismatch') {
                const current = await H.getConfig();
                if (current.serverOrigin === config.serverOrigin && H.sameIdentity(current.pin, config.pin)) {
                    await H.api.storage.local.set({ tpHelper: { ...current, enabled: false, identityError: error.message } });
                    if (H.stopBridge) await H.stopBridge(error.message);
                }
            }
            throw error;
        }
    };
})();
