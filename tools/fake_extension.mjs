// A fake browser for the extension's background script, shared by the
// headless tests that run src/background/background.js (test_tracking.mjs,
// test_update_handshake.mjs, test_ai_removed.mjs).
//
// One fake holds what outlives a worker — storage, open tabs, granted
// permissions, registered content scripts — and each bootWorker() starts the
// background script afresh over it in its own vm context, the way an update,
// a browser restart or a service-worker wake does. Every storage call takes a
// few random milliseconds, so handlers that race each other lose writes here
// the way they do in the browser.
//
// Not a test itself (no test_ prefix): the runner only runs tools/test_*.mjs.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EXT_ID = 'tpextensionid';
export const BASE = `chrome-extension://${EXT_ID}/`;

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const jitter = () => new Promise(r => setTimeout(r, Math.floor(Math.random() * 3)));
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Wait until cond() holds (polling), or give up after ms.
export async function until(cond, ms = 3000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await cond()) return true;
        await sleep(5);
    }
    return Boolean(await cond());
}

function event() {
    const fns = [];
    return {
        fns,
        addListener: (fn) => { fns.push(fn); },
        removeListener: (fn) => { const i = fns.indexOf(fn); if (i !== -1) fns.splice(i, 1); },
        hasListener: (fn) => fns.includes(fn)
    };
}

export function makeBrowser({ timeScale = 1 } = {}) {
    const storage = new Map();
    const pageStorageListeners = [];   // the pages' (TreeStore, notes): they outlive a worker
    let workerStorageListeners = [];
    const tabs = new Map();          // id -> { id, url, windowId }
    const granted = new Set();       // origins granted, e.g. '<all_urls>'
    const registered = new Map();    // content-script id -> registration
    const sentToTabs = [];           // { tabId, msg }
    const runtimeSent = [];          // messages the worker sent to pages
    let reloads = 0;
    let contexts = null;             // runtime.getContexts answer (array) or null = unsupported

    function fireStorage(changes) {
        for (const fn of [...pageStorageListeners, ...workerStorageListeners]) {
            const own = clone(changes);
            setTimeout(() => fn(own, 'local'), 0);
        }
    }

    const storageLocal = {
        async get(keys) {
            await jitter();
            const out = {};
            if (keys === null || keys === undefined) {
                for (const [k, v] of storage) out[k] = clone(v);
                return out;
            }
            for (const k of [].concat(keys)) if (storage.has(k)) out[k] = clone(storage.get(k));
            return out;
        },
        async set(obj) {
            await jitter();
            const changes = {};
            for (const [k, v] of Object.entries(obj)) {
                changes[k] = { oldValue: clone(storage.get(k)), newValue: clone(v) };
                storage.set(k, clone(v));
            }
            fireStorage(changes);
        },
        async remove(keys) {
            await jitter();
            const changes = {};
            for (const k of [].concat(keys)) {
                if (!storage.has(k)) continue;
                changes[k] = { oldValue: clone(storage.get(k)) };
                storage.delete(k);
            }
            if (Object.keys(changes).length) fireStorage(changes);
        }
    };

    // The page side: what an extension page (TreeStore, notes) sees as
    // `chrome`. It shares storage with every worker booted below.
    const pageApi = {
        runtime: {
            id: EXT_ID,
            getURL: (p) => BASE + String(p || '').replace(/^\//, ''),
            onMessage: event(),
            sendMessage: async () => undefined
        },
        storage: { local: storageLocal, onChanged: { addListener: (fn) => pageStorageListeners.push(fn), removeListener() {} } },
        tabs: { create: async () => ({}) }
    };

    let worker = null;

    // Start the background script afresh, as a new worker would.
    function bootWorker({ file = path.join(ROOT, 'src/background/background.js') } = {}) {
        const ev = {
            installed: event(), startup: event(), message: event(), updateAvailable: event(),
            removed: event(), clicked: event(), permAdded: event(), permRemoved: event(), storage: event()
        };
        workerStorageListeners = [];
        const api = {
            runtime: {
                id: EXT_ID,
                getURL: (p) => BASE + String(p || '').replace(/^\//, ''),
                onInstalled: ev.installed,
                onStartup: ev.startup,
                onMessage: ev.message,
                onUpdateAvailable: ev.updateAvailable,
                async sendMessage(msg) {
                    runtimeSent.push(clone(msg));
                    // Delivered to the extension pages' listeners; the first
                    // answer is the reply, as in the browser.
                    const fns = pageApi.runtime.onMessage.fns;
                    if (!fns.length) throw new Error('Could not establish connection. Receiving end does not exist.');
                    const sender = { id: EXT_ID, url: BASE + 'src/background/background.js' };
                    return new Promise((resolve) => {
                        let answered = false;
                        let pending = 0;
                        for (const fn of fns) {
                            const keep = fn(clone(msg), sender, (r) => { if (!answered) { answered = true; resolve(r); } });
                            if (keep === true) pending++;
                        }
                        if (!pending && !answered) resolve(undefined);
                    });
                },
                reload() { reloads++; },
                ...(contexts ? { getContexts: async () => clone(contexts) } : {})
            },
            storage: {
                local: storageLocal,
                onChanged: { addListener: (fn) => { workerStorageListeners.push(fn); ev.storage.fns.push(fn); } }
            },
            tabs: {
                async query(q = {}) {
                    await jitter();
                    return [...tabs.values()].filter(t => !q.url || t.url === q.url).map(clone);
                },
                async create(props) { const id = 1000 + tabs.size; tabs.set(id, { id, url: props.url || 'about:blank' }); return { id }; },
                async update() { return {}; },
                async sendMessage(tabId, msg) {
                    if (!tabs.has(tabId)) throw new Error('No tab with id ' + tabId);
                    sentToTabs.push({ tabId, msg: clone(msg) });
                    return undefined;
                },
                onRemoved: ev.removed
            },
            windows: { async update() { return {}; } },
            action: { onClicked: ev.clicked },
            permissions: {
                async contains(p) { return (p.origins || []).every(o => granted.has(o)); },
                async request(p) { (p.origins || []).forEach(o => granted.add(o)); return true; },
                async remove(p) { (p.origins || []).forEach(o => granted.delete(o)); return true; },
                onAdded: ev.permAdded,
                onRemoved: ev.permRemoved
            },
            scripting: {
                async getRegisteredContentScripts({ ids } = {}) {
                    return [...registered.values()].filter(s => !ids || ids.includes(s.id)).map(clone);
                },
                async registerContentScripts(list) { for (const s of list) registered.set(s.id, clone(s)); },
                async unregisterContentScripts({ ids } = {}) { for (const id of ids || []) registered.delete(id); }
            }
        };
        const sandbox = {
            chrome: api,
            navigator: globalThis.navigator,
            console,
            crypto: globalThis.crypto,
            URL,
            setTimeout: (fn, ms) => setTimeout(fn, Math.max(0, Math.round((ms || 0) * timeScale))),
            clearTimeout
        };
        vm.createContext(sandbox);
        vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: path.relative(ROOT, file) });
        worker = { api, ev, sandbox };
        return worker;
    }

    // Senders as the browser describes them.
    const senders = {
        appPage: { id: EXT_ID, url: BASE + 'src/app/app.html', tab: { id: 77, windowId: 1 }, origin: BASE.slice(0, -1) },
        contentScript: { id: EXT_ID, url: 'https://evil.example/page', tab: { id: 5, windowId: 1 }, origin: 'https://evil.example' },
        otherExtension: { id: 'someoneelse', url: 'chrome-extension://someoneelse/x.html' },
        noUrl: { id: EXT_ID }
    };

    // Deliver a runtime message to the worker; resolves with its reply, or
    // undefined when it did not answer.
    function message(msg, sender = senders.appPage) {
        return new Promise((resolve) => {
            let answered = false;
            let kept = false;
            for (const fn of worker.ev.message.fns) {
                const r = fn(clone(msg), clone(sender), (reply) => { answered = true; resolve(reply); });
                if (r === true) kept = true;
            }
            if (!kept && !answered) setTimeout(() => resolve(undefined), 20);
        });
    }

    return {
        storage, tabs, granted, registered, sentToTabs, runtimeSent, senders, pageApi,
        get reloads() { return reloads; },
        setContexts(list) { contexts = list; },
        bootWorker,
        get worker() { return worker; },
        message,
        fire(name, ...args) { for (const fn of worker.ev[name].fns) fn(...args.map(clone)); }
    };
}
