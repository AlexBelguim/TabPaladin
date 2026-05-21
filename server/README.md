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

All endpoints require `Authorization: Bearer <TABPALADIN_TOKEN>` except `/api/health`.

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
| GET | `/` (and other paths) | serves the PWA |

## TLS

Mobile browsers refuse to install a PWA or fire share-target intents over plain
HTTP. Put a reverse proxy in front (Traefik, Caddy, NPM) and terminate TLS there.
Local desktop testing over HTTP works fine.
