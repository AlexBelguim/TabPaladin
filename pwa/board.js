import { el, button, walk, visibleRoots, nodeCount, sameAccount } from './desktopCore.js';
import { ExpandState, OPEN_TABS_KEY, tabGroupKey } from './lib/expandState.js';
import { TabGrouper } from './lib/tabGrouper.js';
import { helperUrl } from './helper.js';
let dragging = null;
const domain = url => { try { return new URL(url).hostname.replace(/^www\./,'') || 'Local files'; } catch { return 'Other'; } };
export async function openNodes(ctx,nodes,limit=500,mode='new-window') {
    const eligible=nodes.filter(n=>n.kind==='bookmark'&&helperUrl(n.url));
    const urls=eligible.slice(0,limit).map(n=>n.url);
    if(eligible.length>limit&&limit===500)ctx.toast('Opening the first 500 of '+eligible.length+' bookmarks. Open smaller folders for the rest.');
    if(!urls.length)return;
    if(ctx.helper.supports('windows.openUrls')){const result=await ctx.helper.request('windows.openUrls',{urls,mode});if(result.failed?.length)ctx.toast(result.failed.length+' bookmarks could not be opened. Your bookmarks are kept.');}
    else for(const url of urls)ctx.openExternal(url);
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
    // lead: an element shown between the header and the body (Workflows' bar).
    function card(node,{depth=0,budget:pool=budget(),lead=null}={}){
        const readOnly=node.virtual||node.readOnly||String(node.id).startsWith('imp:')||String(node.id).startsWith('imports:');
        const box=el('section',{className:'board-card'+(depth?' nested':' board-column')+(readOnly?' is-imports':'')+(node.role==='workflows'?' is-workflows':''),dataset:{folderId:node.id}}),head=el('div',{className:'board-heading'}),body=el('div',{className:'board-body'});
        let open=ExpandState.isOpen(node.id,depth===0),filled=false,limit=200;
        const caret=el('span',{className:'folder-caret','aria-hidden':'true'});
        const toggle=button('',()=>{open=!open;ExpandState.set(node.id,open);fill();},'board-toggle');
        toggle.title=node.title||'Untitled';
        toggle.append(caret,el('span',{className:'folder-icon','aria-hidden':'true',text:readOnly?'📥':node.role==='workflows'?'💾':'📁'}),
            el('span',{className:'folder-title',text:node.title||'Untitled'}));
        if(readOnly)toggle.append(el('span',{className:'imports-badge',text:'synced'}));
        toggle.append(el('span',{className:'folder-stats',text:folderStats(node.children||[])}));
        const actions=el('div',{className:'board-tools'});
        const loose=()=>((ctx.store.roots().length?walk(ctx.store.roots()).find(n=>n.id===node.id):null)?.children||[]).filter(n=>n.kind==='bookmark');
        const many=loose().length;
        if(many)actions.append(tool(many>500?'▶ 500':'▶ All',many>500?'Open the first 500 bookmarks in a new window':'Open all '+many+' bookmarks in a new window',()=>openNodes(ctx,loose())));
        if(many>10)actions.append(tool('▶ 10','Open the first 10 in a new window',()=>openNodes(ctx,loose(),10)));
        head.addEventListener('auxclick',e=>{if(e.button===1){e.preventDefault();openNodes(ctx,loose()).catch(x=>ctx.toast(x.message));}});
        if(!readOnly){
            if(ctx.split)actions.append(tool('✨ Split','Sort the loose bookmarks here by keyword',()=>ctx.split(node.id),'icon-btn tool-split'));
            actions.append(tool('＋📁','New folder inside '+(node.title||'this folder'),async()=>{const title=prompt('New subfolder');if(title?.trim())await ctx.edit(()=>ctx.store.createNode({parentId:node.id,kind:'folder',title:title.trim()}));}));
            if(!node.role)actions.append(tool('🗑','Delete '+(node.title||'this folder'),async()=>{if(confirm('Delete '+(node.title||'folder')+' and its '+(nodeCount(node)-1)+' items?')){const account=ctx.account();await ctx.edit(()=>ctx.store.removeNode(node.id));if(ctx.helper.supports('track.untrack'))await ctx.helper.request('track.untrack',{workflowId:node.id,account});}},'icon-btn danger'));
        }
        actions.append(tool('›','Browse '+(node.title||'this folder')+' in Organize',()=>ctx.navigate('organize',node.id)));
        if(!readOnly){
            drag(toggle,{kind:'nodes',ids:[node.id]},ctx);
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
            const children=node.children||[];const folders=children.filter(n=>n.kind==='folder');
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
                    row.append(favicon(item.url),a,tool('🗑','Delete bookmark',()=>removeItems(ctx,[item]),'icon-btn danger bm-del'));drag(row,{kind:'nodes',ids:[item.id]},ctx);group.append(row);
                }body.append(group);
            }
            const total=children.filter(n=>n.kind==='bookmark').length;
            if(shown<total)body.append(button('Show '+Math.min(500,total-shown)+' more',()=>{limit+=500;pool.remaining+=500;filled=false;body.replaceChildren();fill();},'board-more'));
            if(!children.length)body.append(el('p',{className:'board-empty'},readOnly?'Empty folder.':'Empty folder. Drag tabs or bookmarks here.'));
        }
        if(open&&pool.remaining<=0){open=false;caret.textContent='▷';box.classList.add('restore-skipped');}
        fill();return box;
    }
    return {card,budget,restore:()=>{},destroy(){generation++;for(const t of timers)clearTimeout(t);timers.clear();}};
}
export function createBoard(ctx){
    let snapshot=null,windowId=null,settings={},rootRef=null,smart=true,groupsOverride=null;
    const accountAtSnapshot=()=>snapshot?.account;
    const localCtx={...ctx,fileTabs,split:id=>ctx.split(id)};
    const cards=createFolderCards(localCtx);
    async function fileTabs(payload,targetId){
        const filingSnapshot=snapshot;
        if(!filingSnapshot||filingSnapshot.snapshotId!==payload.snapshotId||!sameAccount(accountAtSnapshot(),ctx.account()))throw new Error('Refresh the tab snapshot before filing.');
        const selected=payload.tabs.filter(t=>filingSnapshot.tabs.some(s=>s.tabId===t.tabId&&s.url===t.url));
        if(!selected.length||selected.length!==payload.tabs.length)throw new Error('The tab snapshot changed. No tabs were closed.');
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
            for(const t of selected){const n=await ctx.store.createNode({parentId:target.id,kind:'bookmark',title:t.title||t.url,url:t.url});savedIds.push({id:n.id,url:t.url});}
        });
        const kind=await ctx.platform.backendKind();if(!['indexeddb','cache'].includes(kind))throw new Error('The bookmarks are kept in memory only; tabs remain open.');
        const record=(await ctx.platform.getRaw('tpTree')).tpTree;const nodes=walk(record?.roots||[]);
        if(!savedIds.every(s=>nodes.some(n=>n.id===s.id&&n.url===s.url)))throw new Error('Could not read back every filed bookmark; tabs remain open.');
        await ctx.assertAccount(payload.account);
        const result=await ctx.helper.request('tabs.closeSnapshot',{snapshotId:filingSnapshot.snapshotId,tabIds:selected.map(t=>t.tabId),expectedCount:selected.length});
        if(workflowId)await ctx.publishWorkflow?.(workflowId);
        snapshot=null;ctx.toast('Filed '+selected.length+' tabs; '+result.closed.length+' closed. Refresh to file more.');ctx.refresh();
    }
    async function refreshTabs(){
        const account=ctx.account();await ctx.assertAccount(account);
        const body={purpose:'file'};if(windowId!=null)body.windowId=windowId;
        const got=await ctx.helper.request('tabs.snapshot',body);snapshot={...got,account};groupsOverride=null;ctx.refresh();
    }
    const board={async render(root){
        rootRef=root;if(snapshot&&!sameAccount(snapshot.account,ctx.account())){snapshot=null;groupsOverride=null;}settings=await ctx.storage.getSettings();await ExpandState.load();
        const toolbar=el('div',{className:'page-actions'});
        root.append(el('div',{className:'page-head'},
            el('div',{className:'page-title'},el('h1',{},'Board'),el('p',{className:'page-sub'},'Drag open tabs onto a folder to file them. Middle-click a header to open its links.')),
            toolbar));
        const refresh=button('⟳ Refresh open tabs',refreshTabs,'primary');refresh.disabled=!ctx.helper.supports('tabs.snapshot');toolbar.append(refresh);
        toolbar.append(button('Choose window',async()=>{const wins=await ctx.helper.request('windows.list',{});const select=el('select',{'aria-label':'Browser window'});for(const w of wins)select.append(el('option',{value:String(w.windowId),text:(w.title||'Window')+' · '+w.tabCount}));select.addEventListener('change',()=>{windowId=Number(select.value);snapshot=null;});windowId=wins[0]?.windowId??null;toolbar.append(select);}));
        toolbar.append(button(smart?'Group by domain':'Group by keyword',()=>{smart=!smart;groupsOverride=null;ctx.refresh();}));
        const columns=el('div',{className:'board-columns'}),tabs=el('section',{className:'board-card board-column open-tabs'});
        const tabsOpen=ExpandState.isOpen(OPEN_TABS_KEY,true);
        const known=new Set(walk(ctx.store.roots()).filter(n=>n.url).map(n=>n.url));
        const items=snapshot?snapshot.tabs.filter(t=>!known.has(t.url)):[];
        const toggle=button('',()=>{ExpandState.set(OPEN_TABS_KEY,!ExpandState.isOpen(OPEN_TABS_KEY,true));ctx.refresh();},'board-toggle');
        toggle.setAttribute('aria-expanded',String(tabsOpen));
        toggle.append(el('span',{className:'folder-caret','aria-hidden':'true',text:tabsOpen?'▾':'▸'}),el('span',{className:'folder-icon','aria-hidden':'true',text:'🌐'}),
            el('span',{className:'folder-title',text:'Open Tabs'}),el('span',{className:'folder-stats',text:snapshot?String(items.length):''}));
        const tabsBody=el('div',{className:'board-body'});
        tabs.append(el('div',{className:'board-heading'},toggle),tabsBody);tabs.classList.toggle('is-open',tabsOpen);tabsBody.hidden=!tabsOpen;
        if(tabsOpen){
            if(!snapshot)tabsBody.append(el('p',{className:'board-empty'},ctx.helper.supports('tabs.snapshot')?'Click Refresh open tabs. Tabs already in your tree are hidden.':'Open tabs show here with the TabPaladin helper installed. Tabs already in your tree are hidden.'));
            else{
                if(!items.length)tabsBody.append(el('p',{className:'board-empty'},'No tabs to file: every open tab is already in your tree.'));
                const groups=groupsOverride||(smart?TabGrouper.groupSmart(items,settings.customKeywords,settings.categoryOrder):Object.fromEntries([...new Set(items.map(t=>domain(t.url)))].map(d=>[d,items.filter(t=>domain(t.url)===d)])));
                for(const[name,list]of Object.entries(groups)){
                    // A keyword group: the old page's violet .tab-group-card.
                    const group=el('section',{className:'board-domain tab-group'}),key=tabGroupKey(name),groupOpen=ExpandState.isOpen(key,true),header=button('',()=>{ExpandState.set(key,!ExpandState.isOpen(key,true));ctx.refresh();},'tab-group-head');
                    header.title='Drag to file all '+list.length+' tabs';header.setAttribute('aria-expanded',String(groupOpen));
                    header.append(el('span',{className:'folder-caret','aria-hidden':'true',text:groupOpen?'▾':'▸'}),el('span',{className:'folder-icon','aria-hidden':'true',text:'🏷️'}),
                        el('span',{className:'domain-name',text:name}),el('span',{className:'domain-count',text:String(list.length)}));
                    drag(header,{kind:'tabs',tabs:list,group:name,snapshotId:snapshot.snapshotId},ctx);group.append(header);
                    group.addEventListener('dragover',e=>{if(dragging?.kind==='tabs')e.preventDefault();});
                    group.addEventListener('drop',e=>{if(dragging?.kind!=='tabs')return;e.preventDefault();e.stopPropagation();const moving=new Set(dragging.tabs.map(t=>t.tabId));groupsOverride=Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,v.filter(t=>!moving.has(t.tabId))]));groupsOverride[name].push(...dragging.tabs);dragging=null;ctx.refresh();});
                    if(groupOpen)for(const t of list){const row=el('div',{className:'board-tab',title:t.url},favicon(t.url),el('span',{className:'board-tab-title',text:t.title||t.url}));drag(row,{kind:'tabs',tabs:[t],snapshotId:snapshot.snapshotId},ctx);group.append(row);}tabsBody.append(group);
                }
            }
        }
        tabs.addEventListener('dragover',e=>{if(dragging?.kind==='tabs')e.preventDefault();});
        tabs.addEventListener('drop',e=>{if(dragging?.kind!=='tabs'||!snapshot)return;e.preventDefault();const items=dragging.tabs;const ids=new Set(items.map(t=>t.tabId));const original=groupsOverride||TabGrouper.groupSmart(snapshot.tabs,settings.customKeywords,settings.categoryOrder);groupsOverride=Object.fromEntries(Object.entries(original).map(([k,v])=>[k,v.filter(t=>!ids.has(t.tabId))]));groupsOverride.Ungrouped=[...(groupsOverride.Ungrouped||[]),...items];dragging=null;ctx.refresh();});
        columns.append(tabs);
        const pool=cards.budget();for(const n of visibleRoots(ctx.store.roots(),settings))columns.append(cards.card(n,{budget:pool}));root.append(columns);
    },destroy(){cards.destroy();rootRef=null;snapshot=null;}};
    document.addEventListener('dragover',e=>{if(!dragging)return;const edge=60;if(e.clientY<edge)window.scrollBy(0,-18);else if(e.clientY>innerHeight-edge)window.scrollBy(0,18);});
    ctx.helper.on((event)=>{if(event==='tabs.changed'&&rootRef?.isConnected){snapshot=null;ctx.toast('Browser tabs changed. Refresh before filing.');ctx.refresh();}});
    return board;
}
