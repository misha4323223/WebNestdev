#!/bin/sh
# Правила, закрывающие выход контейнерам проекта мимо egress-прокси (пункт 5.1 плана
# масштабирования, docs/SCALING_3000_PLAN.md).
#
# Зачем отдельный файл, а не строки в vm-deploy.sh: правила нужны и после перезагрузки ВМ, когда
# никакой выкатки не было. Поэтому скрипт ставится на хост (выкатка кладёт его в /usr/local/sbin и
# включает systemd-юнит), а выкатка запускает его же — одна реализация, два повода.
#
# Что делает: в цепочке DOCKER-USER (Docker её не пересоздаёт и не чистит) запрещает исходящие
# соединения из подсети сети предпросмотра. Разрешено ровно два вида трафика:
#   1) из контейнеров сервера и брокера наружу — они сами ходят в провайдера модели, S3 и GitHub;
#   2) внутри подсети предпросмотра — API, дверь, сам предпросмотр и прокси на 3128.
# Всё остальное отклоняется, поэтому «поставить пакет мимо прокси» сырым сокетом больше нельзя.
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
BROKER_SERVICE="${BROKER_SERVICE:-docker-broker}"

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

# Адреса контейнеров сервера и брокера: им выход наружу нужен, и они в той же подсети.
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

apply_rules() {
  net=$(network_name)
  if [ -z "$net" ]; then
    log "сеть предпросмотра не найдена — правила не ставлю"
    exit 0
  fi
  cidr=$(subnet_of "$net")
  if [ -z "$cidr" ]; then
    log "у сети $net нет IPv4-подсети — правила не ставлю"
    exit 0
  fi
  clear_rules
  exceptions=0
  for address in $(addresses_of "$SERVER_SERVICE") $(addresses_of "$BROKER_SERVICE"); do
    add_rule -s "$cidr" -d "$address/32" -j RETURN
    exceptions=$((exceptions + 1))
  done
  # Внутри подсети: API и прокси (3128), дверь (8788/8789) и сам предпросмотр. Это не «дыра»:
  # выйти наружу отсюда всё равно нельзя, а прокси стоит именно там.
  add_rule -s "$cidr" -d "$cidr" -j RETURN
  add_rule -s "$cidr" -j REJECT --reject-with icmp-port-unreachable
  log "сеть $net ($cidr): выход закрыт, разрешено адресов платформы: $exceptions и вся подсеть предпросмотра"
}

case "$ACTION" in
  apply) apply_rules ;;
  clear)
    clear_rules
    log "правила сняты: выход из сети предпросмотра снова открыт напрямую"
    ;;
  status)
    if [ -z "$(our_rules)" ]; then log "правил нет"; else our_rules; fi
    ;;
  *)
    log "неизвестное действие: $ACTION (ожидается apply, clear или status)"
    exit 64
    ;;
esac
