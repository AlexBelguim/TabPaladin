// The notes page of the full-screen app: library, list and note side by side.
//
// This used to be a block inside sidepanel.js that flattened notebooks into
// one heading per folder title, hid the list while a note was open, and lost
// edits on Back. It is its own module now, notebook-first:
//   - Library: All notes / Open tasks / Unfiled, then the notebook tree at any
//     depth, with fold state remembered on this device.
//   - List: the scope's notes by last edit (or title, or tree order), with
//     plain-text previews, task progress and scoped search.
//   - Note: Read, Edit or (on wide windows) Split, with an explicit Save.
//
// Saving stays explicit and local: Save or Ctrl+S writes the working copy, and
// ⬆️ Push stays the only thing that talks to the server. An unsaved draft is
// guarded on every way out of it, and survives leaving Notes through the gear,
// but never another account's working copy coming in (see "accounts").
//
// Layout is driven by classes set from here (.nv-cols-*, .nv-pane-*,
// .nv-can-split, .is-read/.is-edit/.is-split). #notes-container itself is
// still shown and hidden through style.display, because app.js watches that
// and every other view switcher in sidepanel.js writes it.
import { NotesManager } from '../utils/notesManager.js';
import { TreeStore } from '../utils/treeStore.js';
import * as NM from '../utils/notesModel.js';

const api = globalThis.browser || globalThis.chrome;
const $ = (id) => document.getElementById(id);

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

// Views that share the page with Notes; opening Notes hides them, as the old
// handler in sidepanel.js did.
const OTHER_VIEWS = [
    'organizer-source-container',
    'organizer-container',
    'settings-container',
    'groups-container',
    'workflows-container'
];

const view = {
    lib: NM.emptyLibrary(),
    expanded: new Set(),
    scope: 'all',
    sort: 'edited',
    mode: 'read',           // the remembered Read/Edit/Split choice
    shown: 'read',          // what the note pane shows right now
    query: '',
    noteId: null,           // the note in the editor (null with isNew for a draft)
    isNew: false,
    newParentId: null,      // where a new note will be filed
    loaded: { title: '', content: '' },  // what the editor last loaded or saved
    removed: false,         // the open note vanished in a pull
    pane: 'list',           // the pane narrow layouts show: 'side' | 'list' | 'note'
    cols: 3,
    restoreNoteId: null,    // last open note from a previous visit
    copy: null,             // { id, owner } of the working copy the view was drawn from
    checkParked: true,      // look for a parked draft of this account on the next refresh
    initialized: false,
    opened: false
};

// --- per-device prefs ---------------------------------------------------------

function storage() {
    try { return window.localStorage; } catch (e) { return null; }
}

function savePrefs() {
    // Stale ids are dropped on the way out so the entry does not grow forever.
    const expanded = [...view.expanded].filter(id => view.lib.notebooks.has(id) || !view.lib.rootId);
    NM.writeNotesUi(storage(), {
        expanded,
        scope: view.scope,
        noteId: view.noteId || view.restoreNoteId || null,
        sort: view.sort,
        mode: view.mode
    });
}

function loadPrefs() {
    const p = NM.readNotesUi(storage());
    view.expanded = new Set(p.expanded);
    view.scope = p.scope;
    view.sort = p.sort;
    view.mode = p.mode;
    view.shown = p.mode;
    view.restoreNoteId = p.noteId;
}

// --- accounts ---------------------------------------------------------------------
//
// The working copy can be swapped for another account's under the view:
// signing in as someone else, a pull or a refused push that sets the copy
// aside, a restore from Settings — in this page or in another one. Nothing
// from the previous copy may reach the next: not the open note, not a draft,
// not the selection. So the view starts over on the new copy's library.
//
// An unsaved draft belongs to the copy it was written in. Before a switch made
// in this page, sidepanel.js asks (tabpaladin:before-account-switch) and the
// draft is saved into the outgoing copy, so it is set aside with it, or
// discarded. One nobody could ask about — the switch happened in another
// page — is parked on this device under its account and comes back into the
// editor when that account's copy does, never for anyone else's.

const ACCOUNT_UI_KEY = 'tp_notes_ui_accounts_v1';
const PARKED_KEY = 'tp_notes_parked_v1';
const MAX_ACCOUNT_UI = 20;
// Parked drafts that could not be written (storage full or blocked): kept for
// as long as this page lives rather than dropped.
const parkedHere = [];

function readJson(key, fallback) {
    try {
        const raw = storage() ? storage().getItem(key) : null;
        return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
        return fallback;
    }
}

function writeJson(key, value) {
    try {
        if (!storage()) return false;
        storage().setItem(key, JSON.stringify(value));
        return true;
    } catch (e) {
        return false;
    }
}

// An account's id at its server's address, however the address was typed.
function ownerKey(owner) {
    if (!owner) return 'unstamped';
    let url = String(owner.url || '').replace(/\/+$/, '');
    try {
        const u = new URL(url);
        url = u.origin + u.pathname.replace(/\/$/, '');
    } catch (e) { /* not a URL: compare it as typed */ }
    return `${url}|${Number(owner.userId)}`;
}

// The same account as TreeStore counts it: the same id at the same address,
// on the same server where both know the server's id. Unstamped matches only
// unstamped.
function sameOwner(a, b) {
    if (!a || !b) return !a && !b;
    if (a.serverId && b.serverId && a.serverId !== b.serverId) return false;
    return ownerKey(a) === ownerKey(b);
}

// Fold state, scope and last open note are per account; sort and mode stay
// per device. The outgoing account's are kept for when it comes back.
function swapAccountPrefs(fromOwner, toOwner) {
    const stored = readJson(ACCOUNT_UI_KEY, {});
    const map = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
    map[ownerKey(fromOwner)] = {
        expanded: [...view.expanded],
        scope: view.scope,
        noteId: view.noteId || view.restoreNoteId || null,
        t: Date.now()
    };
    const keys = Object.keys(map).sort((a, b) => (Number(map[b] && map[b].t) || 0) - (Number(map[a] && map[a].t) || 0));
    for (const k of keys.slice(MAX_ACCOUNT_UI)) delete map[k];
    writeJson(ACCOUNT_UI_KEY, map);
    const entry = map[ownerKey(toOwner)];
    // readNotesUi validates the entry the same way it does the device prefs.
    const p = NM.readNotesUi({ getItem: () => (entry ? JSON.stringify(entry) : null) });
    view.expanded = new Set(p.expanded);
    view.scope = p.scope;
    view.restoreNoteId = p.noteId;
}

function parkDraft(owner) {
    const note = view.isNew ? null : currentNote();
    const draft = {
        owner: owner ? { url: owner.url, userId: owner.userId, username: owner.username || null, serverId: owner.serverId || null } : null,
        noteId: view.isNew ? null : view.noteId,
        notebookId: view.isNew || view.removed ? view.newParentId : note ? note.notebookId : null,
        title: $('noteTitleInput').value,
        content: $('noteContentInput').value,
        loaded: { ...view.loaded },
        parkedAt: new Date().toISOString()
    };
    const list = readJson(PARKED_KEY, []);
    if (!writeJson(PARKED_KEY, [...(Array.isArray(list) ? list : []), draft])) parkedHere.push(draft);
}

function takeParkedDraft(owner) {
    const list = readJson(PARKED_KEY, []);
    if (Array.isArray(list)) {
        const i = list.findIndex(d => d && typeof d.content === 'string' && sameOwner(d.owner, owner));
        if (i !== -1) {
            const [draft] = list.splice(i, 1);
            if (writeJson(PARKED_KEY, list)) return draft;
        }
    }
    const j = parkedHere.findIndex(d => sameOwner(d.owner, owner));
    return j === -1 ? null : parkedHere.splice(j, 1)[0];
}

// Back into the editor, unsaved, as it was left: the note it was editing if
// that is still here, otherwise as text to keep (a draft, or a note removed
// since).
function restoreParkedDraft(draft) {
    const note = draft.noteId ? view.lib.notes.find(n => n.id === draft.noteId) : null;
    const nbId = draft.notebookId && view.lib.notebooks.has(draft.notebookId) ? draft.notebookId : null;
    view.noteId = note ? note.id : draft.noteId || null;
    view.isNew = !draft.noteId;
    view.removed = Boolean(draft.noteId && !note);
    view.newParentId = note ? null : nbId;
    view.restoreNoteId = note ? note.id : view.restoreNoteId;
    view.loaded = note
        ? { title: note.title, content: note.content }
        : { title: String((draft.loaded && draft.loaded.title) || ''), content: String((draft.loaded && draft.loaded.content) || '') };
    $('noteTitleInput').value = String(draft.title || '');
    $('noteContentInput').value = String(draft.content || '');
    view.shown = view.mode === 'split' && canSplit() ? 'split' : 'edit';
    view.pane = 'note';
    renderPreview();
    renderNoteChrome();
    renderBacklinks();
    markSelectedRow();
    layout();
    toast(`Your unsaved note “${String(draft.title || '').trim() || 'Untitled'}” is back from before the account switch. Save it to keep it.`, 6000);
}

// Has the working copy become another one since the view last looked? Then
// start over on it. A copy only stamped with its owner (claimed on sign-in,
// adopted, or pulled) is the same copy; another account's tree pulled over it
// is not.
function noticeCopySwitch() {
    const st = TreeStore.status();
    if (!st.loaded) return false;
    if (!view.copy) {
        view.copy = { id: st.copyId, owner: st.owner };
        return false;
    }
    const otherOwner = view.copy.owner && st.owner && !sameOwner(view.copy.owner, st.owner);
    if (st.copyId === view.copy.id && !otherOwner) {
        view.copy.owner = st.owner;
        return false;
    }
    startOverForCopy(st);
    return true;
}

function startOverForCopy(st) {
    const from = view.copy ? view.copy.owner : null;
    if (isDirty()) parkDraft(from);
    swapAccountPrefs(from, st.owner);
    view.copy = { id: st.copyId, owner: st.owner };
    view.noteId = null;
    view.isNew = false;
    view.removed = false;
    view.newParentId = null;
    view.lib = NM.emptyLibrary();
    view.query = '';
    view.pane = 'list';
    view.checkParked = true;
    // Unseen, the next visit is a first visit for this account: it reopens
    // that account's last note.
    view.opened = isVisible();
    moveCtx = null;
    dragging = null;
    clearTimeout(searchTimer);
    closePopups();
    closeMoveDialog();
    $('notesSearchInput').value = '';
    fillEditor('', '');
    savePrefs();
    renderSidebar();
    renderList();
    renderNoteChrome();
    renderBacklinks();
    layout();
}

// Before a switch made here: save the draft into the copy being set aside,
// or discard it, or (Cancel twice) keep editing and call the switch off.
async function settleDraftBeforeSwitch(action) {
    const owner = TreeStore.status().owner;
    const whose = owner && owner.username ? ` (${owner.username}’s)` : '';
    if (window.confirm(`${action || 'Switching accounts'} sets this working copy${whose} aside, and the note open in Notes has unsaved changes.\n\n`
        + `Save them into this copy first? They are set aside with it.\n\nOK = Save    Cancel = don’t save`)) {
        return saveNote();
    }
    if (window.confirm(`Discard the unsaved changes to the note?\n\nOK = Discard    Cancel = keep editing (nothing is switched)`)) {
        discardDraft();
        return true;
    }
    return false;
}

// --- small helpers --------------------------------------------------------------

function toast(msg, ms = 2800) {
    if (!msg) return;
    let el = document.getElementById('tp-toast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'tp-toast';
        el.style.cssText = 'position:fixed; left:50%; bottom:24px; transform:translateX(-50%);'
            + 'background:rgba(17,24,39,0.97); color:#e5e7eb; border:1px solid var(--border-color,#374151);'
            + 'padding:10px 16px; border-radius:10px; font-size:0.85rem; z-index:3000;'
            + 'box-shadow:0 10px 30px rgba(0,0,0,0.5); max-width:80vw; text-align:center;'
            + 'transition:opacity .18s ease;';
        document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.style.opacity = '0'; }, ms);
}

function isVisible() {
    const sec = $('notes-container');
    return Boolean(sec && sec.style.display !== 'none' && sec.style.display !== '');
}

function canSplit() {
    return window.innerWidth >= 1500;
}

function plural(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function currentNote() {
    return view.noteId ? view.lib.notes.find(n => n.id === view.noteId) || null : null;
}

function scopeNotebookId() {
    const id = NM.notebookIdOf(view.scope);
    return id && view.lib.notebooks.has(id) ? id : null;
}

// --- rendered note (moved from sidepanel.js unchanged) -----------------------------

// Inline markup shared by every line: [[wiki-links]] become clickable chips
// and bare URLs become links. Takes already-escaped text.
function renderNoteInlineHtml(escaped) {
    let html = escaped.replace(/\[\[([^\[\]]+)\]\]/g, (m, t) =>
        `<span class="note-wikilink" data-target="${t.trim()}">[[${t.trim()}]]</span>`);
    html = html.replace(/(https?:\/\/[^\s<)&]+)/g,
        `<a href="$1" class="note-urllink" title="Open in new tab">$1</a>`);
    return html;
}

// Inline markdown: **bold**, *italic*, `code`. Applied after escaping, so the
// patterns only ever see safe text.
function renderNoteEmphasis(html) {
    return html
        .replace(/`([^`]+)`/g, '<code class="note-code">$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
}

// Render note content as HTML.
//
// Tasks become real checkboxes carrying their source line number, so toggling
// one edits exactly that line of the stored markdown. Headings, bullets and
// emphasis render too — previously everything except tasks and links came out
// as escaped text, so a note full of "## Meat" and "- 260 g soy sauce" read as
// raw markdown with only the checkboxes working.
//
// `skipTitle` drops a leading "# Heading" that just repeats the note's title,
// which is otherwise shown twice: once in the title field, once at the top of
// the body.
function renderNoteContentHtml(content, skipTitle = '') {
    const lines = String(content == null ? '' : content).split('\n');
    const out = [];
    let inList = false;
    let titleDropped = false;

    const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };

    lines.forEach((raw, i) => {
        const task = NotesManager.parseTaskLine(raw);
        if (task) {
            closeList();
            const label = renderNoteEmphasis(renderNoteInlineHtml(escapeHtml(task.label)));
            out.push(
                `<label class="note-task"${task.indent ? ` style="margin-left:${task.indent * 14}px;"` : ''}>` +
                `<input type="checkbox" class="note-task-box" data-line="${i}"${task.checked ? ' checked' : ''}>` +
                `<span class="note-task-label${task.checked ? ' done' : ''}">${label}</span>` +
                `</label>`
            );
            return;
        }

        const heading = raw.match(/^(#{1,4})\s+(.*)$/);
        if (heading) {
            closeList();
            const text = heading[2].trim();
            // A leading H1 echoing the title is noise, not content.
            if (!titleDropped && heading[1].length === 1 && skipTitle
                && text.toLowerCase() === skipTitle.toLowerCase()) {
                titleDropped = true;
                return;
            }
            const level = Math.min(heading[1].length + 1, 5); // h1 -> h2, so page structure stays sane
            out.push(`<h${level} class="note-h">${renderNoteEmphasis(renderNoteInlineHtml(escapeHtml(text)))}</h${level}>`);
            return;
        }

        const bullet = raw.match(/^(\s*)[-*]\s+(.*)$/);
        if (bullet) {
            if (!inList) { out.push('<ul class="note-list">'); inList = true; }
            out.push(`<li>${renderNoteEmphasis(renderNoteInlineHtml(escapeHtml(bullet[2])))}</li>`);
            return;
        }

        closeList();
        if (raw.trim() === '') { out.push('<div class="note-gap"></div>'); return; }
        out.push(`<p class="note-p">${renderNoteEmphasis(renderNoteInlineHtml(escapeHtml(raw)))}</p>`);
    });

    closeList();
    return out.join('');
}

// --- layout -----------------------------------------------------------------------

// Three panes from 1200px, two from 760px (the left one switching between
// library and list), one below that. Split needs room for two readable columns.
function layout() {
    const nv = $('nv');
    if (!nv) return;
    const w = window.innerWidth;
    view.cols = w >= 1200 ? 3 : w >= 760 ? 2 : 1;
    nv.classList.toggle('nv-cols-3', view.cols === 3);
    nv.classList.toggle('nv-cols-2', view.cols === 2);
    nv.classList.toggle('nv-cols-1', view.cols === 1);
    nv.classList.toggle('nv-can-split', canSplit());
    for (const p of ['side', 'list', 'note']) nv.classList.toggle(`nv-pane-${p}`, view.pane === p);
    $('nv-to-side').textContent = view.cols === 1 ? '‹ Notebooks' : '📓 Notebooks';
    if (isVisible()) {
        // The panes fill the window under the topbar and scroll on their own.
        const top = nv.getBoundingClientRect().top + window.scrollY;
        nv.style.setProperty('--nv-top', `${Math.max(0, Math.round(top))}px`);
    }
    applyMode();
}

function setPane(pane) {
    view.pane = pane;
    layout();
}

// --- library pane -------------------------------------------------------------------

function renderSidebar() {
    const lib = view.lib;
    const scopes = [
        ['all', '🗒', 'All notes', lib.counts.all],
        ['tasks', '☐', 'Open tasks', lib.counts.openTasks],
        ['unfiled', '📥', 'Unfiled', lib.counts.unfiled]
    ];
    $('nv-scopes').innerHTML = scopes.map(([s, icon, label, n]) =>
        `<button type="button" class="nv-scope${view.scope === s ? ' is-selected' : ''}" data-scope="${s}">`
        + `<span class="nv-ico" aria-hidden="true">${icon}</span><span class="nv-name">${label}</span>`
        + `<span class="nv-count">${n}</span></button>`).join('');

    const rows = [];
    const walk = (books) => {
        for (const b of books) {
            const hasKids = b.children.length > 0;
            const open = hasKids && view.expanded.has(b.id);
            const id = escapeHtml(b.id);
            const name = escapeHtml(b.title || '(unnamed)');
            rows.push(
                `<div class="nv-tree-row${view.scope === 'nb:' + b.id ? ' is-selected' : ''}" style="--depth:${b.depth}"`
                + ` role="treeitem"${hasKids ? ` aria-expanded="${open}"` : ''} data-nb="${id}" draggable="true">`
                + (hasKids
                    ? `<button type="button" class="nv-chev${open ? ' is-open' : ''}" data-fold="${id}"`
                        + ` aria-label="${open ? 'Collapse' : 'Expand'} ${name}">▸</button>`
                    : '<span class="nv-chev-space"></span>')
                + `<button type="button" class="nv-tree-name" data-open-nb="${id}" title="${escapeHtml(b.path.join(' › '))}">`
                + `<span class="nv-ico" aria-hidden="true">📓</span><span class="nv-name">${name}</span></button>`
                + `<span class="nv-count">${b.totalCount}</span>`
                + `<button type="button" class="nv-more" data-nb-menu="${id}" aria-label="Actions for ${name}" title="Notebook actions">⋯</button>`
                + `</div>`);
            if (open) walk(b.children);
        }
    };
    walk(lib.roots);
    $('nv-tree').innerHTML = rows.join('') || '<p class="nv-tree-empty">No notebooks yet.</p>';
    renderSync();
}

function renderSync() {
    const btn = $('nv-sync');
    if (!btn) return;
    const dirty = TreeStore.status().dirty;
    btn.textContent = dirty ? 'Local changes not pushed · ⬆ Push' : 'All changes pushed';
    btn.classList.toggle('is-dirty', dirty);
    btn.disabled = !dirty;
}

// --- list pane ----------------------------------------------------------------------

function taskPillHtml(tasks) {
    if (!tasks || !tasks.total) return '';
    if (tasks.open === 0) return `<span class="nv-pill is-done" title="All tasks done">✓ ${tasks.done}/${tasks.total}</span>`;
    const pct = Math.round((tasks.done / tasks.total) * 100);
    return `<span class="nv-pill" title="${tasks.done} of ${tasks.total} tasks done">`
        + `<span class="nv-pill-bar"><span style="width:${pct}%"></span></span>${tasks.done}/${tasks.total}</span>`;
}

function pathChipHtml(note) {
    if (!note.notebookId || !note.path.length) return '';
    return `<span class="nv-chip" title="${escapeHtml(note.path.join(' › '))}">📓 ${escapeHtml(NM.pathLabel(note.path))}</span>`;
}

function noteRowHtml(note, { chip = false, titleRanges = null, snippet = null, now = Date.now() } = {}) {
    const untitled = !String(note.title || '').trim();
    const title = untitled
        ? 'Untitled'
        : (titleRanges && titleRanges.length ? NM.highlightHtml(note.title, titleRanges, escapeHtml) : escapeHtml(note.title));
    const preview = snippet
        ? `${escapeHtml(snippet.before)}<mark>${escapeHtml(snippet.hit)}</mark>${escapeHtml(snippet.after)}`
        : escapeHtml(note.preview);
    const chips = taskPillHtml(note.tasks) + (chip ? pathChipHtml(note) : '');
    const selected = !view.isNew && note.id === view.noteId;
    return `<li class="nv-row${selected ? ' is-selected' : ''}" data-note="${escapeHtml(note.id)}" draggable="true"`
        + `${selected ? ' aria-current="true"' : ''}>`
        + `<div class="nv-row-top"><span class="nv-row-title${untitled ? ' is-untitled' : ''}">${title}</span>`
        + `<span class="nv-row-time">${escapeHtml(NM.relativeTime(note.updatedAt, now))}</span></div>`
        + (preview ? `<div class="nv-row-preview">${preview}</div>` : '')
        + (chips ? `<div class="nv-row-chips">${chips}</div>` : '')
        + `</li>`;
}

function subNotebookRowHtml(b) {
    return `<li class="nv-subnb" data-open-nb="${escapeHtml(b.id)}">`
        + `<span class="nv-ico" aria-hidden="true">📓</span><span class="nv-name">${escapeHtml(b.title || '(unnamed)')}</span>`
        + `<span class="nv-count">${b.totalCount}</span><span class="nv-chev-r" aria-hidden="true">›</span></li>`;
}

function emptyHtml(text, actions = '') {
    return `<li class="nv-empty"><p>${text}</p>${actions}</li>`;
}

function renderList() {
    const lib = view.lib;
    const list = $('notes-list');
    const keepScroll = list.scrollTop;
    const nbId = scopeNotebookId();
    const nb = nbId ? lib.notebooks.get(nbId) : null;
    const label = NM.scopeLabel(lib, view.scope);
    const pool = NM.notesInScope(lib, view.scope);
    const now = Date.now();

    $('nv-list-name').textContent = label;
    const count = nb ? nb.totalCount : pool.length;
    $('nv-list-sub').textContent = [nb && nb.depth > 0 ? nb.path.join(' › ') : '', plural(count, 'note')]
        .filter(Boolean).join(' · ');
    const search = $('notesSearchInput');
    search.placeholder = view.scope === 'all' ? 'Search all notes' : `Search in ${label}`;
    if (search.value !== view.query && document.activeElement !== search) search.value = view.query;
    $('nv-sort').value = view.sort;

    const html = [];
    const q = view.query.trim();
    if (q) {
        const scoped = view.scope !== 'all';
        const results = NM.searchNotes(lib, q, nb ? { notebookId: nb.id } : scoped ? { notes: pool } : {});
        const searchAll = scoped ? ' · <button type="button" class="nv-link-btn" data-act="search-all">Search all notes</button>' : '';
        if (!results.length) {
            html.push(emptyHtml(`No notes match “${escapeHtml(q)}”`,
                `<div class="nv-empty-actions"><button type="button" class="nv-btn" data-act="create-from-query">+ Create note “${escapeHtml(q)}”</button>`
                + (scoped ? '<button type="button" class="nv-btn" data-act="search-all">Search all notes</button>' : '')
                + '</div>'));
        } else {
            const n = results.length;
            html.push(`<li class="nv-summary">${n} match${n === 1 ? '' : 'es'}`
                + `${scoped ? ` in ${escapeHtml(label)}` : ''}${searchAll}</li>`);
            for (const r of results) {
                html.push(noteRowHtml(r.note, { chip: true, titleRanges: r.titleRanges, snippet: r.snippet, now }));
            }
        }
    } else {
        if (nb) for (const child of nb.children) html.push(subNotebookRowHtml(child));
        const chip = view.scope === 'all' || view.scope === 'tasks';
        const notes = NM.sortNotes(pool, view.sort);
        if (view.sort === 'edited') {
            for (const g of NM.groupByRecency(notes, now)) {
                html.push(`<li class="nv-bucket">${escapeHtml(g.bucket)}</li>`);
                for (const n of g.notes) html.push(noteRowHtml(n, { chip, now }));
            }
        } else {
            for (const n of notes) html.push(noteRowHtml(n, { chip, now }));
        }
        if (!notes.length && !(nb && nb.children.length)) {
            if (nb) {
                html.push(emptyHtml(`No notes in ${escapeHtml(label)} yet`,
                    '<div class="nv-empty-actions"><button type="button" class="nv-btn" data-act="new-here">+ New note here</button></div>'));
            } else if (view.scope === 'tasks') {
                html.push(emptyHtml('No open tasks. Nice.'));
            } else if (view.scope === 'unfiled') {
                html.push(emptyHtml('No unfiled notes.'));
            } else {
                html.push(emptyHtml('No notes yet',
                    '<div class="nv-empty-actions"><button type="button" class="nv-btn" data-act="new">+ New note</button></div>'));
            }
        }
    }
    list.innerHTML = html.join('');
    list.scrollTop = keepScroll;
}

function markSelectedRow() {
    for (const row of $('notes-list').querySelectorAll('.nv-row')) {
        const on = !view.isNew && row.dataset.note === view.noteId;
        row.classList.toggle('is-selected', on);
        if (on) row.setAttribute('aria-current', 'true');
        else row.removeAttribute('aria-current');
    }
}

// --- note pane ----------------------------------------------------------------------

export function isDirty() {
    const title = $('noteTitleInput').value;
    const content = $('noteContentInput').value;
    // The note is gone from the tree, so whatever is in the editor exists nowhere else.
    if (view.removed) return content.trim() !== '' || title.trim() !== '';
    if (view.isNew) return title.trim() !== '' || content.trim() !== '';
    if (!view.noteId) return false;
    return title !== view.loaded.title || content !== view.loaded.content;
}

function applyMode() {
    const pane = $('note-editor');
    if (!pane) return;
    let shown = view.shown;
    if (shown === 'split' && !canSplit()) shown = 'edit';
    pane.classList.toggle('is-read', shown === 'read');
    pane.classList.toggle('is-edit', shown === 'edit');
    pane.classList.toggle('is-split', shown === 'split');
    $('noteTitleInput').readOnly = shown === 'read';
    for (const b of $('nv-modes').querySelectorAll('button[data-mode]')) {
        b.setAttribute('aria-pressed', String(b.dataset.mode === shown));
    }
    if (shown !== 'edit') renderPreview();
}

// remember=false for a mode the view picks on its own (a new note opens in
// Edit) rather than one the user chose.
function setMode(mode, { remember = true, focus = true } = {}) {
    view.shown = mode;
    if (remember) {
        view.mode = mode;
        savePrefs();
    }
    applyMode();
    if (focus && mode !== 'read') $('noteContentInput').focus();
}

function renderPreview() {
    const title = $('noteTitleInput').value.trim() || view.loaded.title;
    const html = renderNoteContentHtml($('noteContentInput').value, title);
    $('notePreview').innerHTML = `<div class="note-preview-body">${html || '<span class="nv-muted">Empty note.</span>'}</div>`;
}

function renderBacklinks() {
    const box = $('nv-backlinks');
    const title = view.loaded.title;
    if (view.isNew || view.removed || !title) {
        box.innerHTML = '';
        return;
    }
    const links = NM.backlinksTo(view.lib, title, view.noteId);
    box.innerHTML = links.length
        ? `<div class="note-backlinks"><span class="nv-muted">Linked from:</span> ${links.map(n =>
            `<span class="note-wikilink note-backlink" data-target="${escapeHtml(n.title)}">${escapeHtml(n.title || 'Untitled')}</span>`).join(' ')}</div>`
        : '';
}

// Everything around the editor: crumb, status, buttons, meta. Never touches
// the title or text fields, so it is safe to call while someone types.
function renderNoteChrome() {
    const has = Boolean(view.isNew || view.noteId || view.removed);
    $('nv-note-empty').hidden = has;
    $('nv-note-main').hidden = !has;
    if (!has) return;

    const note = currentNote();
    // A removed note shows where 'Keep my text' would file it: its last notebook.
    const nbId = view.isNew || view.removed ? view.newParentId : note ? note.notebookId : null;
    const nb = nbId ? view.lib.notebooks.get(nbId) : null;
    const crumb = $('nv-crumb');
    if (view.isNew) {
        crumb.textContent = `in ${nb ? nb.title || '(unnamed)' : 'Unfiled'} ▾`;
        crumb.title = 'Choose where the new note is filed';
    } else {
        crumb.textContent = nb ? `📓 ${NM.pathLabel(nb.path)}` : '📥 Unfiled';
        crumb.title = `${nb ? nb.path.join(' › ') : 'Unfiled'}${view.removed ? '' : ' — Move to…'}`;
    }
    crumb.disabled = view.removed;

    const dirty = isDirty();
    const status = $('nv-note-status');
    if (dirty) {
        status.innerHTML = '<span class="nv-dot" aria-hidden="true"></span>Unsaved';
        status.className = 'nv-note-status is-unsaved';
    } else {
        status.textContent = TreeStore.status().dirty ? 'Saved locally · not pushed' : '';
        status.className = 'nv-note-status';
    }
    $('saveNoteBtn').disabled = !dirty;
    $('nv-move-note').disabled = view.removed;
    $('deleteNoteBtn').textContent = view.isNew ? 'Discard new note' : 'Delete note';
    $('nv-removed').hidden = !view.removed;
    $('nv-meta').textContent = view.isNew ? 'New note' : view.removed ? '' : note ? NM.noteMetaLine(note) : '';
}

// Load the editor. The preview follows even while hidden, so switching to
// Read never shows the previous note for a moment.
function fillEditor(title, content) {
    $('noteTitleInput').value = title;
    $('noteContentInput').value = content;
    view.loaded = { title, content };
    renderPreview();
}

function showNote(note, { mode = null } = {}) {
    view.noteId = note.id;
    view.isNew = false;
    view.removed = false;
    view.newParentId = null;
    view.restoreNoteId = note.id;
    fillEditor(note.title, note.content);
    view.shown = mode || view.mode;
    view.pane = 'note';
    savePrefs();
    renderNoteChrome();
    renderBacklinks();
    markSelectedRow();
    layout();
    const scroller = document.querySelector('#note-editor .nv-note-scroll');
    if (scroller) scroller.scrollTop = 0;
}

function clearEditor() {
    view.noteId = null;
    view.isNew = false;
    view.removed = false;
    view.newParentId = null;
    fillEditor('', '');
    renderNoteChrome();
    renderBacklinks();
    markSelectedRow();
}

function discardDraft() {
    if (view.isNew || view.removed) {
        clearEditor();
        return;
    }
    fillEditor(view.loaded.title, view.loaded.content);
    renderNoteChrome();
    applyMode();
}

// Write the editor to the local working copy. Returns true when saved.
async function saveNote() {
    if (view.removed) {
        // The note is gone; saving keeps the text as a new note, in the
        // notebook it was last seen in (refresh() noted it in newParentId).
        view.isNew = true;
        view.removed = false;
        view.noteId = null;
    }
    // A pull can remove the notebook a draft was meant for; the crumb then
    // already reads Unfiled, so file it there (as the PWA does) rather than fail.
    if (view.isNew && view.newParentId && !view.lib.notebooks.has(view.newParentId)) view.newParentId = null;
    if (!view.isNew && !view.noteId) return true;
    const titleInput = $('noteTitleInput');
    const textarea = $('noteContentInput');
    const newContent = textarea.value;
    try {
        let result;
        if (view.isNew) {
            // A draft's 'stored' title is the one it was opened with (a
            // wikilink's target, say), so its '# Target' line follows a rename.
            result = NM.resolveTitleOnSave({
                storedTitle: view.loaded.title,
                loadedContent: view.loaded.content,
                newContent,
                titleField: titleInput.value
            });
            const created = await NotesManager.createNote(result.title, result.content, { parentId: view.newParentId });
            view.noteId = created.id;
            view.isNew = false;
            view.newParentId = null;
            view.restoreNoteId = created.id;
        } else {
            const stored = await TreeStore.getNode(view.noteId);
            if (!stored) {
                const gone = currentNote();
                view.removed = true;
                view.newParentId = gone ? gone.notebookId : null;
                renderNoteChrome();
                return false;
            }
            // The field only counts as a rename when it was actually edited;
            // otherwise a rename that arrived by pull would be reverted.
            const fieldEdited = titleInput.value !== view.loaded.title;
            result = NM.resolveTitleOnSave({
                storedTitle: stored.title,
                loadedContent: view.loaded.content,
                newContent,
                titleField: fieldEdited ? titleInput.value : undefined
            });
            await NotesManager.updateNote(view.noteId, { title: result.title, content: result.content });
        }
        view.loaded = { title: result.title, content: result.content };
        titleInput.value = result.title;
        if (textarea.value !== result.content) textarea.value = result.content;
        savePrefs();
        await refresh();
        return true;
    } catch (e) {
        console.error('[TabPaladin] Save note failed', e);
        window.alert('Could not save the note: ' + e.message);
        return false;
    }
}

// The guard on every way out of a dirty editor. Two confirms because confirm()
// has two buttons and the choice has three outcomes: save, discard, or stay.
export async function canLeave() {
    if (!isDirty()) return true;
    const name = $('noteTitleInput').value.trim() || view.loaded.title || 'Untitled';
    if (window.confirm(`Save your changes to “${name}” first?\n\nOK = Save    Cancel = don't save`)) {
        return saveNote();
    }
    if (window.confirm(`Discard your changes to “${name}”?\n\nOK = Discard    Cancel = keep editing`)) {
        discardDraft();
        return true;
    }
    return false;
}

async function selectNote(id, { mode = null } = {}) {
    if (id === view.noteId && !view.isNew && !view.removed) {
        if (mode) setMode(mode, { remember: false });
        setPane('note');
        return true;
    }
    if (!(await canLeave())) return false;
    const note = view.lib.notes.find(n => n.id === id);
    if (!note) return false;
    showNote(note, { mode });
    return true;
}

// A new draft. It is filed into the open notebook unless told otherwise, and
// nothing is written until Save.
async function newNote({ parentId, title = '', content = '' } = {}) {
    if (!(await canLeave())) return false;
    view.noteId = null;
    view.isNew = true;
    view.removed = false;
    view.newParentId = parentId !== undefined ? parentId : scopeNotebookId();
    fillEditor(title, content);
    view.shown = view.mode === 'split' && canSplit() ? 'split' : 'edit';
    view.pane = 'note';
    renderNoteChrome();
    renderBacklinks();
    markSelectedRow();
    layout();
    const target = title ? $('noteContentInput') : $('noteTitleInput');
    target.focus();
    if (target === $('noteContentInput')) target.setSelectionRange(target.value.length, target.value.length);
    return true;
}

async function deleteCurrent() {
    if (view.isNew) {
        if (isDirty() && !window.confirm('Discard this new note?')) return;
        clearEditor();
        return;
    }
    const note = currentNote();
    if (!note) return;
    if (!window.confirm(`Delete note “${note.title || 'Untitled'}”?`)) return;
    try {
        await NotesManager.deleteNote(note.id);
        view.restoreNoteId = null;
        clearEditor();
        savePrefs();
        setPane('list');
        await refresh();
        toast('Note deleted.');
    } catch (e) {
        window.alert('Could not delete the note: ' + e.message);
    }
}

// Esc out of Edit/Split, through the guard.
async function leaveEdit() {
    if (view.shown === 'read') return;
    if (!(await canLeave())) return;
    if (view.isNew) {
        // An untouched new note has nothing to keep.
        clearEditor();
        setPane('list');
        return;
    }
    setMode('read', { remember: false, focus: false });
}

async function followWikilink(target) {
    const note = NM.findNoteByTitle(view.lib, target);
    if (note) {
        await selectNote(note.id);
        return;
    }
    if (!window.confirm(`Note “${target}” doesn't exist. Create it?`)) return;
    const from = currentNote();
    await newNote({ parentId: from ? from.notebookId : scopeNotebookId(), title: target, content: `# ${target}\n\n` });
}

async function toggleTask(box) {
    const textarea = $('noteContentInput');
    const updated = NotesManager.toggleTaskAtLine(textarea.value, Number(box.dataset.line));
    if (updated === textarea.value) return;
    const wasClean = !isDirty();
    textarea.value = updated;
    // Ticking a box in a clean note saves it straight away, the way a notes
    // app behaves. In a draft the tick just joins the unsaved edits.
    if (wasClean && view.noteId && !view.isNew) {
        try {
            await NotesManager.updateNote(view.noteId, { content: updated });
            view.loaded.content = updated;
        } catch (e) {
            window.alert('Could not update the task: ' + e.message);
        }
    }
    renderPreview();
    renderNoteChrome();
}

// --- Move to… -------------------------------------------------------------------------

let moveCtx = null;

function openMoveDialog(kind, id = null) {
    const lib = view.lib;
    let currentId = null;
    let excludeId = null;
    let heading = 'Move to…';
    if (kind === 'note') {
        const n = lib.notes.find(x => x.id === id);
        if (!n) return;
        currentId = n.notebookId;
        heading = `Move “${n.title || 'Untitled'}” to…`;
    } else if (kind === 'new') {
        currentId = view.newParentId;
        heading = 'File the new note in…';
    } else {
        const b = lib.notebooks.get(id);
        if (!b) return;
        currentId = b.parentId;
        excludeId = id;
        heading = `Move notebook “${b.title || '(unnamed)'}” to…`;
    }
    moveCtx = { kind, id };
    $('nv-move-title').textContent = heading;
    const atRoot = currentId === null;
    const rootLabel = kind === 'notebook' ? '🗒 Top level' : '📥 Unfiled';
    const opts = NM.notebookOptions(lib, { excludeId, currentId });
    $('nv-move-list').innerHTML =
        `<button type="button" class="nv-move-opt${atRoot ? ' is-current' : ''}" data-target=""${atRoot ? ' disabled' : ''}>`
        + `<span class="nv-name">${rootLabel}</span>${atRoot ? '<span class="nv-tick">✓</span>' : ''}</button>`
        + opts.map(o =>
            `<button type="button" class="nv-move-opt${o.current ? ' is-current' : ''}" style="--depth:${o.depth}"`
            + ` data-target="${escapeHtml(o.id)}"${o.disabled ? ' disabled' : ''} title="${escapeHtml(o.path.join(' › '))}">`
            + `<span class="nv-ico" aria-hidden="true">📓</span><span class="nv-name">${escapeHtml(o.title || '(unnamed)')}</span>`
            + `<span class="nv-count">${o.count}</span>${o.current ? '<span class="nv-tick">✓</span>' : ''}</button>`).join('');
    const dlg = $('nv-move-dialog');
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
}

function closeMoveDialog() {
    const dlg = $('nv-move-dialog');
    if (dlg.open) {
        if (typeof dlg.close === 'function') dlg.close();
        else dlg.removeAttribute('open');
    }
}

async function moveTo(targetId) {
    const ctx = moveCtx;
    closeMoveDialog();
    if (!ctx) return;
    const target = targetId || null;
    const where = target
        ? NM.pathLabel((view.lib.notebooks.get(target) || { path: ['?'] }).path)
        : (ctx.kind === 'notebook' ? 'the top level' : 'Unfiled');
    if (ctx.kind === 'new') {
        view.newParentId = target;
        renderNoteChrome();
        return;
    }
    try {
        if (ctx.kind === 'note') await NotesManager.moveNote(ctx.id, target);
        else await NotesManager.moveNotebook(ctx.id, target);
        if (target) {
            const nb = view.lib.notebooks.get(target);
            if (nb) for (const id of nb.pathIds.slice(0, -1)) view.expanded.add(id);
            if (ctx.kind === 'notebook') view.expanded.add(target);
        }
        savePrefs();
        await refresh();
        toast(`Moved to ${where}`);
    } catch (e) {
        toast(e.message);
    }
}

async function moveToNewNotebook() {
    const name = window.prompt('New notebook name:');
    if (name === null) return;
    try {
        const nb = await NotesManager.createNotebook(name, null);
        await refresh();
        await moveTo(nb.id);
    } catch (e) {
        toast(e.message);
    }
}

// --- notebook actions --------------------------------------------------------------------

async function createNotebookPrompt(parentId = null) {
    const parent = parentId ? view.lib.notebooks.get(parentId) : null;
    const name = window.prompt(parent ? `New notebook inside “${parent.title}”:` : 'New notebook name:');
    if (name === null) return;
    try {
        const nb = await NotesManager.createNotebook(name, parentId);
        if (parentId) view.expanded.add(parentId);
        await refresh();
        await setScope(`nb:${nb.id}`);
        toast(`Notebook “${nb.title}” created.`);
    } catch (e) {
        toast(e.message);
    }
}

async function renameNotebookPrompt(id) {
    const nb = view.lib.notebooks.get(id);
    if (!nb) return;
    const name = window.prompt('Rename notebook:', nb.title);
    if (name === null || name.trim() === nb.title) return;
    try {
        await NotesManager.renameNotebook(id, name);
        await refresh();
    } catch (e) {
        toast(e.message);
    }
}

async function deleteNotebookPrompt(id) {
    const nb = view.lib.notebooks.get(id);
    if (!nb) return;
    const parent = nb.parentId ? view.lib.notebooks.get(nb.parentId) : null;
    const contents = [];
    if (nb.directCount) contents.push(plural(nb.directCount, 'note'));
    if (nb.children.length) contents.push(plural(nb.children.length, 'notebook'));
    const msg = contents.length
        ? `Delete notebook “${nb.title}”? Its ${contents.join(' and ')} move up to ${parent ? parent.title : 'Notes'}.`
        : `Delete notebook “${nb.title}”?`;
    if (!window.confirm(msg)) return;
    try {
        await NotesManager.deleteNotebook(id);
        view.expanded.delete(id);
        if (view.scope === `nb:${id}`) view.scope = parent ? `nb:${parent.id}` : 'all';
        if (view.newParentId === id) view.newParentId = parent ? parent.id : null;
        savePrefs();
        await refresh();
        toast(`Notebook “${nb.title}” deleted.`);
    } catch (e) {
        toast(e.message);
    }
}

function openNotebookMenu(id, anchor) {
    const nb = view.lib.notebooks.get(id);
    if (!nb) return;
    const pop = $('nv-popup');
    pop.innerHTML =
        '<button type="button" data-nb-act="new-note">New note here</button>'
        + '<button type="button" data-nb-act="new-sub">New notebook inside</button>'
        + '<button type="button" data-nb-act="rename">Rename…</button>'
        + '<button type="button" data-nb-act="move">Move to…</button>'
        + '<hr>'
        + '<button type="button" data-nb-act="delete" class="nv-danger">Delete notebook</button>';
    pop.dataset.nb = id;
    pop.hidden = false;
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    pop.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
    pop.style.top = `${r.bottom + h + 8 > window.innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4}px`;
}

function closePopups() {
    $('nv-popup').hidden = true;
    $('nv-note-menu').hidden = true;
}

async function notebookAction(act, id) {
    closePopups();
    if (act === 'new-note') {
        if (await newNote({ parentId: id })) {
            view.scope = `nb:${id}`;
            savePrefs();
            renderSidebar();
            renderList();
        }
    } else if (act === 'new-sub') {
        await createNotebookPrompt(id);
    } else if (act === 'rename') {
        await renameNotebookPrompt(id);
    } else if (act === 'move') {
        openMoveDialog('notebook', id);
    } else if (act === 'delete') {
        await deleteNotebookPrompt(id);
    }
}

// --- drag and drop ------------------------------------------------------------------------
// A note row dropped on a notebook (or on Unfiled) moves it; a notebook
// dropped on another notebook (or on the Notebooks heading, for the top
// level) moves that. Same rules as Move to…: never into itself or below.

let dragging = null; // { kind: 'note' | 'notebook', id }

function dropTargetOf(el) {
    if (!el || !el.closest) return null;
    const row = el.closest('.nv-tree-row[data-nb]');
    if (row) return { kind: 'notebook', id: row.dataset.nb, el: row };
    const unfiled = el.closest('.nv-scope[data-scope="unfiled"]');
    if (unfiled) return { kind: 'unfiled', id: null, el: unfiled };
    const head = el.closest('.nv-tree-head');
    if (head) return { kind: 'top', id: null, el: head };
    return null;
}

function canDrop(target) {
    if (!dragging || !target) return false;
    if (dragging.kind === 'note') {
        const note = view.lib.notes.find(n => n.id === dragging.id);
        return Boolean(note) && target.kind !== 'top' && (target.id || null) !== note.notebookId;
    }
    const nb = view.lib.notebooks.get(dragging.id);
    if (!nb || target.kind === 'unfiled') return false;
    if (target.kind === 'top') return nb.parentId !== null;
    const t = view.lib.notebooks.get(target.id);
    return Boolean(t) && !t.pathIds.includes(nb.id) && t.id !== nb.parentId;
}

function clearDropMarks() {
    for (const el of document.querySelectorAll('#nv .is-drop')) el.classList.remove('is-drop');
}

function wireDragAndDrop(root) {
    root.addEventListener('dragstart', (e) => {
        const row = e.target.closest && e.target.closest('.nv-row[data-note]');
        const nbRow = !row && e.target.closest && e.target.closest('.nv-tree-row[data-nb]');
        if (row) dragging = { kind: 'note', id: row.dataset.note };
        else if (nbRow) dragging = { kind: 'notebook', id: nbRow.dataset.nb };
        else return;
        e.dataTransfer.effectAllowed = 'move';
        // Firefox starts no drag without some data on it.
        e.dataTransfer.setData('text/plain', dragging.id);
    });
    root.addEventListener('dragover', (e) => {
        const target = dropTargetOf(e.target);
        if (!canDrop(target)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!target.el.classList.contains('is-drop')) {
            clearDropMarks();
            target.el.classList.add('is-drop');
        }
    });
    root.addEventListener('dragleave', (e) => {
        const target = dropTargetOf(e.target);
        if (target && !target.el.contains(e.relatedTarget)) target.el.classList.remove('is-drop');
    });
    root.addEventListener('drop', async (e) => {
        const target = dropTargetOf(e.target);
        clearDropMarks();
        if (!canDrop(target)) return;
        e.preventDefault();
        moveCtx = { kind: dragging.kind, id: dragging.id };
        dragging = null;
        await moveTo(target.id || '');
    });
    root.addEventListener('dragend', () => {
        dragging = null;
        clearDropMarks();
    });
}

// --- scope, sort, search ------------------------------------------------------------------

async function setScope(scope) {
    view.scope = scope;
    const id = NM.notebookIdOf(scope);
    const nb = id ? view.lib.notebooks.get(id) : null;
    if (nb) for (const a of nb.pathIds.slice(0, -1)) view.expanded.add(a);
    savePrefs();
    renderSidebar();
    renderList();
    $('notes-list').scrollTop = 0;
    setPane('list');
}

let searchTimer = null;
function onSearchInput() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
        view.query = $('notesSearchInput').value;
        renderList();
        $('notes-list').scrollTop = 0;
    }, 100);
}

// ↑/↓ through the visible rows, opening each (guarded).
async function moveSelection(dir) {
    const rows = [...$('notes-list').querySelectorAll('.nv-row[data-note]')];
    if (!rows.length) return;
    let i = rows.findIndex(r => r.dataset.note === view.noteId);
    i = i === -1 ? (dir > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, i + dir));
    const row = rows[i];
    if (await selectNote(row.dataset.note)) {
        row.scrollIntoView({ block: 'nearest' });
    }
}

// --- refresh -------------------------------------------------------------------------------

async function refresh() {
    const before = view.noteId && !view.isNew && !view.removed ? currentNote() : null;
    // A library read across a switch may be the previous copy's: read again.
    let lib;
    for (;;) {
        const copyId = TreeStore.status().copyId;
        lib = await NotesManager.getLibrary();
        if (TreeStore.status().copyId === copyId) break;
    }
    noticeCopySwitch();
    view.lib = lib;
    const nbId = NM.notebookIdOf(view.scope);
    if (nbId && !view.lib.notebooks.has(nbId)) view.scope = 'all';

    if (view.noteId && !view.isNew && !view.removed) {
        const note = currentNote();
        if (!note) {
            // A pull (or another page) removed the note while it was open.
            // 'Keep my text' files it where it was, if that notebook is left.
            view.removed = true;
            view.newParentId = before ? before.notebookId : null;
        } else if (!isDirty() && (note.title !== view.loaded.title || note.content !== view.loaded.content)
            && !$('note-editor').contains(document.activeElement)) {
            // Changed elsewhere while it sat here unedited: show the new text.
            fillEditor(note.title, note.content);
            if (view.shown !== 'edit') renderPreview();
        }
    }
    renderSidebar();
    renderList();
    renderNoteChrome();
    renderBacklinks();
    if (view.checkParked) {
        view.checkParked = false;
        const draft = !view.noteId && !view.isNew && !view.removed ? takeParkedDraft(TreeStore.status().owner) : null;
        if (draft) restoreParkedDraft(draft);
    }
}

// --- entry points ------------------------------------------------------------------------------

function showSection() {
    for (const id of OTHER_VIEWS) {
        const el = $(id);
        if (el) el.style.display = 'none';
    }
    $('notes-container').style.display = 'block';
}

// Open Notes. With a noteId, that note is shown with its notebook expanded;
// with a scope, that scope. With neither, the view comes back as it was left —
// a draft included — or, on the first visit, as the last visit left it.
export async function openNotes({ noteId = null, scope = null } = {}) {
    showSection();
    await refresh();

    if (!view.opened) {
        view.opened = true;
        if (!noteId && !view.noteId && !view.isNew && view.restoreNoteId) {
            const last = view.lib.notes.find(n => n.id === view.restoreNoteId);
            if (last) showNote(last);
        }
        view.pane = noteId ? 'note' : 'list';
    }

    if (noteId) {
        const note = view.lib.notes.find(n => n.id === noteId);
        if (note && (await selectNote(note.id))) {
            for (const id of note.pathIds) view.expanded.add(id);
            const inScope = view.scope === 'all'
                || (view.scope === 'tasks' && note.tasks.open > 0)
                || view.scope === (note.notebookId ? `nb:${note.notebookId}` : 'unfiled');
            if (!inScope) view.scope = note.notebookId ? `nb:${note.notebookId}` : 'unfiled';
            view.query = '';
            $('notesSearchInput').value = '';
            savePrefs();
            renderSidebar();
            renderList();
            const row = $('notes-list').querySelector(`.nv-row[data-note="${CSS.escape(note.id)}"]`);
            if (row) row.scrollIntoView({ block: 'nearest' });
        }
    } else if (scope) {
        await setScope(scope);
    }
    layout();
    applyMode();
}

export function initNotesView() {
    if (view.initialized) return;
    view.initialized = true;
    loadPrefs();
    // The prefs just read are the current copy's account's: note which copy
    // that is before anything can switch it.
    TreeStore.load().then(() => { noticeCopySwitch(); }).catch(() => {});

    $('viewNotesBtn')?.addEventListener('click', () => { openNotes(); });

    wireDragAndDrop($('nv'));

    // Library.
    $('newNoteBtn').addEventListener('click', () => { newNote(); });
    $('nv-new-notebook').addEventListener('click', () => { createNotebookPrompt(null); });
    $('nv-scopes').addEventListener('click', (e) => {
        const b = e.target.closest('[data-scope]');
        if (b) setScope(b.dataset.scope);
    });
    $('nv-tree').addEventListener('click', (e) => {
        const fold = e.target.closest('[data-fold]');
        if (fold) {
            const id = fold.dataset.fold;
            if (view.expanded.has(id)) view.expanded.delete(id);
            else view.expanded.add(id);
            savePrefs();
            renderSidebar();
            return;
        }
        const menu = e.target.closest('[data-nb-menu]');
        if (menu) {
            e.stopPropagation();
            openNotebookMenu(menu.dataset.nbMenu, menu);
            return;
        }
        const open = e.target.closest('[data-open-nb]');
        if (open) setScope(`nb:${open.dataset.openNb}`);
    });
    $('nv-sync').addEventListener('click', () => { $('mainPushBtn')?.click(); });
    $('nv-popup').addEventListener('click', (e) => {
        const b = e.target.closest('[data-nb-act]');
        if (b) notebookAction(b.dataset.nbAct, $('nv-popup').dataset.nb);
    });

    // List.
    $('nv-to-side').addEventListener('click', () => setPane('side'));
    $('notesSearchInput').addEventListener('input', onSearchInput);
    $('nv-sort').addEventListener('change', (e) => {
        view.sort = e.target.value;
        savePrefs();
        renderList();
    });
    $('notes-list').addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]');
        if (act) {
            const a = act.dataset.act;
            if (a === 'new') newNote({ parentId: null });
            else if (a === 'new-here') newNote({ parentId: scopeNotebookId() });
            else if (a === 'search-all') setScope('all');
            else if (a === 'create-from-query') {
                const t = view.query.trim();
                newNote({ parentId: scopeNotebookId(), title: t, content: `# ${t}\n\n` });
            }
            return;
        }
        const nb = e.target.closest('[data-open-nb]');
        if (nb) { setScope(`nb:${nb.dataset.openNb}`); return; }
        const row = e.target.closest('[data-note]');
        if (row) selectNote(row.dataset.note);
    });

    // Note.
    $('nv-to-list').addEventListener('click', () => setPane('list'));
    $('nv-modes').addEventListener('click', (e) => {
        const b = e.target.closest('button[data-mode]');
        if (b) setMode(b.dataset.mode);
    });
    $('saveNoteBtn').addEventListener('click', () => { saveNote(); });
    $('deleteNoteBtn').addEventListener('click', () => { closePopups(); deleteCurrent(); });
    $('nv-crumb').addEventListener('click', () => {
        if (view.isNew) openMoveDialog('new');
        else if (view.noteId) openMoveDialog('note', view.noteId);
    });
    $('nv-move-note').addEventListener('click', () => {
        closePopups();
        if (view.isNew) openMoveDialog('new');
        else if (view.noteId) openMoveDialog('note', view.noteId);
    });
    $('nv-note-menu-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        const menu = $('nv-note-menu');
        const opening = menu.hidden;
        closePopups();
        menu.hidden = !opening;
    });
    $('nv-keep').addEventListener('click', () => { saveNote(); });
    $('nv-close-removed').addEventListener('click', () => {
        if (isDirty() && !window.confirm('Close it? The text in the editor is not saved anywhere.')) return;
        clearEditor();
        setPane('list');
    });

    let previewTimer = null;
    const onEdit = () => {
        renderNoteChrome();
        if (view.shown === 'split') {
            clearTimeout(previewTimer);
            previewTimer = setTimeout(renderPreview, 150);
        }
    };
    $('noteContentInput').addEventListener('input', onEdit);
    $('noteTitleInput').addEventListener('input', onEdit);
    $('noteTitleInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            $('noteContentInput').focus();
        }
    });

    // Clicks in the rendered note and backlinks: tasks toggle, wiki-links
    // navigate between notes, URLs open tabs.
    const onNoteClick = async (e) => {
        const box = e.target.closest('.note-task-box');
        if (box) {
            await toggleTask(box);
            return;
        }
        const urlLink = e.target.closest('.note-urllink');
        if (urlLink) {
            e.preventDefault();
            const url = urlLink.getAttribute('href');
            try { await api.tabs.create({ url }); } catch (err) { window.open(url, '_blank', 'noopener'); }
            return;
        }
        const wiki = e.target.closest('.note-wikilink');
        // dataset.target is entity-decoded by the HTML parser, so it holds the raw title.
        if (wiki && wiki.dataset.target) await followWikilink(wiki.dataset.target);
    };
    $('notePreview').addEventListener('click', onNoteClick);
    $('nv-backlinks').addEventListener('click', onNoteClick);

    // Move dialog.
    $('nv-move-list').addEventListener('click', (e) => {
        const b = e.target.closest('.nv-move-opt');
        if (b && !b.disabled) moveTo(b.dataset.target);
    });
    $('nv-move-new').addEventListener('click', () => { moveToNewNotebook(); });
    $('nv-move-cancel').addEventListener('click', () => { closeMoveDialog(); });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('#nv-popup') && !e.target.closest('.nv-menu-wrap')) closePopups();
    });

    // Keyboard, only while Notes is the visible view.
    document.addEventListener('keydown', (e) => {
        if (!isVisible()) return;
        const t = e.target;
        const search = $('notesSearchInput');
        if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
            e.preventDefault();
            if (isDirty()) saveNote();
            return;
        }
        if (e.key === 'Escape') {
            if ($('nv-move-dialog').open) return; // the dialog closes itself
            if (!$('nv-popup').hidden || !$('nv-note-menu').hidden) { closePopups(); return; }
            if (t === search && search.value) {
                e.preventDefault();
                search.value = '';
                view.query = '';
                renderList();
                return;
            }
            if (view.shown !== 'read' && (view.noteId || view.isNew)) {
                e.preventDefault();
                leaveEdit();
            }
            return;
        }
        // The Move to… dialog is modal: its keys are its own.
        if ($('nv-move-dialog').open) return;
        const inField = t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]');
        // Enter on a focused button or link already means "press this".
        const onControl = t && t.closest && t.closest('button, a[href], summary, [role="button"], [role="menuitem"]');
        if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && (!inField || t === search)) {
            e.preventDefault();
            moveSelection(e.key === 'ArrowDown' ? 1 : -1);
            return;
        }
        if (inField || e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key === '/') {
            e.preventDefault();
            if (view.cols < 3 && view.pane !== 'list') setPane('list');
            search.focus();
            search.select();
        } else if (e.key === 'Enter' && !onControl && view.noteId && !view.isNew && $('note-editor').offsetParent !== null) {
            e.preventDefault();
            setMode('edit', { remember: false });
        }
    });

    // Push asks first when the open note has unsaved edits: OK saves it to the
    // working copy so it goes up with the push; Cancel carries on and leaves
    // the draft as it is. Pull never saves it — the pull replaces the working
    // copy, so a save would be thrown away with it. The draft simply stays in
    // the editor, dirty, and refresh() leaves a dirty editor alone.
    window.addEventListener('tabpaladin:before-sync', (e) => {
        if (!isDirty() || !e.detail || e.detail.kind !== 'push') return;
        const p = (async () => {
            if (window.confirm('Save the open note before pushing?')) await saveNote();
        })();
        if (typeof e.detail.waitUntil === 'function') e.detail.waitUntil(p);
    });

    window.addEventListener('beforeunload', (e) => {
        if (!isDirty()) return;
        e.preventDefault();
        e.returnValue = '';
    });

    let resizeQueued = false;
    window.addEventListener('resize', () => {
        if (resizeQueued) return;
        resizeQueued = true;
        requestAnimationFrame(() => {
            resizeQueued = false;
            layout();
        });
    });

    // Leaving Notes (the gear, another tile) only hides the section: the DOM
    // and any draft stay exactly as they were for the way back.
    const sec = $('notes-container');
    new MutationObserver(() => {
        const on = isVisible();
        document.body.classList.toggle('tp-notes-open', on);
        if (on) layout();
        else closePopups();
    }).observe(sec, { attributes: true, attributeFilter: ['style'] });

    // Signing in as someone else, or a pull or restore that sets this copy
    // aside, asks here first while the open note has unsaved changes.
    // Resolving false calls the switch off.
    window.addEventListener('tabpaladin:before-account-switch', (e) => {
        if (!isDirty() || !e.detail || typeof e.detail.waitUntil !== 'function') return;
        e.detail.waitUntil(settleDraftBeforeSwitch(e.detail.action));
    });

    // A pull, another page writing the working copy, or our own saves: redraw
    // the tree and list a moment later. The editor itself is never rebuilt —
    // unless the copy is another account's now, which is noticed at once, so
    // nothing (a Push, a Save) can reach the old note in between.
    let changeTimer = null;
    TreeStore.onChanged(() => {
        noticeCopySwitch();
        if (changeTimer) return;
        changeTimer = setTimeout(async () => {
            changeTimer = null;
            if (view.opened) await refresh();
        }, 250);
    });

    layout();
}
