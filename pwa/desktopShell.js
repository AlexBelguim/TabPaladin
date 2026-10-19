import { el, button, sameAccount } from './desktopCore.js';

// The desktop's left sidebar (900px and wider). On a computer the page header
// (#topbar) is laid out as the sidebar by desktop.css: the brand, then this
// nav, then the sync block, the helper status and the ⋯ menu's actions, then
// the account. The phone keeps the header as its top bar and never shows the
// nav or the account block.
const ROUTES = [
    ['home', 'Home', '🏠'], ['board', 'Board', '🗂️'], ['workflows', 'Workflows', '🪟'], ['organize', 'Organize', '✨'],
    ['notes', 'Notes', '📝'], ['inbox', 'Inbox', '📥'], ['settings', 'Settings', '⚙️']
];
const count = n => (n > 99 ? '99+' : String(n));

export function createDesktopShell(ctx) {
    let route='home',id=null,generation=0,lastAccount=null,drawnWho=null;const scroll=new Map();
    const views=new Map();
    const nav=el('nav',{className:'desktop-nav','aria-label':'Workspace'});
    const account=el('div',{className:'desktop-account'});
    const bar=document.getElementById('topbar');
    const brand=document.getElementById('brand-home');
    if(bar&&brand){brand.after(nav);bar.append(account);}else document.body.append(nav);
    // The Inbox is drawn over the content: going anywhere else closes it.
    const go=key=>{if(key!=='inbox')ctx.closeInbox?.();ctx.navigate(key);};
    brand?.addEventListener('click',()=>ctx.closeInbox?.());
    const items=new Map();
    for(const [key,label,icon] of ROUTES){
        const b=button('',()=>go(key),'desktop-nav-item');
        const badge=el('span',{className:'dn-badge'+(key==='home'?' dn-badge-sync':'')});
        b.dataset.route=key;
        b.append(el('span',{className:'dn-icon','aria-hidden':'true',text:icon}),el('span',{className:'dn-label',text:label}),badge);
        items.set(key,{b,badge});nav.append(b);
    }
    function drawNav(){
        let badges={},inboxOpen=false;
        try{badges=ctx.badges?.()||{};inboxOpen=Boolean(ctx.inboxOpen?.());}catch{/* drawn again with the next change */}
        for(const [key,{b,badge}] of items){
            const active=inboxOpen?key==='inbox':route===key;
            b.classList.toggle('active',active);
            if(active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');
            const n=Number(badges[key])||0;
            badge.textContent=n?count(n):'';badge.hidden=!n;
            badge.title=n?(key==='home'?n+' unpushed edit'+(n===1?'':'s'):key==='notes'?n+' waiting for approval':n+' waiting to be filed'):'';
            b.disabled=!views.has(key)&&!['notes','inbox','settings'].includes(key);
        }
    }
    function drawAccount(){
        let who={};
        try{who=ctx.who?.()||{};}catch{/* drawn again with the next change */}
        const key=JSON.stringify(who);if(key===drawnWho)return;drawnWho=key;
        const name=String(who.username||'');
        account.replaceChildren(el('div',{className:'da-who'},
            el('span',{className:'da-avatar','aria-hidden':'true',text:(name.trim()[0]||'?').toUpperCase()}),
            el('span',{className:'da-text'},
                el('span',{className:'da-name',text:who.signedIn?name||'Signed in':'Not signed in',title:name}),
                el('span',{className:'da-sub',text:who.signedIn?(who.role?'Signed in · '+who.role:'Signed in'):'Sign in to sync'}))));
        const actions=el('div',{className:'da-actions'});
        if(who.signedIn){
            actions.append(button('Account & sync',()=>ctx.openLegacySettings(),'ghost da-settings'));
            if(ctx.signOut)actions.append(button('Sign out',()=>ctx.signOut(),'ghost da-signout'));
        }else actions.append(button('Sign in',()=>ctx.openLegacySettings(),'primary da-signin'));
        account.append(actions);
    }
    const shell={
        register(name,view){views.set(name,view);drawNav();},
        setRoute(name,nodeId=null){route=name;id=nodeId;drawNav();},
        get route(){return route;},
        // The badges, the Inbox's highlight or who is signed in changed.
        refreshChrome(){drawNav();drawAccount();},
        captureScroll(root){if(!root||!lastAccount)return;const key=JSON.stringify(lastAccount);scroll.set(key,new Map([...root.querySelectorAll('[data-folder-id]')].map(card=>[card.dataset.folderId,card.querySelector('.board-body')?.scrollTop||0])));},
        invalidate(){generation++;},
        render(root){
            const view=views.get(route);if(!view)return false;
            const account=ctx.account();const current=++generation;const stage=el('div',{className:'desktop-page page-'+route});
            root.append(el('p',{className:'desktop-loading'},'Loading workspace…'));
            Promise.resolve(view.render(stage,id)).then(()=>{
                if(current!==generation||!sameAccount(account,ctx.account()))return;
                root.replaceChildren(stage);lastAccount=account;const kept=scroll.get(JSON.stringify(account));if(kept)for(const card of stage.querySelectorAll('[data-folder-id]')){const body=card.querySelector('.board-body');if(body)body.scrollTop=kept.get(card.dataset.folderId)||0;}
            }).catch(e=>{if(current===generation)root.replaceChildren(el('p',{},e.message));});
            return true;
        },
        destroy(){for(const v of views.values())v.destroy?.();nav.remove();account.remove();generation++;}
    };
    document.addEventListener('desktop-error',e=>ctx.toast(e.detail));drawNav();drawAccount();return shell;
}
