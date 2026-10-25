/**
 * Feed for saved X and Instagram posts
 * In a tab the helper opened for a folder (src/helper/feed.js), a panel
 * shows where in the folder this post is, and its arrows, the J and K keys,
 * or a typed number go to the next, previous or numbered post of the folder.
 * On a post, scrolling is left alone: it is how replies and comments are
 * read. On an Instagram reel, which scrolls to the next reel of Instagram's
 * own feed, the wheel and the up/down keys go through the folder instead.
 */

(function () {
    'use strict';

    // Registered at runtime by the helper, only while feeds are switched on
    // in its Settings. It reads no extension storage and sends only the
    // page's own address. Injected again after a switch off and on: the
    // first copy is switched back on.
    if (typeof window.__tpFeed === 'function') { window.__tpFeed(); return; }
    const ext = typeof browser !== 'undefined' ? browser : chrome;
    const PANEL = 'tp-feed-panel';
    let enabled = true, feed = null, turning = false, lastHref = '';

    const ask = (msg) => {
        try {
            return Promise.resolve(ext.runtime.sendMessage({ channel: 'tp-feed', url: location.href, ...msg })).catch(() => null);
        } catch (e) {
            return Promise.resolve(null);
        }
    };

    // An Instagram reel: its page scrolls on to Instagram's next reel.
    const onReel = () => /(^|\.)instagram\.com$/.test(location.hostname) && /^\/(?:[^/]+\/)?reels?\//.test(location.pathname);

    async function check() {
        lastHref = location.href;
        if (!enabled) return;
        const was = feed;
        const reply = await ask({ op: 'get' });
        feed = reply && reply.ok && reply.feed ? reply.feed : null;
        turning = false;
        if (!feed && was && onReel()) {
            // Instagram's own arrow or swipe went on to a reel of its feed:
            // the folder's next one instead (its last, at the end).
            feed = was;
            turning = true;
            const next = await ask({ op: 'go', to: was.index + 1 });
            const target = next && next.url ? next : await ask({ op: 'go', to: was.index });
            if (target && target.url) { location.assign(target.url); return; }
            feed = null;
            turning = false;
        }
        draw();
    }

    async function go(dir, to = null) {
        if (!feed || turning) return;
        turning = true;
        const reply = await ask(to === null ? { op: 'go', dir } : { op: 'go', to });
        if (reply && reply.ok && reply.url) { location.assign(reply.url); return; }
        turning = false;
        if (reply && reply.end) note(dir > 0 ? 'End of ' + (feed.title || 'the folder') : 'Start of ' + (feed.title || 'the folder'));
    }

    function roundButton(text, title, dir) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = text;
        b.title = title;
        b.dataset.dir = String(dir);
        Object.assign(b.style, { width: '48px', height: '48px', borderRadius: '50%', border: '1px solid rgba(127,127,127,0.35)', cursor: 'pointer',
            fontSize: '20px', color: '#fff', background: 'rgba(30,30,30,0.85)', boxShadow: '0 2px 10px rgba(0,0,0,0.35)' });
        b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); go(dir); });
        return b;
    }

    function askNumber(pos) {
        if (!feed) return;
        const input = document.createElement('input');
        input.type = 'number';
        input.min = '1';
        input.max = String(feed.count);
        input.value = String(feed.index + 1);
        input.setAttribute('aria-label', 'Number in this folder, 1 to ' + feed.count);
        Object.assign(input.style, { width: '64px', textAlign: 'center', font: 'inherit', color: '#fff', borderRadius: '8px',
            border: '1px solid rgba(255,255,255,0.4)', background: 'rgba(0,0,0,0.75)', padding: '4px' });
        let finished = false;
        const finish = (jump) => {
            if (finished) return;
            finished = true;
            const n = Math.round(Number(input.value));
            input.replaceWith(pos);
            if (jump && n >= 1 && n <= feed.count && n - 1 !== feed.index) go(0, n - 1);
        };
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') finish(true);
            else if (e.key === 'Escape') finish(false);
        });
        input.addEventListener('blur', () => finish(false));
        pos.replaceWith(input);
        input.focus();
        input.select();
    }

    function note(text) {
        const pos = document.querySelector('#' + PANEL + ' [data-pos]');
        if (!pos) return;
        pos.textContent = text;
        setTimeout(draw, 1500);
    }

    function draw() {
        let panel = document.getElementById(PANEL);
        if (!feed || !enabled) { if (panel) panel.remove(); return; }
        if (!panel) {
            panel = document.createElement('div');
            panel.id = PANEL;
            Object.assign(panel.style, { position: 'fixed', right: '20px', top: '50%', transform: 'translateY(-50%)', zIndex: '2147483000',
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', font: '500 13px system-ui, sans-serif',
                color: '#fff', textAlign: 'center', textShadow: '0 1px 3px rgba(0,0,0,0.8)' });
            const title = document.createElement('div');
            title.dataset.title = '';
            Object.assign(title.style, { maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
            // Click the "2 / 12" to type where in the folder to go.
            const pos = document.createElement('button');
            pos.type = 'button';
            pos.dataset.pos = '';
            pos.title = 'Go to a number in this folder';
            Object.assign(pos.style, { border: '0', borderRadius: '8px', background: 'rgba(30,30,30,0.85)', color: '#fff', font: 'inherit', cursor: 'text', padding: '4px 8px' });
            pos.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); askNumber(pos); });
            panel.append(title, roundButton('▲', 'Previous in this folder (K)', -1), pos, roundButton('▼', 'Next in this folder (J)', 1));
            document.body.append(panel);
        }
        panel.querySelector('[data-title]').textContent = '📥 ' + (feed.title || 'TabPaladin');
        const pos = panel.querySelector('[data-pos]');
        if (pos) pos.textContent = (feed.index + 1) + ' / ' + feed.count;
        const up = panel.querySelector('[data-dir="-1"]'), down = panel.querySelector('[data-dir="1"]');
        up.disabled = feed.index === 0;
        down.disabled = feed.index === feed.count - 1;
        up.style.opacity = up.disabled ? '0.4' : '1';
        down.style.opacity = down.disabled ? '0.4' : '1';
    }

    // An Instagram reel: the wheel goes through the folder, as on a Short.
    // Comments and other dialogs still scroll themselves.
    let wheelSum = 0, wheelAt = 0;
    window.addEventListener('wheel', (e) => {
        if (!feed || !onReel() || e.ctrlKey) return;
        if (e.target && e.target.closest && e.target.closest('[role="dialog"], #' + PANEL)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        const now = Date.now();
        if (now - wheelAt > 300) wheelSum = 0;
        wheelAt = now;
        wheelSum += e.deltaY;
        if (Math.abs(wheelSum) >= 60) {
            const dir = wheelSum > 0 ? 1 : -1;
            wheelSum = 0;
            go(dir);
        }
    }, { capture: true, passive: false });

    // J next, K previous: X's own keys for that, taken over in a feed tab;
    // on an Instagram reel, the up and down keys too.
    const typing = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || (t.closest && t.closest('[contenteditable="true"], [role="textbox"]')));
    window.addEventListener('keydown', (e) => {
        if (!feed || typing(e.target) || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        const reel = onReel();
        const dir = e.key === 'j' || e.key === 'J' || (reel && (e.key === 'ArrowDown' || e.key === 'PageDown')) ? 1
            : e.key === 'k' || e.key === 'K' || (reel && (e.key === 'ArrowUp' || e.key === 'PageUp')) ? -1 : 0;
        if (!dir) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        go(dir);
    }, true);

    // Both sites move between pages without loading one: notice the address.
    setInterval(() => { if (location.href !== lastHref) check(); }, 700);
    window.__tpFeed = () => { enabled = true; check(); };
    check();

    try {
        ext.runtime.onMessage.addListener((msg, sender) => {
            if (!sender || sender.id !== ext.runtime.id || sender.tab) return;
            if (msg && msg.type === 'tp-feed-off') { enabled = false; feed = null; draw(); }
        });
    } catch (e) { /* stays until the page reloads */ }
})();
