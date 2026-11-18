#!/usr/bin/env bash
# Бэкап клиентской базы: по дампу на схему аккаунта.
#
#   ./backup.sh backup              снять дампы всех схем и удалить старые
#   ./backup.sh restore SCHEMA FILE восстановить одну схему из дампа в базу
#   ./backup.sh list                показать последние дампы
#
# Дампы снимаются с локального кластера, но по возможности со standby: pg_dump на реплике не
# мешает записи. Загрузка в S3 — через `CLIENT_DB_BACKUP_UPLOAD` (команда получает путь в $1),
# потому что S3-клиент и ключи живут в контейнере сервера, а не на хосте.
set -Eeuo pipefail

PG_VERSION=${PG_VERSION:-17}
PG_PORT=${PG_PORT:-5434}
PG_DB=${PG_DB:-app}
DIR=${CLIENT_DB_BACKUP_DIR:-/var/backups/webnestdev/client-db}
KEEP_DAYS=${CLIENT_DB_BACKUP_KEEP_DAYS:-7}
UPLOAD=${CLIENT_DB_BACKUP_UPLOAD:-}
MODE=${1:-backup}

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "[client-db-backup] $*"; }
fail() { log "ОШИБКА: $*"; exit 1; }

sql() { sudo -n -u postgres psql -p "$PG_PORT" -d "$PG_DB" -tAc "$1"; }

case "$MODE" in
  backup)
    [ "$(sql "SELECT to_regclass('nestdev_admin.tenants') IS NOT NULL")" = "t" ] ||
      fail "учётной таблицы нет: клиентская база не инициализирована"
    stamp=$(date -u +%Y%m%dT%H%M%SZ)
    mkdir -p "$DIR"
    count=0
    while IFS= read -r schema; do
      [ -n "$schema" ] || continue
      [[ "$schema" =~ ^tenant_[0-9a-f]{16}$ ]] || { log "пропускаю неожиданное имя схемы"; continue; }
      target="$DIR/${schema}-${stamp}.dump"
      if sudo -n -u postgres pg_dump -p "$PG_PORT" -d "$PG_DB" -n "$schema" \
        --format=custom --no-owner --no-privileges --lock-wait-timeout=30s > "$target"; then
        count=$((count + 1))
        [ -n "$UPLOAD" ] && eval "$UPLOAD \"$target\""
      else
        rm -f "$target"
        log "дамп схемы $schema не удался"
      fi
    done < <(sql "SELECT schema_name FROM nestdev_admin.tenants ORDER BY schema_name")
    find "$DIR" -name 'tenant_*.dump' -mtime +"$KEEP_DAYS" -delete
    log "готово дампов: $count, каталог $DIR, хранение $KEEP_DAYS дней"
    ;;
  restore)
    schema=${2:?usage: backup.sh restore SCHEMA FILE}
    file=${3:?usage: backup.sh restore SCHEMA FILE}
    [ -f "$file" ] || fail "файла $file нет"
    [[ "$schema" =~ ^tenant_[0-9a-f]{16}$ ]] || fail "некорректное имя схемы"
    sudo -n -u postgres psql -p "$PG_PORT" -d "$PG_DB" -v ON_ERROR_STOP=1 \
      -c "CREATE SCHEMA IF NOT EXISTS \"$schema\" AUTHORIZATION \"$schema\""
    sudo -n -u postgres pg_restore -p "$PG_PORT" -d "$PG_DB" -n "$schema" --no-owner "$file"
    log "схема $schema восстановлена из $file"
    ;;
  list)
    find "$DIR" -name 'tenant_*.dump' -printf '%TY-%Tm-%Td %TH:%TM %s %p\n' 2>/dev/null |
      sort | tail -n 20 || true
    ;;
  *)
    echo "usage: backup.sh backup|restore SCHEMA FILE|list" >&2
    exit 64
    ;;
esac
