# Локальные workspace вместо Gluster для `sandboxes`

Журнал фактической реализации схемы «локальный workspace на каждой ноде + снапшоты».
Gluster остаётся для `sites`, `data`, сертификатов, custom domains, `project-archives`, бэкапов и
служебного состояния.

> **Правило:** пока все этапы не выполнены и не проверены, production не переводится на локальные
> диски, Gluster-том `sandboxes` не отключается. Поведение по умолчанию — текущий shared-режим.

## Статусы этапов

| Этап | Статус | Дата/время UTC | Что фактически сделано |
|---|---|---|---|
| 0. Контракт и флаги | готово | 17.11.2026, 07:49 UTC | Создан журнал; добавлены флаги, health-диагностика и стартовая строка без смены поведения |
| 1. Метаданные нод и проектов | готово | 17.11.2026, 07:49 UTC | Добавлены колонки, диск и режим в heartbeat; disk-gate включается только при `local` |
| 2. Owner-маршрутизация HTTP/WS | код готов, проверка на двух нодах ожидает | 17.11.2026, 07:58 UTC | HTTP и WS прокси добавлены, по умолчанию выключены; реальные две ноды ещё не проверялись |
| 3. Локальный workspace на `node-1` | код готов, две ноды не проверены | 17.11.2026, 08:10 UTC | Локальный корень, запрет чужого проекта, запрет pin-only delete/reassign; тест на JSON-хранилище |
| 4. Горячие snapshot/restore | код готов | 17.11.2026, 08:10 UTC | Неразрушающий snapshot, restore через staging, checksum, периодический планировщик |
| 5. Фон, квоты, уборка, админка | код готов | 17.11.2026, 08:10 UTC | Фон фильтрует проекты по владельцу; квота берёт размер snapshot; миграция в админке |
| 6. Preview/агент/публикация | код готов | 17.11.2026, 08:10 UTC | Preview, terminal, git и публикация идут через `getSandbox`; failover больше не делает pin-only |
| 7. Миграция/failover/fencing | код готов, destructive-проверка не выполнена | 17.11.2026, 08:10 UTC | Snapshot → внутренний restore → смена pin/epoch; failover восстанавливает snapshot; блокировки |
| 8. `node-2` local + отключение Gluster для sandboxes | ожидает | — | **Не выполнять до завершения этапов 0–7** |

## Целевые инварианты

1. `project.node` — единственный владелец workspace.
2. Любой проектный HTTP/WS-запрос выполняется на ноде-владельце.
3. Локальный корень каждой ноды не является Gluster-монтированием.
4. `sites`, `data`, сертификаты, custom domains, `project-archives` остаются общими.
5. Горячий snapshot не удаляет workspace.
6. Смена `project.node` — только после restore и проверки файлов на целевой ноде.
7. Старая нода после возвращения не может писать в уже перенесённый проект.
8. Пока локальный режим выключен, поведение полностью прежнее — Gluster/shared.
9. При падении ноды проект не «переезжает» на пустой диск: restore snapshot или явная ошибка.

## План по этапам

### Этап 0. Контракт и флаги — S — **готово 17.11.2026, 07:49 UTC**

- `WEBNESTDEV_WORKSPACE_MODE=shared|local`, по умолчанию `shared`.
- `WEBNESTDEV_LOCAL_WORKSPACE_DIR`, по умолчанию `/var/lib/webnestdev/workspaces`.
- `WEBNESTDEV_OWNER_ROUTING=0|1`, по умолчанию `0`.
- `WEBNESTDEV_INTERNAL_API_PORT` и внутренний токен — только для последующей owner-маршрутизации.
- Режим виден в `/api/health` и стартовом логе.
- Критерий: при значениях по умолчанию все существующие тесты и поведение не меняются.

### Этап 1. Метаданные нод и проектов — S/M — **готово 17.11.2026, 07:49 UTC**

- В `nodes`: `api_address`, `workspace_mode`, `disk_total_bytes`, `disk_free_bytes`.
- В `projects`: `workspace_mode`, `workspace_epoch`, `snapshot_key`, `snapshot_at`, `workspace_bytes`.
- Heartbeat отдаёт диск и режим; placement учитывает свободный диск.
- Критерий: обе ноды видны с дисковой ёмкостью; shared-ranking не меняется.

### Этап 2. Owner-маршрутизация HTTP/WS — L/XL — **код готов, проверка на двух нодах ожидает**

- Приватный внутренний listener на каждой ноде, токен, запрет петель.
- Резолвер `project.node → api_address`.
- Прокси проектных HTTP-маршрутов и WebSocket `/ws` с `projectId` в query.
- Офлайн-владелец — 503 без локального fallback.
- Критерий: файлы, git, terminal, preview и publish работают при попадании запроса на любую ноду.

### Этап 3. Локальный workspace на одной ноде — M — **код готов 17.11.2026, 08:10 UTC**

- Локальный корень на `node-1`, тот же путь в API и Docker-брокере.
- `getSandbox()` в локальном режиме разрешает только владельца.
- `reassignProjectNode()` без переноса файлов запрещён.
- `deleteProject()` выполняется на владельце.
- Сделано: `config.ts` выбирает локальный корень, `getSandbox()` бросает
  `WorkspaceOwnerMismatchError` для чужого проекта, delete/reassign —
  `WorkspaceMigrationRequiredError`. `workspace-local.test.ts` проверяет это на JSON-хранилище.
- Для local `SANDBOX_DIR`, `WEBNESTDEV_LOCAL_WORKSPACE_DIR` и
  `WEBNESTDEV_LOCAL_WORKSPACE_HOST_DIR` должны указывать на один и тот же локальный каталог
  ноды; иначе Docker-брокер и контейнеры увидят другой путь.
- Критерий: проект на `node-1` полностью работает локально, проект на `node-2` — по-прежнему
  через Gluster; запросы маршрутизируются корректно.
- **Не проверено:** реальные два узла и Docker-брокер на локальном диске.

### Этап 4. Горячие snapshot/restore — M/L — **код готов 17.11.2026, 08:10 UTC**

- Отдельный неразрушающий snapshot с manifest, checksum и retention.
- Restore на целевую ноду через staging и атомарную замену.
- Cold archive и snapshot не смешиваются.
- Сделано: `workspace-snapshot.ts` пишет `tar.gz` в `project-archives`, manifest и checksum,
  не удаляет рабочий каталог; restore распаковывает в staging, сохраняет backup и подменяет
  каталог. `snapshot-scheduler.ts` снимает snapshot только своих незанятых проектов.
- Критерий: snapshot не удаляет рабочую копию; restore на чистую ноду идемпотентен.

### Этап 5. Фон, квоты, уборка, админка — M — **код готов 17.11.2026, 08:10 UTC**

- `archive-scheduler` обрабатывает только проекты своей ноды.
- `storage-quota` считает локальные размеры на владельце, для чужих — из метаданных.
- `orphan-sweeper` не трогает каталоги другой ноды.
- Удаление проекта чистит workspace, snapshot и archive.
- Сделано: `listProjectOwnersOnThisNode()` фильтрует local-проекты других нод; archive и
  orphan-sweeper используют его; quota при отсутствующем локальном каталоге берёт
  `workspaceBytes` из метаданных snapshot.
- Критерий: фоновая задача на одной ноде не может удалить/архивировать проект другой.

### Этап 6. Preview, агент, публикация — M — **код готов 17.11.2026, 08:10 UTC**

- Preview, static listener, terminal, git и агент — только на владельце.
- `preview-failover` не делает pin-only.
- Публикация собирает проект на владельце, релизы пишет в общий `sites`.
- Сделано: `preview-runner` отказывает на чужой ноде в local; `preview-failover` восстанавливает
  snapshot на выжившую ноду и только потом меняет pin; публикация идёт через `getSandbox`.
- Критерий: preview и publish работают через любую ноду; при падении ноды нет пустого проекта.

### Этап 7. Миграция, failover, fencing — L/XL — **код готов, destructive-проверка ожидает**

- Блокировка проекта в БД, snapshot, restore, проверка, смена pin, bump epoch.
- `getSandbox()` при выдаче сверяет `node` и `workspace_epoch`; если проект перенесли во время
  подготовки workspace, запрос получает ошибку и не пишет в чужой каталог. Долгие уже начатые
  операции отдельно не прерываются — миграция ждёт preview/задания/агента.
- Падение ноды: restore последнего snapshot на выжившую ноду или явный 503.
- Сделано: `workspace-migration.ts` — snapshot на владельце, внутренний restore на цели,
  затем `moveProjectWorkspace()` с expected epoch; миграция ждёт окончания preview/заданий/агента.
  `POST /api/admin/projects/:id/migrate` требует `confirm: true`; `POST /api/internal/workspace/restore`
  защищён общим токеном. Failover восстанавливает последний snapshot; без snapshot проект
  остаётся с явной ошибкой, а не на пустом диске.
- Критерий: перенос без двух писателей и без потери файлов; destructive-тест только с разрешения.
- **Не проверено:** реальный перенос между двумя ВМ, поведение epoch при старых запросах,
  таймауты больших snapshot.

### Этап 8. `node-2` local и отключение Gluster для sandboxes — M

- Перевод `node-2`, пилотная группа, проверка, удаление рабочего монтирования `sandboxes`.
- На каждой ноде `SANDBOX_DIR` и локальный корень — один каталог на локальном диске, не Gluster.
- Gluster остаётся для `sites`, `data`, архивов и служебных данных.
- Критерий: оба узла работают локально; ни один проектный маршрут не зависит от общего
  `sandboxes`; откат через `WEBNESTDEV_WORKSPACE_MODE=shared`.

## Журнал изменений

### 17.11.2026, 07:43 UTC — создан журнал

- Зафиксирован план и правило: до завершения всех этапов Gluster-переход не выполняется.
- Начата реализация этапа 0: флаги и диагностика без смены поведения.

### 17.11.2026, 07:49 UTC — этапы 0 и 1

- `server/src/sandbox/workspace-mode.ts`: `shared|local`, `owner-routing`, локальный каталог,
  внутренний порт и проверка наличия токена. По умолчанию — `shared`, routing выключен.
- `/api/health` и стартовый лог показывают режим workspace. Токен наружу не выводится.
- `nodes`: добавлены `api_address`, `workspace_mode`, `disk_total_mb`, `disk_free_mb`.
- `projects`: добавлены `workspace_mode`, `workspace_epoch`, `snapshot_key`, `snapshot_at`,
  `workspace_bytes`. Пока это только схема, поведение проекта не меняется.
- Heartbeat локального и удалённого узла отдаёт диск и режим; runner — тоже.
- `placement` проверяет свободный диск только если вызывающий явно передал `requiredDiskMb`.
  В `local`-режиме создание проекта передаёт резерв `WEBNESTDEV_WORKSPACE_DISK_MB` (1024 МБ).
- Gluster-монтирования, `SANDBOX_DIR` и production `.env` не менялись.

### 17.11.2026, 07:58 UTC — этап 2, код

- Добавлен `server/src/nodes/owner-router.ts`: хук `onRequest` для `/api/projects/:id/...`,
  потоковая пересылка на `apiAddress` владельца, проверка внутреннего токена, 503 при
  недоступном владельце, без локального fallback.
- Добавлен `server/src/nodes/owner-door.ts`: приватный внутренний listener на каждой ноде,
  проверка токена через `timingSafeEqual`, только проектные пути и `/ws` с `projectId`.
- WebSocket: `registerOwnerWebSocket()` оборачивает штатный upgrade-listener после регистрации
  `/ws`; клиент панели теперь передаёт `projectId` в query. Старый клиент без query работает
  локально, как раньше.
- В `agent-ws.ts` добавлена проверка: `projectId` из query обязан совпадать с `projectId` в
  `agent.run`, иначе сокет мог бы обслуживать чужой проект.
- Всё выключено по умолчанию: `WEBNESTDEV_OWNER_ROUTING` не задан, внутренняя дверь не слушает.
- Compose и Gluster не менялись.
- **Не проверено:** реальный обмен между `node-1` и `node-2`, публичный путь через Caddy/NLB,
  внутренний порт в Docker-сети, долгие upload/download через прокси. До этой проверки
  `WEBNESTDEV_OWNER_ROUTING=1` в production не включать.

### 17.11.2026, 08:10 UTC — этапы 3–7, код

- `server/src/sandbox/config.ts` и `sandbox-service.ts`: локальный корень и owner-guard;
  чужой проект в `local` не открывается даже при старом `WEBNESTDEV_SHARED_SANDBOX=1`.
- `project-store.ts`: `assertNodeWorkspace`, запрет delete/reassign на чужой ноде,
  `listProjectOwnersOnThisNode()`.
- `storage/workspace-snapshot.ts`: неразрушающий snapshot и restore через staging/backup;
  `storage/workspace-migration.ts`: перенос и восстановление потерянного проекта;
  `storage/snapshot-scheduler.ts`: периодические snapshot своих незанятых проектов.
- `routes/workspace-migration.ts`, `routes/internal-workspace.ts`: админская миграция и
  внутренний restore с общим токеном; зарегистрированы в `index.ts`.
- `preview-runner.ts` и `preview-failover.ts`: local-проверки; failover восстанавливает snapshot
  вместо pin-only.
- `deploy/node1` и `deploy/node2`: проброшен приватный `10.0.0.x:8791:8791` и
  `WEBNESTDEV_API_ADDRESS`; по умолчанию routing и local всё ещё выключены.
- **Не проверено:** реальные две ВМ, PostgreSQL-миграции на живой базе, Gluster-cutover.

### 17.11.2026, 08:13 UTC — retention и удаление snapshot

- Новый snapshot удаляет предыдущий hot snapshot и его manifest: на проект остаётся один
  оплачиваемый объект, а не растущая пачка после каждого прохода планировщика.
- `deleteProject()` удаляет и hot snapshot; иначе после удаления проекта объект оставался бы
  в бакете навсегда.
- `workspace-snapshot.test.ts` дополнен проверкой замены старого snapshot.
- `getSandbox()` сверяет `node` и `workspace_epoch` перед выдачей конфига: если миграция прошла
  во время подготовки workspace, запрос получает `WorkspaceMigrationRequiredError`.
  Конфиг теперь несёт `workspaceEpoch`, чтобы вызывающий код мог использовать его для проверки.

## Проверки

- `bun tsc -b --noEmit` — успешно.
- `npx tsc -p server/tsconfig.json --noEmit` — успешно.
- `npm test --workspace=server` — 1999 тестов, 1989 прошли, 10 пропущены (Chromium/среда),
  0 падений. Включая новые `workspace-local.test.ts` и `workspace-migration.test.ts`.
- После retention/delete отдельно: 76 storage/project-store тестов и
  `workspace-snapshot.test.ts` — успешно; `npx tsc -p server/tsconfig.json --noEmit` — успешно.
- Не проверялось: реальные PostgreSQL-миграции на живой базе, поведение двух ВМ и локальный диск.
  Эти проверки относятся к тестовой выкатке.

## Следующий шаг

Тестовая выкатка на две ноды: включить `WEBNESTDEV_OWNER_ROUTING=1` и общий внутренний токен
только на время проверки, перевести пилотный проект в `local`, снять snapshot, перенести на
вторую ноду и вернуть обратно. Только после этого обсуждать Gluster-cutover. До проверки не
включать `WEBNESTDEV_WORKSPACE_MODE=local` в production и не трогать монтирование `sandboxes`.
