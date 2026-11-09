#!/usr/bin/env bash
# Разрешает guard-проверке подключиться к локальному PostgreSQL peer-узла
# под существующей ролью replicator (только чтение роли, без доступа к данным).
#
# Использование: ./pg_hba_probe.sh PEER_PRIVATE_IP
set -euo pipefail

PEER_IP=${1:?usage: pg_hba_probe.sh PEER_PRIVATE_IP}
PG_VERSION=${PG_VERSION:-17}
PG_CLUSTER=${PG_CLUSTER:-main}
HBA="/etc/postgresql/${PG_VERSION}/${PG_CLUSTER}/pg_hba.conf"
LINE="host postgres replicator ${PEER_IP}/32 scram-sha-256"

if [ ! -f "$HBA" ]; then
  echo "pg_hba not found: $HBA; peer probe not configured" >&2
  exit 0
fi

if grep -qE "^[[:space:]]*host[[:space:]]+postgres[[:space:]]+replicator[[:space:]]+${PEER_IP}/32" "$HBA"; then
  echo "peer probe already allowed from $PEER_IP"
  exit 0
fi

printf '\n# HA start guard: peer role check (read-only)\n%s\n' "$LINE" >> "$HBA"
echo "added peer probe rule for $PEER_IP"

if pg_ctlcluster "$PG_VERSION" "$PG_CLUSTER" status >/dev/null 2>&1; then
  pg_ctlcluster "$PG_VERSION" "$PG_CLUSTER" reload
  echo "PostgreSQL reloaded"
else
  echo "PostgreSQL is stopped; rule will apply on next start"
fi
