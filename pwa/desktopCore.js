import { safeHref } from './lib/notesModel.js';
export function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    if (typeof attrs === 'string') attrs = { className: attrs };
    for (const [key, value] of Object.entries(attrs || {})) {
        if (value == null || value === false) continue;
        if (key === 'text') node.textContent = String(value);
        else if (key === 'className') node.className = value;
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
        else if (key === 'href') { const href = safeHref(value); if (href) node.href = href; }
        else if (['value','checked','disabled','draggable','readOnly','type','id','title'].includes(key)) node[key] = value;
        else if (!/^on/i.test(key) && key !== 'innerHTML') node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat(Infinity)) if (child != null) node.append(child?.nodeType ? child : document.createTextNode(String(child)));
    return node;
}
export function button(text, handler, className = 'ghost') {
    const b = el('button', { type: 'button', className, text });
    b.addEventListener('click', async event => {
        try { await handler(event); } catch (e) { b.dispatchEvent(new CustomEvent('desktop-error', { bubbles: true, detail: e.message })); }
    });
    return b;
}
export function download(name, text, mime = 'application/json') {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = el('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export function walk(nodes) { return (nodes || []).flatMap(n => [n, ...walk(n.children)]); }
export const NOISE_ROOTS = new Set(['trash','prullenbak','papierkorb','corbeille','speed dial','speed dials','pinboard','reading list']);
export function visibleRoots(roots, settings = {}) {
    const focused = new Set((settings.focusedFolderIds || []).map(String));
    const all = walk(roots);
    const candidates = focused.size ? all.filter(n => focused.has(String(n.id))) : roots;
    return [...(roots || []).filter(n => n.role === 'workflows'), ...(candidates || []).filter(n => n.kind === 'folder'
        && !['pins','notes','workflows'].includes(n.role) && !NOISE_ROOTS.has(String(n.title || '').trim().toLowerCase()))];
}
export function sameAccount(a,b) { return (!a && !b) || !!(a && b && a.url === b.url && String(a.userId) === String(b.userId) && a.serverId === b.serverId); }
export function nodeCount(n) { return 1 + (n.children || []).reduce((sum,c) => sum + nodeCount(c),0); }

export function folderPaths(roots){const out=[];const visit=(nodes,path=[],trail=[])=>{for(const node of nodes||[])if(node.kind==='folder'&&!node.virtual&&!node.readOnly){const parts=[...path,node.title],parents=[...trail,node];out.push({node,path:parts.join(' > '),trail:parents});visit(node.children,parts,parents);}};visit(roots);return out;}
