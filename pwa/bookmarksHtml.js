// Parser for the Netscape bookmark file format — the HTML file every browser's
// "Export bookmarks" produces (Chrome, Firefox, Opera, Edge, Safari all write
// the same dialect). This is how bookmarks get into TabPaladin from any
// browser without an extension: export there, upload here.
//
// The format is not real HTML (unclosed <DT>s, a <p> after every <DL>), so
// this doesn't parse a DOM — it tokenizes the tags that matter, in document
// order, and tracks folder depth with a stack:
//
//   <DT><H3 ...>Title</H3>   a folder; the <DL> that follows holds its children
//   <DL><p>                  descend into the most recently seen folder
//   </DL>                    ascend
//   <DT><A HREF="...">Title</A>   a bookmark in the current folder
//
// Returns an array of top-level nodes in the app's legacy local shape
// ({ type: 'folder'|'bookmark', title, url?, children? }) — the same shape the
// rest of the app edits, so the result can be appended to the tree directly.

const TOKEN_RE = /<DL[^>]*>|<\/DL>|<H3[^>]*>([\s\S]*?)<\/H3>|<A\s+([^>]*)>([\s\S]*?)<\/A>/gi;
const HREF_RE = /HREF\s*=\s*"([^"]*)"/i;

function decodeEntities(s) {
    return String(s || '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0*39;|&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&amp;/g, '&')
        .trim();
}

// Firefox exports carry `place:` smart folders and some browsers include
// javascript: bookmarklets; neither is a page worth syncing. data: urls are
// kept — old TabPaladin notes exported with the browser's bookmarks travel as
// data:application/json and turn back into real notes on push.
function keepUrl(url) {
    const u = String(url || '').trim();
    if (!u) return false;
    if (/^(place|javascript):/i.test(u)) return false;
    return true;
}

export function parseBookmarksHtml(text) {
    const roots = [];
    const stack = [];                    // open folders, outermost first
    let pendingFolder = null;            // last <H3>, waiting for its <DL>
    const currentChildren = () => (stack.length ? stack[stack.length - 1].children : roots);

    let m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(String(text || ''))) !== null) {
        const tag = m[0];

        if (/^<DL/i.test(tag)) {
            if (pendingFolder) {
                stack.push(pendingFolder);
                pendingFolder = null;
            } else {
                // The outermost <DL> (or a stray one) — descend into a
                // throwaway wrapper so a matching </DL> can't underflow.
                const wrapper = { type: 'folder', title: '', children: currentChildren(), _wrapper: true };
                stack.push(wrapper);
            }
            continue;
        }

        if (/^<\/DL/i.test(tag)) {
            stack.pop();
            continue;
        }

        if (m[1] !== undefined) { // <H3> folder heading
            const folder = { type: 'folder', title: decodeEntities(m[1]) || 'Folder', children: [] };
            currentChildren().push(folder);
            pendingFolder = folder;
            continue;
        }

        // <A> bookmark
        const href = (m[2].match(HREF_RE) || [])[1];
        if (!keepUrl(href)) continue;
        const url = decodeEntities(href);
        currentChildren().push({
            type: 'bookmark',
            title: decodeEntities(m[3]) || url,
            url
        });
    }

    // A folder whose <DL> never came (empty folder in some dialects) is
    // already in its parent's children — nothing to clean up. Strip the
    // wrapper flags before returning.
    const strip = (nodes) => {
        for (const n of nodes) {
            delete n._wrapper;
            if (n.children) strip(n.children);
        }
        return nodes;
    };
    return strip(roots);
}

// Convenience: everything under one dated folder, dropping empty top-level
// husks (Chrome always wraps in "Bookmarks bar"/"Other bookmarks" even when
// empty).
export function importedFolderFrom(text, dateStr) {
    const roots = parseBookmarksHtml(text).filter(n =>
        n.type === 'bookmark' || (n.children && n.children.length > 0));
    if (!roots.length) return null;
    return {
        type: 'folder',
        title: `Imported ${dateStr}`,
        children: roots
    };
}

export function countNodes(node) {
    if (!node) return 0;
    return 1 + (node.children || []).reduce((s, c) => s + countNodes(c), 0);
}
