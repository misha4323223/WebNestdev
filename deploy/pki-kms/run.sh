#!/usr/bin/env bash
# Оркестратор миграции/ротации PostgreSQL PKI через Yandex KMS.
#
# Запускается на отдельном подписанте (GitHub Actions runner или машина
# администратора). На node-1 только создаются CSR и устанавливаются готовые
# сертификаты; приватный ключ CA в KMS, ca.key с ноды удаляется.
#
# Обязательные переменные:
#   MODE=migrate|rotate|verify
#   CONFIRM=MIGRATE|ROTATE       для migrate/rotate
#   DEPLOY_HOST / DEPLOY_USER / DEPLOY_SSH_KEY   SSH к node-1
#   KMS_KEY_ID + SA_KEY_FILE     для migrate/rotate (кроме verify)
#
# Необязательные:
#   DEPLOY_PORT=22
#   REMOVE_OLD_KEY=1             удалить старый ca.key после успешной миграции
#   REMOTE_SCRIPT=/opt/webnestdev-ha/pg_pki.sh
#   PG_PKI_DIR=/etc/webnestdev-ha/pg-pki
#   PYTHON=python3
set -euo pipefail

MODE=${MODE:-}
CONFIRM=${CONFIRM:-}
DEPLOY_HOST=${DEPLOY_HOST:-}
DEPLOY_USER=${DEPLOY_USER:-Misha}
DEPLOY_PORT=${DEPLOY_PORT:-22}
DEPLOY_SSH_KEY=${DEPLOY_SSH_KEY:-}
KMS_KEY_ID=${KMS_KEY_ID:-}
SA_KEY_FILE=${SA_KEY_FILE:-}
REMOVE_OLD_KEY=${REMOVE_OLD_KEY:-0}
REMOTE_SCRIPT=${REMOTE_SCRIPT:-/opt/webnestdev-ha/pg_pki.sh}
PG_PKI_DIR=${PG_PKI_DIR:-/etc/webnestdev-ha/pg-pki}
PYTHON=${PYTHON:-python3}
REPO_ROOT=${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}
PKI_SCRIPT=${PKI_SCRIPT:-$REPO_ROOT/deploy/ha/pg_pki.sh}
SIGNER=${SIGNER:-$REPO_ROOT/deploy/pki-kms/pki_kms.py}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

log() { printf '[pki-kms] %s\n' "$*"; }
fail() { printf '[pki-kms] ОШИБКА: %s\n' "$*" >&2; exit 1; }

case "$MODE" in
  migrate) [ "$CONFIRM" = "MIGRATE" ] || fail "для MODE=migrate задайте CONFIRM=MIGRATE" ;;
  rotate) [ "$CONFIRM" = "ROTATE" ] || fail "для MODE=rotate задайте CONFIRM=ROTATE" ;;
  verify) ;;
  *) fail "MODE должен быть migrate, rotate или verify" ;;
esac
[ -n "$DEPLOY_HOST" ] || fail "не задан DEPLOY_HOST"
[ -r "$DEPLOY_SSH_KEY" ] || fail "нет DEPLOY_SSH_KEY"
[ -r "$PKI_SCRIPT" ] || fail "нет $PKI_SCRIPT"
case "$MODE" in
  migrate|rotate)
    [ -r "$SIGNER" ] || fail "нет $SIGNER"
    [ -n "$KMS_KEY_ID" ] || fail "не задан KMS_KEY_ID"
    [ -r "$SA_KEY_FILE" ] || fail "нет SA_KEY_FILE"
    ;;
esac
case "$REMOVE_OLD_KEY" in 0|1) ;; *) fail "REMOVE_OLD_KEY должен быть 0 или 1" ;; esac
case "$KMS_KEY_ID" in *[!A-Za-z0-9_-]*) fail "недопустимый KMS_KEY_ID" ;; esac

SSH_OPTS=(
  -i "$DEPLOY_SSH_KEY"
  -p "$DEPLOY_PORT"
  -o BatchMode=yes
  -o StrictHostKeyChecking=accept-new
  -o ConnectTimeout=15
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=20
)
ssh_remote() { ssh "${SSH_OPTS[@]}" "$DEPLOY_USER@$DEPLOY_HOST" "$@" < /dev/null; }
ssh_remote_stdin() { ssh "${SSH_OPTS[@]}" "$DEPLOY_USER@$DEPLOY_HOST" "$@"; }
remote_pki() { ssh_remote "sudo -n bash '$REMOTE_SCRIPT' $*"; }

download() {
  local remote=$1 local=$2
  ssh_remote "sudo -n cat '$remote'" > "$local" || fail "не удалось скачать $remote"
  [ -s "$local" ] || fail "пустой файл $remote"
}

upload() {
  local local=$1 remote=$2
  [ -s "$local" ] || fail "локальный файл пуст: $local"
  ssh_remote_stdin "sudo -n tee '$remote' >/dev/null && sudo -n chmod 644 '$remote'" < "$local" || \
    fail "не удалось загрузить $remote"
}

install_remote_script() {
  ssh_remote_stdin "umask 077; cat > /tmp/webnestdev-pg_pki.$$.sh" < "$PKI_SCRIPT" || \
    fail "не удалось передать pg_pki.sh на node-1"
  ssh_remote "sudo -n install -d -m 755 /opt/webnestdev-ha && sudo -n install -m 755 /tmp/webnestdev-pg_pki.$$.sh '$REMOTE_SCRIPT' && rm -f /tmp/webnestdev-pg_pki.$$.sh" || \
    fail "не удалось установить pg_pki.sh на node-1"
  log "pg_pki.sh установлен на node-1: $REMOTE_SCRIPT"
}

prepare_remote() {
  ssh_remote true || fail "node-1 недоступна по SSH"
  install_remote_script
}

# Подписант получает только CSR. Ключи листьев создаются на node-1 и не
# передаются на runner; приватный ключ CA вообще не покидает KMS.
sign_node() {
  local node=$1 csr="$WORK/$node.csr" cert="$WORK/$node.crt"
  "$PYTHON" "$SIGNER" --kms-key-id "$KMS_KEY_ID" --sa-key-file "$SA_KEY_FILE" \
    sign --ca-cert "$WORK/ca.crt" --csr "$csr" --node "$node" --out "$cert" --days 90 || \
    fail "$node: подпись KMS не удалась"
  upload "$cert" "$PG_PKI_DIR/nodes/$node/next-server.crt"
  remote_pki kms-stage-cert "$node"
}

issue_leaves() {
  local node
  for node in node-1 node-2; do
    remote_pki kms-csr "$node"
    download "$PG_PKI_DIR/nodes/$node/next-server.csr" "$WORK/$node.csr"
    sign_node "$node"
  done
}

migrate() {
  log "создаю новый root CA в KMS (приватный ключ не покидает Yandex KMS)"
  "$PYTHON" "$SIGNER" --kms-key-id "$KMS_KEY_ID" --sa-key-file "$SA_KEY_FILE" \
    root --out "$WORK/ca.crt" --days 3650 || fail "не удалось выпустить root CA"
  upload "$WORK/ca.crt" "/tmp/webnestdev-kms-ca.crt"
  remote_pki kms-install-ca /tmp/webnestdev-kms-ca.crt
  issue_leaves
  # Листья уже проверены, но live TLS ещё старый. Сначала обе ноды начинают
  # доверять старому и новому CA, затем переключаются листья, затем старый CA
  # убирается из доверия. Без этого шага node-2 отвергнет новый лист node-1.
  remote_pki kms-stage-trust
  remote_pki kms-activate node-1
  remote_pki kms-activate node-2
  remote_pki kms-retire-old-ca
  remote_pki verify
  if [ "$REMOVE_OLD_KEY" = "1" ]; then
    remote_pki kms-retire-key
  else
    log "старый ca.key оставлен на node-1; удалить: REMOVE_OLD_KEY=1 или pg_pki.sh kms-retire-key"
  fi
  log "миграция на Yandex KMS завершена"
}

rotate() {
  # Для подписи нужен только публичный CA. Он уже лежит на node-1; скачиваем
  # его, чтобы issuer в новых листьях совпал с текущим доверием.
  download "$PG_PKI_DIR/ca.crt" "$WORK/ca.crt"
  log "ротация листьев с текущим CA из KMS"
  issue_leaves
  remote_pki kms-activate node-1
  remote_pki kms-activate node-2
  remote_pki verify
  log "ротация завершена"
}

verify() {
  remote_pki verify
  log "verify завершён"
}

prepare_remote
case "$MODE" in
  migrate) migrate ;;
  rotate) rotate ;;
  verify) verify ;;
esac
