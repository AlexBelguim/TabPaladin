// Headless test: P4, the move (src/helper/move.js, pwa/move.js and the
// shared TreeStore's importBackupCopy), end to end: the extension's
// background with every helper module in a fake browser, the web app's
// receiver over the shared core on an in-memory platform, and a fake server
// that signs its identity and answers sign-out.
//
// What this locks down:
//   1. Detection of every legacy key, including a set-aside copy missing
//      from tpTreeStashIndex; the badge; the toolbar opening the move page
//      until the move is done, and the web app after it. A fresh install
//      finds nothing.
//   2. The hand-over: only the tab the move page approved, only with a
//      click; parts only for the pinned server — copies stamped for another
//      server (and their drafts) stay in the helper; no session token and no
//      old AI key in any part, or anywhere in the web app.
//   3. Settle: every incoming copy lands set aside first; the working copy
//      becomes current only over an empty or clean copy, never over one with
//      unpushed edits; another account's copy stays set aside for that
//      account; drafts are parked; device settings fill in only what the web
//      app lacks; queued removals and legacy workflows come with the copy.
//   4. Idempotence: a transfer cut off half-way keeps nothing and runs
//      again; one written but not acknowledged is not read twice; a settle
//      stopped half-way finishes without duplicates; sending everything again
//      changes nothing.
//   5. Tracking: the old UI's tracked workflow tabs are retargeted to 'web'
//      for the copy's account, and closing one queues a web removal, never
//      tpPendingRemovals; one that cannot be matched keeps its bookmark.
//   6. The old UI's own session is signed out only once the move is done
//      and the web app reports a signed-in session, then blanked; the
//      server's shared token is never changed.
//   7. Rollback: every key 1.1.0 reads is as it was (only the revoked
//      session token is blank and tracking is retargeted), and 1.1.0's own
//      TreeStore loads the same working copy and set-aside copies.
//   8. The moved parts are kept in an IndexedDB database of their own
//      ('tabpaladin-moves'): the working copy's database is never upgraded
//      for them.
//   9. A helper worker that stopped mid-hand-over makes each part again and
//      serves it only when it is the same; another document, or an ack that
//      does not confirm every part, gets nothing.
//
// Run: node tools/test_move.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
// Each web page a test starts gets modules of its own (a TreeStore of its own).
import './fresh_page.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT_ID = 'tpextensionid';
const BASE = `chrome-extension://${EXT_ID}/`;
const ORIGIN = 'https://tp.example.com';
const OLD = 'https://old.example.com';          // the same server, at the old UI's address
const OTHER = 'https://other.example.org';      // another server
const SESSION_TOKEN = 'sess-' + 'a1'.repeat(24);
const SHARED_TOKEN = 'shared-' + 'b2'.repeat(24);
const AI_KEY = 'AIza-not-a-real-key-0123456789';
const MANIFEST_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version;

let failures = 0;
function check(name, cond, detail) {
    if (cond) console.log(`  ok  ${name}`);
    else { failures++; console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(cond, ms = 4000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await cond()) return true; await sleep(10); }
    return Boolean(await cond());
}

// --- A server that signs its identity ----------------------------------------------
const b64url = buf => Buffer.from(new Uint8Array(buf)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function makeIdentity(serverId) {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    return { serverId, privateKey: pair.privateKey, jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } };
}
const main = await makeIdentity('srv-main');
const other = await makeIdentity('srv-other');
const servers = new Map([[ORIGIN, main], [OLD, main], [OTHER, other]]);
const sessions = new Set();
const fetchLog = [];
// Answers a proxy gives to sign-out before the server does (a 502 while the
// server restarts): taken one per sign-out.
const logoutAnswers = [];
async function fakeFetch(url, opts = {}) {
    const u = new URL(url);
    const auth = (opts.headers && (opts.headers.Authorization || opts.headers.authorization)) || '';
    fetchLog.push({ origin: u.origin, path: u.pathname, method: opts.method || 'GET', auth });
    const srv = servers.get(u.origin);
    if (!srv) throw new TypeError('Failed to fetch');
    const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => clone(body) });
    if (u.pathname === '/api/identity') {
        const nonce = u.searchParams.get('nonce');
        const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, srv.privateKey, new TextEncoder().encode(`tp-identity|1|${nonce}|${srv.serverId}`));
        return reply(200, { app: 'tabpaladin', alg: 'ES256', nonce, serverId: srv.serverId, publicKeyJwk: srv.jwk, sig: b64url(sig) });
    }
    const token = auth.replace(/^Bearer\s+/, '');
    // As server/index.js: sign-out ends a session token; the shared token
    // (AUTH_TOKEN) is answered but never ended.
    if (u.pathname === '/api/logout') {
        if (logoutAnswers.length) return reply(logoutAnswers.shift(), {});
        if (sessions.has(token)) { sessions.delete(token); return reply(200, { ok: true }); }
        return token === SHARED_TOKEN ? reply(200, { ok: true }) : reply(401, { error: 'Unauthorized' });
    }
    if (u.pathname === '/api/auth/me') {
        return sessions.has(token) || token === SHARED_TOKEN ? reply(200, { ok: true, user: { id: 1, username: 'alex' }, serverId: srv.serverId }) : reply(401, {});
    }
    return reply(404, {});
}

// --- A fake browser for the background and every helper module ---------------------
function event() {
    const fns = [];
    return { fns, addListener: fn => fns.push(fn), removeListener: fn => { const i = fns.indexOf(fn); if (i !== -1) fns.splice(i, 1); }, hasListener: fn => fns.includes(fn) };
}
function makeBrowser({ getKeys = true } = {}) {
    const local = new Map();
    const session = new Map();
    const tabs = new Map();
    const windows = new Map([[1, { id: 1, focused: true, type: 'normal', incognito: false }]]);
    const granted = new Set();
    const registered = new Map();
    const created = [];
    const updated = [];
    const queues = new Map();
    const locks = { request(name, fn) { const prev = queues.get(name) || Promise.resolve(); const run = prev.then(() => fn()); queues.set(name, run.catch(() => {})); return run; } };
    let storageFns = [];
    const state = { badge: '', title: '', optionsOpened: 0 };
    const area = (map, fires) => ({
        async get(keys) {
            const out = {};
            if (keys === null || keys === undefined) { for (const [k, v] of map) out[k] = clone(v); return out; }
            const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
            for (const k of list) if (map.has(k)) out[k] = clone(map.get(k));
            return out;
        },
        async set(obj) {
            const changes = {};
            for (const [k, v] of Object.entries(obj)) { changes[k] = { oldValue: clone(map.get(k)), newValue: clone(v) }; map.set(k, clone(v)); }
            if (fires) for (const fn of [...storageFns]) setTimeout(() => fn(clone(changes), 'local'), 0);
        },
        async remove(keys) {
            const changes = {};
            for (const k of [].concat(keys)) { if (map.has(k)) { changes[k] = { oldValue: clone(map.get(k)) }; map.delete(k); } }
            if (fires && Object.keys(changes).length) for (const fn of [...storageFns]) setTimeout(() => fn(clone(changes), 'local'), 0);
        },
        ...(getKeys ? { async getKeys() { return [...map.keys()]; } } : {})
    });
    const matches = (pattern, url) => (pattern.endsWith('/*') ? String(url).startsWith(pattern.slice(0, -1)) : pattern === url);
    let nextTab = 500;
    let worker = null;
    function boot() {
        const ev = { installed: event(), startup: event(), message: event(), updateAvailable: event(), removed: event(), created: event(), updatedTab: event(),
            activated: event(), clicked: event(), focus: event(), permAdded: event(), permRemoved: event(), menu: event() };
        storageFns = [];
        const api = {
            runtime: {
                id: EXT_ID, getURL: p => BASE + String(p || '').replace(/^\//, ''), getManifest: () => ({ version: MANIFEST_VERSION }),
                onInstalled: ev.installed, onStartup: ev.startup, onMessage: ev.message, onUpdateAvailable: ev.updateAvailable,
                async sendMessage() { throw new Error('Could not establish connection. Receiving end does not exist.'); },
                async openOptionsPage() { state.optionsOpened++; }, reload() {}
            },
            storage: { local: area(local, true), session: area(session, false), onChanged: { addListener: fn => storageFns.push(fn) } },
            tabs: {
                async query(q = {}) {
                    let list = [...tabs.values()];
                    if (q.url) list = list.filter(t => [].concat(q.url).some(p => matches(p, t.url)));
                    if (q.active) list = list.filter(t => t.active);
                    if (q.windowId != null) list = list.filter(t => t.windowId === q.windowId);
                    return clone(list);
                },
                async get(id) { if (!tabs.has(id)) throw new Error('No tab with id: ' + id); return clone(tabs.get(id)); },
                async create(props = {}) { const t = { id: nextTab++, url: props.url || 'about:blank', windowId: props.windowId ?? 1, active: props.active !== false, incognito: false, index: 0 }; tabs.set(t.id, t); created.push(clone(t)); return clone(t); },
                async update(id, props = {}) { const t = tabs.get(id); if (!t) throw new Error('No tab'); Object.assign(t, props); updated.push({ id, props: clone(props) }); return clone(t); },
                async remove(id) { tabs.delete(id); },
                async sendMessage() { return undefined; },
                onRemoved: ev.removed, onCreated: ev.created, onUpdated: ev.updatedTab, onActivated: ev.activated
            },
            windows: {
                async get(id) { if (!windows.has(id)) throw new Error('No window'); return clone(windows.get(id)); },
                async getAll() { return clone([...windows.values()]); },
                async update() { return {}; },
                async create(props = {}) { const t = await api.tabs.create({ url: props.url }); return { id: 1, tabs: [t] }; },
                onFocusChanged: ev.focus
            },
            action: { onClicked: ev.clicked, async setBadgeText({ text }) { state.badge = text; }, async setTitle({ title }) { state.title = title; } },
            permissions: {
                async contains(p) { return (p.origins || []).every(o => granted.has(o)); },
                async request(p) { (p.origins || []).forEach(o => granted.add(o)); return true; },
                async remove(p) { (p.origins || []).forEach(o => granted.delete(o)); return true; },
                onAdded: ev.permAdded, onRemoved: ev.permRemoved
            },
            scripting: {
                async getRegisteredContentScripts({ ids } = {}) { return [...registered.values()].filter(s => !ids || ids.includes(s.id)).map(clone); },
                async registerContentScripts(list) { for (const s of list) registered.set(s.id, clone(s)); },
                async unregisterContentScripts({ ids } = {}) { for (const id of ids || []) registered.delete(id); },
                async executeScript() { return []; }
            },
            contextMenus: { async removeAll() {}, create() {}, onClicked: ev.menu }
        };
        const sandbox = { chrome: api, navigator: { locks }, console, crypto: globalThis.crypto, URL, URLSearchParams, TextEncoder, TextDecoder,
            btoa, atob, fetch: fakeFetch, AbortController, setTimeout, clearTimeout, setInterval, clearInterval };
        const context = vm.createContext(sandbox);
        sandbox.importScripts = (...files) => {
            for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/background', f), 'utf8'), context, { filename: f });
        };
        vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/background/background.js'), 'utf8'), context, { filename: 'background.js' });
        worker = { api, ev, H: sandbox.TPHelper };
        return worker;
    }
    function send(msg, sender) {
        return new Promise((resolve) => {
            let kept = false;
            for (const fn of worker.ev.message.fns) { if (fn(clone(msg), clone(sender), r => resolve(clone(r))) === true) kept = true; }
            if (!kept) setTimeout(() => resolve(undefined), 20);
        });
    }
    const movePageSender = { id: EXT_ID, url: BASE + 'src/helper/move.html', tab: { id: 900, windowId: 1, incognito: false } };
    async function movePage(op, body = {}) {
        const r = await send({ channel: 'tp-helper-move', op, body }, movePageSender);
        if (!r || !r.ok) throw Object.assign(new Error((r && r.error && r.error.message) || 'no reply'), { code: r && r.error && r.error.code });
        return r.data;
    }
    // The web app's page, through its content script: what helper.js sends.
    function page(tabId, documentId) {
        const inst = crypto.randomUUID();
        let gesture = null;
        const client = {
            hello: null, calls: [],
            click() { gesture = Date.now(); },
            supports(op) { return Boolean(client.hello && client.hello.ops.includes(op)); },
            async request(op, body = {}) {
                client.calls.push(op);
                const t = tabs.get(tabId);
                const sender = { id: EXT_ID, tab: clone(t), frameId: 0, url: t.url, origin: new URL(t.url).origin, documentId };
                const msg = { channel: 'tp-bridge', inst, gestureAgeMs: gesture === null ? null : Date.now() - gesture, visible: true,
                    req: { v: 1, id: crypto.randomUUID(), op, body: clone(body) } };
                const reply = clone(await worker.H.handleBridgeMessage(msg, sender));
                if (!reply.ok) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
                return reply.data;
            },
            async attach() { client.hello = await client.request('cs.attach', {}); return client.hello; }
        };
        return client;
    }
    return { local, session, tabs, windows, granted, created, updated, state, boot, movePage, page, send, get worker() { return worker; } };
}

// --- The old UI's data, as 1.0–1.2 left it ------------------------------------------
const A_OWNER = { url: ORIGIN, userId: 1, username: 'alex', serverId: 'srv-main' };
const BIG = 'x'.repeat(700 * 1024); // more than one 512 KiB chunk
function legacyData() {
    return {
        tpTree: {
            baseVersion: 40, dirty: true, editCount: 3, owner: A_OWNER, origin: null, copyId: 'copy-ext', rev: 'rev-ext', seq: 9, baseId: 'base-ext',
            lastSyncAt: '2026-10-01T09:00:00.000Z', lastSyncKind: 'push', restoredFrom: [], meta: { apiKey: AI_KEY },
            roots: [
                { id: 'f-bookmarks', kind: 'folder', title: 'Bookmarks', role: 'bookmarks', children: [
                    { id: 'b-site', kind: 'bookmark', title: 'Site', url: 'https://site.example.com/' }] },
                { id: 'f-workflows', kind: 'folder', title: 'TabPaladin Workflows', role: 'workflows', children: [
                    { id: 'wf1', kind: 'folder', title: 'Research', payload: { createdAt: '2026-09-01T00:00:00.000Z' }, children: [
                        { id: 'b1', kind: 'bookmark', title: 'A', url: 'https://a.example.com/' },
                        { id: 'b2', kind: 'bookmark', title: 'B', url: 'https://b.example.com/' },
                        { id: 'b3', kind: 'bookmark', title: 'C', url: 'https://c.example.com/' }] }] },
                { id: 'f-notes', kind: 'folder', title: 'TabPaladin Notes', role: 'notes', children: [
                    { id: 'n1', kind: 'note', title: 'Groceries', payload: { content: '# Groceries\n- milk', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z' } },
                    { id: 'n-big', kind: 'note', title: 'Long', payload: { content: BIG, createdAt: null, updatedAt: null } }] },
                { id: 'imports:root', kind: 'folder', title: 'TabPaladin Imports', virtual: true, readOnly: true, children: [
                    { id: 'imp:1:x', kind: 'bookmark', title: 'Imported', url: 'https://imp.example.com/', virtual: true }] }
            ]
        },
        tpTreeStashIndex: ['tpTreeStash:https://old.example.com|1', 'tpTreeStash:https://other.example.org|1', 'tpTreeStash:https://old.example.com|legacy'],
        // Set aside at the server's old address: the same account.
        'tpTreeStash:https://old.example.com|1': { roots: [{ id: 'old-f', kind: 'folder', title: 'Old address copy', children: [] }], baseVersion: 12, dirty: false, editCount: 0,
            owner: { url: OLD, userId: 1, username: 'alex', serverId: 'srv-main' }, origin: null, url: OLD, username: 'alex', setAsideAt: '2026-08-01T00:00:00.000Z',
            focusedFolderIds: [], expanded: {}, pendingRemovals: [], restoredFrom: [], copyId: 'copy-old', fromRev: 'rev-old' },
        // Another server: never leaves.
        'tpTreeStash:https://other.example.org|1': { roots: [{ id: 'oth-f', kind: 'folder', title: 'Other server only', children: [
            { id: 'oth-b', kind: 'bookmark', title: 'Elsewhere', url: 'https://elsewhere.example.net/' }] }], baseVersion: 3, dirty: true, editCount: 2,
            owner: { url: OTHER, userId: 1, username: 'alex', serverId: 'srv-other' }, origin: null, url: OTHER, username: 'alex', setAsideAt: '2026-07-01T00:00:00.000Z',
            focusedFolderIds: [], expanded: {}, pendingRemovals: [], restoredFrom: [], copyId: 'copy-other', fromRev: 'rev-other' },
        // From before accounts, set aside at the old address.
        'tpTreeStash:https://old.example.com|legacy': { roots: [{ id: 'pre-f', kind: 'folder', title: 'Before accounts', children: [] }], baseVersion: 5, dirty: false, editCount: 0,
            owner: null, origin: 'pre-accounts', url: OLD, username: null, setAsideAt: '2026-06-01T00:00:00.000Z', focusedFolderIds: [], expanded: {}, pendingRemovals: [], restoredFrom: [], copyId: 'copy-pre', fromRev: null },
        // Stamped at the old address before stamps carried a server id: this
        // server only because that address proves the pinned identity.
        'tpTreeStash:https://old.example.com|1#1700000000000': { roots: [{ id: 'nosid-f', kind: 'folder', title: 'Stamped without an id', children: [] }], baseVersion: 2, dirty: false, editCount: 0,
            owner: { url: OLD, userId: 1, username: 'alex' }, origin: null, url: OLD, username: 'alex', setAsideAt: '2026-05-01T00:00:00.000Z',
            focusedFolderIds: [], expanded: {}, pendingRemovals: [], restoredFrom: [], copyId: 'copy-nosid', fromRev: 'rev-nosid' },
        // The same, at an address nothing answers at any more: it stays.
        'tpTreeStash:https://gone.example.net|1': { roots: [{ id: 'gone-f', kind: 'folder', title: 'Unreachable address', children: [] }], baseVersion: 2, dirty: false, editCount: 0,
            owner: { url: 'https://gone.example.net', userId: 1, username: 'alex' }, origin: null, url: 'https://gone.example.net', username: 'alex', setAsideAt: '2026-05-02T00:00:00.000Z',
            focusedFolderIds: [], expanded: {}, pendingRemovals: [], restoredFrom: [], copyId: 'copy-gone', fromRev: 'rev-gone' },
        // Another account on this server, set aside and lost from the index.
        'tpTreeStash:https://tp.example.com|2': { roots: [{ id: 'sam-f', kind: 'folder', title: 'Sam', children: [] }], baseVersion: 7, dirty: true, editCount: 1,
            owner: { url: ORIGIN, userId: 2, username: 'sam', serverId: 'srv-main' }, origin: null, url: ORIGIN, username: 'sam', setAsideAt: '2026-09-15T00:00:00.000Z',
            focusedFolderIds: [], expanded: {}, pendingRemovals: [], restoredFrom: [], copyId: 'copy-sam', fromRev: 'rev-sam' },
        tpPendingRemovals: ['b2'],
        tpLiveDraft: { pageX: { owner: A_OWNER, origin: null, noteId: 'n1', notebookId: null, title: 'Groceries list', content: '# Groceries\n- milk\n- eggs',
            loaded: { title: 'Groceries', content: '# Groceries\n- milk' }, at: '2026-10-01T10:00:00.000Z' } },
        tpParkedMirror: { at: 1, drafts: [{ owner: A_OWNER, origin: null, noteId: null, notebookId: null, title: '', content: 'A parked idea', loaded: { title: '', content: '' }, parkedAt: '2026-09-20T00:00:00.000Z' }], pages: {} },
        workflows: [{ name: 'Legacy wf', createdAt: '2025-01-01T00:00:00.000Z', tabs: [{ url: 'https://legacy.example.com/', title: 'L' }, { title: 'no url' }] }],
        workflows_legacy_backup: [{ name: 'Older backup', tabs: [] }],
        settings: { backend: { url: OLD, token: SESSION_TOKEN, username: 'alex', userId: 1, serverId: 'srv-main' }, focusedFolderIds: ['f-bookmarks'],
            customKeywords: { Coding: ['github', 'gitlab'], Token: ['kept as a word'] }, categoryOrder: ['Coding', 'Token'], geminiApiKey: AI_KEY, useAI: true },
        tpUiExpanded: { v: 1, cards: { wf1: { o: 1, t: 5 }, __open_tabs__: { o: 0, t: 6 }, 'aigroup:coding': { o: 1, t: 7 } } },
        tpOpenWorkflowTabs: {
            101: { workflowId: 'wf1', bookmarkId: 'b1', target: 'ext' },
            102: { workflowId: 'wf1', bookmarkId: 'gone-bookmark', target: 'ext' },
            103: { workflowId: 'wf1', bookmarkId: 'b3' }
        }
    };
}
// The old UI's localStorage (its origin is the move page's).
const OLD_LOCAL = {
    tp_notes_parked_v1: JSON.stringify([
        { owner: A_OWNER, origin: null, noteId: null, notebookId: null, title: '', content: 'A parked idea', loaded: { title: '', content: '' }, parkedAt: '2026-09-20T00:00:00.000Z' },
        { owner: { url: OTHER, userId: 1, username: 'alex', serverId: 'srv-other' }, origin: null, noteId: 'oth-n', notebookId: null, title: '', content: 'Other server draft', loaded: { title: '', content: '' }, parkedAt: '2026-09-21T00:00:00.000Z' }
    ]),
    tp_notes_ui_v1: JSON.stringify({ expanded: ['nb-ext'], scope: 'all', noteId: 'n1', sort: 'title', mode: 'read' }),
    tp_notes_ui_accounts_v1: JSON.stringify({ [`${ORIGIN}|1`]: { expanded: ['nb-ext'], scope: 'all', noteId: null, t: 10 }, [`${OTHER}|1`]: { expanded: [], scope: 'all', noteId: null, t: 11 } })
};
// The move page's first step (movePage.js copyLocalStorage): the old UI's
// localStorage keys into storage.local, originals left.
async function copyLocalStorage(b, local = OLD_LOCAL) {
    const prev = b.local.get('tpLegacyLocalStorage');
    await b.worker.api.storage.local.set({ tpLegacyLocalStorage: { v: 1, copiedAt: new Date().toISOString(), keys: { ...(prev ? prev.keys : {}), ...local } } });
}
function seed(b, data = legacyData()) {
    for (const [k, v] of Object.entries(data)) b.local.set(k, clone(v));
    for (const id of [101, 102, 103]) b.tabs.set(id, { id, url: 'https://a.example.com/', windowId: 1, active: false, incognito: false, index: 1 });
    b.tabs.set(50, { id: 50, url: ORIGIN + '/', windowId: 1, active: true, incognito: false, index: 0 });
}
async function connect(b) {
    b.granted.add('https://tp.example.com/*');
    await b.movePage('configure', { origin: ORIGIN });
    await until(() => b.local.get('tpHelper')?.enabled === true);
}

// --- The web app's side -----------------------------------------------------------
let pages = 0;
async function webPage(seedKv = {}) {
    const q = `?move=${++pages}`;
    const { createPlatform, memoryBackend } = await import('../pwa/platform.js' + q);
    const map = new Map(Object.entries(clone(seedKv)));
    globalThis.__tpPlatform = createPlatform({ backend: memoryBackend(map), id: 'page' + pages });
    const { TreeStore } = await import('../pwa/lib/treeStore.js' + q);
    const { StorageManager } = await import('../pwa/lib/storageManager.js' + q);
    const M = await import('../pwa/move.js' + q);
    const DC = await import('../pwa/durableCopy.js' + q);
    return { platform: globalThis.__tpPlatform, map, TreeStore, StorageManager, M, DC };
}
function fakeLocalStorage(init = {}) {
    const m = new Map(Object.entries(init));
    return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), map: m };
}
function memoryMoves() {
    const m = new Map();
    const store = {
        map: m, failWrites: 0,
        async get(k) { return clone(m.get(k)); },
        async getMany(keys) { const out = {}; for (const k of keys) if (m.has(k)) out[k] = clone(m.get(k)); return out; },
        async write(entries) {
            if (store.failWrites > 0) { store.failWrites--; throw Object.assign(new Error('The disk is full'), { name: 'QuotaExceededError' }); }
            for (const [k, v] of Object.entries(entries)) { if (v === null || v === undefined) m.delete(k); else m.set(k, clone(v)); }
        }
    };
    return store;
}
const A = { url: ORIGIN, userId: 1, username: 'alex', serverId: 'srv-main', tenancyOwner: true };
function receiver(web, helper, { account = A, ls = fakeLocalStorage(), moves = memoryMoves(), answers = [], restoreFails = 0 } = {}) {
    const toasts = [];
    let signedIn = account;
    const ctx = {
        helper, store: web.TreeStore, storage: web.StorageManager, platform: web.platform, ls, moves, origin: ORIGIN, crypto: globalThis.crypto,
        account: () => signedIn,
        helperAccount: () => (signedIn ? { url: ORIGIN, userId: signedIn.userId, serverId: signedIn.serverId } : null),
        confirmAccount: async () => signedIn,
        async assertAccount(a) {
            const owner = web.TreeStore.status().owner;
            if (!signedIn || Number(signedIn.userId) !== Number(a.userId) || !owner || Number(owner.userId) !== Number(a.userId)) throw new Error('changed');
        },
        async restore(key, a) {
            if (restoreFails > 0) { restoreFails--; throw new Error('The browser stopped mid-way.'); }
            await web.TreeStore.restoreStash(key, a);
        },
        parkDrafts(list) {
            const parked = web.DC.readParked(ls);
            for (const d of list) if (!parked.some(x => web.DC.sameDraft(x, d))) parked.push(d);
            return web.DC.writeParked(ls, parked);
        },
        toast: t => toasts.push(t), refresh() {}, signIn() {},
        confirm: () => (answers.length ? answers.shift() : true)
    };
    const r = web.M.createMoveReceiver(ctx);
    return { r, ctx, toasts, ls, moves, signIn: a => { signedIn = a; } };
}
const allText = map => JSON.stringify([...map.entries()]);

// =========================================================================================
console.log('\n1. Detection, the badge and the toolbar');
const b = makeBrowser();
seed(b);
const before = clone(Object.fromEntries(b.local));
b.boot();
b.worker.ev.installed.fns.forEach(fn => fn({ reason: 'update', previousVersion: '1.2.0' }));
await until(() => b.local.get('tpMove')?.state === 'pending');
const found = b.local.get('tpMove')?.found || [];
for (const key of ['tpTree', 'tpTreeStashIndex', 'tpTreeStash:https://tp.example.com|2', 'tpTreeStash:https://other.example.org|1', 'tpPendingRemovals',
    'tpLiveDraft', 'tpParkedMirror', 'workflows', 'workflows_legacy_backup', 'settings']) {
    check(`detected: ${key}`, found.includes(key), JSON.stringify(found));
}
check('the set-aside copy missing from the index is found by scanning', found.includes('tpTreeStash:https://tp.example.com|2'));
await until(() => b.state.badge === 'MOVE');
check('a pending move shows a badge', b.state.badge === 'MOVE', b.state.badge);
b.worker.ev.clicked.fns.forEach(fn => fn({ id: 50 }));
await until(() => b.created.some(t => t.url === BASE + 'src/helper/move.html'));
check('until the move is done the toolbar opens the move page', b.created.some(t => t.url === BASE + 'src/helper/move.html'));
{
    const fresh = makeBrowser({ getKeys: false });
    fresh.boot();
    fresh.worker.ev.installed.fns.forEach(fn => fn({ reason: 'install' }));
    await until(() => fresh.local.get('tpMove'));
    check('a fresh install has nothing to move', fresh.local.get('tpMove')?.state === 'none', JSON.stringify(fresh.local.get('tpMove')));
    fresh.worker.ev.clicked.fns.forEach(fn => fn({ id: 1 }));
    await until(() => fresh.state.optionsOpened > 0);
    check('and its toolbar opens the setup page (no server yet), not the move page', fresh.state.optionsOpened > 0 && !fresh.created.some(t => t.url.includes('move.html')));
}

console.log('\n2. The move page: setup, what moves, approval');
await connect(b);
await copyLocalStorage(b);
const status = await b.movePage('status');
check('the working copy moves (stamped for this server)', status.working?.class === 'this' && status.working.moves && status.working.dirty && status.working.editCount === 3);
const byKey = Object.fromEntries(status.stashes.map(s => [s.key, s]));
check('the copy from the server\'s old address is this server\'s (signed id)', byKey['tpTreeStash:https://old.example.com|1']?.class === 'this-moved');
check('the copy for another server is kept in this browser', byKey['tpTreeStash:https://other.example.org|1']?.class === 'other' && !byKey['tpTreeStash:https://other.example.org|1'].moves);
check('the unstamped copy goes, for the web app to decide', byKey['tpTreeStash:https://old.example.com|legacy']?.class === 'unstamped');
check('a stamp without a server id, at an address that proves the pinned identity, is this server\'s', byKey['tpTreeStash:https://old.example.com|1#1700000000000']?.class === 'this-moved'
    && byKey['tpTreeStash:https://old.example.com|1#1700000000000'].moves);
check('one at an address that cannot prove it stays in this browser', byKey['tpTreeStash:https://gone.example.net|1']?.class === 'other' && !byKey['tpTreeStash:https://gone.example.net|1'].moves);
check('drafts: those for this server move, the other server\'s stays', status.drafts.moving >= 2 && status.drafts.kept === 1, JSON.stringify(status.drafts));
check('the status carries no credential', !JSON.stringify(status).includes(SESSION_TOKEN) && !JSON.stringify(status).includes(AI_KEY));
// A page left open from before writes the old AI key back: it still never moves.
b.local.set('settings', { ...b.local.get('settings'), geminiApiKey: AI_KEY });
const approval = await b.movePage('approve');
check('Move opens the web app at #/move and approves that tab for ten minutes', approval.tabId === 50 && b.tabs.get(50).url === ORIGIN + '/#/move'
    && approval.until - Date.now() > 9 * 60 * 1000);
check('the old address proved the pinned identity, so its unstamped copy is this server\'s', b.local.get('tpMove')?.sameServer?.[OLD]);

console.log('\n3. The hand-over: the approved tab, a click, this server only');
const page = b.page(50, 'doc-1');
const hello = await page.attach();
check('hello says this tab is approved, and lists the move ops', hello.move?.approvedHere === true && ['move.manifest', 'move.part', 'move.ack'].every(op => hello.ops.includes(op)));
let refused = null;
try { await page.request('move.manifest', {}); } catch (e) { refused = e.code; }
check('without a click the manifest is refused', refused === 'needs-gesture', refused);
b.tabs.set(51, { id: 51, url: ORIGIN + '/', windowId: 1, active: true, incognito: false, index: 2 });
b.tabs.get(50).active = false;
const stranger = b.page(51, 'doc-x');
await stranger.attach();
stranger.click();
refused = null;
try { await stranger.request('move.manifest', {}); } catch (e) { refused = e.code; }
check('another tab of the web app is refused', refused === 'move-not-approved', refused);
b.tabs.get(51).active = false;
b.tabs.get(50).active = true;

const web1 = await webPage();
await web1.TreeStore.switchAccount(A); // signed in: an empty copy for alex
page.click();
const rx1 = receiver(web1, page);
// Interrupted: the tab closes after the first chunk.
const realRequest = page.request;
let served = 0;
page.request = async (op, body) => {
    if (op === 'move.part' && ++served === 2) throw Object.assign(new Error('The page closed.'), { code: 'unavailable' });
    return realRequest(op, body);
};
let cut = null;
try { await rx1.r.receive(); } catch (e) { cut = e.message; }
check('a transfer cut off half-way keeps nothing', cut && rx1.moves.map.size === 0, `${cut} / ${rx1.moves.map.size}`);
check('and the move is not done', b.local.get('tpMove')?.state === 'pending');
page.request = realRequest;
page.click();
const bundle1 = await rx1.r.receive();
const partIds = bundle1.parts.map(p => p.id).sort();
check('every part for this server arrived', JSON.stringify(partIds) === JSON.stringify(['drafts', 'prefs', 'stash:tpTreeStash:https://old.example.com|1',
    'stash:tpTreeStash:https://old.example.com|1#1700000000000', 'stash:tpTreeStash:https://old.example.com|legacy', 'stash:tpTreeStash:https://tp.example.com|2', 'working'].sort()), JSON.stringify(partIds));
check('a part bigger than one chunk came in several', page.calls.filter(c => c === 'move.part').length > bundle1.parts.length);
const held = allText(rx1.moves.map);
check('the other server\'s copy and draft never left the helper', !held.includes('other.example.org') && !held.includes('Other server only') && !held.includes('Other server draft'));
check('nor did the copy at the address that could not prove the identity', !held.includes('Unreachable address'));
check('no session token and no old AI key in any part', !held.includes(SESSION_TOKEN) && !held.includes(AI_KEY) && !/"(token|apiKey|geminiApiKey)"/.test(held));
check('the parts are kept verbatim with their digests, and the bundle with them', bundle1.parts.every(p => rx1.moves.map.get('part:' + p.digest)?.digest === p.digest)
    && rx1.moves.map.has('bundle:' + bundle1.bundleId));
const move1 = b.local.get('tpMove');
check('the ack records the delivery and the move is done', move1.state === 'done' && move1.deliveredTo?.[ORIGIN]?.bundleId === bundle1.bundleId);
await until(() => b.state.badge === '');
check('the badge goes', b.state.badge === '');

console.log('\n4. Tracking retargeted to the web app');
const track = b.local.get('tpOpenWorkflowTabs');
check('a tracked tab of the moved copy is now the web app\'s, for its account', track[101]?.target === 'web' && track[101].url === 'https://a.example.com/'
    && track[101].account?.userId === '1' && track[101].account.url === ORIGIN && track[101].account.serverId === 'srv-main' && track[101].origin === ORIGIN);
check('an entry from before targets existed is retargeted too', track[103]?.target === 'web' && track[103].url === 'https://c.example.com/');
check('one whose bookmark is not in the copy stays as it was', track[102]?.target === 'ext');
const queuedBefore = clone(b.local.get('tpPendingRemovals'));
b.worker.ev.removed.fns.forEach(fn => fn(101, { windowId: 1, isWindowClosing: false }));
b.worker.ev.removed.fns.forEach(fn => fn(102, { windowId: 1, isWindowClosing: false }));
await until(() => (b.local.get('tpHelperRemovals') || []).length === 1 && !b.local.get('tpOpenWorkflowTabs')[102]);
const webQueue = b.local.get('tpHelperRemovals') || [];
check('closing a retargeted tab queues a web removal for that account', webQueue.length === 1 && webQueue[0].bookmarkId === 'b1' && webQueue[0].account.userId === '1');
check('nothing is written to the old UI\'s queue any more', JSON.stringify(b.local.get('tpPendingRemovals')) === JSON.stringify(queuedBefore));

console.log('\n5. Settle: set aside first, then decide');
await rx1.r.settlePending();
const st1 = web1.TreeStore.status();
const roots1 = JSON.stringify(web1.TreeStore.roots());
check('over an empty copy the extension\'s working copy is current, with its unpushed edits', st1.dirty && st1.owner?.userId === 1 && roots1.includes('"Research"'));
check('its virtual imports are not brought in', !roots1.includes('imp:1:x') && !roots1.includes('imports:root'));
check('its queued removal came with it and is applied', !roots1.includes('"b2"') && roots1.includes('"b1"'));
check('the legacy workflows array became a workflow folder', roots1.includes('"Legacy wf"') && roots1.includes('https://legacy.example.com/'));
const stashes1 = await web1.TreeStore.listStashes(A);
const label = s => `${s.username}@${s.url}`;
check('the old-address copy lands set aside, stamped at this address', stashes1.some(s => s.url === ORIGIN && s.items === 1 && s.match === 'same' && s.stamps.some(x => x.url === OLD)), JSON.stringify(stashes1.map(label)));
check('sam\'s copy lands set aside for sam, not for alex', stashes1.some(s => s.username === 'sam' && s.match === null));
check('the copy stamped without a server id lands as alex\'s, at this address', stashes1.some(s => s.url === ORIGIN && s.match === 'same' && s.items === 1
    && s.stamps.some(x => x.url === OLD) && s.setAsideAt && s.key.includes(ORIGIN)) && stashes1.filter(s => s.stamps.some(x => x.url === OLD) && s.match === 'same').length === 2);
check('the copy from before accounts is the server owner\'s to take back', stashes1.some(s => s.origin === 'pre-accounts' && s.match === 'same'));
check('nothing for another server came in', !allText(web1.map).includes('other.example.org'));
const parked1 = web1.DC.readParked(rx1.ls);
check('the live draft is parked, its edited title in the title field', parked1.some(d => d.noteId === 'n1' && d.content.includes('eggs') && d.nv?.titleField === 'Groceries list'));
check('the parked draft came once, from the list and the mirror', parked1.filter(d => d.content === 'A parked idea').length === 1);
const settings1 = await web1.StorageManager.getSettings();
check('keyword categories the web app lacked came over, words lower-cased', JSON.stringify(settings1.customKeywords?.Coding) === '["github","gitlab"]'
    && Array.isArray(settings1.customKeywords?.Token));
check('the notes view came over where the web app had none', JSON.parse(rx1.ls.getItem('tp_notes_ui_v1')).sort === 'title');
const cards1 = (await web1.platform.storage.local.get('tpUiExpanded')).tpUiExpanded?.cards || {};
check('device cards came over; the copy\'s own go with the copy', cards1.__open_tabs__?.o === 0 && cards1['aigroup:coding']?.o === 1);
check('no session token or old AI key anywhere in the web app', !allText(web1.map).includes(SESSION_TOKEN) && !allText(web1.map).includes(AI_KEY)
    && ![...rx1.ls.map.values()].some(v => v.includes(SESSION_TOKEN) || v.includes(AI_KEY)));
const receipt1 = rx1.moves.map.get('receipt:' + bundle1.bundleId);
check('a receipt with an outcome per part', receipt1?.done && Object.keys(receipt1.outcome).length === bundle1.parts.length && receipt1.from === 'extension');
check('a toast says what came in', rx1.toasts.some(t => /Brought in from the extension/.test(t)), JSON.stringify(rx1.toasts));

console.log('\n6. Again: nothing twice');
const count1 = (await web1.TreeStore.listStashes(A)).length;
await rx1.r.settlePending({ ids: [bundle1.bundleId] });
check('settling again changes nothing', (await web1.TreeStore.listStashes(A)).length === count1);
// Send again: a new approval, the same data.
await b.movePage('approve');
await page.attach();
page.click();
const partsBefore = page.calls.filter(c => c === 'move.part').length;
const bundle2 = await rx1.r.receive();
check('parts held already are not read again', page.calls.filter(c => c === 'move.part').length === partsBefore && bundle2.bundleId !== bundle1.bundleId);
await rx1.r.settlePending();
check('and settle to the same outcome: no new copies, no new drafts', (await web1.TreeStore.listStashes(A)).length === count1
    && web1.DC.readParked(rx1.ls).length === parked1.length, `${(await web1.TreeStore.listStashes(A)).length} / ${count1}`);
const r2 = rx1.moves.map.get('receipt:' + bundle2.bundleId);
check('the second receipt says each outcome is the earlier one', r2?.done && Object.values(r2.outcome).every(o => o.again));

console.log('\n7. Never over a copy with unpushed edits');
{
    await b.movePage('approve');
    const web = await webPage();
    await web.TreeStore.switchAccount(A);
    const mine = await web.TreeStore.createNode({ parentId: null, kind: 'folder', title: 'Edited in the web app' });
    await web.TreeStore.flush();
    const p2 = b.page(50, 'doc-2');
    await p2.attach();
    p2.click();
    const rx = receiver(web, p2);
    await rx.r.receive();
    await rx.r.settlePending();
    const st = web.TreeStore.status();
    check('the web app\'s dirty copy stays current, untouched', st.dirty && (await web.TreeStore.getNode(mine.id)) && !JSON.stringify(web.TreeStore.roots()).includes('"Research"'));
    const ext = (await web.TreeStore.listStashes(A)).find(s => s.match === 'same' && s.dirty && s.items > 5);
    const raw = ext ? (await web.platform.getRaw(ext.key))[ext.key] : null;
    check('the extension\'s dirty copy waits set aside, labelled as from the extension', ext && raw?.meta?.movedFromExtension?.part === 'working');
    const outcome = Object.values(rx.moves.map.get([...rx.moves.map.keys()].find(k => k.startsWith('receipt:'))).outcome).find(o => o.why === 'both-dirty');
    // Three edits, and the legacy workflows array it brings as a fourth.
    check('and the report says both have unpushed edits', Boolean(outcome) && /From the browser extension: 4 unpushed edits/.test(web.M.outcomeText(outcome)), outcome && web.M.outcomeText(outcome));
    // Nothing happens to it by itself after that: signing in as sam on this
    // device and back as alex brings back alex's own work, never the
    // extension's copy filed before it.
    const SAM = { url: ORIGIN, userId: 2, username: 'sam', serverId: 'srv-main' };
    const asSam = await web.TreeStore.switchAccount(SAM);
    check('sam\'s copy brought in by the move does not come back by itself either', asSam.action === 'fresh' && web.TreeStore.roots().length === 0, JSON.stringify(asSam.action));
    const back = await web.TreeStore.switchAccount(A);
    const rootsBack = JSON.stringify(web.TreeStore.roots());
    check('as sam and back as alex: alex\'s own copy comes back, not the one the move set aside', back.action === 'restored' && web.TreeStore.status().dirty
        && Boolean(await web.TreeStore.getNode(mine.id)) && !rootsBack.includes('"Research"'), `${back.action} ${rootsBack.slice(0, 120)}`);
    check('and the extension\'s copy still waits set aside, as it was', (await web.TreeStore.listStashes(A)).some(s => s.key === ext.key && s.dirty));
    // Two of alex's own copies aside: the one set aside last comes back.
    await web.TreeStore.setAsideAndReset({ url: A.url, userId: A.userId, username: A.username, serverId: A.serverId });
    const second = await web.TreeStore.createNode({ parentId: null, kind: 'folder', title: 'Second copy' });
    await web.TreeStore.flush();
    await web.TreeStore.switchAccount(SAM);
    const again = await web.TreeStore.switchAccount(A);
    check('with two of alex\'s own copies aside, the one set aside last comes back', again.action === 'restored'
        && Boolean(await web.TreeStore.getNode(second.id)) && !(await web.TreeStore.getNode(mine.id)));
}
{
    await b.movePage('approve');
    // A clean copy here (pulled, nothing unpushed).
    const web = await webPage({ tpTree: { baseVersion: 41, dirty: false, editCount: 0, owner: A_OWNER, origin: null, copyId: 'web-copy', rev: 'web-rev', seq: 3, baseId: 'web-base',
        restoredFrom: [], roots: [{ id: 'web-f', kind: 'folder', title: 'Clean in the web app', children: [] }] } });
    await web.TreeStore.switchAccount(A);
    const p3 = b.page(50, 'doc-3');
    await p3.attach();
    p3.click();
    // The settle stops half-way the first time (the restore fails).
    const rx = receiver(web, p3, { restoreFails: 1 });
    await rx.r.receive();
    await rx.r.settlePending();
    const firstReceipt = rx.moves.map.get([...rx.moves.map.keys()].find(k => k.startsWith('receipt:')));
    check('a settle that stopped half-way is not done', firstReceipt && !firstReceipt.done);
    const stashesMid = (await web.TreeStore.listStashes(A)).length;
    await rx.r.settlePending();
    const st = web.TreeStore.status();
    check('run again, the extension\'s dirty copy is current over the clean one', st.dirty && JSON.stringify(web.TreeStore.roots()).includes('"Research"'));
    const all = await web.TreeStore.listStashes(A);
    check('the clean copy was set aside, not replaced', all.some(s => s.items === 1 && !s.dirty && s.match === 'same' && s.url === ORIGIN && !s.stamps.some(x => x.url === OLD)));
    // Half-way: the incoming copy and the four set-aside ones filed. Then:
    // the incoming one current, the clean one aside in its place.
    check('and nothing was filed twice', stashesMid === 5 && all.length === 5, `${stashesMid} → ${all.length}`);
    check('the incoming working copy is not also left set aside', !all.some(s => s.items > 5));
}

console.log('\n8. The old UI\'s session: signed out once the web app has one');
check('not before the web app reports a signed-in session', b.local.get('settings').backend.token === SESSION_TOKEN && !fetchLog.some(f => f.path === '/api/logout'));
sessions.add(SESSION_TOKEN);
await page.request('session.report', { signedIn: true, username: 'alex', userId: 1 });
await until(() => b.local.get('tpMove')?.legacyToken?.state === 'revoked');
check('then it is signed out on its server and blanked here', b.local.get('tpMove')?.legacyToken?.state === 'revoked' && b.local.get('settings').backend.token === ''
    && !sessions.has(SESSION_TOKEN) && fetchLog.some(f => f.path === '/api/logout' && f.auth === 'Bearer ' + SESSION_TOKEN && f.origin === OLD));
check('only that: the rest of the old settings are as they were', b.local.get('settings').backend.url === OLD && b.local.get('settings').customKeywords.Coding.length === 2);
{
    // The server's shared token in the old UI: never ended, never blanked.
    const s = makeBrowser();
    seed(s);
    s.local.set('settings', { ...s.local.get('settings'), backend: { url: ORIGIN, token: SHARED_TOKEN } });
    s.boot();
    await until(() => s.local.get('tpMove')?.state === 'pending');
    await connect(s);
    await copyLocalStorage(s);
    const early = s.page(50, 'doc-s');
    await early.attach();
    await early.request('session.report', { signedIn: true, username: 'alex', userId: 1 });
    await sleep(50);
    check('before the move is done a signed-in report signs nothing out', !s.local.get('tpMove')?.legacyToken && s.local.get('settings').backend.token === SHARED_TOKEN);
    await s.movePage('approve');
    const sp = s.page(50, 'doc-s2');
    await sp.attach();
    sp.click();
    const web = await webPage();
    await web.TreeStore.switchAccount(A);
    const answers = [];
    const rxs = receiver(web, sp, { answers });
    // Every part written here, and then the ack never arrives (the tab closed).
    const realReq = sp.request;
    let acks = 0;
    sp.request = async (op, body) => {
        if (op === 'move.ack' && ++acks === 1) throw Object.assign(new Error('The page closed.'), { code: 'unavailable' });
        return realReq(op, body);
    };
    let lost = null;
    try { await rxs.r.receive(); } catch (e) { lost = e.message; }
    check('an ack that never arrived: the parts are kept here, the move still pending', lost && [...rxs.moves.map.keys()].some(k => k.startsWith('part:'))
        && s.local.get('tpMove').state === 'pending');
    sp.request = realReq;
    sp.click();
    const reads = sp.calls.filter(c => c === 'move.part').length;
    await rxs.r.receive();
    check('Bring in again reads no part twice, and the move is done', sp.calls.filter(c => c === 'move.part').length === reads && s.local.get('tpMove').state === 'done');
    // A settle begun as another account (sam) goes on as alex only from a click.
    const ids = rxs.moves.map.get('index').bundles;
    for (const id of ids) rxs.moves.map.set('receipt:' + id, { bundleId: id, from: 'extension', at: '2026-10-02T00:00:00.000Z', outcome: {}, account: { url: ORIGIN, userId: 2, username: 'sam', serverId: 'srv-main' } });
    await rxs.r.settlePending();
    check('quietly, at a start, it waits', ids.every(id => !rxs.moves.map.get('receipt:' + id).done) && (await web.TreeStore.listStashes(A)).length === 0);
    answers.push(false, false);
    await rxs.r.settlePending({ interactive: true });
    check('"Continue as alex?" answered no: still nothing', ids.every(id => !rxs.moves.map.get('receipt:' + id).done) && (await web.TreeStore.listStashes(A)).length === 0);
    answers.push(true, true);
    await rxs.r.settlePending({ interactive: true });
    check('answered yes: settled as alex, each part once', ids.every(id => rxs.moves.map.get('receipt:' + id).done && rxs.moves.map.get('receipt:' + id).account.userId === 1)
        && JSON.stringify(web.TreeStore.roots()).includes('"Research"'));
    await sp.request('session.report', { signedIn: true, username: 'alex', userId: 1 });
    await until(() => s.local.get('tpMove')?.legacyToken);
    check('the shared token is left exactly as it is', s.local.get('tpMove').legacyToken.state === 'shared-kept' && s.local.get('settings').backend.token === SHARED_TOKEN);
}

console.log('\n9. After the move the toolbar opens the web app');
b.created.length = 0;
b.updated.length = 0;
b.worker.ev.clicked.fns.forEach(fn => fn({ id: 50 }));
await until(() => b.updated.some(u => u.id === 50) || b.created.length);
check('the web app tab is focused, not the move page', b.updated.some(u => u.id === 50 && u.props.active) && !b.created.some(t => t.url.includes('move.html')));
const hello2 = await page.attach();
check('hello no longer warns about the old copy\'s unpushed edits', hello2.legacy === null && hello2.move?.state === 'done');

console.log('\n10. Rollback: 1.1.0 finds its data untouched');
{
    const after = Object.fromEntries(b.local);
    const legacyKeys = ['tpTree', 'tpTreeStashIndex', 'tpTreeStash:https://old.example.com|1', 'tpTreeStash:https://other.example.org|1', 'tpTreeStash:https://old.example.com|legacy',
        'tpTreeStash:https://tp.example.com|2', 'tpTreeStash:https://old.example.com|1#1700000000000', 'tpTreeStash:https://gone.example.net|1', 'tpPendingRemovals', 'tpLiveDraft', 'tpParkedMirror', 'workflows', 'workflows_legacy_backup', 'tpUiExpanded'];
    for (const k of legacyKeys) check(`${k} is as it was`, JSON.stringify(after[k]) === JSON.stringify(before[k]));
    // The AI switch was retired by the background since 1.0.x; the key a
    // stale page wrote back (above) is still where it was, and never moved.
    const oldSettings = { ...before.settings, backend: { ...before.settings.backend, token: '' } };
    delete oldSettings.useAI;
    const canon = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));
    check('settings are as they were, but for the revoked session token', canon(after.settings) === canon(oldSettings),
        canon(after.settings) + ' / ' + canon(oldSettings));
    check('the old UI\'s localStorage keys were only copied', JSON.stringify(after.tpLegacyLocalStorage.keys) === JSON.stringify(OLD_LOCAL));
    // 1.1.0's own TreeStore, from git, over this storage.
    let dir = null;
    try {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-rollback-'));
        fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
        for (const f of ['treeStore.js', 'expandState.js']) {
            fs.writeFileSync(path.join(dir, f), execFileSync('git', ['-C', ROOT, 'show', `d8a9955:src/utils/${f}`], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
        }
    } catch (e) { dir = null; }
    if (!dir) {
        console.log('  --  1.1.0 is not in this checkout\'s history: its TreeStore was not loaded');
    } else {
        const saved = globalThis.__tpPlatform;
        delete globalThis.__tpPlatform;
        const listeners = [];
        globalThis.chrome = { storage: {
            local: { get: async (keys) => { const out = {}; for (const k of [].concat(keys)) if (b.local.has(k)) out[k] = clone(b.local.get(k)); return out; },
                set: async (obj) => { for (const [k, v] of Object.entries(obj)) b.local.set(k, clone(v)); }, remove: async () => {} },
            onChanged: { addListener: fn => listeners.push(fn) } } };
        const { TreeStore: Old } = await import(pathToFileURL(path.join(dir, 'treeStore.js')).href);
        globalThis.__tpPlatform = saved;
        await Old.load();
        const st = Old.status();
        // It applies its own queued removal (b2) as it loads, as it always
        // did: one more edit on top of the three.
        check('1.1.0 loads the same working copy, unpushed edits and all', st.dirty && st.editCount === 4 && st.owner?.url === ORIGIN && st.copyId === 'copy-ext'
            && JSON.stringify(Old.roots().map(r => r.id)) === JSON.stringify(before.tpTree.roots.map(r => r.id)) && !JSON.stringify(Old.roots()).includes('"b2"'), JSON.stringify(st));
        check('and lists the same set-aside copies', (await Old.listStashes()).length === before.tpTreeStashIndex.length);
        delete globalThis.chrome;
    }
}

console.log('\n11. The moved parts go to a database of their own, never touching the working copy\'s');
{
    const { createKv } = await import('../pwa/durableCopy.js');
    const { createMoveReceiver } = await import('../pwa/move.js');
    const idb = makeFakeIndexedDB();
    const kv = createKv(idb);
    await kv.write({ tpTree: { roots: [], seq: 1 } });
    // The receiver as the app makes it: IndexedDB, no store handed in.
    const rx = createMoveReceiver({ helper: { supports: () => false }, indexedDB: idb, ls: fakeLocalStorage(), account: () => null, origin: ORIGIN });
    check('nothing moved yet: no bundles', (await rx.bundles()).length === 0);
    check('the moves database has its store; the working copy\'s database is as it was (version, stores)',
        idb.stores('tabpaladin-moves').join() === 'moves' && idb.version('tabpaladin') === 1 && idb.stores('tabpaladin').join() === 'kv',
        `${idb.stores('tabpaladin-moves')} / ${idb.version('tabpaladin')} ${idb.stores('tabpaladin')}`);
    check('the working copy kept in kv is still there', JSON.stringify(await kv.get('tpTree')) === '{"roots":[],"seq":1}');
}

console.log('\n12. A helper restarted mid-hand-over makes each part again, and serves it only unchanged');
{
    const w = makeBrowser();
    seed(w);
    w.boot();
    await until(() => w.local.get('tpMove')?.state === 'pending');
    await connect(w);
    await copyLocalStorage(w);
    await w.movePage('approve');
    const p = w.page(50, 'doc-r');
    await p.attach();
    p.click();
    const manifest = await p.request('move.manifest', {});
    w.boot(); // the service worker stopped: no part in memory any more
    const part = await p.request('move.part', { bundleId: manifest.bundleId, partId: 'working', offset: 0 });
    const meta = manifest.parts.find(x => x.id === 'working');
    check('the part is made again and served, with the same digest', part.digest === meta.digest && part.total === meta.bytes && typeof part.chunk === 'string');
    const tree = w.local.get('tpTree');
    w.local.set('tpTree', { ...tree, editCount: tree.editCount + 1 });
    w.boot();
    let code = null;
    try { await p.request('move.part', { bundleId: manifest.bundleId, partId: 'working', offset: 0 }); } catch (e) { code = e.code; }
    check('changed since the manifest: refused, nothing half-old half-new', code === 'move-changed', code);
    code = null;
    try { await p.request('move.ack', { bundleId: manifest.bundleId, received: manifest.parts.slice(1).map(x => ({ id: x.id, digest: x.digest })) }); } catch (e) { code = e.code; }
    check('an ack that does not confirm every part records nothing', code === 'bad-args' && w.local.get('tpMove').state === 'pending', code);
    const other = w.page(50, 'doc-r2');
    await other.attach();
    code = null;
    try { await other.request('move.part', { bundleId: manifest.bundleId, partId: 'working', offset: 0 }); } catch (e) { code = e.code; }
    check('another document in the same tab cannot read the hand-over', code === 'move-not-approved', code);
}

console.log('\n14. The old session: only a sign-out the server took counts');
{
    const v = makeBrowser();
    seed(v);
    const token = 'sess-' + 'c3'.repeat(24);
    v.local.set('settings', { ...v.local.get('settings'), backend: { ...v.local.get('settings').backend, token } });
    sessions.add(token);
    v.boot();
    await until(() => v.local.get('tpMove')?.state === 'pending');
    await connect(v);
    await copyLocalStorage(v);
    await v.movePage('approve');
    const vp = v.page(50, 'doc-v');
    await vp.attach();
    vp.click();
    const web = await webPage();
    await web.TreeStore.switchAccount(A);
    await receiver(web, vp).r.receive();
    const report = () => vp.request('session.report', { signedIn: true, username: 'alex', userId: 1 });
    logoutAnswers.push(502);
    await report();
    await until(() => v.local.get('tpMove')?.legacyToken);
    const lt = v.local.get('tpMove').legacyToken;
    check('a sign-out a proxy answered 502 is not taken for the shared token: failed, to be tried again', v.local.get('tpMove').state === 'done' && lt.state === 'failed'
        && v.local.get('settings').backend.token === token && sessions.has(token), JSON.stringify(lt));
    const st = await v.movePage('status');
    check('the move page offers the sign-out again, and shows no digest of the token', st.legacyToken?.state === 'failed' && !('tokenMark' in st.legacyToken));
    await report();
    await sleep(30);
    check('a report straight after waits (asked again after a while)', sessions.has(token) && v.local.get('tpMove').legacyToken.state === 'failed');
    const r = await v.movePage('revoke', { force: true });
    check('"Sign the old session out now" asks at once: signed out on the server, blanked here', r.state === 'revoked' && !sessions.has(token)
        && v.local.get('settings').backend.token === '', JSON.stringify(r));
    // Back to 1.1.0 and signed in there again: that new token goes too.
    const token2 = 'sess-' + 'd4'.repeat(24);
    sessions.add(token2);
    v.local.set('settings', { ...v.local.get('settings'), backend: { ...v.local.get('settings').backend, token: token2 } });
    await report();
    await until(() => !sessions.has(token2) && v.local.get('settings').backend.token === '');
    check('a token signed in since (after going back to 1.1.0) is signed out and blanked too', !sessions.has(token2) && v.local.get('settings').backend.token === ''
        && v.local.get('tpMove').legacyToken.state === 'revoked');
    // One the server ended already: refused at sign-out (401), confirmed.
    v.local.set('settings', { ...v.local.get('settings'), backend: { ...v.local.get('settings').backend, token: 'sess-' + 'e5'.repeat(24) } });
    const r3 = await v.movePage('revoke', { force: true });
    check('a token the server ended already is blanked (401 to the sign-out, 401 to who-am-I)', r3.state === 'revoked' && v.local.get('settings').backend.token === '');
    check('no token, and no digest of one, ever reached the web app', !allText(web.map).includes(token) && !allText(web.map).includes('tokenMark'));
}

// A small IndexedDB: versions, an upgrade step that adds stores, and
// transactions that commit together.
function makeFakeIndexedDB() {
    const dbs = new Map();
    const conns = new Set();
    function open(name, version) {
        const req = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
        setTimeout(() => {
            const rec = dbs.get(name) || { version: 0, stores: new Map() };
            const target = version === undefined ? Math.max(1, rec.version) : version;
            dbs.set(name, rec);
            const conn = { name, version: rec.version, upgrading: false, closed: false, onversionchange: null, onclose: null,
                createObjectStore(n) { if (!conn.upgrading) throw new Error('InvalidStateError'); rec.stores.set(n, new Map()); },
                close() { conn.closed = true; conns.delete(conn); },
                transaction(store) {
                    if (conn.closed) throw Object.assign(new Error('closing'), { name: 'InvalidStateError' });
                    const data = rec.stores.get(store);
                    if (!data) throw Object.assign(new Error('NotFoundError'), { name: 'NotFoundError' });
                    const tx = { oncomplete: null, onabort: null, onerror: null };
                    const staged = new Map();
                    const ops = [];
                    const request = (fn) => { const r = { onsuccess: null }; ops.push(() => { r.result = fn(); if (r.onsuccess) r.onsuccess({ target: r }); }); return r; };
                    tx.objectStore = () => ({
                        get: k => request(() => (staged.has(k) ? staged.get(k) : clone(data.get(k)))),
                        put: (v, k) => request(() => { staged.set(k, clone(v)); }),
                        delete: k => request(() => { staged.set(k, undefined); })
                    });
                    tx.abort = () => {};
                    setTimeout(() => {
                        while (ops.length) ops.shift()();
                        for (const [k, v] of staged) { if (v === undefined) data.delete(k); else data.set(k, v); }
                        if (tx.oncomplete) tx.oncomplete();
                    }, 0);
                    return tx;
                } };
            Object.defineProperty(conn, 'objectStoreNames', { get: () => ({ contains: n => rec.stores.has(n) }) });
            conns.add(conn);
            req.result = conn;
            if (target > rec.version) {
                for (const c of conns) if (c !== conn && c.name === name && c.onversionchange) c.onversionchange({});
                rec.version = target;
                conn.version = target;
                conn.upgrading = true;
                if (req.onupgradeneeded) req.onupgradeneeded({ target: req });
                conn.upgrading = false;
            }
            if (req.onsuccess) req.onsuccess({ target: req });
        }, 0);
        return req;
    }
    return { open, version: n => dbs.get(n)?.version, stores: n => [...(dbs.get(n)?.stores.keys() || [])].sort() };
}

console.log(failures === 0 ? '\nAll move tests passed.\n' : `\n${failures} move test(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
