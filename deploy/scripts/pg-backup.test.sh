#!/usr/bin/env bash
#
# Проверка оболочки бэкапа без Docker и без базы: `docker` подменяется заглушкой, которая
# отвечает как compose-сервисы. Проверяются ветки backup, check и restore-drill, отказ загрузки
# и обязательная уборка учебной базы после неудачного восстановления.
#
# Запуск: bash deploy/scripts/pg-backup.test.sh
set -Eeuo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/pg-backup-test.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/app" "$WORK/bin" "$WORK/tmp"

DUMP="$WORK/dump"
head -c 2048 /dev/zero | tr '\0' 'x' > "$DUMP"
LOG="$WORK/calls.log"
: > "$LOG"

cat > "$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$STUB_LOG"
# Настоящий `docker compose exec -T` читает stdin. Этот режим воспроизводит случай, когда
# скрипт передан через `bash -s` и первый же exec может съесть его остаток. `compose version`
# stdin не читает, поэтому глотаем его только на exec.
if [ "${STUB_EAT_STDIN:-0}" = "1" ]; then
  case "$*" in *"exec -T"*) cat >/dev/null || true ;; esac
fi

case "$*" in
  "compose version") exit 0 ;;
  *"exec -T postgres sh -lc"*"pg_dump"*) cat "$STUB_DUMP" ;;
  *"exec -T postgres sh -lc"*"printf %s"*"POSTGRES_DB"*) printf '%s' "${STUB_DB:-webnestdev}" ;;
  *"exec -T postgres sh -lc"*"printf %s"*"POSTGRES_USER"*) printf '%s' "${STUB_USER:-webnestdev}" ;;
  *"exec -T postgres pg_restore -l"*) cat >/dev/null ;;
  *"exec -T postgres psql"*"pg_database_size"*) printf '%s' "${STUB_DB_BYTES:-4194304}" ;;
  *"exec -T postgres psql"*"CREATE DATABASE"*) exit 0 ;;
  *"exec -T postgres psql"*"DROP DATABASE"*) exit 0 ;;
  *"exec -T postgres psql"*"count(*)"*) printf '%s' "${STUB_TABLES:-42}" ;;
  *"exec -T postgres pg_restore"*)
    cat >/dev/null
    [ "${STUB_RESTORE_FAIL:-0}" = "1" ] && exit 1
    exit 0
    ;;
  *"exec -T webnestdev-server node server/dist/scripts/postgres-backup.js put"*)
    cat >/dev/null
    [ "${STUB_UPLOAD_FAIL:-0}" = "1" ] && { echo "upload failed" >&2; exit 1; }
    printf '{"ok":true,"key":"webnestdev/backups/postgres/webnestdev/2026/10/29/webnestdev-20261029T000000Z.dump","bytes":2048,"sha256":"%s","createdAt":"2026-10-29T00:00:00.000Z"}\n' \
      "$(printf 'a%.0s' {1..64})"
    ;;
  *"exec -T webnestdev-server node server/dist/scripts/postgres-backup.js check"*)
    [ "${STUB_CHECK_FAIL:-0}" = "1" ] && { echo "stale" >&2; exit 1; }
    printf '{"ok":true,"ageHours":1}\n'
    ;;
  *"exec -T webnestdev-server node server/dist/scripts/postgres-backup.js manifest"*)
    printf '{"version":1,"database":"webnestdev","key":"webnestdev/backups/postgres/webnestdev/2026/10/29/webnestdev-20261029T000000Z.dump","bytes":2048,"sha256":"%s","createdAt":"2026-10-29T00:00:00.000Z"}\n' \
      "$(printf 'a%.0s' {1..64})"
    ;;
  *"exec -T webnestdev-server node server/dist/scripts/postgres-backup.js get"*)
    cat "$STUB_DUMP"
    ;;
  *) echo "unexpected docker: $*" >&2; exit 99 ;;
esac
STUB
chmod +x "$WORK/bin/docker"

run_script() {
  local name="$1" mode="$2"
  shift 2
  set +e
  env PATH="$WORK/bin:$PATH" MODE="$mode" APP_DIR="$WORK/app" TMPDIR="$WORK/tmp" \
    STUB_LOG="$LOG" STUB_DUMP="$DUMP" "$@" \
    bash "$ROOT/deploy/scripts/pg-backup.sh" > "$WORK/$name.out" 2> "$WORK/$name.err"
  CODE=$?
  set -e
}

expect_code() {
  [ "$CODE" -eq "$1" ] || {
    echo "FAIL: ожидался код $1, получен $CODE"
    sed 's/^/  err: /' "$WORK/$CASE.err" || true
    exit 1
  }
}

expect_file() {
  local pattern="$1" file="$2"
  grep -q -- "$pattern" "$file" || {
    echo "FAIL: не найдено «$pattern» в $file"
    sed 's/^/  /' "$file" || true
    exit 1
  }
}

expect_no_file() {
  local pattern="$1" file="$2"
  if grep -q -- "$pattern" "$file"; then
    echo "FAIL: неожиданное «$pattern» в $file"
    sed 's/^/  /' "$file"
    exit 1
  fi
}

echo "ok - бэкап: дамп, проверка архива, загрузка, уборка временных файлов"
CASE=backup
: > "$LOG"
run_script backup backup
expect_code 0
expect_file '"ok":true' "$WORK/backup.out"
expect_file 'pg_dump' "$LOG"
expect_file 'postgres-backup.js put --database webnestdev' "$LOG"
expect_file 'бэкап готов' "$WORK/backup.err"
if find "$WORK/tmp" -maxdepth 1 -type d -name 'webnestdev-pg-backup.*' | grep -q .; then
  echo "FAIL: временный каталог бэкапа остался"; exit 1
fi

echo "ok - бэкап: ошибка загрузки возвращает ненулевой код и не оставляет дамп"
CASE=backup-upload-fail
: > "$LOG"
run_script backup-upload-fail backup STUB_UPLOAD_FAIL=1
expect_code 1
expect_file 'загрузка дампа' "$WORK/backup-upload-fail.err"
if find "$WORK/tmp" -maxdepth 1 -type d -name 'webnestdev-pg-backup.*' | grep -q .; then
  echo "FAIL: временный каталог после ошибки остался"; exit 1
fi

echo "ok - бэкап: при нехватке места дамп не начинается"
CASE=backup-nospace
: > "$LOG"
run_script backup-nospace backup STUB_DB_BYTES=999999999999999
expect_code 1
expect_file 'мало места' "$WORK/backup-nospace.err"
expect_no_file 'pg_dump' "$LOG"

echo "ok - проверка свежести: успех и отказ"
CASE=check
: > "$LOG"
run_script check check
expect_code 0
expect_file '"ok":true' "$WORK/check.out"
expect_file 'check --database webnestdev --max-age-hours 30' "$LOG"

CASE=check-stale
run_script check-stale check STUB_CHECK_FAIL=1
expect_code 1
expect_file 'проверка свежести' "$WORK/check-stale.err"

echo "ok - учебное восстановление: отдельная база, проверка таблиц, удаление"
CASE=restore
: > "$LOG"
run_script restore restore-drill
expect_code 0
expect_file 'CREATE DATABASE "restore_check_' "$LOG"
expect_file 'postgres-backup.js get --key webnestdev/backups/postgres' "$LOG"
expect_file 'pg_restore -U webnestdev -d restore_check_' "$LOG"
expect_file 'DROP DATABASE IF EXISTS "restore_check_' "$LOG"
expect_file 'восстановление проверено: 42 таблиц' "$WORK/restore.err"
expect_no_file 'CREATE DATABASE "webnestdev"' "$LOG"
expect_no_file 'DROP DATABASE IF EXISTS "webnestdev"' "$LOG"

echo "ok - учебное восстановление: KEEP_RESTORE_DB=1 оставляет базу для разбора"
CASE=restore-keep
: > "$LOG"
run_script restore-keep restore-drill KEEP_RESTORE_DB=1
expect_code 0
expect_file 'оставлена' "$WORK/restore-keep.err"
expect_no_file 'DROP DATABASE IF EXISTS "restore_check_' "$LOG"

echo "ok - учебное восстановление: при ошибке учебная база всё равно удаляется"
CASE=restore-fail
: > "$LOG"
run_script restore-fail restore-drill STUB_RESTORE_FAIL=1
expect_code 1
expect_file 'восстановление в restore_check_' "$WORK/restore-fail.err"
expect_file 'DROP DATABASE IF EXISTS "restore_check_' "$LOG"

echo "ok - скрипт, переданный через stdin, не теряет остаток из-за docker exec"
CASE=stdin
: > "$LOG"
set +e
env PATH="$WORK/bin:$PATH" MODE=backup APP_DIR="$WORK/app" TMPDIR="$WORK/tmp" \
  STUB_LOG="$LOG" STUB_DUMP="$DUMP" STUB_EAT_STDIN=1 \
  bash -s < "$ROOT/deploy/scripts/pg-backup.sh" > "$WORK/stdin.out" 2> "$WORK/stdin.err"
CODE=$?
set -e
expect_code 0
expect_file 'бэкап готов' "$WORK/stdin.err"
expect_file 'postgres-backup.js put --database webnestdev' "$LOG"

echo "ok - неизвестный режим отклоняется"
CASE=bad-mode
run_script bad-mode unknown
expect_code 2
expect_file 'неизвестный MODE=unknown' "$WORK/bad-mode.err"

echo "все проверки бэкапа прошли"
