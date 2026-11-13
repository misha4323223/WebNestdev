# Состояние production и оперативная память

Дата среза: **13.11.2026**. Документ фиксирует факты, которые нельзя терять между
сессиями. Секреты здесь не хранятся: только имена переменных, пути и способы проверки.

## 1. Роли ВМ

| ВМ | Роль | Адрес | Текущее питание |
| --- | --- | --- | --- |
| `node-1` | production primary: API, Caddy, HAProxy, PostgreSQL primary, `node1-runner` | `10.0.0.4`, management `2.59.83.250` | `ON` |
| `node-2` | standby/worker: PostgreSQL streaming standby, API/Caddy/broker/runner, общий storage | `10.0.0.5`; внешний NAT динамический, читать из MWS API | `ON` — включена 13.11.2026 для выкатки и проверки локального кэша |

**С 13.11.2026:** primary PostgreSQL — `node-1`, `node-2` включена и работает streaming
standby (лаг 0). Обе ноды обслуживают API, runner и общий storage; NLB видит оба target'а.
API на `node-1` ходит в локальный HAProxy `:5432`. Это двухнодовый режим, а не работа на
одной ВМ: при падении `node-1` `node-2` должна принять трафик и базу.

**Не включать `node-2`, пока `node-1` не жива и не является primary:** иначе контроллер
`node-2` может повысить её и получится два primary. Включать только по явной просьбе и под
конкретную работу; после включения она должна стартовать standby, а не primary.

`node-2` — **не тестовая и не одноразовая машина**. Это вторая нода production-контура;
её PostgreSQL, storage, runner и env-файлы — production-конфигурация, а не тестовая
заготовка. На 13.11.2026 она включена и работает streaming standby.

Правило работы:

1. На 13.11.2026 `node-1` — primary, `node-2` — streaming standby; обе ВМ включены.
2. Доводить задачу до конца, не выключая работающую ВМ в середине.
3. Перед production-запуском включить `node-2`, проверить её standby и выполнить плановый
   переезд primary на неё по [`PRODUCTION_LAUNCH.md`](PRODUCTION_LAUNCH.md).
4. Питание менять только по явной просьбе пользователя; после выключения проверять MWS
   `power=OFF`.
5. После production-HA `node-2` работает постоянно; это фиксируется отдельным решением.

Пока `node-2` выключена, production не должен зависеть от её базы или storage как от
единственного экземпляра.

## 2. Текущая production-сборка

- Публичный адрес: `https://nestdev.ru`.
- `GET /api/ready` отвечает `ok:true`.
- Текущая production-сборка: `a6b28ce115f2` — локальная сборка из рабочего дерева
  13.11.2026, не коммит и не образ из GHCR.
- Образ: `ghcr.io/misha4323223/webnestdev:sha-a6b28ce115f2` — собран на `node-1`, в GHCR
  не публиковался; на обеих нодах закреплён в env.
- Выкачена 13.11.2026 вручную на обе ноды; `/api/ready` и `/api/health` на node-1 и node-2
  отдают этот build. Код включает локальный кэш зависимостей preview, hybrid fallback,
  прогресс запуска, отдельный лимит hybrid/общий бюджет ноды, static-only панель preview
  и двухминутный idle для Docker/hybrid; подробности — в разделе 20 и
  [`HYBRID_PREVIEW.md`](HYBRID_PREVIEW.md).
- Прод работает на базе `node-1`; `node-2` — streaming standby и работает. Переключение
  выполнялось аварийным прогоном 12.11.2026, подробности — в разделе 19.
- NLB `webnestdev-nlb-main` — публичный ingress; DNS при переключении не меняется. Обе ноды
  в строю; публичный `https://nestdev.ru` и `/api/ready` отвечают `200`.

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
  он оставался на прежней сборке, пока сервис уже работал на новой. С 13.11.2026 скрипт
  также гарантирует локальный каталог кэша, bind-mount и переменные `WEBNESTDEV_PREVIEW_CACHE_*`
  и пересоздаёт runner, если образ тот же, а конфигурация кэша неполная.
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

1. MWS: фактическое `status.hardware.power`. На 12.11.2026 после обратного прогона — `OFF`.
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

> Историческая запись. После обратного прогона 12.11.2026 primary снова на `node-1`;
> актуальное состояние — раздел 19, а не откат, описанный ниже.

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
| Origin TLS | wildcard `*.host.nestdev.ru` из Certificate Manager на обеих нодах (до 09.02.2027) |

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
5. ✅ **11.11.2026 — TLS на origin для новых сайтов.** До этого новый slug получал 504: CDN
   ходит на origin по HTTPS, а Caddy пытался выпустить сертификат на каждое имя через ACME,
   который после переключения DNS приходит на CDN. Исправление: забрали уже выпущенный
   managed-сертификат `host-wildcard` через
   `GET /certmanager/v1/projects/project-pimashin2015/certificates/host-wildcard:download`,
   положили `fullchain.pem`/`key.pem` в `certs/host` на **обеих** нодах и переключили
   `host-tls.caddy` с `on_demand` на статический сертификат. Проверка: новый slug через CDN —
   `200` с содержимым, NLB 10/10 — `200`, `my-furniture` — `200`, сертификат `*.host` действует
   до 09.02.2027.

**Важно при обновлении:** поля ответа `certificate`/`chainedCert` приходят без завершающего
перевода строки; склеивать их `cat` подряд нельзя — получится
`-----END CERTIFICATE----------BEGIN CERTIFICATE-----`, и Caddy отвергнет ключ. Между PEM-блоками
нужен `\n`.

**Продление.** Workflow `deploy` перед выкаткой запускает
`deploy/scripts/host-cert.mjs`: он забирает текущий сертификат из Certificate Manager и
`deploy/scripts/install-host-cert.sh` раскладывает его в `certs/host` на node-1 и node-2,
перечитывая Caddy. Шаг выполняется и в ежедневном режиме `cert`, поэтому после продления MWS
копии на origin обновляются без ручных действий; ошибка обновления не блокирует выкатку кода.
Сертификат Let's Encrypt действует 90 дней, MWS продлевает его 09.01.2027.

**Полный тест автоматизации 11.11.2026.** На обе ноды положили заведомо чужой self-signed
сертификат (только файлы, без reload Caddy), затем запустили `host-cert.mjs` и
`install-host-cert.sh` так же, как workflow. Скрипт скачал managed-сертификат, заменил файлы на
обеих нодах и перечитал Caddy: на дисках и в TLS обеих нод снова serial
`0624FC8D1A56A367ACB2FBA401271ABC1B8D`, fingerprint `69:FC:…:B6:5A`, тестовый сайт — `200`.
Само продление MWS (`renewalAt` 09.01.2027) не форсировалось, чтобы не расходовать лимит
Let's Encrypt; проверен полный путь «скачать → установить → reload» после порчи локальной копии.

Purge при публикации автоматизирован (см. ниже); HTML не кешируется (`no-cache`), ассеты
живут до TTL 1 ч. Черновики и удалённые сайты отдают 404/502 по состоянию сайта, а не из-за
отсутствия сертификата.

**Авто-purge (выкачен 11.11.2026, build `2a9a58986ced`):**

- `server/src/hosting/cdn-purge.ts` — best-effort вызов `POST /cdn/v1/projects/{project}/cacheTasks/{name}`
  с `paths: ["/*"]` после успешной публикации; ошибка только логируется и не переводит сайт в failed.
- Включается переменными `HOSTING_CDN_PURGE=1`, `HOSTING_CDN_RESOURCE=hosting`,
  `HOSTING_CDN_PROJECT=project-pimashin2015` (добавлены в `deploy/node{1,2}/docker-compose.override.yml`).
- Workflow `deploy` собрал образ `ghcr.io/misha4323223/webnestdev:sha-2a9a58986ced` и выкатил его
  на обе ноды; `/api/health` на node-1 и node-2 отдаёт `2a9a58986ced1c89deba952ad14f09e58155514c`,
  все три `HOSTING_CDN_*` видны в контейнерах. `my-furniture` через CDN — 200. **End-to-end
  11.11.2026:** CSS v1 после прогрева отдавался с `x-edge-cache-status: HIT`; после публикации v2
  задача `purge-fulltest-172315-mwce9iw6` создалась автоматически и дошла до `OK`; CDN отдал
  `fulltest-css-v2` через ~6 с (`MISS`), HTML v2 — сразу (`no-cache`). Тестовый сайт и аккаунт
  удалены.
- Ресурс общий, поэтому purge чистит кеш **всех** сайтов. Это принятый компромисс: отдельный
  ресурс на сайт не нужен, а лишний промах кеша дешевле залипшего старого ассета.
- Проверено: тест `cdn-purge.test.ts` (7/7), `tsc -p server/tsconfig.json --noEmit`; реальная
  задача `purge-my-furniture-mwbwhmxc` дошла до `OK`.

Все сайты, старые и новые, уже попадают в CDN автоматически за счёт wildcard-CNAME и одного
ресурса `hosting`; отдельный ресурс на сайт не создаётся.

Осталось: TLS на участке HAProxy ↔ PostgreSQL (меняется `db_proxy.py`: peer-цель должна идти
напрямую в `5433` с `ssl verify required`; нужны сертификаты и `hostssl` на обеих нодах) и
проверка `restore-s3` после выкатки образа с CLI-командами.

## 17. 12.11.2026: hybrid preview pilot и синхронизация node-2

- `node-2` включена, MWS: `power=ON`, `ready.state=OK`; API на обеих нодах отдаёт
  `cf0a57accbdf…`.
- Выкатка `43264347020` синхронизировала образ, `docker-compose.yml`, Caddy, сертификаты,
  runner и egress-правила на `node-2`; `node2-sync.sh` завершился с `node-2 готова`.
- PostgreSQL до аварийного прогона: `node-1` — primary (`pg_is_in_recovery=f`, read-only off),
  `node-2` — streaming standby (`pg_is_in_recovery=t`, лаг 0); после прогона роли обратные;
  после обратного прогона primary снова `node-1`, см. раздел 19. Gluster: по два brick'а на
  `data`, `sandboxes`, `sites`; storage/ownership timers активны.
- Hybrid-пилот: временный проект на `node-2`, listener в API на `node-1`; статика, `/api`,
  POST с телом, WebSocket и ошибка backend проверены через публичный preview. Подробности и
  замеры — в [`HYBRID_PREVIEW.md`](HYBRID_PREVIEW.md), раздел «Реальный пилот 12.11.2026».
- Временный проект, preview-контейнер, sandbox и тестовый аккаунт удалены; `previews.runtime=0`.
- Реальный failover с остановкой `node-1` **выполнен** 12.11.2026 после hybrid-пилота:
  `node-2` стала primary, `node-1` возвращена standby; затем обратный прогон вернул primary
  на `node-1`; сценарии и ограничения — в разделах 18–19.

## 18. 12.11.2026: аварийный failover node-1 → node-2

Проведён контролируемый отказ primary по runbook [`PRODUCTION_LAUNCH.md`](PRODUCTION_LAUNCH.md),
этапы A–C. Использовался временный аккаунт и три временных проекта; после проверки они,
их файлы, сессии и preview удалены.

### Подготовка

- Прямой SSH на `node-2` через её текущий внешний NAT (`171.22.73.93`) проверен до отказа:
  управление не зависело от `node-1`.
- Backup перед прогоном: `webnestdev/backups/postgres/webnestdev/2026/11/12/webnestdev-20261112T172954Z.dump`,
  4 738 867 байт; `MODE=check` — успешно.
- Preflight: оба контроллера active, `node-1` primary, `node-2` standby, оба API 200,
  `ALLOW_PRIMARY` нет, слот `node2` активен, лаг 0, Gluster — по два brick'а.
- Тестовый маркер `HA-E2E-A 20261112T173053Z` создан до отказа; проект `HA-E2E-A`
  (id `171202ea…`, `node-2`) и его preview были доступны через `node-1` до выключения.

### Отказ и takeover

| Событие | UTC |
| --- | --- |
| MWS power-off `node-1` | 17:31:28 |
| `node-2`: `pg_is_in_recovery()=f` | 17:32:56 |
| `node-2`: `/api/ready` = 200 | 17:33:06 |
| публичный `https://nestdev.ru/api/ready` = 200 | 17:33:27 |

RTO от команды power-off до публичного API — **119 с** (до локального API `node-2` — 98 с,
до PostgreSQL primary — 88 с). Контроллер `webnestdev-failover-node2.service` активен,
Caddy/API/runner/broker на `node-2` поднялись; MWS `node-1 power=OFF`.

RPO: маркер и проект, созданные за 35 с до отказа, сохранились; расхождений нет. NLB после
отказа продолжал отдавать публичный API через `node-2`; прямые target-статусы MWS — оба `OK`.

### Пользовательский путь

- `HA-E2E-A`: файл `.ha-e2e-marker` прочитан после takeover; старый preview был привязан к
  выключенному API `node-1` и завис, после `preview/start` на `node-2` открылся с маркером
  (`page 200`). Это ожидаемое восстановление после смены owner, а не потеря данных.
- `HA-E2E-B` создан уже на `node-2` (id `8088e1c8…`); проект, файл, терминал и preview
  работают; preview стартовал за 63 мс.
- `HA-E2E-C` создан на вернувшейся `node-1` (id `36c27e58…`), пока её локальный PostgreSQL
  был остановлен guard'ом; API `node-1` работал через HAProxy на `node-2`, preview стартовал
  за 43 мс. После рестарта API preview пришлось запустить заново — это штатное следствие
  рестарта процесса API, файлы и данные сохранились.
- Терминал проекта выполнен на обоих узлах: `pwd` = `/workspace`, код 0, файл
  `.ha-e2e-terminal*` записан и прочитан через API.

### Возврат node-1 и rejoin

- `node-1` включена в 17:35:57. Start-guard не пустил старый primary:
  `СТАРТ ЗАПРЕЩЁН: peer уже primary; локальный primary создал бы split-brain`.
- Контроллер `node-1` поднял API через HAProxy на `10.0.0.5:5432`; API `200` с 17:37:34.
- Rejoin выполнен в 17:38:16–17:38:24 (`standby.sh 10.0.0.5 5432 node1`), слот `node1`
  создан; `pg_is_in_recovery()=t`, `pg_stat_wal_receiver.status=streaming`, лаг 0 байт.
- После rejoin `archive_mode` снова оказался `off` (известное следствие `standby.sh`).
  Выполнен `webnestdev-pg-pitr setup` и рестарт PostgreSQL на `node-2`; `archive_mode=on`,
  WAL успешно заархивирован (`archived=1`, `failed=0`, `last=0000000D0000000000000047`).

### NLB и сеть

- MWS NLB `webnestdev-nlb-main`: оба target `OK` для TCP 80 и TCP 443; публичные
  `https://nestdev.ru` и `/api/ready` — 200.
- Прямая проверка Caddy с соседней ВМ (`node-2 → 10.0.0.4:443`) не работает: облачная
  защита разрешает 443 только от NLB, но не peer-to-peer. Это не признак unhealthy target;
  для приёмки использовались статусы target'ов MWS, а не прямой peer-запрос.

### Исправленные дефекты

1. `pg-pitr.sh`: установленная копия `setup` падала на `install` в саму себя; после
   обновления скрипта добавлен fallback на соседний `webnestdev-pg-pitr-s3`, чтобы S3-таймер
   включался и при запуске из `/usr/local/sbin`.
2. `pg-backup.sh`: на `node-2` не было `.env`, поэтому `docker compose` не подставлял
   обязательные переменные и backup/check падали. Добавлены `COMPOSE_ENV_FILES` и
   автоопределение `runtime.env` + `node2.env`; финальный backup и `check` прошли.
3. После rejoin потребовался PITR setup (см. выше); без него primary работал бы без
   WAL-архива.

### Финальное состояние этапов A–C (историческое)

- После прямого отказа `node-2` была primary (`pg_is_in_recovery()=f`, HAProxy →
  `127.0.0.1:5433`), `node-1` — standby (`t`, HAProxy → `10.0.0.5:5432`), оба API 200,
  оба `power=ON`. Это состояние относилось только к этапам A–C.
- Backup после очистки тестовых данных того прогона:
  `webnestdev/backups/postgres/webnestdev/2026/11/12/webnestdev-20261112T174719Z.dump`,
  4 738 836 байт; `MODE=check` — успешно, в том числе с `node-1` (проверка переносимости
  скрипта). Restore drill на `node-2` восстановил **58 таблиц**, после проверки учебная база
  удалена. PITR-таймеры active, `archive_mode=on`.
- Пользовательские данные вне временных проектов не затрагивались; тестовый аккаунт,
  проекты, sandbox-каталоги, сессии и preview удалены.

## 19. 12.11.2026: обратный отказ node-2 → node-1, storage split и выключение node-2

После этапов A–C выполнен полный обратный прогон по этапам D/E и отдельная проверка
storage-quorum. Тестовый аккаунт, проекты `REV-E2E-BASE`, `REV-E2E-D`, `REV-E2E-E`, их
sandbox-каталоги, сессии и preview после фиксации evidence удалены.

### Этап D: отказ node-2 и takeover node-1

| Событие | UTC |
| --- | --- |
| команда MWS power-off `node-2` | 17:58:33 |
| MWS подтвердил `node-2 power=OFF` | 17:59:28 |
| `node-1`: `pg_is_in_recovery()=f` | 17:59:42 |
| `node-1`: локальный API `200` | 17:59:51 |
| публичный `https://nestdev.ru/api/ready` = 200 | 17:59:51 |

RTO от начала команды power-off — **78 с**; от подтверждения `power=OFF` — **23 с**. RPO 0:
маркер `REV-E2E-BASE` и проект, созданные до отказа, сохранились; в `node-1` осталась одна
Gluster-реплика, `quorum-type` автоматически стал `none`, запись в `data`/`sandboxes`
прошла. NLB: `node-2 FAILED`, `node-1 OK`; второй primary не появился.

- `REV-E2E-BASE` (id `04774d11…`) после рестарта API открылся, preview отдал маркер.
- `REV-E2E-D` создан на `node-1`, терминал выполнился, preview открылся; проект привязан
  к `node-1`, а не только публичный health-check.
- `node-1` оставался primary и при одном brick'е; storage-guard выставил `none` без ручного
  вмешательства.

### Этап E: возврат node-2, работа через node-1 и rejoin

- MWS power-on `node-2` — 18:00:42, `power=ON` — 18:01:39. Start-guard не пустил её старый
  primary: PostgreSQL не стартовал как второй primary.
- API `node-2` поднялся через HAProxy на primary `node-1` — 200 в 18:02:22.
- `REV-E2E-E` создан на `node-2`, терминал и preview прошли; публичный трафик в это время
  шёл через NLB.
- Rejoin `node-2` выполнен 18:02:58–18:03:05: `pg_is_in_recovery()=t`,
  `pg_stat_wal_receiver.status=streaming`, лаг 0; NLB снова показывал оба target `OK`.
  После rejoin на `node-1` включён `archive_mode=on` через `webnestdev-pg-pitr setup`
  (известное следствие `standby.sh`).
- Отдельно проверен ingress через единственную `node-2`: Caddy на `node-1` кратковременно
  остановлен, публичный `/api/ready` остался `200`; затем Caddy возвращён. MWS target
  `node-2` в этом коротком окне ещё показывал `OK` из-за задержки health-статуса, поэтому
  вывод об ingress сделан по публичному ответу, а не только по статусу target'а.

### Storage-quorum при сетевом разделении

Проверена изоляция Gluster-портов между нодами (TCP 24007 и 49152–65535) в обе стороны;
SSH и PostgreSQL 5432 не блокировались. Это storage-network split, а не полная изоляция ВМ.

| Момент | Результат |
| --- | --- |
| обе стороны заблокированы, 18:17:51 | Gluster CLI: `Connection failed`; `quorum-type` остался `auto` |
| запись probe на primary | `probe_exit=124` — запись заморожена, split-brain нет |
| PostgreSQL | `node-1` — `f`, `node-2` — `t`; promotion не произошёл |
| публичный API | `200` через `node-1`; API `node-2` во время split был недоступен |
| обе стороны разблокированы, 18:18:44 | запись probe `exit=0`; оба API `200` |
| после восстановления | `quorum-type=auto` на всех трёх томах, данные читаются, split-правил нет |

Это ожидаемое поведение replica 2 без witness: при потере кворума запись блокируется, а не
уходит в split-brain. Полная сетевая изоляция всех портов не имитировалась; ограничение
«нет автоматического promotion без подтверждённого fencing» остаётся в силе.

### Peer-to-peer 443

Прямой `node-1 → 10.0.0.5:443` и `node-2 → 10.0.0.4:443` не проходят; порт 5432 при этом
открыт, а оба NLB target имеют `OK`. Это ограничение облачной защиты/NLB, а не признак
unhealthy target. Для проверки было создано явное private-правило `webnestdev-allow-peer-web`
(TCP 80/443, `10.0.0.0/24` → `10.0.0.0/24`, priority 1000): MWS показал `ready=OK`, но прямой
peer-запрос всё равно не открылся. Правило удалено (`204`), в финале остались только шесть
исходных firewall-правил. Код и NLB из-за этого не менялись.

### Финальное состояние

- `node-1` — primary: `pg_is_in_recovery()=f`, `archive_mode=on`, API `200`.
- `node-2` — перед выключением standby (`t`, `streaming`, лаг 0), затем MWS `power=OFF`;
  сейчас недоступна. NLB: `node-2 FAILED`, `node-1 OK` для TCP 80/443.
- Gluster на `node-1`: `data`/`sandboxes`/`sites` — `quorum-type=none` (единственный brick),
  все три mount'а читаются, probe-запись прошла. Это принятое ограничение режима одной ВМ.
- Публичный `https://nestdev.ru` и `/api/ready` — `200`; split-правил iptables нет.
- Тестовые данные удалены. Финальный backup:
  `webnestdev/backups/postgres/webnestdev/2026/11/12/webnestdev-20261112T182338Z.dump`,
  4 738 838 байт; `MODE=check` — успешно, возраст 0 ч.
- **Не включено в текущий режим:** failover при падении `node-1`, вторая Gluster-реплика,
  второй API-target. Для production-запуска сначала включить `node-2`, проверить standby и
  перевести primary на неё по runbook; только после этого выключать её нельзя.

## 20. 13.11.2026: локальный кэш зависимостей preview на обеих нодах

Состояние на 13.11.2026 после выкатки `c1d2d1a`: `node-1` — primary PostgreSQL, `node-2` —
streaming standby; обе ВМ включены, API/runner/брокер работают на одной сборке.
`node-2` остаётся включённой до отдельной команды пользователя.

### Где лежит кэш

- Путь на каждой ноде: `/var/lib/webnestdev/preview-cache`.
- Каталог локальный, не на Gluster; исходники проекта и `dist` по-прежнему лежат в общем
  storage. `node_modules` монтируется в контейнер как `/workspace/node_modules`.
- Владелец — uid/gid `1000:1000`, права `0775`, чтобы установка внутри контейнера не
  получала `EACCES` и Docker не создавал root-owned источник mount'а.
- Очистка: кэши без обращений дольше `WEBNESTDEV_PREVIEW_CACHE_TTL_DAYS` (по умолчанию 30
  дней) удаляются при старте и каждые 6 часов. Выключатель — `WEBNESTDEV_PREVIEW_CACHE=0`.

### Что должно быть у API, брокера и runner

| Компонент | Переменные | Mount |
| --- | --- | --- |
| API (`src-webnestdev-server-1`) | `WEBNESTDEV_PREVIEW_CACHE_DIR`, `WEBNESTDEV_PREVIEW_CACHE_HOST_DIR`, `WEBNESTDEV_PREVIEW_CACHE_TTL_DAYS` | `/var/lib/webnestdev/preview-cache` → тот же путь |
| Docker-брокер | `BROKER_PREVIEW_CACHE_ROOT` | `/var/lib/webnestdev/preview-cache` → тот же путь, read-only |
| `node1-runner` / `node2-runner` | те же три `WEBNESTDEV_PREVIEW_CACHE_*` | `/var/lib/webnestdev/preview-cache` → тот же путь, read-write |

Runner — контейнер вне compose, поэтому одного обновления образа недостаточно.
`deploy/scripts/update-runner.sh` с 13.11.2026 сам создаёт каталог (при необходимости через
`sudo -n`), добавляет bind-mount и недостающие переменные и пересоздаёт runner, даже если образ
уже совпадает. Это закрывает случай, когда API уже видел кэш, а runner создавал его внутри
своего контейнера.

### Порядок применения

1. Убедиться, что `node-1` жив и является primary PostgreSQL.
2. Включить `node-2`, дождаться SSH, standby и `node2-runner`.
3. Обновить runner сначала на `node-1`, затем на `node-2`:

```bash
# node-1
ssh node1 "IMAGE_REF='ghcr.io/misha4323223/webnestdev:sha-c1d2d1a19ccc' bash -s" \
  < deploy/scripts/update-runner.sh

# node-2 (через ProxyCommand на node-1)
ssh node2 "IMAGE_REF='ghcr.io/misha4323223/webnestdev:sha-c1d2d1a19ccc' bash -s" \
  < deploy/scripts/update-runner.sh
```

4. После runner обновить API и брокер штатным compose (на `node-2` — с её двумя env-файлами):

```bash
# node-1
cd ~/webnestdev/src && docker compose \
  -f docker-compose.yml -f docker-compose.override.yml \
  up -d --no-build --no-deps webnestdev-server docker-broker

# node-2
cd /home/ubuntu/webnestdev/src && docker compose \
  --env-file runtime.env --env-file node2.env \
  -f docker-compose.yml -f docker-compose.override.yml \
  up -d --no-build --no-deps webnestdev-server docker-broker
```

5. Проверить на каждой ноде `/api/ready` и что сборка совпадает с выкаченной.

### Проверка без вывода секретов

```bash
# bind-mount есть и указывает на локальный каталог
docker inspect node1-runner \
  --format '{{range .HostConfig.Binds}}{{println .}}{{end}}' | grep preview-cache

# имена переменных (значения не печатаем)
docker inspect node1-runner \
  --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -o '^[A-Z_]*' | grep PREVIEW_CACHE

# каталог доступен на запись внутри runner
docker exec node1-runner sh -lc 'test -w "$WEBNESTDEV_PREVIEW_CACHE_DIR" && echo cache-writable'
```

Те же команды выполнить с `node2-runner` на `node-2`. Для API и брокера проверяются их
mount'ы `preview-cache` и ключи `WEBNESTDEV_PREVIEW_CACHE_*` / `BROKER_PREVIEW_CACHE_ROOT`.

Фактическая проверка 13.11.2026: на обеих нодах runner пересоздан с bind-mount, все три
переменные присутствуют, `cache-writable` подтверждён; API и брокер имеют mount, `/api/ready`
на обеих нодах — `200`, build `c1d2d1a19cccafac3ed4d6c710a580a75f77fa67`.

Связанные документы:

- [`PRODUCTION_LAUNCH.md`](PRODUCTION_LAUNCH.md) — порядок production-запуска и проверки;
- [`CLUSTER_HA_PLAN.md`](CLUSTER_HA_PLAN.md) — целевая HA-схема;
- [`HA_BIDIRECTIONAL_PLAN.md`](HA_BIDIRECTIONAL_PLAN.md) — результаты failover;
- [`PRODUCTION_DEPLOYMENT.md`](PRODUCTION_DEPLOYMENT.md) — выкатка и Docker.
