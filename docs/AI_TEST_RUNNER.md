# Тестовый контур агента (этап 2)

Статус: **каркас, выключен по умолчанию**. Флаг `AGENT_TEST_RUNNER`; без него каталог
инструментов, авто-проверки и обычный запуск не меняются. При включённом флаге тесты
встроены в автоматическую проверку после сборки.

## Что уже есть

### `agent/test-impact.ts`

Статический расчёт affected tests по графу импортов `repo-index`:

- изменение самого теста — тест выбирается;
- прямой и транзитивный вызывающий тест — до 3 обратных импортов по умолчанию;
- новый файл — соседний `*.test.*`, `*.spec.*`, `__tests__`, `test_*.py`;
- `package.json`, lockfile, `tsconfig*`, конфиги Jest/Vitest/Playwright/pytest — полный набор,
  потому что сужение в этом случае небезопасно;
- лимит 50 тестов, `truncated:true` вместо молчаливого обрезания.

Модуль не запускает команды и не читает тела тестов. Если сомневается — выбирает больше
тестов, а не меньше.

### `tools/test-tools.ts`

`project.test` — один запуск объявленной проектом команды:

- Node: `scripts.test` из `package.json`, менеджер из `packageManager` или lockfile
  (`npm`, `pnpm`, `yarn`, `bun`);
- Python: `python3 -m pytest -q` только при `pytest.ini`, `pyproject.toml`, `setup.cfg` или
  `requirements.txt`;
- нет тестового скрипта — `not_configured`, без установки пакетов и угадывания раннера;
- `CI=1`, маскирование секретных env-файлов, таймаут по умолчанию и максимум 5 минут;
- сводка TAP, Jest/Vitest и pytest, список падений, `failureDetails` с первым сообщением
  ошибки, хвост вывода;
- `runDeclaredTests`: отдельная функция исполнения с внедряемым runner; unit-тесты
  проверяют pass, fail и timeout без Docker;
- при `changed` возвращает affected tests;
- при `onlyAffected:true` дописывает пути только для Vitest, Jest, `node --test`, `tsx --test`
  и pytest; при неизвестном скрипте, watch-режиме, путях вне `cwd` или слишком длинной
  команде безопасно откатывается на полный набор и объясняет причину.

## Чего ещё нет

- Автоматическая проверка после правок всё ещё запускает полный test script; `onlyAffected`
  доступен только при явном вызове инструмента.
- Отдельного `not_configured`-статуса в browser-scenario QA: тесты не запускаются в сценарии.
- Нет измерения, сколько задач реально выбирают affected-only.
- Нет автоматического повтора flaky-тестов; timeout проверен только на fake runner.
- Полного набора тестов на финализации и трёх попыток исправления.
- Ретроспективного baseline: нельзя утверждать, что регрессии снижены на 50%.
- Измерения роста токенов.
- Canary на реальном проекте.

## Проверки

- `agent/test-impact.test.ts` — 5/5;
- `tools/test-tools.test.ts` — 8/8 (детекция менеджеров, pytest, TAP/Vitest/pytest-сводка,
  affected-only, shell-quoting, pass/fail/timeout);
- `agent/verification-policy.test.ts` — 8/8, включая `failureDetails` и отличие
  `not_configured` от падения;
- `agent/tool-catalog.test.ts` — 4/4, включая выключенный по умолчанию `project.test`;
- итого 25/25 в последнем прогоне;
- `server tsc` — без ошибок; сценарий agent-runtime с реальным sandbox не запускался.

### Полный реальный прогон (15.11.2026, после этапа 3)

Это checkpoint, а не закрытие приёмки: canary и baseline ещё впереди.

| Команда | Результат |
|---|---|
| `npm test --workspace=server` | 1 906 тестов: 1 896 passed, 10 skipped, 0 failed (135 с) |
| `npm run test:web` | 6/6 passed |
| `npm run test:broker` | 30/30 passed |
| `npx tsc -b --noEmit` | 0 ошибок |
| `npx tsc -p server/tsconfig.json --noEmit` | 0 ошибок |

Пропущенные проверки — Chromium/среда, не падения. Всего 1 942 теста: 1 932 passed, 10 skipped,
0 failed.

Следующий шаг: добавить canary `AGENT_TEST_RUNNER`, проверить отказ тестов в реальном
sandbox и снять baseline. Цепочка typecheck → build → tests → preview → HTTP → browser
уже собрана; тесты идут после успешной сборки, проект без тестов не считается упавшим.
`onlyAffected` пока не включается автоматически: сначала нужен замер, что он не пропускает
регрессии.
