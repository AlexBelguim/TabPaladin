# TabPaladin Sync Server

Tiny Node + SQLite backend for the TabPaladin extension and PWA.

## Run on TrueNAS (or any Docker host)

```bash
cd server
# Set a long random token:
echo 'TABPALADIN_TOKEN=7f3b8e2a9c5d4f1e0b9a8c7d6e5f4a3b' > .env
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

## TLS

Mobile browsers refuse to install a PWA or fire share-target intents over plain
HTTP. Put a reverse proxy in front (Traefik, Caddy, NPM) and terminate TLS there.
Local desktop testing over HTTP works fine.
