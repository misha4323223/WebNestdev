#!/usr/bin/env bash
# Устанавливает таймер reload Caddy на ноде. Запускать с sudo из каталога развёртывания:
#   sudo deploy/ha/install-caddy-reload.sh
# Повторный запуск безопасен; APP_DIR можно переопределить, если код лежит не рядом с данными.
set -euo pipefail

SRC=$(cd "$(dirname "$0")" && pwd)
APP_DIR=${APP_DIR:-$(cd "$SRC/../.." && pwd)}
COMPOSE_FILE=${COMPOSE_FILE:-docker-compose.yml}
COMPOSE_OVERRIDE=${COMPOSE_OVERRIDE:-docker-compose.override.yml}
COMPOSE_ENV_FILES=${COMPOSE_ENV_FILES:-}
CUSTOM_DOMAINS_CADDY_DIR=${CUSTOM_DOMAINS_CADDY_DIR:-/var/lib/webnestdev/data/caddy-custom}
CADDY_DATA_HOST_DIR=${CADDY_DATA_HOST_DIR:-/var/lib/webnestdev/data/caddy-data}

install -m 755 "$SRC/caddy-reload.sh" /usr/local/sbin/webnestdev-caddy-reload
install -m 644 "$SRC/webnestdev-caddy-reload.service" /etc/systemd/system/webnestdev-caddy-reload.service
install -m 644 "$SRC/webnestdev-caddy-reload.timer" /etc/systemd/system/webnestdev-caddy-reload.timer

install -d -m 755 /etc/default
cat > /etc/default/webnestdev-caddy-reload <<EOF
APP_DIR=$APP_DIR
COMPOSE_FILE=$COMPOSE_FILE
COMPOSE_OVERRIDE=$COMPOSE_OVERRIDE
COMPOSE_ENV_FILES=$COMPOSE_ENV_FILES
CUSTOM_DOMAINS_CADDY_DIR=$CUSTOM_DOMAINS_CADDY_DIR
EOF

install -d -m 775 "$CUSTOM_DOMAINS_CADDY_DIR" "$CADDY_DATA_HOST_DIR"
# API пишет custom-domains.caddy от uid 1000. Если каталог создал root (этот установщик),
# без chown первый проход API не сможет сделать атомарный rename. Caddy читает файл как root.
chown "${WEBNESTDEV_UID:-1000}:${WEBNESTDEV_GID:-1000}" "$CUSTOM_DOMAINS_CADDY_DIR" 2>/dev/null || true
chmod 775 "$CUSTOM_DOMAINS_CADDY_DIR" 2>/dev/null || true

systemctl daemon-reload
systemctl enable --now webnestdev-caddy-reload.timer
echo "caddy-reload установлен: APP_DIR=$APP_DIR, таймер=$(systemctl is-active webnestdev-caddy-reload.timer)"
