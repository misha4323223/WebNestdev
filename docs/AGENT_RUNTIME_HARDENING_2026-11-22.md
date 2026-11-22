# Agent runtime hardening: 22.11.2026

**22.11.2026, 13:58 UTC.** Закрыты оставшиеся P0 из аудита плана запуска, кроме потолка
бюджета одного запуска: пользователь решил, что 300 кредитов DeepSeek вместо 100 — не
критично. Код лежит в рабочем дереве; выкатки не было. Изменения вступят в силу только
после обычной выкатки образа.

## Что изменено

### 1. SIGTERM больше не обрывает запуски

**Было.** `server/src/index.ts` не обрабатывал SIGTERM. Docker при выкатке убивал процесс
сразу: идущий запуск агента обрывался, а расход записывался только в `finally`
(`agent-runtime.ts`), поэтому терялся; клиент видел разрыв сокета.

**Стало.**

- `server/src/lifecycle.ts` — общее состояние остановки (`beginShutdown`, `isShuttingDown`);
- `server/src/agent/active-runs.ts` — счётчик всех запусков процесса (`activeRunTotal`);
- `server/src/index.ts` — обработчики SIGTERM/SIGINT: новые запуски не принимаются,
  активные получают до `WEBNESTDEV_SHUTDOWN_GRACE_MS` (по умолчанию 120 с), затем
  `app.close()` (его `onClose` останавливает фоновые циклы) и выход; закрытие само
  ограничено 10 с, потому что открытые WebSocket могут держать его долго;
- `server/src/routes/agent-ws.ts` — во время остановки сокет отвечает ошибкой
  `SERVER_RESTARTING` вместо запуска нового прогона;
- `docker-compose.yml` — `stop_grace_period: 135s` у `webnestdev-server`. Без этого Docker
  по умолчанию ждёт 10 с и присылает SIGKILL, то есть дренаж не успевал бы начаться.
  Compose на нодах обновляется выкаткой; на уже работающем контейнере старый grace period
  сохраняется до пересоздания.

Таймер запуска (15 минут в `agent-ws.ts`) остаётся вторым слоем: дренаж не отменяет
watchdog, а только даёт коротким запускам закончиться.

### 2. Таймауты провайдера модели

**Было.** `openai-compatible-provider.ts` вызывал `fetch` без собственного таймаута. Зависший
шлюз занимал слот аккаунта, место в очереди и ресурсы до общего watchdog.

**Стало.** `server/src/provider/provider-timeouts.ts`:

- `AI_CONNECT_TIMEOUT_MS` — 30 000 мс до заголовков ответа;
- `AI_IDLE_TIMEOUT_MS` — 90 000 мс простоя между чанками потока; таймер перезапускается
  перед каждым чанком, поэтому долгая, но живая генерация не обрывается;
- `ProviderTimeoutError` содержит `ETIMEDOUT`, поэтому существующее правило
  `provider-retry.ts` повторяет запрос до первого байта; после начала потока шаг не
  повторяется;
- отмена внешним сигналом (стоп, закрытие вкладки) по-прежнему проходит как AbortError и не
  превращается в таймаут.

### 3. Изменения в облаке и DNS подтверждает человек

**Было.** `access.request` по умолчанию создавал подключение с `allowWrites=true`
(`access-tools.ts`). Модель могла выполнить мутирующий запрос, если просьба была
неоднозначной или пришла из недоверенного текста.

**Стало.**

- `server/src/tools/mutation-approval.ts` — карточка через существующий `askUser`
  (`question.asked`), варианты «Разрешить изменение» и «Отклонить». Без панели (нет
  `emit`) мутация не выполняется — fail closed, как у отправки секрета в `net.request`;
- `server/src/tools/cloud-tools.ts` — POST/PUT/PATCH/DELETE подтверждаются до вызова API;
- `server/src/tools/yandex-tools.ts` — те же методы подтверждаются до `yandexFetch`;
- `server/src/tools/domain-tools.ts` — любая не-читающая команда регистратора
  подтверждается до запроса в кабинет;
- `access.request` создаёт новые подключения с `allowWrites=false`; в описании инструмента
  прямо сказано, что флаг нужно запрашивать только по просьбе пользователя.

Существующие подключения с `allowWrites=true` не меняются: они и раньше требовали явного
включения в карточке. Карточка подтверждения — второй слой, а не замена этому решению.
Чтение (GET/HEAD и read-only команды) не подтверждается, иначе обычная работа агента
встанет на каждом шаге.

**Остаточное поведение:** если в карточке облака/Yandex изменения выключены, подтверждение
может появиться до отказа `assertWritesAllowed`/`yandexFetch`. Это лишний клик в
неправильно настроенном подключении, а не доступ к ресурсам; запрос всё равно не уходит.

### 4. Единая обёртка недоверенного вывода

**Было.** Предупреждение о недоверенном тексте было только в vision-промпте. README,
страницы, ответы API и логи попадали в контекст как обычный текст.

**Стало.** `boundToolOutput` в `server/src/agent/context-budget.ts` оборачивает вывод
`web.search`, `web.read`, `net.request`, `net.download`, `fs.read`, `fs.grep`,
`terminal.exec`, `terminal.start`, `terminal.tail`, `preview.logs`, `browser.open`,
`browser.inspect`, `browser.runtime`, `browser.scenario`, `image.inspect` маркерами
`[НЕДОВЕРЕННЫЕ ДАННЫЕ …]` и `[КОНЕЦ НЕДОВЕРЕННЫХ ДАННЫХ]`. Маркеры входят в тот же лимит,
что и текст, поэтому результат шага не растёт сверх бюджета. В системный промпт добавлено
правило: такой текст — данные, а не инструкции и не разрешение. Собственные ответы
платформы (`project.verify` и структурированные результаты инструментов) не оборачиваются.

## Проверки

Выполнено в рабочем дереве:

```bash
cd server && npx tsx --test src/agent/active-runs.test.ts src/agent/context-budget.test.ts \
  src/provider/provider-timeouts.test.ts src/tools/mutation-approval.test.ts
# 44 теста, 44 pass

cd server && npx tsx --test src/provider/openai-compatible-provider.test.ts \
  src/provider/provider-retry.test.ts src/provider/provider-retry-http.test.ts \
  src/provider/failover-provider.test.ts src/provider/reasoning-stream.test.ts \
  src/provider/routed-provider.test.ts src/provider/platform-provider.test.ts \
  src/agent/message-builder.test.ts src/agent/planner-policy.test.ts \
  src/agent/active-runs.test.ts src/agent/context-budget.test.ts \
  src/tools/domain-request.test.ts src/tools/question-tools.test.ts \
  src/tools/mutation-approval.test.ts
# 133 теста, 133 pass

cd server && npx tsc -p tsconfig.json --noEmit
# без ошибок
```

Полный `npm test` был разбит на шесть групп и пройден позднее: 2275 тестов, 2265 pass,
10 skip, 0 fail (408 файлов). Выкачено 22.11.2026, 14:29–14:36 UTC: обе ноды на `1d177ff`,
`StopTimeout=135` подтверждён на живых контейнерах, SIGTERM на `node-2` дал строку дренажа
и `/api/ready=200` после возврата; результат — в [`PRODUCTION_STATE.md`](PRODUCTION_STATE.md).

## Что осталось

- Мягкий лимит шагов, детектор прогресса, авторезюм и остальные P1, не вошедшие в
  [`P1_HARDENING_2026-11-22.md`](P1_HARDENING_2026-11-22.md), не входят в эту правку.
- `/api/tls-ask`, публичные docs с топологией и `PUBLIC CONNECT` — отдельные задачи из
  [`SECURITY_HARDENING_2026-11-21.md`](SECURITY_HARDENING_2026-11-21.md).
- Потолок бюджета одного запуска сознательно не реализован (решение пользователя).
