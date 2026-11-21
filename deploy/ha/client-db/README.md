# Клиентская база платформы: второй кластер PostgreSQL с failover

Отдельный кластер `17/client` на порту **5434**, не пересекающийся с платформенным `17/main`
(`:5433`). Одна база `app`, в ней схема на аккаунт (`tenant_<hash>`), одна роль на аккаунт,
PgBouncer на приватном адресе ноды (`:6432`).

```text
serverless-функция проекта
        │ DATABASE_URL → приватный IP ноды :6432
        ▼
PgBouncer (transaction pooling, auth_query)
        │
        ▼
PostgreSQL 17/client :5434  ← primary
        │ streaming
        ▼
PostgreSQL 17/client :5434  ← standby на второй ноде
```

## Диск

Данные кластера лежат на **локальном диске ноды** (`/var/lib/postgresql/17/client`), а не на
Gluster. Gluster — replica 2 для файлов проектов; PostgreSQL на нём теряет в блокировках и
латентности. Надёжность даёт потоковая репликация на вторую ноду, а не общий том.

## Файлы

| Файл | Назначение |
|---|---|
| `install.sh` | создаёт кластер, репликацию, PgBouncer, ставит юниты |
| `failover.py` | `status`, `guard`, `tick`, `promote`; политика в `decide()` |
| `backup.sh` | дампы по схемам, восстановление одной схемы, список |
| `webnestdev-client-db*.service/timer` | кластер, failover каждые 20 с, квоты и бэкап по расписанию |
| `client-db.env.example` | шаблон `/etc/webnestdev/client-db.env` |

## Установка

0. Поставить пакеты (скрипт их не устанавливает): `sudo apt-get install -y postgresql-17 pgbouncer`.
1. Создать `/etc/webnestdev/client-db.env` (root:root, 600) по шаблону. Обязательны:
   `PRIVATE_IP`, `PEER_IP`, `REPL_PASSWORD`, `CLIENT_DB_ADMIN_URL`.
   `CLIENT_DB_ADMIN_URL` — строка **отдельной** роли `nestdev_client_admin`, а не `postgres`:
   `postgres://nestdev_client_admin:…@127.0.0.1:5434/app`; она не покидает хост.

   Роль создаётся на primary один раз (пароль заменить своим, не печатать):
   ```sql
   CREATE ROLE nestdev_client_admin LOGIN CREATEROLE PASSWORD '…';
   GRANT CREATE, CONNECT ON DATABASE app TO nestdev_client_admin WITH GRANT OPTION;
   ```
   После первого провижининга выдать права на учётную таблицу:
   ```sql
   GRANT USAGE, CREATE ON SCHEMA nestdev_admin TO nestdev_client_admin;
   GRANT SELECT, INSERT, UPDATE ON TABLE nestdev_admin.tenants TO nestdev_client_admin;
   ```
   `CREATEROLE` нужен для `ALTER ROLE … SET` дочерних tenant-роли; членство в tenant-роли
   выдаётся только на время DDL (создание схемы и смена её владельца) и сразу снимается. Схемой
   владеет администратор, tenant получает права внутри неё. Роль не является superuser и не имеет
   постоянного доступа к данным клиентов.
2. На `node-1`:
   `REPL_PASSWORD='…' ./install.sh primary`
3. Скопировать `/etc/webnestdev/client-db.env` с `node-1` на `node-2`, заменив
   `PRIVATE_IP`/`PEER_IP` (`PGBOUNCER_AUTH_PASSWORD` создаёт primary — без него standby не встанет).
4. На `node-2` (после включения машины):
   `./install.sh standby`
5. На каждой ноде создать `/etc/webnestdev/client-db-admin.conf` (владелец пользователя
   деплоя, режим 600) с одной строкой:
   `CLIENT_DB_ADMIN_URL=<административная строка через PgBouncer этой ноды>`.
   Compose-файл сервера подключает этот файл как необязательный `env_file`; в git и `.env`
   секрет не попадает. `CLIENT_DB_PUBLIC_HOST` уже задан в override (`10.0.0.4`/`10.0.0.5`).
6. Перезапустить сервер (фича включается только при заданных адресах; без файла маршрут
   отвечает 503 и ничего не ломает).

## Обслуживание

```bash
./install.sh pgbouncer    # переконфигурировать PgBouncer без пересоздания кластера
./failover.py status      # роль, состояние соседа, счётчик подтверждений
```

`install.sh standby` можно запускать только на ноде, которая должна **стать** standby: он
останавливает кластер и заново снимает basebackup. На работающем primary его запускать нельзя.

## Failover

- `webnestdev-client-db-failover.timer` каждые 20 секунд запускает `tick`.
- `tick` спрашивает локальную роль и роль соседа. Если сосед недоступен **два раза подряд**
  (`FAILOVER_CONFIRMATIONS`), standby делает `pg_ctlcluster promote`, переключает PgBouncer на
  локальный primary и пишет состояние в `/var/lib/webnestdev/client-db/role.json`.
- `guard` (ExecStartPre кластера) не даёт стартовать локальному primary, если сосед отвечает
  как primary — защита от split-brain.
- Вернувшаяся нода **не поднимает свой старый primary**: её готовят как standby повторным
  `install.sh standby` (basebackup со слота). Это осознанный шаг: автоматический rejoin с
  перезаписью каталога данных опаснее ручного.
- Синхронная репликация по умолчанию **выключена** (`SYNC_REPLICATION=0`): при выключенной
  `node-2` запись не встанет. Включить `1`, когда обе ноды работают постоянно — тогда RPO 0.
  При выключенной синхронности потеря последних транзакций при аварии возможна (RPO > 0).

## Адрес в `DATABASE_URL`

Пока нет стабильного DNS для приватной сети, клиентская строка указывает на приватный IP ноды,
где живёт PgBouncer. Функции проекта исполняются на той же ноде, поэтому путь остаётся
работоспособным; при переезде проекта или появлении выделенной пары ВМ адрес меняется в
`CLIENT_DB_PUBLIC_HOST` (и в новых выдачах), существующие строки не переписываются.

## Квоты

`webnestdev-client-db-quota.timer` раз в сутки запускает `node dist/scripts/client-db-quota.js`
внутри контейнера сервера: скрипт читает `nestdev_admin.tenants`, берёт тариф аккаунта и
переводит роль в `default_transaction_read_only` при превышении. Данные не удаляются.

## Бэкапы

`webnestdev-client-db-backup.timer` в 02:30 UTC снимает `pg_dump -Fc` по каждой схеме в
`/var/backups/webnestdev/client-db`, хранит 7 дней. Загрузка в S3 — через
`CLIENT_DB_BACKUP_UPLOAD` (команда получает путь в `$1`), потому что S3-клиент и ключи живут в
контейнере сервера. Восстановление одной схемы:

```bash
sudo /usr/local/sbin/webnestdev-client-db-backup restore tenant_<hash> /var/backups/webnestdev/client-db/tenant_<hash>-<ts>.dump
```

## Проверка после установки

```bash
sudo -u postgres psql -p 5434 -tAc "select pg_is_in_recovery()"        # t на standby, f на primary
/usr/local/sbin/webnestdev-client-db-failover status                    # роль и доступность соседа
sudo systemctl status pgbouncer webnestdev-client-db-failover.timer
psql -h <PRIVATE_IP> -p 6432 -U tenant_<hash> -d app -c 'select 1'      # пароль из проекта
```

Учения: остановить primary (`pg_ctlcluster 17 client stop`), подождать 40–60 секунд, проверить
`failover status` на второй ноде (`role: primary`) и запись через PgBouncer. После учения
вернуть прежний порядок: на бывшем primary — `install.sh standby`.

## Ограничения

- Одна база `app` и один кластер: 100 баз на кластер и лимиты managed здесь не действуют.
- Нет автоматического rejoin и нет кворума из трёх узлов: при разделении сети возможен простой
  до ручного разбора — это дешевле, чем два primary.
- PgBouncer в transaction pooling: не работают сессионные `SET`, `LISTEN/NOTIFY` между
  запросами и именованные prepared statements.
- Восстановление на момент времени (PITR) для клиентских схем не включено: есть ночные дампы.
