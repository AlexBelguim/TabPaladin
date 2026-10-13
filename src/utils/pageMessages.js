// Messages an extension page listens to.
//
// Every listener on an extension page takes a message only from this
// extension's own background or pages: the sender is this extension, and it
// is on the extension's own origin. A content script is this extension too,
// but it runs inside a web page and its sender.url is that page's address, so
// nothing a web page can make one say reaches a page here.
//
// Not !sender.tab: the app page runs in a tab, and its messages carry one.

const ext = () => globalThis.browser || globalThis.chrome;

export function isFromThisExtension(sender, runtime = ext().runtime) {
    if (!sender || !runtime || sender.id !== runtime.id) return false;
    const base = runtime.getURL('');
    return typeof sender.url === 'string' && sender.url.startsWith(base);
}

// The update handshake (see "Updates" in src/background/background.js): the
// browser has an update ready, and applying it will end this page. `prepare`
// writes what the page holds only in memory; once it has (or failed), the
// page says so with 'tp:update-ready' and the background may reload.
export function listenForUpdate(prepare, { runtime = ext().runtime } = {}) {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    const page = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!msg || msg.type !== 'tp:prepare-update' || !isFromThisExtension(sender, runtime)) return;
        Promise.resolve()
            .then(() => prepare())
            .catch((e) => console.warn('[TabPaladin] Could not save everything before the update', e))
            .then(() => {
                try { sendResponse({ ok: true }); } catch (e) { /* the channel closed */ }
                try {
                    const sent = runtime.sendMessage({ type: 'tp:update-ready', nonce: msg.nonce, page });
                    if (sent && typeof sent.catch === 'function') sent.catch(() => {});
                } catch (e) { /* the background is going anyway */ }
            });
        return true;
    });
}
