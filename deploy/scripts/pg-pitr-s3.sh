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
#   <prefix>/pitr/basebackup/latest.txt    самый новый ts
#   <prefix>/pitr/basebackup/stable.txt    проверенный ts для restore по умолчанию
#
# latest и stable — разные вещи. Новая копия сразу появляется в S3 и обновляет latest, но
# stable остаётся прежней, пока оператор не выдержит карантин и не выполнит promote. Старые
# объекты base backup при этом не удаляются: при плохой новой копии есть к чему вернуться.
#
# Состояние выгрузки — /var/lib/postgresql/pitr-uploaded.txt: без него пришлось бы спрашивать
# HEAD по каждому из сотен сегментов на каждом запуске.
#
# Режимы:
#   MODE=sync    выгрузить новое (по умолчанию, вызывается таймером)
#   MODE=promote переключить stable.txt на latest.txt после выдержки (по умолчанию 7 дней)
#   MODE=status  что уже выгружено и что ждёт
set -Eeuo pipefail

MODE="${1:-${MODE:-sync}}"
ARCHIVE_DIR="${ARCHIVE_DIR:-/var/lib/postgresql/wal-archive}"
BACKUP_DIR="${BACKUP_DIR:-/var/lib/postgresql/basebackup}"
STATE="${STATE:-/var/lib/postgresql/pitr-uploaded.txt}"
KEEP_BUNDLES="${KEEP_BUNDLES:-2}"
STABLE_PROMOTE_DAYS="${STABLE_PROMOTE_DAYS:-7}"
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

remote_text() {
  local key="$1"
  cli get-object --key "$key" 2>/dev/null | tr -d '\r\n' || true
}

# Timestamp base backup — UTC вида 20261117T213209Z. Возраст считаем по нему, а не по локальному
# mtime: S3 может восстановить объект или перенести его между нодами.
ts_epoch() {
  local ts="$1"
  [[ "$ts" =~ ^([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})Z$ ]] || return 1
  date -u -d "${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]} ${BASH_REMATCH[4]}:${BASH_REMATCH[5]}:${BASH_REMATCH[6]} UTC" +%s
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
  local dir="$1"
  local tar="$dir.tar.gz"
  [ -f "$tar" ] || tar -czf "$tar" -C "$dir" .
  printf '%s' "$tar"
}

# Первый запуск после обновления: stable ещё нет. Считаем текущую последнюю копию stable, чтобы
# restore не остался без указателя. Дальше stable не двигается автоматически.
ensure_stable() {
  local prefix="$1" latest="$2" stable
  stable=$(remote_text "$prefix/pitr/basebackup/stable.txt")
  if [ -n "$stable" ]; then
    return 0
  fi
  printf '%s\n' "$latest" > "$BACKUP_DIR/.stable.txt"
  upload_file "$prefix/pitr/basebackup/stable.txt" "$BACKUP_DIR/.stable.txt"
  rm -f "$BACKUP_DIR/.stable.txt"
  log "stable.txt создан: $latest; следующая копия ждёт promote"
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
    ensure_stable "$PREFIX" "$ts"
    # Локальные бандлы не копим: исходные каталоги нужны для drill, tar — только для вывоза.
    ls -1t "$BACKUP_DIR"/*.tar.gz 2>/dev/null | tail -n +$((KEEP_BUNDLES + 1)) | while read -r old; do
      rm -f "$old"
    done
  fi
}

# Переключение stable — отдельное действие. Автоматически по возрасту нельзя: возраст не
# доказывает, что копия целая. Сначала restore-s3 на этой копии, затем promote.
promote() {
  local role cid prefix latest stable target target_epoch now age
  role=$(sudo -n -u postgres psql -p 5433 -Atc 'select pg_is_in_recovery();' 2>/dev/null || true)
  if [ "$role" != f ]; then
    fail "promote можно делать только на primary (in_recovery=${role:-unknown})"
  fi
  cid=$(container)
  [ -n "$cid" ] || fail "контейнер сервера не найден — S3-клиента нет"
  CID="$cid"
  prefix=$(s3_prefix)
  latest=$(remote_text "$prefix/pitr/basebackup/latest.txt")
  [ -n "$latest" ] || fail "в бакете нет latest.txt"
  stable=$(remote_text "$prefix/pitr/basebackup/stable.txt")
  # PROMOTE_TS обязателен, если за неделю успела появиться ещё одна копия: promote latest
  # в этот момент переключил бы stable на другую, возможно ещё не проверенную копию.
  target="${PROMOTE_TS:-${S3_TS:-}}"
  [ -n "$target" ] || target="$latest"
  if [ "$target" = "$stable" ]; then
    log "stable уже указывает на $target"
    return 0
  fi
  if ! cli head-object --key "$prefix/pitr/basebackup/$target.tar.gz" | grep -q '"exists":true'; then
    fail "в бакете нет архива $target.tar.gz"
  fi
  if [ "${FORCE:-0}" != "1" ]; then
    target_epoch=$(ts_epoch "$target") || fail "не разобрал timestamp $target"
    now=$(date -u +%s)
    age=$(( (now - target_epoch) / 86400 ))
    if [ "$age" -lt "$STABLE_PROMOTE_DAYS" ]; then
      fail "копии $target всего ${age} дн.; stable можно переключить после $STABLE_PROMOTE_DAYS дн. (FORCE=1 — только для bootstrap)"
    fi
  fi
  printf '%s\n' "$target" > "$BACKUP_DIR/.stable.txt"
  upload_file "$prefix/pitr/basebackup/stable.txt" "$BACKUP_DIR/.stable.txt"
  rm -f "$BACKUP_DIR/.stable.txt"
  log "stable переключён: ${stable:--} -> $target; latest остаётся $latest; старый объект остаётся в S3"
}

status() {
  if [ -r "$STATE" ]; then
    echo "state: $(wc -l < "$STATE") сегментов выгружено"
  else
    echo "state: 0 сегментов выгружено (файла $STATE ещё нет)"
  fi
  echo "ждёт: $(find "$ARCHIVE_DIR" -maxdepth 1 -type f -name '0*' 2>/dev/null | wc -l) в архиве"
  local cid prefix latest stable
  cid=$(container)
  if [ -n "$cid" ]; then
    CID="$cid"
    if prefix=$(s3_prefix 2>/dev/null); then
      latest=$(remote_text "$prefix/pitr/basebackup/latest.txt")
      stable=$(remote_text "$prefix/pitr/basebackup/stable.txt")
      echo "s3 latest: ${latest:--}"
      echo "s3 stable: ${stable:--}"
      echo "s3 promote после: $STABLE_PROMOTE_DAYS дн."
    fi
  fi
}

case "$MODE" in
  sync) sync ;;
  promote) promote ;;
  status) status ;;
  *) log "неизвестный MODE=$MODE (sync, promote, status)"; exit 2 ;;
esac
