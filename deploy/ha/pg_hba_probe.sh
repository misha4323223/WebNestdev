#!/usr/bin/env bash
# Разрешает guard-проверке подключиться к локальному PostgreSQL peer-узла
# под существующей ролью replicator (только чтение роли, без доступа к данным),
# а API — ходить через локальный HAProxy напрямую в PostgreSQL peer-узла.
#
# Использование: ./pg_hba_probe.sh PEER_PRIVATE_IP
set -euo pipefail

PEER_IP=${1:?usage: pg_hba_probe.sh PEER_PRIVATE_IP}
PG_VERSION=${PG_VERSION:-17}
PG_CLUSTER=${PG_CLUSTER:-main}
HBA="/etc/postgresql/${PG_VERSION}/${PG_CLUSTER}/pg_hba.conf"
TLS_CERT="/etc/postgresql/${PG_VERSION}/${PG_CLUSTER}/tls/server.crt"
# После pg_tls.sh PostgreSQL принимает только TLS; hostssl заставляет и guard-проверку
# идти по TLS. До появления сертификата оставляем прежнее host-правило, иначе установка
# на свежей ноде сломала бы проверку роли peer.
if [ -s "$TLS_CERT" ]; then
  TYPE=hostssl
else
  TYPE=host
fi
PROBE_LINE="$TYPE postgres replicator ${PEER_IP}/32 scram-sha-256"
APP_LINE="$TYPE webnestdev webnestdev ${PEER_IP}/32 scram-sha-256"
CHANGED=0

if [ ! -f "$HBA" ]; then
  echo "pg_hba not found: $HBA; peer probe not configured" >&2
  exit 0
fi

add_rule(){
  local pattern=$1 comment=$2 line=$3 label=$4
  if grep -qE "$pattern" "$HBA"; then
    echo "$label already allowed from $PEER_IP"
    return 0
  fi
  printf '\n# %s\n%s\n' "$comment" "$line" >> "$HBA"
  echo "added $label rule for $PEER_IP"
  CHANGED=1
}

add_rule "^[[:space:]]*${TYPE}[[:space:]]+postgres[[:space:]]+replicator[[:space:]]+${PEER_IP}/32" \
  "HA start guard: peer role check (read-only)" "$PROBE_LINE" "peer probe"
# Прямой peer-маршрут API: локальный HAProxy подключается к PostgreSQL соседа
# от имени приложения, а не через HAProxy соседа.
add_rule "^[[:space:]]*${TYPE}[[:space:]]+webnestdev[[:space:]]+webnestdev[[:space:]]+${PEER_IP}/32" \
  "HA API: direct PostgreSQL peer connection" "$APP_LINE" "application peer"

if [ "$CHANGED" = "1" ]; then
  if pg_ctlcluster "$PG_VERSION" "$PG_CLUSTER" status >/dev/null 2>&1; then
    pg_ctlcluster "$PG_VERSION" "$PG_CLUSTER" reload
    echo "PostgreSQL reloaded"
  else
    echo "PostgreSQL is stopped; rule will apply on next start"
  fi
fi
