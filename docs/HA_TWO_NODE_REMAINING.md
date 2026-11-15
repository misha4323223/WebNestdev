# Двухнодовый HA: что осталось без третьей ВМ

Этот файл — рабочий чеклист, а не второй runbook. Установка, аварийные прогоны и rejoin
описаны в [`PRODUCTION_LAUNCH.md`](PRODUCTION_LAUNCH.md), [`CLUSTER_HA_PLAN.md`](CLUSTER_HA_PLAN.md)
и [`deploy/ha/README.md`](../deploy/ha/README.md). Здесь только то, что ещё не закрыто, и
границы, чтобы не делать уже сделанное.

**Актуально на 15.11.2026, 17:20 UTC, сборка `4556b09`.** `node-1` — primary PostgreSQL,
`node-2` — streaming standby, обе ВМ включены. Проверка после выкатки: API на обеих нодах
`200`, `pg_stat_replication` — `1|0`, `archive_mode=on`, публичный
`https://nestdev.ru/api/ready` — `200`. HAProxy уже ходит в primary напрямую на `5433`, но
**TLS ещё не включён**: на обеих нодах `ssl=on` с `snakeoil`, HBA на `host`, сертификат
`pg_tls.sh` не создан. `ha-status-node-1.json` и `ha-status-node-2.json` уже пишутся.
Публичный ingress идёт через NLB, DNS при переключении не меняется.

## Уже реализовано — не дублировать

| Область | Где | Что уже есть |
| --- | --- | --- |
| Promotion/fencing/rejoin | `deploy/ha/failover.py`, `postgres.py`, `standby.sh` | Fencing через MWS, promotion только после `power=OFF`, rejoin, защита от второго primary |
| Плановый switchover | `deploy/ha/switchover.py`, `control.py` | Mailbox в общем `data/ha-switchover.json`, состояния и откат |
| Storage | `storage_quorum.py`, `storage_ready()` | Проверка всех трёх томов, Gluster quorum, повторная проверка после fencing |
| WAL/PITR | `pitr.py`, `deploy/scripts/pg-pitr*.sh` | `archive_mode` на обеих нодах, basebackup, выгрузка в S3, учебный restore |
| Инициализация схемы | `server/src/storage/init-lock.ts` | Blocking advisory-lock `webnestdev:storage-init` уже есть; не нужен второй lock |
| Базовые алерты | `server/src/health/alerts.ts` | Диск, память, swap, ошибки архивации, возраст backup, подтверждение получателя |
| Ingress | NLB + Caddy на обеих нодах | Проверено: при остановленном Caddy на `node-1` публичный домен 6/6 отдал `200` через `node-2` |
| Двусторонний отказ | `docs/PRODUCTION_STATE.md` §18–19 | Реальные power-off прогоны, RPO 0, rejoin обеих нод |

Отдельно: **witness/arbiter и кворум без третьей машины не делаем.** Это ограничение
двухнодовой схемы, а не незакрытый пункт. Для production с постоянными двумя нодами
нужен третий witness или managed storage — отдельное решение после запуска.

## Осталось

### 1. TLS на участке HAProxy ↔ PostgreSQL — код выкачен, TLS не включён

**Выкачено 15.11.2026, 17:07 UTC, сборка `4556b09`:** `deploy/ha/pg_tls.sh`, TLS-backend в
`db_proxy.py`, прямая цель peer `5433`, `sslmode=verify-full` в `standby.sh`, `hostssl` в
`pg_hba_probe.sh` и передача сертификата через `node2-sync.sh`. Локальные тесты HA и
`bash -n` проходят; на обеих нодах лежит новый runtime-код.

**Сейчас (проверено после выкатки):** API ходит в локальный HAProxy `:5432`,
HAProxy — в локальный PostgreSQL `127.0.0.1:5433` или в PostgreSQL peer напрямую на `5433`
(plaintext, без TLS). На обеих нодах `ssl=on`, но используется системный
`/etc/ssl/certs/ssl-cert-snakeoil.pem` с пустым `ssl_ca_file`; `pg_hba` остаётся на
`host`, HAProxy — без `ssl`. На `node-2` в старом `/var/lib/postgresql/tls` лежат пустые
`ca.crt`/`server.crt`; новый скрипт их не использует.

При выкатке найден и исправлен пропуск: прямому peer-маршруту нужно HBA-правило
`webnestdev` с приватного IP соседа, а не только `replicator`. Оно добавлено в
`pg_hba_probe.sh`; на `node-1` применено вручную и проверено через `/api/ready` на
`node-2`.

**Решение:** PostgreSQL `ssl=on`, самоподписанный сертификат с SAN для
`host.docker.internal`, `127.0.0.1`, `10.0.0.4`, `10.0.0.5`; HAProxy подключается к
PostgreSQL напрямую (`5433`) с `ssl verify required`; HBA переводится на `hostssl`;
репликация и rejoin идут на `5433` с `sslmode=verify-full`.

**Почему не через peer HAProxy:** иначе получается двойной TLS (клиент → HAProxy и
HAProxy → PostgreSQL) либо расшифровка на промежуточной ноде. Прямой `5433` с проверкой
сертификата — один предсказуемый участок.

**Критерий готовности:** на обеих нодах `show ssl = on`; `sslmode=require` к `5433`
работает, `sslmode=disable` — нет; `pg_stat_replication` остаётся `streaming` с лагом 0;
`/api/ready` — `200` на обеих нодах; после rejoin standby снова подключается по TLS.

**Не делать:** не включать TLS «по пути» на живой primary без проверки сертификата и
`pg_hba`; не заменять пустые файлы на `node-2` нулевыми сертификатами; не переводить HBA
на `hostssl` при `ssl=off`.

### 2. HA-наблюдаемость — выкачена и работает

**Выкачено 15.11.2026, 17:07 UTC, сборка `4556b09`:** `deploy/ha/status.py` пишет снимок
роли/лага/фазы в общий `data/ha-status-<node>.json`; `server/src/health/ha.ts` добавляет
проверки `replication`, `standby`, `controller` в существующие алерты и админ-снимок.
Локальные тесты проходят.

**Сейчас:** снимки обеих нод обновляются, `node-1` — `primary/done`, `node-2` —
`standby/passive`, `replicationStreams=1`, лаг `0`. `alerts.ts` видит лаг репликации,
отсутствие standby и состояние контроллера; `/api/admin/infra` показывает HA-пару.

**Решение:** один host-side снимок состояния (роль, LSN/лаг, `pg_stat_replication`,
`pg_stat_wal_receiver`, `archive_ready`, storage, последний tick контроллера) в общий
`data/ha-status.json`; API читает его и добавляет проверки в существующий `buildHealthChecks`,
не создавая второй планировщик писем. NLB проверять отдельным внешним монитором, а не
подменять его локальным TCP-пробингом.

**Критерий готовности:** при остановленном standby в админке и письме появляется
«нет standby/лаг», при восстановлении — «снова в норме»; состояние переживает рестарт API;
секреты и строки подключения в снимок не попадают.

### 3. Полный отказ `node-1` для domain/preview

**Сейчас:** ingress-тест с остановленным Caddy уже пройден; реальные power-off прогоны
12.11.2026 пройдены, но после последних изменений custom domains и owner-aware preview
нужен повторный целевой прогон.

**Критерий готовности:** при выключенной `node-1` `node-2` становится primary, принимает
запись; `https://nestdevtest.ru` и `www` отвечают; preview, созданный на `node-1`, либо
доступен через owner-aware дверь, либо честно показывает `ownerUnavailable`, а не ложный
`200`; после возврата `node-1` не становится вторым primary и снова принимает API.

**Не делать:** не считать остановку одного Caddy полным отказом ноды; не оставлять
`node-1` выключенной после теста без явной команды.

### 4. Миграции на двух репликах и PITR drill — проверено 15.11.2026, 17:15 UTC

**Сделано:** два процесса одновременно вызвали `initializeStorage()` на живой primary
(сборка `4556b09`). Оба завершились `init-ok`, один ждал advisory-lock; DDL выполнился
один раз, ошибок нет, `/api/ready` остался `200`.

**`restore-s3`:** последний base backup `20261115T043406Z`, 24 WAL-сегмента, целевое время
`2026-11-15 12:00:00+00`. Drill поднялся на `5544`, `pg_is_in_recovery()=f`, 18 проектов,
последнее обновление проекта `2026-11-15T11:08:55.318Z`; после проверки drill остановлен и
удалён. Перед повтором `pg_switch_wal()` был вызван штатно, чтобы открытый сегмент `4E`
попал в архив и S3; без этого restore на момент после последнего архивного WAL законно
падает «recovery ended before target».

**Критерий готовности выполнен:** конкурентный DDL безопасен; `restore-s3` восстанавливает
базу на выбранный момент, метка и число проектов совпадают.

### 5. Плановый switchover primary на `node-2`

**Сейчас:** процедура и mailbox проверены в обе стороны; текущий primary — `node-1`.
Перед production-запуском primary нужно перенести на `node-2` по
[`PRODUCTION_LAUNCH.md`](PRODUCTION_LAUNCH.md).

**Критерий готовности:** `node-2` — `pg_is_in_recovery()=f`, принимает запись; `node-1` —
standby с лагом 0 и API `200`; публичный `/api/ready` — `200`; `archive_mode=on` на новой
primary; после этого `node-2` не выключается.

## Порядок работ

1. TLS и проверка репликации (пункт 1) — код выкачен, TLS ещё не включён.
2. HA-снимок и проверки в админке/письмах (пункт 2) — выкачено и работает.
3. Целевой domain/preview failover (пункт 3) — destructive, нужно окно.
4. Конкурентный DDL и `restore-s3` (пункт 4) — проверено 15.11.2026, 17:15 UTC.
5. Плановый switchover (пункт 5) — только после 1–4, destructive.

Пункты 1–2 можно делать на включённых нодах без простоя: TLS включается на standby,
затем на primary; API переподключается через HAProxy. Пункт 3 — destructive-прогон,
его нельзя совмещать с пунктом 5.
