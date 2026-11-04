// A saved MEGA link shown as what it opens: the folder's (or file's) name and
// size, which the server reads from MEGA with the key in the link
// (server/linkInfo.js), instead of the link or a title that only says "MEGA".
//
// decorate(anchor, url) is called on a link row's anchor once it is in its
// row: what is known is drawn at once, and what is not (or is a day old) is
// asked for, many links to one request, and drawn when it comes. Answers are
// kept in localStorage so a list of them draws without waiting the next time.

const MEGA = /^https?:\/\/(?:[\w-]+\.)?mega\.(?:nz|co\.nz)\/(?:(?:folder|file)\/[\w-]{8}#|#F?!)/;
const STORE = 'tp_link_info';
const FRESH_MS = 24 * 3600 * 1000;
// A link the server could not read is asked about again after this.
const RETRY_MS = 5 * 60 * 1000;
const MAX_KEPT = 1000;
// The server takes at most 20 links a request.
const BATCH = 20;

export const isMegaLink = (url) => MEGA.test(String(url || ''));

export function formatSize(bytes) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let n = Number(bytes) || 0, i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (i === 0 || n >= 100 ? Math.round(n) : n.toFixed(1)) + ' ' + units[i];
}

const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

// request(urls) -> {info: {[url]: {kind, name, size, files, folders} | {error}}}
export function createLinkInfo({ request }) {
    let kept = {};
    try { kept = JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch (e) { /* none kept */ }
    const save = () => {
        const urls = Object.keys(kept);
        if (urls.length > MAX_KEPT) {
            urls.sort((a, b) => kept[a].at - kept[b].at);
            for (const url of urls.slice(0, urls.length - MAX_KEPT)) delete kept[url];
        }
        try { localStorage.setItem(STORE, JSON.stringify(kept)); } catch (e) { /* full: kept for this page only */ }
    };
    const waiting = new Map(); // url -> anchors to draw when its answer comes
    const queued = new Set();
    const pending = new Set(); // queued or on the way
    const asked = new Map(); // url -> when it was last asked about
    let timer = null;

    function draw(anchor, url, info) {
        let tag = anchor.nextElementSibling;
        if (!tag || !tag.classList.contains('link-size')) {
            tag = document.createElement('span');
            tag.className = 'link-size';
            anchor.after(tag);
        }
        if (info.error === 'gone') {
            tag.textContent = 'gone from MEGA';
            tag.classList.add('link-gone');
            anchor.title = `This link no longer opens anything on MEGA.\n${url}`;
            return;
        }
        if (!info.name) { tag.remove(); return; }
        anchor.textContent = info.name;
        tag.textContent = formatSize(info.size);
        tag.classList.remove('link-gone');
        const inside = info.kind === 'folder'
            ? plural(info.files || 0, 'file') + (info.folders ? ' in ' + plural(info.folders + 1, 'folder') : '')
            : 'File';
        anchor.title = `${info.name}\n${inside} on MEGA · ${formatSize(info.size)}\n${url}`;
    }

    async function flush() {
        timer = null;
        const urls = [...queued];
        queued.clear();
        for (let i = 0; i < urls.length; i += BATCH) {
            const chunk = urls.slice(i, i + BATCH);
            let answers = {};
            try { answers = (await request(chunk)).info || {}; } catch (e) { /* asked again after RETRY_MS */ }
            for (const url of chunk) {
                const info = answers[url];
                if (info && info.error !== 'failed') kept[url] = { ...info, at: Date.now() };
                for (const anchor of waiting.get(url) || []) if (info && anchor.isConnected) draw(anchor, url, info);
                waiting.delete(url);
                pending.delete(url);
            }
            save();
        }
    }

    function decorate(anchor, url) {
        if (!isMegaLink(url)) return;
        const known = kept[url];
        if (known) draw(anchor, url, known);
        if (known && Date.now() - known.at < FRESH_MS) return;
        if (!pending.has(url)) {
            if (Date.now() - (asked.get(url) || 0) < RETRY_MS) return;
            asked.set(url, Date.now());
            pending.add(url);
            queued.add(url);
            if (!timer) timer = setTimeout(flush, 50);
        }
        if (!waiting.has(url)) waiting.set(url, new Set());
        waiting.get(url).add(anchor);
    }

    return { decorate };
}
