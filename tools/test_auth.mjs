// Auth tests against a running server, started with the test account on a
// fresh data directory:
//
//   ADMIN_USERNAME=tester ADMIN_PASSWORD='correct horse battery' AUTH_MAX_FAILURES=8 IMPORTS_SCHEDULER=off \
//     MAX_PROPOSALS_PER_USER=3 [AUTH_TOKEN=<32+ char token>] PORT=18999 DATA_DIR=/tmp/x node server/index.js
//   node tools/test_auth.mjs --url http://127.0.0.1:18999 [--legacy <the same token>]
//
// Covers the cases worth getting wrong: the over-the-network setup claim being
// gone, login, session access, wrong password, unknown user, no credentials,
// logout revoking the session, password change revoking every other session,
// the legacy token acting as the data's owner, CORS for extension and foreign
// origins, body size limits, the OAuth callback escaping what it echoes;
// accounts: who may manage them and how the owner is protected, two accounts
// never reaching each other's tree, history, inbox, notes, proposals, imports
// or prefs, a reset signing an account out, and a delete removing exactly that
// account; and — last, because it locks this IP out — the login rate limit
// (expects AUTH_MAX_FAILURES <= 20).

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
    check('legacy token acts as the owner of the data', legacyMe.json?.user?.role === 'admin' && legacyMe.json.user.username === USER
        && legacyMe.json.user.tenancyOwner === true, JSON.stringify(legacyMe.json));
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

// 15. Accounts. tester is the admin and the owner of the data.
const ownerMe = await call('/api/auth/me', { token });
const OWNER_ID = ownerMe.json?.user?.id;
check('the env-created admin is the tenancy owner', ownerMe.json?.user?.tenancyOwner === true, JSON.stringify(ownerMe.json));
const users0 = await call('/api/users', { token });
check('an admin session lists accounts, marking you and the owner',
    users0.status === 200 && users0.json.users.some(u => u.username === USER && u.you && u.owner), JSON.stringify(users0.json));
if (LEGACY) {
    const viaToken = await call('/api/users', { method: 'POST', token: LEGACY, body: { username: 'tok-made', password: 'long-enough-1', currentPassword: NEWPASS } });
    check('AUTH_TOKEN cannot manage accounts (403)', viaToken.status === 403, `HTTP ${viaToken.status}`);
}
const badPw = await call('/api/users', { method: 'POST', token, body: { username: 'sam', password: 'sam-password-1', currentPassword: 'not my password' } });
check('a wrong current password is refused (401)', badPw.status === 401, `HTTP ${badPw.status}`);
const mkSam = await call('/api/users', { method: 'POST', token, body: { username: 'sam', password: 'sam-password-1', role: 'user', currentPassword: NEWPASS } });
const mkKim = await call('/api/users', { method: 'POST', token, body: { username: 'kim', password: 'kim-password-1', role: 'admin', currentPassword: NEWPASS } });
check('an admin creates accounts with their own password', mkSam.status === 200 && mkKim.status === 200 && mkSam.json.user.role === 'user',
    JSON.stringify([mkSam.json, mkKim.json]));
const SAM_ID = mkSam.json?.user?.id;
const KIM_ID = mkKim.json?.user?.id;
const clash = await call('/api/users', { method: 'POST', token, body: { username: 'Sam', password: 'sam-password-1', currentPassword: NEWPASS } });
check('"Sam" is refused next to "sam"', clash.status === 409 && /too close/.test(clash.json?.error), JSON.stringify(clash.json));
const samTok = (await call('/api/login', { method: 'POST', body: { username: 'sam', password: 'sam-password-1' } })).json?.token;
const kimTok = (await call('/api/login', { method: 'POST', body: { username: 'kim', password: 'kim-password-1' } })).json?.token;
check('a plain user gets 403 on /api/users', (await call('/api/users', { token: samTok })).status === 403);

// Isolation.
const ownerTree = await call('/api/tree', { token });
const samTree = await call('/api/tree', { token: samTok });
check('sam starts with an empty tree at a version of his own',
    samTree.status === 200 && samTree.json.roots.length === 0 && samTree.json.version !== ownerTree.json.version
    && samTree.json.userId === SAM_ID, JSON.stringify(samTree.json));
const foreign = await call('/api/tree', { method: 'PUT', token: samTok,
    body: { roots: ownerTree.json.roots, baseVersion: samTree.json.version, deviceId: 'sam' } });
check("sam pushing the owner's ids gets 412 foreign-ids", foreign.status === 412 && foreign.json.code === 'foreign-ids', JSON.stringify(foreign.json));
const wrongAcct = await call('/api/tree', { method: 'PUT', token: samTok, body: { roots: [], baseUserId: OWNER_ID, force: true } });
check("a copy stamped with the owner's id gets 412 wrong-account, even forced", wrongAcct.status === 412 && wrongAcct.json.code === 'wrong-account');
await call('/api/shared', { method: 'POST', token, body: { url: 'https://owner-inbox.example' } });
const ownerHistory = await call('/api/history', { token });
check("sam gets 404 on the owner's history entry",
    (await call(`/api/history/${ownerHistory.json.snapshots[0].id}`, { token: samTok })).status === 404);
await call('/api/shared', { method: 'DELETE', token: samTok });
check("sam clearing his inbox leaves the owner's",
    (await call('/api/shared', { token })).json.links.some(l => l.url === 'https://owner-inbox.example'));
const ownerShare = await call('/api/share', { method: 'POST', token });
const ownerLlm = ownerShare.json.url.split('/llm/')[1];
await call(`/llm/${ownerLlm}/propose`, { method: 'POST', body: { title: 'Owner secret', content: '# Owner secret\nhidden' } });
check("sam sees none of the owner's proposals", (await call('/api/proposals', { token: samTok })).json.proposals.length === 0);
const ownerProposal = (await call('/api/proposals', { token })).json.proposals.find(p => p.title === 'Owner secret');
check("sam cannot approve the owner's proposal", (await call(`/api/proposals/${ownerProposal?.id}/approve`, { method: 'POST', token: samTok })).status === 404);
await call(`/api/proposals/${ownerProposal?.id}/approve`, { method: 'POST', token });
const samShare = await call('/api/share', { method: 'POST', token: samTok });
const samLlm = samShare.json.url.split('/llm/')[1];
const samPage = await fetch(BASE + `/llm/${samLlm}`).then(r => r.text());
check("sam's LLM link lists only sam's notes", samPage.includes('Existing notes (0)') && !samPage.includes('Owner secret'));
let cap = null;
for (let i = 0; i < 260 && cap === null; i++) {
    const r = await call(`/llm/${samLlm}/propose`, { method: 'POST', body: { title: `Idea ${i}`, content: 'x' } });
    if (r.status === 429) cap = i;
}
check('proposals beyond MAX_PROPOSALS_PER_USER get 429', cap !== null && cap > 0, `cap=${cap}`);
check("the owner's proposals were not counted against sam's cap",
    (await call('/api/proposals', { token: samTok })).json.proposals.length === cap);

const ownerX = await call('/api/imports/capture', { method: 'POST', token, body: { url: 'https://x.com/owner/status/1' } });
const xId = ownerX.json?.sourceId;
for (const [method, path] of [['GET', `/api/imports/${xId}/items`], ['POST', `/api/imports/${xId}/run`],
    ['GET', `/api/imports/${xId}/authorize`], ['DELETE', `/api/imports/${xId}`], ['POST', `/api/imports/${xId}/restore`]]) {
    const r = await call(path, { method, token: samTok });
    check(`sam ${method} ${path.replace(String(xId), ':id')} on the owner's source -> 404`, r.status === 404, `HTTP ${r.status}`);
}
const samX = await call('/api/imports/capture', { method: 'POST', token: samTok, body: { url: 'https://x.com/owner/status/1' } });
check("sam's capture of the same post makes his own X source", samX.json?.captured && samX.json.sourceId !== xId && !samX.json.duplicate,
    JSON.stringify(samX.json));

// Prefs.
const pref1 = await call('/api/prefs/share.targets', { method: 'PUT', token, body: { value: { v: 1, domains: {} } } });
check('a pref is stored', pref1.status === 200 && pref1.json.updatedAt, JSON.stringify(pref1.json));
const prefGet = await call('/api/prefs/share.targets', { token });
check('and read back', prefGet.json?.value?.v === 1 && prefGet.json.updatedAt === pref1.json.updatedAt);
const stale = await call('/api/prefs/share.targets', { method: 'PUT', token, body: { value: { v: 2 }, baseUpdatedAt: '2000-01-01T00:00:00.000Z' } });
check('a stale baseUpdatedAt gets 409 with the current value', stale.status === 409 && stale.json.current?.value?.v === 1);
const fresh = await call('/api/prefs/share.targets', { method: 'PUT', token, body: { value: { v: 2 }, baseUpdatedAt: pref1.json.updatedAt } });
check('the current baseUpdatedAt is accepted', fresh.status === 200);
const tooBig = await call('/api/prefs/big', { method: 'PUT', token, body: { value: 'x'.repeat(70 * 1024) } });
check('a value over 64 KB is refused', tooBig.status === 413, `HTTP ${tooBig.status}`);
const badKey = await call('/api/prefs/' + encodeURIComponent('no spaces!'), { method: 'PUT', token, body: { value: 1 } });
check('a malformed key is refused', badKey.status === 400, `HTTP ${badKey.status}`);
check("sam cannot read the owner's prefs", (await call('/api/prefs/share.targets', { token: samTok })).status === 404
    && Object.keys((await call('/api/prefs', { token: samTok })).json.prefs).length === 0);

// Managing accounts, and protecting the owner.
const ownerBefore = JSON.stringify([(await call('/api/tree', { token })).json, (await call('/api/shared', { token })).json,
    (await call('/api/history', { token })).json, (await call('/api/prefs', { token })).json]);
const reset = await call(`/api/users/${SAM_ID}`, { method: 'PUT', token, body: { password: 'sam-password-2', currentPassword: NEWPASS } });
check('a reset signs that account out', reset.status === 200 && (await call('/api/tree', { token: samTok })).status === 401);
for (const [what, path, method, body] of [
    ['demoting', `/api/users/${OWNER_ID}`, 'PUT', { role: 'user', currentPassword: 'kim-password-1' }],
    ['resetting', `/api/users/${OWNER_ID}`, 'PUT', { password: 'taken-over-1', currentPassword: 'kim-password-1' }],
    ['deleting', `/api/users/${OWNER_ID}/delete`, 'POST', { confirm: USER, currentPassword: 'kim-password-1' }]
]) {
    const r = await call(path, { method, token: kimTok, body });
    check(`another admin ${what} the owner is refused`, r.status === 403 && r.json?.code === 'owner', JSON.stringify(r.json));
}
const selfDelete = await call(`/api/users/${KIM_ID}/delete`, { method: 'POST', token: kimTok, body: { confirm: 'kim', currentPassword: 'kim-password-1' } });
check('deleting yourself is refused', selfDelete.status === 400 && selfDelete.json?.code === 'self');
const selfReset = await call(`/api/users/${KIM_ID}`, { method: 'PUT', token: kimTok, body: { password: 'whatever-1', currentPassword: 'kim-password-1' } });
check('resetting your own password here is refused (use Change password)', selfReset.status === 400);
const wrongConfirm = await call(`/api/users/${SAM_ID}/delete`, { method: 'POST', token, body: { confirm: 'Sam', currentPassword: NEWPASS } });
check('a delete with the wrong confirmation is refused', wrongConfirm.status === 400 && wrongConfirm.json?.code === 'confirm');
const deleted = await call(`/api/users/${SAM_ID}/delete`, { method: 'POST', token, body: { confirm: 'sam', currentPassword: NEWPASS } });
check('a correct delete returns counts and a backup name',
    deleted.status === 200 && deleted.json.deleted.users === 1 && deleted.json.deleted.import_items >= 1
    && /^sync\.db\.predelete-\d+-/.test(deleted.json.backup), JSON.stringify(deleted.json));
check('the deleted account can no longer sign in',
    (await call('/api/login', { method: 'POST', body: { username: 'sam', password: 'sam-password-2' } })).status === 401);
const ownerAfter = JSON.stringify([(await call('/api/tree', { token })).json, (await call('/api/shared', { token })).json,
    (await call('/api/history', { token })).json, (await call('/api/prefs', { token })).json]);
check("the owner's data is unchanged by all of it", ownerAfter === ownerBefore);
check('a deleted name cannot be registered again',
    (await call('/api/users', { method: 'POST', token, body: { username: 'SAM', password: 'sam-password-3', currentPassword: NEWPASS } })).status === 409);

// A wrong current password counts like a failed sign-in. kim's budget only:
// limits are per IP and username, so the owner is not locked out by it.
let adminLimited = null;
for (let i = 0; i < 25 && adminLimited === null; i++) {
    const r = await call(`/api/users/${KIM_ID}`, { method: 'PUT', token: kimTok, body: { role: 'user', currentPassword: 'wrong wrong' } });
    if (r.status === 429) adminLimited = i;
}
check('wrong current passwords are rate-limited like sign-ins', adminLimited !== null, 'never limited');
check("and that does not lock out the owner", (await call('/api/users', { token })).status === 200
    && (await call('/api/login', { method: 'POST', body: { username: USER, password: NEWPASS } })).status === 200);

// 16. The OAuth callback echoes the provider's error, escaped.
const cb = await fetch(BASE + '/api/imports/reddit/callback?error=' + encodeURIComponent('<script>alert(1)</script>'));
const cbHtml = await cb.text();
check('callback error is HTML-escaped',
    !cbHtml.includes('<script>alert(1)') && cbHtml.includes('&lt;script&gt;'), cbHtml.slice(0, 200));

// 17. Rate limit — last, because it locks this client out for the window.
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
