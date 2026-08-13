// Auth tests against a running server.
//
//   AUTH_TOKEN=legacy DATA_DIR=/tmp/x node server/index.js
//   node tools/test_auth.mjs --url http://127.0.0.1:18999 --legacy legacy
//
// Covers the cases worth getting wrong: setup once, login, session access,
// wrong password, unknown user, no credentials, logout revoking the session,
// password change revoking every other session, and the legacy token still
// working during migration.

const arg = (n, d = null) => {
    const i = process.argv.indexOf('--' + n);
    return i === -1 ? d : process.argv[i + 1];
};

const BASE = (arg('url') || 'http://127.0.0.1:18999').replace(/\/$/, '');
const LEGACY = arg('legacy');

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

async function call(path, { method = 'GET', token, body } = {}) {
    const res = await fetch(BASE + path, {
        method,
        headers: {
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...(token ? { Authorization: 'Bearer ' + token } : {})
        },
        body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await res.json(); } catch (e) { /* empty body */ }
    return { status: res.status, json };
}

const USER = 'alex';
const PASS = 'correct horse battery';
const NEWPASS = 'staple correct horse';

// 1. Fresh server reports no account.
const status0 = await call('/api/auth/status');
check('status is public and reports no account yet',
    status0.status === 200 && status0.json.hasAccount === false,
    `hasAccount=${status0.json?.hasAccount}`);

// 2. Protected route rejects an unauthenticated caller.
const noAuth = await call('/api/pull');
check('pull without credentials is rejected', noAuth.status === 401, `HTTP ${noAuth.status}`);

// 3. Setup creates the account and returns a session.
const setup = await call('/api/auth/setup', { method: 'POST', body: { username: USER, password: PASS } });
check('setup creates the account and returns a session',
    setup.status === 200 && typeof setup.json.token === 'string' && setup.json.token.length >= 32,
    `HTTP ${setup.status}`);

// 4. Short passwords are refused.
const short = await call('/api/auth/setup', { method: 'POST', token: setup.json?.token, body: { username: USER, password: 'abc' } });
check('short password refused', short.status === 400, `HTTP ${short.status}`);

// 5. Setup is not open once an account exists.
const reSetup = await call('/api/auth/setup', { method: 'POST', body: { username: 'someone', password: 'hunter2hunter2' } });
check('setup refuses an unauthenticated second account', reSetup.status === 403, `HTTP ${reSetup.status}`);

// 6. The issued session works.
const withSession = await call('/api/pull', { token: setup.json?.token });
check('session token grants access', withSession.status === 200, `HTTP ${withSession.status}`);

// 7. Login with the right password.
const login = await call('/api/login', { method: 'POST', body: { username: USER, password: PASS } });
check('login with correct password succeeds',
    login.status === 200 && typeof login.json.token === 'string', `HTTP ${login.status}`);

// 8. Wrong password and unknown user both fail, and look the same.
const wrong = await call('/api/login', { method: 'POST', body: { username: USER, password: 'nope nope nope' } });
const unknown = await call('/api/login', { method: 'POST', body: { username: 'ghost', password: 'nope nope nope' } });
check('wrong password rejected', wrong.status === 401, `HTTP ${wrong.status}`);
check('unknown user rejected identically',
    unknown.status === wrong.status && unknown.json?.error === wrong.json?.error,
    `${unknown.status} "${unknown.json?.error}"`);

// 9. A made-up token is rejected.
const bogus = await call('/api/pull', { token: 'f'.repeat(64) });
check('invented token rejected', bogus.status === 401, `HTTP ${bogus.status}`);

// 10. Logout revokes only that session.
const other = await call('/api/login', { method: 'POST', body: { username: USER, password: PASS } });
await call('/api/logout', { method: 'POST', token: login.json?.token });
const afterLogout = await call('/api/pull', { token: login.json?.token });
const otherStillOk = await call('/api/pull', { token: other.json?.token });
check('logout revokes that session', afterLogout.status === 401, `HTTP ${afterLogout.status}`);
check('logout leaves other sessions alone', otherStillOk.status === 200, `HTTP ${otherStillOk.status}`);

// 11. Legacy token keeps working during migration.
if (LEGACY) {
    const legacy = await call('/api/pull', { token: LEGACY });
    check('legacy shared token still works', legacy.status === 200, `HTTP ${legacy.status}`);
}

// 12. Password change revokes every existing session.
const change = await call('/api/auth/password', {
    method: 'POST', token: other.json?.token,
    body: { currentPassword: PASS, newPassword: NEWPASS }
});
check('password change succeeds with the right current password', change.status === 200, `HTTP ${change.status}`);
const oldSession = await call('/api/pull', { token: other.json?.token });
check('password change revokes existing sessions', oldSession.status === 401, `HTTP ${oldSession.status}`);
const newLogin = await call('/api/login', { method: 'POST', body: { username: USER, password: NEWPASS } });
check('new password works', newLogin.status === 200, `HTTP ${newLogin.status}`);
const oldPassword = await call('/api/login', { method: 'POST', body: { username: USER, password: PASS } });
check('old password no longer works', oldPassword.status === 401, `HTTP ${oldPassword.status}`);

// --- report ---
let failed = 0;
console.log('\n--- auth ---');
for (const r of results) {
    if (!r.pass) failed++;
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `\n      ${r.detail}` : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
