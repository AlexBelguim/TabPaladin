# P2 implementation report

## Scope and branch

- Base: local main at 04ce9a5e14630ec89c52a2ad0734bd4b1bad0fe8.
- Branch: feat/p2-helper, in the attached p2-helper worktree.
- P2 only: extension 1.1.0 and PWA 34. No P3 desktop port, vault or move workflow.
- Nothing merged or pushed. No live server was started or changed.

## What changed

- Helper classic background modules: signed ECDSA identity setup and per-origin pins, exact-origin runtime registration, sender/document/permission checks, isolated trusted gestures, capability negotiation, rate limits, stored mutation receipts, and detach on sign-out/address changes.
- Extension Settings: connection disclosure, HTTP LAN acknowledgement, explicit re-pin, account display, close policy, staged browser import, activity and recently closed tabs. The toolbar keeps opening the legacy client. Toolbar menus open the web app, prefill a save review, reopen the last helper-closed batch, and open Settings.
- Tab services: document-bound snapshots, count/URL checks before close, durable recovery log, normal/private-window filtering, source-window selection, tracked workflow opening, separate ext/web removal paths, account/origin/pin-scoped persistent queue and issued-removal acknowledgements. Whole-window close defaults to keep. The old Save & Close excludes server-origin tabs.
- PWA: validated helper client, workflow checkbox review, durable write/readback before closing, workflow append through POST /api/workflows, copy-scoped pending append retries, tracked open, queued removals, Pin current tab, dated staged imports using the shared conversion, helper status, and legacy-copy dirty warning.
- Shared TreeStore: additive guarded append receipt, validated durable removals for the working copy or matching set-aside copy, and an optional browser-import title. Shared twins copied byte for byte.
- Server: full CSP enforced, including connect-src self and the restricted favicon image hosts. PWA server address fixed to location.origin, without forwarding a credential saved for a different origin. No database schema or SQL statements changed; no tenancy-scan additions were necessary.
- README and PRIVACY disclose the bridge, the server operator's tab access, retained state and permissions.

## Intentional deviations

- Testing was explicitly waived by the owner's latest instruction, "Finish p2 no testing". No new helper suites were added or executed. Existing manifest/security/syntax expectations were updated for the new packaged files, permissions and enforced CSP.
- P2 retains the existing required bookmarks permission and optional all-sites video-seek permission. Removing/re-requesting the required bookmarks grant would break the preserved legacy client; the helper-only permission reduction belongs to P5. Staged import performs one getTree read from the Settings click and never edits browser bookmarks.
- New captures/imports/pins require a signed-in account, preserving the existing rule against writing into a signed-out account's kept copy. A previously signed-in offline copy can retain pending work. Append failures keep the saved workflow locally.
- A no-root append falls back to the existing guarded pushFolding. A conflict remains pending for explicit resolution; there is no automatic pull/resave that might replace local work.
- Changing servers keeps old state under its original origin/pin. Transferring legacy copies belongs to the later move phase; no data is moved automatically.
- The packages retain the legacy UI and shared source, as required while it remains the main PC client. Only manifest.json, src/ and icon assets are packaged; no server, PWA, tools, development data or remote executable code is included.

## Source review and package inspection

One source review covered data preservation, account routing and bridge security. Fixes included account-bearing removal requests, matching event names, correct response keys, recovery-first closes with URL rechecks, old-origin identity pin retention, no credential forwarding after origin lock, explicit session-expiry detach, staged-import receipts and imports under the Bookmarks root. Storage failures leave tabs open and removals queued. Existing copy/draft/settings keys are not migrated or removed by this phase.

Both packages were built with node tools/package.mjs. Each contains 35 entries and all 11 helper files. Chrome adds contextMenus; Firefox adds menus; no required host access was added. Archive source inspection found no eval, Function constructor, remote script tag or remote importScripts reference. Manifests retain CRLF; edited source and PWA files retain LF.

## Test execution record

No tests were run after the final no-testing instruction. Earlier, on an incomplete intermediate snapshot:

| Test file | Result at that time |
| --- | --- |
| tools/test_syntax.mjs | Passed (99 scripts then) |
| tools/test_manifests.mjs | Passed |
| tools/test_tracking.mjs | Passed |
| tools/test_update_handshake.mjs | Passed |
| tools/test_video_seek.mjs | Passed |

The earlier sync_shared --check command found a TreeStore mismatch; the final shared sources were copied with node tools/sync_shared.mjs. Other test files, including live-server auth, were not run. Earlier passes do not validate the completed implementation. Package construction and archive/source inspection were performed, not browser or runtime tests.

## Known gaps and manual checks

- The completed implementation has no automated or browser validation, by request.
- Load/update the extension in place in Chrome and Firefox; preserve the extension id. Check legacy working copy, set-aside copies, parked/live drafts, settings and tracked windows after an update.
- Exercise setup, optional exact-server permission, pin persistence, wrong/changed identity rejection, HTTP acknowledgement, sign-out detach and Reconnect.
- Check toolbar click and all right-click menu items. In the web app save a reviewed workflow, confirm only saved unchanged tabs close, and reopen it with tracking. Close one tab, close an entire window, and reopen the app after queued removals.
- Exercise Pin current tab and staged bookmark import, including bookmarklets remaining inert and an interrupted acknowledgement not duplicating the imported folder.
- Installed-PWA content-script injection varies by browser; use a normal web-app tab if the helper cannot attach. Browser/Opera menu rendering also needs manual confirmation.
- Snapshot/handoff expiry requires starting that action again; oversized bookmark imports (750,000 serialized characters) use the existing HTML-file import instead.
- Rare navigation during the browser's final close API call, multi-tab/account switches during a long save, and a worker stopping between creating a tab and recording its tracking remain browser-level timing gaps. The recovery log, stored receipts and fail-closed checks limit consequences; these scenarios were not chased or tested.
