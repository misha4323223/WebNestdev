#!/usr/bin/env bash
# Установка контроллера failover на node-1. Секреты не создаёт: mws.env и regru.env
# кладутся отдельно с правами 600. Повторный запуск безопасен.
set -euo pipefail

SRC=$(cd "$(dirname "$0")" && pwd)
DST=/opt/webnestdev-ha

install -d -m 755 "$DST"
install -d -m 700 /etc/webnestdev-ha
install -d -m 755 /var/lib/webnestdev-ha
install -d -m 755 /etc/systemd/system/postgresql@17-main.service.d
install -m 644 "$SRC/mws.py" "$SRC/regru.py" "$SRC/postgres.py" "$SRC/db_proxy.py" "$SRC/storage_quorum.py" "$SRC/control.py" "$SRC/switchover.py" "$SRC/failover.py" "$SRC/cli.py" "$SRC/standby.sh" "$SRC/pg_start_guard.py" "$SRC/pg_hba_probe.sh" "$SRC/README.md" "$DST/"
install -m 600 "$SRC/pg-guard-node1.env" /etc/webnestdev-ha/guard.env
install -m 644 "$SRC/webnestdev-pg-guard.conf" /etc/systemd/system/postgresql@17-main.service.d/webnestdev-pg-guard.conf
install -m 644 "$SRC/webnestdev-failover.service" /etc/systemd/system/webnestdev-failover.service

for file in mws.env replication.env; do
  if [ ! -r "/etc/webnestdev-ha/$file" ]; then
    echo "missing /etc/webnestdev-ha/$file (mode 600); the PG start guard cannot verify the peer" >&2
    exit 1
  fi
done

bash "$SRC/pg_hba_probe.sh" 10.0.0.5
systemctl daemon-reload
systemctl enable --now haproxy
systemctl enable webnestdev-failover.service
echo "installed $DST; секреты: /etc/webnestdev-ha/{mws,regru}.env"
