#!/usr/bin/env bash
#
# Перевод контейнера runner на ту же сборку, что у сервиса.
#
# Runner живёт вне compose: его создавали руками, и выкатка его не касалась. Поэтому API
# обновлялся, а runner оставался на прежней сборке (на node-1 — c8a0812, на node-2 — 30b7bf8
# при сервисе af837ac). Это не видно по /api/ready: сервис отвечает, а задачи в песочницах
# исполняет старый код. Здесь контейнер пересоздаётся на новом образе с той же конфигурацией
# (сеть, тома, переменные, команда, restart-политика), поэтому повторный запуск ничего не делает.
#
# Переменные:
#   IMAGE_REF=ghcr.io/…   образ, на который переводится runner (обязателен)
#   RUNNER_CONTAINER=…    имя контейнера; без него ищутся node1-runner и node2-runner
#   DRY_RUN=1             показать шаги, ничего не меняя
#
# Порядок важен: новый контейнер сначала создаётся (docker create), и только потом удаляется
# старый. Если create не удался, прежний runner продолжает работать — обновление не оставляет
# узел без runner'а.
set -euo pipefail

IMAGE_REF="${IMAGE_REF:-}"
RUNNER_CONTAINER="${RUNNER_CONTAINER:-}"
DRY_RUN="${DRY_RUN:-0}"

log(){ printf '[runner] %s\n' "$*"; }

if [ -z "$IMAGE_REF" ]; then
  log "IMAGE_REF не задан — runner не обновляю"
  exit 2
fi
if ! printf '%s' "$IMAGE_REF" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._/-]*:[A-Za-z0-9._-]+$'; then
  log "недопустимый тег образа: $IMAGE_REF"
  exit 2
fi

runner="$RUNNER_CONTAINER"
if [ -z "$runner" ]; then
  for candidate in node1-runner node2-runner; do
    if docker inspect "$candidate" >/dev/null 2>&1; then
      runner="$candidate"
      break
    fi
  done
fi
if [ -z "$runner" ]; then
  log "контейнер runner не найден — обновлять нечего"
  exit 0
fi

current=$(docker inspect --format '{{.Config.Image}}' "$runner" 2>/dev/null || true)
network=$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$runner" 2>/dev/null || true)
restart=$(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$runner" 2>/dev/null || true)

# Локальный кэш node_modules. Runner — контейнер вне compose, поэтому обновление образа само
# по себе не добавляло ему ни каталог, ни bind-mount, ни переменные. В итоге runner создавал
# кэш внутри своего контейнера, а `docker run -v` монтировал на хосте другой (root-owned)
# каталог. Здесь конфигурация кэша приводится к тому же виду, что у API.
cache_dir="${PREVIEW_CACHE_DIR:-/var/lib/webnestdev/preview-cache}"
case "$cache_dir" in
  ""|"/") log "небезопасный PREVIEW_CACHE_DIR=$cache_dir"; exit 2 ;;
  /*) ;;
  *) log "PREVIEW_CACHE_DIR должен быть абсолютным: $cache_dir"; exit 2 ;;
esac
case "$cache_dir" in
  /var/lib/webnestdev/sandboxes|/var/lib/webnestdev/sandboxes/*)
    log "PREVIEW_CACHE_DIR не должен лежать внутри песочницы: $cache_dir"; exit 2 ;;
esac
if [ ! -d "$cache_dir" ]; then
  mkdir -p "$cache_dir" 2>/dev/null || sudo -n mkdir -p "$cache_dir" 2>/dev/null || true
fi
if [ -d "$cache_dir" ]; then
  if [ "$(id -u)" = "0" ]; then
    chown -h 1000:1000 "$cache_dir" 2>/dev/null || true
  else
    sudo -n chown -h 1000:1000 "$cache_dir" 2>/dev/null || true
  fi
  chmod 0775 "$cache_dir" 2>/dev/null || sudo -n chmod 0775 "$cache_dir" 2>/dev/null || true
else
  log "каталог кэша $cache_dir не создан — проверьте права"
  exit 1
fi
cache_bind="$cache_dir:$cache_dir"
has_cache_bind=0
binds=()
while IFS= read -r bind; do
  [ -n "$bind" ] || continue
  binds+=(-v "$bind")
  [ "$bind" = "$cache_bind" ] && has_cache_bind=1
done < <(docker inspect --format '{{range .HostConfig.Binds}}{{println .}}{{end}}' "$runner")
if [ "$has_cache_bind" = "0" ]; then
  binds+=(-v "$cache_bind")
fi

cmd=()
while IFS= read -r arg; do
  [ -n "$arg" ] && cmd+=("$arg")
done < <(docker inspect --format '{{range .Config.Cmd}}{{println .}}{{end}}' "$runner")
if [ "${#cmd[@]}" -eq 0 ]; then
  # Без явной команды контейнер запустит CMD образа, то есть супервизор сервера, а не runner.
  log "$runner не имеет своей команды — пересоздавать нельзя, иначе вместо runner'а поднимется сервис"
  exit 1
fi

# Переменные передаются файлом, а не `-e` в командной строке: в окружении runner'а лежит
# RUNNER_TOKEN, а аргументы docker create видны в списке процессов всем пользователям хоста.
# Файл создаётся с правами 0600 и удаляется сразу после создания контейнера.
env_file=$(mktemp)
chmod 600 "$env_file"
trap 'rm -f "$env_file"' EXIT
while IFS= read -r line; do
  [ -n "$line" ] || continue
  case "${line%%=*}" in
    # HOSTNAME docker выставляет сам; WEBNESTDEV_BUILD зашит в новый образ, и старое значение
    # в окружении показывало бы сборку, которой контейнер уже не соответствует; PATH берётся
    # из образа (та же база).
    HOSTNAME|WEBNESTDEV_BUILD|PATH) continue ;;
  esac
  printf '%s\n' "$line" >> "$env_file"
done < <(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$runner")

# Значения кэша добавляются только если их ещё нет: существующие настройки узла не
# перетираются. TTL — тот же, что у API (по умолчанию 30 дней).
env_added=0
ensure_env(){
  local name="$1" value="$2"
  if ! grep -q "^${name}=" "$env_file"; then
    printf '%s=%s\n' "$name" "$value" >> "$env_file"
    env_added=1
  fi
}
ensure_env WEBNESTDEV_PREVIEW_CACHE_DIR "$cache_dir"
ensure_env WEBNESTDEV_PREVIEW_CACHE_HOST_DIR "$cache_dir"
ensure_env WEBNESTDEV_PREVIEW_CACHE_TTL_DAYS "${PREVIEW_CACHE_TTL_DAYS:-30}"

if [ "$current" = "$IMAGE_REF" ] && [ "$has_cache_bind" = "1" ] && [ "$env_added" = "0" ]; then
  log "$runner уже работает на $IMAGE_REF с локальным кэшем $cache_dir"
  exit 0
fi
if [ "$current" = "$IMAGE_REF" ]; then
  log "$runner уже на $IMAGE_REF, но конфигурация кэша неполная — пересоздаю с $cache_dir"
else
  log "$runner работает на ${current:-неизвестном образе} — перевожу на $IMAGE_REF"
fi

args=(--name "$runner.new")
[ -n "$network" ] && args+=(--network "$network")
[ -n "$restart" ] && args+=(--restart "$restart")
args+=(--env-file "$env_file" "${binds[@]}" "$IMAGE_REF" "${cmd[@]}")

if [ "$DRY_RUN" = "1" ]; then
  log "dry-run: docker create --name $runner.new --network ${network:-default} --restart ${restart:-no} --env-file <0600> ${binds[*]} $IMAGE_REF ${cmd[*]}"
  exit 0
fi

docker rm -f "$runner.new" >/dev/null 2>&1 || true
if ! docker create "${args[@]}" >/dev/null; then
  log "новый контейнер не создался — $runner остаётся на ${current:-прежнем образе}"
  docker rm -f "$runner.new" >/dev/null 2>&1 || true
  exit 1
fi
docker rm -f "$runner" >/dev/null
docker rename "$runner.new" "$runner"
docker start "$runner" >/dev/null

sleep 3
running=$(docker inspect --format '{{.State.Running}}' "$runner" 2>/dev/null || true)
if [ "$running" != "true" ]; then
  log "$runner не запустился на $IMAGE_REF — смотрите docker logs $runner"
  docker logs --tail 30 "$runner" 2>&1 | sed 's/^/[runner]   /' || true
  exit 1
fi
log "$runner запущен на $IMAGE_REF"
