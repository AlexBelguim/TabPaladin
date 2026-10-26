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
workflows, inbox, history, LLM share links, MCP tokens, import archives and preferences.
Nothing of one account is ever shown to, or overwritten by, another — see
[Accounts](#accounts).

## Run on TrueNAS (or any Docker host)

```bash
cd server
cp .env.example .env
# Edit .env: at least ADMIN_PASSWORD. Generate one with: openssl rand -base64 18
docker compose up -d --build   # the server runs as uid 1000 (node); it takes ./data over itself
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
| `MAX_INBOX_PER_USER` / `MAX_PROPOSALS_PER_USER` | `5000` / `200` | Per-account caps on the links waiting in the shared-links inbox and on pending AI proposals (share link and MCP together). Past them new rows get `429`; nothing is pruned. |
| `MCP_RATE_LIMIT_PER_MINUTE` | `120` | [MCP](#mcp-ai-chats-with-a-token) requests allowed per token per minute before `429`. |
| `MCP_AUTH_MAX_FAILURES` | `20` | Wrong MCP tokens allowed per client address per 15 minutes before `429`. |
| `MCP_ALLOWED_ORIGINS` | *(none)* | Comma-separated browser origins allowed to call `/mcp` (a request with any other `Origin` header gets `403`); a listed one gets CORS, preflights included, from `/mcp` itself (`CORS_ORIGIN` plays no part there). MCP clients send none. |
| `IMPORT_SECRET` | *(off)* | Encrypts importer OAuth refresh tokens at rest. |
| `TRUST_PROXY` | `loopback, uniquelocal` | Express `trust proxy`: which proxies may set `X-Forwarded-For` / `-Proto`. Set `1` or `true` if your proxy reaches the server from a public address. |
| `CORS_ORIGIN` | *(off)* | Extra comma-separated origins allowed to call the API cross-origin. The server's own origin and browser-extension origins (`chrome-extension://`, `moz-extension://`) are always allowed. |
| `AUTH_MAX_FAILURES` / `AUTH_WINDOW_MINUTES` | `10` / `15` | Failed sign-ins allowed per IP and username per window before `429`, so people behind one NAT do not lock each other out. |
| `AUTH_IP_MAX_FAILURES` | 5 × `AUTH_MAX_FAILURES` | Failed sign-ins allowed per IP across all usernames. |
| `BACKUP_KEEP` | `7` | Boot-time database backups to keep (see below). |
| `SESSION_DAYS` | `180` | Session lifetime. |
| `MAX_SNAPSHOTS` | `200` | Tree history rows kept, per account. |
| `HOST_PORT` | `18921` | The port the server listens on, on the host's network (docker-compose uses `network_mode: host`). |

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

**The identity key.** On its first start the server also makes
`identity.jwk` in the data directory: the ECDSA P-256 key it proves itself
with at `/api/identity`. Keep it with your backups of `sync.db`. A server
restored without it makes a new key, and every client that pinned this server
(the browser helper, once it ships) then refuses it until someone pins it
again by hand. The file is private: whoever holds it can pass as your server.
A key file whose content is not a valid key is moved aside
(`identity.jwk.unreadable-<timestamp>`), never deleted, and a new key made; the
log says so, and prints the key's id (`identity key <id>`) on every start. A
key file the server cannot read at all is left as it is and no new key is
made: `/api/identity` answers 503 and the log says what to fix. After a
restore, check that the file belongs to the server's user (in the container,
`node`, uid 1000; the entrypoint takes over files it can on start) before the
first start, or the server serves without its identity until it does.

### Upgrading an existing server

Existing data, the existing account, its password and every signed-in device
keep working; the account becomes the admin. Before the first start of the new
image:

1. The server no longer runs as root. Its entrypoint hands `./data` to the
   server's user (uid 1000) on start, so nothing needs doing by hand. If the
   host refuses that (some NAS datasets do), it says so in the log and runs as
   root instead; set `RUN_AS=root` in `.env` to skip the hand-over.
2. If `TABPALADIN_TOKEN` is the example value this README used to publish, or
   shorter than 32 characters, the server refuses to start. Replace it with
   `openssl rand -hex 32` (and update anything still using it), or remove it
   once every client signs in with an account. If it was never set, the old
   compose file silently used that example value — it now defaults to off.

## Accounts

The first admin comes from `ADMIN_USERNAME` / `ADMIN_PASSWORD`. Admins add
further accounts from **Settings › Users**, in the extension or the PWA. Each
account starts with an empty tree and has its own of everything: tree and
history, notes, workflows, inbox, LLM share links, MCP tokens and proposals, Reddit / X /
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

A server that goes straight from before accounts to a later schema runs every
step on the same boot, and its copies are named after the version it ends at
(`sync.db.pre-v4-…`, `sync.db.post-v4-…`); `verify_tenancy.js` compares those
the same way.

### Upgrading to the share inbox (schema 4)

The first start of this version takes `sync.db.pre-v4-<timestamp>`, then, in
one transaction after the ownership migration:

- adds columns to `shared_links` (`sid`, `url_key`, `app`, `source`, `raw`,
  `status`, `note`, `updated_at`, `filed_at`), each only when it is missing.
  Every existing row keeps every value it had and reads as a pending share of
  its account — exactly the inbox it was;
- creates `share_filings` (where each share was filed) and, in the tree store,
  `tree_ops` (the log of filed links, see [Shared links](#shared-links));
- sets every account's ops floor to its current tree version, so nothing from
  before the upgrade can look like a gap a client may fold in.

The boot log says `Share inbox: added …`. A failure rolls the step back,
writes `data/MIGRATION_REFUSED` and stops, like the ownership migration.
Running it again is a no-op. Rolling back to the previous image means
restoring `sync.db.pre-v4-*` (the previous image refuses a schema-4 database);
links shared or filed since are lost with it, so export what you need first.

### Upgrading to AI chats (schema 5)

The first start of this version takes `sync.db.pre-v5-<timestamp>`, then, in
one transaction each, after the share inbox's step:

- adds columns to `note_proposals` (`payload`, `reason`, `source`,
  `token_id`, `base_version`), each only when it is missing. Every waiting
  proposal keeps every value it had and stays a note or order proposal, and
  `GET /api/proposals` answers exactly as before;
- creates `mcp_tokens` (the MCP tokens' hashes, names and dates), guarded
  like every per-account table and deleted with its account.

The boot log says `AI proposals: added …`. A failure rolls the step back,
writes `data/MIGRATION_REFUSED` and stops. Running it again is a no-op.
Nothing in the tree changes. Rolling back to the previous image means
restoring `sync.db.pre-v5-*` (the previous image refuses a schema-5
database); proposals and tokens made since are lost with it.

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

The one other write is a link filed from the share sheet (below): it appends
a bookmark (and any new folders) without replacing anything, bumps the version
once, and is logged in `tree_ops` instead of history. `GET
/api/tree/ops?since=N` returns `{ version, floor, complete, ops }`: `complete`
is true only when every change after N is such an append (or its undo). A
client whose push met a 409 with a complete gap folds `ops` into its working
copy and pushes again, so a link filed from the phone never turns into a
conflict prompt on the computer. Any other change in the gap — a push, an
approved proposal — makes it incomplete, and the client pulls as before.

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

All endpoints require `Authorization: Bearer <session token>` (from `/api/login`; or the legacy `TABPALADIN_TOKEN`) except `/api/auth/status`, `/api/login`, `/api/health`, `/api/identity`, the `/llm/...` share-link routes (those are protected by an unguessable, expiring token in the URL instead), `/mcp` (an MCP token, and nothing else) and the Reddit OAuth callback and confirm pages. Everything acts on the caller's own account.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | **no auth** — `{ ok, version, configured, app: 'tabpaladin', serverId }` |
| GET | `/api/identity?nonce=<hex>` | **no auth** — `{ app, serverId, alg: 'ES256', publicKeyJwk, keyId, nonce, sig }`: `sig` is ECDSA P-256 over `tp-identity\|1\|<nonce>\|<serverId>` (raw r‖s, base64url, as WebCrypto verifies it); the nonce is 32–128 lowercase hex characters; 503 when the server has no key |
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
| GET | `/api/tree/ops?since=N` | what a copy based on N missed, when that was only filed links or saved workflows: `{ version, floor, complete, ops, userId, serverId }` |
| POST | `/api/workflows` | save one workflow without pushing the copy: `{ workflow: { id, title, createdAt, tabs: [{ id, title, url }] }, rootId, expectUserId?, expectServerId? }` → `{ baseVersion, version, created, already, userId, serverId }`, appended under the account's workflows root as one logged append (the folder with payload `{ createdAt }`). Client ids; a retry is a no-op. 409 `no-root` (no such workflows root; nothing written, no root made), 409 `conflict` (an id is something else here), 412 for another account. Tab URLs: http, https and local `file:` only (no `javascript:`, `data:`, browser or extension pages, no UNC paths); at most 500 tabs and 8 KB per URL |
| GET | `/api/history` | list of past tree versions |
| GET | `/api/history/:id` | fetch a specific past version |
| POST | `/api/push`, GET `/api/pull` | **410 Gone** — the legacy snapshot sync, kept only to tell old clients to update |
| POST | `/api/shares` | take a share in `{ sid, url, title?, app?, urlKey?, source?, raw?, expectUserId?, expectServerId? }`; idempotent on `sid`; X / Instagram links are archived on arrival; `raw` past 10 KB is cut to fit, never refused |
| GET | `/api/shares` | `?status=pending\|filed\|archived\|dismissed&limit&before` — shares with their filings |
| GET | `/api/shares/:sid` | one share (`id-<n>` addresses a share taken in without a sid) |
| POST | `/api/shares/:sid/file` | `{ targets: [{folderId} \| {newFolder: {id, title, parentId}, existing?}], folders?, title?, url?, app? }` → `{ baseVersion, version, share, created, already, failed, userId, serverId }`; 422 when every target failed |
| POST | `/api/shares/:sid/unfile` | `{ folderIds? }` — undo: removes the bookmarks it made while unchanged and the folders it made while empty; answers with `userId` and `serverId` too |
| POST | `/api/shares/:sid/dismiss`, `/restore` | out of the inbox (never deleted), and back |
| GET | `/api/shares/stats` | `{ apps: { <app>: [{ folderId, n, last }] } }` over the last year |
| GET | `/api/prefs/share` | the share sheet's pins and hidden folders per app (an ordinary pref) |
| GET | `/api/shared` | legacy: the waiting links, `{ links: [{ id, url, title, created_at }] }` |
| POST | `/api/shared` | legacy: add `{ url, title? }` (http(s) only) |
| DELETE | `/api/shared/:id`, `/api/shared` | legacy: dismiss one, or every waiting link of yours (nothing is deleted) |
| POST | `/api/share` | create an LLM share link (returns `{ url, expiresAt }`); a password change or reset ends every link of the account |
| GET | `/api/proposals` | pending note and reorder proposals, as it always answered (`{ id, title, content, notebook, kind, created_at }`) |
| GET | `/api/proposals/review` | every pending proposal, newest first: `{ id, kind: 'note'\|'reorder'\|'tree', title, createdAt, source: 'link'\|'mcp', tokenName, reason, status: 'pending'\|'stale', stale: [why], preview: [{ op, text, danger? }], counts, danger, reviewKey }`, bookmark changes planned against the tree as it is now: `title` says what one would do now (what it was proposed as, once stale), `danger` whether it deletes anything |
| POST | `/api/proposals` | file bookmark changes `{ changes, reason? }` (or one `{ action, … }`) for review — what the web app does with a `#changes=` review link; nothing is applied |
| POST | `/api/proposals/:id/approve` | apply a proposal: one transaction for the account (the change, a version bump, a history snapshot, the proposal's removal); body `{ reviewed? }`, the `reviewKey` of the preview the user was shown; **409** `code: 'stale'` with `stale: [why]` when something it names changed since, **409** `code: 'changed'` when it would now do something other than the preview `reviewed` names — nothing applied either way |
| POST | `/api/proposals/:id/reject` | discard a proposal |
| GET | `/llm/:token` | **no auth** — instructions, every bookmark folder (id and path), the first bookmarks and every note, as plain text; 410 when expired or the account is gone |
| GET | `/llm/:token/bookmarks?page=N` | **no auth** — every bookmark, 500 per page |
| GET | `/llm/:token/folder/:id?offset=N` | **no auth** — one folder's subfolders and bookmarks |
| GET | `/llm/:token/search?q=…` | **no auth** — bookmarks, folders and notes holding every word |
| POST | `/llm/:token/propose` | **no auth** — a proposal for approval: a note `{ title, content, notebook? }`, an order `{ action: 'reorder', order }`, or bookmark changes `{ action: 'create_folder'\|'add_bookmarks'\|'move'\|'rename'\|'delete'\|'changes', …, reason? }` (also `POST /llm/:token`) |
| GET | `/api/mcp/tokens` | signed-in session — the account's MCP tokens `{ id, name, prefix, scope, createdAt, lastUsedAt }` and the endpoint |
| POST | `/api/mcp/tokens` | signed-in session — `{ name }` → the token, **shown once**; at most 20 per account |
| DELETE | `/api/mcp/tokens/:id` | signed-in session — revoke one |
| POST | `/mcp` | **MCP token** (`Authorization: Bearer tpm_…`) — the MCP endpoint (Streamable HTTP, stateless, JSON); GET and DELETE answer 405 |
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

## Shared links

Every link shared to the app — from the Android share sheet, a pasted link or
the clipboard — is a row in the account's `shared_links`, made idempotent by
the client's share id (`sid`): the service worker and the app may both upload
the same share, and a retry after a lost answer lands one row. Its `status`:

| status | means |
|---|---|
| `pending` | waiting in the inbox |
| `archived` | an X or Instagram post: archived on arrival (as `/api/imports/capture` always did), waiting to be filed or left there |
| `filed` | filed into one or more folders (`share_filings`) |
| `dismissed` | Later / ✕ — out of the inbox, never deleted; `restore` brings it back |

**Filing** (`POST /api/shares/:sid/file`) appends a bookmark at the end of each
chosen folder in one transaction: new folders first (a client may send a
folder it made itself and has not pushed, with its own id, so its later push
matches), then the bookmarks, one version bump and one `tree_ops` append — no
history snapshot, so a phone's shares cannot push the restore points out of
the window. A folder already holding this share, or this exact URL, is
reported as `already` and gets no second copy. Folders inside notes,
workflows or pins, and the virtual archive, are refused. Other waiting shares
of the same link are filed with it, and an X or Instagram share's archive row
is marked filed so it is not drawn twice. **Undo** (`unfile`) removes the
bookmarks it made while they still carry that URL and the folders it made
while they are empty, and logs an unappend.

**A forced push** from a copy that never saw a filing can erase it. When a
`force` push's `baseVersion` is older than the server's, filings made since
whose bookmark was in the tree just before the push and is gone after it are
dropped, and a share left with none goes back to the inbox with the note
*Removed by a forced push from <device>*. A push that saw the bookmark and
deleted it was deliberate, and so was any delete before the forced push: the
share stays filed, its filing marked `present: false`.

**Whose share.** Every share route that changes something (`POST /api/shares`,
`file`, `unfile`, `dismiss`, `restore`) takes an optional `expectUserId` and
`expectServerId`: the account a phone kept the share for. When they name
another account or server than the session's, the answer is **412**
`code: "wrong-account"` and nothing changes — a page still holding an older
session's token never files one account's share into another's tree.

## LLM share links

The web app's "🔗 Share notes & bookmarks with an AI chat" button (Notes, and
Settings → AI chats) calls `POST /api/share` and copies a link like
`https://<host>/llm/<token>`. Paste it into any AI chat with web access. The
page tells the chat what it may do and lists, as plain text:

- every bookmark folder with its id and path (`[ab12cd34] Bookmarks / Tech`),
  Pinned and Workflows marked read-only;
- the first 300 bookmarks under their folders (`- [id] Title — address`),
  with a **TRUNCATED** note and the links to read the rest:
  `/llm/<token>/bookmarks?page=N` (500 per page), `/llm/<token>/folder/<id>`
  and `/llm/<token>/search?q=<words>`;
- every note, grouped by notebook, as before.

The chat can never change anything: it can only `POST .../propose`, and the
proposal waits for the user. Bookmark proposals name nodes by id:

| action | body |
|---|---|
| `create_folder` | `{ parentId, path: 'Name' or 'A / B' }` — missing levels are made, existing ones reused |
| `add_bookmarks` | `{ folderId, bookmarks: [{ title, url }] }` — http(s), at most 100; one already in the folder is skipped |
| `move` | `{ ids, toFolderId }` — bookmarks and folders (with everything in them) |
| `rename` | `{ id, title }` |
| `delete` | `{ ids }` — shown to the user flagged as a DELETE; a folder goes with what it holds; at most 200 deleted per proposal |
| `changes` | `{ changes: [{ op, … }] }` — up to 50 of the above, applied together; a `create_folder` may set `ref`, and later ones use `parentRef` / `folderRef` / `toFolderRef` |

Every body may carry a `reason`, shown to the user. Only the bookmark side
can change: never a role folder (Bookmarks, Notes, Workflows, Pinned) itself,
nothing inside Notes, Workflows or Pinned, no note, and not the imported
archive. A proposal is checked against the tree when it is made (a bad one is
refused with the reasons, at most 50 of them) and again whenever it is listed
or approved: every node it names was fingerprinted (kind, title, parent,
address), a folder it deletes also by what it holds (every id below it), and
one that changed since makes it **stale** — shown with why, never applied. At
most `MAX_PROPOSALS_PER_USER` wait per account, link and MCP together.

The preview has a line per change. Every DELETE line is in it; past 60 other
lines the rest are counted (`… and N more, none of them a deletion`).
`danger` is set when anything at all is deleted. A body that carries a note's
`content` is a note proposal whatever its `action` says (unless it is a
`reorder` or has a `changes` list), as the link took it before bookmark
changes.

Approving a bookmark proposal applies all of it in one transaction for the
account, bumps the version (clients pull, as after any proposal), writes a
history snapshot (`device_id: 'ai-proposal'`) and removes the proposal; one
that deletes anything first snapshots the tree as it was
(`device_id: 'before-ai-proposal'`), so links filed since the last snapshot
are in a history version too. The web app sends the `reviewKey` of the
preview it showed, and the server refuses (409 `changed`) when the plan now
reads otherwise. A note proposal writes the note straight into the items
table (creating or replacing the note with that title), as always.

Links expire after 1 hour by default; override with `SHARE_TTL_MINUTES`.
Changing the account's password, or an admin resetting it, ends them at once.
The imported archive (Reddit, X, Instagram) is not on the page.

Notes are grouped into **notebooks** (subfolders of the notes root);
proposals can include an optional `"notebook"` field and the share page lists
notes grouped by notebook.

For LLM chats that cannot POST, the share page also teaches a universal
review link: `https://<host>/#note=<percent-encoded markdown>[&notebook=<name>]`.
The fragment never reaches the server — the PWA opens the note in its editor
for review and only stores it when the user presses Save. Bookmark changes
have one too, `https://<host>/#changes=<percent-encoded {"changes": […]}>`:
the signed-in app asks, then files them with `POST /api/proposals` as a
suggestion waiting on Home; the link applies nothing.

## MCP (AI chats with a token)

`POST /mcp` is a [Model Context Protocol](https://modelcontextprotocol.io)
server for MCP clients — Claude Code directly, Claude Desktop through
`tools/mcp_bridge.mjs`, any other client that can send a header. Setup for
each is in the [main README](../README.md#-use-tabpaladin-with-ai-chats).

- **Transport:** Streamable HTTP, stateless (no `Mcp-Session-Id`), JSON
  responses, served by the official SDK (`@modelcontextprotocol/sdk`,
  pinned). Protocol versions 2024-11-05 to 2025-11-25, the `initialize`
  era; a client of the 2026-07-28 revision falls back to that, as that
  revision prescribes. GET and DELETE answer 405.
- **Tools:** `search_bookmarks`, `list_folders`, `list_folder` (by id or
  path), `get_bookmark`, `list_notes`, `read_note`, `search_notes`;
  `propose_create_folder`, `propose_add_bookmarks`, `propose_move`,
  `propose_rename`, `propose_delete`, `propose_changes`, `propose_note`,
  `propose_note_order` — the share link's proposals: same checks, same
  queue, same approval; `list_my_proposals` — this token's, still waiting,
  with whether each is stale.
- **Tokens:** made, listed and revoked in the web app (Settings → AI chats),
  only by a signed-in session. `tpm_` and 43 more characters, shown once;
  the server keeps its SHA-256 hash, a name, when it was made and last used,
  and the scope `read propose`. Sent as `Authorization: Bearer tpm_…`, never
  in the URL. A token opens `/mcp` and nothing else, and `/mcp` takes
  nothing else. It stops working when revoked, when its account's password
  is changed or reset, or when the account is deleted.
- **Limits:** `MCP_RATE_LIMIT_PER_MINUTE` requests per token (default 120),
  `MCP_AUTH_MAX_FAILURES` wrong tokens per client address per 15 minutes
  (default 20), a 256 KB body, and every tool answer, errors included, at
  most 100 KB of UTF-8 (lists, `list_my_proposals` too, are paged with
  `offset` / `limit`; a long note comes in parts: `read_note` answers
  `nextOffset` until the end, and takes `offset`).
- **Origin:** a request with an `Origin` header (a web page) is refused with
  403 unless `MCP_ALLOWED_ORIGINS` (comma-separated) lists it — the MCP
  transport's DNS-rebinding rule. MCP clients send none. A listed origin (the
  MCP Inspector in a browser, say) gets CORS from `/mcp` itself: its
  preflight is answered (`POST`; `Content-Type`, `Authorization`,
  `Mcp-Protocol-Version`, `Mcp-Session-Id`, `Last-Event-ID`), and every
  answer carries `Access-Control-Allow-Origin`.

**Not yet: claude.ai custom connectors with OAuth.** The hosted Claude apps
(claude.ai, Claude Desktop's Connectors, mobile) reach a remote MCP server
from Anthropic's cloud and sign in with OAuth 2.1 (Dynamic Client
Registration or a Client ID Metadata Document); a fixed bearer token there
("Request headers") is a beta for a limited set of organizations.
TabPaladin has no OAuth server yet. The follow-up, when wanted:

1. `/.well-known/oauth-protected-resource` (and `…/mcp`):
   `{ resource: "https://<host>/mcp", authorization_servers: ["https://<host>"], scopes_supported: ["read", "propose"], bearer_methods_supported: ["header"] }`;
   `/mcp`'s 401 gains `WWW-Authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource", scope="read propose"`.
2. `/.well-known/oauth-authorization-server`: `issuer`, `authorization_endpoint`
   (`/oauth/authorize`), `token_endpoint` (`/oauth/token`, form-urlencoded),
   `registration_endpoint` (`/oauth/register`, JSON, RFC 7591),
   `response_types_supported: ["code"]`, `grant_types_supported: ["authorization_code", "refresh_token"]`,
   `code_challenge_methods_supported: ["S256"]`, `token_endpoint_auth_methods_supported: ["none"]`,
   `client_id_metadata_document_supported: true`, `authorization_response_iss_parameter_supported: true`.
3. Clients: a global `oauth_clients` table (capped, registration
   rate-limited); redirect URIs limited to `https://claude.ai/api/mcp/auth_callback`
   and the loopback `http://localhost/callback` / `http://127.0.0.1/callback`
   on any port (Claude Code); CIMD documents fetched with SSRF guards.
4. Consent: `/oauth/authorize` cannot see the web app's session (it lives in
   the app's storage, not a cookie), so it hands over to the app
   (`/#oauth=<request id>`), which shows the client's name and redirect
   host, asks, and posts its session to `/api/oauth/approve`; the server
   then redirects with a single-use 60-second code, `state` and `iss`.
5. Tokens: PKCE S256 required; `resource` must be this `/mcp`; access
   tokens (1 hour) and rotated refresh tokens (`invalid_grant` once used or
   revoked), stored hashed in a per-account table guarded and deleted with
   the account like `mcp_tokens`, listed and revocable in Settings, revoked
   by a password change; every answer well under Claude's 10-second limit.
6. A schema step, tests for discovery, registration, PKCE, redirect and
   resource mismatches, code reuse, refresh rotation and revocation, and the
   server reachable from Anthropic's addresses (`160.79.104.0/21`).

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

A share arriving at `POST /api/shares` is archived through the same routine
as `POST /api/imports/capture`, which also stays for older clients. It
classifies by host, creates the source on first use (nothing to set up), and
returns `captured:false` for anything else. Share-sheet tracking parameters
(`?t=`, `?s=`, `?igsh=`) are stripped before storing, or the same post shared
twice would archive twice. Filing such a share into a folder marks its archive
row filed, so it is not drawn twice; Later leaves it in the archive only.

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
node tools/test_share_sw.mjs   # PWA service worker: shares kept before the network, the shell cache
node tools/test_share_core.mjs # the share core: what a share holds, cleaning, apps, suggestions, outbox, folding appends
node tools/test_share_pwa.mjs  # the share sheet in the PWA against a real server: one-tap filing, undo, offline, rebase, kept copy
node tools/test_pwa_release.mjs # the PWA's version numbers agree, and the shell holds what it loads
node tools/test_security.mjs  # token check, async scrypt, rate limiter, HTML escaping, identity key; a live server's headers, health and identity (--port)
node tools/test_workflows_append.mjs # POST /api/workflows: URL allowlist, append, retries, conflicts, no-root, folding (starts a server: --port)
node tools/test_render_safety.mjs # notes, bookmarks and links render as text, never markup; the PWA's innerHTML audit
node tools/test_shared_sync.mjs   # the files the extension and the PWA share are byte-identical (tools/sync_shared.mjs copies them)
node tools/test_users.mjs     # users migration, first-admin bootstrap, backups
node tools/test_tenancy.mjs   # ownership migration, per-account isolation, deletion, SQL scan, end-to-end upgrade of an old server's data
node tools/test_shares.mjs    # share inbox: migration, intake, filing, undo, legacy routes, forced-push safety net, and an upgrade rehearsal on a database the schema-3 server wrote (starts servers: --port, --old-port)
node tools/test_pwa_accounts.mjs  # the PWA against a real server: queued shares, unpushed edits across sign-ins, Users block, suggested changes on Home
node tools/test_llm_api.mjs  # the LLM share link: page, pages, search, bookmark proposals, staleness, approval, tenancy (starts a server: --port)
node tools/test_mcp.mjs      # the MCP endpoint: tokens, protocol, tools, auth failures, isolation, limits, the stdio bridge (starts a server: --port)
node tools/test_pwa_durable.mjs   # the PWA's copy kept in IndexedDB: seeding from tp-data, reloads, live drafts, one window editing, accounts, a full disk, persist() (starts a server: --port)
ADMIN_USERNAME=tester ADMIN_PASSWORD='correct horse battery' AUTH_MAX_FAILURES=8 IMPORTS_SCHEDULER=off MAX_PROPOSALS_PER_USER=3 DATA_DIR=/tmp/tp node server/index.js &
node tools/test_auth.mjs --url http://127.0.0.1:18921 [--legacy <token>]   # against a live server
```

### Sharing from a phone

The PWA declares a share target: **Share → TabPaladin** from any app. The share
posts to `/share`, which the **service worker** answers:

1. It writes the share to the outbox (`tp-outbox` in Cache Storage) before
   anything touches the network, with an id of its own and the account
   signed in, then answers `303` to `/?share=<id>` — the link itself never
   goes into a URL.
2. In the background it uploads the share (`POST /api/shares`, a 6 s
   timeout). X and Instagram posts are archived on arrival, as before.
3. The app opens on the share, from cache, with the **Save link** sheet: the
   folders you usually use for that app as chips (pinned ones first, then
   the last one used, then where most of that app's links are). One tap files
   it there — straight into the server's tree, not a push of the phone's copy
   — and another tap files it into a second folder; Undo takes it back. Other
   folders, new ones and pins are a tap away.

Offline, signed out, a session that expired, a server that refuses or never
answers: the share stays in the outbox, every folder chosen meanwhile (each
tap adds to the last, never replacing it) is filed when the phone is back
online (Background Sync where there is one, otherwise coming back to the app
or the next start), and the Inbox lists what waits. A share captured as one
account is never uploaded to another without a yes: each request names the
account it was kept for, and the server refuses it for any other. The worker
cannot read `localStorage`, so the app window holding the session mirrors
the server URL, session token and account into a `tp-config` Cache Storage
entry, cleared on sign-out.

The share reloads the app's window, so the app keeps its working copy on the
device — in IndexedDB (database `tabpaladin`, store `kv`, key `tpTree`), a
moment after every change and at once when it goes to the background — and
the note being written as it is typed (`tpLiveDraft`), and brings them back
without pulling over unpushed edits. For one more release the same copy is
also written to Cache Storage (`tp-data`), where the previous release looks
for it; the first start of this one fills IndexedDB from there. Settings ›
Storage shows where the copy is kept and whether the browser may clear it to
make room, and asks it not to (**Keep my data on this phone**).

One window of the app edits the copy at a time (the Web Lock `tp-primary`):
another tab or window says *TabPaladin is open in another tab* and offers
**Use here**, which has the first one write down what it holds and let go. A
window a share or an import link opened takes over at once.

When the outbox cannot be written, the worker falls back to the old redirect
`/?share=1&url=…&title=…&text=…` and the app keeps the share instead. `POST
/share` on the server does the same when no worker is registered yet (the
first share after installing). Losing the link is the one outcome worth
avoiding.

## TLS

Mobile browsers refuse to install a PWA or fire share-target intents over plain
HTTP. Put a reverse proxy in front (Traefik, Caddy, NPM, a Cloudflare Tunnel,
`tailscale serve`) and terminate TLS there. Use https for every device, not
only phones: the coming browser helper hands tab access to the page at your
server's address, and over plain http anyone on the network path can be that
page. A plain-http LAN address will only be allowed after an explicit
warning. Local desktop testing over HTTP works fine.

## Response headers

Every response carries `X-Content-Type-Options: nosniff` and
`Referrer-Policy: no-referrer`.

The web app (every file under the PWA directory) enforces the full policy:
`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: https://www.google.com https://*.gstatic.com;
connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none';
base-uri 'none'; form-action 'self'; frame-ancestors 'none'`.
PWA 34 locks its server address to its own `location.origin`; previously saved
copies for another address stay in browser storage for recovery. The app's HTML
also gets `Cross-Origin-Opener-Policy: same-origin` and `X-Frame-Options: DENY`.

Every other HTML response — the Reddit connect pages, Express's 404, error
and redirect pages — carries a script-free policy (`default-src 'none';
style-src 'unsafe-inline'; base-uri 'none'; form-action 'self';
frame-ancestors 'none'`). A reverse proxy in front should pass these
headers through unchanged.
