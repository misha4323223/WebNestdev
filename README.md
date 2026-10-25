# NestDev

<img src="public/brand/nestdev-icon-180.png" alt="Логотип NestDev" width="96" height="96" />

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

The real headless-browser worker is now implemented as `browser.runtime`. It executes the Preview in Chromium and reports **what the page actually rendered** — the visible text (bounded), how many characters of it, how many visible elements, and whether the screen is empty — together with console messages, page errors, failed network requests, HTTP errors, and the document status. The worker is protected by a 20-second runtime limit.

The evidence is the point: a PNG screenshot was captured and returned as base64 before, which a text model cannot read, so a run that failed with a white screen could only guess why. The picture is back, but as a *file*: `browser.screenshot` ({path, viewport: 'desktop'|'tablet'|'mobile', fullPage}) saves a PNG into the project's `.webnestdev/screenshots/` (excluded from git, served at `/api/projects/:id/screenshot`), and `browser.runtime` attaches the desktop shot to its result as `screenshot`. The model, which still cannot read the image, gets `layout` instead: page width vs viewport (horizontal overflow), elements beyond the screen edge with CSS selectors, broken images, clipped text, and tap targets under 36 px on mobile — the defects that used to be found only when the user said "смотри, криво". What a *failure* is is decided explicitly (`classifyRuntimeFailures` in `tools/browser-tools.ts`): page errors, console errors, requests that never arrived, `5xx`, a missing route, an **empty screen** and an **unstyled screen** fail the check, while `4xx` answers from the app's own API (a page without a session is supposed to answer `401`) and requests aborted by a navigation are reported as `background` and never fail it. Including the empty-screen case makes the check *stricter* than before: `expectVisible body` passes on a blank page.

The white screen was still being missed, because a page whose styles never arrived has text and elements in the DOM and nothing in the console: `expectVisible body` was satisfied and the model went looking through files. So the evidence now says how the page *looks* (`rendered.styles`): declared vs. loaded stylesheet links, `<style>` blocks, the number of CSS rules in effect, the computed body background and text colour, plus `unstyled` and `noStyles`. Rules, not links, decide: Chromium keeps an empty stylesheet even for a `404`, so a page with declared styles and zero rules is reported as unstyled rather than as fine. In the same spirit, a `4xx` for a `.css` or `.js` file is a failure — without it the page is white — while `favicon.ico` and other browser-invented requests stay `background`.

And the check no longer looks only through the door the *agent* has. `browser.runtime` loads the page twice: at the container address (`url`, `rendered`) and through the platform's own preview proxy (`panelDoor`) with a short-lived session for the project owner — the same route, cookie and headers the panel's iframe uses. A page that breaks in the proxy (rewritten paths, framing, headers) is invisible from the container address; the proxy pass mints a session, deletes it afterwards, and reports "could not check" rather than a failure when the platform address is unreachable from inside the check.

After mutating tools such as `fs.write`, `fs.rename`, `fs.delete`, `terminal.exec`, `npm.install`, `pip.install`, and `net.download`, Agent Runtime automatically starts Preview and runs `project.verify`; for relevant web changes it also runs `browser.runtime`. Failures of that automatic check are returned to the model as actionable diagnostics and are **not** counted toward the run's limit: a project that is still being scaffolded cannot build yet (`tsc` runs before `npm install` exists, then `Cannot find module './App'`), and counting those ended normal runs on the third written file. What is counted is an attempt to finish while verification is still failing — three of those stop the run, and the message now names the last failure (`server/src/agent/verification-policy.ts`). The build step itself is skipped when the project declares no build script: `npm run build` in a plain static page fails with `ENOENT …/package.json`, which is not a defect of the page.

A dev-server preview does not trust the launch flags for its address. The command gets `--host 0.0.0.0 --port 3000`, but a script such as `concurrently "vite" "node server.js"` ignores them, and Vite without `--host` listens on `127.0.0.1` inside the container only — reachable for `docker exec`, invisible to the server, the panel's proxy and Chromium. So the address is settled from evidence instead: the real port comes from the container's `/proc/net/tcp`, and an app bound to loopback gets a TCP relay inside its own container on the platform's port (`server/src/preview/preview-address.ts`). Before this, `preview.ready` was honest ("the app answers") while `project.verify` failed with `Unable to reach Preview: fetch failed` three times and ended the run on the verification-attempt limit.

The network is settled the same way, from evidence rather than assumption. A preview container joins the server's Docker network, and that network is resolved from three sources (`PREVIEW_NETWORK`, the container's hostname, and matching the server's own IP addresses inside `docker network inspect`): Docker isolates bridge networks from each other, so a preview left in the network by default answers `docker exec` while the server, the panel and Chromium cannot reach it at all — a white frame under a preview that reports itself running. When the app answers inside the container but not at the container address, the running container is connected to the server's network and the new address is confirmed before the TCP relay is considered (`server/src/preview/preview-network.ts`); the address is re-checked even when the port did not change, and a relay that has just been started is given time to listen instead of being declared a failure by a single probe. `preview.status` reports `settled` — the address was confirmed by a request from the server itself, which is the door the panel and Chromium use — and `/api/health` lists every live preview with that flag (`activity.previews.addresses`), so "it says it is running and the panel is empty" has an answer without a shell on the VM. When the address cannot be repaired at all (the two containers are on isolated networks, or the operator pins neither), there is still a door: `docker exec` does not go over the network, and the proxy already uses it to ask the app whether it is up. So a failing direct request is repeated *inside the container* — same method, body, query and headers, same status and body back — and the panel shows the app instead of a white frame (`server/src/preview/exec-proxy.ts`). It is slower (one process per asset) and has no hot reload, so the state is marked `execOnly` and the status carries `viaExec` with a hint saying so; the unreachable address is re-checked at most once a minute (`PREVIEW_EXEC_RETRY_MS`), and the direct, streamed path returns by itself as soon as it works again. On a host, the same path is measurable with `node server/dist/scripts/preview-selfcheck.js` inside the server container; every image deploy prints its verdict (`PREVIEW-NETWORK=ok|ok-after-connect|unreachable`).

In the panel the preview frame is reloaded on every fresh status (opening the project, the end of an agent run, the ⟳ button), so a frame that was loaded while the app was still starting — the proxy answers with an empty document until the dev server is up — does not stay white after the logs already say "запущено". The preview door also never hands out a cached copy of anything (`no-store`, validators removed): a reloaded frame has to show the project's latest state, not a copy from the browser's or a middlebox's cache (`server/src/routes/preview.ts`).

**A deployment never leaves a tab on the previous build — and that is enforced in three places, because a cached shell is invisible in the logs.** The document itself is uncacheable *and* uncacheable-to-confirm: `no-store` alone was not enough, since a proxy that still sees an `etag` may answer `304 Not Modified`, and the tab keeps the old document together with the links to the old build's assets — whose names contain a hash and are cached for 30 days, so the old version keeps working and looks perfectly healthy. So the validators are dropped too, in one place (`server/src/routes/cache-headers.ts`, applied by `routes/panel-static.ts` and exercised by its test), while hashed `assets/*` keep their long cache. On top of that each tab compares the build it was compiled into with the one the server reports: `ARG GIT_SHA` is passed to the frontend build as `VITE_BUILD` (`server/Dockerfile`), the same value answers `GET /api/version` (no Docker, no database — it is polled), and a tab whose build differs reloads itself once, cache-busting, so a middlebox that ignores the headers cannot keep showing the old version (`src/lib/app-build.ts`). The reload is recorded per served build in `sessionStorage`, so a tab that cannot be updated never reloads in a loop, and a build with no baked-in SHA (dev, a local build) disables the check entirely.

A preview runs in one of two modes (`PREVIEW_MODE`, logged at startup). By default the project is **built once and served statically from the server process**: `npm run build` runs in the sandbox when a source file is newer than the served output, and `dist`/`build`/`out` (or `PREVIEW_STATIC_DIR`) is served with the SPA fallback the platform's own frontend uses. No container and no dev server means a 4 GB host can keep several projects previewable at once. A project without a build script — or whose build fails, or that produces no `index.html` — automatically falls back to the per-project **dev-server container** with live reload, and the panel says why; `PREVIEW_MODE=container` pins the dev server and `PREVIEW_MODE=static` forbids the fallback. A static preview has no hot reload: it is rebuilt on the next start, and the logs face shows the build output. Starting a preview also **installs what the project declares** (`npm install --no-audit --no-fund`, the same command as `npm.install`, and the only step that gets outbound network): a project that the agent has just created has a `package.json` and no `node_modules`, so the build failed on a missing `vite`, the dev server failed behind it, and "the preview does not start" looked like a platform fault. The check is per declared package, so a partial or interrupted install is completed too, and the install output goes into the preview's own log (`server/src/preview/dependencies.ts`). A failed preview start names its cause in the server log as well (`[preview] не удалось запустить предпросмотр: проект … — причина`): the reason used to exist only in the panel's answer, so `docker compose logs webnestdev-server` showed the attempt and nothing about it.

When the operator sets `PREVIEW_PUBLIC_DOMAIN` (e.g. `preview.nestdev.ru`), every project also has **a preview address of its own**: `<projectId>.preview.nestdev.ru`. The panel's proxy serves the app under `/api/projects/<id>/preview/open/…`, which is exactly why it has to rewrite the app's root-absolute URLs; on its own hostname the app is at the root, so absolute paths, service workers and live reload behave the way they do when the app runs normally, and the address can be opened in a separate tab. It is served by a second listener inside the server process (`PREVIEW_HOST_PORT`, `server/src/preview/preview-host-server.ts`) rather than by a route in the main app: on that hostname the user's app owns the whole path — `/api/…` included — and its live reload arrives on a WebSocket from an arbitrary path, while a wildcard WebSocket route in the main app would take the `/*` that serving the panel needs. Requests go through the same proxy core as the panel (`server/src/preview/preview-proxy.ts`: direct address first, `docker exec` second, `no-store`, the app's framing headers dropped) and the upgrade is relayed byte for byte, so the app negotiates WebSocket itself. Access is a short-lived **ticket** bound to one project (`POST /api/projects/:id/preview/ticket`), because the panel's session cookie is not sent to a subdomain and widening it to the whole domain would put a platform cookie into the user's own code — the proxy strips platform cookies from everything it forwards. The ticket travels in the URL **fragment** (`#ticket=…`), which the browser never sends to a server, so it stays out of logs, history and `Referer`; the platform page served without a cookie exchanges it for an `HttpOnly` cookie on the preview origin and then loads the clean address. TLS is per hostname and on demand: the reverse proxy (`deploy/Caddyfile`) asks `GET /api/preview/tls-ask` before issuing, and that endpoint answers 200 only for the hostname of an existing project, so a wildcard DNS record cannot be used to obtain certificates for invented names and exhaust the Let's Encrypt limit.

## How much runs at once

Three different things are bounded, because they cost different things. A conversation mostly
waits for the model, so `AGENT_MAX_CONCURRENT_RUNS` (default **8**) controls how many run at once;
the memory lives in the containers, so `SANDBOX_MAX_CONCURRENT` (default **2**) controls how many
`docker run` command containers exist at the same moment — that second number is the one to raise
with the host's RAM; and `BROWSER_MAX_CONCURRENT` (default one) controls Chromium instances. A
request that arrives while a limit is reached waits in a bounded queue instead of failing, the
panel shows it waiting, and the daily run quota is consumed only once the run actually starts.
All limits are logged at startup (`[agent] …`, `[sandbox] …`). See
docs/PRODUCTION_DEPLOYMENT.md for the queue settings and what a small host costs in Russia, and
[docs/SCALING_PLAN.md](docs/SCALING_PLAN.md) for the engineering path from one VM to 500+ users.

### Which runs the daily quota counts

The free plan allows **10 agent runs a day**, and that number is about the model the *platform*
pays for. A project with its own AI provider spends the owner's key and the owner's tokens, so its
runs are neither counted nor blocked: `routes/agent-ws.ts` asks once whether the project has a
provider of its own and hands the answer to `consumeAgentRun` (`account/usage-store.ts`), which
returns the current usage snapshot instead of reserving a place in the quota. Runs on the built-in
platform model keep counting exactly as before, and the panel, the settings screen and the plans
page all say so next to the numbers.

On top of the host-wide limit there is **one run per account**: a second tab or a second project
of the same user is answered with `RUN_ALREADY_ACTIVE` and the panel says the agent is still
running, instead of one person taking every place while everyone else queues behind them. A
request that arrives while the account is still unwinding waits for the place first: the panel's
«Отправить сейчас» closes the current socket and starts the queued message immediately, and the
cancelled run releases its place only a moment later — without that grace the user's own second
message was answered with `RUN_ALREADY_ACTIVE`, as if it had started a second agent. The wait is
bounded by `AGENT_ACCOUNT_WAIT_MS` (default 5000, `0` refuses at once) and holds no place in
either queue.

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

### A provider that says "wait" does not end the run

`429` and `503` mean the request never reached the model, so nothing about it has to change for the
next attempt — it only has to wait. That is what a step does now: it pauses and sends the very same
request again, up to `AGENT_PROVIDER_RETRIES` attempts (default **5**) with a doubling pause of up to
`AGENT_PROVIDER_RETRY_MAX_MS` (default **60 s**), inside a total budget of
`AGENT_PROVIDER_RETRY_BUDGET_MS` (default **5 min**) per step. A numeric `Retry-After` from the
gateway — header or body — wins over the backoff, so a router that asks for 40 seconds gets 40
seconds. The panel shows `провайдер ограничил частоту запросов — жду N с и продолжаю (попытка k из n)`
while that happens; it is a progress line, not an error, and the run keeps its place, its history and
its plan. Only when the whole budget is spent does the run stop, with a sentence saying how long it
already waited (`provider/provider-retry.ts`). That is why a free-tier router no longer turns a
quarter-hour task into "подождите минуту и повторите запуск".

What is *not* retried is a refusal about the request itself: a wrong key, a bad shape, or a context
that is too large (step-runner.ts already answers that one by trimming). And a failure that happens
*after* part of the answer was already streamed is not retried either — the text would arrive twice;
that run stops and offers the **Продолжить** button instead.

Because a step can now wait a minute in silence, a running run sends a short `run.alive` every
`AGENT_RUN_HEARTBEAT_MS` (default **20 s**). The panel ignores it: it exists so that a proxy or
load balancer on the way does not close an idle `/ws` connection, which the server would read as
"the user left" and answer by aborting the work.

### Leaving the project does not stop the agent

The workspace is hidden rather than unmounted when the user goes to the main page or switches to the
Files/Terminal tab of the workspace. Its WebSocket — the connection the server watches to decide that
a run is still wanted — stays open, so the agent keeps working; the panel's queue, plan and reconnect
handling stay alive with it. The main page says so in a banner ("Агент продолжает работу над проектом
«…»") that leads back into the project, where the finished turn is already on screen. Reloading the
tab, signing out, or opening another project does end the run: those close the socket, which is the
case the **Продолжить** button above covers.

Inside the project sandbox there is no Docker: `docker`, `docker build` and `docker compose` are
refused by `terminal.exec` with an explanation, because the platform starts the Preview itself and
serves it (see below). A `Dockerfile` is still a normal project artifact to create or edit.

### A host without a Docker daemon

`terminal.exec`, `npm.install`, the git tools, the static build and a container preview all end in
`docker run`, so on a host whose binary or daemon is missing none of them can work. That reason
travels to whoever asked instead of being hidden: the Terminal panel and the preview panel show it
(the terminal route answers 503, not «Внутренняя ошибка сервера»), `/api/sandbox/status` and
`/api/health` carry it as `sandbox.available:false` with a `detail`, `/api/ready` answers 503, and the
agent receives it as the result of the tool it called — one sentence that names the cause, says which
capabilities are gone and what is available instead, so a run adapts rather than repeating a command
that cannot work.

What still works on such a host is not nothing: the file tools, chat attachments, the storage quota
and the **static preview of a buildless project** — `index.html`/CSS/JS as they are, or an already
built `dist` — which is the same preview `project.verify` and `browser.runtime` check. A project that
needs `npm install`, a build or its own HTTP server does need Docker.

Previews are cheaper still, and the cheapest tier needs nothing at all: a project that is already
plain HTML/CSS/JS (`index.html`, no build script) is **served as is — no build, no container** — and
a `dist`/`build`/`out` that is already there is served the same way. A project with a build script
is built once and served from the server process (measured: ~0.5 MB per preview, thirty of them
+13.7 MB), and a project that answers HTTP itself (express, FastAPI, Next in server mode) is
recognised *before* anything is built, so no container is spent on a build that cannot produce a
static preview (`server/src/preview/project-kind.ts` decides from structure, dependencies and
commands — `package.json` alone proves nothing, and a user's `Dockerfile` is never executed).
Runtime previews are the only counted kind, and the count is **per account**: one container preview
at a time (`PREVIEW_MAX_PER_USER`, default 1, `0` disables it), so a second preview of the same user
stops that user's older one instead of refusing them, and other users are not affected. The host-wide
brake (`PREVIEW_MAX_CONTAINERS`) is derived from host memory by default (about one 1 GB preview per GB, at most 8); set an explicit number to override it, or `0` to remove it.
An idle preview is stopped after five minutes without use.

## CI

GitHub Actions runs the server tests, the server build and the web build for pull requests targeting `main` and pushes to `main` (`.github/workflows/ci.yml`), and builds the production Docker image in `.github/workflows/production-ci.yml`.

## Deployment

`.github/workflows/deploy.yml` deploys to the VM: it builds and publishes the image to GHCR, then runs `deploy/scripts/vm-deploy.sh` on the server over SSH (or on a self-hosted runner installed there). It starts manually from Actions → **deploy** → *Run workflow* and accepts `mode=image` (pull the published image), `mode=source` (build from the repository on the VM), `mode=prune` (drop old images and build cache) or `mode=cleanup` (truncate the containers' JSON logs on the VM — the deploy itself writes no log files, and without a size limit they fill the disk long before the images do); passing an older `image=…:sha-…` tag rolls back. **A push to `main` deploys production by itself** — the workflow's `push` trigger is enabled, and the deploy verifies the build it shipped (`/api/health` → `build`, `PANEL-BUILD=ok|mismatch`) and rolls the VM back to the previous image when the version does not match. Secrets and variables to create — `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_PORT`, `DEPLOY_KNOWN_HOSTS`, and the optional `DEPLOY_APP_DIR` / `DEPLOY_RUNNER` — are listed in [docs/PRODUCTION_DEPLOYMENT.md](docs/PRODUCTION_DEPLOYMENT.md).

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

Phone sign-in sends a code through a Russian SMS provider. The first choice is **Yandex Cloud Notification Service** (SNS-compatible HTTP API), configured with a service account key (`YANDEX_SA_KEY` / `YANDEX_SA_KEY_FILE`) plus `YANDEX_CLOUD_ID`; the service account needs the `editor` role on the folder. A ready `YANDEX_NOTIFY_IAM_TOKEN` also works but **expires in about 12 hours** — SMS arrive while it is fresh and then stop, so the key is what production should use (it is preferred even when a stale token is still set, because the server mints and caches a fresh token from it). Alternative providers are `SMS_RU_API_ID`, `SMSC_LOGIN`+`SMSC_PASSWORD`, `EXOLVE_API_KEY`, or `SMSAERO_EMAIL`+`SMSAERO_API_KEY`. With none set the server runs in test mode: the code is logged and (outside production) returned as `devCode`, so the whole flow can be tested before a provider exists.

When no code arrives, the reason is not a guess: `GET /api/auth/phone/status` reports the active provider, whether it is in test mode, and whether it authenticates with a self-renewing `key` or an expiring `token`; the sign-in screen shows the server's explanation after the code is requested; every failed send is logged with the provider's own refusal; and `GET /api/health` → `sms` carries the same summary for the operator. In a container the keys must be listed in `docker-compose.yml` as well — Compose forwards only the variables named there.

Yandex Cloud Notification Service delivers SMS only to Russian numbers, and until an individual sender is registered the channel sits in the sandbox, where only verified test numbers receive messages — see docs/AUTH_PRODUCTION_PLAN.md for the registration lead time.

### Which build is running

Every image is stamped with the commit it was built from, and the server reports it: `GET /api/health` → `build`. The deploy refuses to call itself successful when the running version is not the one it shipped — it rolls the VM back to the previous image instead (see [docs/PRODUCTION_DEPLOYMENT.md](docs/PRODUCTION_DEPLOYMENT.md)). A page that still looks old while `build` is new is the browser cache: the document is served with `cache-control: no-store`, and a browser holding it under the older 30-day rule needs one hard reload.

## Chat history and the run windows

A conversation is the record of the work, not a scrollback of the open tab. Stored with it: the user messages, every assistant answer, the **thinking** the model published before answering, every **tool call together with its result**, and the **task plan**. Reopening the workspace, switching a tab, reloading the page or opening the project on another device shows the same run again — the action list and the thinking are rebuilt from the stored turns, not kept only in the browser.

The agent cannot read that whole record at once: every request is bounded by `agent/context-budget.ts`, which shortens old steps and finally drops them. What leaves the window is replaced by one note (`cutNote`) — and the note is where the agreed specifics used to get lost. It is now divided into sections with their own quotas: the user's requests (first plus the newest, up to 1200 characters each), the model's conclusions, and what was already done with the project. An answer keeps **both ends** — the opening, and the last 150 characters where «Итого: берём вариант B» normally sits — and the head of the first request is never dropped. When older requests do not fit, the note says how many were left out, so the model reads files instead of pretending the summary is complete.

Decisions are also recorded explicitly. The `note.remember` tool takes a short line (`kind: decision | rejected | open | fact`) and appends it to `.webnestdev/notes-<conversation>.md` inside the project — outside git, one file per chat, capped at 60 lines / 6000 characters with the oldest evicted first, so roughly a day of dense work stays. That list is inserted as its own **system** message and updated in place the moment the tool writes a new line; the context cutter never drops or shortens system messages, so a palette, a font, a client's name or a rejected layout survived both the cut and the next run — including tomorrow's. The prompt tells the model to record agreements instead of re-deciding them, and not to use the notes as a progress log (`plan.update` is for steps).

Nothing is lost when the window drops: the whole conversation stays stored, and `chat.history({query?, limit?})` reads it back **verbatim** on request — the newest turns by default, or the newest matches for a word or phrase across the entire saved chat. Only the user's messages and the model's answers come back, clipped head+tail per turn, never tool logs; a conversation of another project is refused. This is deliberate instead of a second, self-rewriting "compressed archive": a rewrite would lose exactly the specifics it was meant to keep and would drift from the real chat, while reading the stored one costs nothing until it is actually needed.

A project keeps several chats, and they belong to the account rather than to the browser: the **Чаты** button above the conversation opens the project's saved sessions — each labelled by the question it started with, with the last answer as a preview and the time it was last used — any of them reopens, and **Новая сессия** starts the next one. Opening a project returns to the last chat, and a project without chats gets a new one, so the history is there on another device and after the browser storage is cleared.

Two windows that collapse and remember their state — **План задач** and **Действия агента** — sit next to the composer: what is happening right now stays next to the input instead of scrolling away with the chat, and each window has its own scroll, so a long run never pushes the conversation down. The model's thinking is not a window of its own: it belongs to the answer it produced and is folded **above** it, so the model reasons first and writes the answer below — the shape Replit uses. While a run works, that container is open and carries the step, the context size and the elapsed time; a stored answer keeps its thinking folded. When the model's gateway sends no reasoning at all (most non-reasoning models) there is no empty window to stare at: a single live line says the answer is being prepared, with the same step, context and time, and the window appears at the moment the model really says something.

The chain of thought is asked for rather than hoped for, and it is asked for in every request: the
gateways publish `reasoning_content`/`reasoning`/`reasoning_details` (and a few more names) **only**
when the request carries `reasoning_effort`, so `WEBNESTDEV_AI_REASONING` (default `medium`, `off`
to stop asking, `low`/`high` for the depth) is sent with every step unless the composer's
**Лёгкое / Среднее / Глубокое** choice overrides it for that run. A gateway that does not know
the field answers `400`/`422` to the first attempt, so the provider repeats the very same request
without it and remembers the address for the rest of the process — the run never ends over a field
nobody asked for. Folded, the container is not silent: its header keeps the **last line** of the
thought stream next to «Размышляю…», and a finished answer is labelled with the size of what the
model thought.

The agent is instructed to think and answer **in Russian first**, switching to another language only where the work itself needs it — code, paths, commands, error messages and quoted documentation.

## Storage: where the data actually lives

`WEBNESTDEV_STORAGE` accepts exactly two backends: `json` (files) and `postgres`. Anything else — including the old `ydb` value — is not a backend any more, and startup fails with a configuration error instead of silently writing somewhere else. In production the variable defaults to `postgres` when it is unset, and `DATABASE_URL` is then required.

With `json`, set `WEBNESTDEV_DATA_DIR` to a path outside the source tree: the default is `.webnestdev` inside the working directory, so a redeploy that replaces the code directory takes accounts, projects, conversations and connected integrations with it. `deploy/scripts/make-env-vm.sh` writes such a directory (`~/webnestdev/data`) and reuses the existing `WEBNESTDEV_ENCRYPTION_KEY`, because a new key makes every secret encrypted earlier unreadable.

## Agent modes

The message composer has one button that shows the current mode and switches it on click, and the choice is sent with every run. The same row shows the model the project will run on — the project provider model, or the platform default — and opens the AI provider settings when pressed:

- **Разработчик (developer)** — the full agent: it writes files, runs the terminal, starts the Preview and verifies the result.
- **Планировщик (planner)** — read-only: the agent studies the project and publishes a plan with `plan.update` without changing anything. Enforcement lives on the server, not in the prompt: the runtime refuses `fs.write`, `fs.rename`, `fs.delete`, `npm.install`, `pip.install`, `net.download`, `database.env`, `secrets.request`, `git.add`, `git.commit`, `preview.start`, `preview.stop`, mutating `yandex.request` calls and `net.request` with anything but GET/HEAD, and `terminal.exec` only runs a single inspection command (`ls`, `cat`, `grep`, `find`, `git status|log|diff|branch`, `npm ls`). Anything chained, piped, redirecting output, installing packages or running a script is refused, so the planner can read a project but can never write to one. The policy is covered by `server/src/agent/planner-policy.test.ts`.

A quick-start template and a GitHub import both start in **Планировщик** instead of writing immediately: the agent asks up to two genuinely important clarifying questions, then publishes the full plan. The **Утвердить и начать разработку** button next to the plan is the command that switches the same run to developer mode and sends the approved steps as the task. Importing a repository first asks what to do with it — analysis only, prepare to run it, find errors, or a custom instruction — and that answer becomes the planner task. The composer also has **Лёгкое / Среднее / Глубокое** reasoning depth; the choice is stored per browser and sent with every run as `reasoning_effort`, overriding the server default (`WEBNESTDEV_AI_REASONING=off` still disables the request entirely).

## Project database

Every project keeps its data in a database of the user's own, so nothing depends on the platform's storage. The integrations list has a **База данных** card that offers Russian providers first — Yandex Cloud (Managed PostgreSQL, Serverless YDB), VK Cloud, Selectel, Timeweb Cloud, Cloud.ru — plus a custom server, with the exact console steps for each. The card accepts the connection string the provider shows (`postgresql://…`, `mysql://…`, `mongodb://…`, `grpcs://…` for YDB, `redis://…`) or the same values field by field; the password and the full string are encrypted at rest like every other credential (see docs/SECRET_ENCRYPTION.md) and are never returned to the browser or to the model.

The user has two ways to connect it, and both end in the same place:

1. paste the connection string into the card (Settings → Integrations → База данных), or
2. tell the agent which provider you want — it explains where to create the database and asks for the string through the secrets modal window (never in chat), which stores it encrypted for the project.

After that the agent uses two tools: `database.status` reports the engine, host, port and database name (never the password), and `database.env` merges `DATABASE_URL` (plus `MONGODB_URI`, `REDIS_URL` or `YDB_CONNECTION_STRING` where the engine expects it) into the project's encrypted secret store for `.env.local`, leaving every other variable untouched. The card can also run a TCP reachability check from the API host — it answers "this address is reachable", which is honest about not being a login test.

## Files the user brings

Work the user already has — photographs, logos, documents — gets into the project through the chat composer: the paperclip, or a drag-and-drop onto the input field. The file is `POST`ed to `/api/projects/:id/upload`, stored under `uploads/` with a safe basename and announced to the agent by path, so the agent needs no new tool to use it — it is in the file tree. Photographs are shrunk in the browser before the request: anything over 600 KB and of type JPEG/PNG/WebP is redrawn to at most 1800 px on the long edge and re-encoded as WebP at quality 0.82 (`shrinkImage` in `src/features/agent/AgentPanel.tsx`), which turns a 6 MB phone photo into a few hundred kilobytes and keeps the 2 MB API body limit out of the way; the panel says so when it happens, because the stored file is then `.webp`. SVG, GIF and HEIC are sent untouched (canvas cannot read them), and if a file still exceeds the limit the panel names it instead of silently failing.

## Secrets

A key never travels through the chat. When a task needs a credential, the agent calls `secrets.request` with the environment variable name, a one-line purpose and the env file (`.env.local` by default). The run publishes a `secret.requested` event, the panel opens a modal window, and the value the user pastes is `POST`ed to `/api/projects/:id/secrets` — into the project's encrypted secret store, never into the workspace. The tool receives only a confirmation, so the value never reaches the model, the conversation, the tool result or the event stream; `server/src/routes/secrets.test.ts` asserts exactly that. The window expires after five minutes (`SECRET_REQUEST_TIMEOUT_MS`) or when the run stops, and the user can cancel: the agent is then told to continue without the key and never to ask for it in chat. The same store backs the **Секреты проекта** tab: variables can be added, imported from a `.env` file, replaced and deleted, but never read back. A file may be `.env` or any `.env.<environment>` variant that is not a template (`.env`, `.env.local`, `.env.production`, `.env.production.local`, …); templates such as `.env.example` stay visible to the agent. A multi-line value (a PEM key) is kept as one value and quoted so the generated file stays valid for dotenv/Vite. Covered by `server/src/secrets/pending-secrets.test.ts`, `server/src/secrets/env-value.test.ts`, `server/src/tools/secret-tools.test.ts`, `server/src/routes/secrets.test.ts` and `server/src/routes/project-secrets.test.ts`.

## GitHub integration

The integrations list connects services one button at a time: the connect button opens the provider's authorization page in a separate window, and the card shows a green indicator once the account is linked. A service stays on "Не настроено на сервере" until its OAuth app is registered — only in that state does the GitHub card also show the setup steps below, so a configured server keeps the card to the service name, its status and the buttons:

1. Open GitHub → Settings → Developer settings → OAuth Apps → "New OAuth App" (`https://github.com/settings/applications/new`). Any name and homepage URL work.
2. Add the Redirect URI `https://<app-host>/api/github/callback` — the card shows the exact value to copy, because the server derives it from the origin the app is open at (`GITHUB_CALLBACK_URL` overrides it; up to 10 URIs are allowed, so the local `http://localhost:5173/api/github/callback` fits in the same app). Leave "Allow wildcard matching", "Enable Device Flow" and "Expire user access tokens" switched off: the server stores only the access token and never refreshes it.
3. Press "Register application": the page shows the **Client ID**, and "Generate a new client secret" issues the **Client secret** (shown once — copy it immediately; generate a new one if it is lost).
4. Provide `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` to the server environment and restart the server. In Freebuff that is Settings → Environment. Development generates the credential-encryption key into the data directory on first use; production requires `WEBNESTDEV_ENCRYPTION_KEY` (see docs/SECRET_ENCRYPTION.md).
5. Set `GITHUB_FRONTEND_URL` when the app is served from a different host than the callback.

The callback must be reachable by the browser, and in production the app host has to be listed in `WEBNESTDEV_ALLOWED_ORIGINS` — the OAuth flow only returns to an origin from that list.

## GitLab integration

The GitLab card works the same way: OAuth in a separate window, or a personal access token when no OAuth application is configured. To register the OAuth application, open GitLab → avatar → **Edit profile** → **Access → Applications** (`https://gitlab.com/-/user_settings/applications`, or `https://<your-gitlab>/-/user_settings/applications` for a self-hosted instance), add the redirect URI `<app-host>/api/gitlab/callback`, enable `read_api`, `read_repository` and `write_repository` (the last one is for pushing commits), and keep **Confidential** on. Then provide `GITLAB_CLIENT_ID` and `GITLAB_CLIENT_SECRET`; `GITLAB_BASE_URL` points the connector at a self-hosted GitLab, and `GITLAB_CALLBACK_URL` / `GITLAB_FRONTEND_URL` override the derived addresses. A personal token needs the same scopes and works without an OAuth application.

Imported GitLab projects keep their remote: the **Изменения** tab can push commits back and pull the branch, with the GitLab token used only on the server. On the free plan an import is limited to 100 MB (`FREE_REPOSITORY_IMPORT_BYTES` in `server/src/account/plans.ts`); larger repositories are rejected before a project is created, and paid plans have no such per-repository limit.

## GitVerse and SourceCraft

Both cards live in **Код и репозитории** and connect with a personal token; GitVerse also supports OAuth. GitVerse is GitHub-shaped: repositories are listed from `https://api.gitverse.ru/user/repos`, imported through `/contents`, and a GitVerse token created in **Settings → Token Management** must allow the repository (read and write). OAuth is GitVerse-specific: register an application under **Settings → Applications** with the redirect URI `<app-host>/api/gitverse/callback` and scopes `read:user read:repository write:repository`, then provide `GITVERSE_CLIENT_ID` and `GITVERSE_CLIENT_SECRET`. GitVerse requires PKCE for every client, so the server generates `code_verifier`/`code_challenge` itself and refreshes the one-hour access token with the stored `refresh_token`.

SourceCraft has no documented endpoint for reading a file's contents, so its import is a shallow `git clone` with the token used only in git authentication (never in the remote URL), and the same token pushes commits back. Its personal tokens are created under **Home → Access → Personal access tokens** and must grant a repository role that can read and write. OAuth applications are not documented by SourceCraft, so the card offers the token only.

## Yandex Cloud integration

The Yandex Cloud card stays folded to a single button. **Подключить** opens the Yandex Cloud console in a new tab and unfolds the key field, because a service-account authorized key is the only credential Yandex Cloud still accepts for a new integration: Yandex ID OAuth tokens stopped working for Cloud on 1 June 2026, so a GitHub-like "sign in and allow" flow cannot grant Cloud access. The card accepts three forms of the credential:

- **Authorized key of a service account (recommended)** — Yandex Cloud console → "Сервисные аккаунты" → create an account → grant `viewer` on the cloud plus the roles the agent needs on the folder → "Создать новый ключ" → "Создать авторизованный ключ" → download the JSON and paste it. The server signs a PS256 JWT with it and exchanges that for an IAM token (`iam.api.cloud.yandex.net/iam/v1/tokens`).
- **IAM token** (`t1.…`) — from `yc iam create-token` or the console button; it lives about 12 hours.
- **Yandex ID OAuth token** (`y0_…`) — only for the OAuth button flow.

Credentials are verified against `resource-manager` before they are stored, then encrypted like every other secret (see docs/SECRET_ENCRYPTION.md) and used only on behalf of that user.

Reads and writes are separated: the agent can always read the account (clouds, folders, VM instances, disks, buckets, Serverless functions) with `yandex.status` and `yandex.resources`, while `yandex.request` refuses any method other than GET/HEAD until the user turns on "Разрешить агенту изменять ресурсы" in the card. With that switch on, the agent creates, changes and deletes resources through the same authenticated call, so it can act on the user's explicit command.

Server environment:

1. Register an OAuth app at `https://oauth.yandex.ru/client/new` with the Yandex Cloud API scope and the callback `https://<app-host>/api/yandex/callback`.
2. Provide `YANDEX_CLIENT_ID` and `YANDEX_CLIENT_SECRET` (`YANDEX_CALLBACK_URL`, `YANDEX_FRONTEND_URL` and `YANDEX_OAUTH_SCOPE` override the defaults; the scope defaults to `cloud-api`).
3. The key path does not need an OAuth app at all, so these values are only used by the sign-in flow; the connector card opens the console and the key form regardless.

See docs/AUTH_PRODUCTION_PLAN.md for the staged rollout. Credential encryption, legacy-token migration, and key rotation are documented in docs/SECRET_ENCRYPTION.md.

## Other Russian clouds

Next to Yandex Cloud, the integrations tab lists the clouds that can be connected with a key in the same folded shape — one button, then a three-step guide and the field (`src/features/integrations/cloud/`):

- **Timeweb Cloud** — a permanent API token, verified with `GET https://api.timeweb.cloud/api/v1/servers`.
- **Cloud.ru** — `Key ID` + `Key Secret` of a service account, verified by exchanging them for a token at `https://iam.api.cloud.ru/api/v1/auth/token`.
- **MWS (МТС)** — the `key.json` authorized key, verified by reading projects through the existing `server/src/mws/mws-auth.ts`.
- **REG.RU Облако** (`cloud.reg.ru`) — the API key from «Настройки» → «Настройки окружения» (created automatically; the card says outright that it opens every cloud-server operation), verified by reading the server list at `GET https://api.cloudvps.reg.ru/v1/reglets` with `Authorization: Bearer`. The panel itself is not deep-linked: the button opens the REG.RU help article that names the exact section, because the panel route is account-specific.

None of them offers a GitHub-like "sign in and allow" flow for cloud resources (checked against their documentation in October 2026): every one of them authenticates a service account or a personal API token. So the connector does the honest thing instead — opens the provider's console, explains where the key is created, and stores it only after the provider accepts it (`server/src/cloud/verify.ts`). Credentials are encrypted like every other secret and are never returned to the browser. The provider catalog is `server/src/cloud/providers.ts` on the server and `src/features/integrations/cloud/catalog.ts` in the panel; adding a cloud means adding an entry to both and a verify function.

The agent reaches those clouds through two tools: `cloud.status` (which clouds are connected, with the account each key belongs to — never the key itself) and `cloud.request` (an authenticated call to the provider's API, reads and changes alike). **A cloud key opens both directions, so the platform does not pretend otherwise**: the card says so before the key is saved, changes are enabled on connect and can be switched off in the same card (`allowWrites` per connection, `/api/cloud/:provider/writes`). The second half of the rule lives with the agent: creating, changing or deleting a resource happens only when the user explicitly asked for that exact action in the conversation — `cloud.request` carries that rule in its own description, and a mutating call on a connection with changes disabled is refused with the name of the switch to turn on (`server/src/cloud/api.ts`, `assertWritesAllowed`). The host is locked per provider (`api.timeweb.cloud`, `*.cloud.ru`, `*.mwsapis.ru`, `api.cloudvps.reg.ru` with the `/v1/` prefix required), so a typo in a path cannot send the key elsewhere (`server/src/cloud/api.ts`, covered by `api.test.ts`).

## Domains

The agent can answer "is this name free?" without any account: `domain.check` (`server/src/domains/`) reads public registry data and returns `available`, `taken` or `unknown` per name, accepts Cyrillic names and full URLs, and never registers, renews, transfers or touches DNS. Two sources are used:

- **`.ru`, `.su`, `.рф`** — WHOIS of the TCI registry (`whois.tcinet.ru`, port 43), because these zones publish no RDAP at all. A registered name answers with a `domain:` line, a free one with `No entries found`.
- **every other zone** — RDAP through the `rdap.org` bootstrap, which follows the redirect into the zone's registry.

Two details keep the answer honest instead of merely plausible. The bootstrap answers `404` both for a free name and for a zone it does not serve (`.ru`, `.de`, …), so a `404` whose body says `No RDAP service is available` is reported as `unknown`, not as a free domain. And `rdap.org` refuses the default `User-Agent` of Node's `fetch` with `403`, so the client identifies itself. Anything unexpected — a timeout, `429`, an unfamiliar WHOIS format — becomes `unknown`, never `available`, because a wrong "free" makes the agent send the user to buy a taken domain.

Registration stays the user's action, and that is a deliberate product decision, not a missing feature: no Russian registrar offers an OAuth-style "connect your account" flow for third parties. Beget's API authenticates with a login plus a separate API password on every request, and REG.RU's API additionally requires the caller's IP to be allow-listed in the account's security settings. The agent therefore checks names for free, and the user buys the domain in their own registrar panel.

### Registrar connectors

The integrations tab also lists three registrar cabinets under **«Домены»** (`src/features/integrations/domains/`), in the same folded shape as the clouds — one button, a three-step guide and the fields:

- **REG.RU** — the account login plus the main or the alternative API password; read through `POST https://api.reg.ru/api/regru2/service/get_list` with `servtype=domain` (домены — это услуги типа `domain`; команды `domain/get_list` в REG.API 2 нет, она отвечает `NO_SUCH_COMMAND`). The cabinet must allow API access and the server's IP; when REG.RU answers `ACCESS_DENIED_FROM_IP`, the error names the server's own external address, so the user knows exactly which IP to add in **«Настройки API» → «Диапазоны IP-адресов» → «Добавить IP»** (`regRuAccessHint` in `server/src/domains/registrar-api.ts`; вкладки «Безопасность», которую называла прежняя подсказка, в кабинете нет). Интеграции вообще не ведут на главные сервисов: ссылка в карточке — это страница, где ключ выдаётся, и за этим следит `server/src/catalog-links.test.ts`.
- **Beget** — the account login plus the separate API password set in the panel's **«API»** section; read through `https://api.beget.com/api/domain/getList`.
- **Timeweb Cloud** — the same API token as its cloud card, read through `GET https://api.timeweb.cloud/api/v1/domains`.

A cabinet is stored only after the registrar accepts the credential and returns the domain list — the same rule as the clouds (`server/src/domains/verify.ts`). Secrets are encrypted like every other secret, live in the `domain_connections` table (or the JSON fallback) and never travel back to the browser. The catalog is `server/src/domains/providers.ts` on the server and `src/features/integrations/domains/catalog.ts` in the panel, so adding a registrar means an entry in both plus a branch in `registrar-api.ts`.

The registrar card has the same **«Разрешить агенту изменять ресурсы»** switch as a cloud card (`allow_writes` in `domain_connections`, default on, toggled by `POST /api/domains/:provider/writes`). With it on, the agent uses `domain.request` — a call to the registrar API with the stored credentials — to do the job a beginner actually needs after deploying: point the domain at the new server by writing the `A` records for `@` and `www`, add a `TXT` for a verification, remove an outdated record. Reads (`zone/get_resource_records`, `dns/getData`, `GET /api/v1/domains/...`) are always allowed; anything that is not a read is refused before the request when the switch is off, and the refusal tells the user to turn it on. Registration, renewal, transfer and payment are never performed by the agent: money and ownership stay with the person. The agent answers "which domains do I already own?" through `domain.list`, which also reports `allowWrites` for every cabinet.

## Services that connect with a key

Below the clouds and the registrars, **«Интеграции» → «Сервисы»** lists the Russian services a generated app most often needs — 20 of them, in six groups (`src/features/integrations/services/`):

- **Файлы (S3)** — Selectel, VK Cloud, Yandex Object Storage, Timeweb Cloud, Cloud.ru.
- **Почта** — NotiSend, Sendsay, RuSender, Unisender.
- **Оплата** — ЮKassa, CloudPayments, Robokassa, Т-Банк Эквайринг.
- **AI** — GigaChat, Yandex AI Studio.
- **Карты** — Yandex Maps API, 2GIS.
- **CRM** — RetailCRM, Битрикс24 (входящий вебхук), amoCRM.

Everything is Russian by design; the foreign providers (Stripe, Resend, SendGrid, OpenAI, Google Maps, HubSpot…) are deliberately absent and stay for a later round. The card is the same folded one as the clouds: one button, a three-step guide, the fields, and the console link. A key is stored **only after the provider accepted it**, and what was checked is written on the card itself. Two providers have no safe read-only request at all — Robokassa and Т-Банк: any call that would verify the credentials is already a payment operation, so those cards say plainly that they store without verification (`verification: "store"` in `server/src/services/catalog.ts`) instead of pretending. Unisender is offered with a note that its licensor is registered in Cyprus, because the product promise is "Russian services" and that detail matters.

Verification is one request per provider, chosen so that it never creates or charges anything: listing S3 buckets, reading an account, exchanging the GigaChat key for a short-lived token and reading the model list, searching a 2GIS region, `credentials` in RetailCRM, `user.current` in Битрикс24. The S3 signature is implemented in the repository (`server/src/services/s3.ts`) rather than pulled from an SDK, and it was checked against an independent implementation — the access key is never trusted to "look right". GigaChat lives behind the Russian trusted CA, which Node does not ship, so the public chain is kept in `server/certs/` and passed to those two requests only (`server/src/services/russian-ca.ts`); the server image copies the files in explicitly, because `tsc` does not. Nothing extends trust globally.

Stored credentials are encrypted with the same key as every other secret, live in the `service_connections` table (or the JSON fallback), and never travel back to the browser: the list endpoint returns only `connected`, the account the key belongs to and the env variable names. Key rotation covers the new folders and tables (`scripts/rotate-encryption-key.mjs`, `JSON_TARGETS` includes the keyed maps `cloud/`, `domains/`, `services/`).

The agent uses three tools (`server/src/tools/service-tools.ts`): `service.status` (what is connected, with the account — never the key), `service.env` and `service.secrets`. `service.env` copies a connected service's variables into the project's encrypted secret store, so the generated app reads `process.env.S3_ACCESS_KEY_ID`, `process.env.YOOKASSA_SHOP_ID`, `process.env.GIGACHAT_AUTH_KEY` and so on at run time — the values never enter the model's context or the tool result, only the names do. That is what makes "подключите оплату" a card the user fills once instead of a key pasted into the chat.

Adding a service means an entry in `server/src/services/catalog.ts` (fields, env names, defaults, `derive`) and in `src/features/integrations/services/catalog.ts` (name, colour, steps), plus a branch in `verify.ts` when a safe check exists. The two catalogs are kept in step by hand — ids, field keys, `optional`, `secret` and names — because a field the panel demands that the server does not read is a broken card.

## Subscriptions and payments

Paid plans are sold through Robokassa: `POST /api/billing/checkout` creates a signed invoice,
`POST /api/billing/robokassa/result` is the server-to-server notification that closes the payment and
activates or extends the subscription, and `GET /api/billing` reports the plan, its end date, the
auto-renew switch and the payment history. The plan a user has actually paid for is read by
`accountPlanFor` (`server/src/billing/store.ts`) and therefore changes quotas, project and storage
limits and the web-search provider at once. Auto-renew charges run hourly and only when the shop has
the recurring-payments service enabled. Keys are entered in **Settings → Platform keys → Payment
(Robokassa)** and stored encrypted; step-by-step cabinet setup (ResultURL, passwords, receipts for
self-employed, test mode) is in [docs/ROBOKASSA.md](docs/ROBOKASSA.md).

A paid plan sells a **monthly pool of model tokens** (50 млн on «Плюс», 250 млн on «Премиум»),
counted from the `model_usage` rows the provider actually reported rather than from button presses:
`getTokenBudget` sums the current UTC month, `consumeAgentRun` refuses a run with
`TOKEN_BUDGET_EXHAUSTED` once the pool is spent, and the subscription page shows the same number as
a monthly meter. The daily run limit stays as the anti-loop guard, and a project with its own AI
provider spends neither the pool nor a daily run. The free plan has no pool (`limit: 0`) and keeps its 10 daily runs. Free
accounts also have integration slots — 1 cloud, 1 registrar, 3 services — enforced by
`server/src/account/integration-limits.ts` before a credential is verified; existing connections are
never disconnected by a downgrade. See [docs/PLANS_AND_LIMITS.md](docs/PLANS_AND_LIMITS.md).

## Changes and rollback

Every finished developer run that changed files becomes a checkpoint: a regular git commit in the project's sandbox directory (`server/src/changes/git-repo.ts` uses `isomorphic-git`, so no `git` binary is required in either image). The commit is created only after the automatic build, preview and browser verification passed, so history holds states that were actually checked, not every intermediate edit.

A checkpoint stays local. **The agent never pushes on its own**: sending commits to a repository is a change to shared code, so it happens only when the user presses **Отправить** in the **Git** tab, after they have seen the result. `createRepositoryForProject` is the one path that creates a repository and sends the initial state, and it too runs from that tab on an explicit click. An imported repository starts from its real GitHub commit — the import fetches the remote branch without touching the files — so the first task produces an ordinary fast-forward commit instead of an unrelated history. A failed or unavailable push never loses work: the commit stays in the project and the panel says why it was not sent, with the same button to retry.

The **Git** tab is shaped like the Git pane in Replit: a branch menu, pull/push, the working tree with per-file diffs, and a commit box. Uncommitted edits — including ones made by hand in **Файлы** or in the terminal — can be selected file by file, given a message and committed without waiting for an agent run; «Отправить» next to the button is the explicit push. Below it, the history lists checkpoints with their files, opens diffs and the commit on the provider, and restores any earlier one. Rollback restores the file tree of that commit and commits the result on top; it never rewrites history, so it needs no force-push and cannot drop other people's commits — and it stays local until the user sends it. The same API lives in `server/src/routes/changes.ts` (`worktree`, `diff`, `commit`, `branches`).

What never enters history: `node_modules`, build output (`dist`, `build`, `.next`, …), caches, environment files and files above `CHANGES_MAX_FILE_BYTES` (12 MB by default). These rules live in `.git/info/exclude` and in `ignoredPath`, so a project's own `.gitignore` keeps working unchanged. `CHANGES_PUSH_TIMEOUT_MS` (20 s) bounds a push so the panel does not wait on an unreachable GitHub; a timeout is reported as "not sent" while the checkpoint stays local.

## Questions from the agent

When the user's decision changes what to build — layout, content, stack, which of two approaches — the model calls `question.ask` instead of guessing. The question opens as a sheet above the message box (`src/features/agent/QuestionSheet.tsx`), with ready-made options, multi-select when several answers make sense, and always the possibility to write a custom answer. The run stops and waits; the answer travels over `/api/projects/:id/questions/:requestId/answer`, not through the agent socket, the same way a secret does, and the server accepts only the labels the question actually offered. Skipping (or the five-minute timeout, `QUESTION_TIMEOUT_MS`) returns "no answer" to the tool, and its description tells the model to pick a sensible default and say which one, never to repeat the question in chat.

## Support tickets

The **Поддержка** button stores a ticket on the server (`server/src/support/support-store.ts`): category, severity, description, steps, page, project, user agent and a mandatory screenshot (PNG/JPEG/WebP, signature-checked, 4 MB). The platform admin reads the list at `GET /api/support/tickets` and the image at `GET /api/support/tickets/:id/screenshot` with their session; the web panel has no separate screen for it yet. Email delivery (`SUPPORT_SMTP_*`) is optional and only a notification — the ticket exists whether or not the message went out, and the dialog says which of the two happened.

A separate desktop or mobile admin app has no panel cookie, so it reads the same two endpoints with a read-only key instead: set `SUPPORT_API_KEY` in **Settings → Platform keys → Поддержка** (at least 16 characters, applied without a restart) and send it as `Authorization: Bearer <key>` or `X-Support-Key: <key>`. The key only reads: creating a ticket still requires a signed-in user, and an invalid or too short key falls back to the session check. Comparison is a constant-time SHA-256 match (`server/src/support/support-api-key.ts`), and both endpoints answer `401` without a key or session, `403` for a signed-in non-admin.

## Admin API

A separate admin app signs in through its own accounts — not through panel users and not through the panel cookie. `POST /api/admin/login` checks the password and returns a short challenge, `POST /api/admin/2fa/verify` accepts a TOTP code (or one of the recovery codes) and answers with a session token used as `Authorization: Bearer <token>`. The second factor is mandatory: the first sign-in goes through `2fa/setup` and `2fa/enable`, and `enable` returns ten one-time recovery codes once. Administrator accounts are created only on the server (`npm run admin:create -- --email …` in development, `node server/dist/scripts/admin-cli.js create --email …` inside the container), and `reset-2fa` is the only way to remove the factor. Without a shell on the VM, set the `ADMIN_BOOTSTRAP_EMAIL` and `ADMIN_BOOTSTRAP_PASSWORD` repository secrets instead: the server creates that account on startup and never overwrites an existing one. Sessions last eight hours in total and thirty minutes idle. Browser access from another origin is limited to `WEBNESTDEV_ADMIN_ORIGINS`; no admin route reads or sets a cookie, so the panel session is never exposed to the admin app. Endpoints, flows and curl examples are in [docs/ADMIN_API.md](docs/ADMIN_API.md).

## Security

The audit, its statuses and the stage-by-stage work log live in [docs/SECURITY.md](docs/SECURITY.md). Stage 1 closed four P0 findings: real client IP behind Caddy with per-account login throttling, a global same-origin guard for mutating requests, a dedicated Docker network for previews (so project code cannot reach PostgreSQL), and the panel-origin preview — production without `PREVIEW_PUBLIC_DOMAIN` now answers 503 on the path preview instead of running project code with the panel's session. Containers also run with `--cap-drop=ALL` and `no-new-privileges`.
