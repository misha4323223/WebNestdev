# Двухнодовый HA: что осталось без третьей ВМ

Этот файл — рабочий чеклист, а не второй runbook. Установка, аварийные прогоны и rejoin
описаны в [`PRODUCTION_LAUNCH.md`](PRODUCTION_LAUNCH.md), [`CLUSTER_HA_PLAN.md`](CLUSTER_HA_PLAN.md)
и [`deploy/ha/README.md`](../deploy/ha/README.md). Здесь только то, что ещё не закрыто, и
границы, чтобы не делать уже сделанное.

**Актуально на 22.11.2026, 07:35 UTC, сборка `d7c491b`; runtime `db_proxy.py` с ALPN
установлен на обе ноды.** PostgreSQL TLS работает на отдельном CA и уникальных сертификатах
нод; подробности — [`PG_PKI_2026-11-22.md`](PG_PKI_2026-11-22.md). `node-1` — primary PostgreSQL, `node-2` — streaming standby;
оба API и публичный `https://nestdev.ru/api/ready` — `200`, `pg_stat_replication` —
`streaming`, лаг близок к нулю, `archive_mode=on`. На обеих нодах `ssl=on`, HBA — только
`hostssl`, HAProxy ходит в PostgreSQL по TLS 1.3 с проверкой CA, standby — `sslmode=verify-full`.
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

## Осталось и текущее состояние

### 1. TLS на участке HAProxy ↔ PostgreSQL — включён 21.11.2026, PKI — 22.11.2026

**21.11.2026, 22:08 UTC.** TLS включён на живой паре. **22.11.2026, 07:33 UTC** общий
самоподписанный сертификат заменён на отдельный CA и уникальные листья нод (`pg_pki.sh`):
CA и ключи — только на `node-1`, на `node-2` — её лист и публичный CA; `server.key` — `600`,
PostgreSQL использует копии в `/etc/postgresql/17/main/tls`. На обеих нодах `ssl=on`,
`ssl_cert_file` указывает на лист своей ноды, `pg_hba` содержит **8 правил `hostssl` и 0
правил `host`**.

HAProxy на обеих нодах ходит в PostgreSQL напрямую на `5433` с проверкой CA. Ключевая
деталь: PostgreSQL 17 принимает direct TLS только с ALPN `postgresql`; HAProxy 2.8
открывает TLS сразу, без `SSLRequest`, поэтому backend-строка обязана содержать
`alpn postgresql`. Без этого PostgreSQL рвёт новые соединения с сообщением
`received direct SSL connection request without ALPN protocol negotiation extension`, а
старые пулы API ещё какое-то время работают — это опасное ложное «всё хорошо». Фикс внесён
в `deploy/ha/db_proxy.py` и проверен на обеих нодах.

`node-2` подключён к `node-1` с `sslmode=verify-full sslrootcert=/etc/postgresql/17/main/tls/ca.crt`;
`pg_stat_replication` — `streaming`, лаг близок к нулю. API после принудительного пересоздания
пулов на обеих нодах — `200`; все соединения приложения к `webnestdev` имеют `ssl=true`
(TLS 1.3). Прямое `sslmode=disable` к `5433` отклоняется, `sslmode=require` доходит до
authentication, `sslmode=verify-full` проверяет цепочку.

**Закрыто 22.11.2026:** общий self-signed сертификат заменён на PKI; `pg_pki.sh migrate`
прошёл на живой паре без простоя, `rotate` и `auto-rotate` проверены, старый CA удалён из
trust bundle. Остаются отдельные задачи: KMS/HSM и защищённый off-site backup CA-ключа
(скрипт и workflow добавлены, первый backup/restore drill ещё не выполнены).
При плановом rejoin использовать `standby.sh` с `PG_TLS_CA`; он выставляет `sslmode=verify-full`
автоматически. `pg_tls.sh setup` при активном PKI блокируется; на `node-2` не создавать
вторую общую пару.

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

1. TLS, отдельный PKI, ротация и проверка репликации (пункт 1) — **закрыто 21.11.2026,
   22:08 UTC; PKI и ротация — 22.11.2026, 07:33 UTC**.
2. HA-снимок и проверки в админке/письмах (пункт 2) — выкачено и работает.
3. Целевой domain/preview failover (пункт 3) — destructive, нужно окно.
4. Конкурентный DDL и `restore-s3` (пункт 4) — проверено 15.11.2026, 17:15 UTC.
5. Плановый switchover (пункт 5) — только после 1–4, destructive.

Пункты 1–2 можно делать на включённых нодах без простоя: TLS включается на standby,
затем на primary; API переподключается через HAProxy. Пункт 3 — destructive-прогон,
его нельзя совмещать с пунктом 5.
