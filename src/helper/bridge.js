// Isolated-world transport only: no storage or credentials are read here.
(() => {
    if (window !== window.top) return;
    const api = typeof browser !== 'undefined' ? browser : chrome;
    const previous = globalThis.__tpHelperBridge;
    try {
        if (previous && previous.helperId === api.runtime.id && previous.alive()) { previous.ping(); return; }
    } catch (_) { /* an orphan from an extension update */ }
    if (previous) { try { previous.stop(); } catch (_) { /* its extension context was invalidated */ } }
    const randomId = () => typeof crypto.randomUUID === 'function' ? crypto.randomUUID()
        : Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
    const inst = randomId();
    let attached = false;
    let stopped = false;
    let hello = null;
    let lastGesture = -Infinity;
    let attachPending = null;
    const origin = location.origin;
    const post = (dir, fields) => {
        try { window.postMessage(JSON.stringify({ tp: 'tp-bridge', v: 1, dir, inst, ...fields }), origin); } catch (_) { /* navigating */ }
    };
    const gesture = event => { if (event.isTrusted) lastGesture = performance.now(); };
    function gone() {
        if (stopped) return;
        post('evt', { event: 'helper.gone', body: {} });
        stop();
    }
    async function send(req) {
        try {
            if (!api.runtime.id) { gone(); return null; }
            return await api.runtime.sendMessage({ channel: 'tp-bridge', inst,
                gestureAgeMs: Number.isFinite(lastGesture) ? Math.max(0, performance.now() - lastGesture) : null,
                visible: document.visibilityState === 'visible' && document.hasFocus(),
                req: { v: 1, id: req.id, op: req.op, body: req.body } });
        } catch (error) {
            if (/invalidated|receiving end|disconnected/i.test(String(error && error.message))) gone();
            return { ok: false, error: { code: 'restarting', message: 'The helper is restarting. Retry this request.', retryable: true } };
        }
    }
    async function attach() {
        if (stopped) return;
        if (attachPending) return attachPending;
        attachPending = (async () => {
            const response = await send({ id: randomId(), op: 'cs.attach', body: {} });
            if (stopped || !response || !response.ok) return;
            attached = true;
            hello = response.data;
            post('hello', { body: hello });
        })();
        try { await attachPending; } finally { attachPending = null; }
    }
    async function onMessage(event) {
        if (stopped || event.source !== window || event.origin !== origin || typeof event.data !== 'string' || event.data.length > 1024 * 1024) return;
        let message;
        try { message = JSON.parse(event.data); } catch (_) { return; }
        if (!message || message.tp !== 'tp-bridge' || message.v !== 1) return;
        if (message.dir === 'ping') { await attach(); return; }
        if (!attached || message.dir !== 'req' || message.inst !== inst || typeof message.id !== 'string'
            || !/^[a-f0-9-]{32,36}$/i.test(message.id) || typeof message.op !== 'string' || message.op.length > 64
            || !message.body || typeof message.body !== 'object' || Array.isArray(message.body)) return;
        const response = await send({ id: message.id, op: message.op, body: message.body });
        if (response) post('res', { id: message.id, op: message.op, body: response });
    }
    function onEvent(message, sender) {
        if (stopped || !sender || sender.id !== api.runtime.id || !message || message.channel !== 'tp-bridge-evt' || typeof message.event !== 'string') return;
        if (message.event === 'helper.detached') { attached = false; hello = null; }
        if (attached || message.event === 'helper.detached') post('evt', { event: message.event, body: message.body || {} });
    }
    function stop() {
        stopped = true; attached = false;
        window.removeEventListener('message', onMessage);
        window.removeEventListener('pointerdown', gesture, true);
        window.removeEventListener('keydown', gesture, true);
        document.removeEventListener('visibilitychange', onVisibility);
        try { api.runtime.onMessage.removeListener(onEvent); } catch (_) { /* extension updated */ }
    }
    const onVisibility = () => { if (document.visibilityState === 'visible') attach(); };
    globalThis.__tpHelperBridge = { helperId: api.runtime.id, alive: () => !stopped && Boolean(api.runtime.id), stop, ping: attach };
    window.addEventListener('message', onMessage);
    window.addEventListener('pointerdown', gesture, true);
    window.addEventListener('keydown', gesture, true);
    document.addEventListener('visibilitychange', onVisibility);
    api.runtime.onMessage.addListener(onEvent);
    attach();
})();
