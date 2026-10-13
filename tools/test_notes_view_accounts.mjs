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
                for (const fn of storageListeners) fn(changes, 'local');
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
        appendChild(c) { return c; }, append() {}, remove() {},
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
globalThis.alert = (msg) => { console.log('ALERT', msg); };
globalThis.prompt = () => null;
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
const server = { 'tok-a': { userId: 1, version: 3, roots: aliceRoots }, 'tok-b': { userId: 2, version: 9, roots: bobRoots } };
globalThis.fetch = async (url, opts = {}) => {
    const token = String((opts.headers || {}).Authorization || '').replace('Bearer ', '');
    const acct = server[token];
    if (!acct || !String(url).endsWith('/api/tree')) throw new Error(`unexpected fetch ${url}`);
    const body = { ok: true, version: acct.version, roots: acct.roots(), userId: acct.userId, serverId: 'srv' };
    return { ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => JSON.stringify(body) };
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
// Another TabPaladin page bringing another copy in, as TreeStore writes it.
let otherWrites = 0;
const otherPageLoads = (owner, roots) => chrome.storage.local.set({
    tpTree: { baseVersion: 5, roots, dirty: false, owner, editCount: 0, copyId: `other-${++otherWrites}`, rev: `other-${otherWrites}` }
});

NV.initNotesView();
await TreeStore.load();
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

console.log(failures === 0 ? '\nAll notes-view account tests passed.\n' : `\n${failures} test(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
