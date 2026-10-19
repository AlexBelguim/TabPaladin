import { el, button, walk, visibleRoots, download, nodeCount, sameAccount, folderPaths } from './desktopCore.js';
import { BookmarkOrganizer } from './lib/bookmarkOrganizer.js';
function exportNode(n){if(n.kind==='folder')return{type:'folder',title:n.title,children:(n.children||[]).filter(c=>!c.virtual&&!c.readOnly).map(exportNode)};if(n.kind==='note')return{type:'bookmark',title:n.title,url:'data:application/json,'+encodeURIComponent(JSON.stringify(n.payload))};return{type:'bookmark',title:n.title,url:n.url};}
export function createOrganize(ctx){
    let selected=new Set(),proposal=null,previewAccount=null,rootId=null,splitNext=null,rootRef=null;
    function reset(){selected=new Set();proposal=null;previewAccount=null;}
    async function analyze(ids){
        const account=ctx.account();await ctx.assertAccount(account);const scope=new Set();for(const id of ids){if(id.startsWith('loose-'))scope.add(id);else{const n=await ctx.store.getNode(id);if(n)for(const f of walk([n]).filter(x=>x.kind==='folder'&&!x.virtual&&!x.readOnly))scope.add('loose-'+f.id);}}const raw=await BookmarkOrganizer.proposeSmartOrganization([...scope]);
        await ctx.assertAccount(account);previewAccount=account;proposal=[];
        for(const g of raw.groups||[]){const items=[];for(const item of g.items||[]){const n=await ctx.store.getNode(item.id);if(n?.kind==='bookmark'&&!n.virtual&&!n.readOnly)items.push({...item,title:n.title,url:n.url});}if(items.length)proposal.push({...g,items,checked:true});}
        ctx.refresh();
    }
    async function destination(text,group){
        const all=folderPaths(ctx.store.roots()),exact=all.find(f=>f.path.toLowerCase()===text.trim().toLowerCase());if(exact)return exact.node.id;
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
        await ctx.edit(async account=>{if(replace)await ctx.store.importBackupCopy({roots:ctx.store.roots(),...ctx.store.status()},{account});const made=await ctx.store.createTree({parentId:null,tree});if(replace)await ctx.store.removeNode(existing.id);const settings=await ctx.storage.getSettings();await ctx.store.saveCopySettings({focusedFolderIds:[...new Set([...(settings.focusedFolderIds||[]),made.id])]},{account});});
        ctx.toast('Folder imported locally.');
    }
    const api={split(id){splitNext=id;proposal=null;},async render(root,id=null){
        rootRef=root;if(previewAccount&&!sameAccount(previewAccount,ctx.account()))reset();if(rootId!==id){rootId=id;selected=new Set();if(!splitNext)proposal=null;}
        const tools=el('div',{className:'page-actions'});
        root.append(el('div',{className:'page-head'},
            el('div',{className:'page-title'},el('h1',{},'Organize'),el('p',{className:'page-sub'},'Pick folders, then sort their loose bookmarks into subfolders by your keywords (Settings › Custom keywords).')),
            tools));
        const settings=await ctx.storage.getSettings(),all=folderPaths(ctx.store.roots());
        const current=id?await ctx.store.getNode(id):null;
        if(current&&(current.virtual||current.readOnly)){root.append(el('p',{className:'desk-empty'},'The archive is managed on the Board; choose a writable source.'));return;}
        tools.append(button('Sources',()=>{proposal=null;ctx.navigate('organize');}),button('＋📁 New folder',async()=>{const title=prompt('Folder name');if(title?.trim())await ctx.edit(()=>ctx.store.createNode({parentId:current?.id||null,kind:'folder',title:title.trim()}));}));
        const file=el('input',{type:'file',accept:'.json',hidden:true});file.addEventListener('change',async()=>{try{await importFolder(file.files[0]);}catch(e){ctx.toast(e.message);}finally{file.value='';}});
        tools.append(button('📥 Import folder JSON',()=>file.click()),file);if(current)tools.append(button('📤 Export folder JSON',()=>download('folder.json',JSON.stringify({version:1,exportedAt:new Date().toISOString(),...exportNode(current)},null,2))));
        if(splitNext){const target=splitNext;splitNext=null;await analyze(['loose-'+target]);return;}
        if(proposal){
            const moving=proposal.reduce((n,g)=>n+g.items.length,0);
            root.append(el('h2',{},'Review proposed moves · '+proposal.length+' group'+(proposal.length===1?'':'s')+', '+moving+' bookmark'+(moving===1?'':'s')));
            if(!proposal.length)root.append(el('p',{className:'desk-empty'},'No keyword-based moves were proposed.'));
            const paths=el('datalist',{id:'organize-paths'});for(const f of all)paths.append(el('option',{value:f.path}));root.append(paths);
            const groups=el('div',{className:'proposal-grid'});
            for(const group of proposal){const section=el('section',{className:'organize-proposal'}),check=el('input',{type:'checkbox',checked:group.checked});check.addEventListener('change',()=>{group.checked=check.checked;section.classList.toggle('unchecked',!check.checked);});
                section.classList.toggle('unchecked',!group.checked);
                const base=all.find(f=>f.node.id===group.targetId)?.path||'Bookmarks';group.destination??=base+(group.newSubfolder?' > '+group.newSubfolder:'');
                const input=el('input',{value:group.destination,list:'organize-paths','aria-label':'Destination folder path'});input.addEventListener('input',()=>group.destination=input.value);
                section.append(el('label',{className:'proposal-head'},check,el('span',{className:'proposal-name',text:group.groupName}),el('span',{className:'proposal-count',text:String(group.items.length)})),
                    el('label',{className:'proposal-dest'},el('span',{},'Move to'),input));
                const list=el('div',{className:'proposal-items'});
                group.items.forEach(item=>{const row=el('div',{className:'proposal-item',draggable:true,title:item.url},el('span',{className:'pi-title',text:item.title}),el('span',{className:'pi-url',text:item.url}));row.addEventListener('dragstart',e=>e.dataTransfer.setData('application/x-tp-proposal',item.id));list.append(row);});
                section.append(list);
                section.addEventListener('dragover',e=>{e.preventDefault();section.classList.add('drop-target');});section.addEventListener('dragleave',()=>section.classList.remove('drop-target'));
                section.addEventListener('drop',e=>{e.preventDefault();section.classList.remove('drop-target');const itemId=e.dataTransfer.getData('application/x-tp-proposal');let item;for(const from of proposal){const hit=from.items.find(i=>i.id===itemId);if(hit){item=hit;from.items=from.items.filter(i=>i.id!==itemId);break;}}if(item){group.items.push(item);ctx.refresh();}});
                section.append(el('div',{className:'proposal-foot'},button('Apply this group',()=>apply([group]))));groups.append(section);
            }
            root.append(groups);
            root.append(el('div',{className:'page-footer'},el('span',{className:'page-footer-note'},'Drag a bookmark onto another group to move it there. Nothing moves until you apply.'),
                button('Back to sources',()=>{proposal=null;ctx.refresh();}),button('Apply selected changes',()=>apply(proposal.filter(g=>g.checked)),'primary')));return;
        }
        const breadcrumb=el('nav',{className:'organize-crumbs','aria-label':'Folder path'},button('All sources',()=>ctx.navigate('organize'),'crumb'));if(current){const entry=all.find(f=>f.node.id===current.id);for(const folder of entry?.trail||[current])breadcrumb.append(el('span',{className:'crumb-sep','aria-hidden':'true',text:'›'}),button(folder.title||'Untitled',()=>ctx.navigate('organize',folder.id),'crumb'+(folder.id===current.id?' current':'')));}root.append(breadcrumb);
        const sources=current?(current.children||[]).filter(n=>n.kind==='folder'&&!n.readOnly&&!n.virtual):visibleRoots(ctx.store.roots(),settings).filter(n=>!n.virtual&&!n.readOnly);
        const grid=el('div',{className:'organize-sources'});
        for(const source of sources){
            const kids=source.children||[],loose=kids.filter(n=>n.kind==='bookmark').length,subs=kids.filter(n=>n.kind==='folder').length;
            // The old page's source card: select on the left, drill in on the right.
            const tile=el('article',{className:'organize-source'+(selected.has(source.id)?' selected':'')});
            const check=el('input',{type:'checkbox',checked:selected.has(source.id)});check.addEventListener('change',()=>{check.checked?selected.add(source.id):selected.delete(source.id);tile.classList.toggle('selected',check.checked);});
            tile.append(el('label',{className:'source-select'},check,el('span',{className:'source-text'},
                    el('span',{className:'source-title',text:(source.role==='workflows'?'💾 ':'📁 ')+(source.title||'Untitled')}),
                    el('span',{className:'source-count',text:loose+' loose bookmark'+(loose===1?'':'s')+(subs?' · '+subs+' folder'+(subs===1?'':'s'):'')}))),
                el('div',{className:'source-actions'},button('✨ Split loose',()=>analyze(['loose-'+source.id])),button('Browse ›',()=>ctx.navigate('organize',source.id))));
            grid.append(tile);
        }
        root.append(grid);
        if(!sources.length)root.append(el('p',{className:'desk-empty'},current?'No folders inside '+(current.title||'this folder')+'.':'No sources yet. Pull your tree or import a folder.'));
        if(current){const loose=(current.children||[]).filter(n=>n.kind==='bookmark');const check=el('input',{type:'checkbox',checked:selected.has('loose-'+current.id)});check.addEventListener('change',()=>check.checked?selected.add('loose-'+current.id):selected.delete('loose-'+current.id));
            const box=el('section',{className:'organize-loose desk-card'},el('label',{className:'proposal-head'},check,el('span',{className:'proposal-name',text:'Loose bookmarks here'}),el('span',{className:'proposal-count',text:String(loose.length)})));
            const rows=el('div',{className:'proposal-items'});for(const n of loose.slice(0,200))rows.append(el('div',{className:'proposal-item static',title:n.url},el('span',{className:'pi-title',text:n.title}),el('span',{className:'pi-url',text:n.url})));
            if(loose.length)box.append(rows);root.append(box);}
        root.append(el('div',{className:'page-footer'},el('span',{className:'page-footer-note'},'Select sources, then sort their loose bookmarks by keyword.'),
            button('Back to Board',()=>ctx.navigate('board')),button('Analyze & Sort selected',()=>analyze([...selected]),'primary')));
    }};return api;
}
