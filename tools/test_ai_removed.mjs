// Headless test: the built-in AI is gone from the extension, and what was
// kept still works.
//
// Owner decision: no Gemini key, no AI organizer or Restructure, no
// aiService.js, no key storage anywhere. Kept: the keyword (non-AI)
// organizer, the Organize "Sources" grid, folder JSON export/import and
// keyword JSON export/import.
//
// What this locks down:
//   1. aiService.js (and the Gemini model lister) are gone, and no shipped
//      code, markup or style names Gemini, its endpoint, the AI organizer,
//      Restructure, "Refine with AI" or the key field — only the lists of
//      retired setting names that delete it.
//   2. An install that stored a Gemini key has it deleted from storage on
//      update (and on the next wake), the rest of its settings untouched.
//   3. The pages never read it back nor write it again: StorageManager strips
//      it from every read and write, purgeRetiredSettings deletes it, and a
//      TreeStore account switch does not write it back.
//   4. Analyze & Sort and Split run the keyword organizer, which still
//      proposes and applies; the kept features are still wired.
//   5. README and PRIVACY no longer mention Gemini.
//
// Run: node tools/test_ai_removed.mjs

import fs from 'node:fs';
import path from 'node:path';
import { makeBrowser, ROOT, sleep, until } from './fake_extension.mjs';

let failures = 0;
function check(name, cond, detail) {
    if (cond) {
        console.log(`  ok  ${name}`);
    } else {
        failures++;
        console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

function listFiles(dir, out = []) {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.posix.join(dir, e.name);
        if (e.isDirectory()) listFiles(rel, out);
        else if (/\.(js|mjs|html|css|json)$/.test(e.name)) out.push(rel);
    }
    return out;
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

console.log('\n1. Nothing of it ships');
{
    check('src/utils/aiService.js is gone', !fs.existsSync(path.join(ROOT, 'src/utils/aiService.js')));
    check('tools/list_models.js (the Gemini model lister) is gone', !fs.existsSync(path.join(ROOT, 'tools/list_models.js')));
    const shipped = [...listFiles('src'), 'manifest.json', 'firefox/manifest.json'];
    const banned = [/gemini/i, /generativelanguage/i, /aiService/, /AIService/, /organizeWithAI|restructureWithAI|analyzeWithAI/,
        /restructure/i, /Refine with AI/i, /aiGroupTabsBtn|aiHintsInput|aiTabsHintsInput|use-ai-toggle|gemini-api-key|ai-regroup-controls/,
        /\buseAI\b/, /AI Brain/];
    const hits = [];
    for (const rel of shipped) {
        // The only place the names may appear: the lists of retired settings
        // that delete them.
        const code = stripComments(read(rel)).split('\n')
            .filter(line => !/RETIRED_SETTINGS\s*=\s*\[/.test(line)).join('\n');
        for (const re of banned) if (re.test(code)) hits.push(`${rel}: ${re}`);
    }
    check('no shipped code, markup or style names it', hits.length === 0, hits.join('; '));
    const retired = shipped.filter(rel => /RETIRED_SETTINGS\s*=\s*\['geminiApiKey', 'useAI'\]/.test(read(rel)));
    check('the retired names live only where they are deleted (background, StorageManager, TreeStore)',
        JSON.stringify(retired.sort()) === JSON.stringify(['src/background/background.js', 'src/utils/storageManager.js', 'src/utils/treeStore.js']),
        JSON.stringify(retired));
}

console.log('\n2. A stored key is deleted on update');
{
    const b = makeBrowser({ timeScale: 0.02 });
    const before = { focusedFolderIds: ['f1'], customKeywords: { Work: ['jira'] }, useAI: true, geminiApiKey: 'AIzaSECRET',
        backend: { url: 'https://tp.example', token: 'tok', username: 'alex' }, videoSeek: false };
    b.storage.set('settings', JSON.parse(JSON.stringify(before)));
    b.bootWorker();
    b.fire('installed', { reason: 'update', previousVersion: '1.0.0' });
    await until(() => !('geminiApiKey' in (b.storage.get('settings') || {})));
    await sleep(50);
    const after = b.storage.get('settings');
    check('the key and the AI switch are gone from storage', !('geminiApiKey' in after) && !('useAI' in after) && !JSON.stringify([...b.storage.values()]).includes('AIzaSECRET'));
    const { useAI, geminiApiKey, ...rest } = before;
    check('everything else in settings is as it was', JSON.stringify(after) === JSON.stringify(rest), JSON.stringify(after));

    // Written back by a page from before, then a later wake.
    b.storage.set('settings', { ...after, geminiApiKey: 'AIzaAGAIN' });
    b.bootWorker();
    await until(() => !('geminiApiKey' in (b.storage.get('settings') || {})));
    check('a later wake deletes it too', !('geminiApiKey' in b.storage.get('settings')));
}

// One page for 3 and 4: its modules keep the browser they were loaded in.
const page = makeBrowser();
globalThis.chrome = page.pageApi;

console.log('\n3. The pages never read it back nor write it again');
{
    const b = page;
    const { StorageManager } = await import('../src/utils/storageManager.js');
    const { TreeStore } = await import('../src/utils/treeStore.js');
    b.storage.set('settings', { focusedFolderIds: ['x'], geminiApiKey: 'AIzaPAGE', useAI: true, backend: { url: 'https://a' } });
    const got = await StorageManager.getSettings();
    check('getSettings does not hand it out', !('geminiApiKey' in got) && !('useAI' in got) && got.focusedFolderIds[0] === 'x');
    await StorageManager.saveSettings({ ...got, geminiApiKey: 'AIzaWRITTEN', useAI: true, categoryOrder: ['A'] });
    check('saveSettings does not write it', !('geminiApiKey' in b.storage.get('settings')) && !('useAI' in b.storage.get('settings'))
        && b.storage.get('settings').categoryOrder[0] === 'A');
    b.storage.set('settings', { ...b.storage.get('settings'), geminiApiKey: 'AIzaOLD' });
    check('purgeRetiredSettings deletes it', (await StorageManager.purgeRetiredSettings()) === true
        && !('geminiApiKey' in b.storage.get('settings')) && b.storage.get('settings').backend.url === 'https://a');
    check('and has nothing to do the second time', (await StorageManager.purgeRetiredSettings()) === false);

    b.storage.set('settings', { ...b.storage.get('settings'), geminiApiKey: 'AIzaSWITCH' });
    b.storage.set('tpTree', { baseVersion: 1, roots: [{ id: 'r', kind: 'folder', title: 'R', children: [] }], dirty: false, owner: { url: 'https://a', userId: 1 }, rev: 'x', copyId: 'c' });
    await TreeStore.load();
    await TreeStore.switchAccount({ url: 'https://a', userId: 2, username: 'sam' });
    check('a TreeStore account switch writes settings without it', !('geminiApiKey' in b.storage.get('settings')),
        JSON.stringify(b.storage.get('settings')));
}

console.log('\n4. The keyword organizer, and what was kept');
{
    const b = page;
    await b.pageApi.storage.local.set({ settings: { focusedFolderIds: [] } });
    // Another page brings this copy in; this page's TreeStore takes it.
    await b.pageApi.storage.local.set({ tpTree: { baseVersion: 1, dirty: false, rev: 'y', seq: 99, copyId: 'd', origin: 'local', roots: [
        { id: 'src', kind: 'folder', title: 'Inbox', children: [
            { id: 'g1', kind: 'bookmark', title: 'GitHub - project', url: 'https://github.com/a/b' },
            { id: 'g2', kind: 'bookmark', title: 'stackoverflow answer', url: 'https://stackoverflow.com/q/1' },
            { id: 'v1', kind: 'bookmark', title: 'A video', url: 'https://www.youtube.com/watch?v=1' }
        ] }
    ] } });
    const { BookmarkOrganizer } = await import('../src/utils/bookmarkOrganizer.js');
    const { TreeStore } = await import('../src/utils/treeStore.js');
    await until(async () => Boolean(await TreeStore.getNode('src')));
    check('BookmarkOrganizer has no AI entry points left', !('AIService' in BookmarkOrganizer) && !('analyzeWithAI' in BookmarkOrganizer)
        && !('getAllItemsInScope' in BookmarkOrganizer) && typeof BookmarkOrganizer.proposeSmartOrganization === 'function');
    const proposal = await BookmarkOrganizer.proposeSmartOrganization(['loose-src']);
    const names = proposal.groups.map(g => g.groupName).sort();
    check('the keyword organizer proposes groups from keywords', names.includes('Coding - Github') && names.includes('Video - Youtube'),
        JSON.stringify(names));
    await BookmarkOrganizer.applyOrganization(proposal.groups);
    const inbox = await TreeStore.getNode('src');
    const coding = inbox.children.find(c => c.title === 'Coding');
    check('and applying it files the bookmarks', coding && JSON.stringify(inbox.children.filter(c => c.kind === 'bookmark').map(c => c.id)) === '[]',
        JSON.stringify(inbox.children.map(c => c.title)));
    await TreeStore.flush();

    // From 1.9.0 the old UI's page only sends to the move page: its code
    // stays packaged (checked here), and the web app carries these on.
    const sidepanel = read('src/sidepanel/sidepanel.js');
    const organize = read('pwa/organize.js');
    check('Analyze & Sort and Split run the keyword organizer, in the old UI\'s code and in the web app',
        /getElementById\('analyzeBtn'\)[\s\S]{0,900}BookmarkOrganizer\.proposeSmartOrganization\(folderIds\)/.test(sidepanel)
        && /async function runSplitOnFolder[\s\S]{0,300}proposeSmartOrganization\(sourceIds\)/.test(sidepanel)
        && /BookmarkOrganizer\.proposeSmartOrganization\(/.test(organize));
    check('the Organize "Sources" grid is still there, in the old UI\'s code and in the web app',
        /getElementById\('organizeBookmarksBtn'\)[\s\S]{0,400}renderSourceGrid\(VIRTUAL_ROOT_ID\)/.test(sidepanel)
        && /button\('Sources'/.test(organize));
    check('folder JSON export and import are still there', /async function exportBookmarkFolder\(/.test(sidepanel)
        && /async function importBookmarkFolder\(/.test(sidepanel) && /id="folderImportBtn"/.test(sidepanel));
    check('keyword JSON export and import are still there', /id="kwExportBtn"/.test(sidepanel) && /id="kwImportBtn"/.test(sidepanel)
        && /customKeywords: mutableState\.customKeywords/.test(sidepanel));
    check('Settings has no AI section, and saving it writes no key', !/AI Brain|Gemini/.test(stripComments(sidepanel))
        && !/geminiApiKey/.test(sidepanel));
}

console.log('\n5. The docs');
{
    check('README no longer mentions Gemini or AI organisation', !/gemini/i.test(read('README.md')) && !/AI-Powered Organization/.test(read('README.md')));
    // It may say that an older version's key is deleted; nothing else.
    const privacy = read('PRIVACY.md').replace(/\n {2}/g, ' ');
    const mentions = privacy.split(/(?<=\.)\s/).filter(s => /gemini/i.test(s));
    check('PRIVACY mentions Gemini only to say an older key is deleted, never as a service data goes to',
        mentions.length <= 1 && mentions.every(s => /deleted/.test(s)) && !/Third-party services[\s\S]*Gemini[\s\S]*## What TabPaladin does not do/.test(privacy),
        JSON.stringify(mentions));
}

console.log(failures === 0 ? '\nAll AI-removal tests passed.\n' : `\n${failures} AI-removal test(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
