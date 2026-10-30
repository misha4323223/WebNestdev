#!/bin/sh
# Установка gVisor (runsc) на ВМ и регистрация его как Docker runtime.
#
# Обычно запускается автоматически из deploy/scripts/vm-deploy.sh, когда
# SANDBOX_RUNTIME=runsc, а Docker ещё не знает runtime: так установка не требует терминала на ВМ.
# Вручную тоже можно: sudo sh deploy/scripts/install-runsc.sh
#
# Версию можно закрепить: RUNSC_VERSION=release-20261026.0 sh ...
# RUNSC_RESTART_DOCKER=1 разрешает перезапустить Docker, если reload не зарегистрировал runtime.
# Автоматическая выкатка передаёт 1: иначе на ВМ без терминала некому сделать restart. Перезапуск
# кратко останавливает работающие контейнеры; compose поднимает их после установки.
# Скрипт идемпотентен: повторный запуск переустанавливает те же файлы и runtime.
set -eu

RUNSC_RESTART_DOCKER="${RUNSC_RESTART_DOCKER:-0}"

has_runsc(){
  command -v docker >/dev/null 2>&1 || return 1
  docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q '"runsc"'
}

wait_for_docker(){
  i=0
  while [ "$i" -lt 60 ]; do
    docker info >/dev/null 2>&1 && return 0
    sleep 1
    i=$((i + 1))
  done
  return 1
}

version="${RUNSC_VERSION:-release-20261026.0}"
base="https://github.com/google/gvisor/releases/download/$version"

if [ "$(id -u)" != "0" ]; then
  if command -v sudo >/dev/null 2>&1; then
    exec sudo -- sh "$0" "$@"
  fi
  echo "нужен root: запустите через sudo" >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64|amd64) arch=x86_64 ;;
  aarch64|arm64) arch=aarch64 ;;
  *) echo "неподдерживаемая архитектура: $(uname -m)" >&2; exit 1 ;;
esac

for command in curl sha256sum tar; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "не найдена команда $command; установите её и повторите" >&2
    exit 1
  fi
done

# GNU tar умеет флаг -j, но распаковку делегирует отдельному bzip2. На минимальной ВМ
# (именно такой оказался прод) tar --help показывает -j, а распаковка падает с
# "bzip2: Cannot exec". Поэтому проверяем сам декомпрессор и при необходимости ставим его:
# установщик и так запускается от root, а без bzip2 релиз gVisor не распаковать.
if ! command -v bzip2 >/dev/null 2>&1; then
  echo "[runsc] bzip2 не найден — устанавливаю пакет"
  if command -v apt-get >/dev/null 2>&1; then
    # Сначала без update: на ВМ могут быть готовые списки пакетов, а лишний поход в
    # репозиторий — это ещё одна сетевая точка отказа. update нужен только если пакет
    # не нашёлся в уже загруженных списках.
    if ! DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends bzip2; then
      DEBIAN_FRONTEND=noninteractive apt-get update -qq && \
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends bzip2
    fi
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache bzip2
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y bzip2
  elif command -v yum >/dev/null 2>&1; then
    yum install -y bzip2
  else
    echo "bzip2 не найден, а пакетный менеджер не распознан; установите bzip2 вручную" >&2
    exit 1
  fi
fi
if ! command -v bzip2 >/dev/null 2>&1; then
  echo "bzip2 всё ещё недоступен после установки; распаковать gVisor нельзя" >&2
  exit 1
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM
asset="gvisor-$arch.tar.bz2"
echo "[runsc] скачиваю $version ($arch)"
curl -fsSL --retry 3 --connect-timeout 20 --max-time 300 "$base/$asset" -o "$tmp/$asset"
curl -fsSL --retry 3 --connect-timeout 20 --max-time 60 "$base/SHA256SUMS" -o "$tmp/SHA256SUMS"

expected=$(awk -v name="$asset" '$2 == name { print $1; exit }' "$tmp/SHA256SUMS")
if [ -z "$expected" ]; then
  echo "в SHA256SUMS нет $asset — релиз $version неполный" >&2
  exit 1
fi
printf '%s  %s\n' "$expected" "$tmp/$asset" | sha256sum -c -

# Официальный tarball содержит runsc, containerd-shim-runsc-v1 и gvisor-bin/; их нужно держать
# вместе. Именно в /usr/local/bin, потому что Sentry может перезапускаться от непривилегированного
# пользователя и должен быть ему доступен.
echo "[runsc] распаковываю в /usr/local/bin"
tar -xjf "$tmp/$asset" -C /usr/local/bin
chmod 0755 /usr/local/bin/runsc

config=/etc/docker/daemon.json
if [ -f "$config" ]; then
  backup="$config.bak.runsc.$(date +%Y%m%d%H%M%S)"
  cp -a "$config" "$backup"
  echo "[runsc] копия daemon.json: $backup"
fi

echo "[runsc] регистрирую runtime в Docker"
/usr/local/bin/runsc install --runtime=runsc

if command -v systemctl >/dev/null 2>&1; then
  systemctl reload docker || echo "[runsc] reload Docker завершился с ошибкой — проверю runtime и при необходимости перезапущу" >&2
else
  # Не-systemd хост: Docker перечитывает daemon.json по SIGHUP.
  pid=$(pidof dockerd 2>/dev/null | awk '{print $1}' || true)
  if [ -z "$pid" ]; then
    echo "dockerd не найден; нужен перезапуск Docker" >&2
  else
    kill -HUP "$pid" 2>/dev/null || echo "[runsc] не удалось послать SIGHUP dockerd" >&2
  fi
fi

if has_runsc; then
  echo "[runsc] Docker знает runtime runsc"
else
  if [ "$RUNSC_RESTART_DOCKER" != "1" ]; then
    echo "[runsc] Docker пока не показывает runtime runsc — перезапустите Docker вручную:" >&2
    echo "  sudo systemctl restart docker" >&2
    echo "и проверьте: docker info --format '{{json .Runtimes}}'" >&2
    exit 1
  fi
  echo "[runsc] reload не подхватил runtime — перезапускаю Docker (контейнеры кратко остановятся)" >&2
  if command -v systemctl >/dev/null 2>&1; then
    systemctl restart docker
  elif command -v service >/dev/null 2>&1; then
    service docker restart
  else
    echo "[runsc] нечем перезапустить Docker: нет systemctl и service" >&2
    exit 1
  fi
  if ! wait_for_docker; then
    echo "[runsc] Docker не поднялся после перезапуска" >&2
    exit 1
  fi
  if ! has_runsc; then
    echo "[runsc] после перезапуска Docker всё ещё не знает runtime runsc" >&2
    echo "  проверьте: docker info --format '{{json .Runtimes}}'" >&2
    exit 1
  fi
  echo "[runsc] Docker знает runtime runsc после перезапуска"
fi

echo "[runsc] готово: $(/usr/local/bin/runsc --version 2>&1 | head -1)"
echo "[runsc] дальше: SANDBOX_RUNTIME=runsc включит его в выкатке; откат — SANDBOX_RUNTIME=docker."
