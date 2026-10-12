// Where the sync server lives.
//
// There is deliberately no built-in default: the server is self-hosted, so
// its address is whatever each user typed into Settings. The PWA ignores this
// entirely — it is served *by* the sync server and defaults to its own origin.
export function resolveServerUrl(saved) {
    return String(saved || '').trim().replace(/\/$/, '');
}
