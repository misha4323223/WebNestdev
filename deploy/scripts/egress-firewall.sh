#!/bin/sh
# Правила, закрывающие сетевые обходы для чужого кода (пункт 5.1 плана масштабирования,
# docs/SCALING_3000_PLAN.md).
#
# Зачем отдельный файл, а не строки в vm-deploy.sh: правила нужны и после перезагрузки ВМ, когда
# никакой выкатки не было. Поэтому скрипт ставится на хост (выкатка кладёт его в /usr/local/sbin и
# включает systemd-юнит), а выкатка запускает его же — одна реализация, два повода.
#
# Что делает:
#   1) сеть предпросмотра — запрещает исходящие соединения, кроме доступа к egress-прокси API
#      (порт 3128). Контейнеры предпросмотра больше не видят друг друга и внутренние порты API;
#      наружу они ходят только через прокси, который проверяет allowlist;
#   2) сеть serverless-функций — разрешает публичный интернет, но отклоняет private, loopback,
#      link-local, CGNAT и metadata. Функция не может дотянуться до API, PostgreSQL, Docker или
#      облачного metadata, а внешние API и CDN продолжают работать.
#
# DNS работает: контейнеры резолвят через встроенный DNS Docker, а запросы наружу делает демон на
# хосте — вне этих правил. Это осознанно: иначе вместе с обходом прокси сломался бы и allowlist,
# который решает по домену, а не по адресу.
#
# Режимы:
#   apply (по умолчанию) — поставить правила (сначала снять свои же: повторный запуск безопасен);
#   clear                — снять только свои правила, чужой трафик не трогать;
#   status               — показать свои правила.
#
# Скрипт намеренно ничего не роняет при «нечего делать» (нет сети, нет контейнеров): открытый выход
# хуже закрытого, но и падение выкатки из-за отсутствия правил хуже обоих — прокси уже стоит и
# работает, а причина видна в логе.
set -eu

CHAIN="DOCKER-USER"
TAG="webnestdev-egress"
ACTION="${1:-apply}"
SERVER_SERVICE="${SERVER_SERVICE:-webnestdev-server}"
FUNCTIONS_NETWORK="${FUNCTIONS_DOCKER_NETWORK:-webnestdev-functions}"

log() { printf '[egress-firewall] %s\n' "$*"; }

# root нужен только для iptables. В выкатке это `sudo -n` (пароль спросить не у кого), при загрузке
# systemd запускает скрипт уже от root.
if [ "$(id -u)" != "0" ]; then
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    exec sudo -n -- sh "$0" "$@"
  fi
  log "нужен root для iptables, а sudo -n недоступен — правила не меняю"
  exit 2
fi

if ! command -v iptables >/dev/null 2>&1; then
  log "iptables не найден на хосте — правила не меняю"
  exit 2
fi

if ! iptables -S "$CHAIN" >/dev/null 2>&1; then
  log "цепочки $CHAIN нет: правила Docker ещё не созданы (демон не поднимал ни одного контейнера?)"
  exit 0
fi

# Свои правила узнаются по комментарию: так их можно снять, не зная точного вида, и не задеть
# правила Docker и чужие цепочки.
our_rules() {
  iptables -S "$CHAIN" 2>/dev/null | grep -- "$TAG" || true
}

clear_rules() {
  our_rules | while IFS= read -r line; do
    [ -n "$line" ] || continue
    spec=$(printf '%s' "$line" | sed 's/^-A [A-Za-z-]* //; s/"//g')
    # Разбиение на слова здесь нужное: spec — это аргументы iptables, а не одно значение.
    # shellcheck disable=SC2086
    iptables -D "$CHAIN" $spec 2>/dev/null || true
  done
}

network_name() {
  if [ -n "${PREVIEW_NETWORK:-}" ]; then
    printf '%s' "$PREVIEW_NETWORK"
    return 0
  fi
  # Имя сети задаёт compose (`webnestdev-preview`); правило по суффиксу — тот же приём, что в
  # server/src/preview/preview-network.ts. Базу не выбираем: её сеть кончается на `db`.
  docker network ls --format '{{.Name}}' 2>/dev/null | grep -E '(^|[-_])preview$' | grep -vE '(^|[-_])db$' | head -n 1
}

subnet_of() {
  docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}}{{"\n"}}{{end}}' "$1" 2>/dev/null |
    grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+$' | head -n 1
}

# Адреса контейнеров сервера. Preview-контейнеру нужен только прокси на сервере, но сервер сам
# ходит наружу и не должен попасть под правило источника.
addresses_of() {
  service="$1"
  ids=$(docker ps -q --filter "label=com.docker.compose.service=$service" 2>/dev/null || true)
  [ -n "$ids" ] || return 0
  for id in $ids; do
    docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{"\n"}}{{end}}' "$id" 2>/dev/null || true
  done | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | sort -u || true
}

add_rule() {
  iptables -A "$CHAIN" "$@" -m comment --comment "$TAG" || log "не удалось добавить правило: $*"
}

apply_preview_rules() {
  net=$(network_name)
  if [ -z "$net" ]; then
    log "сеть предпросмотра не найдена — правила preview не ставлю"
    return 0
  fi
  cidr=$(subnet_of "$net")
  if [ -z "$cidr" ]; then
    log "у сети $net нет IPv4-подсети — правила preview не ставлю"
    return 0
  fi
  # Адрес сервера может измениться при пересоздании контейнера, а сеть API остаётся той же.
  # Поэтому разрешаем прокси по подсети API, а не только по текущему IP: иначе после рестарта
  # Docker правило /32 устаревало бы и preview терял установку пакетов до следующей выкатки.
  api_net=$(docker network ls --filter label=com.docker.compose.network=webnestdev --format '{{.Name}}' 2>/dev/null | head -n 1 || true)
  api_cidr=""
  if [ -n "$api_net" ]; then api_cidr=$(subnet_of "$api_net"); fi
  exceptions=0
  for address in $(addresses_of "$SERVER_SERVICE"); do
    # Только egress-прокси. API 8787, health и дверь 8788/8789 из контейнера проекта не нужны:
    # иначе чужой код мог бы обращаться к внутренним маршрутам платформы напрямую.
    add_rule -s "$cidr" -d "$address/32" -p tcp --dport "${EGRESS_PROXY_PORT:-3128}" -j RETURN
    exceptions=$((exceptions + 1))
  done
  if [ -n "$api_cidr" ]; then
    add_rule -s "$cidr" -d "$api_cidr" -p tcp --dport "${EGRESS_PROXY_PORT:-3128}" -j RETURN
    exceptions=$((exceptions + 1))
  fi
  # Контейнеры preview не должны видеть друг друга: HMR идёт от браузера через Caddy, а не
  # контейнер-контейнер. API сам обращается к preview, и его ответный трафик не входит в правило
  # источника, поэтому панель продолжает работать.
  add_rule -s "$cidr" -j REJECT --reject-with icmp-port-unreachable
  log "сеть $net ($cidr): разрешён только egress-прокси, адресов: $exceptions; доступ к другим preview закрыт"
}

apply_functions_rules() {
  net="$FUNCTIONS_NETWORK"
  if [ -z "$net" ] || ! docker network inspect "$net" >/dev/null 2>&1; then
    log "сеть функций $net не найдена — правила функций не ставлю"
    return 0
  fi
  # Ошибка конфигурации не должна отрезать API от базы или запирать функцию в сети preview.
  # Если имя совпало с сетью сервера, правила функций не ставим: это громко видно в логе.
  preview=$(network_name)
  if [ -n "$preview" ] && [ "$net" = "$preview" ]; then
    log "сеть функций совпадает с сетью предпросмотра ($net) — правила функций не ставлю"
    return 0
  fi
  server_nets=$(docker ps -q --filter "label=com.docker.compose.service=$SERVER_SERVICE" 2>/dev/null |
    while read -r id; do
      docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}\n{{end}}' "$id" 2>/dev/null || true
    done)
  api_net=$(docker network ls --filter label=com.docker.compose.network=webnestdev --format '{{.Name}}' 2>/dev/null | head -n 1 || true)
  if printf '%s\n%s\n' "$server_nets" "$api_net" | grep -Fxq "$net"; then
    log "сеть функций совпадает с сетью API ($net) — правила функций не ставлю"
    return 0
  fi
  cidr=$(subnet_of "$net")
  if [ -z "$cidr" ]; then
    log "у сети функций $net нет IPv4-подсети — правила не ставлю"
    return 0
  fi
  # Функции должны иметь доступ к публичным API. Поэтому политика не REJECT-all, а список
  # запрещённых назначений. Он повторяет server/src/security/address-policy.ts; shell-версия
  # нужна ядру, где JS-проверки уже нет.
  for destination in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 192.88.99.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4; do
    add_rule -s "$cidr" -d "$destination" -j REJECT --reject-with icmp-port-unreachable
  done
  # Своя сеть — отдельно и явно: даже если подсеть пересечётся с private-диапазоном, контейнеры
  # функций не должны разговаривать друг с другом.
  add_rule -s "$cidr" -d "$cidr" -j REJECT --reject-with icmp-port-unreachable
  log "сеть функций $net ($cidr): публичный интернет разрешён, private/metadata и связь между функциями закрыты"
}

apply_rules() {
  clear_rules
  apply_preview_rules
  apply_functions_rules
}

case "$ACTION" in
  apply) apply_rules ;;
  clear)
    clear_rules
    log "правила сняты: выход из сетей снова открыт напрямую"
    ;;
  status)
    if [ -z "$(our_rules)" ]; then log "правил нет"; else our_rules; fi
    ;;
  *)
    log "неизвестное действие: $ACTION (ожидается apply, clear или status)"
    exit 64
    ;;
esac
