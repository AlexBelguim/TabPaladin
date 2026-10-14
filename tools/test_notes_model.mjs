// Unit tests for the shared notes model (src/utils/notesModel.js and its
// byte-identical twin pwa/lib/notesModel.js).
//
// What this locks down:
//   1. The two copies are byte-identical — the extension and the PWA must
//      agree on tree, counts, previews, search, recency and the title rule.
//   2. Every export, against one fixture: Work > Standup; Work > Meetings >
//      Q4 planning; Recipes > Meetings > Bake-off; an empty notebook; unfiled
//      Groceries and Ideas; tasks; a note without timestamps; sentinels.
//   3. buildLibrary gives the same answers through an extension-shaped and a
//      PWA-shaped adapter.
//
// Run: node tools/test_notes_model.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import * as NM from '../src/utils/notesModel.js';
import * as PWA_NM from '../pwa/lib/notesModel.js';

let failures = 0;
function check(name, cond, detail) {
    if (cond) {
        console.log(`  ok  ${name}`);
    } else {
        failures++;
        console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const here = path.dirname(fileURLToPath(import.meta.url));

console.log('\n1. The twins are byte-identical');
const extBytes = readFileSync(path.join(here, '../src/utils/notesModel.js'));
const pwaBytes = readFileSync(path.join(here, '../pwa/lib/notesModel.js'));
check('src/utils/notesModel.js === pwa/lib/notesModel.js', Buffer.compare(extBytes, pwaBytes) === 0,
    'copy one over the other');
check('no BOM', extBytes[0] !== 0xef);
check('LF line endings only', !extBytes.includes(0x0d));
check('no imports (the PWA serves it standalone)', !/^\s*import\s/m.test(extBytes.toString('utf8')));
check('both copies export the same names', eq(Object.keys(NM).sort(), Object.keys(PWA_NM).sort()));

// --- fixture ------------------------------------------------------------------

// Local-time instants, so the recency checks hold in every time zone.
const NOW = new Date(2026, 9, 13, 12, 0, 0);
const at = (y, mo, d, h = 12, mi = 0, s = 0) => new Date(y, mo, d, h, mi, s).toISOString();
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const extRoot = {
    id: 'nr', kind: 'folder', title: 'TabPaladin Notes', role: 'notes', children: [
        { id: 'n-groc', kind: 'note', title: 'Groceries', payload: {
            content: '# Groceries\n- [ ] milk\n- [x] eggs\n- [ ] bread',
            createdAt: at(2026, 9, 1), updatedAt: ago(DAY) } },
        { id: 'n-ideas', kind: 'note', title: 'Ideas', payload: {
            content: 'Try the **Crème brûlée** from https://www.example.com/r/1 and `code` with [[Bake-off]]',
            createdAt: at(2026, 9, 1), updatedAt: ago(3 * DAY) } },
        { id: 'nb-work', kind: 'folder', title: 'Work', children: [
            { id: 'n-standup', kind: 'note', title: 'Standup', payload: {
                content: 'Daily notes, nothing open.', createdAt: at(2026, 8, 1), updatedAt: ago(40 * DAY) } },
            { id: 'nb-wmeet', kind: 'folder', title: 'Meetings', children: [
                { id: 'n-q4', kind: 'note', title: 'Q4 planning', payload: {
                    content: '# Q4 planning\n- [ ] budget\n- [x] hiring\n\nAgenda: review the roadmap with the whole team before Friday.',
                    createdAt: at(2026, 9, 10), updatedAt: ago(5 * MIN) } }
            ]}
        ]},
        { id: 'nb-recipes', kind: 'folder', title: 'Recipes', children: [
            { id: 'nb-rmeet', kind: 'folder', title: 'Meetings', children: [
                // No timestamps at all; hostile-looking content.
                { id: 'n-bake', kind: 'note', title: 'Bake-off', payload: {
                    content: 'Judges <script>alert(1)</script> & "quotes" [[<b>]]' } }
            ]}
        ]},
        { id: 'nb-empty', kind: 'folder', title: 'Empty', children: [] },
        { id: 's-meta', kind: 'note', title: '__tabpaladin_meta__', payload: { content: '{}' } },
        { id: 's-root', kind: 'note', title: '__tabpaladin_root__', payload: { content: '' } }
    ]
};

const extAdapter = {
    children: (n) => n.children || [],
    isFolder: (n) => n.kind === 'folder',
    isNote: (n) => n.kind === 'note',
    id: (n) => n.id,
    title: (n) => n.title,
    fields: (n) => n.payload || {}
};

// The PWA keeps notes as bookmarks with a data:application/json url and ids
// as _pwaId (see pwa/app.js fromWire); its adapter decodes on the way in.
const DATA = 'data:application/json,';
function toPwa(node) {
    const out = { title: node.title, _pwaId: node.id };
    if (node.kind === 'note') {
        out.type = 'bookmark';
        out.url = DATA + encodeURIComponent(JSON.stringify({ v: 1, ...(node.payload || {}) }));
    } else {
        out.type = 'folder';
        out.children = (node.children || []).map(toPwa);
    }
    return out;
}
const pwaRoot = toPwa(extRoot);
const pwaAdapter = {
    children: (n) => n.children || [],
    isFolder: (n) => n.type === 'folder' || n.type === 'root',
    isNote: (n) => n.type === 'bookmark' && typeof n.url === 'string' && n.url.startsWith(DATA)
        && !NM.SENTINEL_TITLES.has(n.title),
    id: (n) => n._pwaId,
    title: (n) => n.title || '',
    fields: (n) => {
        try {
            const p = JSON.parse(decodeURIComponent(n.url.slice(DATA.length)));
            return { content: p.content || '', createdAt: p.createdAt || null, updatedAt: p.updatedAt || null };
        } catch (e) {
            return { content: '', createdAt: null, updatedAt: null };
        }
    }
};

console.log('\n2. Markdown helpers (moved unchanged)');
check('parseLinks finds wiki links and urls',
    eq(NM.parseLinks('see [[A]] and [[ B ]] at https://x.test/y'), { wiki: ['A', 'B'], urls: ['https://x.test/y'] }));
check('parseTaskLine reads a bare box', eq(NM.parseTaskLine('[x] done'), { indent: 0, checked: true, label: 'done' }));
check('toggleTaskAtLine flips only the box',
    NM.toggleTaskAtLine('a\n  * [ ] b c\nd', 1) === 'a\n  * [x] b c\nd');
check('rewriteWikiLink rewrites every [[Old]]',
    NM.rewriteWikiLink('[[Old]] and [[ Old ]] not [[Older]]', 'Old', 'New') === '[[New]] and [[New]] not [[Older]]');

console.log('\n3. taskStats');
check('counts open, done, total', eq(NM.taskStats('- [ ] a\n- [x] b\n[ ] c\ntext'), { open: 2, done: 1, total: 3 }));
check('CRLF content counts too', eq(NM.taskStats('- [ ] a\r\n- [X] b\r\n'), { open: 1, done: 1, total: 2 }));
check('no tasks', eq(NM.taskStats(''), { open: 0, done: 0, total: 0 }));

console.log('\n4. plainPreview');
check('Groceries reads as a list', NM.plainPreview(extRoot.children[0].payload.content, 'Groceries') === 'milk · eggs · bread',
    NM.plainPreview(extRoot.children[0].payload.content, 'Groceries'));
check('a leading H1 equal to the title is dropped (ignoring case)',
    NM.plainPreview('# groceries\nmilk', 'Groceries') === 'milk');
check('a leading H1 that differs from the title stays',
    NM.plainPreview('# Old name\nbody', 'New name') === 'Old name · body', NM.plainPreview('# Old name\nbody', 'New name'));
const ideas = NM.plainPreview(extRoot.children[1].payload.content, 'Ideas');
check('bold, code, [[a]] and URLs stripped to text and host',
    ideas === 'Try the Crème brûlée from example.com and code with Bake-off', ideas);
check('URL shown as its host', ideas.includes('example.com') && !ideas.includes('https://') && !ideas.includes('www.'), ideas);
check('markdown links keep their label', NM.plainPreview('see [the docs](https://a.test/x)') === 'see the docs');
check('empty content gives an empty preview', NM.plainPreview('', 'X') === '' && NM.plainPreview('# X', 'X') === '');
const long = NM.plainPreview('word '.repeat(100), '');
check('long previews end in an ellipsis within 160 characters', long.length <= 160 && long.endsWith('…'), String(long.length));
check('custom max', NM.plainPreview('abcdefghij', '', 5).length <= 5);
check('prose lines join with a space, list items with a dot',
    NM.plainPreview('first line\nsecond line\n- item', '') === 'first line second line · item',
    NM.plainPreview('first line\nsecond line\n- item', ''));

console.log('\n5. relativeTime and recencyBucket');
const rt = (iso, now = NOW) => NM.relativeTime(iso, now);
check('59s -> now', rt(ago(59 * 1000)) === 'now');
check('a future stamp (clock skew) -> now', rt(new Date(NOW.getTime() + 5 * MIN).toISOString()) === 'now');
check('60s -> 1m', rt(ago(60 * 1000)) === '1m');
check('59m -> 59m', rt(ago(59 * MIN)) === '59m');
check('same day -> hours', rt(ago(3 * HOUR)) === '3h');
const oneAm = new Date(2026, 9, 13, 1, 0, 0);
check('three hours ago but yesterday -> Yesterday', rt(new Date(2026, 9, 12, 22, 0).toISOString(), oneAm) === 'Yesterday');
check('yesterday -> Yesterday', rt(ago(DAY)) === 'Yesterday');
check('6 days -> weekday', rt(at(2026, 9, 7)) === 'Wed', rt(at(2026, 9, 7)));
check('29 days -> day month', rt(at(2026, 8, 14)) === '14 Sep', rt(at(2026, 8, 14)));
check('last year -> day month year', rt(at(2025, 2, 12)) === '12 Mar 2025', rt(at(2025, 2, 12)));
check('missing -> empty', rt(null) === '' && rt('') === '' && rt('garbage') === '');
check('accepts a Date or a number for now', NM.relativeTime(ago(2 * MIN), NOW.getTime()) === '2m');
check('meta line with tasks', NM.noteMetaLine({ updatedAt: ago(2 * HOUR), tasks: { open: 2, done: 1, total: 3 } }, NOW)
    === 'Edited 2h ago · 1 of 3 done');
check('meta line phrasing', NM.noteMetaLine({ updatedAt: ago(10 * 1000) }, NOW) === 'Edited just now'
    && NM.noteMetaLine({ updatedAt: ago(DAY) }, NOW) === 'Edited yesterday'
    && NM.noteMetaLine({ updatedAt: at(2026, 8, 14) }, NOW) === 'Edited 14 Sep');
check('meta line without a stamp or tasks is empty', NM.noteMetaLine({ updatedAt: null, tasks: { total: 0 } }, NOW) === '');

const rb = (iso) => NM.recencyBucket(iso, NOW);
check('bucket Today', rb(ago(5 * MIN)) === 'Today');
check('bucket Yesterday', rb(ago(DAY)) === 'Yesterday');
check('bucket 6 days -> Previous 7 days', rb(at(2026, 9, 7)) === 'Previous 7 days');
check('bucket 7 days -> Previous 7 days', rb(at(2026, 9, 6)) === 'Previous 7 days');
check('bucket 8 days -> Previous 30 days', rb(at(2026, 9, 5)) === 'Previous 30 days');
check('bucket 29 days -> Previous 30 days', rb(at(2026, 8, 14)) === 'Previous 30 days');
check('bucket 31 days -> Older', rb(at(2026, 8, 12)) === 'Older');
check('bucket last year -> Older', rb(at(2025, 2, 12)) === 'Older');
check('bucket missing -> Undated', rb(null) === 'Undated');
check('every bucket is listed in order', eq(NM.RECENCY_BUCKETS,
    ['Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days', 'Older', 'Undated']));

console.log('\n6. leadingTitle and resolveTitleOnSave');
check('first line only', NM.leadingTitle('\n\n# A\n# B') === 'A');
check('a later # is only a heading', NM.leadingTitle('intro\n# A') === null);
check('## is not a title', NM.leadingTitle('## A') === null);
check('blank H1 is no title', NM.leadingTitle('#   \nx') === null);
check('CRLF first line', NM.leadingTitle('# A\r\nb') === 'A');

const R = NM.resolveTitleOnSave;
check('rule 1: a changed title field renames and rewrites the old first line',
    eq(R({ storedTitle: 'Old', loadedContent: '# Old\nbody', newContent: '# Old\nbody!', titleField: 'New' }),
        { title: 'New', content: '# New\nbody!' }));
check('rule 1: first line kept when it no longer carries the old title',
    eq(R({ storedTitle: 'Old', loadedContent: 'body', newContent: '# Other\nbody', titleField: 'New' }),
        { title: 'New', content: '# Other\nbody' }));
check('rule 1: no H1 means nothing to rewrite',
    eq(R({ storedTitle: 'Old', loadedContent: 'body', newContent: 'body', titleField: 'New' }),
        { title: 'New', content: 'body' }));
check('rule 1: a blank field means Untitled',
    R({ storedTitle: 'Old', loadedContent: 'x', newContent: 'x', titleField: '  ' }).title === 'Untitled');
check('rule 1: a rename leaves an opening heading that is not the title alone',
    eq(R({ storedTitle: 'Recipes', loadedContent: '# Pasta\n- spaghetti', newContent: '# Pasta\n- spaghetti', titleField: 'Italian recipes' }),
        { title: 'Italian recipes', content: '# Pasta\n- spaghetti' }));
check('rule 1: a pure rename of a diverged note leaves its stale H1 alone',
    eq(R({ storedTitle: 'New', loadedContent: '# Old\nb', newContent: '# Old\nb', titleField: 'Newer' }),
        { title: 'Newer', content: '# Old\nb' }));
check('rule 1: the title line matches ignoring case',
    eq(R({ storedTitle: 'alpha', loadedContent: '# Alpha\nb', newContent: '# Alpha\nb', titleField: 'Beta' }),
        { title: 'Beta', content: '# Beta\nb' }));
check('rule 2: editing the first-line H1 renames',
    eq(R({ storedTitle: 'Old', loadedContent: '# Old\nb', newContent: '# Fresh\nb' }), { title: 'Fresh', content: '# Fresh\nb' }));
check('rule 2: an unchanged title field does not block it',
    R({ storedTitle: 'Old', loadedContent: '# Old\nb', newContent: '# Fresh\nb', titleField: 'Old' }).title === 'Fresh');
check('rule 2: editing an opening heading that is not the title never renames',
    eq(R({ storedTitle: 'Recipes', loadedContent: '# Pasta\n- spaghetti', newContent: '# Pasta carbonara\n- spaghetti' }),
        { title: 'Recipes', content: '# Pasta carbonara\n- spaghetti' }));
check('rule 2: ... nor through an untouched title field',
    R({ storedTitle: 'Recipes', loadedContent: '# Pasta\nx', newContent: '# Pasta carbonara\nx', titleField: 'Recipes' }).title === 'Recipes');
check('rule 2: a heading added to a titled note is only a heading',
    R({ storedTitle: 'Plan', loadedContent: 'intro', newContent: '# Week 1\nintro' }).title === 'Plan');
check('rule 2: an Untitled note takes the H1 it gains',
    R({ storedTitle: 'Untitled', loadedContent: 'milk', newContent: '# Groceries\nmilk' }).title === 'Groceries');
check('rule 2: a case-only edit of the title line renames',
    R({ storedTitle: 'alpha', loadedContent: '# alpha\nb', newContent: '# Alpha\nb' }).title === 'Alpha');
check('rule 3: a diverged legacy note keeps its stored title',
    R({ storedTitle: 'New', loadedContent: '# Old\nbody', newContent: '# Old\nbody edited' }).title === 'New');
check('rule 3: a later # Section never renames',
    R({ storedTitle: 'Plan', loadedContent: 'intro', newContent: 'intro\n# Section' }).title === 'Plan');
check('rule 3: a new note takes its H1', R({ storedTitle: null, loadedContent: '', newContent: '# Hello\nx' }).title === 'Hello');
check('rule 3: a new note with no H1 is Untitled', R({ storedTitle: null, loadedContent: '', newContent: 'just text' }).title === 'Untitled');
check('rule 3: a wikilink-prefilled note keeps its title',
    R({ storedTitle: '', loadedContent: '# Target\n\n', newContent: '# Target\n\nbody' }).title === 'Target');
check('rule 1: a prefilled draft renamed in its field rewrites its title line',
    eq(R({ storedTitle: 'Target', loadedContent: '# Target\n\n', newContent: '# Target\n\nbody', titleField: 'Target 2' }),
        { title: 'Target 2', content: '# Target 2\n\nbody' }));
check('leading blank lines are preserved on rewrite',
    R({ storedTitle: 'A', loadedContent: '\n# A\nb', newContent: '\n# A\nb', titleField: 'B' }).content === '\n# B\nb');

console.log('\n7. normalizeForSearch');
check('lower case, diacritics removed', NM.normalizeForSearch('Crème Brûlée ÅNGSTRÖM') === 'creme brulee angstrom');
check('nullish is empty', NM.normalizeForSearch(null) === '');

console.log('\n8. buildLibrary (extension adapter, then PWA adapter)');
function checkLibrary(label, lib) {
    const work = lib.notebooks.get('nb-work');
    const wmeet = lib.notebooks.get('nb-wmeet');
    const rmeet = lib.notebooks.get('nb-rmeet');
    check(`${label}: notes root id`, lib.rootId === 'nr');
    check(`${label}: same-named notebooks stay distinct`,
        wmeet && rmeet && wmeet.id !== rmeet.id
        && eq(wmeet.path, ['Work', 'Meetings']) && eq(rmeet.path, ['Recipes', 'Meetings']));
    check(`${label}: depth and parent`, wmeet.depth === 1 && wmeet.parentId === 'nb-work' && work.depth === 0 && work.parentId === null);
    check(`${label}: counts include sub-notebooks`, work.totalCount === 2 && work.directCount === 1, `${work.totalCount}/${work.directCount}`);
    check(`${label}: open-task notes roll up`, work.openTaskNotes === 1 && lib.notebooks.get('nb-recipes').openTaskNotes === 0);
    check(`${label}: the empty notebook is listed`, lib.notebooks.has('nb-empty') && lib.notebooks.get('nb-empty').totalCount === 0);
    check(`${label}: roots in stored order`, eq(lib.roots.map(b => b.id), ['nb-work', 'nb-recipes', 'nb-empty']));
    check(`${label}: children in stored order`, eq(work.children.map(b => b.id), ['nb-wmeet']));
    check(`${label}: sentinels excluded`, !lib.notes.some(n => n.title.startsWith('__tabpaladin')) && lib.notes.length === 5,
        lib.notes.map(n => n.title).join(', '));
    check(`${label}: counts`, eq(lib.counts, { all: 5, unfiled: 2, openTasks: 2 }), JSON.stringify(lib.counts));
    const q4 = lib.notes.find(n => n.id === 'n-q4');
    check(`${label}: a note knows its notebook path`, q4.notebookId === 'nb-wmeet' && eq(q4.path, ['Work', 'Meetings'])
        && eq(q4.pathIds, ['nb-work', 'nb-wmeet']));
    check(`${label}: preview and tasks attached`, q4.preview.startsWith('budget · hiring') && eq(q4.tasks, { open: 1, done: 1, total: 2 }), q4.preview);
    const bake = lib.notes.find(n => n.id === 'n-bake');
    check(`${label}: a note without timestamps`, bake.updatedAt === null && bake.createdAt === null);
    check(`${label}: tree order`, eq(lib.notes.map(n => n.id), ['n-groc', 'n-ideas', 'n-standup', 'n-q4', 'n-bake'])
        && lib.notes.every((n, i) => n.order === i));
}
const lib = NM.buildLibrary(extRoot, extAdapter);
checkLibrary('ext', lib);
const pwaLib = PWA_NM.buildLibrary(pwaRoot, pwaAdapter);
checkLibrary('pwa', pwaLib);
check('both adapters agree on every note', eq(
    lib.notes.map(n => [n.id, n.title, n.preview, n.tasks, n.notebookId, n.updatedAt]),
    pwaLib.notes.map(n => [n.id, n.title, n.preview, n.tasks, n.notebookId, n.updatedAt])));
check('no root -> an empty library', NM.buildLibrary(null, extAdapter).notes.length === 0
    && NM.buildLibrary(null, extAdapter).counts.all === 0);
check('updatedAt falls back to createdAt', NM.buildLibrary({ id: 'r', kind: 'folder', children: [
    { id: 'x', kind: 'note', title: 'X', payload: { content: '', createdAt: '2026-01-01T00:00:00.000Z' } }
] }, extAdapter).notes[0].updatedAt === '2026-01-01T00:00:00.000Z');
// The memo must not serve a stale preview when only the text changed.
const v1 = NM.buildLibrary({ id: 'r', kind: 'folder', children: [
    { id: 'm', kind: 'note', title: 'M', payload: { content: 'see [[Pasta]]', updatedAt: '2026-01-01T00:00:00.000Z' } }] }, extAdapter);
const v2 = NM.buildLibrary({ id: 'r', kind: 'folder', children: [
    { id: 'm', kind: 'note', title: 'M', payload: { content: 'see [[Pizza]]', updatedAt: '2026-01-01T00:00:00.000Z' } }] }, extAdapter);
check('preview memo notices a same-length rewrite', v1.notes[0].preview === 'see Pasta' && v2.notes[0].preview === 'see Pizza');

console.log('\n9. Scopes and labels');
check('all', NM.notesInScope(lib, 'all').length === 5);
check('open tasks', eq(NM.notesInScope(lib, 'tasks').map(n => n.id).sort(), ['n-groc', 'n-q4']));
check('unfiled', eq(NM.notesInScope(lib, 'unfiled').map(n => n.id), ['n-groc', 'n-ideas']));
check('a notebook lists its direct notes', eq(NM.notesInScope(lib, 'nb:nb-work').map(n => n.id), ['n-standup']));
check('deep includes sub-notebooks', eq(NM.notesInScope(lib, 'nb:nb-work', { deep: true }).map(n => n.id), ['n-standup', 'n-q4']));
check('scope labels', NM.scopeLabel(lib, 'nb:nb-wmeet') === 'Meetings' && NM.scopeLabel(lib, 'tasks') === 'Open tasks'
    && NM.scopeLabel(lib, 'unfiled') === 'Unfiled' && NM.scopeLabel(lib, 'nb:gone') === 'All notes');
check('notebookIdOf', NM.notebookIdOf('nb:abc') === 'abc' && NM.notebookIdOf('all') === null);
check('pathLabel joins', NM.pathLabel(['Work', 'Meetings']) === 'Work › Meetings');
check('pathLabel truncates from the left', NM.pathLabel(['A very long notebook name', 'Another long one', 'Meetings'], 24) === '… › Meetings',
    NM.pathLabel(['A very long notebook name', 'Another long one', 'Meetings'], 24));
check('pathLabel of nothing', NM.pathLabel([]) === '');

console.log('\n10. sortNotes');
const edited = NM.sortNotes(lib.notes, 'edited');
check('edited: newest first, undated last', eq(edited.map(n => n.id), ['n-q4', 'n-groc', 'n-ideas', 'n-standup', 'n-bake']),
    edited.map(n => n.id).join(','));
check('title: A–Z', eq(NM.sortNotes(lib.notes, 'title').map(n => n.title), ['Bake-off', 'Groceries', 'Ideas', 'Q4 planning', 'Standup']));
check('manual: tree order', eq(NM.sortNotes(edited, 'manual').map(n => n.id), lib.notes.map(n => n.id)));
const twins = [
    { id: 'a', title: 'Same', updatedAt: null, order: 0 },
    { id: 'b', title: 'same', updatedAt: null, order: 1 },
    { id: 'c', title: 'Same', updatedAt: null, order: 2 }
];
check('stable on ties (title)', eq(NM.sortNotes([twins[2], twins[0], twins[1]], 'title').map(n => n.id), ['a', 'b', 'c']));
check('stable on ties (edited)', eq(NM.sortNotes([twins[1], twins[2], twins[0]], 'edited').map(n => n.id), ['a', 'b', 'c']));
check('does not mutate its input', lib.notes[0].id === 'n-groc');
const grouped = NM.groupByRecency(edited, NOW);
check('recency groups in order', eq(grouped.map(g => g.bucket), ['Today', 'Yesterday', 'Previous 7 days', 'Older', 'Undated']),
    grouped.map(g => g.bucket).join(','));

console.log('\n11. searchNotes');
check('blank query finds nothing', NM.searchNotes(lib, '   ').length === 0);
const q4hits = NM.searchNotes(lib, 'q4');
check("'q4' finds Q4 planning", q4hits.length === 1 && q4hits[0].note.id === 'n-q4');
check('title hit ranges', eq(q4hits[0].titleRanges, [[0, 2]]));
check('every term must match (AND)', NM.searchNotes(lib, 'budget hiring').length === 1
    && NM.searchNotes(lib, 'budget nonexistent').length === 0);
check("'creme' matches 'Crème'", NM.searchNotes(lib, 'creme').some(r => r.note.id === 'n-ideas'));
check("'CRÈME' matches too", NM.searchNotes(lib, 'CRÈME').some(r => r.note.id === 'n-ideas'));
const meet = NM.searchNotes(lib, 'meetings');
check('path matches count', eq(meet.map(r => r.note.id).sort(), ['n-bake', 'n-q4']));
const ranked = NM.searchNotes({ notes: [
    { id: 'c', title: 'Other', content: 'plan', path: [], pathIds: [], updatedAt: '2026-10-13T00:00:00.000Z', order: 0 },
    { id: 'p', title: 'Plans', content: '', path: ['Planning'], pathIds: ['x'], updatedAt: '2026-10-12T00:00:00.000Z', order: 1 },
    { id: 't', title: 'My plan', content: '', path: [], pathIds: [], updatedAt: '2026-10-11T00:00:00.000Z', order: 2 },
    { id: 'x', title: 'Zed', content: '', path: ['Planning'], pathIds: ['x'], updatedAt: '2026-10-10T00:00:00.000Z', order: 3 },
    { id: 'y', title: 'Plan B', content: '', path: [], pathIds: [], updatedAt: '2026-10-09T00:00:00.000Z', order: 4 }
] }, 'plan');
check('ranking: title prefix, title contains, path, content; then recency',
    eq(ranked.map(r => r.note.id), ['p', 'y', 't', 'x', 'c']), ranked.map(r => `${r.note.id}:${r.score}`).join(','));
check('scoped to a notebook subtree', eq(NM.searchNotes(lib, 'e', { notebookId: 'nb-work' }).map(r => r.note.id).sort(), ['n-q4', 'n-standup']));
check('scoped to a candidate list', NM.searchNotes(lib, 'e', { notes: NM.notesInScope(lib, 'unfiled') })
    .every(r => !r.note.notebookId));
const snip = NM.searchNotes(lib, 'roadmap')[0].snippet;
check('snippet holds the hit', snip && snip.hit.toLowerCase() === 'roadmap', JSON.stringify(snip));
check('snippet stays within about 40 characters either side',
    snip.before.length <= 42 && snip.after.length <= 42, JSON.stringify(snip));
check('snippet skips the title line', !snip.before.includes('# Q4'));
const longNote = { notes: [{ id: 'l', title: 'L', content: 'x'.repeat(10) + ' ' + 'lorem ipsum '.repeat(20) + 'needle ' + 'dolor sit '.repeat(20),
    path: [], pathIds: [], updatedAt: null, order: 0 }] };
const ls = NM.searchNotes(longNote, 'needle')[0].snippet;
check('a long note gets ellipses on both sides', ls.before.startsWith('…') && ls.after.endsWith('…')
    && ls.before.length <= 42 && ls.after.length <= 42, JSON.stringify(ls));
const hostile = NM.searchNotes(lib, 'judges')[0];
check('HTML-like text comes back as plain data',
    hostile.snippet && (hostile.snippet.after.includes('<script>') || hostile.snippet.hit.includes('<')), JSON.stringify(hostile.snippet));
const acc = NM.searchNotes({ notes: [{ id: 'd', title: 'Déjà vu', content: '', path: [], pathIds: [], updatedAt: null, order: 0 }] }, 'deja');
check('title ranges map back through diacritics', eq(acc[0].titleRanges, [[0, 4]]));
const decomposed = 'Café society';
const dec = NM.searchNotes({ notes: [{ id: 'e', title: decomposed, content: '', path: [], pathIds: [], updatedAt: null, order: 0 }] }, 'society');
check('title ranges survive length-changing normalisation', eq(dec[0].titleRanges, [[6, 13]]), JSON.stringify(dec[0].titleRanges));
check('highlightHtml escapes and marks', NM.highlightHtml('<Q4> plan', [[1, 3]], (s) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;'))
    === '&lt;<mark>Q4</mark>&gt; plan');

console.log('\n12. findNoteByTitle and backlinksTo');
check('exact title', NM.findNoteByTitle(lib, 'Ideas').id === 'n-ideas');
check('case-insensitive fallback', NM.findNoteByTitle(lib, 'q4 PLANNING').id === 'n-q4');
check('missing -> null', NM.findNoteByTitle(lib, 'Nope') === null);
check('backlinks', eq(NM.backlinksTo(lib, 'Bake-off').map(n => n.id), ['n-ideas']));
check('backlinks exclude the note itself', NM.backlinksTo(lib, 'Bake-off', 'n-ideas').length === 0);

console.log('\n13. notebookOptions');
const opts = NM.notebookOptions(lib);
check('flattened in tree order with depth', eq(opts.map(o => `${o.depth}:${o.id}`),
    ['0:nb-work', '1:nb-wmeet', '0:nb-recipes', '1:nb-rmeet', '0:nb-empty']));
check('counts include sub-notebooks', opts.find(o => o.id === 'nb-work').count === 2);
const moving = NM.notebookOptions(lib, { excludeId: 'nb-work', currentId: 'nb-recipes' });
check('the moved notebook and its descendants are disabled',
    moving.find(o => o.id === 'nb-work').disabled && moving.find(o => o.id === 'nb-wmeet').disabled);
check('the current location is ticked and disabled', moving.find(o => o.id === 'nb-recipes').current
    && moving.find(o => o.id === 'nb-recipes').disabled);
check('everything else stays enabled', !moving.find(o => o.id === 'nb-rmeet').disabled && !moving.find(o => o.id === 'nb-empty').disabled);

console.log('\n14. resolveNotebookByName');
const res = (n, l = lib) => NM.resolveNotebookByName(l, n);
check('top-level exact', eq(res('Work'), { id: 'nb-work' }));
check('top-level ignores case', eq(res('work'), { id: 'nb-work' }));
check("'Work / Meetings' resolves the path", eq(res('Work / Meetings'), { id: 'nb-wmeet' }));
check("'Recipes / Meetings' resolves the other one", eq(res('Recipes / Meetings'), { id: 'nb-rmeet' }));
check('ambiguous nested name falls back to create at the top', eq(res('Meetings'), { create: { parentId: null, segments: ['Meetings'] } }));
check('missing -> create at the top', eq(res('NewBook'), { create: { parentId: null, segments: ['NewBook'] } }));
check('partial path -> create the rest under the deepest match', eq(res('Work / Projects'), { create: { parentId: 'nb-work', segments: ['Projects'] } }));
check('blank -> null', res('  ') === null);
const unique = NM.buildLibrary({ id: 'nr', kind: 'folder', children: [
    { id: 'a', kind: 'folder', title: 'Work', children: [{ id: 'b', kind: 'folder', title: 'Standups', children: [] }] },
    { id: 'c', kind: 'folder', title: 'Q1 / Q2', children: [] },
    { id: 'd', kind: 'folder', title: 'Home', children: [{ id: 'e', kind: 'folder', title: 'A / B', children: [] }] }
] }, extAdapter);
check('a unique nested title resolves', eq(res('standups', unique), { id: 'b' }));
check("a top-level title containing ' / ' wins", eq(res('Q1 / Q2', unique), { id: 'c' }));
check("a nested title containing ' / ' beats path parsing", eq(res('A / B', unique), { id: 'e' }));

console.log('\n15. notebookNameProblem');
check('blank refused', NM.notebookNameProblem('  ', []) !== null);
check('duplicate refused ignoring case', NM.notebookNameProblem('work', ['Work', 'Recipes']) !== null);
check('fresh name accepted', NM.notebookNameProblem('Projects', ['Work']) === null);
check('sentinel names refused', NM.notebookNameProblem('__tabpaladin_meta__', []) !== null);

console.log('\n16. liftChildren');
const sibs = [{ id: 'x' }, { id: 'nb' }, { id: 'y' }];
const kids = [{ id: 'k1' }, { id: 'k2' }];
const lifted = NM.liftChildren(sibs, 1, kids);
check('children take the notebook\'s place, in order', eq(lifted.map(n => n.id), ['x', 'k1', 'k2', 'y']));
check('the same objects (and ids) are kept', lifted[1] === kids[0] && lifted[2] === kids[1] && lifted[0] === sibs[0]);
check('input untouched', sibs.length === 3 && sibs[1].id === 'nb');
check('bad index is a no-op copy', eq(NM.liftChildren(sibs, 7, [{ id: 'z' }]).map(n => n.id), ['x', 'nb', 'y']));
check('an empty notebook just disappears', eq(NM.liftChildren(sibs, 1, []).map(n => n.id), ['x', 'y']));

console.log('\n17. Per-device UI state');
const mem = new Map();
const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
check('defaults when empty', eq(NM.readNotesUi(storage), NM.defaultNotesUi()));
NM.writeNotesUi(storage, { expanded: ['nb-work'], scope: 'nb:nb-wmeet', noteId: 'n-q4', sort: 'title', mode: 'split' });
check('round trip', eq(NM.readNotesUi(storage), { expanded: ['nb-work'], scope: 'nb:nb-wmeet', noteId: 'n-q4', sort: 'title', mode: 'split' }));
mem.set(NM.NOTES_UI_KEY, '{"expanded":"x","scope":"bogus","sort":"weird","mode":7,"noteId":5}');
check('garbage fields fall back', eq(NM.readNotesUi(storage), NM.defaultNotesUi()));
mem.set(NM.NOTES_UI_KEY, '{not json');
check('unparseable falls back', eq(NM.readNotesUi(storage), NM.defaultNotesUi()));
const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
check('a throwing storage is survivable', eq(NM.readNotesUi(throwing), NM.defaultNotesUi()));
let threw = false;
try { NM.writeNotesUi(throwing, NM.defaultNotesUi()); NM.writeNotesUi(null, {}); } catch (e) { threw = true; }
check('writes never throw', !threw);

console.log('\n18. Inline tokens and safeHref (the renderers build DOM from these)');
const tok = (s) => NM.renderInlineTokens(s);
check('plain text is one text token', eq(tok('just words'), [{ type: 'text', text: 'just words' }]));
check('empty and null give nothing', eq(tok(''), []) && eq(tok(null), []));
check('**strong**, *em* and `code`', eq(tok('**a** *b* `c*d`'), [
    { type: 'strong', children: [{ type: 'text', text: 'a' }] }, { type: 'text', text: ' ' },
    { type: 'em', children: [{ type: 'text', text: 'b' }] }, { type: 'text', text: ' ' },
    { type: 'code', text: 'c*d' }
]), JSON.stringify(tok('**a** *b* `c*d`')));
check('a wikilink keeps its trimmed target and shows [[target]]',
    eq(tok('see [[ Bake-off ]]'), [{ type: 'text', text: 'see ' }, { type: 'wikilink', target: 'Bake-off', text: '[[Bake-off]]' }]));
check('a bare URL, query string and all', eq(tok('at https://x.test/a?b=1&c=2 now'), [
    { type: 'text', text: 'at ' }, { type: 'url', href: 'https://x.test/a?b=1&c=2', text: 'https://x.test/a?b=1&c=2' }, { type: 'text', text: ' now' }
]));
check('a URL in parentheses stops at ")"', eq(tok('(https://x.test)').map(t => t.type), ['text', 'url', 'text']) && tok('(https://x.test)')[1].href === 'https://x.test');
check('emphasis holds wikilinks and URLs', eq(tok('**[[A]] https://x.test**'), [{ type: 'strong', children: [
    { type: 'wikilink', target: 'A', text: '[[A]]' }, { type: 'text', text: ' ' }, { type: 'url', href: 'https://x.test', text: 'https://x.test' }
] }]));
check('nothing inside a wikilink or code span is linkified',
    eq(tok('[[https://x.test]] `https://y.test`').map(t => t.type), ['wikilink', 'text', 'code']));
check('unclosed markers are text', eq(tok('**a [[b `c *d'), [{ type: 'text', text: '**a [[b `c *d' }]));
check('the twins tokenize alike', eq(tok('**x** [[y]] https://z.test `w`'), PWA_NM.renderInlineTokens('**x** [[y]] https://z.test `w`')));
check('a 200 KB line of markers stays fast', (() => {
    const t0 = Date.now();
    NM.renderInlineTokens('[[a*`'.repeat(40000) + '**' + '*a'.repeat(20000));
    return Date.now() - t0 < 2000;
})());
check('safeHref keeps http and https, normalized', NM.safeHref(' https://X.test/a ') === 'https://x.test/a' && NM.safeHref('http://x.test') === 'http://x.test/');
check('safeHref refuses every other scheme',
    ['javascript:alert(1)', 'JAVASCRIPT:x', 'data:text/html,x', 'vbscript:x', 'file:///C:/x', 'ftp://x.test', 'chrome://settings', 'https:x.test', '//x.test', 'x.test', '', null, 42]
        .every(u => NM.safeHref(u) === null));

console.log(failures === 0 ? '\nAll notes-model tests passed.\n' : `\n${failures} test(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
