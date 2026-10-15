// Keeps the files the extension and the web app share byte-identical.
//
// The web app is served on its own and cannot import from src/, so the code
// both clients run lives twice: the canonical copy under src/utils and a copy
// under pwa/lib/. Edit the canonical one, then run this to copy it over:
//
//   node tools/sync_shared.mjs           copy every canonical file over its twin
//   node tools/sync_shared.mjs --check   change nothing; exit 1 when any differ
//
// tools/test_shared_sync.mjs fails the moment a pair differs. The pwa/lib/
// copies become the canonical ones when src/ goes.
//
// The web app runs them on its own platform (pwa/platform.js, installed as
// globalThis.__tpPlatform before they load): each picks it with the one line
// that otherwise picks the browser's extension API.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// [canonical, copy], relative to the repository root.
export const TWINS = [
    ['src/utils/notesModel.js', 'pwa/lib/notesModel.js'],
    ['src/utils/treeStore.js', 'pwa/lib/treeStore.js'],
    ['src/utils/expandState.js', 'pwa/lib/expandState.js'],
    ['src/utils/storageManager.js', 'pwa/lib/storageManager.js'],
    ['src/utils/pinsManager.js', 'pwa/lib/pinsManager.js'],
    ['src/utils/notesManager.js', 'pwa/lib/notesManager.js'],
    ['src/utils/bookmarkOrganizer.js', 'pwa/lib/bookmarkOrganizer.js'],
    ['src/utils/tabGrouper.js', 'pwa/lib/tabGrouper.js']
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
        const canonicalMissing = t.missing.includes(path.relative(ROOT, path.join(ROOT, t.canonical)));
        if (t.missing.length && (check || canonicalMissing)) {
            console.error(`missing: ${t.missing.join(', ')}`);
            differ++;
            continue;
        }
        if (t.missing.length) {
            // A new twin: made from the canonical file.
            fs.mkdirSync(path.dirname(path.join(ROOT, t.copy)), { recursive: true });
            fs.copyFileSync(path.join(ROOT, t.canonical), path.join(ROOT, t.copy));
            console.log(`  created  ${t.canonical} -> ${t.copy}`);
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
