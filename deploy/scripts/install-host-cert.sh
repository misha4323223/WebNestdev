#!/usr/bin/env bash
#
# Устанавливает origin-сертификат `*.host.nestdev.ru` на node-1 и, если она доступна, на node-2.
# Запускается на node-1 после `host-cert.mjs` (сертификат уже скачан в CERT_DIR).
#
#   bash deploy/scripts/install-host-cert.sh /tmp/host-cert
#
# CDN ходит на NLB, поэтому сертификат нужен обеим нодам. Недоступная node-2 — не ошибка:
# её можно включить позже, выкатка синхронизирует certs/host.
set -Eeuo pipefail

APP_DIR="${APP_DIR:-$HOME/webnestdev/src}"
CERT_DIR="${1:-/tmp/host-cert}"
CADDY_CONTAINER="${CADDY_CONTAINER:-src-caddy-1}"
NODE2_APP_DIR="${NODE2_APP_DIR:-/home/ubuntu/webnestdev/src}"
NODE2_HOST="${NODE2_HOST:-10.0.0.5}"
NODE2_USER="${NODE2_USER:-ubuntu}"
NODE2_KEY="${NODE2_KEY:-$HOME/.ssh/node2_key}"
SNIPPET='# TLS для публичных сайтов: wildcard `*.host.nestdev.ru` из MWS Certificate Manager.
# Файлы сертификата: certs/host на хосте, /certs/host внутри Caddy. Не редактировать руками.
tls /certs/host/fullchain.pem /certs/host/key.pem
'

fail(){ printf '[host-cert-install] ошибка: %s\n' "$*" >&2; exit 1; }
log(){ printf '[host-cert-install] %s\n' "$*"; }

[ -s "$CERT_DIR/fullchain.pem" ] || fail "$CERT_DIR/fullchain.pem не найден"
[ -s "$CERT_DIR/key.pem" ] || fail "$CERT_DIR/key.pem не найден"
openssl x509 -in "$CERT_DIR/fullchain.pem" -noout >/dev/null 2>&1 || fail "fullchain не читается"
openssl pkey -in "$CERT_DIR/key.pem" -noout >/dev/null 2>&1 || fail "key не читается"

install_local(){
  mkdir -p "$APP_DIR/certs/host"
  install -m 644 "$CERT_DIR/fullchain.pem" "$APP_DIR/certs/host/fullchain.pem"
  install -m 600 "$CERT_DIR/key.pem" "$APP_DIR/certs/host/key.pem"
  printf '%s' "$SNIPPET" > "$APP_DIR/host-tls.caddy"
  chmod 644 "$APP_DIR/host-tls.caddy"
  docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 ||
    docker restart "$CADDY_CONTAINER" >/dev/null
  log "node-1: сертификат установлен, Caddy перечитан"
}

install_node2(){
  if ! ssh -i "$NODE2_KEY" -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=10 \
      "$NODE2_USER@$NODE2_HOST" true >/dev/null 2>&1; then
    log "node-2 недоступна — сертификат останется на node-1, синхронизируется позже"
    return 0
  fi
  tar -czf - -C "$APP_DIR" certs/host/fullchain.pem certs/host/key.pem host-tls.caddy |
    ssh -i "$NODE2_KEY" -o BatchMode=yes -o StrictHostKeyChecking=no "$NODE2_USER@$NODE2_HOST" \
      "mkdir -p '$NODE2_APP_DIR/certs/host' && tar -xzf - -C '$NODE2_APP_DIR' &&
       chmod 644 '$NODE2_APP_DIR/certs/host/fullchain.pem' '$NODE2_APP_DIR/host-tls.caddy' &&
       chmod 600 '$NODE2_APP_DIR/certs/host/key.pem'" ||
    fail "не удалось передать сертификат на node-2"
  ssh -i "$NODE2_KEY" -o BatchMode=yes -o StrictHostKeyChecking=no "$NODE2_USER@$NODE2_HOST" \
    "docker exec '$CADDY_CONTAINER' caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 ||
     docker restart '$CADDY_CONTAINER' >/dev/null" ||
    fail "не удалось перечитать Caddy на node-2"
  log "node-2: сертификат установлен, Caddy перечитан"
}

install_local
install_node2
