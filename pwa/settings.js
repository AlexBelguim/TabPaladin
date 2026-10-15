import { el, button, download, walk, sameAccount } from './desktopCore.js';
import { CONTEXT_KEYWORDS } from './lib/tabGrouper.js';
import * as DC from './durableCopy.js';
const clone = value => JSON.parse(JSON.stringify(value));
const scrub = value => Array.isArray(value) ? value.map(scrub) : value && typeof value==='object' ? Object.fromEntries(Object.entries(value).filter(([key])=>!/(token|password|secret|apikey)$/i.test(key)&&!['__proto__','constructor','prototype'].includes(key)).map(([key,v])=>[key,scrub(v)])) : value;
const parse = value => { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; } };
export function createSettings(ctx){
    return { async render(root){
        const account=ctx.account();const settings=await ctx.storage.getSettings();const draft=clone({focusedFolderIds:settings.focusedFolderIds||[],customKeywords:settings.customKeywords||{},categoryOrder:settings.categoryOrder||[]});
        root.append(el('h1',{},'Settings'),button('Account, sync, storage and importers',()=>ctx.openLegacySettings()),button('Test connection',async()=>{
            const res=await fetch(location.origin+'/api/health',{cache:'no-store',credentials:'omit',redirect:'error'});const data=await res.json();
            ctx.toast(res.ok&&data.app==='tabpaladin'?'Server OK · '+data.serverId:'This server did not report a TabPaladin identity.');
        }));
        const focus=el('section',{},el('h2',{},'Sources / focused folders'));
        const folders=walk(ctx.store.roots()).filter(n=>n.kind==='folder'&&!n.virtual&&!n.readOnly&&!['pins','notes'].includes(n.role));
        for(const folder of folders){const check=el('input',{type:'checkbox',checked:draft.focusedFolderIds.includes(folder.id)});check.addEventListener('change',()=>{draft.focusedFolderIds=check.checked?[...new Set([...draft.focusedFolderIds,folder.id])]:draft.focusedFolderIds.filter(id=>id!==folder.id);});focus.append(el('label',{className:'settings-source'},check,' '+folder.title));}root.append(focus);
        const keywords=el('section',{},el('h2',{},'Custom keywords'));
        const rows=el('div');
        function drawKeywords(){rows.replaceChildren();const names=[...new Set([...draft.categoryOrder,...Object.keys(CONTEXT_KEYWORDS),...Object.keys(draft.customKeywords)])];draft.categoryOrder=names;
            names.forEach((name,index)=>{const row=el('div',{className:'keyword-row'}),input=el('input',{value:(draft.customKeywords[name]||[]).join(', '),'aria-label':name+' custom keywords'});
                input.addEventListener('input',()=>{draft.customKeywords[name]=[...new Set(input.value.split(',').map(s=>s.trim().toLowerCase()).filter(Boolean))];});
                row.append(el('strong',{},name),el('small',{},'Built in: '+(CONTEXT_KEYWORDS[name]||[]).join(', ')),input,button('↑',()=>{if(index){[names[index-1],names[index]]=[names[index],names[index-1]];draft.categoryOrder=names;drawKeywords();}}),button('↓',()=>{if(index<names.length-1){[names[index+1],names[index]]=[names[index],names[index+1]];draft.categoryOrder=names;drawKeywords();}}));
                row.draggable=true;row.addEventListener('dragstart',e=>e.dataTransfer.setData('application/x-tp-category',name));row.addEventListener('dragover',e=>e.preventDefault());row.addEventListener('drop',e=>{e.preventDefault();const moved=e.dataTransfer.getData('application/x-tp-category');if(!names.includes(moved))return;draft.categoryOrder=names.filter(n=>n!==moved);draft.categoryOrder.splice(index,0,moved);drawKeywords();});
                if(!CONTEXT_KEYWORDS[name])row.append(button('Delete category',()=>{delete draft.customKeywords[name];draft.categoryOrder=draft.categoryOrder.filter(n=>n!==name);drawKeywords();}));rows.append(row);
            });
        }drawKeywords();
        const keywordFile=el('input',{type:'file',accept:'.json',hidden:true});
        keywordFile.addEventListener('change',async()=>{try{if(!keywordFile.files[0])return;const data=JSON.parse(await keywordFile.files[0].text());const incoming=data.customKeywords||data.keywords||data;
            if(!incoming||typeof incoming!=='object'||Array.isArray(incoming)||Object.values(incoming).some(v=>!Array.isArray(v)||v.some(w=>typeof w!=='string')))throw new Error('Choose a keyword JSON export.');
            for(const [name,words]of Object.entries(incoming)){if(['__proto__','constructor','prototype'].includes(name))continue;draft.customKeywords[name]=[...new Set([...(draft.customKeywords[name]||[]),...words].map(w=>w.trim().toLowerCase()).filter(Boolean))];}
            draft.categoryOrder=[...new Set([...draft.categoryOrder,...(Array.isArray(data.categoryOrder)?data.categoryOrder.filter(x=>typeof x==='string'):[])])];drawKeywords();
        }catch(e){ctx.toast(e.message);}finally{keywordFile.value='';}});
        keywords.append(rows,button('Add category',()=>{const name=prompt('Category name')?.trim();if(name&&!['__proto__','constructor','prototype'].includes(name)){draft.customKeywords[name]=draft.customKeywords[name]||[];drawKeywords();}}),button('Export keywords JSON',()=>download('tabpaladin-keywords.json',JSON.stringify({customKeywords:draft.customKeywords,categoryOrder:draft.categoryOrder},null,2))),button('Import keywords JSON',()=>keywordFile.click()),keywordFile);root.append(keywords);
        root.append(button('Save all device settings',async()=>{await ctx.assertAccount(account);const fresh=await ctx.storage.getSettings();await ctx.storage.saveSettings({...fresh,...draft});ctx.toast('Settings saved.');ctx.refresh();},'primary'),button('Cancel settings changes',()=>ctx.refresh()));
        root.append(el('h2',{},'Set-aside copies'));
        const all=await ctx.store.listStashes(account);for(const stash of all){
            const label=(stash.username||'Kept copy')+' @ '+(stash.url||'local')+' · '+stash.items+' items'+(stash.dirty?' · '+stash.editCount+' unpushed':'');
            const row=el('article',{className:'settings-stash'},el('strong',{},label));
            row.append(button('Export bookmarks.html',async()=>download('kept-copy.html',await ctx.store.exportStashHtml(stash.key),'text/html')));
            const raw=(await ctx.platform.getRaw(stash.key))[stash.key];
            if(raw?.recoveryDrafts?.length)row.append(button('Export recovered drafts',()=>download('recovered-drafts.md',raw.recoveryDrafts.map(d=>'# '+(d.title||'Draft')+'\n\n'+(d.content||d.nv?.draft||'')).join('\n\n---\n\n'),'text/markdown')));
            if(stash.url===location.origin&&['same','moved'].includes(stash.match)){
                row.append(button('Restore',()=>ctx.restoreSetAside(stash)),button('Discard…',async()=>{if(raw?.recoveryDrafts?.length&&!confirm('Export the recovered drafts first? Cancel keeps this copy.'))return;if(raw?.recoveryDrafts?.length)download('recovered-drafts.md',raw.recoveryDrafts.map(d=>d.content||'').join('\n\n---\n\n'),'text/markdown');await ctx.discardSetAside(stash,all);ctx.refresh();}));
            }else row.append(el('small',{},'Sign in to the matching account on its original server to restore. Export only here.'));root.append(row);
        }
        root.append(button('Export parked note drafts',()=>ctx.exportDrafts()));
        const backupFile=el('input',{type:'file',accept:'.json',hidden:true});backupFile.addEventListener('change',async()=>{try{const file=backupFile.files[0];if(!file)return;if(file.size>128*1024*1024)throw new Error('The backup is too large.');const text=await file.text();const backup=JSON.parse(text);
            if(backup.format!=='tabpaladin-extension-backup'||backup.version!==1||!backup.storage)throw new Error('Choose a TabPaladin extension backup (version 1).');
            const data=scrub(backup.storage),local=scrub(backup.localStorage||{}),copies=Object.entries(data).filter(([key,value])=>(key==='tpTree'||key.startsWith('tpTreeStash:'))&&value&&Array.isArray(value.roots));
            if(!copies.length)throw new Error('This backup contains no working-copy trees. Keep the original file for recovery.');
            if(!confirm('Keep '+copies.length+' backed-up copies separately for review? This does not replace the current copy or sign you in.'))return;
            const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),x=>x.toString(16).padStart(2,'0')).join('');
            const parked=parse(local.tp_notes_parked_v1)||[],live=Object.values(data.tpLiveDraft||{}),mirror=data.tpParkedMirror?.drafts||[];
            for(const[key,copy]of copies){await ctx.assertAccount(account);const drafts=[...parked,...mirror,...live.map(d=>({...d,parkedAt:d.at||backup.exportedAt}))].filter(d=>d&&typeof d.content==='string'&&(copy.owner?DC.sameOwner(d.owner,copy.owner):!d.owner));
                await ctx.store.importBackupCopy(copy,{account,sourceId:digest+':'+key,focusedFolderIds:copy.focusedFolderIds||data.settings?.focusedFolderIds||[],expanded:copy.expanded||data.tpUiExpanded?.cards||{},pendingRemovals:copy.pendingRemovals||(key==='tpTree'?data.tpPendingRemovals:[])||[],drafts});
            }ctx.toast('Backup copies kept separately. Review their owners before restoring.');ctx.refresh();
        }catch(e){ctx.toast(e.message);}finally{backupFile.value='';}});
        ctx.renderVault?.(root);
        root.append(el('h2',{},'Recovery'),el('p',{},'Bring in an extension backup as separate copies. Credentials are ignored. Your current copy is kept.'),button('Bring in an extension backup',()=>backupFile.click()),backupFile);
    }};
}
