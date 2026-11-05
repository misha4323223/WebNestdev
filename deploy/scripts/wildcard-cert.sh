#!/usr/bin/env bash
#
# Wildcard-сертификат для публичных адресов предпросмотра: `*.<PREVIEW_PUBLIC_DOMAIN>`.
#
# Зачем он нужен. По умолчанию Caddy выдаёт сертификат на каждое имя отдельно, в момент первого
# обращения (on_demand + ask-endpoint, см. deploy/Caddyfile): поддомены появляются вместе с
# проектами, и заранее список имён неизвестен. Каждый проект — отдельная выдача Let's Encrypt, у
# которой есть цена (лимит 50 сертификатов на зарегистрированный домен в неделю) и задержка на
# первом заходе. Один wildcard закрывает все текущие и будущие имена одним сертификатом.
#
# Wildcard нельзя получить по HTTP-01, поэтому здесь DNS-01: acme.sh пишет TXT-запись
# `_acme-challenge.<домен>` через API регистратора. Готовые файлы кладутся в каталог, который
# смонтирован в Caddy на чтение, а Caddyfile подключает сниппет `preview-tls.caddy`
# (`tls /certs/preview/fullchain.pem /certs/preview/key.pem`).
#
# Скрипт идемпотентен: повторный запуск ничего не выпускает, пока сертификату больше
# RENEW_BEFORE_DAYS дней, и всегда приводит сниппет к тому состоянию, которое описано ниже.
#
# Режимы:
#   --issue (по умолчанию)  выпустить/обновить сертификат и включить его в Caddy
#   --status                показать состояние сертификата и текущую схему TLS (код 0 всегда)
#   --check                 код 0, если сертификат есть и жить ему больше RENEW_BEFORE_DAYS; иначе 1
#                           (для мониторинга; продление делает cron acme.sh)
#   --disable               вернуть on_demand и перечитать Caddy (сертификат на диске остаётся)
#   --force                 с --issue: перевыпустить, даже если срок ещё не подошёл
#
# Окружение:
#   PREVIEW_PUBLIC_DOMAIN   домен превью, сертификат выпускается на `*.<это значение>` (обязателен)
#   WILDCARD_DOMAIN         явный домен для сертификата вместо PREVIEW_PUBLIC_DOMAIN
#   ACME_DNS_PROVIDER       dnsapi acme.sh (по умолчанию dns_regru); учётные данные провайдера
#                           передаются его же переменными, для reg.ru — REGRU_API_Username и
#                           REGRU_API_Password
#   ACME_SH                 путь к acme.sh (по умолчанию ~/.acme.sh/acme.sh)
#   ACME_SH_INSTALL=1       разрешить установку acme.sh, если его нет (по умолчанию запрещено)
#   ACME_EMAIL              адрес регистрации в Let's Encrypt
#   ACME_SERVER             ACME-сервер (по умолчанию letsencrypt; для проверок — staging)
#   RENEW_BEFORE_DAYS       за сколько дней до конца срока обновлять (по умолчанию 30)
#   APP_DIR                 каталог развёртывания с docker-compose.yml (по умолчанию ~/webnestdev/src)
#   CERTS_HOST_DIR          каталог сертификатов на хосте (по умолчанию $APP_DIR/certs — рядом с
#                           docker-compose.yml, чтобы выкатке не нужен был root)
#   CERT_CONTAINER_DIR      тот же каталог внутри Caddy (по умолчанию /certs/preview)
#   COMPOSE_FILE            файл compose (по умолчанию docker-compose.yml)
#   CADDY_SERVICE           сервис Caddy (по умолчанию caddy)
#
# Пример:
#   REGRU_API_Username=… REGRU_API_Password=… PREVIEW_PUBLIC_DOMAIN=preview.nestdev.ru \
#     bash deploy/scripts/wildcard-cert.sh --issue
set -Eeuo pipefail

MODE=issue
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --issue) MODE=issue ;;
    --status) MODE=status ;;
    --check) MODE=check ;;
    --disable) MODE=disable ;;
    --force) FORCE=1 ;;
    -h|--help) awk 'NR > 1 && /^set -Eeuo pipefail$/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "$0"; exit 0 ;;
    *) echo "неизвестный аргумент: $arg (см. --help)" >&2; exit 2 ;;
  esac
done

log(){ printf '[cert] %s\n' "$*"; }
fail(){ printf '[cert] ошибка: %s\n' "$*" >&2; exit 1; }

APP_DIR="${APP_DIR:-$HOME/webnestdev/src}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
CADDY_SERVICE="${CADDY_SERVICE:-caddy}"
SNIPPET_FILE="${SNIPPET_FILE:-$APP_DIR/preview-tls.caddy}"
CERTS_HOST_DIR="${CERTS_HOST_DIR:-$APP_DIR/certs}"
CERT_DIR="${CERT_DIR:-$CERTS_HOST_DIR/preview}"
CERT_CONTAINER_DIR="${CERT_CONTAINER_DIR:-/certs/preview}"
ACME_SH="${ACME_SH:-$HOME/.acme.sh/acme.sh}"
ACME_DNS_PROVIDER="${ACME_DNS_PROVIDER:-dns_regru}"
ACME_EMAIL="${ACME_EMAIL:-nestdev@mail.ru}"
ACME_SERVER="${ACME_SERVER:-letsencrypt}"
ACME_SH_INSTALL="${ACME_SH_INSTALL:-0}"
RENEW_BEFORE_DAYS="${RENEW_BEFORE_DAYS:-30}"
DOCKER="${DOCKER:-docker}"

WILDCARD_DOMAIN="${WILDCARD_DOMAIN:-${PREVIEW_PUBLIC_DOMAIN:-}}"
CERT_FILE="$CERT_DIR/fullchain.pem"
KEY_FILE="$CERT_DIR/key.pem"

#
# Сниппет: единственное место, где выбор схемы записан в конфиге. Caddyfile подключает его
# строкой `import`, поэтому переключение не трогает основной файл и не требует условной логики
# в конфиге Caddy (её там нет).
#
write_ondemand_snippet(){
  mkdir -p "$(dirname "$SNIPPET_FILE")"
  cat > "$SNIPPET_FILE" <<'EOF'
# TLS для публичных адресов предпросмотра.
#
# Файл подключается из Caddyfile строкой `import /etc/caddy/preview-tls.caddy` и управляется
# скриптом `deploy/scripts/wildcard-cert.sh`:
#
#   без wildcard — сертификат на каждое имя по запросу (on_demand + ask-endpoint);
#   с wildcard   — один сертификат на `*.<домен>`, полученный по DNS-01 и лежащий в /certs.
#
# Руками этот файл не правят: скрипт перезаписывает его целиком и перечитывает конфиг Caddy.
tls {
	on_demand
}
EOF
}

write_static_snippet(){
  mkdir -p "$(dirname "$SNIPPET_FILE")"
  cat > "$SNIPPET_FILE" <<EOF
# TLS для публичных адресов предпросмотра: wildcard-сертификат \`*.$WILDCARD_DOMAIN\`.
#
# Файл управляется \`deploy/scripts/wildcard-cert.sh\` — не редактировать руками: скрипт
# перезаписывает его и перечитывает конфиг Caddy. Домен берётся из PREVIEW_PUBLIC_DOMAIN.
# Файлы сертификата: $CERT_DIR на хосте, $CERT_CONTAINER_DIR внутри Caddy.
# Вернуть выдачу по одному имени: \`bash deploy/scripts/wildcard-cert.sh --disable\`.
tls $CERT_CONTAINER_DIR/fullchain.pem $CERT_CONTAINER_DIR/key.pem
EOF
}

snippet_mode(){
  if [ -f "$SNIPPET_FILE" ] && grep -q "$CERT_CONTAINER_DIR/fullchain.pem" "$SNIPPET_FILE"; then
    printf 'wildcard'
  else
    printf 'on_demand'
  fi
}

reload_caddy(){
  if [ ! -f "$APP_DIR/$COMPOSE_FILE" ]; then
    log "compose ($APP_DIR/$COMPOSE_FILE) не найден — перечитывать Caddy нечем, сниппет применю при следующей выкатке"
    return 0
  fi
  local output
  if output=$(cd "$APP_DIR" && "$DOCKER" compose -f "$COMPOSE_FILE" exec -T "$CADDY_SERVICE" \
      caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1); then
    log "Caddy перечитал конфигурацию"
  else
    # Не валим выпуск: сертификат уже на диске и применится при следующей выкатке или рестарте.
    log "Caddy не перечитал конфигурацию (сертификат остаётся на диске): $output"
  fi
}

cert_not_after(){
  [ -f "$CERT_FILE" ] || return 1
  openssl x509 -in "$CERT_FILE" -noout -enddate 2>/dev/null | cut -d= -f2-
}

cert_days_left(){
  local end epoch now
  end=$(cert_not_after) || return 1
  [ -n "$end" ] || return 1
  epoch=$(date -d "$end" +%s 2>/dev/null) || return 1
  now=$(date +%s)
  printf '%s' $(( (epoch - now) / 86400 ))
}

ensure_acme(){
  if [ -x "$ACME_SH" ]; then return 0; fi
  if [ "$ACME_SH_INSTALL" != "1" ]; then
    fail "acme.sh не найден ($ACME_SH). Установите его (curl https://get.acme.sh | sh -s email=$ACME_EMAIL) или задайте ACME_SH=… и ACME_SH_INSTALL=1, чтобы скрипт поставил его сам"
  fi
  command -v curl >/dev/null 2>&1 || fail "для установки acme.sh нужен curl"
  mkdir -p "$(dirname "$ACME_SH")"
  local install_log="$ACME_SH.install.log"
  : > "$install_log" 2>/dev/null || install_log=/dev/null

  # Штатный установщик: ставит acme.sh, ключ аккаунта и cron для продления. Сообщения не
  # выбрасываем в /dev/null: без них причина отказа на ВМ не видна, а терминала там нет.
  log "ставлю acme.sh в $(dirname "$ACME_SH")"
  if curl -fsSL --retry 2 --retry-delay 2 --max-time 60 https://get.acme.sh \
      -o "$ACME_SH.installer" 2>>"$install_log"; then
    sh "$ACME_SH.installer" -s "email=$ACME_EMAIL" >>"$install_log" 2>&1 </dev/null || true
  else
    printf 'get.acme.sh недоступен\n' >>"$install_log"
  fi
  rm -f "$ACME_SH.installer"

  # Запасной путь: сам acme.sh — один файл. Установщик может упасть и без сети (например, нет
  # crontab), а без cron продление всё равно сделает выкатка — она проходит шаг каждый раз.
  if [ ! -x "$ACME_SH" ]; then
    log "установщик не сработал — скачиваю acme.sh напрямую"
    curl -fsSL --retry 2 --retry-delay 2 --max-time 60 \
      https://raw.githubusercontent.com/acmesh-official/acme.sh/master/acme.sh \
      -o "$ACME_SH" 2>>"$install_log" || rm -f "$ACME_SH"
    [ -s "$ACME_SH" ] || curl -fsSL --retry 2 --retry-delay 2 --max-time 60 \
      https://cdn.jsdelivr.net/gh/acmesh-official/acme.sh@master/acme.sh \
      -o "$ACME_SH" 2>>"$install_log" || rm -f "$ACME_SH"
    [ -s "$ACME_SH" ] && chmod +x "$ACME_SH" 2>/dev/null || true
  fi
  [ -s "$ACME_SH" ] || fail "acme.sh не установился: $(tail -3 "$install_log" 2>/dev/null | tr '\n' ' ')"
  [ -x "$ACME_SH" ] || chmod +x "$ACME_SH" 2>/dev/null || true
  [ -x "$ACME_SH" ] || fail "acme.sh скачан в $ACME_SH, но не стал исполняемым"
  log "acme.sh на месте: $ACME_SH (журнал: $install_log)"
}

provider_hint(){
  case "$ACME_DNS_PROVIDER" in
    dns_regru)
      if [ -z "${REGRU_API_Username:-}" ] && [ -z "${REGRU_API_Password:-}" ] \
         && ! grep -qs 'REGRU_API_' "${HOME:-/root}/.acme.sh/account.conf"; then
        log "учётные данные reg.ru не заданы: экспортируйте REGRU_API_Username и REGRU_API_Password (API-пароль из личного кабинета)"
      fi
      ;;
  esac
}

issue_cert(){
  ensure_acme
  provider_hint
  local domain="*.$WILDCARD_DOMAIN"
  local args=(--issue --dns "$ACME_DNS_PROVIDER" -d "$domain" --keylength ec-256 --server "$ACME_SERVER")
  [ "$FORCE" = "1" ] && args+=(--force)
  log "выпускаю $domain через $ACME_DNS_PROVIDER"
  if ! "$ACME_SH" "${args[@]}" </dev/null; then
    fail "acme.sh не выпустил $domain. Проверьте учётные данные DNS-провайдера и что домен обслуживается его API"
  fi
  install_cert
}

install_cert(){
  mkdir -p "$CERT_DIR"
  chmod 700 "$CERTS_HOST_DIR" "$CERT_DIR" 2>/dev/null || true
  # reloadcmd — готовая команда с абсолютными путями, а не вызов этого скрипта: продление идёт
  # из cron acme.sh, где переменных окружения выкатки (домен, APP_DIR) нет. Сниппет при
  # продлении не меняется — те же два пути, — поэтому достаточно перечитать конфиг Caddy.
  local reloadcmd
  reloadcmd="cd $APP_DIR && $DOCKER compose -f $COMPOSE_FILE exec -T $CADDY_SERVICE caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile"
  if ! "$ACME_SH" --install-cert -d "*.$WILDCARD_DOMAIN" --ecc \
      --key-file "$KEY_FILE" --fullchain-file "$CERT_FILE" \
      --reloadcmd "$reloadcmd" </dev/null; then
    fail "сертификат выпущен, но файлы не установлены в $CERT_DIR"
  fi
  [ -f "$CERT_FILE" ] && [ -f "$KEY_FILE" ] || fail "после установки нет $CERT_FILE или $KEY_FILE"
  chmod 600 "$KEY_FILE"
  chmod 644 "$CERT_FILE"
  write_static_snippet
  log "wildcard подключён: $CERT_FILE ($(cert_days_left || echo '?') дн.) → $SNIPPET_FILE"
}

case "$MODE" in
  status)
    mode=$(snippet_mode)
    printf 'домен:      %s\n' "${WILDCARD_DOMAIN:-<не задан>}"
    printf 'схема:      %s\n' "$mode"
    if [ -f "$CERT_FILE" ]; then
      printf 'сертификат: %s\n' "$CERT_FILE"
      printf 'действует:  до %s (%s дн.)\n' "$(cert_not_after || echo '?')" "$(cert_days_left || echo '?')"
    else
      printf 'сертификат: нет (%s)\n' "$CERT_FILE"
    fi
    printf 'сниппет:    %s\n' "$SNIPPET_FILE"
    exit 0
    ;;

  check)
    [ -n "$WILDCARD_DOMAIN" ] || fail "не задан PREVIEW_PUBLIC_DOMAIN (или WILDCARD_DOMAIN)"
    if [ ! -f "$CERT_FILE" ]; then
      log "сертификата нет: $CERT_FILE"
      exit 1
    fi
    if ! openssl x509 -in "$CERT_FILE" -noout -checkend $((RENEW_BEFORE_DAYS * 86400)) >/dev/null 2>&1; then
      log "сертификат истекает раньше чем через $RENEW_BEFORE_DAYS дн."
      exit 1
    fi
    log "сертификат в порядке: $(cert_not_after) ($(cert_days_left) дн.)"
    [ "$(snippet_mode)" = "wildcard" ] || log "внимание: сертификат есть, но Caddy работает на on_demand (включить: --issue)"
    exit 0
    ;;

  disable)
    write_ondemand_snippet
    log "TLS снова on_demand: $SNIPPET_FILE (файлы сертификата оставил в $CERT_DIR)"
    reload_caddy
    exit 0
    ;;

  issue)
    [ -n "$WILDCARD_DOMAIN" ] || fail "не задан PREVIEW_PUBLIC_DOMAIN (или WILDCARD_DOMAIN)"
    command -v openssl >/dev/null 2>&1 || fail "нужен openssl (проверка срока сертификата)"

    days=$(cert_days_left || echo "")
    if [ -f "$CERT_FILE" ] && [ "$FORCE" != "1" ] && [ -n "$days" ] && [ "$days" -gt "$RENEW_BEFORE_DAYS" ]; then
      log "сертификат ещё действует $days дн. — выпуск не нужен (--force для перевыпуска)"
      write_static_snippet
      reload_caddy
      exit 0
    fi

    issue_cert
    reload_caddy
    exit 0
    ;;
esac
