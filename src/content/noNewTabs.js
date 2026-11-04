/**
 * No new tabs on rentry.co
 * Runs in the page's own world before the page's scripts, so their popups
 * meet the stub below. A rentry page (where link lockers usually lead) opens
 * an ad tab on every click and its links in new tabs; with this, nothing
 * opens a new tab unless the user asks for one: a plain click on a link
 * opens it in the same tab, Ctrl/Shift/Cmd-click and the middle button still
 * open new tabs and windows. Nor does a script send this tab to another site
 * (the ad, when it finds it cannot open its tab), except to the link the user
 * just clicked.
 *
 * Registered at runtime by the helper (src/helper/unwrap.js), only while
 * "Stop rentry.co from opening new tabs" is on in its Settings. It reads
 * nothing, keeps nothing and sends nothing.
 */

(function () {
    'use strict';

    const opensNew = (target) => !!target && !/^_(self|top|parent)$/i.test(target);
    const stubWindow = () => ({ closed: true, opener: null, close() {}, focus() {}, blur() {}, postMessage() {},
        location: { href: '', assign() {}, replace() {} }, document: { open() {}, write() {}, close() {} } });

    // Scripts' own popups and new tabs: never.
    window.open = function () { return stubWindow(); };
    const anchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
        if (opensNew(this.target) && !this.hasAttribute('download')) return;
        return anchorClick.call(this);
    };
    const formSubmit = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function () {
        if (opensNew(this.target)) return;
        return formSubmit.call(this);
    };

    const baseTarget = () => {
        const base = document.querySelector('base[target]');
        return base ? base.getAttribute('target') : '';
    };
    // Where the user's last plain click on a link was going, for a moment.
    let clicked = null;
    // Clicks on links, before the page's handlers see them.
    window.addEventListener('click', (e) => {
        const a = e.target && e.target.closest ? e.target.closest('a[href], area[href]') : null;
        if (!a || !opensNew(a.getAttribute('target') || baseTarget())) return;
        // A click a script made up: no tab.
        if (!e.isTrusted) { e.preventDefault(); return; }
        // The user's own new-tab or new-window click stays theirs.
        if (e.button !== 0 || e.ctrlKey || e.shiftKey || e.metaKey || e.altKey) return;
        a.setAttribute('target', '_self');
        const href = a.href;
        if (!/^https?:/i.test(href)) return;
        clicked = { href, until: Date.now() + 5000 };
        // The ad script cancels the click (to open the link from a made-up
        // click of its own, which is stopped above): then it is opened here, once.
        setTimeout(() => { if (e.defaultPrevented) location.assign(href); }, 0);
    }, true);

    // A script sending this tab to another site: only to that link.
    if (window.navigation && typeof window.navigation.addEventListener === 'function') {
        window.navigation.addEventListener('navigate', (e) => {
            if (!e.cancelable || e.userInitiated || (e.navigationType !== 'push' && e.navigationType !== 'replace')) return;
            let to;
            try { to = new URL(e.destination.url); } catch (_) { return; }
            if (to.origin === location.origin) return;
            if (clicked && Date.now() < clicked.until && to.href === clicked.href) return;
            e.preventDefault();
        });
    }
})();
