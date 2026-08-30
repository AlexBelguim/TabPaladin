// Notes feature — Obsidian-lite notes stored as first-class note items under
// the tree's notes root (the folder carrying role 'notes'). A note is a node
// of kind 'note': the title is the note title, and the payload holds
// {content, createdAt, updatedAt}. Notes used to be bookmarks with a
// data:application/json url; the payload replaced that encoding when the tree
// moved server-side.
import { TreeStore } from './treeStore.js';

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

// Extract [[wiki link targets]] and bare http(s) URLs from note content.
function parseLinks(content) {
    const wiki = [];
    const wikiRe = /\[\[([^\[\]]+)\]\]/g;
    let m;
    while ((m = wikiRe.exec(content)) !== null) {
        const target = m[1].trim();
        if (target) wiki.push(target);
    }
    const urls = content.match(/https?:\/\/[^\s)\]]+/g) || [];
    return { wiki, urls };
}

// Markdown task list: "- [ ] thing" / "- [x] thing" (also "* [ ]"), and a
// bare "[ ] thing" with no list marker at all.
//
// Strict GitHub markdown wants the bullet, but people type the box on its own
// and then wonder why nothing is clickable — so the bullet is optional here.
// It stays captured so toggling can rewrite only the box and leave the rest of
// the line, bullet or not, byte-for-byte intact.
const TASK_LINE_RE = /^(\s*)(?:[-*]\s+)?\[([ xX])\]\s?(.*)$/;

function parseTaskLine(line) {
    const m = String(line).match(TASK_LINE_RE);
    if (!m) return null;
    return { indent: m[1].length, checked: m[2].toLowerCase() === 'x', label: m[3] };
}

// Flip the checkbox on one line, byte-for-byte preserving everything else —
// indentation, the bullet character, the label, and every other line.
function toggleTaskAtLine(content, lineIndex) {
    const text = String(content == null ? '' : content);
    const lines = text.split('\n');
    if (!Number.isInteger(lineIndex) || lineIndex < 0 || lineIndex >= lines.length) return text;
    const line = lines[lineIndex];
    // Only the "[ ]" box itself is rewritten; the rest of the line is untouched.
    const m = line.match(/^(\s*(?:[-*]\s+)?\[)([ xX])(\])/);
    if (!m) return text;
    lines[lineIndex] = m[1] + (m[2].toLowerCase() === 'x' ? ' ' : 'x') + line.slice(m[1].length + 1);
    return lines.join('\n');
}

// Replace [[oldTitle]] with [[newTitle]] inside a content string.
function rewriteWikiLink(content, oldTitle, newTitle) {
    const escaped = oldTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return content.replace(new RegExp(`\\[\\[\\s*${escaped}\\s*\\]\\]`, 'g'), `[[${newTitle}]]`);
}

// Walk one folder for notes; subfolders are notebooks, so recurse and tag each
// note with the folder title it sits in.
function collect(folder, notebook, out) {
    for (const c of folder.children || []) {
        const note = toNote(c);
        if (note) {
            note.notebook = notebook;
            out.push(note);
        } else if (c.kind === 'folder') {
            collect(c, c.title || notebook, out);
        }
    }
}

export const NotesManager = {
    NOTES_ROOT_TITLE: 'TabPaladin Notes',
    parseLinks,
    parseTaskLine,
    toggleTaskAtLine,

    findNotesRoot: () => TreeStore.findRoleRoot('notes'),

    listNotes: async () => {
        const root = await TreeStore.findRoleRoot('notes');
        if (!root) return [];
        const notes = [];
        collect(root, null, notes);
        // Most recently updated first.
        notes.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
        return notes;
    },

    createNote: async (title, content = '') => {
        const root = await TreeStore.ensureRoleRoot('notes');
        const now = new Date().toISOString();
        const node = await TreeStore.createNode({
            parentId: root.id,
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

        const updated = await TreeStore.updateNode(id, {
            title: newTitle,
            payload: {
                content: newContent,
                createdAt: note ? note.createdAt : new Date().toISOString(),
                updatedAt: new Date().toISOString()
            }
        });

        // Rename: rewrite [[Old Title]] links in every other note so they don't break.
        if (newTitle !== oldTitle) {
            const notes = await NotesManager.listNotes();
            for (const other of notes) {
                if (other.id === id) continue;
                const rewritten = rewriteWikiLink(other.content, oldTitle, newTitle);
                if (rewritten !== other.content) {
                    await TreeStore.updateNode(other.id, {
                        payload: {
                            content: rewritten,
                            createdAt: other.createdAt,
                            updatedAt: new Date().toISOString()
                        }
                    });
                }
            }
        }

        return updated;
    },

    deleteNote: async (id) => {
        await TreeStore.removeNode(id);
    },

    // Notes whose content links to [[title]] (excluding the note itself).
    getBacklinks: async (title, excludeId = null) => {
        const notes = await NotesManager.listNotes();
        return notes.filter(n =>
            n.id !== excludeId && parseLinks(n.content).wiki.includes(title)
        );
    }
};
