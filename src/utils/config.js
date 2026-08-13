// Deployment defaults.
//
// EDIT THIS ONE LINE if your sync server moves. It is the address every client
// falls back to, so nobody has to type a URL into a settings box.
//
// The PWA ignores this entirely — it is served *by* the sync server, so it
// defaults to its own origin and is always correct. This constant exists for
// the extension, which has no way to know where your server lives.
export const DEFAULT_SERVER_URL = 'https://bookmarks.apsonater.win';

// A saved URL still wins, so changing servers doesn't need a code edit — but
// with nothing saved you get the line above rather than an empty box.
export function resolveServerUrl(saved) {
    const trimmed = String(saved || '').trim();
    return (trimmed || DEFAULT_SERVER_URL).replace(/\/$/, '');
}
