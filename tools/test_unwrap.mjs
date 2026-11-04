// The Linkvertise redirect (src/helper/unwrap.js): a tab that lands on a
// "dynamic" link goes to the address in its ?r=, and nothing else moves.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (name, ok, detail) => { console.log((ok ? '  ok  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : ' — ' + JSON.stringify(detail))); if (!ok) failures++; };

const listeners = [];
const updates = [];
const api = { tabs: { onUpdated: { addListener: fn => listeners.push(fn) }, update: async (id, p) => { updates.push({ id, ...p }); } } };
const H = { api };
const sandbox = { TPHelper: H, URL, atob, TextDecoder, Uint8Array };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(root + '/src/helper/unwrap.js', 'utf8'), sandbox, { filename: 'src/helper/unwrap.js' });

const b64 = s => Buffer.from(s).toString('base64');
check('an /access/.../dynamic link gives its address',
    H.unwrapLink('https://linkvertise.com/access/337950/482236/dynamic?r=aHR0cHM6Ly9yZW50cnkuY28vbml6dmZ0ZWQ%3D') === 'https://rentry.co/nizvfted');
check('a fractional id and the plain /id/dynamic form work too',
    H.unwrapLink('https://linkvertise.com/access/337950/328.31574427894475/dynamic?r=aHR0cHM6Ly9yZW50cnkuY28vdmJ4dDd3cWM%3D') === 'https://rentry.co/vbxt7wqc'
    && H.unwrapLink('https://linkvertise.com/337950/dynamic?r=' + b64('https://example.com/a?b=1')) === 'https://example.com/a?b=1');
check('Linkvertise\'s other domains and www. count', H.unwrapLink('https://www.link-to.net/1/dynamic?r=' + b64('https://example.com/')) === 'https://example.com/');
check('a raw + in ?r= is still read as base64', H.unwrapLink('https://linkvertise.com/1/dynamic?r=aHR0cHM6Ly9leGFtcGxlLmNvbS8/cT0+Pj5+fn4=') === 'https://example.com/?q=%3E%3E%3E~~~');
check('UTF-8 in the address survives', H.unwrapLink('https://linkvertise.com/1/dynamic?r=' + encodeURIComponent(b64('https://example.com/ö'))) === 'https://example.com/%C3%B6');
check('only http and https destinations', H.unwrapLink('https://linkvertise.com/1/dynamic?r=' + b64('javascript:alert(1)')) === null
    && H.unwrapLink('https://linkvertise.com/1/dynamic?r=' + b64('data:text/html,hi')) === null);
check('other sites, other Linkvertise pages and junk are left alone',
    H.unwrapLink('https://example.com/1/dynamic?r=' + b64('https://evil.test/')) === null
    && H.unwrapLink('https://linkvertise.com.evil.test/1/dynamic?r=' + b64('https://evil.test/')) === null
    && H.unwrapLink('https://linkvertise.com/337950/some-name') === null
    && H.unwrapLink('https://linkvertise.com/1/dynamic?r=%%%') === null
    && H.unwrapLink('https://linkvertise.com/1/dynamic') === null
    && H.unwrapLink('not a url') === null);

const fire = (id, info, tab = {}) => listeners.forEach(fn => fn(id, info, tab));
fire(7, { url: 'https://linkvertise.com/access/337950/482236/dynamic?r=aHR0cHM6Ly9yZW50cnkuY28vbml6dmZ0ZWQ%3D' });
fire(8, { status: 'complete' });
fire(9, { url: 'https://example.com/' });
fire(10, { url: 'https://linkvertise.com/1/dynamic?r=' + b64('https://example.com/') }, { incognito: true });
await Promise.resolve();
check('the tab that landed on the link is sent on; the others are not', JSON.stringify(updates) === JSON.stringify([{ id: 7, url: 'https://rentry.co/nizvfted' }]), updates);

if (failures) { console.error(failures + ' failed'); process.exit(1); }
console.log('all passed');
