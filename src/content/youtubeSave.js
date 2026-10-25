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
    const SHORTS_BAR = ['ytd-reel-video-renderer[is-active] reel-action-bar-view-model',
        'ytd-reel-video-renderer[is-active] #actions', 'ytd-shorts [is-active] #actions'];

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
        b.append(svgIcon(), label);
        Object.assign(b.style, {
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
            border: '0', cursor: 'pointer', font: '500 14px Roboto, Arial, sans-serif',
            color: 'var(--yt-spec-text-primary, #f1f1f1)', background: 'var(--yt-spec-badge-chip-background, rgba(255,255,255,0.1))'
        });
        if (floating) {
            Object.assign(b.style, { position: 'fixed', right: '24px', bottom: '24px', zIndex: '2147483000', height: '40px', borderRadius: '20px',
                padding: '0 16px', background: '#3d5afe', color: '#fff', boxShadow: '0 4px 14px rgba(0,0,0,0.4)' });
        } else if (vertical) {
            Object.assign(b.style, { flexDirection: 'column', width: '48px', minHeight: '48px', borderRadius: '24px', padding: '8px 0', margin: '0 0 16px', fontSize: '12px', gap: '2px' });
        } else {
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

    const first = (selectors) => {
        // Only a spot on screen counts: YouTube keeps hidden copies of both
        // rows (the previous Short, the player's other layouts) in the page.
        const onScreen = (el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
        };
        for (const s of selectors) {
            const el = [...document.querySelectorAll(s)].find(onScreen);
            if (el) return el;
        }
        return null;
    };

    // When YouTube's markup has moved on and no spot is found within a few
    // seconds, the button floats in the corner instead.
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
            const bar = first(SHORTS_BAR);
            if (bar) {
                placed = true;
                if (!bar.querySelector(':scope > .' + CLASS)) bar.prepend(makeButton(true));
            }
        }
        if (placed) { if (floating) floating.remove(); return; }
        if (floating) return;
        if (Date.now() - since < 4000) { setTimeout(schedule, 1000); return; }
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
    window.__tpYouTubeSave = () => { enabled = true; schedule(); };
    schedule();

    try {
        ext.runtime.onMessage.addListener((msg, sender) => {
            if (!sender || sender.id !== ext.runtime.id || sender.tab) return;
            if (msg && msg.type === 'tp-youtube-save-off') {
                enabled = false;
                document.querySelectorAll('.' + CLASS).forEach(b => b.remove());
            }
        });
    } catch (e) { /* stays until the page reloads */ }
})();
