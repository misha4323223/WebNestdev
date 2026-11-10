# Состояние production и оперативная память

Дата среза: **10.11.2026**. Документ фиксирует факты, которые нельзя терять между
сессиями. Секреты здесь не хранятся: только имена переменных, пути и способы проверки.

## 1. Роли ВМ

| ВМ | Роль | Адрес | Текущее питание |
| --- | --- | --- | --- |
| `node-1` | production primary: API, Caddy, HAProxy, PostgreSQL, `node1-runner` | `10.0.0.4`, management `2.59.83.250` | `ON` |
| `node-2` | вторая production-нода: API/Caddy/runner, PostgreSQL standby, общий storage | `10.0.0.5`; внешний NAT динамический (10.11.2026: `111.88.131.185`), читать из MWS API | `ON` — по решению пользователя оставлена включённой |

`node-2` — **не тестовая и не одноразовая машина**. Это вторая нода production-контура.
10.11.2026 пользователь разрешил оставить её включённой; после production-запуска она
работает постоянно. Её PostgreSQL, storage, runner и env-файлы — production-конфигурация,
а не тестовая заготовка.

Правило работы:

1. `node-2` сейчас остаётся включённой — это указание пользователя, а не временный тестовый
   режим.
2. Довести задачу до конца, не выключая ВМ в середине.
3. Вернуть прод в исходное состояние.
4. Питание менять только по явной просьбе пользователя; выключение — с проверкой MWS
   `power=OFF`.
5. После production-HA — постоянно включена.

Пока `node-2` выключена (если её когда-то выключат), production не должен зависеть от её
базы или storage как от единственного экземпляра.

## 2. Текущая production-сборка

- Публичный адрес: `https://nestdev.ru`.
- `GET /api/ready` отвечает `ok:true`.
- Базовая работающая сборка: `30b7bf876c1e83a3f92d26e3ff0a1d2727fd0fd9`.
- Образ в GHCR: `ghcr.io/misha4323223/webnestdev:sha-30b7bf876c1e`.
- С 10.11.2026 обе ВМ работают на локальном hotfix-образе
  `webnestdev:preview-owner-20261110`, собранном `FROM` базового образа с исправлением
  cross-replica preview (см. §10). Это временный образ до сборки исправления в CI; тег
  `WEBNESTDEV_BUILD` внутри него по-прежнему `30b7bf876c1e`.
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

- GitHub Actions сейчас деплоит `node-1`; `node-2` автоматически не деплоится.
- Полный деплой на `node-2` требует отдельного запуска `vm-deploy.sh` на ней.
- `MODE=token` и `MODE=pg-password` только пишут env и не перезапускают сервис.
- `MODE=image` — полная выкатка образа; не использовать его только ради env-синхронизации.
- В image-режиме на `node-1` токен runner синхронизируется автоматически.
- Для `node-2` учитывать её отдельные env-файлы из раздела 3.
- **Image-deploy не обновляет HA-скрипты.** `/opt/webnestdev-ha` ставится отдельно через
  `deploy/ha/install-node1.sh` и `install-node2.sh`. Если на ВМ остался старый checkout,
  установка из него вернёт контроллер без `switchover.py`/`control.py`. После изменений в
  `deploy/ha` скопировать актуальный каталог на обе ВМ и перезапустить оба failover-юнита;
  проверка — раздел 11.

## 7. Что проверять после работ с `node-2`

1. MWS: `status.hardware.power=OFF`, если production-HA ещё не запущен.
2. SSH к `10.0.0.5` не отвечает после выключения.
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

- `node-2` обновлена до production-образа `ghcr.io/misha4323223/webnestdev:sha-30b7bf876c1e`
  (build `30b7bf876c1e83a3f92d26e3ff0a1d2727fd0fd9`); API и `node2-runner` отвечают,
  PostgreSQL — streaming standby от `10.0.0.4`.
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

Связанные документы:

- [`PRODUCTION_LAUNCH.md`](PRODUCTION_LAUNCH.md) — порядок production-запуска и проверки;
- [`CLUSTER_HA_PLAN.md`](CLUSTER_HA_PLAN.md) — целевая HA-схема;
- [`HA_BIDIRECTIONAL_PLAN.md`](HA_BIDIRECTIONAL_PLAN.md) — результаты failover;
- [`PRODUCTION_DEPLOYMENT.md`](PRODUCTION_DEPLOYMENT.md) — выкатка и Docker.
