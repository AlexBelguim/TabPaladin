// P4, the move: what the old extension UI kept goes to the server's web app.
//
// Detect. On an update, and at any start that has not looked yet, every key
// the old UI kept is looked for: the working copy (tpTree), every set-aside
// copy (each 'tpTreeStash:' key, listed in tpTreeStashIndex or not), the
// removal queue, note drafts (live and mirrored), an unmigrated legacy
// 'workflows' array and its backup, and settings. Anything found sets
// tpMove {state: 'pending'} and a badge, and until the move is done the
// toolbar opens the move page (move.html). The old UI's page
// (src/app/app.html) only redirects there; its code stays packaged.
//
// Approve. The move page (an extension page: consent lives in UI this
// helper controls) records an approval for the web-app tab it opens at
// <origin>/#/move, valid for ten minutes.
//
// Hand-over. move.manifest (with a click, from the approved tab, whose
// document it binds), move.part (each part in 512 KiB chunks, with its
// SHA-256) and move.ack (once the web app has written every part). Parts are
// made on demand from storage, read under TreeStore's own locks, and only for
// the pinned server: the working copy and set-aside copies stamped for it or
// unstamped, their drafts, and device preferences. Copies stamped for
// another server never leave this browser. No token, password or key is in
// any part: they are built from named fields, and anything named like a
// secret is dropped on top of that.
//
// After the ack. deliveredTo[origin] is recorded, tracked workflow tabs of
// the copy that moved are retargeted to 'web', the toolbar opens the web app,
// and the background stops queueing removals for the old UI. Once the web app
// reports a signed-in session, the old UI's own session token is signed out
// and blanked; a token the server still accepts after that is its shared
// token, which is left exactly as it is. Nothing the old UI kept is deleted,
// so reinstalling 1.1.0 brings the old UI back over it.
(() => {
    'use strict';
    const H = globalThis.TPHelper;
    const api = H.api;
    const MOVE = 'tpMove';
    const APPROVAL = 'tpMoveApproval';
    const BUNDLE = 'tpMoveBundle';
    const LEGACY_LS = 'tpLegacyLocalStorage';
    const MOVE_PAGE = 'src/helper/move.html';
    const STASH_PREFIX = 'tpTreeStash:';
    const CHUNK = 512 * 1024;
    const MAX_PART = 64 * 1024 * 1024;
    const APPROVAL_MS = 10 * 60 * 1000;
    const SECRET_FIELD = /(token|password|secret|apikey)$/i;
    const now = () => Date.now();
    const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
    const plain = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
    const isUiKey = k => k.startsWith('__') || k.startsWith('aigroup:');
    const parse = raw => { try { return typeof raw === 'string' ? JSON.parse(raw) : null; } catch (_) { return null; } };
    function encode(bytes) {
        let out = '';
        for (let i = 0; i < bytes.length; i += 32768) out += String.fromCharCode(...bytes.subarray(i, i + 32768));
        return btoa(out);
    }
    // Anything named like a secret goes, at any depth. Keyword categories are
    // the user's own words, not field names.
    function scrub(value, depth = 0) {
        if (depth > 200) return null;
        if (Array.isArray(value)) return value.map(v => scrub(v, depth + 1));
        if (!plain(value)) return value;
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            if (SECRET_FIELD.test(k) || k === '__proto__') continue;
            out[k] = k === 'customKeywords' ? v : scrub(v, depth + 1);
        }
        return out;
    }
    const lock = (name, fn) => (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function'
        ? navigator.locks.request(name, () => fn()) : fn());
    // TreeStore's order: the working-copy lock, then the removal queue's.
    const underCopyLocks = fn => lock('tp-working-copy', () => lock('tp-pending-removals', fn));

    // --- State ----------------------------------------------------------------
    async function readMove() { return (await api.storage.local.get(MOVE))[MOVE] || null; }
    let moveChain = Promise.resolve();
    function updateMove(fn) {
        const run = moveChain.then(async () => {
            const cur = await readMove();
            const next = await fn(cur ? { ...cur } : null);
            if (next) await api.storage.local.set({ [MOVE]: next });
            return next || cur;
        });
        moveChain = run.catch(() => {});
        return run;
    }
    function paint(move) {
        H.moveBadge = move && move.state === 'pending' ? 'MOVE' : '';
        Promise.resolve(H.badge && H.badge()).catch(() => {});
        const action = api.action || api.browserAction;
        try {
            const set = action && action.setTitle && action.setTitle({ title: H.moveBadge ? 'Move TabPaladin into your web app' : 'Open TabPaladin' });
            if (set && set.catch) set.catch(() => {});
        } catch (_) { /* cosmetic */ }
    }
    H.moveDone = async () => (await readMove())?.state === 'done';

    // --- Detect ---------------------------------------------------------------
    async function allKeys() {
        if (typeof api.storage.local.getKeys === 'function') {
            try { return await api.storage.local.getKeys(); } catch (_) { /* older browser */ }
        }
        return Object.keys((await api.storage.local.get(null)) || {});
    }
    // Every set-aside copy: those the index lists, and any it lost. Listing
    // every key can mean reading all of storage (no getKeys), so the scan is
    // kept until a set-aside copy's key changes.
    let scanned = null;
    api.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && Object.keys(changes).some(k => k.startsWith(STASH_PREFIX))) scanned = null;
    });
    async function stashKeys() {
        const listed = (await api.storage.local.get('tpTreeStashIndex')).tpTreeStashIndex;
        const keys = new Set((Array.isArray(listed) ? listed : []).filter(k => typeof k === 'string' && k.startsWith(STASH_PREFIX)));
        if (!scanned) scanned = (await allKeys()).filter(k => typeof k === 'string' && k.startsWith(STASH_PREFIX));
        for (const k of scanned) keys.add(k);
        return [...keys];
    }
    const someData = v => Array.isArray(v) ? v.length > 0 : plain(v) ? Object.keys(v).length > 0 : v !== undefined && v !== null && v !== '';
    async function scan() {
        const data = await api.storage.local.get(['tpTree', 'tpTreeStashIndex', 'tpPendingRemovals', 'tpLiveDraft', 'tpParkedMirror',
            'workflows', 'tpMigrationDone', 'workflows_legacy_backup', 'settings']);
        const found = [];
        const tree = data.tpTree;
        if (tree && Array.isArray(tree.roots) && (tree.roots.length || tree.dirty)) found.push('tpTree');
        if (someData(data.tpTreeStashIndex)) found.push('tpTreeStashIndex');
        const keys = await stashKeys();
        const present = keys.length ? await api.storage.local.get(keys) : {};
        for (const k of keys) if (present[k]) found.push(k);
        for (const k of ['tpPendingRemovals', 'tpLiveDraft', 'tpParkedMirror', 'workflows_legacy_backup', 'settings']) if (someData(data[k])) found.push(k);
        if (Array.isArray(data.workflows) && data.workflows.length && !data.tpMigrationDone) found.push('workflows');
        return found;
    }
    // Once pending or done, it stays so: a done move is never taken back
    // because the old keys are still here (they always are).
    H.detectMove = ({ rescan = false } = {}) => updateMove(async (cur) => {
        if (cur && (cur.state === 'pending' || cur.state === 'done')) return null;
        if (cur && cur.state === 'none' && !rescan) return null;
        const found = await scan();
        return found.length
            ? { ...(cur || {}), v: 1, state: 'pending', detectedAt: now(), found }
            : { ...(cur || {}), v: 1, state: 'none', checkedAt: now() };
    }).then((move) => { paint(move); return move; });

    // --- Opening ----------------------------------------------------------------
    async function focusOrOpen(path) {
        const url = api.runtime.getURL(path);
        try {
            const tab = ((await api.tabs.query({ url })) || []).find(t => !t.incognito);
            if (tab) {
                await api.tabs.update(tab.id, { active: true });
                if (tab.windowId != null && api.windows) await api.windows.update(tab.windowId, { focused: true });
                return tab;
            }
        } catch (_) { /* open one */ }
        return api.tabs.create({ url });
    }
    H.openMovePage = () => focusOrOpen(MOVE_PAGE);
    // The toolbar: the move page until the move is done, then the web app
    // (its identity checked first), or helper Settings when there is none.
    H.toolbarClick = async () => {
        let move = await readMove();
        if (!move) move = await H.detectMove();
        if (!move || move.state === 'pending') return H.openMovePage();
        try {
            return await H.openWebApp('');
        } catch (error) {
            if (error && error.code === 'not-configured') return null; // openWebApp opened Settings
            return api.runtime.openOptionsPage();
        }
    };

    // --- Whose copy -------------------------------------------------------------
    // 'this': stamped for the pinned server (its address, and its signed id
    // where the stamp has one); 'this-moved': the pinned server at another
    // address — its signed id in the stamp, or, for a stamp without one, an
    // address that proved the pinned identity when the move was approved —
    // confirmed on the move page; 'unstamped': made while signed out
    // ('local') or from before accounts; 'other': anything else.
    function classify(owner, config, move = null) {
        if (!config || !config.serverOrigin || !config.pin) return 'unknown';
        if (plain(owner) && owner.url) {
            const sameOrigin = H.originOf(owner.url) === config.serverOrigin;
            if (owner.serverId) return owner.serverId !== config.pin.serverId ? 'other' : sameOrigin ? 'this' : 'this-moved';
            return sameOrigin ? 'this' : sameServerUrl(owner.url, config, move) ? 'this-moved' : 'other';
        }
        return 'unstamped';
    }
    const sends = cls => cls === 'this' || cls === 'this-moved' || cls === 'unstamped';
    // An unstamped copy's address is this server's: the same origin, or one
    // that proved the pinned identity when the move was approved.
    function sameServerUrl(url, config, move) {
        const o = H.originOf(url || '');
        return Boolean(o) && (o === config.serverOrigin || Boolean(move && plain(move.sameServer) && move.sameServer[o] === H.pinScope(config)));
    }
    function countItems(roots) {
        let n = 0;
        const stack = Array.isArray(roots) ? [...roots] : [];
        while (stack.length && n < 2000000) {
            const node = stack.pop();
            if (!node || node.virtual) continue;
            n++;
            if (Array.isArray(node.children)) for (const c of node.children) stack.push(c);
        }
        return n;
    }
    function nodeIds(roots) {
        const ids = new Set();
        const stack = Array.isArray(roots) ? [...roots] : [];
        while (stack.length) {
            const node = stack.pop();
            if (!node || node.virtual) continue;
            if (typeof node.id === 'string') ids.add(node.id);
            if (Array.isArray(node.children)) for (const c of node.children) stack.push(c);
        }
        return ids;
    }

    // --- What there is ------------------------------------------------------------
    async function inventory() {
        const keys = await stashKeys();
        const data = await api.storage.local.get(['tpTree', 'tpPendingRemovals', 'tpLiveDraft', 'tpParkedMirror', 'workflows',
            'tpMigrationDone', 'workflows_legacy_backup', 'settings', 'tpUiExpanded', LEGACY_LS, ...keys]);
        const stashes = keys.filter(k => plain(data[k]) && Array.isArray(data[k].roots)).map(k => ({ key: k, record: data[k] }));
        return { data, stashes };
    }
    function draftsOf(data) {
        const ls = plain(data[LEGACY_LS]) && plain(data[LEGACY_LS].keys) ? data[LEGACY_LS].keys : {};
        const valid = d => plain(d) && typeof d.content === 'string';
        const listed = parse(ls.tp_notes_parked_v1);
        const mirror = plain(data.tpParkedMirror) ? data.tpParkedMirror : {};
        const pages = plain(mirror.pages) ? Object.values(mirror.pages).filter(Array.isArray).flat() : [];
        return {
            parked: (Array.isArray(listed) ? listed : []).filter(valid),
            mirrored: [...(Array.isArray(mirror.drafts) ? mirror.drafts : []), ...pages].filter(valid),
            live: (plain(data.tpLiveDraft) ? Object.values(data.tpLiveDraft) : []).filter(valid)
        };
    }
    const settingsOf = data => (plain(data.settings) ? data.settings : {});
    const legacyUrlOf = data => {
        const backend = plain(settingsOf(data).backend) ? settingsOf(data).backend : {};
        return typeof backend.url === 'string' ? backend.url.trim() : '';
    };
    const keywordsOf = settings => (plain(settings.customKeywords)
        ? Object.fromEntries(Object.entries(settings.customKeywords).filter(([name, words]) => !['__proto__', 'constructor', 'prototype'].includes(name)
            && Array.isArray(words)).map(([name, words]) => [name, words.filter(w => typeof w === 'string')])) : {});

    // The parts for the pinned server, read in one go under TreeStore's locks.
    async function buildParts(config, move) {
        return underCopyLocks(async () => {
            const { data, stashes } = await inventory();
            const settings = settingsOf(data);
            const legacyUrl = legacyUrlOf(data);
            const parts = [];
            const add = (id, kind, payload) => parts.push({ id, kind, payload: { v: 1, part: id, ...payload } });
            const cards = plain(data.tpUiExpanded) && data.tpUiExpanded.v === 1 && plain(data.tpUiExpanded.cards) ? data.tpUiExpanded.cards : {};
            const card = v => plain(v) && (v.o === 0 || v.o === 1);
            const legacy = Array.isArray(data.workflows) && data.workflows.length && !data.tpMigrationDone ? scrub(data.workflows) : null;
            const removals = Array.isArray(data.tpPendingRemovals) ? data.tpPendingRemovals.map(String).slice(0, 100000) : [];
            const unstampedAt = url => ({ sameServer: sameServerUrl(url, config, move), legacyUrl: H.originOf(url || '') || null });
            const tree = plain(data.tpTree) && Array.isArray(data.tpTree.roots) ? data.tpTree : null;
            let workingSent = false;
            if (tree && sends(classify(tree.owner, config, move)) && (tree.roots.length || tree.dirty || removals.length || legacy)) {
                const ids = nodeIds(tree.roots);
                add('working', 'tree', {
                    class: classify(tree.owner, config, move),
                    ...(tree.owner ? { sameServer: null, legacyUrl: null } : unstampedAt(legacyUrl)),
                    record: scrub(tree),
                    pendingRemovals: removals,
                    legacyWorkflows: legacy,
                    focusedFolderIds: (Array.isArray(settings.focusedFolderIds) ? settings.focusedFolderIds : []).filter(id => typeof id === 'string' && ids.has(id)),
                    expanded: Object.fromEntries(Object.entries(cards).filter(([k, v]) => !isUiKey(k) && ids.has(k) && card(v)))
                });
                workingSent = true;
            }
            if (legacy && !workingSent) {
                // Workflows from before the tree belong to no account: an
                // unstamped copy of their own.
                add('workflows', 'tree', {
                    class: 'unstamped', ...unstampedAt(legacyUrl),
                    record: { roots: [], origin: 'pre-accounts', dirty: false, editCount: 0, baseVersion: 0 },
                    pendingRemovals: [], legacyWorkflows: legacy, focusedFolderIds: [], expanded: {}
                });
            }
            for (const { key, record } of stashes) {
                const cls = classify(record.owner, config, move);
                if (!sends(cls) || !(record.roots.length || record.dirty)) continue;
                add('stash:' + key, 'tree', {
                    class: cls, key,
                    ...(record.owner ? { sameServer: null, legacyUrl: null } : unstampedAt(record.url || legacyUrl)),
                    record: scrub(record)
                });
            }
            const drafts = draftsOf(data);
            const mine = list => list.filter(d => sends(classify(d.owner, config, move))).map(d => scrub(d));
            const moving = { parked: mine(drafts.parked), mirrored: mine(drafts.mirrored), live: mine(drafts.live) };
            if (moving.parked.length + moving.mirrored.length + moving.live.length) add('drafts', 'drafts', moving);
            const ls = plain(data[LEGACY_LS]) && plain(data[LEGACY_LS].keys) ? data[LEGACY_LS].keys : {};
            const accounts = parse(ls.tp_notes_ui_accounts_v1);
            const prefs = {
                customKeywords: keywordsOf(settings),
                categoryOrder: Array.isArray(settings.categoryOrder) ? settings.categoryOrder.filter(n => typeof n === 'string') : [],
                uiExpanded: Object.fromEntries(Object.entries(cards).filter(([k, v]) => isUiKey(k) && card(v))),
                notesUi: typeof ls.tp_notes_ui_v1 === 'string' ? ls.tp_notes_ui_v1 : null,
                // Notes view by account: those of this server, and the unstamped.
                notesUiAccounts: plain(accounts) ? Object.fromEntries(Object.entries(accounts).filter(([k, v]) => plain(v)
                    && (k === 'unstamped' || k === 'unstamped-local' || H.originOf(k.split('|')[0]) === config.serverOrigin))) : {}
            };
            if (Object.keys(prefs.customKeywords).length || prefs.categoryOrder.length || Object.keys(prefs.uiExpanded).length
                || prefs.notesUi || Object.keys(prefs.notesUiAccounts).length) add('prefs', 'prefs', prefs);
            return parts;
        });
    }
    async function encodeParts(parts) {
        const out = [];
        for (const p of parts) {
            const bytes = new TextEncoder().encode(JSON.stringify(p.payload));
            if (bytes.length > MAX_PART) {
                H.fail('too-large', 'One part of this browser\'s data is larger than 64 MiB. Use "Download a backup file" on the move page, then "Bring in an extension backup" in the web app\'s Settings.');
            }
            out.push({ id: p.id, kind: p.kind, bytes, digest: hex(await crypto.subtle.digest('SHA-256', bytes)) });
        }
        return out;
    }

    // --- Other addresses of this server ----------------------------------------
    // The old UI may have reached this server at another address (a LAN
    // address before a tunnel): its copies say so in their stamps. Such an
    // address counts as this server only while it proves the pinned identity
    // (signature and key); one that cannot be reached is asked again after a
    // while. Copies at an address that does not stay in this browser.
    function addressesOf(data, stashes) {
        const urls = [legacyUrlOf(data)];
        const tree = plain(data.tpTree) ? data.tpTree : null;
        for (const rec of [tree, ...stashes.map(s => s.record)]) {
            if (!rec) continue;
            if (plain(rec.owner)) { if (!rec.owner.serverId) urls.push(String(rec.owner.url || '')); } else urls.push(String(rec.url || ''));
        }
        return urls;
    }
    async function checkAddresses(config, urls) {
        const scope = H.pinScope(config);
        const move = await readMove();
        const tried = plain(move && move.addressChecks) ? move.addressChecks : {};
        const fresh = o => tried[o] && tried[o].pinScope === scope && (tried[o].same || now() - (Number(tried[o].at) || 0) < 10 * 60 * 1000);
        const origins = [...new Set(urls.map(u => H.originOf(u || '')).filter(o => /^https?:/.test(o) && o !== config.serverOrigin))]
            .filter(o => !fresh(o)).slice(0, 5);
        if (!origins.length) return;
        const results = {};
        for (const o of origins) {
            try { results[o] = Boolean(H.sameIdentity(config.pin, await H.fetchIdentity(o))); } catch (_) { results[o] = false; }
        }
        await updateMove((cur) => {
            if (!cur) return null;
            const map = { ...(plain(cur.sameServer) ? cur.sameServer : {}) };
            const checks = { ...(plain(cur.addressChecks) ? cur.addressChecks : {}) };
            for (const [o, same] of Object.entries(results)) {
                if (same) map[o] = scope; else delete map[o];
                checks[o] = { pinScope: scope, same, at: now() };
            }
            return { ...cur, sameServer: map, addressChecks: checks };
        });
    }

    // --- The move page's summary ----------------------------------------------
    async function status() {
        const config = await H.getConfig();
        const pinned = Boolean(config.serverOrigin && config.pin);
        const { data, stashes } = await inventory();
        if (pinned) await checkAddresses(config, addressesOf(data, stashes)).catch(() => {});
        const move = await readMove();
        const settings = settingsOf(data);
        const legacyUrl = legacyUrlOf(data);
        const view = (record, extra = {}) => {
            const owner = plain(record.owner) ? record.owner : null;
            const cls = classify(owner, pinned ? config : null, move);
            const url = owner ? String(owner.url || '') : String(record.url || legacyUrl || '');
            return {
                owner: owner ? { url: String(owner.url || ''), userId: owner.userId ?? null, username: owner.username || record.username || null, serverId: owner.serverId || null } : null,
                origin: owner ? null : record.origin || 'pre-accounts', url,
                items: countItems(record.roots), dirty: record.dirty === true,
                editCount: record.dirty ? Math.max(1, Number(record.editCount) || 0) : 0,
                class: cls, moves: pinned && sends(cls), sameServer: pinned && !owner ? sameServerUrl(url, config, move) : null, ...extra
            };
        };
        const tree = plain(data.tpTree) && Array.isArray(data.tpTree.roots) ? data.tpTree : null;
        const drafts = draftsOf(data);
        const all = [...drafts.parked, ...drafts.mirrored, ...drafts.live];
        const draftsMoving = pinned ? all.filter(d => sends(classify(d.owner, config, move))).length : 0;
        const cards = plain(data.tpUiExpanded) && plain(data.tpUiExpanded.cards) ? Object.keys(data.tpUiExpanded.cards).length : 0;
        const session = (await api.storage.local.get('tpHelperSession')).tpHelperSession;
        const approval = (await H.temporary.get(APPROVAL))[APPROVAL];
        const ls = plain(data[LEGACY_LS]) ? data[LEGACY_LS] : null;
        return {
            version: api.runtime.getManifest().version,
            state: move ? move.state : 'none', detectedAt: move?.detectedAt || null, found: move?.found || [],
            server: pinned ? { origin: config.serverOrigin, serverId: config.pin.serverId, enabled: config.enabled === true, identityError: config.identityError || null } : null,
            legacyUrl: legacyUrl ? H.originOf(legacyUrl) || legacyUrl : '',
            session: session && pinned && session.origin === config.serverOrigin && session.serverId === config.pin.serverId
                ? { signedIn: session.signedIn === true, username: session.username || '' } : null,
            working: tree ? view(tree) : null,
            stashes: stashes.map(s => view(s.record, { key: s.key, setAsideAt: s.record.setAsideAt || null })),
            drafts: { total: all.length, moving: draftsMoving, kept: all.length - draftsMoving },
            prefs: { keywordCategories: Object.keys(keywordsOf(settings)).length, categoryOrder: Array.isArray(settings.categoryOrder) ? settings.categoryOrder.length : 0,
                focusedFolders: Array.isArray(settings.focusedFolderIds) ? settings.focusedFolderIds.length : 0, openCards: cards,
                notesView: Boolean(ls && plain(ls.keys) && ls.keys.tp_notes_ui_v1) },
            queuedRemovals: Array.isArray(data.tpPendingRemovals) ? data.tpPendingRemovals.length : 0,
            legacyWorkflows: Array.isArray(data.workflows) && !data.tpMigrationDone ? data.workflows.length : 0,
            legacyWorkflowsBackup: Array.isArray(data.workflows_legacy_backup) ? data.workflows_legacy_backup.length : 0,
            localStorageCopiedAt: ls ? ls.copiedAt || null : null,
            approval: approval && approval.until > now() && pinned && approval.pinScope === H.pinScope(config) ? { tabId: approval.tabId, until: approval.until } : null,
            deliveredTo: move?.deliveredTo || {}, retargeted: move?.retargeted || {},
            legacyToken: move?.legacyToken ? { state: move.legacyToken.state, message: move.legacyToken.message || null, at: move.legacyToken.at || null } : null
        };
    }

    // --- Approve (move page) ------------------------------------------------------
    const cache = new Map(); // bundleId -> Map(partId -> {id, kind, bytes, digest})
    async function approve() {
        const config = await H.getConfig();
        if (!config.serverOrigin || !config.pin || !config.enabled) H.fail('not-configured', 'Connect your server first.');
        let move = await readMove();
        if (!move || move.state === 'none') move = await H.detectMove({ rescan: true });
        if (!move || move.state === 'none') H.fail('nothing-to-move', 'This browser holds nothing of the old TabPaladin to move.');
        // Which other addresses are this server, as of now.
        const { data, stashes } = await inventory();
        await checkAddresses(config, addressesOf(data, stashes));
        const tab = await H.openWebApp('#/move', { requireBridge: true });
        const current = await H.getConfig();
        if (!current.enabled || !current.pin || H.pinScope(current) !== H.pinScope(config)) H.fail('not-configured', 'The helper connection changed. Try again.');
        const approval = { approvalId: H.randomId(), origin: config.serverOrigin, serverId: config.pin.serverId, pinScope: H.pinScope(config),
            tabId: tab.id, documentKey: null, at: now(), until: now() + APPROVAL_MS };
        await H.temporary.remove(BUNDLE);
        await H.temporary.set({ [APPROVAL]: approval });
        cache.clear();
        if (H.sendEvent) await H.sendEvent(tab.id, 'move.approved', {}).catch(() => {});
        return { tabId: tab.id, origin: approval.origin, until: approval.until };
    }

    // --- Hand-over (bridge) -------------------------------------------------------
    // One move operation at a time, apart from the tracking writer's chain:
    // building a large manifest never holds up a tab-close write.
    let opChain = Promise.resolve();
    const inTurn = (fn) => { const run = opChain.then(fn, fn); opChain = run.catch(() => {}); return run; };
    async function approvalFor(ctx, { bind = false } = {}) {
        const approval = (await H.temporary.get(APPROVAL))[APPROVAL];
        if (!approval || approval.until < now() || approval.origin !== ctx.config.serverOrigin || approval.pinScope !== H.pinScope(ctx.config)
            || approval.tabId !== ctx.sender.tab.id || (approval.documentKey && approval.documentKey !== ctx.documentKey)) {
            H.fail('move-not-approved', 'Start the move from the TabPaladin extension: click its toolbar icon, then Move. Then click Bring in here within ten minutes.');
        }
        if (bind && !approval.documentKey) {
            approval.documentKey = ctx.documentKey;
            await H.temporary.set({ [APPROVAL]: approval });
        }
        return approval;
    }
    async function bundleFor(ctx, bundleId) {
        const bundle = (await H.temporary.get(BUNDLE))[BUNDLE];
        if (!bundle || bundle.bundleId !== bundleId || bundle.scope !== H.scope(ctx) || bundle.pinScope !== H.pinScope(ctx.config) || bundle.until < now()) {
            H.fail('move-not-approved', 'This hand-over expired or belongs to another page. Click Bring in again.');
        }
        return bundle;
    }
    H.handlers['move.manifest'] = (_body, ctx) => inTurn(async () => {
        await H.assertContext(ctx);
        const approval = await approvalFor(ctx, { bind: true });
        const built = await encodeParts(await buildParts(ctx.config, await readMove()));
        await H.assertContext(ctx);
        const bundleId = H.randomId();
        cache.clear();
        cache.set(bundleId, new Map(built.map(p => [p.id, p])));
        const bundle = { bundleId, approvalId: approval.approvalId, scope: H.scope(ctx), pinScope: H.pinScope(ctx.config), origin: ctx.config.serverOrigin,
            parts: built.map(p => ({ id: p.id, kind: p.kind, digest: p.digest, bytes: p.bytes.length })), until: now() + APPROVAL_MS };
        await H.temporary.set({ [BUNDLE]: bundle });
        return { bundleId, serverId: ctx.config.pin.serverId, helperVersion: api.runtime.getManifest().version, parts: bundle.parts };
    });
    H.handlers['move.part'] = (body, ctx) => inTurn(async () => {
        await H.assertContext(ctx);
        if (typeof body.bundleId !== 'string' || typeof body.partId !== 'string' || !Number.isSafeInteger(body.offset) || body.offset < 0 || body.offset % CHUNK) {
            H.fail('bad-args', 'Invalid move part request.');
        }
        const bundle = await bundleFor(ctx, body.bundleId);
        const meta = bundle.parts.find(p => p.id === body.partId);
        if (!meta || body.offset >= meta.bytes) H.fail('bad-args', 'That part is not in this hand-over.');
        let part = cache.get(bundle.bundleId) && cache.get(bundle.bundleId).get(meta.id);
        if (!part) {
            // A fresh worker: made again, and served only if it is the same.
            const built = await encodeParts(await buildParts(ctx.config, await readMove()));
            cache.clear();
            cache.set(bundle.bundleId, new Map(built.map(p => [p.id, p])));
            part = cache.get(bundle.bundleId).get(meta.id);
        }
        if (!part || part.digest !== meta.digest) {
            H.fail('move-changed', 'This browser\'s data changed since the hand-over started. Click Bring in again; nothing was kept from this one.');
        }
        bundle.until = now() + APPROVAL_MS;
        await H.temporary.set({ [BUNDLE]: bundle });
        return { bundleId: bundle.bundleId, partId: meta.id, offset: body.offset, total: meta.bytes, digest: meta.digest,
            chunk: encode(part.bytes.subarray(body.offset, body.offset + CHUNK)) };
    });

    // The tracked tabs of the copy that moved now update its workflows in the
    // web app: each 'ext' entry gets the copy's account and its bookmark's
    // address, as a web entry has. One whose bookmark is not in the copy, or
    // with no account to give it, stays as it is; closing it then keeps its
    // bookmark.
    function retargetTracking(tree, account, config) {
        const byId = new Map(), parent = new Map();
        const stack = (Array.isArray(tree && tree.roots) ? tree.roots : []).map(n => [n, null]);
        while (stack.length) {
            const [node, up] = stack.pop();
            if (!node || node.virtual || node.readOnly || typeof node.id !== 'string') continue;
            byId.set(node.id, node);
            parent.set(node.id, up);
            if (Array.isArray(node.children)) for (const c of node.children) stack.push([c, node.id]);
        }
        const urlFor = (workflowId, bookmarkId) => {
            const node = byId.get(String(bookmarkId));
            if (!node || node.kind !== 'bookmark' || typeof node.url !== 'string') return null;
            for (let up = parent.get(node.id); up; up = parent.get(up)) if (up === String(workflowId)) return node.url;
            return null;
        };
        return H.serialized(async () => {
            const map = await H.getTrackMap();
            let count = 0, kept = 0;
            for (const [tabId, entry] of Object.entries(map)) {
                if (!entry || entry.target === 'web') continue;
                const url = account ? urlFor(entry.workflowId, entry.bookmarkId) : null;
                if (!url) { kept++; continue; }
                map[tabId] = { workflowId: String(entry.workflowId), bookmarkId: String(entry.bookmarkId), url, account,
                    origin: config.serverOrigin, pinScope: H.pinScope(config), target: 'web', at: now(), movedFrom: 'ext' };
                count++;
            }
            if (count) await H.setTrackMap(map);
            return { count, kept };
        });
    }
    H.handlers['move.ack'] = (body, ctx) => inTurn(async () => {
        await H.assertContext(ctx);
        const bundle = await bundleFor(ctx, body.bundleId);
        const received = Array.isArray(body.received) ? body.received : [];
        if (received.length !== bundle.parts.length
            || bundle.parts.some(p => !received.some(r => plain(r) && r.id === p.id && r.digest === p.digest))) {
            H.fail('bad-args', 'The web app did not confirm every part. Nothing was recorded.');
        }
        // The signed-in account, for an unstamped working copy only (it
        // becomes theirs in the web app). Checked against the pin like any.
        const account = body.account ? H.account(body.account, ctx.config) : null;
        let target = null, tree = null;
        if (bundle.parts.some(p => p.id === 'working')) {
            tree = (await api.storage.local.get('tpTree')).tpTree;
            const cls = classify(tree && tree.owner, ctx.config, await readMove());
            if ((cls === 'this' || cls === 'this-moved') && Number.isInteger(Number(tree.owner.userId)) && Number(tree.owner.userId) > 0) {
                target = { url: ctx.config.serverOrigin, serverId: ctx.config.pin.serverId, userId: String(tree.owner.userId) };
            } else if (cls === 'unstamped' && account) target = account;
        }
        const tracked = target ? await retargetTracking(tree, target, ctx.config) : { count: 0, kept: null };
        const origin = ctx.config.serverOrigin;
        const move = await updateMove(cur => ({
            ...(cur || { v: 1 }), state: 'done', doneAt: (cur && cur.doneAt) || now(),
            deliveredTo: { ...((cur && cur.deliveredTo) || {}), [origin]: { bundleId: bundle.bundleId, serverId: ctx.config.pin.serverId, at: now(), parts: bundle.parts } },
            retargeted: { ...((cur && cur.retargeted) || {}), [origin]: { at: now(), count: tracked.count, kept: tracked.kept } }
        }));
        await H.temporary.remove([APPROVAL, BUNDLE]);
        cache.clear();
        paint(move);
        // A session this server already reported: the old token can go now.
        H.revokeLegacyToken().catch(() => {});
        return { recorded: true, retargeted: tracked.count };
    });
    H.moveHello = async (ctx) => {
        const move = await readMove();
        const approval = (await H.temporary.get(APPROVAL))[APPROVAL];
        const delivered = move && move.deliveredTo && move.deliveredTo[ctx.config.serverOrigin];
        return {
            state: move ? move.state : 'none',
            approvedHere: Boolean(approval && approval.until > now() && approval.origin === ctx.config.serverOrigin
                && approval.pinScope === H.pinScope(ctx.config) && approval.tabId === ctx.sender.tab.id
                && (!approval.documentKey || approval.documentKey === ctx.documentKey)),
            delivered: delivered ? { bundleId: delivered.bundleId, at: delivered.at } : null
        };
    };

    // --- The old UI's session ---------------------------------------------------
    // Signed out on its server once the web app has a signed-in session for
    // this server, then blanked here. The server's logout ends session tokens
    // only; one it still accepts after a sign-out it took (2xx) is its shared
    // token, never changed by this. Any other answer to the sign-out (a
    // proxy's 502 while the server restarts, say) proves nothing: tried again
    // later, and the move page keeps its button. A server elsewhere (one that
    // did not prove the pinned identity) is left alone. An outcome holds for
    // the token it was reached with (a short digest of it is kept, never the
    // token): one signed in since, in 1.1.0 after going back, is looked at
    // anew.
    async function revokeNow({ force = false } = {}) {
        const config = await H.getConfig();
        const move = await readMove();
        if (!config.serverOrigin || !config.pin || !move || move.state !== 'done' || !move.deliveredTo || !move.deliveredTo[config.serverOrigin]) return { state: 'waiting' };
        const last = move.legacyToken;
        const settings = (await api.storage.local.get('settings')).settings;
        const backend = plain(settings) && plain(settings.backend) ? settings.backend : {};
        const token = typeof backend.token === 'string' ? backend.token : '';
        const tokenMark = token ? hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('tp-legacy-token|' + token))).slice(0, 16) : '';
        if (last && (token ? ['revoked', 'shared-kept', 'none'].includes(last.state) && last.tokenMark === tokenMark
            : ['revoked', 'none'].includes(last.state))) return last;
        // A server that could not be reached is asked again after a while,
        // not on every report; the move page's button asks now.
        if (!force && last && last.state === 'failed' && last.tokenMark === tokenMark && now() - (Number(last.at) || 0) < 10 * 60 * 1000) return last;
        const session = (await api.storage.local.get('tpHelperSession')).tpHelperSession;
        if (!session || session.signedIn !== true || session.origin !== config.serverOrigin || session.serverId !== config.pin.serverId) return { state: 'waiting' };
        const record = async (outcome) => {
            const legacyToken = { ...outcome, tokenMark };
            if (last && last.state === legacyToken.state && last.message === legacyToken.message && last.tokenMark === tokenMark && legacyToken.state !== 'failed') return last;
            const value = { ...legacyToken, at: now() };
            await updateMove(cur => ({ ...(cur || { v: 1 }), legacyToken: value }));
            return value;
        };
        if (!token) return record({ state: 'none' });
        const base = String(backend.url || '').trim().replace(/\/+$/, '');
        if (!/^https?:\/\//.test(base) || !sameServerUrl(base, config, move)) {
            return record({ state: 'other-server', message: 'The old sign-in is for another server address. It was left as it is.' });
        }
        const call = (path, method) => fetch(base + path, { method, headers: { Authorization: 'Bearer ' + token },
            credentials: 'omit', cache: 'no-store', redirect: 'error' });
        try {
            // 401: the server refuses this token already (ended or expired);
            // checked below like one it just ended.
            const out = await call('/api/logout', 'POST');
            if (!out.ok && out.status !== 401) return record({ state: 'failed', message: 'The server answered ' + out.status + ' to signing out. Trying again later.' });
            const me = await call('/api/auth/me', 'GET');
            if (me.status === 401) {
                // Blank only this token: never one the settings hold since.
                const fresh = (await api.storage.local.get('settings')).settings;
                if (plain(fresh) && plain(fresh.backend) && fresh.backend.token === token) {
                    await api.storage.local.set({ settings: { ...fresh, backend: { ...fresh.backend, token: '' } } });
                }
                return record({ state: 'revoked' });
            }
            if (me.ok && out.ok) return record({ state: 'shared-kept', message: 'The extension holds the server\'s shared token, which signing out does not end. It was left as it is.' });
            return record({ state: 'failed', message: me.ok ? 'The server did not confirm the sign-out. Trying again later.' : 'The server answered ' + me.status + '. Trying again later.' });
        } catch (_) {
            return record({ state: 'failed', message: 'The server could not be reached. Trying again later.' });
        }
    }
    let revoking = null;
    H.revokeLegacyToken = (opts) => {
        if (!revoking) revoking = revokeNow(opts).finally(() => { revoking = null; });
        return revoking;
    };
    H.onSessionReport = (session) => { if (session && session.signedIn === true) H.revokeLegacyToken().catch(() => {}); };

    // --- The move page's messages ---------------------------------------------------
    const fromMovePage = sender => Boolean(sender && sender.id === api.runtime.id && typeof sender.url === 'string'
        && sender.url.split(/[?#]/)[0] === api.runtime.getURL(MOVE_PAGE) && !(sender.tab && sender.tab.incognito));
    async function handleMovePage(message, sender) {
        try {
            if (!fromMovePage(sender)) H.fail('bad-origin', 'Only the move page may do this.');
            const body = plain(message.body) ? message.body : {};
            let data;
            if (message.op === 'status') data = await status();
            else if (message.op === 'configure') data = await H.configure(body.origin, body.insecureAck === true, { repin: body.repin === true });
            else if (message.op === 'approve') data = await approve();
            else if (message.op === 'open') { const tab = await H.openWebApp(''); data = { tabId: tab && tab.id }; }
            else if (message.op === 'revoke') data = await H.revokeLegacyToken({ force: body.force === true });
            else if (message.op === 'rescan') data = await H.detectMove({ rescan: true });
            else H.fail('unsupported-op', 'Unknown move page action.');
            return { ok: true, data };
        } catch (error) {
            return H.errorResult ? H.errorResult(error) : { ok: false, error: { code: error.code || 'internal', message: error.message } };
        }
    }
    api.runtime.onMessage.addListener((message, sender, reply) => {
        if (!message || message.channel !== 'tp-helper-move') return;
        handleMovePage(message, sender).then(reply, () => reply({ ok: false, error: { code: 'internal', message: 'The helper could not complete this.' } }));
        return true;
    });

    H.ops.push('move.manifest', 'move.part', 'move.ack');
    api.runtime.onInstalled.addListener(() => { H.detectMove({ rescan: true }).catch(e => console.warn('TabPaladin move:', e.message)); });
    // Any start: one that missed the update looks now, and the badge comes back.
    readMove().then(move => (move ? paint(move) : H.detectMove())).catch(() => {});
})();
