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
#   DRY_RUN=1                  показать шаги, ничего не меняя
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

log(){ printf '[deploy] %s\n' "$*"; }
run(){ if [ "$DRY_RUN" = "1" ]; then log "dry-run: $*"; else "$@"; fi; }

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
  log "каталог развёртывания не найден: $APP_DIR"
  exit 2
fi

log "деплой в $APP_DIR, режим: $MODE$( [ "$DRY_RUN" = "1" ] && echo " (dry-run)" )"
cd "$APP_DIR"
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
  *)
    log "неизвестный MODE=$MODE (ожидается image или source)"
    exit 2
    ;;
esac

wait_for_health
log "деплой завершён"
