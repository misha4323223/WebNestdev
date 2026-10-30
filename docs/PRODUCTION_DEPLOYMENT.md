# Production deployment

## Where production runs

The production VM and the Docker containers on it live in **MWS (МТС Web Services, `mws.ru`)**, not in Yandex Cloud. The VM runs Docker Compose, the `webnestdev-server` container, Postgres and the sandbox/preview containers started through the mounted Docker socket. Yandex Cloud is used only for optional integrations (Yandex Search API, Notification Service/SMS, Yandex ID sign-in) and for the object-storage keys a project may need — not for hosting. Keep this in mind when changing deploy scripts, firewall rules, disk or backup settings: they act on an MWS VM.

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
- `WEBNESTDEV_STORAGE=postgres` (or explicitly `json` for a single-VM install that keeps files in `WEBNESTDEV_DATA_DIR`)
- `WEBNESTDEV_ALLOWED_ORIGINS=https://your-domain.example`
- `DATABASE_URL=postgres://...` when `WEBNESTDEV_STORAGE=postgres`
- An unknown `WEBNESTDEV_STORAGE` value (including the old `ydb`) now stops startup instead of silently writing JSON files.
- GitHub OAuth URLs must use HTTPS when OAuth credentials are enabled.
- Phone login sends real SMS as soon as one Russian provider block is set **and is passed
  into the container**: Compose forwards only the variables named in `docker-compose.yml`,
  so a key that sits in `.env` but is not listed there reaches nothing — the server stays
  in test mode and only logs the code, which looks exactly like "SMS stopped arriving".
  All the provider keys are passed through now; fill the one you use: Yandex Cloud
  Notification Service (`YANDEX_SA_KEY` / `YANDEX_SA_KEY_FILE` + `YANDEX_CLOUD_ID`),
  otherwise `SMS_RU_API_ID`, or `SMSC_LOGIN`+`SMSC_PASSWORD`, or `EXOLVE_API_KEY`, or
  `SMSAERO_EMAIL`+`SMSAERO_API_KEY`; sender name via `SMS_SENDER` or `YANDEX_SMS_SENDER`.
- **For Yandex, use the service account key, not a ready-made token.** An IAM token lives
  about 12 hours: SMS work right after the setup and then every send fails with 401. The
  key is exchanged for a fresh token by the server itself, and it wins even when a stale
  `YANDEX_NOTIFY_IAM_TOKEN` is still set. Put the key file in `/var/lib/webnestdev/secrets`
  (mounted read-only into the container) and set
  `YANDEX_SA_KEY_FILE=/var/lib/webnestdev/secrets/yandex-sa-key.json`. The path in that
  variable is a path **inside the server container**, so `/app/yandex-sa-key.json` is a value
  that cannot work: the image never contains the key, and the wrong value survives
  `make-env-vm.sh` because it is carried along as an SMS key. When the configured path does not
  open, the key is looked up by name in the locations that usually hold it — the mounted
  secrets directory (`WEBNESTDEV_SECRETS_DIR`, otherwise `/var/lib/webnestdev/secrets`),
  `/run/secrets`, `./secrets` and `./keys` — and `GET /api/health` reports `sms.ready` with
  `sms.keyFile` (the path it was actually read from) and a `sms.note` when that differs from
  the variable. `npm run sms:check --workspace=server` prints the same and answers
  `SMS-CHECK=key-unreadable` instead of `configured` when no path opens. The deploy runs that
  check itself after every rollout (`verify_sms` in
  [`deploy/scripts/vm-deploy.sh`](../deploy/scripts/vm-deploy.sh)) and prints the verdict as
  `[deploy] SMS: …`, so a key path that cannot work is visible in the Actions log — without a
  shell on the VM, and without waiting for the first user who cannot sign in.
- With no provider the server stays in test mode and logs the code — safe for staging, not
  for real users. Keep `WEBNESTDEV_SMS_TEST_MODE` unset in production. Note the Yandex
  sender registration lead time (see [AUTH_PRODUCTION_PLAN.md](AUTH_PRODUCTION_PLAN.md)).

When SMS do not arrive, look in this order: `npm run sms:check --workspace=server` — one command
that names the active provider, the credential kind and (for Yandex) the channel state read from
CNS without sending anything, so «канал в песочнице», «нет прав» и «ключ не дошёл до контейнера»
различаются между собой; добавьте `-- --to <номер>`, чтобы отправить настоящее сообщение и
увидеть отказ провайдера целиком. Дальше: `curl -s localhost:8787/api/health` → `sms`
shows the provider that is actually active and whether it authenticates with a `key` or a
`token`; the sign-in screen itself prints the reason it got from the server (test mode,
sandbox number, expired token); and `docker compose logs webnestdev-server` has the
provider's own refusal — every failed send is logged with its cause.

The server intentionally fails fast in production when the allowed-origin list is missing or contains localhost.

## Ключи сервера: панель вместо правки .env

Ключи самого сервиса — GitHub OAuth (`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`), Yandex Cloud
(`YANDEX_CLOUD_ID`, `YANDEX_FOLDER_ID`, `YANDEX_SA_KEY`), ключи SMS-провайдеров, модель платформы
(`PLATFORM_AI_*`), оплата (Robokassa) и почта платформы (`MAIL_*`, Yandex Cloud Postbox) — вводятся
в панели: **Настройки → Ключи сервера**. Это ответ на вопрос «как
прокинуть ключи на продакшен»: заходить на ВМ и править `.env` больше не нужно, и перезапуск тоже.

- Значения лежат в `WEBNESTDEV_DATA_DIR/platform/env.json` — вне каталога кода, поэтому
  переживают выкатку (каталог кода заменяется, `DATA_DIR` — нет) — и зашифрованы тем же ключом
  `WEBNESTDEV_ENCRYPTION_KEY`, что и подключения интеграций. В браузер значения не возвращаются:
  список показывает форму (`sk-…f3a2`, `строк: 23`) и источник (панель / `.env` / не задан).
- Ключ из панели важнее переменной окружения и читается на каждый запрос, поэтому вход через
  GitHub и отправка SMS начинают работать сразу после сохранения. Пустое поле возвращает ключ к
  значению из `.env` — «как было», без правки файла на ВМ.
- **Кому открыта панель.** Только администратору, которого называют в окружении:
  `WEBNESTDEV_ADMIN_EMAILS=you@example.com` (через запятую) или `WEBNESTDEV_ADMIN_USER_IDS=…`.
  Это значение читается только из окружения и намеренно не хранится в панели: редактор ключей,
  который сам себе выдаёт доступ, — не замок. Пока список пуст, вкладка показывает это и
  подсказывает переменную, вместо того чтобы открыть ключи первому зарегистрированному аккаунту.
  В выкатке адрес администратора передаётся секретом `WEBNESTDEV_ADMIN_EMAILS` (workflow кладёт
  его в `.env` на ВМ и переносит при пересборке `.env`).
- **Загрузка `.env` и вставка полем.** Панель принимает и отдельные поля, и целый файл (или
  перетаскиванием, или вставкой текста). Понимаются `export`, комментарии, одинарные и двойные
  кавычки, CRLF из Windows, значение в кавычках на нескольких строках, JSON authorized key,
  склеенный в одну строку с литеральными `\n`, и JSON, куда при копировании попали настоящие
  переносы строк внутри `private_key` — такой ключ чинится при сохранении и хранится уже
  каноническим JSON. Плохая строка не отменяет остальные: ответ перечисляет, что сохранено, что
  возвращено к `.env` и что пропущено с причиной (`NODE_ENV — изменяется при выкладке`).
- **GitHub OAuth.** Callback в настройках OAuth-приложения:
  `https://<домен панели>/api/github/callback`; `GITHUB_FRONTEND_URL` — `https://<домен панели>/`.
  `GITHUB_CALLBACK_URL` и `GITHUB_FRONTEND_URL` можно не задавать: адрес выводится из домена, на
  котором открыта панель. Ротация секрета — «Generate a new client secret» на GitHub, вставить
  новое значение в панель; старый секрет перестаёт работать сразу после этого.
- **Yandex Cloud.** `YANDEX_CLOUD_ID=b1g…` и `YANDEX_FOLDER_ID=b1g…` — поля панели. Ключ
  сервисного аккаунта вставляется в `YANDEX_SA_KEY` файлом authorized key целиком (многострочным —
  поле это выдерживает) либо указывается путь внутри контейнера в `YANDEX_SA_KEY_FILE`
  (`/var/lib/webnestdev/secrets/yandex-sa-key.json`).  Ключ предпочтительнее готового IAM-токена:
  токен живёт около 12 часов, ключ сервер обменивает на свежий сам.
- **Почта платформы (Yandex Cloud Postbox).** Письма об оплате, предупреждение о списании и
  обращения поддержки: сервисный аккаунт с ролью `postbox.sender`, API-ключ с областью
  `yc.postbox.send` (идентификатор ключа — логин SMTP, секрет — пароль), адрес отправителя на
  подтверждённом по DKIM домене. Пошаговая настройка — [MAIL.md](MAIL.md). Без почты
  автопродление не включается: предупреждение о списании обязательно (376-ФЗ).
- **Если ключи заданы в GitHub Secrets.** GitHub **не даёт создать секрет или переменную с
  префиксом `GITHUB_`** — он зарезервирован под служебные значения (`GITHUB_TOKEN` и другие), и
  поле имени просто не сохраняется. Поэтому в настройках репозитория ключи GitHub OAuth
  называются `GH_OAUTH_CLIENT_ID` и `GH_OAUTH_CLIENT_SECRET` (секреты), `GH_CALLBACK_URL` и
  `GH_FRONTEND_URL` (переменные) — workflow сам записывает их в `.env` как `GITHUB_CLIENT_ID`,
  `GITHUB_CLIENT_SECRET`, `GITHUB_CALLBACK_URL`, `GITHUB_FRONTEND_URL`. Вместе с ними workflow
  передаёт `YANDEX_CLOUD_ID`, `YANDEX_FOLDER_ID`, `WEBNESTDEV_ADMIN_EMAILS`,
  `WEBNESTDEV_ADMIN_USER_IDS` в `.env` на ВМ
  (`PLATFORM_ENV_FILE` в [`deploy/scripts/vm-deploy.sh`](../deploy/scripts/vm-deploy.sh)); пустой
  секрет ничего не стирает. Это удобно для чистой ВМ, но не обязательно: те же значения,
  введённые в панели, важнее и переживают любую выкатку.

## PostgreSQL

The server creates its required tables on startup with `CREATE TABLE IF NOT EXISTS`. Persistent application metadata is stored in PostgreSQL; the local filesystem remains for the sandbox workspace itself.

For an existing installation that still has JSON metadata, run from `server/` with `WEBNESTDEV_STORAGE=postgres` and `DATABASE_URL` set:

```bash
npm run migrate:json-to-ydb
```

The migration is idempotent and uses UPSERTs. It covers users, sessions, projects, conversations, providers, GitHub, Yandex, database connections, encrypted project secrets and the secret audit journal; platform keys stay in `platform/env.json` and are used by both backends.

A daily logical backup of this database goes to the platform bucket, is checked for freshness, and is restored into a scratch database once a month. Setup, key layout, retention and the restore drill are in [POSTGRES_BACKUP.md](POSTGRES_BACKUP.md). A backup that has never been restored is not considered a backup.

## Docker

Build from the repository root:

```bash
docker build -f server/Dockerfile -t webnestdev:production .
```

The image contains the built Vite frontend, Fastify server, Chromium for browser inspection, and Docker CLI for the current sandbox architecture.

Do not expose the Docker socket publicly. The current socket-based sandbox is an interim architecture; the production target is a dedicated sandbox worker.

## Sandbox and preview

Agent commands and the live preview run in containers started by the server through the mounted socket. Both mount the project directory from `WEBNESTDEV_SANDBOX_DIR`, and that path is resolved by the **Docker daemon on the VM**, not by the server process. The directory therefore has to exist on the host under exactly the same absolute path and be mounted into the server container the same way: `docker-compose.yml` does it with `SANDBOX_DIR` (default `/var/lib/webnestdev/sandboxes`), and [`deploy/scripts/make-env-vm.sh`](../deploy/scripts/make-env-vm.sh) writes the same path into `.env` and creates it. A named volume or a container-only path is not enough — the sandbox and preview containers would get an empty directory while the agent writes files into the server's own copy.

- Project directories are handed to the sandbox user, not just chmod-ed: the containers run as uid 1000. Before stage 2.2 the server wrote files as root, and the entrypoint still normalises ownership of legacy trees on the first start; after that the server also runs as 1000, so new files belong to the same user as the container. Files and directories are `chown`ed to 1000 (775/664, secrets 600); on a host where that is impossible, permissions fall back to 777/666 only so the container can still write. File ownership is what git checks: a repo whose `.git` belongs to root while git runs as 1000 answers `dubious ownership`, and writes to `.git/FETCH_HEAD` or `.git/index` fail with `Permission denied`. The `.git` tree is re-opened before every container command, and the command container carries `safe.directory=*` so a legacy root-owned repo is usable immediately. Vite caches under `node_modules` that were created by a non-container user are removed, since Vite cannot write into them and they are disposable.
An installation that predates the host path keeps its project files in the `webnestdev-data` volume; move them once with [`deploy/scripts/migrate-sandboxes.sh`](../deploy/scripts/migrate-sandboxes.sh) (`SANDBOX_DIR=/var/lib/webnestdev/sandboxes bash migrate-sandboxes.sh` from the deployment directory), otherwise existing projects open empty. An **image deploy does this itself**: `vm-deploy.sh` copies the volume into `SANDBOX_DIR` when that directory is still empty and says so when it is not (`MIGRATE_SANDBOXES=0` disables it).
- **Git inside the container works on a repo the server owns.** The worktree and `.git` belong to uid 1000 (the server chowns them), the agent's `git.commit` supplies the platform author (`NestDev Agent`) instead of requiring a `user.name` that project repos never had, and remote operations are not attempted from the container at all — `git.pull` runs in the server process with the connected token (see the `git.pull` tool), because the container has no network and no credentials.
- **The sandbox image is the full Node image, not `-slim`.** It is the environment for the agent's commands, `npm install` and the preview container, and the agent's git tools run `git` inside it. `node:22-bookworm-slim` has no git at all, so «Работа с Git» answered `/bin/sh: 1: git: not found` (exit 127) while the panel's history kept working (it uses isomorphic-git in the server process). The full image is buildpack-deps based: it brings git, `make` and a C compiler, so native `npm install` and git-URL dependencies work too. It costs about 1 GB on disk instead of ~330 MB; the deploy pre-pulls it best-effort (`SANDBOX_IMAGE`, default in `server/src/sandbox/config.ts`), and a host that wants the small image back builds its own slim+git image and sets `SANDBOX_IMAGE` to it — the platform does not assume git exists and says so in the tool error instead of returning the shell's answer as repository state.
- The two paths are kept apart in code, not assumed equal. The server writes projects into `WEBNESTDEV_SANDBOX_DIR`, while every container mount uses `WEBNESTDEV_SANDBOX_HOST_DIR` (same value by default) — so a sandbox directory that is *not* mounted at the same absolute path in the server container can still be made to work by naming its host path. A relative path is reported as a failure instead of being passed to `docker run -v`, where it would silently resolve against the host root.
- **The path contract is checked, not trusted.** At startup the server writes a marker file into the sandbox directory and asks a container to read it back through the same mount a command uses; the result stays in `GET /api/health` under `sandbox.mount` and in the startup log. `docker compose exec -T webnestdev-server node server/dist/scripts/sandbox-selfcheck.js` runs the check on demand and prints both directories plus a machine-readable `SANDBOX-MOUNT=` verdict (`ok`, `mismatch`, `image`, `docker`, `disk`). This exists because the reverse of it is what happened in practice: the VM ran a `docker-compose.yml` older than the repository, the server fell back to its own default directory, the containers mounted a host path that was empty, and the symptom surfaced as an agent reporting that files had disappeared.

- Starting a preview first installs what the project declares (`npm install --no-audit --no-fund`, the only step with outbound network, the same command as `npm.install`) and puts its output into the preview's log. A project the agent has just created has no `node_modules`: the build used to fail on a missing `vite`, the dev server behind it, and a failed start now also names its cause as a `[preview]` line in the server container, so `docker compose logs webnestdev-server` shows why instead of only the attempt.
- A preview runs in one of two modes and `PREVIEW_MODE` picks it. `auto` (the default) builds the project with `npm run build` inside the sandbox and serves the output (`dist`, `build` or `out` containing an `index.html`; `PREVIEW_STATIC_DIR` overrides the choice) **from the server process itself** — no container, so a small host keeps several projects previewable at once. A project without a build script, with a failing build, or without an `index.html` falls back to the per-project dev server and the panel says why. `container` is that dev server with live reload; `static` forbids the fallback. A static preview has no hot reload: it is rebuilt on the next start when a source file is newer than the served build (`PREVIEW_STATIC_BUILD=always` rebuilds every start, `never` serves whatever is there), and its logs face shows the build output instead of dev-server output.
- A preview is stopped after five minutes without use (`PREVIEW_IDLE_MS`, `0` disables the sweep; `PREVIEW_SWEEP_MS` sets how often it runs). Use means: a status or logs read, a proxied request, or the open panel's heartbeat — a closed tab stops sending it, and the container is freed. A project with a run in flight is never swept.
- The cheapest tier comes first and is decided by the project itself, not by a flag: a project whose files are already servable (`index.html` and no build script) is **served as is, with no build and no container**, and files present in `dist`/`build`/`out` are served the same way. A project with a build script is built once and served from `dist`; a project that answers HTTP itself (express, fastify, Nest, Next in server mode, FastAPI) is recognised as such *before* anything is built, so no container is spent on a build that cannot produce a static preview. The decision and its evidence live in `server/src/preview/project-kind.ts` (structure, dependencies and commands together — `package.json` alone proves nothing).
- **A user's `Dockerfile` is never executed.** `docker build` runs its steps as root without the memory, PID and network limits that `docker run` applies, so it is not the same trust level as the rest of the platform; the file is reported as evidence and the project is served by our own image. An isolated builder is a separate product, not a flag.
- A runtime preview is the one kind that is counted, and it is counted **per account**: `PREVIEW_MAX_PER_USER` (default `1`, `0` disables it). A user's second container preview stops *that user's* oldest one — two projects of one person do not fight over the host, and nobody waits for a slot. Another user's running app is never stopped behind their back. `PREVIEW_MAX_CONTAINERS` is a brake on the **host total**: by default it is derived from host memory (about one 1 GB preview per GB, at most `8`), an explicit number overrides it, and `0` removes the cap. Static previews are not counted: a listener costs ~0.5 MB.
- `GET /api/health` reports what the host is doing right now — the three queues (runs, sandbox containers, Chromium) with `active`/`queued`/`limit`, live previews per kind, disk usage of the sandbox directory and RSS/swap. These are the four numbers from the launch checklist, and the point of them is that a queue nobody can see is indistinguishable from a hang. Полные поля отдаются только запросу с loopback; снаружи, через Caddy, ответ содержит лишь `ok`, `service`, `build` и `sms`, чтобы не публиковать пути и очередь хоста.
- The preview container is not published on the host. It joins a dedicated preview network (`webnestdev-preview` in compose) that the server also joins, and is reached at its own container address on port 3000, so a user's app never appears on the VM's public address. PostgreSQL stays on the `webnestdev` network with the server and Caddy; previews never join it, so project code cannot reach the platform database. Caddy's subnet on `webnestdev` is fixed, and that subnet is what the server trusts for `X-Forwarded-For` — an address would change every time the container is recreated. `PREVIEW_NETWORK` pins another network; it is unset by default because Compose prefixes names with the project (the VM's `src` gives `src_webnestdev-preview`), so the server resolves its own preview network from Docker instead. `PREVIEW_REAP_ON_START=0` skips removing preview containers left over from a previous server run (set it when several replicas share one Docker host). The preview container is started **without `--rm`**: a dev server that exits on its own mistake (bad start script, occupied port, OOM) would otherwise be deleted by Docker before the server could read its output, and the panel showed `Error response from daemon: No such container: <id>` instead of the reason. An exited preview therefore stays stopped until the stop button, the next start or the next status read removes it, and `/api/projects/:id/preview/logs` answers `running: false` for a container Docker no longer knows rather than returning that message as application logs.
- **That network is found, checked and repaired, not assumed.** Docker isolates bridge networks from each other, so a preview container left in the network by default is invisible to a server that runs in its own container — while `docker exec` into it still works. That combination is the one that looks like a platform fault from the panel: the preview reports itself running and ready, everything the agent asks about the address fails with `fetch failed`, and the framed app is a white screen. The server therefore resolves its own networks from three sources (`PREVIEW_NETWORK`, the container's hostname, and matching its own IP addresses inside `docker network inspect` when a compose file sets a custom `hostname:`), starts the preview on them, and — when the app answers inside the container but not at the container address — **connects the running preview container to the preview network** (`docker network connect`; never to the database network) and confirms the new address. Only then does it fall back to the TCP relay for an app bound to `127.0.0.1`. The status the panel sees carries `settled`: the address was confirmed by a request from the server itself, which is the same door the panel iframe and Chromium use.
- **When the address cannot be repaired, the panel is still served — through `docker exec`.** `docker exec` does not depend on the network at all, and it is already how the platform asks the app whether it is up (`previewAppAnswers`). So the proxy tries the container address first — streamed, WebSocket HMR included — and, if that fails while the app answers inside the container, serves the same request from inside it (`server/src/preview/exec-proxy.ts`): the method, the body, the query and the app's own request headers go in, and the status, headers and body come back. The panel then shows the app (slower — one process per asset — and without hot reload) instead of a white frame under a preview that reports itself running. The state carries `execOnly`, the status the panel sees carries `viaExec` together with a hint saying exactly this, and recovery costs nothing: the unreachable address is re-checked at most once every `PREVIEW_EXEC_RETRY_MS` (default 60 000; `0` re-checks on every read), so as soon as the network is repaired or the container is restarted the direct address takes over again. Because each such request is a Node process *inside* the preview container, how many run at once is bounded (`PREVIEW_EXEC_MAX_CONCURRENT`, default 4; the rest wait in a finite queue — `PREVIEW_EXEC_MAX_QUEUE`, `PREVIEW_EXEC_QUEUE_TIMEOUT_MS`), and `/api/health` shows that queue as `activity.previews.exec`. These and every other preview knob must be listed in the `environment:` block of `docker-compose.yml`: compose passes a container only the variables named there, so a value that exists in `.env` but not in that block is silently ignored — which is exactly why `PREVIEW_NETWORK` (and the limits above) are now named there. A preview started without the exec path is not affected in any way.
- **Any of that can be measured on the VM, without waiting for a user to hit it.** `docker compose exec -T webnestdev-server node server/dist/scripts/preview-selfcheck.js` starts a throwaway container on the resolved network and port and prints which of the cases the host is in: `PREVIEW-NETWORK=ok` (the server reaches it), `ok-after-connect` (it did not, and the platform's repair fixes it), `unreachable` (neither — set `PREVIEW_NETWORK`), `start-failed` (the probe container never started — a Docker problem, not the network), `no-docker`, `image`. Every image deploy runs the same check and prints its verdict in the run log (`PREVIEW_CHECK=0` skips it); a failure does not fail the deploy, because this is a property of the host rather than of the shipped build. The same deploy log also answers whether Docker works *inside* the server container at all (`DOCKER-CHECK=ok|no-cli|no-socket|failed`, `DOCKER_CHECK=0` skips it): `spawn docker ENOENT` in the server log means the image has no docker CLI, and `Cannot connect to the Docker daemon` means neither the broker socket nor a direct `/var/run/docker.sock` is reachable from it (the direct socket is deliberately not mounted, so the broker is the only path) — without either, no preview and no agent command can start a container at all.

## Isolation: gVisor and a non-root server

`SANDBOX_RUNTIME` selects the Docker runtime for every command, long job, preview and self-check container: `docker` (the default, ordinary runc) or `runsc` (gVisor). The flag is deliberately opt-in: deploying this code without the variable changes nothing.

No terminal on the VM is required. The deploy installs gVisor when `SANDBOX_RUNTIME=runsc` and `docker info` does not list `runsc`. There are two equivalent triggers:

- **One run from GitHub:** Actions → `deploy` → Run workflow → `sandbox_runtime=runsc`. This overrides the repository Variable for that run and does not change it permanently.
- **Normal deploys:** set the repository Variable `SANDBOX_RUNTIME=runsc` and push (or run the workflow with `sandbox_runtime=keep`). A repository Secret with the same name is also read as a fallback, so an existing secret does not have to be moved. Every later deploy reuses the installed runtime and does not reinstall it.

The workflow sends `deploy/scripts/install-runsc.sh` to the VM in base64, so it does not depend on the VM's checkout being current. `vm-deploy.sh` runs it with `sudo -n` before switching the application version. The deploy user therefore needs passwordless sudo (`sudo -n true`). If that is not available, the deploy stops with an explicit log line; a host administrator must install `runsc` once or grant that permission. `RUNSC_INSTALL=0` (a repository Variable or Secret, passed to the deploy) disables automatic installation for a host that is already prepared; `RUNSC_INSTALL=auto` is the default.

The script downloads the pinned gVisor release, verifies `SHA256SUMS`, keeps `runsc` and its `gvisor-bin/` sidecars together, registers the runtime through `runsc install`, and reloads Docker. If the reload does not expose `runsc`, the deploy passes `RUNSC_RESTART_DOCKER=1`, and the script restarts Docker, waits for it, and verifies the runtime. Containers with `restart: unless-stopped` come back on their own; the deploy then starts the new version. Expect a short Docker interruption on the first run — do it in a maintenance window. If installation fails, the deploy stops **before** switching the application version, so the previous working stack is not replaced by a server whose sandbox cannot start containers.

The deploy log must say `SANDBOX-RUNTIME=runsc: Docker знает gVisor`; the server log prints `[sandbox] рантайм контейнеров: runsc (gVisor)`. The deploy already runs `sandbox-selfcheck` and `preview-selfcheck`; their verdicts are in the Actions log, so no VM shell is needed:

```text
SANDBOX-MOUNT=ok
PREVIEW-NETWORK=ok
```

For a real project, open it through the panel and run `npm install`, `npm run build`, git status and preview/HMR. The checks and ordinary containers use the same runtime; a preview self-check run under runc would not prove anything. Compare build time and memory with `SANDBOX_RUNTIME=docker` and `runsc` and record the numbers in the scaling plan. gVisor is slower on syscall-heavy work such as a cold `npm install`; that is expected, and the rollback is one variable: `SANDBOX_RUNTIME=docker` plus a deploy. The runtime stays installed, so switching back to runsc needs no reinstall.

### Server process is not root

The server container's entrypoint starts as root only to prepare persistent state, then `exec`s the Node process through `setpriv` as uid/gid 1000. The broker deliberately remains root because it is the only process that sees the real `docker.sock`; it creates its Unix socket with mode `0660` and group `BROKER_SOCKET_GID` (default 1000), so the unprivileged server can still reach the broker but not the Docker daemon directly.

At startup the entrypoint:

- chowns `WEBNESTDEV_DATA_DIR` to `WEBNESTDEV_UID:WEBNESTDEV_GID`; stage 2.2 accepts only `1000:1000`, because sandbox containers and the broker policy already use that uid, and any other value would leave files the container cannot write. An unsupported value stops the container with a clear `[entrypoint]` error instead of producing a working-looking but broken server;
- recursively normalises the sandbox directory once, then records a marker in the data volume so later starts do not rescan `node_modules`;
- copies host secrets from the read-only `WEBNESTDEV_SECRETS_DIR` into a private runtime directory owned by the server, because the deploy may create the host directory as `root:root 0700`; `YANDEX_SA_KEY_FILE` and `POSTBOX_SA_KEY_FILE` are rewritten to the copy;
- sets `HOME`/`XDG_CACHE_HOME` to writable paths in `/tmp` (Chromium and Node must not try to write `/root`).

The internal `GET /api/health` response carries `sandbox.runtime` (the runtime the server will pass to the next container) and `activity.process.uid`/`gid`; the uid/gid come from the running process, not from an environment variable. A deploy prints `SERVER-USER=ok uid=1000` after reading `/proc/1/status` inside the container (`SERVER_USER_CHECK=0` skips it). `docker compose exec` itself still runs as root — that is why the check reads PID 1, not `id` in an exec session. If the entrypoint cannot prepare a volume, it logs the exact path and the server may fail to write; the previous image still works because it can write files owned by 1000.

Rootless Docker on future runner nodes remains part of stage 3; this change makes the API process unprivileged on the current single VM without pretending that the Docker daemon itself is rootless.

Rollback is asymmetric, and this matters during an incident. gVisor is turned off with `SANDBOX_RUNTIME=docker` and a deploy; nothing is uninstalled. The non-root server is reverted by deploying the previous image, because the old image is the one that runs as root. Mounting `/var/run/docker.sock` back into the current image does **not** restore Docker access: the socket is `root:docker 0660`, and uid 1000 is not in that group. `WEBNESTDEV_DOCKER_BROKER=0` is likewise not a rollback for the current image. The full sequence is in `docs/DOCKER_BROKER.md` §6.

## Preview details

- **The app's address is settled from evidence, not assumed.** The launch command asks for `--host 0.0.0.0 --port 3000`, but only a tool that parses those flags obeys them (Vite, Next); a dev script built from `concurrently`, `npm-run-all` or a plain `node server.js` stays on its own port, and Vite without `--host` listens on `127.0.0.1` *inside* the container — visible to `docker exec`, invisible to the server, the proxy and Chromium. The platform therefore reads the container's `/proc/net/tcp` for the port the app actually holds, and an app that answers on loopback only gets a TCP relay inside its own container on a free platform port (`server/src/preview/preview-address.ts`). `settled` in the preview state means the address has been confirmed by a request; until it is, the next status read tries again, so a slow first start heals itself. When nothing can be repaired, `project.verify` reports whether the app answered *inside* the container instead of only `Unable to reach Preview: fetch failed` — the difference between «the dev server never came up» and «it is running where nobody can reach it» (the latter used to burn the three verification attempts and end the run).
- **A preview that never comes back is an answer, not a white frame.** The proxy waits at most `PREVIEW_PROXY_TIMEOUT_MS` (default 30 000) for the app and then reports what happened, distinguishing a connection that was refused (nothing listens on that port any more) from one that was accepted and never answered (the app is alive inside the container but unreachable from outside — the network/loopback case above). Without the bound the request waited for the server's own request timeout, and the panel showed an empty white frame with no reason for minutes.
- **A deploy never leaves an open tab on the previous build.** Three layers, because a cached shell leaves no trace in the deploy log. (1) The document is served with `no-store, no-cache, must-revalidate, max-age=0`, `pragma`/`expires`, **and without `etag`/`last-modified`**: with a validator still present a proxy may answer `304 Not Modified`, and the tab keeps the old document plus its links to the old build's assets — those carry a hash and are cached 30 days, so the old version keeps working and looks healthy. The rule lives in one place (`server/src/routes/cache-headers.ts`, applied by `routes/panel-static.ts`, covered by `panel-static.test.ts`), while hashed `assets/*` keep `immutable, max-age=30d` and unhashed files (icons) keep `no-cache`. The preview proxy applies the same no-store rule to everything it serves: a reloaded frame must show the project's current state. (2) Every tab compares its own build with the server's: `ARG GIT_SHA` reaches the frontend build as `VITE_BUILD` (Vite exposes `VITE_*` from the build environment, so `vite.config.ts` is untouched), the same value answers `GET /api/version` — build number only, no Docker/database, so it is cheap enough to poll — and a mismatch reloads the tab once with a cache-busting `?v=` query (`src/lib/app-build.ts`, polled every two minutes and on returning to the tab). The attempt is recorded per served build in `sessionStorage`, so a build that cannot reach a given tab never causes a reload loop; a build with no SHA (dev, a local build) disables the check. (3) The deploy already fails when the live build is not the shipped one (`verify_version` above), so the three layers agree on what "the new version" is.
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
  the moment the run ends — including a failed or cancelled one — and a request that arrives
  before that moment waits for the place instead of being refused: `AGENT_ACCOUNT_WAIT_MS`
  (default `5000`, `0` refuses at once). The wait exists for the panel's «Отправить сейчас»,
  which closes the socket of the running task and starts the queued message right away; without
  it the user's own message was answered `RUN_ALREADY_ACTIVE`, as though a second agent had been
  started. It is bounded and holds no place in either queue.
- `BROWSER_MAX_CONCURRENT` (default `1`) — Chromium instances at once. The browser worker launches
  Chromium **inside the server container**, where no memory limit applies, so this is what keeps a
  browser check from taking the whole platform down. `BROWSER_MAX_QUEUE` (default `8`) and
  `BROWSER_QUEUE_TIMEOUT_MS` (default `60000`) bound the rest.
- `AGENT_PROVIDER_RETRIES` (default `5`), `AGENT_PROVIDER_RETRY_BASE_MS` (default `2000`),
  `AGENT_PROVIDER_RETRY_MAX_MS` (default `60000`), `AGENT_PROVIDER_RETRY_BUDGET_MS` (default
  `300000`) — how a step waits out a provider that answers `429` or `5xx` instead of ending the run.
  The place a run holds is kept while it waits, so a provider that refuses everyone makes runs wait
  rather than fail: lower the budget if the queue has to turn over faster, and raise it (or
  `AGENT_MAX_CONCURRENT_RUNS`) when the gateway's limit is the real constraint.
  `AGENT_RUN_HEARTBEAT_MS` (default `20000`) is the interval of the `run.alive` message that keeps a
  long, silent step from looking like an idle connection to a proxy or load balancer.

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
3. **TLS** — the session cookie gets the `secure` flag only when the request actually arrives
   over https (`X-Forwarded-Proto`, or the socket itself), so a service opened on `http://…:8787`
   logs in but sends that cookie unencrypted; `WEBNESTDEV_COOKIE_SECURE` overrides the flag in
   either direction. Terminate HTTPS (Caddy with Let's Encrypt is the shortest path) and make sure
   the proxy forwards the scheme, or the cookie stops being `secure`. Caddy also proxies
   WebSockets, which `/ws` and container-preview HMR need.
4. **Limits** — `PREVIEW_MODE=auto`, `SANDBOX_MAX_CONCURRENT=2`, `SANDBOX_MEMORY=512m`,
   `AGENT_MAX_CONCURRENT_RUNS=8` (20-30 is fine on this box), `BROWSER_MAX_CONCURRENT=1`.
   Lower `TOOL_COMMAND_MAX_OUTPUT` (default 200 000 chars) — every command output is sent to the
   model, so this number is a *bill*, not a comfort setting.
5. **Secrets** — `WEBNESTDEV_ENCRYPTION_KEY`, `WEBNESTDEV_ALLOWED_ORIGINS`, `POSTGRES_PASSWORD`,
   `DATABASE_URL`, and the AI provider (`PLATFORM_AI_BASE_URL` / `PLATFORM_AI_MODEL` /
   `PLATFORM_AI_API_KEY`; for the free plan also `PLATFORM_AI_FREE_BASE_URL` /
   `PLATFORM_AI_FREE_MODEL` / `PLATFORM_AI_FREE_KEY_1..3`; for the agent's image tool
   `PLATFORM_IMAGE_BASE_URL` / `PLATFORM_IMAGE_MODEL` / `PLATFORM_IMAGE_KEY_1..3`).
   Secrets live in the environment,
   never in the repository.
6. **Hygiene (cron)** — weekly `docker system prune -af --filter until=168h` and weekly removal of
   `node_modules` in projects untouched for a month. The nightly `pg_dump` to Object Storage is no
   longer a manual cron: it runs from `.github/workflows/pg-backup.yml` (see
   [POSTGRES_BACKUP.md](POSTGRES_BACKUP.md)), with a daily freshness check and a monthly restore
   drill. MWS disk backups are incremental and manual only (3.456 ₽/GB·month).
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

## Keeping the disk from filling up

Every deploy pulls a new image, and the server image contains Chromium — that is gigabytes per
version. Left alone, a 30 GB disk fills after a handful of deploys, and a full disk takes down
Postgres, builds and project writes at once. So the deploy script keeps only the **running** image
of the deployment repository (`KEEP_IMAGES`, default `1`) and removes the rest *after* the health
check passes. The spare copy is not worth its gigabytes: the image is already in GHCR, and a manual
rollback begins with `docker pull`. A failed deploy still keeps the previous image in place, because
pruning runs only after a successful health check — that rollback stays instant.

- **Automatic:** every image deploy prunes old versions; nothing to schedule.
- **Automatic, when the disk is already full:** a `docker pull` that fails is answered with the same
  cleanup and **one retry**. Without it a full disk was a dead end — the layers of a new image (and
  Chromium inside them) do not extract with `no space left on device`, the pull dies before the
  post-deploy cleanup can run, and every later deploy fails the same way until someone logs into the
  VM. The retry only runs on a failed pull, so a healthy deploy never pays for it.
- **By hand, without SSH:** Actions → **deploy** → *Run workflow* → `mode=prune`. It only cleans
  images and never touches the running service.
- **When the service is down but the version is right:** `mode=repair`. It runs the same cleanup
  (which also frees the space a recreate needs) and then re-creates the containers from the image
  pinned in `.env` (`WEBNESTDEV_IMAGE`), with `--force-recreate` so a container stuck in a restart
  loop is replaced rather than considered already up. It never pulls or changes the version, and
  the health, Docker, sandbox and panel checks run afterwards exactly as in a normal deploy. This
  is the one-command answer to the full-disk / restart-loop dead end that otherwise needs SSH.
- **On a timer (optional):** the same logic is reachable from the VM if the repository is checked
  out there — `MODE=prune bash deploy/scripts/vm-deploy.sh`, so a cron line
  `0 4 * * 0 MODE=prune bash /path/to/vm-deploy.sh >> /var/log/webnestdev-prune.log 2>&1` is enough.
  `KEEP_IMAGES=2` brings the second copy back if a fast offline rollback matters more than disk.
  The same applies to `MODE=repair`, which prunes first and then brings the service back up.

- **The image itself is kept small:** the runtime stage installs production dependencies only
  (`npm ci --omit=dev`), the browser is `chromium-headless-shell` rather than the full Chromium (the
  server launches it headless everywhere, which saves ~390 MB), and `docker` is the 43 MB static
  client instead of the 282 MB `docker.io` package with containerd and runc inside it.
- Other repositories (`postgres`, `node:22-bookworm`) are deliberately **not** touched: deleting
  them only means re-pulling them later. `IMAGE_REPO_PATTERN` changes which repositories are cleaned.
- Build cache is pruned too, and on a real VM it turned out to be the biggest single line in
  `docker system df` — **15 GB**, more than every image together, because an image-mode deploy never
  builds on the server. `PRUNE_BUILD_CACHE` (default `all`, because that VM never builds) sweeps the
  whole cache, `1` only what is older than a week, `0` disables it.
- `DRY_RUN=1` lists what would be removed without removing anything — worth a look the first time.

Object storage is **not** a substitute for this: a bucket cannot hold `node_modules` or `/var/lib/docker`
(no POSIX semantics, no locks), so it is for Postgres dumps and cold archives of idle projects,
not for the working disk.

That cold tier is implemented: with `PLATFORM_S3_*` set and `PROJECT_ARCHIVE_ENABLED=1`, projects
without writes for `PROJECT_ARCHIVE_IDLE_MINUTES` (three hours by default) are packed into
`<prefix>/projects/<userId>/<projectId>/workspace.tar.gz`, verified by size, and removed from the
VM disk. The next access downloads and unpacks them automatically, so the panel and the agent see a
normal directory. On the numbers above this is what lets one 30 GB disk serve more than 20–40
projects: only projects in active use occupy it. Setup, variables and the API are in
[STORAGE.md](STORAGE.md#object-storage-cold-tier).

## GitHub Actions deployment

[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) builds the image, pushes it to GHCR (`ghcr.io/<owner>/<repo>`) and then runs [`deploy/scripts/vm-deploy.sh`](../deploy/scripts/vm-deploy.sh) **on the server** — over SSH, or locally when the job runs on a self-hosted runner installed on the VM itself.

It runs automatically on every push to `main`, and can also be started by hand from Actions → **deploy** → *Run workflow* (for example to roll back with an older image tag).

Two modes:

- **image** (default) — the VM pulls the published image and starts it with Compose (`WEBNESTDEV_IMAGE`); the code directory is not touched. The deploy **also ships `docker-compose.yml`** from the checked-out repository: the file is validated with `docker compose config` before it replaces the one on the VM (the previous file is kept as `docker-compose.yml.bak`), and a file that does not validate is skipped instead of breaking the rollout. Without this the VM silently kept an old file — which is exactly how the sandbox paths diverged. `SYNC_COMPOSE=0` turns it off.
- **source** — the VM runs `git fetch` / `git checkout` / `git pull --ff-only`, `npm ci`, `npm run build` and `sudo systemctl restart $SYSTEMD_UNIT`.

After the health check the deploy runs the sandbox self-check inside the server container and **fails (exit 4) on a path mismatch**: a deployment in which the agent writes files the sandbox terminal cannot see is not a successful deployment.

**The deploy also verifies that the version it shipped is the version that is running.** Every image carries the commit SHA it was built from (`GET /api/health` → `build`), and the script compares both the running container's image and that `build` value with the tag it deployed. A mismatch — the container was not recreated, or the service came up on something else — **rolls the VM back to the previous image and fails the job** (exit 5; exit 1 when the new version never becomes ready). Before this, a failed deploy simply left whatever was already running, and the symptom surfaced days later as "the site shows the old version again" with nothing about it in any log. `VERIFY_VERSION=0` turns the check off.

Which version is live right now, without a shell on the VM:

```bash
curl -s localhost:8787/api/health | sed -n 's/.*"build":"\([^"]*\)".*/\1/p'
```

The same number is available from `GET /api/health`. If it is the new commit while the page still looks old, the page came from the browser cache — the document is served with `cache-control: no-store` for exactly that reason, but a browser that cached it under the older 30-day rule needs one hard reload (clear site data on a phone).

Rollback by hand: run the workflow again with mode `image` and `image=ghcr.io/<owner>/<repo>:sha-<12 символов коммита>` of the previous build (every tag is listed in the GHCR package page). The previous image is still on the VM: cleanup runs only after a successful deploy, so a rollback never needs a rebuild.

Repository secrets (Settings → Secrets and variables → Actions → **Secrets**):

| Secret | Value |
| --- | --- |
| `DEPLOY_HOST` | VM address reachable from the runner |
| `DEPLOY_USER` | SSH user on the VM |
| `DEPLOY_SSH_KEY` | private key (the public one goes to `~/.ssh/authorized_keys`) |
| `DEPLOY_PORT` | SSH port, optional, default 22 |
| `DEPLOY_KNOWN_HOSTS` | optional; without it the runner runs `ssh-keyscan` |
| `YANDEX_SA_KEY_JSON` | optional; the whole service account key file. The deploy writes it to `/var/lib/webnestdev/secrets/yandex-sa-key.json` (mode 600), points `YANDEX_SA_KEY_FILE` at it and removes the temporary copy — SMS login stops depending on someone logging into the VM to place the file |
| `YANDEX_SEARCH_API_KEY` | optional; API key of the service account with the `yc.search-api.execute` scope. This is the web search of paid plans (Yandex Search API v2), not the SMS key |
| `YANDEX_SEARCH_FOLDER_ID` | optional; the folder where that account has the `search-api.webSearch.user` role. Empty — the server falls back to `YANDEX_FOLDER_ID` |
| `TAVILY_API_KEY` | optional; reserve web search provider for paid plans, used when Yandex Search API is not configured or refused |
| `PLATFORM_S3_ACCESS_KEY_ID` | optional; HMAC access key of the platform's own bucket (cold tier, `docs/STORAGE.md`). Together with the secret key it lets the server archive idle projects to S3 and restore them on first access; without the pair nothing changes and projects stay on the VM disk |
| `PLATFORM_S3_SECRET_ACCESS_KEY` | optional; HMAC secret for the access key above. Shown once by the provider when the key is created |

If the secrets directory belongs to root — docker creates a bind-mount source that way — the deploy writes the key with a one-off container from the image it just pulled: the deploy user already has docker (without it the deploy could not start a container at all), and inside that container the write happens as root, so neither `sudo` (which may ask for a password that nobody can type in a workflow) nor a login to the VM is needed. The key keeps the documented path. Only when that container cannot write — no image at hand, docker refusing — does the deploy print the one command to run instead (`sudo mkdir -p /var/lib/webnestdev/secrets && sudo chown $USER /var/lib/webnestdev/secrets`) and leave the existing key untouched.

Repository variables (same page → **Variables**):

| Variable | Value |
| --- | --- |
| `DEPLOY_APP_DIR` | deployment directory holding `docker-compose.yml` and `.env`, default `~/webnestdev/src` |
| `DEPLOY_RUNNER` | self-hosted runner label; set it (and install the runner on the VM) when the VM has no inbound SSH |
| `WEB_SEARCH_PROVIDER` | optional; `auto` (default — provider by plan), `duckduckgo`, `yandex` or `tavily`. Never lifts a paid provider into the free plan: free accounts always search DuckDuckGo (`docs/WEB_SEARCH.md`) |
| `PLATFORM_S3_ENDPOINT` | optional; S3 service address only, for MTS Web Services `https://storage.mwsapis.ru` |
| `PLATFORM_S3_BUCKET` | optional; bucket name, for example `webnest` |
| `PLATFORM_S3_REGION` | optional; signing region, `ru-central1` for MTS Web Services |
| `PLATFORM_S3_PREFIX` | optional; key prefix inside the bucket, `webnestdev` by default |
| `PROJECT_ARCHIVE_ENABLED` | optional; `1` turns the idle-project sweeper on. Without it the keys are accepted but nothing is archived |
| `PROJECT_ARCHIVE_IDLE_MINUTES` | optional; minutes without writes before a project is packed to the bucket, 180 (three hours) by default |
| `PROJECT_ARCHIVE_IDLE_DAYS` | optional legacy form in days; ignored when the minutes key is set |
| `SANDBOX_RUNTIME` | optional; `docker` (default, runc) or `runsc` (gVisor). Setting `runsc` makes the deploy install gVisor on first use if Docker does not know it |
| `RUNSC_INSTALL` | optional; `auto` (default) or `0`. `0` forbids the deploy from touching Docker and requires `runsc` to be pre-installed |
| `WEBNESTDEV_PUBLIC_DEMO` | optional; `1` opens the site under a dedicated demo account without the sign-in screen, `0` or empty keeps the normal sign-in. Meant for temporary payment-provider review |

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

Application secrets are **not** copied into GitHub, with three deliberate exceptions: the Yandex service account key may be set as the `YANDEX_SA_KEY_JSON` repository secret, the web-search keys (`YANDEX_SEARCH_API_KEY`, `YANDEX_SEARCH_FOLDER_ID`, `TAVILY_API_KEY`) may be set as repository secrets, and the cold-tier bucket pair (`PLATFORM_S3_ACCESS_KEY_ID`, `PLATFORM_S3_SECRET_ACCESS_KEY`, plus the endpoint/bucket/region variables) may be set the same way — the deploy writes them into `.env` on the VM, where Compose passes them to the server. The service account key is a multi-line file rather than a one-line value, and hand-placing it on the VM was exactly why SMS login kept failing (`YANDEX_SA_KEY_FILE=/app/yandex-sa-key.json` is a path inside the image). The deploy installs it and points the variable at the installed file; without the secret the step says so and changes nothing. Everything else — `WEBNESTDEV_ENCRYPTION_KEY`, OAuth client secrets, the other SMS keys and AI-provider keys — belongs to the server and stays only in the `.env` inside `DEPLOY_APP_DIR` on the VM: Compose reads them there, and the deploy workflow never sees them — it builds the image, runs the tests (they set the key they need themselves, no real secret required) and restarts the service. A second copy in Actions would add another place to leak and to rotate without giving the pipeline anything. The one GitHub-side credential the VM may need is a one-time `docker login ghcr.io` with a token that can `read:packages` — entered on the VM and kept there. Alternatively make the GHCR package public in the package settings, and no login is needed.

The `production` environment is created on the first run; add *Required reviewers* there to make every deploy wait for an approval.

What the VM needs before the first deploy: Docker with the Compose plugin, `DEPLOY_APP_DIR` containing `docker-compose.yml` and a filled `.env` (see [make-env-vm.sh](../deploy/scripts/make-env-vm.sh)), and `git` plus Node.js when using mode `source`. A private GHCR image needs a one-time `docker login ghcr.io` on the VM — the script prints the command and exits with code 3 when the pull fails. The deploy is considered successful only after `/api/ready` returns 200; otherwise the script prints `/api/health` (it answers even when readiness fails) and exits with code 1.

## HTTPS and public preview addresses

TLS terminates at a reverse proxy in front of Fastify; Fastify itself stays on the private HTTP port 8787, and a second listener (8788) serves public preview addresses. WebSocket traffic must be proxied for `/ws` — agent runs need it.

The repository ships that proxy as a `caddy` service in [`docker-compose.yml`](../docker-compose.yml) with [`deploy/Caddyfile`](../deploy/Caddyfile). [`deploy/scripts/vm-deploy.sh`](../deploy/scripts/vm-deploy.sh) installs the Caddyfile next to the compose file — validated with `caddy validate` **before** it replaces the running one, because a broken config takes down the front door rather than the service behind it — and starts the service together with the server (`SYNC_COMPOSE=0` turns the sync off). Domains and the Let's Encrypt contact come from `.env`:

| Variable | Meaning |
| --- | --- |
| `WEBNESTDEV_SITE_DOMAIN` | panel/API domain, e.g. `nestdev.ru` (compose default `localhost`) |
| `PREVIEW_PUBLIC_DOMAIN` | preview domain, e.g. `preview.nestdev.ru`; empty disables public preview addresses **and, in production, closes the path-based preview in the panel** — project code must not run on the panel origin |
| `WEBNESTDEV_TRUSTED_PROXIES` | address or CIDR of the reverse proxy allowed to set `X-Forwarded-For`; compose trusts its own subnet (`172.30.0.0/24` by default), because Caddy has no pinned address — preview containers live on a separate network, so project code cannot spoof the header. Defaults to loopback only, so a non-compose deployment behind another proxy must set it |
| `ACME_EMAIL` | address Let's Encrypt writes to when a certificate cannot be issued |
| `PREVIEW_HOST_PORT` | port of the preview door inside the container (default `8788`) |
| `PREVIEW_TICKET_TTL_MS` | how long a preview link stays valid (default 12 h) |

[`make-env-vm.sh`](../deploy/scripts/make-env-vm.sh) derives them from the same `PUBLIC_ORIGIN` it already takes (`PUBLIC_ORIGIN=https://nestdev.ru` writes `WEBNESTDEV_SITE_DOMAIN=nestdev.ru`, `PREVIEW_PUBLIC_DOMAIN=preview.nestdev.ru` and `ACME_EMAIL=nestdev@mail.ru`) and carries them across a re-run. A panel reached by IP gets no preview domain: an address that exists only by accident is worse than no address.

DNS: `A @` and `A www` point at the VM, plus a **wildcard** `A *.preview` to the same address. The wildcard is what makes every project's address resolve without a per-project DNS write, and it is also why the site block in `deploy/Caddyfile` is a wildcard address — Caddy matches exactly one label under that suffix, which is the same rule the server applies when it turns a hostname back into a project.

### Previews on `<project>.preview.<domain>`

Why it exists: the panel's proxy serves the app under `/api/projects/<id>/preview/open/…`, so the app does not live at the root and its root-absolute URLs (`/assets/…`, `/@vite/client`) have to be rewritten on the way out. On its own hostname the app *is* at the root, so absolute paths, service workers and live reload behave the way they do when the app runs normally, and the address can be opened in another tab.

How it is put together:

- **The address is derived, not stored.** The host label is the project id, so `<projectId>.<PREVIEW_PUBLIC_DOMAIN>` (36 characters, a valid DNS label) is stable across renames and unique without a new table; a deleted project's address answers 404. `PREVIEW_PUBLIC_DOMAIN` unset turns the feature off; in production the panel's path-based preview then answers 503 with the variable to set, because serving project code from the panel's own origin would give it the session and the panel API.
- **The door is a separate listener in the server process** (`PREVIEW_HOST_PORT`, [`server/src/preview/preview-host-server.ts`](../server/src/preview/preview-host-server.ts)). It cannot be a route in the main Fastify app: on its hostname the user's app owns the whole path, `/api/…` included, and its live reload arrives on a WebSocket from an arbitrary path — a wildcard WebSocket route there would take the `/*` that serving the panel needs. Requests go through the same proxy core as the panel path ([`preview/preview-proxy.ts`](../server/src/preview/preview-proxy.ts): direct address first, `docker exec` second, `no-store`, the app's framing headers dropped) and the upgrade is relayed byte for byte, so the app negotiates WebSocket itself.
- **Access is a ticket, not the session cookie.** The panel's session cookie is issued for the panel domain and is *not* sent to a subdomain, and widening it to the whole domain would be worse: the proxy passes request headers to the app, so the platform cookie would end up in the user's own code. Instead `POST /api/projects/:id/preview/ticket` mints a short-lived ticket bound to one project (encrypted with `WEBNESTDEV_ENCRYPTION_KEY`), and the panel opens `https://<project>.<preview-domain>/#ticket=…`. The ticket is in the **fragment**, not the query: the browser never sends a fragment to a server, so the ticket is absent from access logs, proxy logs, browser history and the app's own `Referer`. Without a cookie the door answers a link navigation with a platform page (its own CSP nonce, `no-store`), which reads the ticket from `location.hash`, POSTs it to `/__nest/preview/session` on the same origin and gets an `HttpOnly`, `SameSite=Lax` cookie there; the exchange accepts only same-origin JSON, and the page then replaces the address with the clean URL, so the app's own assets, `fetch` and WebSocket carry on without it. A resource request without the cookie still gets 401, and the door no longer accepts a ticket in the query string or in a WebSocket URL at all — old `?ticket=…` links stop working. Platform cookies (`webnestdev_session`, `webnestdev_preview`) are stripped from everything forwarded to the app.
- **The certificate is issued on demand, per project hostname.** A wildcard certificate would need DNS-01 against the registrar's API; per-hostname issuance needs only the `ask` endpoint. `on_demand_tls { ask http://webnestdev-server:8787/api/preview/tls-ask }` makes Caddy ask before every issuance, and the endpoint ([`server/src/routes/preview.ts`](../server/src/routes/preview.ts)) answers 200 only for the host of an existing project and 404 for everything else — without that check a wildcard DNS record would let anyone request a certificate for an invented name and burn the Let's Encrypt limit for the domain (50 certificates per registered domain per week). On-demand also means Caddy does **not** try to obtain the wildcard `*.preview.<domain>` certificate in the background, and the first handshake for `p1.preview.<domain>` is what asks for `p1.preview.<domain>` — the concrete name, solvable with HTTP-01/TLS-ALPN, which is why this works without DNS-01 ([automatic HTTPS](https://caddyserver.com/docs/automatic-https#on-demand-tls), [tls directive](https://caddyserver.com/docs/caddyfile/directives/tls)). Caddy's rate-limiting subdirectives (`interval`, `burst`) are deliberately not used: Caddy ≥2.9 rejects them, and the gate is the endpoint plus the certificate cache. Keep the image tag in `docker-compose.yml` and the Caddyfile in step — the deploy validates the file before installing it, and Caddy ≥2.9 would reject a file that still names those subdirectives.
- **Certificates live in the `caddy-data` volume.** Without it every deploy would start from an empty certificate store and ask for a certificate per hostname all over again; the weekly limit is met by not asking twice, not by asking less often. Keep the volume: the Caddyfile is the file that is replaced on deploy, the volume is not.
- A stopped preview answers 503 with the reason instead of an empty page, a running one whose container address the server cannot reach says so on the WebSocket (no live reload, the page still works), and a request without a ticket gets the ticket page (a navigation) or 401 (a resource). When `PREVIEW_PUBLIC_DOMAIN` is unset the path-based preview keeps working only in development; in production it is closed (503) so that project code never runs on the panel origin.

Check it without a shell on the VM:

```bash
# адрес проекта знает панель; health отдаёт и сам домен: activity.previews.publicDomain
curl -s localhost:8787/api/health | grep -o '"publicDomain":"[^"]*"'
# 404 — имя не обслуживается, 200 — можно выдавать сертификат
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:8787/api/preview/tls-ask?domain=<project-id>.preview.nestdev.ru'
# без билета адрес закрыт: 401, а не приложение
curl -s -o /dev/null -w '%{http_code}\n' 'https://<project-id>.preview.nestdev.ru/'
```

The two numbers to watch when a preview address misbehaves: `/api/health` → `activity.previews.publicDomain` (is the domain configured at all) and `activity.previews.addresses` → `settled` (can the server reach the app it is being asked to serve).

## Health endpoints

- `GET /api/health` — liveness plus dependency state, **when requested from loopback inside the server**. `sandbox` carries the selected runtime (`runtime`), the two sandbox directories (`sandboxDir`, `sandboxHostDir`) and the last mount check (`mount`), and `activity.disk.path` is the directory the projects actually live in — three fields that answer "why does the sandbox terminal look empty" without a shell on the VM. `activity.process.uid`/`gid` show the user the server process actually runs as (stage 2.2), rather than what the compose file asked for. `build` is the commit SHA the running image was built from (what the deploy verifies), and `sms` names the active SMS provider with whether it sends for real and how it authenticates (`credentialKind`: a self-renewing `key` or a `token` that expires). `activity.previews.addresses` lists every live preview (`mode`, `port`, `settled`, `ageSeconds`): `settled: false` on a running preview is the precise answer to "the preview says it is running and the panel is empty" — the server cannot reach the address the panel would use, and `preview-selfcheck` says why on this host. Публичный ответ через Caddy содержит только `ok`, `service`, `build` и `sms`; полный — командой `docker compose exec -T webnestdev-server curl -s http://127.0.0.1:8787/api/health`.
- `GET /api/ready` — readiness; returns HTTP 503 when required dependencies are unavailable, and also when the mount check reported `mismatch` — the one sandbox failure that does not heal on its own. Снаружи ответ содержит только `ok`, `service`, `build`; подробности — тем же loopback-запросом из контейнера.
- Порт `8787` опубликован только на `127.0.0.1` хоста: наружу обязан смотреть Caddy (80/443). Проверка `curl localhost:8787` на ВМ остаётся рабочей, а обход HTTPS и Origin-проверки с внешнего адреса — нет.
