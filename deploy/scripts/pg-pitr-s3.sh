#!/usr/bin/env bash
#
# Вывоз PITR-архива в S3: WAL-сегменты и base backup (пункт 4.4).
#
# Зачем: локальный архив в /var/lib/postgresql переживает ошибку в данных, но не потерю ВМ.
# Вторая нода для этого не годится — standby хранит только свежий WAL для репликации, а не
# историю. Единственное место, которое переживёт потерю любой ноды, — бакет.
#
# Как устроено без S3-клиента на хосте: файл стримится в контейнер сервера, где ключи уже есть:
#   docker exec -i <server> node server/dist/scripts/postgres-backup.js put-object --key ...
# Обратный путь — `get-object --key ...` в stdout.
#
# Ключи:
#   <prefix>/pitr/wal/<сегмент>            WAL, по одному объекту
#   <prefix>/pitr/wal/index.txt            список выгруженных сегментов (для восстановления)
#   <prefix>/pitr/basebackup/<ts>.tar.gz   физическая копия
#   <prefix>/pitr/basebackup/latest.txt    какой ts восстанавливать
#
# Состояние выгрузки — /var/lib/postgresql/pitr-uploaded.txt: без него пришлось бы спрашивать
# HEAD по каждому из сотен сегментов на каждом запуске.
#
# Режимы:
#   MODE=sync    выгрузить новое (по умолчанию, вызывается таймером)
#   MODE=status  что уже выгружено и что ждёт
set -Eeuo pipefail

MODE="${1:-${MODE:-sync}}"
ARCHIVE_DIR="${ARCHIVE_DIR:-/var/lib/postgresql/wal-archive}"
BACKUP_DIR="${BACKUP_DIR:-/var/lib/postgresql/basebackup}"
STATE="${STATE:-/var/lib/postgresql/pitr-uploaded.txt}"
KEEP_BUNDLES="${KEEP_BUNDLES:-2}"
SERVICE_LABEL="com.docker.compose.service=webnestdev-server"
CLI="node server/dist/scripts/postgres-backup.js"

log() { printf '[pitr-s3] %s\n' "$*" >&2; }
fail() { log "ОШИБКА: $*"; exit 1; }

[ "$(id -u)" = 0 ] || fail "нужен root: sudo $0"

container() {
  docker ps -q --filter "label=$SERVICE_LABEL" | head -n 1
}

cli() {
  docker exec -i "$CID" $CLI "$@" </dev/null
}

# Отдельно от cli: файл едет на stdin, поэтому здесь его нельзя закрывать.
cli_stdin() {
  docker exec -i "$CID" $CLI "$@"
}

# Префикс берём у сервера: он же используется холодным ярусом и дампами.
s3_prefix() {
  cli config | python3 -c 'import json,sys; print(json.load(sys.stdin)["prefix"])'
}

upload_file() {
  local key="$1" file="$2"
  if ! cli_stdin put-object --key "$key" < "$file" >/dev/null; then
    fail "не выгрузился $key"
  fi
  log "выгружен $key ($(du -h "$file" | cut -f1))"
}

# Бандл base backup: pg_basebackup оставляет каталог, а в бакет удобнее один объект.
bundle() {
  local dir="$1" tar="$dir.tar.gz"
  [ -f "$tar" ] || tar -czf "$tar" -C "$dir" .
  printf '%s' "$tar"
}

sync() {
  # На standby архива нет — выгружать нечего; без этой проверки после switchover обе ноды
  # писали бы в один бакет разные (и неполные) наборы.
  if [ "$(sudo -n -u postgres psql -p 5433 -Atc 'select pg_is_in_recovery();' 2>/dev/null)" != f ]; then
    log "узел не primary — выгрузку пропускаю"
    exit 0
  fi
  CID=$(container)
  [ -n "$CID" ] || fail "контейнер сервера не найден — S3-клиента нет"
  # Старый образ не знает put-object: не шумим ошибкой каждые пять минут, а честно пишем,
  # что вывоз включится после выкатки.
  if ! cli head-object --key "$(s3_prefix)/pitr/probe" 2>/dev/null | grep -q '"ok":true'; then
    log "этот образ сервера не умеет put-object — вывоз включится после выкатки"
    exit 0
  fi
  PREFIX=$(s3_prefix)
  touch "$STATE"
  chmod 600 "$STATE"

  local uploaded=0 name
  for file in "$ARCHIVE_DIR"/0*; do
    [ -f "$file" ] || continue
    name=$(basename "$file")
    grep -qxF "$name" "$STATE" && continue
    upload_file "$PREFIX/pitr/wal/$name" "$file"
    printf '%s\n' "$name" >> "$STATE"
    uploaded=$((uploaded + 1))
  done
  if [ "$uploaded" -gt 0 ] || [ ! -s "$STATE" ]; then
    # Индекс — единственный способ перечислить объекты без ListObjects: восстановление знает,
    # какие сегменты скачивать, по этому файлу.
    cli_stdin put-object --key "$PREFIX/pitr/wal/index.txt" < "$STATE" >/dev/null
    log "индекс обновлён: $(wc -l < "$STATE") сегментов"
  fi

  local ts dir tar
  ts=$(sed -n 's/^TS=//p' "$BACKUP_DIR/LATEST" 2>/dev/null || true)
  if [ -n "$ts" ] && [ -d "$BACKUP_DIR/$ts" ]; then
    tar=$(bundle "$BACKUP_DIR/$ts")
    if ! cli head-object --key "$PREFIX/pitr/basebackup/$ts.tar.gz" | grep -q '"exists":true'; then
      upload_file "$PREFIX/pitr/basebackup/$ts.tar.gz" "$tar"
    fi
    printf '%s\n' "$ts" > "$BACKUP_DIR/.latest.txt"
    upload_file "$PREFIX/pitr/basebackup/latest.txt" "$BACKUP_DIR/.latest.txt"
    rm -f "$BACKUP_DIR/.latest.txt"
    # Локальные бандлы не копим: исходные каталоги нужны для drill, tar — только для вывоза.
    ls -1t "$BACKUP_DIR"/*.tar.gz 2>/dev/null | tail -n +$((KEEP_BUNDLES + 1)) | while read -r old; do
      rm -f "$old"
    done
  fi
}

status() {
  if [ -r "$STATE" ]; then
    echo "state: $(wc -l < "$STATE") сегментов выгружено"
  else
    echo "state: 0 сегментов выгружено (файла $STATE ещё нет)"
  fi
  echo "ждёт: $(find "$ARCHIVE_DIR" -maxdepth 1 -type f -name '0*' 2>/dev/null | wc -l) в архиве"
}

case "$MODE" in
  sync) sync ;;
  status) status ;;
  *) log "неизвестный MODE=$MODE (sync, status)"; exit 2 ;;
esac
