import { TabGrouper } from './tabGrouper.js';
import { AIService } from './aiService.js';


export const BookmarkOrganizer = {
    // Export AIService for sidepanel to use directly if needed
    AIService: AIService,

    /**
     * Getting top-level folder structure for user selection.
     */
    getStructure: async () => {
        try {
            const tree = await chrome.bookmarks.getTree();
            if (!tree || tree.length === 0) return [];
            const root = tree[0];
            return root.children || [];
        } catch (e) {
            console.error("Error getting bookmark structure:", e);
            return [];
        }
    },

    /**
     * Gets immediate subfolders and file-count of specific folders.
     * Used for granular source selection within a scope.
     */
    /**
     * Gets contents of a specific folder (Loose Count + Subfolders).
     * Used for drill-down navigation.
     */
    getDirectoryContents: async (folderId) => {
        try {
            // Handle Root Scope (Array of IDs scenario or Single ID)
            // If folderId is 'root', we might need top level?
            // Assuming single ID for drill down.
            const subTree = await chrome.bookmarks.getSubTree(folderId);
            if (!subTree || subTree.length === 0) return null;

            const root = subTree[0];
            const looseCount = root.children ? root.children.filter(c => c.url).length : 0;
            const subfolders = root.children ? root.children.filter(c => !c.url) : [];

            return {
                id: root.id,
                title: root.title,
                looseCount,
                subfolders: subfolders.map(f => {
                    const children = f.children || [];
                    const fileCount = children.filter(c => c.url).length;
                    const folderCount = children.filter(c => !c.url).length;
                    return {
                        id: f.id,
                        title: f.title,
                        fileCount,
                        folderCount
                    };
                })
            };
        } catch (e) {
            console.error(e);
            return null;
        }
    },

    /**
     * Recursively finds ALL folders within scope that contain bookmarks (files).
     * Returns a flat list of "Containers" to check/uncheck.
     */
    getFlattenedScope: async (scopeIds) => {
        let results = [];

        // Helper to process a node and its children
        function traverse(node, currentPath, currentPathId) {
            const myTitle = node.title || (node.id === '1' ? 'Bookmarks Bar' : node.id === '2' ? 'Other Bookmarks' : 'Mobile');

            // Build Path
            // If root (0), skip. If top level (1,2,3), just use title. Else append.
            let newPath = currentPath;
            if (node.id !== '0') {
                newPath = currentPath ? `${currentPath} > ${myTitle}` : myTitle;
            } else {
                newPath = ''; // Root has no path
            }

            // Check content of THIS node
            // Does it have children that are URLs?
            if (node.children) {
                const looseCount = node.children.filter(c => c.url).length;
                if (looseCount > 0) {
                    results.push({
                        id: node.id,
                        title: newPath + (node.id === '0' ? '' : ' (Files)'), // Visual label
                        fullPath: newPath, // Key for display opacity
                        type: 'loose', // It's a "Container of Loose Files" for this specific folder
                        originalId: node.id,
                        count: looseCount,
                        depth: newPath.split('>').length // Rough depth
                    });
                }

                // Recurse to subfolders
                node.children.forEach(child => {
                    if (!child.url) {
                        traverse(child, newPath, '');
                    }
                });
            }
        }

        for (const id of scopeIds) {
            try {
                const subTree = await chrome.bookmarks.getSubTree(id);
                if (subTree && subTree.length > 0) {
                    // subTree[0] is the folder itself.
                    // We need its path context? 
                    // Actually getting SubTree returns the node relative to itself as root usually?
                    // No, it returns the node with its properties. 
                    // We might need full path context if the user selects a deep folder as scope.
                    // But getStructure returns top level.
                    // For now, let's just traverse starting from this node, using its title as base.
                    traverse(subTree[0], '', '');
                }
            } catch (e) { console.error(e); }
        }

        return results;
    },

    /**
     * Recursive function to map all folders with their full paths.
     * @param {Array<string>} [allowedRootIds] - Optional. If provided, restricts map to folders descending from these roots.
     * @returns {Promise<Array>} Array of { id, title, path, pathId }
     */
    getFolderMap: async (allowedRootIds = null) => {
        const tree = await chrome.bookmarks.getTree();
        let folders = [];

        function traverse(node, currentPath, currentPathId) {
            if (node.children) {
                // It is a folder (or root)
                let newPath = currentPath;
                let newPathId = currentPathId;

                // Don't modify path for Root (0)
                if (node.id !== '0') {
                    const title = node.title || (node.id === '1' ? 'Bookmarks Bar' : node.id === '2' ? 'Other Bookmarks' : 'Mobile Bookmarks');
                    newPath = currentPath ? `${currentPath} > ${title}` : title;
                    newPathId = currentPathId ? `${currentPathId}/${node.id}` : node.id;

                    // Filter Logic:
                    // If allowedRootIds is set, we only include this folder if:
                    // 1. It IS one of the allowed roots.
                    // 2. OR its pathId starts with one of the allowed roots (it is a child).
                    let include = true;
                    if (allowedRootIds && allowedRootIds.length > 0) {
                        // Check if the current path includes any of the allowed IDs.
                        // This supports selecting a subfolder (e.g. ID 50) and getting 50 + its children.
                        // Path format: "0/1/50/99"
                        const segments = newPathId.split('/');
                        const startsWithAllowed = allowedRootIds.some(id => segments.includes(id));
                        if (!startsWithAllowed) include = false;
                    }

                    if (include) {
                        folders.push({
                            id: node.id,
                            title: node.title,
                            fullPath: newPath,
                            pathIds: newPathId
                        });
                    }
                }

                node.children.forEach(child => traverse(child, newPath, newPathId));
            }
        }

        // Start traversal
        tree.forEach(node => traverse(node, '', ''));
        return folders;
    },

    /**
     * Flattens specific folders to get all containsed bookmarks.
     */
    flattenFolders: async (folderIds) => {
        let bookmarks = [];

        async function traverse(id) {
            const nodes = await chrome.bookmarks.getSubTree(id);

            function visit(node) {
                if (node.url) {
                    bookmarks.push(node);
                } else if (node.children) {
                    node.children.forEach(visit);
                }
            }
            nodes.forEach(visit);
        }

        async function getLoose(id) {
            const nodes = await chrome.bookmarks.getSubTree(id);
            if (nodes && nodes[0] && nodes[0].children) {
                nodes[0].children.forEach(node => {
                    if (node.url) bookmarks.push(node);
                });
            }
        }

        for (const input of folderIds) {
            if (input.startsWith('loose-')) {
                const realId = input.replace('loose-', '');
                await getLoose(realId);
            } else {
                await traverse(input);
            }
        }
        return bookmarks;
    },

    /**
     * Smart Analysis and Proposal Generation.
     * @param {Array} folderIds - IDs of folders to organize (source).
     */
    /**
     * Smart Analysis and Proposal Generation (Recursive / Local Scope).
     * @param {Array} folderIds - IDs of folders to organize (source). 
     * Handles 'loose-ID' format by strictly looking at that folder's scope.
     */
    proposeSmartOrganization: async (folderIds) => {
        const proposals = { groups: [] };

        // Helper: Find existing subfolder by name or synonyms
        async function findSubfolder(parentId, name, useSynonyms = false) {
            const children = await chrome.bookmarks.getChildren(parentId);
            const folders = children.filter(c => !c.url);

            // 1. Exact Match
            let match = folders.find(f => f.title.toLowerCase() === name.toLowerCase());

            // 2. Synonym Match
            if (!match && useSynonyms && TabGrouper.CONTEXT_SYNONYMS && TabGrouper.CONTEXT_SYNONYMS[name]) {
                for (const syn of TabGrouper.CONTEXT_SYNONYMS[name]) {
                    match = folders.find(f => f.title.toLowerCase() === syn.toLowerCase());
                    if (match) break;
                }
            }
            return match;
        }

        for (const inputId of folderIds) {
            // Parse ID (loose-123 -> 123)
            const sourceId = inputId.replace('loose-', '');

            // Get Items to Organize (Only loose files in this folder)
            // We use getSubTree to be sure we are looking at the right place
            const tree = await chrome.bookmarks.getSubTree(sourceId);
            if (!tree || !tree.length) continue;

            const root = tree[0];
            const looseItems = root.children ? root.children.filter(c => c.url) : [];
            if (looseItems.length === 0) continue;

            const rootPath = root.title || 'Root';

            // Get Settings for Custom Keywords
            const settings = await StorageManager.getSettings();
            const customKeywords = settings.customKeywords || {};

            // Group by Context (with Custom Keywords)
            const grouped = TabGrouper.groupByContext(looseItems, customKeywords);

            for (const [context, items] of Object.entries(grouped)) {
                if (context === "Other" || items.length === 0) continue;

                // Step 1: Find/Propose Context Folder in Source
                // e.g. Source/Gaming
                const contextFolder = await findSubfolder(sourceId, context, true);

                // Group by Domain
                const byDomain = {};
                items.forEach(item => {
                    try {
                        const domain = new URL(item.url).hostname.replace('www.', '').split('.')[0];
                        if (!byDomain[domain]) byDomain[domain] = [];
                        byDomain[domain].push(item);
                    } catch (e) { }
                });

                for (const [domain, domainItems] of Object.entries(byDomain)) {
                    const niceDomain = domain.charAt(0).toUpperCase() + domain.slice(1);

                    // Step 2: Recursive Drill - Where should this Domain go?

                    // Case A: Context Folder Exists (e.g. "Gaming" exists)
                    // We check inside "Gaming" for "Minecraft"
                    let targetId = null;
                    let targetPath = '';
                    let action = 'CREATE';
                    let newSubfolder = '';

                    if (contextFolder) {
                        // Check inside Context Folder for Domain Folder
                        const domainFolder = await findSubfolder(contextFolder.id, niceDomain);

                        if (domainFolder) {
                            // "Gaming > Minecraft" exists! Perfect match.
                            targetId = domainFolder.id;
                            targetPath = `${rootPath} > ${contextFolder.title} > ${domainFolder.title}`;
                            action = 'MOVE';
                        } else {
                            // Local Context exists, but Domain does not.
                            // Proposed: Create "Minecraft" inside "Gaming".
                            targetId = contextFolder.id;
                            targetPath = `${rootPath} > ${contextFolder.title}`;
                            action = 'MOVE';
                            newSubfolder = niceDomain;
                        }
                    } else {
                        // Case B: Context Folder Does NOT Exist LOCALLY in Source.
                        // GLOBAL SEARCH FALLBACK
                        // Does the Domain folder exist ANYWHERE else globally? (e.g. "Leakshaven" in "Other > Porn")
                        // Does the Context folder exist ANYWHERE else globally?

                        // 1. Precise Domain Match Globally
                        let globalDomainMatch = folderMap.find(f => f.title.toLowerCase() === niceDomain.toLowerCase());

                        // 2. Context Match Globally
                        let globalContextMatch = null;
                        if (!globalDomainMatch) {
                            // Try to find "Adult" or "Porn" globally
                            globalContextMatch = folderMap.find(f => f.title.toLowerCase() === context.toLowerCase());
                            if (!globalContextMatch && TabGrouper.CONTEXT_SYNONYMS && TabGrouper.CONTEXT_SYNONYMS[context]) {
                                for (const syn of TabGrouper.CONTEXT_SYNONYMS[context]) {
                                    globalContextMatch = folderMap.find(f => f.title.toLowerCase() === syn.toLowerCase());
                                    if (globalContextMatch) break;
                                }
                            }
                        }

                        if (globalDomainMatch) {
                            // Found the exact folder somewhere else!
                            targetId = globalDomainMatch.id;
                            targetPath = globalDomainMatch.fullPath;
                            action = 'MOVE';
                        } else if (globalContextMatch) {
                            // Found the Category folder somewhere else.
                            // Propose creating Domain subfolder THERE.
                            targetId = globalContextMatch.id;
                            targetPath = globalContextMatch.fullPath;
                            action = 'MOVE';
                            newSubfolder = niceDomain;
                        } else {
                            // Truly confusing. Fallback to creating in Source.
                            targetId = sourceId;
                            targetPath = rootPath;
                            action = 'CREATE';
                            newSubfolder = context;
                        }
                    }

                    // CRITICAL FIX: Double Check if the proposed "newSubfolder" already exists in "targetId".
                    // (Same validity check as before, still vital)
                    if (newSubfolder) {
                        const targetChildren = await chrome.bookmarks.getChildren(targetId);
                        const existingSub = targetChildren.find(c => !c.url && c.title.toLowerCase() === newSubfolder.toLowerCase());
                        if (existingSub) {
                            targetId = existingSub.id;
                            targetPath = targetPath + ` > ${existingSub.title}`;
                            newSubfolder = '';

                            if (niceDomain && niceDomain.toLowerCase() !== context.toLowerCase()) {
                                const deepChildren = await chrome.bookmarks.getChildren(existingSub.id);
                                const deepMatch = deepChildren.find(c => !c.url && c.title.toLowerCase() === niceDomain.toLowerCase());
                                if (deepMatch) {
                                    targetId = deepMatch.id;
                                    targetPath = targetPath + ` > ${deepMatch.title}`;
                                } else {
                                    newSubfolder = niceDomain;
                                }
                            }
                        }
                    }

                    // Add to proposals
                    // Note: We might generate multiple groups for same Context if we split by domain.
                    // If Context Folder didn't exist, we might get 5 groups all proposing to create "Gaming".
                    // The UI/Apply logic needs to handle this (deduplicate creation).
                    // Or we merge them here.

                    proposals.groups.push({
                        groupName: `${context} - ${niceDomain}`,
                        action,
                        targetId,
                        targetPath,
                        newSubfolder,
                        items: domainItems.map(i => ({ ...i, currentParent: i.parentId }))
                    });
                }
            }
        }

        // Post-Processing: Deduplicate "Create Context" proposals?
        // If we have "Gaming - Minecraft" -> Create "Gaming"
        // And "Gaming - Roblox" -> Create "Gaming"
        // We should merge them into one proposal "Gaming" -> Create "Gaming", containing both sets of items.
        // UNLESS the user wants to split them?
        // Let's defer that to a "Merge" pass if needed, but for now individual cards are safer for user verification.
        // The Apply logic handles "If folder exists, use it", so parallel creates are safe-ish (race condition possible but unlikely in seq).

        return { groups: proposals.groups };
    },

    /**
     * Helper: Get ALL items from a list of Folder IDs (Recursive).
     * Used for "Restructure" mode where we want to grab everything and reshuffle.
     */
    getAllItemsInScope: async (folderIds) => {
        let looseItems = [];

        // Helper to recursively extract items
        const extractItems = (node) => {
            if (node.url) {
                looseItems.push({
                    id: node.id,
                    title: node.title,
                    url: node.url,
                    parentId: node.parentId
                });
            } else if (node.children) {
                node.children.forEach(extractItems);
            }
        };

        for (const rawId of folderIds) {
            // Check for explicit "Loose Only" mode
            if (rawId.startsWith('loose-')) {
                const realId = rawId.replace('loose-', '');
                try {
                    const children = await chrome.bookmarks.getChildren(realId);
                    // Shallow fetch: only direct children that are items
                    children.forEach(child => {
                        if (child.url) {
                            looseItems.push({
                                id: child.id,
                                title: child.title,
                                url: child.url,
                                parentId: child.parentId
                            });
                        }
                    });
                } catch (err) {
                    console.error(`Failed to fetch children for loose ID ${realId}`, err);
                }
            } else {
                // Recursive Fetch (Folder Mode)
                try {
                    const subTree = await chrome.bookmarks.getSubTree(rawId);
                    if (subTree && subTree.length > 0) {
                        extractItems(subTree[0]);
                    }
                } catch (err) {
                    console.error(`Failed to fetch subtree for ID ${rawId}`, err);
                }
            }
        }

        // Deduplicate (in case user selected Parent AND Child, causing double fetch)
        const unique = new Map();
        looseItems.forEach(item => unique.set(item.id, item));
        looseItems = Array.from(unique.values());

        // For context, we don't strictly need 'folders' array for the AI prompt
        // (the Prompt only asks for ITEMS list).
        // But if we wanted to pass existing folders, we could.
        // For Restructure, we check "Ignore existing folders", so empty array is fine.
        return { looseItems, folders: [] };
    },

    /**
     * AI-Powered Organization.
     * Uses Gemini to map items to the full folder tree.
     */
    /**
     * AI-Powered Organization.
     * Uses Gemini to map items to the full folder tree.
     */
    analyzeWithAI: async (folderIds, contextIds, apiKey, hints) => {
        // 1. Get scope
        const { looseItems } = await BookmarkOrganizer.getAllItemsInScope(folderIds);
        if (looseItems.length === 0) return { groups: [] };

        // 2. Get Context
        // Respect Scope: Only show folders relevant to the user's selection
        // FIXED: Use contextIds (Settings Scope) instead of folderIds (Source Scope)
        // If contextIds is empty/null, it means "Global" (if logic handles null properly), 
        // or we should default to '2' (Other Bookmarks) + '1' (Bar) if we want restricted default.
        // getFolderMap(null) returns everything.
        const allStructure = await BookmarkOrganizer.getFolderMap(contextIds);
        const contextFolders = allStructure.map(f => ({ id: f.id, path: f.fullPath }));

        // 3. Call AI
        // Expected output: { "bookmarkId": "folderId" or "NEW:Category" }
        let mapping;
        try {
            mapping = await AIService.organizeWithAI(looseItems, contextFolders, apiKey, hints);
        } catch (e) {
            console.error("AI Analysis Failed", e);
            throw e;
        }

        // 4. Convert AI Map to Proposals
        const groups = {}; // Key: TargetID (or NewName), Value: ProposalObject

        looseItems.forEach(item => {
            const decision = mapping && mapping[item.id]; // Safety check
            if (!decision || decision === 'SKIP') return;

            if (decision.startsWith('NEW:')) {
                // Proposed New Category
                const newCat = decision.replace('NEW:', '').trim();
                const groupKey = `NEW_${newCat}`;

                if (!groups[groupKey]) {
                    groups[groupKey] = {
                        groupName: newCat,
                        action: 'CREATE',
                        targetId: '2', // Default to Other Bookmarks (safe root)
                        targetPath: 'Other bookmarks',
                        newSubfolder: newCat,
                        items: []
                    };
                }
                groups[groupKey].items.push(item);

            } else {
                // Existing Folder ID
                const folderId = decision;
                const folderInfo = allStructure.find(f => f.id === folderId);

                if (folderInfo) {
                    if (!groups[folderId]) {
                        groups[folderId] = {
                            groupName: folderInfo.title, // Use Folder Name as Group Name
                            action: 'MOVE',
                            targetId: folderId,
                            targetPath: folderInfo.fullPath,
                            newSubfolder: '',
                            items: []
                        };
                    }
                    groups[folderId].items.push(item);
                }
            }
        });

        return { groups: Object.values(groups) };
    },

    /**
     * Apply organization.
     */
    applyOrganization: async (approvedGroups) => {
        for (const group of approvedGroups) {
            let folderId = group.targetId;

            // Creates subfolder if requested
            if (group.newSubfolder && group.newSubfolder.trim() !== '') {
                // Check if it actually exists inside user specified parent
                // (Optimization: could minimize API calls, but creates ensure safety)
                const children = await chrome.bookmarks.getChildren(folderId);
                const existing = children.find(c => c.title.toLowerCase() === group.newSubfolder.toLowerCase() && !c.url);

                if (existing) {
                    folderId = existing.id;
                } else {
                    const created = await chrome.bookmarks.create({
                        parentId: folderId,
                        title: group.newSubfolder
                    });
                    folderId = created.id;
                }
            }

            // Move items
            for (const item of group.items) {
                try {
                    await chrome.bookmarks.move(item.id, { parentId: folderId });
                } catch (e) { console.warn("Failed to move bookmark", item.id, e); }
            }
        }
    }
};
