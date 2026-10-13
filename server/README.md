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

**Several people, one server.** Every account has its own tree, notes,
workflows, inbox, history, LLM share links, import archives and preferences.
Nothing of one account is ever shown to, or overwritten by, another — see
[Accounts](#accounts).

## Run on TrueNAS (or any Docker host)

```bash
cd server
cp .env.example .env
# Edit .env: at least ADMIN_PASSWORD. Generate one with: openssl rand -base64 18
mkdir -p data && sudo chown 1000:1000 data   # the container runs as uid 1000 (node)
docker compose up -d --build
```

The server listens on `http://<host>:18921`. On its first start it creates
the admin account from `ADMIN_USERNAME` / `ADMIN_PASSWORD`; sign in with
those in the PWA or the extension's Backend settings. After that the two
variables are ignored, so editing `.env` later changes nobody's password —
change it from the app instead. A server with no account and no
`ADMIN_PASSWORD` refuses to start. There is no way to create an account over
the network.

### Environment

| Variable | Default | |
|---|---|---|
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / *(required on first start)* | First admin account. Ignored once any account exists. |
| `TABPALADIN_TOKEN` | *(off)* | Legacy shared token, passed to the server as `AUTH_TOKEN`. Requests bearing it (`Authorization: Bearer` or `X-API-Key`) act as the account that owned the data before accounts were separated — for scripts, and for clients that predate logins. It cannot manage accounts. At least 32 characters; the old example value from this README is refused. Also the admin password on a first start without `ADMIN_PASSWORD`. |
| `TENANCY_OWNER` | *(unset)* | Only for the [upgrade to separate accounts](#upgrading-to-separate-accounts-schema-3), and only when the database already holds more than one account: the username (or id) whose data it all is. |
| `IMPORTS_SCHEDULER` | *(on)* | `off` stops the import scheduler — for rehearsing on a copy of a real database. |
| `MAX_INBOX_PER_USER` / `MAX_PROPOSALS_PER_USER` | `5000` / `200` | Per-account caps on the shared-links inbox and on pending LLM proposals. Past them new rows get `429`; nothing is pruned. |
| `IMPORT_SECRET` | *(off)* | Encrypts importer OAuth refresh tokens at rest. |
| `TRUST_PROXY` | `loopback, uniquelocal` | Express `trust proxy`: which proxies may set `X-Forwarded-For` / `-Proto`. Set `1` or `true` if your proxy reaches the server from a public address. |
| `CORS_ORIGIN` | *(off)* | Extra comma-separated origins allowed to call the API cross-origin. The server's own origin and browser-extension origins (`chrome-extension://`, `moz-extension://`) are always allowed. |
| `AUTH_MAX_FAILURES` / `AUTH_WINDOW_MINUTES` | `10` / `15` | Failed sign-ins allowed per IP and username per window before `429`, so people behind one NAT do not lock each other out. |
| `AUTH_IP_MAX_FAILURES` | 5 × `AUTH_MAX_FAILURES` | Failed sign-ins allowed per IP across all usernames. |
| `BACKUP_KEEP` | `7` | Boot-time database backups to keep (see below). |
| `SESSION_DAYS` | `180` | Session lifetime. |
| `MAX_SNAPSHOTS` | `200` | Tree history rows kept, per account. |
| `HOST_PORT` | `18921` | Host port in docker-compose. |

**Backups.** At boot, before any migration touches it, the server writes a
consistent copy of the database (`VACUUM INTO`, which includes what is still in
the WAL — a plain file copy of a running `sync.db` does not):

| file | when | kept |
|---|---|---|
| `sync.db.bak-<timestamp>` | at most once a day | the newest `BACKUP_KEEP` |
| `sync.db.pre-v<N>-<timestamp>` | before a schema upgrade to version N; not again within ten minutes while the upgrade has not happened, so a restart loop cannot pile them up | forever — it is the rollback point |
| `sync.db.post-v<N>-<timestamp>` | right after that upgrade, before any client can push | forever |
| `sync.db.predelete-<id>-<timestamp>` | before an admin deletes an account | the newest 10 |

Each kind rotates under its own prefix, so none can push another out. Note
that pre-upgrade and predelete copies **contain deleted accounts' data**; they
stay on the server's disk. To restore, stop the container and copy one over
`sync.db` (deleting `sync.db-wal` and `sync.db-shm`).

### Upgrading an existing server

Existing data, the existing account, its password and every signed-in device
keep working; the account becomes the admin. Before the first start of the new
image:

1. The container no longer runs as root. Hand it the data directory once:
   `sudo chown -R 1000:1000 ./data`. The server says so at boot if it can't
   write there.
2. If `TABPALADIN_TOKEN` is the example value this README used to publish, or
   shorter than 32 characters, the server refuses to start. Replace it with
   `openssl rand -hex 32` (and update anything still using it), or remove it
   once every client signs in with an account. If it was never set, the old
   compose file silently used that example value — it now defaults to off.

## Accounts

The first admin comes from `ADMIN_USERNAME` / `ADMIN_PASSWORD`. Admins add
further accounts from **Settings › Users**, in the extension or the PWA. Each
account starts with an empty tree and has its own of everything: tree and
history, notes, workflows, inbox, LLM share links and proposals, Reddit / X /
Instagram archives, and preferences. Every row in the database names the
account it belongs to, and the database itself refuses a row whose account
does not exist, so a forgotten check is an error, not a leak.

Account management is deliberately harder to reach than the rest:

- only an admin, in a signed-in session — the legacy `AUTH_TOKEN` keeps the
  data access it always had but cannot manage accounts;
- every change asks for the acting admin's own password again (counted like a
  failed sign-in), and is checked again as it is written: an admin demoted,
  deleted or signed out in the meantime changes nothing;
- the **server owner** — the account holding the data from before accounts
  were separated — cannot be deleted, demoted or reset over HTTP at all, not
  even by another admin;
- the last admin cannot be demoted or deleted, nor can you delete yourself or
  change your own role, nor delete the account `AUTH_TOKEN` acts as while it
  is set;
- a new name that differs from an existing or deleted one only by case
  ("Alex" next to "alex") is refused;
- deleting an account signs it out everywhere, takes a `predelete` backup
  (and deletes nothing if that fails), then removes everything the account
  owns in one transaction. Its id is never handed out again.

A password reset signs that account out on every device, including a sign-in
with the old password that was still being checked when the reset landed.
Unpushed edits on its
devices stay there; the clients never discard a working copy because of an
account change — they set it aside instead.

**Moving the owner.** By design this needs shell access. With the container
stopped:

```bash
sqlite3 data/sync.db "UPDATE server_meta SET value = '<new owner id>' WHERE key IN ('tenancy_owner_id', 'legacy_token_user_id');"
```

### Upgrading to separate accounts (schema 3)

The first start of this version assigns every existing row to the account
that already exists, and nothing else changes: same tree version (so no device
sees a conflict), same sessions, same history, inbox, proposals and archives.
The boot log says what it did:

```
Tenancy migration: assigned 9312 rows to alex (#1); recovered 1 removed import source(s); pre-upgrade copy sync.db.pre-v3-…; post-upgrade copy sync.db.post-v3-…
```

- Archives of import sources you had removed used to be left behind with no
  source; they come back as greyed *Removed … source* rows under **Show
  removed sources**, where they can be restored or purged. Removing a source
  is now a soft delete that keeps its archive.
- The migration is one transaction that checks itself before committing:
  every table that existed before must hash identically (apart from the new
  columns), every row must have an owner, and the owner's tree version must
  be the one their devices hold. Anything else rolls it all back.
- It **refuses** rather than guesses: when the database holds more than one
  account (set `TENANCY_OWNER=<username>`), when free disk is under 2.5 × the
  database, or when the database was already upgraded by a newer build. A
  refusal writes `data/MIGRATION_REFUSED` with the reason and stops; later
  starts stop at that file without taking more backups, so a restart loop
  cannot rotate your older backups away. Fix the cause, delete the file,
  restart.

**Rehearse first.** On a copy taken with `VACUUM INTO` (or any
`sync.db.bak-*`), or with the container stopped — never a plain copy of a
running `sync.db`, which misses everything still in the WAL:

```bash
sqlite3 data/sync.db "VACUUM INTO '/tmp/rehearsal/sync.db'"
IMPORTS_SCHEDULER=off DATA_DIR=/tmp/rehearsal PORT=18930 node index.js
```

`IMPORTS_SCHEDULER=off` stops the copy sweeping your real Reddit account.
A copy of an already upgraded database reports the same `serverId` as the
original; the clients still treat it as a different server because its address
differs, so a browser signed in to it sets the real server's working copy
aside rather than pushing it there.

**Verify.** Compare the frozen copies on either side of the migration — not
the live database, which your devices are already pushing to:

```bash
docker compose exec tabpaladin-sync node verify_tenancy.js /data/sync.db.pre-v3-… /data/sync.db.post-v3-…
```

It prints per-table row counts and hashes for both and exits non-zero on any
difference. `node verify_tenancy.js --digest /data/sync.db` prints the digest
the migration recorded at the time.

**Rolling back means restoring `sync.db.pre-v3-*`**, not running the old image
on the upgraded database: the old image would show every account's bookmarks
merged together, and its writes are refused by the database. This version
refuses to start on a database upgraded by a newer one and says which copy to
restore.

## The tree

`GET /api/tree` returns `{ version, roots, userId, serverId }` — an array of
top-level folders, no browser roots, and the account they belong to on which
server. `serverId` is random, made on first start and kept in the database:
account ids start at 1 on every server, so a client tells "admin #1 here" from
"admin #1 on another server" by it. Nodes are:

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

`PUT /api/tree` replaces the caller's whole tree: `{ roots, baseVersion,
baseUserId, baseServerId, deviceId }`. If `baseVersion` is not the server's
current version — another device pushed in between — the push is refused with
**409** and the client must pull first (or send `force: true`). Every accepted
write bumps the version and lands a `{format: 2, roots}` row in the history
table.

A working copy that belongs to another account is refused with **412**, which
`force` does not override: `code: "wrong-account"` when `baseUserId` names
someone else or `baseServerId` another server, `code: "foreign-ids"` when the
pushed tree contains items stored under another account. Clients set such a
copy aside rather than pull over it. Versions are drawn from one server-wide
sequence, so no two accounts ever share one; clients only compare them for
equality.

The response of `GET /api/tree` also carries a **virtual imports subtree**
(`id: "imports:root"`, flagged `virtual`/`readOnly`) composed at read time from
the import archive and nested inside the Bookmarks folder. It is never stored, is stripped from any pushed tree, and
can only be changed through the explicit import verbs below.

## Endpoints

All endpoints require `Authorization: Bearer <session token>` (from `/api/login`; or the legacy `TABPALADIN_TOKEN`) except `/api/auth/status`, `/api/login`, `/api/health`, the `/llm/...` share-link routes (those are protected by an unguessable, expiring token in the URL instead) and the Reddit OAuth callback and confirm pages. Everything acts on the caller's own account.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | server status |
| GET | `/api/auth/status` | **no auth** — `{ hasAccount, legacyTokenEnabled }` |
| GET | `/api/auth/me` | `{ user: { id, username, role, tenancyOwner }, serverId }` |
| POST | `/api/login` | **no auth** — `{ username, password }` → session token, `user` and `serverId`; rate-limited per IP and username |
| POST | `/api/auth/password` | `{ currentPassword, newPassword }`; revokes every session |
| GET | `/api/users` | admin session — every account with role, owner flag and what it holds |
| POST | `/api/users` | admin session — `{ username, password, role, currentPassword }` |
| PUT | `/api/users/:id` | admin session — `{ role?, password?, currentPassword }`; a reset signs that account out |
| POST | `/api/users/:id/delete` | admin session — `{ confirm: '<username>', currentPassword }` → `{ deleted: {table: n}, backup }` |
| GET | `/api/prefs`, `/api/prefs/:key` | the caller's preferences |
| PUT | `/api/prefs/:key` | `{ value, baseUpdatedAt? }`; 409 with `current` when stale; 64 KB per value, 100 keys |
| DELETE | `/api/prefs/:key` | remove one |
| GET | `/api/tree` | the tree (+ virtual imports subtree), `userId` and `serverId` |
| PUT | `/api/tree` | replace the tree `{ roots, baseVersion, baseUserId?, baseServerId?, deviceId?, force? }`; 409 on a stale baseVersion, 412 for another account's or server's copy |
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
| GET | `/api/imports` | list import sources with counts and last-run state; `?includeRemoved=1` adds removed ones |
| POST | `/api/imports` | create `{ provider, clientId, clientSecret, intervalMinutes? }` |
| PATCH | `/api/imports/:id` | enable/disable, change interval or credentials |
| DELETE | `/api/imports/:id` | remove a source, keeping its archive; `?purge=1` deletes the archive too |
| POST | `/api/imports/:id/restore` | bring a removed source back |
| GET | `/api/imports/:id/items` | browse the archive (`limit`, `offset`) |
| POST | `/api/imports/:id/run` | sweep now |
| POST | `/api/imports/:id/items/delete` | purge `{ externalIds }` from the archive (tombstoned) |
| POST | `/api/imports/:id/items/file` | mark `{ externalIds }` as filed into the user's own tree |
| POST | `/api/imports/:id/undismiss` | forget deleted-item tombstones so a sweep may restore them |
| POST | `/api/imports/capture` | file a shared `{ url, title }` into its archive (X / Instagram) |
| GET | `/api/imports/:id/authorize` | returns the provider consent URL |
| GET | `/api/imports/reddit/callback` | **no auth** — OAuth redirect, guarded by a one-shot `state`; asks which account receives the connection |
| POST | `/api/imports/reddit/confirm` | **no auth** — the confirm page's form, guarded by a one-time nonce |
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
6. Back from Reddit, the page asks *Connect Reddit u/… to TabPaladin account
   …?* Nothing is stored until you press **Connect** — a consent link can be
   sent to anyone, so the person completing it confirms which account receives
   their saved posts.

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
node tools/test_security.mjs  # token check, async scrypt, rate limiter, HTML escaping
node tools/test_users.mjs     # users migration, first-admin bootstrap, backups
node tools/test_tenancy.mjs   # ownership migration, per-account isolation, deletion, SQL scan, end-to-end upgrade of an old server's data
node tools/test_pwa_accounts.mjs  # the PWA against a real server: queued shares, unpushed edits across sign-ins, Users block
ADMIN_USERNAME=tester ADMIN_PASSWORD='correct horse battery' AUTH_MAX_FAILURES=8 IMPORTS_SCHEDULER=off MAX_PROPOSALS_PER_USER=3 DATA_DIR=/tmp/tp node server/index.js &
node tools/test_auth.mjs --url http://127.0.0.1:18921 [--legacy <token>]   # against a live server
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
