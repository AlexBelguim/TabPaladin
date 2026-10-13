// Headless tests for the server's security helpers, plus the boot-time refusal
// of a weak legacy token (spawns the server, which exits before listening).
//
// What this locks down:
//   1. The published example token and short tokens are refused; an empty
//      token (legacy mode off) and a proper one are accepted.
//   2. Async scrypt hashes verify, reject wrong passwords, and still verify a
//      hash in the format the old synchronous code wrote — existing accounts
//      must keep signing in.
//   3. The rate limiter blocks after `max` failures, resets on success, and
//      lets the key back in once the window passes.
//   4. HTML escaping covers the characters that matter in text and attributes.
//   5. The server's identity key (identity.js): made once in the data
//      directory and read back the same, a signature over the nonce and the
//      server id that WebCrypto verifies, and an unreadable key file moved
//      aside (never deleted) for a new one.
//   6. A live server (on --port): the web app's files carry its CSP (script,
//      object, base, frame-ancestors and form-action enforced; connect-src
//      and img-src only reported), COOP and X-Frame-Options on its HTML;
//      every other HTML response — the /api/imports pages, Express's 404,
//      error and redirect pages — the strict script-free CSP; nosniff and
//      Referrer-Policy on every response; /api/health says app and serverId;
//      /api/identity signs the nonce, refuses a bad one, and keeps its key
//      across a restart.
//
// Run: node tools/test_security.mjs [--port 18988]

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
    authTokenProblem, hashPassword, verifyPassword, sameSecret, makeRateLimiter, escapeHtml,
    APP_CSP, APP_CSP_REPORT_ONLY, STRICT_CSP
} from '../server/security.js';
import { loadOrCreateIdentity, identityMessage, IDENTITY_FILE, NONCE_RE } from '../server/identity.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback = null) => {
    const i = process.argv.indexOf('--' + name);
    return i === -1 ? fallback : process.argv[i + 1];
};
const PORT = Number(arg('port') || 18988);

let failures = 0;
function check(name, cond, detail) {
    if (cond) {
        console.log(`  ok  ${name}`);
    } else {
        failures++;
        console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

// --- 1. Legacy token ---
console.log('legacy token');
check('published example token refused', authTokenProblem('7f3b8e2a9c5d4f1e0b9a8c7d6e5f4a3b') !== null);
check('short token refused', authTokenProblem('a'.repeat(31)) !== null);
check('empty token allowed (legacy mode off)', authTokenProblem('') === null);
check('32-char random token allowed', authTokenProblem(crypto.randomBytes(16).toString('hex')) === null);
check('64-char random token allowed', authTokenProblem(crypto.randomBytes(32).toString('hex')) === null);

function bootWith(env) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-sec-'));
    const r = spawnSync(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
        env: { ...process.env, PORT: '0', DATA_DIR: dataDir, PWA_DIR: dataDir, ...env },
        encoding: 'utf8',
        timeout: 15000
    });
    fs.rmSync(dataDir, { recursive: true, force: true });
    return r;
}

const known = bootWith({ AUTH_TOKEN: '7f3b8e2a9c5d4f1e0b9a8c7d6e5f4a3b' });
check('server refuses to boot with the published token',
    known.status === 1 && /Refusing to start/.test(known.stderr), `status ${known.status} ${known.stderr}`);
const short = bootWith({ AUTH_TOKEN: 'hunter2' });
check('server refuses to boot with a short token',
    short.status === 1 && /at least 32/.test(short.stderr), `status ${short.status} ${short.stderr}`);
const weakAdmin = bootWith({ AUTH_TOKEN: '', ADMIN_PASSWORD: 'short' });
check('server refuses to boot with a short ADMIN_PASSWORD',
    weakAdmin.status === 1 && /ADMIN_PASSWORD/.test(weakAdmin.stderr), `status ${weakAdmin.status} ${weakAdmin.stderr}`);
const noAdmin = bootWith({ AUTH_TOKEN: '', ADMIN_PASSWORD: '' });
check('server refuses to boot with no account and no ADMIN_PASSWORD',
    noAdmin.status === 1 && /ADMIN_PASSWORD/.test(noAdmin.stderr), `status ${noAdmin.status} ${noAdmin.stderr}`);

// --- 2. Passwords ---
console.log('passwords');
const h = await hashPassword('correct horse battery');
check('hash has the scrypt:salt:hex format', /^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$/.test(h), h);
check('right password verifies', await verifyPassword('correct horse battery', h));
check('wrong password fails', !(await verifyPassword('correct horse batterz', h)));
check('garbage stored hash fails without throwing', !(await verifyPassword('x', 'nonsense')));
check('truncated stored hash fails without throwing', !(await verifyPassword('x', 'scrypt:abcd:ef')));

// Exactly what the old synchronous hashPassword produced.
const salt = crypto.randomBytes(16).toString('hex');
const legacyHash = `scrypt:${salt}:${crypto.scryptSync('old password', salt, 64).toString('hex')}`;
check('hash written by the old sync code still verifies', await verifyPassword('old password', legacyHash));

check('sameSecret matches equal strings', sameSecret('abc', 'abc'));
check('sameSecret rejects different lengths', !sameSecret('abc', 'abcd'));

// --- 3. Rate limiter ---
console.log('rate limiter');
let t = 0;
const rl = makeRateLimiter({ max: 3, windowMs: 1000, now: () => t });
check('fresh key may try', rl.retryAfter('ip') === 0);
rl.fail('ip'); rl.fail('ip');
check('below max may still try', rl.retryAfter('ip') === 0);
rl.fail('ip');
check('blocked at max failures', rl.retryAfter('ip') > 0, String(rl.retryAfter('ip')));
check('other keys unaffected', rl.retryAfter('other') === 0);
t = 1001;
check('window expiry lets the key back in', rl.retryAfter('ip') === 0);
rl.fail('ip'); rl.fail('ip'); rl.reset('ip'); rl.fail('ip');
check('reset clears the count', rl.retryAfter('ip') === 0);

// --- 4. HTML ---
console.log('html');
check('escapes markup', escapeHtml('<script>alert("x")</script>') === '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
check('escapes ampersand and quote', escapeHtml(`a&b'c`) === 'a&amp;b&#39;c');

// --- 5. Identity key ---
console.log('identity key');
const b64urlBytes = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
async function verifies(publicKeyJwk, sig, message) {
    const key = await crypto.webcrypto.subtle.importKey('jwk', publicKeyJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return crypto.webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64urlBytes(sig), new TextEncoder().encode(message));
}
const quiet = { warn: (m) => warnings.push(m) };
const warnings = [];
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-identity-'));
    try {
        const first = loadOrCreateIdentity(dir, { log: quiet });
        const file = path.join(dir, IDENTITY_FILE);
        check('the first start makes a key in the data directory', first.ok && first.created && fs.existsSync(file));
        check('  the public half only is handed out', first.publicKeyJwk && !('d' in first.publicKeyJwk)
            && first.publicKeyJwk.kty === 'EC' && first.publicKeyJwk.crv === 'P-256', JSON.stringify(first.publicKeyJwk));
        const again = loadOrCreateIdentity(dir, { log: quiet });
        check('a restart reads the same key back', again.ok && !again.created && again.keyId === first.keyId
            && again.publicKeyJwk.x === first.publicKeyJwk.x);
        const nonce = crypto.randomBytes(16).toString('hex');
        const sig = again.sign(nonce, 'srv-1');
        check('the signature verifies with WebCrypto over tp-identity|1|nonce|serverId', await verifies(first.publicKeyJwk, sig, identityMessage(nonce, 'srv-1'))
            && identityMessage(nonce, 'srv-1') === `tp-identity|1|${nonce}|srv-1`);
        check('  and not over another nonce or server id', !(await verifies(first.publicKeyJwk, sig, identityMessage(nonce.replace(/^./, c => (c === 'a' ? 'b' : 'a')), 'srv-1')))
            && !(await verifies(first.publicKeyJwk, sig, identityMessage(nonce, 'srv-2'))));
        fs.writeFileSync(file, '{"kty":"EC","crv":"P-256","x":"broken"}');
        const healed = loadOrCreateIdentity(dir, { log: quiet });
        const aside = fs.readdirSync(dir).filter(f => f.startsWith(`${IDENTITY_FILE}.unreadable-`));
        check('an unreadable key file is moved aside, not deleted, and a new key made', healed.ok && healed.created && healed.keyId !== first.keyId
            && aside.length === 1 && fs.readFileSync(path.join(dir, aside[0]), 'utf8').includes('broken') && warnings.some(w => /pin it again/.test(w)));
        check('the nonce rule wants 128 bits of hex', NONCE_RE.test('0'.repeat(32)) && !NONCE_RE.test('0'.repeat(31)) && !NONCE_RE.test('G'.repeat(32))
            && !NONCE_RE.test('0'.repeat(129)));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// --- 6. A live server ---
console.log('live server: headers, health, identity');
const BASE = `http://127.0.0.1:${PORT}`;
const liveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-sec-live-'));
function startServer() {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^(AUTH_TOKEN|ADMIN_|TENANCY_OWNER|IMPORT_|MAX_)/.test(k)) delete env[k];
    const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
        env: { ...env, PORT: String(PORT), DATA_DIR: liveDir, PWA_DIR: path.join(ROOT, 'pwa'),
            ADMIN_USERNAME: 'alex', ADMIN_PASSWORD: 'correct horse battery', IMPORTS_SCHEDULER: 'off' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    const exited = new Promise(r => proc.on('exit', r));
    const ready = new Promise((resolve, reject) => {
        const onData = (d) => { log += d; if (/Server listening/.test(log)) resolve(); };
        proc.stdout.on('data', onData);
        proc.stderr.on('data', onData);
        exited.then(() => reject(new Error(`server exited: ${log}`)));
        setTimeout(() => reject(new Error(`server did not start: ${log}`)), 20000);
    });
    return { proc, ready, exited, log: () => log, stop: async () => { proc.kill(); await exited; } };
}

let server = startServer();
try {
    await server.ready;
    const get = (p, opts = {}) => fetch(BASE + p, { redirect: 'manual', ...opts });
    const csp = (r) => r.headers.get('content-security-policy');
    const ro = (r) => r.headers.get('content-security-policy-report-only');

    // The web app.
    const appFiles = ['/', '/index.html', '/app.js?v=1', '/sw.js', '/shareCore.js', '/manifest.webmanifest', '/icons/icon192.png'];
    const appRes = await Promise.all(appFiles.map(p => get(p)));
    check('every web app file is served', appRes.every(r => r.status === 200), appRes.map(r => r.status).join());
    check('  with the app\'s CSP enforced and the full policy reported', appRes.every(r => csp(r) === APP_CSP && ro(r) === APP_CSP_REPORT_ONLY),
        `${csp(appRes[0])} | ${ro(appRes[0])}`);
    const enforced = APP_CSP.split(';').map(d => d.trim().split(' ')[0]);
    check('  enforced: script-src, object-src, base-uri, frame-ancestors, form-action, and not connect-src, img-src or default-src',
        ['script-src', 'object-src', 'base-uri', 'frame-ancestors', 'form-action'].every(d => enforced.includes(d))
        && !['connect-src', 'img-src', 'default-src'].some(d => enforced.includes(d))
        && /script-src 'self'(;|$)/.test(APP_CSP) && /object-src 'none'/.test(APP_CSP) && /base-uri 'none'/.test(APP_CSP)
        && /frame-ancestors 'none'/.test(APP_CSP) && /form-action 'self'/.test(APP_CSP), APP_CSP);
    check('  reported: connect-src \'self\' and img-src limited to Google\'s favicon hosts',
        /connect-src 'self'(;|$)/.test(APP_CSP_REPORT_ONLY) && /img-src 'self' data: https:\/\/www\.google\.com https:\/\/\*\.gstatic\.com(;|$)/.test(APP_CSP_REPORT_ONLY)
        && /default-src 'self'/.test(APP_CSP_REPORT_ONLY), APP_CSP_REPORT_ONLY);
    const shell = appRes[0];
    check('the app\'s HTML gets COOP same-origin and X-Frame-Options DENY',
        shell.headers.get('cross-origin-opener-policy') === 'same-origin' && shell.headers.get('x-frame-options') === 'DENY'
        && appRes[1].headers.get('cross-origin-opener-policy') === 'same-origin');
    check('  its scripts do not (COOP is a document header)', !appRes[2].headers.get('cross-origin-opener-policy'));
    // node:http, not fetch: fetch marks a conditional request no-cache, which
    // a server rightly answers in full.
    const notModified = await new Promise((resolve, reject) => {
        http.get(BASE + '/', { headers: { 'If-None-Match': shell.headers.get('etag') } }, (res) => { res.resume(); resolve(res); }).on('error', reject);
    });
    check('  a 304 for the shell keeps the app\'s policy', notModified.statusCode === 304 && notModified.headers['content-security-policy'] === APP_CSP,
        String(notModified.statusCode));

    // Every other HTML response.
    const others = [
        ['a 404 page', await get('/no-such-page')],
        ['the Reddit callback without a code', await get('/api/imports/reddit/callback')],
        ['the Reddit callback with an error', await get('/api/imports/reddit/callback?error=%3Cscript%3E')],
        ['the Reddit callback with a dead state', await get('/api/imports/reddit/callback?code=x&state=y')],
        ['the Reddit confirm with a dead nonce', await get('/api/imports/reddit/confirm', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'nonce=x&accept=1' })],
        ['an unparseable JSON body', await get('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' })],
        ['the /share fallback redirect', await get('/share', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' }, body: 'url=https%3A%2F%2Fexample.com' })],
        ['a directory redirect', await get('/icons')]
    ];
    for (const [name, r] of others) {
        const type = r.headers.get('content-type') || '';
        check(`${name} (${r.status}, ${type.split(';')[0] || 'no type'}): the strict CSP, not the app's`,
            csp(r) === STRICT_CSP && !ro(r) && r.headers.get('x-frame-options') === 'DENY' && !r.headers.get('cross-origin-opener-policy'),
            `${csp(r)} | ${ro(r)}`);
    }
    check('  each of those really is HTML (or a redirect)', others.every(([, r]) => /text\/html/.test(r.headers.get('content-type') || '') || (r.status >= 300 && r.status < 400)),
        others.map(([n, r]) => `${n}: ${r.headers.get('content-type')}`).join('; '));
    check('STRICT_CSP allows no script, object, frame or base and only same-origin forms',
        /default-src 'none'/.test(STRICT_CSP) && !/script-src/.test(STRICT_CSP) && /frame-ancestors 'none'/.test(STRICT_CSP)
        && /base-uri 'none'/.test(STRICT_CSP) && /form-action 'self'/.test(STRICT_CSP));

    // Every response.
    const health = await get('/api/health');
    const healthJson = await health.clone().json();
    const all = [...appRes, ...others.map(([, r]) => r), health, await get('/api/tree'), await get('/llm/not-a-token'),
        await get('/api/identity?nonce=' + 'a'.repeat(32)), await get('/api/auth/status', { method: 'OPTIONS', headers: { Origin: 'chrome-extension://abc', 'Access-Control-Request-Method': 'GET' } })];
    check(`nosniff and Referrer-Policy no-referrer on every response (${all.length})`,
        all.every(r => r.headers.get('x-content-type-options') === 'nosniff' && r.headers.get('referrer-policy') === 'no-referrer'));
    check('JSON answers carry no document policy', !csp(health) && !ro(health));
    check('no X-Powered-By', all.every(r => !r.headers.get('x-powered-by')));

    // Health and identity.
    const login = await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'alex', password: 'correct horse battery' }) })).json();
    check('/api/health says app "tabpaladin" and the server id sign-in gives', healthJson.ok && healthJson.app === 'tabpaladin'
        && typeof healthJson.serverId === 'string' && healthJson.serverId === login.serverId && healthJson.version === 2 && healthJson.configured === true,
        JSON.stringify(healthJson));
    const nonce = crypto.randomBytes(16).toString('hex');
    const idRes = await get('/api/identity?nonce=' + nonce);
    const id = await idRes.json();
    check('/api/identity answers without credentials', idRes.status === 200 && id.app === 'tabpaladin' && id.serverId === healthJson.serverId
        && id.nonce === nonce && id.alg === 'ES256' && id.publicKeyJwk && !('d' in id.publicKeyJwk), JSON.stringify(id));
    check('  its signature verifies with WebCrypto over this nonce and server id',
        await verifies(id.publicKeyJwk, id.sig, `tp-identity|1|${nonce}|${id.serverId}`));
    check('  and over nothing else', !(await verifies(id.publicKeyJwk, id.sig, `tp-identity|1|${'0'.repeat(32)}|${id.serverId}`)));
    for (const bad of ['', 'abc', 'Z'.repeat(32), 'A'.repeat(32), '0'.repeat(200)]) {
        const r = await get('/api/identity' + (bad ? '?nonce=' + bad : ''));
        check(`  a bad nonce (${bad ? bad.slice(0, 8) + '…' : 'none'}) is a 400`, r.status === 400);
    }
    check('the key file is in the data directory', fs.existsSync(path.join(liveDir, IDENTITY_FILE)));

    await server.stop();
    server = startServer();
    await server.ready;
    const id2 = await (await get('/api/identity?nonce=' + nonce)).json();
    check('after a restart: the same key and server id', id2.keyId === id.keyId && id2.publicKeyJwk.x === id.publicKeyJwk.x && id2.serverId === id.serverId
        && await verifies(id.publicKeyJwk, id2.sig, `tp-identity|1|${nonce}|${id.serverId}`));
    await server.stop();

    fs.writeFileSync(path.join(liveDir, IDENTITY_FILE), 'not json');
    server = startServer();
    await server.ready;
    const id3 = await (await get('/api/identity?nonce=' + nonce)).json();
    check('a server whose key file is unreadable still starts, with a new key, and says so',
        id3.ok && id3.keyId !== id.keyId && /pin it again/.test(server.log())
        && fs.readdirSync(liveDir).some(f => f.startsWith(`${IDENTITY_FILE}.unreadable-`)), server.log());
} catch (e) {
    failures++;
    console.error(`FAIL  live server: ${e.stack || e}`);
} finally {
    await server.stop().catch(() => {});
    fs.rmSync(liveDir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nAll security tests passed.\n' : `\n${failures} test(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
