// Tests for MEGA links shown as their folder's name and size: the server's
// lookup (server/linkInfo.js) against a fake MEGA that encrypts the way the
// real one does, and the web app's link test and size labels
// (pwa/linkInfo.js).
//
// What this locks down:
//   1. Every link shape is read: /folder/H#K, /file/H#K, the old #F!H!K and
//      #!H!K, and a link that opens on a file or folder inside a folder.
//      Other sites, and keys of the wrong length, are not MEGA links.
//   2. The name decrypts with the link's key; the size and counts take in
//      everything under the folder the link opens on, however deep.
//   3. A deleted link is 'gone', a wrong key 'bad-key', a network failure
//      'failed' and asked again only after a while; MEGA's "busy" is retried.
//   4. One listing serves every link into a folder at once (MEGA refuses the
//      same folder twice at once), and answers are kept.
//   5. The route takes 1-20 links and answers only about MEGA ones.
//   6. The web app knows a MEGA link and labels sizes as MEGA does.
//
// Run: node tools/test_link_info.mjs

import crypto from 'node:crypto';
import { parseMega, lookupMega, makeLinkInfo, attachLinkInfo } from '../server/linkInfo.js';
import { isMegaLink, formatSize } from '../pwa/linkInfo.js';

let failures = 0;
function check(name, cond, detail) {
    if (cond) console.log(`  ok  ${name}`);
    else { failures++; console.error(`FAIL  ${name}${detail !== undefined ? ` — ${detail}` : ''}`); }
}

// --- A fake MEGA ---
const b64 = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const cipher = (mode, key, data, iv = null) => {
    const c = crypto.createCipheriv(mode, key, iv);
    c.setAutoPadding(false);
    return Buffer.concat([c.update(data), c.final()]);
};
const fold = (k) => k.length === 32 ? Buffer.from(k.subarray(0, 16).map((b, i) => b ^ k[16 + i])) : k;
const attrs = (name, key) => {
    const text = Buffer.from('MEGA' + JSON.stringify({ n: name }));
    const padded = Buffer.concat([text, Buffer.alloc((16 - text.length % 16) % 16)]);
    return b64(cipher('aes-128-cbc', fold(key), padded, Buffer.alloc(16)));
};
const folderKey = crypto.randomBytes(16);
const node = (h, p, t, name, s) => {
    const key = crypto.randomBytes(t === 1 ? 16 : 32);
    return { h, p, t, a: attrs(name, key), k: `owner123:${b64(cipher('aes-128-ecb', folderKey, key))}`, ...(t === 0 ? { s } : {}) };
};
const NODES = [
    node('ROOTnode', 'ownerXYZ', 1, 'Holiday photos'),
    node('file0001', 'ROOTnode', 0, 'beach.jpg', 1000),
    node('SUBfoldr', 'ROOTnode', 1, 'Day 2'),
    node('file0002', 'SUBfoldr', 0, 'sunset.jpg', 2500),
    node('DEEPfold', 'SUBfoldr', 1, 'Raw'),
    node('file0003', 'DEEPfold', 0, 'sunset.raw', 40000)
];
// A folder shared on by others carries their keys too, before the link's.
NODES[0].k = `someone1:${b64(crypto.randomBytes(32))}/someone2:${b64(crypto.randomBytes(16))}/${NODES[0].k}`;
const fileKey = crypto.randomBytes(32);
const FOLDER = `https://mega.nz/folder/PUBhandl#${b64(folderKey)}`;
const FILE = `https://mega.nz/file/FILEhndl#${b64(fileKey)}`;

function fakeMega({ busyOnce = false } = {}) {
    const calls = [];
    let busy = busyOnce;
    const fetch = async (url, opts) => {
        const u = new URL(url);
        const [cmd] = JSON.parse(opts.body);
        calls.push({ id: u.searchParams.get('id'), n: u.searchParams.get('n'), a: cmd.a });
        await new Promise(r => setTimeout(r, 5));
        if (fetch.down) throw new Error('network down');
        let answer;
        if (busy) { busy = false; answer = -3; }
        else if (cmd.a === 'f') answer = u.searchParams.get('n') === 'PUBhandl' ? { f: NODES } : -9;
        else if (cmd.a === 'g') answer = cmd.p === 'FILEhndl' ? { s: 777, at: attrs('movie.mkv', fileKey) } : -9;
        return { ok: true, status: 200, json: async () => [answer] };
    };
    fetch.calls = calls;
    return fetch;
}

console.log('\n1. Every link shape');
const shape = (url) => { const l = parseMega(url); return l && `${l.kind} ${l.handle} ${l.sub || '-'}`; };
check('a folder link', shape(FOLDER) === 'folder PUBhandl -', shape(FOLDER));
check('a file link', shape(FILE) === 'file FILEhndl -', shape(FILE));
check('a file inside a folder', shape(FOLDER + '/file/file0002') === 'folder PUBhandl file0002');
check('a folder inside a folder', shape(FOLDER + '/folder/SUBfoldr') === 'folder PUBhandl SUBfoldr');
check('the old folder style', shape(`https://mega.nz/#F!PUBhandl!${b64(folderKey)}`) === 'folder PUBhandl -');
check('the old folder style, opening inside', shape(`https://mega.nz/#F!PUBhandl!${b64(folderKey)}!SUBfoldr`) === 'folder PUBhandl SUBfoldr');
check('the old file style', shape(`https://mega.nz/#!FILEhndl!${b64(fileKey)}`) === 'file FILEhndl -');
check('mega.co.nz too', shape(FOLDER.replace('mega.nz', 'mega.co.nz')) === 'folder PUBhandl -');
check('no key: not a MEGA link to read', parseMega('https://mega.nz/folder/PUBhandl') === null);
check('a file key on a folder link is refused', parseMega(`https://mega.nz/folder/PUBhandl#${b64(fileKey)}`) === null);
check('another site is not MEGA', parseMega(FOLDER.replace('mega.nz', 'example.com')) === null);
check('nor a site that only ends like it', parseMega(FOLDER.replace('mega.nz', 'notmega.nz')) === null);
check('nor junk', parseMega('not a url') === null && parseMega('') === null);

console.log('\n2. Names and sizes');
{
    const fetch = fakeMega();
    const root = await lookupMega(parseMega(FOLDER), { fetch });
    check('the folder\'s name decrypts', root.name === 'Holiday photos', JSON.stringify(root));
    check('its size takes in every file however deep', root.size === 43500 && root.files === 3 && root.folders === 2, JSON.stringify(root));
    const sub = await lookupMega(parseMega(FOLDER + '/folder/SUBfoldr'), { fetch });
    check('a link into a folder counts that folder only', sub.name === 'Day 2' && sub.size === 42500 && sub.files === 2 && sub.folders === 1, JSON.stringify(sub));
    const inner = await lookupMega(parseMega(FOLDER + '/file/file0003'), { fetch });
    check('a link to a file in a folder is that file', inner.kind === 'file' && inner.name === 'sunset.raw' && inner.size === 40000, JSON.stringify(inner));
    const file = await lookupMega(parseMega(FILE), { fetch });
    check('a file link: its name and size', file.kind === 'file' && file.name === 'movie.mkv' && file.size === 777, JSON.stringify(file));
    const ids = fetch.calls.map(c => c.id);
    check('every request has its own id', new Set(ids).size === ids.length, ids.join(','));
}

console.log('\n3. Links that do not work');
{
    const info = makeLinkInfo({ fetch: fakeMega() });
    check('a deleted folder is gone', (await info.info(FOLDER.replace('PUBhandl', 'GONEhndl'))).error === 'gone');
    check('a deleted file is gone', (await info.info(FILE.replace('FILEhndl', 'GONEhndl'))).error === 'gone');
    check('a wrong key is bad-key', (await info.info(`https://mega.nz/folder/PUBhandl#${b64(crypto.randomBytes(16))}`)).error === 'bad-key');
    check('a missing folder inside is gone', (await info.info(FOLDER + '/folder/NOTthere')).error === 'gone');

    let clock = 0;
    const fetch = fakeMega();
    const later = makeLinkInfo({ fetch, now: () => clock });
    fetch.down = true;
    check('a network failure is failed', (await later.info(FOLDER)).error === 'failed');
    fetch.down = false;
    clock += 60 * 1000;
    check('and is not asked again at once', (await later.info(FOLDER)).error === 'failed');
    clock += 10 * 60 * 1000;
    check('but after a while', (await later.info(FOLDER)).name === 'Holiday photos');

    const busy = fakeMega({ busyOnce: true });
    check('MEGA busy: asked again', (await lookupMega(parseMega(FOLDER), { fetch: busy })).name === 'Holiday photos' && busy.calls.length === 2,
        busy.calls.length);
}

console.log('\n4. One listing for a folder at once, answers kept');
{
    const fetch = fakeMega();
    const info = makeLinkInfo({ fetch });
    const all = await Promise.all([FOLDER, FOLDER + '/folder/SUBfoldr', FOLDER + '/file/file0001', FOLDER].map(u => info.info(u)));
    check('every link answered', all[0].name === 'Holiday photos' && all[1].name === 'Day 2' && all[2].name === 'beach.jpg' && all[3].name === 'Holiday photos',
        JSON.stringify(all.map(a => a.name)));
    check('with one listing', fetch.calls.filter(c => c.a === 'f').length === 1, fetch.calls.length);
    await info.info(FOLDER);
    check('asked again: kept, MEGA not asked', fetch.calls.length === 1, fetch.calls.length);
}

console.log('\n5. The route');
{
    let handler = null;
    attachLinkInfo({ post: (path, auth, h) => { if (path === '/api/link-info') handler = h; } }, { requireAuth: () => {}, linkInfo: makeLinkInfo({ fetch: fakeMega() }) });
    const ask = async (body) => {
        const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
        await handler({ body }, res);
        return res;
    };
    check('no list: 400', (await ask({})).code === 400);
    check('an empty list: 400', (await ask({ urls: [] })).code === 400);
    check('more than 20: 400', (await ask({ urls: Array(21).fill(FOLDER) })).code === 400);
    check('not strings: 400', (await ask({ urls: [42] })).code === 400);
    const ok = await ask({ urls: [FOLDER, 'https://example.com/', FOLDER] });
    check('MEGA links answered, others left out', ok.code === 200 && ok.body.info[FOLDER].name === 'Holiday photos'
        && Object.keys(ok.body.info).length === 1, JSON.stringify(ok.body));
}

console.log('\n6. The web app');
check('a folder link is MEGA', isMegaLink(FOLDER) && isMegaLink(FILE));
check('the old styles are MEGA', isMegaLink(`https://mega.nz/#F!PUBhandl!${b64(folderKey)}`) && isMegaLink(`https://mega.nz/#!FILEhndl!${b64(fileKey)}`));
check('MEGA\'s own pages are not', !isMegaLink('https://mega.nz/') && !isMegaLink('https://mega.nz/pro'));
check('other sites are not', !isMegaLink('https://example.com/folder/PUBhandl#x') && !isMegaLink('https://notmega.nz/folder/PUBhandl#x') && !isMegaLink(null));
check('sizes', [formatSize(0), formatSize(923), formatSize(4185624), formatSize(91348633545), formatSize(2 ** 40 * 150)].join(' | ')
    === '0 B | 923 B | 4.0 MB | 85.1 GB | 150 TB', [formatSize(0), formatSize(923), formatSize(4185624), formatSize(91348633545), formatSize(2 ** 40 * 150)].join(' | '));

{
    // A "bad-key" answer an earlier release kept in the browser is asked again.
    const stored = { 'tp_link_info': JSON.stringify({ [FOLDER]: { error: 'bad-key', at: Date.now() }, [FILE]: { error: 'gone', at: Date.now() } }) };
    globalThis.localStorage = { getItem: (k) => stored[k] ?? null, setItem: (k, v) => { stored[k] = v; } };
    globalThis.document = { createElement: () => ({ textContent: '', remove() {}, classList: { add() {}, remove() {}, contains: () => false } }) };
    const asked = [];
    const { createLinkInfo } = await import('../pwa/linkInfo.js');
    const li = createLinkInfo({ request: async (urls) => { asked.push(...urls); return { info: { [FOLDER]: { kind: 'folder', name: 'Holiday photos', size: 1, files: 1, folders: 0 } } }; } });
    const anchor = { isConnected: false, nextElementSibling: null, title: '', textContent: '', after() {} };
    li.decorate(anchor, FOLDER);
    li.decorate({ ...anchor, after() {} }, FILE);
    await new Promise(r => setTimeout(r, 100));
    const keptNow = JSON.parse(stored.tp_link_info);
    check('a kept bad-key answer is asked again; a gone one is not', asked.length === 1 && asked[0] === FOLDER, asked);
    check('and the new name is kept', keptNow[FOLDER] && keptNow[FOLDER].name === 'Holiday photos' && keptNow[FILE].error === 'gone', JSON.stringify(keptNow));
    delete globalThis.localStorage;
    delete globalThis.document;
}

if (failures) { console.error(`\n${failures} link-info check(s) failed.`); process.exit(1); }
console.log('\nAll link-info tests passed.');
