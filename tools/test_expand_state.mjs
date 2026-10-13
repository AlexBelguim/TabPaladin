// Headless test for remembered open/closed cards on the extension's main page.
//
// What this locks down:
//   1. src/utils/expandState.js: saved state comes back, defaults hold for
//      cards never touched, junk in storage is ignored, a drag-hover open
//      lasts the session but is never written, writes are debounced, another
//      page's newer toggle is adopted, and the map is capped.
//   2. Pruning drops only tree ids that are gone — and never runs against an
//      empty working copy or after a failed startup pull, where every saved
//      folder would look deleted. Driven through the same guard the sidepanel
//      uses (pruneAgainstTree), against the real TreeStore.
//   3. Row paging in big folders: a body shows its first rows with "Show
//      more" buttons, and every bulk action on a domain group (drag, ▶ All,
//      ▶ 10, delete) still acts on the whole group, not on the visible rows.
//      appendDomainGroups is lifted from sidepanel.js itself and run against
//      a minimal DOM, since the sidepanel cannot be imported headless.
//
// Run: node tools/test_expand_state.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(name, cond, detail) {
    if (cond) {
        console.log(`  ok  ${name}`);
    } else {
        failures++;
        console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

// --- chrome mock ----------------------------------------------------------

const storageData = new Map();
const storageListeners = [];
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const local = {
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
    remove: async (k) => { storageData.delete(k); }
};
globalThis.chrome = {
    storage: { local, onChanged: { addListener: (fn) => storageListeners.push(fn) } }
};

const KEY = 'tpUiExpanded';
const stored = () => (storageData.get(KEY) || {}).cards || {};

storageData.set(KEY, {
    v: 1,
    cards: {
        aaaa: { o: 1, t: 5 },
        gone: { o: 1, t: 6 },
        __open_tabs__: { o: 0, t: 7 },
        'aigroup:news': { o: 0, t: 8 },
        'imp:3:x1': { o: 1, t: 9 },
        bad: { o: 'x', t: 1 },
        nul: null,
        noflag: { t: 3 }
    }
});

const { ExpandState, OPEN_TABS_KEY, aiGroupKey } = await import('../src/utils/expandState.js');
const { TreeStore } = await import('../src/utils/treeStore.js');

console.log('restore and defaults');
await Promise.all([TreeStore.load(), ExpandState.load()]);
check('a folder left open comes back open', ExpandState.isOpen('aaaa') === true);
check('Open Tabs remembered collapsed despite defaulting open', ExpandState.isOpen(OPEN_TABS_KEY, true) === false);
check('an AI group remembered collapsed, keyed by its name', ExpandState.isOpen(aiGroupKey('  News '), true) === false);
check('never-touched folder defaults closed', ExpandState.isOpen('never') === false);
check('never-touched Open Tabs / AI group default open',
    ExpandState.isOpen(OPEN_TABS_KEY + 'x', true) === true && ExpandState.isOpen(aiGroupKey('Shopping'), true) === true);
check('malformed entries are ignored (default applies)',
    ExpandState.isOpen('bad', true) === true && ExpandState.isOpen('nul', true) === true
    && ExpandState.isOpen('noflag', true) === true && ExpandState.isOpen('bad') === false);

console.log('session-only spring open');
ExpandState.openForSession('spring');
check('a drag-hover open is honoured this session', ExpandState.isOpen('spring') === true);
await ExpandState.flush();
check('…and never written', !('spring' in stored()));
ExpandState.openForSession('springclose');
ExpandState.set('springclose', false);
check('an explicit close overrides a drag-hover open', ExpandState.isOpen('springclose') === false);

console.log('writes');
ExpandState.set('bbbb', true);
check('a toggle is not written synchronously (debounced)', !('bbbb' in stored()));
await ExpandState.flush();
check('set() persists after the debounce/flush', stored().bbbb && stored().bbbb.o === 1 && stored().bbbb.t > 0);
check('the stored map keeps the v:1 shape', storageData.get(KEY).v === 1);
check('malformed entries are not written back', !('bad' in stored()) && !('nul' in stored()));

console.log('prune guard');
const before = JSON.stringify(storageData.get(KEY));
check('working copy is empty before any tree arrives', TreeStore.status().isEmpty === true);
let dropped = await ExpandState.pruneAgainstTree(TreeStore);
await ExpandState.flush();
check('empty working copy: nothing pruned', dropped === 0, String(dropped));
check('empty working copy: map untouched', JSON.stringify(storageData.get(KEY)) === before);
check('empty working copy: folders still remembered open', ExpandState.isOpen('gone') === true);

// A tree arrives the way a pull or another page's write lands: through storage.
await local.set({
    tpTree: {
        baseVersion: 3,
        dirty: false,
        rev: 'other-page',
        roots: [
            { id: 'aaaa', kind: 'folder', title: 'Bookmarks', role: 'bookmarks', children: [
                { id: 'bbbb', kind: 'folder', title: 'Work', children: [] }
            ]},
            { id: 'imports:root', kind: 'folder', title: 'TabPaladin Imports', virtual: true, readOnly: true, children: [
                { id: 'imp:3:x1', kind: 'bookmark', title: 'Saved post', url: 'https://reddit.com/x1' }
            ]}
        ]
    }
});
check('tree adopted (non-empty now)', TreeStore.status().isEmpty === false);

dropped = await ExpandState.pruneAgainstTree(TreeStore, { syncError: 'Failed to fetch' });
await ExpandState.flush();
check('startup sync error: nothing pruned', dropped === 0 && JSON.stringify(storageData.get(KEY)) === before);

dropped = await ExpandState.pruneAgainstTree(TreeStore);
await ExpandState.flush();
const after = stored();
check('prune drops only tree ids that are gone', dropped === 2 && !after.gone && !after.springclose,
    `${dropped} dropped; keys ${Object.keys(after).join(',')}`);
check('…keeps folders that still exist, virtual import ids included', after.aaaa && after.bbbb && after['imp:3:x1']);
check('…and never prunes UI keys', after.__open_tabs__ && after['aigroup:news']);

console.log('other pages');
await local.set({ [KEY]: { v: 1, cards: { aaaa: { o: 0, t: Date.now() + 1000 } } } });
check('a newer toggle from another TabPaladin page is adopted', ExpandState.isOpen('aaaa') === false);
await local.set({ [KEY]: { v: 1, cards: { bbbb: { o: 0, t: 1 } } } });
check('an older write from another page does not undo a newer local toggle', ExpandState.isOpen('bbbb') === true);
await local.set({ [KEY]: { v: 2, cards: { bbbb: { o: 0, t: Date.now() + 5000 } } } });
check('an unknown format version is ignored', ExpandState.isOpen('bbbb') === true);

console.log('cap');
for (let i = 0; i < 700; i++) ExpandState.set('k' + i, true);
await ExpandState.flush();
const capped = stored();
check('at most 500 entries are kept', Object.keys(capped).length === 500, String(Object.keys(capped).length));
check('the most recently touched survive', capped.k699 && capped.k500);

console.log('storage failures');
const realSet = local.set;
local.set = async () => { throw new Error('QUOTA_BYTES quota exceeded'); };
let threw = false;
try {
    ExpandState.set('quota', true);
    await ExpandState.flush();
} catch (e) { threw = true; }
local.set = realSet;
check('a failing write is swallowed', !threw);
check('…and the toggle still holds for this page', ExpandState.isOpen('quota') === true);

const realGet = local.get;
local.get = async () => { throw new Error('storage unavailable'); };
const fresh = await import('../src/utils/expandState.js?fresh=1');
threw = false;
try { await fresh.ExpandState.load(); } catch (e) { threw = true; }
local.get = realGet;
check('a failing read loads defaults instead of throwing',
    !threw && fresh.ExpandState.isOpen('aaaa') === false && fresh.ExpandState.isOpen(OPEN_TABS_KEY, true) === true);

// --- Row paging -----------------------------------------------------------
//
// Just enough DOM for appendDomainGroups: elements, fragments, a tiny HTML
// parser for its innerHTML templates, class selectors and listeners.

class Node {
    constructor() { this.parentNode = null; this.childNodes = []; }
    appendChild(n) { return this.insertBefore(n, null); }
    insertBefore(n, ref) {
        const nodes = n instanceof Fragment ? n.childNodes.splice(0) : [n];
        for (const x of nodes) {
            if (x.parentNode) x.parentNode._drop(x);
            x.parentNode = this;
        }
        const at = ref ? this.childNodes.indexOf(ref) : -1;
        this.childNodes.splice(at < 0 ? this.childNodes.length : at, 0, ...nodes);
        return n;
    }
    replaceChildren(...nodes) {
        for (const c of this.childNodes) c.parentNode = null;
        this.childNodes = [];
        for (const n of nodes) this.appendChild(n);
    }
    _drop(x) {
        const i = this.childNodes.indexOf(x);
        if (i >= 0) this.childNodes.splice(i, 1);
        x.parentNode = null;
    }
    remove() { if (this.parentNode) this.parentNode._drop(this); }
    contains(n) {
        for (let e = n; e; e = e.parentNode) if (e === this) return true;
        return false;
    }
    replaceWith(...nodes) {
        const p = this.parentNode;
        if (!p) return;
        for (const n of nodes) p.insertBefore(n, this);
        this.remove();
    }
    get textContent() { return this.childNodes.map(c => c.textContent).join(''); }
    set textContent(v) { this.replaceChildren(new Text(String(v))); }
    *walk() {
        for (const c of this.childNodes) {
            if (c instanceof Element) { yield c; yield* c.walk(); }
        }
    }
    querySelectorAll(sel) {
        const cls = sel.replace(/^\./, '');
        return [...this.walk()].filter(e => e.classList.contains(cls));
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
class Text extends Node {
    constructor(t) { super(); this.data = t; }
    get textContent() { return this.data; }
}
class Fragment extends Node {}
class Element extends Node {
    constructor(tag) {
        super();
        this.tagName = tag.toUpperCase();
        this.attrs = {};
        this.dataset = {};
        this.style = {};
        this.listeners = {};
        const el = this;
        this.classList = {
            contains: (c) => el.className.split(/\s+/).includes(c),
            add: (c) => { if (!el.classList.contains(c)) el.className = (el.className + ' ' + c).trim(); },
            remove: (c) => { el.className = el.className.split(/\s+/).filter(x => x && x !== c).join(' '); }
        };
    }
    get className() { return this.attrs.class || ''; }
    set className(v) { this.attrs.class = v; }
    get title() { return this.attrs.title || ''; }
    set title(v) { this.attrs.title = String(v); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    closest(sel) {
        const cls = sel.replace(/^\./, '');
        for (let e = this; e instanceof Element; e = e.parentNode) {
            if (e.classList.contains(cls) || e.tagName === sel.toUpperCase()) return e;
        }
        return null;
    }
    set innerHTML(html) { this.replaceChildren(...parseHtml(html)); }
}

const VOID = new Set(['img', 'input', 'br']);
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
function parseHtml(html) {
    const root = new Fragment();
    const stack = [root];
    const re = /<(\/?)([a-zA-Z0-9]+)((?:\s+[a-zA-Z-]+(?:="[^"]*")?)*)\s*\/?>|([^<]+)/g;
    let m;
    while ((m = re.exec(html))) {
        const top = stack[stack.length - 1];
        if (m[4] !== undefined) { top.appendChild(new Text(decode(m[4]))); continue; }
        if (m[1]) { stack.pop(); continue; }
        const el = new Element(m[2]);
        for (const a of m[3].matchAll(/([a-zA-Z-]+)(?:="([^"]*)")?/g)) el.setAttribute(a[1], decode(a[2] ?? ''));
        top.appendChild(el);
        if (!VOID.has(m[2].toLowerCase())) stack.push(el);
    }
    return root.childNodes.splice(0);
}

const fakeDocument = {
    createElement: (t) => new Element(t),
    createDocumentFragment: () => new Fragment()
};

function fire(el, type, extra = {}) {
    const ev = {
        type, target: el, button: 0,
        stopPropagation() {}, preventDefault() {},
        dataTransfer: { data: {}, setData(k, v) { this.data[k] = v; } },
        ...extra
    };
    for (const fn of el.listeners[type] || []) fn(ev);
    return ev;
}

// Lift the paging code out of sidepanel.js: its top-level functions end at
// the first line that is a lone `}`.
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'sidepanel', 'sidepanel.js'), 'utf8').split('\n');
function lift(name) {
    const start = SRC.findIndex(l => new RegExp(`^(async )?function ${name}\\(`).test(l));
    if (start < 0) throw new Error(`sidepanel.js has no function ${name}`);
    const end = SRC.indexOf('}', start);
    return SRC.slice(start, end + 1).join('\n');
}
function liftConst(name) {
    const line = SRC.find(l => l.startsWith(`const ${name} = `));
    if (!line) throw new Error(`sidepanel.js has no const ${name}`);
    return line;
}

const calls = { opened: [], removed: [], refreshed: [] };
const env = {
    document: fakeDocument,
    openBookmarksAsNewWindow: async (list) => { calls.opened.push(list.map(b => b.id)); },
    openBookmarkInCurrentWindow: async () => {},
    removeBookmarksSmart: async (ids) => { calls.removed.push([...ids]); },
    refreshFolderBodyIfOpen: async (...args) => { calls.refreshed.push(args); },
    confirm: () => true,
    alert: (msg) => { throw new Error('unexpected alert: ' + msg); },
    // The fade-out delay is cosmetic; run it at once.
    setTimeout: (fn) => { fn(); return 0; }
};
const code = [
    liftConst('BODY_ROW_CAP'), liftConst('SHOW_MORE_STEP'),
    lift('tabDomain'), lift('escapeHtml'),
    lift('appendDomainGroups'), lift('appendDomainGroup'), lift('buildBookmarkRow'),
    'return { appendDomainGroups, BODY_ROW_CAP, SHOW_MORE_STEP };'
].join('\n\n');
const paging = new Function(...Object.keys(env), code)(...Object.values(env));

const bm = (domain, n) => Array.from({ length: n }, (_, i) => ({
    id: `${domain}-${i}`, title: `${domain} ${i}`, url: `https://${domain}/p/${i}`
}));
const nf = (n) => n.toLocaleString();
const flushMicrotasks = () => new Promise(r => setImmediate(r));

console.log('row paging');
check('cap and step are the spec values', paging.BODY_ROW_CAP === 200 && paging.SHOW_MORE_STEP === 500);

const body = new Element('div');
const all = [...bm('a.com', 4000), ...bm('b.com', 1500), ...bm('c.com', 500)];
paging.appendDomainGroups(body, all, 'folder1');
const groups = () => body.querySelectorAll('.src-domain-group');
const groupOf = (d) => groups().find(g => g.dataset.domain === d);
const rowsIn = (el) => el.querySelectorAll('.src-tab-row').length;
const moreIn = (g) => g.childNodes.find(c => c instanceof Element && c.classList.contains('src-more-btn'));
const bodyMore = () => body.childNodes.find(c => c instanceof Element && c.classList.contains('src-more-btn'));

check('opening a 6000-row folder builds 200 rows', rowsIn(body) === 200, String(rowsIn(body)));
check('only the groups the cap reached are built', groups().length === 1 && !!groupOf('a.com'));
let a = groupOf('a.com');
check('the cut group says how many are left, inside the group',
    moreIn(a) && moreIn(a).textContent === `Show ${nf(3800)} more`, moreIn(a) && moreIn(a).textContent);
check('unreached groups sit behind one button at the end of the body',
    bodyMore() && bodyMore().textContent === `Show ${nf(2000)} more bookmarks in 2 sites`
    && body.childNodes[body.childNodes.length - 1] === bodyMore(), bodyMore() && bodyMore().textContent);
check('the domain count is the full group, not the rows shown',
    a.querySelector('.src-domain-count').textContent === '(4000)');

fire(a.querySelector('.domain-open-all-btn'), 'click');
check('▶ All opens the whole group', calls.opened.at(-1).length === 4000, String(calls.opened.at(-1).length));
fire(a.querySelector('.domain-open-10-btn'), 'click');
check('▶ 10 opens the first ten', calls.opened.at(-1).join() === bm('a.com', 10).map(b => b.id).join());
let ev = fire(a.querySelector('.domain-drag-handle'), 'dragstart');
check('dragging the group carries every id in it',
    JSON.parse(ev.dataTransfer.data['text/tp-bookmark-ids']).length === 4000);

fire(moreIn(a), 'click');
check('"Show more" adds 500 rows to its group', rowsIn(a) === 700, String(rowsIn(a)));
check('…and counts down', moreIn(a).textContent === `Show ${nf(3300)} more`);
check('…keeping itself below the rows',
    a.childNodes.filter(c => c instanceof Element).at(-1) === moreIn(a));

// Delete one visible row: the group's list shrinks, so do the bulk actions.
const firstRow = a.querySelector('.src-tab-row');
fire(firstRow.querySelector('.bookmark-delete-btn'), 'click');
await flushMicrotasks();
check('a single delete removes just that bookmark', calls.removed.at(-1).join() === 'a.com-0');
check('…its row goes', rowsIn(a) === 699 && !a.querySelectorAll('.src-tab-row').includes(firstRow));
check('…the count follows the list, not the DOM', a.querySelector('.src-domain-count').textContent === '(3999)');
check('…the remaining "more" is unchanged', moreIn(a).textContent === `Show ${nf(3300)} more`);
fire(a.querySelector('.domain-open-all-btn'), 'click');
check('…and ▶ All no longer includes it',
    calls.opened.at(-1).length === 3999 && !calls.opened.at(-1).includes('a.com-0'));
check('…the body is not rebuilt (other pages of rows stay), only stats refreshed',
    calls.refreshed.at(-1)[0] === 'folder1' && calls.refreshed.at(-1).length === 2);

fire(bodyMore(), 'click');
const b = groupOf('b.com');
check('the end button builds the next 500 rows', b && rowsIn(b) === 500 && rowsIn(body) === 699 + 500);
check('…with its own in-group "more"', moreIn(b) && moreIn(b).textContent === `Show ${nf(1000)} more`);
check('…and a new end button for what is still unreached',
    bodyMore() && bodyMore().textContent === 'Show 500 more bookmarks in 1 site');
check('groups stay in domain order', groups().map(g => g.dataset.domain).join() === 'a.com,b.com');

fire(b.querySelector('.domain-delete-btn'), 'click');
await flushMicrotasks();
check('deleting a domain group deletes all of it, shown or not', calls.removed.at(-1).length === 1500);
check('…removes the group and refreshes the folder',
    !groupOf('b.com') && calls.refreshed.at(-1).length === 1 && calls.refreshed.at(-1)[0] === 'folder1');

const small = new Element('div');
paging.appendDomainGroups(small, [...bm('x.org', 3), ...bm('y.org', 2)], 'folder2');
check('a small folder shows everything with no buttons',
    rowsIn(small) === 5 && small.querySelectorAll('.src-more-btn').length === 0);
const x = small.querySelectorAll('.src-domain-group')[0];
for (const row of x.querySelectorAll('.src-tab-row')) {
    fire(row.querySelector('.bookmark-delete-btn'), 'click');
    await flushMicrotasks();
}
check('deleting the last row of a group removes the group',
    small.querySelectorAll('.src-domain-group').length === 1 && calls.refreshed.at(-1).length === 1);

// --- Folder cards ---------------------------------------------------------
//
// The card controller from sidepanel.js against the real TreeStore working
// copy: restore while detached, collapse keeps children's state, the
// per-render budget, drag-hover opens, and overlapping builds.

const bmk = (prefix, n) => Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${i}`, kind: 'bookmark', title: `${prefix} ${i}`, url: `https://${prefix}.example/${i}`
}));
const BIG = 11;
await local.set({
    tpTree: {
        baseVersion: 4,
        dirty: false,
        rev: 'cards',
        roots: [
            { id: 'bm', kind: 'folder', title: 'Bookmarks', role: 'bookmarks', children: [
                { id: 'fA', kind: 'folder', title: 'A', children: [
                    { id: 'fA1', kind: 'folder', title: 'A1', children: bmk('a1', 2) },
                    { id: 'fA2', kind: 'folder', title: 'A2', children: [] },
                    ...bmk('a', 3)
                ]},
                { id: 'fB', kind: 'folder', title: 'B', children: bmk('b', 1) },
                ...Array.from({ length: BIG }, (_, i) => ({
                    id: `big${i}`, kind: 'folder', title: `Big ${i}`, children: bmk(`big${i}`, 300)
                }))
            ]},
            // One open folder whose open subfolders alone would use up a
            // whole budget, next to a sibling that is open too.
            { id: 'deep', kind: 'folder', title: 'Deep', children: [
                { id: 'd1', kind: 'folder', title: 'D1', children: Array.from({ length: 10 }, (_, i) => ({
                    id: `d1s${i}`, kind: 'folder', title: `D1 ${i}`, children: bmk(`d1s${i}`, 300)
                }))},
                { id: 'd2', kind: 'folder', title: 'D2', children: bmk('d2', 250) }
            ]},
            { id: 'wf', kind: 'folder', title: 'TabPaladin Workflows', role: 'workflows', children: [] }
        ]
    }
});

// The page the card tests attach to: folderCardsFor searches it, as the real
// one searches the document.
const page = new Element('div');
// What the drop handler sees of the page around it.
const view = { mainVisible: false, gridVisible: true, grids: [] };
const navStack = [];
const { refreshFolderBodyIfOpen: _stub, ...envForCards } = env;
const cardEnv = {
    ...envForCards,
    Tree: TreeStore.bookmarks,
    TreeStore,
    ExpandState,
    findWorkflowRootSilent: async () => TreeStore.findRoleRoot('workflows'),
    folderCardsFor: (id) => page.querySelectorAll('.source-folder-card').filter(c => c.dataset.id === String(id)),
    updateFolderCardStats: async () => {},
    isMainViewVisible: () => view.mainVisible,
    isSourceGridVisible: () => view.gridVisible,
    currentNavStack: navStack,
    renderSourceGrid: async (id) => { view.grids.push(id); },
    moveBookmarksSmart: async () => {}
};
const cardCode = [
    ...['BODY_ROW_CAP', 'SHOW_MORE_STEP', 'RESTORE_ROW_BUDGET', 'RESTORE_SKIPPED_TIP', 'IMPORTS_ROOT_TITLE',
        'TP_META_TITLE', 'TP_ROOT_MARKER_TITLE', 'cardControls'].map(liftConst),
    ...['tabDomain', 'escapeHtml', 'isInternalBookmark', 'isVisibleBookmark', 'newRestoreBudget', 'folderStatsText',
        'buildFolderCard', 'restoreQueued', 'renderFolderCard', 'buildFolderBody',
        'appendDomainGroups', 'appendDomainGroup', 'buildBookmarkRow',
        'inHiddenView', 'refreshFolderBodyIfOpen'].map(lift),
    'return { buildFolderCard, restoreQueued, renderFolderCard, newRestoreBudget, cardControls, refreshFolderBodyIfOpen };'
].join('\n\n');
const cards = new Function(...Object.keys(cardEnv), cardCode)(...Object.values(cardEnv));

// One render pass the way the views run it: build the columns, then reopen
// what was open, then attach.
async function renderPass(...subs) {
    const budget = cards.newRestoreBudget();
    const built = subs.map(s => cards.buildFolderCard(s, 0, budget));
    await cards.restoreQueued(budget);
    return built;
}

const settle = async () => { for (let i = 0; i < 20; i++) await flushMicrotasks(); };
const headerOf = (card) => card.childNodes.find(c => c instanceof Element && c.classList.contains('source-folder-header'));
const bodyOf = (card) => card.childNodes.find(c => c instanceof Element && c.classList.contains('source-folder-body'));
const caretOf = (card) => headerOf(card).querySelector('.folder-caret').textContent;
const subCards = (card) => bodyOf(card).childNodes.filter(c => c instanceof Element && c.classList.contains('source-folder-card'));
const subCard = (card, id) => subCards(card).find(c => c.dataset.id === id);
const isShownOpen = (card) => card.dataset.open === '1' && bodyOf(card).style.display === 'block' && caretOf(card) === '▼';
const rootSub = { id: 'bm', title: 'Bookmarks', folderCount: 2 + BIG, fileCount: 0, icon: '🔖' };

console.log('folder cards');
ExpandState.set('bm', true);
ExpandState.set('fA', true);
ExpandState.set('fA1', true);
ExpandState.set('fB', false);
let [root] = await renderPass(rootSub);
check('a remembered-open column comes back open, fully built before it is attached',
    isShownOpen(root) && root.parentNode === null && subCards(root).length === 2 + BIG);
let fA = subCard(root, 'fA');
check('nested remembered-open folders reopen with it', isShownOpen(fA) && isShownOpen(subCard(fA, 'fA1')));
check('never-opened and closed folders stay closed',
    subCard(fA, 'fA2').dataset.open === '' && subCard(root, 'fB').dataset.open === ''
    && bodyOf(subCard(root, 'fB')).childNodes.length === 0 && caretOf(subCard(root, 'fB')) === '▶');

fire(headerOf(fA), 'click');
await settle();
check('a header click closes the folder and empties its body',
    fA.dataset.open === '' && bodyOf(fA).childNodes.length === 0 && caretOf(fA) === '▶');
check('…and is remembered', ExpandState.isOpen('fA') === false);
check('collapsing a parent keeps the children\'s state', ExpandState.isOpen('fA1') === true);
fire(headerOf(fA), 'click');
await settle();
check('re-opening the parent brings its open subfolders back', isShownOpen(fA) && isShownOpen(subCard(fA, 'fA1')));

console.log('restore budget');
for (let i = 0; i < BIG; i++) ExpandState.set(`big${i}`, true);
[root] = await renderPass(rootSub);
const bigs = subCards(root).filter(c => c.dataset.id.startsWith('big'));
const opened = bigs.filter(c => c.dataset.open === '1');
const skipped = bigs.filter(c => c.classList.contains('restore-skipped'));
const rowsBuilt = root.querySelectorAll('.src-tab-row').length;
check('open big folders show their first 200 rows each',
    opened.length > 0 && opened.every(c => bodyOf(c).querySelectorAll('.src-tab-row').length === 200));
check('restoring stops at the per-render budget', skipped.length > 0 && rowsBuilt <= 2000,
    `${opened.length} opened, ${skipped.length} skipped, ${rowsBuilt} rows`);
const sk = skipped[0];
check('a card over the budget stays closed with a hollow caret and says why',
    sk.dataset.open === '' && caretOf(sk) === '▷' && bodyOf(sk).childNodes.length === 0
    && /not reopened automatically/.test(headerOf(sk).title));
check('…its saved state is left alone', ExpandState.isOpen(sk.dataset.id) === true);
fire(headerOf(sk), 'click');
await settle();
check('one click opens it normally and clears the marker',
    isShownOpen(sk) && !sk.classList.contains('restore-skipped') && headerOf(sk).title === '');
for (let i = 0; i < BIG; i++) ExpandState.set(`big${i}`, false);

// The budget goes level by level. Spent depth-first, Deep's ten open
// subfolders (2000 rows) used it up before its sibling D2 or the next column
// were reached, and those came back closed after every drop.
for (const id of ['deep', 'd1', 'd2', 'big0', ...Array.from({ length: 10 }, (_, i) => `d1s${i}`)]) {
    ExpandState.set(id, true);
}
const [deep, col2] = await renderPass(
    { id: 'deep', title: 'Deep', folderCount: 2, fileCount: 0 },
    { id: 'big0', title: 'Big 0', folderCount: 0, fileCount: 300 });
const d1Subs = subCards(subCard(deep, 'd1'));
const deepRows = deep.querySelectorAll('.src-tab-row').length + col2.querySelectorAll('.src-tab-row').length;
check('a later column is not given up for an earlier column\'s nested folders', isShownOpen(col2));
check('…nor a folder for its sibling\'s open subtree', isShownOpen(subCard(deep, 'd2')));
check('the deepest level gets what is left, and the pass stays in budget',
    d1Subs.some(c => c.classList.contains('restore-skipped')) && d1Subs.some(c => c.dataset.open === '1')
    && deepRows <= 2000, `${deepRows} rows`);
for (const id of ['deep', 'd1', 'd2', 'big0', ...Array.from({ length: 10 }, (_, i) => `d1s${i}`)]) {
    ExpandState.set(id, false);
}

console.log('drag-hover and overlapping builds');
const fB = subCard(root, 'fB');
await cards.cardControls.get(fB).springOpen();
check('drag-hover opens a closed folder', isShownOpen(fB));
await ExpandState.flush();
check('…without saving it', stored().fB && stored().fB.o === 0);
[root] = await renderPass(rootSub);
check('…and it stays open through the re-render after the drop', isShownOpen(subCard(root, 'fB')));

const race = cards.renderFolderCard({ id: 'fA', title: 'A', folderCount: 2, fileCount: 3 }, 0);
const rc = cards.cardControls.get(race);
await Promise.all([rc.setOpen(true), rc.refresh(), rc.refresh(), rc.restore(cards.newRestoreBudget())]);
check('overlapping opens and refreshes never duplicate subfolders',
    isShownOpen(race) && subCards(race).length === 2
    && bodyOf(race).childNodes.filter(c => c instanceof Element && c.classList.contains('src-domain-group')).length === 1,
    `${subCards(race).length} subfolder cards`);
const closing = rc.setOpen(true);
await rc.setOpen(false);
await closing;
check('closing while an open is still building leaves it closed', race.dataset.open === '' && bodyOf(race).childNodes.length === 0);

const ghost = cards.renderFolderCard({ id: 'deadbeefdeadbeef', title: 'Gone', folderCount: 0, fileCount: 0 }, 1);
await cards.cardControls.get(ghost).setOpen(true);
check('opening a folder deleted elsewhere says so instead of throwing',
    bodyOf(ghost).textContent === 'Folder no longer exists.');

console.log('refreshes');
// The view on screen holds the Bookmarks column, with A open inside it, and
// A again as a column of its own; a hidden view holds a third copy of A.
// Refresh spies record the budget each card's rebuild was given.
const onScreen = new Element('section');
const offScreen = new Element('section');
offScreen.style.display = 'none';
page.replaceChildren(onScreen, offScreen);
const aSub = { id: 'fA', title: 'A', parentId: 'bm', folderCount: 2, fileCount: 3 };
ExpandState.set('fA', true);
const [bmCol, aCol] = await renderPass(rootSub, aSub);
const [aHidden] = await renderPass(aSub);
onScreen.replaceChildren(bmCol, aCol);
offScreen.appendChild(aHidden);
function spyRefresh(card) {
    const ctl = cards.cardControls.get(card);
    const real = ctl.refresh;
    const seen = [];
    ctl.refresh = (budget) => { seen.push(budget); return real(budget); };
    return seen;
}
const aNested = subCard(bmCol, 'fA');
const seenBm = spyRefresh(bmCol), seenA = spyRefresh(aCol);
const seenNested = spyRefresh(aNested), seenHidden = spyRefresh(aHidden);
const hiddenFirst = bodyOf(aHidden).childNodes[0];
check('(all three copies of A are open)', [aNested, aCol, aHidden].every(isShownOpen));
await cards.refreshFolderBodyIfOpen(['bm', 'fA', 'bm']);
check('a refresh rebuilds every open copy on screen, once each',
    seenBm.length === 1 && seenA.length === 1 && subCard(bmCol, 'fA') !== aNested && isShownOpen(subCard(bmCol, 'fA')),
    `${seenBm.length} / ${seenA.length}`);
check('…a copy inside a body being rebuilt is left to that rebuild', seenNested.length === 0);
check('…all of them out of one restore budget', !!seenBm[0] && seenBm[0] === seenA[0]);
check('…and a view that is not on screen is not touched',
    seenHidden.length === 0 && bodyOf(aHidden).childNodes[0] === hiddenFirst);

// Organize, drilled into Bookmarks: a loose bookmark of Bookmarks dropped on
// open folder A. The level is rebuilt once; A's own refresh would only build
// what that rebuild builds again.
navStack.splice(0, navStack.length, { id: '__virtual_root__', title: 'Sources' }, { id: 'bm', title: 'Bookmarks' });
const [aLevel] = await renderPass(aSub);
onScreen.replaceChildren(aLevel);
const seenLevel = spyRefresh(aLevel);
const dropPayload = { 'text/tp-bookmark-id': 'b-0', 'text/tp-parent-id': 'bm' };
fire(aLevel, 'drop', { dataTransfer: { getData: (k) => dropPayload[k] || '' } });
await settle();
check('an Organize drop on the level shown rebuilds that level once, and nothing else',
    view.grids.join() === 'bm' && seenLevel.length === 0, `${view.grids.join()} / ${seenLevel.length}`);
// The same drop with Organize hidden (the Workflows view, say) leaves the
// hidden grid alone and rebuilds the open card instead.
view.gridVisible = false;
view.grids.length = 0;
fire(aLevel, 'drop', { dataTransfer: { getData: (k) => dropPayload[k] || '' } });
await settle();
check('…while a hidden Organize grid is not rebuilt for a drop elsewhere',
    view.grids.length === 0 && seenLevel.length === 1);
view.gridVisible = true;

console.log(failures === 0 ? '\nAll expand-state tests passed.\n' : `\n${failures} test(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
