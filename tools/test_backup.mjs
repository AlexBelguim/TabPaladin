// Headless test: 'Download a backup' (src/utils/backup.js) and the notice
// that TabPaladin is moving into the server's web app.
//
// What this locks down:
//   1. The backup holds everything the extension stores — working copy,
//      set-aside copies, removal queue, live, parked and mirrored note
//      drafts, settings — and this origin's localStorage, verbatim.
//   2. No secret goes in: the sync session token, a Gemini key an older
//      version kept, and any field named like a token, password, secret or
//      API key are null in the file and listed under `redacted`; the
//      server address and user name stay. Words the user chose (a keyword
//      category called "Token") are kept.
//   3. A summary says what is in it (parked drafts mirrored only under the
//      page that held them counted too); the file is named by date.
//   4. Downloading writes what the page holds first, then hands the browser
//      a JSON file with no token in it.
//   5. Settings has the button; the app page shows the moving notice, with
//      a backup button and a way to hide it.
//
// Run: node tools/test_backup.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(name, cond, detail) {
    if (cond) {
        console.log(`  ok  ${name}`);
    } else {
        failures++;
        console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

const { buildBackup, collectBackup, downloadBackup, backupFileName, BACKUP_FORMAT } = await import('../src/utils/backup.js');

const TOKEN = 'SESSION-TOKEN-0123456789abcdef';
const GEMINI = 'AIzaSyFAKEFAKEFAKEFAKEFAKE';
const tree = {
    baseVersion: 12, dirty: true, editCount: 3, owner: { url: 'https://tp.example', userId: 1, username: 'alex', serverId: 'srv' },
    roots: [{ id: 'bm', kind: 'folder', title: 'Bookmarks', role: 'bookmarks', children: [
        { id: 'b1', kind: 'bookmark', title: 'Token docs', url: 'https://example.com/?token=public' },
        { id: 'n1', kind: 'note', title: 'Note', payload: { content: 'my password manager is great', createdAt: 'x', updatedAt: 'y' } }
    ] }, { id: 'imports:root', kind: 'folder', title: 'TabPaladin Imports', virtual: true, children: [{ id: 'imp:1', kind: 'bookmark', virtual: true }] }]
};
const storage = {
    tpTree: tree,
    'tpTreeStash:https://tp.example|2': { roots: [{ id: 's1', kind: 'folder', title: 'Sam', children: [] }], dirty: false, owner: { url: 'https://tp.example', userId: 2 } },
    tpTreeStashIndex: ['tpTreeStash:https://tp.example|2'],
    tpPendingRemovals: ['b9', 'b10'],
    tpLiveDraft: { page1: { owner: tree.owner, noteId: 'n1', title: 'Note', content: 'UNSAVED TEXT', at: 'z' } },
    tpParkedMirror: { at: 5, drafts: [{ owner: null, origin: 'local', title: 'P', content: 'PARKED TEXT' }] },
    tpOpenWorkflowTabs: { 12: { workflowId: 'w', bookmarkId: 'b1' } },
    tpVideoSeek: true,
    settings: {
        focusedFolderIds: ['bm'], categoryOrder: ['Token', 'Dev'],
        customKeywords: { Token: ['jwt', 'oauth'] },
        useAI: true, geminiApiKey: GEMINI,
        backend: { url: 'https://tp.example', token: TOKEN, username: 'alex', userId: 1, role: 'admin', lastSyncAt: 'when' }
    },
    someIntegration: { clientSecret: 'CLIENT-SECRET', nested: [{ password: 'hunter2' }] }
};
const local = {
    tp_notes_parked_v1: JSON.stringify([{ owner: null, origin: 'local', title: 'P', content: 'PARKED TEXT' }]),
    tp_notes_ui_v1: JSON.stringify({ sort: 'title' }),
    tp_moving_banner_dismissed_v1: '2026-10-13T00:00:00.000Z'
};

console.log('\n1. Everything is in it');
const backup = buildBackup({ storage, local, extension: { name: 'TabPaladin', version: '1.0.1' }, now: new Date('2026-10-13T12:34:56Z') });
const text = JSON.stringify(backup);
check('it says what it is', backup.format === BACKUP_FORMAT && backup.version === 1 && backup.extension.version === '1.0.1'
    && backup.exportedAt === '2026-10-13T12:34:56.000Z');
check('the working copy, verbatim (unpushed edits, virtual nodes and all)', JSON.stringify(backup.storage.tpTree) === JSON.stringify(tree));
for (const key of ['tpTreeStash:https://tp.example|2', 'tpTreeStashIndex', 'tpPendingRemovals', 'tpLiveDraft', 'tpParkedMirror', 'tpOpenWorkflowTabs', 'tpVideoSeek']) {
    check(`${key}, verbatim`, JSON.stringify(backup.storage[key]) === JSON.stringify(storage[key]));
}
check('this origin\'s localStorage, parsed where it is JSON', backup.localStorage.tp_notes_parked_v1[0].content === 'PARKED TEXT'
    && backup.localStorage.tp_notes_ui_v1.sort === 'title' && backup.localStorage.tp_moving_banner_dismissed_v1 === '2026-10-13T00:00:00.000Z');

console.log('\n2. No secret is in it');
check('not the session token', !text.includes(TOKEN));
check('not a Gemini key an older version kept', !text.includes(GEMINI));
check('nor anything named like a secret', !text.includes('CLIENT-SECRET') && !text.includes('hunter2'));
check('each is null in the file and listed', backup.storage.settings.backend.token === null && backup.storage.settings.geminiApiKey === null
    && JSON.stringify(backup.redacted.sort()) === JSON.stringify([
        'storage.settings.backend.token', 'storage.settings.geminiApiKey',
        'storage.someIntegration.clientSecret', 'storage.someIntegration.nested[0].password'].sort()), JSON.stringify(backup.redacted));
check('the server address and user name stay', backup.storage.settings.backend.url === 'https://tp.example'
    && backup.storage.settings.backend.username === 'alex');
check('words the user chose stay: a keyword category called "Token"', JSON.stringify(backup.storage.settings.customKeywords) === '{"Token":["jwt","oauth"]}');
check('and text that merely mentions one (a note, a URL)', text.includes('my password manager is great') && text.includes('?token=public'));
check('nothing in the original was changed', storage.settings.backend.token === TOKEN && storage.settings.geminiApiKey === GEMINI);

console.log('\n3. Summary and name');
check('a summary of what it holds', JSON.stringify(backup.summary) === JSON.stringify({
    workingCopy: { owner: { url: 'https://tp.example', userId: 1, username: 'alex' }, origin: null, items: 3, unpushedEdits: 3, baseVersion: 12 },
    setAsideCopies: 1, parkedDrafts: 1, liveDrafts: 1, queuedRemovals: 2
}), JSON.stringify(backup.summary));
{
    const pages = {
        pageA: [{ owner: null, origin: 'local', title: 'Q', content: 'ONLY IN PAGE A' }],
        pageB: [{ owner: null, origin: 'local', title: 'R', content: 'ONLY IN PAGE B' }, { owner: null, origin: 'local', title: 'S', content: 'AND THIS' }]
    };
    const held = buildBackup({ storage: { ...storage, tpParkedMirror: { ...storage.tpParkedMirror, pages } }, local });
    check('drafts pages could keep only in memory (mirrored by page) are in it, counted on top of the list',
        held.summary.parkedDrafts === 4 && JSON.stringify(held.storage.tpParkedMirror.pages) === JSON.stringify(pages), JSON.stringify(held.summary));
}
check('the file is named by date and time', backupFileName(new Date('2026-10-13T12:34:56Z')) === 'tabpaladin-backup-2026-10-13-12-34-56.json');

console.log('\n4. Collecting and downloading');
{
    const api = {
        storage: { local: { get: async (k) => (k === null ? JSON.parse(JSON.stringify(storage)) : {}) } },
        runtime: { getManifest: () => ({ name: 'TabPaladin', version: '1.0.1' }) }
    };
    const ls = { length: 2, key: (i) => ['tp_notes_ui_v1', 'tp_notes_parked_v1'][i], getItem: (k) => local[k] };
    const got = await collectBackup({ api, localStorage: ls, now: new Date('2026-10-13T00:00:00Z') });
    check('collects every key of storage and localStorage', Object.keys(got.storage).length === Object.keys(storage).length
        && Object.keys(got.localStorage).length === 2 && !JSON.stringify(got).includes(TOKEN));

    const order = [];
    const files = [];
    globalThis.localStorage = ls;
    globalThis.document = {
        createElement: () => ({ click() { files.push({ name: this.download, href: this.href }); order.push('download'); }, remove() {} }),
        body: { appendChild() {} }
    };
    const blobs = new Map();
    const realCreate = URL.createObjectURL;
    URL.createObjectURL = (b) => { const u = `blob:${blobs.size}`; blobs.set(u, b); return u; };
    URL.revokeObjectURL = () => {};
    await downloadBackup({ api, prepare: async () => { order.push('prepare'); } });
    URL.createObjectURL = realCreate;
    const file = files[0];
    const saved = file ? JSON.parse(await blobs.get(file.href).text()) : null;
    check('what the page holds is written first, then the file is handed over', JSON.stringify(order) === '["prepare","download"]');
    check('a .json file with everything but the token', file && /^tabpaladin-backup-.*\.json$/.test(file.name) && saved
        && saved.storage.tpTree.editCount === 3 && saved.storage.settings.backend.token === null && !JSON.stringify(saved).includes(TOKEN));
    delete globalThis.document;
    delete globalThis.localStorage;
}

console.log('\n5. Where it is offered');
{
    const sidepanel = fs.readFileSync(path.join(ROOT, 'src/sidepanel/sidepanel.js'), 'utf8');
    const html = fs.readFileSync(path.join(ROOT, 'src/app/app.html'), 'utf8');
    const app = fs.readFileSync(path.join(ROOT, 'src/app/app.js'), 'utf8');
    check('Settings has "Download a backup", writing the copy and the open note first',
        /id="backup-download-btn"[^>]*>📦 Download a backup</.test(sidepanel) && /getElementById\('backup-download-btn'\)[\s\S]{0,200}downloadPageBackup\(\)/.test(sidepanel)
        && /function downloadPageBackup\(\) \{[\s\S]*?TreeStore\.flush\(\)[\s\S]*?saveLiveDraft\(\)/.test(sidepanel));
    // 1.9.0: the old app page only sends to the move page, which offers the
    // backup first. The old page's moving banner stays in its packaged code.
    const movePage = fs.readFileSync(path.join(ROOT, 'src/helper/move.html'), 'utf8');
    const movePageJs = fs.readFileSync(path.join(ROOT, 'src/helper/movePage.js'), 'utf8');
    check('the app page says TabPaladin is moving, and sends to the move page',
        /moving into your server's web app/.test(html) && /http-equiv="refresh" content="0; url=\.\.\/helper\/move\.html"/.test(html) && !/<script/.test(html));
    check('the move page offers a backup file first, the old banner\'s code is still packaged',
        movePage.indexOf('id="backup"') > -1 && movePage.indexOf('id="backup"') < movePage.indexOf('id="move"')
        && /import \{ downloadBackup \} from '\.\.\/utils\/backup\.js'/.test(movePageJs) && /downloadBackup\(\{ api \}\)/.test(movePageJs)
        && /tp_moving_banner_dismissed_v1/.test(app) && /downloadBackup\(/.test(app));
}

console.log(failures === 0 ? '\nAll backup tests passed.\n' : `\n${failures} backup test(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
