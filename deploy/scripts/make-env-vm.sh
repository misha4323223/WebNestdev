#!/bin/bash
set -e
cd ~/webnestdev/src

# The encryption key must survive a redeploy: it decrypts connected integrations and
# provider tokens, and a freshly generated key makes everything encrypted earlier
# unreadable. Reuse the one already written when it has the expected shape.
if [ -f .env ] && grep -q '^WEBNESTDEV_ENCRYPTION_KEY=[a-f0-9]\{64\}$' .env; then
  ENCKEY=$(grep '^WEBNESTDEV_ENCRYPTION_KEY=' .env | head -1 | cut -d= -f2)
  echo "ENV-KEY-REUSED"
else
  ENCKEY=$(openssl rand -hex 32)
  echo "ENV-KEY-CREATED"
fi

# Accounts, projects and conversations live here. The path is outside the source tree on
# purpose: a redeploy replaces the code directory, and data kept inside it disappears.
DATA_DIR="$HOME/webnestdev/data"
mkdir -p "$DATA_DIR"

# Каталог песочниц и предпросмотра. Docker запускает контейнеры проектов с -v <путь>,
# и путь разбирается на хосте, поэтому он должен совпадать с тем, что смонтирован внутрь
# серверного контейнера (см. docker-compose.yml). Именованный том здесь не годится.
# Путь совпадает с значением по умолчанию в docker-compose.yml: если он здесь и там
# разойдётся, контейнеры и сервер начнут смотреть в разные каталоги.
SANDBOX_DIR="/var/lib/webnestdev/sandboxes"
if ! mkdir -p "$SANDBOX_DIR" 2>/dev/null; then
  echo "каталог $SANDBOX_DIR недоступен для записи. Выполните один раз:" >&2
  echo "  sudo mkdir -p $SANDBOX_DIR && sudo chmod 0775 $SANDBOX_DIR" >&2
  exit 1
fi
chmod 0775 "$SANDBOX_DIR" 2>/dev/null || true

# docker-compose.yml requires POSTGRES_PASSWORD: the postgres service and the server's
# DATABASE_URL are both built from it, and without it `docker compose up` refuses to start.
# It is reused when present — postgres only reads it while creating the data volume, so a
# fresh password on an existing volume breaks the connection.
if [ -f .env ] && grep -q '^POSTGRES_PASSWORD=.\+' .env; then
  PGPASS=$(grep '^POSTGRES_PASSWORD=' .env | head -1 | cut -d= -f2-)
  echo "PGPASS-REUSED"
else
  PGPASS=$(openssl rand -hex 16)
  echo "PGPASS-CREATED"
fi

{
  printf 'NODE_ENV=production\n'
  # WEBNESTDEV_STORAGE now accepts exactly two values: json and postgres. The old `ydb`
  # value is not a backend any more — the server used to fall back to json files without
  # saying so, which is why stored conversations looked lost.
  printf 'WEBNESTDEV_STORAGE=json\n'
  printf 'WEBNESTDEV_DATA_DIR=%s\n' "$DATA_DIR"
  printf 'SANDBOX_DIR=%s\n' "$SANDBOX_DIR"
  printf 'WEBNESTDEV_ENCRYPTION_KEY=%s\n' "$ENCKEY"
  printf 'WEBNESTDEV_ALLOWED_ORIGINS=http://178.236.27.102:8787,http://localhost:8787\n'
  # Пароль базы: docker-compose.yml без него не поднимется (см. проверку выше).
  printf 'POSTGRES_PASSWORD=%s\n' "$PGPASS"
} > .env
chmod 600 .env
echo "LINES=$(wc -l < .env)"
echo "ENCLEN=$(grep -c '^WEBNESTDEV_ENCRYPTION_KEY=[a-f0-9]\{64\}$' .env)"
echo "DATADIR=$(grep '^WEBNESTDEV_DATA_DIR=' .env | cut -d= -f2)"
echo "SANDBOXDIR=$(grep '^SANDBOX_DIR=' .env | cut -d= -f2)"
echo "PGPASS=$(grep -c '^POSTGRES_PASSWORD=.\+' .env)"
echo "ENV-READY"
