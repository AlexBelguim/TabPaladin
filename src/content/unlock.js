/**
 * Link lockers: Linkvertise and Lootlabs
 * On a Linkvertise or Lootlabs link page, a TabPaladin page covers the
 * locker from its first moment, does the locker's steps inside the page
 * itself (its own cookies and connection, which is what the locker's servers
 * accept) and opens the destination. It says what it is doing and, when it
 * cannot finish, why, with the page underneath one click away.
 *
 * The steps themselves run in the page's own world, in
 * src/content/unlockPage.js; this side draws TabPaladin's page, hands that
 * script the link and a secret, and shows what it reports.
 *
 * Registered at runtime by the helper (src/helper/unwrap.js), only while
 * "Skip link lockers" is on in its Settings. It reads no extension storage
 * and sends nothing to the extension; the only servers it talks to are the
 * locker's own, from the page.
 */

(function () {
    'use strict';

    const LINKVERTISE = ['linkvertise.com', 'link-to.net', 'up-to-down.net', 'direct-link.net', 'link-center.net', 'link-hub.net', 'link-target.net', 'file-link.net'];
    const LOOTLABS = ['speedy-links.com', 'loot-link.com', 'loot-links.com', 'lootlink.org', 'lootlinks.co', 'lootdest.org', 'lootdest.com', 'lootdest.info', 'links-loot.com', 'linksloot.net', 'best-links.org'];
    const onHost = (host, list) => list.some(h => host === h || host.endsWith('.' + h));

    // Which locker a page is and, for Linkvertise, the link it names:
    // /access/<user>/<link>, /<user>/<link> or /<user>/<link>/1. Dynamic links
    // carry their address and are sent on by the helper before this matters.
    function classify(href) {
        let u;
        try { u = new URL(href); } catch (_) { return null; }
        if (u.protocol !== 'https:') return null;
        if (onHost(u.hostname, LINKVERTISE)) {
            const parts = u.pathname.split('/').filter(Boolean);
            if (parts[0] === 'access') parts.shift();
            if (parts[2] === '1') parts.pop();
            if (parts.length !== 2 || !/^\d{1,12}$/.test(parts[0]) || parts[1] === 'dynamic') return null;
            let url;
            try { url = decodeURIComponent(parts[1]); } catch (_) { return null; }
            return { site: 'linkvertise', userId: parts[0], url };
        }
        if (onHost(u.hostname, LOOTLABS)) {
            return u.pathname === '/s' && u.search.length > 1 ? { site: 'lootlabs' } : null;
        }
        return null;
    }

    const safeUrl = (raw) => {
        try {
            const u = new URL(String(raw).trim());
            return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
        } catch (_) { return null; }
    };

    // Lootlabs sends the destination as base64 whose first five characters
    // are an XOR key for the rest, which is then URI-encoded.
    function decodeLoot(payload) {
        let raw;
        try { raw = atob(String(payload).trim()); } catch (_) { return null; }
        if (raw.length <= 5) return null;
        const key = raw.slice(0, 5);
        let out = '';
        for (let i = 5; i < raw.length; i++) out += String.fromCharCode(raw.charCodeAt(i) ^ key.charCodeAt((i - 5) % 5));
        try { return safeUrl(decodeURIComponent(out)); } catch (_) { return null; }
    }

    if (typeof document === 'undefined') {
        globalThis.TPUnlock = { classify, decodeLoot, safeUrl, LINKVERTISE, LOOTLABS };
        return;
    }
    if (window.top !== window || window.__tpUnlock) return;
    window.__tpUnlock = true;
    const link = classify(location.href);
    if (!link) return;

    const SITE = link.site === 'linkvertise' ? 'Linkvertise' : 'Lootlabs';
    const LIMIT = link.site === 'linkvertise' ? 4 * 60000 : 5 * 60000;
    const REASONS = {
        'lv-error': ['Linkvertise refused a step.', 'It may have changed how its pages work, or flagged this visit. Show the page to do it by hand.'],
        'lv-premium': ['This link is for Linkvertise Premium members only.', 'There is nothing to skip without a Premium account.'],
        'lv-stuck': ['Linkvertise did not hand out the link after its steps.', 'Show the page to see what it still wants.'],
        'lv-unknown': ['Linkvertise asked for a step TabPaladin does not know.', 'Show the page to do it by hand.'],
        'loot-error': ['Something on the Lootlabs page went wrong.', 'Try again, or show the page.'],
        'loot-no-tasks': ['The Lootlabs task list did not load.', 'The page may have failed to load or changed. Try again, or show the page.'],
        'loot-no-start': ['Lootlabs ignored the automatic task clicks.', 'Show the page and click the tasks yourself. Their offer tabs stay closed, and TabPaladin opens the link when it arrives.'],
        'loot-bad-link': ['Lootlabs sent a link TabPaladin could not read.', 'Show the page and use its Unlock button.'],
        'timeout': ['The locker did not finish in time.', link.site === 'lootlabs'
            ? 'A task may need doing by hand, such as "Confirm you are human". Show the page to finish it: TabPaladin keeps listening and opens the link when it arrives.'
            : 'Try again, or show the page.'],
        'bad-destination': ['The destination is not a web address.', 'Show the page to see it.'],
        'blocked': ['TabPaladin\'s script did not start in the page.', 'Try again. If it keeps happening, this browser may be too old for it (Firefox needs version 128 or later). Show the page to do it by hand.']
    };

    // The covering page, in a closed shadow root so the locker's styles and
    // scripts leave it alone, and in the browser's top layer (a popover) so
    // nothing the page stacks can cover it. Without popovers (Firefox before
    // 125) it is the last element at the highest z-index instead.
    const host = document.createElement('tp-unlock');
    host.setAttribute('style', 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;display:block!important');
    const topLayer = typeof host.showPopover === 'function';
    if (topLayer) host.setAttribute('popover', 'manual');
    let hidden = false;
    const raise = () => {
        if (hidden) return;
        const html = document.documentElement;
        if (!html) return;
        if (!host.isConnected || (!topLayer && html.lastElementChild !== host)) html.appendChild(host);
        if (topLayer && !host.matches(':popover-open')) { try { host.showPopover(); } catch (_) { /* not yet in a document */ } }
    };

    // The tab's icon while TabPaladin has the page, also once it is shown:
    // TabPaladin's shield, saying what is going on. The page's own icons are
    // switched off for as long as this page is open.
    const SHIELD = 'M24 2 L44 9 V25 C44 36.5 35 43.5 24 46.5 C13 43.5 4 36.5 4 25 V9 Z';
    const ICONS = {
        working: ['#60a5fa', '#8b5cf6', '<path d="M13.5 15.5l8.5 8.5-8.5 8.5M24.5 15.5l8.5 8.5-8.5 8.5" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>'],
        needs: ['#fbbf24', '#f59e0b', '<circle cx="24" cy="17" r="5.5" fill="#fff"/><path d="M13.5 35.5c0-6.6 4.7-10 10.5-10s10.5 3.4 10.5 10z" fill="#fff"/>'],
        failed: ['#f87171', '#dc2626', '<rect x="21.5" y="11" width="5" height="16.5" rx="2.5" fill="#fff"/><circle cx="24" cy="33.5" r="3.2" fill="#fff"/>']
    };
    const favicon = document.createElement('link');
    favicon.rel = 'icon';
    favicon.type = 'image/svg+xml';
    const setIcon = (kind) => {
        const [from, to, glyph] = ICONS[kind];
        favicon.href = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'
            + `<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><path d="${SHIELD}" fill="url(#g)"/>${glyph}</svg>`);
    };
    setIcon('working');
    // Browsers read icons from the head, which a page only has once parsing starts.
    const keepIcon = () => {
        const head = document.head;
        if (!head) return;
        for (const l of head.querySelectorAll('link[rel~="icon" i]')) if (l !== favicon) l.rel = 'tp-unlock-page-icon';
        if (favicon.parentNode !== head || head.lastElementChild !== favicon) head.appendChild(favicon);
    };
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
:host{color-scheme:dark}
*{box-sizing:border-box}
.wrap{position:fixed;inset:0;overflow:auto;background:#10151d;color:#e5eaf0;font:16px/1.55 system-ui,sans-serif;display:flex;align-items:flex-start;justify-content:center;padding:12vh 16px 40px}
.card{width:100%;max-width:560px;background:#19222e;border:1px solid #2c394a;border-radius:14px;padding:24px}
.brand{display:flex;justify-content:space-between;color:#aebac8;font-size:13px;letter-spacing:.04em;text-transform:uppercase}
h1{font-size:22px;margin:6px 0 2px}
.sub{color:#aebac8;margin:0 0 16px;overflow-wrap:anywhere;font-size:14px}
.bar{height:4px;border-radius:2px;background:#2c394a;overflow:hidden;margin-bottom:16px}
.fill{height:100%;width:30%;background:#63baa8;border-radius:2px;animation:slide 1.4s ease-in-out infinite}
.bar.known .fill{animation:none;transition:width .4s}
.bar.failed .fill{animation:none;width:100%;background:#d9776f}
@keyframes slide{0%{margin-left:-30%}100%{margin-left:100%}}
ol{list-style:none;margin:0;padding:0}
li{display:flex;gap:10px;padding:6px 0;color:#aebac8}
li.active{color:#e5eaf0}
li .icon{flex:none;width:18px;text-align:center}
li.active .icon::before{content:'';display:inline-block;width:12px;height:12px;border:2px solid #63baa8;border-top-color:transparent;border-radius:50%;animation:spin .8s linear infinite}
li.ok .icon::before{content:'\\2713';color:#63baa8}
li.bad .icon::before{content:'\\2715';color:#d9776f}
li small{display:block;color:#aebac8;font-size:13px}
@keyframes spin{to{transform:rotate(360deg)}}
.result{margin-top:16px;padding:12px 16px;border-left:3px solid #d9776f;background:#10151d;border-radius:4px}
.result.paste{border-left-color:#63baa8}
.result.needs{border-left-color:#e0b25b}
.result b{display:block}
.result p{margin:4px 0 0;color:#aebac8}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.5 ui-monospace,monospace;max-height:320px;overflow:auto;margin:8px 0 0;color:#e5eaf0}
a{color:#8dc6ff;overflow-wrap:anywhere}
.actions{margin-top:18px}
button{background:#314a68;color:#fff;border:1px solid #54769b;border-radius:7px;padding:9px 14px;font:inherit;font-size:15px;cursor:pointer;margin:4px 6px 4px 0}
button:hover{background:#405f83}
button.primary{background:#1c6b60;border-color:#2d8f81}
details{margin-top:14px;color:#aebac8;font-size:13px}
summary{cursor:pointer}
.foot{margin:18px 0 0;color:#7d8a99;font-size:13px}
[hidden]{display:none!important}
@media (prefers-reduced-motion:reduce){.fill,li.active .icon::before{animation:none}}
</style>
<div class="wrap" role="dialog" aria-labelledby="t">
<div class="card">
<div class="brand"><span>TabPaladin</span><span id="clock">0:00</span></div>
<h1 id="t"></h1>
<p class="sub" id="where"></p>
<div class="bar" id="bar"><div class="fill" id="fill"></div></div>
<ol id="steps" aria-live="polite"></ol>
<div class="result" id="result" hidden><b id="why"></b><p id="next"></p><pre id="paste" hidden></pre></div>
<div class="actions"><button id="copyPaste" class="primary" hidden>Copy text</button><button id="retry" hidden>Try again</button><button id="show">Show the page</button><button id="copy" hidden>Copy details</button></div>
<details id="more"><summary>Details</summary><pre id="log"></pre></details>
<p class="foot">Turn this off in the TabPaladin helper's Settings, under Link lockers.</p>
</div></div>`;
    const $ = (id) => root.getElementById(id);
    $('t').textContent = 'Skipping the ' + SITE + ' page';
    $('where').textContent = location.hostname + location.pathname.slice(0, 80) + (location.pathname.length > 80 ? '\u2026' : '');
    raise();
    keepIcon();
    // Kept on top until it is put away, also after a failure or once done;
    // the tab's icon is kept the whole time.
    setInterval(() => { raise(); keepIcon(); }, 500);
    document.addEventListener('DOMContentLoaded', () => { raise(); keepIcon(); });

    // State: working, then failed (a link may still arrive), then done
    // (opening the link, or showing a paste).
    const started = Date.now();
    const log = [];
    let state = 'working', alive = false, deadline = started + LIMIT, waitTimer = null, current = null;
    const note = (text) => {
        log.push(((Date.now() - started) / 1000).toFixed(1).padStart(6) + ' s  ' + text);
        $('log').textContent = log.join('\n');
    };
    const clock = setInterval(() => {
        const s = Math.floor((Date.now() - started) / 1000);
        $('clock').textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
        if (!alive && Date.now() - started > 5000) fail('blocked');
        else if (Date.now() > deadline) fail('timeout');
    }, 1000);
    const step = (text, sub) => {
        if (current) {
            current.className = 'ok';
            if (waitTimer) current.querySelector('small').textContent = '';
        }
        clearInterval(waitTimer);
        waitTimer = null;
        current = document.createElement('li');
        current.className = 'active';
        current.innerHTML = '<span class="icon"></span><span><span class="text"></span><small></small></span>';
        current.querySelector('.text').textContent = text;
        if (sub) current.querySelector('small').textContent = sub;
        $('steps').appendChild(current);
        note(text);
    };
    const subtext = (text) => { if (current) current.querySelector('small').textContent = text; };
    const progress = (fraction) => { $('bar').classList.add('known'); $('fill').style.width = Math.round(Math.max(.04, fraction) * 100) + '%'; };
    const stop = () => { clearInterval(clock); clearInterval(waitTimer); };
    // A later failure replaces an earlier one's reason; nothing replaces done.
    function fail(reason, detail) {
        if (state === 'done') return;
        state = 'failed';
        setIcon('failed');
        stop();
        if (current) current.className = 'bad';
        $('bar').classList.add('failed');
        const [why, next] = REASONS[reason] || REASONS['lv-error'];
        $('why').textContent = 'Couldn\'t skip this page. ' + why;
        $('next').textContent = next;
        $('result').className = 'result';
        $('result').hidden = false;
        $('retry').hidden = false;
        $('copy').hidden = false;
        note('Failed: ' + reason + (detail ? ' (' + detail + ')' : ''));
        if (detail) $('more').open = true;
    }
    const finish = () => {
        state = 'done';
        setIcon('working');
        stop();
        if (current) current.className = 'ok';
        $('bar').classList.remove('failed');
        progress(1);
        $('retry').hidden = true;
    };
    function go(raw) {
        if (state === 'done') return;
        const url = safeUrl(raw);
        if (!url) { fail('bad-destination', String(raw).slice(0, 200)); return; }
        finish();
        $('result').hidden = true;
        note('Destination: ' + url);
        step('Opening ' + new URL(url).hostname);
        // A download, or anything else that leaves this page in place.
        setTimeout(() => {
            const a = document.createElement('a');
            a.href = url;
            a.rel = 'noreferrer';
            a.textContent = url;
            $('result').className = 'result paste';
            $('why').textContent = 'If nothing opened, here is the link:';
            $('next').replaceChildren(a);
            $('result').hidden = false;
        }, 4000);
        location.replace(url);
    }
    function showPaste(text) {
        if (state === 'done') return;
        finish();
        $('t').textContent = 'The ' + SITE + ' link is a text';
        $('result').className = 'result paste';
        $('why').textContent = 'Here it is:';
        $('next').textContent = '';
        $('paste').textContent = text;
        $('paste').hidden = false;
        $('result').hidden = false;
        $('copyPaste').hidden = false;
        note('Got a paste of ' + text.length + ' characters');
    }

    // The page's script reports through events named with this secret, which
    // the page never sees: it is handed over before any page script runs.
    const secret = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
    // The work goes on underneath: a link that still arrives is opened.
    const showPage = () => {
        if (hidden) return;
        hidden = true;
        if (topLayer) { try { host.hidePopover(); } catch (_) { /* already hidden */ } }
        host.style.setProperty('display', 'none', 'important');
        document.dispatchEvent(new CustomEvent('tp-unlock-in-' + secret, { detail: 'shown' }));
        note('Page shown');
    };
    $('show').addEventListener('click', showPage);
    $('retry').addEventListener('click', () => location.reload());
    const copy = (text) => {
        const done = () => note('Copied');
        try { navigator.clipboard.writeText(text).then(done, () => select(text)); } catch (_) { select(text); }
    };
    const select = () => { $('more').open = true; const r = document.createRange(); r.selectNodeContents($('log')); const s = root.getSelection ? root.getSelection() : getSelection(); s.removeAllRanges(); s.addRange(r); };
    $('copy').addEventListener('click', () => copy(['TabPaladin link locker: ' + SITE, location.hostname + location.pathname, ...log].join('\n')));
    $('copyPaste').addEventListener('click', () => { try { navigator.clipboard.writeText($('paste').textContent).then(() => { $('copyPaste').textContent = 'Copied'; }); } catch (_) { /* select it by hand */ } });

    document.addEventListener('tp-unlock-' + secret, (e) => {
        let m;
        try { m = JSON.parse(String(e.detail)); } catch (_) { return; }
        if (!m || typeof m !== 'object') return;
        alive = true;
        if (m.type === 'log') { note(String(m.text)); return; }
        // These still count after a failure or a timeout: the locker may
        // have been finished by hand on the page, or just took longer.
        if (m.type === 'loot-link') {
            const url = decodeLoot(m.payload);
            note('Link received');
            if (url) go(url); else fail('loot-bad-link');
            return;
        }
        if (m.type === 'done') { go(m.url); return; }
        if (m.type === 'paste') { showPaste(String(m.text || '')); return; }
        if (m.type === 'fail') { fail(String(m.reason), m.detail ? String(m.detail) : ''); return; }
        if (state !== 'working') return;
        if (m.type === 'step') step(String(m.text), Array.isArray(m.names) ? m.names.join(' \u00b7 ') : '');
        else if (m.type === 'wait') {
            const until = Date.now() + Number(m.ms);
            // Waits the locker sets push the time limit back.
            deadline = Math.max(deadline, until + 60000);
            clearInterval(waitTimer);
            const tick = () => subtext(String(m.text) + ' \u00b7 ' + Math.max(0, Math.ceil((until - Date.now()) / 1000)) + ' s');
            tick();
            waitTimer = setInterval(tick, 500);
        } else if (m.type === 'loot-progress') {
            subtext(m.done + ' of ' + m.total + ' tasks done');
            if (m.total) progress(m.done / m.total);
        } else if (m.type === 'loot-needs') {
            // Not a failure: the page is the user's for this one step, and
            // the link is still opened when it arrives.
            const names = (Array.isArray(m.names) ? m.names : []).map(String).filter(Boolean);
            deadline = Math.max(deadline, Date.now() + 15 * 60000);
            $('result').className = 'result needs';
            setIcon('needs');
            $('why').textContent = names.length === 1 ? 'One step needs you: ' + names[0] : 'These steps need you: ' + names.join(', ');
            $('next').textContent = 'Lootlabs doesn\'t finish ' + (names.length === 1 ? 'it' : 'them') + ' on its own. Show the page and do '
                + (names.length === 1 ? 'it' : 'them') + ' there; TabPaladin keeps listening and opens the link as soon as Lootlabs sends it.';
            $('result').hidden = false;
            $('show').className = 'primary';
            note('Needs the user: ' + names.join(', '));
            // Only the human check left: shown right away, at the check.
            if (m.check === true) showPage();
        }
    });

    step('Starting');
    // Hand-over: the page's script takes this off the root element now if it
    // ran first (on the event), or as soon as it runs.
    const html = document.documentElement;
    if (html) {
        html.setAttribute('data-tp-unlock', JSON.stringify({ n: secret, link }));
        document.dispatchEvent(new CustomEvent('tp-unlock-hello'));
        // Not picked up in time: no page script to give it to.
        setTimeout(() => { if (!alive) html.removeAttribute('data-tp-unlock'); }, 5000);
    }
})();
