// Reddit adapter — OAuth2 plus a sweep of the saved listing.
//
// Why this exists at all: Reddit's listing endpoints stop paginating at 1000
// items. The saves themselves are not deleted, but /user/<name>/saved will only
// ever hand back the most recent 1000 and there is no page 1001. Sweeping on a
// schedule and never dropping what we have already seen is the only way to hold
// an archive that outgrows that window.

const OAUTH_BASE = 'https://oauth.reddit.com';
const WWW_BASE = 'https://www.reddit.com';

// 100 is the per-request maximum, 10 pages is the whole 1000-item window.
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

// Reddit throttles generic user agents hard, and the documented format is
// platform:app_id:version (by /u/username).
function userAgent(username) {
    const who = username ? ` (by /u/${username})` : '';
    return `web:tabpaladin-importer:v1.0${who}`;
}

export function authorizeUrl({ clientId, redirectUri, state }) {
    const params = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        state,
        redirect_uri: redirectUri,
        // Without permanent we only get a 1-hour token and the importer stops
        // working an hour after it is set up.
        duration: 'permanent',
        // Comma-separated, per Reddit's docs. identity to learn the username the
        // saved listing is keyed by, history for the listing itself.
        scope: 'identity,history'
    });
    return `${WWW_BASE}/api/v1/authorize?${params}`;
}

async function tokenRequest({ clientId, clientSecret, body, username }) {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await fetch(`${WWW_BASE}/api/v1/access_token`, {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${basic}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': userAgent(username)
        },
        body: new URLSearchParams(body).toString()
    });
    const text = await res.text();
    if (!res.ok) {
        throw new Error(`Reddit token request failed (${res.status}): ${text.slice(0, 300)}`);
    }
    let json;
    try { json = JSON.parse(text); } catch (e) {
        throw new Error(`Reddit token response was not JSON: ${text.slice(0, 200)}`);
    }
    if (json.error) throw new Error(`Reddit token request failed: ${json.error}`);
    return json;
}

export async function exchangeCode({ clientId, clientSecret, redirectUri, code }) {
    const json = await tokenRequest({
        clientId, clientSecret,
        body: { grant_type: 'authorization_code', code, redirect_uri: redirectUri }
    });
    if (!json.refresh_token) {
        // Almost always means duration=permanent was missing or the app is a
        // script-type app; without it the importer dies after an hour.
        throw new Error('Reddit did not return a refresh token — the app must be a "web app" and the request must use duration=permanent.');
    }
    return {
        refreshToken: json.refresh_token,
        accessToken: json.access_token,
        expiresAt: new Date(Date.now() + (json.expires_in || 3600) * 1000).toISOString()
    };
}

export async function refreshAccessToken({ clientId, clientSecret, refreshToken, username }) {
    const json = await tokenRequest({
        clientId, clientSecret, username,
        body: { grant_type: 'refresh_token', refresh_token: refreshToken }
    });
    return {
        accessToken: json.access_token,
        expiresAt: new Date(Date.now() + (json.expires_in || 3600) * 1000).toISOString()
    };
}

async function apiGet(path, { accessToken, username }) {
    const res = await fetch(`${OAUTH_BASE}${path}`, {
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'User-Agent': userAgent(username)
        }
    });
    if (res.status === 429) {
        const reset = res.headers.get('x-ratelimit-reset');
        throw new Error(`Reddit rate-limited the sweep (429)${reset ? `; retry in ${reset}s` : ''}.`);
    }
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Reddit ${path} failed (${res.status}): ${body.slice(0, 300)}`);
    }
    return res.json();
}

export async function whoami({ accessToken }) {
    const me = await apiGet('/api/v1/me', { accessToken });
    return me && me.name;
}

// A saved listing mixes posts (t3) and comments (t1). Both are worth keeping and
// both have a permalink, so both become bookmarks; the permalink is used as the
// URL rather than a link post's outbound target, because what was saved is the
// Reddit thread.
function normalize(child) {
    const kind = child && child.kind;
    const d = (child && child.data) || {};
    if (!d.name || !d.permalink) return null;

    const permalink = d.permalink.startsWith('http') ? d.permalink : `${WWW_BASE}${d.permalink}`;
    const createdUtc = d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null;

    if (kind === 't1') {
        // link_title is the thread the comment sits in, which is what makes a
        // saved comment recognisable months later; the body is the fallback.
        const snippet = (d.body || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        return {
            externalId: d.name,
            url: permalink,
            title: d.link_title || (snippet ? `Comment: ${snippet}` : 'Comment'),
            author: d.author || null,
            container: d.subreddit || null,
            createdUtc,
            extra: { kind: 'comment', body: (d.body || '').slice(0, 500) }
        };
    }

    return {
        externalId: d.name,
        url: permalink,
        title: d.title || '(untitled)',
        author: d.author || null,
        container: d.subreddit || null,
        createdUtc,
        extra: {
            kind: 'post',
            // Where a link post actually points, kept so nothing is lost even
            // though the bookmark targets the thread.
            linkUrl: d.url && d.url !== permalink ? d.url : undefined,
            over18: d.over_18 || undefined
        }
    };
}

// Walk the whole window every run rather than resuming from a cursor. Ten
// requests against a ~100/minute budget costs nothing, and a full sweep repairs
// itself after a failed run instead of leaving a permanent hole in the archive.
export async function fetchSaved({ accessToken, username, maxPages = MAX_PAGES }) {
    const items = [];
    const seen = new Set();
    let after = null;
    let pages = 0;

    while (pages < maxPages) {
        const params = new URLSearchParams({ limit: String(PAGE_SIZE), raw_json: '1' });
        if (after) params.set('after', after);

        const listing = await apiGet(`/user/${encodeURIComponent(username)}/saved?${params}`, { accessToken, username });
        const data = (listing && listing.data) || {};
        const children = data.children || [];
        pages++;

        for (const child of children) {
            const item = normalize(child);
            // Reddit will happily repeat an item across pages when the listing
            // shifts under us mid-sweep; the archive is keyed by external_id
            // anyway, but de-duping here keeps the "seen" set honest.
            if (item && !seen.has(item.externalId)) {
                seen.add(item.externalId);
                items.push(item);
            }
        }

        after = data.after || null;
        if (!after || children.length === 0) break;
    }

    // "complete" means we saw everything Reddit is willing to show, either
    // because the listing ended or because we hit its 1000-item ceiling. Both
    // are a trustworthy basis for deciding what is no longer in the listing; a
    // sweep cut short by an error is not, and never gets here.
    return { items, pages, complete: !after || pages >= maxPages };
}
