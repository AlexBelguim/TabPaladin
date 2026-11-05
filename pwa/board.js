import { el, button, walk, visibleRoots, nodeCount, sameAccount } from './desktopCore.js';
import { ExpandState, OPEN_TABS_KEY, tabGroupKey } from './lib/expandState.js';
import { TabGrouper } from './lib/tabGrouper.js';
import { helperUrl, keptSummary } from './helper.js';
let dragging = null;
const domain = url => { try { return new URL(url).hostname.replace(/^www\./,'') || 'Local files'; } catch { return 'Other'; } };
// Where each URL is saved: its bookmarks, each with the folder it is in.
const savedPlaces=roots=>{const out=new Map();const visit=(nodes,folder)=>{for(const n of nodes||[]){if(n.kind==='bookmark'&&n.url){if(!out.has(n.url))out.set(n.url,[]);out.get(n.url).push({node:n,folder});}if(n.children)visit(n.children,n);}};visit(roots,null);return out;};
// A bookmark in the imports archive: the server's record, left where it is.
const archived=n=>Boolean(n.virtual||n.readOnly||String(n.id).startsWith('imp:'));
const placeNames=list=>[...new Set((list||[]).map(p=>p.folder?p.folder.title||'Untitled':'the top level'))];
// Filing tabs that are already saved: move those bookmarks into the folder,
// or add a copy there so the link is in both places. 'move', 'copy' or null.
function askMoveOrCopy(tabs,places,target,others){
    return new Promise(resolve=>{
        const name=target.title||'this folder',one=tabs.length===1;
        const done=v=>{sheet.remove();document.removeEventListener('keydown',key,true);resolve(v);};
        const key=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();done(null);}};
        const several=tabs.some(t=>places.get(t.url).filter(p=>!archived(p.node)).length>1),inArchive=tabs.some(t=>places.get(t.url).some(p=>archived(p.node)));
        const notes=[others?(others===1?'The other tab is new and is filed as usual.':'The other '+others+' tabs are new and are filed as usual.'):'',
            several?'Moving a link saved in more than one folder leaves it only in '+name+'.':'',inArchive?'Copies in the imports archive stay there either way.':''].filter(Boolean);
        const sheet=el('div',{className:'saved-ask-sheet',role:'dialog','aria-modal':'true','aria-label':'Already saved'},
            el('div',{className:'saved-ask-panel'},
                el('h2',{text:one?'This tab is already saved':tabs.length+' of these tabs are already saved'}),
                el('ul',{className:'saved-ask-list'},tabs.slice(0,6).map(t=>el('li',{},el('span',{className:'saved-ask-title',text:t.title||t.url}),el('span',{className:'saved-ask-where',text:'in '+placeNames(places.get(t.url)).join(', ')}))),
                    tabs.length>6?el('li',{className:'saved-ask-more',text:'and '+(tabs.length-6)+' more'}):null),
                el('p',{className:'saved-ask-hint',text:(one?'Move it to ':'Move them to ')+name+', or add a copy there so '+(one?'it is':'they are')+' in both places.'}),
                notes.length?el('p',{className:'saved-ask-note',text:notes.join(' ')}):null,
                el('div',{className:'saved-ask-actions'},button('Move to '+name,()=>done('move'),'primary'),button('Add a copy',()=>done('copy')),button('Cancel',()=>done(null)))));
        sheet.addEventListener('click',e=>{if(e.target===sheet)done(null);});
        document.addEventListener('keydown',key,true);
        document.body.append(sheet);
        sheet.querySelector('button.primary').focus();
    });
}
// Copy links: the open tabs by site, and the links of the ticked sites copied one per line, to paste into another app
// (a downloader that takes links from the clipboard, say). Over the page, like askMoveOrCopy.
function copyLinks(tabs,toast){
    const bySite=new Map();for(const t of tabs){const d=domain(t.url);if(!bySite.has(d))bySite.set(d,[]);bySite.get(d).push(t.url);}
    const sites=[...bySite].sort((a,b)=>b[1].length-a[1].length||a[0].localeCompare(b[0])).map(([name,urls])=>({name,urls,box:el('input',{type:'checkbox'})}));
    const done=()=>{sheet.remove();document.removeEventListener('keydown',key,true);};
    const key=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();done();}};
    const picked=()=>sites.filter(s=>s.box.checked).flatMap(s=>s.urls);
    const hint=el('p',{className:'saved-ask-hint',text:'Tick the sites whose tabs you want: their links are copied, one per line.'});
    // when the browser will not let the page write the clipboard, the links are shown selected to copy by hand
    const manual=el('textarea',{className:'copy-links-manual',readOnly:true,rows:'5','aria-label':'The links',hidden:true});
    const copy=button('Copy',async()=>{const urls=picked();if(!urls.length)return;const text=urls.join('\n');
        try{await navigator.clipboard.writeText(text);done();toast('Copied '+urls.length+(urls.length===1?' link.':' links.'));}
        catch{manual.value=text;manual.hidden=false;manual.focus();manual.select();hint.textContent='The browser did not let the page copy: press Ctrl+C now, the links are selected.';}},'primary');
    const all=el('input',{type:'checkbox'});
    const sync=()=>{const n=picked().length,k=sites.filter(s=>s.box.checked).length;copy.disabled=!n;copy.textContent=n?'Copy '+n+(n===1?' link':' links'):'Copy';all.checked=k===sites.length;all.indeterminate=k>0&&k<sites.length;};
    all.addEventListener('change',()=>{for(const s of sites)s.box.checked=all.checked;sync();});
    for(const s of sites)s.box.addEventListener('change',sync);
    const sheet=el('div',{className:'saved-ask-sheet',role:'dialog','aria-modal':'true','aria-label':'Copy links'},
        el('div',{className:'saved-ask-panel'},
            el('h2',{text:'Copy links of the open tabs'}),hint,
            el('label',{className:'copy-links-row copy-links-all'},all,el('span',{className:'saved-ask-title',text:'All sites'}),el('span',{className:'saved-ask-where',text:String(tabs.length)})),
            el('ul',{className:'saved-ask-list copy-links-list'},sites.map(s=>el('li',{},el('label',{className:'copy-links-row'},s.box,el('span',{className:'saved-ask-title',text:s.name}),el('span',{className:'saved-ask-where',text:String(s.urls.length)}))))),
            manual,
            el('div',{className:'saved-ask-actions'},copy,button('Cancel',done))));
    sheet.addEventListener('click',e=>{if(e.target===sheet)done();});
    document.addEventListener('keydown',key,true);
    document.body.append(sheet);sync();
    if(sites.length)sites[0].box.focus();
}
export async function openNodes(ctx,nodes,limit=500,mode='new-window') {
    const eligible=nodes.filter(n=>n.kind==='bookmark'&&helperUrl(n.url));
    const urls=eligible.slice(0,limit).map(n=>n.url);
    if(eligible.length>limit&&limit===500)ctx.toast('Opening the first 500 of '+eligible.length+' bookmarks. Open smaller folders for the rest.');
    if(!urls.length)return;
    if(ctx.helper.supports('windows.openUrls')){const result=await ctx.helper.request('windows.openUrls',{urls,mode});if(result.failed?.length)ctx.toast(result.failed.length+' bookmarks could not be opened. Your bookmarks are kept.');}
    else for(const url of urls)ctx.openExternal(url);
}
// A YouTube link's video id, and whether it is a Short.
const youTubeVideo = url => {
    try {
        const u = new URL(url), host = u.hostname.replace(/^(www|m|music)\./, '');
        let id = null;
        if (host === 'youtu.be') id = u.pathname.split('/')[1];
        else if (host === 'youtube.com') {
            if (u.pathname === '/watch') id = u.searchParams.get('v');
            else { const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([^/?#]+)/); if (m) id = m[1]; }
        }
        return id && /^[A-Za-z0-9_-]{6,20}$/.test(id) ? { id, short: u.pathname.startsWith('/shorts/') } : null;
    } catch { return null; }
};
// Why the helper cannot do `op` for this page: not connected, or the page
// still has the list of what the helper could do from before an update.
function helperLacks(ctx, op, what) {
    if (ctx.helper.supports(op)) return null;
    if (ctx.helper.status !== 'ready') return what + ' needs the TabPaladin helper: connect it in its Settings.';
    const v = ctx.helper.hello && ctx.helper.hello.helperVersion;
    return 'This page still sees helper ' + (v || 'an older version') + '. Reload this page (Ctrl+R) after updating the helper.';
}
// A YouTube folder played in order, in any number, in the folder's own
// player: the helper opens the first video in a tab that keeps the folder;
// there its panel, arrows and keys (and a video's end) go through it.
export async function playYouTube(ctx, title, nodes) {
    const vids = nodes.map(n => youTubeVideo(n.url)).filter(Boolean);
    if (!vids.length) { ctx.toast('No YouTube videos in ' + title + '.'); return; }
    const lacks = helperLacks(ctx, 'youtube.playlist', 'Playing a folder');
    if (lacks) { ctx.toast(lacks); return; }
    try { await ctx.helper.request('youtube.playlist', { title, videos: vids }); }
    catch (x) {
        if (x.code === 'youtube-off') { ctx.toast('Turn on the YouTube button in helper Settings first.'); return; }
        throw x;
    }
}
// A saved X or Instagram post (not a profile or a page of the site).
const isPost = url => {
    try {
        const u = new URL(url), host = u.hostname.replace(/^(www|mobile)\./, '');
        if (host === 'x.com' || host === 'twitter.com') return /\/status(?:es)?\/\d+/.test(u.pathname);
        return host === 'instagram.com' && /^\/(?:[^/]+\/)?(p|reels?|tv)\/[A-Za-z0-9_-]+/.test(u.pathname);
    } catch { return false; }
};
// A folder of X or Instagram posts as a feed: the helper opens the first in
// a tab where next and previous go through the folder (src/helper/feed.js).
export async function openFeed(ctx, title, nodes) {
    const urls = nodes.map(n => n.url).filter(isPost);
    if (!urls.length) { ctx.toast('No X or Instagram posts in ' + title + '.'); return; }
    const lacks = helperLacks(ctx, 'feed.open', 'A feed');
    if (lacks) { ctx.toast(lacks); return; }
    try { await ctx.helper.request('feed.open', { title, urls }); }
    catch (x) {
        if (x.code === 'feeds-off') { ctx.toast('Turn on "Feeds for X and Instagram" in helper Settings first.'); return; }
        throw x;
    }
}
function drag(elm,payload,ctx){elm.draggable=true;elm.addEventListener('dragstart',e=>{dragging={...payload,account:ctx.account()};e.dataTransfer.setData('text/plain','TabPaladin items');e.dataTransfer.effectAllowed='move';});elm.addEventListener('dragend',()=>{dragging=null;});}
async function removeItems(ctx,nodes){
    if(!confirm('Delete '+nodes.length+' selected bookmarks?'))return;
    await ctx.edit(async()=>{
        const archive=nodes.filter(n=>ctx.store.imports.parse(n.id));
        if(archive.length)await ctx.store.imports.deleteItems(ctx.syncConfig(),archive.map(n=>n.id));
        for(const n of nodes.filter(n=>!ctx.store.imports.parse(n.id)))await ctx.store.removeNode(n.id);
    });
}
// The old page's folder card header: caret, icon, title, counts.
const folderStats = children => {
    const folders = children.filter(n => n.kind === 'folder').length, marks = children.filter(n => n.kind === 'bookmark').length;
    return [folders ? folders + ' 📁' : '', marks ? marks + ' 📄' : ''].filter(Boolean).join(' · ') || 'Empty';
};
// Kept out of the Board's folder cards: the Workflows column shows its own
// folder wherever it sits, and pins and notes have pages of their own.
const ROLE_FOLDERS = new Set(['workflows', 'pins', 'notes']);
// An app's own folder (payload.app, e.g. YouTube): shown inside the imports
// archive, kept like the role folders.
const appFolder = n => Boolean(n && n.kind === 'folder' && n.payload && n.payload.app);
const tool = (label, title, handler, className = 'icon-btn') => { const b = button(label, handler, className); b.title = title; return b; };
function favicon(url) {
    if (!/^https?:/i.test(url || '')) return el('span', { className: 'bm-icon bm-icon-none', 'aria-hidden': 'true' });
    const icon = el('img', { className: 'bm-icon', width: '16', height: '16', alt: '', loading: 'lazy' });
    icon.src = 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(domain(url)) + '&sz=16';
    return icon;
}
export function createFolderCards(ctx){
    let generation=0;const timers=new Set();
    const budget=()=>({remaining:2000,controllers:[]});
    // The YouTube folder and every folder inside it: those get ▶ Play.
    let ytCache={roots:null,ids:new Set()};
    const youTubeFolders=()=>{const roots=ctx.store.roots();if(ytCache.roots!==roots){const apps=walk(roots).filter(n=>n.kind==='folder'&&n.payload?.app==='youtube');ytCache={roots,ids:new Set(apps.flatMap(a=>[a,...walk(a.children)]).filter(n=>n.kind==='folder').map(n=>n.id))};}return ytCache.ids;};
    // lead: an element shown between the header and the body (Workflows' bar).
    // extra: other folders listed inside this one after its own (the Bookmarks
    // column holds the other top-level folders).
    function card(node,{depth=0,budget:pool=budget(),lead=null,extra=[]}={}){
        const readOnly=node.virtual||node.readOnly||String(node.id).startsWith('imp:')||String(node.id).startsWith('imports:');
        // An app's folder (YouTube) looks like the archive it sits in, but is editable.
        const imported=readOnly||appFolder(node);
        const box=el('section',{className:'board-card'+(depth?' nested':' board-column')+(imported?' is-imports':'')+(node.role==='workflows'?' is-workflows':''),dataset:{folderId:node.id}}),head=el('div',{className:'board-heading'}),body=el('div',{className:'board-body'});
        let open=ExpandState.isOpen(node.id,depth===0),filled=false,limit=200;
        const caret=el('span',{className:'folder-caret','aria-hidden':'true'});
        const toggle=button('',()=>{open=!open;ExpandState.set(node.id,open);fill();},'board-toggle');
        toggle.title=node.title||'Untitled';
        toggle.append(caret,el('span',{className:'folder-icon','aria-hidden':'true',text:imported?'📥':node.role==='workflows'?'💾':'📁'}),
            el('span',{className:'folder-title',text:node.title||'Untitled'}));
        if(imported)toggle.append(el('span',{className:'imports-badge',text:'synced'}));
        toggle.append(el('span',{className:'folder-stats',text:folderStats((node.children||[]).filter(n=>!ROLE_FOLDERS.has(n.role)&&!appFolder(n)).concat(extra,ctx.extraFor?.(node)||[]))}));
        const actions=el('div',{className:'board-tools'});
        const loose=()=>((ctx.store.roots().length?walk(ctx.store.roots()).find(n=>n.id===node.id):null)?.children||[]).filter(n=>n.kind==='bookmark');
        const many=loose().length;
        if(youTubeFolders().has(node.id)){const vids=walk(node.children||[]).filter(n=>n.kind==='bookmark'&&youTubeVideo(n.url));if(vids.length)actions.append(tool('▶ Play','Play '+(node.title||'this folder')+' on YouTube: next and previous go through this folder',()=>playYouTube(ctx,node.title||'YouTube',vids).catch(x=>ctx.toast(x.message)),'icon-btn tool-play'));}
        // The archive's X and Instagram folders, and any folder that is mostly their posts.
        {const marks=walk(node.children||[]).filter(n=>n.kind==='bookmark'),posts=marks.filter(n=>isPost(n.url));if(posts.length&&(String(node.id).startsWith('imp:src:')||posts.length*2>=marks.length))actions.append(tool('▶ Feed','Go through '+(node.title||'this folder')+' post by post on X or Instagram',()=>openFeed(ctx,node.title||'Feed',posts).catch(x=>ctx.toast(x.message)),'icon-btn tool-play'));}
        if(many)actions.append(tool(many>500?'▶ 500':'▶ All',many>500?'Open the first 500 bookmarks in a new window':'Open all '+many+' bookmarks in a new window',()=>openNodes(ctx,loose())));
        if(many>10)actions.append(tool('▶ 10','Open the first 10 in a new window',()=>openNodes(ctx,loose(),10)));
        head.addEventListener('auxclick',e=>{if(e.button===1){e.preventDefault();openNodes(ctx,loose()).catch(x=>ctx.toast(x.message));}});
        if(!readOnly){
            if(ctx.split)actions.append(tool('✨ Split','Sort the loose bookmarks here by keyword',()=>ctx.split(node.id),'icon-btn tool-split'));
            actions.append(tool('＋📁','New folder inside '+(node.title||'this folder'),async()=>{const title=prompt('New subfolder');if(title?.trim())await ctx.edit(()=>ctx.store.createNode({parentId:node.id,kind:'folder',title:title.trim()}));}));
            // Special folders inside (Workflows, pins, notes, YouTube: shown
            // elsewhere) move to the top level first; only the rest is deleted.
            if(!node.role&&!appFolder(node))actions.append(tool('🗑','Delete '+(node.title||'this folder'),async()=>{
                const keep=walk(node.children||[]).filter(n=>n.kind==='folder'&&(ROLE_FOLDERS.has(n.role)||n.role==='bookmarks'||appFolder(n)));
                const gone=nodeCount(node)-1-keep.reduce((sum,k)=>sum+nodeCount(k),0);
                const saying='Delete '+(node.title||'folder')+(gone?' and its '+gone+' items':'')+'?'+(keep.length?'\n\n'+keep.map(k=>k.title).join(', ')+' move to the top level first and are kept.':'');
                if(!confirm(saying))return;
                const account=ctx.account();
                await ctx.edit(async()=>{for(const k of keep)await ctx.store.moveNode(k.id,{parentId:null});await ctx.store.removeNode(node.id);});
                if(ctx.helper.supports('track.untrack'))await ctx.helper.request('track.untrack',{workflowId:node.id,account});
            },'icon-btn danger'));
        }
        actions.append(tool('›','Browse '+(node.title||'this folder')+' in Organize',()=>ctx.navigate('organize',node.id)));
        if(!readOnly){
            if(!node.role&&!appFolder(node))drag(toggle,{kind:'nodes',ids:[node.id]},ctx);
            box.addEventListener('dragover',e=>{if(!dragging)return;e.preventDefault();box.classList.add('drop-target');if(!open){const t=setTimeout(()=>{ExpandState.openForSession(node.id);open=true;fill();},700);timers.add(t);}});
            box.addEventListener('dragleave',()=>{box.classList.remove('drop-target');for(const t of timers)clearTimeout(t);timers.clear();});
            box.addEventListener('drop',async e=>{
                e.preventDefault();e.stopPropagation();box.classList.remove('drop-target');const d=dragging;dragging=null;
                try{
                    if(!d||!sameAccount(d.account,ctx.account()))throw new Error('The account changed; nothing was filed.');
                    if(d.kind==='tabs'){await ctx.fileTabs(d,node.id);return;}
                    await ctx.edit(async()=>{
                        for(const id of d.ids||[]){
                            const item=await ctx.store.getNode(id);if(!item)continue;
                            if(ctx.store.imports.parse(id))await ctx.store.imports.fileItems(ctx.syncConfig(),[id],node.id);
                            else await ctx.store.moveNode(id,{parentId:node.id});
                        }
                    });
                }catch(x){ctx.toast(x.message);}
            });
        }
        head.append(toggle,actions);box.append(head);if(lead)box.append(lead);box.append(body);
        function fill(){body.hidden=!open;caret.textContent=open?'▾':'▸';toggle.setAttribute('aria-expanded',String(open));box.classList.toggle('is-open',open);if(!open||filled)return;filled=true;
            const children=node.children||[];const folders=[...children.filter(n=>n.kind==='folder'&&!ROLE_FOLDERS.has(n.role)&&!appFolder(n)),...extra,...(ctx.extraFor?.(node)||[])];
            for(const sub of folders)body.append(card(sub,{depth:depth+1,budget:pool}));
            const groups=new Map();for(const b of children.filter(n=>n.kind==='bookmark')){const key=domain(b.url);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(b);}
            let shown=0;
            for(const [name,items]of groups){
                // A domain group: the old page's .src-domain-group.
                const group=el('div',{className:'board-domain'}),bar=el('div',{className:'board-domain-head'},
                    el('span',{className:'drag-handle','aria-hidden':'true',text:'⋮⋮'}),el('span',{className:'domain-name',text:name}),el('span',{className:'domain-count',text:String(items.length)}));
                const tools=el('span',{className:'domain-tools'},tool(items.length>500?'▶ 500':'▶ All',items.length>500?'Open the first 500 in a new window':'Open all '+items.length+' in a new window',()=>openNodes(ctx,items)));
                if(items.length>10)tools.append(tool('▶ 10','Open the first 10 in a new window',()=>openNodes(ctx,items,10)));
                tools.append(tool('🗑','Delete all '+items.length+' bookmarks under '+name,()=>removeItems(ctx,items),'icon-btn danger'));
                bar.append(tools);
                bar.title='Drag to file all '+items.length;
                drag(bar,{kind:'nodes',ids:items.map(n=>n.id)},ctx);group.append(bar);
                bar.addEventListener('auxclick',e=>{if(e.button===1){e.preventDefault();openNodes(ctx,items).catch(x=>ctx.toast(x.message));}});
                for(const item of items){
                    if(shown>=limit||pool.remaining<=0)break;shown++;pool.remaining--;
                    const row=el('div',{className:'board-bookmark'}),a=el('a',{href:item.url,target:'_blank',rel:'noopener',text:item.title||item.url,title:item.url});
                    if(helperUrl(item.url))row.addEventListener('auxclick',e=>{if(e.button===1&&ctx.helper.supports('windows.openUrls')){e.preventDefault();openNodes(ctx,[item],1,'background').catch(x=>ctx.toast(x.message));}});
                    row.append(favicon(item.url),a,tool('🗑','Delete bookmark',()=>removeItems(ctx,[item]),'icon-btn danger bm-del'));ctx.linkInfo?.decorate(a,item.url);drag(row,{kind:'nodes',ids:[item.id]},ctx);group.append(row);
                }body.append(group);
            }
            const total=children.filter(n=>n.kind==='bookmark').length;
            if(shown<total)body.append(button('Show '+Math.min(500,total-shown)+' more',()=>{limit+=500;pool.remaining+=500;filled=false;body.replaceChildren();fill();},'board-more'));
            if(!folders.length&&!children.some(n=>n.kind==='bookmark'))body.append(el('p',{className:'board-empty'},readOnly?'Empty folder.':'Empty folder. Drag tabs or bookmarks here.'));
        }
        if(open&&pool.remaining<=0){open=false;caret.textContent='▷';box.classList.add('restore-skipped');}
        fill();return box;
    }
    return {card,budget,restore:()=>{},destroy(){generation++;for(const t of timers)clearTimeout(t);timers.clear();}};
}
export function createBoard(ctx){
    // listed: the window's tabs as shown, read without a click (tabs.listWindow).
    // Filing needs a snapshot, which needs one: it is taken as a drag starts.
    let listed=null,listing=null,listError=null,snapshotTake=null,stale=false,windowId=null,settings={},rootRef=null,smart=true,groupsOverride=null;
    let appFolders=[];
    // The imports archive also shows the app folders (YouTube): those are the
    // user's own, editable folders, so they are kept in the tree, not the archive.
    const localCtx={...ctx,fileTabs,split:id=>ctx.split(id),extraFor:node=>node.id==='imports:root'?appFolders:[]};
    const cards=createFolderCards(localCtx);
    const sameTabs=(a,b)=>JSON.stringify((a||[]).map(t=>[t.tabId,t.url,t.title]))===JSON.stringify((b||[]).map(t=>[t.tabId,t.url,t.title]));
    function listTabs(){
        if(listing)return listing;
        listing=(async()=>{
            const before=listed,error=listError;
            try{const body={};if(windowId!=null)body.windowId=windowId;listed=await ctx.helper.request('tabs.listWindow',body);listError=null;}
            catch(x){listError=x.message;}
            finally{listing=null;}
            if(listError!==error||!before||!sameTabs(before.tabs,listed?.tabs)){groupsOverride=null;if(rootRef?.isConnected&&!dragging)ctx.refresh();}
        })();
        return listing;
    }
    const relist=()=>{listError=null;return listTabs();};
    function takeSnapshot(){
        const account=ctx.account(),body={purpose:'file'};if(windowId!=null)body.windowId=windowId;
        snapshotTake=ctx.helper.request('tabs.snapshot',body).then(got=>({...got,account}));snapshotTake.catch(()=>{});
    }
    const dragTabs=(elm,payload)=>{drag(elm,payload,ctx);elm.addEventListener('dragstart',takeSnapshot);};
    async function fileTabs(payload,targetId){
        if(!snapshotTake)throw new Error('Drag the tabs again.');
        const filingSnapshot=await snapshotTake;
        if(!sameAccount(filingSnapshot.account,ctx.account()))throw new Error('The account changed; nothing was filed.');
        const selected=payload.tabs.map(t=>filingSnapshot.tabs.find(s=>s.tabId===t.tabId&&s.url===t.url)).filter(Boolean);
        if(!selected.length||selected.length!==payload.tabs.length)throw new Error('The tabs changed while you dragged them. No tabs were closed.');
        // Tabs already saved: their bookmarks move here, or a copy is added
        // (asked; cancelled, nothing is filed). A workflow always gets its own.
        const places=savedPlaces(ctx.store.roots()),into=await ctx.store.getNode(targetId);
        if(!into||into.readOnly||into.virtual)throw new Error('Choose an editable folder.');
        const already=selected.filter(t=>places.has(t.url));
        let move=false;
        if(already.length&&into.role!=='workflows'){
            const choice=await askMoveOrCopy(already,places,into,selected.length-already.length);
            if(!choice)return;
            move=choice==='move';
        }
        let savedIds=[],workflowId=null;
        await ctx.edit(async()=>{
            let target=await ctx.store.getNode(targetId);if(!target||target.readOnly||target.virtual)throw new Error('Choose an editable folder.');
            if(target.role==='workflows'||payload.group){
                const base=payload.group||domain(selected[0].url);let title=base,n=2;
                while((target.children||[]).some(c=>c.title===title))title=base+' ('+(n++)+')';
                const existing=target.role!=='workflows'&&(target.children||[]).find(c=>c.kind==='folder'&&c.title.toLowerCase()===base.toLowerCase());
                target=existing||await ctx.store.createNode({parentId:target.id,kind:'folder',title,payload:{createdAt:new Date().toISOString()}});
                if((await ctx.store.getNode(targetId)).role==='workflows')workflowId=target.id;
            }
            for(const t of selected){
                // Moved: its first bookmark comes here, its other copies go (the archive's stay).
                const mine=move?(places.get(t.url)||[]).filter(p=>!archived(p.node)):[];
                if(mine.length){await ctx.store.moveNode(mine[0].node.id,{parentId:target.id});for(const p of mine.slice(1))await ctx.store.removeNode(p.node.id);savedIds.push({id:mine[0].node.id,url:t.url});continue;}
                // A copy, but not a second one in the same folder.
                const here=(target.children||[]).find(c=>c.kind==='bookmark'&&c.url===t.url);
                if(here){savedIds.push({id:here.id,url:t.url});continue;}
                const n=await ctx.store.createNode({parentId:target.id,kind:'bookmark',title:t.title||t.url,url:t.url});savedIds.push({id:n.id,url:t.url});
            }
        });
        const kind=await ctx.platform.backendKind();if(!['indexeddb','cache'].includes(kind))throw new Error('The bookmarks are kept in memory only; tabs remain open.');
        const record=(await ctx.platform.getRaw('tpTree')).tpTree;const nodes=walk(record?.roots||[]);
        if(!savedIds.every(s=>nodes.some(n=>n.id===s.id&&n.url===s.url)))throw new Error('Could not read back every filed bookmark; tabs remain open.');
        await ctx.assertAccount(payload.account);
        const result=await ctx.helper.request('tabs.closeSnapshot',{snapshotId:filingSnapshot.snapshotId,tabIds:selected.map(t=>t.tabId),expectedCount:selected.length});
        if(workflowId)await ctx.publishWorkflow?.(workflowId);
        snapshotTake=null;ctx.toast('Filed '+selected.length+' tabs; '+result.closed.length+' closed.'+keptSummary(result));relist();
    }
    // Middle-click closes an open tab, or every tab under a header. Clicks
    // close in batches: the helper closes one set of tabs a second.
    let closing=[],closeTimer=null,lastClose=0;
    // shown: what disappears at once (the row, or the header's whole group).
    function closeOnMiddle(elm,tabs,shown=elm){
        elm.addEventListener('mousedown',e=>{if(e.button===1)e.preventDefault();});
        elm.addEventListener('auxclick',e=>{if(e.button!==1)return;e.preventDefault();e.stopPropagation();shown.remove();
            closing.push(...tabs.filter(t=>!closing.includes(t)));clearTimeout(closeTimer);
            closeTimer=setTimeout(closeQueued,Math.max(300,lastClose+1100-Date.now()));});
    }
    async function closeQueued(){
        const want=closing;closing=[];closeTimer=null;if(!want.length)return;lastClose=Date.now();
        try{
            const body={purpose:'save-window'};if(windowId!=null)body.windowId=windowId;
            const snap=await ctx.helper.request('tabs.snapshot',body);
            const tabIds=want.filter(t=>snap.tabs.some(s=>s.tabId===t.tabId&&s.url===t.url)).map(t=>t.tabId);
            const result=tabIds.length?await ctx.helper.request('tabs.closeSnapshot',{snapshotId:snap.snapshotId,tabIds,expectedCount:tabIds.length}):{closed:[],kept:[]};
            lastClose=Date.now();
            const summary=keptSummary(result)+(tabIds.length<want.length?' '+(want.length-tabIds.length)+' changed and stayed open.':'');
            if(summary)ctx.toast('Closed '+result.closed.length+' tabs.'+summary);
        }catch(x){ctx.toast(x.message);}
        relist();
    }
    const board={async render(root){
        rootRef=root;settings=await ctx.storage.getSettings();await ExpandState.load();
        const canList=ctx.helper.supports('tabs.listWindow');
        if(canList&&!listed&&!listError)listTabs();
        const toolbar=el('div',{className:'page-actions'});
        root.append(el('div',{className:'page-head'},
            el('div',{className:'page-title'},el('h1',{},'Board'),el('p',{className:'page-sub'},'Drag open tabs onto a folder to file them. Middle-click a folder header to open its links, an open tab or its header to close them.')),
            toolbar));
        const refresh=button('⟳ Refresh open tabs',relist,'primary');refresh.disabled=!canList;toolbar.append(refresh);
        const openTabs=(listed&&listed.tabs)||[],copyBtn=button('⧉ Copy links',()=>copyLinks(openTabs,ctx.toast));copyBtn.disabled=!openTabs.length;copyBtn.title='Copy the links of the open tabs, by site';toolbar.append(copyBtn);
        toolbar.append(button('Choose window',async()=>{const wins=await ctx.helper.request('windows.list',{});const select=el('select',{'aria-label':'Browser window'});for(const w of wins)select.append(el('option',{value:String(w.windowId),text:(w.title||'Window')+' · '+w.tabCount}));select.addEventListener('change',()=>{windowId=Number(select.value);relist();});toolbar.append(select);}));
        toolbar.append(button(smart?'Group by domain':'Group by keyword',()=>{smart=!smart;groupsOverride=null;ctx.refresh();}));
        const columns=el('div',{className:'board-columns'}),tabs=el('section',{className:'board-card board-column open-tabs'});
        const tabsOpen=ExpandState.isOpen(OPEN_TABS_KEY,true);
        // New tabs in groups; those already in the tree apart, below them.
        const places=savedPlaces(ctx.store.roots());
        const items=listed?listed.tabs.filter(t=>!places.has(t.url)):[],saved=listed?listed.tabs.filter(t=>places.has(t.url)):[];
        const toggle=button('',()=>{ExpandState.set(OPEN_TABS_KEY,!ExpandState.isOpen(OPEN_TABS_KEY,true));ctx.refresh();},'board-toggle');
        toggle.setAttribute('aria-expanded',String(tabsOpen));
        toggle.append(el('span',{className:'folder-caret','aria-hidden':'true',text:tabsOpen?'▾':'▸'}),el('span',{className:'folder-icon','aria-hidden':'true',text:'🌐'}),
            el('span',{className:'folder-title',text:'Open Tabs'}),el('span',{className:'folder-stats',text:listed?String(items.length)+(saved.length?' · '+saved.length+' saved':''):''}));
        const tabsBody=el('div',{className:'board-body'});
        tabs.append(el('div',{className:'board-heading'},toggle),tabsBody);tabs.classList.toggle('is-open',tabsOpen);tabsBody.hidden=!tabsOpen;
        if(tabsOpen){
            if(!canList)tabsBody.append(el('p',{className:'board-empty'},'Open tabs show here with the TabPaladin helper installed. Tabs already in your tree are listed apart.'));
            else if(listError&&!listed)tabsBody.append(el('p',{className:'board-empty'},listError));
            else if(!listed)tabsBody.append(el('p',{className:'board-empty'},'Reading open tabs…'));
            else{
                if(!items.length)tabsBody.append(el('p',{className:'board-empty'},saved.length?'No new tabs: every open tab is already in your tree (below).':'No tabs to file: every open tab is already in your tree.'));
                const groups=groupsOverride||(smart?TabGrouper.groupSmart(items,settings.customKeywords,settings.categoryOrder):Object.fromEntries([...new Set(items.map(t=>domain(t.url)))].map(d=>[d,items.filter(t=>domain(t.url)===d)])));
                for(const[name,list]of Object.entries(groups)){
                    // A keyword group: the old page's violet .tab-group-card.
                    const group=el('section',{className:'board-domain tab-group'}),key=tabGroupKey(name),groupOpen=ExpandState.isOpen(key,true),header=button('',()=>{ExpandState.set(key,!ExpandState.isOpen(key,true));ctx.refresh();},'tab-group-head');
                    header.title='Drag to file all '+list.length+' tabs. Middle-click to close them';header.setAttribute('aria-expanded',String(groupOpen));closeOnMiddle(header,list,group);
                    header.append(el('span',{className:'folder-caret','aria-hidden':'true',text:groupOpen?'▾':'▸'}),el('span',{className:'folder-icon','aria-hidden':'true',text:'🏷️'}),
                        el('span',{className:'domain-name',text:name}),el('span',{className:'domain-count',text:String(list.length)}));
                    dragTabs(header,{kind:'tabs',tabs:list,group:name});group.append(header);
                    group.addEventListener('dragover',e=>{if(dragging?.kind==='tabs'&&!dragging.saved)e.preventDefault();});
                    group.addEventListener('drop',e=>{if(dragging?.kind!=='tabs'||dragging.saved)return;e.preventDefault();e.stopPropagation();const moving=new Set(dragging.tabs.map(t=>t.tabId));groupsOverride=Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,v.filter(t=>!moving.has(t.tabId))]));groupsOverride[name].push(...dragging.tabs);dragging=null;ctx.refresh();});
                    // Inside, a header per site, as in the folder cards: dragging
                    // one files its tabs straight into the folder dropped on.
                    const sites=new Map();for(const t of list){const d=domain(t.url);if(!sites.has(d))sites.set(d,[]);sites.get(d).push(t);}
                    const bySite=!(sites.size===1&&sites.has(name));
                    if(groupOpen)for(const[site,siteTabs]of sites){
                        const box=bySite?el('div',{className:'board-domain tab-site'}):group;
                        if(bySite){const bar=el('div',{className:'board-domain-head'},el('span',{className:'drag-handle','aria-hidden':'true',text:'⋮⋮'}),el('span',{className:'domain-name',text:site}),el('span',{className:'domain-count',text:String(siteTabs.length)}));bar.title='Drag to file all '+siteTabs.length+' '+site+' tabs. Middle-click to close them';dragTabs(bar,{kind:'tabs',tabs:siteTabs});closeOnMiddle(bar,siteTabs,box);box.append(bar);group.append(box);}
                        for(const t of siteTabs){const row=el('div',{className:'board-tab',title:t.url},favicon(t.url),el('span',{className:'board-tab-title',text:t.title||t.url}));dragTabs(row,{kind:'tabs',tabs:[t]});closeOnMiddle(row,[t]);box.append(row);}
                    }
                    tabsBody.append(group);
                }
                // Tabs already in the tree, with where they are. Dropped on a
                // folder, they are moved there or copied (askMoveOrCopy).
                if(saved.length){
                    const key=tabGroupKey('__saved__'),savedOpen=ExpandState.isOpen(key,true),box=el('section',{className:'board-domain tab-group is-saved'});
                    const header=button('',()=>{ExpandState.set(key,!ExpandState.isOpen(key,true));ctx.refresh();},'tab-group-head');
                    header.title='Already in your tree. Drag to a folder to move them there or add a copy. Middle-click to close them';header.setAttribute('aria-expanded',String(savedOpen));closeOnMiddle(header,saved,box);
                    header.append(el('span',{className:'folder-caret','aria-hidden':'true',text:savedOpen?'▾':'▸'}),el('span',{className:'folder-icon','aria-hidden':'true',text:'✓'}),
                        el('span',{className:'domain-name',text:'Already saved'}),el('span',{className:'domain-count',text:String(saved.length)}));
                    dragTabs(header,{kind:'tabs',tabs:saved,saved:true});box.append(header);
                    if(savedOpen)for(const t of saved){
                        const where=placeNames(places.get(t.url)).join(', ');
                        const row=el('div',{className:'board-tab',title:t.url+'\nSaved in '+where},favicon(t.url),el('span',{className:'board-tab-title',text:t.title||t.url}),el('span',{className:'board-tab-where',text:where}));
                        dragTabs(row,{kind:'tabs',tabs:[t],saved:true});closeOnMiddle(row,[t]);box.append(row);
                    }
                    tabsBody.append(box);
                }
            }
        }
        tabs.addEventListener('dragover',e=>{if(dragging?.kind==='tabs'&&!dragging.saved)e.preventDefault();});
        tabs.addEventListener('drop',e=>{if(dragging?.kind!=='tabs'||dragging.saved||!listed)return;e.preventDefault();const moving=dragging.tabs;const ids=new Set(moving.map(t=>t.tabId));const original=groupsOverride||TabGrouper.groupSmart(items,settings.customKeywords,settings.categoryOrder);groupsOverride=Object.fromEntries(Object.entries(original).map(([k,v])=>[k,v.filter(t=>!ids.has(t.tabId))]));groupsOverride.Ungrouped=[...(groupsOverride.Ungrouped||[]),...moving];dragging=null;ctx.refresh();});
        columns.append(tabs);
        // Three columns: Open Tabs, Workflows (wherever its folder sits) and
        // Bookmarks, which holds the other top-level folders after its own.
        const pool=cards.budget(),roots=ctx.store.roots();
        const flows=walk(roots).find(n=>n.kind==='folder'&&n.role==='workflows');
        if(flows)columns.append(cards.card(flows,{budget:pool}));
        const hasImports=walk(roots).some(n=>n.id==='imports:root');
        appFolders=hasImports?walk(roots).filter(appFolder):[];
        const rest=visibleRoots(roots,settings).filter(n=>n.role!=='workflows'&&!(hasImports&&appFolder(n))),home=rest.find(n=>n.role==='bookmarks');
        if(home)columns.append(cards.card(home,{budget:pool,extra:rest.filter(n=>n!==home)}));
        else for(const n of rest)columns.append(cards.card(n,{budget:pool}));
        root.append(columns);
    },destroy(){cards.destroy();rootRef=null;listed=null;listError=null;snapshotTake=null;}};
    document.addEventListener('dragover',e=>{if(!dragging)return;const edge=60;if(e.clientY<edge)window.scrollBy(0,-18);else if(e.clientY>innerHeight-edge)window.scrollBy(0,18);});
    // The list follows the browser: tab changes the helper reports, and coming
    // back to this page. Mid-drag it waits, so the dragged row stays put.
    const follow=()=>{if(!rootRef?.isConnected||!ctx.helper.supports('tabs.listWindow'))return;if(dragging){stale=true;return;}relist();};
    document.addEventListener('dragend',()=>{if(stale){stale=false;setTimeout(follow,0);}});
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')follow();});
    window.addEventListener('focus',follow);
    ctx.helper.on((event)=>{if(event==='tabs.changed')follow();});
    return board;
}
