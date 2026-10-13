// Account management for admins: list accounts with what they hold, add one,
// change a role or reset a password, delete one with everything it owns.
//
// Deliberately harder to reach than the rest of the API:
//   - an admin role, and a real signed-in session — not the legacy
//     AUTH_TOKEN, which scripts hold and which keeps the data access it always
//     had but no power over other accounts;
//   - every change re-checks the acting admin's own current password, counted
//     like a failed sign-in, so a stolen 180-day session alone cannot wipe an
//     account;
//   - the tenancy owner — the account holding the data from before accounts
//     were separated — cannot be deleted, demoted or reset over HTTP at all.
//     Moving that takes shell access (see the README), by design.
//
// Handlers are async (scrypt) and this is Express 4, so each catches its own
// errors. Passwords are hashed before any synchronous transaction, and every
// rule is checked again inside it — the acting admin included: requireAuth and
// requireAdmin looked before the awaits, and in between that admin may have
// been demoted, deleted or signed out.

import path from 'node:path';
import { hashPassword, verifyPassword } from './security.js';
import {
    validateUsername, validatePassword, insertUser, userById, usernameClash,
    tenancyOwnerId, legacyTokenUserId, backupNow, identify, presentedToken
} from './users.js';
import { userStats, deleteUserData } from './tenancy.js';

const ROLES = new Set(['user', 'admin']);
const PREDELETE_KEEP = 10;

export function requireAdmin(req, res, next) {
    if (req.user && req.user.role === 'admin') return next();
    res.status(403).json({ error: 'Only an admin can manage accounts.' });
}

export function requireSession(req, res, next) {
    if (req.user && req.user.via === 'session') return next();
    res.status(403).json({ error: 'Use a signed-in admin session, not AUTH_TOKEN.' });
}

// `limiter` is the sign-in limiter: { limited(req, res, username) -> bool,
// fail(req, username), ok(req, username) }.
export function attachUserAdmin(app, { db, requireAuth, dbPath, authToken, limiter }) {
    const guard = [requireAuth, requireAdmin, requireSession];
    const adminCount = () => db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
    const accountRow = (id) => db.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?').get(id);

    const describe = (u, req) => ({
        id: u.id,
        username: u.username,
        role: u.role,
        createdAt: u.created_at,
        you: u.id === req.user.id,
        owner: u.id === tenancyOwnerId(db),
        legacyToken: Boolean(authToken) && u.id === legacyTokenUserId(db),
        stats: userStats(db, u.id)
    });

    // The acting admin's own password, from body.currentPassword. Sends the
    // error response itself and returns false when it does not check out.
    async function confirmActor(req, res) {
        if (limiter.limited(req, res, req.user.username)) return false;
        const row = userById(db, req.user.id);
        const ok = row && await verifyPassword(String((req.body || {}).currentPassword || ''), row.password_hash);
        if (!ok) {
            limiter.fail(req, req.user.username);
            res.status(401).json({ error: 'Your password is wrong.', code: 'bad-password' });
            return false;
        }
        limiter.ok(req, req.user.username);
        return true;
    }

    const fail = (res, status, error, code) => res.status(status).json({ error, ...(code ? { code } : {}) });

    // Still an admin, in a live session, as the same account? Re-read from
    // the database inside each change's transaction, after every await.
    const NOT_ADMIN = [403, 'You are no longer signed in as an admin.', 'not-admin'];
    const actorStillAdmin = (req) => {
        const now = identify(db, authToken, presentedToken(req));
        return Boolean(now && now.via === 'session' && now.id === req.user.id && now.role === 'admin');
    };

    function deleteRefusal(target, req) {
        if (target.id === req.user.id) return [400, 'You cannot delete your own account.', 'self'];
        if (target.id === tenancyOwnerId(db)) {
            return [403, "The server owner can't be deleted from here — change it from the server CLI.", 'owner'];
        }
        if (target.role === 'admin' && adminCount() <= 1) return [409, 'That is the last admin.', 'last-admin'];
        if (authToken && target.id === legacyTokenUserId(db)) {
            return [409, 'AUTH_TOKEN acts as this account; remove it from .env first.', 'legacy-token'];
        }
        return null;
    }

    app.get('/api/users', ...guard, (req, res) => {
        const users = db.prepare('SELECT id, username, role, created_at FROM users ORDER BY id').all();
        res.json({ ok: true, users: users.map(u => describe(u, req)) });
    });

    // {username, password, role, currentPassword}. A new account starts with
    // an empty tree at a fresh version.
    app.post('/api/users', ...guard, async (req, res) => {
        try {
            const body = req.body || {};
            const name = validateUsername(body.username);
            if (name.error) return fail(res, 400, name.error, 'username');
            const pw = validatePassword(body.password);
            if (pw.error) return fail(res, 400, pw.error, 'password');
            const role = body.role || 'user';
            if (!ROLES.has(role)) return fail(res, 400, 'Role must be user or admin.', 'role');
            const clash = usernameClash(db, name.username);
            if (clash) {
                return fail(res, 409, clash === name.username
                    ? `"${name.username}" already exists or belonged to a deleted account.`
                    : `"${name.username}" is too close to existing "${clash}".`, 'name-clash');
            }
            if (!(await confirmActor(req, res))) return;
            const passwordHash = await hashPassword(pw.password);
            const user = db.transaction(() => (actorStillAdmin(req)
                ? insertUser(db, { username: name.username, passwordHash, role }) : null))();
            if (!user) return fail(res, ...NOT_ADMIN);
            res.json({ ok: true, user: describe(accountRow(user.id), req) });
        } catch (e) {
            if (e && e.code === 'name-clash') return fail(res, 409, e.message, 'name-clash');
            console.error('[TabPaladin] Creating an account failed:', e);
            fail(res, 500, 'Creating the account failed.');
        }
    });

    // {role?, password?, currentPassword}. A password reset signs that account
    // out everywhere. Not for your own account: your password has its own
    // route, and your role is another admin's call.
    app.put('/api/users/:id', ...guard, async (req, res) => {
        try {
            const id = Number(req.params.id);
            const body = req.body || {};
            const target = accountRow(id);
            if (!target) return fail(res, 404, 'No such account.');
            if (id === tenancyOwnerId(db)) {
                return fail(res, 403, "Server owner: change it from the owner's own Settings or the server CLI.", 'owner');
            }
            const wantsRole = body.role !== undefined;
            const wantsPassword = body.password !== undefined;
            if (!wantsRole && !wantsPassword) return fail(res, 400, 'Nothing to change.');
            if (id === req.user.id) {
                return fail(res, 400, wantsPassword ? 'Use Change password for your own account.'
                    : 'Another admin has to change your role.', 'self');
            }
            if (wantsRole && !ROLES.has(body.role)) return fail(res, 400, 'Role must be user or admin.', 'role');
            if (wantsPassword) {
                const pw = validatePassword(body.password);
                if (pw.error) return fail(res, 400, pw.error, 'password');
            }
            if (!(await confirmActor(req, res))) return;
            const hash = wantsPassword ? await hashPassword(body.password) : null;

            const result = db.transaction(() => {
                if (!actorStillAdmin(req)) return NOT_ADMIN;
                const cur = accountRow(id);
                if (!cur) return [404, 'No such account.'];
                if (id === tenancyOwnerId(db)) return [403, 'Server owner.', 'owner'];
                if (wantsRole && cur.role === 'admin' && body.role !== 'admin' && adminCount() <= 1) {
                    return [409, 'That is the last admin; make someone else an admin first.', 'last-admin'];
                }
                if (wantsRole) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(body.role, id);
                let signedOut = 0;
                if (hash) {
                    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
                    signedOut = db.prepare('DELETE FROM sessions WHERE username = ?').run(cur.username).changes;
                }
                return { signedOut };
            })();
            if (Array.isArray(result)) return fail(res, ...result);
            res.json({ ok: true, user: describe(accountRow(id), req), signedOut: result.signedOut });
        } catch (e) {
            console.error('[TabPaladin] Changing an account failed:', e);
            fail(res, 500, 'Changing the account failed.');
        }
    });

    // {confirm: '<username>', currentPassword}. POST rather than DELETE with a
    // body, which proxies may strip. In order: sign the account out (so
    // nothing new lands while the copy is taken), back up, then delete
    // everything it owns in one transaction. A failed backup deletes nothing.
    app.post('/api/users/:id/delete', ...guard, async (req, res) => {
        try {
            const id = Number(req.params.id);
            const body = req.body || {};
            const target = accountRow(id);
            if (!target) return fail(res, 404, 'No such account.');
            const refusal = deleteRefusal(target, req);
            if (refusal) return fail(res, ...refusal);
            if (String(body.confirm || '') !== target.username) {
                return fail(res, 400, `Type ${target.username} to confirm.`, 'confirm');
            }
            if (!(await confirmActor(req, res))) return;

            const signedOut = db.transaction(() => {
                if (!actorStillAdmin(req)) return NOT_ADMIN;
                const cur = accountRow(id);
                if (!cur) return [404, 'No such account.'];
                const again = deleteRefusal(cur, req);
                if (again) return again;
                return db.prepare('DELETE FROM sessions WHERE username = ?').run(cur.username).changes;
            })();
            if (Array.isArray(signedOut)) return fail(res, ...signedOut);

            let backup;
            try {
                backup = backupNow(db, dbPath, `predelete-${id}`, { keep: PREDELETE_KEEP, prunePrefix: 'predelete-' });
            } catch (e) {
                console.error(`[TabPaladin] Backup before deleting ${target.username} failed:`, e);
                return fail(res, 500, `Backup failed — ${target.username} is signed out but nothing was deleted.`, 'backup-failed');
            }
            // Nothing awaited since the checks above, but they are repeated with
            // the delete itself so no later change can slip an await between.
            const deleted = db.transaction(() => {
                if (!actorStillAdmin(req)) return NOT_ADMIN;
                const cur = accountRow(id);
                if (!cur) return [404, 'No such account.'];
                return deleteRefusal(cur, req) || deleteUserData(db, id, { deletedBy: req.user.id });
            })();
            if (Array.isArray(deleted)) return fail(res, ...deleted);
            console.log(`[TabPaladin] ${req.user.username} deleted account ${target.username} (#${id}); backup ${path.basename(backup)}.`);
            res.json({ ok: true, deleted, backup: path.basename(backup) });
        } catch (e) {
            console.error('[TabPaladin] Deleting an account failed:', e);
            fail(res, 500, 'Deleting the account failed.');
        }
    });
}
