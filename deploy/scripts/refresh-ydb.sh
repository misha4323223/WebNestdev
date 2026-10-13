#!/bin/bash
# Обновить YDB_TOKEN в .env и перезапустить контейнер (cron: 0 */6 * * *)
# IAM-токен живёт до 12 ч; контейнер читает YDB_TOKEN из env при старте → нужен рестарт.
set -e
DIR=/home/Misha/webnestdev
TOKEN=$(python3 $DIR/scripts/ydb-token-refresh.py)
[ -n "$TOKEN" ] && [ ${#TOKEN} -gt 20 ] || { echo "empty/short token" >&2; exit 1; }
cd $DIR/src
grep -q '^YDB_TOKEN=' .env || echo 'YDB_TOKEN=' >> .env
sed -i "s|^YDB_TOKEN=.*|YDB_TOKEN=$TOKEN|" .env
docker compose up -d --wait
echo "ydb token refreshed + container restarted $(date -Is)"
