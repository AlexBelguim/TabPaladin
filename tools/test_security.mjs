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
//
// Run: node tools/test_security.mjs

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
    authTokenProblem, hashPassword, verifyPassword, sameSecret, makeRateLimiter, escapeHtml
} from '../server/security.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

console.log(failures === 0 ? '\nAll security tests passed.\n' : `\n${failures} test(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
