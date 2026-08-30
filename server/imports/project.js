// The imports subtree, built at read time.
//
// The archive's only home is the import_items table. When a client pulls the
// tree, the server appends this virtual, read-only subtree to the response —
// it is never stored, so there is nothing to reconcile, nothing to eject, and
// no stale device can damage it. Removing or filing an item happens through
// explicit /api/imports/:id/items verbs instead of being inferred from what a
// pushed tree no longer contains.

export const IMPORTS_ROOT_ID = 'imports:root';
export const IMPORTS_ROOT_TITLE = 'TabPaladin Imports';

const PROVIDER_FOLDER = {
    reddit: 'Reddit',
    x: 'X',
    instagram: 'Instagram'
};

export function providerFolderTitle(provider) {
    return PROVIDER_FOLDER[provider] || provider;
}

// Whatever that platform calls the thing a post belongs to. It is what makes a
// wall of archived links scannable, so it is worth spelling natively rather
// than prefixing everything with Reddit's convention.
const CONTAINER_PREFIX = {
    reddit: (c) => `r/${c}`,
    x: (c) => `@${c}`,
    instagram: (c) => `@${c}`
};

// Bookmark titles carry it so the archive stays readable once it is thousands
// of entries deep and the folder name alone tells you nothing.
export function titleFor(item, provider) {
    const base = item.title || item.url;
    const fmt = CONTAINER_PREFIX[provider];
    const prefix = item.container && fmt ? `${fmt(item.container)} — ` : '';
    const full = prefix + base;
    // Chrome starts truncating in the middle around here, and an over-long title
    // makes the PWA list unreadable well before that.
    return full.length > 180 ? full.slice(0, 177) + '…' : full;
}

// One provider's subtree: a single <Provider> folder of bookmarks. Item ids
// are `imp:<sourceId>:<externalId>` so a client can hand them straight back to
// the delete/file verbs.
export function buildProviderFolder({ source, items }) {
    const provider = source.provider;

    // Flat: the items sit directly in the provider folder.
    //
    // They used to be nested <Provider>/<List>/<YYYY-MM>/, which put four
    // levels between you and fifteen links. The month grouping earned its keep
    // when the folder was written into the bookmark tree and had to be stable
    // across rebuilds; the subtree is composed fresh on every read now, so the
    // grouping only costs clicks. Newest first, which is the order the months
    // were approximating anyway.
    return {
        id: `imp:src:${source.id}`,
        kind: 'folder',
        title: providerFolderTitle(provider),
        virtual: true,
        children: items
            .slice()
            .sort((a, b) => String(b.created_utc || '').localeCompare(String(a.created_utc || '')))
            .map(item => ({
                id: `imp:${source.id}:${item.external_id}`,
                kind: 'bookmark',
                title: titleFor(item, provider),
                url: item.url,
                virtual: true
            }))
    };
}

// The whole virtual root, or null when there are no import sources at all —
// no point showing an empty managed folder to someone who never set imports up.
export function buildImportsTree(store) {
    const sources = store.listSources();
    if (!sources.length) return null;
    return {
        id: IMPORTS_ROOT_ID,
        kind: 'folder',
        title: IMPORTS_ROOT_TITLE,
        virtual: true,
        readOnly: true,
        children: sources.map(source => buildProviderFolder({
            source,
            // Filed items are excluded: the user moved a copy into their own
            // tree, and drawing it here too would show it twice.
            items: store.activeItemsFor(source.id)
        }))
    };
}
