// Importers — archive external saved-lists and serve them as a virtual,
// read-only subtree on every tree pull.
//
// One call from server/index.js wires up the schema, the routes and the
// scheduler, so the main file stays about the tree and nothing else.

import { initSchema, makeStore, credentialsAreEncrypted } from './store.js';
import { attachRoutes } from './routes.js';
import { startScheduler } from './runner.js';

// The schema is created by the caller (initSchema) before the ownership
// migration runs; this only wires routes and the scheduler. IMPORTS_SCHEDULER=off
// leaves the scheduler off — for a rehearsal on a copy of a real database,
// which would otherwise refresh tokens against the real Reddit account.
export function attachImports(app, { db, requireAuth, accountName, env = process.env }) {
    const store = makeStore(db);

    attachRoutes(app, { store, requireAuth, accountName });
    const schedulerOff = String(env.IMPORTS_SCHEDULER || '').toLowerCase() === 'off';
    const stop = schedulerOff ? () => {} : startScheduler(store);
    if (schedulerOff) console.log('[TabPaladin Imports] Scheduler off (IMPORTS_SCHEDULER=off).');

    if (!credentialsAreEncrypted() && store.listAllSources().length > 0) {
        console.warn('[TabPaladin Imports] IMPORT_SECRET is not set — OAuth refresh tokens are stored in plaintext in sync.db.');
    }

    return { store, stop };
}

export { makeStore, initSchema };
