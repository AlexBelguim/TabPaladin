# TabPaladin Sync Server

Tiny Node + SQLite backend for the TabPaladin extension and PWA.

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

## Endpoints

All endpoints require `Authorization: Bearer <TABPALADIN_TOKEN>` except `/api/health` and the `/llm/...` share-link routes (those are protected by an unguessable, expiring token in the URL instead).

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | server status |
| POST | `/api/push` | upload `{ snapshot, deviceId? }` |
| GET | `/api/pull` | get latest snapshot |
| GET | `/api/history` | list of past snapshot timestamps |
| GET | `/api/history/:id` | fetch a specific past snapshot |
| GET | `/api/shared` | pending links inbox |
| POST | `/api/shared` | add `{ url, title? }` |
| DELETE | `/api/shared/:id` | remove one inbox entry |
| DELETE | `/api/shared` | clear inbox |
| POST | `/api/share` | create an LLM share link (returns `{ url, expiresAt }`) |
| GET | `/api/proposals` | list pending LLM note proposals |
| POST | `/api/proposals/:id/approve` | apply a proposal to the latest snapshot (new snapshot row) |
| POST | `/api/proposals/:id/reject` | discard a proposal |
| GET | `/llm/:token` | **no auth** — notes + LLM instructions as markdown; 410 when expired |
| POST | `/llm/:token/propose` | **no auth** — LLM submits `{ title, content, notebook? }` for approval |
| GET | `/api/imports` | list import sources with counts and last-run state |
| POST | `/api/imports` | create `{ provider, clientId, clientSecret, intervalMinutes? }` |
| PATCH | `/api/imports/:id` | enable/disable, change interval or credentials |
| DELETE | `/api/imports/:id` | remove a source; `?purge=1` also deletes its archive |
| GET | `/api/imports/:id/items` | browse the archive (`limit`, `offset`) |
| POST | `/api/imports/:id/run` | sweep now |
| POST | `/api/imports/:id/reproject` | rebuild the bookmark folder from the archive |
| GET | `/api/imports/:id/authorize` | returns the provider consent URL |
| GET | `/api/imports/reddit/callback` | **no auth** — OAuth redirect, guarded by a one-shot `state` |
| GET | `/` (and other paths) | serves the PWA |

## LLM share links

The PWA's "🔗 Share with LLM" button calls `POST /api/share` and copies a link
like `https://<host>/llm/<token>`. Paste it into any LLM chat with web access:
the LLM can read all notes plus instructions (note styling, `[[wikilinks]]`, and
that it must **never edit directly** — it can only `POST .../propose`). The
proposal lands in the PWA's *Pending approval* block; approving applies it to
the snapshot (creating or replacing the note with that title).

Links expire after 1 hour by default; override with `SHARE_TTL_MINUTES`.
Unauthenticated routes expose only the notes folder, never the full snapshot.

Notes are grouped into **notebooks** (subfolders of `TabPaladin Notes`);
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
window are stamped as gone from the source and keep their bookmarks.

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

Saved posts and saved comments both land as bookmarks under:

```
TabPaladin Imports/Reddit/Saved/<YYYY-MM>/
```

Grouped by the month the post was created, so re-projecting always produces the same
tree. From there they are ordinary bookmarks — they sync to every device, and
workflows, pins and the AI organiser all work on them.

### How it holds together

The archive lives in the `import_items` table, not in the snapshot. `/api/push`
replaces the snapshot wholesale with whatever a browser sends, so a device that pushes
before it pulls would otherwise drop the whole import folder — and for anything Reddit
has already forgotten, that snapshot was the only copy. Because the bookmark tree is a
*projection* of the table, the next sweep just rebuilds it; `POST
/api/imports/:id/reproject` forces that repair without touching the network.

A sweep that changes nothing writes no snapshot, so an idle importer does not churn
the history or trigger pointless pulls on every device.

**Imports are one-way.** Deleting an imported bookmark in TabPaladin never un-saves
anything on Reddit.

### Tests

```bash
node tools/test_imports.mjs
```

## TLS

Mobile browsers refuse to install a PWA or fire share-target intents over plain
HTTP. Put a reverse proxy in front (Traefik, Caddy, NPM) and terminate TLS there.
Local desktop testing over HTTP works fine.
