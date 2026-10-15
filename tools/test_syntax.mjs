// Every shipped script must parse the way the browser or Node loads it.
//
// The other suites lift functions out of big files by text or import only
// part of the code, so a stray quote can leave them green while the module
// the browser loads fails to parse and nothing on the page runs. That is
// exactly what a merge resolution once did to sidepanel.js. Plain
// `node --check file.js` does not catch it either: outside a package with
// "type": "module", Node checks a .js file as a classic script.
//
// Run: node tools/test_syntax.mjs

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Loaded as classic scripts: the service worker and the share core it
// imports (which the page loads with a plain <script> too), the MV2/MV3
// background script and the content script.
const CLASSIC = new Set([
    'pwa/sw.js',
    'pwa/shareCore.js',
    'src/background/background.js',
    'src/content/videoSeek.js'
]);

function listJs(dir, out = []) {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const rel = path.posix.join(dir, entry.name);
        if (entry.isDirectory()) listJs(rel, out);
        else if (/\.(m?js)$/.test(entry.name)) out.push(rel);
    }
    return out;
}

let failures = 0;
const files = ['src', 'pwa', 'server', 'tools'].flatMap(d => listJs(d));
for (const rel of files) {
    const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    let error = null;
    if (CLASSIC.has(rel) || (rel.startsWith('src/helper/') && !/\/(options|movePage)\.js$/.test(rel))) {
        try { new vm.Script(source, { filename: rel }); } catch (e) { error = e.message; }
    } else {
        const r = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: source, encoding: 'utf8' });
        if (r.status !== 0) error = (r.stderr || '').split('\n').filter(Boolean).slice(0, 4).join(' | ');
    }
    if (error) {
        failures++;
        console.error(`FAIL  ${rel} — ${error}`);
    }
}

console.log(failures === 0
    ? `\nAll ${files.length} scripts parse.\n`
    : `\n${failures} of ${files.length} script(s) failed to parse.\n`);
process.exit(failures === 0 ? 0 : 1);
