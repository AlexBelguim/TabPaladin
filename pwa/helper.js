// Protocol 1 page client. The extension, rather than this page, enforces
// permission, identity, visibility and trusted-gesture checks.
const LIMIT = 1024 * 1024;
const fail = (code, message) => Object.assign(new Error(message), { code });
const plain = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function helperRequestId(crypto = globalThis.crypto) {
    if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return [...bytes].map(n => n.toString(16).padStart(2, '0')).join('');
}

export function createHelperClient({ win = globalThis.window, origin = globalThis.location?.origin,
    crypto = globalThis.crypto, timeout = 15000, schedule = setTimeout, cancel = clearTimeout } = {}) {
    let hello = null;
    let instance = null;
    let status = 'absent';
    let stopped = false;
    const helpers = new Set();
    const pending = new Map();
    const listeners = new Set();
    const timers = new Set();
    const notify = (event, body) => { for (const fn of listeners) { try { fn(event, body); } catch (e) { /* listener */ } } };
    function later(fn, ms) {
        const id = schedule(() => { timers.delete(id); fn(); }, ms);
        timers.add(id);
        if (id && typeof id.unref === 'function') id.unref();
        return id;
    }
    function rejectAll(message) {
        for (const p of pending.values()) { cancel(p.timer); p.reject(fail('unavailable', message)); }
        pending.clear();
    }
    function detach(reason) {
        hello = null;
        instance = null;
        status = reason;
        rejectAll('The helper disconnected. Try again after it reconnects.');
        notify('status', status);
    }
    function post(envelope) {
        const data = JSON.stringify({ tp: 'tp-bridge', v: 1, ...envelope });
        if (data.length > LIMIT) throw fail('too-large', 'This helper request is too large.');
        win.postMessage(data, origin);
    }
    function receive(event) {
        if (stopped || event.source !== win || event.origin !== origin || typeof event.data !== 'string' || event.data.length > LIMIT) return;
        let m;
        try { m = JSON.parse(event.data); } catch (e) { return; }
        if (!plain(m) || m.tp !== 'tp-bridge' || m.v !== 1 || !['hello', 'res', 'evt'].includes(m.dir)) return;
        if (m.dir === 'hello') {
            const b = m.body;
            if (plain(b) && plain(b.protocol) && b.serverOrigin === origin && typeof b.helperId === 'string'
                && Number.isInteger(b.protocol.min) && Number.isInteger(b.protocol.max)
                && (b.protocol.min > 1 || b.protocol.max < 1)) { detach('incompatible'); return; }
            if (!plain(b) || typeof m.inst !== 'string' || !m.inst || !plain(b.protocol)
                || b.protocol.min > 1 || b.protocol.max < 1 || !Number.isInteger(b.protocol.min) || !Number.isInteger(b.protocol.max)
                || typeof b.helperId !== 'string' || !b.helperId || b.serverOrigin !== origin
                || typeof b.serverId !== 'string' || !b.serverId || !Array.isArray(b.ops) || b.ops.length > 100
                || b.ops.some(op => typeof op !== 'string' || op.length > 100)) return;
            helpers.add(b.helperId);
            if (helpers.size > 1) { detach('multiple'); return; }
            if (instance && instance !== m.inst) rejectAll('The helper reconnected. Try again.');
            instance = m.inst;
            hello = b;
            status = 'ready';
            notify('hello', b);
            notify('status', status);
            return;
        }
        if (!hello || m.inst !== instance) return;
        if (m.dir === 'res') {
            const p = pending.get(m.id);
            if (!p || !plain(m.body) || typeof m.body.ok !== 'boolean' || (m.op && m.op !== p.op)) return;
            if (!m.body.ok && m.body.error?.code === 'restarting' && m.body.error.retryable && !p.retried) {
                p.retried = true;
                later(() => {
                    if (pending.get(m.id) !== p) return;
                    try { post({ dir: 'req', inst: instance, id: m.id, op: p.op, body: p.body }); }
                    catch (e) { pending.delete(m.id); cancel(p.timer); p.reject(e); }
                }, 250);
                return;
            }
            pending.delete(m.id);
            cancel(p.timer);
            if (m.body.ok) p.resolve(m.body.data);
            else {
                const error = m.body.error || {};
                p.reject(Object.assign(fail(String(error.code || 'helper-error'), String(error.message || 'The helper could not complete this action.')), { retryable: error.retryable === true }));
            }
        } else if (typeof m.event === 'string') {
            if (m.event === 'helper.gone' || m.event === 'helper.detached') detach('absent');
            else notify(m.event, m.body);
        }
    }
    const client = {
        get status() { return status; },
        get hello() { return hello; },
        supports(op) { return status === 'ready' && hello.ops.includes(op); },
        on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        ping() { if (!stopped && typeof win?.postMessage === 'function') post({ dir: 'ping' }); },
        request(op, body = {}) {
            if (!client.supports(op)) return Promise.reject(fail('unsupported', status === 'multiple'
                ? 'Two TabPaladin helpers are installed: remove one.' : 'Connect the TabPaladin helper to use this feature.'));
            const id = helperRequestId(crypto);
            return new Promise((resolve, reject) => {
                const timer = later(() => { pending.delete(id); reject(fail('timeout', 'The helper did not respond. Your saved copy is kept; try again.')); }, ['windows.openWorkflow', 'windows.openUrls', 'tabs.closeSnapshot'].includes(op) ? 60000 : timeout);
                pending.set(id, { resolve, reject, timer, op, body, retried: false });
                try { post({ dir: 'req', inst: instance, id, op, body }); }
                catch (e) { cancel(timer); pending.delete(id); reject(e); }
            });
        },
        close() {
            stopped = true;
            rejectAll('This page closed.');
            for (const timer of timers) cancel(timer);
            timers.clear();
            win?.removeEventListener?.('message', receive);
            listeners.clear();
        }
    };
    if (typeof win?.postMessage === 'function') {
        win.addEventListener('message', receive);
        client.ping();
        for (const ms of [250, 1000, 3000]) later(client.ping, ms);
        later(() => { if (!hello) notify('status', status); }, 1500);
    }
    return client;
}

export function helperUrl(raw) {
    if (typeof raw !== 'string' || raw.length > 8192 || /[\u0000-\u001f\\]/.test(raw)) return false;
    try {
        const u = new URL(raw);
        return !u.username && !u.password && (['http:', 'https:'].includes(u.protocol) || (u.protocol === 'file:' && !u.hostname && !/^\/{2}/.test(u.pathname)));
    } catch (e) { return false; }
}

export function sameHelperAccount(a, b) {
    return Boolean(a && b && a.url === b.url && a.userId !== null && a.userId !== undefined
        && Number(a.userId) === Number(b.userId) && a.serverId && a.serverId === b.serverId);
}

function find(nodes, id) {
    for (const n of nodes || []) {
        if (n.id === id) return n;
        const found = find(n.children, id);
        if (found) return found;
    }
    return null;
}

// Read the committed record, not TreeStore's in-memory view. Closing browser
// tabs must never depend on a failed write or on the memory-only fallback.
export async function durableWorkflow(platform, store, workflow, selected) {
    if (!['indexeddb', 'cache'].includes(await platform.backendKind())) throw new Error('This copy cannot be kept durably. No tabs were closed.');
    if (!(await store.flush())) throw new Error('The workflow is not written yet. No tabs were closed.');
    const record = (await platform.getRaw('tpTree')).tpTree;
    const node = find(record?.roots, workflow.id);
    const children = (node?.children || []).filter(n => n.kind === 'bookmark');
    if (!node || children.length !== selected.length || workflow.tabs.length !== selected.length
        || children.some((n, i) => n.id !== workflow.tabs[i].id || n.url !== selected[i].url)) {
        throw new Error('The saved tabs did not match the snapshot. No tabs were closed.');
    }
}

export async function saveHelperWorkflow({ helper, platform, store, storage, snapshot, tabs, title, account, assertCurrent, push }) {
    if (!snapshot || typeof snapshot.snapshotId !== 'string' || !Array.isArray(tabs) || !tabs.length || tabs.length > 500
        || tabs.some(t => !helperUrl(t.url) || !snapshot.tabs.some(s => s.tabId === t.tabId && s.url === t.url))) {
        throw new Error('Select between 1 and 500 saveable tabs from the snapshot.');
    }
    await assertCurrent();
    const before = await store.currentCopy();
    const workflow = await storage.saveWorkflow(title.trim() || 'Workflow', tabs);
    await assertCurrent();
    const root = await store.findRoleRoot('workflows');
    const pending = { workflow: { id: workflow.id, title: workflow.name, createdAt: workflow.createdAt, tabs: workflow.tabs.map(t => ({ id: t.id, title: t.title, url: t.url })) }, rootId: root.id, account };
    await store.updateMeta(m => ({ ...m, helperPendingWorkflows: [...(m.helperPendingWorkflows || []), pending] }));
    await durableWorkflow(platform, store, workflow, tabs);
    await assertCurrent();
    const expect = await store.currentCopy();
    if (!store.sameCopy(expect, before)) throw new Error('The account or working copy changed. No tabs were closed.');
    let closed = null;
    let closeError = null;
    try {
        closed = await helper.request('tabs.closeSnapshot', { snapshotId: snapshot.snapshotId, tabIds: tabs.map(t => t.tabId), expectedCount: tabs.length });
    } catch (e) { closeError = e; }
    let pushed = false;
    let pushError = null;
    try { pushed = await push(pending, { before, expect }); } catch (e) { pushError = e; }
    return { workflow, closed, closeError, pushed, pushError };
}

// Browser bookmarklets are retained as text-only bookmarks; the renderer and
// tab-opening helper independently refuse their schemes. No imported roles,
// ids or metadata can replace the user's existing tree.
export function stagedBookmarkFolder(tree, day = new Date().toISOString().slice(0, 10)) {
    let count = 0;
    const walk = (n, depth) => {
        if (!plain(n) || depth > 40 || ++count > 50000) throw new Error('The staged bookmark tree is too large.');
        const title = String(n.title || n.url || 'Folder').slice(0, 4096);
        if (typeof n.url === 'string') {
            if (n.url.length > 8192) throw new Error('A bookmark URL is too long.');
            return { kind: 'bookmark', title, url: n.url };
        }
        return { kind: 'folder', title, children: (Array.isArray(n.children) ? n.children : []).map(c => walk(c, depth + 1)) };
    };
    if (!Array.isArray(tree)) throw new Error('The staged bookmarks are not a browser tree.');
    return { kind: 'folder', title: `Imported browser bookmarks ${day}`, children: tree.map(n => walk(n, 0)) };
}

export const pageHelper = createHelperClient();
