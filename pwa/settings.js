import { el, button, download, walk, sameAccount, folderPaths } from './desktopCore.js';
import { CONTEXT_KEYWORDS } from './lib/tabGrouper.js';
import * as DC from './durableCopy.js';
const clone = value => JSON.parse(JSON.stringify(value));
const scrub = value => Array.isArray(value) ? value.map(scrub) : value && typeof value==='object' ? Object.fromEntries(Object.entries(value).filter(([key])=>!/(token|password|secret|apikey)$/i.test(key)&&!['__proto__','constructor','prototype'].includes(key)).map(([key,v])=>[key,scrub(v)])) : value;
const parse = value => { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; } };
export function createSettings(ctx){
    return { async render(root){
        const account=ctx.account();const settings=await ctx.storage.getSettings();const draft=clone({focusedFolderIds:settings.focusedFolderIds||[],customKeywords:settings.customKeywords||{},categoryOrder:settings.categoryOrder||[]});
        root.append(el('div',{className:'page-head'},
            el('div',{className:'page-title'},el('h1',{},'Settings'),el('p',{className:'page-sub'},'What this device shows and sorts by, and the copies it keeps. Account, sync, storage and importers have their own panel.')),
            el('div',{className:'page-actions'},button('⚙️ Account, sync, storage and importers',()=>ctx.openLegacySettings(),'primary'),button('Test connection',async()=>{
            const res=await fetch(location.origin+'/api/health',{cache:'no-store',credentials:'omit',redirect:'error'});const data=await res.json();
            ctx.toast(res.ok&&data.app==='tabpaladin'?'Server OK · '+data.serverId:'This server did not report a TabPaladin identity.');
        }))));
        // Two columns: this device's settings, and the copies and recovery.
        const main=el('div',{className:'settings-main'}),side=el('div',{className:'settings-side'});
        root.append(el('div',{className:'settings-layout'},main,side));
        const focus=el('section',{className:'settings-card'},el('h2',{},'Sources / focused folders'),el('p',{className:'settings-hint'},'The folders the Board and Organize start from. None ticked: every top-level folder.'));
        const sourceList=el('div',{className:'settings-sources'});
        const folders=folderPaths(ctx.store.roots()).filter(({node:n})=>!['pins','notes'].includes(n.role));
        for(const{node:folder,path}of folders){const check=el('input',{type:'checkbox',checked:draft.focusedFolderIds.includes(folder.id)});check.addEventListener('change',()=>{draft.focusedFolderIds=check.checked?[...new Set([...draft.focusedFolderIds,folder.id])]:draft.focusedFolderIds.filter(id=>id!==folder.id);});sourceList.append(el('label',{className:'settings-source',title:path},check,el('span',{text:path})));}
        if(!folders.length)sourceList.append(el('p',{className:'settings-hint'},'No folders yet.'));
        focus.append(sourceList);main.append(focus);
        const keywords=el('section',{className:'settings-card'},el('h2',{},'Custom keywords'),el('p',{className:'settings-hint'},'Words that sort tabs and bookmarks into categories, on top of the built-in ones. Drag a row, or use ↑ ↓, to set the order categories are tried in.'));
        const rows=el('div',{className:'keyword-rows'});
        const customFor=name=>Object.hasOwn(draft.customKeywords,name)&&Array.isArray(draft.customKeywords[name])?draft.customKeywords[name]:[];
        const builtinsFor=name=>Object.hasOwn(CONTEXT_KEYWORDS,name)?CONTEXT_KEYWORDS[name]:[];
        function drawKeywords(){rows.replaceChildren();const names=[...new Set([...draft.categoryOrder,...Object.keys(CONTEXT_KEYWORDS),...Object.keys(draft.customKeywords)])].filter(name=>typeof name==='string'&&!['__proto__','constructor','prototype'].includes(name));draft.categoryOrder=names;
            names.forEach((name,index)=>{const row=el('div',{className:'keyword-row'}),input=el('input',{value:customFor(name).join(', '),'aria-label':name+' custom keywords'});
                input.addEventListener('input',()=>{draft.customKeywords[name]=[...new Set(input.value.split(',').map(s=>s.trim().toLowerCase()).filter(Boolean))];});
                const builtins=builtinsFor(name);
                const up=button('↑',()=>{if(index){[names[index-1],names[index]]=[names[index],names[index-1]];draft.categoryOrder=names;drawKeywords();}},'icon-btn');up.title='Move up';up.disabled=!index;
                const down=button('↓',()=>{if(index<names.length-1){[names[index+1],names[index]]=[names[index],names[index+1]];draft.categoryOrder=names;drawKeywords();}},'icon-btn');down.title='Move down';down.disabled=index===names.length-1;
                input.placeholder='Your keywords, comma separated';
                row.append(el('span',{className:'drag-handle','aria-hidden':'true',text:'⋮⋮'}),el('strong',{text:name,title:name}),el('small',{text:builtins.length?'Built in: '+builtins.join(', '):'Your category',title:builtins.join(', ')}),input,up,down);
                row.draggable=true;row.addEventListener('dragstart',e=>e.dataTransfer.setData('application/x-tp-category',name));row.addEventListener('dragover',e=>e.preventDefault());row.addEventListener('drop',e=>{e.preventDefault();const moved=e.dataTransfer.getData('application/x-tp-category');if(!names.includes(moved))return;draft.categoryOrder=names.filter(n=>n!==moved);draft.categoryOrder.splice(index,0,moved);drawKeywords();});
                if(!Object.hasOwn(CONTEXT_KEYWORDS,name)){const del=button('🗑',()=>{delete draft.customKeywords[name];draft.categoryOrder=draft.categoryOrder.filter(n=>n!==name);drawKeywords();},'icon-btn danger');del.title='Delete category';row.append(del);}else row.append(el('span'));rows.append(row);
            });
        }drawKeywords();
        const keywordFile=el('input',{type:'file',accept:'.json',hidden:true});
        keywordFile.addEventListener('change',async()=>{try{if(!keywordFile.files[0])return;if(keywordFile.files[0].size>32*1024*1024)throw new Error('The keyword file is too large.');const data=JSON.parse(await keywordFile.files[0].text());const incoming=data.customKeywords||data.keywords||data;
            if(!incoming||typeof incoming!=='object'||Array.isArray(incoming)||Object.values(incoming).some(v=>!Array.isArray(v)||v.some(w=>typeof w!=='string')))throw new Error('Choose a keyword JSON export.');
            for(const [name,words]of Object.entries(incoming)){if(['__proto__','constructor','prototype'].includes(name))continue;draft.customKeywords[name]=[...new Set([...customFor(name),...words].map(w=>w.trim().toLowerCase()).filter(Boolean))];}
            draft.categoryOrder=[...new Set([...draft.categoryOrder,...(Array.isArray(data.categoryOrder)?data.categoryOrder.filter(x=>typeof x==='string'):[])])];drawKeywords();
        }catch(e){ctx.toast(e.message);}finally{keywordFile.value='';}});
        keywords.append(rows,el('div',{className:'settings-row-actions'},button('＋ Add category',()=>{const name=prompt('Category name')?.trim();if(name&&!['__proto__','constructor','prototype'].includes(name)){draft.customKeywords[name]=customFor(name);drawKeywords();}}),button('📤 Export keywords JSON',()=>download('tabpaladin-keywords.json',JSON.stringify({customKeywords:draft.customKeywords,categoryOrder:draft.categoryOrder},null,2))),button('📥 Import keywords JSON',()=>keywordFile.click()),keywordFile));main.append(keywords);
        main.append(el('div',{className:'settings-save'},el('span',{className:'page-footer-note'},'Sources and keywords are kept for this device until you save.'),
            button('Cancel settings changes',()=>ctx.refresh()),button('Save all device settings',async()=>{await ctx.assertAccount(account);await ctx.store.saveCopySettings(draft,{account});ctx.toast('Settings saved.');ctx.refresh();},'primary')));
        const stashes=el('section',{className:'settings-card'},el('h2',{},'Set-aside copies'),el('p',{className:'settings-hint'},'Copies kept on this device for another account or from a restore.'));side.append(stashes);
        const all=await ctx.store.listStashes(account);if(!all.length)stashes.append(el('p',{className:'settings-empty'},'None on this device.'));for(const stash of all){
            const raw=(await ctx.platform.getRaw(stash.key))[stash.key];
            const label=(raw?.meta?.movedFromExtension?'From the browser extension: ':'')+(stash.username||'Kept copy')+' @ '+(stash.url||'local')+' · '+stash.items+' items'+(stash.dirty?' · '+stash.editCount+' unpushed edit'+(stash.editCount===1?'':'s'):'');
            const row=el('article',{className:'settings-stash'},el('strong',{},label));
            row.append(button('Export recovery JSON',async()=>{const data=(await ctx.platform.getRaw(stash.key))[stash.key];download('kept-copy.json',JSON.stringify(data,null,2));}));
            row.append(button('Export bookmarks.html',async()=>download('kept-copy.html',await ctx.store.exportStashHtml(stash.key),'text/html')));
            if(raw?.recoveryDrafts?.length)row.append(button('Export recovered drafts',()=>download('recovered-drafts.md',raw.recoveryDrafts.map(d=>'# '+(d.title||'Draft')+'\n\n'+(d.content||d.nv?.draft||'')).join('\n\n---\n\n'),'text/markdown')));
            if(stash.url===location.origin&&['same','moved'].includes(stash.match)){
                row.append(button('Restore',()=>ctx.restoreSetAside(stash)),button('Discard…',async()=>{if(raw?.recoveryDrafts?.length&&!confirm('Export the recovered drafts first? Cancel keeps this copy.'))return;if(raw?.recoveryDrafts?.length)download('recovered-drafts.md',raw.recoveryDrafts.map(d=>d.content||'').join('\n\n---\n\n'),'text/markdown');await ctx.discardSetAside(stash,all);ctx.refresh();}));
            }else row.append(el('small',{},'Sign in to the matching account on its original server to restore. Export only here.'));stashes.append(row);
        }
        stashes.append(el('div',{className:'settings-row-actions'},button('Export parked note drafts',()=>ctx.exportDrafts())));
        const backupFile=el('input',{type:'file',accept:'.json',hidden:true});backupFile.addEventListener('change',async()=>{try{const file=backupFile.files[0];if(!file)return;if(file.size>128*1024*1024)throw new Error('The backup is too large.');const text=await file.text();const backup=JSON.parse(text);
            if(backup.format!=='tabpaladin-extension-backup'||backup.version!==1||!backup.storage)throw new Error('Choose a TabPaladin extension backup (version 1).');
            const data=scrub(backup.storage),local=scrub(backup.localStorage||{}),copies=Object.entries(data).filter(([key,value])=>(key==='tpTree'||key.startsWith('tpTreeStash:'))&&value&&Array.isArray(value.roots));
            const legacy=Array.isArray(data.workflows)?data.workflows:[];
            if(legacy.length){const backend=data.settings?.backend||{},owner=data.tpTree?.owner||(backend.url&&Number(backend.userId)>0?{url:backend.url,userId:Number(backend.userId),username:backend.username||null,serverId:backend.serverId||null}:null);const role={id:DC.newId(),kind:'folder',role:'workflows',title:'TabPaladin Workflows',children:[]};
                for(const wf of legacy){if(!wf||!Array.isArray(wf.tabs))throw new Error('Invalid legacy workflows. Keep the original backup.');role.children.push({id:DC.newId(),kind:'folder',title:wf.name||'Recovered workflow',payload:{createdAt:wf.createdAt||backup.exportedAt},children:wf.tabs.map(t=>({id:DC.newId(),kind:'bookmark',title:t.title||t.url,url:t.url}))});}
                copies.push(['legacy-workflows',{roots:[role],owner,origin:owner?null:'pre-accounts',url:backend.url,dirty:true,editCount:legacy.length,baseVersion:0}]);}
            if(!copies.length)throw new Error('This backup contains no working-copy trees. Keep the original file for recovery.');
            if(!confirm('Keep '+copies.length+' backed-up copies separately for review? This does not replace the current copy or sign you in.'))return;
            const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),x=>x.toString(16).padStart(2,'0')).join('');
            const parked=parse(local.tp_notes_parked_v1)||[],live=Object.values(data.tpLiveDraft||{}),mirror=data.tpParkedMirror?.drafts||[];
            for(const[key,copy]of copies){await ctx.assertAccount(account);const drafts=[...parked,...mirror,...live.map(d=>({...d,parkedAt:d.at||backup.exportedAt}))].filter(d=>d&&typeof d.content==='string'&&(copy.owner?DC.sameOwner(d.owner,copy.owner):!d.owner));
                await ctx.store.importBackupCopy(copy,{account,sourceId:digest+':'+key,focusedFolderIds:copy.focusedFolderIds||data.settings?.focusedFolderIds||[],expanded:copy.expanded||data.tpUiExpanded?.cards||{},pendingRemovals:copy.pendingRemovals||(key==='tpTree'?data.tpPendingRemovals:[])||[],drafts});
            }ctx.toast('Backup copies kept separately. Review their owners before restoring.');ctx.refresh();
        }catch(e){ctx.toast(e.message);}finally{backupFile.value='';}});
        // The helper vault and the move from the extension draw their own
        // sections; in the side column each is a card (settings.css).
        ctx.renderVault?.(side);
        await ctx.renderMove?.(side);
        side.append(el('section',{className:'settings-card'},el('h2',{},'Recovery'),el('p',{className:'settings-hint'},'Bring in an extension backup as separate copies. Credentials are ignored. Your current copy is kept.'),button('Bring in an extension backup',()=>backupFile.click()),backupFile));
    }};
}
