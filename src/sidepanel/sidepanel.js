import { TabGrouper } from '../utils/tabGrouper.js';
import { StorageManager } from '../utils/storageManager.js';
import { BookmarkOrganizer } from '../utils/bookmarkOrganizer.js';
import { AIService } from '../utils/aiService.js';

// --- State ---
let currentTabs = [];
let savedWorkflows = [];

// --- Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
    await loadWorkflows();
    await loadCurrentTabs();

    console.log("🛠️ StorageManager Loaded:", StorageManager);
    console.log("Existing Workflows:", savedWorkflows);

    setupEventListeners();
});

function setupEventListeners() {
    document.getElementById('saveWorkflowBtn').addEventListener('click', saveSessionAndClose);

    async function saveSessionAndClose() {
        // 1. Get all tabs
        const tabs = await chrome.tabs.query({ currentWindow: true });
        if (tabs.length === 0) return;

        // 2. Prompt for name
        const name = prompt("Name this session (e.g. 'Research', 'Private'):");
        if (!name) return;

        // 3. Save Workflow
        await StorageManager.saveWorkflow(name, tabs);

        // 4. Create a clean new tab so window doesn't close
        await chrome.tabs.create({});

        // 5. Close old tabs
        const tabIds = tabs.map(t => t.id);
        await chrome.tabs.remove(tabIds);

        // 6. Refresh UI
        loadWorkflows();

        // Optional: Notify
        // alert("Session saved and closed!");
    }

    // Dynamic listeners for workflow items
    document.getElementById('workflows-list').addEventListener('click', handleWorkflowClick);
}

// --- Tabs Logic ---
async function loadCurrentTabs() {
    currentTabs = await chrome.tabs.query({ currentWindow: true });
    // Initial render: Just list them or group by domain? Let's group by default or show list.
    // For now: Show grouped by Context (Smart)
    renderGroupedTabs();
}

function renderGroupedTabs() {
    // Treat current tabs like a "Proposal" so we can reuse the advanced UI
    // 1. Group Smart
    const grouped = TabGrouper.groupSmart(currentTabs);

    // 2. Convert to Proposal format matching bookmarkOrganizer.js structure
    // We mock the "folderMap" lookup slightly here or just fetch it
    StorageManager.getSettings().then(settings => {
        const allowedIds = settings.focusedFolderIds || [];

        BookmarkOrganizer.getFolderMap(allowedIds).then(folderMap => {
            const proposal = { groups: [] };
            // Default target: Find matching allowed ID, or fallback to first available, or 'Other Bookmarks' if valid.
            // If Scoped map is empty (rare), might default to '2' but '2' might not be in scope. 
            // Better fallback: The first folder in the map.
            const defaultTarget = folderMap.find(f => f.id === '2') || folderMap[0] || { id: '2', fullPath: 'Other Bookmarks' };

            for (const [groupName, tabs] of Object.entries(grouped)) {
                // Find best matching folder for this group name
                let bestMatch = folderMap.find(f => f.title.toLowerCase() === groupName.toLowerCase());

                proposal.groups.push({
                    groupName: groupName,
                    action: bestMatch ? 'MOVE' : 'CREATE',
                    targetId: bestMatch ? bestMatch.id : defaultTarget.id,
                    targetPath: bestMatch ? bestMatch.fullPath : defaultTarget.fullPath,
                    newSubfolder: bestMatch ? '' : groupName,
                    items: tabs.map(t => ({
                        id: t.id,
                        title: t.title,
                        url: t.url,
                        isTab: true // Flag to know if we need to bookmark vs move
                    }))
                });
            }

            // Use the reused render function
            renderOrganizerProposal(proposal, true); // true = isTabMode
        });
    });
}

// --- Workflows Logic ---
async function loadWorkflows() {
    savedWorkflows = await StorageManager.getWorkflows();
    renderWorkflows();
}

function renderWorkflows() {
    const list = document.getElementById('workflows-list');
    list.innerHTML = '';

    if (savedWorkflows.length === 0) {
        list.innerHTML = '<li class="empty-state">No saved workflows.</li>';
        return;
    }

    savedWorkflows.forEach(wf => {
        const li = document.createElement('li');
        li.className = 'workflow-item';
        li.dataset.id = wf.id;
        li.innerHTML = `
      <span>${wf.name} (${wf.tabs.length})</span>
      <div style="display:flex; gap:4px;">
        <button class="sm-btn export-wf-btn" title="Export this workflow">⬇</button>
        <button class="sm-btn delete-wf-btn">✕</button>
      </div>
    `;
        list.appendChild(li);
    });
}

// --- Import/Export Workflow Handlers ---
document.getElementById('exportAllWorkflowsBtn').addEventListener('click', async () => {
    try {
        await StorageManager.exportWorkflows();
    } catch (e) {
        console.error("Export failed:", e);
        alert("Export failed: " + e.message);
    }
});

document.getElementById('importWorkflowsBtn').addEventListener('click', () => {
    document.getElementById('importFileInput').click();
});

document.getElementById('importFileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    try {
        const text = await file.text();
        const result = await StorageManager.importWorkflows(text);
        if (result.success) {
            await loadWorkflows();
            alert(`Imported ${result.count} workflow(s) successfully!`);
        } else {
            alert("Import failed: " + result.error);
        }
    } catch (err) {
        console.error("Import error:", err);
        alert("Import failed: " + err.message);
    }
    e.target.value = ''; // Reset file input
});


// Handle clicking a workflow (restore or delete)
async function handleWorkflowClick(e) {
    const li = e.target.closest('.workflow-item');
    if (!li) return;

    const id = li.dataset.id;
    const wf = savedWorkflows.find(w => w.id === id);
    if (!wf) return;

    // Export single workflow
    if (e.target.classList.contains('export-wf-btn')) {
        e.stopPropagation();
        try {
            const blob = new Blob([JSON.stringify([wf], null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const safeName = wf.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
            await chrome.downloads.download({
                url: url,
                filename: `workflow_${safeName}.json`
            });
        } catch (err) {
            console.error("Export single failed:", err);
            alert("Export failed: " + err.message);
        }
        return;
    }

    // Delete
    if (e.target.classList.contains('delete-wf-btn')) {
        e.stopPropagation(); // Prevent restore
        if (confirm(`Delete workflow "${wf.name}"?`)) {
            await StorageManager.deleteWorkflow(id);
            loadWorkflows();
        }
        return;
    }

    // Restore
    await StorageManager.restoreWorkflow(wf);
}

// --- Saving Actions ---

async function saveGroupAsWorkflow(name, tabs) {
    const newName = prompt("Enter name for this workflow:", name);
    if (!newName) return;

    await StorageManager.saveWorkflow(newName, tabs);
    loadWorkflows();
    alert("Workflow saved!");
}

async function saveGroupToBookmarks(name, tabs) {
    // Create folder in "Other Bookmarks"
    const folder = await chrome.bookmarks.create({ title: name }); // Defaults to Other Bookmarks if parentId omitted

    for (const tab of tabs) {
        await chrome.bookmarks.create({
            parentId: folder.id,
            title: tab.title,
            url: tab.url
        });
    }
    alert(`Saved to Bookmarks folder: "${name}"`);
}

// --- Bookmark Organizer Logic ---
let currentProposal = null;
let currentNavStack = []; // Stack of {id, title} for breadcrumbs

// Helper: Render Grid based on current Folder ID
async function renderSourceGrid(folderId) {
    const content = await BookmarkOrganizer.getDirectoryContents(folderId);
    if (!content) return;

    const sourceList = document.getElementById('source-list');
    sourceList.innerHTML = '';
    sourceList.className = 'source-grid';

    // 1. Navigation Header (Breadcrumbs / Back)
    if (currentNavStack.length > 0) {
        const navHeader = document.createElement('div');
        navHeader.style.gridColumn = '1 / -1';
        navHeader.style.display = 'flex';
        navHeader.style.alignItems = 'center';
        navHeader.style.gap = '10px';
        navHeader.style.marginBottom = '5px';
        navHeader.innerHTML = `
            <button id="navBackBtn" class="sm-btn" style="border:none; background:transparent; font-size:0.95rem; padding:6px 0; display:flex; align-items:center; gap:6px; color:#9ca3af; transition:color 0.2s;">
                <span style="font-size:1.1rem;">⬅</span> Back
            </button>
            <span style="font-weight:600; color:#ddd; font-size:1rem;">${content.title}</span>
        `;
        sourceList.appendChild(navHeader);

        const backBtn = navHeader.querySelector('#navBackBtn');
        backBtn.addEventListener('mouseenter', () => backBtn.style.color = '#fff');
        backBtn.addEventListener('mouseleave', () => backBtn.style.color = '#9ca3af');
        backBtn.addEventListener('click', () => {
            currentNavStack.pop(); // Remove current
            const prev = currentNavStack[currentNavStack.length - 1]; // Peek new top
            renderSourceGrid(prev ? prev.id : folderId); // If empty stack? Should not happen if we manage correctly.
            // Actually, if we pop, we should render the *new* top. 
            // If stack was [Root, Child], popping Child leaves [Root].
            // Logic: Stack represents *history*. The last item is "Current".
            // Let's say Stack: [Root]. Current is Root.
            // Enter Child -> Stack: [Root, Child]. Current is Child.
            // Back -> Pop Child. Current is Root.
        });
    }

    // 2. Loose Files Option (Use split-card structure to match folders)
    if (content.looseCount > 0) {
        const card = document.createElement('div');
        card.className = 'source-split-card';
        card.dataset.value = `loose-${content.id}`;

        // Selection Area (Left) - Same as subfolder structure
        const selectArea = document.createElement('div');
        selectArea.className = 'source-select-area';
        selectArea.innerHTML = `
            <div style="font-size:1.1rem; margin-bottom:4px;">📄</div>
            <div style="font-size:0.85rem; font-weight:500; line-height:1.2;">Loose Files</div>
            <div style="font-size:0.75rem; color:#888; margin-top:2px;">${content.looseCount} items</div>
        `;

        // Placeholder for right side (no drill, but keeps width consistent)
        const placeholder = document.createElement('div');
        placeholder.className = 'source-drill-btn';
        placeholder.style.visibility = 'hidden'; // Hide but reserve space

        card.appendChild(selectArea);
        card.appendChild(placeholder);

        card.addEventListener('click', () => card.classList.toggle('selected'));
        sourceList.appendChild(card);
    }

    // 3. Subfolders
    content.subfolders.forEach(sub => {
        const card = document.createElement('div');
        card.className = 'source-split-card';
        // Note: Dataset value for logic
        // card.dataset.value is set when selected

        // Selection Area (Left)
        const selectArea = document.createElement('div');
        selectArea.className = 'source-select-area';

        // Stats Label
        let statsParts = [];
        if (sub.folderCount > 0) statsParts.push(`${sub.folderCount} 📁`);
        if (sub.fileCount > 0) statsParts.push(`${sub.fileCount} 📄`);
        const statsLabel = statsParts.join(' , ') || 'Empty';

        selectArea.innerHTML = `
            <div style="font-size:1.1rem; margin-bottom:4px;">📁</div>
            <div style="font-size:0.85rem; font-weight:500; line-height:1.2;">${sub.title}</div>
            <div style="font-size:0.75rem; color:#888; margin-top:2px;">${statsLabel}</div>
        `;

        // Drill Button (Right)
        const drillBtn = document.createElement('div');
        drillBtn.className = 'source-drill-btn';
        drillBtn.innerHTML = '›'; // A cleaner arrow character
        drillBtn.title = `Open ${sub.title}`;

        // Logic
        selectArea.addEventListener('click', () => {
            card.classList.toggle('selected');
            if (card.classList.contains('selected')) {
                card.dataset.value = sub.id; // Passing ID means "All recursive content"
            } else {
                delete card.dataset.value;
            }
        });

        drillBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            currentNavStack.push({ id: sub.id, title: sub.title });
            renderSourceGrid(sub.id);
        });

        card.appendChild(selectArea);
        card.appendChild(drillBtn);
        sourceList.appendChild(card);
    });
}


document.getElementById('viewWorkflowsBtn').addEventListener('click', async () => {
    // Switch Views
    document.getElementById('organizer-source-container').style.display = 'none';
    document.getElementById('organizer-container').style.display = 'none';
    document.getElementById('settings-container').style.display = 'none';
    document.getElementById('groups-container').style.display = 'none';
    document.getElementById('workflows-container').style.display = 'block';

    await loadWorkflows(); // Ensure workflows are refreshed
});

document.getElementById('groupTabsBtn').addEventListener('click', async () => {
    // Switch Views
    document.getElementById('organizer-source-container').style.display = 'none';
    document.getElementById('organizer-container').style.display = 'none';
    document.getElementById('settings-container').style.display = 'none';
    document.getElementById('workflows-container').style.display = 'none';
    document.getElementById('groups-container').style.display = 'block';

    await loadCurrentTabs();
});

// AI Grouping for TABS
document.getElementById('aiGroupTabsBtn').addEventListener('click', async () => {
    const btn = document.getElementById('aiGroupTabsBtn');
    const originalText = btn.textContent;
    btn.textContent = 'Grouping... 🧠';
    btn.disabled = true;

    try {
        const settings = await StorageManager.getSettings();
        if (!settings.useAI || !settings.geminiApiKey) {
            alert("AI features disabled. Check Settings.");
            return;
        }

        // 1. Get Tabs (Source)
        const tabs = await chrome.tabs.query({ currentWindow: true });
        const looseItems = tabs.map(t => ({
            id: t.id.toString(), // Ensure string ID
            title: t.title,
            url: t.url,
            isTab: true
        }));

        // 2. Get Context (Folders)
        // We want AI to file tabs into EXISTING folders if possible, or create NEW ones.
        const allowedIds = settings.focusedFolderIds || [];
        const allStructure = await BookmarkOrganizer.getFolderMap(allowedIds);
        const contextFolders = allStructure.map(f => ({ id: f.id, path: f.fullPath }));

        // 3. User Hints
        const hints = document.getElementById('aiTabsHintsInput').value.trim();

        // 4. Call AIService (Reusing the core AI logic)
        // We use the same 'organizeWithAI' because the signature is generic (links, folders, key, hints)
        const mapping = await AIService.organizeWithAI(looseItems, contextFolders, settings.geminiApiKey, hints);

        // 5. Convert Mapping to UI Proposal
        // (Similar logic to Analyze, but for Tabs)
        const groups = {};

        looseItems.forEach(item => {
            const decision = mapping[item.id];
            if (!decision || decision === 'SKIP') return;

            if (decision.startsWith('NEW:')) {
                const newCat = decision.replace('NEW:', '').trim();
                const groupKey = `NEW_${newCat}`;
                if (!groups[groupKey]) {
                    groups[groupKey] = {
                        groupName: newCat, action: 'CREATE', targetId: '2', targetPath: 'Other bookmarks',
                        newSubfolder: newCat, items: []
                    };
                }
                groups[groupKey].items.push(item);
            } else {
                const folderId = decision;
                const folderInfo = allStructure.find(f => f.id === folderId);
                if (folderInfo) {
                    if (!groups[folderId]) {
                        groups[folderId] = {
                            groupName: folderInfo.title, action: 'MOVE', targetId: folderId,
                            targetPath: folderInfo.fullPath, newSubfolder: '', items: []
                        };
                    }
                    groups[folderId].items.push(item);
                }
            }
        });

        // 6. Render
        const proposal = { groups: Object.values(groups) };
        renderOrganizerProposal(proposal, true); // true = isTabMode

    } catch (e) {
        console.error("AI Tab Grouping Failed", e);
        alert("AI Failed: " + e.message);
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
    }
});

document.getElementById('organizeBookmarksBtn').addEventListener('click', async () => {
    try {
        const settings = await StorageManager.getSettings();
        const focusedIds = settings.focusedFolderIds || [];

        // Default Start: First item in Scope, or 'Other Bookmarks' (2)
        const startId = (focusedIds.length > 0) ? focusedIds[0] : '2';

        // Check if startId is valid (exists) or fallback
        // We initialize stack
        const content = await BookmarkOrganizer.getDirectoryContents(startId);
        const startTitle = content ? content.title : 'Bookmarks';

        currentNavStack = [{ id: startId, title: startTitle }];
        await renderSourceGrid(startId);

        document.getElementById('groups-container').style.display = 'none';
        document.getElementById('organizer-source-container').style.display = 'block';
        document.getElementById('organizer-container').style.display = 'none';
    } catch (err) {
        console.error("Organize Bookmarks Error:", err);
        alert("Error opening organizer: " + err.message);
    }
});

document.getElementById('cancelSourceBtn').addEventListener('click', () => {
    document.getElementById('organizer-source-container').style.display = 'none';
    document.getElementById('groups-container').style.display = 'block';
    document.getElementById('source-list').className = ''; // Reset class just in case
});

// Step 2: Analyze & Propose
document.getElementById('analyzeBtn').addEventListener('click', async () => {
    // FIX: Include split cards in selection!
    const selected = document.querySelectorAll('.source-btn.selected, .source-split-card.selected');
    // Pass raw values (e.g. 'loose-5' or '5'). The backend 'getAllItemsInScope' handles the distinction.
    const folderIds = Array.from(selected).map(btn => btn.dataset.value).filter(Boolean);

    if (folderIds.length === 0) {
        alert('Please select at least one folder to organize.');
        return;
    }

    const btn = document.getElementById('analyzeBtn');
    const originalText = btn.textContent;
    btn.textContent = 'Analyzing... 🧠';
    btn.disabled = true;

    try {
        // Validation check for StorageManager
        if (typeof StorageManager.getSettings !== 'function') {
            alert("StorageManager.getSettings missing. Reload extension.");
            return;
        }

        const settings = await StorageManager.getSettings();

        // Get user hints
        const hintsInput = document.getElementById('aiHintsInput');
        const userHints = hintsInput ? hintsInput.value.trim() : '';

        // Call the actual AI or fallback to naive
        let proposal;
        if (settings.useAI && settings.geminiApiKey) {
            // FIXED: Context Scope logic
            // When explicitly analyzing selected folders (Source View), user intent is usually to organize WITHIN that scope.
            // If we use 'focusedFolderIds', it might be too broad (e.g. Root) or too narrow (unrelated).
            // We should prioritize the EXPLICITLY SELECTED source folders as the context.
            // (If user wants to move items OUT of source to Global, they might need a different mode, but "Analyze" usually implies "Cleanup this folder").

            const cleanSourceIds = folderIds.map(id => id.replace('loose-', ''));
            // If we have selected sources, USE THEM. Only fallback to Settings if no source selected (rare/impossible here).
            const contextIds = (cleanSourceIds.length > 0) ? cleanSourceIds : (settings.focusedFolderIds || []);

            console.log("🔍 DEBUG CONTEXT (Fixed):", {
                folderIds,
                cleanSourceIds,
                focusedSettings: settings.focusedFolderIds,
                FINAL_CONTEXT: contextIds
            });

            proposal = await BookmarkOrganizer.analyzeWithAI(folderIds, contextIds, settings.geminiApiKey, userHints);
        } else {
            proposal = await BookmarkOrganizer.proposeSmartOrganization(folderIds);
        }
        renderOrganizerProposal(proposal);

    } catch (error) {
        console.error(error);
        alert('Analysis failed: ' + error.message);
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
    }
});

document.getElementById('restructureBtn').addEventListener('click', async () => {
    // Logic similar to analyzeBtn but calls restructureWithAI
    const selected = document.querySelectorAll('.source-btn.selected, .source-split-card.selected');
    const folderIds = Array.from(selected).map(btn => btn.dataset.value).filter(Boolean);

    if (folderIds.length === 0) {
        alert('Please select at least one folder to RESTRUCTURE.');
        return;
    }

    const btn = document.getElementById('restructureBtn');
    const originalText = btn.textContent;
    btn.textContent = 'Re-Architecting... 🏗️';
    btn.disabled = true;
    document.getElementById('analyzeBtn').disabled = true;

    try {
        const settings = await StorageManager.getSettings();
        if (!settings.useAI || !settings.geminiApiKey) {
            alert("AI features are required for Restructure. Please enable AI and set an API key in Settings.");
            return;
        }

        // 1. Get ALL items from selected folders
        const { looseItems } = await BookmarkOrganizer.getAllItemsInScope(folderIds);

        // Get user hints
        const hintsInput = document.getElementById('aiHintsInput');
        const userHints = hintsInput ? hintsInput.value.trim() : '';

        // 2. Call AI Restructure
        const aiMapping = await AIService.restructureWithAI(looseItems, settings.geminiApiKey, userHints);

        // 3. Build Proposal from AI Mapping
        // aiMapping: { "bookmarkId": "Category > Subcategory" }
        const groups = {};
        looseItems.forEach(item => {
            const newPath = aiMapping[item.id];
            if (!newPath) return;

            if (!groups[newPath]) {
                groups[newPath] = {
                    groupName: newPath,
                    action: 'CREATE',
                    targetId: '2', // Default to Other Bookmarks
                    targetPath: `Other bookmarks/${newPath.replace(/ > /g, '/')}`,
                    newSubfolder: newPath.replace(/ > /g, '/'),
                    items: []
                };
            }
            groups[newPath].items.push(item);
        });

        const proposal = { groups: Object.values(groups) };
        renderOrganizerProposal(proposal);

    } catch (error) {
        console.error(error);
        alert('Restructure failed: ' + error.message);
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
        document.getElementById('analyzeBtn').disabled = false;
    }
});

// Back from proposals
document.getElementById('cancelOrganizerBtn').addEventListener('click', () => {
    document.getElementById('organizer-container').style.display = 'none';
    document.getElementById('organizer-source-container').style.display = 'block';
});

// Step 3: Apply
document.getElementById('applyOrganizerBtn').addEventListener('click', async () => {
    const proposal = window.currentRenderedProposal; // Configured by render function
    if (!proposal) return;

    // Filter out unchecked groups by index
    const checkboxes = document.querySelectorAll('.proposal-checkbox');
    const checkedIndices = Array.from(checkboxes)
        .filter(cb => cb.checked)
        .map(cb => parseInt(cb.dataset.index));

    const approvedGroups = proposal.groups.filter((_, idx) => checkedIndices.includes(idx));

    if (approvedGroups.length === 0) {
        alert("No groups selected.");
        return;
    }

    if (window.isTabMode) {
        // Saving Tabs to Bookmarks
        for (const group of approvedGroups) {
            let folderId = group.targetId;

            // Handle Subfolder creation
            if (group.newSubfolder && group.newSubfolder.trim() !== '') {
                try {
                    const created = await chrome.bookmarks.create({
                        parentId: folderId,
                        title: group.newSubfolder
                    });
                    folderId = created.id;
                } catch (e) { console.error("Error creating subfolder", e); }
            }

            // Create Bookmarks from Tabs
            for (const item of group.items) {
                await chrome.bookmarks.create({
                    parentId: folderId,
                    title: item.title,
                    url: item.url
                });
            }
        }
        alert(`Saved ${approvedGroups.length} groups to bookmarks!`);
    } else {
        // Organizing existing bookmarks
        await BookmarkOrganizer.applyOrganization(approvedGroups);
        alert(`Organized ${approvedGroups.length} groups!`);
    }

    // Reset UI
    document.getElementById('organizer-container').style.display = 'none';
    document.getElementById('groups-container').style.display = 'block';
});

async function renderOrganizerProposal(proposal, isTabMode = false) {
    const list = document.getElementById('proposals-list');

    // Switch Views
    document.getElementById('groups-container').style.display = 'none';
    document.getElementById('organizer-container').style.display = 'block';

    list.innerHTML = '';

    if (proposal.groups.length === 0) {
        list.innerHTML = '<p>No suggestions found.</p>';
        document.getElementById('applyOrganizerBtn').style.display = 'none';
        return;
    }
    document.getElementById('applyOrganizerBtn').style.display = 'block';

    const settings = await StorageManager.getSettings();
    const allowedIds = settings.focusedFolderIds || [];
    const folderMap = await BookmarkOrganizer.getFolderMap(allowedIds);

    // -- Generate Datalist (Once) --
    // We assume this list is relatively static for the session
    const datalistId = 'folder-paths-list';
    let datalist = document.getElementById(datalistId);
    if (!datalist) {
        datalist = document.createElement('datalist');
        datalist.id = datalistId;
        document.body.appendChild(datalist);
    }
    datalist.innerHTML = folderMap.map(f => `<option value="${f.fullPath}"></option>`).join('');

    // Default Fallback (usually 'Other Bookmarks' or first available)
    const fallbackRoot = folderMap.find(f => f.id === '2') || folderMap[0];

    proposal.groups.forEach((group, index) => {
        const div = document.createElement('div');
        div.className = 'group-card';
        div.style.borderLeft = group.action === 'MOVE' ? '4px solid #10b981' : '4px solid #3b82f6';
        div.dataset.index = index;

        // Determine Initial State
        // If targetId is known folder, use its path.
        // If it was a CREATE proposal, use the newSubfolder name (or groupName if simple)
        let initialValue = '';
        let initialIcon = '📂'; // Default to folder
        let isNew = false;

        const originalFolder = folderMap.find(f => f.id === group.targetId);

        if (group.action === 'CREATE' || (group.newSubfolder && group.newSubfolder !== '')) {
            // It's a creation proposal
            // We display just the Name they want to create (simplified) OR standard path?
            // User request: "Auto complete... indication icon of new folder".
            // If it's "New: Minecraft", prompt likely returned "Minecraft".
            // We should preset it to "Minecraft".
            initialValue = group.newSubfolder || group.groupName;
            initialIcon = '🆕';
            isNew = true;
            div.style.borderLeft = '4px solid #f59e0b'; // Amber for Create
        } else if (originalFolder) {
            initialValue = originalFolder.fullPath;
            initialIcon = '📂';
            isNew = false;
        } else {
            // Fallback
            initialValue = group.groupName;
            initialIcon = '❓';
        }


        // Generate Items HTML
        const itemsHtml = group.items.map((i, itemIndex) => {
            const domain = new URL(i.url).hostname;
            const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
            return `
                <div class="draggable-item" draggable="true" data-group-index="${index}" data-item-index="${itemIndex}" style="display:flex; align-items:center; gap:8px; padding:6px; background:rgba(255,255,255,0.03); margin-bottom:2px; border-radius:4px; cursor:grab;">
                    <img src="${faviconUrl}" width="16" height="16" style="flex-shrink:0; border-radius:3px;"/>
                    <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:0.85rem; color:var(--text-color); opacity:0.9;">${i.title}</div>
                </div>
            `;
        }).join('');

        div.innerHTML = `
      <div class="group-header" style="display:flex; flex-direction:column; gap:8px; margin-bottom: 8px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
             <!-- Label -->
            <label style="display:flex; align-items:center; cursor:pointer; font-weight:bold; font-size:1rem; flex:1;">
                <input type="checkbox" checked class="proposal-checkbox" data-index="${index}" style="margin-right:10px; transform:scale(1.1); accent-color: var(--primary-color);">
                ${group.groupName} 
            </label>
            
            <button class="sm-btn apply-single-btn" data-index="${index}" style="margin-left:8px; background:transparent; border:1px solid #10b981; color:#10b981;">✓ Apply This</button>
        </div>
        
        <!-- Smart Input UI -->
        <div style="position:relative;">
             <div style="font-size:0.7rem; color:#888; margin-bottom:4px; font-weight:600;">DESTINATION</div>
             <div style="display:flex; align-items:center; background:#111827; border:1px solid var(--border-color); border-radius:4px; padding:2px 8px;">
                <span class="status-icon" style="font-size:1.2rem; margin-right:8px; cursor:default;" title="${isNew ? 'New Folder' : 'Existing Folder'}">${initialIcon}</span>
                <input type="text" class="smart-dest-input" list="${datalistId}" value="${initialValue}" 
                       placeholder="Type folder path or new name..." 
                       style="flex:1; background:transparent; border:none; color:white; padding:8px 0; font-size:0.9rem; outline:none;">
             </div>
             <!-- Optional: Tiny help text -->
        </div>
      </div>
      
      <div class="group-items drop-zone" data-index="${index}" style="overflow:visible; border-top:1px solid rgba(255,255,255,0.1); padding-top:8px; min-height:40px;">
        ${itemsHtml}
        ${group.items.length === 0 ? '<div style="color:#666; font-style:italic; font-size:0.8rem; text-align:center; padding:10px;">Drag items here</div>' : ''}
      </div>
    `;

        list.appendChild(div);

        // -- Logic: Handle Smart Input --
        const input = div.querySelector('.smart-dest-input');
        const iconSpan = div.querySelector('.status-icon');
        const cardBorder = div;

        input.addEventListener('input', () => {
            const val = input.value.trim();

            // Check exact match in folderMap
            // We use fullPath or maybe just title if unique? fullPath is safer.
            const match = folderMap.find(f => f.fullPath.toLowerCase() === val.toLowerCase());

            if (match) {
                // FOUND: Move Mode
                group.action = 'MOVE';
                group.targetId = match.id;
                group.targetPath = match.fullPath;
                group.newSubfolder = ''; // Clear creation

                // Visuals
                iconSpan.textContent = '📂';
                iconSpan.title = "Existing Folder";
                cardBorder.style.borderLeft = '4px solid #10b981'; // Green
            } else {
                // NOT FOUND: Create Mode
                group.action = 'CREATE';
                group.newSubfolder = val;
                // Target ID should be the Root Scope (fallbackRoot) because we can't infer parent easily from a text string unless we parse ">"
                // Advanced: Parse "Parent > Child" string?
                // For now, simple "Name" -> Create in Root.
                group.targetId = fallbackRoot.id;
                group.targetPath = fallbackRoot.fullPath;

                // Visuals
                iconSpan.textContent = '🆕';
                iconSpan.title = "Will Create New Folder";
                cardBorder.style.borderLeft = '4px solid #f59e0b'; // Amber
            }
        });

        // Single Apply
        div.querySelector('.apply-single-btn').addEventListener('click', async (e) => {
            if (confirm(`Organize just this group?`)) {
                await BookmarkOrganizer.applyOrganization([group]);
                proposal.groups.splice(index, 1);
                // Refresh
                renderOrganizerProposal(proposal, window.isTabMode);
                alert("Group Organized!");
            }
        });
    });

    // -- Global Drag & Drop Handlers --
    setupDragAndDrop(proposal);

    window.currentRenderedProposal = proposal;
    window.isTabMode = isTabMode;
}

function setupDragAndDrop(proposal) {
    const draggables = document.querySelectorAll('.draggable-item');
    const droppables = document.querySelectorAll('.drop-zone');

    let draggedItem = null;
    let sourceGroupIndex = null;
    let sourceItemIndex = null;

    draggables.forEach(elem => {
        elem.addEventListener('dragstart', (e) => {
            draggedItem = elem;
            sourceGroupIndex = parseInt(elem.dataset.groupIndex);
            sourceItemIndex = parseInt(elem.dataset.itemIndex);
            e.dataTransfer.setData('text/plain', 'item'); // Firefox req
            elem.style.opacity = '0.5';
        });

        elem.addEventListener('dragend', () => {
            elem.style.opacity = '1';
            draggedItem = null;
        });
    });

    droppables.forEach(zone => {
        zone.addEventListener('dragover', (e) => {
            e.preventDefault(); // Allow dropping
            zone.style.background = 'rgba(255,255,255,0.05)';
        });

        zone.addEventListener('dragleave', () => {
            zone.style.background = 'transparent';
        });

        zone.addEventListener('drop', (e) => {
            e.preventDefault();
            zone.style.background = 'transparent';

            const targetGroupIndex = parseInt(zone.dataset.index);

            if (sourceGroupIndex === targetGroupIndex) return; // Dropped in same group

            // Move Data
            const item = proposal.groups[sourceGroupIndex].items[sourceItemIndex];

            // Remove from Source
            // Note: splicing invalidates indices. We must rely on our render check.
            proposal.groups[sourceGroupIndex].items.splice(sourceItemIndex, 1);

            // Add to Target
            proposal.groups[targetGroupIndex].items.push(item);

            // Re-Render EVERYTHING (easiest way to fix indices)
            renderOrganizerProposal(proposal, window.isTabMode);
        });
    });
}

// --- Settings Logic ---
// --- Settings Logic ---
document.getElementById('settingsToggleBtn').addEventListener('click', async () => {
    // Show Settings, Hide others
    document.getElementById('actions').style.display = 'none';
    document.getElementById('groups-container').style.display = 'none';
    document.getElementById('workflows-container').style.display = 'none';
    document.getElementById('organizer-container').style.display = 'none';
    document.getElementById('organizer-source-container').style.display = 'none';

    const container = document.getElementById('settings-container');
    container.style.display = 'block';

    // Fetch Data
    const settings = await StorageManager.getSettings();
    const folders = await BookmarkOrganizer.getStructure();

    // -- Render UI --
    container.innerHTML = `
        <h2 style="font-size:1.1rem; margin-bottom:12px; border-bottom:1px solid var(--border-color); padding-bottom:8px;">Extension Settings</h2>
        
        <div id="settings-scroll-area" style="overflow-y:auto; max-height: calc(100vh - 100px); padding-right:4px;">
            
            <!-- 1. Source Folders (Grid Style) -->
            <h3 style="font-size:0.9rem; color:#aaa; margin-bottom:10px; text-transform:uppercase; letter-spacing:0.5px;">Target Folders</h3>
            <div id="settings-folder-grid" class="source-grid" style="margin-bottom:20px;">
                <!-- Folders injected here -->
            </div>

            <!-- 2. Custom Keywords -->
            <h3 style="font-size:0.9rem; color:#aaa; margin-bottom:10px; margin-top:20px; text-transform:uppercase; letter-spacing:0.5px;">Custom Keywords</h3>
            <div id="settings-keywords-list" style="margin-bottom:20px;">
                <!-- Inputs injected here -->
            </div>

            <!-- 3. AI Configuration -->
            <h3 style="font-size:0.9rem; color:#aaa; margin-bottom:10px; margin-top:20px; text-transform:uppercase; letter-spacing:0.5px;">AI Brain (Gemini)</h3>
            <div style="background:var(--card-bg); padding:15px; border-radius:8px; border:1px solid var(--border-color);">
                <label style="display:flex; align-items:center; cursor:pointer; margin-bottom:10px;">
                    <input type="checkbox" id="use-ai-toggle" ${settings.useAI ? 'checked' : ''} style="margin-right:10px; transform:scale(1.2);">
                    <span style="font-weight:bold;">Enable AI Organization</span>
                </label>
                
                <div id="ai-key-wrapper" style="display:${settings.useAI ? 'block' : 'none'}; margin-top:10px; padding-left:5px;">
                    <div style="font-size:0.85rem; margin-bottom:5px; color:#ccc;">Gemini API Key</div>
                    <input type="password" id="gemini-api-key" value="${settings.geminiApiKey || ''}" placeholder="Paste API Key..." style="width:100%; padding:8px; background:#111827; border:1px solid #374151; color:white; border-radius:4px;">
                    <div style="font-size:0.75rem; color:#666; margin-top:6px;">
                        Keys are stored locally. <a href="#" style="color:#3b82f6;">Get Free Key</a>
                    </div>
                </div>
            </div>

            <!-- Save Actions -->
            <div style="margin-top:20px; display:flex; gap:10px; justify-content:flex-end;">
                 <button id="closeSettingsBtnInternal" class="sm-btn" style="padding:8px 16px;">Cancel</button>
                 <button id="saveGlobalSettingsBtn" class="main-btn" style="width:auto; padding:8px 24px;">Save All Settings</button>
            </div>
            <div style="height:40px;"></div>
        </div>
    `;

    // A. Render Folders as Grid Cards
    const grid = document.getElementById('settings-folder-grid');
    if (folders) {
        folders.forEach(folder => {
            const isChecked = settings.focusedFolderIds && settings.focusedFolderIds.includes(folder.id);
            const card = document.createElement('div');
            card.className = `source-btn ${isChecked ? 'selected' : ''}`; // Reuse source-btn class for look
            card.style.justifyContent = 'flex-start'; // Align left
            card.style.padding = '12px';
            card.style.textAlign = 'left';
            card.dataset.id = folder.id;

            card.innerHTML = `
                <div class="icon" style="margin-bottom:0; margin-right:10px;">📁</div>
                <div>${folder.title}</div>
                <div class="checkbox-indicator" style="margin-left:auto; font-size:1.2rem; color:${isChecked ? '#10b981' : 'transparent'};">✓</div>
            `;

            card.addEventListener('click', () => {
                card.classList.toggle('selected');
                const indicator = card.querySelector('.checkbox-indicator');
                indicator.style.color = card.classList.contains('selected') ? '#10b981' : 'transparent';
            });
            grid.appendChild(card);
        });
    }

    // B. Render Keywords
    const kwList = document.getElementById('settings-keywords-list');
    const categories = ["Gaming", "Adult", "AI & Tech", "Coding", "Video", "Social", "News", "Shopping"];

    categories.forEach(cat => {
        const currentCustom = (settings.customKeywords && settings.customKeywords[cat]) ? settings.customKeywords[cat].join(', ') : '';
        const row = document.createElement('div');
        row.style.marginBottom = '12px';
        row.innerHTML = `
            <div style="font-size:0.85rem; font-weight:600; margin-bottom:4px; color:#ddd;">${cat}</div>
            <input type="text" class="keyword-input" data-cat="${cat}" value="${currentCustom}" placeholder="e.g. word1, word2" style="width:100%; padding:8px; background:#1f2937; border:1px solid #374151; color:white; border-radius:4px; font-size:0.9rem;">
        `;
        kwList.appendChild(row);
    });

    // C. Event Listeners
    document.getElementById('use-ai-toggle').addEventListener('change', (e) => {
        document.getElementById('ai-key-wrapper').style.display = e.target.checked ? 'block' : 'none';
    });

    document.getElementById('closeSettingsBtnInternal').addEventListener('click', closeSettings);

    document.getElementById('saveGlobalSettingsBtn').addEventListener('click', async () => {
        // Collect Folders
        const selectedCards = grid.querySelectorAll('.source-btn.selected');
        const focusedFolderIds = Array.from(selectedCards).map(c => c.dataset.id);

        // Collect Keywords
        const inputEls = kwList.querySelectorAll('.keyword-input');
        const newCustom = {};
        inputEls.forEach(input => {
            const val = input.value.trim();
            if (val) {
                const kws = val.split(',').map(s => s.trim()).filter(s => s);
                if (kws.length) newCustom[input.dataset.cat] = kws;
            }
        });

        // Collect AI
        const useAI = document.getElementById('use-ai-toggle').checked;
        const apiKey = document.getElementById('gemini-api-key').value.trim();

        // Save
        const newSettings = {
            focusedFolderIds,
            customKeywords: newCustom,
            useAI,
            geminiApiKey: apiKey
        };

        await StorageManager.saveSettings(newSettings);
        alert("Settings Saved!");
        closeSettings();
    });
});

document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
    const checks = document.querySelectorAll('.setting-folder-check:checked');
    const focusedFolderIds = Array.from(checks).map(c => c.value);

    await StorageManager.saveSettings({ focusedFolderIds });
    alert("Settings Saved!");

    // The provided snippet had a duplicate settingsToggleBtn listener here,
    // which is incorrect. The settingsToggleBtn listener should only be defined once.
    // The keyword saving logic is now handled by a separate button created dynamically.
});

document.getElementById('closeSettingsBtn').addEventListener('click', closeSettings);

function closeSettings() {
    document.getElementById('settings-container').style.display = 'none';
    document.getElementById('actions').style.display = 'block';
    document.getElementById('groups-container').style.display = 'block';
    document.getElementById('workflows-container').style.display = 'block';

    // Reload tabs in case settings changed context logic (future proofing)
    loadCurrentTabs();
}
