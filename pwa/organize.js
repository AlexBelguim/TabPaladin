import { el, button, walk, visibleRoots, download, nodeCount, sameAccount } from './desktopCore.js';
import { BookmarkOrganizer } from './lib/bookmarkOrganizer.js';
function folders(roots){const out=[];const visit=(nodes,path=[])=>{for(const node of nodes||[])if(node.kind==='folder'&&!node.virtual&&!node.readOnly){const parts=[...path,node.title];out.push({node,path:parts.join(' > ')});visit(node.children,parts);}};visit(roots);return out;}
function exportNode(n){if(n.kind==='folder')return{type:'folder',title:n.title,children:(n.children||[]).filter(c=>!c.virtual&&!c.readOnly).map(exportNode)};if(n.kind==='note')return{type:'bookmark',title:n.title,url:'data:application/json,'+encodeURIComponent(JSON.stringify(n.payload))};return{type:'bookmark',title:n.title,url:n.url};}
export function createOrganize(ctx){
    let selected=new Set(),proposal=null,previewAccount=null,rootId=null,splitNext=null,rootRef=null;
    function reset(){selected=new Set();proposal=null;previewAccount=null;}
    async function analyze(ids){
        const account=ctx.account();await ctx.assertAccount(account);const raw=await BookmarkOrganizer.proposeSmartOrganization(ids);
        await ctx.assertAccount(account);previewAccount=account;proposal=[];
        for(const g of raw.groups||[]){const items=[];for(const item of g.items||[]){const n=await ctx.store.getNode(item.id);if(n?.kind==='bookmark'&&!n.virtual&&!n.readOnly)items.push({...item,title:n.title,url:n.url});}if(items.length)proposal.push({...g,items,checked:true});}
        ctx.refresh();
    }
    async function destination(text,group){
        const all=folders(ctx.store.roots()),exact=all.find(f=>f.path.toLowerCase()===text.trim().toLowerCase());if(exact)return exact.node.id;
        const parts=text.split('>').map(p=>p.trim()).filter(Boolean);if(!parts.length)throw new Error('Choose a destination path.');
        let parent=group.targetId&&await ctx.store.getNode(group.targetId);let index=0;
        const prefix=all.filter(f=>text.toLowerCase().startsWith(f.path.toLowerCase()+' > ')).sort((a,b)=>b.path.length-a.path.length)[0];
        if(prefix){parent=prefix.node;index=prefix.path.split('>').length;}
        if(!parent||parent.kind!=='folder'||parent.readOnly||parent.virtual)parent=await ctx.store.ensureRoleRoot('bookmarks');
        for(const title of parts.slice(index)){const next=(parent.children||[]).find(n=>n.kind==='folder'&&n.title.toLowerCase()===title.toLowerCase());parent=next||await ctx.store.createNode({parentId:parent.id,kind:'folder',title});}
        return parent.id;
    }
    async function apply(groups){
        if(!sameAccount(previewAccount,ctx.account()))throw new Error('The account changed. Analyze again.');
        for(const group of groups)for(const item of group.items){const n=await ctx.store.getNode(item.id);if(!n||n.kind!=='bookmark'||n.url!==item.url||n.title!==item.title)throw new Error('A proposed bookmark changed. Analyze again; nothing was moved.');}
        const count=groups.reduce((n,g)=>n+g.items.length,0);if(!count||!confirm('Move '+count+' reviewed bookmarks to the displayed destinations?'))return;
        await ctx.edit(async account=>{for(const group of groups){await ctx.assertAccount(account);const target=await destination(group.destination,group);for(const item of group.items){await ctx.assertAccount(account);await ctx.store.moveNode(item.id,{parentId:target});}}});
        proposal=proposal.filter(g=>!groups.includes(g));ctx.refresh();
    }
    async function importFolder(file){
        if(!file)return;if(file.size>32*1024*1024)throw new Error('Folder JSON is too large.');const data=JSON.parse(await file.text());let count=0;
        const convert=(n,depth=0)=>{if(!n||depth>100||++count>100000||typeof n.title!=='string')throw new Error('Invalid folder JSON.');if(n.type==='folder'){if(!Array.isArray(n.children))throw new Error('Invalid folder children.');return{kind:'folder',title:n.title,children:n.children.map(c=>convert(c,depth+1))};}if(n.type!=='bookmark'||typeof n.url!=='string'||n.url.length>8192)throw new Error('Invalid bookmark JSON.');
            if(n.url.startsWith('data:application/json,')){let payload;try{payload=JSON.parse(decodeURIComponent(n.url.slice('data:application/json,'.length)));}catch{throw new Error('Invalid note in folder JSON.');}return{kind:'note',title:n.title,payload};}return{kind:'bookmark',title:n.title,url:n.url};};
        if(data.version!==1||data.type!=='folder')throw new Error('Choose a version 1 folder export.');const tree=convert(data);const existing=ctx.store.roots().find(n=>n.kind==='folder'&&n.title===tree.title&&!n.role&&!n.virtual);let replace=false;
        if(existing){replace=confirm('Replace '+existing.title+' ('+nodeCount(existing)+' items)? Cancel offers renaming.');if(!replace){const name=prompt('Import under a different folder name',tree.title+' (imported)');if(!name)return;tree.title=name;}else if(!confirm('Confirm replacement. The existing working copy will first be kept aside as a backup.'))return;}
        if(!confirm('Import '+count+' items into '+tree.title+'?'))return;
        await ctx.edit(async account=>{if(replace)await ctx.store.importBackupCopy({roots:ctx.store.roots(),...ctx.store.status()},{account});const made=await ctx.store.createTree({parentId:null,tree});if(replace)await ctx.store.removeNode(existing.id);const settings=await ctx.storage.getSettings();await ctx.storage.saveSettings({...settings,focusedFolderIds:[...new Set([...(settings.focusedFolderIds||[]),made.id])]});});
        ctx.toast('Folder imported locally.');
    }
    const api={split(id){splitNext=id;proposal=null;},async render(root,id=null){
        rootRef=root;if(previewAccount&&!sameAccount(previewAccount,ctx.account()))reset();if(rootId!==id){rootId=id;selected=new Set();if(!splitNext)proposal=null;}
        root.append(el('h1',{},'Organize'));
        const settings=await ctx.storage.getSettings(),all=folders(ctx.store.roots());
        const current=id?await ctx.store.getNode(id):null;
        if(current&&(current.virtual||current.readOnly)){root.append(el('p',{},'The archive is managed on the Board; choose a writable source.'));return;}
        const tools=el('div',{className:'desktop-inline'},button('Sources',()=>{proposal=null;ctx.navigate('organize');}),button('+ New folder',async()=>{const title=prompt('Folder name');if(title?.trim())await ctx.edit(()=>ctx.store.createNode({parentId:current?.id||null,kind:'folder',title:title.trim()}));}));
        const file=el('input',{type:'file',accept:'.json',hidden:true});file.addEventListener('change',async()=>{try{await importFolder(file.files[0]);}catch(e){ctx.toast(e.message);}finally{file.value='';}});
        tools.append(button('Import folder JSON',()=>file.click()),file);if(current)tools.append(button('Export folder JSON',()=>download('folder.json',JSON.stringify({version:1,exportedAt:new Date().toISOString(),...exportNode(current)},null,2))));root.append(tools);
        if(splitNext){const target=splitNext;splitNext=null;await analyze(['loose-'+target]);return;}
        if(proposal){
            root.append(el('h2',{},'Review proposed moves'));
            if(!proposal.length)root.append(el('p',{},'No keyword-based moves were proposed.'));
            const paths=el('datalist',{id:'organize-paths'});for(const f of all)paths.append(el('option',{value:f.path}));root.append(paths);
            for(const group of proposal){const section=el('section',{className:'organize-proposal'}),check=el('input',{type:'checkbox',checked:group.checked});check.addEventListener('change',()=>group.checked=check.checked);
                const base=all.find(f=>f.node.id===group.targetId)?.path||'Bookmarks';group.destination??=base+(group.newSubfolder?' > '+group.newSubfolder:'');
                const input=el('input',{value:group.destination,list:'organize-paths','aria-label':'Destination folder path'});input.addEventListener('input',()=>group.destination=input.value);
                section.append(el('label',{},check,' '+group.groupName),input);
                group.items.forEach(item=>{const row=el('div',{className:'proposal-item',text:item.title+' — '+item.url,draggable:true});row.addEventListener('dragstart',e=>e.dataTransfer.setData('application/x-tp-proposal',item.id));section.append(row);});
                section.addEventListener('dragover',e=>e.preventDefault());section.addEventListener('drop',e=>{e.preventDefault();const itemId=e.dataTransfer.getData('application/x-tp-proposal');let item;for(const from of proposal){const hit=from.items.find(i=>i.id===itemId);if(hit){item=hit;from.items=from.items.filter(i=>i.id!==itemId);break;}}if(item){group.items.push(item);ctx.refresh();}});
                section.append(button('Apply this group',()=>apply([group])));root.append(section);
            }
            root.append(button('Apply selected changes',()=>apply(proposal.filter(g=>g.checked)),'primary'),button('Back to sources',()=>{proposal=null;ctx.refresh();}));return;
        }
        const breadcrumb=el('div',{className:'desktop-inline'},button('All sources',()=>ctx.navigate('organize')));if(current){const path=all.find(f=>f.node.id===current.id)?.path;breadcrumb.append(el('span',{},path||current.title));}root.append(breadcrumb);
        const sources=current?(current.children||[]).filter(n=>n.kind==='folder'&&!n.readOnly&&!n.virtual):visibleRoots(ctx.store.roots(),settings).filter(n=>!n.virtual&&!n.readOnly);
        const grid=el('div',{className:'organize-sources'});
        for(const source of sources){const check=el('input',{type:'checkbox',checked:selected.has(source.id)});check.addEventListener('change',()=>check.checked?selected.add(source.id):selected.delete(source.id));const tile=el('article',{},el('label',{},check,' '+source.title),el('p',{},(source.children||[]).filter(n=>n.kind==='bookmark').length+' loose bookmarks'),button('Browse ›',()=>ctx.navigate('organize',source.id)),button('Split loose bookmarks',()=>analyze(['loose-'+source.id])));grid.append(tile);}
        root.append(grid);
        if(current){const loose=(current.children||[]).filter(n=>n.kind==='bookmark');const check=el('input',{type:'checkbox',checked:selected.has('loose-'+current.id)});check.addEventListener('change',()=>check.checked?selected.add('loose-'+current.id):selected.delete('loose-'+current.id));root.append(el('label',{},check,' Loose bookmarks here · '+loose.length));for(const n of loose.slice(0,200))root.append(el('p',{},n.title+' — '+n.url));}
        root.append(button('Analyze & Sort selected',()=>analyze([...selected]),'primary'),button('Back to Board',()=>ctx.navigate('board')));
    }};return api;
}
