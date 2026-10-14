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
- Phone login sends real SMS as soon as one Russian provider block is set. Yandex
  Cloud Notification Service first (`YANDEX_NOTIFY_IAM_TOKEN` or `YANDEX_SA_KEY` +
  `YANDEX_CLOUD_ID`), otherwise `SMS_RU_API_ID`, or `SMSC_LOGIN`+`SMSC_PASSWORD`, or
  `EXOLVE_API_KEY`, or `SMSAERO_EMAIL`+`SMSAERO_API_KEY`; sender name via `SMS_SENDER`
  or `YANDEX_SMS_SENDER`. With none set, the server stays in test mode and logs the
  code — safe for staging, not for real users. Keep `WEBNESTDEV_SMS_TEST_MODE` unset in
  production. Note the Yandex sender registration lead time (see
  [AUTH_PRODUCTION_PLAN.md](AUTH_PRODUCTION_PLAN.md)).

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

## GitHub Actions deployment

[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) builds the image, pushes it to GHCR (`ghcr.io/<owner>/<repo>`) and then runs [`deploy/scripts/vm-deploy.sh`](../deploy/scripts/vm-deploy.sh) **on the server** — over SSH, or locally when the job runs on a self-hosted runner installed on the VM itself.

Start it from Actions → **deploy** → *Run workflow*. It is manual on purpose: a push to `main` does not go to production during development. Uncomment the `push` block in the workflow to deploy on every push to `main`.

Two modes:

- **image** (default) — the VM pulls the published image and starts it with Compose (`WEBNESTDEV_IMAGE`); the code directory is not touched.
- **source** — the VM runs `git fetch` / `git checkout` / `git pull --ff-only`, `npm ci`, `npm run build` and `sudo systemctl restart $SYSTEMD_UNIT`.

Rollback: run the workflow again with mode `image` and `image=ghcr.io/<owner>/<repo>:sha-<12 символов коммита>` of the previous build (every tag is listed in the GHCR package page).

Repository secrets (Settings → Secrets and variables → Actions → **Secrets**):

| Secret | Value |
| --- | --- |
| `DEPLOY_HOST` | VM address reachable from the runner |
| `DEPLOY_USER` | SSH user on the VM |
| `DEPLOY_SSH_KEY` | private key (the public one goes to `~/.ssh/authorized_keys`) |
| `DEPLOY_PORT` | SSH port, optional, default 22 |
| `DEPLOY_KNOWN_HOSTS` | optional; without it the runner runs `ssh-keyscan` |

Repository variables (same page → **Variables**):

| Variable | Value |
| --- | --- |
| `DEPLOY_APP_DIR` | deployment directory holding `docker-compose.yml` and `.env`, default `~/webnestdev/src` |
| `DEPLOY_RUNNER` | self-hosted runner label; set it (and install the runner on the VM) when the VM has no inbound SSH |

Where the values come from — none of them is issued by a service, the only generated one is the key:

```bash
# on your machine: a dedicated key for the deploy, not your personal one
ssh-keygen -t ed25519 -f deploy_key -N ''
# public half goes to the deploy user on the VM:
ssh-copy-id -i deploy_key.pub <DEPLOY_USER>@<DEPLOY_HOST>
# private half (deploy_key) goes into the DEPLOY_SSH_KEY secret
ssh-keyscan -H <DEPLOY_HOST>   # DEPLOY_KNOWN_HOSTS, optional
```

`DEPLOY_HOST`, `DEPLOY_USER` and `DEPLOY_PORT` are the address, login and port you already use to reach the VM; `DEPLOY_KNOWN_HOSTS` is optional, without it the runner runs `ssh-keyscan` itself. With a self-hosted runner (`DEPLOY_RUNNER` set) the SSH secrets are not needed at all — the script runs on the VM itself. The `ci.yml` and `production-ci.yml` workflows need no secrets: `GITHUB_TOKEN` is issued automatically.

Application secrets are **not** copied into GitHub. `WEBNESTDEV_ENCRYPTION_KEY`, OAuth client secrets, SMS keys and AI-provider keys belong to the server and stay only in the `.env` inside `DEPLOY_APP_DIR` on the VM: Compose reads them there, and the deploy workflow never sees them — it builds the image, runs the tests (they set the key they need themselves, no real secret required) and restarts the service. A second copy in Actions would add another place to leak and to rotate without giving the pipeline anything. The one GitHub-side credential the VM may need is a one-time `docker login ghcr.io` with a token that can `read:packages` — entered on the VM and kept there. Alternatively make the GHCR package public in the package settings, and no login is needed.

The `production` environment is created on the first run; add *Required reviewers* there to make every deploy wait for an approval.

What the VM needs before the first deploy: Docker with the Compose plugin, `DEPLOY_APP_DIR` containing `docker-compose.yml` and a filled `.env` (see [make-env-vm.sh](../deploy/scripts/make-env-vm.sh)), and `git` plus Node.js when using mode `source`. A private GHCR image needs a one-time `docker login ghcr.io` on the VM — the script prints the command and exits with code 3 when the pull fails. The deploy is considered successful only after `/api/ready` returns 200; otherwise the script prints `/api/health` (it answers even when readiness fails) and exits with code 1.

## HTTPS

Terminate TLS at Caddy/nginx/another reverse proxy. Keep Fastify on the private HTTP port 8787. WebSocket traffic must be proxied for `/ws`.

## Health endpoints

- `GET /api/health` — liveness plus dependency state.
- `GET /api/ready` — readiness; returns HTTP 503 when required dependencies are unavailable.
