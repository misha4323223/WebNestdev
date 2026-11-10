# Запуск в продакшен: HA и проверка восстановленных узлов

Статус: **чеклист к исполнению, частично прогнан 10.11.2026**. Плановый switchover в обе
стороны через `control.py`, оба rejoin и холодный старт `node-2` с текущим HA-кодом уже
проверены. Аварийные этапы B/D (выключение ВМ с MWS fencing), живой admin endpoint
switchover, полный пользовательский E2E на каждом восстановленном узле, NLB targets,
backup/restore drill и RTO/RPO ещё не прогонялись.
Документ фиксирует, что нужно проверить до production-запуска второй ВМ и какие
пользовательские сценарии должны работать после каждого восстановления.

Связанные документы:

- [`PRODUCTION_STATE.md`](PRODUCTION_STATE.md) — текущее состояние ВМ, env, токенов и PG-пароля;
- [`HA_BIDIRECTIONAL_PLAN.md`](HA_BIDIRECTIONAL_PLAN.md) — архитектура и результаты
  прошлых failover-тестов;
- [`CLUSTER_HA_PLAN.md`](CLUSTER_HA_PLAN.md) — целевая схема, ограничения и матрица проверок;
- [`deploy/ha/README.md`](../deploy/ha/README.md) — установка контроллера, start-guard и rejoin;
- [`PRODUCTION_DEPLOYMENT.md`](PRODUCTION_DEPLOYMENT.md) — выкатка, Docker, preview и health;
- [`POSTGRES_BACKUP.md`](POSTGRES_BACKUP.md) — backup и restore drill.

## 1. Что считается успехом

Запуск разрешён только если **все** пункты ниже подтверждены на тестовом аккаунте:

1. Падение `node-1` → `node-2` становится primary, поднимает API/Caddy, принимает записи.
2. Возврат `node-1` → она не становится вторым primary, но поднимает API и принимает
   пользователей через базу `node-2`; затем rejoin делает её standby.
3. Падение `node-2` → `node-1` становится primary и принимает записи.
4. Возврат `node-2` → она не становится вторым primary, но поднимает API и принимает
   пользователей через базу `node-1`; затем rejoin делает её standby.
5. На **каждом восстановленном узле** через публичный NLB работают:
   - создание нового проекта;
   - терминал проекта (команда выполняется и пишет файл);
   - preview проекта (страница открывается и отдаёт ожидаемый маркер).
6. В каждый момент ровно один PostgreSQL primary; нет `ALLOW_PRIMARY`, нет двух
   `pg_is_in_recovery() = f`.
7. Данные тестового проекта переживают оба переключения: проект, файл из терминала и
   preview не теряются.
8. NLB имеет ожидаемые healthy targets; публичный `https://nestdev.ru` и `/api/ready`
   отвечают `200` без изменения DNS.
9. RTO/RPO записаны, отклонений и незапланированных записей в старую базу нет.

Если хотя бы один пункт не выполнен — **production-запуск не начинается**.

## 2. Границы и безопасность прогона

- Это тест на тестовом аккаунте и тестовых проектах. Не использовать боевые проекты
  для разрушающих действий.
- Прогон выполняется в отдельное окно. На это время лучше предупредить пользователей:
  возможны короткие разрывы WebSocket, терминала и preview.
- Перед началом — свежий backup и проверенный restore drill. Без backup тест не начинать.
- `node-2` — вторая production-ВМ, а не тестовая. Сейчас она выключена из-за стоимости
  до запуска production-HA. Для прогона её нужно включить; после прогона, если production
  ещё не объявлен, **выключить и подтвердить `power=OFF`**. В production она остаётся
  включённой постоянно.
- Не создавать `/etc/webnestdev-ha/ALLOW_PRIMARY` и не запускать PostgreSQL вручную через
  `pg_ctlcluster start`: это обходит start-guard. Штатный путь —
  `systemctl start postgresql@17-main`.
- Не читать и не печатать `.env`, пароли репликации и ключи MWS. В командах ниже пароль
  передаётся только через переменную окружения.
- Не делать `power=OFF` для обеих ВМ одновременно. Не выключать узел, который в этот
  момент является единственным healthy backend NLB.

## 3. Исходная топология

| Компонент | `node-1` | `node-2` |
| --- | --- | --- |
| MWS VM | `webnestdev` | `node-2` |
| Приватный IP | `10.0.0.4` | `10.0.0.5` |
| Management/SSH | `2.59.83.250` | `2.59.80.174` |
| PostgreSQL | `17/main`, локально `5433` | `17/main`, локально `5433` |
| API | `src-webnestdev-server-1` | `src-webnestdev-server-1` |
| Caddy | `src-caddy-1` | `src-caddy-1` |
| HAProxy | `:5432` → текущий primary | `:5432` → текущий primary |
| HA-контроллер | `webnestdev-failover.service` | `webnestdev-failover-node2.service` |
| NLB | `webnestdev-nlb-main`, backend `10.0.0.4` | backend `10.0.0.5` |

Публичный вход — `https://nestdev.ru` → `178.236.27.102` → NLB. DNS при переключении
не меняется. PostgreSQL primary — ровно один; второй узел streaming standby.

Перед прогоном `node-2` должна быть включена, но это ещё не production-решение: после
работ её состояние возвращается по правилу экономии до production-запуска, если запуск
не состоялся.

## 4. Подготовка

### 4.1. Доступы и инструменты

Понадобятся:

- MWS Console: питание ВМ и target statuses NLB;
- SSH на обе ВМ (management-адреса выше). Ниже используются алиасы `node1` и
  `node2`; если их нет, настройте SSH config на эти адреса. Ключи и пароли в
  репозиторий не добавлять;
- панель `https://nestdev.ru`;
- тестовый аккаунт с правом создавать проекты и запускать preview;
- административный доступ к панели для проверки `GET /api/admin/nodes` и, при
  необходимости, переноса pin проекта.

Не использовать production-аккаунт владельца платформы для тестовых проектов.

**Отдельный доступ к `node-2` после падения `node-1`.** Штатный SSH к `node-2` идёт
через `node-1` (ProxyCommand), поэтому после выключения `node-1` этот путь исчезает.
После включения `node-2` (раздел 4.2) обязательно проверьте независимый доступ к ней:
management-адрес `2.59.80.174` напрямую или консоль MWS (VNC/serial). Если ни один способ не работает,
двухмашинный тест начинать нельзя: вы не сможете проверить `node-2` после отказа
`node-1`.

### 4.2. Включить `node-2`, если она выключена

Если `node-2` сейчас `power=OFF`:

1. Включить её в MWS Console и дождаться SSH.
2. Дождаться, пока `webnestdev-failover-node2.service` станет `active`, а PostgreSQL —
   standby (`pg_is_in_recovery()=t`).
3. Убедиться, что `node-2` не смотрит в базу, которую собираются выключать: её HAProxy
   должен указывать на текущий primary `node-1`.
4. Проверить, что прод не использует `node-2` как единственное хранилище или
   единственную базу. Общие тома GlusterFS должны быть видны обоим узлам.

После работ, если production ещё не объявлен, `node-2` выключается из-за стоимости; см. этап F.

### 4.2.1. Синхронизировать runner-токен на `node-2`

API и runner должны использовать один и тот же `RUNNER_TOKEN`. На `node-1` он уже
лежит в `.env`; на `node-2` compose использует **не `.env`**, а два файла:

- `runtime.env`
- `node2.env`

Это видно по метке контейнера `com.docker.compose.project.environment_file`. Не создавать
пустой `.env` и не копировать `.env.bak`: остальные настройки `node-2` уже лежат в её
compose env-файлах, включая `NODE2_PG_PASSWORD`.

Для синхронизации используется режим `MODE=token` в `deploy/scripts/vm-deploy.sh`. Он
читает `RUNNER_TOKEN` из контейнера `node2-runner` и записывает его как
`WEBNESTDEV_RUNNER_TOKEN` и `NODE1_RUNNER_TOKEN`, **не перезапуская сервис**:

```bash
ssh node2 'MODE=token APP_DIR="$HOME/webnestdev/src" ENV_FILE="$HOME/webnestdev/src/runtime.env" bash -s' \
  < deploy/scripts/vm-deploy.sh
ssh node2 'MODE=token APP_DIR="$HOME/webnestdev/src" ENV_FILE="$HOME/webnestdev/src/node2.env" bash -s' \
  < deploy/scripts/vm-deploy.sh
```

В логе должно быть одно из двух:

```text
WEBNESTDEV_RUNNER_TOKEN и NODE1_RUNNER_TOKEN синхронизированы с RUNNER_TOKEN контейнера node2-runner
```

или:

```text
токены API и runner уже совпадают с RUNNER_TOKEN контейнера node2-runner
```

Сообщение `.../.env нет — RUNNER_TOKEN не синхронизирую` означает, что выбран не тот
файл: на `node-2` нужно явно передать `runtime.env` и `node2.env`.

После записи проверить, что compose видит правильное значение, **не печатая сам токен**:

```bash
ssh node2 'cd "$HOME/webnestdev/src" && docker compose \
  --env-file runtime.env --env-file node2.env \
  config --format json | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d[\"services\"][\"webnestdev-server\"][\"environment\"][\"WEBNESTDEV_RUNNER_TOKEN\"]))"'
```

Ожидаемо: `64` (или другая длина, но не `0`). Сам токен в терминал не выводится.

Токен `node1-runner` и `node2-runner` должен совпадать: иначе API на одной ВМ не сможет
обращаться к runner на другой. Скрипт синхронизирует API с **локальным** runner, но не
сравнивает токены двух ВМ. Если значения различаются, сначала привести их к одному
значению на обоих runner-контейнерах, затем повторить синхронизацию.

`MODE=token` только пишет env-файлы. Если API на узле уже запущен, после синхронизации
перезапустить его штатным `docker compose ... up -d --no-build` (или при следующем
плановом запуске узла), иначе работающий контейнер сохранит старое окружение.

`NODE2_PG_PASSWORD` на `node-1` должен быть фактическим паролем роли `webnestdev` на
`node-2`, а не заглушкой. Его нельзя печатать в терминал. Перенос выполняется отдельным
режимом `MODE=pg-password`: значение кладётся в временный файл с правами `600`, после чего
скрипт записывает его в env и удаляет временный файл:

```bash
ssh node1 'MODE=pg-password PG_PASSWORD_FILE=/tmp/node2-pg.secret bash -s' \
  < deploy/scripts/vm-deploy.sh
```

После записи проверить, что compose на `node-1` собирается без ошибок и не выводит пароль:

```bash
ssh node1 'cd "$HOME/webnestdev/src" && docker compose \
  -f docker-compose.yml -f docker-compose.override.yml config --quiet && echo compose-ok'
```

### 4.3. Backup

Перед началом сценариев:

Скрипт выполняется **на `node-1`**, а не в рабочей копии на ноутбуке:

```bash
ssh node1 "MODE=backup BACKUP_MAX_AGE_HOURS=30 bash -s" \
  < deploy/scripts/pg-backup.sh
ssh node1 "MODE=check BACKUP_MAX_AGE_HOURS=30 bash -s" \
  < deploy/scripts/pg-backup.sh
```

`MODE` — переменная окружения, а не позиционный аргумент. `PG_MODE=auto` на текущем
стенде выбирает системный кластер. Если `APP_DIR` на ВМ отличается от
`~/webnestdev/src`, добавьте `APP_DIR=...` в строку перед `bash -s`. Для учебного
восстановления отдельно:

```bash
ssh node1 "MODE=restore-drill bash -s" < deploy/scripts/pg-backup.sh
```

Записать в журнал прогона:

- имя backup-файла/объекта;
- время backup;
- результат `check`;
- дату последнего успешного restore drill.

Без свежего backup и известного restore пути прогон не начинать.

### 4.4. Тестовые проекты и маркеры

Создать отдельный тестовый аккаунт или использовать существующий тестовый аккаунт.
Для каждого этапа создавать проект с уникальным именем:

```text
HA-E2E-A-<UTC timestamp>   # базовый, создан на node-1
HA-E2E-B-<UTC timestamp>   # создан после падения node-1, на node-2
HA-E2E-C-<UTC timestamp>   # создан на вернувшейся node-1
HA-E2E-D-<UTC timestamp>   # создан после падения node-2, на node-1
HA-E2E-E-<UTC timestamp>   # создан на вернувшейся node-2
```

Для каждого проекта записать:

- `projectId`;
- `projects.node` (узел, за которым закреплён проект);
- время создания;
- URL preview;
- результат терминала.

Если проект создан через API восстановленного узла, но placement выбрал другой узел,
для проверки терминала/preview **перевести pin на проверяемый узел** через
административный API `POST /api/admin/projects/:id/node` с
`{"node":"node-1"}` или `{"node":"node-2"}`. Это не меняет файлы: workspace общий.
Без переноса pin терминал и preview могут выполняться на соседнем runner, и проверка
«восстановленная машина обслуживает» будет неполной.

### 4.5. Preflight

Выполнить на обеих ВМ и записать результат:

```bash
# контроллер: выполнить на соответствующей ВМ
# node-1:
sudo systemctl is-active webnestdev-failover.service
sudo systemctl is-enabled webnestdev-failover.service
# node-2:
sudo systemctl is-active webnestdev-failover-node2.service
sudo systemctl is-enabled webnestdev-failover-node2.service

# PostgreSQL: ровно один primary
sudo -u postgres psql -p 5433 -Atc "select pg_is_in_recovery()"

# API
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/api/ready

# HAProxy target
sudo awk '/^[[:space:]]*server primary/{print $3}' /etc/haproxy/haproxy.cfg

# start-guard установлен
test -f /etc/systemd/system/postgresql@17-main.service.d/webnestdev-pg-guard.conf && echo guard-ok
```

Ожидаемое исходное состояние:

- оба контроллера `active` и `enabled`;
- на обеих ВМ есть `/opt/webnestdev-ha/switchover.py` и `control.py`, в юнитах заданы
  `HA_CONTROL_PATH` и `HA_SWITCHOVER_TIMEOUT_SECONDS=180`; это актуальный набор, а не
  старый checkout (image-deploy HA-скрипты не обновляет);
- `node-1`: `pg_is_in_recovery()=f` (primary), HAProxy → `127.0.0.1:5433`;
- `node-2`: `pg_is_in_recovery()=t` (standby), HAProxy → `10.0.0.4:5432`;
- оба `/api/ready` = `200`;
- на `node-2` выполнен `MODE=token` для `runtime.env` и `node2.env`, токены API и
  `node2-runner` совпадают;
- на `node-1` записан фактический `NODE2_PG_PASSWORD`, `docker compose config` проходит;
- NLB: оба target `OK`;
- `https://nestdev.ru` и `https://nestdev.ru/api/ready` = `200`;
- `/etc/webnestdev-ha/ALLOW_PRIMARY` отсутствует на обеих ВМ;
- на обеих ВМ смонтированы `sandboxes`, `sites`, `data`;
- `GET /api/admin/nodes` показывает проверяемые узлы `online` и `fresh`;
- backup свежий.

Если исходное состояние другое — сначала восстановить его, не начиная сценарии.

Дополнительно проверить автоматический старт и sandbox:

```bash
# на обеих ВМ: контейнеры должны иметь restart=unless-stopped
for c in src-docker-broker-1 src-webnestdev-server-1 src-caddy-1; do
  docker inspect -f '{{.Name}} restart={{.HostConfig.RestartPolicy.Name}}' "$c"
done

# node-2: runner тоже должен переживать перезагрузку
docker inspect -f '{{.Name}} restart={{.HostConfig.RestartPolicy.Name}}' node2-runner

# gVisor на обеих ВМ
docker info --format '{{json .Runtimes}}' | grep -o runsc
```

Ожидаемо: broker/API/Caddy/runner — `unless-stopped`, `runsc` есть в Docker; API и broker
получают `SANDBOX_RUNTIME=runsc` / `BROKER_RUNTIME=runsc`.

На `node-1` отдельно проверить неактивный слот `node2` и запас `pg_wal`: пока `node-2`
выключена, слот удерживает WAL. Если `pg_wal` растёт или диск заканчивается, слот нужно
удалить и после включения `node-2` сделать rejoin, а не ждать заполнения диска.

```bash
sudo -u postgres psql -p 5433 -Atc "select slot_name, active,
  pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn))
  from pg_replication_slots"
df -h /var/lib/postgresql
```

### 4.6. Плановый switchover: обязательная репетиция

До аварийных этапов B/D прогнать плановый switchover без выключения ВМ. Он проверяет
`switchover.py`/`control.py`, остановку API на источнике, promotion target, запись в базу и
возврат источника в API-работу. Использовать административный Bearer-токен, не печатать его.

1. Убедиться, что `node-1` primary, `node-2` standby, оба API `200`.
2. Запросить переход на `node-2`:

   ```bash
   curl -fsS -X POST "https://nestdev.ru/api/admin/nodes/node-2/switchover" \
     -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
     -d '{"confirm":true,"reason":"pre-production switchover rehearsal"}'
   ```

3. Опрашивать `GET /api/admin/nodes/switchover`, пока состояние не станет `promoted`
   (не дольше 180 с) или `failed`.
4. Проверить на `node-2`: `pg_is_in_recovery()=f`, запись `create temp table`/`insert`,
   `/api/ready` и Caddy `200`; публичный `/api/ready` `200`. На `node-1`: `/api/ready`
   `200` через HAProxy на `node-2`, локальный PostgreSQL остановлен.
5. Rejoin `node-1` по разделу 6, этап C; проверить `t` и `streaming`.
6. Запросить обратный переход на `node-1`, дождаться `promoted`, проверить primary и API;
   rejoin `node-2` по разделу 6, этап E; проверить `streaming`.
7. Сделать холодный старт `node-2`: `power=OFF` → `power=ON`, дождаться автоматического
   запуска standby/API/Caddy/broker/runner и `runsc`. Если production ещё не объявлен,
   выключить `node-2` и подтвердить `power=OFF`.

Если любой шаг не проходит — зафиксировать и не начинать аварийные этапы. Этот прогон
проверяет только плановый протокол; MWS fencing и promotion после реальной потери primary
он не заменяет.

## 5. Как проверять пользовательские сценарии

Эти действия повторяются на каждом этапе, где указано «проверить пользовательский путь».

### 5.1. Создание проекта

1. Открыть панель через публичный адрес.
2. Создать проект с именем этапа, например `HA-E2E-C-20261109T1900Z`.
3. Убедиться, что проект появился в списке и открывается.
4. Записать `projectId` и `projects.node`.
5. Дождаться, пока проверяемый узел в `GET /api/admin/nodes` будет `online` и
   `fresh` (heartbeat runner).
6. При необходимости перенести pin на проверяемый узел через админ-API. Если API
   отвечает `PROJECT_BUSY`, остановите preview и задания проекта и повторите.

### 5.2. Терминал

В терминале проекта выполнить:

```bash
pwd
printf 'HA-E2E-C-20261109T1900Z\n' > .ha-e2e-marker
cat .ha-e2e-marker
```

Ожидаемо:

- команда завершилась с кодом `0`;
- файл `.ha-e2e-marker` создан в корне проекта;
- после перезагрузки/переключения файл читается.

Если терминал возвращает ошибку, зафиксировать её в журнале; не считать сценарий
пройденным только по `200` от `/api/ready`.

### 5.3. Preview

1. В корне тестового проекта создать минимальную страницу, чтобы не зависеть от
   сборки и `npm install`:

   ```bash
   printf '<!doctype html><meta charset="utf-8"><title>HA-E2E</title><h1>HA-E2E-C</h1>\n' > index.html
   ```

2. Нажать «Preview»/«Запустить preview» в панели.
3. Дождаться состояния `running` и открыть preview.
4. Проверить, что страница содержит `HA-E2E-C` и не показывает белую рамку/ошибку.
5. Записать URL и время первого успешного ответа.

Для production `PREVIEW_MODE=auto` статический `index.html` должен обслуживаться без
сборки. Если проект использует dev-server, дождаться `running` и проверить его logs.

### 5.4. Проверка, что обслуживает именно нужный узел

NLB распределяет трафик между Caddy на обеих ВМ. Поэтому `200` с публичного адреса
сам по себе не доказывает, что запрос обработала восстановленная ВМ.

Сначала проверить прямой Caddy/API проверяемого узла **с соседней ВМ**:

```bash
# с node-1 проверить Caddy/API node-2
ssh node1 "curl -k -fsS --resolve nestdev.ru:443:10.0.0.5 https://nestdev.ru/api/ready"

# с node-2 проверить Caddy/API node-1
ssh node2 "curl -k -fsS --resolve nestdev.ru:443:10.0.0.4 https://nestdev.ru/api/ready"
```

Затем — обязательная проверка пользовательского пути именно через нужный узел:

1. Убедиться, что второй узел healthy и его Caddy можно временно остановить.
2. На **соседнем** узле остановить только Caddy, не PostgreSQL и не API:

   ```bash
   # например, чтобы весь публичный трафик пошёл на node-1:
   ssh node2 "docker stop src-caddy-1"
   ```

3. Подождать 45–60 секунд: NLB health check — TCP 443, unhealthy threshold 3 × 10 с.
4. В MWS Console убедиться, что target остановленного узла `FAILED`, а проверяемого —
   `OK`.
5. Через публичный адрес выполнить создание проекта, терминал и preview из раздела 5.
6. После проверки вернуть Caddy:

   ```bash
   ssh node2 "docker start src-caddy-1"
   ```

7. Дождаться, пока NLB снова покажет оба target `OK`.

Не останавливать Caddy на единственном здоровом узле. Не останавливать PostgreSQL ради
этой проверки. Если после остановки Caddy публичный адрес не отвечает, сначала вернуть
Caddy и разбираться, а не продолжать сценарий.

## 6. Сценарии прогона

Все времена — UTC. Перед каждым этапом записывать питание ВМ, роли PostgreSQL, NLB
targets и время. После каждого этапа — RTO (от отказа до `/api/ready=200`) и RPO
(последняя подтверждённая запись).

### Этап A. Исходное состояние: node-1 primary, node-2 standby

- Обе ВМ включены.
- NLB: оба target `OK`.
- `node-1` primary, `node-2` standby.
- Создать `HA-E2E-A`, pin `node-1`, выполнить терминал и preview из раздела 5.
- Записать маркер и URL preview.

### Этап B. Падение node-1 → node-2 primary

После выключения `node-1` штатный ProxyCommand через неё перестаёт работать. Команды
на `node-2` с этого момента выполняйте через независимый доступ из раздела 4.1:
management-адрес `2.59.80.174` напрямую или консоль MWS. Если используете консоль,
выполняйте внутреннюю часть команд без префикса `ssh node2`.

1. В MWS Console выключить `node-1` (`power=OFF`). Это имитация отказа, не штатное
   выключение.
2. Зафиксировать время отказа.
3. Ждать контроллер `node-2`: fencing, promotion, API/Caddy.
4. Проверить:

   ```bash
   ssh node2 "sudo -u postgres psql -p 5433 -Atc 'select pg_is_in_recovery()'"
   ssh node2 "curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/api/ready"
   ```

   Ожидаемо: `f`, API `200`.
5. MWS: `node-1 power=OFF`, NLB target `node-1 FAILED`, `node-2 OK`.
6. Публичный `https://nestdev.ru/api/ready` = `200`.
7. Открыть ранее созданный `HA-E2E-A`: файл `.ha-e2e-marker` на месте, preview
   открывается (если preview был остановлен — запустить заново). Если проект не
   открывается из-за старого pin на выключенную `node-1`, сначала убедиться, что у
   него нет живого preview/задания, затем перевести pin на `node-2` через админ-API.
8. Создать `HA-E2E-B`, pin `node-2`, терминал и preview.
9. Проверить, что второго primary нет: `node-1` выключена, `node-2` — единственный
   доступный PostgreSQL.
10. Записать RTO/RPO.

### Этап C. Возврат node-1 как второй API, затем rejoin

1. Включить `node-1` через MWS. Ждать SSH.
2. Проверить, что start-guard **не пустил** старый primary:

   ```bash
   ssh node1 "sudo systemctl is-active postgresql@17-main.service || true"
   ssh node1 "sudo journalctl -u postgresql@17-main.service -n 30 --no-pager"
   ```

   Ожидаемо: PostgreSQL не active; в логе guard причина вида «peer уже primary» или
   «СТАРТ ЗАПРЕЩЁН». Это правильное поведение, не ошибка.

3. Проверить, что контроллер `node-1` поднял API через `node-2`:

   ```bash
   ssh node1 "sudo systemctl is-active webnestdev-failover.service"
   ssh node1 "sudo awk '/^[[:space:]]*server primary/{print $3}' /etc/haproxy/haproxy.cfg"
   ssh node1 "curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/api/ready"
   ```

   Ожидаемо: контроллер `active`, HAProxy → `10.0.0.5:5432`, API `200`.

4. Принудительно направить публичный трафик на `node-1`, остановив Caddy на `node-2`
   по разделу 5.4. Дождаться NLB: `node-1 OK`, `node-2 FAILED`.
5. Через публичную панель создать `HA-E2E-C`, pin `node-1`, выполнить терминал и
   preview. Это доказывает, что вернувшаяся `node-1` принимает пользователей, хотя
   её локальный PostgreSQL остановлен.
6. Вернуть Caddy на `node-2`, дождаться обоих target `OK`.
7. Rejoin `node-1` как standby от `node-2`:

   ```bash
   ssh node1 "sudo bash -c '
     set -a
     . /etc/webnestdev-ha/replication.env
     set +a
     PGPASSWORD=\"\$REPLICATION_PASSWORD\" bash /opt/webnestdev-ha/standby.sh \
       10.0.0.5 5432 node1
   '"
   ```

8. Проверить standby и поток WAL:

   ```bash
   ssh node1 "sudo -u postgres psql -p 5433 -Atc 'select pg_is_in_recovery()'"
   ssh node1 "sudo -u postgres psql -p 5433 -Atc 'select status from pg_stat_wal_receiver'"
   ```

   Ожидаемо: `t`, `streaming`.
9. Проверить, что NLB снова видит оба target `OK` и `node-1` API `200`.
10. Записать результат.

### Этап D. Падение node-2 → node-1 primary

Теперь `node-1` — standby, `node-2` — primary.

1. В MWS Console выключить `node-2` (`power=OFF`). Зафиксировать время.
2. Ждать контроллер `node-1`: fencing, promotion, API/Caddy.
3. Проверить:

   ```bash
   ssh node1 "sudo -u postgres psql -p 5433 -Atc 'select pg_is_in_recovery()'"
   ssh node1 "curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/api/ready"
   ```

   Ожидаемо: `f`, API `200`.
4. MWS: `node-2 power=OFF`, NLB target `node-2 FAILED`, `node-1 OK`.
5. Публичный `/api/ready` = `200`.
6. Открыть `HA-E2E-C`, проверить маркер и preview.
7. Создать `HA-E2E-D`, pin `node-1`, терминал и preview.
8. Записать RTO/RPO.

### Этап E. Возврат node-2 как второй API, затем rejoin

1. Включить `node-2` через MWS. Ждать SSH.
2. Проверить, что guard не пустил её старый primary:

   ```bash
   ssh node2 "sudo systemctl is-active postgresql@17-main.service || true"
   ssh node2 "sudo journalctl -u postgresql@17-main.service -n 30 --no-pager"
   ```

   Ожидаемо: PostgreSQL не active; guard пишет, что peer primary.

3. Проверить API `node-2` через `node-1`:

   ```bash
   ssh node2 "sudo awk '/^[[:space:]]*server primary/{print $3}' /etc/haproxy/haproxy.cfg"
   ssh node2 "curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/api/ready"
   ```

   Ожидаемо: HAProxy → `10.0.0.4:5432`, API `200`.

4. Остановить Caddy на `node-1`, дождаться NLB: `node-2 OK`, `node-1 FAILED`.
5. Через публичную панель создать `HA-E2E-E`, pin `node-2`, терминал и preview.
6. Вернуть Caddy на `node-1`, дождаться обоих target `OK`.
7. Rejoin `node-2` как standby от `node-1`:

   ```bash
   ssh node2 "sudo bash -c '
     set -a
     . /etc/webnestdev-ha/replication.env
     set +a
     PGPASSWORD=\"\$REPLICATION_PASSWORD\" bash /opt/webnestdev-ha/standby.sh \
       10.0.0.4 5432 node2
   '"
   ```

8. Проверить `pg_is_in_recovery()=t` и `pg_stat_wal_receiver.status=streaming`.
9. Проверить оба NLB target `OK`.

### Этап F. Финальное состояние перед запуском

- `node-1` — primary.
- `node-2` — standby, **включена** и принимает API.
- Оба NLB target `OK`.
- Публичный сайт и `/api/ready` = `200`.
- Тестовые проекты A–E открываются; последние терминальные и preview-проверки прошли.
- Записан RTO/RPO по каждому направлению.
- Нет `ALLOW_PRIMARY`, нет второго primary, ошибок guard в журнале нет.
- После фиксации evidence тестовые проекты и их preview удалены, чтобы не занимать
  ёмкость; удаление не делается раньше записи доказательств.

Если это ещё не production-запуск, после фиксации результата выключить `node-2` и
подтвердить `power=OFF`. Если это уже запуск — `node-2` остаётся включённой.

## 7. Окно production-запуска

После успешного прогона и решения «go»:

1. Объявить maintenance window и зафиксировать release/commit.
2. Сделать свежий backup.
3. Включить `node-2` (если она была выключена после теста).
4. Синхронизировать runner-токен на `node-2` по разделу 4.2.1 и убедиться, что API
   получит тот же токен, что и `node2-runner`; при необходимости перезапустить API.
5. Убедиться, что оба контроллера `active`, start-guard установлен, `ALLOW_PRIMARY`
   отсутствует.
6. Проверить топологию: `node-1` primary, `node-2` standby; оба API `200`; NLB targets
   `OK`.
7. Выполнить финальный smoke-тест на production-аккаунте:
   - открыть панель;
   - открыть существующий проект;
   - выполнить безопасную команду в терминале;
   - запустить и открыть preview;
   - проверить публичный `/api/ready`.
8. Включить мониторинг на 30–60 минут: NLB targets, роли PostgreSQL, лаг репликации,
   `/api/ready`, 5xx, ошибки контроллера.
9. Только после этого объявить запуск завершённым.

В production `node-2` **не выключать** после проверки: это уже постоянная ёмкость,
если решение о production-HA зафиксировано в `docs/CLUSTER_HA_PLAN.md`. Без этой
отдельной записи действует правило экономии до production-запуска — выключить после
работ.

## 8. Матрица приёмки

| Проверка | A: база | B: node-1 упала | C: node-1 вернулась | D: node-2 упала | E: node-2 вернулась |
| --- | --- | --- | --- | --- | --- |
| Primary | `node-1` | `node-2` | `node-2` | `node-1` | `node-1` |
| Второй PostgreSQL | standby | нет | `node-1` stopped | нет | `node-2` stopped |
| NLB | оба OK | `node-2` OK | оба OK | `node-1` OK | оба OK |
| `/api/ready` | 200 | 200 | 200 | 200 | 200 |
| Создание проекта | A | B | C | D | E |
| Терминал | [ ] | [ ] | [ ] | [ ] | [ ] |
| Preview | [ ] | [ ] | [ ] | [ ] | [ ] |
| Восстановленная ВМ реально обслужила | — | — | C на `node-1` | — | E на `node-2` |
| Rejoin | — | — | `node-1` standby | — | `node-2` standby |

Отмечать пункт в матрице или журнале как пройденный только после фактического
выполнения, а не после успешного health-check.

## 9. Журнал прогона

Заполнять по каждому этапу:

| Поле | Значение |
| --- | --- |
| Этап / UTC | |
| Кто выполнял | |
| Power `node-1` / `node-2` | |
| PostgreSQL primary | |
| `pg_is_in_recovery()` на обоих | |
| NLB targets | |
| `https://nestdev.ru` | |
| `/api/ready` | |
| `projectId` | |
| `projects.node` | |
| Терминал: команда и код | |
| Preview: URL и результат | |
| RTO | |
| RPO / последняя запись | |
| Ошибки/отклонения | |

Прикладывать:

- скриншот списка проектов и preview;
- вывод терминала;
- `journalctl` контроллера и start-guard;
- статус NLB;
- `pg_stat_replication`/`pg_stat_wal_receiver`;
- логи API/Caddy при ошибке.

## 10. Стоп-условия

Немедленно остановить прогон и не запускать production, если:

- на двух узлах одновременно `pg_is_in_recovery() = f`;
- guard не заблокировал старый primary или кто-то запустил его через
  `ALLOW_PRIMARY`/`pg_ctlcluster`;
- после failover публичный `/api/ready` не становится `200`;
- NLB не имеет ни одного healthy target;
- создание проекта, терминал или preview не работают на восстановленном узле;
- потерян тестовый проект, файл или preview после переключения;
- GlusterFS потерял кворум/данные и не восстанавливается;
- backup/restore не подтверждён.

При остановке:

1. Не форсировать promotion и не запускать второй primary.
2. Вернуть Caddy на остановленный узел.
3. Оставить/вернуть `node-1` как рабочий primary.
4. `node-2` выключить, если это не production.
5. Восстановить данные из backup только по процедуре
   [`POSTGRES_BACKUP.md`](POSTGRES_BACKUP.md).
6. Зафиксировать причину и не считать запуск состоявшимся.

## 11. Ограничения, которые нельзя замалчивать

- Автоматического failback нет: вернувшийся узел становится standby только после
  `standby.sh`; роль обратно переключается отдельным решением.
- NLB health check — TCP 443. Caddy может стать healthy раньше, чем API полностью
  готов; после старта API проверять именно пользовательский сценарий.
- GlusterFS replica 2 без witness остаётся риском split-brain при сетевом разделении.
  MWS fencing защищает PostgreSQL, но не заменяет arbiter для production.
- Start-guard защищает `systemctl`-запуск; прямой `pg_ctlcluster start` его обходит.
- Терминал и WebSocket при падении узла рвутся; это ожидаемо, после переключения
  пользователь переподключается и повторяет действие.
- HA-скрипты не входят в image-deploy: после изменения `deploy/ha` их нужно установить на
  обе ВМ и перезапустить оба failover-юнита. Проверять наличие `switchover.py`/`control.py`,
  а не только active-статус старого контроллера.
- Плановый switchover 10.11.2026 не заменяет аварийный failover с MWS fencing. Этапы B/D
  остаются обязательными до production-запуска.

## 12. Чеклист перед нажатием «запуск»

- [ ] Backup создан, `check` пройден, restore drill известен.
- [ ] Актуальный `deploy/ha` установлен на обе ВМ; есть `switchover.py`/`control.py`,
  на каждой ВМ свой failover-юнит active/enabled, `HA_CONTROL_PATH` общий, timeout задан.
- [ ] Плановый switchover пройден в обе стороны, оба rejoin дали `streaming` с нулевым
  лагом, холодный старт `node-2` поднял standby/API/Caddy/broker/runner без ручных команд.
- [ ] Оба направления аварийного failover прогнаны (выключение ВМ + MWS fencing).
- [ ] На каждом восстановленном узле создан проект, выполнен терминал, открыт preview.
- [ ] Pin проекта проверялся на нужном узле, а не только публичный `200`.
- [ ] В каждом состоянии ровно один primary.
- [ ] Rejoin обоих узлов проверен, streaming WAL подтверждён.
- [ ] NLB targets и публичный сайт проверены.
- [ ] На `node-2` синхронизированы `runtime.env` и `node2.env`, токены API и runner
  совпадают с `node-1`.
- [ ] На `node-1` записан фактический `NODE2_PG_PASSWORD`; compose-конфигурация проходит.
- [ ] RTO/RPO записаны.
- [ ] Нет `ALLOW_PRIMARY`, нет обойдённого guard.
- [ ] Есть ответственный за окно и план отката.
- [ ] Принято отдельное решение о постоянной работе `node-2`.
