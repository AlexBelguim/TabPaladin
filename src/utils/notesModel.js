// Notes model shared by both clients: the notebook tree, counts, previews,
// search, recency and the title rule, as pure functions with no imports and no
// side effects.
//
// There are two copies of this file and they must stay byte-identical:
// src/utils/notesModel.js (the extension, re-exported through NotesManager)
// and pwa/notesModel.js (the PWA, which is served on its own and cannot import
// from src/). Edit one, copy it over the other; tools/test_notes_model.mjs
// fails the moment they differ. If the two disagreed, a note would show one
// title, count or preview on the phone and another on the computer.
//
// Both clients hand their own tree to buildLibrary() through a small adapter,
// because their node shapes differ:
//   { children(n), isFolder(n), isNote(n), id(n), title(n),
//     fields(n) -> { content, createdAt, updatedAt } }

// Bookkeeping nodes TabPaladin writes into folders. Never notes or notebooks.
export const SENTINEL_TITLES = new Set(['__tabpaladin_meta__', '__tabpaladin_root__']);

// --- Markdown helpers -------------------------------------------------------
// Moved here from notesManager.js unchanged; NotesManager re-exports them.

// Extract [[wiki link targets]] and bare http(s) URLs from note content.
export function parseLinks(content) {
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
export const TASK_LINE_RE = /^(\s*)(?:[-*]\s+)?\[([ xX])\]\s?(.*)$/;

export function parseTaskLine(line) {
    const m = String(line).match(TASK_LINE_RE);
    if (!m) return null;
    return { indent: m[1].length, checked: m[2].toLowerCase() === 'x', label: m[3] };
}

// Flip the checkbox on one line, byte-for-byte preserving everything else —
// indentation, the bullet character, the label, and every other line.
export function toggleTaskAtLine(content, lineIndex) {
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
export function rewriteWikiLink(content, oldTitle, newTitle) {
    const escaped = oldTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return content.replace(new RegExp(`\\[\\[\\s*${escaped}\\s*\\]\\]`, 'g'), `[[${newTitle}]]`);
}

// Open/done/total task counts, for the "1/3" pill and the Open tasks scope.
export function taskStats(content) {
    let open = 0;
    let done = 0;
    for (const line of String(content == null ? '' : content).split(/\r?\n/)) {
        const task = parseTaskLine(line);
        if (!task) continue;
        if (task.checked) done++;
        else open++;
    }
    return { open, done, total: open + done };
}

// --- Title rule -------------------------------------------------------------
//
// The stored title is canonical. The note's first non-blank line, when it is
// "# X", is kept in step with it: renaming rewrites that line, and changing
// that line during an edit renames the note. A "# " further down is only a
// heading. The PWA used to take the first "# " line anywhere as the title, so a
// later "# Section" silently renamed the note — and a note renamed in the
// extension was renamed back by the next phone save.

const H1_RE = /^#\s+(.+?)\s*$/;

function firstContentLine(lines) {
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim()) return i;
    }
    return -1;
}

// The "# X" on the first non-blank line, or null. Only that line counts.
export function leadingTitle(content) {
    const lines = String(content == null ? '' : content).split('\n');
    const i = firstContentLine(lines);
    if (i < 0) return null;
    const m = lines[i].replace(/\r$/, '').match(H1_RE);
    const title = m ? m[1].trim() : '';
    return title || null;
}

function replaceLeadingTitle(content, title) {
    const lines = String(content).split('\n');
    const i = firstContentLine(lines);
    if (i < 0) return String(content);
    const cr = lines[i].endsWith('\r') ? '\r' : '';
    lines[i] = `# ${title}${cr}`;
    return lines.join('\n');
}

// Decide the title (and content) a save writes. Rules, in order:
//  1. A title field that differs from the stored title wins (blank means
//     'Untitled'), and the first line is rewritten when it still carries the
//     old title — either the stored one or the one the editor loaded.
//  2. A first-line "# X" that changed during this edit renames the note.
//  3. Otherwise the stored title stays; a brand-new note takes its "# X", or
//     'Untitled'.
// Rule 2 is what keeps diverged notes (stored 'New', body still '# Old') from
// being renamed back: the H1 only counts when this edit changed it.
export function resolveTitleOnSave({ storedTitle = null, loadedContent = '', newContent = '', titleField } = {}) {
    const stored = typeof storedTitle === 'string' ? storedTitle.trim() : '';
    const content = String(newContent == null ? '' : newContent);
    const newH1 = leadingTitle(content);
    const loadedH1 = leadingTitle(loadedContent);

    if (typeof titleField === 'string' && titleField.trim() !== stored) {
        const title = titleField.trim() || 'Untitled';
        if (newH1 !== null && (newH1 === stored || newH1 === loadedH1)) {
            return { title, content: replaceLeadingTitle(content, title) };
        }
        return { title, content };
    }
    if (newH1 !== null && newH1 !== loadedH1) return { title: newH1, content };
    return { title: stored || newH1 || 'Untitled', content };
}

// --- Plain-text previews ------------------------------------------------------

function hostOf(url) {
    const m = String(url).match(/^https?:\/\/(?:[^@/?#\s]*@)?([^/?#\s:]+)/i);
    return m ? m[1].replace(/^www\./i, '') : url;
}

// Inline markdown to plain text: [label](url) -> label, [[X]] -> X, URLs to
// their host (or kept whole), and emphasis/code markers dropped.
function inlinePlain(text, hostOnly) {
    return String(text)
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[\[([^\[\]]+)\]\]/g, (m, t) => t.trim())
        .replace(/https?:\/\/[^\s)\]>]+/g, (u) => (hostOnly ? hostOf(u) : u))
        .replace(/`([^`]*)`/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1$2')
        .replace(/~~([^~]+)~~/g, '$1');
}

// One line of text for a whole note. List items and headings are joined with
// ' · ' (a shopping list reads 'milk · eggs'), runs of prose with a space. A
// leading '# Title' that repeats the title is dropped: the row already shows it.
function flatten(content, { title = null, hostOnly = true } = {}) {
    const lines = String(content == null ? '' : content).split(/\r?\n/);
    let i = firstContentLine(lines);
    if (i < 0) return '';
    const h1 = lines[i].match(H1_RE);
    const wanted = String(title == null ? '' : title).trim().toLowerCase();
    if (h1 && (!wanted || h1[1].trim().toLowerCase() === wanted)) i++;

    const parts = [];
    for (; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim() || /^\s*(```|~~~|-{3,}|\*{3,}|_{3,})\s*$/.test(line)) continue;
        let text;
        let item = true;
        const task = parseTaskLine(line);
        const heading = line.match(/^\s*#{1,6}\s+(.*)$/);
        const bullet = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
        if (task) text = task.label;
        else if (heading) text = heading[1];
        else if (bullet) text = bullet[1];
        else {
            text = line.replace(/^\s*>\s?/, '');
            item = false;
        }
        text = inlinePlain(text, hostOnly).replace(/\s+/g, ' ').trim();
        if (text) parts.push({ text, item });
    }
    let out = '';
    parts.forEach((p, j) => {
        if (j === 0) out = p.text;
        else out += (p.item || parts[j - 1].item ? ' · ' : ' ') + p.text;
    });
    return out;
}

// The two-line preview under a note row.
export function plainPreview(content, title = '', max = 160) {
    const text = flatten(content, { title, hostOnly: true });
    if (text.length <= max) return text;
    return text.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

// --- Recency --------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function toDate(value) {
    if (value == null || value === '') return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

// Whole calendar days between two instants, in local time. Rounded, so a
// daylight-saving day of 23 or 25 hours still counts as one.
function calendarDaysBetween(earlier, later) {
    const a = new Date(earlier.getFullYear(), earlier.getMonth(), earlier.getDate());
    const b = new Date(later.getFullYear(), later.getMonth(), later.getDate());
    return Math.round((b - a) / 86400000);
}

// 'now', '5m', '2h', 'Yesterday', 'Mon', '12 Mar', '12 Mar 2024' — or '' when
// the note carries no usable timestamp.
export function relativeTime(iso, now = Date.now()) {
    const d = toDate(iso);
    if (!d) return '';
    const n = toDate(now) || new Date();
    const secs = (n - d) / 1000;
    if (secs < 60) return 'now';
    if (secs < 3600) return `${Math.floor(secs / 60)}m`;
    const days = calendarDaysBetween(d, n);
    if (days <= 0) return `${Math.floor(secs / 3600)}h`;
    if (days === 1) return 'Yesterday';
    if (days < 7) return WEEKDAYS[d.getDay()];
    if (d.getFullYear() === n.getFullYear()) return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export const RECENCY_BUCKETS = ['Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days', 'Older', 'Undated'];

export function recencyBucket(iso, now = Date.now()) {
    const d = toDate(iso);
    if (!d) return 'Undated';
    const days = calendarDaysBetween(d, toDate(now) || new Date());
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days <= 7) return 'Previous 7 days';
    if (days <= 30) return 'Previous 30 days';
    return 'Older';
}

// Consecutive runs of notes per recency bucket, for the list's section
// headers. Expects notes already sorted by sortNotes(…, 'edited').
export function groupByRecency(notes, now = Date.now()) {
    const groups = [];
    for (const note of notes) {
        const bucket = recencyBucket(note.updatedAt, now);
        const last = groups[groups.length - 1];
        if (last && last.bucket === bucket) last.notes.push(note);
        else groups.push({ bucket, notes: [note] });
    }
    return groups;
}

// --- Library ----------------------------------------------------------------------
//
// One walk of the notes root gives everything both clients draw:
//   notebooks: Map<id, { id, title, parentId, path, pathIds, depth, children,
//              directCount, totalCount, openTaskNotes }>   (any depth)
//   roots:     the top-level notebooks, in stored order
//   notes:     [{ id, title, content, createdAt, updatedAt, notebookId, path,
//              pathIds, order, preview, tasks }]   (order = tree order)
//   counts:    { all, unfiled, openTasks }
// Notebooks are identified by id, never by title, so Work › Meetings and
// Recipes › Meetings stay two notebooks.

// Previews and task counts are memoised per note version: a phone with a few
// hundred notes rebuilds the library on every render.
const derived = new Map();

function deriveNote(id, title, content, updatedAt) {
    const key = `${id}|${updatedAt}|${content.length}`;
    const hit = derived.get(key);
    // Same length and stamp is not proof of the same text: a link rewrite
    // keeps updatedAt, and [[Pasta]] -> [[Pizza]] keeps the length.
    if (hit && hit.content === content && hit.title === title) return hit;
    if (derived.size > 5000) derived.clear();
    const entry = { content, title, preview: plainPreview(content, title), tasks: taskStats(content) };
    derived.set(key, entry);
    return entry;
}

export function emptyLibrary() {
    return { rootId: null, notebooks: new Map(), roots: [], notes: [], counts: { all: 0, unfiled: 0, openTasks: 0 } };
}

export function buildLibrary(notesRoot, adapter) {
    const lib = emptyLibrary();
    if (!notesRoot || !adapter) return lib;
    lib.rootId = adapter.id(notesRoot);
    let order = 0;

    const walk = (folder, book) => {
        for (const child of adapter.children(folder) || []) {
            if (!child) continue;
            const title = adapter.title(child) || '';
            if (SENTINEL_TITLES.has(title)) continue;
            if (adapter.isNote(child)) {
                const f = adapter.fields(child) || {};
                const id = adapter.id(child);
                const content = typeof f.content === 'string' ? f.content : '';
                const updatedAt = f.updatedAt || f.createdAt || null;
                const d = deriveNote(id, title, content, updatedAt);
                lib.notes.push({
                    id,
                    title,
                    content,
                    createdAt: f.createdAt || null,
                    updatedAt,
                    notebookId: book ? book.id : null,
                    path: book ? book.path : [],
                    pathIds: book ? book.pathIds : [],
                    order: order++,
                    preview: d.preview,
                    tasks: d.tasks
                });
            } else if (adapter.isFolder(child)) {
                const id = adapter.id(child);
                const nb = {
                    id,
                    title,
                    parentId: book ? book.id : null,
                    path: [...(book ? book.path : []), title],
                    pathIds: [...(book ? book.pathIds : []), id],
                    depth: book ? book.depth + 1 : 0,
                    children: [],
                    directCount: 0,
                    totalCount: 0,
                    openTaskNotes: 0
                };
                lib.notebooks.set(id, nb);
                (book ? book.children : lib.roots).push(nb);
                walk(child, nb);
            }
        }
    };
    walk(notesRoot, null);

    // A notebook's count includes its sub-notebooks' notes.
    for (const note of lib.notes) {
        const open = note.tasks.open > 0;
        lib.counts.all++;
        if (open) lib.counts.openTasks++;
        if (!note.notebookId) {
            lib.counts.unfiled++;
            continue;
        }
        lib.notebooks.get(note.notebookId).directCount++;
        for (const id of note.pathIds) {
            const nb = lib.notebooks.get(id);
            nb.totalCount++;
            if (open) nb.openTaskNotes++;
        }
    }
    return lib;
}

// Scopes are 'all' | 'tasks' | 'unfiled' | 'nb:<id>'. A notebook scope lists
// its direct notes (sub-notebooks get rows of their own) unless deep is set,
// which is what search inside a notebook uses.
export function notesInScope(library, scope, { deep = false } = {}) {
    if (scope === 'tasks') return library.notes.filter(n => n.tasks.open > 0);
    if (scope === 'unfiled') return library.notes.filter(n => !n.notebookId);
    const id = notebookIdOf(scope);
    if (id) {
        return deep
            ? library.notes.filter(n => n.pathIds.includes(id))
            : library.notes.filter(n => n.notebookId === id);
    }
    return library.notes.slice();
}

export function notebookIdOf(scope) {
    return typeof scope === 'string' && scope.startsWith('nb:') ? scope.slice(3) : null;
}

// Display name of a scope; a notebook scope whose notebook vanished (a pull
// removed it) reads as All notes, which is also what the clients fall back to.
export function scopeLabel(library, scope) {
    if (scope === 'tasks') return 'Open tasks';
    if (scope === 'unfiled') return 'Unfiled';
    const nb = library.notebooks.get(notebookIdOf(scope));
    if (nb) return nb.title || '(unnamed)';
    return 'All notes';
}

// 'Work › Meetings', truncated from the left ('… › Meetings') when it would
// not fit; the leaf is what tells notebooks apart.
export function pathLabel(path, maxChars = 32) {
    const parts = (path || []).map(p => p || '(unnamed)');
    const full = parts.join(' › ');
    if (full.length <= maxChars || parts.length < 2) return full;
    for (let i = 1; i < parts.length; i++) {
        const label = '… › ' + parts.slice(i).join(' › ');
        if (label.length <= maxChars) return label;
    }
    return '… › ' + parts[parts.length - 1];
}

const timeOf = (iso) => {
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isNaN(t) ? -Infinity : t;
};

// Stable: equal keys keep tree order. 'edited' puts undated notes last.
export function sortNotes(notes, mode = 'edited') {
    const list = Array.from(notes || []);
    if (mode === 'manual') {
        list.sort((a, b) => a.order - b.order);
    } else if (mode === 'title') {
        list.sort((a, b) =>
            String(a.title || '').localeCompare(String(b.title || ''), undefined, { sensitivity: 'base', numeric: true })
            || a.order - b.order);
    } else {
        list.sort((a, b) => (timeOf(b.updatedAt) - timeOf(a.updatedAt)) || a.order - b.order);
    }
    return list;
}

// First note with this exact title, else one matching case-insensitively.
export function findNoteByTitle(library, title) {
    const t = String(title == null ? '' : title).trim();
    if (!t) return null;
    const lower = t.toLowerCase();
    return library.notes.find(n => n.title === t)
        || library.notes.find(n => String(n.title).trim().toLowerCase() === lower)
        || null;
}

// Notes whose content links to [[title]], excluding the note itself.
export function backlinksTo(library, title, excludeId = null) {
    if (!title) return [];
    return library.notes.filter(n => n.id !== excludeId && parseLinks(n.content).wiki.includes(title));
}

// --- Search -------------------------------------------------------------------------

// Lower case, NFD, combining marks removed: 'Crème' matches 'creme'.
export function normalizeForSearch(s) {
    return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

// Character-wise normalisation that remembers where each normalised character
// came from, so hit positions map back onto the original text. Only used when
// normalising changed the length; otherwise positions already line up.
function normalizeWithMap(s) {
    const str = String(s == null ? '' : s);
    let norm = '';
    const starts = [];
    const ends = [];
    let i = 0;
    for (const ch of str) {
        const n = ch.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
        for (let k = 0; k < n.length; k++) {
            starts.push(i);
            ends.push(i + ch.length);
        }
        norm += n;
        i += ch.length;
    }
    return { norm, starts, ends };
}

function locator(text) {
    const fast = normalizeForSearch(text);
    if (fast.length === text.length) {
        return { norm: fast, from: (s, e) => [s, e] };
    }
    const m = normalizeWithMap(text);
    return { norm: m.norm, from: (s, e) => [m.starts[s], m.ends[e - 1]] };
}

function mergeRanges(ranges) {
    const sorted = ranges.filter(r => r[1] > r[0]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const out = [];
    for (const r of sorted) {
        const last = out[out.length - 1];
        if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
        else out.push([r[0], r[1]]);
    }
    return out;
}

// Every occurrence of every term, as [start, end) ranges into the original text.
function matchRanges(text, terms) {
    const loc = locator(String(text || ''));
    const ranges = [];
    for (const t of terms) {
        let at = loc.norm.indexOf(t);
        while (at !== -1) {
            ranges.push(loc.from(at, at + t.length));
            at = loc.norm.indexOf(t, at + t.length);
        }
    }
    return mergeRanges(ranges);
}

const SNIPPET_RADIUS = 40;

// About 40 characters either side of the first hit in the note's text, cut at
// word boundaries. Plain data: callers escape it before it touches HTML.
function contentSnippet(content, title, terms) {
    const plain = flatten(content, { title, hostOnly: false });
    if (!plain) return null;
    const loc = locator(plain);
    let best = null;
    for (const t of terms) {
        const at = loc.norm.indexOf(t);
        if (at !== -1 && (!best || at < best[0])) best = [at, at + t.length];
    }
    if (!best) return null;
    const [start, end] = loc.from(best[0], best[1]);
    let s = Math.max(0, start - SNIPPET_RADIUS);
    let e = Math.min(plain.length, end + SNIPPET_RADIUS);
    if (s > 0) {
        const sp = plain.indexOf(' ', s);
        if (sp !== -1 && sp < start) s = sp + 1;
    }
    if (e < plain.length) {
        const sp = plain.lastIndexOf(' ', e);
        if (sp > end) e = sp;
    }
    return {
        before: (s > 0 ? '…' : '') + plain.slice(s, start),
        hit: plain.slice(start, end),
        after: plain.slice(end, e) + (e < plain.length ? '…' : '')
    };
}

const normalizedContent = new Map();
function normContent(note) {
    const hit = normalizedContent.get(note.id);
    if (hit && hit.src === note.content) return hit.norm;
    if (normalizedContent.size > 5000) normalizedContent.clear();
    const norm = normalizeForSearch(note.content);
    normalizedContent.set(note.id, { src: note.content, norm });
    return norm;
}

// Every whitespace-separated term must match the title, the notebook path or
// the content. Ranking: title prefix, title contains, notebook path, content;
// ties go to the most recently edited.
//   -> [{ note, score, titleRanges: [[start, end]...], snippet: {before, hit, after} | null }]
// `notebookId` limits the search to that notebook and its sub-notebooks;
// `notes` replaces the candidate list (the Open tasks or Unfiled scope).
export function searchNotes(library, query, { notebookId = null, notes = null } = {}) {
    const terms = normalizeForSearch(query).split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    let pool = notes || library.notes;
    if (notebookId) pool = pool.filter(n => n.pathIds.includes(notebookId));

    const results = [];
    for (const note of pool) {
        const title = normalizeForSearch(note.title);
        const path = normalizeForSearch(note.path.join(' / '));
        const content = normContent(note);
        let inTitle = false;
        let inPath = false;
        let inContent = false;
        let all = true;
        for (const t of terms) {
            const a = title.includes(t);
            const b = path.includes(t);
            const c = content.includes(t);
            if (!a && !b && !c) { all = false; break; }
            inTitle = inTitle || a;
            inPath = inPath || b;
            inContent = inContent || c;
        }
        if (!all) continue;
        const score = title.startsWith(terms[0]) ? 4 : inTitle ? 3 : inPath ? 2 : 1;
        results.push({
            note,
            score,
            titleRanges: inTitle ? matchRanges(note.title, terms) : [],
            snippet: inContent ? contentSnippet(note.content, note.title, terms) : null
        });
    }
    results.sort((a, b) =>
        (b.score - a.score)
        || (timeOf(b.note.updatedAt) - timeOf(a.note.updatedAt))
        || (a.note.order - b.note.order));
    return results;
}

// Wrap ranges of `text` in <mark>, escaping everything with the caller's
// escaper — this module never builds HTML from unescaped text.
export function highlightHtml(text, ranges, escape) {
    const s = String(text == null ? '' : text);
    let out = '';
    let at = 0;
    for (const [start, end] of ranges || []) {
        if (start < at) continue;
        out += escape(s.slice(at, start)) + '<mark>' + escape(s.slice(start, end)) + '</mark>';
        at = end;
    }
    return out + escape(s.slice(at));
}

// --- Notebook operations ------------------------------------------------------------

// The tree flattened for a Move to… picker, in tree order. The item being
// moved (excludeId) and everything inside it are disabled, and so is the
// current location (currentId).
export function notebookOptions(library, { excludeId = null, currentId = null } = {}) {
    const out = [];
    const walk = (books, blocked) => {
        for (const b of books) {
            const excluded = blocked || b.id === excludeId;
            const current = currentId !== null && b.id === currentId;
            out.push({
                id: b.id,
                title: b.title,
                depth: b.depth,
                path: b.path,
                count: b.totalCount,
                current,
                excluded,
                disabled: excluded || current
            });
            walk(b.children, excluded);
        }
    };
    walk(library.roots, false);
    return out;
}

// Why a notebook name is refused, or null when it is fine: blank, or the same
// as a sibling notebook's name ignoring case.
export function notebookNameProblem(name, siblingTitles = []) {
    const t = String(name == null ? '' : name).trim();
    if (!t) return 'Notebook name cannot be empty.';
    if (SENTINEL_TITLES.has(t)) return 'That name is reserved.';
    const lower = t.toLowerCase();
    if ((siblingTitles || []).some(s => String(s == null ? '' : s).trim().toLowerCase() === lower)) {
        return `There is already a notebook called "${t}" here.`;
    }
    return null;
}

// Find the notebook an import link or LLM proposal names. Order:
//   an exact top-level title; an exact nested title that itself contains
//   ' / '; an 'A / B' path; a unique nested title; otherwise create it at the
//   top level.
// -> { id } | { create: { parentId | null, segments } } | null for a blank name.
// Matching ignores case, preferring an exact-case match among equals.
export function resolveNotebookByName(library, name) {
    const wanted = String(name == null ? '' : name).trim();
    if (!wanted) return null;
    const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
    const pick = (list, t) => list.find(b => String(b.title).trim() === t) || list[0];

    const top = library.roots.filter(b => same(b.title, wanted));
    if (top.length) return { id: pick(top, wanted).id };

    const all = [...library.notebooks.values()];
    if (wanted.includes(' / ')) {
        const literal = all.filter(b => same(b.title, wanted));
        if (literal.length) return { id: pick(literal, wanted).id };
        const segments = wanted.split(/\s+\/\s+/).map(s => s.trim()).filter(Boolean);
        let level = library.roots;
        let parent = null;
        let i = 0;
        for (; i < segments.length; i++) {
            const hits = level.filter(b => same(b.title, segments[i]));
            if (!hits.length) break;
            parent = pick(hits, segments[i]);
            level = parent.children;
        }
        if (i === segments.length) return { id: parent.id };
        return { create: { parentId: parent ? parent.id : null, segments: segments.slice(i) } };
    }

    const nested = all.filter(b => b.depth > 0 && same(b.title, wanted));
    if (nested.length === 1) return { id: nested[0].id };
    return { create: { parentId: null, segments: [wanted] } };
}

// Deleting a notebook never deletes notes: its children (notes and
// sub-notebooks, order kept) take its place among its siblings.
export function liftChildren(siblings, index, children) {
    const list = Array.from(siblings || []);
    if (!Number.isInteger(index) || index < 0 || index >= list.length) return list;
    return [...list.slice(0, index), ...(children || []), ...list.slice(index + 1)];
}

// --- Per-device UI state --------------------------------------------------------------
//
// Fold state, scope, last note, sort and editor mode live in localStorage on
// each device and are never synced. Every read is validated: a stale or
// garbled entry falls back to the defaults rather than breaking Notes.

export const NOTES_UI_KEY = 'tp_notes_ui_v1';

export function defaultNotesUi() {
    return { expanded: [], scope: 'all', noteId: null, sort: 'edited', mode: 'read' };
}

export function readNotesUi(storage) {
    const d = defaultNotesUi();
    try {
        const raw = storage ? storage.getItem(NOTES_UI_KEY) : null;
        if (!raw) return d;
        const p = JSON.parse(raw) || {};
        return {
            expanded: Array.isArray(p.expanded) ? p.expanded.filter(x => typeof x === 'string').slice(0, 1000) : [],
            scope: typeof p.scope === 'string' && /^(all|tasks|unfiled|nb:.+)$/.test(p.scope) ? p.scope : d.scope,
            noteId: typeof p.noteId === 'string' && p.noteId ? p.noteId : null,
            sort: ['edited', 'title', 'manual'].includes(p.sort) ? p.sort : d.sort,
            mode: ['read', 'edit', 'split'].includes(p.mode) ? p.mode : d.mode
        };
    } catch (e) {
        return d;
    }
}

export function writeNotesUi(storage, prefs) {
    try {
        if (storage) storage.setItem(NOTES_UI_KEY, JSON.stringify(prefs));
    } catch (e) {
        // Private mode or blocked storage: the UI still works, it just forgets.
    }
}
