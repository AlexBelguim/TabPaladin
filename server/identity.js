// The server's signing identity: one ECDSA P-256 key pair, made on the first
// start and kept in DATA_DIR/identity.jwk.
//
// A client that pins this server (the browser helper, from its setup on)
// trusts the key, not the address: GET /api/identity?nonce=<hex> answers with
// the public key and a signature over the client's fresh nonce and this
// server's id, so whatever answers at an address can prove it is the server
// that was pinned. Nothing secret leaves here; the private key never does.
//
// The file is part of a backup. A server restored without it makes a new key
// on its next start, and every pinned client then refuses it until someone
// pins it again by hand. A file whose content is not a valid key is moved
// aside (never deleted) and a new one made, with a loud warning. A file the
// server cannot read at all (its owner or mode, a disk error) is left alone
// and no key is made: that is a fault to fix, not a reason to change identity.
// With no key, the server still runs and /api/identity answers 503.
//
// Top-level on purpose: the Dockerfile copies server/*.js and server/imports
// only, and a module in a new subdirectory would crash-loop the container.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const IDENTITY_FILE = 'identity.jwk';
export const IDENTITY_APP = 'tabpaladin';
// What the signature covers: 'tp-identity|1|' + nonce + '|' + serverId, with
// ES256 (ECDSA P-256 over SHA-256), as raw r||s, base64url — the format
// WebCrypto's verify takes.
export const IDENTITY_CONTEXT = 'tp-identity|1|';
// At least 128 bits of the client's randomness, lowercase hex.
export const NONCE_RE = /^[0-9a-f]{32,128}$/;

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function identityMessage(nonce, serverId) {
    return `${IDENTITY_CONTEXT}${nonce}|${serverId}`;
}

// RFC 7638 thumbprint of the public key: a short, stable name for it.
export function keyThumbprint(jwk) {
    const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
    return b64url(crypto.createHash('sha256').update(canonical).digest());
}

function publicPart(jwk) {
    return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
}

function validPrivateJwk(jwk) {
    if (!jwk || typeof jwk !== 'object' || jwk.kty !== 'EC' || jwk.crv !== 'P-256'
        || typeof jwk.x !== 'string' || typeof jwk.y !== 'string' || typeof jwk.d !== 'string') return null;
    try {
        const key = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d }, format: 'jwk' });
        // The public half must be the one this private key makes.
        const pub = crypto.createPublicKey(key).export({ format: 'jwk' });
        return pub.x === jwk.x && pub.y === jwk.y ? key : null;
    } catch (e) {
        return null;
    }
}

function writeNew(file) {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = privateKey.export({ format: 'jwk' });
    const record = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d, createdAt: new Date().toISOString() };
    // Written whole and then renamed into place, so a crash never leaves half
    // a key; created only where there is none, so a key is never replaced.
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    try {
        if (fs.existsSync(file)) throw new Error(`${file} appeared while a new key was being written`);
        fs.renameSync(tmp, file);
    } finally {
        if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
    }
    return record;
}

// {ok, publicKeyJwk, keyId, created, movedAside, sign(nonce, serverId)} or
// {ok: false, error}. `log` gets the warnings.
export function loadOrCreateIdentity(dataDir, { log = console } = {}) {
    const file = path.join(dataDir, IDENTITY_FILE);
    let movedAside = null;
    let created = false;
    let key = null;
    let record = null;
    try {
        let text = null;
        try {
            text = fs.readFileSync(file, 'utf8');
        } catch (e) {
            // No file: make one. A file there that cannot be read (wrong owner
            // or mode after a restore, a disk error) is not a broken key, and a
            // new identity is exactly what a pin flags: leave it where it is
            // and serve without one until someone fixes it.
            if (e.code !== 'ENOENT') {
                const uid = typeof process.getuid === 'function' ? process.getuid() : null;
                return {
                    ok: false,
                    error: `${file} is there but cannot be read (${e.code || e.message}), and was left as it is. `
                        + `Let the server's user read it${uid === null ? '' : ` (on the host: sudo chown ${uid}:${uid} <that file>)`}`
                        + ' and restart, and the server keeps its identity.'
                };
            }
        }
        if (text !== null) {
            try { record = JSON.parse(text); } catch (e) { record = null; }
            key = validPrivateJwk(record);
            if (!key) {
                movedAside = `${file}.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}`;
                fs.renameSync(file, movedAside);
                log.warn(`[TabPaladin] ${file} is not a valid key; moved it to ${movedAside} and made a new identity. `
                    + 'Clients that pinned this server must pin it again.');
            }
        }
        if (!key) {
            record = writeNew(file);
            key = validPrivateJwk(record);
            created = true;
        }
    } catch (e) {
        return { ok: false, error: e.message };
    }
    if (!key) return { ok: false, error: 'the new key could not be read back' };
    const publicKeyJwk = publicPart(record);
    return {
        ok: true,
        created,
        movedAside,
        publicKeyJwk,
        keyId: keyThumbprint(publicKeyJwk),
        sign(nonce, serverId) {
            const sig = crypto.sign('sha256', Buffer.from(identityMessage(nonce, serverId), 'utf8'), { key, dsaEncoding: 'ieee-p1363' });
            return b64url(sig);
        }
    };
}

// GET /api/identity?nonce=<hex>, unauthenticated: a client checks who answers
// before it has (or without ever sending) any credentials.
export function attachIdentity(app, { identity, serverId }) {
    app.get('/api/identity', (req, res) => {
        if (!identity || !identity.ok) {
            return res.status(503).json({ error: 'This server has no identity key right now; see its log.' });
        }
        const nonce = typeof req.query.nonce === 'string' ? req.query.nonce : '';
        if (!NONCE_RE.test(nonce)) {
            return res.status(400).json({ error: 'nonce: 32 to 128 lowercase hex characters (at least 128 random bits).' });
        }
        res.json({
            ok: true,
            app: IDENTITY_APP,
            serverId,
            alg: 'ES256',
            publicKeyJwk: identity.publicKeyJwk,
            keyId: identity.keyId,
            nonce,
            sig: identity.sign(nonce, serverId)
        });
    });
}
