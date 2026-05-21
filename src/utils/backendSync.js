// Backend sync — push/pull selected bookmark folders to a TabPaladin sync server.

const api = typeof browser !== 'undefined' ? browser : chrome;

function authHeader(token) {
    return token ? { 'Authorization': 'Bearer ' + token } : {};
}

function trim(url) { return (url || '').replace(/\/$/, ''); }

// Serialize a chrome.bookmarks node into the on-wire JSON shape.
function serializeNode(node) {
    if (node.url) {
        return {
            type: 'bookmark',
            title: node.title,
            url: node.url,
            dateAdded: node.dateAdded
        };
    }
    return {
        type: node.id === '0' ? 'root' : 'folder',
        title: node.title || '',
        dateAdded: node.dateAdded,
        // We preserve native browser IDs ('1', '2', '3') for root children so pull can map.
        nativeId: ['0', '1', '2', '3'].includes(node.id) ? node.id : undefined,
        children: (node.children || []).map(serializeNode)
    };
}

async function fullBookmarkSnapshot(focusedFolderIds = [], workflowRootId = null) {
    const tree = await api.bookmarks.getTree();
    const root = tree[0]; // virtual root with id '0'
    
    // If no focused folder IDs are selected and no workflowRootId, push everything (fallback)
    if (focusedFolderIds.length === 0 && !workflowRootId) {
        return {
            version: 1,
            exportedAt: new Date().toISOString(),
            ...serializeNode(root)
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
        // The virtual root '0' is always preserved. Other native roots ('1', '2', '3') are only kept
        // if they or their descendants are targeted.
        const isVirtualRoot = node.id === '0';
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
            type: node.id === '0' ? 'root' : 'folder',
            title: node.title || '',
            dateAdded: node.dateAdded,
            nativeId: ['0', '1', '2', '3'].includes(node.id) ? node.id : undefined,
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
    for (const node of children || []) {
        if (!node || typeof node !== 'object') continue;
        if (node.type === 'bookmark' && node.url) {
            try { await api.bookmarks.create({ parentId, title: node.title || node.url, url: node.url }); }
            catch (e) { console.warn('Failed to create bookmark', node, e); }
        } else if (node.type === 'folder') {
            try {
                const f = await api.bookmarks.create({ parentId, title: node.title || 'Folder' });
                await recreateChildren(f.id, node.children || []);
            } catch (e) { console.warn('Failed to create folder', node, e); }
        }
    }
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

    // Destructive: replaces the contents of Bookmarks Bar / Other Bookmarks / Mobile
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
            'roots:', snapshot.children.map(c => `${c.title}(${c.nativeId || 'no-nativeId'}, ${(c.children || []).length} children)`).join(' | '),
            '| total folders:', totals.f, '| total bookmarks:', totals.b);

        // Recovery for snapshots pushed before the nativeId fix: map by well-known root titles.
        const TITLE_TO_NATIVE = {
            'bookmarks bar': '1',
            'bookmarks toolbar': '1',
            'other bookmarks': '2',
            'unfiled bookmarks': '2',
            'mobile bookmarks': '3',
            'mobile': '3'
        };

        // Map snapshot root children by nativeId — with title-based fallback.
        const nativeMap = new Map();
        const stillOrphan = [];
        for (const c of snapshot.children) {
            if (c.nativeId) {
                nativeMap.set(c.nativeId, c);
                continue;
            }
            const guess = TITLE_TO_NATIVE[(c.title || '').toLowerCase()];
            if (guess && !nativeMap.has(guess)) {
                console.log(`[TabPaladin Pull] recovering root by title "${c.title}" → nativeId ${guess}`);
                nativeMap.set(guess, c);
            } else {
                stillOrphan.push(c);
            }
        }

        // For each real browser root, clear it completely.
        // If the snapshot has matching native root children, recreate them.
        for (const localId of ['1', '2', '3']) {
            try {
                await emptyFolder(localId);
                const snap = nativeMap.get(localId);
                if (snap && snap.children) {
                    await recreateChildren(localId, snap.children);
                }
            } catch (e) {
                console.warn('Failed during pull apply for root', localId, e);
            }
        }

        // Anything left orphan: merge its CHILDREN into Other Bookmarks (no nested wrapper folder).
        for (const orphan of stillOrphan) {
            console.warn('[TabPaladin Pull] unrecognized orphan, merging children into Other Bookmarks:', orphan.title);
            if (orphan.children && orphan.children.length) {
                await recreateChildren('2', orphan.children);
            }
        }
    }
};
