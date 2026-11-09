#!/usr/bin/env bash
# Подготовка локального PostgreSQL как физического standby от указанного primary.
#
# Использование:
#   PGPASSWORD='...' ./standby.sh 10.0.0.4 5432 node2
#
# Скрипт не печатает пароль. Он останавливает локальный кластер, сохраняет старый data
# directory рядом, делает basebackup, настраивает primary_conninfo/слот и запускает standby.
# Тот же скрипт используется для rejoin вернувшегося старого primary.
set -euo pipefail

SOURCE_HOST=${1:?usage: standby.sh SOURCE_HOST [SOURCE_PORT] [SLOT]}
SOURCE_PORT=${2:-5432}
SLOT=${3:-}
PG_VERSION=${PG_VERSION:-17}
PG_CLUSTER=${PG_CLUSTER:-main}
PG_DATA=${PG_DATA:-/var/lib/postgresql/${PG_VERSION}/${PG_CLUSTER}}
PGPASSFILE=${PGPASSFILE:-/var/lib/postgresql/.pgpass}
PG_USER=${PG_USER:-replicator}
PG_DB=${PG_DB:-postgres}
LOCAL_PORT=${LOCAL_PORT:-$(sudo -n pg_lsclusters -h | awk -v v="$PG_VERSION" -v c="$PG_CLUSTER" '$1==v && $2==c {print $3; exit}')}

if [ -z "${PGPASSWORD:-}" ]; then
  echo "PGPASSWORD is required (replication password); it is never printed" >&2
  exit 2
fi
if [ -n "$SLOT" ] && ! [[ "$SLOT" =~ ^[a-zA-Z0-9_]+$ ]]; then
  echo "invalid slot name: $SLOT" >&2
  exit 2
fi

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

if sudo -n pg_ctlcluster "$PG_VERSION" "$PG_CLUSTER" status >/dev/null 2>&1; then
  log "stopping local PostgreSQL ${PG_VERSION}/${PG_CLUSTER}"
  sudo -n pg_ctlcluster "$PG_VERSION" "$PG_CLUSTER" stop --force || true
fi

stamp=$(date -u +%Y%m%dT%H%M%SZ)
if [ -d "$PG_DATA" ]; then
  backup="${PG_DATA}.pre-ha-${stamp}"
  log "saving old data directory to $backup"
  sudo -n mv "$PG_DATA" "$backup"
fi
sudo -n install -d -o postgres -g postgres -m 700 "$PG_DATA"

# .pgpass читается pg_basebackup и затем самим standby; пароль не попадает в argv.
sudo -n install -d -o postgres -g postgres -m 700 "$(dirname "$PGPASSFILE")"
printf '%s:%s:replication:%s:%s\n' "$SOURCE_HOST" "$SOURCE_PORT" "$PG_USER" "$PGPASSWORD" \
  | sudo -n tee "$PGPASSFILE" >/dev/null
sudo -n chown postgres:postgres "$PGPASSFILE"
sudo -n chmod 600 "$PGPASSFILE"

if [ -n "$SLOT" ]; then
  log "ensuring replication slot $SLOT on $SOURCE_HOST:$SOURCE_PORT"
  sudo -n -u postgres env PGPASSFILE="$PGPASSFILE" \
    psql -h "$SOURCE_HOST" -p "$SOURCE_PORT" -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 \
    -c "SELECT pg_create_physical_replication_slot('$SLOT') WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = '$SLOT');" \
    >/dev/null 2>&1 || log "slot may already exist; continuing"
fi

log "basebackup from $SOURCE_HOST:$SOURCE_PORT into $PG_DATA"
sudo -n -u postgres env PGPASSFILE="$PGPASSFILE" \
  pg_basebackup -h "$SOURCE_HOST" -p "$SOURCE_PORT" -U "$PG_USER" -D "$PG_DATA" \
  -R -X stream -c fast ${SLOT:+-S "$SLOT"}

# pg_basebackup -R копирует и старый postgresql.auto.conf с прежним primary_conninfo.
# Убираем старые параметры, чтобы standby не пытался подключиться к самому себе.
sudo -n -u postgres sh -c "grep -vE '^(primary_conninfo|primary_slot_name|passfile)[[:space:]]*=' '$PG_DATA/postgresql.auto.conf' > '$PG_DATA/postgresql.auto.conf.tmp' && mv '$PG_DATA/postgresql.auto.conf.tmp' '$PG_DATA/postgresql.auto.conf'"
# pg_basebackup с PGPASSFILE может добавить отдельный passfile; PostgreSQL 17 не
# принимает его как server GUC. Убираем, иначе standby не стартует.
sudo -n -u postgres sed -i '/^[[:space:]]*passfile[[:space:]]*=/d' "$PG_DATA/postgresql.auto.conf"
sudo -n -u postgres tee -a "$PG_DATA/postgresql.auto.conf" >/dev/null <<EOF
primary_conninfo = 'user=$PG_USER host=$SOURCE_HOST port=$SOURCE_PORT sslmode=prefer'
${SLOT:+primary_slot_name = '$SLOT'}
EOF

log "starting local PostgreSQL ${PG_VERSION}/${PG_CLUSTER}"
sudo -n pg_ctlcluster "$PG_VERSION" "$PG_CLUSTER" start

for _ in $(seq 1 30); do
  if sudo -n -u postgres psql -p "$LOCAL_PORT" -tAc 'select pg_is_in_recovery()' 2>/dev/null | grep -qx t; then
    log "standby is in recovery"
    exit 0
  fi
  sleep 2
done

log "standby did not enter recovery; check /var/log/postgresql/postgresql-${PG_VERSION}-${PG_CLUSTER}.log"
exit 1
