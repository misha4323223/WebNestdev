#!/usr/bin/env bash
# Учебное выключение node-2 через MWS. Скрипт только выключает ВМ и наблюдает;
# promotion делает webnestdev-failover.service. Включение обратно — отдельный шаг.
set -euo pipefail

set -a
. /etc/webnestdev-ha/mws.env
. /etc/webnestdev-ha/regru.env
set +a
cd /opt/webnestdev-ha

echo "start=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
python3 cli.py power OFF
echo "power_off_confirmed=$(date -u +%Y-%m-%dT%H:%M:%SZ)"

deadline=$((SECONDS + 240))
while [ "$SECONDS" -lt "$deadline" ]; do
  recovery=$(sudo -u postgres psql -p 5433 -tAc "select pg_is_in_recovery()" 2>/dev/null || echo "error")
  api=$(curl -s -m 3 -o /dev/null -w "%{http_code}" http://127.0.0.1:8787/api/ready || true)
  echo "t=$(date -u +%Y-%m-%dT%H:%M:%SZ) recovery=${recovery:-?} api=${api:-?}"
  if [ "$recovery" = "f" ] && [ "$api" = "200" ]; then
    echo "ready=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    break
  fi
  sleep 3
done

echo "--- status ---"
python3 cli.py status
echo "--- journal ---"
journalctl -u webnestdev-failover -n 30 --no-pager
