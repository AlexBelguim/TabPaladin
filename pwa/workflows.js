import { el, button, download, walk } from './desktopCore.js';
import { createFolderCards } from './board.js';
import { ExpandState } from './lib/expandState.js';
import { relativeTime } from './lib/notesModel.js';
const saved = iso => { const r = relativeTime(iso); return !r ? '' : r === 'now' ? 'Saved just now' : /^\d+[mh]$/.test(r) ? 'Saved ' + r + ' ago' : 'Saved ' + r; };
export function createWorkflows(ctx){
    const exportsFor=()=>{const role=walk(ctx.store.roots()).find(n=>n.kind==='folder'&&n.role==='workflows');return(role?.children||[]).filter(n=>n.kind==='folder').map(n=>({id:n.id,name:n.title,createdAt:n.payload?.createdAt||new Date().toISOString(),tabs:walk(n.children).filter(c=>c.kind==='bookmark').map(c=>({id:c.id,title:c.title,url:c.url,favIconUrl:null}))}));};
    const cards=createFolderCards({...ctx,split:id=>ctx.split(id)});
    return {async render(root){
        await ExpandState.load();
        const bar=el('div',{className:'page-actions'});
        root.append(el('div',{className:'page-head'},
            el('div',{className:'page-title'},el('h1',{},'Workflows'),el('p',{className:'page-sub'},'Saved browser windows. Open one to bring its tabs back; a tracked window keeps its workflow up to date.')),
            bar));
        const file=el('input',{type:'file',accept:'.json,application/json',hidden:true});
        file.addEventListener('change',async()=>{
            try{
                const picked=file.files[0];if(!picked)return;if(picked.size>32*1024*1024)throw new Error('This workflow file is too large.');
                const data=JSON.parse(await picked.text());
                if(!Array.isArray(data)||data.length>10000||data.some(w=>!w||!Array.isArray(w.tabs)||w.tabs.some(t=>!t||typeof t.url!=='string'||typeof t.title!=='string'&&t.title!=null)))throw new Error('Choose a workflow JSON export. Nothing was imported.');
                if(!confirm('Import '+data.length+' workflows as new folders?'))return;
                await ctx.edit(async()=>{for(const wf of data)await ctx.storage.saveWorkflow(wf.name||'Imported Workflow',wf.tabs);});
                ctx.toast('Workflows imported locally.');
            }catch(e){ctx.toast(e.message);}finally{file.value='';}
        });
        bar.append(button('💾 Create Workflow',()=>ctx.capture(),'primary'),button('📥 Import JSON',()=>file.click()),button('📤 Export all JSON',async()=>download('tabpaladin-workflows.json',JSON.stringify(exportsFor(),null,2))),file);
        const role=await ctx.store.findRoleRoot('workflows');const workflows=(role?.children||[]).filter(n=>n.kind==='folder');
        const columns=el('div',{className:'workflow-grid'});const budget=cards.budget();
        for(const wf of workflows){
            // The card's header is the workflow's; under it, its own bar.
            const wrap=el('article',{className:'workflow-panel'}),tools=el('div',{className:'workflow-actions'});
            const tabs=walk(wf.children).filter(c=>c.kind==='bookmark').length;
            tools.append(button('▶ Open',()=>ctx.openWorkflow(wf),'primary'),button('⏹ Stop tracking',async()=>{const account=ctx.account();await ctx.assertAccount(account);if(ctx.helper.supports('track.untrack'))await ctx.helper.request('track.untrack',{workflowId:wf.id,account});}),button('✨ Split',()=>ctx.split(wf.id)),button('📤 JSON',async()=>{const item=exportsFor().find(w=>w.id===wf.id);download('workflow.json',JSON.stringify([item],null,2));}));
            tools.firstChild.title='Open in a tracked browser window';tools.lastChild.title='Export this workflow as JSON';
            const lead=el('div',{className:'workflow-bar'},el('span',{className:'workflow-meta',text:[tabs+' tab'+(tabs===1?'':'s'),saved(wf.payload?.createdAt)].filter(Boolean).join(' · ')}),tools);
            wrap.append(cards.card(wf,{budget,lead}));columns.append(wrap);
        }
        root.append(columns);if(!workflows.length)root.append(el('p',{className:'desk-empty'},'No workflows yet. Create one from a browser window or import a JSON file.'));
    },destroy(){cards.destroy();}};
}
