# Двусторонний failover node-1 ↔ node-2

Статус: **аварийный failover проверен в обе стороны 08.11.2026**, но на предыдущей версии
HA-скриптов; 10.11.2026 дополнительно проверены плановый switchover `node-1 → node-2 →
node-1`, оба rejoin и холодный старт `node-2` с текущим HA-кодом. Повторный destructive-прогон
с аварийным выключением каждой ВМ **на текущем `deploy/ha`** выполнен 10.11.2026, но
**с временным `quorum-type=none`**: обнаружены блокеры автоматического storage-quorum и
automount Gluster, поэтому чистым прохождением он не считается (см. §0.2).
Документ описывает, как превратить односторонний сценарий `node-2 → node-1` в двусторонний.
Это не замена [CLUSTER_HA_PLAN.md](CLUSTER_HA_PLAN.md): общая целевая схема и ограничения
остаются там, здесь — конкретная работа, порядок, критерии приёмки и откат.

## 0. Результаты live-тестов 08.11 и 10.11.2026

Проверено на реальных ВМ, без ручного promotion базы:

- **21:11–21:12 UTC, `node-1` → `node-2`:** `node-1` выключена через MWS; контроллер
  `node-2` увидел потерю primary, выключил `node-1` через MWS, повысил standby и поднял
  broker/API/Caddy. `/api/ready` на `node-2` ответил `200`, в базе остались 18 проектов,
  Gluster-каталоги и сайты были доступны.
- **21:15 UTC, rejoin:** `node-1` возвращена и пересоздана как standby от `node-2`;
  `pg_stat_wal_receiver=streaming`, данные и 55 таблиц совпали.
- **21:17–21:18 UTC, `node-2` → `node-1`:** `node-2` выключена; контроллер `node-1`
  выполнил fencing, повысил standby, поднял broker/API/Caddy и переключил DNS на
  `178.236.27.102`. `/api/ready` и `https://nestdev.ru` ответили `200`.
- **Текущее состояние:** `node-1` — primary, `node-2` — вторая production-нода,
  `power=OFF` только из-за стоимости до production-запуска. NLB и active-active код
  готовы; после production-решения `node-2` будет включена постоянно.

В ходе теста исправлены три реальные ошибки: MWS-имя первой ВМ (`webnestdev`, не `node-1`),
порядок запуска `docker-broker` перед API и сброс старого состояния `done` после rejoin.

### 0.1. Плановый switchover 10.11.2026

Текущий `deploy/ha` установлен на обе ВМ из рабочего дерева; прежние каталоги сохранены в
`/opt/webnestdev-ha.bak-20261110112118` (`node-1`) и `/opt/webnestdev-ha.bak-20261110112139`
(`node-2`). На обеих ВМ есть `switchover.py`, `control.py`, `HA_CONTROL_PATH` и
`HA_SWITCHOVER_TIMEOUT_SECONDS=180`, контроллеры active.

- Плановый switchover `node-1 → node-2`: `target_ready` 11:24:12 UTC,
  `source_stopped` 11:24:28, `promoted` 11:24:32. `node-2` стала primary, API/Caddy и
  запись в PostgreSQL проверены; `node-1` осталась API-узлом через `node-2`.
- Rejoin `node-1` 11:26:25 UTC: streaming standby, лаг нулевой.
- Обратный switchover `node-2 → node-1`: `target_ready` 11:27:09, `source_stopped`
  11:27:17, `promoted` 11:27:24. Primary вернулся на `node-1`.
- Rejoin `node-2` 11:28:00 UTC: standby `t`, `streaming` от `10.0.0.4`,
  `pg_stat_replication=17/main|streaming|async`.
- Холодный старт `node-2` после rejoin: автоматически поднялись PostgreSQL standby,
  failover-контроллер, broker/API/Caddy и runner; `/api/ready` и Caddy — `200`,
  `SANDBOX_RUNTIME=runsc`, `BROKER_RUNTIME=runsc`, Docker видит `runsc`.
- Публичный `https://nestdev.ru/api/ready` — `200`; после проверки `node-1` primary,
  `node-2` standby и `power=OFF` по правилу экономии до production-запуска.

Этот прогон не заменяет аварийный failover: MWS fencing и promotion после потери
primary нужно проверить отдельно в полном прогоне.

### 0.2. Повторный destructive-прогон 10.11.2026 (с тестовым обходом storage)

Выполнен на текущем `deploy/ha` с реальным MWS `power=OFF`: `node-1` выключалась, затем
возвращалась; после rejoin выключалась `node-2`. Оба контроллера на время смены роли были
остановлены, `data`/`sandboxes`/`sites` временно переведены в `cluster.quorum-type=none`,
потому что текущий код не размораживает Gluster после потери peer (дефект 1). При обоих
включённых узлах `quorum-type` вернулся в `auto`; после финального выключения `node-2`
контроллер оставил `none` как для единственного узла. Этот прогон подтверждает
fencing/promotion/API/DB, но **не подтверждает автоматический переход storage-quorum
из standby в primary**.

| Событие | `node-1` → `node-2` | `node-2` → `node-1` |
| --- | --- | --- |
| Начало MWS power-off | 13:32:29 UTC | 13:53:06 UTC |
| MWS подтвердил `power=OFF` | 13:33:43 | 13:54:34 |
| Контроллер увидел потерю primary | 13:34:07 (`suspect`) | 13:54:53 (`suspect`) |
| Fencing / promotion | 13:35:06 / 13:35:07 | 13:55:39 / 13:55:40 |
| API `/api/ready=200` | 13:35:16 | 13:55:54 (краткий `502` в 13:55:48) |
| Публичный `https://nestdev.ru` | `200` в 13:35:21 | `200` в 13:55:54 |

RTO: **1 мин 38 с** и **1 мин 20 с** от подтверждённого `power=OFF`; от начала вызова
MWS — **2 мин 52 с** и **2 мин 48 с**. RPO под записью не измерялся: перед выключением
непрерывной нагрузки не было. После обоих promotion в базе было **18 проектов и 5 сайтов**,
временная таблица принимала запись, `my-furniture.host.nestdev.ru` и
`my-sayt.host.nestdev.ru` отвечали `200`.

Возврат узлов:

- `node-1` после promotion на `node-2` не запустила PostgreSQL (start-guard), API работала
  через `node-2`; rejoin выполнен в 13:52:05, standby `t`, `streaming`, лаг нулевой.
- `node-2` после promotion на `node-1` также не запустила PostgreSQL; rejoin выполнен
  в 14:04:19, standby `t`, `streaming`, лаг нулевой.
- Финальное состояние: `node-1` primary, `node-2` standby; при обоих включённых узлах
  `quorum-type=auto`, после штатного выключения `node-2` — `none` (единственный узел),
  публичный `ready=200`; MWS `power=OFF`.

**Дефекты, найденные прогоном (не закрыты):**

1. **Storage-quorum блокирует promotion из standby.** При `cluster.quorum-type=auto`,
   выключенном peer и локальной роли standby клиент Gluster получает
   `Client-quorum is not met` и `no read subvols`; чтение `HA_CONTROL_PATH` падает с
   `Transport endpoint is not connected`. Контроллер уходит в повторяющуюся ошибку цикла
   и не доходит до promotion. Когда локальный узел уже primary, `storage_quorum` умеет
   выставить `none`; проблема именно в переходе standby → primary. Нужно переводить
   quorum в `none` после MWS `power=OFF` **до** promotion, делать control path независимым
   от общего storage и проверять реальное чтение mount, а не только `os.path.ismount`.
2. **Gluster не монтируется автоматически на `node-1` после загрузки.** Юниты
   `var-lib-webnestdev-{data,sandboxes,sites}.mount` переходят в `failed`; API стартует
   с локальными пустыми каталогами. В прогоне помогли ручные `mount -a` и перезапуск
   `broker/API/Caddy/runner`. Нужны зависимость от `glusterd` и повторное монтирование.
3. **Rejoin не создаёт replication slot.** `standby.sh` молча игнорирует ошибку создания
   слота, затем `pg_basebackup -S` падает с `replication slot "node1" does not exist`.
   Слоты `node1` и `node2` пришлось создавать вручную на текущем primary.
4. **Внешний management-IP `node-2` динамический.** MWS выдавал `111.88.128.56`, затем
   `171.22.75.81`; адрес `2.59.80.174` из старых документов уже не актуален. Штатный
   доступ — `10.0.0.5` через ProxyCommand на `node-1`, при выключенной `node-1` — текущий
   NAT из MWS API или консоль MWS.

> Пункты 1–3 закрыты 10.11.2026: quorum снимается на standby после MWS `power=OFF`,
> storage-guard перемонтирует том и освобождает его от контейнеров, `standby.sh` создаёт
> слот и больше не скрывает ошибку. Повторный destructive-прогон прошёл без ручного
> вмешательства: RTO 79 с в реверсе, RPO 0. См. `PRODUCTION_STATE.md` §12.

### 0.3. Инцидент 09.11.2026: node-2 поднялась как primary

После включения `node-2` её PostgreSQL стартовал как **primary**, а не standby: data directory
остался от прежнего promotion, `standby.signal` и корректный `primary_conninfo` отсутствовали,
а `webnestdev-failover-node2.service` после загрузки был неактивен. Я вручную запустил
`postgresql@17-main`, не проверив `pg_is_in_recovery()` до запуска. Это была моя ошибка
эксплуатации, а не следствие NLB.

Состояние было split-brain: два PostgreSQL считали себя primary. Публичного трафика на
`node-2` в тот момент не было — её NLB target был `FAILED` из-за остановленного Caddy, — но
это не оправдание: запись в обе базы могла разойтись. `node-2` сразу остановлена, пересоздана
через `standby.sh` от `node-1` и проверена как `pg_is_in_recovery()=t`; после проверки ВМ
выключена. Для ручного запуска добавлен systemd start-guard (`pg_start_guard.py`): если
data directory стартует как primary, guard сначала проверяет фактическую роль peer через
`replicator` на приватном `5433`. Peer standby — старт разрешён; peer primary — запрещён
(split-brain). Если peer недоступен, MWS `power=OFF` разрешает старт после fencing, а
`power=ON` запрещает. Прямой `pg_ctlcluster start` обходит systemd-guard; штатный путь —
`systemctl start postgresql@17-main`.

---

## 1. Что уже есть

| Слой | node-1 | node-2 |
| --- | --- | --- |
| Питание | включена | `power=OFF` после проверки 10.11; данные standby готовы к включению |
| API | `src-webnestdev-server-1` работает | остановлен вместе с ВМ; холодный старт 10.11 дал `200` |
| Caddy | работает | остановлен вместе с ВМ; холодный старт дал `200` |
| PostgreSQL | системный кластер `17/main`, порт `5433`, primary | streaming standby от `node-1` после rejoin 10.11; при выключении данные сохранены |
| HAProxy | `0.0.0.0:5432` → `127.0.0.1:5433` | установлен, настроен на `10.0.0.4:5432`; остановлен вместе с ВМ |
| NFS | выключен, заменён Gluster | NFS-клиент убран |
| Storage | GlusterFS `sandboxes/sites/data`, replica 2 | GlusterFS `sandboxes/sites/data`, replica 2 |
| HA-контроллер | `webnestdev-failover.service`, обе стороны | `webnestdev-failover-node2.service`, обе стороны |
| MWS | цель fencing — `node-2` | MWS-имя первой ВМ — `webnestdev`, не `node-1` |
| Ingress | NLB `webnestdev-nlb-main` на `178.236.27.102` | бэкенд NLB; management — динамический NAT MWS, штатный SSH через `10.0.0.5` |
| DNS | `nestdev.ru` и `*.preview` → `178.236.27.102` (NLB, не меняется) | DNS не трогаем |

Тест 08.11.2026 подтвердил оба направления. **Production-инварианты:** `node-2` постоянно
включена; обе ВМ обслуживают API/runner/preview; PostgreSQL остаётся один primary плюс один
standby; вернувшийся узел не становится primary, но сразу принимает прикладную нагрузку.
Ограничения текущего стенда: автоматического failback базы нет (возврат узла — отдельный
rejoin), третьей witness-ВМ нет. Ingress уже переведён на NLB `webnestdev-nlb-main` на
существующем `178.236.27.102`; DNS при failover не меняется.

Если после promotion на `node-2` возвращается старый primary `node-1`, start-guard не
пускает её PostgreSQL. Контроллер `node-1` видит, что локальная база недоступна, проверяет
primary peer, переводит локальный HAProxy на `node-2` и поднимает API/Caddy. Поэтому
`node-1` снова принимает пользователей как вторая API-реплика, хотя её PostgreSQL остаётся
остановленной до ручного rejoin. Если primary peer недоступен, API не поднимается.

## 2. Цель и границы

Цель: при отказе любой из двух ВМ вторая должна:

1. поднять локальный PostgreSQL и принимать записи;
2. поднять API/Caddy и отвечать по обычному адресу;
3. открыть существующие проекты, sandbox и static sites;
4. не создать второго primary;
5. после возврата старой ВМ позволить вернуть её как standby/worker без автоматического
   захвата роли.

Границы первого этапа:

- две ВМ, без третьей witness-ВМ;
- автоматический failover в обе стороны;
- **автоматический failback не делаем**: вернувшийся узел становится standby, роль обратно
  переключается только явной командой;
- split-brain при разделении сети остаётся риском; MWS fencing обязателен. Полноценный
  кворум — отдельный этап с третьей ВМ.

## 3. Ключевые ограничения

### 3.1. Storage

**До миграции** NFS на `node-1` был точкой отказа: пока `node-2` только клиент, при
выключении `node-1` проекты и сайты недоступны. Для двустороннего теста был нужен
независимый POSIX-слой. Рассматривались:

- GlusterFS replicated volume на двух ВМ (быстрее в лаборатории, но без arbiter есть риск
  split-brain);
- DRBD + NFS (ближе к блочной модели, требует модуль ядра и отдельный диск);
- managed shared filesystem (лучше для прода, если доступен у провайдера).

Выбран и поднят **GlusterFS replica 2**: тома `sandboxes`, `sites` и `data` имеют по brick
на каждой ВМ. NFS-сервер `node-1` и NFS-клиент `node-2` выключены. Полный тест `power=OFF
node-1` прошёл; остаточный риск replica 2 без arbiter — split-brain при разделении сети.

### 3.2. Ingress

`178.236.27.102` (`ea-webnestdev`) закреплён за NLB `webnestdev-nlb-main`; бэкенды —
Caddy на `node-1` и `node-2`, health check TCP 443. У `node-1` management-адрес
`2.59.83.250`; у `node-2` постоянного внешнего нет — NAT MWS меняется, штатный SSH идёт
на `10.0.0.5` через ProxyCommand на `node-1`. В DNS management-адреса не входят.

DNS на адрес конкретной ВМ не используется: при failover A-записи остаются на NLB.
`DNS_ENABLED=0` в HA-контроллере это фиксирует.

### 3.3. PostgreSQL

`node-1` — primary; `node-2` после rejoin 10.11 — streaming standby и выключена до
production-запуска. Её data directory уже содержит `standby.signal` и `primary_conninfo` на
`node-1`; холодный старт 10.11 это подтвердил, новый basebackup при неизменном primary не
нужен. После каждого switchover всё равно требуется rejoin. Нужны:

- basebackup с текущего primary;
- `standby.signal` и `primary_conninfo`;
- слот репликации и контроль лага;
- promotion только после подтверждённого fencing;
- rejoin старого primary через `pg_rewind` или полный basebackup (база небольшая,
  полный reclone проще и безопаснее).

### 3.4. Контроллер

Текущий `deploy/ha/failover.py`:

- запускается только на `node-1`;
- проверяет только `PRIMARY_PG_HOST=10.0.0.5`;
- фехтует только `node-2` (`MWS_VM_PATH` по умолчанию);
- **не переключает DNS:** A-записи постоянно указывают на NLB `178.236.27.102`;
- после promotion уходит в `done` и не делает rejoin.

Для двух сторон нужен один и тот же код с ролью, адресами peer, MWS path, локальным
публичным IP и командами запуска API/Caddy. Два экземпляра контроллера не должны одновременно
повышать базу: действовать может только узел, который является standby и видит peer
недоступным; перед promotion обязателен `power=OFF` peer.

## 4. Этапы

### Этап 0. Базовая линия и откат

- Зафиксировать текущие роли, версии, состояние контейнеров и DNS.
- Убедиться, что свежий backup PostgreSQL и копия `DATA_DIR`/`SITES_DIR` есть.
- Сохранить текущие compose/HA-конфиги в резервную папку.
- Не менять DNS и не выключать `node-1` до готовности storage и ingress.

Приёмка: есть восстанавливаемый backup, известны команды возврата, `node-2` можно выключить
без потери текущего прода.

### Этап 1. Симметричный контроллер

- Вынести общую логику в `deploy/ha/` без дублирования файлов.
- Параметры: `LOCAL_ID`, `PEER_ID`, `PEER_PG_HOST`, `PEER_PG_PORT`, `LOCAL_PUBLIC_IP`,
  `MWS_VM_PATH`, `API_CONTAINER`, `CADDY_CONTAINER`, `STORAGE_PATH`.
- Разрешить действие только если локальная база в recovery.
- Перед promotion: проверить MWS, выключить peer, дождаться `power=OFF`.
- После promotion: поднять API/Caddy, проверить `/api/ready` и запись в PostgreSQL,
  переключить DNS на локальный статический IP.
- Добавить понятные состояния и защиту от повторного promotion.
- Установка на обе ВМ, отдельные env-файлы с правами `600`.

Приёмка: на каждой ВМ контроллер запускается, видит свою роль, не действует на primary,
не пытается фехтовать при недоступном MWS, а unit-тесты покрывают выбор роли и порядок
fencing → promotion → API → DNS.

### Этап 2. PostgreSQL standby и rejoin

- Скрипт подготовки standby: остановить локальный кластер, сделать basebackup с текущего
  primary, включить recovery, запустить, проверить `pg_is_in_recovery()` и лаг.
- Скрипт rejoin: после возврата старого primary пересоздать его как standby от нового
  primary; для текущего объёма допустим полный basebackup.
- Не включать жёсткий synchronous commit на двух ВМ: при выключенном standby primary
  перестанет принимать записи.
- Проверить, что API ходит через локальный HAProxy, а не в конкретную ВМ.

Приёмка: `node-1` primary → `node-2` standby → promotion → `node-1` снова standby;
затем то же в обратную сторону; данные и число таблиц совпадают.

### Этап 3. Общий storage

- Выбрать и поднять слой (GlusterFS/DRBD/managed).
- Перенести `SANDBOX_DIR`, `SITES_DIR` и `DATA_DIR` на общий слой.
- Сохранить uid/gid 1000, права, блокировки, `rename`, `fsync`.
- ✅ Убрать NFS-сервер `node-1` как обязательную зависимость: выполнено, используется GlusterFS.
- Проверить чтение/запись проекта, preview, терминала и static site с обеих ВМ.

Приёмка: выключить `node-1`; `node-2` открывает существующий проект, запускает preview и
отдаёт сайт; после возврата `node-1` видит те же файлы.

### Этап 4. API/Caddy и ingress

- Поднять вторую API/Caddy-реплику на `node-2`.
- Настроить локальный HAProxy и `DATA_DIR` на обеих ВМ.
- Настроить NLB или статический адрес + DNS failover.
- Проверить сертификаты, cookie, WebSocket агента и preview.

Приёмка: остановка Caddy/API на `node-1` не ломает HTTPS и панель на `node-2`; после
возврата оба узла снова доступны.

### Этап 5. Тесты в две стороны

1. `node-1` primary, `node-2` standby: выключить API/Caddy на `node-1` → трафик на `node-2`.
2. `node-1` primary, `node-2` standby: `power=OFF node-1` → `node-2` primary, API, проекты.
3. Вернуть `node-1`, сделать standby, проверить отсутствие второго primary.
4. `node-2` primary: `power=OFF node-2` → `node-1` primary.
5. Вернуть `node-2` как standby.
6. Разделение сети: автоматического promotion без подтверждённого fencing быть не должно.
7. Проверить RPO/RTO, число таблиц, целостность проекта и preview.

После каждого теста: вернуть прод в исходное состояние, выключить `node-2`, подтвердить
`power=OFF`.

### Этап 6. Документация и эксплуатация

- Обновить `CLUSTER_HA_PLAN.md` фактическим состоянием и результатами тестов.
- Описать runbook: статус, promotion, rejoin, DNS, откат, аварийные логи.
- Добавить алерты на лаг, отсутствие standby, старый backup, unhealthy NLB.
- Зафиксировать ограничение: без третьей witness-ВМ автоматический failover при разделении
  сети не является полностью безопасным.

## 5. Порядок реализации

Сначала код и локальные тесты контроллера, затем настройка standby и API на `node-2`, затем
storage, затем ingress, и только после этого — полный `power=OFF node-1`. Не менять DNS и не
включать автоматическое переключение, пока не готовы backup, storage и ingress.

## 6. Откат

- Остановить новый контроллер на обеих ВМ.
- Вернуть `node-1` primary, `node-2` — standby/worker.
- Вернуть DNS на `178.236.27.102`.
- Вернуть старые compose-файлы и, при необходимости, резервные каталоги данных из
  `.pre-gluster-*`; NFS-монтирование включать только как аварийный откат.
- Выключить `node-2`, проверить `power=OFF`.

## 7. Критерии готовности

- Обе ВМ могут быть primary и standby.
- Failover в обе стороны проходит без второго primary.
- После возврата узла он не забирает роль сам.
- Проекты, preview и сайты доступны после переключения.
- Есть backup, rejoin-процедура и проверенный откат.
- Документация содержит фактическое состояние и известные ограничения.
