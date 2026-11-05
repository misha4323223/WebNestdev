#!/usr/bin/env bash
#
# Проверка выпуска wildcard-сертификата без Let's Encrypt, без acme.sh и без Docker: `acme.sh`
# и `docker` подменяются заглушками. Проверяются ветки, из-за которых на проде бывает тихо:
#   • повторный запуск не тратит выдачу, пока сертификат свежий;
#   • без сертификата сниппет переключается на статические файлы, а не остаётся on_demand;
#   • `--check` возвращает 1, когда сертификата нет, и 0, когда он в порядке;
#   • `--disable` возвращает выдачу по одному имени и не удаляет файлы;
#   • без домена скрипт отказывается работать, а не выпускает сертификат на пустое имя.
#
# Запуск: bash deploy/scripts/wildcard-cert.test.sh
set -Eeuo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SCRIPT="$ROOT/deploy/scripts/wildcard-cert.sh"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/wildcard-cert-test.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/app" "$WORK/bin" "$WORK/certs"
: > "$WORK/app/docker-compose.yml"
LOG="$WORK/calls.log"
: > "$LOG"

failures=0
ok(){ printf 'ok   %s\n' "$*"; }
bad(){ printf 'FAIL %s\n' "$*" >&2; failures=$((failures + 1)); }

cat > "$WORK/bin/acme.sh" <<'STUB'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'acme %s\n' "$*" >> "$STUB_LOG"
case "${1:-}" in
  --issue) exit 0 ;;
  --install-cert)
    cert=""; key=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --fullchain-file) cert="$2"; shift 2 ;;
        --key-file) key="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    [ -n "$cert" ] && [ -n "$key" ] || exit 1
    mkdir -p "$(dirname "$cert")" "$(dirname "$key")"
    openssl req -x509 -newkey rsa:2048 -nodes -days "${STUB_DAYS:-90}" \
      -subj "/CN=*.preview.test" -keyout "$key" -out "$cert" >/dev/null 2>&1
    printf 'reloadcmd %s\n' "$*" >> "$STUB_LOG"
    exit 0
    ;;
esac
STUB

cat > "$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >> "$STUB_LOG"
exit 0
STUB
chmod +x "$WORK/bin/acme.sh" "$WORK/bin/docker"
# acme.sh берёт хуки DNS API из dnsapi рядом с собой — без файла хука он считает себя неготовым
# и пытался бы ставиться заново.
mkdir -p "$WORK/bin/dnsapi" && : > "$WORK/bin/dnsapi/dns_regru.sh"

run_cert(){
  local domain=()
  [ "${NO_DOMAIN:-0}" = "1" ] || domain=(PREVIEW_PUBLIC_DOMAIN=preview.test)
  env STUB_LOG="$LOG" STUB_DAYS="${STUB_DAYS:-90}" \
    APP_DIR="$WORK/app" CERTS_HOST_DIR="$WORK/certs" CERT_CONTAINER_DIR="/certs/preview" \
    ACME_SH="$WORK/bin/acme.sh" DOCKER="$WORK/bin/docker" ACME_SH_INSTALL=0 \
    ${domain[@]+"${domain[@]}"} bash "$SCRIPT" "$@"
}

SNIPPET="$WORK/app/preview-tls.caddy"

# 1. Сертификата нет: --check говорит «плохо».
if run_cert --check >/dev/null 2>&1; then
  bad "--check без сертификата вернул 0"
else
  ok "--check без сертификата возвращает 1"
fi

# 2. Выпуск: acme.sh получает wildcard на домен превью, сниппет — статические файлы.
if run_cert --issue >/dev/null 2>"$WORK/err"; then
  ok "--issue завершился успешно"
else
  bad "--issue завершился ошибкой: $(cat "$WORK/err")"
fi
grep -q -- '--dns dns_regru -d \*\.preview\.test' "$LOG" && ok "acme.sh выпускает *.<домен> через DNS-01" \
  || bad "acme.sh не получил ожидаемых аргументов: $(grep '^acme --issue' "$LOG" || echo '<нет вызова>')"
grep -q -- '--reloadcmd cd .*docker compose -f docker-compose.yml exec -T caddy caddy reload' "$LOG" \
  && ok "продление из cron перечитывает Caddy по абсолютному пути" \
  || bad "reloadcmd не содержит абсолютного вызова compose"
grep -q '/certs/preview/fullchain.pem' "$SNIPPET" && ok "сниппет указывает на wildcard-сертификат" \
  || bad "сниппет не переключился на wildcard: $(cat "$SNIPPET" 2>/dev/null)"
[ -f "$WORK/certs/preview/fullchain.pem" ] && [ -f "$WORK/certs/preview/key.pem" ] \
  && ok "файлы сертификата на месте" || bad "файлов сертификата нет"
[ "$(stat -c '%a' "$WORK/certs/preview/key.pem" 2>/dev/null || stat -f '%Lp' "$WORK/certs/preview/key.pem")" = "600" ] \
  && ok "закрытый ключ только для владельца (600)" || bad "у ключа неверные права"
grep -q 'docker compose -f docker-compose.yml exec -T caddy caddy reload' "$LOG" \
  && ok "после выпуска Caddy перечитал конфигурацию" || bad "Caddy не перечитывался"

# 3. Повторный запуск не тратит выдачу, пока сертификат свежий.
: > "$LOG"
run_cert --issue >/dev/null 2>&1
if grep -q '^acme --issue' "$LOG"; then
  bad "повторный --issue выпустил сертификат заново при свежем сроке"
else
  ok "повторный --issue не тратит выдачу"
fi

# 3b. После неудачи повторов нет, пока не истечёт пауза (кэш отрицательного ответа DNS).
rm -f "$WORK/certs/preview/fullchain.pem" "$WORK/certs/preview/key.pem"
mkdir -p "$WORK/certs/preview" && date +%s > "$WORK/certs/preview/.last-failure"
: > "$LOG"
run_cert --issue >/dev/null 2>&1
if grep -q '^acme --issue' "$LOG"; then
  bad "выпуск повторился, не выждав кэш отрицательного ответа DNS"
else
  ok "повтор после неудачи ждёт окончания паузы"
fi
rm -f "$WORK/certs/preview/.last-failure"
run_cert --issue >/dev/null 2>&1 || bad "выпуск после снятия паузы вернул ошибку"

# 4. --check на свежем сертификате и статус.
run_cert --check >/dev/null 2>&1 && ok "--check на свежем сертификате возвращает 0" \
  || bad "--check на свежем сертификате вернул не 0"
run_cert --status > "$WORK/status" 2>&1 || bad "--status вернул ошибку"
grep -q 'схема:      wildcard' "$WORK/status" && ok "--status показывает wildcard" \
  || bad "--status не увидел wildcard: $(cat "$WORK/status")"

# 5. Просроченный сертификат: --check ругается, --issue его перевыпускает.
# Сертификат с малым сроком: перевыпуск с --force, чтобы на диске был именно истекающий.
STUB_DAYS=1 run_cert --issue --force >/dev/null 2>&1 || bad "перевыпуск с --force вернул ошибку"
STUB_DAYS=1 run_cert --check >/dev/null 2>&1 \
  && bad "--check не заметил истекающий сертификат" || ok "--check замечает истекающий сертификат"
: > "$LOG"
STUB_DAYS=90 run_cert --issue >/dev/null 2>&1
grep -q '^acme --issue' "$LOG" && ok "истекающий сертификат перевыпускается" \
  || bad "истекающий сертификат не перевыпущен"

# 6. --disable: возврат на on_demand, файлы остаются.
run_cert --disable >/dev/null 2>&1 || bad "--disable вернул ошибку"
grep -q 'on_demand' "$SNIPPET" && ! grep -q '/certs/' "$SNIPPET" \
  && ok "--disable возвращает выдачу по одному имени" || bad "--disable не вернул on_demand: $(cat "$SNIPPET")"
[ -f "$WORK/certs/preview/fullchain.pem" ] && ok "--disable не удаляет сертификат" \
  || bad "--disable удалил сертификат"

# 7. Без домена работать отказывается.
if NO_DOMAIN=1 run_cert --issue >/dev/null 2>"$WORK/err"; then
  bad "--issue без PREVIEW_PUBLIC_DOMAIN завершился успешно"
else
  grep -q 'PREVIEW_PUBLIC_DOMAIN' "$WORK/err" && ok "без домена скрипт отказывается с подсказкой" \
    || bad "непонятная ошибка без домена: $(cat "$WORK/err")"
fi

if [ "$failures" -gt 0 ]; then
  printf '\n%d проверок не прошло\n' "$failures" >&2
  exit 1
fi
printf '\nвсе проверки прошли\n'
