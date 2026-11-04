/**
 * Link lockers, the page's side
 * Runs in the locker page's own world, registered next to src/content/unlock.js
 * (which draws TabPaladin's page and reports), so its requests, sockets and
 * clicks are the page's own and the page's security policy does not stop it.
 * It does nothing until unlock.js hands it the link and a secret, both
 * before any of the page's scripts run; it then reports only through events
 * whose name carries that secret, sent with functions taken before the page
 * could change them.
 *
 * Linkvertise: the page's own API calls. Ask for the link's tasks, complete
 * the wait task and each ad (after the time the page itself waits), then ask
 * again and get the destination or a paste.
 * Lootlabs: the page's own task list, clicked without opening any of the
 * offers (popups and new tabs are stubbed out). Its server marks each task
 * done after a while and sends the destination over its socket ("r:...").
 */

(function () {
    'use strict';

    const root = document.documentElement;
    const dispatch = EventTarget.prototype.dispatchEvent, listen = EventTarget.prototype.addEventListener, unlisten = EventTarget.prototype.removeEventListener;
    const getAttr = Element.prototype.getAttribute, removeAttr = Element.prototype.removeAttribute;
    const Custom = CustomEvent, stringify = JSON.stringify, parse = JSON.parse;
    if (!root) return;

    // unlock.js leaves {n, link} on the root element; whichever of the two
    // runs second picks it up.
    const take = () => {
        const raw = getAttr.call(root, 'data-tp-unlock');
        if (!raw) return false;
        removeAttr.call(root, 'data-tp-unlock');
        let cfg;
        try { cfg = parse(raw); } catch (_) { return true; }
        if (cfg && typeof cfg.n === 'string' && cfg.link && (cfg.link.site === 'linkvertise' || cfg.link.site === 'lootlabs')) work(cfg);
        return true;
    };
    const hello = () => { if (take()) unlisten.call(document, 'tp-unlock-hello', hello); };
    if (!take()) listen.call(document, 'tp-unlock-hello', hello);

    function work(cfg) {
        const say = (type, data) => { dispatch.call(document, new Custom('tp-unlock-' + cfg.n, { detail: stringify({ type, ...data }) })); };
        const pageFetch = window.fetch.bind(window);
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));

        // No popups or new tabs from this page while TabPaladin is on it,
        // except what its Unlock button opens: that is the destination. Once
        // the page is shown, it is the user's again (a Lootlabs check the user
        // does may open its own tab).
        let unlockAt = 0, handsOff = false;
        listen.call(document, 'click', (e) => {
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
        listen.call(document, 'tp-unlock-in-' + cfg.n, (e) => { if (String(e.detail) === 'shown') handsOff = true; });

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
            // The page's action ids are three random UUIDs run together, cut to 100.
            const actionId = () => (crypto.randomUUID() + crypto.randomUUID() + crypto.randomUUID()).slice(0, 100);
            const args = (extra) => ({ additional_data: { taboola: { user_id: tbUser, consent_string: '', url: location.href, external_referrer: document.referrer, session_id: tbSession } },
                action_id: actionId(), ...extra });
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
            // Lootlabs finishes its other tasks by itself after a while; a
            // human check it does not. Once only such tasks are left, or after
            // 75 seconds, the ones left are handed to the user.
            const human = (t) => /human|verif|captcha|robot/i.test(name(t));
            const since = Date.now();
            let pressed = false, asked = false;
            setInterval(() => {
                tasks = findTasks();
                const left = tasks.filter(t => !t.classList.contains('done'));
                const done = tasks.length - left.length;
                say('loot-progress', { done, total: tasks.length });
                if (!asked && left.length && (left.every(human) || Date.now() - since > 75000)) {
                    asked = true;
                    say('loot-needs', { names: left.map(name) });
                }
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
})();
