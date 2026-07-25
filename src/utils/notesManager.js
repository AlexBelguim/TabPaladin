// Notes feature — Obsidian-lite notes stored as bookmarks under a
// "TabPaladin Notes" root folder, resolved through the same shared resolver
// as the workflows root. Each note is one bookmark whose url is a
// data:application/json payload, so it syncs via the browser account and
// can't be accidentally opened as a page.
import { StorageManager } from './storageManager.js';

const api = typeof browser !== 'undefined' ? browser : chrome;

const NOTES_ROOT_TITLE = 'TabPaladin Notes';
const NOTES_ROOT_SETTINGS_KEY = 'notesRootBookmarkId';
const DATA_PREFIX = 'data:application/json,';

async function findNotesRoot() {
    return StorageManager.resolveRootFolder({
        title: NOTES_ROOT_TITLE,
        settingsKey: NOTES_ROOT_SETTINGS_KEY,
        create: false
    });
}

async function findOrCreateNotesRoot() {
    return StorageManager.resolveRootFolder({
        title: NOTES_ROOT_TITLE,
        settingsKey: NOTES_ROOT_SETTINGS_KEY,
        create: true
    });
}

function buildNoteUrl(payload) {
    return DATA_PREFIX + encodeURIComponent(JSON.stringify(payload));
}

function parseNoteNode(node) {
    if (!node || !node.url || !node.url.startsWith(DATA_PREFIX)) return null;
    let payload = {};
    try {
        payload = JSON.parse(decodeURIComponent(node.url.slice(DATA_PREFIX.length)));
    } catch (e) {
        return null;
    }
    return {
        id: node.id,
        title: node.title,
        content: payload.content || '',
        createdAt: payload.createdAt || new Date(node.dateAdded || Date.now()).toISOString(),
        updatedAt: payload.updatedAt || payload.createdAt || null
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

// Replace [[oldTitle]] with [[newTitle]] inside a content string.
function rewriteWikiLink(content, oldTitle, newTitle) {
    const escaped = oldTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return content.replace(new RegExp(`\\[\\[\\s*${escaped}\\s*\\]\\]`, 'g'), `[[${newTitle}]]`);
}

export const NotesManager = {
    NOTES_ROOT_TITLE,
    parseLinks,

    findNotesRoot,

    listNotes: async () => {
        const root = await findNotesRoot();
        if (!root) return [];
        const notes = [];
        // Direct children are loose notes; subfolders are notebooks
        // (created by the PWA), so recurse one level and tag each note
        // with its notebook title.
        const walk = async (parentId, notebook) => {
            const children = await api.bookmarks.getChildren(parentId);
            for (const c of children) {
                const note = parseNoteNode(c);
                if (note) {
                    note.notebook = notebook;
                    notes.push(note);
                } else if (!c.url) {
                    await walk(c.id, c.title || notebook);
                }
            }
        };
        await walk(root.id, null);
        // Most recently updated first.
        notes.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
        return notes;
    },

    createNote: async (title, content = '') => {
        const root = await findOrCreateNotesRoot();
        const now = new Date().toISOString();
        const node = await api.bookmarks.create({
            parentId: root.id,
            title,
            url: buildNoteUrl({ v: 1, content, createdAt: now, updatedAt: now })
        });
        return parseNoteNode(node);
    },

    updateNote: async (id, { title, content }) => {
        const current = (await api.bookmarks.get(id))[0];
        if (!current) throw new Error('Note not found');
        const note = parseNoteNode(current);
        const oldTitle = current.title;
        const newTitle = title !== undefined ? title : oldTitle;
        const newContent = content !== undefined ? content : (note ? note.content : '');

        await api.bookmarks.update(id, {
            title: newTitle,
            url: buildNoteUrl({
                v: 1,
                content: newContent,
                createdAt: note ? note.createdAt : new Date().toISOString(),
                updatedAt: new Date().toISOString()
            })
        });

        // Rename: rewrite [[Old Title]] links in every other note so they don't break.
        if (newTitle !== oldTitle) {
            const notes = await NotesManager.listNotes();
            for (const other of notes) {
                if (other.id === id) continue;
                const rewritten = rewriteWikiLink(other.content, oldTitle, newTitle);
                if (rewritten !== other.content) {
                    await api.bookmarks.update(other.id, {
                        url: buildNoteUrl({
                            v: 1,
                            content: rewritten,
                            createdAt: other.createdAt,
                            updatedAt: new Date().toISOString()
                        })
                    });
                }
            }
        }

        return (await api.bookmarks.get(id))[0];
    },

    deleteNote: async (id) => {
        await api.bookmarks.remove(id);
    },

    // Notes whose content links to [[title]] (excluding the note itself).
    getBacklinks: async (title, excludeId = null) => {
        const notes = await NotesManager.listNotes();
        return notes.filter(n =>
            n.id !== excludeId && parseLinks(n.content).wiki.includes(title)
        );
    }
};
