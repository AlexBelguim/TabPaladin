// A page of the web app, as a test starts it: modules of its own.
//
// The app is a tree of ES modules (pwa/app.js, pwa/platform.js, the shared
// core in pwa/lib/), and the shared core keeps the working copy in module
// state, as a page does. A test that starts the app afresh — the phone's OS
// closed it, a share reloaded it — imports pwa/app.js again with a query of
// its own (app.js?start=3); this passes that query on to every module of the
// app that page imports, so it gets a TreeStore, a platform and the rest of
// its own, with nothing in memory from the page before, as a new page does.
// A module a test imports by itself (no query) is shared, as before.
//
// Usage: import './fresh_page.mjs' before the first import of pwa/app.js;
// closePage() before starting the next page: the page before is gone, and
// hears, reads and writes nothing more (its platform is closed).

import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PWA = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'pwa')).href + '/';

registerHooks({
    resolve(specifier, context, nextResolve) {
        const r = nextResolve(specifier, context);
        const parent = context && context.parentURL;
        if (parent && parent.startsWith(PWA) && r && r.url && r.url.startsWith(PWA) && !r.url.includes('?')) {
            const q = new URL(parent).search;
            if (q) return { ...r, url: r.url + q };
        }
        return r;
    }
});

// The page before goes: what a closed tab does.
export function closePage() {
    const p = globalThis.__tpPlatform;
    if (p && typeof p.close === 'function') p.close();
}
