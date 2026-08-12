// Home screen for the full-screen app page: DuckDuckGo search, pinned links,
// and recent workflows/notes.
//
// Deliberately standalone. sidepanel.js still owns every existing view and is
// loaded alongside this unchanged, so the redesign rehouses those views rather
// than rewriting 3000 lines of working logic.
import { PinsManager, initialsFor, colorFor } from '../utils/pinsManager.js';
import { StorageManager } from '../utils/storageManager.js';
import { NotesManager } from '../utils/notesManager.js';

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

function pinTile(pin) {
    const el = document.createElement('div');
    el.className = 'pin-tile';
    el.dataset.id = pin.id;
    el.tabIndex = 0;
    el.title = pin.url;

    const fav = document.createElement('span');
    fav.className = 'pin-fav';
    fav.style.background = colorFor(pin.url);
    fav.textContent = initialsFor(pin);

    const name = document.createElement('span');
    name.className = 'pin-name';
    name.textContent = pin.title;

    const host = document.createElement('span');
    host.className = 'pin-host';
    host.textContent = pin.host;

    const remove = document.createElement('button');
    remove.className = 'pin-remove';
    remove.type = 'button';
    remove.title = `Unpin ${pin.title}`;
    remove.setAttribute('aria-label', `Unpin ${pin.title}`);
    remove.textContent = '×';

    el.append(fav, name, host, remove);
    return el;
}

function addTile() {
    const el = document.createElement('button');
    el.className = 'pin-tile pin-add';
    el.type = 'button';
    el.id = 'pinAddBtn';
    el.innerHTML = '<span class="pin-fav">＋</span><span class="pin-name">Pin a link</span>';
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

// Open tasks in a note, for the "3 of 6 open" style count.
function openTaskCount(content) {
    const lines = String(content || '').split(/\r?\n/);
    let open = 0;
    let total = 0;
    for (const line of lines) {
        const task = NotesManager.parseTaskLine(line);
        if (!task) continue;
        total++;
        if (!task.checked) open++;
    }
    return { open, total };
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
        const notes = await NotesManager.listNotes();
        fillPanel('recent-notes',
            notes.slice(0, 5).map(n => {
                const { open, total } = openTaskCount(n.content);
                return recentRow(n.title || 'Untitled', total ? `${open} of ${total} open` : '');
            }),
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
            if (tile && tile.title) window.open(tile.title, '_blank');
        });
        grid.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            const tile = e.target.closest('.pin-tile');
            if (tile && !tile.classList.contains('pin-add') && tile.title) window.open(tile.title, '_blank');
        });
    }

    await renderPins();
    await renderRecents();
}

// Let the rest of the app refresh the home screen after it changes things.
window.addEventListener('tabpaladin:home-refresh', () => {
    renderPins();
    renderRecents();
});
