// Proves the ownership migration changed nothing but ownership.
//
//   node verify_tenancy.js <sync.db.pre-v3-…> <sync.db.post-v3-…>
//   node verify_tenancy.js --digest <sync.db>
//
// Compares every table that existed before accounts were separated, row for
// row (count plus sha256 in primary-key order), between the frozen copy taken
// before the migration and the one taken right after it — never the live
// database, which clients are already pushing to. Columns the migration added
// are left out. Rows it added on purpose are left out of the post copy: the
// placeholder sources that adopted orphaned archives, and an admin created on
// that same boot, both read from the post copy's recorded tenancy_digest.
// Prints both sides and exits non-zero on any difference.
//
// --digest prints the digest the migration recorded at the time.
//
// In the container:
//   docker compose exec tabpaladin-sync node verify_tenancy.js /data/sync.db.pre-v3-… /data/sync.db.post-v3-…

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { DIGEST_TABLES, digestTables, getServerMeta } from './tenancy.js';

function recordedDigest(db) {
    const raw = getServerMeta(db, 'tenancy_digest');
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
}

// { ok, rows: [{table, pre, post, same}], problems, recorded }.
export function compareCopies(prePath, postPath) {
    const pre = new Database(prePath, { readonly: true, fileMustExist: true });
    const post = new Database(postPath, { readonly: true, fileMustExist: true });
    try {
        const recorded = recordedDigest(post);
        const problems = [];
        if (!recorded) problems.push(`${path.basename(postPath)} has no recorded tenancy digest — is it a post-migration copy?`);
        const before = digestTables(pre, DIGEST_TABLES);
        const after = digestTables(post, Object.keys(before), {
            like: before,
            exclude: {
                import_sources: new Set((recorded && recorded.orphanSourceIds) || []),
                users: new Set((recorded && recorded.bootstrappedUserIds) || [])
            }
        });
        const rows = Object.keys(before).map(table => {
            const a = before[table];
            const b = after[table] || null;
            return { table, pre: a, post: b, same: Boolean(b) && a.n === b.n && a.sha256 === b.sha256 };
        });
        for (const r of rows) if (!r.same) problems.push(`${r.table} differs`);
        return { ok: problems.length === 0, rows, problems, recorded };
    } finally {
        pre.close();
        post.close();
    }
}

function main(argv) {
    if (argv[0] === '--digest' && argv[1]) {
        const db = new Database(argv[1], { readonly: true, fileMustExist: true });
        const recorded = recordedDigest(db);
        db.close();
        if (!recorded) {
            console.error('No tenancy digest recorded in that database.');
            return 1;
        }
        console.log(JSON.stringify(recorded, (k, v) => (k === 'columns' ? undefined : v), 2));
        return 0;
    }
    if (argv.length !== 2) {
        console.error('Usage: node verify_tenancy.js <pre-v3 copy> <post-v3 copy>\n       node verify_tenancy.js --digest <db>');
        return 2;
    }
    const result = compareCopies(argv[0], argv[1]);
    const pad = (s, n) => String(s).padEnd(n);
    console.log(`${pad('table', 20)}${pad('pre rows', 10)}${pad('post rows', 11)}sha256 pre / post`);
    for (const r of result.rows) {
        console.log(`${pad(r.table, 20)}${pad(r.pre.n, 10)}${pad(r.post ? r.post.n : '-', 11)}`
            + `${r.pre.sha256.slice(0, 16)} / ${r.post ? r.post.sha256.slice(0, 16) : '-'}  ${r.same ? 'same' : 'DIFFERENT'}`);
    }
    if (result.recorded) {
        const orphans = result.recorded.orphanSourceIds || [];
        console.log(`\nRecovered removed sources (left out of import_sources): ${orphans.length ? orphans.join(', ') : 'none'}`);
    }
    if (!result.ok) {
        console.error(`\nNOT VERIFIED: ${result.problems.join('; ')}`);
        return 1;
    }
    console.log('\nVerified: every pre-existing table is unchanged apart from ownership.');
    return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exit(main(process.argv.slice(2)));
}
