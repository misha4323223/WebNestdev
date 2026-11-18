#!/usr/bin/env bash
# Клиентская база платформы: отдельный кластер PostgreSQL на общем диске ноды.
#
# Использование:
#   REPL_PASSWORD='…' ./install.sh primary      # первый запуск на node-1
#   REPL_PASSWORD='…' ./install.sh standby      # подготовка/переподготовка node-2
#
# Что делает:
#   * создаёт кластер `17/client` на порту 5434 (не трогая платформенный `main` на 5433);
#   * на primary — включает потоковую репликацию, роль и слот для standby, базу `app`;
#   * на standby — снимает basebackup с primary и запускает его как standby;
#   * поднимает PgBouncer на приватном адресе ноды (порт 6432) с auth_query;
#   * ставит юниты: кластер, failover, проверка квот, бэкап.
#
# Пароль репликации приходит из окружения и нигде не печатается. Скрипт идемпотентен: повторный
# запуск не удаляет данные, кроме `standby`, который заново снимает копию с primary.
set -Eeuo pipefail

ROLE=${1:?usage: install.sh primary|standby|pgbouncer}
HERE=$(cd "$(dirname "$0")" && pwd)

# shellcheck source=/dev/null
[ -f /etc/webnestdev/client-db.env ] && . /etc/webnestdev/client-db.env

PG_VERSION=${PG_VERSION:-17}
PG_CLUSTER=${PG_CLUSTER:-client}
PG_PORT=${PG_PORT:-5434}
PG_DB=${PG_DB:-app}
PRIVATE_IP=${PRIVATE_IP:?PRIVATE_IP обязателен: на нём слушает PgBouncer}
PEER_IP=${PEER_IP:-}
REPL_USER=${REPL_USER:-client_replicator}
REPL_SLOT=${REPL_SLOT:-client_standby}
PGBOUNCER_PORT=${PGBOUNCER_PORT:-6432}
PGBOUNCER_AUTH_USER=${PGBOUNCER_AUTH_USER:-pgbouncer_auth}
# Синхронная репликация: строже по данным (RPO 0), но запись встаёт, пока standby недоступен.
# По умолчанию выключена — включить, когда обе ноды работают постоянно.
SYNC_REPLICATION=${SYNC_REPLICATION:-0}
PGDATA=${PGDATA:-/var/lib/postgresql/${PG_VERSION}/${PG_CLUSTER}}
PGCONF=${PGCONF:-/etc/postgresql/${PG_VERSION}/${PG_CLUSTER}}
[ -n "${REPL_PASSWORD:-}" ] || { echo "REPL_PASSWORD обязателен" >&2; exit 2; }
case "$ROLE" in primary|standby|pgbouncer) ;; *) echo "роль: primary, standby или pgbouncer" >&2; exit 2 ;; esac

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "[client-db] $*"; }
sql() { sudo -n -u postgres psql -p "$PG_PORT" -d "${1:-postgres}" -tAc "$2"; }

cluster_exists() {
  sudo -n pg_lsclusters -h | awk -v v="$PG_VERSION" -v c="$PG_CLUSTER" '$1==v && $2==c {found=1} END {exit !found}'
}

ensure_cluster() {
  if ! cluster_exists; then
    log "создаю кластер ${PG_VERSION}/${PG_CLUSTER} на порту $PG_PORT"
    sudo -n pg_createcluster "$PG_VERSION" "$PG_CLUSTER" --port "$PG_PORT" --start-conf manual
  fi
}

configure_postgres() {
  local file="$PGCONF/postgresql.conf"
  local sync_line=""
  [ "$SYNC_REPLICATION" = "1" ] && sync_line="synchronous_standby_names = '${REPL_SLOT}'"
  if ! grep -q '^# webnestdev-client-db$' "$file"; then
    log "настраиваю $file"
    sudo -n tee -a "$file" >/dev/null <<EOF
# webnestdev-client-db
listen_addresses = '127.0.0.1,${PRIVATE_IP}'
wal_level = replica
max_wal_senders = 5
max_replication_slots = 5
hot_standby = on
synchronous_commit = remote_write
${sync_line}
wal_keep_size = 512MB
EOF
  fi
  local hba="$PGCONF/pg_hba.conf"
  if ! grep -q '^# webnestdev-client-db$' "$hba"; then
    log "разрешаю подключения и репликацию в $hba"
    sudo -n tee -a "$hba" >/dev/null <<EOF
# webnestdev-client-db
local   all             postgres                                peer
host    all             all             127.0.0.1/32            scram-sha-256
host    all             all             ${PRIVATE_IP}/32        scram-sha-256
${PEER_IP:+host    all             all             ${PEER_IP}/32           scram-sha-256
}host    replication     ${REPL_USER}     127.0.0.1/32            scram-sha-256
${PEER_IP:+host    replication     ${REPL_USER}     ${PEER_IP}/32           scram-sha-256}
EOF
  fi
}

ensure_replication_role() {
  if [ "$(sql postgres "SELECT 1 FROM pg_roles WHERE rolname='${REPL_USER}'")" != "1" ]; then
    log "создаю роль репликации ${REPL_USER}"
    sql postgres "CREATE ROLE ${REPL_USER} WITH REPLICATION LOGIN PASSWORD '${REPL_PASSWORD}'" >/dev/null
  else
    sql postgres "ALTER ROLE ${REPL_USER} WITH REPLICATION LOGIN PASSWORD '${REPL_PASSWORD}'" >/dev/null
  fi
  if [ "$(sql postgres "SELECT 1 FROM pg_replication_slots WHERE slot_name='${REPL_SLOT}'")" != "1" ]; then
    log "создаю слот ${REPL_SLOT}"
    sql postgres "SELECT pg_create_physical_replication_slot('${REPL_SLOT}')" >/dev/null
  fi
}

ensure_database() {
  if [ "$(sql postgres "SELECT 1 FROM pg_database WHERE datname='${PG_DB}'")" != "1" ]; then
    log "создаю базу ${PG_DB}"
    sql postgres "CREATE DATABASE ${PG_DB}" >/dev/null
  fi
  if [ "$(sql "$PG_DB" "SELECT 1 FROM pg_roles WHERE rolname='${PGBOUNCER_AUTH_USER}'")" != "1" ]; then
    log "создаю роль ${PGBOUNCER_AUTH_USER} для auth_query"
    sql "$PG_DB" "CREATE ROLE ${PGBOUNCER_AUTH_USER} LOGIN PASSWORD '${PGBOUNCER_AUTH_PASSWORD}'" >/dev/null
  else
    # Пароль должен совпадать с userlist PgBouncer на обеих нодах: обновляем при каждом запуске.
    sql "$PG_DB" "ALTER ROLE ${PGBOUNCER_AUTH_USER} WITH PASSWORD '${PGBOUNCER_AUTH_PASSWORD}'" >/dev/null
  fi
  # PgBouncer читает пароль роли только через SECURITY DEFINER: обычная роль не видит pg_shadow.
  sql "$PG_DB" "CREATE OR REPLACE FUNCTION public.pgbouncer_get_auth(uname text)
    RETURNS TABLE(usename text, passwd text)
    LANGUAGE sql SECURITY DEFINER AS \$\$
      SELECT u.usename, u.passwd FROM pg_shadow u WHERE u.usename = \$1
    \$\$" >/dev/null
  sql "$PG_DB" "REVOKE ALL ON FUNCTION public.pgbouncer_get_auth(text) FROM PUBLIC" >/dev/null
  sql "$PG_DB" "GRANT EXECUTE ON FUNCTION public.pgbouncer_get_auth(text) TO ${PGBOUNCER_AUTH_USER}" >/dev/null
}

setup_pgbouncer() {
  local backend=$1
  log "PgBouncer: слушаю ${PRIVATE_IP}:${PGBOUNCER_PORT}, backend ${backend}:${PG_PORT}"
  local dir=/etc/pgbouncer
  sudo -n install -d -m 755 "$dir"
  sudo -n tee "$dir/pgbouncer.ini" >/dev/null <<EOF
[databases]
${PG_DB} = host=${backend} port=${PG_PORT} dbname=${PG_DB}

[pgbouncer]
listen_addr = ${PRIVATE_IP}
listen_port = ${PGBOUNCER_PORT}
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt
auth_user = ${PGBOUNCER_AUTH_USER}
auth_query = SELECT usename, passwd FROM public.pgbouncer_get_auth(\$1)
pool_mode = transaction
max_client_conn = 2000
default_pool_size = 25
max_user_connections = 2
max_db_connections = 100
server_idle_timeout = 30
server_lifetime = 1800
client_idle_timeout = 60
log_connections = 0
log_disconnections = 0
EOF
  # PgBouncer ходит в PostgreSQL паролем auth_user: в userlist нужен открытый пароль, а не
  # SCRAM-хэш из pg_authid (с хэшем вход в сервер невозможен).
  sudo -n tee "$dir/userlist.txt" >/dev/null <<EOF
"${PGBOUNCER_AUTH_USER}" "${PGBOUNCER_AUTH_PASSWORD}"
EOF
  sudo -n chown postgres:postgres "$dir/userlist.txt"
  sudo -n chmod 600 "$dir/userlist.txt"
  sudo -n systemctl enable pgbouncer >/dev/null 2>&1 || true
  sudo -n systemctl restart pgbouncer
}

install_units() {
  log "ставлю юниты webnestdev-client-db*"
  sudo -n install -m 644 "$HERE"/webnestdev-client-db*.service /etc/systemd/system/
  sudo -n install -m 644 "$HERE"/webnestdev-client-db*.timer /etc/systemd/system/
  sudo -n install -m 755 "$HERE/failover.py" /usr/local/sbin/webnestdev-client-db-failover
  sudo -n install -m 755 "$HERE/backup.sh" /usr/local/sbin/webnestdev-client-db-backup
  sudo -n systemctl daemon-reload
  # Кластер уже запущен выше: `--now` упал бы на «already running». Юнит включается на загрузку.
  sudo -n systemctl enable webnestdev-client-db.service
  sudo -n systemctl start webnestdev-client-db.service || true
  sudo -n systemctl enable --now webnestdev-client-db-failover.timer
  sudo -n systemctl enable --now webnestdev-client-db-quota.timer
  sudo -n systemctl enable --now webnestdev-client-db-backup.timer
}

main_primary() {
  # Пароль auth_user должен быть одинаковым на обеих нодах: primary создаёт его один раз и
  # дописывает в /etc/webnestdev/client-db.env, standby получает файл вместе с остальными
  # значениями. Без этого userlist на standby расходится с ролью на primary.
  if [ -z "${PGBOUNCER_AUTH_PASSWORD:-}" ]; then
    PGBOUNCER_AUTH_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=')
    printf 'PGBOUNCER_AUTH_PASSWORD=%s\n' "$PGBOUNCER_AUTH_PASSWORD" |
      sudo -n tee -a /etc/webnestdev/client-db.env >/dev/null
  fi
  ensure_cluster
  configure_postgres
  sudo -n pg_ctlcluster "$PG_VERSION" "$PG_CLUSTER" start || true
  ensure_replication_role
  ensure_database
  setup_pgbouncer 127.0.0.1
  install_units
  log "primary готов: ${PRIVATE_IP}:${PGBOUNCER_PORT}/${PG_DB}"
}

main_standby() {
  [ -n "$PEER_IP" ] || { echo "PEER_IP обязателен для standby" >&2; exit 2; }
  [ -n "${PGBOUNCER_AUTH_PASSWORD:-}" ] || {
    echo "PGBOUNCER_AUTH_PASSWORD отсутствует: скопируйте /etc/webnestdev/client-db.env с primary" >&2
    exit 2
  }
  ensure_cluster
  configure_postgres
  log "останавливаю локальный кластер и снимаю basebackup с ${PEER_IP}"
  sudo -n pg_ctlcluster "$PG_VERSION" "$PG_CLUSTER" stop --force || true
  if [ -d "$PGDATA" ]; then
    sudo -n mv "$PGDATA" "${PGDATA}.pre-client-db-$(date -u +%Y%m%dT%H%M%SZ)"
  fi
  sudo -n install -d -o postgres -g postgres -m 700 "$PGDATA"
  local passfile=/var/lib/postgresql/.pgpass-client-db
  printf '%s:%s:*:%s:%s\n' "$PEER_IP" "$PG_PORT" "$REPL_USER" "$REPL_PASSWORD" |
    sudo -n tee "$passfile" >/dev/null
  sudo -n chown postgres:postgres "$passfile"
  sudo -n chmod 600 "$passfile"
  # Слот живёт на текущем primary. После promotion его там нет: создаём перед basebackup,
  # иначе вернувшаяся нода не может подключиться к новому primary.
  if [ "$(sudo -n -u postgres env PGPASSFILE="$passfile" psql -h "$PEER_IP" -p "$PG_PORT" \
    -U "$REPL_USER" -d postgres -tAc "SELECT 1 FROM pg_replication_slots WHERE slot_name='${REPL_SLOT}'")" != "1" ]; then
    log "создаю слот ${REPL_SLOT} на ${PEER_IP}"
    sudo -n -u postgres env PGPASSFILE="$passfile" psql -h "$PEER_IP" -p "$PG_PORT" \
      -U "$REPL_USER" -d postgres -tAc "SELECT pg_create_physical_replication_slot('${REPL_SLOT}')" >/dev/null
  fi
  sudo -n -u postgres env PGPASSFILE="$passfile" \
    pg_basebackup -h "$PEER_IP" -p "$PG_PORT" -U "$REPL_USER" -D "$PGDATA" \
    -R -X stream -c fast -S "$REPL_SLOT"
  # pg_basebackup переносит passfile как GUC — PostgreSQL 17 его не принимает.
  sudo -n -u postgres sed -i '/^[[:space:]]*passfile[[:space:]]*=/d' "$PGDATA/postgresql.auto.conf"
  sudo -n pg_ctlcluster "$PG_VERSION" "$PG_CLUSTER" start || true
  setup_pgbouncer "$PEER_IP"
  install_units
  log "standby готов и смотрит в ${PEER_IP}:${PG_PORT}"
}

main_pgbouncer() {
  # Переконфигурация без пересоздания кластера: нужна после promotion/rejoin и при смене
  # пароля auth_user. Backend — локальный primary или сосед, если эта нода standby.
  local role
  role=$(sudo -n -u postgres psql -p "$PG_PORT" -tAc "select pg_is_in_recovery()" 2>/dev/null || echo "down")
  case "$role" in
    f) setup_pgbouncer 127.0.0.1 ;;
    t) [ -n "$PEER_IP" ] || { echo "PEER_IP обязателен для standby" >&2; exit 2; }; setup_pgbouncer "$PEER_IP" ;;
    *) echo "кластер не отвечает: сначала поднимите его" >&2; exit 1 ;;
  esac
}

case "$ROLE" in
  primary) main_primary ;;
  standby) main_standby ;;
  pgbouncer) main_pgbouncer ;;
esac
