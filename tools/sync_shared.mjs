// Keeps the files the extension and the web app share byte-identical.
//
// The web app is served on its own and cannot import from src/, so the code
// both clients run lives twice: the canonical copy under src/utils and a copy
// under pwa/. Edit the canonical one, then run this to copy it over:
//
//   node tools/sync_shared.mjs           copy every canonical file over its twin
//   node tools/sync_shared.mjs --check   change nothing; exit 1 when any differ
//
// tools/test_shared_sync.mjs fails the moment a pair differs. When the web
// app moves onto the shared core, the pwa/lib/ copies are added to TWINS (and
// become the canonical ones when src/ goes).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// [canonical, copy], relative to the repository root.
export const TWINS = [
    ['src/utils/notesModel.js', 'pwa/notesModel.js']
];

// Each pair as {canonical, copy, same, missing}.
export function compareTwins(root = ROOT) {
    return TWINS.map(([canonical, copy]) => {
        const a = path.join(root, canonical);
        const b = path.join(root, copy);
        const missing = [a, b].filter(p => !fs.existsSync(p)).map(p => path.relative(root, p));
        const same = !missing.length && Buffer.compare(fs.readFileSync(a), fs.readFileSync(b)) === 0;
        return { canonical, copy, same, missing };
    });
}

function main() {
    const check = process.argv.includes('--check');
    let differ = 0;
    for (const t of compareTwins()) {
        if (t.missing.length) {
            console.error(`missing: ${t.missing.join(', ')}`);
            differ++;
            continue;
        }
        if (t.same) {
            console.log(`  same     ${t.copy}`);
            continue;
        }
        if (check) {
            console.error(`  differs  ${t.copy} (from ${t.canonical})`);
            differ++;
        } else {
            fs.copyFileSync(path.join(ROOT, t.canonical), path.join(ROOT, t.copy));
            console.log(`  copied   ${t.canonical} -> ${t.copy}`);
        }
    }
    process.exit(differ ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
