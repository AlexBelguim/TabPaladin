// Entry point for the full-screen app page.
//
// sidepanel.js is loaded first and still owns every existing view; this only
// starts the home screen and keeps it in step with those views. Home hides
// whenever another section opens, which is how the side panel already behaved —
// one section at a time — just with room to breathe.
import { initHome } from './home.js';

const HOME_IDS = ['home-container', 'actions', 'home-recents'];
// Sections that take over the page when open.
const VIEW_IDS = [
    'organizer-source-container',
    'organizer-container',
    'workflows-container',
    'notes-container',
    'settings-container'
];

function anyViewOpen() {
    return VIEW_IDS.some((id) => {
        const el = document.getElementById(id);
        return el && el.style.display !== 'none' && el.style.display !== '';
    });
}

function syncHomeVisibility() {
    const hide = anyViewOpen();
    for (const id of HOME_IDS) {
        const el = document.getElementById(id);
        if (!el) continue;
        // #actions is the tile row — part of home, so it goes with it.
        el.style.display = hide ? 'none' : '';
    }
    const groups = document.getElementById('groups-container');
    if (groups && hide) groups.style.display = 'none';
}

function watchViews() {
    // sidepanel.js toggles these by writing style.display directly, so observing
    // the attribute is the least invasive way to react without editing it.
    const observer = new MutationObserver(syncHomeVisibility);
    for (const id of VIEW_IDS) {
        const el = document.getElementById(id);
        if (el) observer.observe(el, { attributes: true, attributeFilter: ['style'] });
    }
    syncHomeVisibility();
}

// The wordmark is the way back. Every view is a section sidepanel.js shows by
// writing style.display, so closing them all is what "go home" means here.
function goHome() {
    for (const id of VIEW_IDS) {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    }
    const groups = document.getElementById('groups-container');
    if (groups) groups.style.display = '';
    syncHomeVisibility();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    window.dispatchEvent(new CustomEvent('tabpaladin:home-refresh'));
}

async function boot() {
    try {
        await initHome();
    } catch (e) {
        console.error('[TabPaladin] Home failed to start', e);
    }
    watchViews();
    document.getElementById('tp-home-link')?.addEventListener('click', goHome);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}
