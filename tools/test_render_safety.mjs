// What a note, a bookmark or a server answer can put on the page: text, never
// markup or script.
//
// The note renderers used to build HTML strings with regex replaces, and the
// URL pass ran over the markup the wikilink pass had just written:
// [[https://a.com/x/onmouseover=alert`1`//]] came out as a link inside the
// chip's data-target, breaking out of the attribute (stored XSS from a note,
// in the PWA and in the extension's notes page). Now both build DOM nodes
// from notesModel's tokens.
//
// What this locks down:
//   1. The tokenizer: the reviewer's payload is one wikilink token whose
//      target is plain text; URLs stop at quotes, '<', '>' and backticks.
//   2. safeHref takes http and https only: javascript:, data:, vbscript:,
//      file: and the rest are refused.
//   3. The inline DOM builder (NM.appendInlineNodes), the PWA's note preview
//      (pwa/app.js renderNotePreview, evaluated on its own) and the
//      extension's (src/app/notesView.js renderNoteContent), on a fake
//      document, over hostile notes: only the expected elements, properties,
//      data-* keys and styles are ever set, every href is http(s), and the
//      hostile text arrives as text.
//   4. The innerHTML audit of pwa/*.js stays done: every interpolation in an
//      HTML-looking template is escaped, a number, a constant or one of the
//      reviewed locals below (counted, so a new one fails until reviewed);
//      no insertAdjacentHTML, outerHTML or document.write; window.open only
//      inside openExternal, which takes http(s) only.
//   5. The notes renderers keep no HTML-string path: the old functions are
//      gone and the preview is not written with innerHTML.
//   6. The notesModel twins are byte-identical.
//
// Run: node tools/test_render_safety.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as NM from '../src/utils/notesModel.js';
import * as PWA_NM from '../pwa/notesModel.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let failures = 0;
function check(name, cond, detail) {
    if (cond) console.log(`  ok  ${name}`);
    else { failures++; console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- A fake document that records everything set on an element ----------------

function makeDoc() {
    const text = (t) => ({ nodeType: 3, textContent: String(t) });
    const element = (tag) => {
        const node = { nodeType: 1, tagName: String(tag).toUpperCase(), childNodes: [], dataset: {}, style: {}, props: {} };
        node.appendChild = (c) => { node.childNodes.push(c); return c; };
        return new Proxy(node, {
            set(t, k, v) {
                if (k === 'textContent') t.childNodes = [text(v)];
                else t.props[k] = v;
                return true;
            },
            get(t, k) {
                if (k === 'textContent') return textOf(t);
                if (k in t) return t[k];
                return t.props[k];
            }
        });
    };
    return { createElement: element, createTextNode: text };
}
const textOf = (n) => (n.nodeType === 3 ? n.textContent : n.childNodes.map(textOf).join(''));
const elementsIn = (nodes) => nodes.flatMap(n => (n.nodeType === 1 ? [n, ...elementsIn(n.childNodes)] : []));
const escapeText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s) => escapeText(s).replace(/"/g, '&quot;');
// For failure messages only: what a browser would hold, serialized.
function serialize(n) {
    if (n.nodeType === 3) return escapeText(n.textContent);
    const attrs = Object.entries(n.props).map(([k, v]) => ` ${k === 'className' ? 'class' : k}="${escapeAttr(v)}"`).join('')
        + Object.entries(n.dataset).map(([k, v]) => ` data-${k}="${escapeAttr(v)}"`).join('')
        + (Object.keys(n.style).length ? ` style="${escapeAttr(JSON.stringify(n.style))}"` : '');
    return `<${n.tagName.toLowerCase()}${attrs}>${n.childNodes.map(serialize).join('')}</${n.tagName.toLowerCase()}>`;
}

const TAGS = new Set(['P', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SPAN', 'A', 'STRONG', 'EM', 'CODE', 'INPUT', 'LABEL', 'DIV']);
const PROPS = new Set(['className', 'href', 'target', 'rel', 'title', 'type', 'checked']);
const DATA = new Set(['target', 'line']);
const STYLES = new Set(['marginLeft']);

// Everything that is wrong with a rendered tree, as strings.
function problems(nodes) {
    const out = [];
    for (const e of elementsIn(nodes)) {
        if (!TAGS.has(e.tagName)) out.push(`element <${e.tagName}>`);
        for (const k of Object.keys(e.props)) if (!PROPS.has(k)) out.push(`property ${k} on <${e.tagName}>`);
        for (const k of Object.keys(e.dataset)) if (!DATA.has(k)) out.push(`data-${k}`);
        for (const k of Object.keys(e.style)) if (!STYLES.has(k)) out.push(`style ${k}`);
        if ('href' in e.props) {
            const href = e.props.href;
            if (e.tagName !== 'A' || NM.safeHref(href) !== href || !/^https?:\/\/[^\s"'<>`]+$/.test(href)) out.push(`href ${JSON.stringify(href)}`);
        }
        if (e.tagName === 'INPUT' && e.props.type !== 'checkbox') out.push(`input type ${e.props.type}`);
    }
    return out;
}

// Notes written to break out of something.
const HOSTILE = [
    '[[https://a.com/x/onmouseover=alert`1`//]]',
    '[[x" onmouseover="alert(1)]]',
    "[[x' autofocus onfocus='alert(1)]]",
    '[[<img src=x onerror=alert(1)>]]',
    'https://a.com/"onmouseover="alert(1)',
    "https://a.com/'><img src=x onerror=alert(1)>",
    'https://a.com/`onmouseover=alert(1)`',
    '<script>alert(1)</script>',
    '**<img src=x onerror=alert(1)>** *<svg onload=alert(1)>*',
    '`<b>code</b>` and `[[x]]`',
    'javascript:alert(1) data:text/html,<script>alert(1)</script>',
    '[link](javascript:alert(1)) [y](https://ok.test/a)',
    '&lt;b&gt; &amp; &quot; already escaped stays as typed'
];

// --- 1. Tokens --------------------------------------------------------------------
console.log('\n1. Tokens');
const payload = '[[https://a.com/x/onmouseover=alert`1`//]]';
check('the reviewer\'s payload is one wikilink, its target plain text',
    eq(NM.renderInlineTokens(payload), [{ type: 'wikilink', target: 'https://a.com/x/onmouseover=alert`1`//', text: payload }]),
    JSON.stringify(NM.renderInlineTokens(payload)));
const urlOf = (s) => NM.renderInlineTokens(s).filter(t => t.type === 'url').map(t => t.href);
check('a URL stops at a double quote', eq(urlOf('https://a.com/x"onmouseover=y'), ['https://a.com/x']));
check('... at a single quote', eq(urlOf("https://a.com/x'y"), ['https://a.com/x']));
check('... at > and <', eq(urlOf('https://a.com/x>y https://b.com/z<w'), ['https://a.com/x', 'https://b.com/z']));
check('... at a backtick', eq(urlOf('https://a.com/x`y`'), ['https://a.com/x']));
check('... at whitespace and ")"', eq(urlOf('(https://a.com/x) https://b.com/y z'), ['https://a.com/x', 'https://b.com/y']));
check('nothing but http(s) is a url token', eq(urlOf('javascript:alert(1) ftp://x.test data:,x'), []));

// --- 2. safeHref ------------------------------------------------------------------
console.log('\n2. safeHref');
for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'java\tscript:alert(1)', 'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)', 'file:///C:/Windows/win.ini', 'file://server/share/x', 'blob:https://a.com/x', 'about:blank', 'chrome://settings',
    'view-source:https://a.com', '//evil.test/x', '\u0000https://a.com']) {
    check(`refuses ${JSON.stringify(bad)}`, NM.safeHref(bad) === null && PWA_NM.safeHref(bad) === null);
}
check('takes http and https, normalized', NM.safeHref('HTTPS://A.com/x y') === 'https://a.com/x%20y' && NM.safeHref('http://a.com') === 'http://a.com/');

// --- 3. Rendered DOM --------------------------------------------------------------
console.log('\n3. Rendered DOM');
const appSrc = read('pwa/app.js');
const start = appSrc.indexOf('function renderNotePreview(doc, content');
const end = appSrc.indexOf('\n}\n', start);
check('pwa/app.js has renderNotePreview(doc, content, skipTitle)', start > -1 && end > start);
const renderNotePreview = new Function('NM', `${appSrc.slice(start, end + 2)}\nreturn renderNotePreview;`)(PWA_NM);

globalThis.chrome = globalThis.chrome || {};
const { renderNoteContent } = await import('../src/app/notesView.js');

const renderers = [
    ['NM.appendInlineNodes', (doc, text) => {
        const p = doc.createElement('p');
        NM.appendInlineNodes(doc, p, NM.renderInlineTokens(text), { target: '_blank', rel: 'noopener', onclick: 'alert(1)', href: 'javascript:x' });
        return [p];
    }],
    ['the PWA note preview', (doc, text) => renderNotePreview(doc, text, '')],
    ['the extension note page', (doc, text) => renderNoteContent(text, '', doc)]
];

for (const [name, render] of renderers) {
    const allProblems = [];
    for (const line of HOSTILE) {
        // Each payload as a paragraph, a heading, a bullet and a task.
        for (const text of [line, `# ${line}`, `- ${line}`, `- [ ] ${line}`, `1. ${line}`]) {
            const nodes = render(makeDoc(), text);
            const bad = problems(nodes);
            if (bad.length) allProblems.push(`${JSON.stringify(text)}: ${bad.join(', ')} in ${nodes.map(serialize).join('')}`);
        }
    }
    check(`${name}: only safe elements, properties and links over ${HOSTILE.length * 5} hostile lines`, allProblems.length === 0,
        allProblems.slice(0, 3).join('\n      '));

    const doc = makeDoc();
    const nodes = render(doc, payload);
    const chips = elementsIn(nodes).filter(e => e.props.className === 'note-wikilink');
    check(`${name}: the payload is one chip, target as data, no link`,
        chips.length === 1 && chips[0].dataset.target === 'https://a.com/x/onmouseover=alert`1`//'
            && !elementsIn(nodes).some(e => e.tagName === 'A') && textOf({ nodeType: 1, childNodes: nodes }) === payload,
        nodes.map(serialize).join(''));

    const attr = render(makeDoc(), '[[x" onmouseover="alert(1)]] see https://ok.test/a?b=1&c=2 and javascript:alert(1)');
    const links = elementsIn(attr).filter(e => e.tagName === 'A');
    check(`${name}: quotes stay inside the target, links are http(s) only`,
        elementsIn(attr).some(e => e.dataset.target === 'x" onmouseover="alert(1)')
            && links.length === 1 && links[0].props.href === 'https://ok.test/a?b=1&c=2' && links[0].props.className === 'note-urllink',
        attr.map(serialize).join(''));

    const markup = render(makeDoc(), '<script>alert(1)</script> **<img src=x onerror=alert(1)>**');
    check(`${name}: markup in a note is text`,
        textOf({ nodeType: 1, childNodes: markup }).includes('<script>alert(1)</script>')
            && textOf({ nodeType: 1, childNodes: markup }).includes('<img src=x onerror=alert(1)>')
            && !elementsIn(markup).some(e => ['SCRIPT', 'IMG'].includes(e.tagName)),
        markup.map(serialize).join(''));
}

{
    const nodes = renderNotePreview(makeDoc(), '# Title\n- [x] done [[A]]\n  - [ ] open\n1. one\n\nplain **b** *i* `c`', 'Title');
    const tags = nodes.map(n => n.tagName).join(',');
    const boxes = elementsIn(nodes).filter(e => e.tagName === 'INPUT');
    check('PWA preview keeps its shape: title dropped, tasks with their line, lists, paragraph',
        tags === 'UL,OL,P' && boxes.length === 2 && boxes[0].dataset.line === '1' && boxes[0].props.checked === true
            && boxes[1].dataset.line === '2' && boxes[1].props.checked === false
            && elementsIn(nodes).some(e => e.tagName === 'STRONG') && elementsIn(nodes).some(e => e.tagName === 'EM')
            && elementsIn(nodes).some(e => e.tagName === 'CODE'),
        nodes.map(serialize).join(''));
}
{
    const nodes = renderNoteContent('# Title\n## Sub\n- [x] done\n- item\n\npara', 'Title', makeDoc());
    const tags = nodes.map(n => n.tagName).join(',');
    check('extension page keeps its shape: title dropped, h3 for ##, task label, list, gap, paragraph',
        tags === 'H3,LABEL,UL,DIV,P' && elementsIn(nodes).find(e => e.tagName === 'INPUT').dataset.line === '2',
        nodes.map(serialize).join(''));
}

// --- 4. The innerHTML audit of pwa/*.js --------------------------------------------
console.log('\n4. The innerHTML audit of pwa/*.js');

// A small JS scanner: every template literal, nested ones included, with the
// expressions it interpolates. Comments, strings and regex literals are
// skipped well enough for this codebase.
function skipString(s, i) {
    const q = s[i++];
    while (i < s.length && s[i] !== q) { if (s[i] === '\\') i++; i++; }
    return i + 1;
}
function regexStarts(s, i) {
    let j = i - 1;
    while (j >= 0 && /\s/.test(s[j])) j--;
    return j < 0 || /[(,=:[!&|?{};+\-*%<>~^]/.test(s[j]) || /\b(return|typeof|case)$/.test(s.slice(Math.max(0, j - 6), j + 1));
}
function skipRegex(s, i) {
    let cls = false;
    for (i++; i < s.length; i++) {
        if (s[i] === '\\') { i++; continue; }
        if (s[i] === '[') cls = true;
        else if (s[i] === ']') cls = false;
        else if (s[i] === '/' && !cls) break;
    }
    for (i++; /[a-z]/.test(s[i] || ''); i++);
    return i;
}
function readInterpolation(s, i, out, lineAt) {
    const from = i;
    let depth = 0;
    while (i < s.length) {
        const c = s[i];
        if (c === "'" || c === '"') { i = skipString(s, i); continue; }
        if (c === '`') { i = readTemplate(s, i, out, lineAt); continue; }
        if (c === '{') depth++;
        else if (c === '}') { if (depth === 0) break; depth--; }
        i++;
    }
    return { text: s.slice(from, i), end: i };
}
function readTemplate(s, i, out, lineAt) {
    const from = i;
    const parts = [];
    for (i++; i < s.length && s[i] !== '`';) {
        if (s[i] === '\\') { i += 2; continue; }
        if (s[i] === '$' && s[i + 1] === '{') {
            const e = readInterpolation(s, i + 2, out, lineAt);
            parts.push(e.text.trim());
            i = e.end + 1;
            continue;
        }
        i++;
    }
    out.push({ line: lineAt(from), raw: s.slice(from, i + 1), parts });
    return i + 1;
}
function templatesIn(s) {
    const out = [];
    const lineAt = (i) => s.slice(0, i).split('\n').length;
    for (let i = 0; i < s.length;) {
        const c = s[i];
        if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
        if (c === '/' && s[i + 1] === '*') { const j = s.indexOf('*/', i + 2); i = j === -1 ? s.length : j + 2; continue; }
        if (c === '/' && regexStarts(s, i)) { i = skipRegex(s, i); continue; }
        if (c === "'" || c === '"') { i = skipString(s, i); continue; }
        if (c === '`') { i = readTemplate(s, i, out, lineAt); continue; }
        i++;
    }
    return out;
}
// Top-level split of an expression at `sep` (a 1-2 char operator).
function splitTop(expr, seps) {
    const parts = [];
    let depth = 0;
    let from = 0;
    for (let i = 0; i < expr.length; i++) {
        const c = expr[i];
        if (c === "'" || c === '"') { i = skipString(expr, i) - 1; continue; }
        if (c === '`') { i = readTemplate(expr, i, [], () => 0) - 1; continue; }
        if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c)) depth--;
        else if (depth === 0) {
            const sep = seps.find(x => expr.startsWith(x, i));
            if (sep) { parts.push(expr.slice(from, i).trim()); from = i + sep.length; i += sep.length - 1; }
        }
    }
    parts.push(expr.slice(from).trim());
    return parts;
}
const ESCAPING_CALL = /^(escapeHtml|escapeAttr|Number|taskPillHtml|NM\.highlightHtml)\(/;
function wholeCall(expr) {
    if (!ESCAPING_CALL.test(expr) || !expr.endsWith(')')) return false;
    let depth = 0;
    for (let i = expr.indexOf('('); i < expr.length; i++) {
        if (expr[i] === "'" || expr[i] === '"') { i = skipString(expr, i) - 1; continue; }
        if (expr[i] === '(') depth++;
        else if (expr[i] === ')' && --depth === 0) return i === expr.length - 1;
    }
    return false;
}
// Safe output: an escaping call, a literal (a template's own parts are
// checked as a template), a length or small sum, either side of ?: or ||.
function safeOutput(expr, reviewed) {
    const e = expr.trim();
    if (wholeCall(e)) return true;
    if (/^(['"]).*\1$/s.test(e) || /^`[\s\S]*`$/.test(e) || /^\d+$/.test(e)) return true;
    if (/^[\w.]+\.length$/.test(e) || /^\w+ \+ \d+$/.test(e)) return true;
    const ternary = splitTop(e, ['?']);
    if (ternary.length === 2) {
        const branches = splitTop(ternary[1], [':']);
        return branches.length === 2 && branches.every(b => safeOutput(b, reviewed));
    }
    const ors = splitTop(e, ['||']);
    if (ors.length > 1) return ors.every(b => safeOutput(b, reviewed));
    if (Object.hasOwn(reviewed, e)) { reviewed[e].seen++; return true; }
    return false;
}

// Locals that go into HTML unescaped, each reviewed: what it holds and why
// that is safe, and how many times it appears. A new one, or one more use,
// fails until it is reviewed and listed here.
const REVIEWED_APP = {
    why: [1, 'renderContent: one of three fixed messages'],
    s: [1, 'renderNvSide scopes: a fixed scope id'],
    icon: [1, 'renderNvSide scopes: a fixed emoji'],
    label: [1, 'renderNvSide scopes: a fixed label'],
    n: [1, 'renderNvSide scopes: a count'],
    'tasks.done': [3, 'taskPillHtml: a count'],
    'tasks.total': [3, 'taskPillHtml: a count'],
    pct: [1, 'taskPillHtml: a rounded percentage'],
    title: [1, 'noteRowHtml: escapeHtml or NM.highlightHtml(..., escapeHtml), or "Untitled"'],
    preview: [1, 'noteRowHtml: escaped snippet parts or escapeHtml(note.preview)'],
    chips: [1, 'noteRowHtml: taskPillHtml plus an escaped path chip'],
    'b.depth': [1, 'renderNvSide tree: a depth computed from the tree'],
    id: [4, 'renderNvSide tree: escapeHtml(b.id)'],
    drag: [1, 'renderNvSide tree: a fixed draggable attribute or nothing'],
    open: [1, 'renderNvSide tree: a boolean'],
    name: [3, 'renderNvSide tree: escapeHtml(b.title)'],
    'b.totalCount': [1, 'renderNvSide tree: a count'],
    'child.totalCount': [1, 'fillNvResults: a count'],
    right: [1, 'renderNvNote: fixed buttons'],
    'o.depth': [1, 'openMoveSheet: a depth from NM.notebookOptions'],
    'o.count': [1, 'openMoveSheet: a count from NM.notebookOptions'],
    actions: [1, 'renderUsers: fixed buttons and a fixed hint']
};

for (const file of fs.readdirSync(path.join(ROOT, 'pwa')).filter(f => f.endsWith('.js'))) {
    const src = read(`pwa/${file}`);
    const reviewed = Object.fromEntries(Object.entries(file === 'app.js' ? REVIEWED_APP : {}).map(([k, [count, why]]) => [k, { count, why, seen: 0 }]));
    const html = templatesIn(src).filter(t => /<[a-z/!]/i.test(t.raw));
    const unsafe = [];
    for (const t of html) for (const p of t.parts) if (!safeOutput(p, reviewed)) unsafe.push(`${file}:${t.line} \${${p}}`);
    check(`${file}: every interpolation in its ${html.length} HTML template(s) is escaped, a number or constant, or reviewed`,
        unsafe.length === 0, unsafe.join('\n      '));
    const miscounted = Object.entries(reviewed).filter(([, r]) => r.seen !== r.count).map(([k, r]) => `${k} seen ${r.seen}, reviewed ${r.count}`);
    check(`${file}: the reviewed locals appear exactly as often as reviewed`, miscounted.length === 0, miscounted.join('; '));
    const code = src.replace(/\/\/.*$/gm, '');
    check(`${file}: no insertAdjacentHTML, outerHTML, document.write or DOMParser`,
        !/insertAdjacentHTML|outerHTML\s*=|document\.write|DOMParser|createContextualFragment|srcdoc/.test(code));
    const opens = [...code.matchAll(/window\.open\(/g)].length;
    check(`${file}: window.open only inside openExternal`, file === 'app.js'
        ? opens === 1 && /function openExternal\(url\) \{\s*const href = NM\.safeHref\(url\);\s*if \(!href\) return null;\s*return window\.open\(href, '_blank', 'noopener'\);/.test(code)
        : opens === 0, `${opens} call(s)`);
}
{
    const sinks = [...appSrc.matchAll(/\.innerHTML\s*=/g)].length;
    check(`pwa/app.js has the 31 audited innerHTML assignments (now ${sinks})`, sinks === 31,
        'a new sink needs its interpolations reviewed (section 4), then this count updated');
    check('the old string renderer and its HTML preview are gone from pwa/app.js',
        !/renderNoteInline|renderNotePreviewHtml|note-preview[^\n]*innerHTML/.test(appSrc) && !/data-target="\$\{t/.test(appSrc));
}

// --- 5. The extension's notes page ------------------------------------------------
console.log('\n5. The extension\'s notes page');
const nv = read('src/app/notesView.js');
check('no HTML-string renderer left (renderNoteInlineHtml, renderNoteEmphasis, renderNoteContentHtml)',
    !/renderNoteInlineHtml|renderNoteEmphasis|renderNoteContentHtml/.test(nv));
check('the preview is not written with innerHTML', !/notePreview'\)\.innerHTML/.test(nv) && /notePreview'\)\.replaceChildren\(/.test(nv));
check('a clicked note link is checked with safeHref before it opens', /const url = NM\.safeHref\(urlLink\.getAttribute\('href'\)\);/.test(nv));

// --- 6. Twins -----------------------------------------------------------------------
console.log('\n6. Twins');
check('src/utils/notesModel.js and pwa/notesModel.js are byte-identical',
    Buffer.compare(fs.readFileSync(path.join(ROOT, 'src/utils/notesModel.js')), fs.readFileSync(path.join(ROOT, 'pwa/notesModel.js'))) === 0);

console.log(failures === 0 ? '\nAll render-safety tests passed.\n' : `\n${failures} test(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
