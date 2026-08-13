// Backend sync — push/pull selected bookmark folders to a TabPaladin sync server.

const api = typeof browser !== 'undefined' ? browser : chrome;

function authHeader(token) {
    return token ? { 'Authorization': 'Bearer ' + token } : {};
}

function trim(url) { return (url || '').replace(/\/$/, ''); }

// Normalize root folder titles across browsers (Chrome, Opera, Firefox, Brave, Edge).
// Returns a canonical key so "Other Bookmarks" (Chrome), "Other bookmarks" (Opera),
// "Unfiled Bookmarks" (Firefox) all map to the same thing.
function normalizeRootTitle(title) {
    const t = (title || '').toLowerCase().trim();
    const ALIASES = {
        'bookmarks bar': 'bookmarks_bar',
        'bookmarks toolbar': 'bookmarks_bar',
        'favourites bar': 'bookmarks_bar',
        'favorites bar': 'bookmarks_bar',
        'other bookmarks': 'other',
        'unfiled bookmarks': 'other',
        // Opera calls it this, and its absence here is what produced duplicate
        // workflow roots: a snapshot pushed from Chrome carries "Other
        // Bookmarks" (-> other) which matched nothing on Opera, so the whole
        // subtree became an orphan and got recreated somewhere else on every
        // single pull. Opera also exposes Speed Dials, Pinboard, Trash and
        // friends, which are deliberately left unaliased — they have no
        // counterpart elsewhere and should never absorb another browser's root.
        'unsorted bookmarks': 'other',
        'mobile bookmarks': 'mobile',
        'mobile': 'mobile',
    };
    return ALIASES[t] || t;
}

async function fullBookmarkSnapshot(focusedFolderIds = [], workflowRootId = null, notesRootId = null) {
    const tree = await api.bookmarks.getTree();
    const root = tree[0]; // virtual root with id '0'

    // Dynamically detect root folder IDs — works across Chrome, Opera, Brave, Edge, Firefox.
    // Instead of hardcoding ['0','1','2','3'], we discover what the browser actually has.
    const rootChildIds = new Set((root.children || []).map(c => String(c.id)));
    rootChildIds.add(String(root.id)); // include virtual root '0'

    // Inner serializer that uses the dynamically detected root IDs.
    function serializeNodeInner(node) {
        if (node.url) {
            return {
                type: 'bookmark',
                title: node.title,
                url: node.url,
                dateAdded: node.dateAdded
            };
        }
        const sid = String(node.id);
        return {
            type: sid === String(root.id) ? 'root' : 'folder',
            title: node.title || '',
            dateAdded: node.dateAdded,
            // Preserve native browser IDs for root children so pull can map.
            nativeId: rootChildIds.has(sid) ? sid : undefined,
            children: (node.children || []).map(serializeNodeInner)
        };
    }

    // Always push the whole tree.
    //
    // Pull replaces a matched root's entire contents, so a filtered push made
    // the two directions disagree about what a snapshot means: push a subset,
    // pull it back, and the root got replaced by that subset. Everything the
    // filter dropped was deleted on the next device to pull. Push and pull are
    // now both whole-tree, which is the only pairing where a round trip is
    // lossless.
    //
    // The focus arguments are kept so existing callers still work, but they no
    // longer narrow the snapshot.
    if (focusedFolderIds.length || workflowRootId || notesRootId) {
        console.log('[TabPaladin Push] Focus arguments ignored — pushing the full tree.');
    }

    return {
        version: 1,
        exportedAt: new Date().toISOString(),
        ...serializeNodeInner(root)
    };

}

// Recreate children under an existing parent. Used during pull.
async function recreateChildren(parentId, children) {
    let created = 0;
    let skipped = 0;
    for (const node of children || []) {
        if (!node || typeof node !== 'object') { skipped++; continue; }
        if (node.type === 'bookmark' && node.url) {
            try {
                await api.bookmarks.create({ parentId, title: node.title || node.url, url: node.url });
                created++;
            }
            catch (e) { console.warn('[TabPaladin Pull] ❌ Failed to create bookmark:', node.title, e); }
        } else if (node.type === 'folder') {
            try {
                const f = await api.bookmarks.create({ parentId, title: node.title || 'Folder' });
                created++;
                console.log(`[TabPaladin Pull]   📁 Created folder "${node.title}" (new id: ${f.id}) under parent ${parentId}`);
                await recreateChildren(f.id, node.children || []);
            } catch (e) { console.warn('[TabPaladin Pull] ❌ Failed to create folder:', node.title, e); }
        } else {
            console.warn(`[TabPaladin Pull] ⚠️ Skipping unknown node: type="${node.type}", title="${node.title}"`);
            skipped++;
        }
    }
    console.log(`[TabPaladin Pull] recreateChildren(parent=${parentId}): created ${created}, skipped ${skipped}, total ${(children || []).length}`);
}

// Empty a folder (used to wipe root children during destructive pull).
async function emptyFolder(folderId) {
    const children = await api.bookmarks.getChildren(folderId);
    for (const c of children) {
        try {
            if (c.url) await api.bookmarks.remove(c.id);
            else await api.bookmarks.removeTree(c.id);
        } catch (e) { console.warn('Failed to remove during pull', c.id, e); }
    }
}

export const BackendSync = {
    async health(config) {
        const res = await fetch(trim(config.url) + '/api/health');
        return res.json();
    },

    async push(config, focusedFolderIds = [], workflowRootId = null, notesRootId = null) {
        const snapshot = await fullBookmarkSnapshot(focusedFolderIds, workflowRootId, notesRootId);
        const res = await fetch(trim(config.url) + '/api/push', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeader(config.token) },
            body: JSON.stringify({ snapshot, deviceId: 'extension' })
        });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
        const data = await res.json();
        return data.timestamp;
    },

    async pullLatestInfo(config) {
        const res = await fetch(trim(config.url) + '/api/pull', {
            headers: authHeader(config.token)
        });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
        return res.json();
    },

    // Destructive: replaces the contents of matched browser root folders
    // with the snapshot's corresponding root children.
    async applyPull(snapshot) {
        if (!snapshot || !snapshot.children) throw new Error('Empty snapshot');

        // --- Diagnostic: log what we're about to apply so users can verify the snapshot is complete.
        const summarize = (node) => {
            if (!node) return { f: 0, b: 0 };
            let f = node.type === 'folder' ? 1 : 0;
            let b = node.type === 'bookmark' ? 1 : 0;
            for (const c of node.children || []) {
                const s = summarize(c);
                f += s.f;
                b += s.b;
            }
            return { f, b };
        };
        const totals = summarize(snapshot);
        console.log('[TabPaladin Pull] incoming snapshot —',
            'roots:', snapshot.children.map(c => `${c.title}(nativeId=${c.nativeId || 'none'}, ${(c.children || []).length} children)`).join(' | '),
            '| total folders:', totals.f, '| total bookmarks:', totals.b);

        // Verbose diagnostic: list every folder path in the snapshot.
        try {
            const verbose = localStorage.getItem('tp_pull_verbose') === '1';
            const findKey = (localStorage.getItem('tp_pull_find') || '').toLowerCase();
            const pathsOf = (node, path = []) => {
                const out = [];
                const curPath = (node.type === 'folder' || node.type === 'root') && node.title
                    ? [...path, node.title]
                    : path;
                if (node.type === 'folder' && path.length > 0) out.push(curPath.join(' / '));
                for (const c of node.children || []) out.push(...pathsOf(c, curPath));
                return out;
            };
            if (verbose || findKey) {
                const all = pathsOf(snapshot);
                if (verbose) console.log('[TabPaladin Pull] all folder paths in snapshot:', all);
                if (findKey) {
                    const matches = all.filter(p => p.toLowerCase().includes(findKey));
                    console.log(`[TabPaladin Pull] folder paths matching "${findKey}":`, matches);
                }
            }
        } catch (e) { /* localStorage might be unavailable in some contexts */ }

        // --- Dynamically discover the browser's actual root folders ---
        // This works for Chrome ('1','2','3'), Opera ('1','2','3','4','5',...), Firefox, Brave, Edge.
        const browserRoots = await api.bookmarks.getChildren('0');
        console.log('[TabPaladin Pull] Browser root folders:',
            browserRoots.map(r => `"${r.title}"(id=${r.id})`).join(', '));

        // --- Match each snapshot root child to an actual browser root ---
        // Priority: 1) exact nativeId match, 2) normalized title match
        const matched = new Map();     // browserRootId → snapChild
        const usedSnapChildren = new Set();

        // Pass 1: match by nativeId (if the snapshot was pushed from the same browser, IDs match)
        for (const snapChild of snapshot.children) {
            if (snapChild.nativeId) {
                const br = browserRoots.find(r => String(r.id) === String(snapChild.nativeId));
                if (br && !matched.has(br.id)) {
                    matched.set(br.id, snapChild);
                    usedSnapChildren.add(snapChild);
                    console.log(`[TabPaladin Pull] Matched snapshot "${snapChild.title}" → browser root "${br.title}" (by nativeId ${snapChild.nativeId})`);
                }
            }
        }

        // Pass 2: match remaining snapshot children by normalized title
        for (const snapChild of snapshot.children) {
            if (usedSnapChildren.has(snapChild)) continue;
            const snapNorm = normalizeRootTitle(snapChild.title);

            for (const br of browserRoots) {
                if (matched.has(br.id)) continue;
                const brNorm = normalizeRootTitle(br.title);
                if (snapNorm === brNorm) {
                    matched.set(br.id, snapChild);
                    usedSnapChildren.add(snapChild);
                    console.log(`[TabPaladin Pull] Matched snapshot "${snapChild.title}" → browser root "${br.title}" (by title match, norm="${snapNorm}")`);
                    break;
                }
            }
        }

        // Collect orphan snapshot children that couldn't match any browser root
        const orphanSnapChildren = snapshot.children.filter(c => !usedSnapChildren.has(c));

        // --- Apply: for each matched browser root, empty it and recreate from snapshot ---
        for (const [browserRootId, snapChild] of matched) {
            const br = browserRoots.find(r => r.id === browserRootId);
            const incoming = (snapChild.children || []).length;

            // Never empty a root we aren't going to refill.
            //
            // The wipe used to be unconditional while the restore was guarded by
            // this same count, so a snapshot carrying an empty root child deleted
            // everything under the matching browser root and put nothing back —
            // removeTree on every folder, including bookmarks that had nothing to
            // do with TabPaladin. push() accepts focusedFolderIds, so a partial
            // push followed by a pull is enough to trigger it.
            if (incoming === 0) {
                console.warn(`[TabPaladin Pull] SKIPPING "${br.title}" (id=${br.id}) — the snapshot has 0 ` +
                    `children for it. Emptying it would delete its contents and restore nothing.`);
                continue;
            }

            try {
                console.log(`[TabPaladin Pull] --- Processing browser root "${br.title}" (id=${br.id}) ← snapshot "${snapChild.title}" ---`);
                await emptyFolder(br.id);
                console.log(`[TabPaladin Pull] Recreating ${incoming} children...`);
                await recreateChildren(br.id, snapChild.children);
                // Verify
                const verify = await api.bookmarks.getChildren(br.id);
                console.log(`[TabPaladin Pull] VERIFY "${br.title}": ${verify.length} children now exist`);
            } catch (e) {
                console.warn(`[TabPaladin Pull] ❌ Failed during pull for root "${br.title}" (id=${br.id})`, e);
            }
        }

        // --- Handle orphan snapshot children: put them under the "Other Bookmarks" equivalent ---
        if (orphanSnapChildren.length > 0) {
            // Find the browser's "Other Bookmarks" equivalent.
            //
            // The old fallback was browserRoots[length - 1], which on Opera is
            // whatever happens to sort last — Trash or Unsynchronized Pinboard.
            // Recreating a subtree there is worse than not recreating it, so
            // prefer 'other', then the bookmarks bar, and otherwise refuse.
            const otherRoot = browserRoots.find(r => normalizeRootTitle(r.title) === 'other')
                || browserRoots.find(r => normalizeRootTitle(r.title) === 'bookmarks_bar')
                || null;

            if (!otherRoot) {
                console.warn('[TabPaladin Pull] No "other" or bookmarks-bar root to hold orphans; skipping ' +
                    `${orphanSnapChildren.length} unmatched snapshot root(s): ` +
                    orphanSnapChildren.map(o => `"${o.title}"`).join(', '));
            }

            const existingUnderOther = otherRoot ? await api.bookmarks.getChildren(otherRoot.id) : [];

            for (const orphan of orphanSnapChildren) {
                if (!otherRoot) break;
                const title = orphan.title || 'Folder';
                const incoming = (orphan.children || []).length;
                if (incoming === 0) {
                    console.warn(`[TabPaladin Pull] Skipping empty orphan root "${title}".`);
                    continue;
                }

                try {
                    // Reuse a folder of the same name if one is already here.
                    //
                    // This used to create unconditionally, so an orphan that never
                    // matched a browser root — easy to hit, since root names differ
                    // between Chrome and Firefox and matching is by normalized
                    // title — spawned a fresh copy on *every* pull. Each copy
                    // brought its own "TabPaladin Workflows" inside it, and
                    // resolveRootFolder then picked between them by child count,
                    // so saves landed in whichever was winning that day. That is
                    // the workflows-splitting-into-multiple-folders symptom.
                    let target = existingUnderOther.find(c => !c.url && c.title === title);
                    if (target) {
                        console.warn(`[TabPaladin Pull] Orphan snapshot root "${title}" → reusing existing folder (id=${target.id}) under "${otherRoot.title}"`);
                        await emptyFolder(target.id);
                    } else {
                        console.warn(`[TabPaladin Pull] Orphan snapshot root "${title}" → creating under "${otherRoot.title}" (id=${otherRoot.id})`);
                        target = await api.bookmarks.create({ parentId: otherRoot.id, title });
                        existingUnderOther.push(target);
                    }
                    await recreateChildren(target.id, orphan.children);
                } catch (e) {
                    console.warn('[TabPaladin Pull] ❌ Failed during pull for orphan root folder', title, e);
                }
            }
        }

        console.log('[TabPaladin Pull] ✅ Pull complete.');
    }
};
