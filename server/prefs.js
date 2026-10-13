// Per-account preferences shared between the extension and the PWA.
//
// A small key/value store, not settings sync: each value is one JSON document
// the clients agree on the shape of. The first consumer is 'share', the share
// sheet's choices per app ({v:1, slots:4, apps:{'x':{pinned:[folderId],
// hidden:[folderId]}}}), keyed by the app a link belongs to because a Web
// Share Target never says which app shared. How often each folder was used is
// not stored here: the server counts filings (GET /api/shares/stats).
// Values may name folder ids that were deleted or never pushed since; clients
// drop ids they do not know on read.
//
// Concurrent edits from two devices: PUT takes the updatedAt the client last
// read as baseUpdatedAt and is refused with 409 and the current value when it
// is stale, so a client can merge instead of overwriting.

const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
export const MAX_PREF_BYTES = 64 * 1024;
export const MAX_PREFS_PER_USER = 100;

export function attachPrefs(app, { db, requireAuth }) {
    const row = (userId, key) =>
        db.prepare('SELECT value, updated_at FROM user_prefs WHERE user_id = ? AND key = ?').get(userId, key);
    const shape = (r) => {
        let value = null;
        try { value = JSON.parse(r.value); } catch (e) { /* corrupt: report as null */ }
        return { value, updatedAt: r.updated_at };
    };
    const badKey = (req, res) => {
        if (KEY_RE.test(req.params.key)) return false;
        res.status(400).json({ error: 'Key: 1-64 letters, numbers, dots, dashes or underscores, starting with a letter or number.' });
        return true;
    };

    app.get('/api/prefs', requireAuth, (req, res) => {
        const prefs = {};
        for (const r of db.prepare('SELECT key, value, updated_at FROM user_prefs WHERE user_id = ? ORDER BY key').all(req.user.id)) {
            prefs[r.key] = shape(r);
        }
        res.json({ ok: true, prefs });
    });

    app.get('/api/prefs/:key', requireAuth, (req, res) => {
        if (badKey(req, res)) return;
        const r = row(req.user.id, req.params.key);
        if (!r) return res.status(404).json({ error: 'No such preference.' });
        res.json({ ok: true, key: req.params.key, ...shape(r) });
    });

    // {value, baseUpdatedAt?}. baseUpdatedAt omitted writes unconditionally;
    // null means "I believe there is none yet".
    app.put('/api/prefs/:key', requireAuth, (req, res) => {
        if (badKey(req, res)) return;
        const body = req.body || {};
        if (!('value' in body)) return res.status(400).json({ error: 'Missing value.' });
        const text = JSON.stringify(body.value);
        if (text === undefined) return res.status(400).json({ error: 'Value must be JSON.' });
        if (Buffer.byteLength(text, 'utf8') > MAX_PREF_BYTES) {
            return res.status(413).json({ error: `A preference holds at most ${MAX_PREF_BYTES / 1024} KB.` });
        }
        const key = req.params.key;
        const userId = req.user.id;
        const result = db.transaction(() => {
            const current = row(userId, key);
            if ('baseUpdatedAt' in body && (current ? current.updated_at : null) !== (body.baseUpdatedAt ?? null)) {
                return { conflict: current ? shape(current) : null };
            }
            if (!current) {
                const n = db.prepare('SELECT COUNT(*) AS n FROM user_prefs WHERE user_id = ?').get(userId).n;
                if (n >= MAX_PREFS_PER_USER) return { full: true };
            }
            // Strictly later than what it replaces, so two writes in the same
            // millisecond cannot share an updatedAt and both pass the check.
            let at = new Date();
            if (current && Date.parse(current.updated_at) >= at.getTime()) at = new Date(Date.parse(current.updated_at) + 1);
            const updatedAt = at.toISOString();
            db.prepare(`
                INSERT INTO user_prefs (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
            `).run(userId, key, text, updatedAt);
            return { updatedAt };
        })();
        if (result.full) {
            return res.status(429).json({ error: `At most ${MAX_PREFS_PER_USER} preferences per account.` });
        }
        if ('conflict' in result) {
            return res.status(409).json({ error: 'Changed on another device since you read it.', current: result.conflict });
        }
        res.json({ ok: true, key, value: body.value, updatedAt: result.updatedAt });
    });

    app.delete('/api/prefs/:key', requireAuth, (req, res) => {
        if (badKey(req, res)) return;
        const n = db.prepare('DELETE FROM user_prefs WHERE user_id = ? AND key = ?').run(req.user.id, req.params.key).changes;
        res.json({ ok: true, deleted: n > 0 });
    });
}
