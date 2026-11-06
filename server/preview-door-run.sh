#!/bin/sh
# Супервизор контейнера сервера: API плюс, если включено, отдельные процессы двери публичных
# предпросмотров (пункт 6.1 плана масштабирования) и egress-прокси для кода проекта (5.1).
#
# Зачем супервизор. Соединения открытых предпросмотров держит дверь, а соединения чужих приложений
# и разговоры с реестрами пакетов — прокси: пока они живут в процессе API, шестьдесят предпросмотров
# и пачка установок добавляют память и файловые дескрипторы тому же процессу, что обслуживает
# панель. Отдельный процесс снимает это, но появляется вопрос жизненного цикла: упавший помощник не
# должен ни ронять панель, ни требовать перезапуска контейнера, а упавший API не должен оставлять
# контейнер живым с одними помощниками.
#
# Правила:
# - API — главный процесс: его выход завершает контейнер с его же кодом;
# - дверь и прокси перезапускаются с паузой, а их штатный выход (код 0 — например, у прокси
#   EGRESS_MODE=off) цикл заканчивает: перезапускать процесс, которому нечего делать, бессмысленно;
# - выключенный режим или отсутствие собранного файла — поведение прежнее, один процесс. Это же
#   делает откат на предыдущий образ безопасным: старый образ эти файлы не читает вовсе, а новый без
#   переменных не поднимает ни дверь, ни прокси отдельно.
set -eu

door_script="server/dist/preview/door-main.js"
egress_script="server/dist/egress/proxy-main.js"

door_wanted=0
if [ "${PREVIEW_DOOR_SEPARATE:-0}" = "1" ]; then
  if [ -f "$door_script" ]; then
    door_wanted=1
  else
    echo "[supervisor] PREVIEW_DOOR_SEPARATE=1, но $door_script в образе нет — дверь остаётся в процессе API"
    export PREVIEW_DOOR_SEPARATE=0
  fi
fi

egress_wanted=0
case "${EGRESS_MODE:-off}" in
  ""|off) ;;
  *) egress_wanted=1 ;;
esac
if [ "${EGRESS_PROXY_ENABLED:-0}" = "1" ]; then egress_wanted=1; fi
if [ "$egress_wanted" = "1" ] && [ ! -f "$egress_script" ]; then
  echo "[supervisor] фильтр исходящей сети включён, но $egress_script в образе нет — прокси не поднимаю"
  export EGRESS_MODE=off EGRESS_PROXY_ENABLED=0
  egress_wanted=0
fi

if [ "$door_wanted" = "0" ] && [ "$egress_wanted" = "0" ]; then
  exec "$@"
fi

api_pid=""
door_pid=""
egress_pid=""

# Один и тот же цикл для всех помощников: сигнал доходит до подшелла, а не до node — иначе
# перезапуск контейнера оставлял бы внутри живой сиротский процесс, который продолжал бы держать
# свой порт.
start_worker() {
  worker_name="$1"
  worker_script="$2"
  (
    child=""
    trap 'trap - TERM INT; [ -n "$child" ] && kill -TERM "$child" 2>/dev/null; wait 2>/dev/null; exit 0' TERM INT
    while :; do
      node "$worker_script" &
      child=$!
      code=0
      wait "$child" || code=$?
      if [ "$code" = "0" ]; then
        echo "[supervisor] $worker_name завершился штатно (код 0) — больше не запускаю"
        break
      fi
      echo "[supervisor] $worker_name упал (код $code), перезапуск через 5 с"
      sleep 5
    done
  ) &
}

shutdown() {
  trap - TERM INT
  echo "[supervisor] остановка: передаю сигнал API и помощникам"
  [ -n "$door_pid" ] && kill -TERM "$door_pid" 2>/dev/null || true
  [ -n "$egress_pid" ] && kill -TERM "$egress_pid" 2>/dev/null || true
  [ -n "$api_pid" ] && kill -TERM "$api_pid" 2>/dev/null || true
  # Дочерние процессы получают сигнал сами; ждём их, чтобы не оставить сирот в контейнере.
  wait 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT

if [ "$egress_wanted" = "1" ]; then
  start_worker "egress-прокси" "$egress_script"
  egress_pid=$!
fi
if [ "$door_wanted" = "1" ]; then
  start_worker "дверь предпросмотра" "$door_script"
  door_pid=$!
fi

node server/dist/index.js &
api_pid=$!

# Главный процесс — API. Его код возврата и есть код контейнера: выкатка и health-check должны
# видеть падение сервера, даже если помощники при этом живы.
# `wait` с ненулевым кодом под `set -e` завершил бы скрипт сразу, не остановив помощников: код
# сохраняется явно, чтобы порядок остановки оставался нашим.
api_code=0
wait "$api_pid" || api_code=$?
[ -n "$door_pid" ] && kill -TERM "$door_pid" 2>/dev/null || true
[ -n "$egress_pid" ] && kill -TERM "$egress_pid" 2>/dev/null || true
wait 2>/dev/null || true
exit "$api_code"
