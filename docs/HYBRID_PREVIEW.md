# Hybrid preview: реализация и ход работ

Статус: **реализация завершена, ожидается пилот на реальном Docker**

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

Режим не включается автоматически по наличию `dev`/`start`: это защищает обычные node-runtime проекты от случайного превращения в hybrid.

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

## 3. Этапы

### Этап 0. Документ и фиксация контракта

- [x] Создан этот документ.
- [x] Зафиксированы поля `package.json.preview` и правила валидации.
- [x] Зафиксировано, что режим только явный.
- [x] Зафиксировано, что backendPaths обязательны для API/WS.
- [x] Зафиксированы критерии готовности.

### Этап 1. Типы, конфигурация, план сборки

- [x] `PreviewMode` и `PreviewStatus` знают `hybrid`.
- [x] `hybrid-config.ts` читает и валидирует `package.json.preview`.
- [x] `hybrid-plan.ts` планирует сборку и static-каталог, не упираясь в отказ `node-runtime`.
- [x] Невалидный hybrid не запускает контейнер и не делает молчаливый fallback в strict-режиме.
- [x] Тесты конфигурации и плана.

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

- [x] `PREVIEW_MODE=hybrid` и fallback в `auto`.
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
- [ ] Отдельный интеграционный прогон hybrid на тестовом проекте (после кода).
- [x] Отметить фактические результаты в разделе «Ход работ».

## 4. Критерии готовности

1. Hybrid-проект собирается, получает listener и backend-контейнер.
2. `GET /` и assets отдаются из `staticDir`.
3. `GET/POST /api/...` доходят до backend, тело и ответ не теряются.
4. `/ws` проходит через listener.
5. `/api` никогда не отдаёт `index.html` при ошибке backend.
6. Повторный запуск переиспользует живой preview, а не создаёт второй контейнер.
7. Stop, idle и reset закрывают listener и удаляют backend.
8. Hybrid учитывается в per-user и host runtime-лимитах.
9. Ошибка hybrid в `auto` убирает остатки и не ломает fallback в container.
10. Старые static и container preview проходят свои тесты.
11. Typecheck сервера и frontend проходит.

## 5. Ход работ

| Дата/время | Этап | Что сделано | Проверка |
|---|---|---|---|
| 12.11.2026 | 0 | Создан документ, зафиксированы контракт и этапы | — |
| 12.11.2026 | 1 | Типы, `hybrid-config.ts`, `hybrid-plan.ts`; тесты конфига и плана | 5/5 тестов конфига и 3/3 плана |
| 12.11.2026 | 2 | `previews` получила backend-колонки, registry читает hybrid; тесты registry | typecheck + 3/3 registry |
| 12.11.2026 | 3 | `static-build.ts`, общий `startPreviewProcess`, hybrid-label | fake-Docker аргументы: 2/2 runner-теста; старые runner-тесты |
| 12.11.2026 | 4 | `hybrid-listener.ts`: static, HTTP proxy, cookies, 502, WebSocket | 4/4 listener |
| 12.11.2026 | 5 | `hybrid-preview.ts`: start/stop/status/logs/refresh; интеграция в manager, reset, theme; fake lifecycle | 7/7 lifecycle; 3/3 adopt; manager-status без Docker |
| 12.11.2026 | 6 | Hybrid в limiter/reservation/adopt/reset/theme/health/admin/verification/frontend types; root `package.json` объявляет WebNestdev hybrid | полный серверный прогон |
| 12.11.2026 | 7 | Проверки кода и тестов | `npm test --workspace=server`: 1737 тестов, 0 fail, 9 skip; `tsc` сервера и frontend — 0 ошибок; реальный Docker-пилот не выполнялся (Docker в окружении отсутствует) |

## 6. Проверки

Плановые команды:

```bash
npm run test --workspace=server -- src/preview/<module>.test.ts
npx tsc -p server/tsconfig.json --noEmit
npx tsc -b --noEmit
```

Полный production build и выкатка выполняются только по отдельной просьбе.

### Фактический результат на 12.11.2026

- `npm test --workspace=server`: **1737 тестов: 1728 pass, 9 skip, 0 fail** (skip — браузерные проверки без Chromium).
- `npx tsc -p server/tsconfig.json --noEmit`: **0 ошибок**.
- `npx tsc -b --noEmit`: **0 ошибок**.
- Hybrid listener проверен реальными HTTP/WebSocket-запросами к тестовому backend; lifecycle — с fake build/backend, без Docker.
- Реальный запуск WebNestdev в hybrid-контейнере не выполнялся: для него нужны Docker, собранный `server/dist`, env-файлы и доступ к API/PostgreSQL. Это следующий пилот, а не скрытая часть уже проверенного.
- Перед пилотом backend должен получить свои обычные production-переменные (БД, storage, ключи) через смонтированные env-файлы проекта; `backendEnv` в `package.json` не должен содержать секреты.
