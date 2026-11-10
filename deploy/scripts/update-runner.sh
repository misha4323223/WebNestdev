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
if [ "$current" = "$IMAGE_REF" ]; then
  log "$runner уже работает на $IMAGE_REF"
  exit 0
fi
log "$runner работает на ${current:-неизвестном образе} — перевожу на $IMAGE_REF"

network=$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$runner" 2>/dev/null || true)
restart=$(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$runner" 2>/dev/null || true)

binds=()
while IFS= read -r bind; do
  [ -n "$bind" ] && binds+=(-v "$bind")
done < <(docker inspect --format '{{range .HostConfig.Binds}}{{println .}}{{end}}' "$runner")

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
