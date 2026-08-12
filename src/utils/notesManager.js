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

// Every folder literally titled "TabPaladin Notes". Normally one; a second
// appears when the extension and the PWA each created their own before the
// two ever synced. Reading from all of them means notes written on the phone
// are never invisible here just because the roots disagree — writes still go
// to the canonical root that resolveRootFolder picks.
async function findAllNotesRoots() {
    let folders = [];
    try {
        const matches = await api.bookmarks.search({ title: NOTES_ROOT_TITLE });
        folders = matches.filter(m => !m.url && m.title === NOTES_ROOT_TITLE);
    } catch (e) {
        folders = [];
    }
    const canonical = await findNotesRoot();
    const seen = new Set();
    const out = [];
    for (const f of [canonical, ...folders]) {
        if (f && !seen.has(f.id)) { seen.add(f.id); out.push(f); }
    }
    return out;
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

// Markdown task list: "- [ ] thing" / "- [x] thing" (also "* [ ]").
// Captures indent, the marker character and the label.
const TASK_LINE_RE = /^(\s*)[-*]\s+\[([ xX])\]\s?(.*)$/;

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
    const m = line.match(/^(\s*[-*]\s+\[)([ xX])(\])/);
    if (!m) return text;
    lines[lineIndex] = m[1] + (m[2].toLowerCase() === 'x' ? ' ' : 'x') + line.slice(m[1].length + 1);
    return lines.join('\n');
}

// Replace [[oldTitle]] with [[newTitle]] inside a content string.
function rewriteWikiLink(content, oldTitle, newTitle) {
    const escaped = oldTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return content.replace(new RegExp(`\\[\\[\\s*${escaped}\\s*\\]\\]`, 'g'), `[[${newTitle}]]`);
}

export const NotesManager = {
    NOTES_ROOT_TITLE,
    parseLinks,
    parseTaskLine,
    toggleTaskAtLine,

    findNotesRoot,

    findAllNotesRoots,

    listNotes: async () => {
        const roots = await findAllNotesRoots();
        if (roots.length === 0) return [];
        const notes = [];
        const seen = new Set();
        // Direct children are loose notes; subfolders are notebooks
        // (created by the PWA), so recurse one level and tag each note
        // with its notebook title.
        const walk = async (parentId, notebook) => {
            const children = await api.bookmarks.getChildren(parentId);
            for (const c of children) {
                const note = parseNoteNode(c);
                if (note) {
                    if (seen.has(note.id)) continue;
                    seen.add(note.id);
                    note.notebook = notebook;
                    notes.push(note);
                } else if (!c.url) {
                    await walk(c.id, c.title || notebook);
                }
            }
        };
        for (const root of roots) {
            try {
                await walk(root.id, null);
            } catch (e) {
                // A duplicate root that vanished mid-read shouldn't lose the rest.
                console.warn('[TabPaladin Notes] could not read notes root', root.id, e);
            }
        }
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
