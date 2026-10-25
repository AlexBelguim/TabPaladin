import { sameAccount, walk } from './desktopCore.js';
import { ExpandState } from './lib/expandState.js';
export async function housekeeping(ctx,{pulled=false}={}){
    const account=ctx.account();if(!account)return;await ctx.store.load();
    const status=ctx.store.status();if(!sameAccount(status.owner,account)||status.isEmpty)return;
    const copy=await ctx.store.currentCopy(),settings=await ctx.storage.getSettings(),focused=[];
    for(const id of settings.focusedFolderIds||[])if(await ctx.store.getNode(id))focused.push(id);
    if(!sameAccount(account,ctx.account()))return;
    if(focused.length!==(settings.focusedFolderIds||[]).length)await ctx.store.saveCopySettings({focusedFolderIds:focused},{account,expect:copy});
    if(pulled)await ExpandState.pruneAgainstTree(ctx.store);
    // A copy with an imports archive and no YouTube folder asks the server for
    // it (accounts that set imports up before the folder existed).
    const roots=ctx.store.roots();
    if(ctx.ensureAppFolder&&walk(roots).some(n=>n.id==='imports:root')&&!walk(roots).some(n=>n.kind==='folder'&&n.payload?.app==='youtube'))await ctx.ensureAppFolder('youtube').catch(e=>console.warn('YouTube folder:',e.message));
    const legacy=await ctx.platform.storage.local.get(['workflows','tpMigrationDone']);
    if(account.tenancyOwner&&!legacy.tpMigrationDone&&Array.isArray(legacy.workflows)&&legacy.workflows.length)await ctx.edit(()=>ctx.storage.migrateLegacyIfNeeded());
}
