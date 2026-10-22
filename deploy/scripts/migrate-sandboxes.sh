#!/usr/bin/env bash
#
# Разовая миграция файлов проектов. Раньше песочницы лежали в именованном томе
# (webnestdev-data:/app/.webnestdev), и docker run -v из контейнеров проектов видел пустой
# каталог на хосте. Теперь каталог песочниц монтируется с хоста (SANDBOX_DIR), поэтому файлы
# уже созданных проектов нужно один раз перенести из тома.
#
# Запуск НА ВМ из каталога развёртывания (там же, где .env и docker-compose.yml):
#   SANDBOX_DIR=$HOME/webnestdev/sandboxes bash migrate-sandboxes.sh
set -euo pipefail

SANDBOX_DIR="${SANDBOX_DIR:-$HOME/webnestdev/sandboxes}"
PROJECT="${COMPOSE_PROJECT_NAME:-$(basename "$PWD")}"
VOLUME="${VOLUME:-${PROJECT}_webnestdev-data}"

if ! docker volume inspect "$VOLUME" >/dev/null 2>&1; then
  echo "том $VOLUME не найден — миграция не нужна"
  exit 0
fi

mkdir -p "$SANDBOX_DIR"
echo "переношу $VOLUME -> $SANDBOX_DIR"
# Образ берётся тот же, что уже есть для песочниц, чтобы не тянуть лишний в ВМ.
docker run --rm -v "$VOLUME:/from:ro" -v "$SANDBOX_DIR:/to" "${SANDBOX_IMAGE:-node:22-bookworm}" \
  sh -c 'if [ -d /from/sandboxes ]; then cp -a /from/sandboxes/. /to/; echo "файлов: $(find /to -type f | wc -l)"; else echo "в томе нет каталога sandboxes"; fi'
echo "готово: $SANDBOX_DIR"
