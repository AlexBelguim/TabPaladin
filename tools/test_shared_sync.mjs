// The files the extension and the web app share stay byte-identical (see
// tools/sync_shared.mjs, which copies the canonical one over its twin).
//
// What this locks down:
//   1. Every pair in TWINS exists and is byte-identical.
//   2. Each shared file is plain UTF-8 with LF line endings and no BOM, and
//      imports nothing but its fellow twins (the web app serves its copies
//      from pwa/lib/ on their own).
//   3. The twin of every file in TWINS is listed once, and the shared core
//      the web app runs on (treeStore.js, expandState.js, notesModel.js and
//      the managers) is in the list, under pwa/lib/.
//   4. sync_shared.mjs --check agrees, and copying restores a twin that was
//      changed by hand.
//
// Run: node tools/test_shared_sync.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { TWINS, ROOT, compareTwins } from './sync_shared.mjs';

let failures = 0;
function check(name, cond, detail) {
    if (cond) console.log(`  ok  ${name}`);
    else { failures++; console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('\n1. Every pair is byte-identical');
for (const t of compareTwins()) {
    check(`${t.copy} === ${t.canonical}`, t.same, t.missing.length ? `missing ${t.missing.join(', ')}` : 'run node tools/sync_shared.mjs');
}

console.log('\n2. Plain files that import only each other');
for (const [canonical] of TWINS) {
    const bytes = fs.readFileSync(path.join(ROOT, canonical));
    const crlf = ['src/utils/bookmarkOrganizer.js', 'src/utils/tabGrouper.js'].includes(canonical);
    const endings = crlf ? !bytes.toString('utf8').replace(/\r\n/g, '').includes('\n') : !bytes.includes(0x0d);
    check(`${canonical}: no BOM, preserved ${crlf ? 'CRLF' : 'LF'}`, bytes[0] !== 0xef && endings);
    // Only a fellow twin, by a relative path: never anything of either client's.
    const imports = [...bytes.toString('utf8').matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map(m => m[1]);
    check(`${canonical}: imports only its fellow twins`,
        imports.every(i => /^\.\/[A-Za-z]+\.js$/.test(i) && TWINS.some(([a]) => a === 'src/utils/' + i.slice(2))), imports.join(', '));
}

console.log('\n3. The list');
const copies = TWINS.map(([, c]) => c);
check('each copy is listed once', new Set(copies).size === copies.length);
for (const f of ['notesModel.js', 'treeStore.js', 'expandState.js', 'storageManager.js', 'pinsManager.js', 'notesManager.js']) {
    check(`${f} is a listed twin, under pwa/lib/`, TWINS.some(([a, b]) => a === `src/utils/${f}` && b === `pwa/lib/${f}`));
}
check('canonical copies live in src/utils, twins in pwa/lib/', TWINS.every(([a, b]) => a.startsWith('src/utils/') && b.startsWith('pwa/lib/')));
check('no older twin is left at pwa/notesModel.js', !fs.existsSync(path.join(ROOT, 'pwa', 'notesModel.js')));

console.log('\n4. The sync tool');
const script = path.join(ROOT, 'tools', 'sync_shared.mjs');
const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
check('--check passes on this checkout', run(['--check']).status === 0);
{
    // A scratch copy of the repository's twins, one of them edited by hand.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-shared-'));
    try {
        for (const [a, b] of TWINS) {
            for (const f of [a, b]) {
                fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true });
                fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
            }
        }
        const [canonical, copy] = TWINS[0];
        fs.appendFileSync(path.join(tmp, copy), '\n// edited by hand\n');
        check('a twin edited by hand is seen', compareTwins(tmp).find(t => t.copy === copy).same === false);
        fs.copyFileSync(path.join(tmp, canonical), path.join(tmp, copy));
        check('copying the canonical file over it restores the pair', compareTwins(tmp).every(t => t.same));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

console.log(failures === 0 ? '\nAll shared-file checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
