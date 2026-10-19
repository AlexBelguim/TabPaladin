import { el, button, walk } from './desktopCore.js';
import { safeHref, relativeTime } from './lib/notesModel.js';

// 'now' / '5m' / 'Yesterday' / '12 Mar' as words.
const ago = iso => { const r = relativeTime(iso); return !r ? '' : r === 'now' ? 'just now' : /^\d+[mh]$/.test(r) ? r + ' ago' : r; };
const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');

// A pin's ⋯ menu is a <details>: one open at a time, closed by a click elsewhere.
let menusWired = false;
function wireMenus() {
    if (menusWired) return;
    menusWired = true;
    document.addEventListener('click', e => {
        for (const open of document.querySelectorAll('.pin-menu[open]')) if (!open.contains(e.target)) open.open = false;
    });
}

export function createHome(ctx) {
    return { async render(root) {
        wireMenus();
        const search = el('input', { type: 'search', placeholder: 'Search DuckDuckGo or type a URL', 'aria-label': 'Search or enter a URL', autocomplete: 'off', spellcheck: 'false' });
        search.addEventListener('keydown', e => { if (e.key === 'Enter') ctx.search(search.value); });
        root.append(el('div', { className: 'home-search-block' },
            el('label', { className: 'home-search' },
                el('span', { className: 'home-search-mark', 'aria-hidden': 'true', text: 'Q' }), search,
                el('span', { className: 'home-search-kbd', 'aria-hidden': 'true', text: 'Enter' }))));

        // Pinned links: favicon tiles, the phone's (ctx.pinTile), with a ⋯ menu.
        const pins = await ctx.pins.list();
        const grid = el('div', { className: 'desk-pins' });
        for (const p of pins) {
            const cell = el('div', { className: 'desk-pin' });
            const tile = ctx.pinTile ? ctx.pinTile(p) : el('a', { className: 'pin-tile', href: p.url, target: '_blank', rel: 'noopener', text: p.title });
            const menu = el('details', { className: 'pin-menu' },
                el('summary', { className: 'pin-menu-btn', title: 'Pin actions', 'aria-label': 'Actions for ' + (p.title || p.url) }, '⋯'));
            const close = () => { menu.open = false; };
            menu.append(el('div', { className: 'pin-menu-pop', role: 'menu' },
                button('Rename…', async () => { close(); const title = prompt('Pin title', p.title); if (title !== null) await ctx.edit(() => ctx.pins.rename(p.id, title)); }, 'pin-menu-item'),
                button('Remove', async () => { close(); if (confirm('Remove this pin?')) await ctx.edit(() => ctx.pins.remove(p.id)); }, 'pin-menu-item danger')));
            cell.append(tile, menu, el('span', { className: 'desk-pin-name', text: p.title || p.url, title: p.url }));
            grid.append(cell);
        }
        const add = button('', async () => {
            const url = prompt('URL to pin (leave blank for the current browser tab)');
            if (url === null) return;
            if (!url.trim()) { await ctx.pinCurrent(); return; }
            const normalized = /^[a-z][a-z0-9+.-]*:/i.test(url.trim()) ? url.trim() : 'https://' + url.trim();
            if (!safeHref(normalized)) throw new Error('Enter an HTTP or HTTPS address.');
            await ctx.edit(() => ctx.pins.add(normalized, prompt('Pin title', '') || normalized));
        }, 'pin-add');
        add.title = 'Pin a link';
        add.append(el('span', { className: 'pin-add-box', 'aria-hidden': 'true', text: '+' }), el('span', { className: 'desk-pin-name', text: 'Add pin' }));
        grid.append(add);
        root.append(el('section', { className: 'home-section' },
            el('div', { className: 'home-section-head' }, el('h2', {}, 'Pinned'), el('span', { className: 'home-count', text: pins.length ? String(pins.length) : '' })),
            grid));

        // The old page's coloured action tiles.
        const actions = el('section', { className: 'home-tiles', 'aria-label': 'Quick actions' });
        for (const [label, hint, run, tone] of [
            ['Group Open Tabs', 'File this window\'s tabs on the Board', () => ctx.navigate('board'), 'blue'],
            ['Organize Bookmarks', 'Sort loose bookmarks by keyword', () => ctx.navigate('organize'), 'green'],
            ['View Workflows', 'Saved windows, ready to reopen', () => ctx.navigate('workflows'), 'indigo'],
            ['Create Workflow 💾', 'Save a browser window', () => ctx.capture(), 'amber'],
            ['📝 Notes', 'Your notebooks', () => ctx.navigate('notes'), 'sky']
        ]) {
            const tile = button('', run, 'home-tile tone-' + tone);
            tile.append(el('span', { className: 'home-tile-label', text: label }), el('span', { className: 'home-tile-hint', text: hint }));
            actions.append(tile);
        }
        root.append(actions);
        ctx.pending?.(root);

        // Recent workflows and recent notes, side by side.
        const workflows = await ctx.storage.getWorkflows();
        const wfPanel = el('section', { className: 'home-panel' },
            el('div', { className: 'home-section-head' }, el('h2', {}, 'Recent workflows'), button('All workflows ›', () => ctx.navigate('workflows'), 'home-head-link')));
        const wfList = el('div', { className: 'home-cards' });
        const nodes = walk(ctx.store.roots());
        for (const wf of workflows.slice(0, 6)) {
            const card = button('', () => ctx.openWorkflow(ctx.store.roots().length ? walk(ctx.store.roots()).find(n => n.id === wf.id) : null), 'home-card');
            // The folder's own date: getWorkflows makes one up when it has none.
            const saved = ago(nodes.find(n => n.id === wf.id)?.payload?.createdAt);
            card.title = 'Open ' + (wf.name || 'this workflow');
            card.append(el('span', { className: 'home-card-icon', 'aria-hidden': 'true', text: '🪟' }),
                el('span', { className: 'home-card-text' },
                    el('span', { className: 'home-card-title', text: wf.name || 'Untitled workflow' }),
                    el('span', { className: 'home-card-meta', text: [plural(wf.tabs.length, 'tab'), saved && 'saved ' + saved].filter(Boolean).join(' · ') })),
                el('span', { className: 'home-card-go', 'aria-hidden': 'true', text: '▶' }));
            wfList.append(card);
        }
        if (!workflows.length) wfList.append(el('p', { className: 'home-empty' }, 'Save a window to start a workflow.'));
        wfPanel.append(wfList);

        const notes = ctx.recentNotes();
        const notePanel = el('section', { className: 'home-panel' },
            el('div', { className: 'home-section-head' }, el('h2', {}, 'Recent notes'), button('All notes ›', () => ctx.navigate('notes'), 'home-head-link')));
        const noteList = el('div', { className: 'home-cards' });
        for (const n of notes.slice(0, 6)) {
            const card = button('', () => ctx.openNote(n.id), 'home-card');
            const tasks = n.tasks && n.tasks.total ? n.tasks.done + '/' + n.tasks.total + ' done' : '';
            const where = n.path && n.path.length ? n.path.join(' › ') : 'Unfiled';
            card.append(el('span', { className: 'home-card-icon', 'aria-hidden': 'true', text: '📝' }),
                el('span', { className: 'home-card-text' },
                    el('span', { className: 'home-card-title' + (n.title ? '' : ' untitled'), text: n.title || 'Untitled' }),
                    el('span', { className: 'home-card-meta', text: [where, tasks].filter(Boolean).join(' · ') })),
                el('span', { className: 'home-card-time', text: ago(n.updatedAt) }));
            noteList.append(card);
        }
        if (!notes.length) noteList.append(el('p', { className: 'home-empty' }, 'No notes yet.'));
        notePanel.append(noteList);
        root.append(el('div', { className: 'home-recents' }, wfPanel, notePanel));
    } };
}
