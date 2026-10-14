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

## Sandbox and preview

Agent commands and the live preview run in containers started by the server through the mounted socket. Both mount the project directory from `WEBNESTDEV_SANDBOX_DIR`, and that path is resolved by the **Docker daemon on the VM**, not by the server process. The directory therefore has to exist on the host under exactly the same absolute path and be mounted into the server container the same way: `docker-compose.yml` does it with `SANDBOX_DIR` (default `/var/lib/webnestdev/sandboxes`), and [`deploy/scripts/make-env-vm.sh`](../deploy/scripts/make-env-vm.sh) writes the same path into `.env` and creates it. A named volume or a container-only path is not enough — the sandbox and preview containers would get an empty directory while the agent writes files into the server's own copy.

- Project directories are opened to the sandbox user (`chmod 0777` on the project root): the containers run as uid 1000 while the server writes files as root.
An installation that predates the host path keeps its project files in the `webnestdev-data` volume; move them once with [`deploy/scripts/migrate-sandboxes.sh`](../deploy/scripts/migrate-sandboxes.sh) (`SANDBOX_DIR=/var/lib/webnestdev/sandboxes bash migrate-sandboxes.sh` from the deployment directory), otherwise existing projects open empty.

- A preview runs in one of two modes and `PREVIEW_MODE` picks it. `auto` (the default) builds the project with `npm run build` inside the sandbox and serves the output (`dist`, `build` or `out` containing an `index.html`; `PREVIEW_STATIC_DIR` overrides the choice) **from the server process itself** — no container, so a small host keeps several projects previewable at once. A project without a build script, with a failing build, or without an `index.html` falls back to the per-project dev server and the panel says why. `container` is that dev server with live reload; `static` forbids the fallback. A static preview has no hot reload: it is rebuilt on the next start when a source file is newer than the served build (`PREVIEW_STATIC_BUILD=always` rebuilds every start, `never` serves whatever is there), and its logs face shows the build output instead of dev-server output.
- A preview is stopped after five minutes without use (`PREVIEW_IDLE_MS`, `0` disables the sweep; `PREVIEW_SWEEP_MS` sets how often it runs). Use means: a status or logs read, a proxied request, or the open panel's heartbeat — a closed tab stops sending it, and the container is freed. A project with a run in flight is never swept.
- The cheapest tier comes first and is decided by the project itself, not by a flag: a project whose files are already servable (`index.html` and no build script) is **served as is, with no build and no container**, and files present in `dist`/`build`/`out` are served the same way. A project with a build script is built once and served from `dist`; a project that answers HTTP itself (express, fastify, Nest, Next in server mode, FastAPI) is recognised as such *before* anything is built, so no container is spent on a build that cannot produce a static preview. The decision and its evidence live in `server/src/preview/project-kind.ts` (structure, dependencies and commands together — `package.json` alone proves nothing).
- **A user's `Dockerfile` is never executed.** `docker build` runs its steps as root without the memory, PID and network limits that `docker run` applies, so it is not the same trust level as the rest of the platform; the file is reported as evidence and the project is served by our own image. An isolated builder is a separate product, not a flag.
- A runtime preview is the one kind that is counted: `PREVIEW_MAX_CONTAINERS` (default `3`, `0` disables the cap). At the cap, the *oldest preview of the same user* is stopped to make room; another user's running app is never stopped behind their back — the request is refused with a reason instead. Static previews are not counted: a listener costs ~0.5 MB.
- `GET /api/health` reports what the host is doing right now — the three queues (runs, sandbox containers, Chromium) with `active`/`queued`/`limit`, live previews per kind, disk usage of the sandbox directory and RSS/swap. These are the four numbers from the launch checklist, and the point of them is that a queue nobody can see is indistinguishable from a hang.
- The preview container is not published on the host. It joins the server's Docker network and is reached at its own container address on port 3000, so a user's app never appears on the VM's public address. `PREVIEW_NETWORK` pins another network; `PREVIEW_REAP_ON_START=0` skips stopping preview containers left over from a previous server run (set it when several replicas share one Docker host).
- The preview is framed by the workspace, so the server answers with `X-Frame-Options: SAMEORIGIN` and the proxy rewrites the app's root-absolute URLs (`/assets/...`, `/@vite/client`, `/_next/...`) onto the proxy prefix. Live WebSocket HMR keeps working on the app's direct address, which is what the agent's `browser.*` checks use; inside the frame the page reloads after each agent run.

## How much this host runs at once

Three things are bounded, and they are not the same thing: **conversations**, **containers** and
**Chromium**. What costs memory is the second and the third; a conversation mostly waits for the
model over the network. Bounding the conversation was a mistake this section used to describe:
one user held the whole host while doing nothing, and everyone else queued behind an idle chat.
All three limits are printed at startup (`[agent] …`, `[sandbox] …`).

- `AGENT_MAX_CONCURRENT_RUNS` (default `8`) — conversations running at once. A run that arrives
  while the limit is reached waits in a queue (`AGENT_MAX_QUEUE`, default `64`) and the panel says
  so instead of looking stuck; `AGENT_QUEUE_TIMEOUT_MS` (default `300000`) bounds the wait, and a
  closed tab or a pressed stop releases the place at once. The daily run quota is consumed only
  once the run really starts, so a full queue never spends one of the user's daily runs; a request
  that finds no place at all is answered with `SERVER_BUSY`. Raise this with the provider's rate
  limit (and the budget), not with the host's memory.
- `SANDBOX_MAX_CONCURRENT` (default `2`) — **the memory limit of the platform**. Every command
  (`terminal.exec`, `npm.install`, `git.*`, the project terminal, the static preview's build)
  starts a fresh `docker run --rm --memory SANDBOX_MEMORY` container that lives seconds, so this is
  what has to fit in RAM. `--memory` is a ceiling rather than an allocation: a typical Vite build
  peaks at 300-500 MB, so two containers fit next to Postgres and the server on a 2 GB VM and four
  or more fit on 8 GB. `SANDBOX_MAX_QUEUE` (default `32`) and `SANDBOX_QUEUE_TIMEOUT_MS` (default
  `180000`) bound the wait; a full queue answers `503` and the command comes back to the model as
  a retryable error.
- One run **per account**, regardless of `AGENT_MAX_CONCURRENT_RUNS`: a second tab or a second
  project of the same user is refused with `RUN_ALREADY_ACTIVE` (the panel says the agent is busy)
  and never takes a second place or a place in the queue. Otherwise a single user with two open
  tabs would fill a two-place host and everyone else would wait behind them. The account is freed
  the moment the run ends — including a failed or cancelled one.
- `BROWSER_MAX_CONCURRENT` (default `1`) — Chromium instances at once. The browser worker launches
  Chromium **inside the server container**, where no memory limit applies, so this is what keeps a
  browser check from taking the whole platform down. `BROWSER_MAX_QUEUE` (default `8`) and
  `BROWSER_QUEUE_TIMEOUT_MS` (default `60000`) bound the rest.

Raise these only together with memory. The server container has no memory limit of its own, so
exceeding the host shows up as an OOM of the entire server rather than of one sandbox.

Preview containers are the one container kind this limit does **not** cover: a `PREVIEW_MODE=container`
dev server is started by name and then lives until it is stopped, so the number of them is bounded
by the idle sweep and by the plan's project limit, not by `SANDBOX_MAX_CONCURRENT`.

### What one 2 vCPU / 4 GB VM actually serves (measured)

Numbers below were measured on this repository (server code, Node 22), not estimated, except
where marked:

| Measured | Result |
| --- | --- |
| Live agent conversation (context + stream + message array) | **~0.16-0.5 MB each** — 100 concurrent runs held in-flight added 15.7 MB of RSS in total, 0 failures |
| Static preview (listener in the server process) | **~0.5 MB each** — 30 previews added 13.7 MB |
| Baseline Node server process | ~90 MB |
| Sandbox command container | up to `SANDBOX_MEMORY` (1 GB ceiling, typically 300-500 MB) — not measurable without Docker |
| Postgres 17 in the same compose | ~150-250 MB — estimate |

What that means in practice on a 4 GB VM: OS and Docker ~0.3-0.5 GB, Postgres ~0.2 GB, the
server ~0.15-0.2 GB, **two** command containers ~0.6-1.0 GB, one or two container previews
~0.3-0.8 GB, Chromium (one at a time, inside the server) ~0.3-0.5 GB. Typical total
1.5-2.7 GB, worst case ~3.2 GB — it fits, with swap as the safety net.

So the box is limited by **containers, not by conversations**: 2 heavy operations at a time
(seconds each) and as many open conversations as the provider quota allows — conversations are
so cheap that `AGENT_MAX_CONCURRENT_RUNS` can go to 20-30 here if the provider keeps up. What it
is *not* sized for is one long-lived dev-server container per project (that is what static
previews removed), and what it runs out of first is **disk**, not memory.

Practical capacity: **~100 active users**, assuming the usual 5-10 % of them work at the same
moment, of which a handful need a live runtime. The limit is the 30 GB disk: the OS, Docker
images and build cache take ~8-12 GB, and every project adds 150-400 MB of `node_modules`, which
is roughly **20-40 projects** — not enough for 100 users with one to three projects each.

### Launch checklist for a single 2 vCPU / 4 GB VM (MWS: ~2 987 ₽/month)

The current bill decomposes exactly as: compute `base` 2 vCPU / 4 GB 2 566 ₽ + 30 GB NBS-PL2
268 ₽ + active IPv4 152 ₽.

1. **Disk first** — grow the boot disk to 100 GB (or attach a 100 GB NBS-PL2 disk, 893 ₽/month)
   and put `/var/lib/docker` and `WEBNESTDEV_SANDBOX_DIR` on it. A full disk takes down Postgres,
   builds and project writes at the same time, and it happens before RAM runs out.
2. **Swap** — 4 GB swap file, `vm.swappiness=10`, and `systemd-oomd`/`earlyoom`; without it one
   simultaneous install + build + Chromium ends in an OOM that kills the whole server.
3. **TLS** — sessions use `secure` cookies by default in production (`WEBNESTDEV_COOKIE_SECURE`),
   so terminate HTTPS (Caddy with Let's Encrypt is the shortest path) or logins silently fail.
   Caddy also proxies WebSockets, which `/ws` and container-preview HMR need.
4. **Limits** — `PREVIEW_MODE=auto`, `SANDBOX_MAX_CONCURRENT=2`, `SANDBOX_MEMORY=512m`,
   `AGENT_MAX_CONCURRENT_RUNS=8` (20-30 is fine on this box), `BROWSER_MAX_CONCURRENT=1`.
   Lower `TOOL_COMMAND_MAX_OUTPUT` (default 200 000 chars) — every command output is sent to the
   model, so this number is a *bill*, not a comfort setting.
5. **Secrets** — `WEBNESTDEV_ENCRYPTION_KEY`, `WEBNESTDEV_ALLOWED_ORIGINS`, `POSTGRES_PASSWORD`,
   `DATABASE_URL`, and the AI provider (`PLATFORM_AI_BASE_URL` / `PLATFORM_AI_MODEL` /
   `PLATFORM_AI_API_KEY`). Secrets live in the environment, never in the repository.
6. **Hygiene (cron)** — weekly `docker system prune -af --filter until=168h`, weekly removal of
   `node_modules` in projects untouched for a month, and a nightly `pg_dump` to Object Storage
   (cold class, 1.26 ₽/GB·month). MWS disk backups are incremental and manual only (3.456 ₽/GB·month).
7. **Firewall** — 80/443/22 only. Nothing in this platform should be reachable any other way.
8. **Watch** — `df -h /`, swap usage, `dmesg` for OOM, the `[sandbox]` queue line, and p95 waiting
   time. These are the four numbers that decide when to buy RAM (`+2 566 ₽/month` for 4 vCPU / 8 GB,
   needs a short power-off) and, much later, a second VM as a queue worker.

### How the platform scales

The design intent is that users be bounded by what they consume, not by each other's presence:

1. **One machine, bigger** — raise `SANDBOX_MAX_CONCURRENT` with the RAM (2 per 2 GB is the
   starting point) and `AGENT_MAX_CONCURRENT_RUNS` with the provider quota. No code change.
2. **Several machines** — the runner is where the memory is, so it is the thing to duplicate. Move
   the WebSocket handler and `AgentRuntime` into a separate worker process, keep the run queue in
   Postgres (`SELECT … FOR UPDATE SKIP LOCKED`), and start N workers: capacity is N × the limits
   above, the API keeps serving everyone, and a worker that dies loses nothing. Yandex Cloud does
   **not** support nested virtualization and no RU serverless container gives you a Docker socket,
   so a worker needs a plain VM with Docker — which is the cheapest thing to rent anyway.
3. **Priority instead of queueing everyone equally** — a paid plan can get its own reserved place
   (a second limiter with its own capacity, or a per-plan `AGENT_MAX_CONCURRENT_RUNS`), so a paying
   user never waits behind free traffic. This is a product decision, not a limit; the current code
   deliberately treats every account the same.
4. **Make the heavy path cheaper** — the static preview already removes the dev-server container;
   keeping browser checks on demand (they are off unless the change touches the UI) keeps Chromium
   out of most runs. Both reduce how often the queue is reached at all.

### What a small host costs in Russia (2026)

Prices are monthly, for a Docker-capable Linux VM, and exclude the database if it is separate —
Postgres runs comfortably in the same 2 GB as the server while the numbers here are small. The
grants are the honest way to start free:

| Where | VM | Price | Free start |
| --- | --- | --- | --- |
| VK Cloud | 2 vCPU / 2 GB (+ disk, + IP) | from ~2 086 ₽ CPU+RAM; 2 vCPU/4 GB ~2 532 ₽ | **5 000 ₽ / 60 days** for an individual, 12 000 ₽ for a company ([bonus](https://cloud.vk.ru/bonus/)) |
| Cloud.ru Evolution | 2 vCPU / 4 GB | ~1 274 ₽ by the documented hourly rate (confirm in the calculator) | **4 000 ₽ / 60 days** for an individual, 20 000 ₽ for a company; a free 2 vCPU/4 GB tier exists but is closed to accounts registered after 30 June 2026 ([bonus](https://cloud.ru/documents/promotions/active/4000-rubles-testing)) |
| Yandex Cloud | 2 vCPU / 2 GB, HDD 13 GB | from ~1 659 ₽ | **4 000 ₽** grant with a card, 10 000 ₽ with a bank transfer ([grant](https://yandex.cloud/en/docs/getting-started/usage-grant)) |
| REG.RU | 2 vCPU / 2 GB, NVMe 40 GB | ~1 382 ₽ (~1,89 ₽/hour) | a 2 vCPU/4 GB server free for 2 months for legal entities ([free VPS](https://www.reg.ru/vps/free)) |
| RuVDS | 2 CPU / 4 GB, SSD 40 GB | 1 149 ₽ on the 3-month promo, 2 432 ₽ regular | 3-day trial advertised ([tariffs](https://ruvds.com/ru/vps_start/)) |
| Selectel | 2 vCPU / 4 GB | from ~2 540 ₽ | up to 30 000 bonus ₽ for a month, for companies ([servers](https://selectel.ru/services/cloud/servers/)) |
| Timeweb Cloud | 2 vCPU / 2 GB | ~3 960 ₽ | grant programme temporarily suspended ([VPS](https://timeweb.cloud/services/vds-vps)) |

Two practical notes on the numbers above: a stopped VM usually keeps billing its disk and public
IP (Selectel additionally offers a paid *freeze* that stops CPU/RAM billing), and hourly billing is
the norm, so a spike can be paid for by the hour instead of the month. Hosting this platform itself
on Yandex Cloud Functions or Serverless Containers is **not** an option today: the sandbox needs a
Docker socket, and neither service documents one.

### How many people can keep a preview open at once

Previews are not bounded like runs, because their cost depends on the mode — and that is exactly
what `PREVIEW_MODE` decides:

| Preview | Memory per project | What limits a 4 GB host |
| --- | --- | --- |
| static (default) | ~0.5 MB — thirty static previews measured +13.7 MB on the whole server | CPU and file descriptors; tens, not the memory |
| container dev server | `SANDBOX_MEMORY`, `1 GB` by default | two or three at once, next to Postgres and the server itself |

So with the default `static`/`auto` mode many users can look at their project at the same time;
with `PREVIEW_MODE=container` the honest answer is a couple. Idle previews free themselves after
`PREVIEW_IDLE_MS` (five minutes), and a build is what costs a moment of memory: it runs in the
sandbox like any other command. Concurrent builds are not limited beyond the agent-run limit — a
preview built by the panel is a short sandbox command, not a run.

## GitHub Actions deployment

[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) builds the image, pushes it to GHCR (`ghcr.io/<owner>/<repo>`) and then runs [`deploy/scripts/vm-deploy.sh`](../deploy/scripts/vm-deploy.sh) **on the server** — over SSH, or locally when the job runs on a self-hosted runner installed on the VM itself.

It runs automatically on every push to `main`, and can also be started by hand from Actions → **deploy** → *Run workflow* (for example to roll back with an older image tag).

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
