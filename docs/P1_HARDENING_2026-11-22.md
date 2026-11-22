# P1 hardening: 22.11.2026

**22.11.2026, 14:09 UTC.** Закрыты пять P1-пунктов из аудита плана запуска: потеря аренды,
пустой ответ модели, `eslint`/`prettier` в planner, `/metrics` и eval-каталог в CI. Код лежит
в рабочем дереве; выкатки не было, коммитов нет.

## Что изменено

### 1. Потеря аренды останавливает запуск

**Было.** `run-lease.ts` при неудачном heartbeat писал `console.warn` и продолжал работу.
Процесс, потерявший аренду, мог параллельно с новым владельцем писать в проект.

**Стало.**

- `acquireRunLease` принимает `onLost`; `RunLease` вызывает его один раз, когда heartbeat
  вернул `false`, и снимает свой таймер;
- `runWithRunSlot` прокидывает `onLeaseLost` из `RunSlotOptions`;
- `agent-ws.ts` по этому колбэку отправляет `RUN_LEASE_LOST`, поднимает `leaseAborted` и
  отменяет `runController`; повторная общая ошибка `AbortError` не отправляется;
- если `release` уже снял аренду, а heartbeat завершился после этого, потеря не считается:
  проверка `released` после `await` закрывает эту гонку.

Тесты: `server/src/agent/run-lease.test.ts` — потеря, однократность, гонка с `release`.

### 2. Пустой ответ модели

**Было.** Пустой шаг обрабатывался только при изображениях в запросе (снятие картинок и
повтор). Без изображений пустой ответ считался завершением: агент заканчивал запуск, не
сказав пользователю ничего.

**Стало.** В `step-runner.ts` пустой шаг без изображений повторяется один раз; второй пустой
ответ подряд останавливает запуск с ошибкой «Провайдер модели вернул пустой ответ». Логика
изображений не менялась: там по-прежнему один повтор без картинок.

Тесты: `server/src/agent/step-runner.test.ts` — случайный пустой ответ и два подряд.

### 3. `eslint`/`prettier` больше не planner read-only

**Было.** Оба имени входили в `READ_ONLY_COMMANDS` в `planner-policy.ts`, хотя загружают
конфиг и плагины проекта, то есть исполняют код, а не только читают файлы.

**Стало.** Они удалены из allowlist; planner проверяет проект через `project.verify`, где
запуск инструментов — отдельное явное действие. Флаги `--fix`, `--write` и `--output`
по-прежнему считаются записью.

Тест: `server/src/agent/planner-policy.test.ts` — `eslint`, `prettier --check` и
`eslint --version` в planner отклоняются.

### 4. `/metrics` для Prometheus

**Стало.** В `health.ts` добавлен `GET /metrics`; текст собирает
`server/src/health/metrics.ts`. Ответ отдаётся только loopback-запросу, снаружи маршрут
отвечает `404`, как будто его нет. Формат — Prometheus text exposition:

- `webnestdev_build_info{build,node}`;
- `webnestdev_uptime_seconds`;
- `webnestdev_process_resident_memory_bytes`;
- `webnestdev_process_heap_used_bytes`;
- `webnestdev_agent_runs_active`;
- `webnestdev_agent_run_slots`;
- `webnestdev_agent_runs_queued`;
- `webnestdev_agent_queue_slots`.

Метрики не заменяют `/api/ready`: scrape с ВМ или через `docker compose exec` видит очередь и
память, а NLB по-прежнему проверяет готовность.

Тест: `server/src/routes/health.test.ts` — loopback получает `200 text/plain`, внешний адрес
`404` без имён метрик.

### 5. Eval-каталог в CI

**Стало.** В `.github/workflows/ci.yml` после тестов сервера добавлен шаг
`Validate agent eval catalog` → `npm run agent:eval`. Без `--adapter` harness проверяет
каталог (36 задач) и его инварианты; настоящий прогон с моделью в CI без ключей не
запускается и требует адаптера.

## Проверки

```bash
cd server && npm run agent:eval
# EVAL-CATALOG=ok tasks=36 selected=36

cd server && npx tsx --test src/agent/run-lease.test.ts \
  src/agent/run-limiter.test.ts src/agent/step-runner.test.ts \
  src/agent/planner-policy.test.ts src/routes/health.test.ts
# 48 тестов, 48 pass

cd server && npx tsc -p tsconfig.json --noEmit
# без ошибок
```

Полный серверный набор прогнан по шести группам (408 файлов): **2275 тестов, 2265 pass,
10 skip, 0 fail**. Пропуски — прежние браузерные/средовые проверки, не связанные с этой
правкой. Выкачено 22.11.2026, 14:29–14:36 UTC: обе ноды на `1d177ff`, `/metrics` 200
изнутри контейнера и 404 не-loopback, SIGTERM на `node-2` дал дренаж и возврат
`/api/ready=200`; подробности — в [`PRODUCTION_STATE.md`](PRODUCTION_STATE.md).

## Что осталось из P1

- мягкий лимит шагов вместо жёсткой ошибки;
- автозапуск этапа и детектор прогресса;
- авторезюм прерванного запуска;
- размеры песочницы (1024 МБ / 1 CPU) и `--ignore-scripts`;
- защита ветки `main` и лишние ключи в `authorized_keys` на `node-1`;
- настоящий eval-прогон с адаптером и ключом модели, если он нужен в CI.
