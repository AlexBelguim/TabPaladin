// Notes feature — Obsidian-lite notes stored as first-class note items under
// the tree's notes root (the folder carrying role 'notes'). A note is a node
// of kind 'note': the title is the note title, and the payload holds
// {content, createdAt, updatedAt}. Notes used to be bookmarks with a
// data:application/json url; the payload replaced that encoding when the tree
// moved server-side.
//
// Notebooks are folders anywhere under the notes root. Every write here goes
// through TreeStore, so it lands in the local working copy, marks it dirty and
// waits for an explicit Push — nothing in this file talks to the server.
//
// The pure parts (tree walking, previews, search, the title rule) live in
// notesModel.js, which the PWA shares byte for byte.
import { TreeStore } from './treeStore.js';
import {
    parseLinks,
    parseTaskLine,
    toggleTaskAtLine,
    rewriteWikiLink,
    buildLibrary,
    emptyLibrary,
    notebookNameProblem
} from './notesModel.js';

export {
    TASK_LINE_RE,
    parseLinks,
    parseTaskLine,
    toggleTaskAtLine,
    rewriteWikiLink
} from './notesModel.js';

function toNote(node) {
    if (!node || node.kind !== 'note') return null;
    const p = node.payload || {};
    return {
        id: node.id,
        title: node.title,
        content: p.content || '',
        createdAt: p.createdAt || null,
        updatedAt: p.updatedAt || p.createdAt || null
    };
}

// How buildLibrary reads this tree's nodes.
const ADAPTER = {
    children: (n) => n.children || [],
    isFolder: (n) => n.kind === 'folder',
    isNote: (n) => n.kind === 'note',
    id: (n) => n.id,
    title: (n) => n.title || '',
    fields: (n) => n.payload || {}
};

// Walk one folder for notes; subfolders are notebooks, so recurse and tag each
// note with the folder it sits in. `notebook` stays the immediate folder's
// title for existing callers; notebookId/notebookPath tell same-named
// notebooks apart.
function collect(folder, book, out) {
    for (const c of folder.children || []) {
        const note = toNote(c);
        if (note) {
            note.notebook = book ? book.title : null;
            note.notebookId = book ? book.id : null;
            note.notebookPath = book ? book.path : [];
            out.push(note);
        } else if (c.kind === 'folder') {
            collect(c, {
                id: c.id,
                title: c.title || (book ? book.title : null),
                path: [...(book ? book.path : []), c.title || '']
            }, out);
        }
    }
}

// Where a node sits under the notes root: { node, parent, index }, or null
// when it is not inside the notes root at all.
function locate(root, id) {
    if (!root) return null;
    const walk = (folder) => {
        const kids = folder.children || [];
        for (let i = 0; i < kids.length; i++) {
            const c = kids[i];
            if (c.id === id) return { node: c, parent: folder, index: i };
            if (c.kind === 'folder') {
                const hit = walk(c);
                if (hit) return hit;
            }
        }
        return null;
    };
    return walk(root);
}

// A notebook id (or null for the notes root itself) resolved to a folder that
// is really inside the notes root. Anything else is refused: notes never leak
// into the bookmarks tree through this API.
function targetFolder(root, notebookId) {
    if (notebookId == null || notebookId === '' || notebookId === root.id) return root;
    const hit = locate(root, notebookId);
    if (!hit || hit.node.kind !== 'folder') throw new Error('That notebook is not in your notes.');
    return hit.node;
}

function siblingNotebookTitles(folder, exceptId = null) {
    return (folder.children || [])
        .filter(c => c.kind === 'folder' && c.id !== exceptId)
        .map(c => c.title);
}

function assertName(title, folder, exceptId = null) {
    const problem = notebookNameProblem(title, siblingNotebookTitles(folder, exceptId));
    if (problem) throw new Error(problem);
    return String(title).trim();
}

async function notesRootOrThrow() {
    const root = await TreeStore.findRoleRoot('notes');
    if (!root) throw new Error('There are no notes yet.');
    return root;
}

export const NotesManager = {
    NOTES_ROOT_TITLE: 'TabPaladin Notes',
    parseLinks,
    parseTaskLine,
    toggleTaskAtLine,

    findNotesRoot: () => TreeStore.findRoleRoot('notes'),

    // Everything the notes view draws: notebook tree, counts, previews.
    getLibrary: async () => {
        const root = await TreeStore.findRoleRoot('notes');
        return root ? buildLibrary(root, ADAPTER) : emptyLibrary();
    },

    listNotes: async () => {
        const root = await TreeStore.findRoleRoot('notes');
        if (!root) return [];
        const notes = [];
        collect(root, null, notes);
        // Most recently updated first.
        notes.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
        return notes;
    },

    // parentId files the note into a notebook; it must be inside the notes root.
    createNote: async (title, content = '', { parentId = null } = {}) => {
        const root = await TreeStore.ensureRoleRoot('notes');
        const parent = targetFolder(root, parentId);
        const now = new Date().toISOString();
        const node = await TreeStore.createNode({
            parentId: parent.id,
            kind: 'note',
            title,
            payload: { content, createdAt: now, updatedAt: now }
        });
        return toNote(node);
    },

    updateNote: async (id, { title, content }) => {
        const current = await TreeStore.getNode(id);
        if (!current) throw new Error('Note not found');
        const note = toNote(current);
        const oldTitle = current.title;
        const newTitle = title !== undefined ? title : oldTitle;
        const newContent = content !== undefined ? content : (note ? note.content : '');

        // Merged, not replaced: fields this client does not know about (a
        // pin flag, anything a newer client adds) must survive an edit.
        const updated = await TreeStore.updateNode(id, {
            title: newTitle,
            payload: {
                ...(current.payload || {}),
                content: newContent,
                createdAt: note && note.createdAt ? note.createdAt : new Date().toISOString(),
                updatedAt: new Date().toISOString()
            }
        });

        // Rename: rewrite [[Old Title]] links in every other note so they don't
        // break. Those notes keep their edited time — a rename is not an edit
        // of theirs, and bumping it would jump them all to the top of Recent.
        if (newTitle !== oldTitle) {
            const notes = await NotesManager.listNotes();
            for (const other of notes) {
                if (other.id === id) continue;
                const rewritten = rewriteWikiLink(other.content, oldTitle, newTitle);
                if (rewritten !== other.content) {
                    const node = await TreeStore.getNode(other.id);
                    await TreeStore.updateNode(other.id, {
                        payload: { ...((node && node.payload) || {}), content: rewritten }
                    });
                }
            }
        }

        return updated;
    },

    // Re-parent only: the payload is untouched, so the edited time stays.
    moveNote: async (id, notebookId = null) => {
        const root = await notesRootOrThrow();
        const hit = locate(root, id);
        if (!hit || hit.node.kind !== 'note') throw new Error('Note not found');
        const target = targetFolder(root, notebookId);
        if (hit.parent.id === target.id) return hit.node;
        return TreeStore.moveNode(id, { parentId: target.id });
    },

    deleteNote: async (id) => {
        await TreeStore.removeNode(id);
    },

    // --- Notebooks -----------------------------------------------------------
    // Names are refused when blank or equal to a sibling notebook's, ignoring
    // case. Notes are never deleted along with a notebook.

    createNotebook: async (title, parentId = null) => {
        const root = await TreeStore.ensureRoleRoot('notes');
        const parent = targetFolder(root, parentId);
        const name = assertName(title, parent);
        return TreeStore.createNode({ parentId: parent.id, kind: 'folder', title: name });
    },

    renameNotebook: async (id, title) => {
        const root = await notesRootOrThrow();
        const hit = locate(root, id);
        if (!hit || hit.node.kind !== 'folder') throw new Error('Notebook not found');
        const name = assertName(title, hit.parent, id);
        return TreeStore.updateNode(id, { title: name });
    },

    moveNotebook: async (id, parentId = null) => {
        const root = await notesRootOrThrow();
        const hit = locate(root, id);
        if (!hit || hit.node.kind !== 'folder') throw new Error('Notebook not found');
        const target = targetFolder(root, parentId);
        if (target.id === id || locate(hit.node, target.id)) {
            throw new Error('A notebook cannot move into itself.');
        }
        if (hit.parent.id === target.id) return hit.node;
        assertName(hit.node.title, target, id);
        return TreeStore.moveNode(id, { parentId: target.id });
    },

    // Lift, never cascade: the notebook's notes and sub-notebooks move into its
    // parent at its position, in order and with their ids, then the empty
    // folder goes.
    deleteNotebook: async (id) => {
        const root = await notesRootOrThrow();
        const hit = locate(root, id);
        if (!hit || hit.node.kind !== 'folder') throw new Error('Notebook not found');
        const children = [...(hit.node.children || [])];
        for (let i = 0; i < children.length; i++) {
            await TreeStore.moveNode(children[i].id, { parentId: hit.parent.id, index: hit.index + i });
        }
        await TreeStore.removeNode(id);
        return { moved: children.length };
    },

    // Notes whose content links to [[title]] (excluding the note itself).
    getBacklinks: async (title, excludeId = null) => {
        const notes = await NotesManager.listNotes();
        return notes.filter(n =>
            n.id !== excludeId && parseLinks(n.content).wiki.includes(title)
        );
    }
};
