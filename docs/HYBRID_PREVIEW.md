# Hybrid preview: реализация и ход работ

Статус: **реализация и реальный Docker-пилот на production-паре завершены**

Начат: 12.11.2026

Цель: отдельный режим `hybrid` — статический frontend + backend в контейнере + общий listener в процессе API.

## 1. Что делает режим

Проект явно объявляет себя hybrid в `package.json`:

```json
{
  "preview": {
    "mode": "hybrid",
    "build": "build",
    "staticDir": "dist",
    "backend": "start:preview-api",
    "backendPaths": ["/api", "/ws"],
    "backendPort": 3000
  }
}
```

- `build` — npm-скрипт сборки frontend/static.
- `staticDir` — каталог сборки внутри проекта.
- `backend` — npm-скрипт запуска backend. Произвольные shell-команды не принимаются.
- `backendPaths` — единственные префиксы, которые уходят в backend. По умолчанию `/api`; WebSocket-путь нужно указать явно.
- `backendPort` — порт backend внутри контейнера, по умолчанию `3000`. Runner также передаёт `PORT`.

Режим не включается по наличию `dev`/`start`: это защищает обычные node-runtime проекты от случайного превращения в hybrid. Но если проект **явно** делится на статический frontend и отдельный backend, сервер сохраняет такой же контракт в локальный `.webnestdev/preview.json` и запускает hybrid без правки пользовательского `package.json`.

### Локальный профиль платформы

`package.json.preview` остаётся высшим приоритетом, если проект сам объявляет контракт. Если его нет, сервер и агент используют один консервативный детектор и пишут локальный профиль:

- в корне есть `package.json` и `scripts.build`;
- есть готовый `dist/`/`build/`/`out/` с `index.html` **или** известный статический framework (Vite, Astro, CRA, SvelteKit и т. п.);
- есть отдельный npm-скрипт backend с явным именем (`start:server`, `start:api`, `start:preview-api`, `serve:api`, `backend:start` и подобные), и его команда действительно запускает процесс; generic `start`/`dev` не считается;
- в исходниках есть хотя бы один реальный backend-префикс (`/api`, `/ws`, `/graphql`, `/trpc`, `/socket.io`);
- проект не использует whole-app framework вроде Next/Nuxt/Remix без явного контракта.

При совпадении сервер пишет только `.webnestdev/preview.json` (атомарно, с evidence) — при импорте GitHub, GitLab, GitVerse и SourceCraft, а также при первом `preview.start`, если профиля не было. Профиль не попадает в git: `.webnestdev/` исключён и в `.git/info/exclude`, и в `.gitignore`; `package.json` пользователя не меняется. Если hybrid не собрался или не поднялся:

- по умолчанию `fallback` равен `auto`: временный сбой (сеть, npm, Docker) возвращает ошибку и **не** подменяет hybrid dev-контейнером; архитектурное несоответствие (hybrid собрался, но backend/static не подходит проекту) может один раз откатиться в обычный container preview;
- `"fallback": "none"` запрещает откат полностью;
- `"fallback": "container"` возвращает старое поведение — откат при любой ошибке hybrid;
- настройка живёт в `.webnestdev/preview.json` (или в `package.json.preview`, если проект сам объявляет контракт); `PREVIEW_MODE=hybrid` остаётся строгим для всего хоста.

Удаление `.webnestdev/preview.json` — способ сбросить автопрофиль и вернуться к static/container.

### Будущая загрузка файлом/архивом

Сейчас отдельной загрузки проекта файлом или архивом нет. Когда она появится, её обработчик должен вызывать `detectAndSaveHybridProfile(sandbox.root)` после распаковки и записи файлов, до первого `preview.start`, с теми же правилами:

- не менять `package.json`;
- писать только `.webnestdev/preview.json` после успешной валидации;
- не блокировать загрузку ошибкой детектора;
- проверить, что профиль не попадает в git.

### Настройка WebNestdev

В корневом `package.json` проекта уже добавлены:

- скрипт `start:preview-api` (`NODE_ENV=production npm run start --workspace=server`);
- `preview.mode=hybrid`, `build=build`, `staticDir=dist`;
- `backend=start:preview-api`, `backendPaths=["/api","/ws"]`, `backendPort=3000`.

`PORT` и `HOST` задаёт платформа; значения из `backendEnv` не могут их переопределить. Секреты backend берёт из смонтированных env-файлов, а не из `package.json`: `backendEnv` предназначен только для несекретных значений.

## 2. Архитектура

```text
клиент
  |
  v
публичная дверь / панель
  |
  v
hybrid listener (127.0.0.1:<random>, процесс API)
  |                         |
  | static dist             | /api, /ws и другие backendPaths
  v                         v
Fastify static          backend-контейнер :backendPort
  |                         |
  v                         +-- HTTP API
index.html / assets         +-- WebSocket
```

- Listener живёт в процессе API, как static preview.
- Backend живёт в контейнере, как container preview.
- Публичный адрес, билеты, `ownerAddress`, WebSocket и cross-replica forwarding переиспользуются.
- Hybrid занимает место в runtime-лимите, а не в static-лимите.
- `docker exec` fallback для hybrid запрещён: он не даёт WebSocket и скрывает сломанный listener.

### Лимиты: 12 hybrid-слотов на ноду

Замер на одной ноде: **12 hybrid-preview** — максимум, а **2 обычных Docker-preview** занимают
почти всю ноду. Поэтому Docker и hybrid считаются не как равные контейнеры, а в общем бюджете
ноды:

```text
hybrid = 1 слот
Docker = PREVIEW_CONTAINER_UNITS слотов
Docker * PREVIEW_CONTAINER_UNITS + hybrid <= PREVIEW_HOST_UNITS
```

Production-значения:

| Переменная | Значение | Смысл |
|---|---:|---|
| `PREVIEW_MAX_CONTAINERS` | `2` | максимум чистых Docker-preview |
| `PREVIEW_MAX_HYBRID` | `8` | максимум hybrid-preview; 8, а не 12 — запас на реальные backend'ы |
| `PREVIEW_HOST_UNITS` | `12` | общий бюджет ноды в hybrid-слотах |
| `PREVIEW_CONTAINER_UNITS` | `6` | один Docker занимает 6 hybrid-слотов |

Отсюда:

| Docker | Hybrid | Слоты |
|---:|---:|---:|
| 0 | 8 | 8 из 12 (4 в запасе) |
| 1 | 6 | 12 из 12 |
| 2 | 0 | 12 из 12 |

То есть два Docker **не оставляют места** для hybrid, а один Docker оставляет ровно 6 hybrid.
Static-preview этот бюджет не занимает: его слушатель стоит ~0.5 МБ.

`PREVIEW_MAX_PER_USER=1` по-прежнему общий для кластера: 8 hybrid на ноде — это восемь разных
аккаунтов, а не восемь проектов одного человека. На двух нодах максимум 8+8=16, но только если
проекты распределены по нодам; планировщик пока не учитывает лимит preview при выборе узла.

### Локальный `node_modules` для hybrid

Hybrid читает контракт из `package.json.preview` проекта (или из `.webnestdev/preview.json`) и
использует тот же локальный кэш зависимостей, что container и static preview:

- `npm install` выполняется в контейнере с `-v <локальный кэш>/<project>:/workspace/node_modules`;
- frontend-сборка и backend-контейнер видят один и тот же локальный `node_modules`;
- Gluster хранит только исходники, `dist` и служебные файлы проекта;
- кэш каждой ноды отдельный: после переезда проекта зависимости один раз установятся заново;
- кэши, к которым не обращались больше 30 дней, удаляются фоновым уборщиком
  (`WEBNESTDEV_PREVIEW_CACHE_TTL_DAYS`).

Это важно именно для hybrid: без общего mount backend собирался бы с одним деревом зависимостей,
а frontend — с другим, и расхождение версий выглядело бы ошибкой приложения.

## 3. Этапы

### Этап 0. Документ и фиксация контракта

- [x] Создан этот документ.
- [x] Зафиксированы поля `package.json.preview` и правила валидации.
- [x] Зафиксировано, что режим только явный.
- [x] Зафиксировано, что backendPaths обязательны для API/WS.
- [x] Зафиксированы критерии готовности.

### Этап 1. Типы, конфигурация, план сборки

- [x] `PreviewMode` и `PreviewStatus` знают `hybrid`.
- [x] `hybrid-config.ts` читает и валидирует `package.json.preview` и локальный `.webnestdev/preview.json`.
- [x] `hybrid-detect.ts` консервативно определяет явный frontend/backend split и пишет профиль без изменения `package.json`.
- [x] `hybrid-plan.ts` планирует сборку и static-каталог, не упираясь в отказ `node-runtime`.
- [x] Невалидный hybrid не запускает контейнер и не делает молчаливый fallback в strict-режиме.
- [x] Тесты конфигурации, профиля, детектора и плана.

### Этап 2. Состояние, БД и реестр

- [x] В `previews` добавлены `backend_host` и `backend_port`.
- [x] Constraint допускает `container`, `static`, `hybrid`.
- [x] `previewFromRow()` читает hybrid и отбрасывает неполные hybrid-строки.
- [x] Hybrid-состояние хранит listener в `host/port`, backend — в `backendHost/backendPort`, контейнер — в `containerId`.
- [x] Тест SQL-миграции таблицы (`preview-table.test.ts`).

### Этап 3. Сборка и runtime backend

- [x] Сборка static-артефакта вынесена в общий модуль без изменения static preview.
- [x] Общий запуск runtime-контейнера умеет принимать явную backend-команду.
- [x] Backend получает `PORT`, секреты, egress, сеть, лимиты и label.
- [x] Backend проходит settlement адреса, но не сохраняет промежуточное состояние как container.
- [x] Для hybrid добавлен отличительный Docker label, чтобы его backend не приняли за обычный dev-контейнер.
- [x] `previewProcessArgs` проверен без Docker: hybrid получает отдельный label, `PORT/HOST` и backend-env, а container сохраняет dev-команду без hybrid-флагов.

### Этап 4. Listener

- [x] `hybrid-listener.ts` отдаёт `dist` и SPA fallback.
- [x] `/api`, `/ws` и настроенные пути уходят в backend.
- [x] HTTP POST с телом доходит до backend.
- [x] WebSocket upgrade проксируется.
- [x] Cookie и заголовки обрабатываются по правилам preview.
- [x] При падении backend `/api` возвращает ошибку, а не `index.html`.
- [x] Listener закрывается и освобождает порт.
- [x] Тесты listener.

### Этап 5. Lifecycle

- [x] `hybrid-preview.ts`: start/stop/status/logs/refresh; чужой backend не принимается через `preview-adopt`.
- [x] Запуск: reserve → build → backend → listener → state → flush → release.
- [x] Любая ошибка убирает контейнер, listener, секреты, state и бронь.
- [x] `previewStatus()` проверяет backend и listener, не оставляя «мёртвый» state.
- [x] `stopPreview()` закрывает listener и удаляет backend.
- [x] `previewLogs()` объединяет сборку и backend-логи.
- [x] Idle sweep использует общий stop.
- [x] Тесты lifecycle без Docker (fake build/backend).

### Этап 6. Интеграция

- [x] `PREVIEW_MODE=hybrid`; `auto` откатывается только при архитектурном несоответствии, временные сбои ошибку не маскируют.
- [x] Hybrid считается runtime-предпросмотром в limiter и reservation.
- [x] `preview-adopt` не принимает hybrid-backend за container.
- [x] `preview-reset` закрывает listeners.
- [x] `routes/theme` пересобирает/перезапускает hybrid.
- [x] `routes/health` и `admin-infra` знают hybrid.
- [x] `verification-tools` проверяет hybrid корректно.
- [x] `src/lib/types.ts` знает hybrid.
- [x] Старт с другой реплики переиспользует живого owner, а probe мёртвого owner не блокирует запуск на выжившей ВМ.
- [x] Старые static/container тесты не меняют поведение.

### Этап 7. Проверки и пилот

- [x] Точечные тесты новых модулей.
- [x] Точечные тесты затронутых старых модулей.
- [x] `tsc -p server/tsconfig.json --noEmit`.
- [x] `tsc -b --noEmit`.
- [x] Проверка статуса/логов/лимитов без реального Docker.
- [x] Отдельный интеграционный прогон hybrid на тестовом проекте (после кода).
- [x] Отметить фактические результаты в разделе «Ход работ».

## 4. Критерии готовности

1. Hybrid-проект собирается, получает listener и backend-контейнер.
2. `GET /` и assets отдаются из `staticDir`.
3. `GET/POST /api/...` доходят до backend, тело и ответ не теряются.
4. `/ws` проходит через listener.
5. `/api` никогда не отдаёт `index.html` при ошибке backend.
6. Повторный запуск переиспользует живой preview, а не создаёт второй контейнер.
7. Stop, idle и reset закрывают listener и удаляют backend.
8. Hybrid учитывается в per-user и host runtime-лимитах; его build и backend используют локальный
   `node_modules`, а не Gluster.
9. Ошибка hybrid в `auto`: временный сбой убирает остатки и возвращает ошибку; архитектурное несоответствие может откатиться в container; `fallback="none"` запрещает откат, `fallback="container"` разрешает его всегда.
10. Старые static и container preview проходят свои тесты.
11. Typecheck сервера и frontend проходит.

## 5. Ход работ

| Дата/время | Этап | Что сделано | Проверка |
|---|---|---|---|
| 12.11.2026 | 0 | Создан документ, зафиксированы контракт и этапы | — |
| 12.11.2026 | 1 | Типы, `hybrid-config.ts`, `hybrid-plan.ts`; тесты конфига и плана | 8/8 тестов конфига и 3/3 плана |
| 12.11.2026 | 2 | `previews` получила backend-колонки, registry читает hybrid; тесты registry | typecheck + 3/3 registry |
| 12.11.2026 | 3 | `static-build.ts`, общий `startPreviewProcess`, hybrid-label | fake-Docker аргументы: 2/2 runner-теста; старые runner-тесты |
| 12.11.2026 | 4 | `hybrid-listener.ts`: static, HTTP proxy, cookies, 502, WebSocket | 4/4 listener |
| 12.11.2026 | 5 | `hybrid-preview.ts`: start/stop/status/logs/refresh; интеграция в manager, reset, theme; fake lifecycle | 7/7 lifecycle; 3/3 adopt; manager-status без Docker |
| 12.11.2026 | 6 | Hybrid в limiter/reservation/adopt/reset/theme/health/admin/verification/frontend types; root `package.json` объявляет WebNestdev hybrid | полный серверный прогон |
| 12.11.2026 | 7 | Проверки кода и тестов | `npm test --workspace=server`: 1746 тестов, 1737 pass, 9 skip, 0 fail; `tsc` сервера и frontend — 0 ошибок |
| 12.11.2026 | 8 | Локальный `.webnestdev/preview.json` и консервативный детектор для server/agent; профиль также сохраняется при импорте GitHub, GitLab, GitVerse и SourceCraft | полный серверный прогон 1746 тестов, typecheck сервера и frontend |
| 12.11.2026 | 7 | Реальный hybrid-пилот на production-паре `node-1`/`node-2` | проект размещён на `node-2`, listener — в API на `node-1`; статика, `/api`, POST и WebSocket — 200; stop/cleanup — 200; замеры ниже |
| 13.11.2026 | 9 | Отдельные лимиты Docker/hybrid и общий бюджет ноды в hybrid-слотах | замер 12 hybrid; production 2 Docker / 8 hybrid / 12 слотов / вес Docker 6; точечные тесты и typecheck |

## 6. Проверки

Плановые команды:

```bash
npm run test --workspace=server -- src/preview/<module>.test.ts
npx tsc -p server/tsconfig.json --noEmit
npx tsc -b --noEmit
```

Полный production build и выкатка выполняются только по отдельной просьбе.

### Фактический результат на 12.11.2026

- `npm test --workspace=server`: **1746 тестов: 1737 pass, 9 skip, 0 fail** (skip — браузерные проверки без Chromium).
- `npx tsc -p server/tsconfig.json --noEmit`: **0 ошибок**.
- `npx tsc -b --noEmit`: **0 ошибок**.
- Hybrid listener проверен реальными HTTP/WebSocket-запросами к тестовому backend; lifecycle — с fake build/backend, без Docker.
- Перед пилотом backend должен получить свои обычные production-переменные (БД, storage, ключи) через смонтированные env-файлы проекта; `backendEnv` в `package.json` не должен содержать секреты.

### Реальный пилот 12.11.2026

Проверено на production-паре, а не на локальном стенде:

- сборка `cf0a57accbdf04d05e2e4e0ad520a34bece064bd` на обеих нодах;
- временный проект `HYBRID-E2E-20261112T171819Z` создан на `node-2`, запуск preview шёл через API `node-1`;
- `mode=hybrid`, listener — `127.0.0.1:42477` в процессе API `node-1`, backend — контейнер на `node-2` (`backendHost=10.0.0.5`), `ownerAddress=10.0.0.4:8788`;
- публичный адрес `https://<project>.preview.nestdev.ru`: тикет обменивается на cookie (`204`), `GET /` и `/app.js` отдают статику, `GET /api/health` и `POST /api/echo` доходят до backend с телом, `/ws` отвечает `echo:hello-ws`, `/api/fail` отдаёт JSON `500`, а не `index.html`;
- повторный старт при живом preview вернул тот же containerId и listener за **24 мс**;
- stop закрыл listener и удалил backend за **451 мс**; статус стал `running:false`, контейнер и sandbox удалены;
- проект и временный аккаунт после теста удалены, `/api/health` снова показывает `previews.runtime=0`.

Замеры (реальные, через публичный preview):

| Что | Результат |
| --- | --- |
| первый старт, включая сборку и запуск контейнера | **64,7 с** |
| повторный старт живого preview | **24 мс** |
| старт после stop | **63,0 с** |
| stop | **451 мс** |
| сборка (`HYBRID-BUILD-OK`) | **20 мс** |
| `GET /` | **33,2 мс**, 256 Б, marker найден |
| `GET /app.js` | **11,1 мс**, marker найден |
| `GET /api/health` | **17,5 мс** |
| `POST /api/echo` | **19,5 мс**, тело сохранено |
| WebSocket echo | **31,8 мс** |
| backend-контейнер | **69,21 MiB / 1 GiB**, 49 PIDs, label `webnestdev.preview.kind=hybrid` |
| API-контейнер во время preview | **220,6 MiB / 3,795 GiB** |

Вывод: гибридный режим работает на живой паре и корректно переживает stop/повторный запуск. Основная задержка холодного старта — не сборка (20 мс), а запуск sandbox/build-контейнера через Docker/gVisor; это отдельный кандидат на оптимизацию, а не ошибка hybrid-listener. Реальный failover `node-1` → `node-2` выполнен отдельно 12.11.2026 (RTO 119 с, данные и preview восстановлены); hybrid-пилот во время самого отказа не перезапускался. Результат и ограничения — в [`PRODUCTION_STATE.md`](PRODUCTION_STATE.md), раздел 18.

## 7. Панель и простой runtime

В панели встраивается только `static`. Docker и hybrid показывают ссылку «Открыть в новом окне»; `iframe`, device-панель и выбор элемента для них не рендерятся. Панель не отправляет heartbeat для runtime, а чтение статуса и логов панелью идёт с `touch:false` и не продлевает контейнер. Продлевает только запрос, реально прошедший через preview.

В production `PREVIEW_IDLE_MS=120000`, `PREVIEW_SWEEP_MS=30000`: после возврата из вкладки preview останавливается примерно через 2–2,5 минуты. Static сохраняет `PREVIEW_STATIC_IDLE_MS=300000` и heartbeat, пока панель видима. Остановленный preview отдаёт по старой ссылке страницу «не запущен», а панель после возврата фокуса снова показывает запуск.
