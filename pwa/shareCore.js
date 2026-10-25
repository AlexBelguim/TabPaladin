// The share sheet's pure core, shared three ways: the service worker loads it
// with importScripts, the page with a <script> before app.js, and the node
// tests evaluate it with new Function. So: a classic script, no DOM, no
// modules, nothing global but self.TPShare.
//
//   extractShare      the link, title and app in what a share target received
//   cleanUrl          tracking parameters off, host by host
//   dedupeKey         one key for the same link however it was written
//   appOf / appLabel  which app a link belongs to ('x', 'youtube', 'site:bbc.co.uk')
//   makeEntry         an outbox entry for a share
//   cacheOutbox       the outbox in Cache Storage (tp-outbox), shared by the
//                     worker and the page; localOutbox is the page's fallback
//   flushOutbox       upload what waits, file what was chosen
//   mergeIntent       the folders chosen for a share, tap after tap
//   indexFolders      the tree's folders a link can be filed into
//   suggest           the chips for an app; searchFolders for the picker
//   applyOps          fold the server's logged appends into a working copy

(function (root) {
    'use strict';

    // --- Links -----------------------------------------------------------------

    // Characters a link found in running text never ends with, and the
    // closing brackets it ends with only when it opened them.
    const TRAILING = new Set(['.', ',', ';', ':', '!', '?', "'", '"', '»', '…', '”', '’', '>', '。', '、', '，']);
    const PAIRS = { ')': '(', ']': '[', '}': '{', '>': '<', '）': '（', '」': '「', '』': '『', '】': '【' };
    // A link in running text: an apostrophe may be inside it (Ender's_Game,
    // /maps/place/Joe's+Pizza) and is trimmed only at its end; it stops at
    // CJK text and at full-width or CJK punctuation, which share texts put
    // straight after it ('.../AbC' then '，复制本条信息').
    const URL_RE = /https?:\/\/[^\s<>"`\u00a0\u2028\u2029\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]+/gi;
    const BARE_RE = /^(?:www\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,24}(?::\d{2,5})?(?:[/?#]\S*)?$/i;

    function count(s, ch) {
        let n = 0;
        for (const c of s) if (c === ch) n++;
        return n;
    }

    function trimLink(link) {
        let s = link;
        for (let guard = 0; guard < 64 && s.length; guard++) {
            const last = s[s.length - 1];
            if (TRAILING.has(last)) { s = s.slice(0, -1); continue; }
            if (s.endsWith('...')) { s = s.slice(0, -3); continue; }
            const open = PAIRS[last];
            if (open && count(s, last) > count(s, open)) { s = s.slice(0, -1); continue; }
            break;
        }
        return s;
    }

    function parseHttp(s) {
        try {
            const u = new URL(s);
            return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
        } catch (e) {
            return null;
        }
    }

    // Every http(s) link in a piece of text, in order, trimmed.
    function linksIn(text) {
        const out = [];
        const s = String(text || '');
        URL_RE.lastIndex = 0;
        let m;
        while ((m = URL_RE.exec(s))) {
            const link = trimLink(m[0]);
            if (parseHttp(link)) out.push({ link, at: m.index });
        }
        return out;
    }

    // A whole field that is a scheme-less 'host.tld/path'.
    function bareLink(text) {
        const s = String(text || '').trim();
        if (!s || /\s/.test(s) || !BARE_RE.test(s)) return null;
        const u = parseHttp('https://' + s);
        return u ? 'https://' + s : null;
    }

    // --- Hosts and apps ----------------------------------------------------------

    const hostOf = (u) => u.hostname.toLowerCase().replace(/\.$/, '');
    // Without a www., m. or mobile. subdomain — never one that is part of the
    // site's own name (mobile.de, m.me).
    const bare = (host) => {
        const b = host.replace(/^(?:www|m|mobile)\./, '');
        return b.length >= registrableDomain(host).length ? b : host;
    };
    const on = (host, domain) => host === domain || host.endsWith('.' + domain);

    // Two-label public suffixes common enough to matter: bbc.co.uk is the
    // site, not co.uk.
    const SECOND_LEVEL = new Set([
        'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk', 'ltd.uk', 'plc.uk',
        'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
        'co.nz', 'org.nz', 'net.nz', 'govt.nz',
        'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
        'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in',
        'com.br', 'net.br', 'org.br', 'gov.br',
        'com.mx', 'org.mx', 'gob.mx',
        'co.za', 'org.za', 'gov.za',
        'com.cn', 'net.cn', 'org.cn', 'gov.cn',
        'com.tw', 'org.tw', 'com.hk', 'org.hk', 'co.kr', 'or.kr',
        'com.sg', 'com.my', 'com.tr', 'com.ar', 'com.co', 'com.pe', 'com.ph',
        'co.il', 'org.il', 'co.id', 'or.id', 'co.th', 'in.th', 'com.vn', 'com.ua',
        'com.pl', 'com.es', 'com.pt', 'co.at', 'or.at', 'com.be'
    ]);

    function registrableDomain(host) {
        const h = String(host || '').toLowerCase().replace(/\.$/, '');
        if (!h || /^\d+(\.\d+){3}$/.test(h) || h.includes(':')) return h;
        const labels = h.split('.');
        if (labels.length <= 2) return h;
        const two = labels.slice(-2).join('.');
        return SECOND_LEVEL.has(two) ? labels.slice(-3).join('.') : two;
    }

    // [app, label, test(host, url)] — first match wins.
    const APPS = [
        ['x', 'X', (h) => ['x.com', 'twitter.com', 't.co', 'fxtwitter.com', 'vxtwitter.com', 'fixupx.com', 'fixvx.com'].some(d => on(h, d))],
        ['youtube', 'YouTube', (h) => on(h, 'youtube.com') || on(h, 'youtu.be') || on(h, 'youtube-nocookie.com')],
        ['reddit', 'Reddit', (h) => on(h, 'reddit.com') || on(h, 'redd.it')],
        ['instagram', 'Instagram', (h) => on(h, 'instagram.com') || on(h, 'instagr.am')],
        ['tiktok', 'TikTok', (h) => on(h, 'tiktok.com')],
        ['github', 'GitHub', (h) => on(h, 'github.com') || on(h, 'github.io')],
        ['facebook', 'Facebook', (h) => on(h, 'facebook.com') || on(h, 'fb.watch') || on(h, 'fb.com')],
        ['linkedin', 'LinkedIn', (h) => on(h, 'linkedin.com') || on(h, 'lnkd.in')],
        ['threads', 'Threads', (h) => on(h, 'threads.net') || on(h, 'threads.com')],
        ['bluesky', 'Bluesky', (h) => on(h, 'bsky.app')],
        ['spotify', 'Spotify', (h) => on(h, 'spotify.com') || on(h, 'spotify.link')],
        ['pinterest', 'Pinterest', (h) => /(^|\.)pinterest\.[a-z.]+$/.test(h) || on(h, 'pin.it')],
        ['maps', 'Google Maps', (h, u) => on(h, 'maps.app.goo.gl') || h === 'maps.google.com' || /(^|\.)maps\.google\.[a-z.]+$/.test(h)
            || (/(^|\.)google\.[a-z.]+$/.test(h) && u.pathname.startsWith('/maps')) || (h === 'goo.gl' && u.pathname.startsWith('/maps'))],
        ['amazon', 'Amazon', (h) => /(^|\.)amazon\.[a-z.]+$/.test(h) || on(h, 'amzn.to') || on(h, 'amzn.eu') || on(h, 'a.co')],
        ['hackernews', 'Hacker News', (h) => h === 'news.ycombinator.com'],
        ['medium', 'Medium', (h) => on(h, 'medium.com')],
        ['wikipedia', 'Wikipedia', (h) => on(h, 'wikipedia.org')],
        ['twitch', 'Twitch', (h) => on(h, 'twitch.tv')]
    ];
    const LABELS = Object.fromEntries(APPS.map(([app, label]) => [app, label]));

    function appOf(url) {
        const u = parseHttp(String(url || ''));
        if (!u) return 'site:unknown';
        const h = hostOf(u);
        for (const [app, , test] of APPS) if (test(h, u)) return app;
        const site = 'site:' + registrableDomain(h);
        return /^[a-z0-9:._-]{1,80}$/.test(site) ? site : 'site:unknown';
    }

    function appLabel(app) {
        if (LABELS[app]) return LABELS[app];
        const s = String(app || '');
        return s.startsWith('site:') ? s.slice(5) : s;
    }

    const isKnownApp = (app) => Boolean(LABELS[app]);

    // --- Cleaning and keys -----------------------------------------------------------

    // Parameters a share sheet adds that say who shared it, not what it is.
    const PARAMS_BY_APP = {
        x: ['s', 't', 'ref_src', 'ref_url'],
        youtube: ['si', 'feature', 'pp'],
        spotify: ['si', 'context'],
        instagram: ['igsh', 'igshid'],
        reddit: ['share_id', 'rdt'],
        tiktok: ['_r', '_t']
    };
    const EVERYWHERE = (k) => k.startsWith('utm_') || k === 'fbclid' || k === 'gclid' || k === 'mc_eid';

    // The query without the dropped parameters, the rest exactly as written.
    function keepParams(search, drop) {
        const q = search.replace(/^\?/, '');
        if (!q) return '';
        const kept = q.split('&').filter((pair) => {
            if (!pair) return false;
            let key = pair.split('=')[0];
            try { key = decodeURIComponent(key.replace(/\+/g, ' ')); } catch (e) { /* keep as written */ }
            return !drop(key.toLowerCase());
        });
        return kept.length ? '?' + kept.join('&') : '';
    }

    // Only the query changes, and only when something is dropped: a link with
    // nothing to drop comes back exactly as it was written.
    function cleanUrl(url) {
        const u = parseHttp(String(url || ''));
        if (!u) return url;
        const own = PARAMS_BY_APP[appOf(u.href)] || [];
        const search = keepParams(u.search, (k) => EVERYWHERE(k) || own.includes(k));
        if (search === u.search) return String(url);
        u.search = search;
        return u.href;
    }

    // The same link, however it was written: scheme, www./m./mobile., a
    // trailing slash, tracking parameters and a fragment that only scrolls
    // (#section) are ignored; one that routes (#/item/1, #!/item, Gmail's
    // #inbox/ID) is part of the page and kept. twitter.com is x.com and a
    // post is its id; youtu.be/ID and /shorts/ID are watch?v=ID.
    function dedupeKey(url) {
        const u = parseHttp(cleanUrl(String(url || '')));
        if (!u) return String(url || '').trim().toLowerCase();
        let host = bare(hostOf(u));
        let path = u.pathname;
        let search = u.search;
        const app = appOf(u.href);
        if (app === 'x') {
            host = 'x.com';
            const m = path.match(/\/status(?:es)?\/(\d+)/);
            if (m) { path = '/status/' + m[1]; search = ''; }
        } else if (app === 'youtube') {
            let id = null;
            if (on(host, 'youtu.be')) id = path.split('/')[1] || null;
            else if (path === '/watch') id = u.searchParams.get('v');
            else { const m = path.match(/^\/(?:shorts|live|embed)\/([^/?#]+)/); if (m) id = m[1]; }
            if (id) { host = 'youtube.com'; path = '/watch'; search = '?v=' + id; }
        }
        if (path.length > 1) path = path.replace(/\/+$/, '');
        const route = /^#!|^#[^#]*\//.test(u.hash) ? u.hash : '';
        return host + (path === '/' ? '' : path) + search + route;
    }

    // --- What was shared --------------------------------------------------------------

    const collapse = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const stripEdges = (s) => s.replace(/^[\s\-–—:|·•,;，、：；]+|[\s\-–—:|·•,;，、：；]+$/g, '').trim();
    // What taking a link out of running text leaves behind: the brackets or
    // quotes it sat in, and punctuation standing on its own.
    const tidy = (s) => String(s || '')
        .replace(/[([{（「『【]\s*[)\]}）」』】]/g, ' ')
        .replace(/"\s*"|'\s*'|“\s*”|‘\s*’|«\s*»/g, ' ')
        .replace(/(^|\s)[.,;:!?…)\]}>»"'”’]+(?=\s|$)/g, ' ');

    // A title for a link that came with none.
    function fallbackTitle(url, app) {
        const u = parseHttp(url);
        if (!u) return '';
        const parts = u.pathname.split('/').filter(Boolean);
        if (app === 'x' && parts[1] === 'status' && parts[0] !== 'i') return `Post by @${parts[0]} on X`;
        if (app === 'instagram' && parts.length >= 2 && /^(p|reel|reels|tv)$/.test(parts[1])) return `Post by @${parts[0]} on Instagram`;
        if (app === 'instagram' && /^(p|reel|reels|tv)$/.test(parts[0] || '')) return 'Instagram post';
        if (app === 'reddit' && parts[0] === 'r' && parts[1]) return `Post in r/${parts[1]}`;
        if (app === 'youtube') return 'YouTube video';
        if (app === 'tiktok' && parts[0] && parts[0].startsWith('@')) return `TikTok by ${parts[0]}`;
        if (app === 'github' && parts.length >= 2) return `${parts[0]}/${parts[1]} on GitHub`;
        if (isKnownApp(app)) return `${appLabel(app)} link`;
        let page = parts.length ? parts[parts.length - 1] : '';
        try { page = decodeURIComponent(page); } catch (e) { /* as written */ }
        page = page.replace(/[-_+]+/g, ' ').replace(/\.\w{2,5}$/, '').trim();
        return page && !/^[\d\s]+$/.test(page) && page.length <= 80 ? `${page} — ${bare(hostOf(u))}` : bare(hostOf(u));
    }

    // The link, title and app in {title, text, url} as a share target got
    // them. The link is the url field when the whole of it is an http(s) URL
    // (taken as written: it is no running text), else the first http(s) URL
    // in url, then text, then title (or a whole field that is a bare
    // 'host.tld/path'); further links go to `others`. The title is the
    // subject, else the text with the link taken out, else one made from the
    // link. No link: url is null and the text is kept, for Save as note.
    function extractShare(fields) {
        const f = {
            title: String((fields && fields.title) || ''),
            text: String((fields && fields.text) || ''),
            url: String((fields && fields.url) || '')
        };
        const found = [];
        for (const key of ['url', 'text', 'title']) {
            const whole = key === 'url' ? f.url.trim() : '';
            if (whole && !/\s/.test(whole) && parseHttp(whole)) { found.push({ link: whole, at: 0, key }); continue; }
            for (const hit of linksIn(f[key])) found.push({ ...hit, key });
        }
        if (!found.length) {
            for (const key of ['url', 'text', 'title']) {
                const b = bareLink(f[key]);
                if (b) { found.push({ link: b, at: 0, key, bare: f[key].trim() }); break; }
            }
        }
        if (!found.length) {
            return { url: null, rawUrl: null, title: collapse(f.title), text: f.text, others: [], app: null, urlKey: null };
        }
        const first = found[0];
        const url = cleanUrl(first.link);
        const app = appOf(url);
        const seen = new Set([dedupeKey(url)]);
        const others = [];
        for (const h of found.slice(1)) {
            const c = cleanUrl(h.link);
            const k = dedupeKey(c);
            if (seen.has(k)) continue;
            seen.add(k);
            others.push(c);
        }
        // A field with its links taken out: what is left is words.
        const words = (key) => {
            let rest = f[key];
            let took = false;
            for (const h of found) {
                if (h.key !== key) continue;
                rest = rest.split(h.bare || h.link).join(' ');
                took = true;
            }
            const t = stripEdges(collapse(took ? tidy(rest) : rest));
            return t && !parseHttp(t) && !bareLink(t) ? t : '';
        };
        let title = words('title');
        if (!title) title = words('text');
        if (!title) title = fallbackTitle(url, app);
        return { url, rawUrl: first.link, title: title.slice(0, 1000), text: f.text, others, app, urlKey: dedupeKey(url) };
    }

    // --- Ids --------------------------------------------------------------------------

    function newSid() {
        const bytes = new Uint8Array(16);
        (root.crypto || globalThis.crypto).getRandomValues(bytes);
        let s = '';
        for (const b of bytes) s += String.fromCharCode(b);
        return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    // --- Accounts ---------------------------------------------------------------------

    const trim = (u) => String(u || '').replace(/\/+$/, '');
    const nameKey = (n) => String(n || '').normalize('NFKC').toLowerCase();

    // The account a share was captured under, from the config the app
    // mirrors: {url, userId, username, serverId}, or null when nobody was
    // signed in.
    function accountOf(cfg) {
        if (!cfg || !cfg.url || !cfg.token) return null;
        return {
            url: trim(cfg.url),
            userId: cfg.userId === undefined || cfg.userId === null || cfg.userId === '' ? null : Number(cfg.userId),
            username: cfg.username || null,
            serverId: cfg.serverId || null
        };
    }

    // Is `account` (an entry's) the one `cfg` is signed in as? The same
    // server address, the same id where both know it (else the same name),
    // and the same server id where both know it. Never true for a share
    // captured while nobody was signed in: that one is offered, not sent.
    function sameAccount(account, cfg) {
        const now = accountOf(cfg);
        if (!account || !now || trim(account.url) !== now.url) return false;
        if (account.serverId && now.serverId && account.serverId !== now.serverId) return false;
        if (account.userId !== null && account.userId !== undefined && now.userId !== null) return Number(account.userId) === now.userId;
        return Boolean(account.username) && nameKey(account.username) === nameKey(now.username);
    }

    // --- The outbox -------------------------------------------------------------------
    //
    // One entry per share, written before anything touches the network:
    //   {v, sid, createdAt, account, fields:{title,text,url}, url, rawUrl,
    //    title, text, app, urlKey, others, source,
    //    uploaded, share, archived,          set once the server has it
    //    file:{targets, folders, title, labels, at} | null,  folders chosen
    //                                         and not filed yet
    //    later, dismiss,                      what to do once it is uploaded
    //    attempts, lastError:{status, message, at, failed?, permanent} | null}
    // Each writer changes only its own fields, through update(), which reads
    // the entry again just before writing; in one page or worker those reads
    // and writes never interleave. A tap adds its folders to `file` (never
    // replaces what an earlier tap chose), and a filing takes out only the
    // folders it sent: one chosen meanwhile stays, and goes next. An entry
    // goes once everything chosen is filed, a dismiss or Later is confirmed
    // by the server, or a day after it was uploaded with nothing chosen (the
    // server's copy waits in the inbox).

    const OUTBOX_CACHE = 'tp-outbox';
    const OUTBOX_PREFIX = '/__tp_share/';
    const UPLOADED_TTL_MS = 24 * 3600 * 1000;
    // The most folders the server files into at once; more go in turns.
    const MAX_TARGETS = 16;

    function phaseOf(e) {
        if (!e) return null;
        if (e.lastError && e.lastError.permanent) return 'error';
        if (!e.uploaded) return 'new';
        return e.file ? 'fileQueued' : 'uploaded';
    }

    function makeEntry({ fields, account = null, source = 'share', sid = newSid(), now = new Date() }) {
        const x = extractShare(fields);
        return {
            v: 1,
            sid,
            createdAt: now.toISOString(),
            account,
            fields: {
                title: String((fields && fields.title) || ''),
                text: String((fields && fields.text) || ''),
                url: String((fields && fields.url) || '')
            },
            url: x.url, rawUrl: x.rawUrl, title: x.title, text: x.text, others: x.others,
            app: x.app, urlKey: x.urlKey, source,
            uploaded: false, share: null, archived: null,
            file: null, later: false, dismiss: false,
            attempts: 0, lastError: null, phase: 'new'
        };
    }

    const stamp = (e) => ({ ...e, phase: phaseOf(e) });

    // A share taken over by the account signed in now (a yes to "Upload to
    // …"): new for it. Whatever another account's server or tree made of it —
    // its upload there, a folder choice in that tree — stays behind.
    function claimEntry(e, account) {
        return {
            ...e, account, uploaded: false, uploadedAt: null, share: null, archived: null,
            file: null, dismiss: false, attempts: 0, lastError: null
        };
    }

    // --- Folders chosen for a share ---------------------------------------------------
    //
    // file = {targets: [{folderId} | {newFolder, existing?}, each with its
    // label], folders: [the never-pushed ancestors they need], title, labels,
    // at}. A target's key is its folder id, or the new folder's.

    const targetKey = (t) => (t && (t.folderId || (t.newFolder && t.newFolder.id))) || null;
    const intentKeys = (intent) => ((intent && intent.targets) || []).map(targetKey).filter(Boolean);

    function shapeIntent(targets, folders, rest) {
        if (!targets.length) return null;
        const keep = new Set(targets.map(t => t.newFolder && t.newFolder.id).filter(Boolean));
        for (const t of targets) {
            // A new folder's never-pushed ancestors, and theirs.
            let parent = t.newFolder && t.newFolder.parentId;
            for (let hops = 0; parent && hops < 64; hops++) {
                const f = folders.find(x => x.id === parent);
                if (!f) break;
                keep.add(f.id);
                parent = f.parentId;
            }
        }
        return {
            ...rest,
            targets,
            folders: folders.filter(f => keep.has(f.id)),
            labels: targets.map(t => t.label).filter(Boolean)
        };
    }

    // What an earlier choice and a new one ask for together: every folder of
    // both, once, the new title, the new time.
    function mergeIntent(prev, next) {
        if (!prev || !prev.targets || !prev.targets.length) return next || null;
        if (!next) return prev;
        const targets = [];
        const seen = new Set();
        for (const t of [...prev.targets, ...(next.targets || [])]) {
            const k = targetKey(t);
            if (!k || seen.has(k)) continue;
            seen.add(k);
            targets.push(t);
        }
        const folders = [];
        for (const f of [...(prev.folders || []), ...(next.folders || [])]) {
            if (f && f.id && !folders.some(x => x.id === f.id)) folders.push(f);
        }
        return shapeIntent(targets, folders, { title: next.title || prev.title, at: next.at || prev.at });
    }

    // The choice without the folders a filing sent, or null when that was all.
    function withoutTargets(intent, sent) {
        if (!intent || !intent.targets) return null;
        const gone = new Set((sent || []).map(targetKey));
        return shapeIntent(intent.targets.filter(t => !gone.has(targetKey(t))), intent.folders || [], { title: intent.title, at: intent.at });
    }

    // Over Cache Storage, which the worker and the page share. Within one of
    // them, every change runs on its own: a read for an update and its write
    // never have another change in between.
    function cacheOutbox(cachesImpl) {
        const open = () => cachesImpl.open(OUTBOX_CACHE);
        const keyFor = (sid) => OUTBOX_PREFIX + encodeURIComponent(sid);
        const pathOf = (k) => {
            const s = typeof k === 'string' ? k : k.url;
            try { return s.startsWith('/') ? s : new URL(s).pathname; } catch (e) { return s; }
        };
        let queue = Promise.resolve();
        const serial = (fn) => {
            const run = queue.then(fn, fn);
            queue = run.catch(() => {});
            return run;
        };
        const read = async (sid) => {
            const c = await open();
            const hit = await c.match(keyFor(sid));
            if (!hit) return null;
            try { return await hit.json(); } catch (e) { return null; }
        };
        const write = async (entry) => {
            const c = await open();
            const e = stamp(entry);
            await c.put(keyFor(e.sid), new Response(JSON.stringify(e), { headers: { 'Content-Type': 'application/json' } }));
            return e;
        };
        const drop = async (sid) => (await open()).delete(keyFor(sid));
        const box = {
            put: (entry) => serial(() => write(entry)),
            get: (sid) => read(sid),
            async list() {
                const c = await open();
                const out = [];
                for (const k of await c.keys()) {
                    if (!pathOf(k).startsWith(OUTBOX_PREFIX)) continue;
                    const hit = await c.match(k);
                    if (!hit) continue;
                    try { out.push(await hit.json()); } catch (e) { /* unreadable: skip */ }
                }
                return out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
            },
            update: (sid, patch) => serial(async () => {
                const cur = await read(sid);
                if (!cur) return null;
                const next = typeof patch === 'function' ? patch(cur) : { ...cur, ...patch };
                return next ? write(next) : cur;
            }),
            // fn(entry) -> the entry to keep, or null to take it out. Returns
            // what was kept, or null.
            settle: (sid, fn) => serial(async () => {
                const cur = await read(sid);
                if (!cur) return null;
                const next = fn(cur);
                if (next) return write(next);
                await drop(sid);
                return null;
            }),
            remove: (sid) => serial(() => drop(sid))
        };
        return box;
    }

    // Over localStorage, for a page without Cache Storage (an http origin).
    // The worker never runs there, so nothing else writes it.
    function localOutbox(storage, key = 'tp_outbox') {
        const read = () => {
            try {
                const all = JSON.parse(storage.getItem(key) || '{}');
                return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
            } catch (e) {
                return {};
            }
        };
        const write = (all) => {
            if (Object.keys(all).length) storage.setItem(key, JSON.stringify(all));
            else storage.removeItem(key);
        };
        const box = {
            async put(entry) { const all = read(); const e = stamp(entry); all[e.sid] = e; write(all); return e; },
            async get(sid) { return read()[sid] || null; },
            async list() { return Object.values(read()).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))); },
            async update(sid, patch) {
                const all = read();
                const cur = all[sid];
                if (!cur) return null;
                const next = typeof patch === 'function' ? patch(cur) : { ...cur, ...patch };
                if (!next) return cur;
                all[sid] = stamp(next);
                write(all);
                return all[sid];
            },
            async settle(sid, fn) {
                const all = read();
                const cur = all[sid];
                if (!cur) return null;
                const next = fn(cur);
                if (next) all[sid] = stamp(next);
                else delete all[sid];
                write(all);
                return next ? all[sid] : null;
            },
            async remove(sid) { const all = read(); const had = sid in all; delete all[sid]; write(all); return had; }
        };
        return box;
    }

    // --- Talking to the server -----------------------------------------------------------

    class Stop extends Error {
        constructor(kind, message) { super(message); this.kind = kind; }
    }

    // One JSON request with a timeout that holds even against a fetch that
    // never answers and ignores its signal.
    async function send(fetchImpl, cfg, method, path, body, timeoutMs) {
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        let timer = null;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => {
                if (ctrl) ctrl.abort();
                reject(new Stop('network', 'The server did not answer in time.'));
            }, timeoutMs);
        });
        try {
            const res = await Promise.race([fetchImpl(trim(cfg.url) + path, {
                method,
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: ctrl ? ctrl.signal : undefined
            }), timeout]);
            let json = null;
            try { json = await Promise.race([res.json(), timeout]); } catch (e) { if (e instanceof Stop) throw e; }
            return { status: res.status, ok: res.ok, json };
        } catch (e) {
            if (e instanceof Stop) throw e;
            throw new Stop('network', e && e.message ? e.message : 'Network error');
        } finally {
            clearTimeout(timer);
        }
    }

    const errorOf = (r, extra = {}) => ({
        status: r.status,
        message: (r.json && r.json.error) || `HTTP ${r.status}`,
        at: new Date().toISOString(),
        // A refusal that sending again will not change. 429 (a full inbox)
        // and 5xx are worth another try later.
        permanent: r.status >= 400 && r.status < 500 && r.status !== 429 && r.status !== 408,
        ...extra
    });

    // What the share target received goes up with the link, as context the
    // server keeps to 10 KB: its text is cut first, then its subject, by
    // UTF-8 bytes (3,500 CJK characters are over it), never half a character.
    const RAW_BYTES = 9 * 1024;
    const utf8Bytes = (s) => (typeof TextEncoder !== 'undefined'
        ? new TextEncoder().encode(s).length : unescape(encodeURIComponent(s)).length);

    function fitRaw(raw, limit = RAW_BYTES) {
        const size = (o) => utf8Bytes(JSON.stringify(o));
        if (size(raw) <= limit) return raw;
        const o = { ...raw };
        for (const key of ['text', 'title']) {
            const chars = Array.from(String(o[key] || ''));
            let lo = 0;
            let hi = chars.length;
            while (lo < hi) {
                const mid = Math.ceil((lo + hi) / 2);
                if (size({ ...o, [key]: chars.slice(0, mid).join('') }) <= limit) lo = mid;
                else hi = mid - 1;
            }
            o[key] = chars.slice(0, lo).join('');
            if (size(o) <= limit) return o;
        }
        return undefined;
    }

    // The account the phone kept the share for: the server refuses (412) to
    // take it in or change it under any other, whatever token is sent.
    const expected = (e) => ({
        expectUserId: e.account && e.account.userId !== null && e.account.userId !== undefined ? e.account.userId : undefined,
        expectServerId: (e.account && e.account.serverId) || undefined
    });

    function intakeBody(e) {
        return {
            sid: e.sid, url: e.url, title: e.title || '', app: e.app || undefined, urlKey: e.urlKey || undefined,
            source: e.source || 'share', ...expected(e),
            raw: fitRaw({ title: e.fields.title, text: e.fields.text, url: e.rawUrl || e.fields.url })
        };
    }

    // Two flushes in one context never send the same entry at once; the
    // worker and the page may, and the server's idempotency on sid and on
    // (share, folder) makes that harmless.
    const inFlight = new Set();
    const idleWaiters = new Map();

    // Resolves once no flush of this context holds the share.
    function whenIdle(sid) {
        if (!inFlight.has(sid)) return Promise.resolve();
        return new Promise((resolve) => {
            if (!idleWaiters.has(sid)) idleWaiters.set(sid, []);
            idleWaiters.get(sid).push(resolve);
        });
    }

    const busy = (sid) => inFlight.has(sid);

    // Upload what waits and carry out what was chosen, for the account `cfg`
    // is signed in as only. Stops at a 401 (signed out), a 412 (the session is
    // another account's) or a network failure, all of which leave every entry
    // as it was. A share the server refused for good is not sent again unless
    // asked for by its id (a tap, Retry). Returns {uploaded:[sid],
    // filed:[{sid, result}] (a share may be filed in turns), removed:[sid],
    // failed:[{sid, error}], skipped:[sid], stopped: null|'auth'|'account'|
    // 'network'|'signed-out'}.
    async function flushOutbox({ outbox, cfg, fetch: fetchImpl, timeoutMs = 6000, sids = null, now = Date.now }) {
        const out = { uploaded: [], filed: [], removed: [], failed: [], skipped: [], stopped: null };
        if (!cfg || !cfg.url || !cfg.token) { out.stopped = 'signed-out'; return out; }
        const want = sids ? new Set(sids) : null;
        let entries;
        try { entries = await outbox.list(); } catch (e) { out.stopped = 'storage'; return out; }
        const stopOn = (r) => {
            if (r.status === 401) throw new Stop('auth', 'Signed out');
            if (r.status === 412) throw new Stop('account', 'This share belongs to another account.');
        };
        for (const listed of entries) {
            if (want && !want.has(listed.sid)) continue;
            if (!listed.url || !sameAccount(listed.account, cfg) || inFlight.has(listed.sid)) { out.skipped.push(listed.sid); continue; }
            const refused = !listed.uploaded && listed.lastError && listed.lastError.permanent;
            if (refused && !want) { out.skipped.push(listed.sid); continue; }
            inFlight.add(listed.sid);
            try {
                let e = await outbox.get(listed.sid);
                if (!e) continue;
                if (!e.uploaded) {
                    const r = await send(fetchImpl, cfg, 'POST', '/api/shares', intakeBody(e), timeoutMs);
                    stopOn(r);
                    if (!r.ok) {
                        e = await outbox.update(e.sid, (c) => ({ ...c, attempts: (c.attempts || 0) + 1, lastError: errorOf(r) }));
                        out.failed.push({ sid: listed.sid, error: e.lastError });
                        continue;
                    }
                    e = await outbox.update(e.sid, (c) => ({
                        ...c, uploaded: true, uploadedAt: new Date(now()).toISOString(),
                        share: r.json.share, archived: r.json.archived || null, lastError: null
                    }));
                    out.uploaded.push(listed.sid);
                    // Discarded on the phone while it went up: nothing more to do.
                    if (!e) continue;
                }
                if (e.file) {
                    // In turns of MAX_TARGETS folders, and then whatever was
                    // chosen while they were on their way.
                    let reupload = false;
                    let refusedHere = false;
                    for (let turn = 0; e && e.file && turn < 16; turn++) {
                        const ask = e.file;
                        const batch = ask.targets.slice(0, MAX_TARGETS);
                        const ref = (e.share && e.share.sid) || e.sid;
                        const r = await send(fetchImpl, cfg, 'POST', `/api/shares/${encodeURIComponent(ref)}/file`, {
                            targets: batch.map(({ label, ...t }) => t), folders: (ask.folders || []).slice(0, MAX_TARGETS),
                            title: ask.title || e.title || undefined, url: ask.url || undefined, app: e.app || undefined, ...expected(e)
                        }, timeoutMs);
                        stopOn(r);
                        if (r.status === 404) {
                            // The server has no such share (any more): upload it again.
                            await outbox.update(e.sid, (c) => ({ ...c, uploaded: false, share: null }));
                            out.failed.push({ sid: e.sid, error: errorOf(r, { permanent: false }) });
                            reupload = true;
                            break;
                        }
                        if (!r.ok) {
                            const failed = (r.json && r.json.failed) || null;
                            // None of those folders can take it (422), or the
                            // request is one the server will never take: that
                            // choice goes, saying why. Anything else (a 5xx)
                            // keeps it for the next try.
                            const final = r.status === 422 || errorOf(r).permanent;
                            e = await outbox.update(e.sid, (c) => ({
                                ...c, file: final ? withoutTargets(c.file, batch) : c.file, lastError: errorOf(r, { failed, permanent: false })
                            }));
                            out.failed.push({ sid: listed.sid, error: e ? e.lastError : errorOf(r, { failed }) });
                            refusedHere = true;
                            if (!final) break;
                            continue;
                        }
                        out.filed.push({ sid: e.sid, result: r.json });
                        // Only what was sent is done: a folder chosen meanwhile
                        // (another tap here, or the worker) stays, and goes next.
                        e = await outbox.settle(e.sid, (c) => {
                            const rest = withoutTargets(c.file, batch);
                            return rest ? { ...c, file: rest, share: r.json.share || c.share, lastError: null } : null;
                        });
                        if (!e) out.removed.push(listed.sid);
                    }
                    if (reupload || refusedHere || !e || e.file) continue;
                }
                if (e.dismiss) {
                    const ref = (e.share && e.share.sid) || e.sid;
                    const r = await send(fetchImpl, cfg, 'POST', `/api/shares/${encodeURIComponent(ref)}/dismiss`, { ...expected(e) }, timeoutMs);
                    stopOn(r);
                    if (r.ok || r.status === 404) { await outbox.remove(e.sid); out.removed.push(e.sid); }
                    continue;
                }
                if (e.later || now() - Date.parse(e.uploadedAt || e.createdAt) > UPLOADED_TTL_MS) {
                    await outbox.remove(e.sid);
                    out.removed.push(e.sid);
                }
            } catch (err) {
                if (err instanceof Stop) {
                    out.stopped = err.kind;
                    if (err.kind === 'network') {
                        try { await outbox.update(listed.sid, (c) => ({ ...c, attempts: (c.attempts || 0) + 1, lastError: { status: 0, message: err.message, at: new Date().toISOString(), permanent: false } })); } catch (e2) { /* kept as it was */ }
                    }
                    break;
                }
                out.failed.push({ sid: listed.sid, error: { status: 0, message: String(err && err.message || err), permanent: false } });
            } finally {
                inFlight.delete(listed.sid);
                const waiting = idleWaiters.get(listed.sid);
                if (waiting) { idleWaiters.delete(listed.sid); waiting.forEach(fn => fn()); }
            }
        }
        return out;
    }

    // --- The tree, as the share sheet sees it ------------------------------------------

    // Roles whose folders are the app's own, not places to file a link.
    const NOT_TARGETS = new Set(['notes', 'workflows', 'pins']);
    // Browser roots nobody files into (the same list the app hides).
    const NOISE = new Set([
        'trash', 'prullenbak', 'papierkorb', 'corbeille',
        'speed dials', 'speeddial', 'pinboard', 'unsynchronized pinboard',
        'imported bookmarks', 'geïmporteerde bladwijzers'
    ]);

    // Every folder a link can be filed into, from wire-format roots
    // ({id, kind, title, url, role, children, virtual}), in tree order:
    // {id, title, parentId, path:[titles], pathIds, depth, role, directCount,
    //  apps:{app: n}, order}. Leaves out the imports archive, notes,
    // workflows, pins and noise roots, with everything under them.
    function indexFolders(roots) {
        const folders = new Map();
        const list = [];
        const byKey = new Map();
        const marks = new Map();
        let bookmarksRootId = null;
        const appFolders = {};
        const walk = (node, parent, depth) => {
            if (!node || node.kind !== 'folder' || node.virtual || node.readOnly) return;
            const id = String(node.id || '');
            if (!id || id.startsWith('imp:') || id === 'imports:root') return;
            if (node.role && NOT_TARGETS.has(node.role)) return;
            if (depth === 0 && NOISE.has(String(node.title || '').toLowerCase().trim())) return;
            const title = String(node.title || '');
            const f = {
                id, title,
                parentId: parent ? parent.id : null,
                path: parent ? [...parent.path, title] : [title],
                pathIds: parent ? [...parent.pathIds, id] : [id],
                depth, role: node.role || null, directCount: 0, apps: {}, order: list.length
            };
            if (node.role === 'bookmarks' && !bookmarksRootId) bookmarksRootId = id;
            // An app's own folder (payload.app): its subfolders are that app's chips.
            const ownApp = node.payload && typeof node.payload.app === 'string' ? node.payload.app : null;
            if (ownApp && !appFolders[ownApp]) appFolders[ownApp] = id;
            folders.set(id, f);
            list.push(f);
            for (const c of node.children || []) {
                if (c && c.kind === 'bookmark' && c.url && !c.virtual) {
                    f.directCount++;
                    const app = appOf(c.url);
                    f.apps[app] = (f.apps[app] || 0) + 1;
                    const key = dedupeKey(c.url);
                    if (!byKey.has(key)) byKey.set(key, []);
                    if (!byKey.get(key).includes(id)) byKey.get(key).push(id);
                    if (!marks.has(key)) marks.set(key, []);
                    marks.get(key).push({ folderId: id, id: String(c.id), url: c.url });
                } else if (c && c.kind === 'folder') {
                    walk(c, f, depth + 1);
                }
            }
        };
        for (const r of roots || []) walk(r, null, 0);
        return {
            folders, list, bookmarksRootId, appFolders,
            // The folders already holding this link.
            holding: (urlKey) => (byKey.get(urlKey) || []).map(id => folders.get(id)).filter(Boolean),
            // The bookmarks of this link in one folder: [{id, url}].
            marksIn: (urlKey, folderId) => (marks.get(urlKey) || []).filter(m => m.folderId === folderId).map(({ id, url }) => ({ id, url }))
        };
    }

    // A folder's place for a chip or a row: its parent path without the
    // Bookmarks root, middle-truncated past three parts ('AI › … › Research').
    function parentPath(folder, index, { max = 3 } = {}) {
        if (!folder) return '';
        let parts = folder.path.slice(0, -1);
        if (index && folder.pathIds[0] === index.bookmarksRootId) parts = parts.slice(1);
        if (parts.length > max) parts = [parts[0], '…', ...parts.slice(-(max - 1))];
        return parts.join(' › ');
    }

    function fullPath(folder, index) {
        if (!folder) return '';
        const parts = index && folder.pathIds[0] === index.bookmarksRootId && folder.path.length > 1 ? folder.path.slice(1) : folder.path;
        return parts.join(' › ');
    }

    const clampSlots = (n) => Math.min(8, Math.max(2, Number(n) || 4));
    const newest = (a, b) => String(b.last || '').localeCompare(String(a.last || ''));

    // Folders filed into recently, from any app, newest first.
    function recentFolders(stats) {
        const last = new Map();
        for (const list of Object.values((stats && stats.apps) || {})) {
            for (const s of list || []) {
                if (!last.has(s.folderId) || String(s.last) > String(last.get(s.folderId))) last.set(s.folderId, s.last);
            }
        }
        return [...last.entries()].map(([folderId, l]) => ({ folderId, last: l })).sort(newest);
    }

    // The chips for links from `app`:
    //   0. the subfolders of its own folder (YouTube › Food, Music…), or that
    //      folder itself while it has none;
    //   1. its pinned folders, in pin order;
    //   2. the folder last used for it;
    //   3. the folders holding the most of its links (ties: the latest
    //      filing, then the shorter path), and those it was filed into;
    //   4. empty slots: folders used recently for anything, tagged 'recent';
    //      with no filing history at all, the biggest folders.
    // Never a hidden folder, nor one not in the index (notes, workflows,
    // pins, the archive, deleted). A first link from an app (nothing pinned,
    // filed or counted) comes with a starter: the app's own new folder in
    // Bookmarks for a known app (or its existing namesake as a chip), '+ New
    // folder…' for a site.
    function suggest(app, { index, prefs = null, stats = null, slots = null } = {}) {
        let n = clampSlots(slots ?? (prefs && prefs.slots));
        const ap = (prefs && prefs.apps && prefs.apps[app]) || {};
        const hidden = new Set(ap.hidden || []);
        const chips = [];
        const seen = new Set();
        const room = (reserve = 0) => chips.length < n - reserve;
        const add = (id, reason, extra = {}, reserve = 0) => {
            if (!room(reserve) || seen.has(id) || hidden.has(id) || !index.folders.has(id)) return false;
            seen.add(id);
            chips.push({ folderId: id, reason, ...extra });
            return true;
        };
        const appStats = ((stats && stats.apps && stats.apps[app]) || []).filter(s => index.folders.has(s.folderId));
        const lastFor = new Map(appStats.map(s => [s.folderId, s.last]));
        const counted = index.list.filter(f => (f.apps[app] || 0) > 0);
        const pinned = (ap.pinned || []).filter(id => index.folders.has(id) && !hidden.has(id));
        const own = index.appFolders && index.appFolders[app];
        const ownSubs = own ? index.list.filter(f => f.parentId === own) : [];
        const firstTime = !own && !pinned.length && !appStats.length && !counted.length;
        if (own) {
            // Room for every subfolder (up to the 8-chip limit) and one more.
            n = clampSlots(Math.max(n, ownSubs.length + 1));
            for (const f of ownSubs.length ? ownSubs : [index.folders.get(own)]) add(f.id, 'app');
        }

        let starter = null;
        let reserve = 0;
        if (firstTime) {
            const label = appLabel(app);
            const namesake = isKnownApp(app)
                ? index.list.find(f => f.title.trim().toLowerCase() === label.toLowerCase() && !hidden.has(f.id))
                : null;
            if (namesake) add(namesake.id, 'named');
            else {
                starter = isKnownApp(app)
                    ? { kind: 'app-folder', title: label, parentId: index.bookmarksRootId }
                    : { kind: 'new-folder' };
                reserve = 1;
            }
        }
        for (const id of pinned) add(id, 'pinned', {}, reserve);
        const last = appStats.slice().sort(newest)[0];
        if (last) add(last.folderId, 'last', { last: last.last }, reserve);
        counted.sort((a, b) => (b.apps[app] - a.apps[app])
            || String(lastFor.get(b.id) || '').localeCompare(String(lastFor.get(a.id) || ''))
            || (a.path.length - b.path.length) || (a.order - b.order));
        for (const f of counted) add(f.id, 'count', { count: f.apps[app] }, reserve);
        for (const s of appStats.slice().sort((a, b) => (b.n - a.n) || newest(a, b))) add(s.folderId, 'count', { count: s.n }, reserve);
        const recent = recentFolders(stats).filter(r => index.folders.has(r.folderId));
        for (const r of recent) add(r.folderId, 'recent', { last: r.last }, reserve);
        if (!recent.length) {
            const biggest = index.list.filter(f => f.directCount > 0)
                .sort((a, b) => (b.directCount - a.directCount) || (a.path.length - b.path.length) || (a.order - b.order));
            for (const f of biggest) add(f.id, 'biggest', { count: f.directCount }, reserve);
        }
        return { chips, firstTime, starter, slots: n };
    }

    // The picker's search: every word must appear somewhere in the folder's
    // full path; folders whose own name holds them come first, then by how
    // many words the name holds, then the shorter path. Ranges are where the
    // words are in the name, for highlighting.
    function searchFolders(index, q, { limit = 50 } = {}) {
        const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
        if (!words.length) return [];
        const hits = [];
        for (const f of index.list) {
            const title = f.title.toLowerCase();
            const hay = f.path.join(' › ').toLowerCase();
            if (!words.every(w => hay.includes(w))) continue;
            const inTitle = words.filter(w => title.includes(w)).length;
            const ranges = [];
            for (const w of words) {
                const at = title.indexOf(w);
                if (at >= 0) ranges.push([at, at + w.length]);
            }
            hits.push({ folder: f, inTitle, all: inTitle === words.length, ranges: ranges.sort((a, b) => a[0] - b[0]) });
        }
        hits.sort((a, b) => (Number(b.all) - Number(a.all)) || (b.inTitle - a.inTitle)
            || (a.folder.path.length - b.folder.path.length) || (a.folder.order - b.folder.order));
        return hits.slice(0, limit);
    }

    // --- Folding the server's appends into a working copy ----------------------------
    //
    // `ops` as GET /api/tree/ops gives them, applied in order through an
    // adapter over whatever shape the copy has:
    //   find(id) -> node | null, kindOf(node), urlOf(node), childCount(node),
    //   insert(parentNode | null, {id, kind, title, url?, payload?}) -> node
    //   (at the end), remove(node), fallbackParent() -> node | null (the
    //   Bookmarks root).
    // An append inserts each node whose id is missing; a folder with no
    // parent (one a phone made at the top level) goes at the top level; one
    // whose parent is gone here goes to the end of the Bookmarks root and
    // counts as relocated, so a later push cannot drop it. A node's payload
    // (a saved workflow's {createdAt}) comes along: dropping it here would
    // erase it for every device at the next push. An unappend removes a node
    // only while it is still that bookmark (same URL) or an empty folder.
    function applyOps(ops, a) {
        const out = { applied: 0, relocated: 0, removed: 0, skipped: 0 };
        for (const op of ops || []) {
            if (op.kind === 'append') {
                for (const n of (op.payload && op.payload.nodes) || []) {
                    if (!n || !n.id || a.find(n.id)) { out.skipped++; continue; }
                    const topLevel = n.kind === 'folder' && (n.parentId === null || n.parentId === undefined || n.parentId === '');
                    let parent = n.parentId ? a.find(n.parentId) : null;
                    if (!topLevel && (!parent || a.kindOf(parent) !== 'folder')) {
                        parent = a.fallbackParent();
                        out.relocated++;
                    }
                    const spec = { id: n.id, kind: n.kind === 'folder' ? 'folder' : 'bookmark', title: String(n.title || ''), url: n.url };
                    if (n.payload && typeof n.payload === 'object' && !Array.isArray(n.payload)) spec.payload = JSON.parse(JSON.stringify(n.payload));
                    a.insert(parent, spec);
                    out.applied++;
                }
            } else if (op.kind === 'unappend') {
                for (const it of (op.payload && op.payload.items) || []) {
                    const node = it && it.id ? a.find(it.id) : null;
                    if (!node) continue;
                    const same = it.kind === 'bookmark'
                        ? a.kindOf(node) === 'bookmark' && a.urlOf(node) === it.url
                        : a.kindOf(node) === 'folder' && a.childCount(node) === 0;
                    if (!same) continue;
                    a.remove(node);
                    out.removed++;
                }
            }
        }
        return out;
    }

    // The adapter over wire-format roots ({id, kind, title, url, role, children}).
    function wireAdapter(roots) {
        const parents = new Map();
        const nodes = new Map();
        const walk = (list, parent) => {
            for (const n of list) {
                nodes.set(n.id, n);
                parents.set(n.id, parent);
                if (n.children) walk(n.children, n);
            }
        };
        walk(roots, null);
        return {
            find: (id) => nodes.get(id) || null,
            kindOf: (n) => n.kind,
            urlOf: (n) => n.url,
            childCount: (n) => (n.children || []).length,
            insert(parent, spec) {
                const node = { id: spec.id, kind: spec.kind, title: spec.title };
                if (spec.kind === 'bookmark') node.url = spec.url;
                else node.children = [];
                if (spec.payload) node.payload = spec.payload;
                const siblings = parent ? (parent.children = parent.children || []) : roots;
                siblings.push(node);
                nodes.set(node.id, node);
                parents.set(node.id, parent);
                return node;
            },
            remove(node) {
                const parent = parents.get(node.id);
                const siblings = parent ? parent.children : roots;
                const i = siblings.indexOf(node);
                if (i >= 0) siblings.splice(i, 1);
                nodes.delete(node.id);
                parents.delete(node.id);
            },
            fallbackParent: () => [...nodes.values()].find(n => n.kind === 'folder' && n.role === 'bookmarks') || null
        };
    }

    root.TPShare = {
        extractShare, cleanUrl, dedupeKey, appOf, appLabel, isKnownApp, registrableDomain, fallbackTitle, linksIn,
        newSid, accountOf, sameAccount,
        makeEntry, claimEntry, phaseOf, cacheOutbox, localOutbox, flushOutbox, whenIdle, busy, OUTBOX_CACHE, OUTBOX_PREFIX, UPLOADED_TTL_MS,
        makeIntent: (targets, folders = [], rest = {}) => shapeIntent(targets || [], folders || [], rest),
        mergeIntent, withoutTargets, intentKeys, targetKey, fitRaw, MAX_TARGETS,
        indexFolders, parentPath, fullPath, recentFolders, suggest, searchFolders,
        applyOps, wireAdapter
    };
})(typeof self !== 'undefined' ? self : globalThis);
