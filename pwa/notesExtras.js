import { el, button, sameAccount } from './desktopCore.js';
import { leadingTitle } from './lib/notesModel.js';
export function createNoteExtras(ctx){
    let preview=null,nvRef=null,lastRead=null;
    function draw(){if(!preview||!nvRef)return;preview.replaceChildren(...ctx.renderPreview(nvRef.draft||'',nvRef.titleField||''));}
    return {
        decorate(pane,{nv,note}){
            if(!ctx.desktop())return;
            const page=pane.querySelector('.note-page');if(!page)return;
            const bar=el('div',{className:'note-mode-bar'});
            let mode=ctx.getMode()||'read';if(!nv.editing)mode='read';else if(mode==='read'&&(!nvRef||nvRef!==nv)){mode='edit';ctx.setMode(mode);}
            if(note&&!nv.editing)lastRead={id:note.id,title:note.title,content:note.content,account:ctx.account()};
            const set=next=>{ctx.setMode(next);if(next!=='read'&&!nv.editing)ctx.startEdit();else ctx.refresh();};
            // Read | Edit | Split as one segmented control, the old notes page's.
            const seg=el('div',{className:'note-seg',role:'group','aria-label':'View'});
            for(const label of ['Read','Edit','Split']){const key=label.toLowerCase();const b=button(label,()=>set(key),mode===key?'primary':'ghost');b.setAttribute('aria-pressed',String(mode===key));if(key==='split'&&!matchMedia('(min-width:1500px)').matches){b.disabled=true;b.title='Split needs a window 1500px wide';}seg.append(b);}
            const push=button('⬆ Push',()=>ctx.push(),'ghost note-push');push.title='Push to the server';
            bar.append(seg,push);page.querySelector('.note-topbar')?.after(bar);page.dataset.noteMode=mode;
            if(nv.removedElsewhere)bar.after(el('p',{className:'note-removed-banner'},'This note was removed elsewhere. Save keeps your text as a new note.'));
            if(nv.editing){
                const textarea=page.querySelector('#note-body-input');const title=el('input',{id:'note-title-input',value:nv.titleField ?? note?.title ?? (leadingTitle(nv.draft) || ''),placeholder:'Note title','aria-label':'Note title'});
                const editor=el('div',{className:'note-editor-fields'},title);textarea.before(editor);editor.append(textarea);
                preview=el('div',{className:'note-live-preview note-preview-body'});nvRef=nv;editor.after(preview);draw();
                const save=page.querySelector('.note-done');if(save)save.textContent='Save locally';
            }else{preview=null;nvRef=null;}
        },
        recover(nv){return !nv.editing&&lastRead?.id===nv.noteId&&sameAccount(lastRead.account,ctx.account())?{editing:true,draft:lastRead.content,loaded:lastRead.content,titleField:lastRead.title,loadedTitle:lastRead.title}:null;},
        input(event,nv){if(!ctx.desktop())return false;if(event.target.id==='note-title-input'){nv.titleField=event.target.value;draw();return true;}if(event.target.id==='note-body-input'){nv.draft=event.target.value;draw();return false;}return false;},
        keydown(event,nv){if(ctx.desktop()&&event.key==='Enter'&&!nv.editing&&!event.ctrlKey&&!event.metaKey&&!event.target?.closest?.('input,textarea,select,button,a')){event.preventDefault();ctx.startEdit();return true;}return false;}
    };
}
