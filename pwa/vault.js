import { el, button, sameAccount } from './desktopCore.js';
const CHUNK=512*1024,MAX=64*1024*1024;
const hex=bytes=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
const encode=bytes=>{let out='';for(let i=0;i<bytes.length;i+=32768)out+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(out);};
const decode=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
const pause=()=>new Promise(resolve=>setTimeout(resolve,25));
export function createVaultMirror(ctx){
    let missingAtStart=false;const startup=ctx.platform.getRaw('tpTree').then(d=>{missingAtStart=!d.tpTree?.roots?.length;}).catch(()=>{});
    let busy=false,checking=false,offer=null,lastReceipt='',message='Connect helper 1.2.0 to keep a safety copy of unpushed work.';
    const available=()=>ctx.helper.supports('vault.put')&&!!globalThis.crypto?.subtle;
    async function mirror(){
        if(busy||!available()||!ctx.account())return;busy=true;
        try{
            const account=ctx.account();if(!await ctx.store.flush())return;
            const raw=(await ctx.platform.getRaw('tpTree')).tpTree;
            if(!raw?.owner||!sameAccount(raw.owner,account)||!raw.copyId)return;
            const drafts=ctx.drafts();
            if(!raw.dirty&&!drafts.length){await ctx.helper.request('vault.clear',{account,copyKey:raw.copyId});message='This copy is clean; no vault mirror is needed.';lastReceipt='';return;}
            const record=Object.fromEntries(['roots','owner','origin','baseVersion','dirty','editCount','copyId','rev','seq','baseId','restoredFrom','meta','lastSyncAt','lastSyncKind'].filter(k=>raw[k]!==undefined).map(k=>[k,raw[k]]));
            record.dirty=true;record.vaultDrafts=drafts;const bytes=new TextEncoder().encode(JSON.stringify(record));if(bytes.length>MAX)throw new Error('This copy exceeds the helper vault limit of 64 MiB. Push or export a backup.');
            const digest=hex(await crypto.subtle.digest('SHA-256',bytes));if(lastReceipt===digest)return;
            for(let offset=0;offset<bytes.length;offset+=CHUNK){if(!sameAccount(account,ctx.account()))return;await ctx.helper.request('vault.put',{account,copyKey:raw.copyId,seq:raw.seq,rev:raw.rev,dirty:true,offset,total:bytes.length,sha256:digest,chunk:encode(bytes.subarray(offset,offset+CHUNK))});await pause();}
            lastReceipt=digest;message='Unpushed work mirrored in the helper at '+new Date().toLocaleTimeString()+'.';
        }catch(e){message=e.message;}finally{busy=false;}
    }
    async function check(){
        if(checking||!available()||!ctx.account())return;checking=true;
        try{
            const account=await ctx.confirmAccount();if(!account||!sameAccount(account,ctx.account())||ctx.helper.hello?.serverId!==account.serverId)return;
            await startup;const entries=await ctx.helper.request('vault.list',{account});if(!sameAccount(account,ctx.account()))return;
            const raw=(await ctx.platform.getRaw('tpTree')).tpTree;
            const localDrafts=ctx.drafts(),draftAt=Math.max(0,...localDrafts.map(d=>Number(d.at||d.parkedAt)||Date.parse(d.at||d.parkedAt)||0));
            offer=entries.filter(e=>e.dirty&&(missingAtStart||!raw?.roots?.length||e.copyKey===raw.copyId&&(e.seq>Number(raw.seq||0)||e.seq===Number(raw.seq||0)&&e.draftCount>0&&(!localDrafts.length||e.draftAt>draftAt)))).sort((a,b)=>b.at-a.at)[0]||null;
            if(offer){message='Restore '+offer.editCount+' unpushed edits kept by the helper.';ctx.toast(message);}
        }catch(e){message=e.message;}finally{checking=false;}
    }
    async function restore(){
        const wanted=offer;if(!wanted)return;const account=await ctx.confirmAccount();if(!sameAccount(account,wanted.account))throw new Error('Sign in as the vault copy owner first.');
        const chunks=[];for(let offset=0;offset<wanted.total;offset+=CHUNK){if(!sameAccount(account,ctx.account()))throw new Error('The account changed. Nothing was restored.');const p=await ctx.helper.request('vault.get',{account,copyKey:wanted.copyKey,sha256:wanted.sha256,offset});chunks.push(decode(p.chunk));await pause();}
        const bytes=new Uint8Array(wanted.total);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}
        if(hex(await crypto.subtle.digest('SHA-256',bytes))!==wanted.sha256)throw new Error('The vault digest did not match. Nothing was restored.');
        const record=JSON.parse(new TextDecoder().decode(bytes));if(!sameAccount(record.owner,account))throw new Error('The vault owner does not match.');
        const saved=await ctx.store.importBackupCopy(record,{account,sourceId:'vault:'+wanted.sha256,drafts:record.vaultDrafts||[]});
        const stash=(await ctx.store.listStashes(account)).find(s=>s.key===saved.key);if(stash)await ctx.restore(stash);offer=null;missingAtStart=false;ctx.refresh();
    }
    const api={mirror,check,render(root){const section=el('section',{},el('h2',{},'Helper vault'),el('p',{},message),button('Mirror now',mirror),button('Check for recovery',async()=>{await check();ctx.refresh();}));if(offer)section.append(button('Restore helper copy',restore,'primary'));section.append(button('Clear this account’s helper copies',async()=>{const account=await ctx.confirmAccount();if(!account)return;if(confirm('Delete this account’s helper safety copies? The local working copy stays.')){await ctx.helper.request('vault.clear',{account});offer=null;message='Helper copies cleared for this account.';ctx.refresh();}}));root.append(section);},
        async beforeSignOut(){
            if(!available())return true;
            if(!await ctx.saveDraft())return false;
            const account=ctx.account();if(!account)return true;
            if(ctx.store.status().dirty){const choice=prompt('Unpushed work must be handled before signing out. Type PUSH to push it, or DISCARD to set it aside on this device and sign out. Cancel keeps you signed in.');
                if(choice==='PUSH'){if(!await ctx.push()||ctx.store.status().dirty)return false;}
                else if(choice==='DISCARD'){const expect=await ctx.store.currentCopy();await ctx.store.setAsideAndReset({...account,expect});}
                else return false;
            }
            await ctx.helper.request('vault.clear',{account});return true;
        },destroy(){clearInterval(timer);document.removeEventListener('visibilitychange',hide);}};
    const timer=setInterval(mirror,30000);const hide=()=>{if(document.visibilityState==='hidden')mirror();};document.addEventListener('visibilitychange',hide);
    ctx.helper.on(event=>{if(event==='hello')check();});return api;
}
