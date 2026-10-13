// Tests for pwa/shareCore.js, the share sheet's pure core: what is found in a
// share, how links are cleaned and matched, which app they belong to, which
// folders are suggested and searched, the outbox and its flush, and folding
// the server's logged appends into a working copy.
//
// What this locks down:
//   1. Extraction against real Android share payloads (Chrome, X, YouTube,
//      Reddit, Instagram, TikTok, Google Maps, links in brackets and quotes,
//      Wikipedia's balanced parentheses, a link only in the title, two links,
//      a scheme-less link, no link at all); an apostrophe inside a link, the
//      url field taken whole, and a link run into CJK text ending there.
//   2. Cleaning is host by host (YouTube keeps v and t, X drops s and t,
//      utm_* goes everywhere) and leaves a link with nothing to drop exactly
//      as written; dedupeKey treats the same link written differently as one,
//      and keeps a fragment that routes (two Gmail threads are two links).
//   3. appOf for every app it knows, and the registrable domain otherwise
//      (mobile.de and m.me are sites, not 'de' and 'me').
//   4. indexFolders leaves out the archive, notes, workflows, pins and noise
//      roots — 300 X links saved in a workflow never make it the top X chip.
//   5. suggest: pins first in order, hidden never, the last-used folder, then
//      counts, then recent folders; the first link from an app gets a
//      starter; with no history at all, the biggest folders. Two folders
//      called Misc are told apart by their paths. searchFolders matches every
//      word and ranks names over paths.
//   6. The outbox (Cache Storage and localStorage) and flushOutbox: never an
//      entry of another account or of nobody's, stops on 401 and on a fetch
//      that never answers, keeps a refused entry, files what was chosen
//      offline, and two flushes at once send a share once. A second tap adds
//      to the first, never replacing it; a filing takes out only what it sent
//      and files what was chosen meanwhile next; more than sixteen folders go
//      in turns; raw goes up cut to the server's 10 KB; a refusal for good is
//      not sent again on its own, and a filing the server never takes is no
//      queued choice; every request names the share's account, and a 412
//      leaves it as it was.
//   7. applyOps: an append inserts, an id already there is skipped, a node
//      whose parent is gone goes to the Bookmarks root, a folder with no
//      parent at the top level, a node's payload (a saved workflow's
//      {createdAt}) comes along, and an unappend removes only an unchanged
//      bookmark or an empty folder.
//
// Run: node tools/test_share_core.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'pwa', 'shareCore.js'), 'utf8');

let failures = 0;
function check(name, cond, detail) {
    if (cond) console.log(`  ok  ${name}`);
    else { failures++; console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// Evaluated the way the worker and the page load it: a classic script that
// sets self.TPShare.
function loadCore() {
    const sandbox = { crypto: globalThis.crypto };
    new Function('self', SRC)(sandbox);
    return sandbox.TPShare;
}
const S = loadCore();

console.log('\n1. What a share holds');
const cases = [
    ['a Chrome page: subject plus the URL in text',
        { title: 'Why SQLite is everywhere', text: 'https://www.example.com/sqlite-everywhere?utm_source=share&utm_medium=android' },
        { url: 'https://www.example.com/sqlite-everywhere', title: 'Why SQLite is everywhere', app: 'site:example.com' }],
    ['X: the URL alone, in text',
        { text: 'https://x.com/nasa/status/1800000000000000000?s=46&t=AbCdEfGh' },
        { url: 'https://x.com/nasa/status/1800000000000000000', title: 'Post by @nasa on X', app: 'x' }],
    ['YouTube: youtu.be with ?si=',
        { title: 'Never Gonna Give You Up', text: 'https://youtu.be/dQw4w9WgXcQ?si=AbC123xyz' },
        { url: 'https://youtu.be/dQw4w9WgXcQ', title: 'Never Gonna Give You Up', app: 'youtube', urlKey: 'youtube.com/watch?v=dQw4w9WgXcQ' }],
    ['Reddit with ?share_id=',
        { text: 'https://www.reddit.com/r/selfhosted/comments/1abcde/my_setup/?share_id=Xy12&utm_medium=android_app&utm_source=share' },
        { url: 'https://www.reddit.com/r/selfhosted/comments/1abcde/my_setup/', title: 'Post in r/selfhosted', app: 'reddit' }],
    ['Instagram with ?igsh=',
        { text: 'https://www.instagram.com/reel/C1AbCdEfGh/?igsh=MWQ1ZGUxMzBkMA==' },
        { url: 'https://www.instagram.com/reel/C1AbCdEfGh/', title: 'Instagram post', app: 'instagram' }],
    ['TikTok: words, a link and a hashtag',
        { text: 'Check out… https://vm.tiktok.com/ZMabc123/ #fyp' },
        { url: 'https://vm.tiktok.com/ZMabc123/', title: 'Check out… #fyp', app: 'tiktok' }],
    ['Google Maps: a place over several lines',
        { text: 'Eiffel Tower\nAv. Gustave Eiffel, 75007 Paris, France\nhttps://maps.app.goo.gl/AbCdEf123' },
        { url: 'https://maps.app.goo.gl/AbCdEf123', title: 'Eiffel Tower Av. Gustave Eiffel, 75007 Paris, France', app: 'maps' }],
    ['a URL in parentheses, with a full stop after',
        { text: 'Check this out (https://youtu.be/abc?si=xyz).' },
        { url: 'https://youtu.be/abc', title: 'Check this out', app: 'youtube' }],
    ['a URL in quotes',
        { text: 'He said "https://example.com/quoted" twice' },
        { url: 'https://example.com/quoted', title: 'He said twice' }],
    ['a URL followed by …',
        { text: 'Read https://example.com/long-read…' },
        { url: 'https://example.com/long-read', title: 'Read' }],
    ['Wikipedia: balanced parentheses kept',
        { text: 'See https://en.wikipedia.org/wiki/Mercury_(planet) for more' },
        { url: 'https://en.wikipedia.org/wiki/Mercury_(planet)', title: 'See for more', app: 'wikipedia' }],
    ['a URL only in the title',
        { title: 'https://example.org/notes/only-in-title', text: '' },
        { url: 'https://example.org/notes/only-in-title', title: 'only in title — example.org' }],
    ['two URLs: the first wins, the second goes to others',
        { text: 'Compare https://a.example/one and https://b.example/two' },
        { url: 'https://a.example/one', others: ['https://b.example/two'] }],
    ['a scheme-less host.tld/path',
        { text: 'example.com/some/page' },
        { url: 'https://example.com/some/page', title: 'page — example.com' }],
    ['the url field wins over text',
        { url: 'https://first.example/a', text: 'Also https://second.example/b' },
        { url: 'https://first.example/a', title: 'Also', others: ['https://second.example/b'] }],
    ['no link at all',
        { text: 'Just a thought to keep' },
        { url: null, text: 'Just a thought to keep' }],
    ['an apostrophe inside a link in the url field: the field is taken whole',
        { url: "https://en.wikipedia.org/wiki/Ender's_Game" },
        { url: "https://en.wikipedia.org/wiki/Ender's_Game", app: 'wikipedia' }],
    ['a Google Maps place with an apostrophe, in the url field',
        { url: "https://www.google.com/maps/place/Joe's+Pizza/@40.7,-73.9,17z" },
        { url: "https://www.google.com/maps/place/Joe's+Pizza/@40.7,-73.9,17z", app: 'maps' }],
    ['an apostrophe inside a link in running text, and one after it',
        { text: "Read https://en.wikipedia.org/wiki/Ender's_Game' tonight" },
        { url: "https://en.wikipedia.org/wiki/Ender's_Game", title: 'Read tonight' }],
    ['a link in single quotes',
        { text: "See 'https://example.com/quoted' here" },
        { url: 'https://example.com/quoted', title: 'See here' }],
    ['Xiaohongshu: the link ends where the Chinese text starts',
        { text: 'http://xhslink.com/a/AbC，复制本条信息，打开【小红书】App查看精彩内容！' },
        { url: 'http://xhslink.com/a/AbC', title: '复制本条信息，打开【小红书】App查看精彩内容！' }],
    ['a link run into CJK text on both sides',
        { text: '看看这个https://example.com/页面。很好' },
        { url: 'https://example.com/' }]
];
for (const [name, fields, want] of cases) {
    const got = S.extractShare(fields);
    const bad = Object.entries(want).filter(([k, v]) => JSON.stringify(got[k]) !== JSON.stringify(v));
    check(name, bad.length === 0, bad.map(([k, v]) => `${k}: got ${JSON.stringify(got[k])}, want ${JSON.stringify(v)}`).join('; '));
}
check('the raw link is kept as found', S.extractShare({ text: 'x https://x.com/a/status/1?s=20 y' }).rawUrl === 'https://x.com/a/status/1?s=20');
check('a subject that is the link itself is no title', S.extractShare({ title: 'https://x.com/a/status/9', text: 'https://x.com/a/status/9' }).title === 'Post by @a on X');

console.log('\n2. Cleaning and matching');
for (const [input, want, why] of [
    ['https://www.youtube.com/watch?v=abc&t=42&si=zzz&feature=share&pp=yg', 'https://www.youtube.com/watch?v=abc&t=42', 'YouTube keeps v and t'],
    ['https://x.com/a/status/1?s=20&t=abc&ref_src=twsrc', 'https://x.com/a/status/1', 'X drops s, t and ref_src'],
    ['https://example.com/?utm_source=a&id=5&utm_medium=b', 'https://example.com/?id=5', 'utm_* goes everywhere'],
    ['https://example.com/a?fbclid=123&gclid=456', 'https://example.com/a', 'fbclid and gclid go everywhere'],
    ['https://open.spotify.com/track/xyz?si=abc', 'https://open.spotify.com/track/xyz', 'Spotify drops si'],
    ['https://www.tiktok.com/@a/video/1?_r=1&_t=8', 'https://www.tiktok.com/@a/video/1', 'TikTok drops _r and _t'],
    ['https://example.com/?t=5&s=2&si=9', 'https://example.com/?t=5&s=2&si=9', 'another site keeps t, s and si'],
    ['https://example.com/a%20b?q=a+b&x=%2F', 'https://example.com/a%20b?q=a+b&x=%2F', 'a link with nothing to drop comes back exactly as written'],
    ['https://example.com/p?keep=1&utm_x=2&also=a%2Cb', 'https://example.com/p?keep=1&also=a%2Cb', 'what is kept keeps its encoding']
]) {
    check(why, S.cleanUrl(input) === want, `${S.cleanUrl(input)}`);
}
const same = (a, b) => S.dedupeKey(a) === S.dedupeKey(b);
check('twitter.com is x.com, and a post is its id', same('https://twitter.com/nasa/status/1', 'https://x.com/NASA/status/1?s=20')
    && same('https://mobile.twitter.com/i/status/1', 'https://x.com/nasa/status/1'));
check('youtu.be/ID is watch?v=ID, as are m., shorts and a timestamp', same('https://youtu.be/abc', 'https://www.youtube.com/watch?v=abc&t=10')
    && same('https://m.youtube.com/watch?v=abc', 'https://youtu.be/abc') && same('http://youtube.com/shorts/abc', 'https://youtu.be/abc?si=q'));
check('www., m., the scheme, a trailing slash and the fragment do not count', same('https://www.example.com/page/', 'http://example.com/page')
    && same('https://m.example.com/page#frag', 'https://example.com/page'));
check('different pages stay different', !same('https://example.com/a', 'https://example.com/b') && !same('https://example.com/?id=1', 'https://example.com/?id=2'));
check('a fragment that routes is part of the page: two Gmail threads, two #/ or #! routes stay different',
    !same('https://mail.google.com/mail/u/0/#inbox/AAA', 'https://mail.google.com/mail/u/0/#inbox/BBB')
    && !same('https://example.com/app/#/item/1', 'https://example.com/app/#/item/2') && !same('https://example.com/#!/a', 'https://example.com/#!/b')
    && same('https://example.com/app/#/item/1', 'http://www.example.com/app#/item/1'),
    [S.dedupeKey('https://mail.google.com/mail/u/0/#inbox/AAA'), S.dedupeKey('https://example.com/app/#/item/1')].join(' '));
check('a www., m. or mobile. that is the site\'s own name stays in the key', !same('https://mobile.de/a', 'https://de/a') && S.dedupeKey('https://m.me/foo') === 'm.me/foo'
    && S.dedupeKey('https://www.mobile.de/a') === 'mobile.de/a', [S.dedupeKey('https://m.me/foo'), S.dedupeKey('https://www.mobile.de/a')].join(' '));

console.log('\n3. Apps');
const apps = {
    'https://x.com/a': 'x', 'https://twitter.com/a': 'x', 'https://t.co/abc': 'x', 'https://fxtwitter.com/a/status/1': 'x',
    'https://vxtwitter.com/a/status/1': 'x', 'https://fixupx.com/a/status/1': 'x',
    'https://www.youtube.com/watch?v=a': 'youtube', 'https://youtu.be/a': 'youtube', 'https://www.youtube-nocookie.com/embed/a': 'youtube',
    'https://music.youtube.com/watch?v=a': 'youtube',
    'https://old.reddit.com/r/a': 'reddit', 'https://redd.it/abc': 'reddit',
    'https://www.instagram.com/p/a/': 'instagram', 'https://instagr.am/p/a': 'instagram',
    'https://vm.tiktok.com/a/': 'tiktok', 'https://github.com/a/b': 'github', 'https://gist.github.com/a': 'github',
    'https://www.facebook.com/a': 'facebook', 'https://fb.watch/abc': 'facebook',
    'https://www.linkedin.com/in/a': 'linkedin', 'https://lnkd.in/abc': 'linkedin',
    'https://www.threads.net/@a': 'threads', 'https://bsky.app/profile/a': 'bluesky',
    'https://open.spotify.com/track/a': 'spotify', 'https://www.pinterest.com/pin/1': 'pinterest', 'https://pin.it/abc': 'pinterest',
    'https://www.pinterest.co.uk/pin/1': 'pinterest',
    'https://www.amazon.com/dp/B0': 'amazon', 'https://www.amazon.co.uk/dp/B0': 'amazon', 'https://www.amazon.de/dp/B0': 'amazon',
    'https://amzn.to/abc': 'amazon', 'https://a.co/d/abc': 'amazon',
    'https://www.google.com/maps/place/x': 'maps', 'https://maps.app.goo.gl/abc': 'maps', 'https://goo.gl/maps/abc': 'maps',
    'https://maps.google.com/?q=x': 'maps',
    'https://news.ycombinator.com/item?id=1': 'hackernews', 'https://medium.com/@a/b': 'medium', 'https://blog.medium.com/x': 'medium',
    'https://en.wikipedia.org/wiki/A': 'wikipedia', 'https://en.m.wikipedia.org/wiki/A': 'wikipedia', 'https://www.twitch.tv/a': 'twitch',
    'https://www.bbc.co.uk/news/x': 'site:bbc.co.uk', 'https://www.nytimes.com/2026/x.html': 'site:nytimes.com',
    'https://edition.cnn.com/x': 'site:cnn.com', 'https://www.abc.net.au/news': 'site:abc.net.au', 'https://www.google.com/search?q=x': 'site:google.com',
    // A www., m. or mobile. that is the site's own name is kept.
    'https://www.mobile.de/x': 'site:mobile.de', 'https://mobile.de/a': 'site:mobile.de', 'https://suchen.mobile.de/x': 'site:mobile.de',
    'https://m.mobile.de/x': 'site:mobile.de', 'https://m.me/foo': 'site:m.me', 'https://www.m.me/x': 'site:m.me', 'https://www.example.de/': 'site:example.de'
};
const wrong = Object.entries(apps).filter(([u, a]) => S.appOf(u) !== a).map(([u, a]) => `${u} -> ${S.appOf(u)} (want ${a})`);
check(`appOf knows every app and falls back to the registrable domain (${Object.keys(apps).length} links)`, wrong.length === 0, wrong.join('; '));
check('labels', S.appLabel('x') === 'X' && S.appLabel('youtube') === 'YouTube' && S.appLabel('site:bbc.co.uk') === 'bbc.co.uk'
    && S.appLabel('hackernews') === 'Hacker News');
check('a share id is 22 url-safe characters, and new each time', /^[A-Za-z0-9_-]{22}$/.test(S.newSid()) && S.newSid() !== S.newSid());

console.log('\n4. The folders a link can be filed into');
const bm = (id, url, title = id) => ({ id, kind: 'bookmark', title, url });
const x = (n) => `https://x.com/u${n}/status/${n}`;
const TREE = [
    { id: 'bm', kind: 'folder', role: 'bookmarks', title: 'Bookmarks', children: [
        { id: 'ai', kind: 'folder', title: 'AI', children: [
            bm('a1', 'https://arxiv.org/abs/1'), bm('a2', x(1)), bm('a3', x(2)),
            { id: 'papers', kind: 'folder', title: 'Papers', children: [bm('p1', 'https://arxiv.org/abs/2'), bm('p2', 'https://arxiv.org/abs/3'), bm('p3', x(3))] },
            { id: 'misc1', kind: 'folder', title: 'Misc', children: [] }
        ] },
        { id: 'fun', kind: 'folder', title: 'Fun', children: [
            bm('f1', 'https://www.youtube.com/watch?v=1'), bm('f2', x(4)), bm('f3', x(5)), bm('f4', x(6)),
            { id: 'misc2', kind: 'folder', title: 'Misc', children: [bm('m1', 'https://example.com/m')] },
            { id: 'deep1', kind: 'folder', title: 'Deep', children: [{ id: 'deep2', kind: 'folder', title: 'Deeper', children: [
                { id: 'deep3', kind: 'folder', title: 'Research', children: [] }] }] }
        ] },
        { id: 'imports:root', kind: 'folder', title: 'TabPaladin Imports', virtual: true, readOnly: true, children: [
            { id: 'imp:src:1', kind: 'folder', title: 'X', virtual: true, children: Array.from({ length: 50 }, (_, i) => ({ id: `imp:1:${i}`, kind: 'bookmark', title: 't', url: x(100 + i), virtual: true })) }
        ] }
    ] },
    { id: 'nr', kind: 'folder', role: 'notes', title: 'Notes', children: [{ id: 'nb', kind: 'folder', title: 'Book', children: [] }] },
    { id: 'wf', kind: 'folder', role: 'workflows', title: 'Workflows', children: [
        { id: 'wf1', kind: 'folder', title: 'Doomscroll', children: Array.from({ length: 300 }, (_, i) => bm(`w${i}`, x(1000 + i))) }] },
    { id: 'pins', kind: 'folder', role: 'pins', title: 'Pinned', children: [bm('pin1', x(5000))] },
    { id: 'trash', kind: 'folder', title: 'Trash', children: [{ id: 'trashf', kind: 'folder', title: 'Old', children: [bm('t1', x(6000))] }] }
];
const idx = S.indexFolders(TREE);
const ids = idx.list.map(f => f.id);
check('the archive, notes, workflows, pins and noise roots are left out, with everything under them',
    !['imports:root', 'imp:src:1', 'nr', 'nb', 'wf', 'wf1', 'pins', 'trash', 'trashf'].some(id => ids.includes(id))
    && ['bm', 'ai', 'papers', 'misc1', 'fun', 'misc2', 'deep3'].every(id => ids.includes(id)), ids.join(','));
check('per folder: the path, the direct count and the count per app', idx.folders.get('papers').path.join('/') === 'Bookmarks/AI/Papers'
    && idx.folders.get('ai').directCount === 3 && idx.folders.get('ai').apps.x === 2 && idx.folders.get('fun').apps.x === 3 && idx.bookmarksRootId === 'bm');
check('the folders already holding a link', idx.holding(S.dedupeKey('https://twitter.com/u1/status/1')).map(f => f.id).join() === 'ai');
check('a parent path drops Bookmarks and truncates the middle', S.parentPath(idx.folders.get('papers'), idx) === 'AI'
    && S.parentPath(idx.folders.get('deep3'), idx) === 'Fun › Deep › Deeper' && S.parentPath(idx.folders.get('ai'), idx) === ''
    && S.parentPath({ path: ['Bookmarks', 'A', 'B', 'C', 'D', 'E'], pathIds: ['bm', 1, 2, 3, 4, 5] }, idx) === 'A › … › C › D');

console.log('\n5. Suggestions and search');
const statsFor = (apps) => ({ apps });
let s = S.suggest('x', { index: idx, prefs: null, stats: null });
check('300 X links in a workflow do not put Workflows on top: the folders holding X links, most first',
    s.chips.map(c => c.folderId).slice(0, 3).join() === 'fun,ai,papers' && s.chips.every(c => c.folderId !== 'wf1') && !s.firstTime, JSON.stringify(s.chips));
s = S.suggest('x', { index: idx, prefs: { v: 1, apps: { x: { pinned: ['misc1', 'papers'], hidden: ['fun'] } } }, stats: null });
check('pinned folders come first, in pin order, and a hidden folder never shows', s.chips.map(c => c.folderId).join() === 'misc1,papers,ai,misc2'
    && s.chips[0].reason === 'pinned' && s.chips[1].reason === 'pinned', JSON.stringify(s.chips));
s = S.suggest('x', { index: idx, stats: statsFor({ x: [{ folderId: 'deep3', n: 1, last: '2026-10-01T00:00:00Z' }, { folderId: 'papers', n: 3, last: '2026-09-01T00:00:00Z' }] }) });
check('the folder last used for the app takes a slot, then counts', s.chips[0].folderId === 'deep3' && s.chips[0].reason === 'last'
    && s.chips.slice(1, 3).map(c => c.folderId).join() === 'fun,ai', JSON.stringify(s.chips));
s = S.suggest('x', { index: idx, stats: statsFor({ x: [{ folderId: 'papers', n: 1, last: '2026-09-01T00:00:00Z' }] }) });
check('a tie in count goes to the most recent filing', S.suggest('x', { index: S.indexFolders([{ id: 'bm', kind: 'folder', role: 'bookmarks', title: 'B', children: [
    { id: 'one', kind: 'folder', title: 'One', children: [bm('o1', x(1))] }, { id: 'two', kind: 'folder', title: 'Two', children: [bm('t1', x(2))] }] }]),
    stats: statsFor({ x: [{ folderId: 'two', n: 1, last: '2026-01-01' }, { folderId: 'one', n: 1, last: '2025-01-01' }] }) }).chips.map(c => c.folderId).slice(0, 2).join() === 'two,one');
s = S.suggest('github', { index: idx, stats: statsFor({ x: [{ folderId: 'deep3', n: 2, last: '2026-10-02' }, { folderId: 'misc2', n: 1, last: '2026-10-01' }] }) });
check('a first link from an app: a starter for its own folder, then recent folders from any app, tagged recent',
    s.firstTime && s.starter && s.starter.kind === 'app-folder' && s.starter.title === 'GitHub' && s.starter.parentId === 'bm'
    && s.chips.map(c => c.folderId).join() === 'deep3,misc2' && s.chips.every(c => c.reason === 'recent') && s.chips.length <= 3, JSON.stringify(s));
s = S.suggest('site:nytimes.com', { index: idx, stats: null });
check('a first link from an unknown site: "+ New folder…", then the biggest folders when nothing was ever filed',
    s.firstTime && s.starter.kind === 'new-folder' && s.chips.map(c => c.reason).every(r => r === 'biggest')
    && s.chips[0].folderId === 'fun' && s.chips.length === 3, JSON.stringify(s));
const withYt = S.indexFolders([{ id: 'bm', kind: 'folder', role: 'bookmarks', title: 'Bookmarks', children: [{ id: 'yt', kind: 'folder', title: 'YouTube', children: [] }] }]);
s = S.suggest('youtube', { index: withYt });
check('a first link whose app already has a folder of that name gets it as a chip, not a second one', !s.starter && s.chips[0].folderId === 'yt');
check('slots are 2-8, 4 by default', S.suggest('x', { index: idx }).slots === 4 && S.suggest('x', { index: idx, slots: 20 }).slots === 8
    && S.suggest('x', { index: idx, prefs: { slots: 2 } }).chips.length === 2);
const misc = S.searchFolders(idx, 'misc');
check('two Misc folders are told apart by their paths', misc.length === 2 && new Set(misc.map(h => S.parentPath(h.folder, idx))).size === 2
    && misc.map(h => S.parentPath(h.folder, idx)).sort().join() === 'AI,Fun');
const ai = S.searchFolders(idx, 'ai pap');
check('every word must match somewhere in the path: "ai pap" finds AI › Papers', ai.length === 1 && ai[0].folder.id === 'papers'
    && JSON.stringify(ai[0].ranges) === '[[0,3]]', JSON.stringify(ai.map(h => [h.folder.id, h.ranges])));
const res = S.searchFolders(idx, 're');
check('name matches rank above path-only matches', res[0].folder.id === 'deep3' && res.every(h => h.folder.path.join(' ').toLowerCase().includes('re')),
    res.map(h => h.folder.id).join());
check('no words, no results', S.searchFolders(idx, '   ').length === 0);

console.log('\n6. The outbox and its flush');
function fakeCaches() {
    const stores = new Map();
    return {
        stores,
        async open(name) {
            if (!stores.has(name)) stores.set(name, new Map());
            const m = stores.get(name);
            return {
                match: async (k) => { const r = m.get(typeof k === 'string' ? k : k.url); return r ? r.clone() : undefined; },
                put: async (k, v) => { m.set(typeof k === 'string' ? k : k.url, v); },
                delete: async (k) => m.delete(typeof k === 'string' ? k : k.url),
                keys: async () => [...m.keys()]
            };
        }
    };
}
const box = S.cacheOutbox(fakeCaches());
const ALEX = { url: 'https://tab.example', token: 'tok-a', userId: 1, username: 'alex', serverId: 'srv' };
const SAM = { ...ALEX, token: 'tok-s', userId: 2, username: 'sam' };
const e1 = S.makeEntry({ fields: { text: 'Look https://x.com/a/status/1?s=20' }, account: S.accountOf(ALEX), sid: 'sid-one-0000000001', now: new Date(Date.now() - 60000) });
await box.put(e1);
check('an entry carries the link, cleaned, the app and the account it was shared under',
    e1.url === 'https://x.com/a/status/1' && e1.app === 'x' && e1.account.userId === 1 && e1.phase === 'new' && (await box.get(e1.sid)).sid === e1.sid);
await box.put(S.makeEntry({ fields: { text: 'https://example.com/sam' }, account: S.accountOf(SAM), sid: 'sid-sams-000000001' }));
await box.put(S.makeEntry({ fields: { text: 'https://example.com/nobody' }, account: null, sid: 'sid-nobody-0000001' }));
await box.put(S.makeEntry({ fields: { text: 'no link here' }, account: S.accountOf(ALEX), sid: 'sid-nolink-0000001' }));
check('list is oldest first', (await box.list()).map(e => e.sid)[0] === 'sid-one-0000000001' && (await box.list()).length === 4);

function server(handler) {
    const calls = [];
    const fn = async (url, opts) => {
        calls.push({ url: String(url).replace('https://tab.example', ''), body: opts.body ? JSON.parse(opts.body) : null, auth: opts.headers.Authorization });
        return handler(String(url).replace('https://tab.example', ''), opts, calls.length);
    };
    fn.calls = calls;
    return fn;
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const shareJson = (sid, status = 'pending') => ({ ok: true, created: true, share: { sid, status, filings: [] }, archived: null });

let api = server((p, o) => json(shareJson(JSON.parse(o.body).sid)));
let out = await S.flushOutbox({ outbox: box, cfg: ALEX, fetch: api });
check('a flush as alex uploads alex\'s share only: not sam\'s, not one made while nobody was signed in, not one without a link',
    JSON.stringify(out.uploaded) === '["sid-one-0000000001"]' && api.calls.length === 1 && api.calls[0].url === '/api/shares'
    && api.calls[0].auth === 'Bearer tok-a' && out.skipped.length === 3, JSON.stringify(out));
check('  sending the share id, the cleaned link and the raw fields', api.calls[0].body.sid === e1.sid && api.calls[0].body.url === e1.url
    && api.calls[0].body.raw.url === 'https://x.com/a/status/1?s=20');
const up = await box.get(e1.sid);
check('  and the entry stays, uploaded, for the page to read', up && up.uploaded === true && up.phase === 'uploaded' && up.share.sid === e1.sid);
out = await S.flushOutbox({ outbox: box, cfg: ALEX, fetch: api });
check('a second flush sends nothing again', api.calls.length === 1 && out.uploaded.length === 0);

await box.update(e1.sid, (c) => ({ ...c, file: { targets: [{ folderId: 'ai' }], labels: ['AI'] } }));
check('a file chosen offline is the fileQueued phase', (await box.get(e1.sid)).phase === 'fileQueued');
api = server((p) => (p.endsWith('/file') ? json({ ok: true, baseVersion: 5, version: 6, created: [{ id: 'n1' }], share: { sid: e1.sid, status: 'filed' } }) : json({})));
out = await S.flushOutbox({ outbox: box, cfg: ALEX, fetch: api });
check('the next flush files it and the entry goes', out.filed.length === 1 && out.filed[0].result.version === 6
    && api.calls[0].url === `/api/shares/${e1.sid}/file` && api.calls[0].body.targets[0].folderId === 'ai' && !(await box.get(e1.sid)));

const fresh = async (sid, account = S.accountOf(ALEX)) => box.put(S.makeEntry({ fields: { text: `https://example.com/${sid}` }, account, sid }));
await fresh('sid-auth-000000001');
api = server(() => new Response('{}', { status: 401 }));
out = await S.flushOutbox({ outbox: box, cfg: ALEX, fetch: api });
check('a 401 stops the flush and keeps the entry as it was', out.stopped === 'auth' && (await box.get('sid-auth-000000001')).uploaded === false);
api = server(() => { throw new TypeError('Failed to fetch'); });
out = await S.flushOutbox({ outbox: box, cfg: ALEX, fetch: api });
check('offline stops it too, noting why', out.stopped === 'network' && (await box.get('sid-auth-000000001')).lastError.status === 0);
api = server(() => new Promise(() => {}));
const t0 = Date.now();
out = await S.flushOutbox({ outbox: box, cfg: ALEX, fetch: api, timeoutMs: 50 });
check('a server that never answers is given up on after the timeout', out.stopped === 'network' && Date.now() - t0 < 2000
    && (await box.get('sid-auth-000000001')).uploaded === false);
api = server(() => json({ error: 'url: an http(s) link is required.' }, 400));
out = await S.flushOutbox({ outbox: box, cfg: ALEX, fetch: api });
const refused = await box.get('sid-auth-000000001');
check('a refusal is kept, as an error, with the server\'s words', refused && refused.phase === 'error' && /http\(s\)/.test(refused.lastError.message)
    && out.failed.length === 1);
await box.remove('sid-auth-000000001');

await fresh('sid-race-000000001');
let release = null;
const gate = new Promise(r => { release = r; });
api = server(async (p, o) => { await gate; return json(shareJson(JSON.parse(o.body).sid)); });
const both = [S.flushOutbox({ outbox: box, cfg: ALEX, fetch: api }), S.flushOutbox({ outbox: box, cfg: ALEX, fetch: api })];
await new Promise(r => setTimeout(r, 20));
release();
await Promise.all(both);
check('two flushes at once send the share once', api.calls.filter(c => c.body && c.body.sid === 'sid-race-000000001').length === 1);

await box.update('sid-race-000000001', { later: true });
await S.flushOutbox({ outbox: box, cfg: ALEX, fetch: server(() => json({})) });
check('Later, once uploaded, takes the entry out (the server keeps the share waiting)', !(await box.get('sid-race-000000001')));
await fresh('sid-old-0000000001');
await box.update('sid-old-0000000001', { uploaded: true, uploadedAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString() });
await S.flushOutbox({ outbox: box, cfg: ALEX, fetch: server(() => json({})) });
check('an uploaded entry a day old with nothing chosen is pruned', !(await box.get('sid-old-0000000001')));
check('sam\'s and nobody\'s entries are still there, untouched', (await box.get('sid-sams-000000001')).uploaded === false
    && (await box.get('sid-nobody-0000001')).uploaded === false);
check('an account is the same id on the same server address and server id', S.sameAccount(S.accountOf(ALEX), ALEX)
    && !S.sameAccount(S.accountOf(ALEX), SAM) && !S.sameAccount(S.accountOf(ALEX), { ...ALEX, url: 'https://elsewhere.example' })
    && !S.sameAccount(S.accountOf(ALEX), { ...ALEX, serverId: 'other' }) && !S.sameAccount(null, ALEX)
    && S.sameAccount({ url: 'https://tab.example', userId: null, username: 'Alex', serverId: null }, { ...ALEX, userId: null }));

const mem = new Map();
const lbox = S.localOutbox({ getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) });
await lbox.put(S.makeEntry({ fields: { text: 'https://example.com/local' }, account: null, sid: 'sid-local-00000001' }));
await lbox.update('sid-local-00000001', { later: true });
check('the localStorage outbox does the same', (await lbox.get('sid-local-00000001')).later === true && (await lbox.list()).length === 1
    && (await lbox.remove('sid-local-00000001')) === true && !mem.has('tp_outbox'));

console.log('\n6b. Choices made one after another, and what the server cannot take');
// The sheet's tap: the folders go into the entry's choice, added to what an
// earlier tap chose, and a flush follows.
const tap = (b, sid, folderId) => b.update(sid, (c) => ({
    ...c, later: false, file: S.mergeIntent(c.file, S.makeIntent([{ folderId, label: folderId.toUpperCase() }], [], { at: new Date().toISOString() }))
}));
const filedOk = (sid) => (p, o) => {
    if (p === '/api/shares') return json(shareJson(JSON.parse(o.body).sid));
    const body = JSON.parse(o.body);
    return json({ ok: true, baseVersion: 1, version: 2, created: body.targets.map((t, i) => ({ id: `b${i}`, kind: 'bookmark', parentId: t.folderId })), share: { sid, status: 'filed', filings: [] } });
};
for (const [name, b] of [['Cache Storage', S.cacheOutbox(fakeCaches())], ['localStorage', S.localOutbox({ getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) })]]) {
    const sidA = 'sid-two-taps-000001';
    await b.put(S.makeEntry({ fields: { text: 'https://example.com/two-taps' }, account: S.accountOf(ALEX), sid: sidA }));
    const offline = server(() => { throw new TypeError('Failed to fetch'); });
    await tap(b, sidA, 'fa');
    await S.flushOutbox({ outbox: b, cfg: ALEX, fetch: offline });
    await tap(b, sidA, 'fb');
    await S.flushOutbox({ outbox: b, cfg: ALEX, fetch: offline });
    const both = await b.get(sidA);
    check(`${name}: offline, a second tap adds its folder to the first, never replacing it`,
        JSON.stringify(S.intentKeys(both.file)) === '["fa","fb"]' && JSON.stringify(both.file.labels) === '["FA","FB"]', JSON.stringify(both.file));
    const back = server(filedOk(sidA));
    const res = await S.flushOutbox({ outbox: b, cfg: ALEX, fetch: back });
    const fileCalls = back.calls.filter(c => c.url.endsWith('/file'));
    check(`${name}:   back online, both are filed and the entry goes`, fileCalls.length === 1
        && JSON.stringify(fileCalls[0].body.targets) === '[{"folderId":"fa"},{"folderId":"fb"}]' && res.filed.length === 1 && !(await b.get(sidA)),
        JSON.stringify(fileCalls.map(c => c.body.targets)));
}

// Online: the second tap lands while the first one's filing is on its way.
{
    const b = S.cacheOutbox(fakeCaches());
    const sidR = 'sid-race-taps-00001';
    await b.put({ ...S.makeEntry({ fields: { text: 'https://example.com/race' }, account: S.accountOf(ALEX), sid: sidR }), uploaded: true, share: { sid: sidR } });
    let release = null;
    const held = new Promise(r => { release = r; });
    let first = true;
    const slow = server(async (p, o) => {
        if (first) { first = false; await held; }
        return filedOk(sidR)(p, o);
    });
    await tap(b, sidR, 'fa');
    const flushA = S.flushOutbox({ outbox: b, cfg: ALEX, fetch: slow, sids: [sidR] });
    await new Promise(r => setTimeout(r, 20));
    await tap(b, sidR, 'fb');
    const flushB = await S.flushOutbox({ outbox: b, cfg: ALEX, fetch: slow, sids: [sidR] });
    check('a flush while another holds the share skips it, and says so', flushB.skipped.includes(sidR) && S.busy(sidR));
    const idle = S.whenIdle(sidR);
    release();
    const resA = await flushA;
    await idle;
    const sent = slow.calls.filter(c => c.url.endsWith('/file')).map(c => c.body.targets.map(t => t.folderId).join());
    check('  the first filing\'s answer takes out only what it sent: the second tap is filed next, in the same flush, and then the entry goes',
        JSON.stringify(sent) === '["fa","fb"]' && resA.filed.length === 2 && !(await b.get(sidR)) && !S.busy(sidR), JSON.stringify({ sent, filed: resA.filed.length }));
}

// More folders than the server takes at once go in turns.
{
    const b = S.cacheOutbox(fakeCaches());
    const sidM = 'sid-many-folders-01';
    await b.put({ ...S.makeEntry({ fields: { text: 'https://example.com/many' }, account: S.accountOf(ALEX), sid: sidM }), uploaded: true, share: { sid: sidM } });
    for (let i = 0; i < 20; i++) await tap(b, sidM, `f${i}`);
    const many = server(filedOk(sidM));
    const r = await S.flushOutbox({ outbox: b, cfg: ALEX, fetch: many });
    const sizes = many.calls.map(c => c.body.targets.length);
    check('twenty folders are filed sixteen, then four', JSON.stringify(sizes) === '[16,4]' && r.filed.length === 2 && !(await b.get(sidM)), JSON.stringify(sizes));
}

// What the share target received goes up cut to fit the server's 10 KB.
{
    const b = S.cacheOutbox(fakeCaches());
    const e = S.makeEntry({ fields: { title: 'Т'.repeat(3000), text: '中'.repeat(3500) + ' https://example.com/cjk' }, account: S.accountOf(ALEX), sid: 'sid-long-cjk-00001' });
    await b.put(e);
    const up = server((p, o) => json(shareJson(JSON.parse(o.body).sid)));
    await S.flushOutbox({ outbox: b, cfg: ALEX, fetch: up });
    const rawSent = up.calls[0].body.raw;
    check('a long CJK share\'s raw goes up under 10 KB of UTF-8, subject included, the text cut and not the link',
        rawSent && new TextEncoder().encode(JSON.stringify(rawSent)).length <= 10 * 1024 && rawSent.url === 'https://example.com/cjk'
        && /^中+/.test(rawSent.text) && rawSent.text.length < e.fields.text.length && up.calls[0].body.url === 'https://example.com/cjk',
        rawSent && new TextEncoder().encode(JSON.stringify(rawSent)).length);
}

// A refusal for good is not sent again on its own; a tap (asked by id) does.
{
    const b = S.cacheOutbox(fakeCaches());
    const sidP = 'sid-refused-0000001';
    await b.put(S.makeEntry({ fields: { text: 'https://example.com/refused' }, account: S.accountOf(ALEX), sid: sidP }));
    await S.flushOutbox({ outbox: b, cfg: ALEX, fetch: server(() => json({ error: 'url: at most 4096 characters.' }, 400)) });
    const again = server(() => json({ error: 'url: at most 4096 characters.' }, 400));
    const bg = await S.flushOutbox({ outbox: b, cfg: ALEX, fetch: again });
    check('a share refused for good is not sent again by a flush on its own', again.calls.length === 0 && bg.skipped.includes(sidP));
    await S.flushOutbox({ outbox: b, cfg: ALEX, fetch: again, sids: [sidP] });
    check('  only when asked for by its id', again.calls.length === 1);
}

// A filing the server will never take is no queued choice.
{
    const b = S.cacheOutbox(fakeCaches());
    const sidF = 'sid-bad-filing-0001';
    await b.put({ ...S.makeEntry({ fields: { text: 'https://example.com/bad-filing' }, account: S.accountOf(ALEX), sid: sidF }), uploaded: true, share: { sid: sidF } });
    await tap(b, sidF, 'fa');
    await S.flushOutbox({ outbox: b, cfg: ALEX, fetch: server(() => json({ error: 'title: at most 1000 characters.' }, 400)) });
    const bad = await b.get(sidF);
    check('a filing refused with a 400 drops that choice, keeping the server\'s words', bad && !bad.file && /at most 1000/.test(bad.lastError.message)
        && bad.lastError.permanent === false, JSON.stringify(bad && { file: bad.file, lastError: bad.lastError }));
}

// The account the phone kept the share for goes with every request, and a
// session of another account (412) changes nothing.
{
    const b = S.cacheOutbox(fakeCaches());
    const sidW = 'sid-wrong-account-1';
    const e = S.makeEntry({ fields: { text: 'https://example.com/whose' }, account: S.accountOf(ALEX), sid: sidW });
    await b.put(e);
    const wrong = server(() => json({ error: 'This share belongs to another account.', code: 'wrong-account' }, 412));
    const r = await S.flushOutbox({ outbox: b, cfg: ALEX, fetch: wrong });
    const left = await b.get(sidW);
    check('every request names the account the share was kept for', wrong.calls[0].body.expectUserId === 1 && wrong.calls[0].body.expectServerId === 'srv');
    check('  and a 412 stops the flush, leaving the share exactly as it was', r.stopped === 'account' && left.uploaded === false && !left.lastError
        && left.attempts === 0, JSON.stringify(r));
}

const claimed = S.claimEntry({ ...S.makeEntry({ fields: { text: 'https://example.com/theirs' }, account: S.accountOf(SAM) }),
    uploaded: true, share: { sid: 'x' }, file: { targets: [{ folderId: 'sams' }] }, lastError: { status: 500 } }, S.accountOf(ALEX));
check('a share taken over by another account is new for it: no upload, share or folder choice of the last one\'s',
    claimed.account.userId === 1 && claimed.uploaded === false && claimed.share === null && claimed.file === null && claimed.lastError === null);

console.log('\n7. Folding the server\'s appends into a working copy');
const copy = JSON.parse(JSON.stringify(TREE));
const a = S.wireAdapter(copy);
const r1 = S.applyOps([{ version: 10, kind: 'append', payload: { nodes: [
    { id: 'nf', parentId: 'ai', kind: 'folder', title: 'Talks' },
    { id: 'nb1', parentId: 'nf', kind: 'bookmark', title: 'Talk', url: 'https://youtu.be/t' },
    { id: 'nb2', parentId: 'fun', kind: 'bookmark', title: 'Talk', url: 'https://youtu.be/t' },
    { id: 'a1', parentId: 'ai', kind: 'bookmark', title: 'dup', url: 'https://arxiv.org/abs/1' },
    { id: 'lost', parentId: 'deleted-here', kind: 'bookmark', title: 'Lost', url: 'https://example.com/lost' }
] } }], a);
const find = (id) => a.find(id);
check('an append inserts each node at the end of its folder', r1.applied === 4 && find('nf') && find('nf').children[0].id === 'nb1'
    && find('fun').children.at(-1).id === 'nb2' && find('ai').children.at(-1).id === 'nf');
check('  a node already there is skipped', r1.skipped === 1 && find('ai').children.filter(c => c.id === 'a1').length === 1);
check('  and one whose folder is gone here goes to the Bookmarks root', r1.relocated === 1 && find('bm').children.at(-1).id === 'lost');
const rTop = S.applyOps([{ version: 10, kind: 'append', payload: { nodes: [
    { id: 'phone-top', parentId: null, kind: 'folder', title: 'Top on the phone' },
    { id: 'phone-top-b', parentId: 'phone-top', kind: 'bookmark', title: 'In it', url: 'https://top.example/' }
] } }], a);
check('  a folder logged with no parent (a phone\'s top-level folder) goes at the top level, and is no relocation',
    rTop.applied === 2 && rTop.relocated === 0 && copy.some(r => r.id === 'phone-top') && !find('bm').children.some(c => c.id === 'phone-top')
    && find('phone-top').children[0].id === 'phone-top-b', JSON.stringify(rTop));
find('nb2').url = 'https://changed.example/';
find('nf').children.push({ id: 'mine', kind: 'bookmark', title: 'Mine', url: 'https://mine.example/' });
const r2 = S.applyOps([{ version: 11, kind: 'unappend', payload: { items: [
    { id: 'nb1', kind: 'bookmark', url: 'https://youtu.be/t' },
    { id: 'nb2', kind: 'bookmark', url: 'https://youtu.be/t' },
    { id: 'nf', kind: 'folder' },
    { id: 'never-here', kind: 'bookmark', url: 'https://x' }
] } }], a);
check('an unappend removes only the unchanged bookmark, never a changed one or a folder with something in it',
    r2.removed === 1 && !find('nb1') && find('nb2') && find('nf') && find('nf').children.length === 1);
// A workflow saved on the server (POST /api/workflows): its folder carries
// payload {createdAt}, which a copy must keep or its next push erases it.
const wfOp = [{ version: 12, kind: 'append', payload: { nodes: [
    { id: 'wf-1', parentId: 'ai', kind: 'folder', title: 'Research', payload: { createdAt: '2026-10-01T09:30:00.000Z' } },
    { id: 'wf-1-t', parentId: 'wf-1', kind: 'bookmark', title: 'One', url: 'https://one.example/' }
] } }];
const r3 = S.applyOps(wfOp, a);
check('an appended folder keeps its payload {createdAt}; a bookmark without one gets none',
    r3.applied === 2 && find('wf-1').payload && find('wf-1').payload.createdAt === '2026-10-01T09:30:00.000Z'
    && find('wf-1').children[0].id === 'wf-1-t' && !('payload' in find('wf-1-t')), JSON.stringify(find('wf-1')));
wfOp[0].payload.nodes[0].payload.createdAt = 'changed later';
check('  as its own copy, not the op\'s object', find('wf-1').payload.createdAt === '2026-10-01T09:30:00.000Z');
const r4 = S.applyOps(wfOp, a);
check('  and the same op again (the client that saved it) skips every id', r4.applied === 0 && r4.skipped === 2);

console.log(failures === 0 ? '\nAll share-core tests passed.\n' : `\n${failures} test(s) failed.\n`);
process.exitCode = failures === 0 ? 0 : 1;
