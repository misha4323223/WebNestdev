#!/bin/bash
set -e
cd ~/webnestdev/src
ENCKEY=$(openssl rand -hex 32)
T=$(python3 ~/webnestdev/scripts/ydb-token-refresh.py)
{
  printf 'NODE_ENV=production\n'
  printf 'WEBNESTDEV_STORAGE=ydb\n'
  printf 'WEBNESTDEV_ENCRYPTION_KEY=%s\n' "$ENCKEY"
  printf 'WEBNESTDEV_ALLOWED_ORIGINS=http://178.236.27.102:8787,http://localhost:8787\n'
  printf 'YDB_CONNECTION_STRING=grpcs://ydb.serverless.yandexcloud.net:2135/ru-central1/b1gpj9488h3k7oaa3foh/etnk2b9gihblr0mitfim\n'
  printf 'YDB_TOKEN=%s\n' "$T"
} > .env
chmod 600 .env
echo "LINES=$(wc -l < .env)"
echo "ENCLEN=$(grep -c '^WEBNESTDEV_ENCRYPTION_KEY=[a-f0-9]\{64\}$' .env)"
echo "TOKLEN=$(awk -F= '/^YDB_TOKEN=/{print length($2)}' .env)"
echo "ENV-READY"
