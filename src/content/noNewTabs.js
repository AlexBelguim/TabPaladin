/**
 * No new tabs on rentry.co
 * Runs in the page's own world before the page's scripts, so their popups
 * meet the stub below. A rentry page (where link lockers usually lead) opens
 * an ad tab on every click and its links in new tabs; with this, nothing
 * opens a new tab unless the user asks for one: a plain click on a link
 * opens it in the same tab, Ctrl/Shift/Cmd-click and the middle button still
 * open new tabs and windows.
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
    // Clicks on links, before the page's handlers see them.
    window.addEventListener('click', (e) => {
        const a = e.target && e.target.closest ? e.target.closest('a[href], area[href]') : null;
        if (!a || !opensNew(a.getAttribute('target') || baseTarget())) return;
        // A click a script made up: no tab.
        if (!e.isTrusted) { e.preventDefault(); return; }
        // The user's own new-tab or new-window click stays theirs.
        if (e.button !== 0 || e.ctrlKey || e.shiftKey || e.metaKey || e.altKey) return;
        a.setAttribute('target', '_self');
    }, true);
})();
