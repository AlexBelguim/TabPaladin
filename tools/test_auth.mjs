// Auth tests against a running server, started with the test account:
//
//   ADMIN_USERNAME=tester ADMIN_PASSWORD='correct horse battery' AUTH_MAX_FAILURES=8 //     PORT=18999 DATA_DIR=/tmp/x node server/index.js
//   node tools/test_auth.mjs --url http://127.0.0.1:18999 [--legacy <32+ char token>]
//
// Covers the cases worth getting wrong: the over-the-network setup claim being
// gone, login, session access, wrong password, unknown user, no credentials,
// logout revoking the session, password change revoking every other session,
// the legacy token acting as the admin, CORS for extension and foreign
// origins, body size limits, the OAuth callback escaping what it echoes, and
// — last, because it locks this IP out — the login rate limit (expects
// AUTH_MAX_FAILURES <= 20).

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

const USER = 'tester';
const PASS = 'correct horse battery';
const NEWPASS = 'staple correct horse';

// 1. Status is public and reports the env-created account.
const status0 = await call('/api/auth/status');
check('status is public and reports the account',
    status0.status === 200 && status0.json.hasAccount === true, `hasAccount=${status0.json?.hasAccount}`);

// 2. Protected route rejects an unauthenticated caller.
const noAuth = await call('/api/tree');
check('pull without credentials is rejected', noAuth.status === 401, `HTTP ${noAuth.status}`);

// 3. Nobody can create or replace an account over the network any more.
const claim = await call('/api/auth/setup', { method: 'POST', body: { username: 'squatter', password: 'squatter-pass' } });
check('setup claim is gone', claim.status === 410, `HTTP ${claim.status}`);
const stillOurs = await call('/api/login', { method: 'POST', body: { username: USER, password: PASS } });
check('env-created account signs in', stillOurs.status === 200 && stillOurs.json?.user?.role === 'admin',
    `HTTP ${stillOurs.status} ${JSON.stringify(stillOurs.json?.user)}`);
const setup = stillOurs; // the session the rest of the run starts from

// 4. Who am I.
const me = await call('/api/auth/me', { token: setup.json?.token });
check('/api/auth/me returns id, username and role',
    me.status === 200 && me.json?.user?.username === USER && me.json.user.role === 'admin' && Number.isInteger(me.json.user.id),
    JSON.stringify(me.json));

// 6. The issued session works.
const withSession = await call('/api/tree', { token: setup.json?.token });
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
const bogus = await call('/api/tree', { token: 'f'.repeat(64) });
check('invented token rejected', bogus.status === 401, `HTTP ${bogus.status}`);

// 10. Logout revokes only that session.
const other = await call('/api/login', { method: 'POST', body: { username: USER, password: PASS } });
await call('/api/logout', { method: 'POST', token: login.json?.token });
const afterLogout = await call('/api/tree', { token: login.json?.token });
const otherStillOk = await call('/api/tree', { token: other.json?.token });
check('logout revokes that session', afterLogout.status === 401, `HTTP ${afterLogout.status}`);
check('logout leaves other sessions alone', otherStillOk.status === 200, `HTTP ${otherStillOk.status}`);

// 11. Legacy token keeps working during migration.
if (LEGACY) {
    const legacy = await call('/api/tree', { token: LEGACY });
    check('legacy shared token still works', legacy.status === 200, `HTTP ${legacy.status}`);
    const legacyMe = await call('/api/auth/me', { token: LEGACY });
    check('legacy token acts as the first admin', legacyMe.json?.user?.role === 'admin' && legacyMe.json.user.username === USER,
        JSON.stringify(legacyMe.json));
}

// 12. Password change revokes every existing session.
const change = await call('/api/auth/password', {
    method: 'POST', token: other.json?.token,
    body: { currentPassword: PASS, newPassword: NEWPASS }
});
check('password change succeeds with the right current password', change.status === 200, `HTTP ${change.status}`);
const oldSession = await call('/api/tree', { token: other.json?.token });
check('password change revokes existing sessions', oldSession.status === 401, `HTTP ${oldSession.status}`);
const newLogin = await call('/api/login', { method: 'POST', body: { username: USER, password: NEWPASS } });
check('new password works', newLogin.status === 200, `HTTP ${newLogin.status}`);
const oldPassword = await call('/api/login', { method: 'POST', body: { username: USER, password: PASS } });
check('old password no longer works', oldPassword.status === 401, `HTTP ${oldPassword.status}`);

// 13. CORS: extensions and same-origin yes, other sites no.
async function preflight(origin) {
    const r = await fetch(BASE + '/api/tree', {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'authorization,content-type' }
    });
    return r.headers.get('access-control-allow-origin');
}
check('chrome extension origin allowed', await preflight('chrome-extension://abcdefghijklmnop') === 'chrome-extension://abcdefghijklmnop');
check('firefox extension origin allowed', await preflight('moz-extension://1234-abcd') === 'moz-extension://1234-abcd');
check('same origin allowed', await preflight(BASE) === BASE);
check('foreign website refused', !(await preflight('https://evil.example')));
const token = newLogin.json?.token;

// 14. Body limits: small everywhere, large only for a tree push.
const big = 'x'.repeat(2 * 1024 * 1024);
const bigShare = await call('/api/shared', { method: 'POST', token, body: { url: 'https://example.com', title: big } });
check('2 MB body refused outside PUT /api/tree', bigShare.status === 413, `HTTP ${bigShare.status}`);
const ver = await call('/api/tree/version', { token });
const tree = await call('/api/tree', { token });
const bigPush = await call('/api/tree', {
    method: 'PUT', token,
    body: { roots: tree.json?.roots || [], baseVersion: ver.json?.version, deviceId: 'pad'.padEnd(64, 'x'), padding: big }
});
check('2 MB tree push accepted', bigPush.status === 200, `HTTP ${bigPush.status} ${JSON.stringify(bigPush.json)}`);

// 15. The OAuth callback echoes the provider's error, escaped.
const cb = await fetch(BASE + '/api/imports/reddit/callback?error=' + encodeURIComponent('<script>alert(1)</script>'));
const cbHtml = await cb.text();
check('callback error is HTML-escaped',
    !cbHtml.includes('<script>alert(1)') && cbHtml.includes('&lt;script&gt;'), cbHtml.slice(0, 200));

// 16. Rate limit — last, because it locks this client out for the window.
let limited = null;
for (let i = 0; i < 25 && !limited; i++) {
    const r = await call('/api/login', { method: 'POST', body: { username: USER, password: 'wrong wrong wrong' } });
    if (r.status === 429) limited = i;
}
check('repeated failed logins get 429', limited !== null, 'never limited');
const lockedOut = await call('/api/login', { method: 'POST', body: { username: USER, password: PASS } });
check('the right password is also refused while limited', lockedOut.status === 429, `HTTP ${lockedOut.status}`);

// --- report ---
let failed = 0;
console.log('\n--- auth ---');
for (const r of results) {
    if (!r.pass) failed++;
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `\n      ${r.detail}` : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
