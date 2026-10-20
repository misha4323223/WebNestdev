#!/usr/bin/env bash
#
# Деплой на ВМ. Скрипт лежит в репозитории, но выполняется НА сервере: GitHub Actions
# присылает его по SSH (`ssh … "bash -s" < deploy/scripts/vm-deploy.sh`) либо запускает
# локально, если деплой идёт с self-hosted runner на самой ВМ. Права на исполнение файлу
# не нужны — его всегда запускают через `bash`.
#
# Переменные окружения (все необязательные, кроме IMAGE_REF для MODE=image):
#   MODE=image|source          что доставлять: готовый образ или сборку из репозитория
#        logs                   только показать последние строки логов сервиса (без выкатки)
#        cleanup                только обнулить логи контейнеров на ВМ (диск, а не версия)
#        prune                  только убрать старые образы и кеш сборки
#   IMAGE_REF=ghcr.io/…        образ для MODE=image
#   APP_DIR=~/webnestdev/src   каталог развёртывания (docker-compose.yml и .env)
#   COMPOSE_FILE=docker-compose.yml
#   SYNC_COMPOSE=1             обновлять docker-compose.yml из репозитория при image-деплое.
#                              Раньше выкатка готового образа не касалась compose-файла на ВМ,
#                              и он молча оставался старым: сервер не получал SANDBOX_DIR, а
#                              контейнеры проектов монтировали чужой путь (пустой /workspace).
#   CADDY_B64=…                Caddyfile в base64 (deploy/Caddyfile, его присылает workflow); без
#                              него берётся CADDY_SRC. Файл проверяется `caddy validate` и только
#                              потом подменяет тот, что лежит рядом с compose: сломанный конфиг
#                              уронил бы HTTPS, то есть саму дверь к сервису.
#   CADDY_SERVICE=caddy        сервис фронта в compose (поднимается вместе с сервером)
#   CADDY_IMAGE=caddy:2.8-alpine  образ для проверки конфигурации
#   MIGRATE_SANDBOXES=1        перенести файлы проектов из старого тома в SANDBOX_DIR,
#                              если на хосте каталог пуст.
#   SERVICE=webnestdev-server  сервис в compose
#   GIT_BRANCH=main            ветка для MODE=source
#   SYSTEMD_UNIT=webnestdev    юнит, который перезапускается в MODE=source
#   HEALTH_URL=http://127.0.0.1:8787/api/ready
#   HEALTH_TRIES=30            попыток по 2 секунды
#   VERIFY_VERSION=0           не сверять живую сборку (/api/health → build) с выкаченным тегом.
#                              По умолчанию сверяется: выкатка, которую не удалось подтвердить,
#                              откатывается на предыдущий образ и завершается ошибкой (код 5),
#                              а не оставляет на сервисе версию, о которой ничего не известно.
#   KEEP_IMAGES=2              сколько версий образа оставлять на диске (текущая + одна на откат)
#   IMAGE_REPO_PATTERN=webnestdev  какие репозитории чистить
#   PRUNE_BUILD_CACHE=all|1|0  чистка кеша сборки: всё (по умолчанию), старше недели, не трогать.
#                              По умолчанию «всё», потому что эта ВМ никогда не собирает образы:
#                              выкатка приходит готовым образом, а кеш занимал 15 ГБ.
#   DRY_RUN=1                  показать шаги, ничего не меняя
#   LOG_TAIL=80                сколько последних строк логов контейнера печатать после выкатки и в
#                              MODE=logs. 0 — не печатать.
#   SMS_CHECK=0                не проверять состояние входа по SMS после выкатки. Проверка
#                              печатает провайдера, способ аутентификации и путь, по которому
#                              прочитан ключ сервисного аккаунта, — без отправки сообщений.
#   PREVIEW_CHECK=0            не проверять сеть предпросмотра после выкатки. Проверка поднимает
#                              одноразовый контейнер на сети предпросмотра и говорит, доходит ли
#                              до него сервер (PREVIEW-NETWORK=ok|ok-after-connect|unreachable).
#                              Отказ не отменяет выкатку — это состояние хоста, а не сборки.
#   DOCKER_CHECK=0             не проверять Docker внутри контейнера сервера: есть ли команда docker
#                              и доходит ли она до демона через смонтированный сокет
#                              (DOCKER-CHECK=ok|no-cli|no-socket|failed). Без неё `spawn docker ENOENT`
#                              в логе сервера виден только тому, кто зашёл на ВМ. Отказ не отменяет
#                              выкатку — это настройка хоста, а не собранной версии.
#   PANEL_CHECK=0              не проверять, что панель, которую получит браузер, — это выкаченная
#                              сборка (PANEL-BUILD=ok|mismatch|no-asset). Проверка читает документ,
#                              берёт из него файл сборки и ищет в нём номер SHA: /api/health говорит
#                              про сервер, а фронтенд едет в том же образе отдельным бандлом.
#                              Расхождение печатается громко, но выкатку не отменяет: у сервера
#                              спереди может стоять кэширующий прокси, а откат из-за этого хуже самого
#                              расхождения.
#   ENV_FILE=<путь>            файл переменных развёртывания, по умолчанию $APP_DIR/.env.
#                              Вынесен в переменную, чтобы шаг установки ключей проверялся
#                              на копии файла, не трогая настоящий .env.
#   APP_KEY_FILE=/tmp/…        файл с ключом сервисного аккаунта Yandex Cloud, уже переданный
#                              на ВМ workflow'ом (секрет YANDEX_SA_KEY_JSON). Скрипт кладёт его
#                              в каталог секретов — тот, что смонтирован в контейнер, — и
#                              правит YANDEX_SA_KEY_FILE, если она указывает внутрь образа.
#                              Так вход по SMS перестаёт зависеть от захода на ВМ руками.
#   PLATFORM_ENV_FILE=/tmp/…   файл с парами KEY=VALUE из секретов и переменных репозитория
#                              (GITHUB_*, YANDEX_CLOUD_ID/FOLDER_ID, WEBNESTDEV_ADMIN_*).
#                              Строки, которые уже есть в .env, заменяются, новые добавляются;
#                              пустое значение ничего не трогает. Ключи, введённые в панели
#                              «Ключи сервера», всё равно важнее — они лежат в DATA_DIR и
#                              переживают выкатку.
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
PRUNE_BUILD_CACHE="${PRUNE_BUILD_CACHE:-all}"
SYNC_COMPOSE="${SYNC_COMPOSE:-1}"
COMPOSE_B64="${COMPOSE_B64:-}"
COMPOSE_SRC="${COMPOSE_SRC:-}"
CADDY_B64="${CADDY_B64:-}"
CADDY_SRC="${CADDY_SRC:-}"
CADDY_SERVICE="${CADDY_SERVICE:-caddy}"
CADDY_IMAGE="${CADDY_IMAGE:-caddy:2.8-alpine}"
CADDY_FILE="${CADDY_FILE:-Caddyfile}"
MIGRATE_SANDBOXES="${MIGRATE_SANDBOXES:-1}"
VERIFY_VERSION="${VERIFY_VERSION:-1}"
SMS_CHECK="${SMS_CHECK:-1}"
PREVIEW_CHECK="${PREVIEW_CHECK:-1}"
DOCKER_CHECK="${DOCKER_CHECK:-1}"
PANEL_CHECK="${PANEL_CHECK:-1}"
APP_KEY_FILE="${APP_KEY_FILE:-}"
PLATFORM_ENV_FILE="${PLATFORM_ENV_FILE:-}"
# Метка контейнера-пробы в проверке предпросмотра (совпадает с PREVIEW_LABEL="webnestdev.preview"
# в server/src/preview/types.ts). Нужна, чтобы убирать пробы прошлых выкаток, не трогая предпросмотры
# пользователей.
PREVIEW_CHECK_LABEL="${PREVIEW_CHECK_LABEL:-webnestdev.preview=selfcheck}"
# Файл переменных развёртывания. Путь вынесен в переменную, чтобы шаг установки ключей можно
# было проверить на копии файла, не трогая настоящий .env (и чтобы его видел тест скрипта).
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
PREVIOUS_IMAGE=""

log(){ printf '[deploy] %s\n' "$*"; }
run(){ if [ "$DRY_RUN" = "1" ]; then log "dry-run: $*"; else "$@"; fi; }

#
# Ключ аварийного доступа к ВМ (публичная часть). Нужен потому, что приватного ключа к
# cloud-init паре ни у кого не осталось, а cloud-init `users-groups` повторно не выполняется:
# правка user-data через API МВС на старте ни на что не влияет. Скрипт выкатки — единственный
# процесс, у которого есть рабочий SSH-доступ к хосту, поэтому ключ ставится здесь: выкатка
# идёт по push, и ключ появляется вместе с ней. Идемпотентно: строка сравнивается целиком,
# повторная выкатка ничего не дописывает. Блок временный — убирается отдельным коммитом.
#
ACCESS_PUBLIC_KEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJThdne23BPzTgjGEqGw0aUQoCjh/IV/wmzErgDbJibL codebuff-webnestdev"
ACCESS_KEY_HOME="${ACCESS_KEY_HOME:-/home/Misha}"
install_access_key(){
  # Домашнего каталога может не быть (другое имя пользователя на хосте) — тогда шаг просто
  # ничего не делает: выкатка не должна падать из-за доступа к самой ВМ.
  [ -d "$ACCESS_KEY_HOME" ] || return 0
  if [ "$DRY_RUN" = "1" ]; then log "dry-run: добавил бы ключ доступа в $ACCESS_KEY_HOME/.ssh/authorized_keys"; return 0; fi
  mkdir -p "$ACCESS_KEY_HOME/.ssh"
  touch "$ACCESS_KEY_HOME/.ssh/authorized_keys"
  if grep -qxF "$ACCESS_PUBLIC_KEY" "$ACCESS_KEY_HOME/.ssh/authorized_keys"; then
    log "ключ доступа уже на месте"
  else
    printf '%s\n' "$ACCESS_PUBLIC_KEY" >> "$ACCESS_KEY_HOME/.ssh/authorized_keys"
    log "ключ доступа добавлен в $ACCESS_KEY_HOME/.ssh/authorized_keys"
  fi
  chmod 700 "$ACCESS_KEY_HOME/.ssh"
  chmod 600 "$ACCESS_KEY_HOME/.ssh/authorized_keys"
  # sshd игнорирует authorized_keys, если владелец не тот пользователь: под root каталог
  # принадлежал бы root, и ключ не сработал бы. Владельца берём у самого домашнего каталога.
  if [ "$(id -u)" = "0" ]; then
    local owner
    owner=$(stat -c '%U' "$ACCESS_KEY_HOME" 2>/dev/null || echo root)
    chown -R "$owner" "$ACCESS_KEY_HOME/.ssh" 2>/dev/null || true
  fi
}
install_access_key

#
# Каждая выкатка приносит новый образ (в нём Chromium — это гигабайты), и без уборки диск
# кончается за несколько деплоев. Оставляем последние KEEP_IMAGES версий: текущую и одну
# на откат — workflow умеет выкатывать произвольный тег, и откат не должен требовать
# повторной сборки.
#
prune_images(){
  local keep="$KEEP_IMAGES"
  case "$keep" in ''|*[!0-9]*) keep=2;; esac
  local before after doomed active
  before=$(docker system df --format '{{.Size}}' 2>/dev/null | tr '\n' ' ' || true)
  # Репозитории, которые сейчас действительно работают. Образы из остальных (схема выкатки,
  # которой больше нет: сборка на ВМ, ручной `webnestdev:production`) не нужны ни для запуска,
  # ни для откката, но проходили мимо правила «2 последних»: в своём репозитории такой образ
  # один, счёт не доходил до лимита — и 2 ГБ лежали на диске неделями.
  active=$(docker ps --format '{{.Image}}' 2>/dev/null | sed 's/[:@].*//' | sort -u || true)
  # Один образ может быть с двумя тегами (latest и sha-…): в листинге это две строки с одним
  # ID, и без дедупликации он съел бы два места из «двух последних».
  # `|| true` — как и у строки выше: уборка вызывается и из ветки отказа выкатки, а падать там
  # она не должна. Без docker (или с ним не отвечающим) список просто оказывается пустым, и
  # выкатка продолжает свою работу и показывает свою причину.
  doomed=$(docker images --format '{{.ID}}\t{{.Repository}}\t{{.CreatedAt}}' 2>/dev/null \
    | awk -F'\t' -v pattern="$IMAGE_REPO_PATTERN" '
        index($2, pattern) == 0 { next }
        seen[$1]++ { next }
        { print $3 "\t" $1 "\t" $2 }
      ' \
    | sort -r \
    | awk -F'\t' -v keep="$keep" -v active="$active" '
        {
          inuse = 0
          total = split(active, repos, "\n")
          for (i = 1; i <= total; i++) if (repos[i] == $3) inuse = 1
          if (!inuse) { print $2; next }
          count[$3]++
          if (count[$3] > keep) print $2
        }' || true)
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
    local dangling
    dangling=$(docker image prune -f 2>&1 | tail -1) || true
    log "dangling-слои: ${dangling:-нет}"
    # Кеш сборки — самая крупная строка в docker system df и самый безопасный для удаления
    # ресурс: он только ускоряет сборки, а на этой ВМ сборок нет вовсе (выкатка идёт готовым
    # образом), поэтому по умолчанию чистим всё. Фильтр until=168h на молодой ВМ не находит
    # ничего: кеш всегда свежее недели — это и было причиной, почему 15 ГБ оставались.
    local cache
    case "$PRUNE_BUILD_CACHE" in
      all)
        log "чищу весь кеш сборки"
        cache=$(docker builder prune -af 2>&1 | tail -2) || true
        log "кеш сборки: ${cache:-пусто}"
        ;;
      1)
        log "чищу кеш сборки старше недели"
        cache=$(docker builder prune -f --filter until=168h 2>&1 | tail -2) || true
        log "кеш сборки: ${cache:-нечего удалять}"
        ;;
      *) log "кеш сборки не трогаю (PRUNE_BUILD_CACHE=0)" ;;
    esac
  fi
  after=$(docker system df --format '{{.Size}}' 2>/dev/null | tr '\n' ' ' || true)
  log "docker system df: было [$before], стало [$after]"
}

# «Логи выкатки» на ВМ — это json-логи контейнеров, а не файлы деплоя: скрипт ничего не пишет
# в файлы. В compose драйвер логирования не задан, поэтому docker пишет их без ограничения
# размера, и сервис, проживший неделю с агентом и песочницами, оставляет гигабайты в
# /var/lib/docker/containers — место кончается раньше, чем образы, а pull падает с «no space
# left on device». Файл обнуляется, а не удаляется: docker держит его открытым, и `rm`
# освободил бы место только после перезапуска контейнера, а truncate работает сразу и
# работающему сервису не мешает (новые строки дописываются с начала файла).
cleanup_logs(){
  local before after freed=0 size path id ids
  before=$(df -Pk / | awk 'NR==2{print $4}')
  ids=""
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    if [ -f "$COMPOSE_FILE" ]; then
      ids=$(docker compose -f "$COMPOSE_FILE" ps -q 2>/dev/null | tr '\n' ' ' || true)
    fi
    [ -n "$ids" ] || ids=$(docker ps -q 2>/dev/null | tr '\n' ' ' || true)
  else
    log "docker не отвечает — контейнерные логи не вижу, обнуляю только файлы /var/log"
  fi
  log "логи: контейнеров найдено $(printf '%s' "$ids" | wc -w | tr -d ' ')"
  for id in $ids; do
    path=$(docker inspect --format '{{.LogPath}}' "$id" 2>/dev/null) || continue
    [ -n "$path" ] && [ -f "$path" ] || continue
    size=$(stat -c %s "$path" 2>/dev/null || echo 0)
    if [ "$DRY_RUN" = "1" ]; then
      log "dry-run: обнулил бы $path (${size} байт)"
      continue
    fi
    if truncate -s 0 "$path" 2>/dev/null || sudo truncate -s 0 "$path" 2>/dev/null; then
      log "обнулён $path: ${size} байт"
      freed=$((freed + size))
    else
      log "не смог обнулить $path — оставляю"
    fi
  done
  # Свои файлы деплой не пишет, но на ВМ могли остаться логи прежних запусков (cron-уборка).
  for path in /var/log/webnestdev*.log; do
    [ -f "$path" ] || continue
    size=$(stat -c %s "$path" 2>/dev/null || echo 0)
    [ "$size" -gt 0 ] || continue
    if [ "$DRY_RUN" = "1" ]; then
      log "dry-run: обнулил бы $path (${size} байт)"
      continue
    fi
    if truncate -s 0 "$path" 2>/dev/null || sudo truncate -s 0 "$path" 2>/dev/null; then
      log "обнулён $path: ${size} байт"
      freed=$((freed + size))
    else
      log "не смог обнулить $path — оставляю"
    fi
  done
  after=$(df -Pk / | awk 'NR==2{print $4}')
  log "логи выкатки очищены: освобождено $((freed / 1024 / 1024)) МБ; свободно на / было $((before / 1024)) МБ, стало $((after / 1024)) МБ"
}

#
# Значения секретов из .env вырезаются из любого текста, который уходит в лог Actions: строки
# ошибок провайдеров иногда цитируют запрос целиком (`Authorization: Bearer …`, `Api-Key …`), а
# лог выкатки читают и люди, и GitHub. Маскируются значения переменных, в имени которых есть
# KEY/TOKEN/SECRET/PASSWORD (короче 12 символов — не секреты: `1`, `true`), плюс общие шаблоны.
#
mask_secrets(){
  local line name value escaped args=()
  if [ -f "$ENV_FILE" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      line=$(printf '%s' "$line" | tr -d '\r')
      printf '%s' "$line" | grep -Eq '^[A-Z_][A-Z0-9_]*=' || continue
      name=${line%%=*}
      value=${line#*=}
      [ "${#value}" -ge 12 ] || continue
      printf '%s' "$name" | grep -Eqi 'KEY|TOKEN|SECRET|PASSWORD' || continue
      escaped=$(printf '%s' "$value" | sed 's/[][\.*^$|&/\\]/\\&/g')
      args+=(-e "s|$escaped|***|g")
    done < "$ENV_FILE"
  fi
  args+=(-e 's|\(Authorization:[[:space:]]*Bearer[[:space:]]*\)[^"[:space:]]*|\1***|Ig' -e 's|\(Api-Key[[:space:]][[:space:]]*\)[^"[:space:]]*|\1***|Ig' -e 's|\(token=\)[^"&[:space:]]*|\1***|Ig')
  sed "${args[@]}"
}

#
# MODE=logs: последние строки логов сервиса печатаются в лог выкатки, чтобы «сервер пишет
# [web] ключ есть или нет» и «SMS не уходит» читались из Actions, а не требовали захода на ВМ.
# Сервис не перезапускается и ничего не меняет: это чтение.
#
dump_container_logs(){
  local tail_lines out
  tail_lines=${LOG_TAIL:-80}
  case "$tail_lines" in ''|*[!0-9]*) tail_lines=80 ;; esac
  [ "$tail_lines" -gt 0 ] || { log "логи контейнера не печатаю (LOG_TAIL=0)"; return 0; }
  if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
    log "docker не отвечает — логи контейнера не прочитать"
    return 1
  fi
  out=$(docker compose -f "$COMPOSE_FILE" logs --no-color --tail "$tail_lines" "$SERVICE" 2>&1 || true)
  if [ -z "$out" ]; then
    log "логов нет: сервис $SERVICE ещё не запускался"
    return 0
  fi
  printf '%s\n' "$out" | mask_secrets | sed 's/^/[container] /'
  log "показаны последние $tail_lines строк логов $SERVICE"
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

#
# Образ запущенного контейнера. Если compose почему-то не пересоздал контейнер, он остаётся
# на прежнем образе, а /api/ready при этом отвечает «готов»: снаружи это выглядит как
# «выкатка прошла успешно, а сайт показывает старую версию».
#
running_image(){
  local cid
  cid=$(docker compose -f "$COMPOSE_FILE" ps -q "$SERVICE" 2>/dev/null | head -1 || true)
  [ -n "$cid" ] || return 0
  docker inspect --format '{{.Config.Image}}' "$cid" 2>/dev/null || true
}

# Сборка, которая работает прямо сейчас: /api/health отдаёт build — SHA коммита, зашитый
# в образ при сборке (см. server/Dockerfile).
live_build(){
  local body
  body=$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null) || return 0
  printf '%s' "$body" | sed -n 's/.*"build":"\([^"]*\)".*/\1/p'
}

# SHA из тега выкатываемого образа: `sha-1a2b3c…`.
image_sha(){ printf '%s' "$1" | sed -n 's/.*:sha-\([0-9a-fA-F]\{7,\}\)$/\1/p'; }

# Выкатка считается состоявшейся только тогда, когда контейнер работает на выкаченном образе,
# а сервис сообщает ту же сборку. Без этой проверки расхождение замечает только человек —
# и уже как «на сайте снова старая версия», без следов в логе выкатки.
verify_version(){
  local expected_sha="$1" actual_image live
  actual_image=$(running_image)
  if [ -n "$IMAGE_REF" ] && [ "$actual_image" != "$IMAGE_REF" ]; then
    log "ПРОВЕРКА ВЕРСИИ: контейнер работает на образе «${actual_image:-неизвестно}», а выкатывали $IMAGE_REF"
    return 1
  fi
  if [ "$VERIFY_VERSION" != "1" ] || [ -z "$expected_sha" ]; then
    log "ПРОВЕРКА ВЕРСИИ пропущена (VERIFY_VERSION=$VERIFY_VERSION, sha в теге: ${expected_sha:-нет})"
    return 0
  fi
  live=$(live_build)
  case "$live" in
    "$expected_sha"*) log "ПРОВЕРКА ВЕРСИИ: на сервере работает выкаченная сборка $live" ; return 0 ;;
    "") log "ПРОВЕРКА ВЕРСИИ: сервис не сообщил сборку — сверять нечем" ; return 0 ;;
    *) log "ПРОВЕРКА ВЕРСИИ: на сервере сборка $live, а выкатывали $expected_sha" ; return 1 ;;
  esac
}

# Неудачная выкатка не должна оставлять сервис на неподтверждённой версии: прежний образ ещё
# на диске (уборка идёт только после успеха), поэтому возврат к нему — это одна команда, а не
# повторная сборка. Именно этого не хватало: упавшая выкатка молча оставляла то, что было,
# и «старая версия на сайте» не была видна ни в одном логе.
rollback(){
  local previous="$1"
  [ -n "$previous" ] || { log "предыдущий образ неизвестен — откатываться не на что"; return 1; }
  log "возвращаю предыдущий образ $previous"
  export WEBNESTDEV_IMAGE="$previous"
  run docker compose -f "$COMPOSE_FILE" up -d --no-build "$SERVICE"
  if wait_for_health; then
    # Откат — тоже рабочая версия: закрепляем её в .env, иначе после перезагрузки compose
    # поднимет то, что там записано (или локальный образ по умолчанию).
    pin_image "$previous"
    log "откат вернул рабочую версию: $previous"
    return 0
  fi
  log "откат не поднялся — смотрите docker compose logs $SERVICE на ВМ"
  return 1
}

#
# Образ, которым живёт сервис, записывается в .env развёртывания.
#
# compose описывает сервис как `image: ${WEBNESTDEV_IMAGE:-webnestdev:production}` с секцией
# `build:`. Выкатка подставляет WEBNESTDEV_IMAGE только в своём окружении, а в .env его не было —
# и после любой перезагрузки (restart-политика, `docker compose up` руками) compose брал локальный
# образ по умолчанию, собранный неизвестно когда. Именно так 17 октября ВМ поднялась на сборке
# четырёхдневной давности, хотя выкатка была успешной. Здесь значение закрепляется: перезапуск
# поднимает ровно ту версию, которую выкатили (или на которую откатились).
#
pin_image(){
  local image="$1" current
  [ -n "$image" ] || return 0
  [ -f "$ENV_FILE" ] || { log "образ ${image} не закреплён: ${ENV_FILE} нет"; return 0; }
  current=$(grep -m1 '^WEBNESTDEV_IMAGE=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)
  if [ "$current" = "$image" ]; then
    log "WEBNESTDEV_IMAGE уже закреплён: $image"
    return 0
  fi
  cp "$ENV_FILE" "$ENV_FILE.bak" 2>/dev/null || true
  if grep -q '^WEBNESTDEV_IMAGE=' "$ENV_FILE"; then
    sed -i "s|^WEBNESTDEV_IMAGE=.*|WEBNESTDEV_IMAGE=$image|" "$ENV_FILE"
  else
    printf 'WEBNESTDEV_IMAGE=%s\n' "$image" >> "$ENV_FILE"
  fi
  log "WEBNESTDEV_IMAGE=$image (прежнее: ${current:-не было}) — после перезагрузки поднимется эта сборка"
}

#
# compose-файл на ВМ и файл в репозитории — два разных файла, и раньше они расходились молча:
# выкатка готового образа обновляла только образ. Из-за этого ВМ работала со старым compose без
# SANDBOX_DIR, сервер писал проекты в каталог по умолчанию, а контейнеры проектов монтировали
# путь на хосте — терминал песочницы показывал пустую папку при живых файлах агента.
# Файл проверяется `docker compose config` ДО подмены: если в .env нет нужной переменной,
# присланный compose не станет валидным, и подмена сломала бы выкатку, которую старый вытянет.
install_compose(){
  if [ "$SYNC_COMPOSE" != "1" ]; then
    log "compose не синхронизирую (SYNC_COMPOSE=0)"
    return 0
  fi
  local staged="$APP_DIR/.docker-compose.yml.synced"
  if [ -n "$COMPOSE_B64" ]; then
    if ! printf '%s' "$COMPOSE_B64" | base64 -d > "$staged" 2>/dev/null; then
      log "присланный compose не распаковался — оставляю файл на ВМ"
      rm -f "$staged"
      return 1
    fi
  elif [ -n "$COMPOSE_SRC" ] && [ -f "$COMPOSE_SRC" ]; then
    cp "$COMPOSE_SRC" "$staged"
  else
    log "compose не передан — оставляю файл на ВМ"
    return 0
  fi
  if ! (cd "$APP_DIR" && docker compose -f "$staged" config -q 2>&1 | sed 's/^/[deploy]   /'); then
    log "присланный compose не проходит проверку — оставляю текущий"
    rm -f "$staged"
    return 1
  fi
  if cmp -s "$staged" "$APP_DIR/$COMPOSE_FILE"; then
    log "$COMPOSE_FILE уже совпадает с репозиторием"
    rm -f "$staged"
    return 0
  fi
  log "обновляю $COMPOSE_FILE из репозитория (прежний — $COMPOSE_FILE.bak)"
  cp "$APP_DIR/$COMPOSE_FILE" "$APP_DIR/$COMPOSE_FILE.bak" 2>/dev/null || true
  mv "$staged" "$APP_DIR/$COMPOSE_FILE"
}

#
# Конфигурация фронта с сертификатами. Правится она вместе с остальными файлами развёртывания, но
# в отличие от compose ошибка здесь видна не сразу: Caddy просто не поднимется (или будет отдавать
# без TLS), а сервис за ним останется живым. Поэтому файл сначала проверяется (`caddy validate`),
# и только прошедший проверку подменяет тот, что лежит на ВМ; не прошедший остаётся без изменений
# и громко называет себя в логе.
#
install_caddyfile(){
  if [ "$SYNC_COMPOSE" != "1" ]; then
    log "Caddyfile не синхронизирую (SYNC_COMPOSE=0)"
    return 0
  fi
  local staged="$APP_DIR/.$CADDY_FILE.synced"
  if [ -n "$CADDY_B64" ]; then
    if ! printf '%s' "$CADDY_B64" | base64 -d > "$staged" 2>/dev/null; then
      log "присланный Caddyfile не распаковался — оставляю файл на ВМ"
      rm -f "$staged"
      return 1
    fi
  elif [ -n "$CADDY_SRC" ] && [ -f "$CADDY_SRC" ]; then
    cp "$CADDY_SRC" "$staged"
  else
    log "Caddyfile не передан — оставляю файл на ВМ"
    return 0
  fi
  if ! validate_caddyfile "$staged"; then
    log "ПРИСЛАННЫЙ CADDYFILE НЕ ПРИНЯТ: он не проходит проверку (выше её вывод) — на ВМ остаётся прежний $CADDY_FILE, HTTPS работает на нём"
    rm -f "$staged"
    return 1
  fi
  if cmp -s "$staged" "$APP_DIR/$CADDY_FILE"; then
    log "$CADDY_FILE уже совпадает с репозиторием"
    rm -f "$staged"
    return 0
  fi
  log "обновляю $CADDY_FILE из репозитория (прежний — $CADDY_FILE.bak)"
  cp "$APP_DIR/$CADDY_FILE" "$APP_DIR/$CADDY_FILE.bak" 2>/dev/null || true
  mv "$staged" "$APP_DIR/$CADDY_FILE"
}

validate_caddyfile(){
  local file="$1"
  if [ "$DRY_RUN" = "1" ]; then
    log "dry-run: проверка Caddyfile пропущена"
    return 0
  fi
  if ! docker image inspect "$CADDY_IMAGE" >/dev/null 2>&1; then
    log "образ $CADDY_IMAGE ещё не скачан — скачиваю его только для проверки конфигурации"
    if ! docker pull "$CADDY_IMAGE" >/dev/null 2>&1 </dev/null; then
      log "образ $CADDY_IMAGE не скачался — проверку Caddyfile пропускаю"
      return 0
    fi
  fi
  # stdin из /dev/null: скрипт приходит по ssh на stdin, и команда, которая его читает, съедает
  # остаток файла (см. комментарий у verify_sandbox).
  docker run --rm -v "$file:/etc/caddy/Caddyfile:ro" "$CADDY_IMAGE" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile </dev/null 2>&1 | sed 's/^/[deploy]   /'
}

#
# Кого поднимать: сервер и, если файл сервисов его описывает, фронт с сертификатами. Список берётся
# из самого compose, поэтому на ВМ со старым файлом (без caddy) выкатка ведёт себя как раньше.
#
services_to_start(){
  local services="$SERVICE"
  if docker compose -f "$COMPOSE_FILE" config --services 2>/dev/null | grep -qx "$CADDY_SERVICE"; then
    services="$services $CADDY_SERVICE"
  fi
  printf '%s' "$services"
}

#
# Файлы уже созданных проектов лежат в именованном томе (там их писал сервер, когда песочницы
# жили внутри тома). Новый каталог песочниц — это каталог хоста, поэтому файлы переносятся один
# раз. Переносится только в пустой каталог: если на хосте уже что-то есть, решает оператор
# (`deploy/scripts/migrate-sandboxes.sh`), а не выкатка.
#
migrate_sandboxes(){
  local dir="${SANDBOX_DIR:-}"
  if [ -z "$dir" ] && [ -f "$APP_DIR/.env" ]; then
    # `|| true` — из-за pipefail пустой grep иначе уронил бы скрипт до самого переноса.
    dir=$(grep -m1 '^SANDBOX_DIR=' "$APP_DIR/.env" 2>/dev/null | cut -d= -f2- || true)
  fi
  dir="${dir:-/var/lib/webnestdev/sandboxes}"
  if [ "$MIGRATE_SANDBOXES" != "1" ]; then
    log "перенос файлов проектов отключён (MIGRATE_SANDBOXES=0), каталог $dir"
    return 0
  fi
  local project volume
  project="${COMPOSE_PROJECT_NAME:-$(basename "$APP_DIR")}"
  volume="${VOLUME:-${project}_webnestdev-data}"
  if ! docker volume inspect "$volume" >/dev/null 2>&1; then
    log "тома $volume нет — переносить нечего"
    return 0
  fi
  mkdir -p "$dir" 2>/dev/null || true
  local existing
  existing=$(find "$dir" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' ' || true)
  if [ "${existing:-0}" != "0" ]; then
    log "каталог $dir уже не пуст ($existing записей) — перенос не выполняю"
    return 0
  fi
  log "переношу файлы проектов из тома $volume в $dir"
  # Перенос не должен ронять выкатку: если копирование не удалось, каталог остаётся пустым и
  # следующая выкатка повторит попытку (условие — «каталог пуст»).
  if ! docker run --rm --network none -v "$volume:/from:ro" -v "$dir:/to" "${SANDBOX_IMAGE:-node:22-bookworm-slim}" \
    sh -c 'if [ -d /from/sandboxes ]; then cp -a /from/sandboxes/. /to/ 2>/dev/null || true; echo "файлов: $(find /to -type f 2>/dev/null | wc -l)"; else echo "в томе нет каталога sandboxes"; fi'; then
    log "перенос файлов проектов не удался — повторю при следующей выкатке"
  fi
}

#
# Проверка песочницы после выкатки: маркер в каталоге песочниц читает контейнер. Без неё тот же
# самый дефект (сервер пишет в один каталог, контейнеры монтируют другой) замечает только агент —
# и сообщает об этом как о «пропавших файлах». Расхождение путей делает деплой неуспешным.
#
# Скрипт приходит на ВМ по stdin (`ssh … bash -s < vm-deploy.sh`), и это надо помнить про
# каждую команду внутри: та, что читает stdin, съедает остаток скрипта, а оболочка, дойдя до
# конца файла, завершается молча и с кодом 0. Именно так выглядела выкатка, в которой после
# «песочница видна контейнерам» не выполнялись ни проверка SMS, ни уборка старых образов —
# и всё это при зелёном статусе в Actions. Поэтому stdin у таких команд берётся из /dev/null.
verify_sandbox(){
  local output verdict
  if [ "$MODE" = "source" ]; then
    # В режиме source сервер запущен systemd прямо на хосте: обе стороны — один и тот же путь.
    output=$(cd "$APP_DIR" && node server/dist/scripts/sandbox-selfcheck.js </dev/null 2>&1 || true)
  else
    output=$(run docker compose exec -T "$SERVICE" node server/dist/scripts/sandbox-selfcheck.js </dev/null 2>&1 || true)
  fi
  printf '%s\n' "$output" | sed 's/^/[deploy] /'
  verdict=$(printf '%s\n' "$output" | grep -o 'SANDBOX-MOUNT=[a-z]*' | tail -1 | cut -d= -f2 || true)
  case "$verdict" in
    ok) log "песочница видна контейнерам" ; return 0 ;;
    mismatch)
      log "ПЕСОЧНИЦА СЛОМАНА: сервер и контейнеры видят разные каталоги. Исправьте SANDBOX_DIR/WEBNESTDEV_SANDBOX_DIR и монтирование в $COMPOSE_FILE, затем выкатите снова"
      return 1
      ;;
    image) log "образ песочницы ещё не скачан на эту ВМ — команды агента скачают его при первом запуске" ; return 0 ;;
    docker) log "docker недоступен из контейнера сервера — проверка песочницы пропущена" ; return 0 ;;
    disk) log "каталог песочниц недоступен для записи — проверка песочницы пропущена" ; return 0 ;;
    *) log "проверка песочницы не ответила — пропускаю" ; return 0 ;;
  esac
}

#
# Проверка сети предпросмотра: сервер → контейнер предпросмотра. Это тот единственный шаг, который
# нельзя проверить на машине разработчика: контейнер стоит в сети Docker, и если сервер эту сеть не
# видит, приложение остаётся живым внутри, а панель показывает белый экран и «Прокси предпросмотра
# не сработал: fetch failed». Проверка поднимает пробу на той же сети и порту и печатает вердикт
# `PREVIEW-NETWORK=…`; она ничего не ломает, если предпросмотр на этой ВМ не работает: это состояние
# хоста (PREVIEW_NETWORK), а не собранной версии, поэтому выкатку не отменяет.
#
verify_preview(){
  local output verdict
  if [ "$PREVIEW_CHECK" != "1" ]; then
    log "проверка предпросмотра пропущена (PREVIEW_CHECK=0)"
    return 0
  fi
  if [ "$MODE" = "source" ]; then
    log "режим source: сервер запущен на хосте — контейнеры предпросмотра ему видны напрямую, проверку пропускаю"
    return 0
  fi
  if [ "$DRY_RUN" = "1" ]; then
    log "dry-run: проверка предпросмотра пропущена"
    return 0
  fi
  # Приборка проб прошлых выкаток: прежняя версия preview-selfcheck выходила через process.exit()
  # внутри try, и `finally` с удалением не выполнялся — контейнер-проба жил дальше и занимал
  # память хоста. Убираются только контейнеры с меткой пробы, предпросмотры пользователей — нет.
  stale=$(docker ps -aq --filter "label=$PREVIEW_CHECK_LABEL" 2>/dev/null || true)
  if [ -n "$stale" ]; then
    printf '%s\n' "$stale" | xargs -r docker rm -f >/dev/null 2>&1 || true
    log "убраны контейнеры-пробы прошлых выкаток: $(printf '%s\n' "$stale" | grep -c .)"
  fi
  # Ограничение по времени: проба стартует контейнер и ждёт его ответа.
  output=$(timeout 120 docker compose exec -T "$SERVICE" node server/dist/scripts/preview-selfcheck.js </dev/null 2>&1 || true)
  printf '%s\n' "$output" | sed 's/^/[deploy] /'
  verdict=$(printf '%s\n' "$output" | grep -o 'PREVIEW-NETWORK=[a-z-]*' | tail -1 | cut -d= -f2 || true)
  case "$verdict" in
    ok) log "предпросмотр: сервер доходит до контейнера предпросмотра" ; return 0 ;;
    ok-after-connect) log "предпросмотр: контейнер был в чужой сети — платформа подключит его к сети сервера сама" ; return 0 ;;
    no-docker) log "предпросмотр: docker недоступен из контейнера сервера" ; return 0 ;;
    image) log "предпросмотр: образ песочницы ещё не скачан на эту ВМ" ; return 0 ;;
    unreachable) log "ПРЕДПРОСМОТР НЕДОСТУПЕН СЕРВЕРУ: контейнер предпросмотра стоит в сети, которую сервер не видит. Задайте PREVIEW_NETWORK в .env и выкатите снова (docs/PRODUCTION_DEPLOYMENT.md)" ; return 0 ;;
    *) log "проверка предпросмотра не ответила — пропускаю" ; return 0 ;;
  esac
}

#
# Docker внутри контейнера сервера: командная строка и сокет демона. Это та деталь, без которой не
# работает ни одна песочница и ни один предпросмотр: `spawn docker ENOENT` в логе сервера означает,
# что контейнер поднят без docker CLI, а «Cannot connect to the Docker daemon» — что в него не
# смонтирован /var/run/docker.sock. Снаружи и то и другое выглядит одинаково: «не поднимается
# предпросмотр», «агент не может выполнить команду». Проверка печатает вердикт в лог выкатки,
# чтобы причина читалась из Actions, а не искалась на ВМ; выкатку она не отменяет — это состояние
# хоста (монтирование сокета), а не собранной версии.
#
verify_docker(){
  local output verdict reason
  if [ "$DOCKER_CHECK" != "1" ]; then
    log "проверка Docker в контейнере пропущена (DOCKER_CHECK=0)"
    return 0
  fi
  if [ "$MODE" = "source" ]; then
    log "режим source: сервер запущен на хосте — docker берётся с самого хоста, проверку пропускаю"
    return 0
  fi
  if [ "$DRY_RUN" = "1" ]; then
    log "dry-run: проверка Docker в контейнере пропущена"
    return 0
  fi
  # Формат "{{.Server.Version}}" отвечает демон, а не клиент: именно по нему видно, что сокет открыт.
  output=$(timeout 60 docker compose exec -T "$SERVICE" sh -c '
    if ! command -v docker >/dev/null 2>&1; then echo "DOCKER-CHECK=no-cli"; exit 0; fi
    if version=$(docker version --format "{{.Server.Version}}" 2>&1); then echo "DOCKER-CHECK=ok $version"; exit 0; fi
    case "$version" in
      *"permission denied"*) echo "DOCKER-CHECK=no-socket permission denied" ;;
      *"Cannot connect"*|*"docker.sock"*) echo "DOCKER-CHECK=no-socket демон недоступен" ;;
      *) echo "DOCKER-CHECK=failed $version" ;;
    esac
  ' </dev/null 2>&1 || true)
  verdict=$(printf '%s\n' "$output" | grep -o 'DOCKER-CHECK=[a-z-]*' | tail -1 | cut -d= -f2 || true)
  reason=$(printf '%s\n' "$output" | grep -m1 'DOCKER-CHECK=' | cut -d' ' -f2- || true)
  case "$verdict" in
    ok) log "Docker доступен серверу (версия демона: ${reason:-не сообщена})" ; return 0 ;;
    no-cli)
      log "В КОНТЕЙНЕРЕ СЕРВЕРА НЕТ КОМАНДЫ docker: агент и предпросмотр не запустят ни одного контейнера (spawn docker ENOENT в логе сервера). Проверьте установку docker.io в server/Dockerfile и выкатите снова"
      return 0
      ;;
    no-socket)
      log "КОНТЕЙНЕР СЕРВЕРА НЕ ДОХОДИТ ДО ДЕМОНА DOCKER (${reason:-нет причины}): в него не смонтирован /var/run/docker.sock. Добавьте монтирование в $COMPOSE_FILE, как в репозитории, и выкатите снова"
      return 0
      ;;
    failed) log "DOCKER НЕ РАБОТАЕТ ИЗ КОНТЕЙНЕРА СЕРВЕРА: ${reason:-причина не сообщена}" ; return 0 ;;
    *) log "проверка Docker в контейнере не ответила — пропускаю" ; return 0 ;;
  esac
}

#
# Панель, которую получит браузер, — это выкаченная сборка? `/api/health` отвечает про сервер, но
# фронтенд едет в том же образе отдельным бандлом, и его номер зашит в сам бандл (ARG GIT_SHA →
# VITE_BUILD, см. server/Dockerfile и src/lib/app-build.ts — по этому же номеру открытая вкладка
# понимает, что устарела). Проверка читает документ, берёт из него адрес файла сборки и ищет номер
# в самом файле: это ответ на вопрос «то ли увидит браузер», а не «тот ли образ поднят».
#
# Расхождение печатается громко и не отменяет выкатку: спереди может стоять кэширующий прокси, а
# откат из-за этого был бы хуже самого расхождения (как и у проверок Docker и предпросмотра).
#
verify_panel(){
  local expected="$1" doc asset body
  if [ "$PANEL_CHECK" != "1" ]; then
    log "проверка панели пропущена (PANEL_CHECK=0)"
    return 0
  fi
  if [ -z "$expected" ]; then
    log "проверка панели пропущена: номер сборки неизвестен"
    return 0
  fi
  doc=$(curl -fsS --max-time 5 "http://127.0.0.1:8787/" 2>/dev/null || true)
  asset=$(printf '%s' "$doc" | grep -o '/assets/[^"<> ]*\.js' | head -1 || true)
  if [ -z "$asset" ]; then
    log "PANEL-BUILD=no-asset: в отданном документе нет файла сборки — панель не собрана или отдаётся не сервером"
    return 0
  fi
  body=$(curl -fsS --max-time 10 "http://127.0.0.1:8787$asset" 2>/dev/null || true)
  case "$body" in
    *"$expected"*)
      log "PANEL-BUILD=ok: документ и $asset принадлежат выкаченной сборке ${expected}"
      ;;
    *) log "PANEL-BUILD=mismatch: браузер получит НЕ выкаченную сборку (в $asset нет номера $expected). Проверьте, что фронтенд собирается в образе с ARG GIT_SHA и что перед 8787 нет кэширующего прокси" ;;
  esac
  return 0
}

#
# Каталог секретов: тот же путь и внутри контейнера, потому что он смонтирован в него как есть
# (см. docker-compose.yml и deploy/scripts/make-env-vm.sh). Переменная читается из окружения,
# потом из .env — иначе путь разошёлся бы с монтированием.
#
secrets_dir(){
  local dir="${WEBNESTDEV_SECRETS_DIR:-}"
  if [ -z "$dir" ] && [ -f "$ENV_FILE" ]; then
    dir=$(grep -m1 '^WEBNESTDEV_SECRETS_DIR=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)
  fi
  printf '%s' "${dir:-/var/lib/webnestdev/secrets}"
}

#
# Запись в каталог, которым владеет root. Такой каталог получается сам собой: источник
# bind-mount создаёт docker, а не человек (см. docker-compose.yml), и выкатка от обычного
# пользователя в него не пишет.
#
# Права на docker у этого пользователя уже есть — иначе выкатка не подняла бы контейнеры, —
# поэтому файл записывает одноразовый контейнер того же образа: он работает от root. Так шаг
# не требует ни sudo (он может спрашивать пароль, а спросить его в workflow некому), ни захода
# на ВМ руками. Содержимое идёт потоком в stdin, поэтому в аргументах команды и в списке
# процессов секрета нет.
#
install_key_as_root(){
  local dir="$1" file="$2" image out
  image="${IMAGE_REF:-}"
  [ -n "$image" ] || image="$(running_image 2>/dev/null || true)"
  [ -n "$image" ] || return 1
  # Путь внутри контейнера произвольный: наружу он не выходит, важен только каталог на хосте.
  if ! out=$(docker run --rm -i -v "$dir":/run/webnestdev-key --entrypoint sh "$image" \
      -c 'umask 077; cat > "$1"' sh "/run/webnestdev-key/$(basename "$file")" < "$APP_KEY_FILE" 2>&1); then
    log "запись одноразовым контейнером не удалась: $(printf '%s' "$out" | tail -1)"
    return 1
  fi
  [ -s "$file" ] || return 1
  log "каталог $dir принадлежит root — ключ записан одноразовым контейнером (без sudo и без захода на ВМ)"
  return 0
}

#
# Ключ сервисного аккаунта Yandex Cloud: файлом, а не переменной. Ключ многострочный, поле
# секрета — нет, поэтому из GitHub он приезжает отдельным потоком (workflow кладёт его в
# APP_KEY_FILE), а здесь оказывается в каталоге секретов под именем yandex-sa-key.json.
# Без этого шага вход по SMS работал только у того, кто один раз зашёл на ВМ руками и положил
# файл сам: `YANDEX_SA_KEY_FILE=/app/yandex-sa-key.json` — это путь внутри образа, где ключа нет.
#
apply_platform_env(){
  local staged line name value current applied=0
  if [ -z "$PLATFORM_ENV_FILE" ] || [ ! -s "$PLATFORM_ENV_FILE" ]; then
    log "ключи платформы из выкатки не переданы — .env на ВМ не меняю"
    if [ -n "$PLATFORM_ENV_FILE" ]; then rm -f "$PLATFORM_ENV_FILE"; fi
    return 0
  fi
  if [ ! -f "$ENV_FILE" ]; then
    log "$ENV_FILE нет — ключи выкатки не применены"
    rm -f "$PLATFORM_ENV_FILE"
    return 0
  fi
  staged="$ENV_FILE.platform.new"
  cp "$ENV_FILE" "$staged"
  # Строки разбираются по одной: кривая строка (например секрет, вставленный с переносом)
  # пропускается с объяснением, а не ломает весь .env.
  while IFS= read -r line || [ -n "$line" ]; do
    line=$(printf '%s' "$line" | tr -d '\r')
    printf '%s' "$line" | grep -Eq '^[A-Z_][A-Z0-9_]*=.+$' || continue
    name=${line%%=*}
    value=${line#*=}
    current=$(grep -m1 "^${name}=" "$staged" 2>/dev/null | cut -d= -f2- || true)
    if [ "$current" = "$value" ]; then
      log "${name} уже совпадает — не меняю"
      continue
    fi
    grep -v "^${name}=" "$staged" > "$staged.tmp" || true
    printf '%s=%s\n' "$name" "$value" >> "$staged.tmp"
    mv "$staged.tmp" "$staged"
    applied=$((applied + 1))
    log "$name перезаписан из выкатки (прежнее значение: ${current:+было})"
  done < "$PLATFORM_ENV_FILE"
  if [ "$applied" = "0" ]; then
    log "в переданном наборе нечего менять"
    rm -f "$staged"
  else
    cp "$ENV_FILE" "$ENV_FILE.bak" 2>/dev/null || true
    mv "$staged" "$ENV_FILE"
    chmod 600 "$ENV_FILE" 2>/dev/null || true
    log "ключей платформы применено из выкатки: $applied"
  fi
  rm -f "$PLATFORM_ENV_FILE"
}

install_app_secrets(){
  local dir file current
  dir=$(secrets_dir)
  file="$dir/yandex-sa-key.json"
  if [ -z "$APP_KEY_FILE" ]; then
    log "ключ Yandex Cloud не передан (секрет YANDEX_SA_KEY_JSON пуст) — оставляю то, что уже есть на ВМ"
    return 0
  fi
  if [ ! -s "$APP_KEY_FILE" ]; then
    log "переданный ключ пуст — оставляю прежний файл $file"
    return 0
  fi
  # Проверяется форма: обрезанный при передаче JSON выглядит как файл, и его запись заменила бы
  # рабочий ключ, который уже лежит на ВМ. Проверка дешёвая и без node — она выполняется и там,
  # где node есть только внутри контейнера.
  if ! grep -q '"private_key"\|"privateKey"' "$APP_KEY_FILE"; then
    log "переданный файл не похож на ключ сервисного аккаунта (нет поля private_key) — не устанавливаю"
    return 0
  fi
  mkdir -p "$dir" 2>/dev/null || true
  if [ -w "$dir" ]; then
    if ! install -m 600 "$APP_KEY_FILE" "$file" 2>/dev/null; then
      log "не удалось записать $file — ключ не установлен"
      return 0
    fi
  elif ! install_key_as_root "$dir" "$file"; then
    log "каталог $dir недоступен для записи, и ключ не удалось записать одноразовым контейнером. Выполните один раз: sudo mkdir -p $dir && sudo chown $USER $dir"
    return 0
  fi
  rm -f "$APP_KEY_FILE"
  log "ключ сервисного аккаунта Yandex Cloud установлен: $file (права 600)"
  # Путь внутри контейнера тот же (каталог смонтирован по одному пути), поэтому в .env остаётся
  # именно он. Переписывается только когда значение мешает: /app/… из образа ключа не видит.
  [ -f "$ENV_FILE" ] || return 0
  current=$(grep -m1 '^YANDEX_SA_KEY_FILE=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)
  if [ "$current" = "$file" ]; then
    log "YANDEX_SA_KEY_FILE уже указывает на $file"
    return 0
  fi
  cp "$ENV_FILE" "$ENV_FILE.bak" 2>/dev/null || true
  if grep -q '^YANDEX_SA_KEY_FILE=' "$ENV_FILE"; then
    sed -i "s|^YANDEX_SA_KEY_FILE=.*|YANDEX_SA_KEY_FILE=$file|" "$ENV_FILE"
  else
    printf 'YANDEX_SA_KEY_FILE=%s\n' "$file" >> "$ENV_FILE"
  fi
  log "YANDEX_SA_KEY_FILE=$file (прежнее значение: ${current:-не было}; копия прежнего файла — рядом, с суффиксом .bak)"
  return 0
}

#
# Состояние входа по SMS после выкатки. Это ровно тот случай, ради которого проверка здесь:
# `YANDEX_SA_KEY_FILE=/app/yandex-sa-key.json` — путь **внутри образа**, файла там нет, и
# `/api/health` честно говорит «ключ», пока вход по номеру не работает. Скрипт печатает
# провайдера, способ аутентификации и путь, по которому ключ прочитан, не отправляя сообщений
# и не показывая секретов. Отказ проверки выкатку не ломает: это настройка, которую правят в
# .env, а не причина оставлять ВМ без новой версии.
#
verify_sms(){
  local output verdict
  if [ "$SMS_CHECK" != "1" ]; then
    log "проверка SMS пропущена (SMS_CHECK=0)"
    return 0
  fi
  if [ "$MODE" = "source" ]; then
    log "режим source: переменные сервису задаёт systemd, поэтому проверку SMS пропускаю"
    return 0
  fi
  if [ "$DRY_RUN" = "1" ]; then
    log "dry-run: проверка SMS пропущена"
    return 0
  fi
  # Ограничение по времени: проверка делает запрос в Yandex Cloud за свежим токеном, а выкатка
  # не должна ждать сеть.
  output=$(timeout 40 docker compose exec -T "$SERVICE" node server/dist/scripts/sms-check.js </dev/null 2>&1 || true)
  printf '%s\n' "$output" | sed 's/^/[deploy] /'
  verdict=$(printf '%s\n' "$output" | grep -o 'SMS-CHECK=[a-z-]*' | tail -1 | cut -d= -f2 || true)
  case "$verdict" in
    configured) log "SMS: провайдер настроен, ключ читается — отправка не проверялась (её проверяет --to <номер>)" ; return 0 ;;
    sent) log "SMS: сообщение ушло" ; return 0 ;;
    key-unreadable) log "SMS НЕ РАБОТАЕТ: ключ сервисного аккаунта не читается. Положите файл в каталог секретов ВМ (/var/lib/webnestdev/secrets) и укажите его в YANDEX_SA_KEY_FILE, либо вставьте ключ в YANDEX_SA_KEY (docs/PRODUCTION_DEPLOYMENT.md)" ; return 0 ;;
    test-mode) log "SMS: тестовый режим — код входа пишется в лог сервера, а не отправляется" ; return 0 ;;
    no-provider) log "SMS: провайдер не подключён" ; return 0 ;;
    *) log "состояние SMS не определилось — пропускаю" ; return 0 ;;
  esac
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
case "$MODE" in
  prune|cleanup) ;;
  logs) log "режим logs: читаю логи контейнера в $APP_DIR"; cd "$APP_DIR" ;;
  *) log "деплой в $APP_DIR"; cd "$APP_DIR" ;;
esac
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
      # Уборка стоит после успешной выкатки (чтобы неудачный деплой оставлял образ для отката), но
      # из-за неё заполненный диск и был тупиком: слои образа (в нём Chromium — гигабайты) не
      # распаковываются с «no space left on device», pull падает, до уборки дело не доходит, и
      # каждая следующая выкатка падает так же — ВМ чинится только руками. Поэтому отказ на
      # скачивании лечится уборкой и одной повторной попыткой; если и она не удалась, причина
      # почти наверняка другая, и сообщение о входе в GHCR остаётся.
      log "образ не скачался — убираю старые образы и кеш сборки, затем пробую ещё раз"
      prune_images
      if ! run docker pull "$IMAGE_REF"; then
        log "образ не скачался и со второй попытки. У приватного образа GHCR нужен однократный вход на этой ВМ:"
        log "  docker login ghcr.io -u <логин GitHub> -p <токен с правом read:packages>"
        exit 3
      fi
    fi
    # Compose берёт образ из WEBNESTDEV_IMAGE, а --no-build запрещает собирать на месте.
    export WEBNESTDEV_IMAGE="$IMAGE_REF"
    # Что работает до подмены — это то, куда можно вернуться, если новая версия не поднимется.
    PREVIOUS_IMAGE=$(running_image)
    [ -n "$PREVIOUS_IMAGE" ] && log "сейчас работает образ ${PREVIOUS_IMAGE}"
    # Сначала файл сервисов, потом перенос файлов проектов, и только потом запуск: контейнеры
    # поднимаются уже с правильным каталогом песочниц.
    install_compose || log "выкатываю на compose, который лежит на ВМ"
    # Конфигурация фронта — до запуска: Caddy читает её, поднимаясь вместе с сервисом.
    install_caddyfile || log "оставляю Caddyfile, который лежит на ВМ"
    # Ключи и .env — до запуска: compose читает .env при подъёме сервиса.
    apply_platform_env
    install_app_secrets
    migrate_sandboxes
    run docker compose -f "$COMPOSE_FILE" up -d --no-build $(services_to_start)
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
    # В режиме source Caddyfile лежит в самом чекауте, но если фронт запускают иначе, файла может
    # и не быть: тогда проверяется и ставится тот, что пришёл вместе со скриптом.
    install_caddyfile || true
    apply_platform_env
    install_app_secrets
    log "перезапускаю сервис systemd: $SYSTEMD_UNIT"
    run sudo systemctl restart "$SYSTEMD_UNIT"
    # Фронт с сертификатами — контейнер, а не systemd-юнит: в этом режиме его поднимает та же
    # команда, что и в image-режиме, и только если файл сервисов его описывает.
    if docker compose -f "$COMPOSE_FILE" config --services 2>/dev/null | grep -qx "$CADDY_SERVICE"; then
      run docker compose -f "$COMPOSE_FILE" up -d --no-build "$CADDY_SERVICE"
    fi
    ;;
  logs)
    log "режим logs: показываю логи контейнера, сервис не перезапускаю"
    dump_container_logs || exit 1
    exit 0
    ;;
  cleanup)
    log "режим cleanup: обнуляю логи контейнеров, сервис не перезапускаю"
    cleanup_logs
    log "уборка логов завершена"
    exit 0
    ;;
  prune)
    log "режим prune: только уборка образов, сервис не трогаю"
    prune_images
    log "уборка завершена"
    exit 0
    ;;
  *)
    log "неизвестный MODE=$MODE (ожидается image, source, logs, cleanup или prune)"
    exit 2
    ;;
esac

# Сервис не поднялся: раньше это просто роняло скрипт, и на ВМ оставался (или висел
# перезапусками) новый образ. В режиме image есть куда вернуться — возвращаемся и говорим об этом.
if ! wait_for_health; then
  if [ "$MODE" = "image" ] && [ "$DRY_RUN" != "1" ]; then
    log "новая версия не поднялась — откатываюсь на предыдущую"
    rollback "$PREVIOUS_IMAGE" || true
  fi
  log "выкатка не принята: сервис не отвечает на $HEALTH_URL"
  exit 1
fi
# «Готов» ещё не значит «та версия»: контейнер мог остаться на прежнем образе, а сам сервис —
# на прежней сборке. Такая выкатка не считается успешной, иначе расхождение обнаруживается
# уже в браузере, как «на сайте снова старая версия».
if [ "$MODE" = "image" ] && [ "$DRY_RUN" != "1" ]; then
  if ! verify_version "$(image_sha "$IMAGE_REF")"; then
    log "выкатка не подтвердилась: новая версия не стала рабочей"
    rollback "$PREVIOUS_IMAGE" || true
    exit 5
  fi
  # Подтверждённая версия закрепляется в .env: перезагрузка ВМ не должна поднимать другой образ.
  pin_image "$IMAGE_REF"
fi
# Docker внутри сервера — до проверки песочницы: она сама спрашивает контейнер, и без docker её
# «docker недоступен» не отличалось бы от «не смонтирован сокет» (см. verify_docker).
verify_docker
# Расхождение путей песочницы — не справка, а сломанная выкатка: агент пишет файлы, которых
# не видит терминал. Такой деплой не считается успешным.
if ! verify_sandbox; then
  log "выкатка не принята: песочница и контейнеры видят разные каталоги"
  exit 4
fi
# Панель, которую увидит браузер: тот же класс ошибки, что и белый экран предпросмотра, только
# про версию сборки («после выкатки показывается старое»). Вердикт печатается в лог выкатки.
verify_panel "$(image_sha "$IMAGE_REF")"
# Сеть предпросмотра: печатается в лог выкатки, потому что «предпросмотр запущен, а в панели
# белый экран» — это ровно про неё, и ответ на это должен быть в Actions, а не на ВМ (см. verify_preview).
verify_preview
# Вход по номеру: печатается в лог выкатки, чтобы «SMS не приходят» читалось из Actions, а не
# выяснялось из .env на ВМ. Отказ здесь не отменяет выкатку (см. verify_sms).
verify_sms
# Логи контейнера после выкатки — в лог Actions, а не только на ВМ: строка `[web] … ключ есть` и
# ошибка старта сервера должны читаться там же, где вердикт выкатки. Хвост короткий, значения
# секретов вырезаются (mask_secrets). Отказ чтения выкатку не отменяет и не роняет.
if [ "$MODE" = "image" ] && [ "$DRY_RUN" != "1" ]; then
  dump_container_logs || true
fi
log "деплой завершён, живая сборка: $(live_build)"
# Уборка после успешной выкатки, а не до неё: если сервис не поднялся, предыдущий образ
# остаётся на месте и можно сразу откатиться на него без сборки.
prune_images
