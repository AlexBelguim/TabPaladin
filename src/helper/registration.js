(() => {
    const H = globalThis.TPHelper;
    const api = H.api;
    let chain = Promise.resolve();
    H.badge = async problem => {
        const action = api.action || api.browserAction;
        try { if (action && action.setBadgeText) await action.setBadgeText({ text: problem ? '!' : '' }); } catch (_) { /* cosmetic */ }
    };
    H.sendEvent = async (tabId, event, body = {}, documentId) => {
        const attached = H.attached.get(tabId);
        if (event !== 'helper.detached') {
            const config = await H.getConfig();
            if (!config.enabled || !attached || attached.origin !== config.serverOrigin) return;
            let tab;
            try { tab = await api.tabs.get(tabId); } catch (_) { return; }
            if (tab.incognito || H.originOf(tab.url) !== config.serverOrigin) return;
            if (event === 'tabs.changed') {
                if (!attached.visible || !tab.active) return;
                const win = await api.windows.get(tab.windowId);
                if (!win.focused || win.incognito) return;
            }
        }
        const target = documentId || (attached && attached.documentId);
        const options = target && typeof browser === 'undefined' ? { documentId: target } : { frameId: 0 };
        try { await api.tabs.sendMessage(tabId, { channel: 'tp-bridge-evt', event, body }, options); } catch (_) { /* event hints may be missed */ }
    };
    H.stopBridge = async reason => {
        try { await api.scripting.unregisterContentScripts({ ids: ['tp-bridge'] }); } catch (_) { /* absent */ }
        const attached = [...H.attached];
        H.attached.clear();
        for (const [tabId, info] of attached) await H.sendEvent(tabId, 'helper.detached', { reason }, info.documentId);
        await H.badge(true);
    };
    async function ensureNow() {
        const config = await H.getConfig();
        if (!config.enabled || !config.serverOrigin || !config.pin) { await H.stopBridge('Connect in helper Settings.'); return false; }
        let expected;
        try { expected = H.parseOrigin(config.serverOrigin, config.insecureAck); } catch (e) { await H.stopBridge(e.message); return false; }
        if (expected.pattern !== config.pattern || !await api.permissions.contains({ origins: [config.pattern] })) {
            await H.stopBridge('Server permission is missing. Reconnect in helper Settings.'); return false;
        }
        try { await H.verifyIdentity(config, { force: true }); } catch (e) { await H.stopBridge(e.message); return false; }
        const currentConfig = await H.getConfig();
        if (!currentConfig.enabled || currentConfig.serverOrigin !== config.serverOrigin || !H.sameIdentity(currentConfig.pin, config.pin)) return false;
        const base = config.pattern.slice(0, -1);
        const wanted = { id: 'tp-bridge', matches: [config.pattern], excludeMatches: [`${base}api/*`, `${base}llm/*`, `${base}share*`], js: ['src/helper/bridge.js'], runAt: 'document_start', allFrames: false };
        const registered = await api.scripting.getRegisteredContentScripts({ ids: ['tp-bridge'] });
        const old = registered[0];
        const matches = old && ['matches', 'excludeMatches', 'js', 'runAt'].every(k => JSON.stringify(old[k]) === JSON.stringify(wanted[k])) && !old.allFrames;
        if (!matches) {
            await H.stopBridge('Refreshing the helper connection.');
            try { await api.scripting.registerContentScripts([{ ...wanted, persistAcrossSessions: true }]); }
            catch (_) { await api.scripting.registerContentScripts([wanted]); }
        }
        // Re-inject packaged files after worker/extension updates; the isolated-world guard is idempotent.
        for (const tab of await api.tabs.query({ url: config.pattern })) {
            if (tab.incognito || H.originOf(tab.url) !== config.serverOrigin) continue;
            const path = new URL(tab.url).pathname;
            if (/^\/(api|llm)(\/|$)/.test(path) || path.startsWith('/share')) continue;
            try { await api.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ['src/helper/bridge.js'] }); } catch (_) { /* a closing or restricted tab */ }
        }
        await H.badge(false);
        return true;
    }
    H.ensureBridge = () => { const run = chain.then(ensureNow, ensureNow); chain = run.catch(() => {}); return run; };
})();
