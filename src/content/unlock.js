/**
 * Link lockers: Linkvertise and Lootlabs
 * On a Linkvertise or Lootlabs link page, a TabPaladin page covers the
 * locker from its first moment, does the locker's steps inside the page
 * itself (its own cookies and connection, which is what the locker's servers
 * accept) and opens the destination. It says what it is doing and, when it
 * cannot finish, why, with the page underneath one click away.
 *
 * Linkvertise: the page's own API calls. Ask for the link's tasks, complete
 * the wait task and each ad (after the time the page itself waits), then ask
 * again and get the destination or a paste.
 * Lootlabs: the page's own task list, clicked without opening any of the
 * offers (popups and new tabs are stubbed out). Its server marks each task
 * done after a while and sends the destination over its socket ("r:...").
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
        globalThis.TPUnlock = { classify, decodeLoot, safeUrl, pageWorker, LINKVERTISE, LOOTLABS };
        return;
    }
    if (window.top !== window || window.__tpUnlock) return;
    window.__tpUnlock = true;
    const link = classify(location.href);
    if (!link) return;

    // Runs in the page's own world (injected below), so its requests are the
    // page's. It sees nothing of the content script: it gets cfg and talks
    // through events on its own script element, which the page cannot reach
    // once it is removed. The page's later changes to dispatchEvent and the
    // like do not reach it either: they are taken here, first.
    function pageWorker(cfg) {
        const channel = document.currentScript;
        const dispatch = EventTarget.prototype.dispatchEvent, Custom = CustomEvent, stringify = JSON.stringify;
        const say = (type, data) => { dispatch.call(channel, new Custom('tp-unlock-out', { detail: stringify({ type, ...data }) })); };
        const pageFetch = window.fetch.bind(window);
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));

        // No popups or new tabs from this page while TabPaladin is on it,
        // except what its Unlock button opens: that is the destination. Once
        // a Linkvertise page is shown, it is the user's again.
        let unlockAt = 0, handsOff = false;
        document.addEventListener('click', (e) => {
            if (e.target && e.target.closest && e.target.closest('button[class*="unlock-btn"]')) unlockAt = Date.now();
        }, true);
        const blocked = (url, what) => {
            if (url && Date.now() - unlockAt < 3000) say('done', { url: String(url) });
            else say('log', { text: 'Blocked a ' + what });
        };
        const stubWindow = () => ({ closed: false, opener: null, close() { this.closed = true; }, focus() {}, blur() {}, postMessage() {},
            location: { href: '', assign() {}, replace() {} }, document: { open() {}, write() {}, close() {} } });
        const nativeOpen = window.open;
        window.open = function (url) {
            if (handsOff) return nativeOpen.apply(this, arguments);
            blocked(url, 'popup');
            return stubWindow();
        };
        const anchorClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
            if (!handsOff && this.target && this.target !== '_self' && this.target !== '_top' && this.target !== '_parent') { blocked(this.href, 'new tab'); return; }
            return anchorClick.call(this);
        };
        channel.addEventListener('tp-unlock-in', (e) => { if (String(e.detail) === 'shown' && cfg.link.site === 'linkvertise') handsOff = true; });

        async function linkvertise() {
            const GQL = 'https://publisher.linkvertise.com/graphql';
            const identifier = { userIdAndUrl: { user_id: cfg.link.userId, url: cfg.link.url } };
            const GET = 'query getContent($identifier: PublicLinkIdentificationInput!, $task_args: TaskArgument) { getContent(input: $identifier, task_args: $task_args) { ... on ContentAccessTaskSet { __typename tasks { __typename id ... on WaitTask { status remainingWaitingTime } ... on AdTask { status adIndex adsTotal payloadBag { taboola { session_id } } ads { completion_token countdown provider_additional_payload { taboola { available_event_url visible_event_url } } } } ... on PremiumTask { status } } } ... on DetailPageTargetData { __typename type url paste } } }';
            const DONE = 'mutation completeTask($identifier: PublicLinkIdentificationInput!, $task_id: String!, $task_args: TaskArgument) { completeTask(input: $identifier, task_id: $task_id, task_args: $task_args) { id ... on AdTask { status } ... on WaitTask { status } ... on PremiumTask { status } } }';
            const mobile = navigator.userAgentData ? navigator.userAgentData.mobile : /Mobi|Android/i.test(navigator.userAgent);
            let tbUser = 'fallbackUserId', tbSession = '';
            try {
                const r = await pageFetch('https://api.taboola.com/2.0/json/linkvertisenew-singlecardexperience/user.sync?app.type=' + (mobile ? 'mobile' : 'desktop')
                    + '&app.apikey=' + (mobile ? '4ca5a7098b3d22c647cc4c0810721cabcdf09055' : 'ef1d95992fae5ed0b4440e58cae147e9a1f7ffea'));
                tbUser = (await r.json()).user.id || tbUser;
            } catch (_) { /* the page itself falls back to this too */ }
            const args = (extra) => ({ additional_data: { taboola: { user_id: tbUser, consent_string: '', url: location.href, external_referrer: document.referrer, session_id: tbSession } },
                action_id: crypto.randomUUID(), ...extra });
            const gql = async (name, query, variables) => {
                const r = await pageFetch(GQL + '?name=' + name, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(name === 'completeTask' ? { cqreferrer: location.href } : {}) },
                    body: JSON.stringify({ operationName: name, query, variables })
                });
                let j;
                try { j = await r.json(); } catch (_) { throw new Error('HTTP ' + r.status + ' from Linkvertise'); }
                if (j.errors && j.errors.length) throw new Error(j.errors.map(e => e.message).join('; '));
                return j.data;
            };
            const complete = async (id, extra) => {
                const r = (await gql('completeTask', DONE, { identifier, task_id: id, task_args: args(extra) })).completeTask;
                say('log', { text: 'completeTask ' + id + ': ' + (r && r.status) });
                if (!r || r.status !== 'DONE') throw new Error('Linkvertise did not accept the step (' + (r && r.status) + ')');
            };
            const ping = (u) => u ? pageFetch(u).catch(() => {}) : Promise.resolve();

            say('step', { text: 'Asking Linkvertise what this link needs' });
            let content = (await gql('getContent', GET, { identifier, task_args: args() })).getContent;
            for (let round = 0; round < 12 && content && content.__typename === 'ContentAccessTaskSet'; round++) {
                const tasks = content.tasks || [];
                say('log', { text: 'Tasks: ' + tasks.map(t => t.__typename + ':' + t.status).join(', ') });
                const task = tasks.find(t => t.__typename !== 'PremiumTask' && t.status === 'IN_PROGRESS')
                    || tasks.find(t => t.__typename !== 'PremiumTask' && t.status === 'OPEN');
                if (!task) return say('fail', { reason: tasks.some(t => t.__typename === 'PremiumTask') ? 'lv-premium' : 'lv-stuck' });
                if (task.__typename === 'WaitTask') {
                    say('step', { text: 'Skipping the waiting room' });
                    await complete(task.id);
                } else if (task.__typename === 'AdTask') {
                    tbSession = (task.payloadBag && task.payloadBag.taboola && task.payloadBag.taboola.session_id) || tbSession;
                    const ad = (task.ads || [])[0];
                    say('step', { text: 'Ad ' + (task.adIndex || 1) + ' of ' + (task.adsTotal || 1) + ', without showing it' });
                    if (!ad) await complete(task.id);
                    else {
                        const tb = ad.provider_additional_payload && ad.provider_additional_payload.taboola;
                        await ping(tb && tb.available_event_url);
                        await ping(tb && tb.visible_event_url);
                        // The page offers "Skip Ad" after 5 to 15 seconds.
                        say('wait', { ms: 15000, text: 'Linkvertise wants each ad on screen for a moment' });
                        await sleep(15000);
                        try { await complete(task.id, { completion_token: ad.completion_token || undefined }); } catch (e) {
                            const rest = Math.max(0, (Number(ad.countdown) || 60) * 1000 - 15000);
                            say('log', { text: 'First try refused (' + e.message + '); retrying after ' + rest / 1000 + ' s' });
                            say('wait', { ms: rest, text: 'Not yet accepted, giving it the ad\'s full time' });
                            await sleep(rest);
                            await complete(task.id, { completion_token: ad.completion_token || undefined });
                        }
                    }
                } else {
                    return say('fail', { reason: 'lv-unknown', detail: task.__typename });
                }
                content = (await gql('getContent', GET, { identifier, task_args: args() })).getContent;
            }
            if (!content || content.__typename !== 'DetailPageTargetData') return say('fail', { reason: 'lv-stuck' });
            if (content.type === 'PASTE' || (!content.url && content.paste)) return say('paste', { text: String(content.paste || '') });
            say('done', { url: content.url });
        }

        async function lootlabs() {
            const NativeSocket = window.WebSocket;
            let socket = false;
            const Socket = function (url, protocols) {
                const ws = protocols === undefined ? new NativeSocket(url) : new NativeSocket(url, protocols);
                socket = true;
                say('log', { text: 'Socket opened to ' + String(url).split('?')[0] });
                ws.addEventListener('message', (e) => {
                    const m = String(e.data);
                    if (m.startsWith('r:')) say('loot-link', { payload: m.slice(2) });
                    else if (m !== '0') say('log', { text: 'Socket: ' + m.slice(0, 120) });
                });
                ws.addEventListener('close', (e) => say('log', { text: 'Socket closed (' + e.code + ')' }));
                return ws;
            };
            Socket.prototype = NativeSocket.prototype;
            for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Socket[k] = NativeSocket[k];
            window.WebSocket = Socket;

            // A task is an element whose class starts "<category>_<id>_<category>".
            const isTask = (el) => /^(\d+)_\d+_\1(\s|$)/.test(el.getAttribute('class') || '');
            const findTasks = () => [...document.querySelectorAll('[class]')].filter(isTask);
            say('step', { text: 'Waiting for the Lootlabs task list' });
            let tasks = [];
            for (let i = 0; i < 60 && !tasks.length; i++) { await sleep(500); tasks = findTasks(); }
            if (!tasks.length) return say('fail', { reason: 'loot-no-tasks' });
            const name = (t) => ((t.querySelector('[class*="task-name"]') || t).textContent || '').trim().slice(0, 80);
            say('step', { text: 'Starting ' + tasks.length + ' tasks without opening them', names: tasks.map(name) });
            for (const t of tasks) {
                if (t.classList.contains('done')) continue;
                t.click();
                await sleep(1200);
            }
            await sleep(3000);
            if (!socket) return say('fail', { reason: 'loot-no-start' });
            say('step', { text: 'Waiting for Lootlabs to release the link (usually about a minute)' });
            let pressed = false;
            setInterval(() => {
                tasks = findTasks();
                const done = tasks.filter(t => t.classList.contains('done')).length;
                say('loot-progress', { done, total: tasks.length });
                // The page's own Unlock button opens the link itself, should
                // it be ready before the socket says so.
                const unlock = document.querySelector('button[class*="unlock-btn"]');
                if (!pressed && tasks.length && done === tasks.length && unlock && !unlock.disabled) { pressed = true; say('log', { text: 'Pressing Unlock' }); unlock.click(); }
            }, 1000);
        }

        say('alive', {});
        (cfg.link.site === 'linkvertise' ? linkvertise() : lootlabs())
            .catch(e => say('fail', { reason: cfg.link.site === 'linkvertise' ? 'lv-error' : 'loot-error', detail: String(e && e.message || e) }));
    }

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
        'blocked': ['The page did not let TabPaladin\'s script run.', 'Its security settings block it. Show the page to do it by hand.']
    };

    // The covering page, in a closed shadow root so the locker's styles and
    // scripts leave it alone.
    const host = document.createElement('tp-unlock');
    host.setAttribute('style', 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;display:block!important');
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
    (document.documentElement || document).appendChild(host);

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
        if (!host.isConnected) (document.documentElement || document).appendChild(host);
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
        stop();
        if (current) current.className = 'bad';
        $('bar').classList.add('failed');
        const [why, next] = REASONS[reason] || REASONS['lv-error'];
        $('why').textContent = 'Couldn\'t skip this page. ' + why;
        $('next').textContent = next;
        $('result').hidden = false;
        $('retry').hidden = false;
        $('copy').hidden = false;
        note('Failed: ' + reason + (detail ? ' (' + detail + ')' : ''));
        if (detail) $('more').open = true;
    }
    const finish = () => {
        state = 'done';
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

    const script = document.createElement('script');
    // The work goes on underneath: a link that still arrives is opened.
    $('show').addEventListener('click', () => {
        host.style.setProperty('display', 'none', 'important');
        script.dispatchEvent(new CustomEvent('tp-unlock-in', { detail: 'shown' }));
        note('Page shown');
    });
    $('retry').addEventListener('click', () => location.reload());
    const copy = (text) => {
        const done = () => note('Copied');
        try { navigator.clipboard.writeText(text).then(done, () => select(text)); } catch (_) { select(text); }
    };
    const select = () => { $('more').open = true; const r = document.createRange(); r.selectNodeContents($('log')); const s = root.getSelection ? root.getSelection() : getSelection(); s.removeAllRanges(); s.addRange(r); };
    $('copy').addEventListener('click', () => copy(['TabPaladin link locker: ' + SITE, location.hostname + location.pathname, ...log].join('\n')));
    $('copyPaste').addEventListener('click', () => { try { navigator.clipboard.writeText($('paste').textContent).then(() => { $('copyPaste').textContent = 'Copied'; }); } catch (_) { /* select it by hand */ } });

    script.addEventListener('tp-unlock-out', (e) => {
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
        }
    });

    step('Starting');
    script.textContent = '(' + pageWorker.toString() + ')(' + JSON.stringify({ link }) + ');';
    (document.head || document.documentElement).appendChild(script);
    script.remove();
})();
