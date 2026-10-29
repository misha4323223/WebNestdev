#!/usr/bin/env bash
#
# Резервная копия PostgreSQL: дамп, загрузка в S3-совместимое хранилище, проверка свежести
# и учебное восстановление в отдельную базу.
#
# Скрипт выполняется НА ВМ (в том числе через `ssh … "bash -s" < deploy/scripts/pg-backup.sh`),
# поэтому дамп снимает контейнер `postgres:17`: клиент `pg_dump` должен быть той же версии, что
# сервер. Загрузку и проверку суммы делает `server/dist/scripts/postgres-backup.js` внутри
# контейнера сервера — там есть S3-клиент и ключи хранилища.
#
# Режимы:
#   MODE=backup        снять дамп, проверить целостность, загрузить, обновить latest.json
#   MODE=check         проверить, что последний бэкап не старше BACKUP_MAX_AGE_HOURS и его размер
#                      совпадает с манифестом (ничего не скачивает)
#   MODE=restore-drill скачать последний бэкап, восстановить в базу restore_check_<время>,
#                      проверить таблицы и удалить её (KEEP_RESTORE_DB=1 — оставить для разбора)
#
# Переменные:
#   APP_DIR=~/webnestdev/src       каталог с docker-compose.yml и .env
#   COMPOSE_FILE=docker-compose.yml
#   SERVICE=webnestdev-server      сервис, внутри которого живёт S3-клиент
#   PG_SERVICE=postgres            сервис базы
#   BACKUP_MAX_AGE_HOURS=30        предел возраста для MODE=check
#   RESTORE_DB_PREFIX=restore_check
#   KEEP_RESTORE_DB=0              не удалять учебную базу после восстановления
#
# Код возврата: 0 — успех (в том числе «бэкап уже идёт»), 1 — ошибка, 2 — неверный MODE.
set -Eeuo pipefail
umask 077

MODE="${MODE:-backup}"
APP_DIR="${APP_DIR:-$HOME/webnestdev/src}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
SERVICE="${SERVICE:-webnestdev-server}"
PG_SERVICE="${PG_SERVICE:-postgres}"
BACKUP_MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-30}"
RESTORE_DB_PREFIX="${RESTORE_DB_PREFIX:-restore_check}"
KEEP_RESTORE_DB="${KEEP_RESTORE_DB:-0}"

TMP=""
SCRATCH=""
PG_DB=""
PG_USER=""
DB_IDENT='^[A-Za-z0-9_][A-Za-z0-9_-]{0,62}$'

log() { printf '[pg-backup] %s\n' "$*" >&2; }
fail() { log "ОШИБКА: $*"; exit 1; }

dc_exec() { docker compose -f "$COMPOSE_FILE" exec -T "$@"; }

cleanup() {
  if [ -n "${SCRATCH:-}" ] && [ "$KEEP_RESTORE_DB" != "1" ] && [ -n "${PG_USER:-}" ]; then
    dc_exec "$PG_SERVICE" psql -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 \
      -c "DROP DATABASE IF EXISTS \"$SCRATCH\" WITH (FORCE)" >/dev/null 2>&1 || true
  fi
  if [ -n "${TMP:-}" ]; then rm -rf "$TMP"; fi
}
trap cleanup EXIT

[ -d "$APP_DIR" ] || fail "каталог развёртывания не найден: $APP_DIR"
cd "$APP_DIR"
command -v docker >/dev/null 2>&1 || fail "docker не найден на этой машине"
docker compose version >/dev/null 2>&1 || fail "docker compose недоступен"

# Один бэкап за раз: две одновременные загрузки не опасны, но засоряют хранилище и мешают
# журналу. Занятая блокировка — это не ошибка: следующий запуск просто не нужен.
if [ "$MODE" = "backup" ]; then
  command -v flock >/dev/null 2>&1 || fail "flock не найден: без него нельзя гарантировать один бэкап за раз"
  exec 9>"${TMPDIR:-/tmp}/webnestdev-pg-backup.lock"
  if ! flock -n 9; then
    log "бэкап уже выполняется — этот запуск пропущен"
    exit 0
  fi
fi

read_database() {
  PG_DB=$(dc_exec "$PG_SERVICE" sh -lc 'printf %s "${POSTGRES_DB:?}"') || fail "не удалось прочитать POSTGRES_DB"
  PG_USER=$(dc_exec "$PG_SERVICE" sh -lc 'printf %s "${POSTGRES_USER:?}"') || fail "не удалось прочитать POSTGRES_USER"
  [[ "$PG_DB" =~ $DB_IDENT ]] || fail "некорректное имя базы: $PG_DB"
  [[ "$PG_USER" =~ $DB_IDENT ]] || fail "некорректное имя пользователя базы: $PG_USER"
}

database_bytes() {
  local raw
  raw=$(dc_exec "$PG_SERVICE" psql -U "$PG_USER" -d "$PG_DB" -tAc 'SELECT pg_database_size(current_database())') \
    || fail "не удалось узнать размер базы"
  raw=$(printf '%s' "$raw" | tr -d '[:space:]')
  [[ "$raw" =~ ^[0-9]+$ ]] || fail "база вернула некорректный размер: $raw"
  printf '%s' "$raw"
}

free_kb() {
  local value
  value=$(df -Pk "$APP_DIR" | awk 'NR==2 {print $4}')
  [[ "$value" =~ ^[0-9]+$ ]] || fail "не удалось узнать свободное место в $APP_DIR"
  printf '%s' "$value"
}

# Временный дамп и будущая восстановленная база занимают место одновременно. Требуем тройной
# запас: дамп сжатый, но распакованная база больше него, а полный диск на этой ВМ ломает
# Postgres, сборки и запись файлов сразу.
require_space() {
  local bytes="$1" factor="${2:-3}" free need
  free=$(free_kb)
  need=$(( bytes / 1024 * factor + 102400 ))
  if [ "$free" -lt "$need" ]; then
    fail "мало места: свободно ${free} КБ, нужно около ${need} КБ (объект ${bytes} байт, запас ×${factor})"
  fi
}

run_backup() {
  local db_bytes before dump size upload started
  db_bytes=$(database_bytes)
  require_space "$db_bytes"

  TMP=$(mktemp -d "${TMPDIR:-/tmp}/webnestdev-pg-backup.XXXXXX") || fail "не удалось создать временный каталог"
  dump="$TMP/db.dump"
  before=$(free_kb)
  started=$(date +%s)
  log "дамп базы $PG_DB: $((db_bytes / 1024 / 1024)) МБ, свободно $((before / 1024)) МБ"

  if ! dc_exec "$PG_SERVICE" sh -lc \
    'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-privileges --lock-wait-timeout=30s' \
    > "$dump"; then
    fail "pg_dump завершился с ошибкой"
  fi

  size=$(wc -c < "$dump" | tr -d '[:space:]')
  [[ "$size" =~ ^[0-9]+$ ]] || fail "не удалось посчитать размер дампа"
  [ "$size" -ge 1024 ] || fail "дамп подозрительно мал: $size байт"
  # `pg_restore -l` читает оглавление архива: это дешёвая проверка, что дамп не обрезан.
  if ! dc_exec "$PG_SERVICE" pg_restore -l < "$dump" >/dev/null; then
    fail "дамп не читается pg_restore -l"
  fi

  log "загружаю дамп ($size байт) в хранилище"
  if ! upload=$(dc_exec "$SERVICE" node server/dist/scripts/postgres-backup.js put --database "$PG_DB" < "$dump"); then
    fail "загрузка дампа в хранилище не удалась"
  fi
  case "$upload" in
    *'"ok":true'*) ;;
    *) fail "загрузчик вернул неожиданный ответ: $upload" ;;
  esac
  printf '%s\n' "$upload"
  rm -rf "$TMP"
  TMP=""
  log "бэкап готов за $(( $(date +%s) - started )) с"
}

run_check() {
  log "проверяю свежесть последнего бэкапа базы $PG_DB (предел ${BACKUP_MAX_AGE_HOURS} ч)"
  if ! dc_exec "$SERVICE" node server/dist/scripts/postgres-backup.js check \
    --database "$PG_DB" --max-age-hours "$BACKUP_MAX_AGE_HOURS"; then
    fail "проверка свежести бэкапа не прошла"
  fi
}

run_restore_drill() {
  local manifest key sha bytes tables
  manifest=$(dc_exec "$SERVICE" node server/dist/scripts/postgres-backup.js manifest --database "$PG_DB") \
    || fail "не удалось прочитать манифест последнего бэкапа"
  key=$(printf '%s' "$manifest" | sed -n 's/.*"key":"\([^"]*\)".*/\1/p')
  sha=$(printf '%s' "$manifest" | sed -n 's/.*"sha256":"\([0-9a-f]*\)".*/\1/p')
  bytes=$(printf '%s' "$manifest" | sed -n 's/.*"bytes":\([0-9][0-9]*\).*/\1/p')
  [ -n "$key" ] || fail "в манифесте нет ключа бэкапа"
  [ -n "$sha" ] || fail "в манифесте нет контрольной суммы"
  [[ "$bytes" =~ ^[0-9]+$ ]] || fail "в манифесте нет корректного размера"
  case "$key" in
    */backups/postgres/*) ;;
    *) fail "манифест указывает вне каталога бэкапов: $key" ;;
  esac
  # Распакованная база больше сжатого дампа: для учебного восстановления запас шире.
  require_space "$bytes" 5

  # PID в имени — чтобы два учебных восстановления, начатые в одну секунду, не делили базу.
  SCRATCH="${RESTORE_DB_PREFIX}_$(date -u +%Y%m%d_%H%M%S)_$$"
  [[ "$SCRATCH" =~ ^[A-Za-z0-9_]{1,63}$ ]] || fail "некорректное имя учебной базы: $SCRATCH"
  [ "$SCRATCH" != "$PG_DB" ] || fail "учебная база совпала с рабочей — восстановление отменено"

  log "восстанавливаю $key в $SCRATCH ($bytes байт)"
  dc_exec "$PG_SERVICE" psql -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE \"$SCRATCH\"" >/dev/null || fail "не удалось создать учебную базу $SCRATCH"

  # `pipefail` важен: если скачивание или проверка суммы сорвётся, pg_restore получит пустой
  # поток, и без pipefail код возврата конвейера мог бы остаться нулевым.
  if ! dc_exec "$SERVICE" node server/dist/scripts/postgres-backup.js get --key "$key" --sha256 "$sha" \
    | dc_exec "$PG_SERVICE" pg_restore -U "$PG_USER" -d "$SCRATCH" --no-owner --no-privileges --exit-on-error; then
    fail "восстановление в $SCRATCH не прошло"
  fi

  tables=$(dc_exec "$PG_SERVICE" psql -U "$PG_USER" -d "$SCRATCH" -tAc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')")
  tables=$(printf '%s' "$tables" | tr -d '[:space:]')
  [[ "$tables" =~ ^[0-9]+$ ]] || fail "не удалось посчитать таблицы в $SCRATCH"
  [ "$tables" -gt 0 ] || fail "в восстановленной базе нет таблиц"

  if [ "$KEEP_RESTORE_DB" = "1" ]; then
    log "восстановление проверено: $tables таблиц; база $SCRATCH оставлена (KEEP_RESTORE_DB=1)"
    SCRATCH=""
  else
    dc_exec "$PG_SERVICE" psql -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 \
      -c "DROP DATABASE IF EXISTS \"$SCRATCH\" WITH (FORCE)" >/dev/null || fail "не удалось удалить учебную базу $SCRATCH"
    SCRATCH=""
    log "восстановление проверено: $tables таблиц; учебная база удалена"
  fi
}

case "$MODE" in
  backup|check|restore-drill) ;;
  *)
    log "неизвестный MODE=$MODE (ожидается backup, check или restore-drill)"
    exit 2
    ;;
esac

read_database
case "$MODE" in
  backup) run_backup ;;
  check) run_check ;;
  restore-drill) run_restore_drill ;;
esac
