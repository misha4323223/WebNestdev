#!/usr/bin/env bash
#
# Деплой на ВМ. Скрипт лежит в репозитории, но выполняется НА сервере: GitHub Actions
# присылает его по SSH (`ssh … "bash -s" < deploy/scripts/vm-deploy.sh`) либо запускает
# локально, если деплой идёт с self-hosted runner на самой ВМ. Права на исполнение файлу
# не нужны — его всегда запускают через `bash`.
#
# Переменные окружения (все необязательные, кроме IMAGE_REF для MODE=image):
#   MODE=image|source          что доставлять: готовый образ или сборку из репозитория
#   IMAGE_REF=ghcr.io/…        образ для MODE=image
#   APP_DIR=~/webnestdev/src   каталог развёртывания (docker-compose.yml и .env)
#   COMPOSE_FILE=docker-compose.yml
#   SERVICE=webnestdev-server  сервис в compose
#   GIT_BRANCH=main            ветка для MODE=source
#   SYSTEMD_UNIT=webnestdev    юнит, который перезапускается в MODE=source
#   HEALTH_URL=http://127.0.0.1:8787/api/ready
#   HEALTH_TRIES=30            попыток по 2 секунды
#   KEEP_IMAGES=2              сколько версий образа оставлять на диске (текущая + одна на откат)
#   IMAGE_REPO_PATTERN=webnestdev  какие репозитории чистить
#   PRUNE_BUILD_CACHE=1        разрешить ещё и чистку кеша сборки (по умолчанию нет)
#   DRY_RUN=1                  показать шаги, ничего не меняя
#
# MODE=prune — только уборка образов, без выкатки и без перезапуска сервиса.
set -euo pipefail

MODE="${MODE:-image}"
IMAGE_REF="${IMAGE_REF:-}"
APP_DIR="${APP_DIR:-$HOME/webnestdev/src}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
SERVICE="${SERVICE:-webnestdev-server}"
GIT_BRANCH="${GIT_BRANCH:-main}"
SYSTEMD_UNIT="${SYSTEMD_UNIT:-webnestdev}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8787/api/ready}"
HEALTH_TRIES="${HEALTH_TRIES:-30}"
DRY_RUN="${DRY_RUN:-0}"
KEEP_IMAGES="${KEEP_IMAGES:-2}"
IMAGE_REPO_PATTERN="${IMAGE_REPO_PATTERN:-webnestdev}"
PRUNE_BUILD_CACHE="${PRUNE_BUILD_CACHE:-0}"

log(){ printf '[deploy] %s\n' "$*"; }
run(){ if [ "$DRY_RUN" = "1" ]; then log "dry-run: $*"; else "$@"; fi; }

#
# Каждая выкатка приносит новый образ (в нём Chromium — это гигабайты), и без уборки диск
# кончается за несколько деплоев. Оставляем последние KEEP_IMAGES версий: текущую и одну
# на откат — workflow умеет выкатывать произвольный тег, и откат не должен требовать
# повторной сборки.
#
prune_images(){
  local keep="$KEEP_IMAGES"
  case "$keep" in ''|*[!0-9]*) keep=2;; esac
  local before after doomed
  before=$(docker system df --format '{{.Size}}' 2>/dev/null | tr '\n' ' ' || true)
  # Один образ может быть с двумя тегами (latest и sha-…): в листинге это две строки с одним
  # ID, и без дедупликации он съел бы два места из «двух последних».
  doomed=$(docker images --format '{{.ID}}\t{{.Repository}}\t{{.CreatedAt}}' 2>/dev/null \
    | awk -F'\t' -v pattern="$IMAGE_REPO_PATTERN" '
        index($2, pattern) == 0 { next }
        seen[$1]++ { next }
        { print $3 "\t" $1 "\t" $2 }
      ' \
    | sort -r \
    | awk -F'\t' -v keep="$keep" '{ count[$3]++ ; if (count[$3] > keep) print $2 }')
  log "чищу старые образы: оставляю $keep последних для репозиториев со «$IMAGE_REPO_PATTERN»"
  if [ -z "$doomed" ]; then
    log "лишних образов нет"
  elif [ "$DRY_RUN" = "1" ]; then
    log "dry-run: удалил бы образы: $(printf '%s' "$doomed" | tr '\n' ' ')"
  else
    while read -r id; do
      [ -n "$id" ] || continue
      # Занятый образ удалить нельзя — это нормально: он работает прямо сейчас.
      if docker rmi "$id" >/dev/null 2>&1; then
        log "удалён старый образ $id"
      else
        log "образ $id занят или уже удалён — оставляю"
      fi
    done <<< "$doomed"
    docker image prune -f >/dev/null 2>&1 || true
    if [ "$PRUNE_BUILD_CACHE" = "1" ]; then
      docker builder prune -f --filter until=168h >/dev/null 2>&1 || true
    fi
  fi
  after=$(docker system df --format '{{.Size}}' 2>/dev/null | tr '\n' ' ' || true)
  log "docker system df: было [$before], стало [$after]"
}

# /api/ready проверяет и хранилище, и доступность Docker для песочниц: деплой считается
# успешным только тогда, когда сервис действительно готов обслуживать запросы.
wait_for_health(){
  local attempt body
  for attempt in $(seq 1 "$HEALTH_TRIES"); do
    if body=$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null); then
      log "сервис готов (попытка $attempt): $body"
      return 0
    fi
    sleep 2
  done
  log "сервис не поднялся за $((HEALTH_TRIES * 2)) с: $HEALTH_URL"
  # /api/health отвечает даже тогда, когда readiness не пройден, и показывает причину.
  local diagnostic="${HEALTH_URL%/*}/health"
  log "диагностика $diagnostic:"
  curl -sS --max-time 5 "$diagnostic" 2>&1 | head -c 500 || true
  printf '\n'
  return 1
}

if [ ! -d "$APP_DIR" ]; then
  if [ "$MODE" = "prune" ]; then
    log "каталог развёртывания не найден ($APP_DIR), но для уборки образов он не нужен"
  else
    log "каталог развёртывания не найден: $APP_DIR"
    exit 2
  fi
fi

log "режим: $MODE$( [ "$DRY_RUN" = "1" ] && echo " (dry-run)" )"
[ "$MODE" = "prune" ] || { log "деплой в $APP_DIR"; cd "$APP_DIR"; }
if [ -f "$COMPOSE_FILE" ]; then
  log "изменённые файлы в $APP_DIR: $(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
fi

case "$MODE" in
  image)
    if [ -z "$IMAGE_REF" ]; then
      log "для MODE=image нужен IMAGE_REF"
      exit 2
    fi
    log "скачиваю образ $IMAGE_REF"
    if ! run docker pull "$IMAGE_REF"; then
      log "образ не скачался. У приватного образа GHCR нужен однократный вход на этой ВМ:"
      log "  docker login ghcr.io -u <логин GitHub> -p <токен с правом read:packages>"
      exit 3
    fi
    # Compose берёт образ из WEBNESTDEV_IMAGE, а --no-build запрещает собирать на месте.
    export WEBNESTDEV_IMAGE="$IMAGE_REF"
    run docker compose -f "$COMPOSE_FILE" up -d --no-build "$SERVICE"
    ;;
  source)
    log "обновляю репозиторий до origin/$GIT_BRANCH"
    run git fetch --prune origin
    run git checkout "$GIT_BRANCH"
    # Только fast-forward: локальные правки на ВМ не должны молча исчезнуть.
    run git pull --ff-only origin "$GIT_BRANCH"
    log "ставлю зависимости и собираю фронтенд с сервером"
    run npm ci
    run npm run build
    log "перезапускаю сервис systemd: $SYSTEMD_UNIT"
    run sudo systemctl restart "$SYSTEMD_UNIT"
    ;;
  prune)
    log "режим prune: только уборка образов, сервис не трогаю"
    prune_images
    log "уборка завершена"
    exit 0
    ;;
  *)
    log "неизвестный MODE=$MODE (ожидается image, source или prune)"
    exit 2
    ;;
esac

wait_for_health
log "деплой завершён"
# Уборка после успешной выкатки, а не до неё: если сервис не поднялся, предыдущий образ
# остаётся на месте и можно сразу откатиться на него без сборки.
prune_images
