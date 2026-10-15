// P3 safety copies. Only this pinned origin and the explicitly stamped
// account can address an entry. Complete copies survive interrupted uploads.
(() => {
    const H=globalThis.TPHelper,api=H.api,INDEX='tpHelperVaultIndex',UPLOADS='tpHelperVaultUploads',MAX=64*1024*1024,CHUNK=512*1024;
    const hex=bytes=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
    const scope=(account,config)=>JSON.stringify([H.pinScope(config),account.userId]);
    const idFor=async(account,copyKey,config)=>hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(scope(account,config)+'|'+copyKey)));
    const decode=text=>{if(typeof text!=='string'||text.length>700000||!/^[A-Za-z0-9+/]*={0,2}$/.test(text))H.fail('bad-args','Invalid vault chunk.');try{return Uint8Array.from(atob(text),c=>c.charCodeAt(0));}catch{H.fail('bad-args','Invalid vault encoding.');}};
    const own=(entry,account,ctx)=>entry.scope===scope(account,ctx.config);
    async function cleanup(){
        const uploads=(await api.storage.local.get(UPLOADS))[UPLOADS]||{};let changed=false;
        for(const[id,u]of Object.entries(uploads))if(Date.now()-u.at>10*60*1000){await api.storage.local.remove((u.offsets||[]).map(offset=>'tpVaultPart:'+id+':'+offset));delete uploads[id];changed=true;}
        if(changed)await api.storage.local.set({[UPLOADS]:uploads});return uploads;
    }
    H.handlers['vault.put']=(body,ctx)=>H.serialized(async()=>{
        await H.assertContext(ctx);const account=H.account(body.account,ctx.config);
        if(typeof body.copyKey!=='string'||!body.copyKey||body.copyKey.length>200||!Number.isSafeInteger(body.seq)||body.seq<0||typeof body.rev!=='string'||body.rev.length>200||body.dirty!==true||!Number.isSafeInteger(body.offset)||body.offset<0||!Number.isSafeInteger(body.total)||body.total<1||body.total>MAX||!/^[a-f0-9]{64}$/.test(body.sha256||''))H.fail('bad-args','Invalid vault metadata.');
        const bytes=decode(body.chunk);if(!bytes.length||bytes.length>CHUNK||body.offset%CHUNK!==0||body.offset+bytes.length>body.total||body.offset+bytes.length<body.total&&bytes.length!==CHUNK)H.fail('bad-args','Invalid vault part offset.');
        const id=await idFor(account,body.copyKey,ctx.config),key='tpVault:'+id;
        const index=(await api.storage.local.get(INDEX))[INDEX]||{};
        const existing=index[id];if(existing&&existing.seq>body.seq)return{keptNewer:true,complete:true};
        if(existing&&existing.seq===body.seq&&existing.sha256===body.sha256)return{complete:true,sha256:existing.sha256};
        const siblings=Object.values(index).filter(e=>e.origin===ctx.config.serverOrigin&&e.pinScope===H.pinScope(ctx.config));
        if(!existing&&siblings.length>=3)H.fail('too-many','The helper already keeps three copies for this server. Push or clear one before adding another.');
        const uploads=await cleanup();const uploadId=id+':'+body.sha256;
        if(!uploads[uploadId]){
            if(Object.keys(uploads).length>=3)H.fail('too-many','Finish the pending vault uploads first.');
            uploads[uploadId]={scope:scope(account,ctx.config),origin:ctx.config.serverOrigin,pinScope:H.pinScope(ctx.config),account,copyKey:body.copyKey,seq:body.seq,rev:body.rev,total:body.total,sha256:body.sha256,at:Date.now(),offsets:[]};
        }
        const u=uploads[uploadId];if(u.total!==body.total||u.seq!==body.seq||u.rev!==body.rev||!own(u,account,ctx))H.fail('bad-args','Vault upload metadata changed.');
        await api.storage.local.set({['tpVaultPart:'+uploadId+':'+body.offset]:body.chunk});if(!u.offsets.includes(body.offset))u.offsets.push(body.offset);u.at=Date.now();await api.storage.local.set({[UPLOADS]:uploads});
        const offsets=[];for(let offset=0;offset<body.total;offset+=CHUNK)offsets.push(offset);
        if(!offsets.every(offset=>u.offsets.includes(offset)))return{complete:false};
        const partKeys=offsets.map(offset=>'tpVaultPart:'+uploadId+':'+offset),parts=await api.storage.local.get(partKeys),all=new Uint8Array(body.total),chunks=[];
        for(let n=0;n<offsets.length;n++){const chunk=parts[partKeys[n]],part=decode(chunk);all.set(part,offsets[n]);chunks.push(chunk);}
        if(hex(await crypto.subtle.digest('SHA-256',all))!==body.sha256)H.fail('bad-args','The vault digest did not match. The prior copy was kept.');
        let record;try{record=JSON.parse(new TextDecoder().decode(all));}catch{H.fail('bad-args','Invalid vault JSON.');}
        if(!Array.isArray(record.roots)||!record.owner||!H.sameAccount(H.account(record.owner,ctx.config),account)||record.copyId!==body.copyKey||record.seq!==body.seq||record.rev!==body.rev||record.dirty!==true)H.fail('bad-args','The vault copy is not stamped for this account.');
        await H.assertContext(ctx);
        const meta={...u,offsets:undefined,at:Date.now(),editCount:Number(record.editCount)||1,dirty:true};index[id]=meta;
        await api.storage.local.set({[key]:{...meta,chunks},[INDEX]:index});
        await api.storage.local.remove(partKeys);delete uploads[uploadId];await api.storage.local.set({[UPLOADS]:uploads});return{complete:true,sha256:body.sha256};
    });
    H.handlers['vault.list']=(body,ctx)=>H.serialized(async()=>{await H.assertContext(ctx);const account=H.account(body.account,ctx.config);const index=(await api.storage.local.get(INDEX))[INDEX]||{};return Object.values(index).filter(e=>own(e,account,ctx)).map(({chunks,scope,pinScope,offsets,...e})=>e);});
    H.handlers['vault.get']=(body,ctx)=>H.serialized(async()=>{await H.assertContext(ctx);const account=H.account(body.account,ctx.config);if(typeof body.copyKey!=='string'||!Number.isSafeInteger(body.offset)||body.offset<0||body.offset%CHUNK!==0)H.fail('bad-args','Invalid vault read.');const id=await idFor(account,body.copyKey,ctx.config),entry=(await api.storage.local.get('tpVault:'+id))['tpVault:'+id];if(!entry||!own(entry,account,ctx))H.fail('bad-args','That account has no matching vault copy.');if(body.sha256!==entry.sha256)H.fail('bad-args','The vault copy changed. Refresh the recovery offer.');const chunk=entry.chunks[body.offset/CHUNK];if(typeof chunk!=='string')H.fail('bad-args','Vault offset is out of range.');return{chunk,total:entry.total,sha256:entry.sha256,offset:body.offset};});
    H.handlers['vault.clear']=(body,ctx)=>H.serialized(async()=>{await H.assertContext(ctx);const account=H.account(body.account,ctx.config),index=(await api.storage.local.get(INDEX))[INDEX]||{};for(const[id,entry]of Object.entries(index))if(own(entry,account,ctx)&&(!body.copyKey||body.copyKey===entry.copyKey)){await api.storage.local.remove('tpVault:'+id);delete index[id];}await api.storage.local.set({[INDEX]:index});const uploads=(await api.storage.local.get(UPLOADS))[UPLOADS]||{};for(const[id,u]of Object.entries(uploads))if(own(u,account,ctx)&&(!body.copyKey||body.copyKey===u.copyKey)){await api.storage.local.remove((u.offsets||[]).map(offset=>'tpVaultPart:'+id+':'+offset));delete uploads[id];}await api.storage.local.set({[UPLOADS]:uploads});return{cleared:true};});
    H.ops.push('vault.put','vault.list','vault.get','vault.clear');
})();
