// 'Download a backup': everything this browser's TabPaladin holds, as one
// JSON file, with its secrets left out.
//
// The file holds every key in the extension's storage — the working copy and
// its unpushed edits, set-aside copies, the removal queue, note drafts (live,
// parked and mirrored), focused folders, keywords and every other setting —
// plus this origin's localStorage (notes preferences and parked drafts). It
// is what a later version's 'Bring in an extension backup' reads, and a way
// back from a mistake: nothing here is ever deleted by making one.
//
// Secrets never go in: the sync session token (and any field named like a
// token, password, secret or API key) is replaced by null and listed under
// `redacted`. Signing in again is the way back to a session.

export const BACKUP_FORMAT = 'tabpaladin-extension-backup';
export const BACKUP_VERSION = 1;

// Field names that hold a secret, wherever they appear.
const SECRET_FIELD = /^(token|accesstoken|refreshtoken|sessiontoken|authtoken|password|secret|clientsecret|apikey|geminiapikey)$/i;
// Maps whose keys are the user's own words (keyword categories), not field
// names: never searched for secrets, so a category called "Token" is kept.
const USER_KEYED = new Set(['customKeywords']);

function redact(value, at, redacted) {
    if (Array.isArray(value)) return value.map((v, i) => redact(v, `${at}[${i}]`, redacted));
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        const here = `${at}.${k}`;
        if (SECRET_FIELD.test(k) && v !== null && v !== undefined && v !== '') {
            out[k] = null;
            redacted.push(here);
        } else if (USER_KEYED.has(k)) {
            out[k] = v;
        } else {
            out[k] = redact(v, here, redacted);
        }
    }
    return out;
}

function countNodes(roots) {
    let n = 0;
    const walk = (node) => {
        if (!node || node.virtual) return;
        n++;
        (node.children || []).forEach(walk);
    };
    (Array.isArray(roots) ? roots : []).forEach(walk);
    return n;
}

function parsed(raw) {
    try { return JSON.parse(raw); } catch (e) { return raw; }
}

// The backup of `storage` (everything storage.local holds) and `local`
// (localStorage, as {key: string}), as a plain object.
export function buildBackup({ storage = {}, local = {}, extension = {}, now = new Date() } = {}) {
    const redacted = [];
    const safeStorage = redact(storage, 'storage', redacted);
    const localValues = {};
    for (const [k, raw] of Object.entries(local || {})) localValues[k] = parsed(raw);
    const safeLocal = redact(localValues, 'localStorage', redacted);

    const tree = storage.tpTree || {};
    const stashKeys = Object.keys(storage).filter(k => k.startsWith('tpTreeStash:'));
    const parkedList = Array.isArray(localValues.tp_notes_parked_v1) ? localValues.tp_notes_parked_v1 : [];
    const mirror = storage.tpParkedMirror && Array.isArray(storage.tpParkedMirror.drafts) ? storage.tpParkedMirror.drafts : [];
    const live = storage.tpLiveDraft && typeof storage.tpLiveDraft === 'object' ? Object.keys(storage.tpLiveDraft) : [];
    return {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exportedAt: now.toISOString(),
        extension: { name: extension.name || 'TabPaladin', version: extension.version || null },
        secrets: 'redacted',
        redacted,
        summary: {
            workingCopy: {
                owner: tree.owner ? { url: tree.owner.url || null, userId: tree.owner.userId, username: tree.owner.username || null } : null,
                origin: tree.owner ? null : tree.origin || null,
                items: countNodes(tree.roots),
                unpushedEdits: tree.dirty ? Math.max(1, Number(tree.editCount) || 0) : 0,
                baseVersion: Number(tree.baseVersion) || 0
            },
            setAsideCopies: stashKeys.length,
            parkedDrafts: Math.max(parkedList.length, mirror.length),
            liveDrafts: live.length,
            queuedRemovals: Array.isArray(storage.tpPendingRemovals) ? storage.tpPendingRemovals.length : 0
        },
        storage: safeStorage,
        localStorage: safeLocal
    };
}

export function backupFileName(now = new Date()) {
    const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
    return `tabpaladin-backup-${stamp}.json`;
}

// Read everything and build the backup. `api` is the extension API,
// `localStorage` this page's.
export async function collectBackup({ api, localStorage = null, now = new Date() } = {}) {
    const storage = (await api.storage.local.get(null)) || {};
    const local = {};
    try {
        if (localStorage) {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k !== null) local[k] = localStorage.getItem(k);
            }
        }
    } catch (e) { /* localStorage blocked: the extension storage is the bulk of it */ }
    let extension = {};
    try {
        const m = api.runtime.getManifest();
        extension = { name: m.name, version: m.version };
    } catch (e) { /* not in an extension page */ }
    return buildBackup({ storage, local, extension, now });
}

// Make the backup and hand it to the browser as a download. `prepare` writes
// what the page still holds only in memory first (the working copy's
// debounce, the open note's unsaved text). Resolves with the backup.
export async function downloadBackup({ api, prepare = null } = {}) {
    if (prepare) {
        try { await prepare(); } catch (e) { /* back up what is written */ }
    }
    let ls = null;
    try { ls = globalThis.localStorage; } catch (e) { ls = null; }
    const now = new Date();
    const backup = await collectBackup({ api, localStorage: ls, now });
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = backupFileName(now);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    return backup;
}
