// Entry point for the full-screen app page.
//
// sidepanel.js is loaded first and still owns most views; Notes has its own
// module (notesView.js). This starts home and Notes, and keeps home in step
// with the other views. Home hides whenever another section opens, which is
// how the side panel already behaved — one section at a time — just with room
// to breathe.
import { initHome } from './home.js';
import { initNotesView, canLeave, saveLiveDraft } from './notesView.js';
import { TreeStore } from '../utils/treeStore.js';
import { ExpandState } from '../utils/expandState.js';
import { listenForUpdate } from '../utils/pageMessages.js';
import { downloadBackup } from '../utils/backup.js';

// An update is about to reload this page: write the working copy, the open
// cards and the open note's unsaved text first.
listenForUpdate(() => Promise.allSettled([TreeStore.flush(), ExpandState.flush(), saveLiveDraft()]));

// The extension is moving into the server's web app. Until the move, say so
// above every view: push before updating, and keep a backup. Dismissed per
// device; Settings › Backup stays.
const MOVING_DISMISSED_KEY = 'tp_moving_banner_dismissed_v1';

function initMovingBanner() {
    const banner = document.getElementById('tp-moving-banner');
    if (!banner) return;
    let dismissed = false;
    try { dismissed = Boolean(window.localStorage.getItem(MOVING_DISMISSED_KEY)); } catch (e) { /* show it */ }
    if (dismissed) return;
    banner.hidden = false;
    const unpushed = document.getElementById('tp-moving-unpushed');
    const paint = () => {
        const st = TreeStore.status();
        if (unpushed) unpushed.textContent = st.dirty ? `You have ${st.editCount} unpushed edit${st.editCount === 1 ? '' : 's'}.` : '';
    };
    TreeStore.load().then(paint).catch(() => {});
    TreeStore.onChanged(paint);
    const backupBtn = document.getElementById('tp-moving-backup');
    backupBtn?.addEventListener('click', async () => {
        backupBtn.disabled = true;
        try {
            await downloadBackup({
                api: globalThis.browser || globalThis.chrome,
                prepare: () => Promise.allSettled([TreeStore.flush(), saveLiveDraft()])
            });
        } catch (e) {
            window.alert('Backup failed: ' + e.message);
        } finally {
            backupBtn.disabled = false;
        }
    });
    document.getElementById('tp-moving-dismiss')?.addEventListener('click', () => {
        try { window.localStorage.setItem(MOVING_DISMISSED_KEY, new Date().toISOString()); } catch (e) { /* hidden for now */ }
        banner.hidden = true;
    });
}

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
// Leaving Notes with an unsaved note asks first (save, discard, or stay).
async function goHome() {
    const notes = document.getElementById('notes-container');
    const inNotes = notes && notes.style.display !== 'none' && notes.style.display !== '';
    if (inNotes && !(await canLeave())) return;
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
        initNotesView();
    } catch (e) {
        console.error('[TabPaladin] Notes failed to start', e);
    }
    try {
        await initHome();
    } catch (e) {
        console.error('[TabPaladin] Home failed to start', e);
    }
    watchViews();
    document.getElementById('tp-home-link')?.addEventListener('click', goHome);
    try {
        initMovingBanner();
    } catch (e) {
        console.error('[TabPaladin] The moving notice failed to start', e);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}
