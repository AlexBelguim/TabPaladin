// Manual sources — archives that are captured rather than swept.
//
// X has no free API since February 2026, and Instagram has no route to a
// personal saved or liked list at all: Basic Display shut down in December 2024
// and the Graph API only exposes saves as an aggregate insight on Business
// accounts. Neither can be fetched, so neither gets an adapter.
//
// What does work is the Android share sheet. Share a post to TabPaladin and it
// lands here, in the same archive as the swept sources, with the same folder
// layout and the same protections. It only ever holds what you deliberately
// shared — there is no backfill of anything you liked before — but from that
// point it grows exactly like the Reddit archive does.

const PROVIDERS = [
    {
        provider: 'x',
        label: 'X saved',
        hosts: ['x.com', 'twitter.com', 'mobile.twitter.com', 'mobile.x.com'],
        // https://x.com/<user>/status/<id>
        id: (u) => {
            const m = u.pathname.match(/\/status\/(\d+)/);
            return m ? 'x:' + m[1] : null;
        },
        // The handle is the closest thing to Reddit's subreddit — it is what
        // makes a wall of archived links scannable months later.
        container: (u) => {
            const m = u.pathname.match(/^\/([^/]+)\/status\//);
            return m && m[1] !== 'i' ? m[1] : null;
        }
    },
    {
        provider: 'instagram',
        label: 'Instagram saved',
        hosts: ['instagram.com', 'www.instagram.com'],
        // https://www.instagram.com/p|reel|tv/<shortcode>/
        id: (u) => {
            const m = u.pathname.match(/\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
            return m ? 'ig:' + m[2] : null;
        },
        container: (u) => {
            const m = u.pathname.match(/^\/([^/]+)\/(p|reel|reels|tv)\//);
            return m ? m[1] : null;
        }
    }
];

export function providerLabel(provider) {
    const p = PROVIDERS.find(x => x.provider === provider);
    return p ? p.label : provider;
}

export function isManualProvider(provider) {
    return PROVIDERS.some(p => p.provider === provider);
}

export function manualProviders() {
    return PROVIDERS.map(p => ({ provider: p.provider, label: p.label }));
}

// Share sheets append tracking junk — X adds ?t=&s=, Instagram adds ?igsh=.
// Left alone it would defeat de-duplication: the same post shared twice would
// arrive as two different URLs. The fragment goes for the same reason.
function cleanUrl(u) {
    const copy = new URL(u.href);
    copy.search = '';
    copy.hash = '';
    // Trailing slash is cosmetic but has to be consistent to dedupe on.
    copy.pathname = copy.pathname.replace(/\/+$/, '') || '/';
    return copy.toString();
}

// Work out which archive a shared link belongs in. Returns null for anything
// that is not one of the manual sources, which the caller treats as "put it in
// the normal inbox instead".
export function classify(rawUrl) {
    let u;
    try {
        u = new URL(String(rawUrl));
    } catch (e) {
        return null;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const match = PROVIDERS.find(p => p.hosts.some(h => h.replace(/^www\./, '') === host));
    if (!match) return null;

    const url = cleanUrl(u);
    return {
        provider: match.provider,
        label: match.label,
        // Fall back to the cleaned URL when the path is not a recognisable post
        // — a profile link, say. Still worth keeping, still de-duplicated.
        externalId: match.id(u) || 'url:' + url,
        url,
        container: match.container(u)
    };
}
