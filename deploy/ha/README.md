# WebNestDev HA runbook

Двусторонний PostgreSQL failover для `node-1` и `node-2`. Подробный план и результаты
live-теста — в [`docs/HA_BIDIRECTIONAL_PLAN.md`](../../docs/HA_BIDIRECTIONAL_PLAN.md).

Проверено 10.11.2026 на рабочей паре: текущий `switchover.py`/`control.py` установлен на
обе ВМ, плановый switchover прошёл в обе стороны (`node-1 → node-2 → node-1`), оба rejoin
дали streaming standby, холодный старт `node-2` поднял PostgreSQL standby, API, Caddy,
broker и runner без ручных команд. После проверки `node-1` — primary, `node-2` — standby и
выключена до production-запуска.

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
HAProxy на локальный PostgreSQL только когда узел стал primary, и на HAProxy peer — когда
узел снова standby. Поэтому вернувшаяся ВМ сразу принимает проекты и preview, но её
PostgreSQL остаётся read-only standby.

Если возвращается **старый primary** после promotion на peer, его PostgreSQL намеренно
не запускается start-guard’ом. Контроллер видит, что локальная база недоступна, проверяет,
что primary peer отвечает, переключает локальный HAProxy на peer и поднимает API/Caddy.
То есть вернувшаяся ВМ снова становится вторым API-узлом и принимает пользователей через
базу текущего primary; локальная PostgreSQL остаётся остановленной до ручного rejoin.
API не поднимается, если primary peer недоступен.

## Установка

```bash
# node-1
sudo bash deploy/ha/install-node1.sh
# node-2 (секреты mws.env/regru.env должны уже лежать в /etc/webnestdev-ha, mode 600)
sudo bash deploy/ha/install-node2.sh
```

**Важно:** image-deploy обновляет только контейнеры приложения и **не** обновляет
`/opt/webnestdev-ha`. Если checkout на ВМ старый, установка «из него» вернёт старый
контроллер без `switchover.py`. Перед установкой скопируйте актуальный каталог `deploy/ha`
из рабочего дерева/релиза на ВМ и запускайте installer из этой копии. После установки
проверьте на обеих ВМ:

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
правило `host postgres replicator <peer>/32`; оно даёт только чтение
`pg_is_in_recovery()`, без доступа к данным. Если peer недоступен, используется
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

## Rejoin вернувшегося узла

После promotion старого primary его нельзя запускать как primary. Узел уже может
обслуживать API через peer (см. выше), но его PostgreSQL нужно пересоздать как standby.
На вернувшемся узле:

```bash
# node-1 возвращается как standby от node-2
sudo bash -c '
  set -a; . /etc/webnestdev-ha/replication.env; set +a
  PGPASSWORD="$REPLICATION_PASSWORD" bash /opt/webnestdev-ha/standby.sh \
    10.0.0.5 5432 node1
'

# node-2 возвращается как standby от node-1
sudo bash -c '
  set -a; . /etc/webnestdev-ha/replication.env; set +a
  PGPASSWORD="$REPLICATION_PASSWORD" bash /opt/webnestdev-ha/standby.sh \
    10.0.0.4 5432 node2
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

## Важно

- Автоматического failback базы нет: роль возвращается только через rejoin + явное переключение.
  Failover в обе стороны автоматический, но возврат старого primary — ручной rejoin.
- `node-2` — вторая production-нода, а не тестовая ВМ. После проверки 10.11.2026 она
  выключена (`power=OFF`) только из-за стоимости до production-запуска. HAProxy, API/Caddy/runner,
  guard и standby PostgreSQL на ней установлены и проверены; после production-решения она
  работает постоянно.
- Пока нет третьего witness, внезапная потеря standby-ВМ при живом primary может оставить
  GlusterFS в quorum `auto` и заморозить запись до MWS-подтверждения её `power=OFF`.
  Для production с постоянной второй ВМ нужен witness/arbiter или fencing со стороны primary.
- Один стабильный ingress — NLB `webnestdev-nlb-main` на **уже существующем** статическом
  адресе `ea-webnestdev` (`178.236.27.102`), на который смотрит REG.RU. Бэкенды — Caddy
  на `10.0.0.4` и `10.0.0.5`; health check TCP 443. DNS при failover не меняется.
  У `node-1` management-адрес `2.59.83.250`, у `node-2` — `2.59.80.174`; в DNS их нет.
  В HA-контроллере стоит `DNS_ENABLED=0`, чтобы REG.RU не переключался на адрес ВМ.
