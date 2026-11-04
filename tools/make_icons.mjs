// The installed app's icons, pwa/icons/app192.png and app512.png, drawn from assets/logo-tile.svg by Chrome. Run it
// after changing that file:
//   node tools/make_icons.mjs
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].find((p) => p && existsSync(p));
if (!CHROME) throw new Error('No Chrome found: set CHROME to one');

const svg = readFileSync(join(ROOT, 'assets', 'logo-tile.svg'), 'utf8').replace('<svg ', '<svg width="512" height="512" ');
const tmp = mkdtempSync(join(tmpdir(), 'tabpaladin-icons-'));
try {
  const page = join(tmp, 'logo-tile.svg');
  writeFileSync(page, svg);
  for (const size of [192, 512]) {
    const out = join(ROOT, 'pwa', 'icons', `app${size}.png`);
    // Chrome won't make a window much under 500 wide, and lays it out a little wider than asked: the icon drawn
    // 512 wide in the corner, the screenshot of the window's first 512 scaled down to the size
    execFileSync(CHROME, ['--headless', '--disable-gpu', '--hide-scrollbars', '--default-background-color=00000000',
      '--window-size=512,512', `--force-device-scale-factor=${size / 512}`, `--screenshot=${out}`,
      pathToFileURL(page).href], { stdio: 'ignore' });
    console.log(`app${size}.png`, statSync(out).size, 'bytes');
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
