# WebNestDev HA runbook

Двусторонний PostgreSQL failover для `node-1` и `node-2`. Подробный план и результаты
live-теста — в [`docs/HA_BIDIRECTIONAL_PLAN.md`](../../docs/HA_BIDIRECTIONAL_PLAN.md).

Проверено 10.11.2026 на рабочей паре: текущий `switchover.py`/`control.py` установлен на
обе ВМ, плановый switchover прошёл в обе стороны (`node-1 → node-2 → node-1`), оба rejoin
дали streaming standby, холодный старт `node-2` поднял PostgreSQL standby, API, Caddy,
broker и runner без ручных команд. На 15.11.2026, 20:51 UTC `node-1` — primary, `node-2`
выключена (`power=OFF`); при включении под работу она должна подняться streaming standby.

## Роли и адреса

| Узел | MWS VM | Приватный IP | Локальный PG | API |
| --- | --- | --- | --- | --- |
| `node-1` | `webnestdev` | `10.0.0.4` | `127.0.0.1:5433` | `src-webnestdev-server-1` |
| `node-2` | `node-2` | `10.0.0.5` | `127.0.0.1:5433` | `src-webnestdev-server-1` |

Контроллер на каждом узле действует только из состояния PostgreSQL standby. Primary
пассивен в части promotion. Перед promotion он обязан получить от MWS `power=OFF` для
peer. Если MWS недоступен, promotion не выполняется.

При этом API/Caddy/runner работают **на обеих ВМ**: standby не ждёт promotion, а его API
ходит через локальный HAProxy в текущий primary. Модуль `db_proxy.py` переключает этот
HAProxy на локальный PostgreSQL только когда узел стал primary, и напрямую в PostgreSQL
peer (`:5433`) — когда узел снова standby. Поэтому вернувшаяся ВМ сразу принимает проекты
и preview, но её PostgreSQL остаётся read-only standby.

После `pg_pki.sh setup` backend HAProxy идёт с `ssl verify required` по отдельному корневому
CA, а у каждой ноды свой лист-сертификат. HAProxy 2.8 подключается к PostgreSQL 17 по
**direct TLS**, поэтому в server-строке обязателен `alpn postgresql`: без него PostgreSQL
рвёт соединение с `received direct SSL connection request without ALPN protocol negotiation
extension`, а старые пулы API могут скрывать поломку. CA и приватные ключи нод хранятся
только на `node-1`; `node2-sync.sh` передаёт на `node-2` её собственный лист и публичный CA.
API по-прежнему ходит в локальный `host.docker.internal:5432` без TLS: шифруется участок между
нодами и HAProxy ↔ PostgreSQL, а не loopback внутри одной ВМ.

Если возвращается **старый primary** после promotion на peer, его PostgreSQL намеренно
не запускается start-guard’ом. Контроллер видит, что локальная база недоступна, проверяет,
что primary peer отвечает, переключает локальный HAProxy на peer и поднимает API/Caddy.
То есть вернувшаяся ВМ снова становится вторым API-узлом и принимает пользователей через
базу текущего primary; локальная PostgreSQL остаётся остановленной до ручного rejoin.
API не поднимается, если primary peer недоступен.

## Установка

```bash
# node-1: создаёт отдельный CA и уникальные листья нод, затем ставит hostssl-правила
sudo bash deploy/ha/install-node1.sh
# node-2 (секреты mws.env/regru.env должны уже лежать в /etc/webnestdev-ha, mode 600)
# Лист node-2 появится после deploy/scripts/node2-sync.sh; без него TLS на node-2
# остаётся выключенным, а API продолжает работать через прежний plaintext.
sudo bash deploy/ha/install-node2.sh
```

**Важно:** image-deploy обновляет контейнеры приложения и **не** обновляет
`/opt/webnestdev-ha`. Выкатка через `deploy/scripts/node2-sync.sh` теперь синхронизирует
runtime-файлы из `deploy/ha/runtime-files.txt` на обе ноды и сверяет SHA-256. Если
`node-2` недоступна, выкатка по умолчанию падает; `SYNC_NODE2=0` — только осознанный
одиночный режим (например, временно выключенная вторая нода). После установки проверьте
на обеих ВМ:

```bash
test -f /opt/webnestdev-ha/switchover.py && test -f /opt/webnestdev-ha/control.py
grep -E '^Environment=HA_(CONTROL_PATH|SWITCHOVER_TIMEOUT_SECONDS)=' \
  /etc/systemd/system/webnestdev-failover*.service
# на node-1
sudo systemctl restart webnestdev-failover.service
sudo systemctl is-active webnestdev-failover.service

# на node-2
sudo systemctl restart webnestdev-failover-node2.service
sudo systemctl is-active webnestdev-failover-node2.service
```

На каждой ВМ её failover-юнит должен быть `active`, а `HA_CONTROL_PATH` — указывать на
общий `/var/lib/webnestdev/data/ha-switchover.json`. Секреты в репозиторий не добавлять.
`replication.env` создаётся на узле и копируется на второй узел только защищённым каналом.

## TLS PostgreSQL и PKI

`pg_pki.sh` создаёт отдельный корневой CA (`CN=WebNestDev PostgreSQL Root CA`) и
**уникальный** лист для каждой ноды. Корневой ключ и оба листа лежат только на `node-1`
в `/etc/webnestdev-ha/pg-pki` (`700 root`, ключи `600`); на `node-2` передаются только
публичный CA и лист/ключ самой `node-2`. Это заменяет прежний общий self-signed
сертификат, который был одновременно CA и ключом обеих нод.

Раскладка:

- `/etc/webnestdev-ha/pg-pki/ca.crt` — публичный корень; `/etc/haproxy/pg-ca.crt` — его копия
  (на время миграции — bundle старого и нового CA).
- `/etc/webnestdev-ha/pg-pki/nodes/node-N/server.crt` и `server.key` — лист ноды.
- `/etc/webnestdev-ha/pg-tls` — совместимый путь, из него `pg_tls.sh apply` раскладывает
  файлы в PostgreSQL; на `node-2` там лежит её собственный лист.
- `/etc/postgresql/17/main/tls` — рабочие файлы PostgreSQL (`server.crt`, `server.key`,
  `ca.crt`). HBA остаётся только `hostssl`.

Основные команды (на `node-1`, через `sudo`):

```bash
sudo /opt/webnestdev-ha/pg_pki.sh setup          # новая установка: CA + оба листа
sudo /opt/webnestdev-ha/pg_pki.sh migrate        # переход с общего self-signed без простоя
sudo /opt/webnestdev-ha/pg_pki.sh rotate         # новые листья с тем же CA
sudo /opt/webnestdev-ha/pg_pki.sh verify         # проверка обеих нод
sudo /opt/webnestdev-ha/pg_pki.sh status         # CA, листья, сроки, fingerprint
sudo /opt/webnestdev-ha/pg_pki.sh install-units  # systemd timer авто-ротации
```

`migrate` сначала добавляет старый и новый CA в общий trust bundle на обеих нодах,
затем заменяет лист `node-1`, потом `node-2`, и только после успешной проверки убирает
старый CA. Так ни один шаг не рвёт HAProxy, standby и API. `setup` на существующем PKI
не перезаписывает CA; `pg_tls.sh setup` при наличии `pg-pki/ca.crt` намеренно завершается
ошибкой, чтобы не вернуть общий сертификат. `pg_tls.sh apply` по-прежнему используется
`node2-sync.sh` и берёт именно `ca.crt`, а не лист.

Лист действует 90 дней, CA — 10 лет. `webnestdev-pg-tls-rotate.timer` на `node-1`
ежедневно запускает `auto-rotate`; ротация происходит, когда до истечения листа осталось
меньше 30 дней. Ротация ставит новый лист сначала на `node-1`, затем на `node-2` и
проверяет streaming/API. Если `node-2` недоступна, таймер завершится ошибкой, но
действующие сертификаты останутся валидными.

Проверка на каждой ноде:

```bash
sudo -u postgres psql -p 5433 -Atc 'show ssl'          # on
sudo -u postgres psql -p 5433 -Atc 'show ssl_cert_file'
sudo openssl verify -CAfile /etc/haproxy/pg-ca.crt \
  /etc/postgresql/17/main/tls/server.crt
openssl x509 -in /etc/postgresql/17/main/tls/server.crt -noout -subject -issuer -dates
grep -E '^[[:space:]]*(host|hostssl)[[:space:]]' \
  /etc/postgresql/17/main/pg_hba.conf
# В HAProxy server-строке должны быть ssl verify required и alpn postgresql
grep -E '^[[:space:]]*server primary' /etc/haproxy/haproxy.cfg
```

Проверка TLS с проверкой цепочки (пароль не печатать):

```bash
PGSSLMODE=verify-full PGSSLROOTCERT=/etc/haproxy/pg-ca.crt \
  psql "host=127.0.0.1 port=5433 dbname=webnestdev user=webnestdev" -c 'select 1'
```

Если лист на `node-2` ещё не пришёл, `db_proxy.py` оставляет plaintext и пишет об этом
в журнал; после `node2-sync.sh` он сам перепишет HAProxy на TLS. Не запускайте
`pg_tls.sh setup` на `node-2`: при активном PKI он откажется работать, а ручная общая
пара сломает проверку соседа. Для планового rejoin источником должен быть PostgreSQL
напрямую (`5433`), а не HAProxy (`5432`): иначе TLS заворачивается дважды.

## Проверка

```bash
# node-1
sudo systemctl status webnestdev-failover.service

# node-2
sudo systemctl status webnestdev-failover-node2.service

# на каждом узле
sudo -u postgres psql -p 5433 -d webnestdev -Atc 'select pg_is_in_recovery()'
curl -fsS http://127.0.0.1:8787/api/ready
```

## Защита ручного старта PostgreSQL

`install-node1.sh` и `install-node2.sh` ставят systemd drop-in для
`postgresql@17-main.service` и `pg_start_guard.py`. Поэтому обычный ручной запуск

```bash
sudo systemctl start postgresql@17-main
```

проходит ту же проверку, что и автоматика:

- data directory в standby (`standby.signal` есть) — старт разрешён;
- primary, а peer отвечает как standby — разрешён;
- primary, peer недоступен, но MWS подтвердил `power=OFF` peer — разрешён
  (fencing уже выполнен);
- primary, а peer отвечает как primary, включён или его питание неизвестно —
  **старт запрещён**, чтобы не получить второй primary.

Текущая цель HAProxy только пишется в лог и **не** является разрешением: старый
конфиг может смотреть в локальную базу, когда peer тоже остаётся primary.

Guard читает `/etc/webnestdev-ha/guard.env`, `mws.env` и `replication.env`. Если
`replication.env` доступен, он сначала спрашивает фактическую роль peer через
`replicator` на приватном `5433`: peer standby — локальный primary разрешён, peer
primary — запрещён. Для этого `pg_hba_probe.sh` добавляет на каждом узле узкое
правило `hostssl postgres replicator <peer>/32` (или `host`, пока сертификата ещё
нет); оно даёт только чтение `pg_is_in_recovery()`, без доступа к данным. Если peer недоступен, используется
MWS: `power=OFF` разрешает старт после fencing, `power=ON` — запрещает.

Аварийный обход — только осознанно: создать `/etc/webnestdev-ha/ALLOW_PRIMARY`,
запустить PostgreSQL и сразу удалить файл. Прямой вызов `pg_ctlcluster start`
обходит systemd-guard; используйте `systemctl`.

## Плановый switchover: освободить node-1

Админ-API пишет запрос в общий `data/ha-switchover.json` (`HA_CONTROL_PATH`). Контроллеры
обоих узлов обрабатывают его отдельно от аварийного failover и **не вызывают MWS fencing**:
источник жив и должен остаться вторым API-узлом.

Последовательность:

1. target проверяет, что он streaming standby, и публикует `replayLsn` (`target_ready`);
2. source ждёт догоняния WAL, останавливает только API, ещё раз сверяет LSN и останавливает
   локальный PostgreSQL (`source_stopped`);
3. target повышает PostgreSQL, поднимает API/Caddy/runner и публикует `promoted`;
4. source на следующем тике видит `promoted`, переключает HAProxy на target и снова поднимает
   API/Caddy. Проекты и preview продолжают запускаться на `node-1`, но его PostgreSQL выключен;
5. вернуть PostgreSQL `node-1` в роли primary можно только через rejoin standby и явное
   переключение — автоматического failback нет.

Состояния: `requested`, `target_ready`, `source_stopped`, `promoted`, `failed`, `rolled_back`.
На время первых трёх обычный failover-цикл приостановлен. При `failed` источник, у которого
PostgreSQL уже остановлен, пытается запустить его обратно через systemd-guard и переходит в
`rolled_back`; если target уже успел стать primary, guard не даст второго primary.

API: `GET /api/admin/nodes/switchover`, `POST /api/admin/nodes/:id/switchover` с телом
`{"confirm":true}`. Питание: `GET /api/admin/nodes/:id/power`, `POST` только с
`{"action":"on","confirm":true}`. Выключение ВМ через API не предусмотрено.

## WAL-архив после promotion и rejoin

Контроллер сам готовит архив на standby до promotion и проверяет его на primary
после promotion. Используется уже установленный `/usr/local/sbin/webnestdev-pg-pitr`:
модуль `pitr.py` не дублирует `ALTER SYSTEM`, а вызывает `webnestdev-pg-pitr setup`.

- на standby при выключенном `archive_mode` выполняется `setup`, затем один
  перезапуск `postgresql@17-main` через systemd; повторные перезапуски не делаются;
- на primary `archive_mode` проверяется после каждого promotion; если он всё ещё
  выключен, в журнал пишется явная ошибка, но primary не перезапускается;
- `PG_PITR_BIN` переопределяет путь к установленному скрипту;
- если `webnestdev-pg-pitr` отсутствует, контроллер пишет ошибку и не пытается
  угадывать настройки.

Проверка на узле:

```bash
sudo -u postgres psql -p 5433 -Atc 'show archive_mode; show archive_command;'
systemctl is-active webnestdev-pg-basebackup.timer webnestdev-pg-wal-prune.timer
```

## HA-статус для API

Контроллер на каждом узле пишет `data/ha-status-<node>.json` (`status.py`) с ролью,
лагом `pg_stat_replication`, статусом WAL receiver, фазой и свежестью. API читает оба
файла из общего `data/` через `server/src/health/ha.ts` и добавляет в письма/админку
три проверки: `replication`, `standby`, `controller`. Если файлов нет (обычный dev или
не-HA установка), проверки не добавляются.

Снимок обновляется на каждом тике контроллера (5 секунд). Пропавший или устаревший файл
считается деградацией, а не «всё хорошо». Секретов в снимке нет.

## Rejoin вернувшегося узла

После promotion старого primary его нельзя запускать как primary. Узел уже может
обслуживать API через peer (см. выше), но его PostgreSQL нужно пересоздать как standby.
На вернувшемся узле:

```bash
# node-1 возвращается как standby от node-2
sudo bash -c '
  set -a; . /etc/webnestdev-ha/replication.env; set +a
  PGPASSWORD="$REPLICATION_PASSWORD" bash /opt/webnestdev-ha/standby.sh \
    10.0.0.5 5433 node1
'

# node-2 возвращается как standby от node-1
sudo bash -c '
  set -a; . /etc/webnestdev-ha/replication.env; set +a
  PGPASSWORD="$REPLICATION_PASSWORD" bash /opt/webnestdev-ha/standby.sh \
    10.0.0.4 5433 node2
'
```

Скрипт сохраняет старый data directory, делает basebackup и запускает standby. После rejoin
контроллер автоматически сбрасывает старое состояние `done` в `passive`.

После планового switchover на `node-1` уже работает API/runner, но PostgreSQL остановлен;
rejoin нужен, только если `node-1` снова должна стать primary или полноценным standby для
следующего переключения. На проверке 10.11.2026 после каждого switchover выполнялся rejoin,
чтобы оба узла закончили в состоянии `streaming standby` и следующий холодный старт был
предсказуемым. Если `replication.env` недоступен, штатный `standby.sh` требует `PGPASSWORD`;
не подставляйте пароль в argv и не печатайте его.

## Storage

`sandboxes`, `sites` и `data` — GlusterFS replica 2, по brick на каждой ВМ. NFS больше не
используется. При выключенной второй ВМ GlusterFS работает, но остаётся риск split-brain
без arbiter; для production нужен третий witness/arbiter или managed shared filesystem.
До его появления запись через разделённую сеть должна блокироваться кворумом Gluster, а
не «лечиться» повышением второго primary.

**Исправлено и проверено 10.11.2026:**

- `storage_quorum.desired()` снимает кворум (`none`) и на standby, как только MWS подтвердил
  `power=OFF` peer'а. Раньше standby возвращал `None`, кворум оставался `auto`, и promotion
  упирался в `no read subvols`. Если peer включён или MWS недоступен — остаётся `auto`.
- `storage_quorum.ensure()` теперь возвращает результат и проверяет значение после `set`.
  Ошибка `gluster volume set` больше не теряется: promotion ждёт успешного quorum на всех
  трёх томах.
- `control.read()` превращает `Transport endpoint is not connected` в понятную ошибку и
  приостанавливает failover, а `failover.storage_ready()` проверяет **все** тома из
  `HA_STORAGE_PATHS` (по умолчанию `data`, `sandboxes`, `sites`), тип моунта и реальное
  чтение каталога, а не только `ismount`. Проверить все три можно так:

  ```bash
  for path in /var/lib/webnestdev/{data,sandboxes,sites}; do
    mountpoint -q "$path" && findmnt -no FSTYPE --target "$path" || echo "НЕ СМОНТИРОВАН: $path"
  done
  sudo gluster volume get sandboxes cluster.quorum-type
  ```

  В юнитах задан `HA_STORAGE_PATHS=/var/lib/webnestdev/data,/var/lib/webnestdev/sandboxes,/var/lib/webnestdev/sites`;
  старый `HA_STORAGE_PATH` больше не используется для promotion-проверки.
- `install-storage-guard.sh` ставит `webnestdev-storage.{service,timer}`: монтирование через
  systemd-юниты (а не `mount(8)`), проверка чтения с `timeout`, а при мёртвом FUSE-моунте —
  остановка держащих его контейнеров, перемонт и их запуск. При загрузке юнит идёт
  `Before=docker.service`; в fstab добавлен `nofail`.
- `standby.sh` больше не подавляет ошибку слота: проверяет, создаёт и падает явно. `.pgpass`
  использует базу `*`, иначе проверка слота в `postgres` шла без пароля.
- `webnestdev-sandbox-ownership.timer` обходит дерево проекта рекурсивно (включая
  `node_modules`) и возвращает чужим элементам uid/gid 1000. С 17.11.2026 он проверяет оба
  корня: общий `SANDBOX_DIR` и локальный `WEBNESTDEV_LOCAL_WORKSPACE_DIR` (по умолчанию
  `/var/lib/webnestdev/workspaces`). Раньше обходился только `SANDBOX_DIR`, поэтому проекты в
  `local`-режиме оставались с `root:root` в `node_modules`: `npm install` падал с
  `EACCES ... unlink .../node_modules/...`, а API писал `EPERM` на `chmod`. Символические
  ссылки в `node_modules/.bin` меняются через `chown -h`, чтобы не затронуть цель ссылки.
  На живой базе 10.11.2026 так исправлено 58 вложенных элементов в двух проектах. Ручной запуск на ВМ:
  `sudo systemctl start webnestdev-sandbox-ownership.service`; из внешней админки —
  `POST /api/admin/projects/:id/permissions` (появится в проде со следующей сборкой образа).

Результат destructive-прогона: `node-1 → node-2` — quorum `none`, PG primary 15:00:43, API
`200` 15:00:53 без ручного обхода кворума; `node-2 → node-1` — публичный `200` через **79 с**
(RTO), RPO = 0 подтверждённых записей в обоих направлениях, оба rejoin — streaming standby
со слотами, созданными `standby.sh`. Подробности — в
[`../docs/PRODUCTION_STATE.md`](../docs/PRODUCTION_STATE.md) §12.

## Важно

- Автоматического failback базы нет: роль возвращается только через rejoin + явное переключение.
  Failover в обе стороны автоматический, но возврат старого primary — ручной rejoin.
- `node-2` — вторая production-нода, а не тестовая ВМ. 10.11.2026 она оставлена включённой
  по решению пользователя: HAProxy, API/Caddy/runner, guard и standby PostgreSQL на ней
  установлены и проверены.
- Пока нет третьего witness, внезапная потеря standby-ВМ при живом primary может оставить
  GlusterFS в quorum `auto` и заморозить запись до MWS-подтверждения её `power=OFF`.
  Для production с постоянной второй ВМ нужен witness/arbiter или fencing со стороны primary.
- Один стабильный ingress — NLB `webnestdev-nlb-main` на **уже существующем** статическом
  адресе `ea-webnestdev` (`178.236.27.102`), на который смотрит REG.RU. Бэкенды — Caddy
  на `10.0.0.4` и `10.0.0.5`; health check TCP 443. DNS при failover не меняется.
  У `node-1` management-адрес `2.59.83.250`; у `node-2` постоянного внешнего нет — NAT MWS
  меняется, штатный SSH идёт на `10.0.0.5` через ProxyCommand на `node-1`; в DNS их нет.
  В HA-контроллере стоит `DNS_ENABLED=0`, чтобы REG.RU не переключался на адрес ВМ.
