#!/usr/bin/env bash
# PostgreSQL PKI: отдельный CA, уникальные сертификаты нод и ротация.
#
# CA и приватные ключи нод лежат только на node-1 в /etc/webnestdev-ha/pg-pki.
# На node-2 передаются сертификат node-2 и публичный CA; ключа CA там нет.
# Сертификат ноды подписан отдельным CA, а не является самоподписанным.
#
# Режимы:
#   setup          создать CA и сертификаты нод, применить на этой ноде (новая установка)
#   migrate        перейти с текущего самоподписанного сертификата на PKI без простоя
#   rotate         выпустить новые сертификаты нод с тем же CA и применить
#   auto-rotate    выпустить новые сертификаты, только если осталось меньше ROTATE_DAYS
#   status         показать CA, сертификаты, сроки и TLS-состояние
#   verify-local   проверить PKI и TLS на текущей ноде
#   verify         проверить обе ноды
#   install-units  поставить systemd timer авто-ротации на node-1
#
# Режимы для CA в Yandex KMS (ключ CA на ноде отсутствует):
#   kms-csr <node>        создать next-server.key и next-server.csr для подписи внешним KMS
#   kms-install-ca <crt>  положить публичный CA (не меняя текущее доверие)
#   kms-stage-cert <node> проверить next-server.crt/key; server.crt не менять до activate
#   kms-stage-trust       добавить старый и новый CA в доверие на обеих нодах
#   kms-activate <node>   установить уже подготовленный сертификат и перечитать TLS
#   kms-retire-old-ca     оставить в доверии только новый CA
#   kms-retire-key        удалить старый ca.key/ca.srl после успешной миграции
#
# Ни ключи, ни пароли не печатаются. Все операции с ключами — root, mode 600.
set -euo pipefail

MODE=${1:-status}
PKI_DIR=${PG_PKI_DIR:-/etc/webnestdev-ha/pg-pki}
CA_KEY="$PKI_DIR/ca.key"
CA_CERT="$PKI_DIR/ca.crt"
CA_MODE="$PKI_DIR/ca-mode"
NODES_DIR="$PKI_DIR/nodes"
TLS_DIR=${PG_TLS_SRC:-/etc/webnestdev-ha/pg-tls}
PG_VERSION=${PG_VERSION:-17}
PG_CLUSTER=${PG_CLUSTER:-main}
PG_PORT=${LOCAL_PG_PORT:-5433}
PG_CONF_DIR="/etc/postgresql/${PG_VERSION}/${PG_CLUSTER}"
PG_TLS_DIR="$PG_CONF_DIR/tls"
HAPROXY_CA=${HA_PG_TLS_CA:-/etc/haproxy/pg-ca.crt}
CERT_DAYS=${PG_TLS_CERT_DAYS:-90}
ROTATE_DAYS=${PG_TLS_ROTATE_DAYS:-30}
CA_DAYS=${PG_TLS_CA_DAYS:-3650}
FORCE=${PG_PKI_FORCE:-0}
NODE2_HOST=${NODE2_HOST:-10.0.0.5}
NODE2_USER=${NODE2_USER:-ubuntu}
NODE2_SSH_KEY=${NODE2_SSH_KEY:-}
SELF=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
UNIT_NAME=webnestdev-pg-tls-rotate
UNIT_SCRIPT=${PG_PKI_UNIT_SCRIPT:-/opt/webnestdev-ha/pg_pki.sh}

log() { printf '[pg-pki] %s\n' "$*"; }
fail() { printf '[pg-pki] ОШИБКА: %s\n' "$*" >&2; exit 1; }
require_root() { [ "$(id -u)" = "0" ] || fail "запускать через sudo"; }

node_ip() {
  case "$1" in
    node-1) printf '10.0.0.4' ;;
    node-2) printf '10.0.0.5' ;;
    *) fail "неизвестная нода '$1' (ожидается node-1 или node-2)" ;;
  esac
}

node_san() {
  local ip
  ip=$(node_ip "$1")
  printf 'DNS:host.docker.internal,DNS:localhost,IP:127.0.0.1,IP:%s' "$ip"
}

cert_days_left() {
  local cert=$1 end
  [ -s "$cert" ] || { printf '0'; return; }
  end=$(openssl x509 -in "$cert" -noout -enddate 2>/dev/null | cut -d= -f2- || true)
  [ -n "$end" ] || { printf '0'; return; }
  local end_epoch now_epoch
  end_epoch=$(date -u -d "$end" +%s 2>/dev/null || true)
  now_epoch=$(date -u +%s)
  [ -n "$end_epoch" ] || { printf '0'; return; }
  printf '%s' "$(( (end_epoch - now_epoch) / 86400 ))"
}

pair_valid() {
  local cert=$1 key=$2
  [ -s "$cert" ] && [ -s "$key" ] || return 1
  openssl x509 -in "$cert" -noout -checkend 86400 >/dev/null 2>&1 || return 1
  openssl pkey -in "$key" -noout >/dev/null 2>&1 || return 1
  [ "$(openssl x509 -in "$cert" -noout -pubkey 2>/dev/null)" = \
    "$(openssl pkey -in "$key" -pubout 2>/dev/null)" ] || return 1
}

ca_cert_valid() {
  [ -s "$CA_CERT" ] || return 1
  openssl x509 -in "$CA_CERT" -noout -checkend 86400 >/dev/null 2>&1 || return 1
  openssl x509 -in "$CA_CERT" -noout -text 2>/dev/null | grep -q 'CA:TRUE' || return 1
}

ca_valid() {
  # Маркер ставит kms-install-ca. Даже если старый ca.key остался на ноде
  # (REMOVE_OLD_KEY=0), локальная подпись и авто-ротация должны быть запрещены.
  [ ! -e "$CA_MODE" ] || return 1
  ca_cert_valid || return 1
  [ -s "$CA_KEY" ] || return 1
  openssl pkey -in "$CA_KEY" -noout >/dev/null 2>&1 || return 1
}

init_ca() {
  install -d -m 700 -o root -g root "$PKI_DIR" "$NODES_DIR"
  [ ! -e "$CA_MODE" ] || fail "CA помечен как KMS ($CA_MODE); файловый CA здесь не создаётся"
  if ca_valid; then
    log "CA уже существует: $(openssl x509 -in "$CA_CERT" -noout -subject | sed 's/^subject=//')"
    return 0
  fi
  [ ! -e "$CA_KEY" ] && [ ! -e "$CA_CERT" ] || fail "есть повреждённый CA в $PKI_DIR; не перезаписываю его автоматически"
  local key_tmp cert_tmp
  key_tmp=$(mktemp "$PKI_DIR/.ca.key.XXXXXX")
  cert_tmp=$(mktemp "$PKI_DIR/.ca.crt.XXXXXX")
  trap 'rm -f "$key_tmp" "$cert_tmp"' RETURN
  openssl req -x509 -newkey rsa:4096 -sha256 -days "$CA_DAYS" -nodes \
    -keyout "$key_tmp" -out "$cert_tmp" \
    -subj "/CN=WebNestDev PostgreSQL Root CA" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -addext "subjectKeyIdentifier=hash" >/dev/null 2>&1 || fail "не удалось создать CA"
  chmod 600 "$key_tmp"
  chmod 644 "$cert_tmp"
  mv -f "$key_tmp" "$CA_KEY"
  mv -f "$cert_tmp" "$CA_CERT"
  trap - RETURN
  log "CA создан: $(openssl x509 -in "$CA_CERT" -noout -subject | sed 's/^subject=//'), срок $CA_DAYS дней"
}

issue_node() {
  local node=$1 dir cert key csr tmp_key tmp_csr tmp_cert ext san
  install -d -m 700 -o root -g root "$NODES_DIR"
  dir="$NODES_DIR/$node"
  install -d -m 700 -o root -g root "$dir"
  cert="$dir/server.crt"
  key="$dir/server.key"
  csr="$dir/server.csr"
  if [ "$FORCE" != "1" ] && pair_valid "$cert" "$key" &&
    [ "$(cert_days_left "$cert")" -gt "$ROTATE_DAYS" ]; then
    log "$node: сертификат ещё действителен $(( $(cert_days_left "$cert") )) дн., выпуск не нужен"
    return 0
  fi
  san=$(node_san "$node")
  tmp_key=$(mktemp "$dir/.server.key.XXXXXX")
  tmp_csr=$(mktemp "$dir/.server.csr.XXXXXX")
  tmp_cert=$(mktemp "$dir/.server.crt.XXXXXX")
  ext=$(mktemp "$dir/.server.ext.XXXXXX")
  trap 'rm -f "$tmp_key" "$tmp_csr" "$tmp_cert" "$ext"' RETURN
  openssl req -new -newkey rsa:4096 -sha256 -nodes \
    -keyout "$tmp_key" -out "$tmp_csr" \
    -subj "/CN=webnestdev-postgres-$node" >/dev/null 2>&1 || fail "$node: не удалось создать CSR"
  cat >"$ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=$san
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
EOF
  openssl x509 -req -in "$tmp_csr" -CA "$CA_CERT" -CAkey "$CA_KEY" \
    -CAserial "$PKI_DIR/ca.srl" -CAcreateserial -days "$CERT_DAYS" -sha256 \
    -extfile "$ext" -out "$tmp_cert" >/dev/null 2>&1 || fail "$node: CA не подписал CSR"
  openssl verify -CAfile "$CA_CERT" "$tmp_cert" >/dev/null 2>&1 || fail "$node: новый сертификат не проверяется CA"
  openssl x509 -in "$tmp_cert" -noout -ext subjectAltName >/dev/null 2>&1 || fail "$node: в сертификате нет SAN"
  chmod 600 "$tmp_key"
  chmod 644 "$tmp_cert"
  mv -f "$tmp_key" "$key"
  mv -f "$tmp_cert" "$cert"
  rm -f "$tmp_csr" "$csr" "$ext"
  trap - RETURN
  log "$node: выпущен сертификат, срок $CERT_DAYS дней, SAN $san"
}

issue_all() {
  init_ca
  issue_node node-1
  issue_node node-2
}

ssh_key_path() {
  local candidate
  for candidate in ${NODE2_SSH_KEY:-} /home/Misha/.ssh/node2_key /root/.ssh/node2_key "$HOME/.ssh/node2_key"; do
    [ -n "$candidate" ] || continue
    if [ -r "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

ssh2() { ssh "${SSH_OPTS[@]}" "$NODE2_USER@$NODE2_HOST" "$@" < /dev/null; }
ssh2_stdin() { ssh "${SSH_OPTS[@]}" "$NODE2_USER@$NODE2_HOST" "$@"; }
ensure_remote() {
  command -v ssh >/dev/null 2>&1 || fail "нет ssh"
  [ -n "${SSH_OPTS+x}" ] || {
    NODE2_SSH_KEY=$(ssh_key_path) || fail "нет SSH-ключа к node-2 (NODE2_SSH_KEY)"
    SSH_OPTS=(-i "$NODE2_SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)
  }
  if ! ssh2 true; then
    fail "node-2 недоступна по SSH ($NODE2_USER@$NODE2_HOST)"
  fi
}

install_ca_local() {
  install -d -m 700 -o postgres -g postgres "$PG_TLS_DIR"
  install -d -m 700 -o root -g root "$TLS_DIR"
  install -m 644 -o postgres -g postgres "$CA_CERT" "$PG_TLS_DIR/ca.crt"
  install -m 644 -o root -g root "$CA_CERT" "$TLS_DIR/ca.crt"
  install -d -m 755 -o root -g root /etc/haproxy
  install -m 644 -o root -g root "$CA_CERT" "$HAPROXY_CA"
  log "CA установлен локально"
}

install_bundle_local() {
  local bundle=$1
  install -m 644 -o postgres -g postgres "$bundle" "$PG_TLS_DIR/ca.crt"
  install -m 644 -o root -g root "$bundle" "$TLS_DIR/ca.crt"
  install -m 644 -o root -g root "$bundle" "$HAPROXY_CA"
  log "доверие обновлено локально"
}

install_cert_local() {
  local node=$1 src="$NODES_DIR/$1"
  [ -s "$src/server.crt" ] && [ -s "$src/server.key" ] || fail "$node: нет сертификата/ключа"
  pair_valid "$src/server.crt" "$src/server.key" || fail "$node: сертификат и ключ не совпадают"
  openssl verify -CAfile "$CA_CERT" "$src/server.crt" >/dev/null 2>&1 || fail "$node: сертификат не проверяется CA"
  install -d -m 700 -o root -g root "$TLS_DIR"
  install -m 644 -o root -g root "$src/server.crt" "$TLS_DIR/server.crt"
  install -m 600 -o root -g root "$src/server.key" "$TLS_DIR/server.key"
  install -d -m 700 -o postgres -g postgres "$PG_TLS_DIR"
  install -m 644 -o postgres -g postgres "$src/server.crt" "$PG_TLS_DIR/server.crt"
  install -m 600 -o postgres -g postgres "$src/server.key" "$PG_TLS_DIR/server.key"
  log "$node: сертификат установлен локально"
}

install_cert_remote() {
  local node=node-2 src="$NODES_DIR/node-2"
  ensure_remote
  [ -s "$src/server.crt" ] && [ -s "$src/server.key" ] || fail "$node: нет сертификата/ключа"
  pair_valid "$src/server.crt" "$src/server.key" || fail "$node: сертификат и ключ не совпадают"
  ssh2 "sudo -n install -d -m 700 -o root -g root '$TLS_DIR' && sudo -n install -d -m 700 -o postgres -g postgres '$PG_TLS_DIR'" || fail "$node: не удалось подготовить каталоги"
  tar -C "$src" -czf - server.crt server.key |
    ssh2_stdin "sudo -n tar -xzf - -C '$TLS_DIR' && sudo -n chown root:root '$TLS_DIR/server.crt' '$TLS_DIR/server.key' && sudo -n chmod 644 '$TLS_DIR/server.crt' && sudo -n chmod 600 '$TLS_DIR/server.key' && sudo -n install -m 644 -o postgres -g postgres '$TLS_DIR/server.crt' '$PG_TLS_DIR/server.crt' && sudo -n install -m 600 -o postgres -g postgres '$TLS_DIR/server.key' '$PG_TLS_DIR/server.key'" ||
    fail "$node: не удалось передать сертификат"
  log "$node: сертификат установлен"
}

install_ca_remote() {
  local bundle=${1:-$CA_CERT} bundle_name
  bundle_name=$(basename "$bundle")
  local -a tar_files=("$bundle_name")
  [ "$bundle_name" = "ca.crt" ] || tar_files+=(ca.crt)
  ensure_remote
  tar -C "$(dirname "$bundle")" -czf - "${tar_files[@]}" |
    ssh2_stdin "sudo -n install -d -m 700 -o root -g root '$PKI_DIR' '$TLS_DIR' && sudo -n install -d -m 700 -o postgres -g postgres '$PG_TLS_DIR' && sudo -n tar -xzf - -C '$PKI_DIR' && sudo -n install -m 644 -o postgres -g postgres '$PKI_DIR/$bundle_name' '$PG_TLS_DIR/ca.crt' && sudo -n install -m 644 -o root -g root '$PKI_DIR/$bundle_name' '$TLS_DIR/ca.crt' && sudo -n install -d -m 755 /etc/haproxy && sudo -n install -m 644 -o root -g root '$PKI_DIR/$bundle_name' '$HAPROXY_CA'" ||
    fail "не удалось установить CA/доверие на node-2"
  log "доверие установлено на node-2"
}

reload_pg_local() {
  local unit="postgresql@${PG_VERSION}-${PG_CLUSTER}.service"
  if ! systemctl is-active --quiet "$unit"; then
    log "$unit не запущен: сертификат применится при следующем старте"
    return 0
  fi
  systemctl reload "$unit"
  for _ in $(seq 1 15); do
    if sudo -u postgres psql -p "$PG_PORT" -Atc 'select 1' >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  fail "PostgreSQL не ответил после reload"
}

reload_pg_remote() {
  ssh2 "sudo -n systemctl reload 'postgresql@${PG_VERSION}-${PG_CLUSTER}.service'" || fail "node-2: PostgreSQL reload не выполнен"
  for _ in $(seq 1 15); do
    if ssh2 "sudo -n -u postgres psql -p '$PG_PORT' -Atc 'select 1'" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  fail "node-2: PostgreSQL не ответил после reload"
}

reload_haproxy_local() {
  [ -f /etc/haproxy/haproxy.cfg ] || { log "HAProxy ещё не установлен"; return 0; }
  haproxy -c -f /etc/haproxy/haproxy.cfg >/dev/null 2>&1 || fail "HAProxy: конфигурация не проходит проверку"
  if systemctl is-active --quiet haproxy; then
    systemctl reload haproxy
    log "HAProxy перечитан локально"
  else
    log "HAProxy не запущен: конфигурация применится при старте"
  fi
}

reload_haproxy_remote() {
  ssh2 "sudo -n haproxy -c -f /etc/haproxy/haproxy.cfg >/dev/null 2>&1 && sudo -n systemctl reload haproxy" || fail "node-2: HAProxy reload не выполнен"
  log "HAProxy перечитан на node-2"
}

check_streaming_local() {
  local recovery state
  recovery=$(sudo -u postgres psql -p "$PG_PORT" -d postgres -Atc 'select pg_is_in_recovery()' 2>/dev/null || true)
  if [ "$recovery" = "t" ]; then
    state=$(sudo -u postgres psql -p "$PG_PORT" -d postgres -Atc \
      "select coalesce(status, 'none') from pg_stat_wal_receiver" 2>/dev/null || true)
    [ "$state" = "streaming" ] || fail "локальный walreceiver не streaming: ${state:-unknown}"
    log "локальная нода standby, walreceiver: streaming"
    return 0
  fi
  [ "$recovery" = "f" ] || fail "не удалось определить роль PostgreSQL"
  state=$(sudo -u postgres psql -p "$PG_PORT" -d postgres -Atc \
    "select coalesce(string_agg(state, ','), 'none') from pg_stat_replication" 2>/dev/null || true)
  [ "$state" = "streaming" ] || fail "репликация не streaming: ${state:-unknown}"
  log "локальная нода primary, репликация: streaming"
}

check_streaming_remote() {
  local recovery state
  recovery=$(ssh2 "sudo -n -u postgres psql -p '$PG_PORT' -d postgres -Atc 'select pg_is_in_recovery()'" 2>/dev/null || true)
  if [ "$recovery" = "t" ]; then
    state=$(ssh2 "sudo -n -u postgres psql -p '$PG_PORT' -d postgres -Atc \"select coalesce(status, 'none') from pg_stat_wal_receiver\"" 2>/dev/null || true)
    [ "$state" = "streaming" ] || fail "node-2 walreceiver не streaming: ${state:-unknown}"
    log "node-2 standby, walreceiver: streaming"
    return 0
  fi
  [ "$recovery" = "f" ] || fail "не удалось определить роль PostgreSQL на node-2"
  state=$(ssh2 "sudo -n -u postgres psql -p '$PG_PORT' -d postgres -Atc \"select coalesce(string_agg(state, ','), 'none') from pg_stat_replication\"" 2>/dev/null || true)
  [ "$state" = "streaming" ] || fail "node-2 primary, репликация не streaming: ${state:-unknown}"
  log "node-2 primary, репликация: streaming"
}

create_bundle() {
  local old="$1" cert_name=${2:-server.crt} bundle="$PKI_DIR/trust-bundle.crt"
  [ -s "$old" ] || fail "нет старого CA для промежуточного доверия"
  cat "$old" "$CA_CERT" >"$bundle"
  chmod 644 "$bundle"
  openssl verify -CAfile "$bundle" "$old" >/dev/null 2>&1 || fail "старый CA не проверяется bundle"
  openssl verify -CAfile "$bundle" "$NODES_DIR/node-1/$cert_name" >/dev/null 2>&1 || fail "node-1 cert не проверяется bundle"
  openssl verify -CAfile "$bundle" "$NODES_DIR/node-2/$cert_name" >/dev/null 2>&1 || fail "node-2 cert не проверяется bundle"
  log "промежуточный bundle: старый + новый CA (проверены $cert_name)"
}

stage_trust() {
  require_root
  ca_valid || issue_all
  local old="$TLS_DIR/ca.crt" backup="$PKI_DIR/old-ca.crt"
  [ -s "$old" ] || fail "нет текущего CA в $old"
  install -m 600 -o root -g root "$old" "$backup"
  create_bundle "$old"
  install_bundle_local "$PKI_DIR/trust-bundle.crt"
  install_ca_remote "$PKI_DIR/trust-bundle.crt"
  reload_pg_local
  reload_pg_remote
  reload_haproxy_local
  reload_haproxy_remote
  log "старый и новый CA добавлены в доверие на обеих нодах"
}

switch_node() {
  local node=$1
  require_root
  if [ "$node" = "node-1" ]; then
    install_cert_local node-1
    reload_pg_local
    reload_haproxy_local
    check_streaming_local
  elif [ "$node" = "node-2" ]; then
    install_cert_remote
    reload_pg_remote
    reload_haproxy_remote
    check_streaming_remote
  else
    fail "switch_node: неизвестная нода $node"
  fi
  log "$node: TLS-сертификат применён"
}

retire_old_ca() {
  require_root
  ca_valid || fail "новый CA не найден"
  install_ca_local
  install_ca_remote "$CA_CERT"
  reload_pg_local
  reload_pg_remote
  reload_haproxy_local
  reload_haproxy_remote
  log "старый CA удалён из доверия; остался только новый CA"
}

#
# CA в Yandex KMS. На ноде нет ca.key, поэтому выпуск делится на шаги:
# CSR создаётся здесь, подпись делает отдельный signer, сертификат возвращается
# сюда. Старые листья при этом не подменяются до kms-activate.
#
kms_csr() {
  local node=$1 dir next_key next_csr san
  require_root
  node_ip "$node" >/dev/null
  install -d -m 700 -o root -g root "$PKI_DIR" "$NODES_DIR"
  dir="$NODES_DIR/$node"
  install -d -m 700 -o root -g root "$dir"
  next_key="$dir/next-server.key"
  next_csr="$dir/next-server.csr"
  san=$(node_san "$node")
  rm -f "$next_key" "$next_csr" "$dir/next-server.crt"
  (umask 077; openssl req -new -newkey rsa:4096 -sha256 -nodes \
    -keyout "$next_key" -out "$next_csr" \
    -subj "/CN=webnestdev-postgres-$node" \
    -addext "subjectAltName=$san" >/dev/null 2>&1) || fail "$node: не удалось создать CSR для KMS"
  chmod 600 "$next_key"
  chmod 644 "$next_csr"
  log "$node: CSR для KMS: $next_csr"
  log "$node: новый ключ: $next_key (600); старый сертификат не тронут"
}

kms_install_ca() {
  local src=${1:-}
  require_root
  [ -n "$src" ] && [ -s "$src" ] || fail "kms-install-ca: укажите публичный ca.crt"
  openssl x509 -in "$src" -noout -text 2>/dev/null | grep -q 'CA:TRUE' || \
    fail "kms-install-ca: $src не является CA-сертификатом"
  install -d -m 700 -o root -g root "$PKI_DIR"
  if [ "$(readlink -f "$src")" != "$(readlink -f "$CA_CERT")" ]; then
    install -m 644 -o root -g root "$src" "$CA_CERT"
  fi
  printf 'kms\n' >"$CA_MODE"
  chmod 644 "$CA_MODE"
  log "CA для KMS установлен в $CA_CERT (доверие пока не менялось)"
  openssl x509 -in "$CA_CERT" -noout -subject -fingerprint -sha256
}

kms_stage_cert() {
  local node=$1 dir next_cert next_key san
  require_root
  node_ip "$node" >/dev/null
  dir="$NODES_DIR/$node"
  next_cert="$dir/next-server.crt"
  next_key="$dir/next-server.key"
  [ -s "$next_cert" ] && [ -s "$next_key" ] || fail "$node: нет next-server.crt/next-server.key"
  ca_cert_valid || fail "$node: нет нового CA в $CA_CERT"
  pair_valid "$next_cert" "$next_key" || fail "$node: новый сертификат и ключ не совпадают"
  openssl verify -CAfile "$CA_CERT" "$next_cert" >/dev/null 2>&1 || \
    fail "$node: новый сертификат не проверяется новым CA"
  san=$(node_san "$node")
  openssl x509 -in "$next_cert" -noout -ext subjectAltName 2>/dev/null | grep -q "IP Address:$(node_ip "$node")" || \
    fail "$node: в новом сертификате нет SAN IP $(node_ip "$node")"
  # Не подменяем server.crt/key до kms-activate: иначе параллельная выкатка
  # node2-sync.sh может установить новый лист раньше, чем обновлено доверие.
  log "$node: новый сертификат проверен и подготовлен в $dir; live-сертификат ещё не заменён"
  log "$node: ожидаемый SAN: $san"
}

# Промежуточное доверие: старый CA, который сейчас лежит в TLS_DIR, плюс новый
# публичный CA. Не требует ca.key и не выпускает сертификаты.
kms_stage_trust() {
  require_root
  ca_cert_valid || fail "нет нового CA в $CA_CERT"
  local old="$TLS_DIR/ca.crt" backup="$PKI_DIR/old-ca.crt"
  [ -s "$old" ] || fail "нет текущего CA в $old"
  install -m 600 -o root -g root "$old" "$backup"
  # Доверие проверяем по next-server.crt: новые листья ещё не активированы,
  # server.crt намеренно остаётся старым до kms-activate.
  create_bundle "$old" next-server.crt
  install_bundle_local "$PKI_DIR/trust-bundle.crt"
  install_ca_remote "$PKI_DIR/trust-bundle.crt"
  reload_pg_local
  reload_pg_remote
  reload_haproxy_local
  reload_haproxy_remote
  log "старый и новый CA добавлены в доверие на обеих нодах"
}

kms_activate() {
  local node=$1 dir next_cert next_key
  require_root
  node_ip "$node" >/dev/null
  dir="$NODES_DIR/$node"
  next_cert="$dir/next-server.crt"
  next_key="$dir/next-server.key"
  [ -s "$next_cert" ] && [ -s "$next_key" ] || \
    fail "$node: сначала выполните kms-stage-cert $node"
  ca_cert_valid || fail "$node: нет нового CA в $CA_CERT"
  pair_valid "$next_cert" "$next_key" || fail "$node: next-сертификат и ключ не совпадают"
  openssl verify -CAfile "$CA_CERT" "$next_cert" >/dev/null 2>&1 || \
    fail "$node: next-сертификат не проверяется новым CA"
  # Защита от активации до промежуточного доверия: иначе соседняя нода
  # отвергнет новый лист. Для обычной ротации текущий CA уже в trust.
  openssl verify -CAfile "$HAPROXY_CA" "$next_cert" >/dev/null 2>&1 || \
    fail "$node: текущее доверие ещё не содержит новый CA; сначала kms-stage-trust"
  install -m 600 -o root -g root "$next_key" "$dir/server.key"
  install -m 644 -o root -g root "$next_cert" "$dir/server.crt"
  switch_node "$node"
  rm -f "$next_key" "$next_cert" "$dir/next-server.csr"
}

kms_retire_old_ca() {
  require_root
  ca_cert_valid || fail "нет нового CA в $CA_CERT"
  local node
  for node in node-1 node-2; do
    [ -s "$NODES_DIR/$node/server.crt" ] || fail "$node: нет сертификата"
    openssl verify -CAfile "$CA_CERT" "$NODES_DIR/$node/server.crt" >/dev/null 2>&1 || \
      fail "$node: установленный сертификат не проверяется новым CA"
  done
  install_ca_local
  install_ca_remote "$CA_CERT"
  reload_pg_local
  reload_pg_remote
  reload_haproxy_local
  reload_haproxy_remote
  log "старый CA удалён из доверия; остался только новый CA"
}

kms_retire_key() {
  require_root
  ca_cert_valid || fail "нет нового CA в $CA_CERT"
  [ -s "$TLS_DIR/ca.crt" ] || fail "нет $TLS_DIR/ca.crt; сначала kms-retire-old-ca"
  cmp -s "$TLS_DIR/ca.crt" "$CA_CERT" || \
    fail "в $TLS_DIR/ca.crt ещё не только новый CA; сначала kms-retire-old-ca"
  local node
  for node in node-1 node-2; do
    pair_valid "$NODES_DIR/$node/server.crt" "$NODES_DIR/$node/server.key" || \
      fail "$node: сертификат/ключ не готовы к удалению старого CA"
    openssl verify -CAfile "$CA_CERT" "$NODES_DIR/$node/server.crt" >/dev/null 2>&1 || \
      fail "$node: сертификат не проверяется новым CA"
  done
  if [ -e "$CA_KEY" ]; then
    rm -f "$CA_KEY" "$PKI_DIR/ca.srl"
    log "старый ca.key и ca.srl удалены; приватный CA теперь только в Yandex KMS"
  else
    log "ca.key уже отсутствует"
  fi
  # Локальный таймер не умеет подписывать через KMS; после перехода он только
  # шумит в журнале. Ротация теперь запускается workflow pki-kms.
  if systemctl list-unit-files "${UNIT_NAME}.timer" >/dev/null 2>&1; then
    systemctl disable --now "${UNIT_NAME}.timer" >/dev/null 2>&1 || true
    log "локальный ${UNIT_NAME}.timer отключён"
  fi
}

verify_local() {
  require_root
  ca_cert_valid || fail "CA не найден или повреждён"
  [ -s "$TLS_DIR/server.crt" ] && [ -s "$TLS_DIR/server.key" ] || fail "нет сертификата/ключа в $TLS_DIR"
  pair_valid "$TLS_DIR/server.crt" "$TLS_DIR/server.key" || fail "сертификат и ключ не совпадают"
  openssl verify -CAfile "$HAPROXY_CA" "$TLS_DIR/server.crt" >/dev/null 2>&1 || fail "сертификат не проверяется текущим CA/бандлом"
  [ "$(cert_days_left "$TLS_DIR/server.crt")" -gt 0 ] || fail "сертификат истёк"
  local ssl hba_host hba_hostssl
  if systemctl is-active --quiet "postgresql@${PG_VERSION}-${PG_CLUSTER}.service"; then
    ssl=$(sudo -u postgres psql -p "$PG_PORT" -Atc 'show ssl' 2>/dev/null || true)
    [ "$ssl" = "on" ] || fail "PostgreSQL: show ssl=$ssl"
  else
    log "PostgreSQL не запущен: проверены файлы, ssl проверится при старте"
  fi
  hba_host=$(grep -Ec '^[[:space:]]*host[[:space:]]+' "$PG_CONF_DIR/pg_hba.conf" || true)
  hba_hostssl=$(grep -Ec '^[[:space:]]*hostssl[[:space:]]+' "$PG_CONF_DIR/pg_hba.conf" || true)
  [ "$hba_host" = "0" ] || fail "pg_hba всё ещё содержит host-правила: $hba_host"
  [ "$hba_hostssl" -gt 0 ] || fail "pg_hba не содержит hostssl"
  grep -q 'ssl verify required' /etc/haproxy/haproxy.cfg || fail "HAProxy не проверяет сертификат"
  grep -q 'alpn postgresql' /etc/haproxy/haproxy.cfg || fail "HAProxy не передаёт ALPN postgresql"
  log "verify: ssl=on, HBA hostssl=$hba_hostssl, HAProxy TLS + ALPN; сертификат $(( $(cert_days_left "$TLS_DIR/server.crt") )) дн."
}

status_local() {
  [ -s "$CA_CERT" ] || fail "CA не найден"
  printf 'CA: '; openssl x509 -in "$CA_CERT" -noout -subject -issuer -enddate -fingerprint -sha256 | tr '\n' ' '; echo
  if [ -e "$CA_MODE" ]; then
    echo 'CA key: в Yandex KMS (ca.key на ноде не используется)'
  elif ca_valid; then
    echo 'CA key: локальный ca.key'
  else
    echo 'CA key: отсутствует на ноде или не совпадает с ca.crt'
  fi
  for node in node-1 node-2; do
    local cert="$NODES_DIR/$node/server.crt"
    if [ -s "$cert" ]; then
      printf '%s: ' "$node"; openssl x509 -in "$cert" -noout -subject -issuer -enddate -fingerprint -sha256 | tr '\n' ' '; echo
    else
      echo "$node: сертификат не выпущен"
    fi
  done
  echo "local cert: $(openssl x509 -in "$TLS_DIR/server.crt" -noout -subject -enddate -fingerprint -sha256 2>/dev/null | tr '\n' ' ')"
}

install_units() {
  require_root
  install -d -m 755 /opt/webnestdev-ha
  if [ "$SELF" != "$UNIT_SCRIPT" ]; then
    install -m 755 "$SELF" "$UNIT_SCRIPT"
  fi
  install -d -m 755 /etc/systemd/system
  cat >"/etc/systemd/system/${UNIT_NAME}.service" <<EOF
[Unit]
Description=Rotate WebNestDev PostgreSQL node certificates
After=network-online.target postgresql@${PG_VERSION}-${PG_CLUSTER}.service
Wants=network-online.target

[Service]
Type=oneshot
User=root
Nice=10
ExecStart=/bin/bash ${UNIT_SCRIPT} auto-rotate
EOF
  cat >"/etc/systemd/system/${UNIT_NAME}.timer" <<EOF
[Unit]
Description=Daily WebNestDev PostgreSQL certificate rotation check

[Timer]
OnCalendar=*-*-* 03:17:00
Persistent=true
RandomizedDelaySec=15m
Unit=${UNIT_NAME}.service

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now "${UNIT_NAME}.timer"
  log "таймер ${UNIT_NAME}.timer установлен"
}

setup() {
  require_root
  # После миграции CA живёт в KMS, а на ноде остаётся только ca.crt. Повторный
  # install-node1.sh не должен пытаться создать файловый ca.key: применяем уже
  # установленный лист и оставляем выпуск внешнему подписанту.
  if ca_cert_valid && [ -e "$CA_MODE" ]; then
    [ -s "$NODES_DIR/node-1/server.crt" ] && [ -s "$NODES_DIR/node-1/server.key" ] || \
      fail "CA в KMS, но сертификата node-1 нет; выпустите его через pki-kms workflow"
    log "CA находится в Yandex KMS: локальный ca.key не нужен, применяю готовый лист node-1"
    install_ca_local
    install_cert_local node-1
    reload_pg_local
    reload_haproxy_local
    bash "$(dirname "$SELF")/pg_tls.sh" apply
    verify_local
    return 0
  fi
  # На уже работающей ноде с прежним общим сертификатом нельзя сразу ставить
  # новый CA: вторая нода ещё ему не доверяет. Для этого есть migrate.
  if [ -s "$TLS_DIR/server.crt" ] && [ ! -s "$CA_CERT" ]; then
    fail "найден старый TLS без PKI; для действующей пары используйте migrate, а не setup"
  fi
  init_ca
  issue_all
  install_ca_local
  install_cert_local node-1
  reload_pg_local
  reload_haproxy_local
  # Конвертирует HBA в hostssl и ещё раз перечитывает PostgreSQL.
  bash "$(dirname "$SELF")/pg_tls.sh" apply
  install_units
  verify_local
}

migrate() {
  require_root
  init_ca
  issue_all
  stage_trust
  switch_node node-1
  switch_node node-2
  retire_old_ca
  install_units
  verify_local
  verify_remote
  log "миграция завершена"
}

rotate() {
  require_root
  if [ -e "$CA_MODE" ]; then
    fail "CA находится в Yandex KMS: используйте workflow pki-kms (режим rotate), локальный ca.key не нужен"
  fi
  ca_valid || fail "CA не найден; ротация невозможна"
  ensure_remote
  FORCE=1 issue_all
  switch_node node-1
  switch_node node-2
  verify_local
  verify_remote
  log "ротация завершена"
}

auto_rotate() {
  require_root
  if [ -e "$CA_MODE" ]; then
    log "CA в Yandex KMS — локальная авто-ротация не выполняется; используйте pki-kms workflow"
    return 0
  fi
  ca_valid || { log "CA нет — авто-ротация пропущена"; return 0; }
  local node days
  for node in node-1 node-2; do
    days=$(cert_days_left "$NODES_DIR/$node/server.crt")
    if [ "$days" -le "$ROTATE_DAYS" ]; then
      log "$node: осталось $days дн. — запускаю ротацию"
      rotate
      return 0
    fi
    log "$node: осталось $days дн. — ротация не нужна"
  done
}

verify_remote() {
  ensure_remote
  ssh2 "sudo -n bash /opt/webnestdev-ha/pg_pki.sh verify-local" || fail "verify на node-2 не прошёл"
  log "node-2 verify прошёл"
}

case "$MODE" in
  setup) setup ;;
  init-ca) require_root; init_ca ;;
  issue) require_root; init_ca; issue_node "${2:?node-1|node-2}" ;;
  stage-trust) stage_trust ;;
  switch) switch_node "${2:?node-1|node-2}" ;;
  retire-old-ca) retire_old_ca ;;
  migrate) migrate ;;
  rotate) rotate ;;
  auto-rotate) auto_rotate ;;
  install-units) install_units ;;
  status) status_local ;;
  verify-local) verify_local ;;
  verify) verify_local; verify_remote ;;
  kms-csr) kms_csr "${2:?node-1|node-2}" ;;
  kms-install-ca) kms_install_ca "${2:-}" ;;
  kms-stage-cert) kms_stage_cert "${2:?node-1|node-2}" ;;
  kms-stage-trust) kms_stage_trust ;;
  kms-activate) kms_activate "${2:?node-1|node-2}" ;;
  kms-retire-old-ca) kms_retire_old_ca ;;
  kms-retire-key) kms_retire_key ;;
  *) fail "неизвестный режим '$MODE' (setup|migrate|rotate|auto-rotate|status|verify|verify-local|install-units|kms-csr|kms-install-ca|kms-stage-cert|kms-stage-trust|kms-activate|kms-retire-old-ca|kms-retire-key)" ;;
esac
