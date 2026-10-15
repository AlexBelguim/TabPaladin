import { el, button, walk } from './desktopCore.js';
import { safeHref } from './lib/notesModel.js';
export function createHome(ctx) {
    return { async render(root) {
        root.append(el('h1', {}, 'Your workspace'));
        const search = el('input', { type: 'search', placeholder: 'Search DuckDuckGo or enter a URL', 'aria-label': 'Search or enter a URL' });
        search.addEventListener('keydown', e => { if (e.key === 'Enter') ctx.search(search.value); });
        root.append(el('div', { className:'desktop-search' }, search));
        const pins = await ctx.pins.list();
        const grid = el('div', { className:'desktop-pins' });
        for (const p of pins) {
            const tile = el('article', { className:'desktop-pin' });
            const href = safeHref(p.url);
            const link = el(href ? 'a' : 'span', href ? { href, target:'_blank',rel:'noopener',text:p.title } : { text:p.title });
            const controls = el('div', {className:'desktop-inline'},
                button('Rename', async () => { const title = prompt('Pin title', p.title); if (title !== null) await ctx.edit(() => ctx.pins.rename(p.id,title)); }),
                button('Remove', async () => { if (confirm('Remove this pin?')) await ctx.edit(() => ctx.pins.remove(p.id)); }));
            tile.append(link, controls); grid.append(tile);
        }
        grid.append(button('+ Pin a link', async () => {
            const url = prompt('URL to pin (leave blank for the current browser tab)');
            if (url === null) return;
            if (!url.trim()) { await ctx.pinCurrent(); return; }
            const normalized = /^[a-z][a-z0-9+.-]*:/i.test(url.trim()) ? url.trim() : 'https://' + url.trim();
            if (!safeHref(normalized)) throw new Error('Enter an HTTP or HTTPS address.');
            await ctx.edit(() => ctx.pins.add(normalized, prompt('Pin title', '') || normalized));
        }));
        root.append(el('h2',{},'Pinned links'),grid);
        const actions=el('div',{className:'desktop-actions'});
        for(const [label,run] of [['Group Open Tabs',()=>ctx.navigate('board')],['Create Workflow',()=>ctx.capture()],['Organize',()=>ctx.navigate('organize')],['Workflows',()=>ctx.navigate('workflows')],['Notes',()=>ctx.navigate('notes')]]) actions.append(button(label,run,'home-action'));
        root.append(actions);
        const workflows=await ctx.storage.getWorkflows();
        const recent=el('section',{},el('h2',{},'Recent workflows'));
        for(const wf of workflows.slice(0,5)) recent.append(button(wf.name + ' · ' + wf.tabs.length + ' tabs',()=>ctx.openWorkflow(ctx.store.roots().length ? walk(ctx.store.roots()).find(n=>n.id===wf.id):null),'desktop-recent'));
        if(!workflows.length)recent.append(el('p',{},'Save a window to start a workflow.'));
        root.append(recent);
        const notes=ctx.recentNotes();
        const panel=el('section',{},el('h2',{},'Recent notes'));
        for(const n of notes.slice(0,5))panel.append(button(n.title||'Untitled',()=>ctx.openNote(n.id),'desktop-recent'));
        panel.append(button('All notes ›',()=>ctx.navigate('notes')));root.append(panel);
        ctx.pending?.(root);
    } };
}
