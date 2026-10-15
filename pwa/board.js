import { el, button, walk, visibleRoots, nodeCount, sameAccount } from './desktopCore.js';
import { ExpandState, OPEN_TABS_KEY, tabGroupKey } from './lib/expandState.js';
import { TabGrouper } from './lib/tabGrouper.js';
import { helperUrl } from './helper.js';
let dragging = null;
const domain = url => { try { return new URL(url).hostname.replace(/^www\./,'') || 'Local files'; } catch { return 'Other'; } };
export async function openNodes(ctx,nodes,limit=500,mode='new-window') {
    const urls=nodes.filter(n=>n.kind==='bookmark'&&helperUrl(n.url)).slice(0,limit).map(n=>n.url);
    if(!urls.length)return;
    if(ctx.helper.supports('windows.openUrls'))await ctx.helper.request('windows.openUrls',{urls,mode});
    else for(const url of urls){const u=new URL(url);if(['http:','https:'].includes(u.protocol))window.open(url,'_blank','noopener');}
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
export function createFolderCards(ctx){
    let generation=0;const timers=new Set();
    const budget=()=>({remaining:2000,controllers:[]});
    function card(node,{depth=0,budget:pool=budget()}={}){
        const box=el('section',{className:'board-card',dataset:{folderId:node.id}}),head=el('div',{className:'board-heading'}),body=el('div',{className:'board-body'});
        const readOnly=node.virtual||node.readOnly||String(node.id).startsWith('imp:')||String(node.id).startsWith('imports:');
        let open=ExpandState.isOpen(node.id,depth===0),filled=false,limit=200;
        const toggle=button((open?'▾ ':'▸ ')+(node.title||'Untitled'),()=>{open=!open;ExpandState.set(node.id,open);fill();},'board-toggle');
        const actions=el('div',{className:'board-tools'});
        const loose=()=>((ctx.store.roots().length?walk(ctx.store.roots()).find(n=>n.id===node.id):null)?.children||[]).filter(n=>n.kind==='bookmark');
        actions.append(button('Open All',()=>openNodes(ctx,loose())),button('Open 10',()=>openNodes(ctx,loose(),10)));
        head.addEventListener('auxclick',e=>{if(e.button===1){e.preventDefault();openNodes(ctx,loose()).catch(x=>ctx.toast(x.message));}});
        actions.append(button('›',()=>ctx.navigate('organize',node.id)));
        if(!readOnly){
            actions.append(button('+ Folder',async()=>{const title=prompt('New subfolder');if(title?.trim())await ctx.edit(()=>ctx.store.createNode({parentId:node.id,kind:'folder',title:title.trim()}));}));
            if(ctx.split)actions.append(button('Split',()=>ctx.split(node.id)));
            if(!node.role)actions.append(button('Delete',async()=>{if(confirm('Delete '+(node.title||'folder')+' and its '+(nodeCount(node)-1)+' items?'))await ctx.edit(()=>ctx.store.removeNode(node.id));}));
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
        head.append(toggle,actions);box.append(head,body);
        function fill(){body.hidden=!open;toggle.textContent=(open?'▾ ':'▸ ')+(node.title||'Untitled');if(!open||filled)return;filled=true;
            const children=node.children||[];const folders=children.filter(n=>n.kind==='folder');
            for(const sub of folders)body.append(card(sub,{depth:depth+1,budget:pool}));
            const groups=new Map();for(const b of children.filter(n=>n.kind==='bookmark')){const key=domain(b.url);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(b);}
            let shown=0;
            for(const [name,items]of groups){
                const group=el('div',{className:'board-domain'}),bar=el('div',{className:'board-domain-head'},el('strong',{},name+' · '+items.length));
                bar.append(button('All',()=>openNodes(ctx,items)),button('10',()=>openNodes(ctx,items,10)),button('Delete',()=>removeItems(ctx,items)));
                drag(bar,{kind:'nodes',ids:items.map(n=>n.id)},ctx);group.append(bar);
                bar.addEventListener('auxclick',e=>{if(e.button===1){e.preventDefault();openNodes(ctx,items).catch(x=>ctx.toast(x.message));}});
                for(const item of items){
                    if(shown>=limit||pool.remaining<=0)break;shown++;pool.remaining--;
                    const row=el('div',{className:'board-bookmark'}),a=el('a',{href:item.url,target:'_blank',rel:'noopener',text:item.title||item.url});
                    if(helperUrl(item.url))row.addEventListener('auxclick',e=>{if(e.button===1&&ctx.helper.supports('windows.openUrls')){e.preventDefault();openNodes(ctx,[item],1,'background').catch(x=>ctx.toast(x.message));}});
                    row.append(a,button('×',()=>removeItems(ctx,[item])));drag(row,{kind:'nodes',ids:[item.id]},ctx);group.append(row);
                }body.append(group);
            }
            const total=children.filter(n=>n.kind==='bookmark').length;
            if(shown<total)body.append(button('Show '+Math.min(500,total-shown)+' more',()=>{limit+=500;pool.remaining+=500;filled=false;body.replaceChildren();fill();}));
        }
        if(open&&pool.remaining<=0){open=false;toggle.textContent='▷ '+(node.title||'Untitled');}
        fill();return box;
    }
    return {card,budget,restore:()=>{},destroy(){generation++;for(const t of timers)clearTimeout(t);timers.clear();}};
}
export function createBoard(ctx){
    let snapshot=null,windowId=null,settings={},rootRef=null,smart=true,groupsOverride=null;
    const accountAtSnapshot=()=>snapshot?.account;
    const localCtx={...ctx,fileTabs,split:id=>ctx.navigate('organize',id)};
    const cards=createFolderCards(localCtx);
    async function fileTabs(payload,targetId){
        if(!snapshot||snapshot.snapshotId!==payload.snapshotId||!sameAccount(accountAtSnapshot(),ctx.account()))throw new Error('Refresh the tab snapshot before filing.');
        const selected=payload.tabs.filter(t=>snapshot.tabs.some(s=>s.tabId===t.tabId&&s.url===t.url));
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
        const result=await ctx.helper.request('tabs.closeSnapshot',{snapshotId:snapshot.snapshotId,tabIds:selected.map(t=>t.tabId),expectedCount:selected.length});
        if(workflowId)await ctx.publishWorkflow?.(workflowId);
        snapshot=null;ctx.toast('Filed '+selected.length+' tabs; '+result.closed.length+' closed. Refresh to file more.');ctx.refresh();
    }
    async function refreshTabs(){
        const account=ctx.account();await ctx.assertAccount(account);
        const body={purpose:'file'};if(windowId!=null)body.windowId=windowId;
        const got=await ctx.helper.request('tabs.snapshot',body);snapshot={...got,account};groupsOverride=null;ctx.refresh();
    }
    const board={async render(root){
        rootRef=root;settings=await ctx.storage.getSettings();await ExpandState.load();
        root.append(el('h1',{},'Board'));
        const toolbar=el('div',{className:'desktop-inline'});
        const refresh=button('Refresh open tabs',refreshTabs);refresh.disabled=!ctx.helper.supports('tabs.snapshot');toolbar.append(refresh);
        toolbar.append(button('Choose window',async()=>{const wins=await ctx.helper.request('windows.list',{});const select=el('select',{'aria-label':'Browser window'});for(const w of wins)select.append(el('option',{value:String(w.windowId),text:(w.title||'Window')+' · '+w.tabCount}));select.addEventListener('change',()=>{windowId=Number(select.value);snapshot=null;});windowId=wins[0]?.windowId??null;toolbar.append(select);}));
        toolbar.append(button(smart?'Group by domain':'Group by keyword',()=>{smart=!smart;groupsOverride=null;ctx.refresh();}));root.append(toolbar);
        const columns=el('div',{className:'board-columns'}),tabs=el('section',{className:'board-card open-tabs'});
        const toggle=button('Open Tabs',()=>{ExpandState.set(OPEN_TABS_KEY,!ExpandState.isOpen(OPEN_TABS_KEY,true));ctx.refresh();});tabs.append(toggle);
        if(ExpandState.isOpen(OPEN_TABS_KEY,true)){
            if(!snapshot)tabs.append(el('p',{},'Click Refresh open tabs. Tabs already in your tree are hidden.'));
            else{
                const known=new Set(walk(ctx.store.roots()).filter(n=>n.url).map(n=>n.url));
                const items=snapshot.tabs.filter(t=>!known.has(t.url));
                const groups=groupsOverride||(smart?TabGrouper.groupSmart(items,settings.customKeywords,settings.categoryOrder):Object.fromEntries([...new Set(items.map(t=>domain(t.url)))].map(d=>[d,items.filter(t=>domain(t.url)===d)])));
                for(const[name,list]of Object.entries(groups)){
                    const group=el('section',{className:'board-domain'}),key=tabGroupKey(name),header=button(name+' · '+list.length,()=>{ExpandState.set(key,!ExpandState.isOpen(key,true));ctx.refresh();});
                    drag(header,{kind:'tabs',tabs:list,group:name,snapshotId:snapshot.snapshotId},ctx);group.append(header);
                    group.addEventListener('dragover',e=>{if(dragging?.kind==='tabs')e.preventDefault();});
                    group.addEventListener('drop',e=>{if(dragging?.kind!=='tabs')return;e.preventDefault();e.stopPropagation();const moving=new Set(dragging.tabs.map(t=>t.tabId));groupsOverride=Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,v.filter(t=>!moving.has(t.tabId))]));groupsOverride[name].push(...dragging.tabs);dragging=null;ctx.refresh();});
                    if(ExpandState.isOpen(key,true))for(const t of list){const row=el('div',{className:'board-tab',text:t.title||t.url,title:t.url});drag(row,{kind:'tabs',tabs:[t],snapshotId:snapshot.snapshotId},ctx);group.append(row);}tabs.append(group);
                }
            }
        }columns.append(tabs);
        const pool=cards.budget();for(const n of visibleRoots(ctx.store.roots(),settings))columns.append(cards.card(n,{budget:pool}));root.append(columns);
    },destroy(){cards.destroy();rootRef=null;snapshot=null;}};
    document.addEventListener('dragover',e=>{if(!dragging)return;const edge=60;if(e.clientY<edge)window.scrollBy(0,-18);else if(e.clientY>innerHeight-edge)window.scrollBy(0,18);});
    ctx.helper.on((event)=>{if(event==='tabs.changed'&&rootRef?.isConnected){snapshot=null;ctx.toast('Browser tabs changed. Refresh before filing.');ctx.refresh();}});
    return board;
}
