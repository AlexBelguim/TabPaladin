// Builds the store-ready extension packages:
//
//   dist/chrome.zip   — manifest.json (MV3) + src/ + assets icons
//   dist/firefox.zip  — firefox/manifest.json (MV2) + src/ + assets icons
//
// Each zip has its manifest at the root. firefox/manifest.json points at
// ../src and ../assets so it can sit beside the Chrome one in the repo, but
// Firefox rejects paths that leave the add-on root, so those are rewritten to
// root-relative here. Chrome, Opera and Edge all take chrome.zip.
//
// Zero dependencies: node:zlib does the deflate, the zip container is written
// by hand.
//
//   node tools/package.mjs

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

// Only the icons ship; logo.png and the SVG sources are for the README/PWA.
const ASSET_FILE = /^icon\d+\.png$/;

function walk(dir, rel = '') {
    const out = [];
    for (const ent of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
        if (ent.name.startsWith('.')) continue;
        const r = rel ? `${rel}/${ent.name}` : ent.name;
        if (ent.isDirectory()) out.push(...walk(dir, r));
        else if (ent.isFile()) out.push(r);
    }
    return out;
}

function payloadFiles() {
    const files = walk(ROOT, 'src').map(r => [r, fs.readFileSync(path.join(ROOT, r))]);
    for (const name of fs.readdirSync(path.join(ROOT, 'assets')).sort()) {
        if (ASSET_FILE.test(name)) files.push([`assets/${name}`, fs.readFileSync(path.join(ROOT, 'assets', name))]);
    }
    return files;
}

// Strip any leading ../ from every string in the manifest.
function rootRelative(value) {
    if (typeof value === 'string') return value.replace(/^(\.\.\/)+/, '');
    if (Array.isArray(value)) return value.map(rootRelative);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rootRelative(v)]));
    }
    return value;
}

// Every path a manifest names must exist in the package, or the store rejects it.
function checkReferences(manifest, files, label) {
    const have = new Set(files.map(([name]) => name));
    const refs = [];
    (function collect(v) {
        if (typeof v === 'string' && /^(src|assets)\//.test(v)) refs.push(v);
        else if (Array.isArray(v)) v.forEach(collect);
        else if (v && typeof v === 'object') Object.values(v).forEach(collect);
    })(manifest);
    const missing = refs.filter(r => !have.has(r));
    if (missing.length) throw new Error(`${label}: manifest references missing files: ${missing.join(', ')}`);
}

// ── zip writer ──────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

// Fixed timestamp (1980-01-01) so the same tree always produces the same zip.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

function zip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const [name, data] of entries) {
        const nameBuf = Buffer.from(name, 'utf8');
        const deflated = zlib.deflateRawSync(data, { level: 9 });
        const store = deflated.length >= data.length;
        const body = store ? data : deflated;
        const method = store ? 0 : 8;
        const crc = crc32(data);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);          // version needed
        local.writeUInt16LE(0x0800, 6);      // UTF-8 names
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(DOS_TIME, 10);
        local.writeUInt16LE(DOS_DATE, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);
        locals.push(local, nameBuf, body);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);        // version made by
        central.writeUInt16LE(20, 6);        // version needed
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt16LE(DOS_TIME, 12);
        central.writeUInt16LE(DOS_DATE, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(body.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt32LE(offset, 42);   // extra/comment/disk/attrs stay 0
        centrals.push(central, nameBuf);

        offset += local.length + nameBuf.length + body.length;
    }
    const centralBuf = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralBuf.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, centralBuf, end]);
}

// ── build ───────────────────────────────────────────────────────────────────

function readJson(rel) {
    return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function build(label, manifest, files) {
    checkReferences(manifest, files, label);
    const entries = [['manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n')], ...files];
    const out = path.join(DIST, `${label}.zip`);
    fs.writeFileSync(out, zip(entries));
    console.log(`${path.relative(ROOT, out)}  ${entries.length} files, ${(fs.statSync(out).size / 1024).toFixed(1)} KiB`);
}

const files = payloadFiles();
const chrome = readJson('manifest.json');
const firefox = rootRelative(readJson('firefox/manifest.json'));

if (chrome.version !== firefox.version) {
    console.warn(`warning: version mismatch — manifest.json ${chrome.version}, firefox/manifest.json ${firefox.version}`);
}

fs.mkdirSync(DIST, { recursive: true });
build('chrome', chrome, files);
build('firefox', firefox, files);
