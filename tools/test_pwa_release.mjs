// The PWA's release ritual, checked: every version number agrees, and the
// worker caches every file the app needs offline.
//
// A release bumps the shell version in several places at once — the ?v=
// queries in index.html, SHELL_CACHE and the SHELL entries in sw.js, and the
// importScripts that loads shareCore.js into the worker. Miss one and the
// phone keeps serving the old bundle from cache while the desktop looks fixed,
// or the worker runs one version of the share core and the page another.
//
// What this locks down:
//   1. index.html's ?v= values, SHELL_CACHE, every versioned SHELL entry and
//      the importScripts version are one number.
//   2. Everything index.html loads, and every module app.js imports, is in
//      SHELL (so the app starts offline), and every SHELL entry is a file.
//
// Run: node tools/test_pwa_release.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PWA = path.join(__dirname, '..', 'pwa');
const read = (f) => fs.readFileSync(path.join(PWA, f), 'utf8');

let failures = 0;
function check(name, cond, detail) {
    if (cond) console.log(`  ok  ${name}`);
    else { failures++; console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const html = read('index.html');
const sw = read('sw.js');
const app = read('app.js');

const htmlRefs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1]).filter(r => !/^(https?:|data:|#)/.test(r));
const htmlVersions = [...html.matchAll(/\?v=(\d+)/g)].map(m => Number(m[1]));
const cacheVersion = Number((sw.match(/const SHELL_CACHE = 'tp-shell-v(\d+)'/) || [])[1]);
const shellBlock = (sw.match(/const SHELL = \[([\s\S]*?)\];/) || [])[1] || '';
const shell = [...shellBlock.matchAll(/'([^']+)'/g)].map(m => m[1]);
const shellVersions = shell.map(s => s.match(/\?v=(\d+)$/)).filter(Boolean).map(m => Number(m[1]));
const imported = [...sw.matchAll(/importScripts\(([^)]*)\)/g)].flatMap(m => [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]));
const importVersions = imported.map(s => s.match(/\?v=(\d+)$/)).filter(Boolean).map(m => Number(m[1]));

console.log('\n1. One version everywhere');
check('SHELL_CACHE names a version', Number.isInteger(cacheVersion) && cacheVersion > 0, String(cacheVersion));
check(`index.html's ?v= values are all ${cacheVersion}`, htmlVersions.length >= 3 && htmlVersions.every(v => v === cacheVersion), JSON.stringify(htmlVersions));
check(`every versioned SHELL entry is ${cacheVersion}`, shellVersions.length >= 3 && shellVersions.every(v => v === cacheVersion), JSON.stringify(shellVersions));
check(`importScripts loads ${cacheVersion}`, imported.length >= 1 && importVersions.length === imported.length && importVersions.every(v => v === cacheVersion),
    JSON.stringify(imported));

console.log('\n2. The shell holds what the app needs offline');
const asShell = (ref) => '/' + ref.replace(/^\.?\//, '');
const missing = htmlRefs.map(asShell).filter(r => !shell.includes(r));
check('everything index.html loads is in SHELL, with the same ?v=', missing.length === 0, missing.join(', '));
check('the worker imports what the page loads: the same shareCore.js', imported.every(i => htmlRefs.includes(i)), JSON.stringify([imported, htmlRefs]));
const modules = new Set();
const walkImports = (file) => {
    const src = read(file);
    for (const m of src.matchAll(/^\s*import\s+(?:[^'"]+\s+from\s+)?['"](\.\/[^'"]+)['"]/gm)) {
        const f = m[1].replace(/^\.\//, '');
        if (!modules.has(f)) { modules.add(f); walkImports(f); }
    }
};
walkImports('app.js');
const unshelled = [...modules].filter(f => !shell.includes('/' + f));
check(`every module app.js imports is in SHELL (${[...modules].join(', ')})`, modules.size >= 3 && unshelled.length === 0, unshelled.join(', '));
const absent = shell.filter(s => s !== '/' && !fs.existsSync(path.join(PWA, s.replace(/^\//, '').replace(/\?.*$/, ''))));
check('every SHELL entry is a file in pwa/', absent.length === 0, absent.join(', '));
check('index.html loads shareCore.js before app.js', html.indexOf('shareCore.js') > -1 && html.indexOf('shareCore.js') < html.indexOf('app.js'));

console.log(failures === 0 ? '\nAll PWA release checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exitCode = failures === 0 ? 0 : 1;
