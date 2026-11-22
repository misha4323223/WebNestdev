#!/usr/bin/env bash
# TLS для PostgreSQL, к которому HAProxy ходит напрямую на 5433.
#
# Зачем: HAProxy и PostgreSQL стоят на одной ВМ, но на standby HAProxy идёт в PostgreSQL
# соседней ноды. Без TLS этот участок — единственный незашифрованный трафик между нодами.
# Здесь создаётся самоподписанный сертификат с SAN для обоих приватных адресов и
# host.docker.internal, включается ssl=on, а TCP-правила pg_hba переводятся на hostssl.
#
# Использование:
#   sudo bash pg_tls.sh setup   # сгенерировать сертификат, если его нет, и применить
#   sudo bash pg_tls.sh apply   # применить уже существующий сертификат
#   sudo bash pg_tls.sh verify  # только проверить конфигурацию, ничего не менять
#
# На node-2 сертификат и ключ кладёт node2-sync.sh из node-1. Отдельный setup на node-2
# создаст другую пару, и HAProxy не сможет проверить сертификат соседа; этот режим нужен
# только для первой ноды или ручного восстановления.
set -euo pipefail

MODE=${1:-setup}
PG_VERSION=${PG_VERSION:-17}
PG_CLUSTER=${PG_CLUSTER:-main}
PG_PORT=${LOCAL_PG_PORT:-5433}
PG_CONF_DIR="/etc/postgresql/${PG_VERSION}/${PG_CLUSTER}"
PG_DATA=${PGDATA:-"/var/lib/postgresql/${PG_VERSION}/${PG_CLUSTER}"}
TLS_SRC=${PG_TLS_SRC:-/etc/webnestdev-ha/pg-tls}
TLS_CERT="$TLS_SRC/server.crt"
TLS_KEY="$TLS_SRC/server.key"
TLS_CA="$TLS_SRC/ca.crt"
PG_TLS_DIR=${PG_TLS_DIR:-"$PG_CONF_DIR/tls"}
HAPROXY_CA=${HA_PG_TLS_CA:-/etc/haproxy/pg-ca.crt}
SAN=${PG_TLS_SAN:-"DNS:host.docker.internal,DNS:localhost,IP:127.0.0.1,IP:10.0.0.4,IP:10.0.0.5"}
FORCE_HBA=${PG_TLS_FORCE_HBA:-1}
UNIT="postgresql@${PG_VERSION}-${PG_CLUSTER}.service"

log() { printf '[pg-tls] %s\n' "$*"; }
fail() { printf '[pg-tls] ОШИБКА: %s\n' "$*" >&2; exit 1; }

require_root() {
  [ "$(id -u)" = "0" ] || fail "запускать через sudo"
}

cert_valid() {
  [ -s "$TLS_CERT" ] && [ -s "$TLS_KEY" ] || return 1
  openssl x509 -in "$TLS_CERT" -noout -checkend 86400 >/dev/null 2>&1 || return 1
  openssl pkey -in "$TLS_KEY" -noout >/dev/null 2>&1 || return 1
  # Сертификат и ключ должны быть одной парой: иначе PostgreSQL не стартует.
  [ "$(openssl x509 -in "$TLS_CERT" -noout -pubkey 2>/dev/null)" = \
    "$(openssl pkey -in "$TLS_KEY" -pubout 2>/dev/null)" ] || return 1
}

generate_cert() {
  command -v openssl >/dev/null 2>&1 || fail "нужен openssl"
  install -d -m 700 -o root -g root "$TLS_SRC"
  local key_tmp cert_tmp
  key_tmp=$(mktemp "$TLS_SRC/.server.key.XXXXXX")
  cert_tmp=$(mktemp "$TLS_SRC/.server.crt.XXXXXX")
  trap 'rm -f "$key_tmp" "$cert_tmp"' RETURN
  log "создаю самоподписанный сертификат (SAN: $SAN)"
  openssl req -x509 -newkey rsa:4096 -sha256 -days 825 -nodes \
    -keyout "$key_tmp" -out "$cert_tmp" \
    -subj "/CN=webnestdev-postgres" \
    -addext "subjectAltName=$SAN" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign" \
    -addext "extendedKeyUsage=serverAuth" >/dev/null 2>&1 ||
    fail "openssl не создал сертификат"
  chmod 600 "$key_tmp"
  chmod 644 "$cert_tmp"
  mv -f "$key_tmp" "$TLS_KEY"
  mv -f "$cert_tmp" "$TLS_CERT"
  trap - RETURN
  log "сертификат создан: $TLS_CERT (действует 825 дней)"
}

install_files() {
  cert_valid || fail "нет валидной пары $TLS_CERT / $TLS_KEY; сначала выполните setup на node-1 и синхронизацию на node-2"
  local ca_file="$TLS_CERT"
  # Старый режим: самоподписанный server.crt был одновременно CA. Новый режим:
  # отдельный ca.crt, которым проверяется leaf-сертификат ноды. Не подменяем CA
  # листом: иначе HAProxy и standby перестанут проверять соседнюю ноду.
  if [ -s "$TLS_CA" ] && openssl verify -CAfile "$TLS_CA" "$TLS_CERT" >/dev/null 2>&1; then
    ca_file="$TLS_CA"
  fi
  install -d -m 700 -o postgres -g postgres "$PG_TLS_DIR"
  install -m 644 -o postgres -g postgres "$TLS_CERT" "$PG_TLS_DIR/server.crt"
  install -m 600 -o postgres -g postgres "$TLS_KEY" "$PG_TLS_DIR/server.key"
  install -m 644 -o postgres -g postgres "$ca_file" "$PG_TLS_DIR/ca.crt"
  if [ "$ca_file" != "$TLS_CA" ]; then
    install -m 644 -o postgres -g postgres "$ca_file" "$TLS_CA"
  fi
  install -d -m 755 -o root -g root /etc/haproxy
  install -m 644 -o root -g root "$ca_file" "$HAPROXY_CA"
  log "сертификат установлен в $PG_TLS_DIR и $HAPROXY_CA (CA: $ca_file)"
}

configure_postgres() {
  command -v pg_conftool >/dev/null 2>&1 || fail "нет pg_conftool (пакет postgresql-common)"
  local auto="$PG_DATA/postgresql.auto.conf"
  local backup="$auto.webnestdev-tls.bak"
  if [ -f "$auto" ] && [ ! -f "$backup" ]; then
    cp -a "$auto" "$backup"
  fi
  if [ -f "$auto" ]; then
    # В auto.conf на node-2 раньше лежал ssl=off. Он перекрывает postgresql.conf,
    # поэтому убираем только TLS-параметры, не трогая archive_* и primary_conninfo.
    local tmp
    tmp=$(mktemp "$PG_DATA/.postgresql.auto.XXXXXX")
    awk '!/^[[:space:]]*(ssl|ssl_cert_file|ssl_key_file|ssl_ca_file|ssl_min_protocol_version)[[:space:]]*=/' \
      "$auto" > "$tmp"
    chown postgres:postgres "$tmp" 2>/dev/null || true
    chmod 600 "$tmp"
    mv -f "$tmp" "$auto"
  fi
  pg_conftool "$PG_VERSION" "$PG_CLUSTER" set ssl on
  pg_conftool "$PG_VERSION" "$PG_CLUSTER" set ssl_cert_file "$PG_TLS_DIR/server.crt"
  pg_conftool "$PG_VERSION" "$PG_CLUSTER" set ssl_key_file "$PG_TLS_DIR/server.key"
  pg_conftool "$PG_VERSION" "$PG_CLUSTER" set ssl_ca_file "$PG_TLS_DIR/ca.crt"
  pg_conftool "$PG_VERSION" "$PG_CLUSTER" set ssl_min_protocol_version TLSv1.2
}

force_hba_tls() {
  [ "$FORCE_HBA" = "1" ] || { log "PG_TLS_FORCE_HBA=0: pg_hba оставлен как есть"; return; }
  local hba="$PG_CONF_DIR/pg_hba.conf"
  [ -f "$hba" ] || fail "нет $hba"
  # hostssl — это те же правила, но только для TLS. Если оставить host, libpq сможет
  # подключиться к 5433 в обход TLS. local (unix socket) не меняется.
  local count
  count=$(grep -Ec '^[[:space:]]*host[[:space:]]+' "$hba" || true)
  if [ "$count" = "0" ]; then
    log "pg_hba уже не содержит host-правил"
    return
  fi
  cp -a "$hba" "$hba.webnestdev-tls.bak"
  awk '
    /^[[:space:]]*#/ { print; next }
    /^[[:space:]]*host[[:space:]]+/ {
      sub(/^[[:space:]]*host[[:space:]]+/, "hostssl ")
      print
      next
    }
    { print }
  ' "$hba.webnestdev-tls.bak" > "$hba"
  chown postgres:postgres "$hba" 2>/dev/null || true
  chmod 640 "$hba" 2>/dev/null || true
  log "pg_hba: $count TCP-правил переведены на hostssl (backup: $hba.webnestdev-tls.bak)"
}

reload_if_running() {
  if systemctl is-active --quiet "$UNIT"; then
    systemctl reload "$UNIT"
    local deadline=$((SECONDS + 15))
    while [ "$SECONDS" -lt "$deadline" ]; do
      if sudo -u postgres psql -p "$PG_PORT" -Atc 'select 1' >/dev/null 2>&1; then
        break
      fi
      sleep 1
    done
  else
    log "$UNIT не запущен: конфигурация применится при следующем старте"
  fi
}

verify_ssl_on() {
  if systemctl is-active --quiet "$UNIT"; then
    local ssl
    ssl=$(sudo -u postgres psql -p "$PG_PORT" -Atc 'show ssl' 2>/dev/null || true)
    [ "$ssl" = "on" ] || fail "PostgreSQL не включил ssl (show ssl=$ssl); HBA не трогаю, чтобы не закрыть TCP"
    log "PostgreSQL: ssl=on"
  fi
}

verify() {
  command -v openssl >/dev/null 2>&1 || fail "нужен openssl"
  [ -s "$HAPROXY_CA" ] || fail "нет $HAPROXY_CA"
  [ -s "$PG_TLS_DIR/server.crt" ] || fail "нет $PG_TLS_DIR/server.crt"
  openssl x509 -in "$HAPROXY_CA" -noout >/dev/null 2>&1 || fail "CA не читается"
  openssl x509 -in "$PG_TLS_DIR/server.crt" -noout -checkend 86400 >/dev/null 2>&1 ||
    fail "сертификат PostgreSQL истёк или истечёт в течение суток"
  if systemctl is-active --quiet "$UNIT"; then
    local ssl
    ssl=$(sudo -u postgres psql -p "$PG_PORT" -Atc 'show ssl' 2>/dev/null || true)
    [ "$ssl" = "on" ] || fail "PostgreSQL отвечает ssl=$ssl (ожидается on)"
    log "PostgreSQL: ssl=on, сертификат и CA на месте"
  else
    log "$UNIT не запущен; проверены только файлы"
  fi
  if [ -f /etc/haproxy/haproxy.cfg ]; then
    if grep -q 'ssl verify required ca-file' /etc/haproxy/haproxy.cfg; then
      log "HAProxy настроен на проверку сертификата PostgreSQL"
    else
      log "ВНИМАНИЕ: HAProxy ещё не переключён на TLS; это сделает db_proxy на следующем тике"
    fi
  fi
}

case "$MODE" in
  setup)
    require_root
    # При активном PKI общий self-signed сертификат больше не создаётся: он
    # перезаписал бы уникальные листья нод и разрушил доверие HAProxy.
    [ ! -s /etc/webnestdev-ha/pg-pki/ca.crt ] || fail "PKI уже активен; используйте pg_pki.sh (setup/migrate/rotate)"
    install -d -m 700 -o root -g root "$TLS_SRC"
    if cert_valid; then
      log "использую существующий сертификат $TLS_CERT"
    else
      generate_cert
    fi
    install_files
    configure_postgres
    reload_if_running
    verify_ssl_on
    # HBA переводим только после того, как PostgreSQL подтвердил ssl=on: иначе
    # hostssl-правила при выключенном TLS закрыли бы все TCP-подключения.
    force_hba_tls
    reload_if_running
    verify
    ;;
  apply)
    require_root
    install_files
    configure_postgres
    reload_if_running
    verify_ssl_on
    force_hba_tls
    reload_if_running
    verify
    ;;

  verify)
    verify
    ;;
  *)
    fail "неизвестный режим '$MODE' (setup|apply|verify)"
    ;;
esac
