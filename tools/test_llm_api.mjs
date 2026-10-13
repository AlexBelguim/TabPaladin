// Tests for what AI chats reach through the 1-hour LLM share link: the page
// (notes and now the bookmark tree), its pages, folder views and search, the
// proposals it takes (notes and orders as before; new folders, new
// bookmarks, moves, renames and deletes), how they are checked, previewed,
// found out of date and approved or rejected, and that no account ever
// reaches another's.
//
// What this locks down:
//   1. The proposal shapes (treeChanges.normalizeChanges): every kind, refs,
//      limits, and refusals with a message a chat can act on.
//   2. Planning against a tree (planChanges): previews, what is read-only
//      (role folders, Notes, Workflows, Pinned, the imported archive, notes),
//      a folder never moved into itself, fingerprints, and a proposal whose
//      nodes changed since coming out stale with the reasons.
//   3. The page: bounded, plain text, ids and paths of every folder, the
//      first bookmarks with a clear TRUNCATED note and working page links,
//      Pinned and Workflows marked read-only, the notes section unchanged,
//      folder views, search, and dead links (bad token, deleted account).
//   4. Proposals through the link: each kind stored with a preview, the old
//      note contract unchanged, refusals with the problems, and the cap.
//   5. Review and approval: GET /api/proposals keeps its old answer (notes
//      and orders only), /api/proposals/review has everything; approving
//      applies the whole proposal in one transaction, moves the version,
//      writes history and drops the proposal; a stale one is refused with
//      409 and changes nothing — never half-applied; reject drops it.
//   6. Tenancy: another account's link, page, ids, review and approvals
//      never touch this one's.
//   And what review found: a delete past the 60th preview line is still
//   flagged and listed; a folder delete goes stale when what is in it
//   changes; approving checks the preview the user was shown (409 changed);
//   approving a delete keeps a history version from before it, links filed
//   since the last snapshot included; ids inside a folder deleted in the
//   same proposal are skipped, not refused; refusals carry at most 50
//   problems; a note body keeps being a note whatever "action" it guessed;
//   and a password change ends the account's share links (test_mcp, and
//   test_auth for an admin reset).
//
// Run: node tools/test_llm_api.mjs [--port 18990]
// Starts this checkout's server on the port with a throwaway data directory.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeChanges, planChanges, ChangeError, MAX_CHANGES, MAX_PREVIEW, MAX_DELETES } from '../server/treeChanges.js';
import { parseProposal } from '../server/proposals.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback = null) => {
    const i = process.argv.indexOf('--' + name);
    return i === -1 ? fallback : process.argv[i + 1];
};
const PORT = Number(arg('port') || 18990);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'correct horse battery';
const CAP = 40;

let failures = 0;
function check(name, cond, detail) {
    if (cond) console.log(`  ok  ${name}`);
    else { failures++; console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const throwsMsg = (fn) => { try { fn(); return null; } catch (e) { return e instanceof ChangeError ? e.message : 'OTHER: ' + e.message; } };
let idn = 0;
const newId = () => `new${++idn}`;

// --- 1. Shapes ----------------------------------------------------------------------
console.log('\n1. Proposal shapes');
{
    const c = normalizeChanges([
        { op: 'create_folder', parentId: 'f1', path: 'A / B', ref: 'ab' },
        { op: 'add_bookmark', folderRef: 'ab', title: ' Spaced   title ', url: 'https://a.example/x' },
        { op: 'move', id: 'b1', toFolderRef: 'ab' },
        { op: 'rename', id: 'b2', title: 'New' },
        { op: 'remove', ids: ['b3', 'b3'] }
    ]);
    check('every kind normalizes, aliases included', c.length === 5 && c[0].op === 'create_folder' && c[0].path.join('|') === 'A|B'
        && c[1].op === 'add_bookmarks' && c[1].bookmarks[0].title === 'Spaced title' && c[2].op === 'move' && c[2].ids[0] === 'b1'
        && c[4].op === 'delete' && c[4].ids.length === 1, JSON.stringify(c));
    check('an untitled bookmark is named by its address',
        normalizeChanges([{ op: 'add_bookmarks', folderId: 'f', bookmarks: [{ url: 'https://u.example/' }] }])[0].bookmarks[0].title === 'https://u.example/');
    for (const [name, list] of [
        ['no changes', []],
        [`${MAX_CHANGES + 1} changes`, Array.from({ length: MAX_CHANGES + 1 }, () => ({ op: 'delete', ids: ['x'] }))],
        ['an unknown op', [{ op: 'explode', ids: ['x'] }]],
        ['a folder with neither parentId nor parentRef', [{ op: 'create_folder', path: 'X' }]],
        ['a folder with both', [{ op: 'create_folder', parentId: 'a', parentRef: 'b', path: 'X' }]],
        ['a ref no earlier change made', [{ op: 'move', ids: ['x'], toFolderRef: 'later' }, { op: 'create_folder', parentId: 'a', path: 'X', ref: 'later' }]],
        ['a ref used twice', [{ op: 'create_folder', parentId: 'a', path: 'X', ref: 'r' }, { op: 'create_folder', parentId: 'a', path: 'Y', ref: 'r' }]],
        ['a javascript: bookmark', [{ op: 'add_bookmarks', folderId: 'f', bookmarks: [{ title: 'x', url: 'javascript:alert(1)' }] }]],
        ['a file: bookmark', [{ op: 'add_bookmarks', folderId: 'f', bookmarks: [{ url: 'file:///etc/passwd' }] }]],
        ['101 bookmarks', [{ op: 'add_bookmarks', folderId: 'f', bookmarks: Array.from({ length: 101 }, (_, i) => ({ url: `https://a.example/${i}` })) }]],
        ['an empty folder name', [{ op: 'create_folder', parentId: 'a', path: '  ' }]],
        ['11 levels', [{ op: 'create_folder', parentId: 'a', path: Array.from({ length: 11 }, (_, i) => `L${i}`).join(' / ') }]],
        ['a 201-character folder name', [{ op: 'create_folder', parentId: 'a', path: 'x'.repeat(201) }]],
        ['201 ids', [{ op: 'delete', ids: Array.from({ length: 201 }, (_, i) => `i${i}`) }]],
        [`${MAX_DELETES + 1} deletions over two changes`, [{ op: 'delete', ids: Array.from({ length: 101 }, (_, i) => `a${i}`) },
            { op: 'delete', ids: Array.from({ length: MAX_DELETES - 100 }, (_, i) => `b${i}`) }]],
        ['a rename without a title', [{ op: 'rename', id: 'x' }]],
        ['an id with a newline', [{ op: 'delete', ids: ['a\nb'] }]]
    ]) {
        const m = throwsMsg(() => normalizeChanges(list));
        check(`refused: ${name}`, m !== null && !m.startsWith('OTHER'), m);
    }
    check('parseProposal: a single action is a one-change proposal with its reason',
        (() => { const p = parseProposal({ action: 'rename', id: 'x', title: 'Y', reason: ' because ' }); return p.type === 'tree' && p.changes.length === 1 && p.reason === 'because'; })());
    check('parseProposal: a note body is a note, as always', parseProposal({ title: 'T', content: 'c', notebook: ' NB ' }).notebook === 'NB');
    check('parseProposal: an unknown action is refused', throwsMsg(() => parseProposal({ action: 'nuke' })) !== null);
    check(`parseProposal: ${MAX_DELETES} deletions over two changes are fine`, parseProposal({ action: 'changes', changes: [
        { op: 'delete', ids: Array.from({ length: 100 }, (_, i) => `a${i}`) }, { op: 'delete', ids: Array.from({ length: 100 }, (_, i) => `b${i}`) }] }).changes.length === 2);
    const guessed = ['create', 'create_note', 'add_note', 'update', 'edit', 'propose', 'remove', 'new_folder', 'delete', 'changes']
        .map(action => [action, (() => { try { return parseProposal({ action, title: 'Groceries', content: '# Groceries\n\n- milk' }); } catch (e) { return e.message; } })()]);
    check('parseProposal: a note body is a note whatever "action" it guessed, as the link always took it',
        guessed.every(([, p]) => p && p.type === 'note' && p.title === 'Groceries'), JSON.stringify(guessed));
    check('  but a bookmark change is still one, and a reorder still a reorder',
        parseProposal({ action: 'remove', ids: ['x'] }).type === 'tree' && parseProposal({ action: 'delete', title: 'x', ids: ['x'] }).type === 'tree'
        && parseProposal({ changes: [{ op: 'delete', ids: ['x'] }], content: 'stray' }).type === 'tree'
        && parseProposal({ action: 'reorder', order: ['A'], content: 'x' }).type === 'reorder');
    check('parseProposal: a 1001-character reason is refused',
        throwsMsg(() => parseProposal({ action: 'delete', ids: ['x'], reason: 'r'.repeat(1001) })) !== null);
}

// --- 2. Planning ------------------------------------------------------------------------
console.log('\n2. Planning against a tree');
{
    const row = (id, parent, kind, title, extra = {}) => ({ id, parent_id: parent, kind, title, role: null, url: null, ...extra });
    const rows = [
        row('bm', null, 'folder', 'Bookmarks', { role: 'bookmarks' }),
        row('tech', 'bm', 'folder', 'Tech'),
        row('ai', 'tech', 'folder', 'AI'),
        row('hn', 'tech', 'bookmark', 'HN', { url: 'https://news.ycombinator.com' }),
        row('inbox', 'bm', 'folder', 'Inbox'),
        row('mdn', 'inbox', 'bookmark', 'MDN', { url: 'https://developer.mozilla.org' }),
        row('nr', null, 'folder', 'Notes', { role: 'notes' }),
        row('n1', 'nr', 'note', 'Diary'),
        row('n2', 'inbox', 'note', 'Loose note'),
        row('wf', null, 'folder', 'Workflows', { role: 'workflows' }),
        row('w1', 'wf', 'folder', 'Session'),
        row('pins', null, 'folder', 'Pinned', { role: 'pins' }),
        row('p1', 'pins', 'bookmark', 'Pin', { url: 'https://pin.example' })
    ];
    const plan = (list, opts = {}) => planChanges(rows, normalizeChanges(list), { newId, ...opts });
    const p = plan([
        { op: 'create_folder', parentId: 'tech', path: 'AI / Papers', ref: 'papers' },
        { op: 'add_bookmarks', folderRef: 'papers', bookmarks: [{ title: 'Attention', url: 'https://arxiv.org/abs/1706.03762' }] },
        { op: 'add_bookmarks', folderId: 'inbox', bookmarks: [{ title: 'MDN again', url: 'https://developer.mozilla.org' }] },
        { op: 'move', ids: ['hn'], toFolderRef: 'papers' },
        { op: 'rename', id: 'inbox', title: 'Reading' },
        { op: 'delete', ids: ['mdn'] }
    ]);
    const texts = p.preview.map(x => x.text);
    check('a batch plans in order, reusing AI, refs resolving, the duplicate skipped', p.ok
        && texts.includes('New folder “Papers” in Bookmarks / Tech / AI')
        && texts.includes('Add “Attention” (https://arxiv.org/abs/1706.03762) to Bookmarks / Tech / AI / Papers')
        && texts.includes('“MDN again” is already in Bookmarks / Inbox')
        && texts.includes('Move bookmark “HN” from Bookmarks / Tech to Bookmarks / Tech / AI / Papers')
        && texts.includes('Rename folder “Inbox” to “Reading” (in Bookmarks)')
        && p.preview.some(x => x.danger && /^DELETE bookmark “MDN”/.test(x.text)), JSON.stringify(texts));
    check('  with the writes in order', p.actions.map(a => a.type).join(',') === 'folder,bookmark,move,rename,delete', JSON.stringify(p.actions));
    check('  and a fingerprint of every existing node it names', ['tech', 'inbox', 'hn', 'mdn'].every(id => p.fingerprints[id])
        && p.fingerprints.hn.t === 'HN' && p.fingerprints.hn.p === 'tech' && !p.fingerprints.papers, JSON.stringify(p.fingerprints));
    check('  and a one-line summary', p.summary === '5 changes: 1 new folder, 1 new bookmark, 1 moved, 1 renamed, 1 DELETED', p.summary);
    for (const [name, list, want] of [
        ['moving the Bookmarks root', [{ op: 'move', ids: ['bm'], toFolderId: 'tech' }], /app's own Bookmarks folder/],
        ['renaming the Notes root', [{ op: 'rename', id: 'nr', title: 'X' }], /app's own Notes folder/],
        ['a folder into its own child', [{ op: 'move', ids: ['tech'], toFolderId: 'ai' }], /cannot be moved into itself/],
        ['a folder into itself', [{ op: 'move', ids: ['tech'], toFolderId: 'tech' }], /cannot be moved into itself/],
        ['a bookmark into Notes', [{ op: 'move', ids: ['hn'], toFolderId: 'nr' }], /inside Notes/],
        ['a folder made in Workflows', [{ op: 'create_folder', parentId: 'w1', path: 'X' }], /inside Workflows/],
        ['a pin deleted', [{ op: 'delete', ids: ['p1'] }], /inside Pinned/],
        ['a note moved', [{ op: 'move', ids: ['n2'], toFolderId: 'tech' }], /is a note/],
        ['a folder holding a note deleted', [{ op: 'delete', ids: ['inbox'] }], /holds 1 note/],
        ['an unknown id', [{ op: 'rename', id: 'nope', title: 'X' }], /no bookmark or folder with id nope/],
        ['a bookmark as a folder', [{ op: 'create_folder', parentId: 'hn', path: 'X' }], /not a folder/],
        ['the imported archive', [{ op: 'move', ids: ['imp:1:2'], toFolderId: 'tech' }], /imported archive/],
        ['a move to where it is', [{ op: 'move', ids: ['hn'], toFolderId: 'tech' }], /Nothing would change/]
    ]) {
        const r = plan(list);
        check(`refused: ${name}`, !r.ok && r.problems.some(m => want.test(m)), JSON.stringify(r.problems));
    }
    const proposed = plan([{ op: 'move', ids: ['hn', 'mdn'], toFolderId: 'ai' }]);
    const later = rows.map(r => r.id === 'hn' ? { ...r, title: 'Hacker News' } : r).filter(r => r.id !== 'mdn')
        .map(r => r.id === 'ai' ? { ...r, parent_id: 'bm' } : r);
    const again = planChanges(later, normalizeChanges([{ op: 'move', ids: ['hn', 'mdn'], toFolderId: 'ai' }]), { fingerprints: proposed.fingerprints, newId });
    check('against a tree that changed since, it is stale and says why', !again.ok && again.problems.length === 0
        && again.stale.some(s => /bookmark “HN” was renamed to “Hacker News”/.test(s))
        && again.stale.some(s => /bookmark “MDN” is no longer there/.test(s))
        && again.stale.some(s => /folder “AI” was moved/.test(s)), JSON.stringify(again.stale));
    const same = planChanges(rows, normalizeChanges([{ op: 'move', ids: ['hn', 'mdn'], toFolderId: 'ai' }]), { fingerprints: proposed.fingerprints, newId });
    check('against the same tree it is still good', same.ok && same.stale.length === 0);

    // A DELETE past the preview's first MAX_PREVIEW lines is still flagged and shown.
    const many = (n, tag) => Array.from({ length: n }, (_, i) => ({ title: `${tag} ${i}`, url: `https://${tag}.example/${i}` }));
    const late = plan([{ op: 'add_bookmarks', folderId: 'tech', bookmarks: many(MAX_PREVIEW + 1, 'late') }, { op: 'delete', ids: ['ai'] }]);
    const lateDanger = late.preview.filter(x => x.danger);
    check('a delete after more than 60 other lines is flagged and still in the preview', late.ok && late.danger === true
        && lateDanger.length === 1 && /^DELETE folder “AI” from Bookmarks \/ Tech \(empty\)$/.test(lateDanger[0].text)
        && late.preview.length === MAX_PREVIEW + 2 && late.preview[late.preview.length - 1].op === 'more'
        && late.preview[late.preview.length - 1].text === '… and 1 more, none of them a deletion', JSON.stringify(late.preview.slice(-3)));
    const spread = plan([{ op: 'delete', ids: ['mdn'] }, { op: 'add_bookmarks', folderId: 'tech', bookmarks: many(100, 'a') },
        { op: 'add_bookmarks', folderId: 'tech', bookmarks: many(10, 'b') }, { op: 'delete', ids: ['hn', 'ai'] }]);
    check('  every DELETE line is kept, before and after the cut, in order', spread.ok && spread.danger
        && spread.preview.filter(x => x.danger).map(x => x.text.split(' ')[2]).join() === '“MDN”,“HN”,“AI”'
        && spread.preview.filter(x => !x.danger && x.op !== 'more').length === MAX_PREVIEW
        && /^… and 50 more, none of them a deletion$/.test(spread.preview[spread.preview.length - 1].text), JSON.stringify(spread.preview.filter(x => x.danger)));
    check('  and nothing deleted is no danger', plan([{ op: 'add_bookmarks', folderId: 'tech', bookmarks: many(70, 'c') }]).danger === false);

    // A folder delete is fingerprinted by what is in it.
    const delAi = plan([{ op: 'delete', ids: ['ai'] }]);
    const withChild = [...rows, row('new-bm', 'ai', 'bookmark', 'Filed later', { url: 'https://later.example' })];
    const grown = planChanges(withChild, normalizeChanges([{ op: 'delete', ids: ['ai'] }]), { fingerprints: delAi.fingerprints, newId });
    check('a folder deleted while empty is stale once something is put in it', delAi.ok && delAi.fingerprints.ai.c && delAi.fingerprints.ai.c.n === 0
        && !grown.ok && grown.stale.some(s => /What is in the folder “AI” changed since \(0 item\(s\) then, 1 now\)/.test(s))
        && grown.actions.some(a => a.type === 'delete' && a.ids.includes('new-bm')), JSON.stringify(grown.stale));
    const delTech = plan([{ op: 'delete', ids: ['tech'] }]);
    const shrunk = planChanges(rows.filter(r => r.id !== 'hn'), normalizeChanges([{ op: 'delete', ids: ['tech'] }]), { fingerprints: delTech.fingerprints, newId });
    const moved = planChanges(rows.map(r => r.id === 'hn' ? { ...r, parent_id: 'ai' } : r), normalizeChanges([{ op: 'delete', ids: ['tech'] }]), { fingerprints: delTech.fingerprints, newId });
    check('  and once something in it goes; a move inside it changes nothing', delTech.fingerprints.tech.c.n === 2
        && !shrunk.ok && shrunk.stale.some(s => /folder “Tech” changed since \(2 item\(s\) then, 1 now\)/.test(s))
        && moved.ok, JSON.stringify([shrunk.stale, moved.stale]));
    const keptAi = planChanges(rows, normalizeChanges([{ op: 'delete', ids: ['ai'] }]), { fingerprints: delAi.fingerprints, newId });
    check('  the same contents are still good, with the same review key', keptAi.ok && keptAi.reviewKey === delAi.reviewKey);

    // Ids inside a folder deleted in the same proposal.
    const both = plan([{ op: 'delete', ids: ['tech', 'hn'] }]);
    const bothRev = plan([{ op: 'delete', ids: ['hn', 'tech'] }]);
    const twice = plan([{ op: 'delete', ids: ['tech'] }, { op: 'delete', ids: ['hn'] }]);
    check('a folder and something in it, deleted together, in either order', both.ok && bothRev.ok && twice.ok
        && both.preview.some(x => x.op === 'skip' && x.text === '“HN” goes with the folder “Tech”, deleted above')
        && both.actions.length === 1 && both.counts.deleted === 1 && bothRev.counts.deleted === 2
        && both.fingerprints.hn && twice.preview.some(x => x.op === 'skip'), JSON.stringify([both.problems, both.preview, twice.problems]));
    const afterDel = plan([{ op: 'delete', ids: ['tech'] }, { op: 'move', ids: ['hn'], toFolderId: 'inbox' }]);
    check('  moving something a delete above took is refused, saying so', !afterDel.ok
        && afterDel.problems.some(m => /Change 2: “HN” is deleted by an earlier change in this proposal/.test(m)), JSON.stringify(afterDel.problems));

    // The review key: what the preview says, whatever else changed.
    const mv = [{ op: 'move', ids: ['mdn'], toFolderId: 'ai' }];
    const mvPlan = plan(mv);
    const renamedAbove = rows.map(r => r.id === 'tech' ? { ...r, title: 'Technology' } : r);
    const mvLater = planChanges(renamedAbove, normalizeChanges(mv), { fingerprints: mvPlan.fingerprints, newId });
    check('a review key names the preview: the same plan, the same key; other lines, another key',
        mvPlan.reviewKey === plan(mv).reviewKey && mvLater.ok && mvLater.reviewKey !== mvPlan.reviewKey
        && mvLater.preview[0].text === 'Move bookmark “MDN” from Bookmarks / Inbox to Bookmarks / Technology / AI', JSON.stringify(mvLater.preview));

    // Preview lines show a bounded part of what a chat or a title can make long.
    const long = plan([{ op: 'rename', id: 'hn', title: 'L'.repeat(1000) },
        { op: 'add_bookmarks', folderId: 'tech', bookmarks: [{ title: 'T'.repeat(1000), url: 'https://long.example/' + 'u'.repeat(7000) }] }]);
    check('long titles and addresses are cut short in the preview', long.ok && long.preview.every(x => x.text.length < 1200)
        && long.preview.some(x => x.text.includes('…')), JSON.stringify(long.preview.map(x => x.text.length)));
}

// --- 3-6. A live server ------------------------------------------------------------------------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-llm-api-'));
const env = { ...process.env };
for (const k of Object.keys(env)) if (/^(AUTH_TOKEN|ADMIN_|TENANCY_OWNER|IMPORT_|MAX_|MCP_)/.test(k)) delete env[k];
const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
        ...env, PORT: String(PORT), DATA_DIR: dataDir, PWA_DIR: path.join(ROOT, 'pwa'), ADMIN_USERNAME: 'alex', ADMIN_PASSWORD: PASSWORD,
        IMPORTS_SCHEDULER: 'off', MAX_PROPOSALS_PER_USER: String(CAP)
    },
    stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
const exited = new Promise(r => server.on('exit', r));
const ready = new Promise((resolve, reject) => {
    const onData = (d) => { serverLog += d; if (/Server listening/.test(serverLog)) resolve(); };
    server.stdout.on('data', onData);
    server.stderr.on('data', onData);
    exited.then(() => reject(new Error(serverLog)));
    setTimeout(() => reject(new Error('server did not start: ' + serverLog)), 20000);
});

async function api(p, { method = 'GET', token, body } = {}) {
    const res = await fetch(p.startsWith('http') ? p : BASE + p, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* not json */ }
    return { status: res.status, json, text, type: res.headers.get('content-type') || '' };
}

const T = '2026-10-01T00:00:00.000Z';
const bm = (id, title, url) => ({ id, kind: 'bookmark', title, url });
const folder = (id, title, children = [], extra = {}) => ({ id, kind: 'folder', title, children, ...extra });

try {
    await ready;
    const login = async (username, password = PASSWORD) => (await api('/api/login', { method: 'POST', body: { username, password } })).json.token;
    const A = await login('alex');
    for (const [name, pw] of [['sam', 'sam-password-1'], ['kim', 'kim-password-1']]) {
        const made = await api('/api/users', { method: 'POST', token: A, body: { username: name, password: pw, role: 'user', currentPassword: PASSWORD } });
        if (made.status !== 200) throw new Error('could not make ' + name + ': ' + JSON.stringify(made.json));
    }
    const S = await login('sam', 'sam-password-1');
    const K = await login('kim', 'kim-password-1');

    const tree0 = (await api('/api/tree', { token: A })).json;
    const bmRoot = tree0.roots.find(r => r.role === 'bookmarks');
    const bulk = Array.from({ length: 700 }, (_, i) => bm(`bulk-${i}`, `Bulk page ${i}`, `https://bulk.example/${i}`));
    const alexRoots = [
        folder(bmRoot.id, 'Bookmarks', [
            folder('f-tech', 'Tech', [folder('f-ai', 'AI', [bm('b-paper', 'A paper', 'https://arxiv.org/abs/1')]),
                bm('b-hn', 'Hacker News', 'https://news.ycombinator.com'), bm('b-lob', 'Lobsters', 'https://lobste.rs')]),
            folder('f-inbox', 'Inbox', [bm('b-mdn', 'MDN', 'https://developer.mozilla.org'), bm('b-old', 'Old thing', 'https://old.example')]),
            folder('f-empty', 'Empty'),
            folder('f-bulk', 'Bulk', bulk)
        ], { role: 'bookmarks' }),
        folder('f-pins', 'Pinned', [bm('b-pin', 'Pinned site', 'https://pin.example')], { role: 'pins' }),
        folder('f-wf', 'Workflows', [folder('f-wf1', 'Morning', [bm('b-tab', 'Mail', 'https://mail.example')])], { role: 'workflows' }),
        folder('f-notes', 'Notes', [folder('f-recipes', 'Recipes', [
            { id: 'n-groc', kind: 'note', title: 'Groceries', payload: { content: '# Groceries\n\n- milk\n- oat flakes', createdAt: T, updatedAt: T } }])],
        { role: 'notes' })
    ];
    const put = await api('/api/tree', { method: 'PUT', token: A, body: { roots: alexRoots, baseVersion: tree0.version } });
    if (put.status !== 200) throw new Error('alex push: ' + put.text);
    const samTree = (await api('/api/tree', { token: S })).json;
    const samRoots = [folder('s-bm', 'Bookmarks', [folder('s-secret', 'Sam secret folder', [bm('s-b1', 'Sam secret bookmark', 'https://sam-secret.example')])], { role: 'bookmarks' })];
    if ((await api('/api/tree', { method: 'PUT', token: S, body: { roots: samRoots, baseVersion: samTree.version } })).status !== 200) throw new Error('sam push');

    console.log('\n3. The page');
    const link = (await api('/api/share', { method: 'POST', token: A })).json;
    const L = new URL(link.url).pathname;
    const page = await api(L);
    check('the page is plain text', page.status === 200 && /^text\/plain/.test(page.type), page.type);
    check('it says how to propose, for notes and for bookmarks', page.text.includes(`POST ${BASE}${L}/propose`)
        && page.text.includes('"action": "create_folder"') && page.text.includes('"action": "move"') && page.text.includes('"action": "delete"')
        && page.text.includes('#changes=') && /NEVER claim a note or bookmark was saved/.test(page.text));
    check('every folder with its id and path', page.text.includes(`[${bmRoot.id}] Bookmarks (4 folders)`)
        && page.text.includes('[f-tech] Bookmarks / Tech (1 folder, 2 bookmarks)') && page.text.includes('[f-ai] Bookmarks / Tech / AI (1 bookmark)')
        && page.text.includes('[f-empty] Bookmarks / Empty (empty)'), page.text.slice(page.text.indexOf('## Bookmark folders'), page.text.indexOf('## Bookmark folders') + 600));
    check('bookmarks with their ids, titles and addresses, under their folder',
        page.text.includes('### Bookmarks / Tech [f-tech]') && page.text.includes('- [b-hn] Hacker News — https://news.ycombinator.com'));
    check('Pinned and Workflows are there, read-only; notes are not listed as bookmarks',
        page.text.includes('[f-pins] Pinned (1 bookmark) — read-only') && page.text.includes('[f-wf1] Workflows / Morning (1 bookmark) — read-only')
        && !page.text.includes('[f-notes]') && !page.text.includes('[f-recipes]'));
    check('only the first 300 bookmarks, with a TRUNCATED note naming the pages',
        page.text.includes('## Bookmarks (707, the first 300 shown)') && page.text.includes('(TRUNCATED: 407 more bookmarks')
        && page.text.includes(`${BASE}${L}/bookmarks?page=1 … ?page=2`) && !page.text.includes('[bulk-699]'));
    check('the notes section is as it was', page.text.includes('## Existing notes (1)\n\n### 📓 Notebook: Recipes\n\n#### Groceries\n\n# Groceries\n\n- milk'));
    check('the page is bounded', page.text.length < 200 * 1024, String(page.text.length));
    check('nothing of sam\'s', !/sam-secret|Sam secret|s-secret/.test(page.text));
    const p2 = await api(L + '/bookmarks?page=2');
    check('page 2 has the rest, and says it is the last', p2.status === 200 && p2.text.includes('page 2 of 2 (707 bookmarks)')
        && p2.text.includes('- [bulk-699] Bulk page 699 — https://bulk.example/699') && p2.text.includes('(This is the last page.)')
        && !p2.text.includes('[b-hn]'));
    const p1 = await api(L + '/bookmarks?page=1');
    check('page 1 points to page 2', p1.text.includes(`Next page: GET ${BASE}${L}/bookmarks?page=2`) && p1.text.includes('[b-hn]'));
    check('a page past the end is the last page', (await api(L + '/bookmarks?page=99')).text.includes('page 2 of 2'));
    const ft = await api(L + '/folder/f-tech');
    check('a folder view lists its folders and bookmarks', ft.status === 200 && ft.text.includes('# Folder Bookmarks / Tech [f-tech]')
        && ft.text.includes('[f-ai] Bookmarks / Tech / AI (1 bookmark)') && ft.text.includes('- [b-lob] Lobsters — https://lobste.rs')
        && !ft.text.includes('[b-paper]'));
    const fb = await api(L + '/folder/f-bulk?offset=650');
    check('  paged past 1000 with an offset', fb.text.includes('- [bulk-650]') && !fb.text.includes('[bulk-649]'));
    check('  an unknown folder is 404, and so is sam\'s', (await api(L + '/folder/nope')).status === 404 && (await api(L + '/folder/s-secret')).status === 404);
    const sr = await api(L + '/search?q=' + encodeURIComponent('hacker news'));
    check('search finds bookmarks by title', sr.text.includes('- [b-hn] Hacker News') && sr.text.includes('(in Bookmarks / Tech)'));
    check('  and notes by their text, and folders by name',
        (await api(L + '/search?q=oat')).text.includes('Groceries (notebook: Recipes)') && (await api(L + '/search?q=tech')).text.includes('[f-tech] Bookmarks / Tech'));
    check('  never another account\'s', !(await api(L + '/search?q=secret')).text.includes('Sam secret'));
    check('  and says how to use it without a query', (await api(L + '/search')).text.includes('Add ?q=<words>'));
    check('a made-up link is gone (410)', (await api('/llm/not-a-real-token')).status === 410 && (await api('/llm/not-a-real-token/bookmarks')).status === 410);
    const kimLink = new URL((await api('/api/share', { method: 'POST', token: K })).json.url).pathname;
    check('kim\'s link works', (await api(kimLink)).status === 200);
    const del = await api('/api/users/' + (await api('/api/users', { token: A })).json.users.find(u => u.username === 'kim').id + '/delete',
        { method: 'POST', token: A, body: { confirm: 'kim', currentPassword: PASSWORD } });
    check('a deleted account\'s link is gone: page, search and proposals', del.status === 200 && (await api(kimLink)).status === 410
        && (await api(kimLink + '/search?q=x')).status === 410
        && (await api(kimLink + '/propose', { method: 'POST', body: { title: 'x', content: 'x' } })).status === 410, JSON.stringify(del.json));

    console.log('\n4. Proposals through the link');
    const propose = (body, path = L + '/propose') => api(path, { method: 'POST', body });
    const note = await propose({ title: 'Idea', content: '# Idea\n\nfrom a chat', notebook: 'Recipes' });
    check('a note proposal answers as it always did', note.status === 200 && note.json.status === 'pending_approval'
        && note.json.message === 'Proposal stored. It only becomes a note after the user approves it in the TabPaladin app — tell them it is waiting for approval.');
    const made = {};
    for (const [key, body] of [
        ['folder', { action: 'create_folder', parentId: 'f-tech', path: 'AI / Papers', reason: 'For the papers' }],
        ['add', { action: 'add_bookmarks', folderId: 'f-inbox', bookmarks: [{ title: 'Node docs', url: 'https://nodejs.org/docs' }, { title: 'MDN dup', url: 'https://developer.mozilla.org' }] }],
        ['move', { action: 'move', ids: ['b-old'], toFolderId: 'f-empty' }],
        ['rename', { action: 'rename', id: 'f-inbox', title: 'Reading inbox' }],
        ['delete', { action: 'delete', ids: ['b-lob'] }],
        ['batch', { action: 'changes', reason: 'Tidy', changes: [
            { op: 'create_folder', parentId: bmRoot.id, path: 'Docs', ref: 'docs' }, { op: 'move', ids: ['b-mdn'], toFolderRef: 'docs' }] }]
    ]) {
        const r = await propose(body);
        made[key] = r.json;
        check(`a ${key} proposal is stored, pending, with a preview`, r.status === 200 && r.json.status === 'pending_approval'
            && Number.isInteger(r.json.id) && Array.isArray(r.json.preview) && r.json.preview.length > 0 && /Home › Suggested changes/.test(r.json.message), r.text);
    }
    check('  the previews say what would happen', made.folder.preview.join('|') === 'New folder “Papers” in Bookmarks / Tech / AI'
        && made.add.preview.join('|') === 'Add “Node docs” (https://nodejs.org/docs) to Bookmarks / Inbox|“MDN dup” is already in Bookmarks / Inbox'
        && made.delete.preview[0].startsWith('DELETE bookmark “Lobsters”'), JSON.stringify(made));
    check('  POST to the page itself works too', (await propose({ action: 'rename', id: 'b-paper', title: 'Attention' }, L)).status === 200);
    for (const [name, body, want] of [
        ['an unknown id', { action: 'move', ids: ['nope'], toFolderId: 'f-tech' }, /no bookmark or folder with id nope/],
        ['sam\'s bookmark, from alex\'s link', { action: 'delete', ids: ['s-b1'] }, /no bookmark or folder with id s-b1/],
        ['a move into Notes', { action: 'move', ids: ['b-hn'], toFolderId: 'f-recipes' }, /inside Notes/],
        ['a folder into its own child', { action: 'move', ids: ['f-tech'], toFolderId: 'f-ai' }, /into itself/],
        ['a pin', { action: 'rename', id: 'b-pin', title: 'x' }, /inside Pinned/],
        ['a javascript: bookmark', { action: 'add_bookmarks', folderId: 'f-tech', bookmarks: [{ url: 'javascript:alert(1)' }] }, /http\(s\) address/],
        ['an unknown action', { action: 'format_disk' }, /Unknown "action"/]
    ]) {
        const r = await propose(body);
        const said = r.json ? [r.json.error, ...(r.json.problems || [])].join(' ') : r.text;
        check(`refused with the reason: ${name}`, r.status === 400 && want.test(said), said);
    }

    console.log('\n5. Review and approval');
    const legacy = (await api('/api/proposals', { token: A })).json;
    check('GET /api/proposals keeps its old answer: notes and orders only, the old fields',
        legacy.proposals.length === 1 && legacy.proposals[0].title === 'Idea'
        && Object.keys(legacy.proposals[0]).join() === 'id,title,content,notebook,kind,created_at', JSON.stringify(legacy));
    const review = async (token = A) => (await api('/api/proposals/review', { token })).json.proposals;
    let all = await review();
    const byId = (id) => all.find(p => p.id === id);
    check('/api/proposals/review has every proposal, newest first, with previews and its source',
        all.length === 8 && all[all.length - 1].kind === 'note' && byId(made.folder.id).kind === 'tree'
        && byId(made.folder.id).reason === 'For the papers' && byId(made.folder.id).source === 'link' && byId(made.folder.id).status === 'pending'
        && byId(made.delete.id).danger === true && byId(made.folder.id).danger === false, JSON.stringify(all.map(p => [p.id, p.kind, p.status])));
    check('sam sees none of it, and cannot approve or reject it', (await review(S)).length === 0
        && (await api(`/api/proposals/${made.folder.id}/approve`, { method: 'POST', token: S })).status === 404
        && (await api(`/api/proposals/${made.folder.id}/reject`, { method: 'POST', token: S })).status === 200
        && (await review()).length === 8);

    const history = async () => (await api('/api/history', { token: A })).json.snapshots;
    const treeNow = async () => (await api('/api/tree', { token: A })).json;
    const find = (roots, id) => { for (const n of roots) { if (n.id === id) return n; const h = find(n.children || [], id); if (h) return h; } return null; };
    const parentOf = (roots, id, parent = null) => { for (const n of roots) { if (n.id === id) return parent; const h = parentOf(n.children || [], id, n); if (h !== undefined) return h; } return undefined; };

    let before = await treeNow();
    let h0 = (await history()).length;
    const ok1 = await api(`/api/proposals/${made.folder.id}/approve`, { method: 'POST', token: A });
    let after = await treeNow();
    const ai = find(after.roots, 'f-ai');
    check('approving a new folder makes it, reusing AI, bumps the version and writes history',
        ok1.status === 200 && ok1.json.kind === 'tree' && after.version === ok1.json.version && after.version > before.version
        && ai.children.some(c => c.kind === 'folder' && c.title === 'Papers') && (await history()).length === h0 + 1
        && (await history())[0].device_id === 'ai-proposal', JSON.stringify([ok1.json, ai]));
    check('  and the proposal is gone', !(await review()).some(p => p.id === made.folder.id));
    for (const key of ['add', 'move', 'delete', 'batch']) {
        const r = await api(`/api/proposals/${made[key].id}/approve`, { method: 'POST', token: A });
        check(`approving the ${key} proposal applies it`, r.status === 200, r.text);
    }
    after = await treeNow();
    const inbox = find(after.roots, 'f-inbox');
    check('  new bookmarks added once (the duplicate skipped), moves made, the delete done, the batch\'s folder holds what it moved',
        inbox.children.filter(c => c.url === 'https://developer.mozilla.org').length === 0
        && inbox.children.some(c => c.title === 'Node docs' && c.url === 'https://nodejs.org/docs')
        && parentOf(after.roots, 'b-old').id === 'f-empty' && !find(after.roots, 'b-lob')
        && parentOf(after.roots, 'b-mdn').title === 'Docs' && parentOf(after.roots, parentOf(after.roots, 'b-mdn').id).id === bmRoot.id,
        JSON.stringify(inbox));

    // Out of date: renamed elsewhere before approval.
    all = await review();
    const renameP = all.find(p => p.kind === 'tree' && /Rename folder “Inbox”/.test(p.title));
    before = await treeNow();
    find(before.roots, 'f-inbox').title = 'Inbox (laptop)';
    const pushed = await api('/api/tree', { method: 'PUT', token: A, body: { roots: before.roots, baseVersion: before.version } });
    all = await review();
    const staleP = all.find(p => p.id === renameP.id);
    check('a proposal whose folder was renamed since is shown stale, with why', pushed.status === 200 && staleP.status === 'stale'
        && staleP.stale.some(s => /folder “Inbox” was renamed to “Inbox \(laptop\)”/.test(s)), JSON.stringify(staleP));
    const v0 = (await treeNow()).version;
    h0 = (await history()).length;
    const refused = await api(`/api/proposals/${renameP.id}/approve`, { method: 'POST', token: A });
    check('  approving it is refused (409 stale) and changes nothing', refused.status === 409 && refused.json.code === 'stale'
        && refused.json.stale.length > 0 && (await treeNow()).version === v0 && (await history()).length === h0
        && find((await treeNow()).roots, 'f-inbox').title === 'Inbox (laptop)' && (await review()).some(p => p.id === renameP.id), refused.text);
    check('  rejecting it drops it', (await api(`/api/proposals/${renameP.id}/reject`, { method: 'POST', token: A })).status === 200
        && !(await review()).some(p => p.id === renameP.id));

    // Never half-applied: a batch whose second change went stale makes no folder either.
    const half = (await propose({ action: 'changes', changes: [
        { op: 'create_folder', parentId: 'f-tech', path: 'Half', ref: 'h' }, { op: 'move', ids: ['b-hn'], toFolderRef: 'h' }] })).json;
    before = await treeNow();
    const techNow = find(before.roots, 'f-tech');
    techNow.children = techNow.children.filter(c => c.id !== 'b-hn');
    await api('/api/tree', { method: 'PUT', token: A, body: { roots: before.roots, baseVersion: before.version } });
    const v1 = (await treeNow()).version;
    const halfR = await api(`/api/proposals/${half.id}/approve`, { method: 'POST', token: A });
    check('a batch whose bookmark was deleted since is refused whole: no folder made, no version moved',
        halfR.status === 409 && (await treeNow()).version === v1 && !JSON.stringify((await treeNow()).roots).includes('"Half"')
        && halfR.json.stale.some(s => /bookmark “Hacker News” is no longer there/.test(s)), halfR.text);
    await api(`/api/proposals/${half.id}/reject`, { method: 'POST', token: A });

    // Notes still approve as before.
    const noteP = (await review()).find(p => p.kind === 'note');
    const noteR = await api(`/api/proposals/${noteP.id}/approve`, { method: 'POST', token: A });
    check('a note proposal approves as before', noteR.status === 200 && JSON.stringify((await treeNow()).roots).includes('from a chat'));

    // The web app's #changes= path: the signed-in app files a chat's changes.
    const filed = await api('/api/proposals', { method: 'POST', token: A, body: { reason: 'From a link', changes: [{ op: 'create_folder', parentId: 'f-empty', path: 'Linked' }] } });
    check('POST /api/proposals files bookmark changes for review, nothing applied', filed.status === 200 && filed.json.kind === 'tree'
        && (await review()).some(p => p.id === filed.json.id && p.reason === 'From a link') && !JSON.stringify((await treeNow()).roots).includes('Linked'));
    check('  but not notes, and not without a session', (await api('/api/proposals', { method: 'POST', token: A, body: { title: 'x', content: 'y' } })).status === 400
        && (await api('/api/proposals', { method: 'POST', body: { changes: [{ op: 'delete', ids: ['b-old'] }] } })).status === 401);
    check('  and not another account\'s ids', (await api('/api/proposals', { method: 'POST', token: S, body: { changes: [{ op: 'delete', ids: ['b-old'] }] } })).status === 400);

    console.log('\n5b. What review found');
    const reject = (id) => api(`/api/proposals/${id}/reject`, { method: 'POST', token: A });
    const approveP = (id, body) => api(`/api/proposals/${id}/approve`, { method: 'POST', token: A, ...(body ? { body } : {}) });
    const pushRoots = async (change) => {
        const t = await treeNow();
        change(t.roots);
        const r = await api('/api/tree', { method: 'PUT', token: A, body: { roots: t.roots, baseVersion: t.version } });
        if (r.status !== 200) throw new Error('push: ' + r.text);
    };

    // A delete hidden after 60 other lines is flagged, listed and named in the title.
    const lateDel = await propose({ action: 'changes', changes: [
        { op: 'add_bookmarks', folderId: 'f-tech', bookmarks: Array.from({ length: 61 }, (_, i) => ({ title: `Late ${i}`, url: `https://late.example/${i}` })) },
        { op: 'delete', ids: ['f-ai'] }] });
    const lateRow = (await review()).find(p => p.id === lateDel.json.id);
    check('a delete after 61 new bookmarks is flagged as a delete, its line shown, the rest counted',
        lateDel.status === 200 && lateRow.danger === true && lateRow.status === 'pending'
        && lateRow.preview.filter(l => l.danger).length === 1 && /^DELETE folder “AI” from Bookmarks \/ Tech with everything in it/.test(lateRow.preview.find(l => l.danger).text)
        && /none of them a deletion/.test(lateRow.preview[lateRow.preview.length - 1].text) && /1 DELETED/.test(lateRow.title), JSON.stringify(lateRow).slice(0, 400));
    await reject(lateDel.json.id);

    // Approving checks what the user was shown.
    const mvOld = await propose({ action: 'move', ids: ['b-old'], toFolderId: 'f-ai' });
    const shown = (await review()).find(p => p.id === mvOld.json.id);
    await pushRoots((roots) => { find(roots, 'f-tech').title = 'Technology'; });
    const nowShown = (await review()).find(p => p.id === mvOld.json.id);
    check('a suggestion whose lines read otherwise since stays pending, retitled by what it would do now',
        shown.status === 'pending' && nowShown.status === 'pending' && typeof shown.reviewKey === 'string' && nowShown.reviewKey !== shown.reviewKey
        && nowShown.title === 'Move bookmark “Old thing” from Bookmarks / Empty to Bookmarks / Technology / AI', JSON.stringify([shown.title, nowShown.title]));
    let vNow = (await treeNow()).version;
    const changedR = await approveP(mvOld.json.id, { reviewed: shown.reviewKey });
    check('  approving the preview shown before is refused (409 changed) and applies nothing', changedR.status === 409 && changedR.json.code === 'changed'
        && (await treeNow()).version === vNow && parentOf((await treeNow()).roots, 'b-old').id === 'f-empty', changedR.text);
    const okR = await approveP(mvOld.json.id, { reviewed: nowShown.reviewKey });
    check('  approving the preview shown now applies it', okR.status === 200 && parentOf((await treeNow()).roots, 'b-old').id === 'f-ai', okR.text);

    // A folder delete goes stale when what is in it changes; approving a
    // delete keeps a history version from before it.
    const delEmpty = await propose({ action: 'delete', ids: ['f-empty'] });
    check('a delete of an empty folder says so', delEmpty.status === 200 && delEmpty.json.preview[0] === 'DELETE folder “Empty” from Bookmarks (empty)', delEmpty.text);
    const sid = 'llm-api-filed-0001';
    const intake = await api('/api/shares', { method: 'POST', token: A, body: { sid, url: 'https://filed.example/only-in-the-log', title: 'Filed into Empty' } });
    const filedR = await api(`/api/shares/${sid}/file`, { method: 'POST', token: A, body: { targets: [{ folderId: 'f-empty' }] } });
    if (intake.status !== 200 || filedR.status !== 200) throw new Error('filing: ' + intake.text + ' ' + filedR.text);
    const staleDel = (await review()).find(p => p.id === delEmpty.json.id);
    check('  a link filed into it since makes it out of date, and keeps its old title', staleDel.status === 'stale'
        && staleDel.stale.some(s => /What is in the folder “Empty” changed since \(0 item\(s\) then, 1 now\)/.test(s))
        && staleDel.title === 'DELETE folder “Empty” from Bookmarks (empty)', JSON.stringify(staleDel));
    vNow = (await treeNow()).version;
    const staleR = await approveP(delEmpty.json.id);
    check('  approving it is refused and deletes nothing', staleR.status === 409 && staleR.json.code === 'stale'
        && (await treeNow()).version === vNow && JSON.stringify((await treeNow()).roots).includes('only-in-the-log'), staleR.text);
    await reject(delEmpty.json.id);
    const delAgain = await propose({ action: 'delete', ids: ['f-empty'] });
    const againRow = (await review()).find(p => p.id === delAgain.json.id);
    const h1 = (await history()).length;
    const delR = await approveP(delAgain.json.id, { reviewed: againRow.reviewKey });
    const hist = await history();
    const snap = async (id) => JSON.stringify((await api(`/api/history/${id}`, { token: A })).json.snapshot);
    const holding = [];
    for (const h of hist) if ((await snap(h.id)).includes('only-in-the-log')) holding.push(h.device_id);
    check('approving a delete keeps a history version from before it, with the link filed since',
        againRow.preview[0].text === 'DELETE folder “Empty” from Bookmarks with everything in it: 1 bookmark(s), 0 folder(s)'
        && delR.status === 200 && !find((await treeNow()).roots, 'f-empty') && hist.length === h1 + 2
        && hist[0].device_id === 'ai-proposal' && hist[1].device_id === 'before-ai-proposal' && holding.join() === 'before-ai-proposal',
        JSON.stringify([againRow.preview, delR.json, hist.slice(0, 3), holding]));

    // Refusals are bounded, and a note body is a note whatever it guessed.
    const flood = await propose({ action: 'changes', changes: Array.from({ length: 50 }, (_, i) => ({
        op: 'move', ids: Array.from({ length: 200 }, (_, j) => `nope-${i}-${j}`), toFolderId: 'f-tech' })) });
    check('a proposal naming 10000 unknown ids is refused with 50 problems and a count of the rest', flood.status === 400
        && flood.json.problems.length === 51 && flood.json.problems[50] === '… and 9950 more problems.' && flood.text.length < 20 * 1024,
        `${flood.status} ${flood.text.length}`);
    const guessedNote = await propose({ action: 'create', title: 'Guessed', content: '# Guessed\n\n- milk' });
    const guessedRow = (await review()).find(p => p.kind === 'note' && p.title === 'Guessed');
    check('a note posted with a guessed "action" is stored as a note, as before', guessedNote.status === 200
        && guessedNote.json.status === 'pending_approval' && Boolean(guessedRow), guessedNote.text);
    if (guessedRow) await reject(guessedRow.id);

    console.log('\n6. The cap');
    const samLink = new URL((await api('/api/share', { method: 'POST', token: S })).json.url).pathname;
    let cap = null;
    for (let i = 0; i < CAP + 5 && cap === null; i++) {
        const r = await propose({ action: 'rename', id: 's-b1', title: `Name ${i}` }, samLink + '/propose');
        if (r.status === 429) cap = i;
    }
    check(`proposals past MAX_PROPOSALS_PER_USER (${CAP}) are refused with 429`, cap === CAP, String(cap));
    check('  also when the request is malformed, and it never counts alex\'s', (await propose({ action: 'nope' }, samLink + '/propose')).status === 429
        && (await propose({ action: 'rename', id: 'b-old', title: 'still room' })).status === 200);
    check('  sam\'s page never lists alex\'s things', !/Hacker News|f-tech|Groceries/.test((await api(samLink)).text));
} catch (e) {
    failures++;
    console.error('FAIL  run stopped:', e, '\n' + serverLog);
} finally {
    server.kill();
    await exited;
    try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) { /* temp */ }
}

if (/TypeError|ReferenceError|SyntaxError/.test(serverLog)) {
    failures++;
    console.error('FAIL  the server logged an error:\n' + serverLog);
}
console.log(failures === 0 ? '\nAll LLM API tests passed.\n' : `\n${failures} test(s) failed.\n`);
process.exitCode = failures === 0 ? 0 : 1;
