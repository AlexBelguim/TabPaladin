const api = typeof browser !== 'undefined' ? browser : chrome;
const $ = id => document.getElementById(id);
let configuredPattern = null;
const status = text => { $('status').textContent = text; };
const call = async (op, body = {}) => {
    const reply = await api.runtime.sendMessage({ channel: 'tp-helper-options', op, body });
    if (!reply?.ok) throw new Error(reply?.error?.message || reply?.error || 'The helper is restarting. Try again.');
    return reply.data;
};
const act = fn => async () => { try { await fn(); await refresh(); } catch (e) { status(e.message); } };
function parsed() { return globalThis.TPHelper.parseOrigin($('origin').value, $('insecure').checked); }
function showHost() { try { const p = parsed(); $('host').textContent = 'Server: ' + p.serverOrigin; } catch (e) { $('host').textContent = e.message; } }
$('origin').addEventListener('input', showHost);
$('insecure').addEventListener('change', showHost);
$('connect').addEventListener('click', () => {
    let p; try { p = parsed(); } catch (e) { status(e.message); return; }
    // Must be the first asynchronous browser call in this click (Firefox).
    const requested = api.permissions.request({ origins: [p.pattern] });
    status('Checking the server identity…');
    requested.then(async granted => {
        if (!granted) throw new Error('Server access was not granted.');
        try {
            await call('configure', { origin: p.serverOrigin, insecureAck: $('insecure').checked, repin: $('repin').checked });
        } catch (e) {
            const old = (await api.storage.local.get('tpHelper')).tpHelper;
            if (old?.serverOrigin !== p.serverOrigin) await api.permissions.remove({ origins: [p.pattern] });
            throw e;
        }
        $('repin').checked = false;
        await call('open', { hash: '#/signin' });
        status('Connected. Sign in in the web app.'); await refresh();
    }).catch(e => status(e.message));
});
$('disconnect').addEventListener('click', act(async () => { await call('disconnect'); status('Helper disconnected. Saved copies and queues are kept.'); }));
$('signin').addEventListener('click', act(() => call('open', { hash: '#/signin' })));
$('policy').addEventListener('change', act(() => call('policy', { windowClosePolicy: $('policy').value })));
$('stopTracking').addEventListener('click', act(() => call('stopTracking')));
$('reopen').addEventListener('click', act(() => call('reopen')));
$('import').addEventListener('click', act(async () => {
    const tree = await api.bookmarks.getTree();
    await call('stageBookmarks', { tree, browser: typeof browser !== 'undefined' ? 'Firefox' : 'Browser' });
    status('Bookmarks staged. Confirm the import in the web app within ten minutes.');
}));
$('video').addEventListener('change', () => {
    const on = $('video').checked;
    // Preserve the exact server grant before removing all-sites access.
    const requested = on ? api.permissions.request({ origins: ['<all_urls>'] })
        : configuredPattern ? api.permissions.request({ origins: [configuredPattern] }) : Promise.resolve(true);
    requested.then(async granted => {
        if (!granted) throw new Error('Access was not granted.');
        await api.storage.local.set({ tpVideoSeek: on });
        if (!on) await api.permissions.remove({ origins: ['<all_urls>'] });
        await refresh();
    }).catch(e => { $('video').checked = !on; status(e.message); });
});
async function refresh() {
    const d = await api.storage.local.get(['tpHelper', 'settings', 'tpOpenWorkflowTabs', 'tpHelperRemovals', 'tpHelperRecentlyClosed', 'tpHelperCalls', 'tpVideoSeek', 'tpHelperSession']);
    const c = d.tpHelper || {};
    configuredPattern = c.pattern || null;
    if (!$('origin').value) $('origin').value = c.serverOrigin || d.settings?.backend?.url || '';
    $('insecure').checked = !!c.insecureAck; $('policy').value = c.windowClosePolicy || 'keep';
    $('identity').textContent = c.pin ? 'Pinned server: ' + c.pin.serverId + (c.enabled === false ? ' · disconnected' : '') + (c.identityError ? ' · ' + c.identityError : '') : 'No server identity pinned yet.';
    const session = d.tpHelperSession?.origin === c.serverOrigin && d.tpHelperSession?.serverId === c.pin?.serverId ? d.tpHelperSession : null;
    $('account').textContent = session?.signedIn ? 'Web app signed in as ' + (session.username || 'an account') : 'Sign in in the web app. Credentials stay there.';
    $('tracking').textContent = Object.keys(d.tpOpenWorkflowTabs || {}).length + ' tracked tabs · ' + (d.tpHelperRemovals || []).length + ' queued removals';
    $('recent').textContent = (d.tpHelperRecentlyClosed || []).filter(t => t.origin === c.serverOrigin).slice(-20).map(t => t.title || t.url).join('\n') || 'No recently closed tabs.';
    $('calls').textContent = (d.tpHelperCalls || []).slice(-50).map(c => new Date(c.at).toLocaleString() + ' · ' + c.op + ' · ' + (c.origin || '')).join('\n') || 'No bridge calls yet.';
    $('video').checked = !!d.tpVideoSeek; $('version').textContent = api.runtime.getManifest().version;
    showHost();
}
$('privacy').removeAttribute('href');
api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && Object.keys(changes).some(k => k.startsWith('tpHelper') || k === 'tpOpenWorkflowTabs')) refresh().catch(e => status(e.message));
});
refresh().then(() => status('Choose your server to connect the web app.')).catch(e => status(e.message));
