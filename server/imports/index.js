// Importers — pull external saved-lists into the bookmark tree.
//
// One call from server/index.js wires up the schema, the routes and the
// scheduler, so the main file stays about sync and nothing else.

import { initSchema, makeStore, credentialsAreEncrypted } from './store.js';
import { attachRoutes } from './routes.js';
import { startScheduler } from './runner.js';

export function attachImports(app, { db, requireAuth, latestSnapshot, commitSnapshot }) {
    initSchema(db);
    const store = makeStore(db);

    attachRoutes(app, { store, requireAuth, latestSnapshot, commitSnapshot });
    const stop = startScheduler(store, { latestSnapshot, commitSnapshot });

    if (!credentialsAreEncrypted() && store.listSources().length > 0) {
        console.warn('[TabPaladin Imports] IMPORT_SECRET is not set — OAuth refresh tokens are stored in plaintext in sync.db.');
    }

    return { store, stop };
}

export { makeStore, initSchema };
