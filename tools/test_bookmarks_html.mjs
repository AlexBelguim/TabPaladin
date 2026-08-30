// Headless test for the Netscape bookmark-file parser — the "import bookmarks
// from any browser" path of the web app.
//
// Run: node tools/test_bookmarks_html.mjs

import { parseBookmarksHtml, importedFolderFrom, countNodes } from '../pwa/bookmarksHtml.js';

let failures = 0;
function check(name, cond, detail) {
    if (cond) {
        console.log(`  ok  ${name}`);
    } else {
        failures++;
        console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

// A realistic Chrome-style export: DOCTYPE noise, unclosed <DT>/<p> tags,
// nesting, entities, plus Firefox-style place: and a javascript: bookmarklet.
const SAMPLE = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file. -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1690000000" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><A HREF="https://news.ycombinator.com/" ADD_DATE="1690000001" ICON="data:image/png;base64,x">Hacker &amp; News</A>
        <DT><H3 ADD_DATE="1690000002">Dev &lt;stuff&gt;</H3>
        <DL><p>
            <DT><A HREF="https://developer.mozilla.org/">MDN</A>
            <DT><A HREF="javascript:alert(1)">Bookmarklet</A>
            <DT><A HREF="place:sort=8&maxResults=10">Most visited</A>
        </DL><p>
    </DL><p>
    <DT><H3>Other bookmarks</H3>
    <DL><p>
        <DT><A HREF="https://example.com/?a=1&amp;b=2">Example &#39;quoted&#39;</A>
        <DT><A HREF="data:application/json,%7B%22v%22%3A1%2C%22content%22%3A%22legacy%20note%22%7D">Old note</A>
        <DT><H3>Empty folder</H3>
        <DL><p>
        </DL><p>
    </DL><p>
</DL><p>
`;

console.log('\n1. Structure');
const roots = parseBookmarksHtml(SAMPLE);
check('two top-level folders', roots.length === 2, roots.map(r => r.title).join(', '));
check('titles decoded', roots[0].title === 'Bookmarks bar' && roots[1].title === 'Other bookmarks');

const bar = roots[0];
check('bar has bookmark + subfolder', bar.children.length === 2,
    bar.children.map(c => c.title).join(', '));
check('entity in bookmark title decoded', bar.children[0].title === 'Hacker & News');
check('entity in folder title decoded', bar.children[1].title === 'Dev <stuff>');

const dev = bar.children[1];
check('nested folder holds only real pages', dev.children.length === 1,
    dev.children.map(c => c.url).join(', '));
check('javascript: and place: dropped', dev.children[0].url === 'https://developer.mozilla.org/');

const other = roots[1];
check('entity in href decoded', other.children[0].url === 'https://example.com/?a=1&b=2');
check('numeric entities decoded', other.children[0].title === "Example 'quoted'");
check('data: legacy note kept', other.children.some(c => String(c.url).startsWith('data:application/json')));
check('empty subfolder survives as a folder', other.children.some(c => c.type === 'folder' && c.title === 'Empty folder'));

console.log('\n2. Wrapper helper');
const wrapped = importedFolderFrom(SAMPLE, '2026-08-30');
check('wrapped in a dated folder', wrapped.title === 'Imported 2026-08-30');
// wrapper + 2 roots + Dev + Empty folder + 4 kept leaves = 9
check('node count sane', countNodes(wrapped) === 9, String(countNodes(wrapped)));

console.log('\n3. Hostile / degenerate input');
check('empty input -> empty', parseBookmarksHtml('').length === 0);
check('plain text -> empty', parseBookmarksHtml('hello world').length === 0);
check('empty input -> null wrapper', importedFolderFrom('', 'x') === null);
const unbalanced = parseBookmarksHtml('<DL><DT><H3>A</H3><DL><DT><A HREF="https://a">a</A>');
check('unclosed DLs still yield the tree', unbalanced.length === 1
    && unbalanced[0].children.length === 1 && unbalanced[0].children[0].url === 'https://a');
const extraClose = parseBookmarksHtml('</DL></DL><DT><A HREF="https://b">b</A>');
check('extra </DL> does not underflow', extraClose.length === 1 && extraClose[0].url === 'https://b');

console.log(failures === 0 ? '\nAll bookmarks-html tests passed.\n' : `\n${failures} test(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
