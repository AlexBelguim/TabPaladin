// Headless test: the extension's notes view when the working copy becomes
// another account's.
//
// What this locks down (src/app/notesView.js with the real TreeStore and
// NotesManager, against a stub DOM):
//   1. Before a switch made in this page — sidepanel.js's
//      tabpaladin:before-account-switch, its helper lifted from the file —
//      an unsaved note is saved into the outgoing copy (and set aside with
//      it), discarded, or the switch is called off. Every sidepanel call that
//      sets the copy aside asks first.
//   2. After a switch the view starts over on the new account's library: no
//      open note, no draft, nothing "removed", no "Save the open note before
//      pushing?" — whether the switch happened here, in another page, or by
//      pulling another account's tree over the copy.
//   3. A draft nobody could ask about is parked under its account and comes
//      back into the editor only for that account: not for another one, nor
//      for the same id on a rebuilt server.
//   4. Fold state, scope and last open note are kept per account; sort stays
//      per device.
//   6. A parked draft waits until its account's copy is ready (pulled, or
//      holding something) and the editor is free, and lands on its note when
//      the note is there — never as a second copy of it.
//   7. A draft from a copy with no account of its own — from before accounts,
//      or at the old address of a server that moved — comes back when that
//      copy does, for the account allowed to take it, never before.
//   8. A pull asks the server whose tree it brings (sidepanel.js doPull and
//      signedInAccount, lifted from the file): a copy from before accounts
//      is set aside for anyone but the owner, so the draft in it is never
//      offered to them, and the owner's own pull keeps both.
//   9. When the server cannot say whose session it is, nothing is set aside
//      on a guess — not on what Settings last learned either: the pull stops
//      with "Couldn’t confirm the account — try again" and changes nothing,
//      and "set aside" is only ever said of a copy that was another
//      account's and was set aside.
//  10. Another page switching accounts while doPull waits (on /api/auth/me,
//      on /api/tree, or before an agreed pull starts) stops it: "Account
//      changed during pull — nothing was replaced."
//  11. Settings › Discard on a set-aside copy (handleStashAction, lifted)
//      names the note drafts parked with it that only it would bring back,
//      offers them as a Markdown file first, and lets them go only with the
//      copy, once confirmed — never one another copy would bring back.
//  12. Every answer applies only to the copy it was about (doPush, lifted
//      with setAsideAndPull): "pull the server's tree" after a refused push
//      never pulls into another account's copy brought in meanwhile, a push's
//      success is never applied to it, a pull agreed to stops when the copy
//      is edited before it lands, and Discard discards nothing — drafts
//      included — once the copy it listed was restored or replaced.
//
// Run: node tools/test_notes_view_accounts.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(name, cond, detail) {
    if (cond) {
        console.log(`  ok  ${name}`);
    } else {
        failures++;
        console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Past the notes view's 250 ms redraw after a tree change.
const settle = () => sleep(400);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// --- chrome mock ----------------------------------------------------------

const storageData = new Map();
const storageListeners = [];
globalThis.chrome = {
    storage: {
        local: {
            get: async (keys) => {
                const out = {};
                for (const k of [].concat(keys)) if (storageData.has(k)) out[k] = clone(storageData.get(k));
                return out;
            },
            set: async (obj) => {
                const changes = {};
                for (const [k, v] of Object.entries(obj)) {
                    changes[k] = { oldValue: storageData.get(k), newValue: clone(v) };
                    storageData.set(k, clone(v));
                }
                // Each page gets its own copy of what was written, as in the browser.
                for (const fn of storageListeners) fn(clone(changes), 'local');
            },
            remove: async (k) => { for (const key of [].concat(k)) storageData.delete(key); }
        },
        onChanged: { addListener: (fn) => storageListeners.push(fn) }
    },
    tabs: { create: async () => {} }
};

// --- a stub DOM: every id exists, nothing renders ---------------------------

const els = new Map();
function makeEl(id) {
    const listeners = {};
    const cls = new Set();
    const el = {
        id, value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, readOnly: false,
        title: '', placeholder: '', open: false, scrollTop: 0, offsetParent: {}, offsetWidth: 0, offsetHeight: 0,
        style: { display: '', setProperty() {} },
        dataset: {},
        classList: {
            add: (...c) => c.forEach(x => cls.add(x)),
            remove: (...c) => c.forEach(x => cls.delete(x)),
            toggle: (c, on) => { if (on === undefined) on = !cls.has(c); if (on) cls.add(c); else cls.delete(c); return on; },
            contains: (c) => cls.has(c)
        },
        addEventListener(t, fn) { (listeners[t] ||= []).push(fn); },
        removeEventListener() {},
        async fire(t, extra = {}) {
            for (const fn of listeners[t] || []) await fn({ target: el, preventDefault() {}, stopPropagation() {}, ...extra });
        },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        contains() { return false; },
        closest() { return null; },
        focus() { document.activeElement = el; },
        select() {}, blur() {}, setSelectionRange() {}, scrollIntoView() {},
        setAttribute() {}, getAttribute() { return null; }, removeAttribute() {}, toggleAttribute() {},
        appendChild(c) { return c; }, append() {}, remove() {}, replaceChildren() {},
        showModal() { this.open = true; }, close() { this.open = false; },
        getBoundingClientRect() { return { top: 0, left: 0, width: 1400, height: 800, right: 1400, bottom: 800 }; }
    };
    return el;
}
globalThis.document = {
    activeElement: null,
    readyState: 'complete',
    getElementById(id) { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    createElement(tag) { return makeEl(`<${tag}>`); },
    createTextNode(text) { return { nodeType: 3, textContent: String(text) }; },
    body: makeEl('body')
};
const ls = new Map();
const winListeners = {};
const confirms = [];
let answers = [];
globalThis.window = globalThis;
globalThis.innerWidth = 1400;
globalThis.innerHeight = 900;
globalThis.scrollY = 0;
globalThis.localStorage = { getItem: k => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: k => ls.delete(k) };
globalThis.confirm = (msg) => { const a = answers.length ? answers.shift() : false; confirms.push(msg); return a; };
const alerts = [];
globalThis.alert = (msg) => { alerts.push(msg); console.log('ALERT', msg); };
const prompts = [];
let promptAnswers = [];
globalThis.prompt = (msg) => { prompts.push(msg); return promptAnswers.length ? promptAnswers.shift() : null; };
globalThis.addEventListener = (t, fn) => { (winListeners[t] ||= []).push(fn); };
globalThis.dispatchEvent = (e) => { for (const fn of winListeners[e.type] || []) fn(e); return true; };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.CSS = { escape: (s) => String(s) };
globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } };

// --- the server: alice (#1) and bob (#2) ------------------------------------

const URL_S = 'https://server.test';
const ALICE = { url: URL_S, userId: 1, username: 'alice', serverId: 'srv' };
const BOB = { url: URL_S, userId: 2, username: 'bob', serverId: 'srv' };
const note = (id, title, content) => ({ id, kind: 'note', title, payload: { content, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' } });
const aliceRoots = () => [{ id: 'a-notes', kind: 'folder', title: 'TabPaladin Notes', role: 'notes', children: [
    { id: 'a-nb', kind: 'folder', title: 'Alice private', children: [
        { id: 'a-sub', kind: 'folder', title: 'Health', children: [note('a-note2', 'Medical', '# Medical\nalice medical')] },
        note('a-note1', 'Diary', '# Diary\nalice old text')
    ] }
] }];
const bobRoots = () => [{ id: 'b-notes', kind: 'folder', title: 'TabPaladin Notes', role: 'notes', children: [
    { id: 'b-nb', kind: 'folder', title: 'Bob work', children: [note('b-note1', 'Bob todo', '# Bob todo\n- [ ] ship')] }
] }];
// alice is the server's owner: what this browser held before accounts is hers.
const server = {
    'tok-a': { userId: 1, username: 'alice', tenancyOwner: true, version: 3, roots: aliceRoots },
    'tok-b': { userId: 2, username: 'bob', tenancyOwner: false, version: 9, roots: bobRoots }
};
const authMeCalls = [];
let authMeDown = false;
// Run once while a request to `path` (with `method`, any by default) is in
// flight: another page acting between a pull's or a push's awaits.
let duringFetch = null;
const puts = [];
globalThis.fetch = async (url, opts = {}) => {
    const token = String((opts.headers || {}).Authorization || '').replace('Bearer ', '');
    const acct = server[token];
    const method = opts.method || 'GET';
    const reply = (body, status = 200) => ({ ok: status < 400, status, statusText: status < 400 ? 'OK' : 'Refused', json: async () => body, text: async () => JSON.stringify(body) });
    if (duringFetch && String(url).endsWith(duringFetch.path) && (!duringFetch.method || duringFetch.method === method)) {
        const { fn } = duringFetch;
        duringFetch = null;
        await fn();
    }
    if (acct && String(url).endsWith('/api/auth/me')) {
        authMeCalls.push(token);
        if (authMeDown) throw new Error('offline');
        return reply({ ok: true, user: { id: acct.userId, username: acct.username, role: 'user', tenancyOwner: acct.tenancyOwner }, serverId: 'srv' });
    }
    if (!acct || !String(url).endsWith('/api/tree')) throw new Error(`unexpected fetch ${url}`);
    if (method === 'PUT') {
        const body = JSON.parse(opts.body);
        puts.push({ token, body });
        if (body.baseUserId !== undefined && Number(body.baseUserId) !== acct.userId) {
            return reply({ error: 'This working copy belongs to another account.', code: 'wrong-account', userId: acct.userId }, 412);
        }
        if (!body.force && Number(body.baseVersion) !== acct.version) return reply({ error: 'conflict', version: acct.version }, 409);
        const pushed = clone(body.roots);
        acct.version += 1;
        acct.roots = () => clone(pushed);
        return reply({ ok: true, version: acct.version, userId: acct.userId, serverId: 'srv' });
    }
    return reply({ ok: true, version: acct.version, roots: acct.roots(), userId: acct.userId, serverId: 'srv' });
};

storageData.set('tpTree', { baseVersion: 3, roots: aliceRoots(), dirty: false, owner: ALICE, editCount: 0, rev: 'seed' });

const { TreeStore } = await import('../src/utils/treeStore.js');
const { NotesManager } = await import('../src/utils/notesManager.js');
const NV = await import('../src/app/notesView.js');
const $ = (id) => document.getElementById(id);

// The helper sidepanel.js dispatches before every switch it makes, lifted
// from the file so this runs the shipped code.
const sidepanel = fs.readFileSync(path.join(ROOT, 'src/sidepanel/sidepanel.js'), 'utf8');
const helperSrc = (sidepanel.match(/async function beforeAccountSwitch\(action\) \{[\s\S]*?\n\}\n/) || [])[0];
check('sidepanel.js has beforeAccountSwitch', Boolean(helperSrc));
const beforeAccountSwitch = new Function(`${helperSrc}\nreturn beforeAccountSwitch;`)();

// Another TabPaladin page: its own TreeStore over the same storage, so what it
// does reaches this page the way it does in the browser.
const { TreeStore: OtherPage } = await import('../src/utils/treeStore.js?other-page');

// sidepanel.js's doPull and the signedInAccount it asks, lifted the same way,
// with Settings that has not learned who is signed in (or, with
// pullSettings changed, that still names someone else).
const lift = (name) => (sidepanel.match(new RegExp(`async function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`)) || [])[0];
const pullSrc = [lift('signedInAccount'), lift('doPull')];
check('sidepanel.js has signedInAccount and doPull', pullSrc.every(Boolean));
let pullToken = 'tok-b';
let pullSettings = { backend: { url: URL_S } };
const doPull = new Function('TreeStore', 'StorageManager', 'getSyncConfig', 'persistSyncStamp', 'Tree', 'pruneStaleExpandState', 'beforeAccountSwitch',
    `${pullSrc.join('\n')}\nreturn doPull;`)(
    TreeStore,
    { getSettings: async () => clone(pullSettings) },
    async () => ({ url: URL_S, token: pullToken }),
    async () => {},
    TreeStore.bookmarks,
    async () => {},
    beforeAccountSwitch
);
// And doPush, with the answers to a refused push it gives (setAsideAndPull,
// and doPull for "pull the server's tree").
const liftPlain = (name) => (sidepanel.match(new RegExp(`\\nfunction ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`)) || [])[0];
const pushSrc = [lift('signedInAccount'), lift('setAsideAndPull'), lift('doPush'), lift('doPull'), liftPlain('relocatedNote')];
check('sidepanel.js has setAsideAndPull and doPush', pushSrc.every(Boolean));
const doPush = new Function('TreeStore', 'StorageManager', 'getSyncConfig', 'persistSyncStamp', 'Tree', 'pruneStaleExpandState', 'beforeAccountSwitch',
    `${pushSrc.join('\n')}\nreturn doPush;`)(
    TreeStore,
    { getSettings: async () => clone(pullSettings) },
    async () => ({ url: URL_S, token: pullToken }),
    async () => {},
    TreeStore.bookmarks,
    async () => {},
    beforeAccountSwitch
);

async function type(id, text) {
    $(id).value = text;
    await $(id).fire('input');
}
// What a Push in the header does first (sidepanel.js beforeSync('push')).
async function pushPrompts() {
    const before = confirms.length;
    const pending = [];
    dispatchEvent(new CustomEvent('tabpaladin:before-sync', { detail: { kind: 'push', waitUntil: (p) => pending.push(p) } }));
    await Promise.allSettled(pending);
    return confirms.slice(before);
}
const editorText = () => `${$('noteTitleInput').value}\n${$('noteContentInput').value}`;
const parked = () => JSON.parse(ls.get('tp_notes_parked_v1') || '[]');
const uiPrefs = () => JSON.parse(ls.get('tp_notes_ui_v1') || '{}');
const accountPrefs = () => JSON.parse(ls.get('tp_notes_ui_accounts_v1') || '{}');
const libraryText = async () => JSON.stringify((await NotesManager.getLibrary()).notes.map(n => [n.title, n.content]));
async function stashOf(userId) {
    const keys = (await chrome.storage.local.get('tpTreeStashIndex')).tpTreeStashIndex || [];
    for (const k of [...keys].reverse()) {
        const s = storageData.get(k);
        if (s && s.owner && s.owner.userId === userId) return JSON.stringify(s.roots);
    }
    return '';
}
const leaveNotes = () => { $('notes-container').style.display = 'none'; };
const clearStashes = async () => { for (const st of await TreeStore.listStashes()) await TreeStore.discardStash(st.key); };
const diaries = async () => (await NotesManager.getLibrary()).notes.filter(n => n.title === 'Diary').map(n => [n.id, n.content]);
// Another TabPaladin page bringing another copy in, as TreeStore writes it.
let otherWrites = 0;
const otherPageLoads = (owner, roots, extra = {}) => chrome.storage.local.set({
    tpTree: { baseVersion: 5, roots, dirty: false, owner, editCount: 0, copyId: `other-${++otherWrites}`, rev: `other-${otherWrites}`, ...extra }
});

// Settings › Set-aside copies (sidepanel.js handleStashAction), lifted the
// same way, with what it downloads caught.
const stashActionSrc = (sidepanel.match(/\n {4}async function handleStashAction\(st, act, account\) \{[\s\S]*?\n {4}\}\n/) || [])[0];
check('sidepanel.js has handleStashAction', Boolean(stashActionSrc));
const downloads = [];
const blobs = new Map();
const handleStashAction = new Function('TreeStore', 'document', 'URL', 'Blob', 'parkedDraftsOnlyWith', 'dropParkedDrafts', 'parkedDraftsMarkdown',
    'renderStashes', 'beforeAccountSwitch', 'pruneStaleFocusedFolders', 'loadWorkflows',
    `${stashActionSrc}\nreturn handleStashAction;`)(
    TreeStore,
    { getElementById: (id) => $(id), createElement: () => ({ click() { downloads.push({ name: this.download, blob: blobs.get(this.href) }); } }) },
    { createObjectURL: (b) => { const u = `blob:${blobs.size}`; blobs.set(u, b); return u; }, revokeObjectURL() {} },
    Blob,
    NV.parkedDraftsOnlyWith, NV.dropParkedDrafts, NV.parkedDraftsMarkdown,
    async () => {}, beforeAccountSwitch, async () => 0, async () => {}
);
// Let an unsaved draft go, as Discard in the switch question does (section 1).
const discardDraft = async () => { answers = [false, true]; await beforeAccountSwitch('Starting over'); answers = []; };

NV.initNotesView();
await TreeStore.load();
await OtherPage.load();
await sleep(0);

console.log('1. Before a switch made here, an unsaved note is settled first');
{
    await NV.openNotes({ scope: 'nb:a-sub' });
    await NV.openNotes({ noteId: 'a-note1' });
    check('alice reads her note, its notebook open', $('noteTitleInput').value === 'Diary' && uiPrefs().expanded.includes('a-nb'),
        JSON.stringify(uiPrefs()));
    await type('noteContentInput', '# Diary\nalice draft one');
    leaveNotes(); // the gear: Settings opens with the draft left in Notes

    answers = [false, false];
    let n = confirms.length;
    check('Cancel twice calls the switch off', (await beforeAccountSwitch('Signing in as bob')) === false);
    check('…after saying whose copy is set aside and why',
        confirms.length === n + 2 && confirms[n].includes('Signing in as bob') && confirms[n].includes('alice’s'), confirms[n]);
    check('…and the draft is still there, unsaved', NV.isDirty() && $('noteContentInput').value.includes('alice draft one'));

    answers = [false, true];
    check('Discard lets the switch go ahead', (await beforeAccountSwitch('Signing in as bob')) === true);
    check('…with the note back as saved', !NV.isDirty() && $('noteContentInput').value === '# Diary\nalice old text'
        && !(await libraryText()).includes('alice draft one'));

    await type('noteContentInput', '# Diary\nalice draft two');
    answers = [true];
    check('Save lets the switch go ahead', (await beforeAccountSwitch('Signing in as bob')) === true);
    check('…with the note saved into alice’s copy', !NV.isDirty() && TreeStore.status().dirty
        && (await libraryText()).includes('alice draft two'));
    answers = [];
    check('with nothing unsaved, nothing is asked', (await beforeAccountSwitch('Signing in as bob')) === true);

    const sw = await TreeStore.switchAccount({ ...BOB, previousUsername: 'alice' });
    await TreeStore.sync.pull({ url: URL_S, token: 'tok-b' });
    await settle();
    check('the saved note was set aside with alice’s copy', sw.setAside && (await stashOf(1)).includes('alice draft two'));
    check('bob’s copy has none of it', !(await libraryText()).includes('alice') && (await libraryText()).includes('Bob todo'));
    check('the editor starts over: empty, nothing removed, nothing unsaved',
        editorText() === '\n' && $('nv-removed').hidden === true && !NV.isDirty());
    check('nothing needed parking', parked().length === 0);
    check('a Push asks nothing about a note', (await pushPrompts()).length === 0);

    await NV.openNotes();
    check('bob opening Notes sees his library only, no note open',
        !$('notes-list').innerHTML.includes('Diary') && $('notes-list').innerHTML.includes('Bob todo') && editorText() === '\n');
    check('bob starts from his own prefs', uiPrefs().scope === 'all' && uiPrefs().expanded.length === 0, JSON.stringify(uiPrefs()));
    $('nv-sort').value = 'title';
    await $('nv-sort').fire('change');
    const alicePrefs = accountPrefs()[`${URL_S}|1`] || {};
    check('alice’s fold state, scope and last note are kept for her, not pruned against bob’s library',
        JSON.stringify(alicePrefs.expanded) === '["a-nb"]' && alicePrefs.scope === 'nb:a-nb' && alicePrefs.noteId === 'a-note1',
        JSON.stringify(alicePrefs));
}

console.log('\n2. An unedited note crosses nothing, and alice gets her view back');
{
    await NV.openNotes({ noteId: 'b-note1' });
    check('bob reads his note', $('noteTitleInput').value === 'Bob todo' && !NV.isDirty());
    leaveNotes();
    const back = await TreeStore.switchAccount({ ...ALICE, previousUsername: 'bob' });
    await settle();
    check('alice’s copy comes back', back.action === 'restored' && (await libraryText()).includes('alice draft two'));
    check('bob’s open note is gone from the editor and nothing was parked', editorText() === '\n' && parked().length === 0 && !NV.isDirty());
    check('a Push asks nothing about a note', (await pushPrompts()).length === 0);
    await NV.openNotes();
    check('alice’s notebook fold state and scope come back', uiPrefs().expanded.includes('a-nb') && uiPrefs().scope === 'nb:a-nb',
        JSON.stringify(uiPrefs()));
    check('…her last note reopens, bob’s never does', $('noteTitleInput').value === 'Diary' && !editorText().includes('Bob'));
    check('…and the sort chosen on this device stays', uiPrefs().sort === 'title');
}

console.log('\n3. A switch made in another page parks the draft under its account');
{
    await type('noteContentInput', '# Diary\nALICE PARKED TEXT');
    check('alice has an unsaved draft, Notes on screen', NV.isDirty() && $('notes-container').style.display === 'block');
    await otherPageLoads(BOB, bobRoots());
    check('at once: the editor is empty and nothing is unsaved', editorText() === '\n' && !NV.isDirty() && $('nv-removed').hidden === true);
    check('the draft is parked under alice', parked().length === 1 && parked()[0].owner.userId === 1
        && parked()[0].noteId === 'a-note1' && parked()[0].content.includes('ALICE PARKED TEXT'), JSON.stringify(parked()));
    check('a Push asks nothing about a note', (await pushPrompts()).length === 0);
    await settle();
    check('bob’s library is drawn, the draft stays parked',
        $('notes-list').innerHTML.includes('Bob todo') && !$('notes-list').innerHTML.includes('Diary')
        && !editorText().includes('ALICE') && parked().length === 1);

    await otherPageLoads({ url: URL_S, userId: 1, username: 'alice', serverId: 'srv-rebuilt' }, []);
    await settle();
    await NV.openNotes();
    check('the same id on a rebuilt server at the same address is someone else: nothing comes back',
        !editorText().includes('ALICE') && parked().length === 1);

    await otherPageLoads(ALICE, aliceRoots());
    for (let i = 0; i < 50 && parked().length; i++) await sleep(20);
    check('alice’s copy back: her draft is back in the editor, unsaved, on her note',
        $('noteContentInput').value === '# Diary\nALICE PARKED TEXT' && NV.isDirty() && $('nv-removed').hidden === true
        && parked().length === 0);
    await $('saveNoteBtn').fire('click');
    await sleep(50);
    const lib = await NotesManager.getLibrary();
    check('Save puts it into her note, not a copy of it',
        lib.notes.filter(n => n.title === 'Diary').length === 1
        && lib.notes.find(n => n.id === 'a-note1').content === '# Diary\nALICE PARKED TEXT' && !NV.isDirty());
}

console.log('\n4. Another account’s tree pulled over the copy is a switch too');
{
    await $('newNoteBtn').fire('click');
    await type('noteTitleInput', 'Alice new idea');
    await type('noteContentInput', 'alice half-written thought');
    check('alice is writing a new note', NV.isDirty() && $('deleteNoteBtn').textContent === 'Discard new note');
    await TreeStore.sync.pull({ url: URL_S, token: 'tok-b' });
    check('the pull stamps the copy bob’s', TreeStore.status().owner.userId === 2);
    check('the new note is not offered to bob', editorText() === '\n' && !NV.isDirty() && (await pushPrompts()).length === 0);
    check('it is parked under alice as a new note', parked().length === 1 && parked()[0].owner.userId === 1
        && parked()[0].noteId === null && parked()[0].title === 'Alice new idea');
    await settle();
    check('bob’s copy has none of it', !(await libraryText()).includes('alice'));

    leaveNotes();
    await TreeStore.switchAccount({ ...ALICE, previousUsername: 'bob' });
    await TreeStore.sync.pull({ url: URL_S, token: 'tok-a' });
    await NV.openNotes();
    check('back as alice, the new note returns as a draft',
        $('noteTitleInput').value === 'Alice new idea' && $('noteContentInput').value === 'alice half-written thought'
        && NV.isDirty() && $('deleteNoteBtn').textContent === 'Discard new note' && parked().length === 0);
}

console.log('\n5. Every switch sidepanel.js makes asks first');
{
    const calls = [];
    for (const call of ['TreeStore.switchAccount(', 'TreeStore.setAsideAndReset(', 'TreeStore.restoreStash(']) {
        for (let i = sidepanel.indexOf(call); i !== -1; i = sidepanel.indexOf(call, i + 1)) {
            const head = sidepanel.slice(0, i);
            const start = Math.max(head.lastIndexOf('async function '), head.lastIndexOf('= async () => {'));
            const name = (sidepanel.slice(start).match(/^(?:async function (\w+)|= async)/) || [])[1]
                || (head.slice(0, start).match(/const (\w+)\s*$/) || [])[1];
            calls.push({ call, name, asks: sidepanel.slice(start, i).includes('beforeAccountSwitch(') });
        }
    }
    const names = calls.map(c => c.name).sort().join(',');
    check('the call sites are the four known ones', names === 'doPull,doSignIn,handleStashAction,setAsideAndPull', names);
    for (const c of calls) check(`${c.name} asks before ${c.call.slice(10, -1)}`, c.asks);
}

console.log('\n6. A parked draft waits for its account’s copy, and lands on its note');
{
    answers = [true];
    await $('deleteNoteBtn').fire('click');
    check('(the new note from 4 is discarded)', !NV.isDirty() && editorText() === '\n');
    await NV.openNotes({ noteId: 'a-note1' });
    await type('noteContentInput', '# Diary\nALICE WAITING');
    await OtherPage.switchAccount({ ...BOB, previousUsername: 'alice' });
    await settle();
    check('another page signs bob in: the draft is parked under alice',
        parked().length === 1 && parked()[0].owner.userId === 1 && editorText() === '\n');
    // There, Settings › Discard on alice's set-aside copy, then alice signs in
    // again: her copy starts empty, and her pull is still on its way.
    const aliceStash = (await OtherPage.listStashes()).filter(s => s.userId === 1).pop();
    await OtherPage.discardStash(aliceStash.key);
    await OtherPage.switchAccount({ ...ALICE, previousUsername: 'bob' });
    await settle();
    check('alice’s new, empty copy: the draft waits instead of coming back as text whose note is missing',
        TreeStore.status().owner.userId === 1 && TreeStore.status().isEmpty
        && editorText() === '\n' && $('nv-removed').hidden === true && parked().length === 1);
    await $('newNoteBtn').fire('click');
    await sleep(0);
    await type('noteTitleInput', 'Started while waiting');
    await OtherPage.sync.pull({ url: URL_S, token: 'tok-a' });
    await settle();
    check('her pull lands while she writes another note: that note stays, the draft keeps waiting',
        $('noteTitleInput').value === 'Started while waiting' && NV.isDirty() && parked().length === 1);
    answers = [true];
    await $('deleteNoteBtn').fire('click');
    await NV.openNotes();
    check('with the editor free again, the draft is back on her note, unsaved, nothing removed',
        $('noteContentInput').value === '# Diary\nALICE WAITING' && NV.isDirty()
        && $('nv-removed').hidden === true && parked().length === 0);
    await $('saveNoteBtn').fire('click');
    await sleep(50);
    check('Save updates her note: one Diary, holding the draft',
        JSON.stringify(await diaries()) === JSON.stringify([['a-note1', '# Diary\nALICE WAITING']]), JSON.stringify(await diaries()));

    await TreeStore.flush();
    await type('noteContentInput', '# Diary\nALICE AGAIN');
    await OtherPage.switchAccount({ ...BOB, previousUsername: 'alice' });
    await settle();
    // Her copy comes back from another page without that note, say deleted
    // on another device; a later pull brings it back.
    const withoutDiary = aliceRoots();
    withoutDiary[0].children[0].children = withoutDiary[0].children[0].children.filter(n => n.id !== 'a-note1');
    await otherPageLoads(ALICE, withoutDiary);
    await settle();
    check('back in a copy without its note, the draft is text to keep',
        $('noteContentInput').value === '# Diary\nALICE AGAIN' && NV.isDirty() && $('nv-removed').hidden === false);
    await chrome.storage.local.set({ tpTree: { ...storageData.get('tpTree'), roots: aliceRoots(), rev: 'pulled-back' } });
    await settle();
    check('the note comes back: the editor is on it again', $('nv-removed').hidden === true && NV.isDirty()
        && $('noteContentInput').value === '# Diary\nALICE AGAIN');
    await $('saveNoteBtn').fire('click');
    await sleep(50);
    check('…so Save updates it rather than keeping a second Diary',
        JSON.stringify(await diaries()) === JSON.stringify([['a-note1', '# Diary\nALICE AGAIN']]), JSON.stringify(await diaries()));
}

console.log('\n7. A draft from a copy with no account of its own comes back with that copy');
{
    await TreeStore.flush();
    await clearStashes();
    // What this browser held before accounts. alice is the server's owner.
    await otherPageLoads(null, aliceRoots());
    await settle();
    await NV.openNotes({ noteId: 'a-note1' });
    await NV.openNotes({ scope: 'nb:a-sub' });
    await type('noteContentInput', '# Diary\nOWNER DRAFT FROM BEFORE ACCOUNTS');
    await OtherPage.switchAccount({ ...BOB, tenancyOwner: false });
    await settle();
    check('bob signing in elsewhere parks it as the draft of the copy from before accounts',
        parked().length === 1 && parked()[0].owner === null && parked()[0].origin === 'pre-accounts', JSON.stringify(parked()));
    check('bob is not offered it', editorText() === '\n' && !NV.isDirty() && (await pushPrompts()).length === 0);
    await OtherPage.sync.pull({ url: URL_S, token: 'tok-b' });
    await settle();
    await NV.openNotes();
    check('nor once his tree is in', parked().length === 1 && !editorText().includes('OWNER'));
    await OtherPage.switchAccount({ ...ALICE, tenancyOwner: true, previousUsername: 'bob' });
    await settle();
    check('the owner signing in gets that copy back, and the draft with it, on its note',
        (TreeStore.status().restoredFrom[0] || {}).origin === 'pre-accounts'
        && $('noteContentInput').value === '# Diary\nOWNER DRAFT FROM BEFORE ACCOUNTS' && NV.isDirty()
        && $('nv-removed').hidden === true && parked().length === 0, JSON.stringify(TreeStore.status().restoredFrom));
    check('…and the notebook it had open', uiPrefs().scope === 'nb:a-sub', JSON.stringify(uiPrefs()));
    await $('saveNoteBtn').fire('click');
    await sleep(50);
    await TreeStore.flush();

    // The same server at a new address: alice's copy at the old one, with a
    // draft, set aside when she signs in at the new one in another page.
    const ALICE_MOVED = { ...ALICE, url: 'https://moved.server.test' };
    await NV.openNotes({ noteId: 'a-note2' });
    await type('noteContentInput', '# Medical\nDRAFT AT THE OLD ADDRESS');
    await OtherPage.switchAccount({ ...ALICE_MOVED, previousUsername: 'alice' });
    await OtherPage.sync.pull({ url: ALICE_MOVED.url, token: 'tok-a' });
    await settle();
    await NV.openNotes();
    check('at the new address the draft stays parked: the same server is never assumed',
        parked().length === 1 && parked()[0].owner.url === URL_S && !editorText().includes('OLD ADDRESS'));
    const moved = (await OtherPage.listStashes(ALICE_MOVED)).find(s => s.match === 'moved');
    await OtherPage.restoreStash(moved.key, ALICE_MOVED, { moved: true });
    await settle();
    check('once she restores that copy there, the draft comes back with it',
        $('noteContentInput').value === '# Medical\nDRAFT AT THE OLD ADDRESS' && NV.isDirty()
        && $('nv-removed').hidden === true && parked().length === 0);
    await $('saveNoteBtn').fire('click');
    await sleep(50);
    await TreeStore.flush();
}

console.log('\n8. A pull asks the server whose tree it brings');
{
    await clearStashes();
    await otherPageLoads(null, aliceRoots());
    await settle();
    await NV.openNotes({ noteId: 'a-note1' });
    await type('noteContentInput', '# Diary\nOWNER DRAFT, BOB’S TOKEN');
    // Settings never learned who is signed in, and the token is bob's.
    pullToken = 'tok-b';
    answers = [true];
    let n = confirms.length;
    const msg = await doPull();
    check('the pull learns from the server it is bob’s', authMeCalls.includes('tok-b'));
    check('…so it asks about the draft first, as any switch does', confirms.length > n && confirms[n].includes('This pull'), confirms[n]);
    check('…and sets the copy from before accounts aside instead of pulling over it',
        /set aside/.test(msg) && (await TreeStore.listStashes()).some(s => s.userId === null && s.origin === 'pre-accounts'), msg);
    const legacyStash = (await TreeStore.listStashes()).find(s => s.userId === null);
    check('…with the draft saved into it', JSON.stringify(storageData.get(legacyStash.key).roots).includes('OWNER DRAFT, BOB’S TOKEN'));
    check('bob has his own tree, and nothing of the draft',
        TreeStore.status().owner.userId === 2 && !(await libraryText()).includes('OWNER')
        && editorText() === '\n' && !NV.isDirty() && (await pushPrompts()).length === 0);

    // The owner's own session from before accounts, likewise unknown to
    // Settings: the pull is hers, so the copy and the draft stay.
    await clearStashes();
    await otherPageLoads(null, aliceRoots());
    await settle();
    await NV.openNotes({ noteId: 'a-note1' });
    await type('noteContentInput', '# Diary\nOWNER DRAFT, OWNER’S TOKEN');
    const copyBefore = TreeStore.status().copyId;
    pullToken = 'tok-a';
    n = confirms.length;
    await doPull();
    await settle();
    check('the owner pulling her own tree over it keeps the copy',
        TreeStore.status().copyId === copyBefore && TreeStore.status().owner.userId === 1
        && (await TreeStore.listStashes()).length === 0 && confirms.length === n);
    check('…and the draft stays in the editor, on her note', $('noteContentInput').value === '# Diary\nOWNER DRAFT, OWNER’S TOKEN'
        && NV.isDirty() && $('nv-removed').hidden === true && parked().length === 0);
    await discardDraft();
}

console.log('\n9. A pull that cannot confirm the account changes nothing');
{
    const cases = [
        ['the owner’s own token', 'tok-a', { backend: { url: URL_S } }],
        ['bob’s token, with Settings still naming alice as the owner', 'tok-b', { backend: { url: URL_S, userId: 1, username: 'alice', tenancyOwner: true } }]
    ];
    for (const [label, token, settings] of cases) {
        await clearStashes();
        // What this browser held before accounts, with unpushed edits.
        await otherPageLoads(null, aliceRoots(), { dirty: true, editCount: 2 });
        await settle();
        await NV.openNotes({ noteId: 'a-note1' });
        await type('noteContentInput', '# Diary\nOWNER DRAFT, SERVER UNSURE');
        const copyBefore = TreeStore.status().copyId;
        const revBefore = storageData.get('tpTree').rev;
        pullToken = token;
        pullSettings = settings;
        authMeDown = true;
        answers = [true, true];
        const a = alerts.length;
        const msg = await doPull();
        authMeDown = false;
        answers = [];
        await settle();
        check(`/api/auth/me down, ${label}: the pull stops with “Couldn’t confirm the account — try again”`,
            /^Couldn’t confirm the account — try again/.test(msg) && !/set aside/.test(msg) && alerts.length === a, msg);
        check('  nothing changed: the copy from before accounts is still the working copy, unpulled, nothing set aside',
            TreeStore.status().copyId === copyBefore && TreeStore.status().owner === null && TreeStore.status().dirty
            && storageData.get('tpTree').rev === revBefore && (await TreeStore.listStashes()).length === 0
            && !(await libraryText()).includes('Bob todo'));
        check('  the draft stays in the editor, on its note, and nothing is parked',
            $('noteContentInput').value === '# Diary\nOWNER DRAFT, SERVER UNSURE' && NV.isDirty()
            && $('nv-removed').hidden === true && parked().length === 0);
        await discardDraft();
    }

    // Settings still naming bob, alice's token and alice's own copy: what
    // Settings says is no reason to set her copy aside.
    await clearStashes();
    await otherPageLoads(ALICE, aliceRoots(), { dirty: true, editCount: 1 });
    await settle();
    const ownCopy = TreeStore.status().copyId;
    pullToken = 'tok-a';
    pullSettings = { backend: { url: URL_S, userId: 2, username: 'bob', tenancyOwner: false } };
    authMeDown = true;
    answers = [false];
    const kept = await doPull();
    authMeDown = false;
    answers = [];
    check('Settings naming bob, alice’s token, /api/auth/me down: her own copy is not set aside on Settings’ word',
        kept === 'Pull cancelled.' && TreeStore.status().copyId === ownCopy && TreeStore.status().owner.userId === 1
        && TreeStore.status().dirty && (await TreeStore.listStashes()).length === 0, kept);
    pullSettings = { backend: { url: URL_S } };

    // The copy says whose it is: then the server's tree says the rest, and
    // "set aside" is said because it was.
    await clearStashes();
    await otherPageLoads(ALICE, aliceRoots(), { dirty: true, editCount: 1 });
    await settle();
    pullToken = 'tok-b';
    authMeDown = true;
    answers = [true];
    const aside = await doPull();
    authMeDown = false;
    answers = [];
    await settle();
    check('alice’s copy, bob’s token, /api/auth/me down: her copy is set aside, and the message says so',
        /The other account’s working copy is set aside/.test(aside) && TreeStore.status().owner.userId === 2
        && (await TreeStore.listStashes()).some(s => s.userId === 1 && s.dirty) && (await libraryText()).includes('Bob todo'), aside);

    // Nothing to set aside: then nothing is said about it.
    await clearStashes();
    await otherPageLoads(ALICE, []);
    await settle();
    const nothing = await doPull();
    check('alice’s empty copy, bob’s token: bob’s tree comes in, and no copy is said to be set aside',
        /^Pulled \d+ item/.test(nothing) && !/set aside/.test(nothing) && TreeStore.status().owner.userId === 2
        && (await TreeStore.listStashes()).length === 0, nothing);
}

console.log('\n10. Another page switching accounts while a pull waits');
{
    await clearStashes();
    await otherPageLoads(ALICE, aliceRoots());
    await settle();
    for (const path of ['/api/auth/me', '/api/tree']) {
        await otherPageLoads(ALICE, aliceRoots());
        await settle();
        pullToken = 'tok-a';
        duringFetch = { path, fn: async () => { await OtherPage.switchAccount({ ...BOB, previousUsername: 'alice' }); } };
        const a = alerts.length;
        const msg = await doPull();
        duringFetch = null;
        await settle();
        check(`bob signed in elsewhere during the pull’s ${path}: “Account changed during pull — nothing was replaced.”`,
            msg === 'Account changed during pull — nothing was replaced.' && alerts.length === a, msg);
        check('  bob’s copy is the working copy, and none of alice’s tree came into it',
            TreeStore.status().owner.userId === 2 && TreeStore.status().copyId === OtherPage.status().copyId
            && !(await libraryText()).includes('Diary') && !JSON.stringify(storageData.get('tpTree').roots).includes('a-note1'));
    }

    // A push refused as out of date, answered "pull the server's tree": that
    // answer was about the copy then, not one another page brings in after.
    await otherPageLoads(ALICE, aliceRoots());
    await settle();
    const otherCopy = aliceRoots();
    otherCopy[0].children.push({ id: 'a-other', kind: 'folder', title: 'ALICE OTHER UNPUSHED', children: [] });
    duringFetch = { path: '/api/auth/me', fn: () => otherPageLoads(ALICE, otherCopy, { dirty: true, editCount: 1 }) };
    const theirs = await doPull({ skipConfirm: true });
    duringFetch = null;
    check('a pull already agreed to stops when another copy comes in before it starts',
        theirs === 'Account changed during pull — nothing was replaced.' && TreeStore.status().dirty
        && JSON.stringify(storageData.get('tpTree').roots).includes('ALICE OTHER UNPUSHED'), theirs);
}

console.log('\n11. Discarding a set-aside copy offers the drafts parked with it');
{
    // A draft from before accounts, parked when another page signed bob in,
    // and one of alice's own, which that copy would never bring back.
    await clearStashes();
    ls.delete('tp_notes_parked_v1');
    await otherPageLoads(null, aliceRoots());
    await settle();
    await NV.openNotes({ noteId: 'a-note1' });
    await type('noteContentInput', '# Diary\nDRAFT OF A COPY ABOUT TO GO');
    await OtherPage.switchAccount({ ...BOB, tenancyOwner: false });
    await settle();
    const aliceOwn = { owner: { ...ALICE }, origin: null, noteId: 'a-note2', notebookId: 'a-sub', title: 'Medical', content: 'ALICE OWN DRAFT',
        loaded: { title: 'Medical', content: '# Medical' }, parkedAt: '2026-10-01T00:00:00.000Z' };
    ls.set('tp_notes_parked_v1', JSON.stringify([...parked(), aliceOwn]));
    const legacy = (await TreeStore.listStashes()).find(s => s.userId === null);
    check('the draft is parked with the copy from before accounts, which is set aside',
        legacy && parked().some(d => d.origin === 'pre-accounts' && d.content.includes('ABOUT TO GO')), JSON.stringify(parked()));
    check('that copy is the only way back for that draft, not for alice’s',
        JSON.stringify(NV.parkedDraftsOnlyWith(legacy.stamps).map(d => d.content)) === '["# Diary\\nDRAFT OF A COPY ABOUT TO GO"]');
    check('  and not the only way when another kept copy would bring it back too',
        NV.parkedDraftsOnlyWith(legacy.stamps, [legacy.stamps]).length === 0);

    answers = [true];
    promptAnswers = ['nope'];
    let n = confirms.length;
    let p = prompts.length;
    await handleStashAction(legacy, 'discard', null);
    check('Discard names the draft and offers it as a file first',
        confirms.length === n + 1 && confirms[n].includes('1 unsaved note draft (“Diary”)') && confirms[n].includes('comes back only with this copy'),
        confirms[n]);
    const file = downloads.length === 1 ? await downloads[0].blob.text() : '';
    check('  the file holds the draft as it was left', downloads.length === 1 && downloads[0].name.endsWith('-note-drafts.md')
        && file.includes('# Diary\nDRAFT OF A COPY ABOUT TO GO') && !file.includes('ALICE OWN DRAFT'), file);
    check('  the typed confirmation says the draft goes with the copy',
        prompts.length === p + 1 && prompts[p].includes('1 unsaved note draft (“Diary”)') && prompts[p].includes('Type discard'), prompts[p]);
    check('  a wrong word discards nothing: the copy and both drafts stay',
        (await TreeStore.listStashes()).some(s => s.key === legacy.key) && parked().length === 2);

    answers = [false];
    promptAnswers = ['discard'];
    n = confirms.length;
    await handleStashAction(legacy, 'discard', null);
    check('declining the file this time downloads nothing', confirms.length === n + 1 && downloads.length === 1);
    check('the copy is discarded with the draft only it would bring back',
        !(await TreeStore.listStashes()).some(s => s.key === legacy.key) && !JSON.stringify(parked()).includes('ABOUT TO GO')
        && $('stash-status').textContent === 'Discarded, with its note draft.', $('stash-status').textContent);
    check('alice’s own draft stays parked for her', parked().length === 1 && parked()[0].content === 'ALICE OWN DRAFT');

    // The same for a copy at a server's old address, set aside when alice
    // signed in at the new one elsewhere.
    ls.delete('tp_notes_parked_v1');
    await clearStashes();
    await otherPageLoads(ALICE, aliceRoots());
    await settle();
    await NV.openNotes({ noteId: 'a-note1' });
    await type('noteContentInput', '# Diary\nDRAFT AT AN OLD ADDRESS');
    const ALICE_MOVED = { ...ALICE, url: 'https://moved.server.test' };
    await OtherPage.switchAccount({ ...ALICE_MOVED, previousUsername: 'alice' });
    await settle();
    const old = (await TreeStore.listStashes()).find(s => s.url === URL_S && s.userId === 1);
    check('a draft at the old address is parked under it', old && parked().length === 1 && parked()[0].owner.url === URL_S);
    answers = [false];
    promptAnswers = ['alice'];
    p = prompts.length;
    await handleStashAction(old, 'discard', null);
    check('discarding that copy names its draft and lets it go with it',
        prompts[p].includes('1 unsaved note draft (“Diary”)') && prompts[p].includes('Type alice')
        && !(await TreeStore.listStashes()).some(s => s.key === old.key) && parked().length === 0, prompts[p]);
}

console.log('\n12. Every answer applies only to the copy it was about');
{
    const has = (v, text) => JSON.stringify(v || null).includes(text);
    const stored = () => storageData.get('tpTree');
    const stashWith = (text) => [...storageData.entries()].filter(([k]) => k.startsWith('tpTreeStash:')).map(([, v]) => v).find(s => has(s.roots, text));
    // bob's copy, set aside earlier in this browser with an edit he never pushed.
    const bobAside = async () => {
        const key = `tpTreeStash:${URL_S}|2`;
        const roots = bobRoots();
        roots[0].children.push({ id: 'b-unpushed', kind: 'folder', title: 'BOB UNPUSHED', children: [] });
        await chrome.storage.local.set({
            [key]: { roots, baseVersion: 9, dirty: true, editCount: 1, owner: { ...BOB }, origin: null, url: URL_S, username: 'bob',
                setAsideAt: new Date().toISOString(), focusedFolderIds: [], expanded: {}, pendingRemovals: [] },
            tpTreeStashIndex: [...((await chrome.storage.local.get('tpTreeStashIndex')).tpTreeStashIndex || []).filter(k => k !== key), key]
        });
    };
    const aliceUnpushed = () => {
        const roots = aliceRoots();
        roots[0].children.push({ id: 'a-unpushed', kind: 'folder', title: 'ALICE UNPUSHED', children: [] });
        return roots;
    };
    // Another page signing bob in, as doSignIn does: the token first, then the switch.
    const bobSignsInElsewhere = async () => {
        pullToken = 'tok-b';
        await OtherPage.switchAccount({ ...BOB, previousUsername: 'alice' });
    };
    pullSettings = { backend: { url: URL_S } };

    // With nobody else acting, every answer to a refused push still works.
    await clearStashes();
    await otherPageLoads(ALICE, aliceUnpushed(), { baseVersion: server['tok-a'].version - 1, dirty: true, editCount: 1 });
    await settle();
    pullToken = 'tok-a';
    answers = [true];
    const pulledTheirs = await doPush();
    answers = [];
    check('a push refused as out of date, answered "pull the server’s tree", pulls it into the copy that was refused',
        /^Pulled \d+ item/.test(pulledTheirs) && stored().owner.userId === 1 && !stored().dirty
        && stored().baseVersion === server['tok-a'].version && !has(stored().roots, 'ALICE UNPUSHED'), pulledTheirs);
    await otherPageLoads(ALICE, aliceUnpushed(), { baseVersion: server['tok-a'].version - 1, dirty: true, editCount: 1 });
    await settle();
    answers = [false, true];
    const forced = await doPush();
    answers = [];
    check('  answered "force", it force-pushes that copy', /^Force-pushed \(v\d+\)\.$/.test(forced) && !stored().dirty
        && has(server['tok-a'].roots(), 'ALICE UNPUSHED'), forced);
    await otherPageLoads(ALICE, aliceUnpushed(), { dirty: true, editCount: 1 });
    await settle();
    pullToken = 'tok-b';
    answers = [true];
    const asideMsg = await doPush();
    answers = [];
    check('a push refused as another account’s (412) sets that copy aside and pulls this account’s tree',
        /^Set the other account's copy aside and pulled/.test(asideMsg) && stored().owner.userId === 2
        && Boolean(stashWith('ALICE UNPUSHED')), asideMsg);

    // A push refused as out of date while bob signs in elsewhere; the answer
    // is "pull the server's tree".
    await clearStashes();
    await otherPageLoads(ALICE, aliceUnpushed(), { baseVersion: server['tok-a'].version - 1, dirty: true, editCount: 1 });
    await bobAside();
    await settle();
    pullToken = 'tok-a';
    duringFetch = { path: '/api/tree', method: 'PUT', fn: bobSignsInElsewhere };
    answers = [true];
    const theirs = await doPush();
    duringFetch = null;
    answers = [];
    await settle();
    check('a push refused while bob signed in elsewhere, answered "pull the server’s tree": nothing is pulled into bob’s copy',
        theirs === 'Account changed during pull — nothing was replaced.', theirs);
    check('  bob’s copy is the working copy, with his unpushed edit', stored().owner.userId === 2 && stored().dirty
        && has(stored().roots, 'BOB UNPUSHED') && TreeStore.status().owner.userId === 2);
    check('  and alice’s unpushed edit waits in her set-aside copy', stashWith('ALICE UNPUSHED') && stashWith('ALICE UNPUSHED').owner.userId === 1
        && stashWith('ALICE UNPUSHED').dirty);

    // A push that goes through while bob signs in elsewhere.
    await clearStashes();
    await otherPageLoads(ALICE, aliceUnpushed(), { baseVersion: server['tok-a'].version, dirty: true, editCount: 1 });
    await bobAside();
    await settle();
    pullToken = 'tok-a';
    duringFetch = { path: '/api/tree', method: 'PUT', fn: bobSignsInElsewhere };
    const pushedMsg = await doPush();
    duringFetch = null;
    await settle();
    check('a push that goes through while bob signs in elsewhere says the copy here was left as it is',
        /^Pushed \(v\d+\)\. The working copy here is another account’s now/.test(pushedMsg)
        && has(server['tok-a'].roots(), 'ALICE UNPUSHED'), pushedMsg);
    check('  bob’s copy is not marked pushed or stamped as alice’s: his edit is still his, unpushed',
        stored().owner.userId === 2 && stored().dirty && stored().baseVersion === 9 && has(stored().roots, 'BOB UNPUSHED')
        && !puts.some(p => p.token === 'tok-a' && has(p.body.roots, 'BOB UNPUSHED')));

    // A pull agreed to over unpushed edits, while another page saves a link
    // during the question.
    await clearStashes();
    await otherPageLoads(ALICE, aliceUnpushed(), { dirty: true, editCount: 1 });
    await settle();
    pullToken = 'tok-a';
    let savedElsewhere = null;
    const realConfirm = globalThis.confirm;
    globalThis.confirm = (msg) => {
        confirms.push(msg);
        savedElsewhere = (async () => {
            await OtherPage.createNode({ parentId: null, kind: 'bookmark', title: 'SAVED DURING THE QUESTION', url: 'https://saved.example' });
            await OtherPage.flush();
        })();
        return true;
    };
    const agreed = await doPull();
    globalThis.confirm = realConfirm;
    await savedElsewhere;
    await settle();
    check('a link saved elsewhere while “pull anyway?” is open stops the pull: “Changed during pull — nothing was replaced; pull again.”',
        agreed === 'Changed during pull — nothing was replaced; pull again.', agreed);
    check('  the link and the unpushed edit are both kept', has(stored().roots, 'SAVED DURING THE QUESTION') && has(stored().roots, 'ALICE UNPUSHED')
        && stored().dirty);

    // Discard on a copy restored meanwhile.
    await clearStashes();
    ls.delete('tp_notes_parked_v1');
    await otherPageLoads(null, aliceRoots());
    await settle();
    await NV.openNotes({ noteId: 'a-note1' });
    await type('noteContentInput', '# Diary\nDRAFT OF A COPY RESTORED MEANWHILE');
    leaveNotes();
    await OtherPage.switchAccount({ ...BOB, tenancyOwner: false });
    await settle();
    const listed = (await TreeStore.listStashes()).find(s => s.userId === null);
    check('(the copy from before accounts is set aside, its draft parked)', listed && parked().some(d => d.content.includes('RESTORED MEANWHILE')));
    await OtherPage.switchAccount({ ...ALICE, tenancyOwner: true, previousUsername: 'bob' });
    await settle();
    answers = [false];
    promptAnswers = ['discard'];
    await handleStashAction(listed, 'discard', null);
    answers = [];
    promptAnswers = [];
    check('Discard on a copy the owner restored meanwhile discards nothing, and says so',
        /no longer set aside.*Nothing was discarded/.test($('stash-status').textContent)
        && TreeStore.status().owner.userId === 1 && TreeStore.status().restoredFrom.some(s => s.origin === 'pre-accounts'), $('stash-status').textContent);
    await NV.openNotes();
    await settle();
    check('  its draft is not dropped: it comes back with the copy', $('noteContentInput').value.includes('DRAFT OF A COPY RESTORED MEANWHILE')
        && parked().length === 0, JSON.stringify(parked()));
    await discardDraft();
    leaveNotes();

    // Discard on a copy set aside again since, under the same key.
    await clearStashes();
    await otherPageLoads(ALICE, aliceUnpushed(), { dirty: true, editCount: 1 });
    await settle();
    await OtherPage.switchAccount({ ...BOB, tenancyOwner: false, previousUsername: 'alice' });
    const first = (await TreeStore.listStashes()).find(s => s.userId === 1);
    await sleep(5);
    await OtherPage.switchAccount({ ...ALICE, previousUsername: 'bob' });
    await OtherPage.createNode({ parentId: null, kind: 'folder', title: 'ALICE LATER EDIT', });
    await OtherPage.flush();
    await OtherPage.switchAccount({ ...BOB, tenancyOwner: false, previousUsername: 'alice' });
    const again = (await TreeStore.listStashes()).find(s => s.userId === 1);
    promptAnswers = ['alice'];
    await handleStashAction(first, 'discard', null);
    promptAnswers = [];
    check('Discard on a copy set aside again since under the same key leaves that copy, with its later edit',
        again && again.key === first.key && again.setAsideAt !== first.setAsideAt
        && (await TreeStore.listStashes()).some(s => s.key === first.key) && has(stashWith('ALICE LATER EDIT'), 'ALICE UNPUSHED')
        && /Nothing was discarded/.test($('stash-status').textContent), $('stash-status').textContent);
}

console.log(failures === 0 ? '\nAll notes-view account tests passed.\n' : `\n${failures} test(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
