// Projection: archive rows -> bookmark subtree inside the snapshot.
//
// The projection is a full deterministic rebuild of one provider's subtree, not
// an incremental patch. That is what makes it self-healing: if a browser pushes
// a tree that predates the import folder, the next projection puts it back
// verbatim instead of leaving a hole.

export const IMPORTS_ROOT_TITLE = 'TabPaladin Imports';

const PROVIDER_FOLDER = {
    reddit: 'Reddit'
};

export function providerFolderTitle(provider) {
    return PROVIDER_FOLDER[provider] || provider;
}

function isFolder(node) {
    return node && (node.type === 'folder' || node.type === 'root');
}

// Find the imports root anywhere in the top two levels, or create it under the
// "other bookmarks" equivalent. Same shape as the notes-root fallback the
// proposal-approve path uses, and for the same reason: root titles differ across
// browsers, so match loosely and fall back to the last root.
export function findOrCreateImportsRoot(snapshot) {
    const roots = snapshot.children || [];
    for (const rootChild of roots) {
        if (isFolder(rootChild) && rootChild.title === IMPORTS_ROOT_TITLE) return rootChild;
        for (const c of rootChild.children || []) {
            if (isFolder(c) && c.title === IMPORTS_ROOT_TITLE) return c;
        }
    }
    const parent = roots.find(r => /other|unfiled/i.test(r.title || '')) || roots[roots.length - 1];
    if (!parent) return null;
    const folder = { type: 'folder', title: IMPORTS_ROOT_TITLE, children: [] };
    parent.children = parent.children || [];
    parent.children.push(folder);
    return folder;
}

// Bookmark titles carry the subreddit so the archive stays readable once it is
// thousands of entries deep and the folder name alone tells you nothing.
function titleFor(item) {
    const base = item.title || item.url;
    const prefix = item.container ? `r/${item.container} — ` : '';
    const full = prefix + base;
    // Chrome starts truncating in the middle around here, and an over-long title
    // makes the PWA list unreadable well before that.
    return full.length > 180 ? full.slice(0, 177) + '…' : full;
}

// Group by the month the item was created rather than when it was imported.
// Import time would scatter a first-run backfill of 1000 posts into one giant
// folder and then re-shuffle nothing on later runs; creation time is stable, so
// re-projecting always yields the identical tree.
function monthKey(item) {
    const ts = item.created_utc;
    if (!ts) return 'undated';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return 'undated';
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Build one provider's subtree: <Provider>/<List>/<YYYY-MM>/bookmarks
export function buildProviderFolder({ provider, listTitle, items }) {
    const byMonth = new Map();
    for (const item of items) {
        const key = monthKey(item);
        if (!byMonth.has(key)) byMonth.set(key, []);
        byMonth.get(key).push(item);
    }

    // Newest month first; "undated" sorts last rather than colliding with real
    // keys under a plain string sort.
    const months = [...byMonth.keys()].sort((a, b) => {
        if (a === 'undated') return 1;
        if (b === 'undated') return -1;
        return b.localeCompare(a);
    });

    const monthFolders = months.map(month => ({
        type: 'folder',
        title: month,
        children: byMonth.get(month)
            .slice()
            .sort((a, b) => String(b.created_utc || '').localeCompare(String(a.created_utc || '')))
            .map(item => ({
                type: 'bookmark',
                title: titleFor(item),
                url: item.url
            }))
    }));

    return {
        type: 'folder',
        title: providerFolderTitle(provider),
        children: [{ type: 'folder', title: listTitle, children: monthFolders }]
    };
}

// Replace the provider's folder under the imports root, leaving other providers
// and anything else in the tree untouched. Returns true when the tree changed.
export function applyProviderFolder(snapshot, providerFolder) {
    const root = findOrCreateImportsRoot(snapshot);
    if (!root) return false;
    root.children = root.children || [];

    const idx = root.children.findIndex(c => isFolder(c) && c.title === providerFolder.title);
    const before = idx >= 0 ? JSON.stringify(root.children[idx]) : null;
    const after = JSON.stringify(providerFolder);
    if (before === after) return false;

    if (idx >= 0) root.children[idx] = providerFolder;
    else root.children.push(providerFolder);
    return true;
}
