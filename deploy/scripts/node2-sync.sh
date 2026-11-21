#!/usr/bin/env bash
#
# Выкатка на вторую ноду из первой.
#
# GitHub Actions деплоит только node-1 (DEPLOY_HOST): у node-2 нет внешнего адреса, а GHCR
# отдаёт ей `unauthorized` — вход в реестр там не настроен. Из-за этого вторая нода
# отставала от первой до ручного вмешательства: после падения node-1 она поднимала старую
# сборку, то есть HA-контур существовал только на бумаге.
#
# Скрипт запускается НА node-1 (её присылает workflow) и делает то, что раньше делали руками:
#   1. передаёт образ по SSH (docker save → docker load) и закрепляет его в env-файлах node-2;
#   2. обновляет на node-2 docker-compose.yml и Caddyfile, если они разошлись с node-1;
#   3. пересоздаёт сервис и брокер с `--no-deps` (override использует системную базу, поэтому
#      legacy postgres не должен подниматься);
#   4. гасит legacy postgres, если он всё-таки запущен;
#   5. перечитывает Caddyfile и обновляет runner на обеих нодах;
#   6. проверяет /api/ready на node-2 и сверяет сборку с выкаченным тегом.
#
# Переменные:
#   IMAGE_REF=ghcr.io/…        выкатываемый образ (обязателен)
#   APP_DIR=~/webnestdev/src   каталог развёртывания на этой ВМ (источник файлов по умолчанию)
#   COMPOSE_SRC=<путь>         актуальный docker-compose.yml из выкатки
#   CADDY_SRC=<путь>           актуальный Caddyfile из выкатки
#   PREVIEW_TLS_SRC=<путь>     актуальный preview-tls.caddy из выкатки
#   CADDY_RELOAD_SRC=<каталог> deploy/ha из выкатки (скрипт и systemd-units)
#   HA_CODE_SRC=<каталог>      deploy/ha из выкатки для runtime-файлов (по умолчанию CADDY_RELOAD_SRC)
#   HA_CODE_DST=/opt/webnestdev-ha  куда установить HA-код на обеих нодах
#   NODE2_HOST=10.0.0.5        приватный адрес второй ноды
#   NODE2_USER=ubuntu
#   NODE2_SSH_KEY=~/.ssh/node2_key
#   NODE2_APP_DIR=/home/ubuntu/webnestdev/src
#   NODE2_ENV_FILES="runtime.env node2.env"  env-файлы compose на node-2
#   NODE2_SERVICES="webnestdev-server docker-broker caddy"
#   NODE2_HEALTH_URL=http://127.0.0.1:8787/api/ready
#   SYNC_NODE2=1|0|auto        1 — обязательна (по умолчанию); 0 — пропустить; auto — пропустить,
#                              если node-2 недоступна
#   RUNNER_SCRIPT_B64=…        содержимое deploy/scripts/update-runner.sh в base64
#   RUNNER_SCRIPT_SRC=<путь>   тот же скрипт файлом
#   DEPLOY_SCRIPT_SRC=<путь>   deploy/scripts/vm-deploy.sh файлом: его MODE=prune убирает
#                              старые образы на node-2 по тому же правилу, что и на node-1
#   KEEP_IMAGES=2              сколько версий образа оставлять на node-2
#   DRY_RUN=1
set -euo pipefail

IMAGE_REF="${IMAGE_REF:-}"
APP_DIR="${APP_DIR:-$HOME/webnestdev/src}"
NODE2_HOST="${NODE2_HOST:-10.0.0.5}"
NODE2_USER="${NODE2_USER:-ubuntu}"
NODE2_SSH_KEY="${NODE2_SSH_KEY:-$HOME/.ssh/node2_key}"
NODE2_APP_DIR="${NODE2_APP_DIR:-/home/ubuntu/webnestdev/src}"
NODE2_ENV_FILES="${NODE2_ENV_FILES:-runtime.env node2.env}"
NODE2_SERVICES="${NODE2_SERVICES:-webnestdev-server docker-broker caddy}"
NODE2_HEALTH_URL="${NODE2_HEALTH_URL:-http://127.0.0.1:8787/api/ready}"
NODE2_HEALTH_TRIES="${NODE2_HEALTH_TRIES:-30}"
SYNC_NODE2="${SYNC_NODE2:-1}"
CUSTOM_DOMAINS_ENABLED="${CUSTOM_DOMAINS_ENABLED:-}"
RUNNER_SCRIPT_B64="${RUNNER_SCRIPT_B64:-}"
RUNNER_SCRIPT_SRC="${RUNNER_SCRIPT_SRC:-}"
DEPLOY_SCRIPT_SRC="${DEPLOY_SCRIPT_SRC:-}"
# Файлы из workflow важнее чекаута на node-1: он может быть старше образа, и тогда на node-2
# уезжала старая версия Caddy. Пустые значения сохраняют прежнее поведение для ручного запуска.
COMPOSE_SRC="${COMPOSE_SRC:-$APP_DIR/docker-compose.yml}"
CADDY_SRC="${CADDY_SRC:-$APP_DIR/Caddyfile}"
PREVIEW_TLS_SRC="${PREVIEW_TLS_SRC:-$APP_DIR/preview-tls.caddy}"
CADDY_RELOAD_SRC="${CADDY_RELOAD_SRC:-$APP_DIR/deploy/ha}"
HA_CODE_SRC="${HA_CODE_SRC:-$CADDY_RELOAD_SRC}"
HA_CODE_DST="${HA_CODE_DST:-/opt/webnestdev-ha}"
EGRESS_SCRIPT_SRC="${EGRESS_SCRIPT_SRC:-$APP_DIR/deploy/scripts/egress-firewall.sh}"
# Workflow передаёт актуальный скрипт из своего чекаута: APP_DIR на node-1 может быть старым,
# и тогда node-2 получала firewall без новых правил. B64 важнее файла.
EGRESS_FIREWALL_B64="${EGRESS_FIREWALL_B64:-}"
FUNCTIONS_NETWORK="${FUNCTIONS_DOCKER_NETWORK:-webnestdev-functions}"
CUSTOM_DOMAINS_CADDY_DIR="${CUSTOM_DOMAINS_CADDY_DIR:-/var/lib/webnestdev/data/caddy-custom}"
CADDY_DATA_HOST_DIR="${CADDY_DATA_HOST_DIR:-/var/lib/webnestdev/data/caddy-data}"
KEEP_IMAGES="${KEEP_IMAGES:-2}"
IMAGE_REPO_PATTERN="${IMAGE_REPO_PATTERN:-webnestdev}"
DRY_RUN="${DRY_RUN:-0}"

log(){ printf '[node2] %s\n' "$*"; }
run(){ if [ "$DRY_RUN" = "1" ]; then log "dry-run: $*"; else "$@"; fi; }

# Отдельная сеть функций не должна быть встроенной или сетью предпросмотра: иначе чужой код
# получит доступ к чужим preview, а не только к публичному интернету.
case "$FUNCTIONS_NETWORK" in
  ""|*[!A-Za-z0-9_.-]*|[!A-Za-z0-9]*)
    log "FUNCTIONS_DOCKER_NETWORK должен быть именем Docker-сети: $FUNCTIONS_NETWORK"; exit 1 ;;
  bridge|host|none|default)
    log "FUNCTIONS_DOCKER_NETWORK не может быть встроенной сетью: $FUNCTIONS_NETWORK"; exit 1 ;;
esac
if printf '%s' "$FUNCTIONS_NETWORK" | grep -Eq '(^|[-_])preview$'; then
  log "FUNCTIONS_DOCKER_NETWORK не может быть сетью предпросмотра: $FUNCTIONS_NETWORK"; exit 1
fi

# По умолчанию вторая нода обязательна: иначе выкатка зеленеет, а HA-контур
# остаётся на старой сборке. Для осознанного одиночного режима задайте SYNC_NODE2=0.
skip_or_fail(){
  if [ "$SYNC_NODE2" = "1" ]; then
    log "$1"
    exit 1
  fi
  log "$1 — пропускаю (SYNC_NODE2=$SYNC_NODE2)"
  exit 0
}

#
# Runtime-файлы HA. Список един для install-node*.sh и этой синхронизации:
# если файл забыли добавить в манифест, выкатка не должна считать узел готовым.
#
HA_FILES=()
load_ha_files(){
  local file
  [ -f "$HA_CODE_SRC/runtime-files.txt" ] || {
    log "нет $HA_CODE_SRC/runtime-files.txt — HA-код не синхронизирован"
    return 1
  }
  while IFS= read -r file; do
    case "$file" in ''|'#'*) continue ;; esac
    case "$file" in *[!A-Za-z0-9._-]*) log "недопустимое имя HA-файла: $file"; return 1 ;; esac
    [ -f "$HA_CODE_SRC/$file" ] || { log "нет $HA_CODE_SRC/$file"; return 1; }
    HA_FILES+=("$file")
  done < "$HA_CODE_SRC/runtime-files.txt"
  [ "${#HA_FILES[@]}" -gt 0 ] || { log "runtime-files.txt пуст"; return 1; }
}

ha_source_sha(){
  sha256sum "$HA_CODE_SRC/$1" | cut -d' ' -f1
}

install_ha_node1(){
  local file unit changed=0 active
  sudo -n install -d -m 755 "$HA_CODE_DST" || return 1
  for file in "${HA_FILES[@]}"; do
    if sudo -n cmp -s "$HA_CODE_SRC/$file" "$HA_CODE_DST/$file"; then
      continue
    fi
    sudo -n install -m 644 "$HA_CODE_SRC/$file" "$HA_CODE_DST/$file" || return 1
    changed=1
  done
  for unit in webnestdev-failover.service; do
    if ! sudo -n cmp -s "$HA_CODE_SRC/$unit" "/etc/systemd/system/$unit"; then
      sudo -n install -m 644 "$HA_CODE_SRC/$unit" "/etc/systemd/system/$unit" || return 1
      changed=1
    fi
  done
  active=$(sudo -n systemctl is-active webnestdev-failover.service 2>/dev/null || true)
  [ "$active" = "active" ] || changed=1
  if [ "$changed" = "1" ]; then
    sudo -n systemctl daemon-reload || return 1
    sudo -n systemctl restart webnestdev-failover.service || return 1
  fi
  sudo -n systemctl is-active --quiet webnestdev-failover.service || return 1
  for file in "${HA_FILES[@]}"; do
    [ "$(ha_source_sha "$file")" = "$(sudo -n sha256sum "$HA_CODE_DST/$file" | cut -d' ' -f1)" ] || {
      log "HA-файл $file на node-1 не совпал после установки"
      return 1
    }
  done
  [ "$(ha_source_sha webnestdev-failover.service)" = "$(sudo -n sha256sum /etc/systemd/system/webnestdev-failover.service | cut -d' ' -f1)" ] || {
    log "unit webnestdev-failover.service на node-1 не совпал после установки"
    return 1
  }
  log "HA-код node-1: ${#HA_FILES[@]} файлов, SHA подтверждён"
}

install_ha_node2(){
  local file unit remote_tmp changed=0 remote_sum active
  ssh2 "sudo -n install -d -m 755 '$HA_CODE_DST'" || return 1
  for file in "${HA_FILES[@]}"; do
    remote_sum=$(ssh2 "sudo -n sha256sum '$HA_CODE_DST/$file' 2>/dev/null | cut -d' ' -f1" || true)
    if [ "$(ha_source_sha "$file")" = "$remote_sum" ]; then
      continue
    fi
    remote_tmp="/tmp/.webnestdev-ha-$file.$$"
    ssh2_stdin "umask 077; cat > '$remote_tmp' && sudo -n install -m 644 '$remote_tmp' '$HA_CODE_DST/$file' && rm -f '$remote_tmp'" < "$HA_CODE_SRC/$file" || return 1
    changed=1
  done
  for unit in webnestdev-failover-node2.service; do
    remote_sum=$(ssh2 "sudo -n sha256sum '/etc/systemd/system/$unit' 2>/dev/null | cut -d' ' -f1" || true)
    if [ "$(ha_source_sha "$unit")" = "$remote_sum" ]; then
      continue
    fi
    remote_tmp="/tmp/.webnestdev-ha-$unit.$$"
    ssh2_stdin "umask 077; cat > '$remote_tmp' && sudo -n install -m 644 '$remote_tmp' '/etc/systemd/system/$unit' && rm -f '$remote_tmp'" < "$HA_CODE_SRC/$unit" || return 1
    changed=1
  done
  active=$(ssh2 "sudo -n systemctl is-active webnestdev-failover-node2.service 2>/dev/null" || true)
  [ "$active" = "active" ] || changed=1
  if [ "$changed" = "1" ]; then
    ssh2 "sudo -n systemctl daemon-reload && sudo -n systemctl restart webnestdev-failover-node2.service" || return 1
  fi
  ssh2 "sudo -n systemctl is-active --quiet webnestdev-failover-node2.service" || return 1
  for file in "${HA_FILES[@]}"; do
    remote_sum=$(ssh2 "sudo -n sha256sum '$HA_CODE_DST/$file' 2>/dev/null | cut -d' ' -f1" || true)
    [ "$(ha_source_sha "$file")" = "$remote_sum" ] || {
      log "HA-файл $file на node-2 не совпал после установки"
      return 1
    }
  done
  remote_sum=$(ssh2 "sudo -n sha256sum /etc/systemd/system/webnestdev-failover-node2.service 2>/dev/null | cut -d' ' -f1" || true)
  [ "$(ha_source_sha webnestdev-failover-node2.service)" = "$remote_sum" ] || {
    log "unit webnestdev-failover-node2.service на node-2 не совпал после установки"
    return 1
  }
  log "HA-код node-2: ${#HA_FILES[@]} файлов, SHA подтверждён"
}

#
# PostgreSQL TLS. Сертификат и ключ создаются один раз на node-1 (install-node1.sh),
# затем передаются на node-2 по SSH. Копируем сертификат, ключ (mode 600) и CA;
# после установки pg_tls.sh переводит HBA на hostssl и перечитывает PostgreSQL.
#
sync_pg_tls(){
  local dir=/etc/webnestdev-ha/pg-tls
  if [ "$DRY_RUN" = "1" ]; then
    log "dry-run: передал бы PostgreSQL TLS-сертификат из $dir на node-2"
    return 0
  fi
  if ! sudo -n test -s "$dir/server.crt" || ! sudo -n test -s "$dir/server.key"; then
    log "pg TLS: на node-1 нет $dir/server.crt — TLS на node-2 не включаю"
    return 0
  fi
  log "передаю PostgreSQL TLS-сертификат на node-2"
  ssh2 "sudo -n install -d -m 700 -o root -g root '$dir'" || return 1
  sudo -n tar -C "$dir" -czf - server.crt server.key ca.crt |
    ssh2_stdin "sudo -n tar -xzf - -C '$dir' && sudo -n chown root:root '$dir/server.crt' '$dir/server.key' '$dir/ca.crt' && sudo -n chmod 600 '$dir/server.key' && sudo -n chmod 644 '$dir/server.crt' '$dir/ca.crt'" || return 1
  ssh2 "sudo -n env PG_VERSION='${PG_VERSION:-17}' PG_CLUSTER='${PG_CLUSTER:-main}' LOCAL_PG_PORT='${LOCAL_PG_PORT:-5433}' bash '$HA_CODE_DST/pg_tls.sh' apply" || return 1
  log "PostgreSQL TLS на node-2 применён"
}

load_ha_files || exit 1
if [ "$DRY_RUN" = "1" ]; then
  log "dry-run: HA-код node-1 и node-2 не устанавливаю"
else
  install_ha_node1 || { log "HA-код node-1 не установлен"; exit 1; }
fi

[ "$SYNC_NODE2" = "0" ] && { log "SYNC_NODE2=0 — вторую ноду не трогаю"; exit 0; }
[ -n "$IMAGE_REF" ] || skip_or_fail "IMAGE_REF не задан"
printf '%s' "$IMAGE_REF" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._/-]*:[A-Za-z0-9._-]+$' || {
  log "недопустимый тег образа: $IMAGE_REF"
  exit 2
}
[ -f "$NODE2_SSH_KEY" ] || skip_or_fail "нет ключа $NODE2_SSH_KEY"

ssh_opts=(-i "$NODE2_SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10
  -o ServerAliveInterval=30 -o ServerAliveCountMax=30)
# Этот скрипт сам приходит по SSH на stdin (`ssh node-1 "bash -s" < node2-sync.sh`), а вложенный
# ssh по умолчанию читает stdin — он съедал остаток скрипта, и синхронизация молча обрывалась на
# середине с кодом 0 (та же ловушка описана в vm-deploy.sh). Поэтому stdin у вложенного ssh
# закрыт везде, где данные не передаются, а для передачи есть отдельная функция.
ssh2(){ ssh "${ssh_opts[@]}" "$NODE2_USER@$NODE2_HOST" "$@" < /dev/null; }
ssh2_stdin(){ ssh "${ssh_opts[@]}" "$NODE2_USER@$NODE2_HOST" "$@"; }

if [ "$DRY_RUN" != "1" ] && ! ssh2 true >/dev/null 2>&1; then
  skip_or_fail "node-2 ($NODE2_USER@$NODE2_HOST) недоступна по SSH"
fi
log "выкатываю $IMAGE_REF на node-2 ($NODE2_HOST)"

# Runner на этой ВМ: локальный контейнер никуда не переезжает, ему нужен только новый образ.
runner_script=""
runner_owned=0
if [ -n "$RUNNER_SCRIPT_B64" ]; then
  runner_script=$(mktemp)
  if printf '%s' "$RUNNER_SCRIPT_B64" | base64 -d > "$runner_script" 2>/dev/null; then
    runner_owned=1
  else
    log "скрипт обновления runner'а не распаковался — runner не трогаю"
    rm -f "$runner_script"
    runner_script=""
  fi
elif [ -n "$RUNNER_SCRIPT_SRC" ] && [ -f "$RUNNER_SCRIPT_SRC" ]; then
  runner_script="$RUNNER_SCRIPT_SRC"
fi

if [ -n "$runner_script" ] && [ "$DRY_RUN" != "1" ]; then
  IMAGE_REF="$IMAGE_REF" bash "$runner_script" || {
    log "runner на node-1 не обновился — выкатка не завершена"
    exit 1
  }
fi

#
# Файлы конфигурации. compose и Caddyfile на node-2 раньше обновлялись только руками, поэтому
# новый сервис или новый адрес превью появлялись лишь на первой ноде. Копируются три файла:
# они одинаковы на обеих нодах, а override (системная база, свои пути) остаётся локальным.
#
sync_file(){
  local name="$1" src="${2:-$APP_DIR/$1}"
  [ -f "$src" ] || { log "$name на этой ВМ нет — оставляю версию node-2"; return 0; }
  local local_sum remote_sum
  local_sum=$(sha256sum "$src" | cut -d' ' -f1)
  remote_sum=$(ssh2 "sha256sum '$NODE2_APP_DIR/$name' 2>/dev/null | cut -d' ' -f1" || true)
  if [ "$local_sum" = "$remote_sum" ]; then
    log "$name на node-2 уже совпадает"
    return 0
  fi
  log "обновляю $name на node-2"
  if [ "$DRY_RUN" = "1" ]; then
    log "dry-run: scp $src → $NODE2_APP_DIR/$name"
    return 0
  fi
  ssh2_stdin "cat > '$NODE2_APP_DIR/$name'" < "$src"
}

sync_file docker-compose.yml "$COMPOSE_SRC"
# Override тоже должен приезжать из репозитория: без него на node-2 нет приватного порта и
# WEBNESTDEV_API_ADDRESS, и owner-routing после выкатки остаётся нерабочим.
NODE2_OVERRIDE_SRC="${NODE2_OVERRIDE_SRC:-$(dirname "$COMPOSE_SRC")/deploy/node2/docker-compose.override.yml}"
if [ ! -f "$NODE2_OVERRIDE_SRC" ]; then
  NODE2_OVERRIDE_SRC="$APP_DIR/deploy/node2/docker-compose.override.yml"
fi
sync_file docker-compose.override.yml "$NODE2_OVERRIDE_SRC"
sync_file Caddyfile "$CADDY_SRC"
sync_file preview-tls.caddy "$PREVIEW_TLS_SRC"
sync_file host-tls.caddy
# Origin-сертификат нужен обеим нодам: CDN ходит на NLB и может попасть в любую.
if [ "$DRY_RUN" != "1" ]; then
  ssh2 "mkdir -p '$NODE2_APP_DIR/certs/host'" || log "не удалось создать certs/host на node-2"
fi
sync_file certs/host/fullchain.pem
sync_file certs/host/key.pem
if [ "$DRY_RUN" != "1" ]; then
  ssh2 "chmod 600 '$NODE2_APP_DIR/certs/host/key.pem' 2>/dev/null || true"
  # Caddyfile импортирует этот каталог; на свежей node-2 пустой каталог не пройдёт validate.
  # Актуальный файл API на общей Gluster-точке не перезаписываем; старый map
  # без `hosting_slash` заменяем безопасным default до первого прохода API.
  ssh2 "mkdir -p '$CUSTOM_DOMAINS_CADDY_DIR' '$CADDY_DATA_HOST_DIR' && { if [ ! -f '$CUSTOM_DOMAINS_CADDY_DIR/custom-domains.caddy' ]; then printf '# Сгенерировано API.\n' > '$CUSTOM_DOMAINS_CADDY_DIR/custom-domains.caddy'; fi; if [ ! -f '$CUSTOM_DOMAINS_CADDY_DIR/hosting-modes.map' ] || ! grep -q 'hosting_slash' '$CUSTOM_DOMAINS_CADDY_DIR/hosting-modes.map' 2>/dev/null; then printf 'map {http.request.host} {hosting_mode} {hosting_canonical} {hosting_slash} {\n\tdefault \"spa\" \"\" \"ignore\"\n}\n' > '$CUSTOM_DOMAINS_CADDY_DIR/hosting-modes.map'; fi; if [ ! -f '$CUSTOM_DOMAINS_CADDY_DIR/hosting-redirects.map' ]; then printf '# Сгенерировано API.\n' > '$CUSTOM_DOMAINS_CADDY_DIR/hosting-redirects.map'; fi; }" || \
    log "не удалось подготовить каталоги custom/caddy-data на node-2"
fi

# Образ. Если он уже есть на node-2 (например, повторный запуск после сбоя на середине),
# повторно не гоняем гигабайты: docker save отдаёт весь образ целиком.
if [ "$DRY_RUN" != "1" ] && ssh2 "docker image inspect '$IMAGE_REF' >/dev/null 2>&1"; then
  log "образ уже есть на node-2"
else
  log "передаю образ на node-2 (docker save | ssh | docker load)"
  if [ "$DRY_RUN" = "1" ]; then
    log "dry-run: docker save $IMAGE_REF | gzip -1 | ssh … docker load"
  else
    docker save "$IMAGE_REF" | gzip -1 | ssh2_stdin "gunzip | docker load"
  fi
fi

# Версия закрепляется в env-файлах node-2: после перезагрузки compose должен поднять ту же
# сборку, а не то, что осталось в файле с прошлой ручной выкатки.
pin_image(){
  local files="$*" file found=0
  for file in $files; do
    local path="$NODE2_APP_DIR/$file"
    if ssh2 "grep -q '^WEBNESTDEV_IMAGE=' '$path' 2>/dev/null"; then
      found=1
      if ssh2 "grep -qx 'WEBNESTDEV_IMAGE=$IMAGE_REF' '$path'"; then
        log "WEBNESTDEV_IMAGE в $file уже $IMAGE_REF"
        continue
      fi
      log "WEBNESTDEV_IMAGE в $file → $IMAGE_REF"
      run ssh2 "sed -i 's|^WEBNESTDEV_IMAGE=.*|WEBNESTDEV_IMAGE=$IMAGE_REF|' '$path'"
    fi
  done
  if [ "$found" = "0" ]; then
    file=${NODE2_ENV_FILES%% *}
    log "WEBNESTDEV_IMAGE не найден в env-файлах — добавляю в $file"
    run ssh2 "printf 'WEBNESTDEV_IMAGE=%s\n' '$IMAGE_REF' >> '$NODE2_APP_DIR/$file'"
  fi
}
pin_image $NODE2_ENV_FILES

# Флаг custom domains не секрет, но без него API на node-2 останется с дефолтом 0 и после
# переключения трафика не будет отдавать маршруты. Не перезаписываем чужие значения пустым.
pin_platform_flag(){
  local name="$1" value="$2" file found=0
  [ -n "$value" ] || return 0
  case "$value" in *[!A-Za-z0-9_.:-]*) log "$name: недопустимое значение — не меняю"; return 0 ;; esac
  for file in $NODE2_ENV_FILES; do
    if ssh2 "grep -q '^$name=' '$NODE2_APP_DIR/$file' 2>/dev/null"; then
      found=1
      if ssh2 "grep -qx '$name=$value' '$NODE2_APP_DIR/$file'"; then
        log "$name в $file уже $value"
        continue
      fi
      log "$name в $file → $value"
      run ssh2 "sed -i 's|^$name=.*|$name=$value|' '$NODE2_APP_DIR/$file'"
    fi
  done
  if [ "$found" = "0" ]; then
    file=${NODE2_ENV_FILES%% *}
    log "$name не найден в env-файлах node-2 — добавляю в $file"
    run ssh2 "printf '%s=%s\\n' '$name' '$value' >> '$NODE2_APP_DIR/$file'"
  fi
}
pin_platform_flag CUSTOM_DOMAINS_ENABLED "$CUSTOM_DOMAINS_ENABLED"

#
# Пересоздание сервиса. `--env-file` передаётся по одному на файл: именно так контейнеры node-2
# и были созданы, и compose должен видеть те же переменные. `--no-deps` не даёт compose поднять
# `postgres` из базового файла — с override база системная.
compose_cmd(){
  local args="" file
  for file in $NODE2_ENV_FILES; do
    args="$args --env-file '$NODE2_APP_DIR/$file'"
  done
  printf '%s' "docker compose$args -f '$NODE2_APP_DIR/docker-compose.yml'"
  if ssh2 "test -f '$NODE2_APP_DIR/docker-compose.override.yml'"; then
    printf '%s' " -f '$NODE2_APP_DIR/docker-compose.override.yml'"
  fi
}

log "пересоздаю на node-2: $NODE2_SERVICES (включая Caddy, чтобы обновился и образ)"
# Сеть функций не создаётся compose: без неё первый же вызов функции упал бы на `--network`.
run ssh2 "docker network inspect '$FUNCTIONS_NETWORK' >/dev/null 2>&1 || docker network create --driver bridge --label webnestdev.functions=1 '$FUNCTIONS_NETWORK'"
if [ "$DRY_RUN" != "1" ]; then
  if [ "$(ssh2 "docker network inspect -f '{{.EnableIPv6}}' '$FUNCTIONS_NETWORK' 2>/dev/null" || true)" = "true" ]; then
    log "сеть функций $FUNCTIONS_NETWORK включает IPv6 — правила хоста закрывают только IPv4"; exit 1
  fi
  if [ "$(ssh2 "docker network inspect -f '{{.Driver}}' '$FUNCTIONS_NETWORK' 2>/dev/null" || true)" != "bridge" ]; then
    log "сеть функций $FUNCTIONS_NETWORK должна быть bridge"; exit 1
  fi
fi
run ssh2 "cd '$NODE2_APP_DIR' && FUNCTIONS_DOCKER_NETWORK='$FUNCTIONS_NETWORK' WEBNESTDEV_IMAGE='$IMAGE_REF' $(compose_cmd) up -d --no-build --no-deps $NODE2_SERVICES"

# Legacy postgres на node-2: тот же дефект, что и на первой ноде, — после `up` он мог остаться
# в работе с прошлой ручной выкатки.
if [ "$DRY_RUN" != "1" ]; then
  legacy=$(ssh2 "cd '$NODE2_APP_DIR' && $(compose_cmd) ps -q postgres 2>/dev/null | head -1" || true)
  if [ -n "$legacy" ] && [ "$(ssh2 "docker inspect -f '{{.State.Running}}' '$legacy' 2>/dev/null" || true)" = "true" ]; then
    log "legacy postgres на node-2 работает — останавливаю"
    run ssh2 "cd '$NODE2_APP_DIR' && $(compose_cmd) stop postgres >/dev/null"
  fi
fi

# Caddy перед сервисом не пересоздаётся: его конфигурация могла измениться, а bind-mount держит
# старый inode. Перечитывание без перерыва, при отказе — перезапуск контейнера.
if ssh2 "test -f '$NODE2_APP_DIR/Caddyfile'"; then
  log "перечитываю Caddyfile на node-2"
  run ssh2 "cd '$NODE2_APP_DIR' && $(compose_cmd) exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile </dev/null || $(compose_cmd) restart caddy >/dev/null" || \
    log "Caddy на node-2 не перечитал конфигурацию — проверьте docker compose logs caddy"
fi

# Таймер reload нужен и на второй ноде: иначе custom-домен, добавленный через API node-1,
# останется в общем файле, но Caddy node-2 не увидит его до следующей выкатки. Скрипты
# установщика берём из репозитория node-1, потому что на node-2 лежит только compose/образ.
install_caddy_reload_node2(){
  local src="$CADDY_RELOAD_SRC"
  local file
  for file in caddy-reload.sh webnestdev-caddy-reload.service webnestdev-caddy-reload.timer install-caddy-reload.sh; do
    [ -f "$src/$file" ] || { log "в $src нет $file — таймер reload на node-2 не установлен"; return 0; }
  done
  if [ "$DRY_RUN" = "1" ]; then
    log "dry-run: установил бы webnestdev-caddy-reload.timer на node-2"
    return 0
  fi
  log "устанавливаю таймер reload Caddy на node-2"
  ssh2 "mkdir -p '$NODE2_APP_DIR/deploy/ha'" || return 0
  for file in caddy-reload.sh webnestdev-caddy-reload.service webnestdev-caddy-reload.timer install-caddy-reload.sh; do
    ssh2_stdin "cat > '$NODE2_APP_DIR/deploy/ha/$file'" < "$src/$file" || {
      log "не удалось передать $file на node-2 — таймер reload не установлен"
      return 0
    }
  done
  ssh2 "cd '$NODE2_APP_DIR/deploy/ha' && sudo -n env APP_DIR='$NODE2_APP_DIR' COMPOSE_ENV_FILES='$NODE2_ENV_FILES' CUSTOM_DOMAINS_CADDY_DIR='${CUSTOM_DOMAINS_CADDY_DIR:-/var/lib/webnestdev/data/caddy-custom}' CADDY_DATA_HOST_DIR='${CADDY_DATA_HOST_DIR:-/var/lib/webnestdev/data/caddy-data}' bash ./install-caddy-reload.sh" || \
    log "таймер reload на node-2 не установлен (нужен sudo -n) — установите deploy/ha/install-caddy-reload.sh вручную"
}
install_caddy_reload_node2

# HA-код должен быть не только на node-1: иначе после падения первой ноды
# node-2 поднимет старый контроллер. Ошибка здесь — ошибка выкатки.
if [ "$DRY_RUN" = "1" ]; then
  log "dry-run: HA-код node-2 не устанавливаю"
else
  install_ha_node2 || { log "HA-код node-2 не установлен"; exit 1; }
  sync_pg_tls || { log "PostgreSQL TLS на node-2 не применён"; exit 1; }
fi

# Runner на node-2: тот же шаг, что и на первой ноде, но скрипт выполняется на второй машине.
if [ -n "$runner_script" ] && [ "$DRY_RUN" != "1" ]; then
  log "обновляю runner на node-2"
  if ! ssh2_stdin "IMAGE_REF='$IMAGE_REF' bash -s" < "$runner_script"; then
    log "runner на node-2 не обновился — выкатка не завершена"
    exit 1
  fi
fi
[ "$runner_owned" = "1" ] && rm -f "$runner_script"

# Проверка: вторая нода должна отвечать и работать именно на выкаченной сборке. Только после
# этого выкатку можно считать состоявшейся — иначе при падении первой ноды поднимется старая.
expected=$(printf '%s' "$IMAGE_REF" | sed -n 's/.*:sha-\([0-9a-fA-F]\{7,\}\)$/\1/p')
if [ "$DRY_RUN" = "1" ]; then
  log "dry-run: проверка $NODE2_HEALTH_URL пропущена"
  exit 0
fi
build=""
for _ in $(seq 1 "$NODE2_HEALTH_TRIES"); do
  build=$(ssh2 "curl -fsS --max-time 5 '$NODE2_HEALTH_URL' 2>/dev/null" | sed -n 's/.*"build":"\([^"]*\)".*/\1/p' || true)
  [ -n "$build" ] && break
  sleep 2
done
if [ -z "$build" ]; then
  log "node-2 не ответила на $NODE2_HEALTH_URL — при падении первой ноды вторая поднимет неизвестное состояние"
  exit 1
fi
if [ -n "$expected" ] && [ "${build#"$expected"}" = "$build" ]; then
  log "node-2 работает на сборке $build, а выкатывали $expected"
  exit 1
fi

#
# Уборка на node-2: образы и логи.
#
# node-1 чистит образы сам внутри каждой выкатки (`KEEP_IMAGES`), а вторая нода до 10.11.2026
# обновлялась вручную и не чистилась ни разу: там лежали четыре образа сервера по 1.45 ГБ
# и 1.45 ГБ кеша сборки при диске 19 ГБ. Скрипт пересылается на node-2 один раз и запускается
# дважды — `prune` (образы) и `housekeeping` (логи), поэтому правило «текущая и предыдущая
# версия» остаётся тем же, что на первой ноде. Ошибка уборки не отменяет выкатку: сервис уже
# проверен, а место — состояние хоста.
if [ -n "$DEPLOY_SCRIPT_SRC" ] && [ -f "$DEPLOY_SCRIPT_SRC" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    log "dry-run: уборку образов и логов на node-2 пропускаю"
  else
    remote_script="/tmp/.webnestdev-maintenance.$$.sh"
    ssh2_stdin "umask 077; cat > '$remote_script'" < "$DEPLOY_SCRIPT_SRC"
    log "убираю старые образы на node-2 (оставляю $KEEP_IMAGES версий)"
    ssh2 "MODE='prune' APP_DIR='$NODE2_APP_DIR' KEEP_IMAGES='$KEEP_IMAGES' IMAGE_REPO_PATTERN='$IMAGE_REPO_PATTERN' bash '$remote_script'" || \
      log "уборка образов на node-2 не удалась — место на диске не освободилось"
    log "чищу логи node-2 (journald и glusterfs)"
    ssh2 "MODE='housekeeping' APP_DIR='$NODE2_APP_DIR' bash '$remote_script'" || \
      log "ротация логов на node-2 не отработала"
    # Фильтр исходящей сети (5.1) на второй ноде: до этого правила ставились только на первой,
    # и превью, попавшее на node-2, могло ходить наружу мимо прокси. Скрипт тот же, решение о
    # включении — в EGRESS_MODE/EGRESS_ENFORCE на самой ноде.
    log "применяю правила egress на node-2"
    # Скрипт передаётся тем же способом, что и в первую ноду: в base64, а не чекаутом на node-2 —
    # там лежит только compose и образ, и старый скрипт правил тихо расходился бы с кодом.
    if [ -z "$EGRESS_FIREWALL_B64" ]; then
      if [ -f "$EGRESS_SCRIPT_SRC" ]; then
        EGRESS_FIREWALL_B64=$(base64 -w0 "$EGRESS_SCRIPT_SRC")
      else
        log "egress-firewall.sh не найден ($EGRESS_SCRIPT_SRC) — правила на node-2 не ставлю"; exit 6
      fi
    fi
    # У node-2 нет .env: без COMPOSE_ENV_FILES `docker compose config/exec` в MODE=egress
    # возвращает пустоту, проверка считает прокси мёртвым и снимает уже поставленные правила.
    node2_compose_envs=$(printf '%s' "$NODE2_ENV_FILES" | tr ' ' ',')
    ssh2 "MODE='egress' APP_DIR='$NODE2_APP_DIR' COMPOSE_ENV_FILES='$node2_compose_envs' FUNCTIONS_DOCKER_NETWORK='$FUNCTIONS_NETWORK' EGRESS_FIREWALL_B64='$EGRESS_FIREWALL_B64' bash '$remote_script'" || {
      log "правила egress на node-2 не применены — выкатка не принята"; exit 6
    }
    ssh2 "rm -f '$remote_script'" || true
  fi
else
  log "скрипт выкатки не передан — уборку на node-2 не делаю"
fi
log "node-2 готова: сборка $build отвечает на /api/ready"
