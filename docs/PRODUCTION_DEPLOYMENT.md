# Production deployment

## Runtime topology

```
Internet
  |
  | HTTPS :443
  v
Caddy / nginx
  |
  | HTTP :8787
  v
WebNestDev Fastify
  |-- /             -> Vite dist/
  |-- /api          -> API
  |-- /ws           -> WebSocket
  |
  +--> YDB          -> persistent metadata
  |
  +--> Docker       -> sandbox/preview
```

## Required production environment

- `NODE_ENV=production`
- `WEBNESTDEV_STORAGE=ydb`
- `WEBNESTDEV_ALLOWED_ORIGINS=https://your-domain.example`
- `YDB_CONNECTION_STRING=grpcs://...`
- `YDB_TOKEN=...` when using an explicit access token, or YDB environment/metadata credentials in Yandex Cloud.
- GitHub OAuth URLs must use HTTPS when OAuth credentials are enabled.

The server intentionally fails fast in production when the allowed-origin list is missing or contains localhost.

## YDB

The server creates its required row tables on startup with `CREATE TABLE IF NOT EXISTS`. Persistent application metadata is stored in YDB; the local filesystem remains for the sandbox workspace itself.

For an existing installation that still has JSON metadata, run:

```bash
cd server
WEBNESTDEV_STORAGE=ydb npm run migrate:json-to-ydb
```

The migration is idempotent and uses UPSERTs.

## Docker

Build from the repository root:

```bash
docker build -f server/Dockerfile -t webnestdev:production .
```

The image contains the built Vite frontend, Fastify server, Chromium for browser inspection, and Docker CLI for the current sandbox architecture.

Do not expose the Docker socket publicly. The current socket-based sandbox is an interim architecture; the production target is a dedicated sandbox worker.

## HTTPS

Terminate TLS at Caddy/nginx/another reverse proxy. Keep Fastify on the private HTTP port 8787. WebSocket traffic must be proxied for `/ws`.

## Health endpoints

- `GET /api/health` — liveness plus dependency state.
- `GET /api/ready` — readiness; returns HTTP 503 when required dependencies are unavailable.


## Verification note
Production changes are validated in CI before merge; runtime YDB connectivity is checked separately in the target Yandex Cloud environment.
