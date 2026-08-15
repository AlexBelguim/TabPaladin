// Projection: archive rows -> bookmark subtree inside the snapshot.
//
// The projection is a full deterministic rebuild of one provider's subtree, not
// an incremental patch. That is what makes it self-healing: if a browser pushes
// a tree that predates the import folder, the next projection puts it back
// verbatim instead of leaving a hole.
//
// A plain rebuild would also undo the user, though: move an import out to file
// it and the next sweep puts a second copy back, delete one and it returns. So
// the rebuild is preceded by a reconcile pass that reads what the user did to
// the folder and records it, and only then rebuilds from what is left.

export const IMPORTS_ROOT_TITLE = 'TabPaladin Imports';

const PROVIDER_FOLDER = {
    reddit: 'Reddit',
    x: 'X',
    instagram: 'Instagram'
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

// Locate an existing provider folder without creating anything. Returns null
// when the snapshot has no imports root at all, which the reconcile pass treats
// very differently from an empty one.
export function findProviderFolder(snapshot, providerTitle) {
    const roots = snapshot.children || [];
    let importsRoot = null;
    for (const rootChild of roots) {
        if (isFolder(rootChild) && rootChild.title === IMPORTS_ROOT_TITLE) { importsRoot = rootChild; break; }
        for (const c of rootChild.children || []) {
            if (isFolder(c) && c.title === IMPORTS_ROOT_TITLE) { importsRoot = c; break; }
        }
        if (importsRoot) break;
    }
    if (!importsRoot) return null;
    return (importsRoot.children || []).find(c => isFolder(c) && c.title === providerTitle) || null;
}

function collectUrls(node, out = new Set()) {
    if (!node) return out;
    if (node.type === 'bookmark' && node.url) out.add(node.url);
    for (const c of node.children || []) collectUrls(c, out);
    return out;
}

// Every URL in the tree except those under the given subtree.
function urlsOutside(snapshot, excluded) {
    const out = new Set();
    const walk = (node) => {
        if (!node || node === excluded) return;
        if (node.type === 'bookmark' && node.url) out.add(node.url);
        for (const c of node.children || []) walk(c);
    };
    walk(snapshot);
    return out;
}

// Decide what the user did to the import folder since it was last projected.
//
//   in the folder            -> untouched, keep projecting it
//   somewhere else in tree   -> filed; stop projecting so it is not duplicated
//   nowhere at all           -> deleted; purge it
//
// Two guards, both load-bearing, because getting this wrong destroys an archive
// that by definition cannot be re-fetched:
//
//  1. No provider folder in the snapshot at all means this tree predates the
//     folder — a device that pushed before it pulled. Everything would look
//     deleted. Reconcile nothing and let the rebuild heal the folder instead.
//  2. An item is only judged if it was actually drawn into a committed snapshot
//     at some point, and drawn in *before* this one was taken. Absence only
//     means "removed" for something that was once present. Judging on import
//     time instead purges anything swept but not yet projected, and a stale
//     device pushing an older copy of the folder would take out every item
//     swept since it last pulled.
export function reconcile({ snapshot, snapshotTimestamp, providerTitle, items }) {
    const folder = findProviderFolder(snapshot, providerTitle);
    if (!folder) return { filed: [], purged: [], skipped: 'no provider folder in snapshot' };

    const inFolder = collectUrls(folder);
    const elsewhere = urlsOutside(snapshot, folder);
    const cutoff = snapshotTimestamp ? Date.parse(snapshotTimestamp) : NaN;

    const filed = [];
    const purged = [];
    for (const item of items) {
        if (inFolder.has(item.url)) continue;
        // Never been placed in the folder — it cannot have been taken out of it.
        if (!item.projected_at) continue;
        // Placed only after this snapshot was taken, so the snapshot predates
        // it and its absence says nothing.
        if (Number.isFinite(cutoff) && Date.parse(item.projected_at) > cutoff) continue;
        if (elsewhere.has(item.url)) filed.push(item);
        else purged.push(item);
    }
    return { filed, purged, skipped: null };
}

// Locate the imports root along with whichever root folder holds it, so
// anything that does not belong inside can be put back out.
function findImportsRootWithParent(snapshot) {
    const roots = snapshot.children || [];
    for (const rootChild of roots) {
        if (isFolder(rootChild) && rootChild.title === IMPORTS_ROOT_TITLE) {
            return { folder: rootChild, parent: snapshot };
        }
        for (const c of rootChild.children || []) {
            if (isFolder(c) && c.title === IMPORTS_ROOT_TITLE) {
                return { folder: c, parent: rootChild };
            }
        }
    }
    return null;
}

// Bookmarks that are not part of the swept archive but are sitting inside it —
// filed in from another device, or from the browser's own bookmark manager,
// which no amount of UI can prevent.
//
// Nothing may live in here: the next sweep rebuilds this subtree from the
// server's records, so anything else is deleted by definition. Rather than let
// the rebuild eat it, move it out to the folder holding the imports root. The
// bookmark survives, and the archive stays exactly what the importer put there.
export function ejectForeign(snapshot, providerTitle, knownUrls) {
    const found = findImportsRootWithParent(snapshot);
    if (!found) return [];
    const folder = findProviderFolder(snapshot, providerTitle);
    if (!folder) return [];

    const moved = [];
    const walk = (node) => {
        if (!node) return;
        if (node.type === 'bookmark' && node.url && !knownUrls.has(node.url)) {
            moved.push({ type: 'bookmark', title: node.title, url: node.url });
        }
        for (const c of node.children || []) walk(c);
    };
    walk(folder);
    if (!moved.length) return [];

    const dest = found.parent;
    dest.children = dest.children || [];
    // Do not re-add one that is already sitting outside; a stray copy inside is
    // then simply dropped by the rebuild.
    const already = new Set(
        dest.children.filter(c => c.type === 'bookmark' && c.url).map(c => c.url)
    );
    for (const b of moved) {
        if (!already.has(b.url)) { dest.children.push(b); already.add(b.url); }
    }
    return moved;
}

// Whatever that platform calls the thing a post belongs to. It is what makes a
// wall of archived links scannable, so it is worth spelling natively rather
// than prefixing everything with Reddit's convention.
const CONTAINER_PREFIX = {
    reddit: (c) => `r/${c}`,
    x: (c) => `@${c}`,
    instagram: (c) => `@${c}`
};

// Bookmark titles carry it so the archive stays readable once it is thousands
// of entries deep and the folder name alone tells you nothing.
function titleFor(item, provider) {
    const base = item.title || item.url;
    const fmt = CONTAINER_PREFIX[provider];
    const prefix = item.container && fmt ? `${fmt(item.container)} — ` : '';
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
                title: titleFor(item, provider),
                url: item.url
            }))
    }));

    // Exactly what the importer swept, and nothing else. Anything the user put
    // in here has already been moved out by ejectForeign, so the rebuild is
    // free to drop everything it does not recognise.
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
