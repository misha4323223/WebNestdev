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
#   APP_DIR=~/webnestdev/src   каталог развёртывания на этой ВМ (источник compose и Caddyfile)
#   NODE2_HOST=10.0.0.5        приватный адрес второй ноды
#   NODE2_USER=ubuntu
#   NODE2_SSH_KEY=~/.ssh/node2_key
#   NODE2_APP_DIR=/home/ubuntu/webnestdev/src
#   NODE2_ENV_FILES="runtime.env node2.env"  env-файлы compose на node-2
#   NODE2_SERVICES="webnestdev-server docker-broker"
#   NODE2_HEALTH_URL=http://127.0.0.1:8787/api/ready
#   SYNC_NODE2=auto|1|0        auto — молча пропустить, если node-2 недоступна; 1 — ошибка
#   RUNNER_SCRIPT_B64=…        содержимое deploy/scripts/update-runner.sh в base64
#   RUNNER_SCRIPT_SRC=<путь>   тот же скрипт файлом
#   DRY_RUN=1
set -euo pipefail

IMAGE_REF="${IMAGE_REF:-}"
APP_DIR="${APP_DIR:-$HOME/webnestdev/src}"
NODE2_HOST="${NODE2_HOST:-10.0.0.5}"
NODE2_USER="${NODE2_USER:-ubuntu}"
NODE2_SSH_KEY="${NODE2_SSH_KEY:-$HOME/.ssh/node2_key}"
NODE2_APP_DIR="${NODE2_APP_DIR:-/home/ubuntu/webnestdev/src}"
NODE2_ENV_FILES="${NODE2_ENV_FILES:-runtime.env node2.env}"
NODE2_SERVICES="${NODE2_SERVICES:-webnestdev-server docker-broker}"
NODE2_HEALTH_URL="${NODE2_HEALTH_URL:-http://127.0.0.1:8787/api/ready}"
NODE2_HEALTH_TRIES="${NODE2_HEALTH_TRIES:-30}"
SYNC_NODE2="${SYNC_NODE2:-auto}"
RUNNER_SCRIPT_B64="${RUNNER_SCRIPT_B64:-}"
RUNNER_SCRIPT_SRC="${RUNNER_SCRIPT_SRC:-}"
DRY_RUN="${DRY_RUN:-0}"

log(){ printf '[node2] %s\n' "$*"; }
run(){ if [ "$DRY_RUN" = "1" ]; then log "dry-run: $*"; else "$@"; fi; }

# Недоступный peer — не ошибка выкатки: node-2 может быть выключена. Явное SYNC_NODE2=1
# делает недоступность ошибкой — это нужно, когда проверяют именно HA-контур.
skip_or_fail(){
  if [ "$SYNC_NODE2" = "1" ]; then
    log "$1"
    exit 1
  fi
  log "$1 — пропускаю (SYNC_NODE2=$SYNC_NODE2)"
  exit 0
}

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
  IMAGE_REF="$IMAGE_REF" bash "$runner_script" || log "runner на этой ВМ не обновился"
fi

#
# Файлы конфигурации. compose и Caddyfile на node-2 раньше обновлялись только руками, поэтому
# новый сервис или новый адрес превью появлялись лишь на первой ноде. Копируются три файла:
# они одинаковы на обеих нодах, а override (системная база, свои пути) остаётся локальным.
#
sync_file(){
  local name="$1" src="$APP_DIR/$1"
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

sync_file docker-compose.yml
sync_file Caddyfile
sync_file preview-tls.caddy

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

log "пересоздаю на node-2: $NODE2_SERVICES"
run ssh2 "cd '$NODE2_APP_DIR' && WEBNESTDEV_IMAGE='$IMAGE_REF' $(compose_cmd) up -d --no-build --no-deps $NODE2_SERVICES"

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

# Runner на node-2: тот же шаг, что и на первой ноде, но скрипт выполняется на второй машине.
if [ -n "$runner_script" ] && [ "$DRY_RUN" != "1" ]; then
  log "обновляю runner на node-2"
  if ! ssh2_stdin "IMAGE_REF='$IMAGE_REF' bash -s" < "$runner_script"; then
    log "runner на node-2 не обновился"
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
log "node-2 готова: сборка $build отвечает на /api/ready"
