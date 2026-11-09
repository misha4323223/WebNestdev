#!/usr/bin/env bash
# Установка контроллера на node-2. Код общий с node-1; отличаются только env и service.
# Секреты не создаёт: /etc/webnestdev-ha/{mws,regru}.env должны быть положены отдельно
# с правами 600. Повторный запуск безопасен.
set -euo pipefail

SRC=$(cd "$(dirname "$0")" && pwd)
DST=/opt/webnestdev-ha
CONF=/etc/webnestdev-ha

install -d -m 755 "$DST"
install -d -m 700 "$CONF"
install -d -m 755 /var/lib/webnestdev-ha
install -d -m 755 /etc/systemd/system/postgresql@17-main.service.d
install -m 644 "$SRC/mws.py" "$SRC/regru.py" "$SRC/postgres.py" "$SRC/db_proxy.py" "$SRC/storage_quorum.py" "$SRC/control.py" "$SRC/switchover.py" "$SRC/failover.py" "$SRC/cli.py" "$SRC/standby.sh" "$SRC/pg_start_guard.py" "$SRC/pg_hba_probe.sh" "$SRC/README.md" "$DST/"
install -m 600 "$SRC/pg-guard-node2.env" "$CONF/guard.env"
install -m 644 "$SRC/webnestdev-pg-guard.conf" /etc/systemd/system/postgresql@17-main.service.d/webnestdev-pg-guard.conf
install -m 644 "$SRC/webnestdev-failover-node2.service" /etc/systemd/system/webnestdev-failover-node2.service

if ! command -v haproxy >/dev/null 2>&1; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq haproxy
fi

for file in mws.env regru.env replication.env; do
  if [ ! -r "$CONF/$file" ]; then
    echo "missing $CONF/$file (mode 600); install it before starting the controller" >&2
    exit 1
  fi
done

if [ ! -r "$CONF/node2.env" ]; then
  echo "note: $CONF/node2.env is absent; using the defaults from the service" >&2
fi

bash "$SRC/pg_hba_probe.sh" 10.0.0.4
systemctl daemon-reload
systemctl enable --now haproxy
systemctl enable webnestdev-failover-node2.service
echo "installed $DST and webnestdev-failover-node2.service; secrets: $CONF/{mws,regru}.env"
echo "start with: systemctl start webnestdev-failover-node2.service"
