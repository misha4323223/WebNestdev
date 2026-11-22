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
mapfile -t HA_RUNTIME_FILES < <(sed -e 's/#.*//' -e '/^[[:space:]]*$/d' "$SRC/runtime-files.txt")
[ "${#HA_RUNTIME_FILES[@]}" -gt 0 ] || { echo "$SRC/runtime-files.txt пуст" >&2; exit 1; }
install -m 644 "${HA_RUNTIME_FILES[@]/#/$SRC/}" "$DST/"
install -m 600 "$SRC/pg-guard-node1.env" /etc/webnestdev-ha/guard.env
install -m 644 "$SRC/webnestdev-pg-guard.conf" /etc/systemd/system/postgresql@17-main.service.d/webnestdev-pg-guard.conf
install -m 644 "$SRC/webnestdev-failover.service" /etc/systemd/system/webnestdev-failover.service

for file in mws.env replication.env; do
  if [ ! -r "/etc/webnestdev-ha/$file" ]; then
    echo "missing /etc/webnestdev-ha/$file (mode 600); the PG start guard cannot verify the peer" >&2
    exit 1
  fi
done

# TLS обязателен до hostssl-правил. PKI создаёт отдельный CA и уникальные
# сертификаты нод; node2-sync.sh передаёт node-2 её собственный сертификат.
bash "$SRC/pg_pki.sh" setup
bash "$SRC/pg_hba_probe.sh" 10.0.0.5
RUNNER_CONTAINER=node1-runner bash "$SRC/install-storage-guard.sh"
systemctl daemon-reload
systemctl enable --now haproxy
systemctl enable webnestdev-failover.service
echo "installed $DST; секреты: /etc/webnestdev-ha/{mws,regru}.env"
