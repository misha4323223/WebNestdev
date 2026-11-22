#!/usr/bin/env bash
# Off-site backup корневого CA PostgreSQL в приватный S3-бакет.
#
# Архив содержит ca.key, ca.crt, ca.srl, публичные листья нод, manifest и checksum.
# Наружу уходит только age-шифрованный tar; приватные листья нод в архив не входят.
#
# Скрипт рассчитан на node-1, где лежит ca.key. Секреты читаются из
# /etc/webnestdev-ha/pki-backup.env (600 root), в журнал не печатаются.
#
# Использование:
#   sudo bash pg_ca_backup.sh backup
#   sudo bash pg_ca_backup.sh verify
#   sudo bash pg_ca_backup.sh status
set -euo pipefail

MODE=${1:-status}
ENV_FILE=${PG_CA_BACKUP_ENV:-/etc/webnestdev-ha/pki-backup.env}
PKI_DIR=${PG_PKI_DIR:-/etc/webnestdev-ha/pg-pki}
CA_KEY="$PKI_DIR/ca.key"
CA_CERT="$PKI_DIR/ca.crt"
CA_SRL="$PKI_DIR/ca.srl"
AGE_BIN=${AGE_BIN:-age}
RCLONE_BIN=${RCLONE_BIN:-rclone}
STAGE_DIR=""
ARCHIVE_FILE=""

log() { printf '[pki-backup] %s\n' "$*"; }
fail() { printf '[pki-backup] ОШИБКА: %s\n' "$*" >&2; exit 1; }
require_root() { [ "$(id -u)" = "0" ] || fail "запускать через sudo"; }

load_env() {
  [ -r "$ENV_FILE" ] || fail "нет $ENV_FILE (600 root)"
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  PKI_S3_ENDPOINT=${PKI_S3_ENDPOINT:-https://storage.yandexcloud.net}
  PKI_S3_REGION=${PKI_S3_REGION:-ru-central1}
  PKI_S3_PREFIX=${PKI_S3_PREFIX:-pki/ca}
  : "${PKI_S3_BUCKET:?PKI_S3_BUCKET не задан}"
  : "${PKI_S3_ACCESS_KEY_ID:?PKI_S3_ACCESS_KEY_ID не задан}"
  : "${PKI_S3_SECRET_ACCESS_KEY:?PKI_S3_SECRET_ACCESS_KEY не задан}"
  : "${PKI_AGE_RECIPIENT:?PKI_AGE_RECIPIENT не задан}"
  case "$PKI_AGE_RECIPIENT" in
    age1[0-9a-z]*) ;;
    *) fail "PKI_AGE_RECIPIENT не похож на age1..." ;;
  esac
  case "$PKI_S3_ENDPOINT" in
    https://*) ;;
    *) fail "PKI_S3_ENDPOINT должен быть https://" ;;
  esac
  PKI_S3_BUCKET=$(printf '%s' "$PKI_S3_BUCKET" | tr -d '[:space:]')
  PKI_S3_PREFIX=$(printf '%s' "$PKI_S3_PREFIX" | tr -d '[:space:]' | sed 's#^/##; s#/$##')
}

configure_rclone() {
  # Конфигурация через окружение: на диске не появляется файл с ключом.
  export RCLONE_CONFIG_PKI_TYPE=s3
  export RCLONE_CONFIG_PKI_PROVIDER=Other
  export RCLONE_CONFIG_PKI_ENV_AUTH=false
  export RCLONE_CONFIG_PKI_FORCE_PATH_STYLE=true
  export RCLONE_CONFIG_PKI_ACCESS_KEY_ID="$PKI_S3_ACCESS_KEY_ID"
  export RCLONE_CONFIG_PKI_SECRET_ACCESS_KEY="$PKI_S3_SECRET_ACCESS_KEY"
  export RCLONE_CONFIG_PKI_ENDPOINT="$PKI_S3_ENDPOINT"
  export RCLONE_CONFIG_PKI_REGION="$PKI_S3_REGION"
}

remote_base() {
  if [ -n "$PKI_S3_PREFIX" ]; then
    printf 'pki:%s/%s' "$PKI_S3_BUCKET" "$PKI_S3_PREFIX"
  else
    printf 'pki:%s' "$PKI_S3_BUCKET"
  fi
}

remote_has() {
  local name=$1
  "$RCLONE_BIN" lsf "$(remote_base)/" --files-only --max-depth 1 2>/dev/null |
    grep -Fqx "$name"
}

check_tools() {
  command -v "$AGE_BIN" >/dev/null 2>&1 || fail "нет age"
  command -v "$RCLONE_BIN" >/dev/null 2>&1 || fail "нет rclone"
  command -v openssl >/dev/null 2>&1 || fail "нет openssl"
  command -v tar >/dev/null 2>&1 || fail "нет tar"
}

check_pki() {
  [ -s "$CA_KEY" ] || fail "нет $CA_KEY"
  [ -s "$CA_CERT" ] || fail "нет $CA_CERT"
  [ -s "$CA_SRL" ] || fail "нет $CA_SRL"
  [ -s "$PKI_DIR/nodes/node-1/server.crt" ] || fail "нет публичного листа node-1"
  [ -s "$PKI_DIR/nodes/node-2/server.crt" ] || fail "нет публичного листа node-2"
  openssl x509 -in "$CA_CERT" -noout -checkend 86400 >/dev/null 2>&1 || fail "CA истёк"
  openssl pkey -in "$CA_KEY" -noout >/dev/null 2>&1 || fail "ca.key не читается"
  [ "$(openssl pkey -in "$CA_KEY" -pubout 2>/dev/null)" = \
    "$(openssl x509 -in "$CA_CERT" -pubkey -noout 2>/dev/null)" ] ||
    fail "ca.key не соответствует ca.crt"
  openssl verify -CAfile "$CA_CERT" \
    "$PKI_DIR/nodes/node-1/server.crt" "$PKI_DIR/nodes/node-2/server.crt" >/dev/null 2>&1 ||
    fail "публичные листья не проверяются CA"
}

check_bucket() {
  "$RCLONE_BIN" lsf "pki:$PKI_S3_BUCKET" --max-depth 1 >/dev/null ||
    fail "нет доступа к s3://$PKI_S3_BUCKET"
}

cleanup() {
  [ -z "$STAGE_DIR" ] || rm -rf "$STAGE_DIR"
  [ -z "$ARCHIVE_FILE" ] || rm -f "$ARCHIVE_FILE"
}
trap cleanup EXIT

make_archive() {
  local ts stage archive cert1 cert2
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  stage=$(mktemp -d)
  archive=$(mktemp --suffix=.tar.gz.age)
  rm -f "$archive"
  STAGE_DIR=$stage
  ARCHIVE_FILE=$archive
  cert1="$PKI_DIR/nodes/node-1/server.crt"
  cert2="$PKI_DIR/nodes/node-2/server.crt"
  chmod 700 "$stage"
  umask 077

  install -m 600 "$CA_KEY" "$stage/ca.key"
  install -m 644 "$CA_CERT" "$stage/ca.crt"
  install -m 600 "$CA_SRL" "$stage/ca.srl"
  install -D -m 644 "$cert1" "$stage/nodes/node-1/server.crt"
  install -D -m 644 "$cert2" "$stage/nodes/node-2/server.crt"
  {
    printf 'created_at=%s\n' "$ts"
    printf 'ca_subject=%s\n' "$(openssl x509 -in "$CA_CERT" -noout -subject | sed 's/^subject=//')"
    printf 'ca_sha256=%s\n' "$(openssl x509 -in "$CA_CERT" -noout -fingerprint -sha256 | cut -d= -f2)"
    printf 'ca_not_after=%s\n' "$(openssl x509 -in "$CA_CERT" -noout -enddate | cut -d= -f2)"
    printf 'node1_sha256=%s\n' "$(openssl x509 -in "$cert1" -noout -fingerprint -sha256 | cut -d= -f2)"
    printf 'node2_sha256=%s\n' "$(openssl x509 -in "$cert2" -noout -fingerprint -sha256 | cut -d= -f2)"
    printf 'host=%s\n' "$(hostname -f 2>/dev/null || hostname)"
  } >"$stage/MANIFEST.txt"
  (
    cd "$stage"
    sha256sum ca.key ca.crt ca.srl MANIFEST.txt \
      nodes/node-1/server.crt nodes/node-2/server.crt >SHA256SUMS
  )
  tar -C "$stage" -czf - . |
    "$AGE_BIN" -r "$PKI_AGE_RECIPIENT" -o "$archive" ||
    fail "age не зашифровал архив"
  [ -s "$archive" ] || fail "age создал пустой архив"
  printf '%s' "$archive"
}

backup() {
  require_root
  load_env
  configure_rclone
  check_tools
  check_pki
  check_bucket
  local archive name remote dest
  archive=$(make_archive)
  name="pg-ca-$(date -u +%Y%m%dT%H%M%SZ).tar.gz.age"
  remote="$(remote_base)/$name"
  dest=$(mktemp --suffix=.sha256)
  trap 'rm -f "$dest"' RETURN
  printf '%s  %s\n' "$(sha256sum "$archive" | cut -d' ' -f1)" "$name" >"$dest"

  log "загружаю $name"
  "$RCLONE_BIN" copyto "$archive" "$remote" --no-traverse
  "$RCLONE_BIN" copyto "$dest" "$remote.sha256" --no-traverse
  printf '%s\n' "$name" | "$RCLONE_BIN" rcat "$(remote_base)/latest.txt"
  remote_has "$name" || fail "объект не найден после загрузки"
  remote_has "$name.sha256" || fail "checksum не найден после загрузки"
  log "backup готов: s3://$PKI_S3_BUCKET/${PKI_S3_PREFIX:+$PKI_S3_PREFIX/}$name"
}

verify() {
  require_root
  load_env
  configure_rclone
  check_tools
  check_bucket
  local latest remote tmp
  latest=$("$RCLONE_BIN" cat "$(remote_base)/latest.txt" 2>/dev/null | tr -d '\r\n' || true)
  [ -n "$latest" ] || fail "нет latest.txt"
  case "$latest" in
    pg-ca-*.tar.gz.age) ;;
    *) fail "latest.txt содержит неожиданное имя: $latest" ;;
  esac
  remote="$(remote_base)/$latest"
  remote_has "$latest" || fail "последний архив не найден: $latest"
  remote_has "$latest.sha256" || fail "нет checksum для $latest"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' RETURN
  "$RCLONE_BIN" copyto "$remote" "$tmp/$latest" --no-traverse
  "$RCLONE_BIN" copyto "$remote.sha256" "$tmp/$latest.sha256" --no-traverse
  (cd "$tmp" && sha256sum -c "$latest.sha256" >/dev/null) ||
    fail "checksum не совпал для $latest"
  log "последний backup: $latest; checksum: ok"
}

status() {
  load_env
  configure_rclone
  check_tools
  check_bucket
  local latest
  latest=$("$RCLONE_BIN" cat "$(remote_base)/latest.txt" 2>/dev/null | tr -d '\r\n' || true)
  printf 'bucket=%s\nprefix=%s\nlatest=%s\n' \
    "$PKI_S3_BUCKET" "${PKI_S3_PREFIX:-—}" "${latest:-—}"
}

case "$MODE" in
  backup) backup ;;
  verify) verify ;;
  status) status ;;
  *) fail "неизвестный режим '$MODE' (backup|verify|status)" ;;
esac
