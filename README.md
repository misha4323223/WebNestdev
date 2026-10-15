# WebNestdev

<img src="public/brand/nestdev-icon-180.png" alt="Логотип WebNestdev" width="96" height="96" />

Web-native evolution of the NestDev agent architecture.

Product artwork source: docs/7277-removebg-preview.png. The UI assets in public/brand are cropped, retina-sized derivatives of it.

## Architecture

Browser -> Fastify API/WebSocket -> Agent Runtime -> OpenAI-compatible Provider -> Tool Registry -> Project Sandbox -> Preview/Deployment

The Electron NestDev project remains separate and is not modified.

## AI provider

The web version uses an OpenAI-compatible API. Configure the provider with a Base URL, optional API key, and model. This supports hosted providers and compatible gateways without requiring a local model runtime.

## Security boundary

Agent commands run through a Docker sandbox by default.

Each command gets only the project workspace, a read-only container root, isolated network by default, CPU/memory/PID limits, a timeout, and bounded output. Provider credentials are not passed into the sandbox.

## Current implementation status

The agent can start a Docker-based project Preview and inspect the running service with `project.verify`, `browser.open`, and `browser.inspect`.

Preview inspection uses the actual host port assigned to the project, rather than assuming port 3000. This matters because different projects may expose different ports.

`browser.open` returns the HTTP status, status text, response headers, content type, a bounded response body, and basic HTML diagnostics when the response is HTML.

`browser.inspect` provides a compact HTML diagnostic view: page title, script/style/link/image references, resource counts, and common error strings found in server-rendered HTML. It deliberately does not claim to execute client-side JavaScript.

`project.verify` uses the same Preview state and performs an HTTP-level readiness check. The Agent Runtime is instructed to treat verification failures and tool errors as actionable diagnostics and retry after making fixes.

The real headless-browser worker is now implemented as `browser.runtime`. It executes the Preview in Chromium, captures console messages, page errors, failed network requests, HTTP errors, page title, rendered HTML size, and a bounded PNG screenshot. The worker is protected by a 20-second runtime limit and a 2 MB screenshot limit. After mutating tools such as `fs.write`, `fs.rename`, `fs.delete`, `terminal.exec`, and `npm.install`, Agent Runtime automatically starts Preview and runs `project.verify`; for relevant web changes it also runs `browser.runtime`. This automatic verification is bounded to three attempts per agent run, and failures are returned to the model as actionable diagnostics for the next fix.

A dev-server preview does not trust the launch flags for its address. The command gets `--host 0.0.0.0 --port 3000`, but a script such as `concurrently "vite" "node server.js"` ignores them, and Vite without `--host` listens on `127.0.0.1` inside the container only — reachable for `docker exec`, invisible to the server, the panel's proxy and Chromium. So the address is settled from evidence instead: the real port comes from the container's `/proc/net/tcp`, and an app bound to loopback gets a TCP relay inside its own container on the platform's port (`server/src/preview/preview-address.ts`). Before this, `preview.ready` was honest ("the app answers") while `project.verify` failed with `Unable to reach Preview: fetch failed` three times and ended the run on the verification-attempt limit.

A preview runs in one of two modes (`PREVIEW_MODE`, logged at startup). By default the project is **built once and served statically from the server process**: `npm run build` runs in the sandbox when a source file is newer than the served output, and `dist`/`build`/`out` (or `PREVIEW_STATIC_DIR`) is served with the SPA fallback the platform's own frontend uses. No container and no dev server means a 4 GB host can keep several projects previewable at once. A project without a build script — or whose build fails, or that produces no `index.html` — automatically falls back to the per-project **dev-server container** with live reload, and the panel says why; `PREVIEW_MODE=container` pins the dev server and `PREVIEW_MODE=static` forbids the fallback. A static preview has no hot reload: it is rebuilt on the next start, and the logs face shows the build output.

## How much runs at once

Three different things are bounded, because they cost different things. A conversation mostly
waits for the model, so `AGENT_MAX_CONCURRENT_RUNS` (default **8**) controls how many run at once;
the memory lives in the containers, so `SANDBOX_MAX_CONCURRENT` (default **2**) controls how many
`docker run` command containers exist at the same moment — that second number is the one to raise
with the host's RAM; and `BROWSER_MAX_CONCURRENT` (default one) controls Chromium instances. A
request that arrives while a limit is reached waits in a bounded queue instead of failing, the
panel shows it waiting, and the daily run quota is consumed only once the run actually starts.
All limits are logged at startup (`[agent] …`, `[sandbox] …`). See
docs/PRODUCTION_DEPLOYMENT.md for the queue settings, the scaling path and what a small host
costs in Russia.

On top of the host-wide limit there is **one run per account**: a second tab or a second project
of the same user is answered with `RUN_ALREADY_ACTIVE` and the panel says the agent is still
running, instead of one person taking every place while everyone else queues behind them.

### A lost connection does not lose the task

The panel reconnects by itself instead of dropping the work: three attempts with growing pauses
while the socket has not opened yet, and then, if the connection dies mid-run, up to two automatic
reconnects that resume the run. A run is aborted server-side when its socket closes, but the
conversation, the plan and every tool result are already stored — so a resume continues from the
same step, and the runtime adds a system notice saying that the history above is finished work and
the stored plan is the bookmark. Once the automatic attempts are used up — or when a run failed,
was stopped, or a reloaded tab opens a conversation whose last turn has no answer — the panel
shows a **Продолжить** button. Refusals that never started a run (daily quota, storage limit, a
second run in the same account) deliberately do not offer it.

Inside the project sandbox there is no Docker: `docker`, `docker build` and `docker compose` are
refused by `terminal.exec` with an explanation, because the platform starts the Preview itself and
serves it (see below). A `Dockerfile` is still a normal project artifact to create or edit.

Previews are cheaper still, and the cheapest tier needs nothing at all: a project that is already
plain HTML/CSS/JS (`index.html`, no build script) is **served as is — no build, no container** — and
a `dist`/`build`/`out` that is already there is served the same way. A project with a build script
is built once and served from the server process (measured: ~0.5 MB per preview, thirty of them
+13.7 MB), and a project that answers HTTP itself (express, FastAPI, Next in server mode) is
recognised *before* anything is built, so no container is spent on a build that cannot produce a
static preview (`server/src/preview/project-kind.ts` decides from structure, dependencies and
commands — `package.json` alone proves nothing, and a user's `Dockerfile` is never executed).
Runtime previews are the only counted kind (`PREVIEW_MAX_CONTAINERS`, default 3), because they
hold memory while they run; an idle preview is stopped after five minutes without use.

## CI

GitHub Actions runs the server tests, the server build and the web build for pull requests targeting `main` and pushes to `main` (`.github/workflows/ci.yml`), and builds the production Docker image in `.github/workflows/production-ci.yml`.

## Deployment

`.github/workflows/deploy.yml` deploys to the VM: it builds and publishes the image to GHCR, then runs `deploy/scripts/vm-deploy.sh` on the server over SSH (or on a self-hosted runner installed there). It starts manually from Actions → **deploy** → *Run workflow* and accepts `mode=image` (pull the published image) or `mode=source` (build from the repository on the VM); passing an older `image=…:sha-…` tag rolls back. Secrets and variables to create — `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_PORT`, `DEPLOY_KNOWN_HOSTS`, and the optional `DEPLOY_APP_DIR` / `DEPLOY_RUNNER` — are listed in [docs/PRODUCTION_DEPLOYMENT.md](docs/PRODUCTION_DEPLOYMENT.md).

## Roadmap

- persistent projects and conversations
- Git/GitHub integration
- live preview workers
- browser worker
- Yandex Cloud resource/deployment tools (resource reads, create/change/delete behind the user's consent switch)
- authentication and secrets
- sponsor service with privacy isolation
- usage limits, moderation and abuse protection

## Local development

The repository uses npm workspaces, so the frontend and backend dependencies are installed from the repository root.

```bash
npm install
npm run dev
```

The development UI runs on port 5173 and the API on port 8787. Vite proxies /api and /ws to the API during local development.

## Local accounts

WebNestDev now uses a real local authentication flow before opening the workspace:

- register with email and password;
- passwordless **sign-in by phone number** for Russian numbers (`+7…`): an SMS one-time code, no password;
- a shared demo account `demo@webnestdev.local` / `demo1234` is seeded at startup, so a fresh install can be opened without registering (disabled in production unless `WEBNESTDEV_DEMO_USER=1`; change the credentials with `WEBNESTDEV_DEMO_EMAIL` / `WEBNESTDEV_DEMO_PASSWORD`);
- login and logout;
- HTTP-only session cookie;
- password hashing with salted scrypt;
- projects and conversations are scoped to the authenticated user.

Local account data is stored under .webnestdev/auth. This is a development storage layer; production storage will move to managed infrastructure without changing the user-facing flow.

### Phone login and SMS delivery

The sign-in screen currently offers **phone only**; the e-mail/password routes still exist on the server but are not shown in the UI.

Sign-in by number requires an explicit consent to process the number: the screen keeps a checkbox, and the server refuses to generate a code (`400`, `consentRequired`) without it. Every accepted consent is appended to an audit log — `auth/phone-consents.json` locally, the `phone_consents` table on PostgreSQL — with the consent version, the purpose (sign-in or linking) and an HMAC of the address instead of the address itself. Set `WEBNESTDEV_PHONE_CONSENT_SECRET` (32+ characters) to key that hash in production; the encryption key is used when it is missing.

A **demo number** signs in without any SMS, so the flow can be used before a provider is connected. It defaults to `+7 999 000-00-00`, is on outside production and opt-in in production through `WEBNESTDEV_DEMO_PHONE_ENABLED=1` (set the number with `WEBNESTDEV_DEMO_PHONE`, turn it off entirely with `WEBNESTDEV_DEMO_PHONE_ENABLED=0`). It is entered like any other number; the sign-in screen keeps no dev notes, so it is documented here instead.

Phone sign-in sends a code through a Russian SMS provider. The first choice is **Yandex Cloud Notification Service** (SNS-compatible HTTP API), configured with `YANDEX_NOTIFY_IAM_TOKEN` **or** a service account key (`YANDEX_SA_KEY` / `YANDEX_SA_KEY_FILE`) plus `YANDEX_CLOUD_ID`; the service account needs the `editor` role on the folder. Alternative providers are `SMS_RU_API_ID`, `SMSC_LOGIN`+`SMSC_PASSWORD`, `EXOLVE_API_KEY`, or `SMSAERO_EMAIL`+`SMSAERO_API_KEY`. With none set the server runs in test mode: the code is logged and (outside production) returned as `devCode`, so the whole flow can be tested before a provider exists.

Yandex Cloud Notification Service delivers SMS only to Russian numbers, and until an individual sender is registered the channel sits in the sandbox, where only verified test numbers receive messages — see docs/AUTH_PRODUCTION_PLAN.md for the registration lead time.

## Chat history and the run windows

A conversation is the record of the work, not a scrollback of the open tab. Stored with it: the user messages, every assistant answer, the **thinking** the model published before answering, every **tool call together with its result**, and the **task plan**. Reopening the workspace, switching a tab, reloading the page or opening the project on another device shows the same run again — the action list and the thinking are rebuilt from the stored turns, not kept only in the browser.

A project keeps several chats, and they belong to the account rather than to the browser: the **Чаты** button above the conversation opens the project's saved sessions — each labelled by the question it started with, with the last answer as a preview and the time it was last used — any of them reopens, and **Новая сессия** starts the next one. Opening a project returns to the last chat, and a project without chats gets a new one, so the history is there on another device and after the browser storage is cleared.

Two windows that collapse and remember their state — **План задач** and **Действия агента** — sit next to the composer: what is happening right now stays next to the input instead of scrolling away with the chat, and each window has its own scroll, so a long run never pushes the conversation down. The model's thinking is not a window of its own: it belongs to the answer it produced and is folded **above** it, so the model reasons first and writes the answer below — the shape Replit uses. While a run works, that container is open and carries the step, the context size and the elapsed time; a stored answer keeps its thinking folded. When the model's gateway sends no reasoning at all (most non-reasoning models), the container says so instead of inventing text.

The agent is instructed to think and answer **in Russian first**, switching to another language only where the work itself needs it — code, paths, commands, error messages and quoted documentation.

## Storage: where the data actually lives

`WEBNESTDEV_STORAGE` accepts exactly two backends: `json` (files) and `postgres`. Anything else — including the old `ydb` value — is not a backend any more, and the server now says so on startup (`[storage] …`) instead of silently writing somewhere else. In production the variable defaults to `postgres` when it is unset, and `DATABASE_URL` is then required.

With `json`, set `WEBNESTDEV_DATA_DIR` to a path outside the source tree: the default is `.webnestdev` inside the working directory, so a redeploy that replaces the code directory takes accounts, projects, conversations and connected integrations with it. `deploy/scripts/make-env-vm.sh` writes such a directory (`~/webnestdev/data`) and reuses the existing `WEBNESTDEV_ENCRYPTION_KEY`, because a new key makes every secret encrypted earlier unreadable.

## Agent modes

The message composer has one button that shows the current mode and switches it on click, and the choice is sent with every run. The same row shows the model the project will run on — the project provider model, or the platform default — and opens the AI provider settings when pressed:

- **Разработчик (developer)** — the full agent: it writes files, runs the terminal, starts the Preview and verifies the result.
- **Планировщик (planner)** — read-only: the agent studies the project and publishes a plan with `plan.update` without changing anything. Enforcement lives on the server, not in the prompt: the runtime refuses `fs.write`, `fs.rename`, `fs.delete`, `npm.install`, `database.env`, `git.add`, `git.commit` and mutating `yandex.request` calls, and `terminal.exec` only runs a single inspection command (`ls`, `cat`, `grep`, `find`, `git status|log|diff|branch`, `npm ls`). Anything chained, piped, redirecting output, installing packages or running a script is refused, so the planner can read a project but can never write to one. The policy is covered by `server/src/agent/planner-policy.test.ts`.

## Project database

Every project keeps its data in a database of the user's own, so nothing depends on the platform's storage. The integrations list has a **База данных** card that offers Russian providers first — Yandex Cloud (Managed PostgreSQL, Serverless YDB), VK Cloud, Selectel, Timeweb Cloud, Cloud.ru — plus a custom server, with the exact console steps for each. The card accepts the connection string the provider shows (`postgresql://…`, `mysql://…`, `mongodb://…`, `grpcs://…` for YDB, `redis://…`) or the same values field by field; the password and the full string are encrypted at rest like every other credential (see docs/SECRET_ENCRYPTION.md) and are never returned to the browser or to the model.

The user has two ways to connect it, and both end in the same place:

1. paste the connection string into the card (Settings → Integrations → База данных), or
2. tell the agent in chat — the agent asks for the connection string, explains where to create the database on a Russian provider, and stores it the same way.

After that the agent uses two tools: `database.status` reports the engine, host, port and database name (never the password), and `database.env` merges `DATABASE_URL` (plus `MONGODB_URI`, `REDIS_URL` or `YDB_CONNECTION_STRING` where the engine expects it) into the project's `.env.local`, leaving every other line untouched. The card can also run a TCP reachability check from the API host — it answers "this address is reachable", which is honest about not being a login test.

## GitHub integration

The integrations list connects services one button at a time: the connect button opens the provider's authorization page in a separate window, and the card shows a green indicator once the account is linked. A service stays on "Не настроено на сервере" until its OAuth app is registered — only in that state does the GitHub card also show the setup steps below, so a configured server keeps the card to the service name, its status and the buttons:

1. Open GitHub → Settings → Developer settings → OAuth Apps → "New OAuth App" (`https://github.com/settings/applications/new`). Any name and homepage URL work.
2. Add the Redirect URI `https://<app-host>/api/github/callback` — the card shows the exact value to copy, because the server derives it from the origin the app is open at (`GITHUB_CALLBACK_URL` overrides it; up to 10 URIs are allowed, so the local `http://localhost:5173/api/github/callback` fits in the same app). Leave "Allow wildcard matching", "Enable Device Flow" and "Expire user access tokens" switched off: the server stores only the access token and never refreshes it.
3. Press "Register application": the page shows the **Client ID**, and "Generate a new client secret" issues the **Client secret** (shown once — copy it immediately; generate a new one if it is lost).
4. Provide `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` to the server environment and restart the server. In Freebuff that is Settings → Environment. Development generates the credential-encryption key into the data directory on first use; production requires `WEBNESTDEV_ENCRYPTION_KEY` (see docs/SECRET_ENCRYPTION.md).
5. Set `GITHUB_FRONTEND_URL` when the app is served from a different host than the callback.

The callback must be reachable by the browser, and in production the app host has to be listed in `WEBNESTDEV_ALLOWED_ORIGINS` — the OAuth flow only returns to an origin from that list.

## Yandex Cloud integration

The Yandex Cloud card works like the GitHub one — press "Подключить" and the authorization window reports back on its own — and it additionally accepts a credential the user pastes, which is the path that always works:

- **Authorized key of a service account (recommended)** — Yandex Cloud console → "Сервисные аккаунты" → create an account → grant `viewer` on the cloud plus the roles the agent needs on the folder → "Создать новый ключ" → "Создать авторизованный ключ" → download the JSON and paste it. The server signs a PS256 JWT with it and exchanges that for an IAM token (`iam.api.cloud.yandex.net/iam/v1/tokens`).
- **IAM token** (`t1.…`) — from `yc iam create-token` or the console button; it lives about 12 hours.
- **Yandex ID OAuth token** (`y0_…`) — only for the OAuth button flow.

Credentials are verified against `resource-manager` before they are stored, then encrypted like every other secret (see docs/SECRET_ENCRYPTION.md) and used only on behalf of that user.

Reads and writes are separated: the agent can always read the account (clouds, folders, VM instances, disks, buckets, Serverless functions) with `yandex.status` and `yandex.resources`, while `yandex.request` refuses any method other than GET/HEAD until the user turns on "Разрешить агенту изменять ресурсы" in the card. With that switch on, the agent creates, changes and deletes resources through the same authenticated call, so it can act on the user's explicit command.

Server environment:

1. Register an OAuth app at `https://oauth.yandex.ru/client/new` with the Yandex Cloud API scope and the callback `https://<app-host>/api/yandex/callback`.
2. Provide `YANDEX_CLIENT_ID` and `YANDEX_CLIENT_SECRET` (`YANDEX_CALLBACK_URL`, `YANDEX_FRONTEND_URL` and `YANDEX_OAUTH_SCOPE` override the defaults; the scope defaults to `cloud-api`).
3. Without those values the button explains that OAuth is not configured and opens the key form instead — the pasted-credential path does not need an OAuth app at all.

See docs/AUTH_PRODUCTION_PLAN.md for the staged rollout. Credential encryption, legacy-token migration, and key rotation are documented in docs/SECRET_ENCRYPTION.md.
