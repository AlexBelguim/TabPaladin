/**
 * YouTube save button
 * Adds a "Save" button to TabPaladin beside a video's Like/Share row and in
 * the Shorts action column. A click asks the helper to open the web app's
 * Save link sheet for this page (src/helper/save.js).
 */

(function () {
    'use strict';

    // Registered at runtime by the helper, only while the YouTube button is
    // switched on in its Settings. It reads no extension storage and sends
    // only the page's own link and title. YouTube redraws its page as you
    // move between videos, so the button is put back whenever it goes.
    // Injected again after being switched off and on: switch the first back on.
    if (typeof window.__tpYouTubeSave === 'function') { window.__tpYouTubeSave(); return; }
    const ext = typeof browser !== 'undefined' ? browser : chrome;
    const CLASS = 'tp-yt-save';
    let enabled = true;

    // YouTube renames its markup now and then: the first match wins.
    const WATCH_ROW = ['ytd-watch-metadata #top-level-buttons-computed', '#above-the-fold #top-level-buttons-computed',
        'ytd-watch-metadata #actions ytd-menu-renderer', '#actions #top-level-buttons-computed'];
    // Shorts: the column is found from its like (heart) button, whatever
    // YouTube calls the column itself this month.
    const SHORTS_LIKE = ['ytd-shorts like-button-view-model', 'ytd-shorts #like-button', 'ytd-shorts ytd-like-button-renderer',
        'like-button-view-model', 'ytd-reel-video-renderer #like-button'];

    const ICON = 'M12 2.5 4 6v6c0 4.6 3.4 8.6 8 9.5 4.6-.9 8-4.9 8-9.5V6l-8-3.5Zm-1 13.2-3.6-3.6 1.4-1.4 2.2 2.2 4.8-4.8 1.4 1.4-6.2 6.2Z';

    function svgIcon() {
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('width', '20');
        svg.setAttribute('height', '20');
        svg.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS(ns, 'path');
        path.setAttribute('d', ICON);
        path.setAttribute('fill', 'currentColor');
        svg.append(path);
        return svg;
    }

    function pageTitle() {
        const h = document.querySelector('ytd-watch-metadata h1, ytd-reel-video-renderer[is-active] h2');
        const text = (h && h.textContent.trim()) || document.title.replace(/\s*-\s*YouTube\s*$/, '');
        return text.slice(0, 500);
    }

    function makeButton(vertical, floating) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = CLASS;
        b.title = 'Save to a TabPaladin folder';
        const label = document.createElement('span');
        label.textContent = 'Save';
        if (vertical) {
            // YouTube's own Shorts buttons: a round button, its label under it.
            const circle = document.createElement('span');
            Object.assign(circle.style, { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '48px', height: '48px',
                borderRadius: '50%', background: 'var(--yt-spec-badge-chip-background, rgba(255,255,255,0.1))' });
            const icon = svgIcon();
            icon.setAttribute('width', '24');
            icon.setAttribute('height', '24');
            circle.append(icon);
            b.append(circle, label);
            Object.assign(b.style, { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', border: '0', padding: '0',
                margin: '0 0 16px', background: 'transparent', cursor: 'pointer', color: 'var(--yt-spec-text-primary, #f1f1f1)',
                font: '400 14px Roboto, Arial, sans-serif' });
        } else {
            b.append(svgIcon(), label);
        }
        if (!vertical) Object.assign(b.style, {
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
            border: '0', cursor: 'pointer', font: '500 14px Roboto, Arial, sans-serif',
            color: 'var(--yt-spec-text-primary, #f1f1f1)', background: 'var(--yt-spec-badge-chip-background, rgba(255,255,255,0.1))'
        });
        if (floating) {
            Object.assign(b.style, { position: 'fixed', right: '24px', bottom: '24px', zIndex: '2147483000', height: '40px', borderRadius: '20px',
                padding: '0 16px', background: '#3d5afe', color: '#fff', boxShadow: '0 4px 14px rgba(0,0,0,0.4)' });
        } else if (!vertical) {
            Object.assign(b.style, { height: '36px', borderRadius: '18px', padding: '0 14px', marginLeft: '8px', flex: 'none' });
        }
        b.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            label.textContent = '…';
            let sent;
            try {
                sent = ext.runtime.sendMessage({ channel: 'tp-youtube-save', url: location.href, title: pageTitle() });
            } catch (err) {
                sent = Promise.reject(err);
            }
            Promise.resolve(sent).then((reply) => {
                label.textContent = reply && reply.ok ? 'Save' : 'Set up TabPaladin';
                if (!(reply && reply.ok)) setTimeout(() => { label.textContent = 'Save'; }, 3000);
            }, () => { label.textContent = 'Reload page'; });
        });
        return b;
    }

    // Only a spot on screen counts: YouTube keeps hidden copies of both
    // rows (the previous Short, the player's other layouts) in the page.
    const onScreen = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
    };
    const first = (selectors) => {
        for (const s of selectors) {
            const el = [...document.querySelectorAll(s)].find(onScreen);
            if (el) return el;
        }
        return null;
    };

    // The like button's slot in the Shorts column: climb from the like button
    // to the first ancestor that stacks it with the other buttons.
    function shortsSlot() {
        const like = first(SHORTS_LIKE);
        let item = like;
        for (let i = 0; item && i < 6; i++, item = item.parentElement) {
            const column = item.parentElement;
            if (!column || column.children.length < 3) continue;
            const c = column.getBoundingClientRect(), r = item.getBoundingClientRect();
            if (c.height >= r.height * 2.5) return { column, item };
        }
        return null;
    }

    // While no spot is found (the page still loading, or YouTube's markup
    // moved on), the button floats in the corner.
    let since = 0, sincePath = '';
    function place() {
        if (!enabled) return;
        const watch = location.pathname === '/watch', shorts = location.pathname.startsWith('/shorts/');
        const floating = document.querySelector('.' + CLASS + '[data-floating]');
        if (!watch && !shorts) { if (floating) floating.remove(); return; }
        if (sincePath !== location.pathname) { sincePath = location.pathname; since = Date.now(); }
        let placed = false;
        if (watch) {
            const row = first(WATCH_ROW);
            if (row && row.parentElement) {
                placed = true;
                if (!row.parentElement.querySelector(':scope > .' + CLASS)) row.parentElement.insertBefore(makeButton(false), row.nextSibling);
            }
        } else {
            const slot = shortsSlot();
            if (slot) {
                placed = true;
                if (!slot.column.querySelector(':scope > .' + CLASS)) slot.column.insertBefore(makeButton(true), slot.item);
            }
        }
        if (placed) { if (floating) floating.remove(); return; }
        if (floating) return;
        if (Date.now() - since < 1500) { setTimeout(schedule, 500); return; }
        const b = makeButton(false, true);
        b.dataset.floating = '1';
        document.body.append(b);
    }

    let queued = false;
    const schedule = () => {
        if (queued) return;
        queued = true;
        setTimeout(() => { queued = false; place(); }, 250);
    };
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('yt-navigate-finish', schedule);
    window.__tpYouTubeSave = () => { enabled = true; schedule(); checkPlaylist(); };
    schedule();

    // --- A TabPaladin folder as a Shorts playlist ---------------------------
    //
    // In a tab the helper opened for a folder (save.js), the Shorts arrows,
    // the wheel and the arrow keys step through that folder instead of
    // YouTube's feed, and a panel says where in it you are. On a video that is
    // not in the folder (one opened from here), YouTube is itself again.
    const PANEL = 'tp-yt-playlist';
    let playlist = null, turning = false, wheelSum = 0, wheelAt = 0;

    const ask = (msg) => {
        try {
            return Promise.resolve(ext.runtime.sendMessage({ channel: 'tp-youtube-playlist', url: location.href, ...msg })).catch(() => null);
        } catch (e) {
            return Promise.resolve(null);
        }
    };

    async function checkPlaylist() {
        if (!enabled) return;
        const reply = await ask({ op: 'get' });
        playlist = reply && reply.ok && reply.playlist ? reply.playlist : null;
        turning = false;
        drawPanel();
    }

    async function go(dir) {
        if (!playlist || turning) return;
        turning = true;
        const reply = await ask({ op: 'go', dir });
        if (reply && reply.ok && reply.url) { location.assign(reply.url); return; }
        turning = false;
        if (reply && reply.end) note(dir > 0 ? 'End of ' + (playlist.title || 'the folder') : 'Start of ' + (playlist.title || 'the folder'));
    }

    function roundButton(text, title, dir) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = text;
        b.title = title;
        Object.assign(b.style, { width: '56px', height: '56px', borderRadius: '50%', border: '0', cursor: 'pointer', fontSize: '22px',
            color: 'var(--yt-spec-text-primary, #f1f1f1)', background: 'var(--yt-spec-badge-chip-background, rgba(255,255,255,0.1))' });
        b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); go(dir); });
        return b;
    }

    function note(text) {
        const panel = document.getElementById(PANEL);
        const pos = panel && panel.querySelector('[data-pos]');
        if (!pos) return;
        pos.textContent = text;
        setTimeout(drawPanel, 1500);
    }

    function drawPanel() {
        let panel = document.getElementById(PANEL);
        let style = document.getElementById(PANEL + '-style');
        if (!playlist || !enabled) {
            if (panel) panel.remove();
            if (style) style.remove();
            return;
        }
        if (!style) {
            // YouTube's own up/down arrows would leave the folder for its feed.
            style = document.createElement('style');
            style.id = PANEL + '-style';
            style.textContent = '#navigation-button-up, #navigation-button-down { display: none !important; }';
            document.documentElement.append(style);
        }
        if (!panel) {
            panel = document.createElement('div');
            panel.id = PANEL;
            Object.assign(panel.style, { position: 'fixed', right: '24px', top: '50%', transform: 'translateY(-50%)', zIndex: '2147483000',
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', font: '400 13px Roboto, Arial, sans-serif',
                color: 'var(--yt-spec-text-primary, #f1f1f1)', textAlign: 'center', maxWidth: '120px' });
            const title = document.createElement('div');
            title.dataset.title = '';
            Object.assign(title.style, { fontWeight: '500', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '120px' });
            const pos = document.createElement('div');
            pos.dataset.pos = '';
            panel.append(title, roundButton('▲', 'Previous in this folder', -1), pos, roundButton('▼', 'Next in this folder', 1));
            document.body.append(panel);
        }
        panel.querySelector('[data-title]').textContent = '📥 ' + (playlist.title || 'TabPaladin');
        panel.querySelector('[data-pos]').textContent = (playlist.index + 1) + ' / ' + playlist.count;
        const [up, down] = panel.querySelectorAll('button');
        up.disabled = playlist.index === 0;
        down.disabled = playlist.index === playlist.count - 1;
        up.style.opacity = up.disabled ? '0.4' : '1';
        down.style.opacity = down.disabled ? '0.4' : '1';
    }

    const typing = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    const onShorts = () => location.pathname.startsWith('/shorts/');
    window.addEventListener('keydown', (e) => {
        if (!playlist || !onShorts() || typing(e.target) || e.altKey || e.ctrlKey || e.metaKey) return;
        const dir = e.key === 'ArrowDown' || e.key === 'PageDown' ? 1 : e.key === 'ArrowUp' || e.key === 'PageUp' ? -1 : 0;
        if (!dir) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        go(dir);
    }, true);
    window.addEventListener('wheel', (e) => {
        if (!playlist || !onShorts() || e.ctrlKey) return;
        // Comments and menus still scroll themselves.
        if (e.target && e.target.closest && e.target.closest('ytd-engagement-panel-section-list-renderer, tp-yt-iron-dropdown, #' + PANEL)) return;
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
    // A long video in the folder opens on the video page: at its end, the next.
    document.addEventListener('ended', (e) => {
        if (playlist && e.target && e.target.tagName === 'VIDEO' && location.pathname === '/watch') go(1);
    }, true);
    document.addEventListener('yt-navigate-finish', checkPlaylist);
    checkPlaylist();

    try {
        ext.runtime.onMessage.addListener((msg, sender) => {
            if (!sender || sender.id !== ext.runtime.id || sender.tab) return;
            if (msg && msg.type === 'tp-youtube-save-off') {
                enabled = false;
                document.querySelectorAll('.' + CLASS).forEach(b => b.remove());
                playlist = null;
                drawPanel();
            }
        });
    } catch (e) { /* stays until the page reloads */ }
})();
