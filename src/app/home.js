// Home screen for the full-screen app page: DuckDuckGo search, pinned links,
// and recent workflows/notes.
//
// Deliberately standalone. sidepanel.js still owns every existing view and is
// loaded alongside this unchanged, so the redesign rehouses those views rather
// than rewriting 3000 lines of working logic.
import { PinsManager, initialsFor, colorFor } from '../utils/pinsManager.js';
import { StorageManager } from '../utils/storageManager.js';
import { NotesManager } from '../utils/notesManager.js';
import { TreeStore } from '../utils/treeStore.js';
import { sortNotes, relativeTime, pathLabel } from '../utils/notesModel.js';
import { openNotes } from './notesView.js';

const DDG = 'https://duckduckgo.com/?q=';

const $ = (id) => document.getElementById(id);

// A bare domain typed into the box should go to the site, not search for it.
// Anything with a space, or without a dot, is a query.
function looksLikeUrl(text) {
    const t = text.trim();
    if (!t || /\s/.test(t)) return false;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return true;
    return /^[^.]+\.[^.]{2,}/.test(t);
}

function submitSearch(raw) {
    const text = String(raw || '').trim();
    if (!text) return;
    const target = looksLikeUrl(text)
        ? (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`)
        : DDG + encodeURIComponent(text);
    window.open(target, '_blank');
}

// --- pinned links ---------------------------------------------------------

// Chrome's own favicon cache, via the "favicon" permission. No network request
// and nothing leaves the machine — unlike hotlinking each site or asking a
// third-party icon service, either of which would tell someone else what you
// have pinned. Firefox has no such endpoint, so it falls back to initials.
// A pin saved before add() started normalising, or typed as a bare host, has
// no scheme — and a scheme-less string resolves against the extension origin
// rather than the web. Both opening and the favicon lookup need the real URL.
function withScheme(url) {
    const s = String(url || '').trim();
    if (!s) return '';
    return /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
}

function openPin(url) {
    const target = withScheme(url);
    if (target) window.open(target, '_blank', 'noopener');
}

// One source, fetched the way sidepanel.js has always fetched icons for
// bookmark rows: a plain <img src> pointed at Google's service. No source
// chain, nothing deferring the load, nothing hiding the element.
//
// The coloured initials sit in their own element behind the icon, and a loaded
// icon hides them by putting .has-icon on the container — CSS does the hiding,
// nothing is removed from the DOM. That separation is deliberate: the initials
// used to be text directly on the container, so hiding them meant
// favEl.textContent = '', which removes *every* child including the <img>. The
// icon deleted itself the instant it loaded and the tile went blank.
function attachFavicon(favEl, pageUrl) {
    let host = '';
    try {
        host = new URL(withScheme(pageUrl)).hostname;
    } catch (e) {
        return; // unparseable — initials only
    }
    if (!host.includes('.')) return;

    const img = document.createElement('img');
    img.className = 'pin-favimg';
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    // Initials are a better fallback than a broken-image glyph on top of them.
    img.addEventListener('error', () => img.remove());
    img.addEventListener('load', () => favEl.classList.add('has-icon'));
    img.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;

    favEl.appendChild(img);
}

function pinTile(pin) {
    const el = document.createElement('div');
    el.className = 'pin-tile';
    el.dataset.id = pin.id;
    // The URL lives here, not in title. title now carries the label, and the
    // click handler used to read title as the destination — which opened the
    // pin's *name* as a relative path under the extension origin.
    el.dataset.url = pin.url;
    el.tabIndex = 0;
    // The label lives here rather than under the tile: a grid of unlabelled
    // icons is unusable without sight or a hover.
    el.title = pin.title;
    el.setAttribute('aria-label', pin.title);

    const fav = document.createElement('span');
    fav.className = 'pin-fav';

    // Own element, not text on the container, so hiding it can never take the
    // icon with it. The tile colour rides on the initials rather than the
    // container for the same reason: it has to disappear together with them.
    const initials = document.createElement('span');
    initials.className = 'pin-initials';
    initials.style.background = colorFor(pin.url);
    initials.textContent = initialsFor(pin);
    fav.appendChild(initials);

    attachFavicon(fav, pin.url);

    const remove = document.createElement('button');
    remove.className = 'pin-remove';
    remove.type = 'button';
    remove.title = `Unpin ${pin.title}`;
    remove.setAttribute('aria-label', `Unpin ${pin.title}`);
    remove.textContent = '×';

    el.append(fav, remove);
    return el;
}

function addTile() {
    const el = document.createElement('button');
    el.className = 'pin-tile pin-add';
    el.type = 'button';
    el.id = 'pinAddBtn';
    el.title = 'Pin a link';
    el.setAttribute('aria-label', 'Pin a link');
    el.innerHTML = '<span class="pin-fav">＋</span>';
    return el;
}

async function renderPins() {
    const grid = $('pins-grid');
    if (!grid) return;
    grid.textContent = '';

    let pins = [];
    try {
        pins = await PinsManager.list();
    } catch (e) {
        console.warn('[TabPaladin] Failed to list pins', e);
    }

    for (const pin of pins) grid.appendChild(pinTile(pin));
    grid.appendChild(addTile());
}

async function promptAndPin() {
    const url = window.prompt('Pin a link — paste a URL, or leave blank to pin the current tab:');
    if (url === null) return;

    let target = url.trim();
    let title = '';
    if (!target) {
        const api = typeof browser !== 'undefined' ? browser : chrome;
        try {
            const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true });
            // The app page itself is the active tab when opened from the toolbar,
            // so pinning "the current tab" would pin TabPaladin.
            if (tab && tab.url && !tab.url.startsWith(api.runtime.getURL(''))) {
                target = tab.url;
                title = tab.title || '';
            } else {
                window.alert('No other tab is open to pin. Paste a URL instead.');
                return;
            }
        } catch (e) {
            window.alert('Could not read the current tab. Paste a URL instead.');
            return;
        }
    }

    try {
        await PinsManager.add(target, title);
        await renderPins();
    } catch (e) {
        window.alert(e.message);
    }
}

// --- recents --------------------------------------------------------------

function recentRow(text, meta) {
    const row = document.createElement('div');
    row.className = 'home-row';
    const left = document.createElement('span');
    left.className = 'home-row-text';
    left.textContent = text;
    const right = document.createElement('span');
    right.className = 'home-row-meta';
    right.textContent = meta;
    row.append(left, right);
    return row;
}

function fillPanel(id, rows, emptyText) {
    const box = $(id);
    if (!box) return;
    box.textContent = '';
    if (rows.length === 0) {
        const p = document.createElement('p');
        p.className = 'home-empty';
        p.textContent = emptyText;
        box.appendChild(p);
        return;
    }
    for (const r of rows) box.appendChild(r);
}

// One recent note: title · notebook on the left, task progress and how long
// ago on the right. A button, because it opens the note.
function recentNoteRow(note, now) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'home-row home-row-btn';
    row.dataset.note = note.id;

    const left = document.createElement('span');
    left.className = 'home-row-text';
    const title = document.createElement('span');
    title.textContent = note.title || 'Untitled';
    if (!note.title) title.className = 'home-row-untitled';
    left.appendChild(title);
    if (note.path.length) {
        const nb = document.createElement('span');
        nb.className = 'home-row-nb';
        nb.textContent = ` · ${pathLabel(note.path, 28)}`;
        nb.title = note.path.join(' › ');
        left.appendChild(nb);
    }

    const right = document.createElement('span');
    right.className = 'home-row-meta';
    const t = note.tasks;
    if (t.total) {
        const pill = document.createElement('span');
        pill.className = 'nv-pill' + (t.open ? '' : ' is-done');
        pill.textContent = t.open ? `${t.done}/${t.total}` : `✓ ${t.done}/${t.total}`;
        pill.title = `${t.done} of ${t.total} tasks done`;
        right.appendChild(pill);
    }
    const when = document.createElement('span');
    when.textContent = relativeTime(note.updatedAt, now);
    right.appendChild(when);

    row.append(left, right);
    return row;
}

async function renderRecents() {
    try {
        const workflows = await StorageManager.getWorkflows();
        fillPanel('recent-workflows',
            workflows.slice(0, 5).map(w => recentRow(w.name, `${(w.tabs || []).length} tabs`)),
            'No workflows saved yet.');
    } catch (e) {
        fillPanel('recent-workflows', [], 'Could not load workflows.');
    }

    try {
        // True recency, from any notebook depth.
        const lib = await NotesManager.getLibrary();
        const now = Date.now();
        fillPanel('recent-notes',
            sortNotes(lib.notes, 'edited').slice(0, 5).map(n => recentNoteRow(n, now)),
            'No notes yet.');
    } catch (e) {
        fillPanel('recent-notes', [], 'Could not load notes.');
    }
}

// --- wiring ---------------------------------------------------------------

export async function initHome() {
    const input = $('homeSearchInput');
    if (input) {
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                submitSearch(input.value);
                input.value = '';
            }
        });
        // Focus on open — this is the landing state, and the whole point of
        // putting search here is that you can start typing immediately.
        setTimeout(() => input.focus(), 60);
    }

    const grid = $('pins-grid');
    if (grid) {
        grid.addEventListener('click', async (e) => {
            const removeBtn = e.target.closest('.pin-remove');
            if (removeBtn) {
                e.stopPropagation();
                const tile = removeBtn.closest('.pin-tile');
                try {
                    await PinsManager.remove(tile.dataset.id);
                    await renderPins();
                } catch (err) { window.alert('Could not unpin: ' + err.message); }
                return;
            }
            if (e.target.closest('.pin-add')) { await promptAndPin(); return; }
            const tile = e.target.closest('.pin-tile');
            if (tile) openPin(tile.dataset.url);
        });
        grid.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            const tile = e.target.closest('.pin-tile');
            if (tile && !tile.classList.contains('pin-add')) openPin(tile.dataset.url);
        });
    }

    // A recent note opens Notes with that note selected and its notebook
    // expanded; 'All notes ›' does what the Notes tile does.
    $('recent-notes')?.addEventListener('click', (e) => {
        const row = e.target.closest('[data-note]');
        if (row) openNotes({ noteId: row.dataset.note });
    });
    $('homeAllNotesBtn')?.addEventListener('click', () => $('viewNotesBtn')?.click());

    await renderPins();
    await renderRecents();
}

// Let the rest of the app refresh the home screen after it changes things.
window.addEventListener('tabpaladin:home-refresh', () => {
    renderPins();
    renderRecents();
});

// And re-render when the tree itself changes — a pull finishing after the home
// screen already painted (the startup auto-pull), an edit in another view, or
// another TabPaladin page writing the working copy.
let homeTreeRefresh = null;
TreeStore.onChanged(() => {
    if (homeTreeRefresh) return;
    homeTreeRefresh = setTimeout(() => {
        homeTreeRefresh = null;
        renderPins();
        renderRecents();
    }, 250);
});
