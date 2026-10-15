import { el, button, sameAccount } from './desktopCore.js';
export function createDesktopShell(ctx) {
    let route='home',id=null,generation=0;
    const views=new Map();
    const nav=el('nav',{className:'desktop-nav','aria-label':'Workspace'});
    document.body.append(nav);
    function drawNav(){nav.replaceChildren();for(const [key,label] of [['home','Home'],['board','Board'],['workflows','Workflows'],['organize','Organize'],['notes','Notes'],['inbox','Inbox'],['settings','Settings']]){
        const b=button(label,()=>ctx.navigate(key),'desktop-nav-item'+(route===key?' active':''));b.disabled=!views.has(key)&&!['notes','inbox','settings'].includes(key);nav.append(b);
    }}
    const shell={
        register(name,view){views.set(name,view);drawNav();},
        setRoute(name,nodeId=null){route=name;id=nodeId;drawNav();},
        get route(){return route;},
        invalidate(){generation++;},
        render(root){
            const view=views.get(route);if(!view)return false;
            const account=ctx.account();const current=++generation;const stage=el('div',{className:'desktop-page'});
            root.append(el('p',{className:'desktop-loading'},'Loading workspace…'));
            Promise.resolve(view.render(stage,id)).then(()=>{
                if(current!==generation||!sameAccount(account,ctx.account()))return;
                root.replaceChildren(stage);
            }).catch(e=>{if(current===generation)root.replaceChildren(el('p',{},e.message));});
            return true;
        },
        destroy(){for(const v of views.values())v.destroy?.();nav.remove();generation++;}
    };
    document.addEventListener('desktop-error',e=>ctx.toast(e.detail));drawNav();return shell;
}
