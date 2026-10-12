// Small security helpers for the sync server, kept out of index.js so they can
// be tested without booting it (tools/test_security.mjs).

import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

// --- The legacy shared token ---
//
// This exact value was the docker-compose fallback and the README's example,
// so every deployment that never changed it shares it with everyone who has
// read the repo. Refuse it outright rather than run "authenticated" with it.
export const KNOWN_PUBLIC_TOKENS = new Set(['7f3b8e2a9c5d4f1e0b9a8c7d6e5f4a3b']);
export const MIN_TOKEN_LENGTH = 32;

// Returns a reason the token must not be used, or null when it is fine. An
// empty token is fine: it means the legacy mode is off and only logins work.
export function authTokenProblem(token) {
    if (!token) return null;
    if (KNOWN_PUBLIC_TOKENS.has(token)) {
        return 'AUTH_TOKEN is the example value published in the TabPaladin repo. Generate your own with `openssl rand -hex 32`.';
    }
    if (token.length < MIN_TOKEN_LENGTH) {
        return `AUTH_TOKEN is ${token.length} characters; it must be at least ${MIN_TOKEN_LENGTH}. Generate one with \`openssl rand -hex 32\`.`;
    }
    return null;
}

// --- Passwords ---
//
// scrypt from node:crypto rather than bcrypt/argon2, so logging in adds no
// dependency to a server whose whole point is being easy to self-host. Async,
// so a burst of login attempts can't stall every other request on the event
// loop. Hash format is unchanged from the old sync version, so existing
// accounts keep working.
const SCRYPT_KEYLEN = 64;

export async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const derived = (await scrypt(String(password), salt, SCRYPT_KEYLEN)).toString('hex');
    return `scrypt:${salt}:${derived}`;
}

export async function verifyPassword(password, stored) {
    const parts = String(stored || '').split(':');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const [, salt, expected] = parts;
    const a = await scrypt(String(password), salt, SCRYPT_KEYLEN);
    const b = Buffer.from(expected, 'hex');
    // Length check first: timingSafeEqual throws on a mismatch.
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Constant-time compare for shared secrets (legacy token, setup code), so they
// can't be guessed a character at a time by timing the response.
export function sameSecret(a, b) {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// --- Rate limiting ---
//
// In-memory, per key (the client IP), fixed window. Only failures count, so a
// user who signs in correctly is never slowed down, while a guesser gets
// `max` tries per window. A restart forgets everything, which is fine for a
// single-process personal server.
export function makeRateLimiter({ max = 10, windowMs = 15 * 60 * 1000, now = () => Date.now() } = {}) {
    const hits = new Map(); // key -> { count, resetAt }

    function entry(key) {
        const t = now();
        let e = hits.get(key);
        if (!e || e.resetAt <= t) {
            e = { count: 0, resetAt: t + windowMs };
            hits.set(key, e);
        }
        return e;
    }

    function prune() {
        const t = now();
        for (const [k, e] of hits) if (e.resetAt <= t) hits.delete(k);
    }

    return {
        // Seconds until the key may try again, or 0 if it may try now.
        retryAfter(key) {
            const e = hits.get(key);
            if (!e || e.resetAt <= now() || e.count < max) return 0;
            return Math.ceil((e.resetAt - now()) / 1000);
        },
        fail(key) {
            if (hits.size > 10000) prune();
            entry(key).count++;
        },
        reset(key) { hits.delete(key); },
        size() { return hits.size; }
    };
}

// --- HTML ---

export function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
