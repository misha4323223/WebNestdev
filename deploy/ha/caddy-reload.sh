#!/usr/bin/env bash
#
# Перечитывает Caddy, когда изменился основной Caddyfile, TLS-сниппет или общий файл
# custom-domains.caddy. Запускается systemd-таймером на каждой ноде.
#
# Почему отдельный таймер, а не reload из API: у сервера нет docker.sock, а держать admin API
# Caddy открытым в сеть нельзя. Скрипт работает на хосте, проверяет конфиг ДО reload и при
# ошибке оставляет работающий старый конфиг. Повторный reload без изменения хеша не делается.
set -euo pipefail

APP_DIR=${APP_DIR:-/home/Misha/webnestdev/src}
COMPOSE_FILE=${COMPOSE_FILE:-docker-compose.yml}
COMPOSE_OVERRIDE=${COMPOSE_OVERRIDE:-docker-compose.override.yml}
COMPOSE_ENV_FILES=${COMPOSE_ENV_FILES:-}
CADDY_SERVICE=${CADDY_SERVICE:-caddy}
CADDY_FILE=${CADDY_FILE:-Caddyfile}
PREVIEW_TLS_FILE=${PREVIEW_TLS_FILE:-preview-tls.caddy}
HOST_TLS_FILE=${HOST_TLS_FILE:-host-tls.caddy}
CUSTOM_DOMAINS_CADDY_DIR=${CUSTOM_DOMAINS_CADDY_DIR:-/var/lib/webnestdev/data/caddy-custom}
STATE_FILE=${STATE_FILE:-/var/lib/webnestdev/caddy-reload.sha}

log(){ printf '[caddy-reload] %s\n' "$*"; }

cd "$APP_DIR"
COMPOSE_ARGS=()
# На node-2 нет .env: без явных env-файлов `docker compose exec` не разрешит обязательные
# переменные и таймер не сможет перечитать Caddy. На node-1 список пуст — compose читает .env.
for env_file in $COMPOSE_ENV_FILES; do
  COMPOSE_ARGS+=(--env-file "$APP_DIR/$env_file")
done
COMPOSE_FILES=("${COMPOSE_ARGS[@]}" -f "$COMPOSE_FILE")
if [ -f "$COMPOSE_OVERRIDE" ]; then
  COMPOSE_FILES+=(-f "$COMPOSE_OVERRIDE")
fi

if ! compose ps -q "$CADDY_SERVICE" >/dev/null 2>&1 || [ -z "$(compose ps -q "$CADDY_SERVICE" 2>/dev/null)" ]; then
  log "контейнер $CADDY_SERVICE не запущен — reload отложен"
  exit 0
fi

hash_inputs(){
  {
    sha256sum "$CADDY_FILE" "$PREVIEW_TLS_FILE" "$HOST_TLS_FILE" 2>/dev/null || true
    if [ -d "$CUSTOM_DOMAINS_CADDY_DIR" ]; then
      find "$CUSTOM_DOMAINS_CADDY_DIR" -maxdepth 1 -type f -name '*.caddy' -print0 \
        | sort -z \
        | xargs -0 -r sha256sum 2>/dev/null || true
    fi
  } | sha256sum | cut -d' ' -f1
}

current_hash=$(hash_inputs)
previous_hash=""
[ -f "$STATE_FILE" ] && previous_hash=$(cat "$STATE_FILE" 2>/dev/null || true)

if [ -n "$previous_hash" ] && [ "$current_hash" = "$previous_hash" ]; then
  exit 0
fi

# `</dev/null` обязателен: таймер не должен ждать stdin, а compose exec иначе подключает его.
if ! timeout 30 docker compose "${COMPOSE_FILES[@]}" exec -T "$CADDY_SERVICE" \
    caddy validate --config "/etc/caddy/$CADDY_FILE" --adapter caddyfile </dev/null; then
  log "validate не прошёл — оставляю работающий конфиг; исправьте custom-domains.caddy/Caddyfile"
  exit 1
fi

if ! timeout 30 docker compose "${COMPOSE_FILES[@]}" exec -T "$CADDY_SERVICE" \
    caddy reload --config "/etc/caddy/$CADDY_FILE" --adapter caddyfile </dev/null; then
  log "reload не удался — Caddy продолжает работать на прежнем конфиге"
  exit 1
fi

mkdir -p "$(dirname "$STATE_FILE")"
printf '%s\n' "$current_hash" > "$STATE_FILE.tmp"
mv "$STATE_FILE.tmp" "$STATE_FILE"
log "Caddy перечитал конфигурацию"
