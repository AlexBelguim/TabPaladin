// Pinned links — the tiles on the home screen.
//
// Stored as plain bookmarks under a "TabPaladin Pinned" root, resolved through
// the same shared resolver as workflows and notes. Plain bookmarks, not the
// data: payloads notes use, because a pin *is* a URL — this way it still works
// if you open it straight from the browser's bookmark manager, and it rides the
// existing sync to the phone with no new plumbing.
import { StorageManager } from './storageManager.js';

const api = typeof browser !== 'undefined' ? browser : chrome;

const PINS_ROOT_TITLE = 'TabPaladin Pinned';
const PINS_ROOT_SETTINGS_KEY = 'pinsRootBookmarkId';

async function findPinsRoot() {
    return StorageManager.resolveRootFolder({
        title: PINS_ROOT_TITLE,
        settingsKey: PINS_ROOT_SETTINGS_KEY,
        create: false
    });
}

async function findOrCreatePinsRoot() {
    return StorageManager.resolveRootFolder({
        title: PINS_ROOT_TITLE,
        settingsKey: PINS_ROOT_SETTINGS_KEY,
        create: true
    });
}

// Host without the www, used as the tile's second line and to derive initials.
export function hostOf(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch (e) {
        return '';
    }
}

// Two letters from the title, or the host if the title is empty. Real favicons
// would mean either hotlinking each site — a request per tile, which tells
// those hosts what you have pinned — or Chrome's favicon service, which needs
// an extra permission and has no equivalent in the PWA.
export function initialsFor({ title, url }) {
    const source = (title || hostOf(url) || '?').trim();
    const words = source.split(/[\s._-]+/).filter(Boolean);
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
    return source.slice(0, 2).toUpperCase();
}

// Deterministic tile colour from the host, so a pin keeps its colour across
// devices and reorders. Hues avoid the 25-45 band, which collides with the
// amber used for warnings elsewhere in the UI.
export function colorFor(url) {
    const key = hostOf(url) || url || '';
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
    if (h > 25 && h < 45) h = (h + 60) % 360;
    return `hsl(${h} 55% 42%)`;
}

function toPin(node) {
    if (!node || !node.url) return null;
    // Root-identity bookkeeping, not something the user pinned.
    if (node.title === '__tabpaladin_root__') return null;
    return {
        id: node.id,
        title: node.title || hostOf(node.url) || node.url,
        url: node.url,
        host: hostOf(node.url)
    };
}

export const PinsManager = {
    PINS_ROOT_TITLE,

    // Never creates the root: an empty home screen shows the "Pin a link" tile,
    // and the folder appears the first time something is actually pinned.
    list: async () => {
        const root = await findPinsRoot();
        if (!root) return [];
        try {
            const children = await api.bookmarks.getChildren(root.id);
            return children.map(toPin).filter(Boolean);
        } catch (e) {
            console.warn('[TabPaladin] Failed to read pins', e);
            return [];
        }
    },

    add: async (url, title) => {
        const clean = String(url || '').trim();
        if (!clean) throw new Error('A pin needs a URL.');
        // Bare hostnames are what people actually type.
        const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(clean) ? clean : `https://${clean}`;
        try {
            // eslint-disable-next-line no-new
            new URL(withScheme);
        } catch (e) {
            throw new Error(`"${clean}" is not a URL.`);
        }

        const root = await findOrCreatePinsRoot();
        const existing = await api.bookmarks.getChildren(root.id);
        if (existing.some(c => c.url === withScheme)) {
            throw new Error('That link is already pinned.');
        }

        const node = await api.bookmarks.create({
            parentId: root.id,
            title: (title || '').trim() || hostOf(withScheme) || withScheme,
            url: withScheme
        });
        return toPin(node);
    },

    remove: async (id) => {
        await api.bookmarks.remove(id);
    },

    rename: async (id, title) => {
        const node = await api.bookmarks.update(id, { title: String(title || '').trim() });
        return toPin(node);
    },

    // index is the destination position within the pins root.
    move: async (id, index) => {
        const root = await findPinsRoot();
        if (!root) return null;
        const node = await api.bookmarks.move(id, { parentId: root.id, index });
        return toPin(node);
    }
};
