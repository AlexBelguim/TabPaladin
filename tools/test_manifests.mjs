// Headless test: the two extension manifests.
//
// What this locks down, for sideloaded updates to install in place without
// the browser disabling the extension or asking anything:
//   1. Both manifests carry the same version.
//   2. Private windows are off limits: "incognito": "not_allowed" in both.
//   3. The permission set is exactly 1.0.0's — nothing added that would show
//      a warning on update — and all-sites access stays optional.
//   4. Every file a manifest names exists.
//
// Run: node tools/test_manifests.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const chrome = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const firefox = JSON.parse(fs.readFileSync(path.join(ROOT, 'firefox/manifest.json'), 'utf8'));
const PERMISSIONS = ['bookmarks', 'downloads', 'scripting', 'storage', 'tabs', 'unlimitedStorage'];
const sorted = (a) => JSON.stringify([...(a || [])].sort());

check('both manifests carry the same version', chrome.version === firefox.version, `${chrome.version} / ${firefox.version}`);
check('the version is a plain x.y.z', /^\d+\.\d+\.\d+$/.test(chrome.version), chrome.version);
check('Chrome: private windows are not allowed', chrome.incognito === 'not_allowed');
check('Firefox: private windows are not allowed', firefox.incognito === 'not_allowed');
check('Chrome: only the warning-free menu permission is added to 1.0.0', sorted(chrome.permissions) === sorted([...PERMISSIONS, 'contextMenus']), sorted(chrome.permissions));
check('Firefox: only the warning-free menu permission is added to 1.0.0', sorted(firefox.permissions) === sorted([...PERMISSIONS, 'menus']), sorted(firefox.permissions));
check('Chrome: all-sites access stays optional', sorted(chrome.optional_host_permissions) === '["<all_urls>"]' && !chrome.host_permissions);
check('Firefox: all-sites access stays optional', sorted(firefox.optional_permissions) === '["<all_urls>"]');
check('P4 sideload release (the move) is 1.9.0', chrome.version === '1.9.0');
const ffScripts = firefox.background?.scripts || [];
check('Firefox loads the move after the helper modules and before the router', ffScripts.indexOf('../src/helper/move.js') > ffScripts.indexOf('../src/helper/vault.js') && ffScripts.indexOf('../src/helper/move.js') < ffScripts.indexOf('../src/helper/router.js'));
const bg = fs.readFileSync(path.join(ROOT, 'src/background/background.js'), 'utf8');
check('Chrome imports the move in the same place', bg.includes("'../helper/vault.js', '../helper/move.js', '../helper/router.js'"));
check('the setup page is available in both browsers', chrome.options_ui?.page === 'src/helper/options.html' && firefox.options_ui?.page === '../src/helper/options.html' && chrome.options_ui.open_in_tab && firefox.options_ui.open_in_tab);
check('no external extension messaging or web accessible resources', JSON.stringify(chrome.externally_connectable) === '{"ids":[]}' && !chrome.web_accessible_resources && !firefox.web_accessible_resources);
check('no static content scripts', !chrome.content_scripts && !firefox.content_scripts);
check('the Firefox id is unchanged, so updates land in place', firefox.browser_specific_settings.gecko.id === 'tabpaladin@extension');

// Every path a manifest names, relative to where it sits.
function refs(value, out = []) {
    if (typeof value === 'string' && /\.(js|html|png|json)$/.test(value)) out.push(value);
    else if (Array.isArray(value)) value.forEach(v => refs(v, out));
    else if (value && typeof value === 'object') Object.values(value).forEach(v => refs(v, out));
    return out;
}
for (const [label, manifest, dir] of [['Chrome', chrome, ROOT], ['Firefox', firefox, path.join(ROOT, 'firefox')]]) {
    const missing = refs(manifest).filter(r => !fs.existsSync(path.join(dir, r)));
    check(`${label}: every file it names exists`, missing.length === 0, missing.join(', '));
}

console.log(failures === 0 ? '\nAll manifest tests passed.\n' : `\n${failures} manifest test(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
