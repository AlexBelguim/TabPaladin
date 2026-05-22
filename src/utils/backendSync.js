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
        'other bookmarks': 'other',
        'unfiled bookmarks': 'other',
        'mobile bookmarks': 'mobile',
        'mobile': 'mobile',
    };
    return ALIASES[t] || t;
}

async function fullBookmarkSnapshot(focusedFolderIds = [], workflowRootId = null) {
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

    // If no focused folder IDs are selected and no workflowRootId, push everything (fallback)
    if (focusedFolderIds.length === 0 && !workflowRootId) {
        return {
            version: 1,
            exportedAt: new Date().toISOString(),
            ...serializeNodeInner(root)
        };
    }

    const focusedSet = new Set(focusedFolderIds);
    if (workflowRootId) {
        focusedSet.add(workflowRootId);
    }

    function hasFocusedDescendant(node) {
        if (focusedSet.has(node.id)) return true;
        if (node.children) {
            return node.children.some(child => hasFocusedDescendant(child));
        }
        return false;
    }

    function serializeFilteredNode(node, insideSelected) {
        const isSelected = focusedSet.has(node.id);
        const keepAll = insideSelected || isSelected;

        if (node.url) {
            if (keepAll) {
                return {
                    type: 'bookmark',
                    title: node.title,
                    url: node.url,
                    dateAdded: node.dateAdded
                };
            }
            return null;
        }

        // For folders: if not inside a selected parent, only keep if it has a focused descendant.
        // The virtual root is always preserved. Other native roots are only kept
        // if they or their descendants are targeted.
        const sid = String(node.id);
        const isVirtualRoot = sid === String(root.id);
        if (!keepAll && !isVirtualRoot && !hasFocusedDescendant(node)) {
            return null;
        }

        const serializedChildren = [];
        for (const child of node.children || []) {
            const res = serializeFilteredNode(child, keepAll);
            if (res) serializedChildren.push(res);
        }

        // For non-root folders, we only keep them if they are selected or had children serialized
        if (!keepAll && !isVirtualRoot && serializedChildren.length === 0) {
            return null;
        }

        return {
            type: isVirtualRoot ? 'root' : 'folder',
            title: node.title || '',
            dateAdded: node.dateAdded,
            nativeId: rootChildIds.has(sid) ? sid : undefined,
            children: serializedChildren
        };
    }

    return {
        version: 1,
        exportedAt: new Date().toISOString(),
        ...serializeFilteredNode(root, false)
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

    async push(config, focusedFolderIds = [], workflowRootId = null) {
        const snapshot = await fullBookmarkSnapshot(focusedFolderIds, workflowRootId);
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
            try {
                console.log(`[TabPaladin Pull] --- Processing browser root "${br.title}" (id=${br.id}) ← snapshot "${snapChild.title}" ---`);
                await emptyFolder(br.id);
                if (snapChild.children && snapChild.children.length) {
                    console.log(`[TabPaladin Pull] Recreating ${snapChild.children.length} children...`);
                    await recreateChildren(br.id, snapChild.children);
                }
                // Verify
                const verify = await api.bookmarks.getChildren(br.id);
                console.log(`[TabPaladin Pull] VERIFY "${br.title}": ${verify.length} children now exist`);
            } catch (e) {
                console.warn(`[TabPaladin Pull] ❌ Failed during pull for root "${br.title}" (id=${br.id})`, e);
            }
        }

        // --- Handle orphan snapshot children: put them under the "Other Bookmarks" equivalent ---
        if (orphanSnapChildren.length > 0) {
            // Find the browser's "Other Bookmarks" equivalent
            const otherRoot = browserRoots.find(r => normalizeRootTitle(r.title) === 'other')
                || browserRoots[browserRoots.length - 1]; // last resort fallback

            for (const orphan of orphanSnapChildren) {
                console.warn(`[TabPaladin Pull] Orphan snapshot root "${orphan.title}" → recreating under "${otherRoot.title}" (id=${otherRoot.id})`);
                try {
                    const f = await api.bookmarks.create({ parentId: otherRoot.id, title: orphan.title || 'Folder' });
                    if (orphan.children && orphan.children.length) {
                        await recreateChildren(f.id, orphan.children);
                    }
                } catch (e) {
                    console.warn('[TabPaladin Pull] ❌ Failed during pull for orphan root folder', orphan.title, e);
                }
            }
        }

        console.log('[TabPaladin Pull] ✅ Pull complete.');
    }
};
