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

`POST /api/imports/capture { url, title }` does the routing. It classifies by
host, creates the source on first use (nothing to set up), and returns
`captured:false` for anything else so the client falls back to the ordinary
shared-links inbox. Share-sheet tracking parameters (`?t=`, `?s=`, `?igsh=`) are
stripped before storing, or the same post shared twice would archive twice.

These sources have no credentials and no sweep, so the clients drop the
Authorise, Sweep and Pause controls for them. Everything else is identical —
same folder layout, same protections, same move/delete behaviour.

Two things this is not: it captures only what you deliberately share from now
on, with no backfill of anything you liked previously; and a share carries just
a URL and sometimes a title, so there is no author or date beyond capture time.
Grouping uses capture time for that reason.

A true one-tap floating overlay is not possible here — drawing over other apps
needs `SYSTEM_ALERT_WINDOW`, a native Android permission with no web equivalent.
That would be a separate native app firing the same share intent.

### The import folder is managed, not yours to rearrange

The projection is a full rebuild, so a naive sweep would undo whatever you did:
move an import out to file it and a second copy comes back, delete one and it
returns within the hour. Instead, each projection first reads the folder and acts
on what it finds:

| you did | result |
|---|---|
| left it alone | stays where it is |
| **moved it out** of the import folder | marked filed — still archived and counted, never projected back, so no duplicate |
| **deleted it** | purged from the archive, plus a contentless tombstone so a later sweep does not re-import it |
| put your *own* bookmark in the folder | ejected — moved back out beside the imports root, never deleted |

Taking things **out** is the only edit the folder supports. Both clients refuse
drops into the subtree and hide the controls that would write into it (new
subfolder, split, batch select), but the browser's own bookmark manager has no
such manners — hence the ejection, which is what keeps a stray bookmark from
being deleted by the next rebuild.

Deleting is unrecoverable — the archived copy is gone, and anything past Reddit's
1000-item window cannot be fetched again. `POST /api/imports/:id/undismiss`
clears the tombstones so a later sweep may restore items *still saved on Reddit*;
it cannot bring back the rest.

Two guards keep that from eating the archive, and both matter:

- **No import folder in the snapshot** means the tree predates it — a device that
  pushed before it pulled. Everything would look deleted, so nothing is
  reconciled and the rebuild heals the folder instead.
- **An item imported after the snapshot was taken** cannot have been deleted in
  it; it did not exist yet. Without this, a stale device pushing an old copy of
  the folder would purge every item swept since it last pulled.

Both clients tint the folder and show a short explainer inside it, so this is
visible before you start dragging things around.

### Tests

```bash
node tools/test_imports.mjs
```

## TLS

Mobile browsers refuse to install a PWA or fire share-target intents over plain
HTTP. Put a reverse proxy in front (Traefik, Caddy, NPM) and terminate TLS there.
Local desktop testing over HTTP works fine.
