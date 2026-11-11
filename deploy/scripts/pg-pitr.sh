#!/usr/bin/env bash
#
# PITR для системного PostgreSQL на node-1 (пункт 4.4 плана масштабирования).
#
# Что это даёт: восстановление не «на вчерашний дамп», а на конкретный момент времени —
# между двумя записями, до неудачной миграции, до ошибочного DELETE. Логический дамп
# (deploy/scripts/pg-backup.sh) остаётся: он проще переносится и проверяется отдельно, но
# гранулярность у него сутки.
#
# Схема (нативная, без новых зависимостей):
#   * `archive_mode = on`, `archive_command` кладёт завершённые WAL-сегменты в
#     $ARCHIVE_DIR. Команда идемпотентна (`cp` во временный файл + `mv`): с `test ! -f`
#     PostgreSQL считал сегмент неархивированным, если файл уже был, и повторял его вечно
#     (проверено 10.11.2026 — 24 неудачных попытки и остановка архивации).
#   * раз в неделю `pg_basebackup -Fp -X stream` в $BACKUP_DIR/<ГГГГММДДT…Z>; хранится
#     $KEEP_BACKUPS последних копий.
#   * `prune` удаляет WAL старше $WAL_KEEP_DAYS суток. Горизонт PITR равен этому сроку, но не
#     больше, чем позволяют самые старые base backup.
#
# ВАЖНО про надёжность: WAL и base backup лежат на локальном диске node-1. Это защищает от
# ошибки в данных, но не от потери ВМ; от потери ВМ по-прежнему защищает ежедневный дамп в S3
# (docs/POSTGRES_BACKUP.md). Вывоз WAL в S3 — следующий шаг, отдельная правка.
#
# Режимы:
#   MODE=setup       включить archive_mode, поставить юниты и таймеры (нужен root)
#   MODE=basebackup  снять физическую копию и вычистить старые
#   MODE=prune       удалить WAL старше WAL_KEEP_DAYS
#   MODE=status      состояние: настройки, архив, копии
#   MODE=restore     восстановить локальный LATEST на момент RESTORE_TIME (порт DRILL_PORT)
#   MODE=restore-s3  то же из бакета (S3_TS=<ts> — конкретная копия, иначе latest.txt)
#   MODE=stop        остановить и удалить учебный кластер
#
# Переменные:
#   PG_PORT=5433  DRILL_PORT=5544  DRILL_DIR=/var/lib/postgresql/pitr-drill
#   RESTORE_TIME='2026-11-10 21:41:04.205539+00'  (обязательна для restore)
#   KEEP_BACKUPS=2  WAL_KEEP_DAYS=21
#
# Код возврата: 0 — успех, 1 — ошибка, 2 — неверный MODE или параметры.
set -Eeuo pipefail

# Режим можно передать аргументом (`pg-pitr.sh setup`) или переменной (`MODE=setup`):
# в systemd удобнее переменная, руками — аргумент.
MODE="${1:-${MODE:-status}}"
PG_PORT="${PG_PORT:-5433}"
PG_VERSION="${PG_VERSION:-17}"
ARCHIVE_DIR="${ARCHIVE_DIR:-/var/lib/postgresql/wal-archive}"
BACKUP_DIR="${BACKUP_DIR:-/var/lib/postgresql/basebackup}"
DRILL_DIR="${DRILL_DIR:-/var/lib/postgresql/pitr-drill}"
DRILL_PORT="${DRILL_PORT:-5544}"
KEEP_BACKUPS="${KEEP_BACKUPS:-2}"
WAL_KEEP_DAYS="${WAL_KEEP_DAYS:-21}"
RESTORE_TIME="${RESTORE_TIME:-}"
PG_CTL="/usr/lib/postgresql/${PG_VERSION}/bin/pg_ctl"
SELF=/usr/local/sbin/webnestdev-pg-pitr

log() { printf '[pg-pitr] %s\n' "$*" >&2; }
fail() { log "ОШИБКА: $*"; exit 1; }

psql_at() { sudo -n -u postgres psql -p "$PG_PORT" -Atc "$1"; }

require_root() {
  [ "$(id -u)" = 0 ] || fail "нужен root: sudo $SELF"
}

archive_command() {
  printf 'cp %%p %s/%%f.tmp && mv -f %s/%%f.tmp %s/%%f' "$ARCHIVE_DIR" "$ARCHIVE_DIR" "$ARCHIVE_DIR"
}

setup_units() {
  install -d -o postgres -g postgres -m 700 "$ARCHIVE_DIR" "$BACKUP_DIR"
  # setup запускают и из установленной копии (`$0` == `$SELF`); install в этом случае падает
  # с «are the same file» и, из-за set -e, обрывает setup до ALTER SYSTEM archive_mode.
  if [ "$(readlink -f "$0")" != "$(readlink -f "$SELF" 2>/dev/null || echo "$SELF")" ]; then
    install -m 0755 "$0" "$SELF"
  fi
  # Выгрузчик в S3 живёт отдельно: у него свой таймер и своя ответственность.
  local s3_src="${S3_SRC:-$(dirname "$0")/pg-pitr-s3.sh}"
  if [ -f "$s3_src" ]; then
    install -m 0755 "$s3_src" /usr/local/sbin/webnestdev-pg-pitr-s3
  else
    log "pg-pitr-s3.sh не найден рядом — таймер S3 не включится"
  fi

  cat > /etc/systemd/system/webnestdev-pg-basebackup.service <<UNIT
[Unit]
Description=WebNestDev PostgreSQL base backup (PITR)
After=postgresql@${PG_VERSION}-main.service
Wants=postgresql@${PG_VERSION}-main.service

[Service]
Type=oneshot
ExecStart=${SELF} basebackup
UNIT
  cat > /etc/systemd/system/webnestdev-pg-basebackup.timer <<UNIT
[Unit]
Description=Weekly WebNestDev PostgreSQL base backup

[Timer]
OnCalendar=Sun 04:30
Persistent=true
RandomizedDelaySec=10m
Unit=webnestdev-pg-basebackup.service

[Install]
WantedBy=timers.target
UNIT
  cat > /etc/systemd/system/webnestdev-pg-pitr-s3.service <<UNIT
[Unit]
Description=WebNestDev PITR archive upload to S3
After=postgresql@${PG_VERSION}-main.service
Wants=postgresql@${PG_VERSION}-main.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/webnestdev-pg-pitr-s3 sync
UNIT
  cat > /etc/systemd/system/webnestdev-pg-pitr-s3.timer <<UNIT
[Unit]
Description=Upload WebNestDev PITR archive to S3

[Timer]
OnCalendar=*:0/5
Persistent=true
RandomizedDelaySec=30s
Unit=webnestdev-pg-pitr-s3.service

[Install]
WantedBy=timers.target
UNIT
  cat > /etc/systemd/system/webnestdev-pg-wal-prune.service <<UNIT
[Unit]
Description=WebNestDev PostgreSQL WAL archive retention
After=postgresql@${PG_VERSION}-main.service

[Service]
Type=oneshot
ExecStart=${SELF} prune
UNIT
  cat > /etc/systemd/system/webnestdev-pg-wal-prune.timer <<UNIT
[Unit]
Description=Daily WebNestDev PostgreSQL WAL retention

[Timer]
OnCalendar=*-*-* 05:00
Persistent=true
RandomizedDelaySec=10m
Unit=webnestdev-pg-wal-prune.service

[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable --now webnestdev-pg-basebackup.timer webnestdev-pg-wal-prune.timer webnestdev-pg-pitr-s3.timer
}

setup() {
  require_root
  setup_units
  psql_at "ALTER SYSTEM SET archive_mode = 'on';" >/dev/null
  psql_at "ALTER SYSTEM SET archive_command = '$(archive_command)';" >/dev/null
  psql_at "select pg_reload_conf();" >/dev/null
  # archive_mode — параметр постмастера: reload его поднимет только если сегмент ещё не писался.
  # Перезапуск здесь не делается молча: его выполняет выкатка, а setup только сообщает факт.
  if [ "$(psql_at 'show archive_mode;')" != "on" ]; then
    log "archive_mode=on записан, но применится после рестарта PostgreSQL: systemctl restart postgresql@${PG_VERSION}-main"
  fi
  status
}

#
# Таймеры стоят на обеих нодах, а работают только на текущей primary: на standby нет ни
# архивации, ни смысла в физической копии. Без этой защиты после switchover обе ноды качали
# бы base backup и выгружали WAL в один и тот же бакет.
#
require_primary() {
  local role
  role=$(psql_at 'select pg_is_in_recovery();' 2>/dev/null || echo unknown)
  if [ "$role" != f ]; then
    log "узел не primary (in_recovery=$role) — шаг пропущен"
    exit 0
  fi
}

basebackup() {
  require_root
  require_primary
  local ts dir
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  dir="$BACKUP_DIR/$ts"
  install -d -o postgres -g postgres -m 700 "$BACKUP_DIR"
  log "снимаю base backup в $dir"
  sudo -n -u postgres pg_basebackup -p "$PG_PORT" -D "$dir" -Fp -X stream -c fast
  printf 'TS=%s\n' "$ts" > "$BACKUP_DIR/LATEST.tmp"
  chown postgres:postgres "$BACKUP_DIR/LATEST.tmp"
  chmod 600 "$BACKUP_DIR/LATEST.tmp"
  mv -f "$BACKUP_DIR/LATEST.tmp" "$BACKUP_DIR/LATEST"
  log "готово: $(du -sh "$dir" | cut -f1)"
  # Оставляем KEEP_BACKUPS последних; удаление старого не трогает WAL — им занимается prune.
  ls -1d "$BACKUP_DIR"/20* 2>/dev/null | sort -r | tail -n +$((KEEP_BACKUPS + 1)) | while read -r old; do
    log "удаляю старый base backup $old"
    rm -rf "$old"
  done
}

prune() {
  require_root
  require_primary
  [ -d "$ARCHIVE_DIR" ] || fail "нет каталога архива $ARCHIVE_DIR"
  local before after
  before=$(du -sm "$ARCHIVE_DIR" | cut -f1)
  find "$ARCHIVE_DIR" -maxdepth 1 -type f -name '0*' -mtime +"$WAL_KEEP_DAYS" -delete
  after=$(du -sm "$ARCHIVE_DIR" | cut -f1)
  log "WAL старше $WAL_KEEP_DAYS сут удалён: ${before} МБ → ${after} МБ"
}

status() {
  echo "archive_mode: $(psql_at 'show archive_mode;')"
  echo "archive_command: $(psql_at 'show archive_command;')"
  psql_at "select 'archived='||archived_count||' failed='||failed_count||' last='||coalesce(last_archived_wal,'-') from pg_stat_archiver;"
  echo "wal_dir: $(du -sh "$ARCHIVE_DIR" 2>/dev/null | cut -f1) ($(find "$ARCHIVE_DIR" -maxdepth 1 -type f -name '0*' 2>/dev/null | wc -l) сегментов)"
  echo "basebackup: $(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1) ($(ls -1d "$BACKUP_DIR"/20* 2>/dev/null | wc -l) копий)"
  echo "latest: $(sed -n 's/^TS=//p' "$BACKUP_DIR/LATEST" 2>/dev/null || echo -)"
}

require_restore_time() {
  [ -n "$RESTORE_TIME" ] || fail "для восстановления нужен RESTORE_TIME='ГГГГ-ММ-ДД ЧЧ:МИ:СС.МК+00'"
}

prepare_drill() {
  stop_drill >/dev/null 2>&1 || true
  rm -rf "$DRILL_DIR"
  install -d -o postgres -g postgres -m 700 "$DRILL_DIR"
}

# Общая часть обоих путей (локальный архив и S3): конфиги, recovery.signal, запуск и ожидание.
start_drill() {
  local target="$1" origin="$2"
  install -d -o postgres -g postgres -m 700 "$DRILL_DIR/conf.d"
  # Debian держит postgresql.conf вне data dir, поэтому base backup его не содержит.
  cp "/etc/postgresql/${PG_VERSION}/main/postgresql.conf" "/etc/postgresql/${PG_VERSION}/main/pg_hba.conf" "$DRILL_DIR/"
  touch "$DRILL_DIR/recovery.signal"
  # recovery.signal обязателен: без него PostgreSQL завершает восстановление на конце backup,
  # игнорируя recovery_target_time (проверено 10.11.2026).
  # archive_mode=off обязателен тоже: иначе учебный кластер после promotion архивирует свои
  # timeline-файлы в тот же каталог и следующий restore падает на «requested timeline N is not a
  # child of this server's history» (проверено 10.11.2026).
  cat >> "$DRILL_DIR/postgresql.auto.conf" <<CONF
restore_command = 'cp ${ARCHIVE_DIR}/%f %p'
recovery_target_time = '${target}'
recovery_target_action = 'promote'
archive_mode = 'off'
CONF
  chown -R postgres:postgres "$DRILL_DIR"
  log "восстанавливаю $origin на $target (порт $DRILL_PORT)"
  sudo -n -u postgres "$PG_CTL" -D "$DRILL_DIR" -l /var/log/postgresql/pitr-drill.log \
    -o "-p $DRILL_PORT -c listen_addresses='' -c data_directory=$DRILL_DIR -c config_file=$DRILL_DIR/postgresql.conf -c hba_file=$DRILL_DIR/pg_hba.conf" \
    start >/dev/null
  local i inrec=t
  for i in $(seq 1 90); do
    inrec=$(sudo -n -u postgres psql -p "$DRILL_PORT" -Atc 'select pg_is_in_recovery()' 2>/dev/null || echo t)
    [ "$inrec" = f ] && break
    sleep 1
  done
  [ "$inrec" = f ] || fail "кластер не вышел из recovery за 90 с — смотрите /var/log/postgresql/pitr-drill.log"
  log "восстановление завершено за ${i} с; кластер слушает $DRILL_PORT (MODE=stop уберёт его)"
  grep -h 'recovery stopping' /var/log/postgresql/pitr-drill.log | tail -1 || true
}

restore() {
  require_root
  require_restore_time
  local ts src
  ts=$(sed -n 's/^TS=//p' "$BACKUP_DIR/LATEST" 2>/dev/null || true)
  [ -n "$ts" ] || fail "нет $BACKUP_DIR/LATEST — сначала MODE=basebackup"
  src="$BACKUP_DIR/$ts"
  [ -d "$src" ] || fail "нет base backup $src"
  prepare_drill
  cp -a "$src"/. "$DRILL_DIR"/
  start_drill "$RESTORE_TIME" "$ts"
}

#
# Восстановление из S3: тот же drill, но base backup и WAL приезжают из бакета. Это то, что
# переживает потерю node-1; локальный архив для drill остаётся быстрее.
#
s3_cli() {
  local cid
  cid=$(docker ps -q --filter "label=com.docker.compose.service=webnestdev-server" | head -n 1)
  [ -n "$cid" ] || fail "контейнер сервера не найден — S3-клиента нет"
  docker exec -i "$cid" node server/dist/scripts/postgres-backup.js "$@"
}

s3_prefix() {
  s3_cli config | python3 -c 'import json,sys; print(json.load(sys.stdin)["prefix"])'
}

restore_s3() {
  require_root
  require_restore_time
  local prefix ts name index
  prefix=$(s3_prefix)
  ts="${S3_TS:-}"
  if [ -z "$ts" ]; then
    ts=$(s3_cli get-object --key "$prefix/pitr/basebackup/latest.txt" | tr -d '\r\n')
  fi
  [ -n "$ts" ] || fail "в бакете нет последнего base backup (latest.txt)"
  index=$(mktemp /tmp/wnd-pitr-index.XXXXXX)
  prepare_drill
  log "скачиваю $prefix/pitr/basebackup/$ts.tar.gz"
  s3_cli get-object --key "$prefix/pitr/basebackup/$ts.tar.gz" | tar -xzf - -C "$DRILL_DIR"
  s3_cli get-object --key "$prefix/pitr/wal/index.txt" > "$index"
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    s3_cli get-object --key "$prefix/pitr/wal/$name" > "$DRILL_DIR/pg_wal/$name"
  done < "$index"
  log "скачано сегментов: $(wc -l < "$index")"
  rm -f "$index"
  chown -R postgres:postgres "$DRILL_DIR"
  start_drill "$RESTORE_TIME" "s3:$ts"
}

stop_drill() {
  require_root
  if [ -d "$DRILL_DIR" ]; then
    sudo -n -u postgres "$PG_CTL" -D "$DRILL_DIR" -m immediate stop >/dev/null 2>&1 || true
    rm -rf "$DRILL_DIR"
    log "учебный кластер остановлен и удалён"
  fi
}

case "$MODE" in
  setup) setup ;;
  basebackup) basebackup ;;
  prune) prune ;;
  status) status ;;
  restore) restore ;;
  restore-s3) restore_s3 ;;
  stop) stop_drill ;;
  *)
    log "неизвестный MODE=$MODE (setup, basebackup, prune, status, restore, restore-s3, stop)"
    exit 2
    ;;
esac
