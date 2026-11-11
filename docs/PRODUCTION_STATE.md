# Состояние production и оперативная память

Дата среза: **11.11.2026**. Документ фиксирует факты, которые нельзя терять между
сессиями. Секреты здесь не хранятся: только имена переменных, пути и способы проверки.

## 1. Роли ВМ

| ВМ | Роль | Адрес | Текущее питание |
| --- | --- | --- | --- |
| `node-1` | production primary: API, Caddy, HAProxy, PostgreSQL primary, `node1-runner` | `10.0.0.4`, management `2.59.83.250` | `ON` |
| `node-2` | вторая нода: API/Caddy/broker/runner, PostgreSQL standby, общий storage | `10.0.0.5`; внешний NAT динамический, читать из MWS API | `OFF` — выключена 11.11.2026 после тестов 4 preview |

**С 10.11.2026:** primary PostgreSQL на `node-1`, `node-2` — streaming standby (лаг 0).
Перед production-запуском primary нужно снова перенести на `node-2` — порядок в
[`PRODUCTION_LAUNCH.md`](PRODUCTION_LAUNCH.md). API на обеих нодах одинаково ходит в свой
локальный HAProxy `:5432`.

`node-2` — **не тестовая и не одноразовая машина**. Это вторая нода production-контура.
10.11.2026 пользователь разрешил оставить её включённой; после production-запуска она
работает постоянно. Её PostgreSQL, storage, runner и env-файлы — production-конфигурация,
а не тестовая заготовка.

Правило работы:

1. `node-2` выключена 11.11.2026 после тестов 4 preview; MWS подтвердил `power=OFF`.
   Включать только под конкретную работу; решение о постоянном питании — за пользователем.
2. Довести задачу до конца, не выключая ВМ в середине.
3. Вернуть прод в исходное состояние.
4. Питание менять только по явной просьбе пользователя; выключение — с проверкой MWS
   `power=OFF`.
5. После production-HA — постоянно включена.

Если `node-2` выключат, production не должен зависеть от её базы или storage как от
единственного экземпляра.

## 2. Текущая production-сборка

- Публичный адрес: `https://nestdev.ru`.
- `GET /api/ready` отвечает `ok:true`.
- Текущая production-сборка: `b3e4f793ff71ae3f2281a74b24324383a1d073a5`.
- Образ в GHCR: `ghcr.io/misha4323223/webnestdev:sha-b3e4f793ff71`.
- Выкачена 11.11.2026 на обе ноды; `/api/health` на node-1 и node-2 отдаёт этот build.
  Серверный код в ней тот же, что в проверенной `9725cb780e98…`; изменения этого деплоя —
  только README и документация. В коде исправлен лимит preview: `PREVIEW_MAX_CONTAINERS`
  считается по своей ноде, а лимит на аккаунт остаётся общим для кластера. Проверено
  4 контейнерных preview (2+2), после теста состояние очищено (`runtime:0` на обеих нодах).
- Прод работает на базе `node-1`; на базу `node-2` не переключён.
- NLB `webnestdev-nlb-main` — публичный ingress; DNS при переключении не меняется.

## 3. Env-файлы

### `node-1`

- Основной файл: `/home/Misha/webnestdev/src/.env`.
- Права `600`.
- Compose-проект использует его для API, runner и HA-override.
- `NODE2_PG_PASSWORD` уже записан фактическим значением роли `webnestdev` на `node-2`.
- `WEBNESTDEV_RUNNER_TOKEN` и `NODE1_RUNNER_TOKEN` совпадают с токеном `node1-runner`.

### `node-2`

Здесь **нет основного `.env`**, и создавать его пустым нельзя. Compose использует два файла:

- `/home/ubuntu/webnestdev/src/runtime.env`
- `/home/ubuntu/webnestdev/src/node2.env`

Это подтверждается меткой контейнера:

```text
com.docker.compose.project.environment_file=
  /home/ubuntu/webnestdev/src/runtime.env,
  /home/ubuntu/webnestdev/src/node2.env
```

Не копировать `.env.bak` и не создавать новый `.env`: остальные настройки второй ноды
уже лежат в `runtime.env` и `node2.env`, включая `NODE2_PG_PASSWORD`.

Оба файла должны содержать `WEBNESTDEV_RUNNER_TOKEN` и `NODE1_RUNNER_TOKEN` с тем же
значением, что и `node2-runner`. Секреты не печатать и не коммитить.

## 4. Runner-токен

- Контейнеры: `node1-runner` на `node-1`, `node2-runner` на `node-2`.
- API читает `WEBNESTDEV_RUNNER_TOKEN`; HA-override также использует `NODE1_RUNNER_TOKEN`.
- Токены `node1-runner`, `node2-runner`, API на `node-1` и API на `node-2` должны совпадать.
- На момент среза совпадение проверено, длина каждого токена — 64 символа.
- Скрипт синхронизации: `deploy/scripts/vm-deploy.sh`, режим `MODE=token`.
- Режим не перезапускает сервис; после записи API нужно перезапустить штатным compose,
  если он уже работает.

На `node-1`:

```bash
ssh node1 'MODE=token bash -s' < deploy/scripts/vm-deploy.sh
```

На `node-2` нужно явно передать **оба** env-файла:

```bash
ssh node2 'MODE=token APP_DIR="$HOME/webnestdev/src" ENV_FILE="$HOME/webnestdev/src/runtime.env" bash -s' \
  < deploy/scripts/vm-deploy.sh
ssh node2 'MODE=token APP_DIR="$HOME/webnestdev/src" ENV_FILE="$HOME/webnestdev/src/node2.env" bash -s' \
  < deploy/scripts/vm-deploy.sh
```

Если в логе появилось `.../.env нет — RUNNER_TOKEN не синхронизирую`, выбран не тот файл:
на `node-2` это должны быть `runtime.env` и `node2.env`.

## 5. `NODE2_PG_PASSWORD`

- Это фактический пароль роли `webnestdev` на PostgreSQL `node-2`, а не заглушка.
- Значение уже записано в `/home/Misha/webnestdev/src/.env` на `node-1`.
- На `node-2` оно лежит в её compose env-файлах.
- `docker compose -f docker-compose.yml -f docker-compose.override.yml config --quiet`
  на `node-1` проходит без ошибки о missing value.
- Значение не выводится в чат и логи.

Для будущей ротации/переноса используется режим `MODE=pg-password`:

```bash
ssh node1 'MODE=pg-password PG_PASSWORD_FILE=/tmp/node2-pg.secret bash -s' \
  < deploy/scripts/vm-deploy.sh
```

`PG_PASSWORD_FILE` — временный файл с правами `600`; скрипт читает его, обновляет
`NODE2_PG_PASSWORD` в env, удаляет временный файл и не печатает значение. Режим не
перезапускает сервис.

После записи проверять только результат, не значение:

```bash
ssh node1 'cd "$HOME/webnestdev/src" && docker compose \
  -f docker-compose.yml -f docker-compose.override.yml config --quiet && echo compose-ok'
```

## 6. Деплой

- GitHub Actions деплоит `node-1` (`deploy/scripts/vm-deploy.sh`), затем шаг
  `Deploy to node-2 over SSH` запускает на `node-1` `deploy/scripts/node2-sync.sh`: образ
  передаётся на `node-2` по SSH (`docker save | ssh | docker load`, GHCR ей отвечает
  `unauthorized`), обновляются `docker-compose.yml`/`Caddyfile`/`preview-tls.caddy`,
  пересоздаются API и брокер с `--no-deps`, гасится legacy postgres, проверяются `/api/ready`
  и сборка. Недоступная `node-2` — не ошибка выкатки (пропуск); `SYNC_NODE2=1` в переменных
  репозитория делает недоступность ошибкой, `SYNC_NODE2=0` выключает шаг.
- Runner обновляется автоматически на обеих нодах (`deploy/scripts/update-runner.sh`): раньше
  он оставался на прежней сборке, пока сервис уже работал на новой.
- `MODE=image` больше не поднимает legacy `postgres` из базового compose: с production
  override `up` идёт с `--no-deps`, а запущенный контейнер останавливается после выкатки.
- Полный деплой на `node-2` вручную по-прежнему возможен (`vm-deploy.sh` на ней), но штатный
  путь — шаг workflow выше.
- `MODE=token` и `MODE=pg-password` только пишут env и не перезапускают сервис.
- `MODE=housekeeping` (и тот же шаг в конце image-выкатки на обеих нодах) ротирует логи
  хоста: journald ограничен `SystemMaxUse=200M`, для `/var/log/glusterfs` ставится
  `logrotate` (50 МБ × 2). Данные проектов и бэкапы не трогаются.
- Сервер раз в час убирает каталоги в `SANDBOX_DIR`, для которых нет проекта в базе
  (порог `SANDBOX_GC_HOURS`, по умолчанию 24 ч; `SANDBOX_GC_DRY_RUN=1` — только показать,
  `SANDBOX_GC_ENABLED=0` — выключить). Служебные каталоги и `.project-backup-*`
  (страховочная копия прежней папки при восстановлении) не удаляются никогда.
- `MODE=image` — полная выкатка образа; не использовать его только ради env-синхронизации.
- В image-режиме на `node-1` токен runner синхронизируется автоматически.
- Для `node-2` учитывать её отдельные env-файлы из раздела 3 (`runtime.env` + `node2.env`).
- **Image-deploy не обновляет HA-скрипты.** `/opt/webnestdev-ha` ставится отдельно через
  `deploy/ha/install-node1.sh` и `install-node2.sh`. Если на ВМ остался старый checkout,
  установка из него вернёт контроллер без `switchover.py`/`control.py`. После изменений в
  `deploy/ha` скопировать актуальный каталог на обе ВМ и перезапустить оба failover-юнита;
  проверка — раздел 11.

## 7. Что проверять после работ с `node-2`

1. MWS: фактическое `status.hardware.power`. На 11.11.2026 после тестов — `OFF`.
   Включать только под конкретную работу и по явной просьбе; после выключения проверять
   `power=OFF`.
2. SSH к `10.0.0.5` (через `node-1`) и `node2-runner` отвечают, пока узел в строю.
3. `node-1`: `/api/ready` = `200`.
4. Токены `node-1` и `node-2` совпадают, если обе ВМ использовались.
5. `docker compose config --quiet` на `node-1` проходит.
6. Прод не смотрит на базу/storage только на `node-2`.

## 8. Чего не делать

- Не называть `node-2` тестовой машиной и не откладывать её production-настройку как
  «тестовую заготовку».
- Не выключать `node-2` в середине работы: сначала завершить задачу, потом выключить.
- Не создавать пустой `.env` на `node-2` и не копировать `.env.bak`.
- Не ставить заглушку в `NODE2_PG_PASSWORD`.
- Не читать и не печатать `.env`, пароли и токены.
- Не переводить прод на базу/storage, которые живут только на выключенной `node-2`.
- Не оставлять `node-2` включённой без production-решения, но и не выключать её до
  завершения текущей задачи.

## 9. Двухнодовый тест 10.11.2026

Проверено на реальных ВМ при включённой `node-2`, без выключения прод-базы:

- `node-2` обновлена до production-образа `ghcr.io/misha4323223/webnestdev:sha-af837ac1659f`
  (build `af837ac1659f32154c7936646dacc23ab7a6b4af`); API и `node2-runner` отвечают,
  PostgreSQL — streaming standby от `10.0.0.4`. Синхронизация `node-2` из workflow появилась
  после этого прогона, поэтому здесь она ещё выкатывалась вручную.
- NLB `webnestdev-nlb-main` видит оба бэкенда (`tcp:80`, `tcp:443`) в состоянии `OK`.
- При нагрузке на `node-2` новый проект A размещён на `node-1`; terminal на `node-1`
  выполнился (`node v26.13.0`).
- При нагрузке на `node-1` новый проект B размещён на `node-2`; terminal через runner
  `node-2` выполнился, preview-контейнер на `node-2` открывался через Caddy **обеих** ВМ.
- После снятия нагрузки с `node-1` (и при нагрузке на `node-2`) новый проект C снова
  размещён на `node-1`; terminal и preview на `node-1` работают. То есть освободившаяся ВМ
  снова принимает проекты, а не остаётся «выключенной из размещения».
- В `docker-compose.override.yml` на `node-1` добавлен
  `WEBNESTDEV_NODE_ADDRESS: 10.0.0.4:8790` (бэкап `.bak-20261110b`), чтобы API на `node-2`
  мог исполнять проекты, привязанные к `node-1`. Compose config проходит, API пересоздан,
  `/api/ready` = `200`, публичный `https://nestdev.ru/api/ready` = `200`.
- `deploy/ha/failover.py` исправлен: после перезагрузки поднимаются не только API, но и
  broker/Caddy с `restart=no` (`all_services_running`). 6 unit-тестов проходят; файл
  установлен на обе ВМ, сервисы active.
- 10.11.2026 на обе ВМ установлен полный актуальный `deploy/ha`, включая `switchover.py` и
  `control.py`; подробности, live switchover и холодный старт — в разделе 11.

Историческое ограничение preview при двух репликах (исправлено 10.11.2026, см. §10):
контейнерный preview, запущенный **локальным** API
на `node-1`, хранит прямой адрес Docker-моста (например, `172.21.0.4:3000`) и не открывает
relay runner'а. Через Caddy `node-1` он работает, через Caddy `node-2` — нет. Preview,
запущенный на `node-2` через runner, открывает relay и доступен с обеих ВМ. Static-preview
по-прежнему живёт в процессе API (слушатель на `127.0.0.1`) и намеренно не пишется в общий
реестр, поэтому вторая реплика о нём даже не знает. Это ограничение только preview; API,
PostgreSQL, terminal и размещение проектов работают на обеих ВМ.

Как это выглядит в жизни (10.11.2026, 09:34 UTC): пользователь запустил preview проекта
«Крот» (`3a6cb9b5-…`, pinned `node-1`) через API на `node-1`; terminal работал, а публичный
адрес то открывался, то отдавал «Предпросмотр недоступен» — NLB направлял iframe то на
дверь `node-1` (она видит контейнер), то на дверь `node-2` (до `172.21.0.4` из другой
Docker-сети не доходит). После выключения `node-2` в 09:36 весь трафик пошёл на `node-1`,
и preview сразу начал отображаться. Это не сбой приложения и не потеря данных: агент видел
приложение, потому что его проверки шли через узел-владелец/runner.

Реализованное 10.11.2026 направление: дверь-не-владелец проксирует запрос на приватную
дверь владельца, а owner-адрес хранится в общем реестре и для container, и для static.
Локальный runner-relay для этого не понадобился; подробности и проверка — в §10.

После теста временный пользователь, проекты A/B/C, preview-контейнеры, ballast и
`/var/lib/webnestdev/data/ha-test` удалены; в базе снова 18 проектов (`node-1` — 3,
`node-2` — 15). `node-2` выключена, MWS `power=OFF`.

## 10. Cross-replica preview: исправление 10.11.2026

Причина: публичная дверь (порт `8788`) каждой реплики получает запросы от NLB, но запись
preview хранила только адрес контейнера в Docker-сети (`172.21.0.4:3000`). Дверь `node-2`
не могла дойти до Docker-моста `node-1`, поэтому один и тот же публичный адрес то работал,
то отдавал «Предпросмотр недоступен». Static-preview вообще не сохранялся в общий реестр:
его слушатель живёт на `127.0.0.1` внутри конкретного процесса API.

Что изменено в коде (рабочее дерево, без коммита):

- `PreviewState`/`PreviewStatus` и общая таблица preview получили `owner_address`.
  Миграция `ensure_preview_table` добавляет колонку и разрешает `mode IN ('container','static')`.
- Для контейнера owner — приватная дверь узла контейнера (`10.0.0.4:8788` или
  `10.0.0.5:8788`); для static — дверь процесса, который держит слушатель.
- Дверь, не являющаяся владельцем, проксирует HTTP и WebSocket (включая HMR) на дверь
  владельца по приватной сети, сохраняя публичный `Host`, cookie и тело запроса
  (`server/src/preview/peer-door.ts`). Ticket/cookie проверяются на обеих дверях.
- Static теперь пишется в общий реестр с owner-адресом, поэтому вторая реплика о нём знает.
- `deploy/node1` и `deploy/node2` публикуют `8788` только на приватный IP ВМ:
  `10.0.0.4:8788:8788` и `10.0.0.5:8788:8788`.
- Обе ВМ получили `WEBNESTDEV_NODE_ADDRESS` (`10.0.0.4:8790` / `10.0.0.5:8790`), чтобы
  owner-адрес определялся и при локальном запуске.

Проверено в production 10.11.2026 (временный пользователь и проект удалены после теста):

- Контейнерный preview проекта на `node-1`: `host=172.21.0.4`, `ownerAddress=10.0.0.4:8788`;
  запрос через дверь `node-2` с публичным Host и ticket вернул HTML приложения и вставил
  pick-bridge. Это исходный сценарий бага — теперь он работает.
- Контейнерный preview проекта на `node-2`: `ownerAddress=10.0.0.5:8788`; запрос через
  дверь `node-1` вернул приложение.
- Static-preview на `node-2`: `host=127.0.0.1`, `ownerAddress=10.0.0.5:8788`; запрос через
  дверь `node-1` вернул статическую страницу. Static-строка при этом видна в общем реестре.
- Обе приватные двери доступны в обе стороны (`10.0.0.4:8788` ↔ `10.0.0.5:8788`).
- `/api/ready` на обеих ВМ и `https://nestdev.ru/api/ready` отвечают `200`.
- Реальные preview-строки, появившиеся во время выкатки, уже содержат `owner_address`
  (`node-1`, container и static); их не удаляли.

Известное ограничение, не относящееся к preview: при ручном переносе проекта между узлами
каталог общего sandbox может оказаться созданным от `root`, и API на другой ВМ не сможет
сделать `chmod` (`EPERM`). Это вопрос общего storage/владельца каталога, а не cross-replica
двери; для production-HA его нужно закрыть отдельно.

После проверки `node-2` выключена, MWS `power=OFF`; публичный прод продолжает работать
через `node-1`.

Важно до штатной пересборки: hotfix-образ существует только локально на обеих ВМ и не
запушен в GHCR. Перезагрузка ВМ безопасна — Docker поднимет уже созданный контейнер с этим
образом. Но `docker compose up` без `WEBNESTDEV_IMAGE=webnestdev:preview-owner-20261110`
вернёт старый `sha-30b7bf876c1e`, а на `node-2` compose нужно запускать с её env-файлами
`runtime.env` и `node2.env` (см. §3). После коммита и сборки в CI заменить образ штатным.

## 11. HA-код и live-проверка 10.11.2026

Проверено на рабочей паре; прод в это время обслуживался через NLB.

- На `node-1` и `node-2` установлен актуальный `deploy/ha` из рабочего дерева. Резервные
  копии прежних каталогов: `/opt/webnestdev-ha.bak-20261110112118` на `node-1` и
  `/opt/webnestdev-ha.bak-20261110112139` на `node-2`.
- На обеих ВМ есть `/opt/webnestdev-ha/switchover.py` и `control.py`, на каждой ВМ свой
  failover-юнит active, `HA_CONTROL_PATH=/var/lib/webnestdev/data/ha-switchover.json`,
  `HA_SWITCHOVER_TIMEOUT_SECONDS=180`.
- Плановый switchover `node-1 → node-2` 10.11.2026: `target_ready` в 11:24:12 UTC,
  `source_stopped` в 11:24:28, `promoted` в 11:24:32. `node-2` стала primary, API и Caddy
  ответили `200`, запись в PostgreSQL проверена временной таблицей; `node-1` продолжила
  отдавать API через primary `node-2`.
- Rejoin `node-1` выполнен в 11:26:25 UTC: `pg_is_in_recovery()=t`,
  `pg_stat_wal_receiver.status=streaming`, отставание `replay_lsn` нулевое.
- Обратный плановый switchover `node-2 → node-1` в 11:27:09–11:27:24 UTC вернул primary на
  `node-1`; `node-2` продолжила API через `node-1`.
- Rejoin `node-2` выполнен в 11:28:00 UTC: standby `t`, `streaming` от `10.0.0.4`;
  `pg_stat_replication` на `node-1` показывает `17/main|streaming|async`.
- Холодный старт `node-2` после rejoin проверен: MWS `power=ON` в 11:31 UTC, автоматически
  поднялись `postgresql@17-main` (standby), `webnestdev-failover-node2`, broker/API/Caddy и
  `node2-runner`; `/api/ready` и Caddy — `200`, `SANDBOX_RUNTIME=runsc`,
  `BROKER_RUNTIME=runsc`, Docker видит `runsc`.
- Публичный `https://nestdev.ru/api/ready` и `/` — `200`; `node-1` primary, `node-2`
  standby.
- После проверки `node-2` выключена; MWS подтвердил `power=OFF`.

**Повторный destructive-прогон 10.11.2026.** Выполнен на текущем `deploy/ha` с реальным
`power=OFF` в обе стороны, но с временным `cluster.quorum-type=none`: текущий код не
размораживает Gluster после потери peer. Это тестовый обход, а не штатное поведение.

- `node-1` → `node-2`: power-off начат 13:32:29 UTC, подтверждён 13:33:43; `suspect`
  13:34:07, fencing/promotion 13:35:06–07; API `200` 13:35:16, публичный сайт `200`
  13:35:21. RTO 1 мин 38 с от подтверждённого отказа.
- `node-2` → `node-1`: power-off начат 13:53:06, подтверждён 13:54:34; `suspect`
  13:54:53, fencing/promotion 13:55:39–40; API `200` 13:55:54 (один краткий `502`
  в 13:55:48). RTO 1 мин 20 с.
- После promotion: 18 проектов, 5 сайтов, запись временной таблицей проходит; сайты
  `my-furniture.host.nestdev.ru` и `my-sayt.host.nestdev.ru` — `200`. Rejoin обоих узлов
  дал streaming standby с нулевым лагом.
- Финальное состояние: `node-1` primary, `node-2` standby; при обоих включённых узлах
  `quorum-type=auto`, после выключения `node-2` — `none` (единственный узел), публичный
  `ready=200`; MWS `power=OFF`.

**Эти блокеры закрыты 10.11.2026 (см. §12).** Внешний management-IP `node-2` остаётся
динамическим — это свойство NAT MWS, а не дефект: адрес нужно читать из API
(`status.network.networkInterfaces[].addresses[].oneToOneNat.external.ipAddress`), в одном
прогоне он менялся `111.88.128.219` → `111.88.131.185`. Штатный путь остаётся прежним:
`10.0.0.5` через ProxyCommand на `node-1`; прямой SSH по текущему NAT — только для
диагностики, пока `node-1` жив.

Порядок production-запуска — в [`PRODUCTION_LAUNCH.md`](PRODUCTION_LAUNCH.md),
разделы 4.5–6 и 12.

## 12. Полный production-like прогон 10.11.2026

Что исправлено в коде (`deploy/ha`, рабочее дерево):

1. **Storage-quorum на переходе standby → primary.** `storage_quorum.desired()` больше не
   возвращает `None` для standby: если peer недоступен и MWS подтвердил `power=OFF`, quorum
   переводится в `none` до promotion. Если peer включён или MWS недоступен — остаётся `auto`
   (защита от split-brain при сетевой изоляции).
2. **Мёртвый FUSE-моунт.** `control.read()` превращает `Transport endpoint is not connected`
   в `RuntimeError`, поэтому failover приостанавливается, а не идёт в fencing вслепую.
   `failover.storage_ready()` проверяет не только `ismount`, но и тип `fuse.glusterfs` и
   реальное чтение каталога. `ensure_local_services()` не поднимает API на непроверенном
   storage.
3. **Automount/самовосстановление Gluster.** `deploy/ha/storage-ensure.sh` +
   `webnestdev-storage.service`/`.timer` (каждые 30 с): монтирует через systemd-юниты
   (а не `mount(8)`, иначе systemd снимает чужой FUSE-процесс), проверяет чтение, а при
   мёртвом моунте останавливает держащие его контейнеры, перемонтирует и поднимает их
   обратно. При загрузке юнит идёт `Before=docker.service`; в fstab добавлен `nofail`.
4. **Rejoin и replication slot.** `standby.sh` проверяет слот, создаёт его и падает с
   понятной ошибкой, если создать не удалось. Попутно исправлен `.pgpass`: база `*` вместо
   `replication` — иначе проверка слота в базе `postgres` шла без пароля
   (`no password supplied`).
5. **Права каталогов проектов.** runner создаёт workspace от uid 1000, API повторяет
   `chmod` при `EPERM`; до выхода образа владельца нормализует
   `webnestdev-sandbox-ownership.timer` (новый проект на «чужой» ВМ иначе оставался
   `root:root`, и терминал падал с `Permission denied`). С 10.11.2026 таймер чинит дерево
   **рекурсивно**, включая `node_modules`: в проекте «3D-игра» остались root-owned каталоги
   от старых запусков, и `npm install` падал с `EACCES: permission denied, unlink
   '.../node_modules/@types/.three-QehKYDIT/...'`. Исправлено на живой базе (58 вложенных
   элементов), unlink от uid 1000 проверен. Кроме таймера есть ручная ручка
   `POST /api/admin/projects/:id/permissions` (код готов, в проде — со следующей сборкой образа);
   на ВМ без нового образа ремонт запускается как `sudo systemctl start
   webnestdev-sandbox-ownership.service`.

Результаты прогона (реальные `power=OFF`, без ручного обхода quorum):

- **node-1 → node-2.** После `power=OFF` `node-1` (14:54:52) выжившая `node-2` сама
  перевела quorum в `none`, дождалась storage и повысилась: PG primary 15:00:43, API `200`
  15:00:53. Публичный `ready=200` восстановился в 15:01:3x. Это первый прогон, где
  понадобилось ручное вмешательство только из-за мёртвых моунтов — после установки
  storage-guard они восстанавливаются автоматически (проверено в обратном прогоне).
- **RPO.** Непрерывная запись `ha_rpo_probe` с fsync ~3.5 строк/с. Последняя подтверждённая
  запись перед падением — `seq 289` в `14:55:10.185Z`; на новом primary максимум `289`.
  Потерь нет (RPO = 0 строк).
- **node-2 → node-1 (реверс).** `power=OFF` `node-2` в 15:06:33; публичный `502` с 15:06:49,
  `200` с 15:08:08 — **RTO 79 с** (было ~6 мин из-за мёртвого моунта). Последняя
  подтверждённая запись `seq 358` в 15:06:33, на новом primary `392` — все подтверждённые
  записи выжили (RPO = 0).
- **Rejoin.** Оба узла вернулись как streaming standby с нулевым лагом; слоты `node1` и
  `node2` созданы `standby.sh` автоматически, вручную ничего не создавалось.
- **NLB.** Оба бэкенда принимают публичный трафик одновременно (в одном окне 5 мин:
  `node-1` — 286 запросов, `node-2` — 5). Публичный адрес не меняется.
- **Приложение на каждом узле.** Проект, созданный на `node-2`, прошёл терминал
  (`node v26.13.0`, запись файла), preview поднялся в container-режиме
  (`ownerAddress=10.0.0.5:8788`), билет обменивался на cookie (`204`) и страница приложения
  отдавалась (`200`, HTML приложения + pick-bridge). После падения `node-1` проект,
  привязанный к мёртвой `node-2`, автоматически переехал, и терминал выполнился на `node-1`.
- **Backup/restore drill.** Свежий `pg_dump -Fc` восстановлен в отдельную БД: счётчики
  совпали с живой базой (18 проектов, 18 пользователей, 7692 сообщения); дампы и
  `SHA256SUMS` лежат в `/var/backups/webnestdev-merge/`.
- **Данные не разъезжаются.** Причина расхождения 10.11.2026 — API на `node-1` был
  подключён к старому Docker-Postgres `src-postgres-1`, а `node-2` — к system PostgreSQL.
  Базы слиты по `message_id` (348 сообщений из старой базы, конфликтов ID нет), API
  переведён на system PG через `docker-compose.override.yml`, legacy-контейнер остановлен
  (`restart=no`), дампы обеих баз сохранены. Сейчас оба узла читают одну базу.

Остаточные риски (не блокируют текущий запуск):

- Replica 2 без witness: при сетевой изоляции (MWS говорит `power=ON`) запись замораживается
  через `auto`, но автоматического арбитража нет. Нужна третья witness-ВМ.
- `node-2` 2 vCPU / 4 ГБ хватает текущей нагрузке; preview/sandbox-ёмкость и диск под
  storage — отдельная задача перед production-масштабом.

## 13. Проверки 10.11.2026: общие лимиты, egress, отказ провайдера

### Общие лимиты входа (4.1) — закрыто

Проверено на живой паре, а не на локальном стенде:

- каждая нода — своя реплика API (`127.0.0.1:8787`), база одна (`node-1:5433`);
- 5 попыток `POST /api/admin/login` с одним адресом на `node-1` + 5 на `node-2` — все 10 прошли
  проверку лимита (лимит по аккаунту `adminLogin` = 10); 11-я с `node-1` — `429` и
  `Retry-After: 898`, 12-я с `node-2` — тоже `429`;
- после `docker restart src-webnestdev-server-1` на `node-2` счётчик остался `13`, ответ — `429`:
  рестарт окна не обнуляет;
- тестовые ключи `subject:adminLogin:accept41*` удалены из `webnestdev_rate_limits`; чужие окна
  не тронуты; `/api/ready` 200 локально и на `https://nestdev.ru`.

### Egress-фильтр (5.1) — включён в проде 10.11.2026

- В `deploy/node1/docker-compose.override.yml` и `deploy/node2/docker-compose.override.yml`:
  `EGRESS_MODE: allowlist`, `EGRESS_ENFORCE: "1"`.
- На обеих нодах `webnestdev-egress.service` `active` и `enabled` (на `node-2` установлен
  впервые), в `DOCKER-USER` — 6 правил с комментарием `webnestdev-egress`.
- Проверка `MODE=egress` на каждой ноде: прокси жив (`mode=allowlist`, 33 домена), сервер ходит
  наружу сам (200), через прокси npm registry 200, `example.com` → 403, контейнер проекта
  ставит пакеты через прокси 200, прямой сокет из контейнера не открывается. Вручную:
  `github.com` через прокси 200, `example.com` 403.
- API на обеих нодах 200, публичный `https://nestdev.ru/api/ready` 200.
- Аварийный выключатель: `EGRESS_MODE: private-only` (публичное разрешено, обход закрыт),
  затем `EGRESS_ENFORCE: "0"` (полный откат). После изменения — пересоздать контейнер сервера.
- **Ловушка на `node-2`:** там нет `.env`, compose читает `runtime.env` и `node2.env`; ручной
  `MODE=egress` без `COMPOSE_ENV_FILES=runtime.env,node2.env` даёт ложное «прокси не отвечает»
  и снимает правила.

### Отказ провайдера модели (7.3)

- Сетевой трафик контейнера API (`172.30.0.4`) на `:443` отклонялся правилом в `DOCKER-USER`
  примерно 45 секунд; правило снято в `trap`, остатков нет.
- Вызов `https://polza.ai/api/v1/models` из контейнера: `200` → `000` (обрыв) → `200` после
  снятия правила; `/api/ready` и `https://nestdev.ru/` всё время отвечали `200`; контейнер не
  перезапускался (`StartedAt` тот же, `RestartCount=0`).
- Ограничение: полноценный запуск агента в окне отказа не выполнялся — проверены изоляция и
  живучесть API, а не текст ошибки в чате. Обработка кодов провайдера покрыта
  `provider-errors`/`provider-retry` тестами.
- Отдельная находка: у запроса к модели (OpenAI-совместимый провайдер) нет собственного
  таймаута — он полагается на `AbortSignal` запуска. При «чёрной дыре» (соединение без ответа)
  шаг может ждать, пока запуск не прервёт пользователь. Это кандидат на отдельную правку с
  тестом, не входившую в сегодняшний блок.

### Переполнение диска (7.3) — не имитировалось

Том реплицируется на `node-2` (19 ГБ), заполнение до 75 % задело бы и прод, и кворум Gluster.
Логика давления (пороги 75/68, остановка на цели, защита активных проектов) покрыта
`server/src/storage/archive-scheduler.test.ts`, archive/wake принят в проде в 1.3. Для честного
учения нужен отдельный том (loop-устройство) или тестовая нода.

## 14. PITR: WAL-архив и восстановление на момент времени (10.11.2026)

Пункт 4.4 в части PITR. Скрипт `deploy/scripts/pg-pitr.sh`, установлен как
`/usr/local/sbin/webnestdev-pg-pitr`; эксплуатация и drill — `POSTGRES_BACKUP.md` §5.

Что сделано на проде:

- `archive_mode=on`, `archive_command` кладёт WAL в `/var/lib/postgresql/wal-archive`
  (локальный диск: каталог под `/var/lib/webnestdev` каждую минуту переводит на uid 1000
  `webnestdev-sandbox-ownership.timer`, WAL там жить не может);
- таймеры `webnestdev-pg-basebackup.timer` (вс 04:30 UTC, хранится 2 копии) и
  `webnestdev-pg-wal-prune.timer` (05:00 UTC, WAL старше 21 суток);
- base backup 88 МБ снимается за ~4 с; WAL-сегмент 16 МБ.

Учение (10.11.2026):

- две метки в рабочей базе с разницей 3 с; restore через `pg-pitr.sh restore` на момент между
  ними — в восстановленной базе `rows=1:before`, второй метки нет, `webnestdev_projects=18`;
- восстановление заняло 1–3 с, остановка ровно перед коммитом следующей транзакции
  (`recovery stopping before commit of transaction ...`) — это и есть PITR, а не «последний дамп»;
- учебный кластер поднимается на порту 5544 и удаляется `pg-pitr.sh stop`; тестовые таблицы
  `webnestdev_pitr_probe*` удалены из рабочих баз.

Три ловушки, найденные по ходу (все исправлены в скрипте):

1. `archive_command` с `test ! -f` не идемпотентен: если файл уже в архиве, PostgreSQL считает
   сегмент неархивированным и повторяет вечно (наблюдали `failed_count=24` и стоящую
   архивацию). Теперь `cp` во временный файл + `mv`.
2. Без `recovery.signal` PostgreSQL завершает recovery на конце base backup и игнорирует
   `recovery_target_time` — выглядит как «восстановление прошло, а метки нет».
3. Учебный кластер при `promote` с включённым `archive_mode` писал свои timeline-файлы в общий
   архив, и следующий restore падал на «requested timeline N is not a child of this server's
   history». Теперь у drill `archive_mode=off`.

**Вывоз в S3 (10.11.2026).** Написан `deploy/scripts/pg-pitr-s3.sh` и таймер
`webnestdev-pg-pitr-s3.timer` (каждые 5 минут, установлены через `pg-pitr.sh setup`):

- каждый новый сегмент — `<prefix>/pitr/wal/<сегмент>`, рядом `index.txt` (вместо ListObjects);
- base backup упаковывается в `<ts>.tar.gz` и уходит в `<prefix>/pitr/basebackup/`, рядом
  `latest.txt` с номером последней копии;
- в образ добавлены CLI-команды `put-object`, `get-object`, `head-object` с проверкой, что ключ
  лежит под `<prefix>/pitr/` и без `..`; хост стримит файл в контейнер, своих ключей у него нет;
- восстановление из бакета — `sudo env RESTORE_TIME='…' /usr/local/sbin/webnestdev-pg-pitr
  restore-s3` (или `S3_TS=<ts>` для конкретной копии).

**Включено 11.11.2026.** Образ `sha-343ee73fc0c4` содержит CLI `put-object`/`get-object`/
`head-object`; таймер `webnestdev-pg-pitr-s3.timer` выгрузил 18 WAL-сегментов, `index.txt`, base
backup `20261110T223005Z.tar.gz` (17 МБ) и `latest.txt`, оба объекта подтверждены
`head-object`. При первом запуске найден и исправлен баг `local dir="$1" tar="$dir.tar.gz"`
(`dir: unbound variable` под `set -u`) — из-за него после WAL не выгружался base backup;
исправленный `pg-pitr-s3.sh` стоит на обеих нодах. Вывоз и `restore-s3` работают.

Осталось по 4.4: TLS между API и PostgreSQL и вынос primary на отдельный от API инстанс.
Выкатка пока не ставит `pg-pitr.sh` автоматически — установка выполнена через `MODE=setup`;
перенос установки в `vm-deploy.sh` — следующий шаг.

## 15. Primary PostgreSQL перенесён на node-2 (10.11.2026)

Пункт 4.4 в части «Postgres отдельно от API». `node-2` остаётся включённой постоянно
(решение пользователя: production-контур на двух узлах), поэтому отдельная ВМ под базу не
покупалась.

Как выполнено:

- planned switchover через штатный mailbox `data/ha-switchover.json`: `requested → target_ready
  → source_stopped → promoted` за ~12 с; `node-2` стал primary, `node-1` остановил локальную
  базу и продолжил отдавать API через HAProxy на peer;
- `node-1` возвращён standby'ом (`standby.sh 10.0.0.5 5432 node1`), слот `node1` создан
  автоматически, лаг 0;
- приложение не меняло `DATABASE_URL`: оба API ходят в локальный HAProxy `:5432`, цель которого
  переключает `db_proxy.py`;
- PITR перенесён на новую primary: `pg-pitr.sh setup` на `node-2`, `archive_mode=on`,
  `pg_switch_wal` → сегмент в архиве, base backup 88 МБ, drill на момент времени — только
  `before`-метка, 18 проектов;
- в `pg-pitr.sh`/`pg-pitr-s3.sh` добавлена защита: таймеры basebackup/prune/выгрузки
  отрабатывают только на primary (`pg_is_in_recovery() = f`), иначе после switchover обе ноды
  писали бы в один бакет.

Проверка после переезда: `node-2` — `pg_is_in_recovery()=f`, 18 проектов, API 200;
`node-1` — `in_recovery=t`, лаг 0, API 200; публичный `https://nestdev.ru/api/ready` — 200.

### Откат 10.11.2026 и простой (важно)

Пользователь решил выключить `node-2` примерно на две недели, поэтому в тот же день primary
возвращён на `node-1` (плановый switchover `node-2 → node-1`, rejoin `node-2`, слот `node2`,
лаг 0, оба API 200). Перед production-запуском базу нужно снова перенести на `node-2` —
порядок в [`PRODUCTION_LAUNCH.md`](PRODUCTION_LAUNCH.md).

Во время обратного переезда прод кратковременно лёг (несколько минут). Причины, чтобы не
повторить:

1. **Битый TLS-конфиг на `node-2`.** В `postgresql.auto.conf` были прописаны
   `ssl_cert_file`/`ssl_key_file`/`ssl_ca_file` на `/var/lib/postgresql/tls/*.crt`, а сами
   файлы — 0 байт. После рестарта PostgreSQL не стартовал (`could not load server certificate
   file ... no start line`), API остались без базы. Лечение: `ssl = off` (TLS ещё не включён),
   пустые файлы остались как напоминание — не включать TLS без валидного сертификата.
2. **Старый worker HAProxy на `node-1`.** После рестарта базы peer'а он держал мёртвые
   соединения, `/api/ready` висел; `sudo systemctl reload haproxy` вернул 200. Это теперь
   штатный шаг после рестарта PostgreSQL на соседней ноде.
3. **`archive_mode` слетает при rejoin.** `standby.sh` перезаписывает `postgresql.auto.conf`
   (новая `primary_conninfo`/слот), и `archive_mode`/`archive_command` исчезают. После
   каждого rejoin новой primary: `webnestdev-pg-pitr setup` + `show archive_mode` = `on`.
   Также исправлен `pg-pitr.sh`: `setup` больше не падает на `install` в самого себя
   («are the same file»), из-за чего `ALTER SYSTEM archive_mode` раньше не выполнялся.

### Выключение `node-2` 10.11.2026

- Перед выключением: `node-1` — primary, `node-2` — standby, лаг 0, публичный `/api/ready` 200.
- **`sudo systemctl poweroff` на `node-2` не сработал** (завис на `cloud-init-hotplugd` и закончился
  перезагрузкой в 22:43). Поэтому: остановлены `postgresql@17-main` и `glusterd`, затем питание
  снято через MWS (`POST` с `metadata.etag` и `spec.hardware.power=OFF`, `gracefulShutdownTimeout
  90s`). MWS: `power=OFF`, `ready.state=OK`.
- После выключения: `ping 10.0.0.5` не проходит, `node-1` — primary, 18 проектов, API 200,
  `https://nestdev.ru/api/ready` 200; `sandboxes` и `data` читаются, в `gluster volume status`
  остались только brick'и `10.0.0.4`; контейнеры на `node-1` живы.
- Ограничения режима: нет failover (потеря `node-1` — ручное восстановление), Gluster — одна
  реплика, риск split-brain при неаккуратном включении. Включать `node-2` только когда `node-1`
  жив и является primary.

## 16. NLB и CDN для хостинга (11.11.2026)

### `node-2` включена для проверки (на момент проверки)

- MWS: `power=ON`, `ready.state=OK`; SSH через `node-1` работает. После тестов 4 preview
  машина снова выключена: `power=OFF`.
- `postgresql@17-main` — standby (`pg_is_in_recovery()=t`), API 200, `glusterd` и Docker активны.
- `node-1` — primary, `pg_stat_replication`: 1 реплика, лаг 0; публичный `/api/ready` 200.
- `gluster volume status`: по 2 brick'а на каждый из трёх томов (`data`, `sandboxes`, `sites`).

### NLB действительно балансирует

Проверка на живом сайте `https://my-furniture.host.nestdev.ru/` (страница ~24 КБ), 40 запросов
через NLB, счётчики сети контейнера `src-caddy-1` на каждой ноде:

| Нода | Принято (rx) | Отдано (tx) | Доля tx |
| --- | --- | --- | --- |
| `node-1` | +57 750 Б | +600 892 Б | 49,7% |
| `node-2` | +62 738 Б | +607 615 Б | 50,3% |

Вывод: NLB распределяет TCP-соединения между обеими нодами практически поровну; обе отдают
сайт из общего Gluster. Счётчики хоста для такой проверки не годятся — в них попадает
репликация Gluster.

### CDN-пилот (удалён 11.11.2026)

- Ресурс: `hosting-pilot` в `project-pimashin2015`, API `cdn.mwsapis.ru`
  (`POST /cdn/v1/projects/{project}/cdnResources/{name}`).
- Origin: `https://my-furniture.host.nestdev.ru`, Host header — тот же домен, HTTPS-редирект,
  кеширование «как у origin» с TTL 1 ч.
- Сгенерированный адрес: `https://top873590456.mwscdn.ru`, статус `Active` (раскатка по edge
  заняла ~10 минут, до этого часть edge отвечала 502/SSL-ошибкой — это нормально для
  `PROCESSING`).
- Проверки: HTML совпадает с origin побайтно (sha256), отдаётся с `x-edge-cache-status: MISS`
  всегда, потому что Caddy ставит `Cache-Control: no-cache`; CSS первый раз `MISS`, дальше `HIT`.
- Purge: `POST /cdn/v1/projects/{project}/cacheTasks/{name}` с
  `spec.action.purge.paths=["/styles.css"]`; задача дошла до `OK`, после неё CSS снова `MISS`,
  затем `HIT`.
- Цена: 0,8418 ₽/ГБ с НДС, без платы за запросы; квота 25 CDN-ресурсов по умолчанию.
- После проверки общей схемы пилот удалён (`DELETE .../cdnResources/hosting-pilot?ifExist=true`, 204).
  Превью не подключались.

### Общий wildcard-CDN для всех сайтов (включён 11.11.2026)

Цель — один CDN-ресурс на `*.host.nestdev.ru`, чтобы новые и существующие сайты попадали в
CDN без отдельных ресурсов.

| Объект | Значение |
| --- | --- |
| Сертификат Certificate Manager | `host-wildcard`, домены `*.host.nestdev.ru`, DNS-01, **`valid=true`** |
| CNAME для делегирования | `_acme-challenge.host.nestdev.ru` → `402a2f9f91e84d2eabe877c343f4c978.certmanager.mwsusercontent.ru.` |
| CDN-ресурс | `hosting`, FQDN `top3561259317.mwscdn.ru`, **включён**, статус `OK` |
| CNAME всех сайтов (после сертификата) | `*.host.nestdev.ru` → `top3561259317.mwscdn.ru.` |
| Origin | `https://178.236.27.102` (NLB), Host и SNI — по имени сайта |

Порядок:

1. ✅ CNAME `_acme-challenge.host.nestdev.ru` добавлен, сертификат стал `valid=true`.
2. ✅ CDN-ресурс `hosting` включён; проверен через `--resolve` на IP edge без изменения DNS:
   `my-furniture` — 200, содержимое совпадает с origin; `my-sayt` — 200; кеш по Host
   раздельный (`my-furniture/styles.css` и `my-sayt/styles.css` не смешиваются); после первого
   промаха CSS отдаётся `HIT`. Несуществующий и неопубликованный сайты дают 502 — это ожидаемо.
3. ✅ В REG.RU удалена A `*.host` → `178.236.27.102` и добавлена CNAME-запись
   `*.host` → `top3561259317.mwscdn.ru.`; авторитетный `ns1.reg.ru` отдаёт CNAME, локальные
   кеши могут держать старый A до истечения TTL (до ~48 мин, без простоя — NLB ещё работает).
4. ✅ Проверены `my-furniture` и `my-sayt` уже через CNAME/CDN: 200, содержимое совпадает с
   origin побайтно, кеш ассетов `HIT`, панель и `api/ready` — 200. Сайт в статусе draft и
   несуществующий slug дают 502 от origin — ожидаемо.

Ограничения: wildcard-сертификат Let's Encrypt действует 90 дней и обновляется автоматически,
пока CNAME `_acme-challenge` остаётся на месте. Purge при публикации ещё не автоматизирован;
пока HTML не кешируется (`no-cache`), а ассеты живут до TTL 1 ч. Черновики и удалённые сайты
через CDN отдают 502, потому что origin-Caddy не выдаёт на них сертификат — это не дефект CDN.

**Авто-purge (выкачен 11.11.2026, build `2a9a58986ced`):**

- `server/src/hosting/cdn-purge.ts` — best-effort вызов `POST /cdn/v1/projects/{project}/cacheTasks/{name}`
  с `paths: ["/*"]` после успешной публикации; ошибка только логируется и не переводит сайт в failed.
- Включается переменными `HOSTING_CDN_PURGE=1`, `HOSTING_CDN_RESOURCE=hosting`,
  `HOSTING_CDN_PROJECT=project-pimashin2015` (добавлены в `deploy/node{1,2}/docker-compose.override.yml`).
- Workflow `deploy` собрал образ `ghcr.io/misha4323223/webnestdev:sha-2a9a58986ced` и выкатил его
  на обе ноды; `/api/health` на node-1 и node-2 отдаёт `2a9a58986ced1c89deba952ad14f09e58155514c`,
  все три `HOSTING_CDN_*` видны в контейнерах. `my-furniture` через CDN — 200. Повторную публикацию
  для end-to-end проверки после выкатки ещё не делали.
- Ресурс общий, поэтому purge чистит кеш **всех** сайтов. Это принятый компромисс: отдельный
  ресурс на сайт не нужен, а лишний промах кеша дешевле залипшего старого ассета.
- Проверено: тест `cdn-purge.test.ts` (7/7), `tsc -p server/tsconfig.json --noEmit`; реальная
  задача `purge-my-furniture-mwbwhmxc` дошла до `OK`.

Все сайты, старые и новые, уже попадают в CDN автоматически за счёт wildcard-CNAME и одного
ресурса `hosting`; отдельный ресурс на сайт не создаётся.

Осталось: TLS на участке HAProxy ↔ PostgreSQL (меняется `db_proxy.py`: peer-цель должна идти
напрямую в `5433` с `ssl verify required`; нужны сертификаты и `hostssl` на обеих нодах) и
проверка `restore-s3` после выкатки образа с CLI-командами.

Связанные документы:

- [`PRODUCTION_LAUNCH.md`](PRODUCTION_LAUNCH.md) — порядок production-запуска и проверки;
- [`CLUSTER_HA_PLAN.md`](CLUSTER_HA_PLAN.md) — целевая HA-схема;
- [`HA_BIDIRECTIONAL_PLAN.md`](HA_BIDIRECTIONAL_PLAN.md) — результаты failover;
- [`PRODUCTION_DEPLOYMENT.md`](PRODUCTION_DEPLOYMENT.md) — выкатка и Docker.
