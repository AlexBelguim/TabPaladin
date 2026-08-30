# TabPaladin Sync Server

Tiny Node + SQLite backend for the TabPaladin extension and PWA.

**The server owns the bookmarks.** The canonical tree lives in the `items`
table of `sync.db`; the extension and the PWA each hold a local working copy
and sync it git-style — edit locally, **push** to upload, **pull** to replace
the working copy with the server's tree. The browser's own bookmark store is
never touched (a one-time *Import this browser's bookmarks* action copies it
in). This replaced the old whole-browser-tree snapshot sync, which had to map
browser-specific root folders ("Other Bookmarks" vs "Unfiled Bookmarks" vs
Opera's "Unsorted Bookmarks") across vendors and broke whenever they disagreed.

On the first boot after upgrading, the server converts the newest legacy
snapshot into the items table automatically — notes, pins, workflows and all.
Nothing is lost; old history rows stay readable.

## Run on TrueNAS (or any Docker host)

```bash
cd server
# Set a long random token:
echo 'TABPALADIN_TOKEN=7f3b8e2a9c5d4f1e0b9a8c7d6e5f4a3b' > .env
# And a second one, if you plan to use importers (see below):
echo 'IMPORT_SECRET=change-me-to-something-long-and-random' >> .env
docker compose up -d --build
```

The server listens on `http://<host>:18921`. Configure the same `TABPALADIN_TOKEN`
in the extension settings (Backend section) and you're synced.

## The tree

`GET /api/tree` returns `{ version, roots }` — an array of top-level folders,
no browser roots. Nodes are:

```jsonc
{ "id": "ab12cd34ef56aa00",       // permanent; survives every push/pull
  "kind": "folder",                // folder | bookmark | note
  "title": "Recipes",
  "role": "notes",                 // folders only, optional: pins | notes | workflows
  "url": "https://…",             // bookmarks only
  "payload": { "content": "…" },  // notes: {content, createdAt, updatedAt}
  "children": [] }                 // folders only
```

Roles replaced the old magic folder titles ("TabPaladin Notes" etc.) as the way
clients find their app-managed roots.

One folder carries `role: "bookmarks"` and is the tree's main bookmarks folder,
titled **Bookmarks**. On first boot after the upgrade the busiest ordinary
top-level folder is designated as it (usually the browser's "Other Bookmarks"),
renamed, and any other ordinary top-level folder is moved inside — a browser's
split between "Bookmarks Bar" and "Other Bookmarks" is a browser's problem, not
a database's. Browser noise roots (Trash, Speed Dials, Pinboard) are left where
they are and hidden by the clients. This runs once and never fights a later
rename or reorganisation.

Importing a browser's bookmarks creates a named folder inside it — "Chrome
bookmarks", "Firefox bookmarks" — so a second import cannot merge into the
first.

`PUT /api/tree` replaces the whole tree: `{ roots, baseVersion, deviceId }`.
If `baseVersion` is not the server's current version — another device pushed in
between — the push is refused with **409** and the client must pull first (or
send `force: true`). Every accepted write bumps the version and lands a
`{format: 2, roots}` row in the history table.

The response of `GET /api/tree` also carries a **virtual imports subtree**
(`id: "imports:root"`, flagged `virtual`/`readOnly`) composed at read time from
the import archive and nested inside the Bookmarks folder. It is never stored, is stripped from any pushed tree, and
can only be changed through the explicit import verbs below.

## Endpoints

All endpoints require `Authorization: Bearer <TABPALADIN_TOKEN>` except `/api/health` and the `/llm/...` share-link routes (those are protected by an unguessable, expiring token in the URL instead).

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | server status |
| GET | `/api/tree` | the tree (+ virtual imports subtree) |
| PUT | `/api/tree` | replace the tree `{ roots, baseVersion, deviceId?, force? }`; 409 on a stale baseVersion |
| GET | `/api/tree/version` | cheap freshness probe |
| GET | `/api/history` | list of past tree versions |
| GET | `/api/history/:id` | fetch a specific past version |
| POST | `/api/push`, GET `/api/pull` | **410 Gone** — the legacy snapshot sync, kept only to tell old clients to update |
| GET | `/api/shared` | pending links inbox |
| POST | `/api/shared` | add `{ url, title? }` |
| DELETE | `/api/shared/:id` | remove one inbox entry |
| DELETE | `/api/shared` | clear inbox |
| POST | `/api/share` | create an LLM share link (returns `{ url, expiresAt }`) |
| GET | `/api/proposals` | list pending LLM note proposals |
| POST | `/api/proposals/:id/approve` | apply a proposal to the tree (bumps the version) |
| POST | `/api/proposals/:id/reject` | discard a proposal |
| GET | `/llm/:token` | **no auth** — notes + LLM instructions as markdown; 410 when expired |
| POST | `/llm/:token/propose` | **no auth** — LLM submits `{ title, content, notebook? }` for approval |
| GET | `/api/imports` | list import sources with counts and last-run state |
| POST | `/api/imports` | create `{ provider, clientId, clientSecret, intervalMinutes? }` |
| PATCH | `/api/imports/:id` | enable/disable, change interval or credentials |
| DELETE | `/api/imports/:id` | remove a source; `?purge=1` also deletes its archive |
| GET | `/api/imports/:id/items` | browse the archive (`limit`, `offset`) |
| POST | `/api/imports/:id/run` | sweep now |
| POST | `/api/imports/:id/items/delete` | purge `{ externalIds }` from the archive (tombstoned) |
| POST | `/api/imports/:id/items/file` | mark `{ externalIds }` as filed into the user's own tree |
| POST | `/api/imports/:id/undismiss` | forget deleted-item tombstones so a sweep may restore them |
| POST | `/api/imports/capture` | file a shared `{ url, title }` into its archive (X / Instagram) |
| GET | `/api/imports/:id/authorize` | returns the provider consent URL |
| GET | `/api/imports/reddit/callback` | **no auth** — OAuth redirect, guarded by a one-shot `state` |
| GET | `/` (and other paths) | serves the PWA |

## LLM share links

The PWA's "🔗 Share with LLM" button calls `POST /api/share` and copies a link
like `https://<host>/llm/<token>`. Paste it into any LLM chat with web access:
the LLM can read all notes plus instructions (note styling, `[[wikilinks]]`, and
that it must **never edit directly** — it can only `POST .../propose`). The
proposal lands in the PWA's *Pending approval* block; approving writes the note
straight into the items table (creating or replacing the note with that title).

Links expire after 1 hour by default; override with `SHARE_TTL_MINUTES`.
Unauthenticated routes expose only the notes, never the full tree.

Notes are grouped into **notebooks** (subfolders of the notes root);
proposals can include an optional `"notebook"` field and the share page lists
notes grouped by notebook.

For LLM chats that cannot POST, the share page also teaches a universal
review link: `https://<host>/#note=<percent-encoded markdown>[&notebook=<name>]`.
The fragment never reaches the server — the PWA opens the note in its editor
for review and only stores it when the user presses Save.

## Importers

Reddit's listing endpoints stop paginating at **1000 items**. Your saves are not
deleted — they stay in Reddit's database — but `/user/<name>/saved` only ever returns
the most recent 1000 and there is no page 1001. The same cap applies to upvoted,
downvoted and hidden listings.

The importer sweeps the list on a schedule and never drops what it has already seen,
so the archive keeps growing past the cap. Items that fall off the end of Reddit's
window are stamped as gone from the source and stay in the archive.

### Connecting Reddit

1. Go to <https://www.reddit.com/prefs/apps> → **create another app…**
2. Pick type **web app** (not "script" — only a web app gets a refresh token).
3. Set the redirect URI to exactly `https://<host>/api/imports/reddit/callback`.
   The PWA shows you the right value to paste.
4. Put a long random string in `IMPORT_SECRET` in `.env` and restart, *before*
   connecting. It encrypts the stored refresh token; without it the token sits in
   `sync.db` in plaintext and the server says so on startup. Changing it later
   invalidates existing connections.
5. In the PWA: **Settings → Imports → Connect Reddit**, paste the client ID and
   secret, then authorise.

Saved posts and saved comments both appear in every client under:

```
Bookmarks/TabPaladin Imports/Reddit/
```

Flat, newest first. The month grouping this used to have earned its keep while
the folder was written into the bookmark tree and had to rebuild identically;
the subtree is composed fresh on every read now, so the extra levels only cost
clicks.

### How it holds together

The archive's only home is the `import_items` table. What clients see as the
`TabPaladin Imports` folder is a **virtual subtree composed at read time** and
appended to every `GET /api/tree` response — it is never stored, a pushed tree
never contains it, and no stale device can damage it. This replaced the old
projection machinery, which wrote the folder into the snapshot and then had to
reconcile, eject and guard its way around every device's pushes.

The subtree is read-only in both clients. Two gestures on it are real
features, and both are explicit server verbs rather than inferred from a push:

| you did | what happens |
|---|---|
| **deleted an item** (desktop app) | `POST /api/imports/:id/items/delete` — purged from the archive, plus a contentless tombstone so a later sweep does not re-import it |
| **dragged an item out** into your own folder (desktop app) | `POST /api/imports/:id/items/file` — a copy lands in your tree, the archive keeps the row but stops drawing it, so it never shows twice |

Deleting is unrecoverable — the archived copy is gone, and anything past Reddit's
1000-item window cannot be fetched again. `POST /api/imports/:id/undismiss`
clears the tombstones so a later sweep may restore items *still saved on Reddit*;
it cannot bring back the rest.

**Imports are one-way.** Deleting an imported item in TabPaladin never un-saves
anything on Reddit.

### X and Instagram — captured, not swept

Neither can be fetched. X has had no free API tier since February 2026, and
Instagram has no route to a personal saved or liked list at all: Basic Display
shut down in December 2024, and the Graph API exposes saves only as an aggregate
insight on Business accounts.

What does work is the Android share sheet. The PWA already declares
`share_target`, so **like a post → Share → TabPaladin** and it lands in its own
archive next to Reddit:

```
TabPaladin Imports/X/Saved/<YYYY-MM>/          "@nasa — Look at this nebula"
TabPaladin Imports/Instagram/Saved/<YYYY-MM>/
```

`POST /api/imports/capture` does the routing. It classifies by
host, creates the source on first use (nothing to set up), and returns
`captured:false` for anything else so the client falls back to the ordinary
shared-links inbox. Share-sheet tracking parameters (`?t=`, `?s=`, `?igsh=`) are
stripped before storing, or the same post shared twice would archive twice.

These sources have no credentials and no sweep, so the clients drop the
Authorise, Sweep and Pause controls for them. Everything else is identical —
same folder layout, same delete/file semantics.

Two things this is not: it captures only what you deliberately share from now
on, with no backfill of anything you liked previously; and a share carries just
a URL and sometimes a title, so there is no author or date beyond capture time.
Grouping uses capture time for that reason.

A true one-tap floating overlay is not possible here — drawing over other apps
needs `SYSTEM_ALERT_WINDOW`, a native Android permission with no web equivalent.
That would be a separate native app firing the same share intent.

### Tests

```bash
node tools/test_items.mjs      # canonical tree store: migration, versioning, notes
node tools/test_treestore.mjs  # extension working copy: managers, facade, sync, import verbs
node tools/test_imports.mjs    # importers: archive, virtual subtree, tombstones
node tools/test_share_sw.mjs   # PWA service worker share handling
node tools/test_auth.mjs --url http://127.0.0.1:18921 --legacy <token>   # against a live server
```

### Sharing from a phone

The PWA declares a share target, so a post shared from X or Instagram on Android
lands in its own archive beside Reddit. The share posts to `/share`, which the
**service worker answers itself** and replies `204` — that is what stops the app
launching every time you share something. The worker cannot read `localStorage`,
so the app mirrors the server URL and session token into a `tp-config` Cache
Storage entry, cleared on sign-out.

Anything that stops the worker finishing — not signed in, server unreachable,
session expired — redirects into the app, which handles the same share the long
way. `POST /share` on the server does the same when no worker is registered yet.
Losing the link is the one outcome worth avoiding.

## TLS

Mobile browsers refuse to install a PWA or fire share-target intents over plain
HTTP. Put a reverse proxy in front (Traefik, Caddy, NPM) and terminate TLS there.
Local desktop testing over HTTP works fine.
