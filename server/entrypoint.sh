#!/bin/sh
# Entrypoint сервера: контейнер стартует root только на время подготовки томов, затем Node
# работает от непривилегированного uid. Это этап 2.2 из docs/SCALING_3000_PLAN.md.
#
# Почему не USER 1000 в Dockerfile: named volume `webnestdev-data` и bind-mount песочниц уже
# существуют и принадлежат root. Если просто сменить USER, сервер не сможет писать в свои же
# данные, а исправление потребовало бы ручного chown на ВМ. Здесь это делается один раз при
# старте, идемпотентно; на повторных стартах данные уже принадлежат uid 1000.
set -eu

uid="${WEBNESTDEV_UID:-1000}"
gid="${WEBNESTDEV_GID:-1000}"
data="${WEBNESTDEV_DATA_DIR:-/app/.webnestdev}"
sandbox="${WEBNESTDEV_SANDBOX_DIR:-$data/sandboxes}"
secrets="${WEBNESTDEV_SECRETS_DIR:-}"
marker="$data/.sandbox-owner-v1"

case "$uid$gid" in
  *[!0-9]*) echo "[entrypoint] WEBNESTDEV_UID/GID должны быть числами: $uid/$gid" >&2; exit 1 ;;
esac
# Контейнеры песочниц, флаги превью и политика брокера уже требуют uid 1000. Другой uid
# выглядел бы рабочим, но сервер писал бы файлы, в которые контейнер не может писать.
if [ "$uid" != "1000" ] || [ "$gid" != "1000" ]; then
  echo "[entrypoint] поддерживается только 1000:1000 (сейчас $uid:$gid): контейнеры песочниц и политика брокера используют этот uid" >&2
  exit 1
fi
case "$data" in
  ""|"/") echo "[entrypoint] небезопасный WEBNESTDEV_DATA_DIR=$data" >&2; exit 1 ;;
  /*) ;;
  *) echo "[entrypoint] WEBNESTDEV_DATA_DIR должен быть абсолютным: $data" >&2; exit 1 ;;
esac
# chown -hR по корню или по каталогу, внутри которого лежат секреты, — это не «подготовка
# томов», а разрушение хоста/потеря защиты секретов. Опечатка в SANDBOX_DIR не должна это делать.
case "$sandbox" in
  ""|"/") echo "[entrypoint] небезопасный WEBNESTDEV_SANDBOX_DIR=$sandbox" >&2; exit 1 ;;
  /*) ;;
  *) echo "[entrypoint] WEBNESTDEV_SANDBOX_DIR должен быть абсолютным: $sandbox" >&2; exit 1 ;;
esac
# Данные не должны оказаться внутри песочницы: тогда chown -hR по песочнице затронул бы
# платформенные секреты и ключи, которые лежат в data. Обратное (песочница внутри data) —
# штатный локальный режим, его обрабатывает отдельная ветка ниже.
case "$data" in
  "$sandbox"/*) echo "[entrypoint] WEBNESTDEV_DATA_DIR не должен лежать внутри песочницы: $data" >&2; exit 1 ;;
esac
if [ -n "$secrets" ]; then
  # Каталог секретов не должен ни лежать внутри данных/песочниц, ни содержать их: иначе cp -a
  # скопировал бы проекты в runtime-secrets, а chown сделал бы секреты доступными серверу.
  case "$secrets" in
    "/") echo "[entrypoint] небезопасный WEBNESTDEV_SECRETS_DIR=$secrets" >&2; exit 1 ;;
    /*) ;;
    *) echo "[entrypoint] WEBNESTDEV_SECRETS_DIR должен быть абсолютным: $secrets" >&2; exit 1 ;;
  esac
  case "$secrets" in
    "$data"|"$data"/*|"$sandbox"|"$sandbox"/*) echo "[entrypoint] WEBNESTDEV_SECRETS_DIR не должен лежать внутри данных или песочниц: $secrets" >&2; exit 1 ;;
  esac
  case "$data" in
    "$secrets"/*) echo "[entrypoint] WEBNESTDEV_DATA_DIR не должен лежать внутри каталога секретов: $data" >&2; exit 1 ;;
  esac
  case "$sandbox" in
    "$secrets"/*) echo "[entrypoint] WEBNESTDEV_SANDBOX_DIR не должен лежать внутри каталога секретов: $sandbox" >&2; exit 1 ;;
  esac
fi

# Если образ когда-нибудь запустят уже от непривилегированного пользователя, подготавливать
# ничего не нужно: exec сохраняет поведение обычного контейнера.
if [ "$(id -u)" != "0" ]; then
  exec "$@"
fi

echo "[entrypoint] подготовка томов для uid=$uid gid=$gid"
mkdir -p "$data"

# Данные сервера: аккаунты, шифрованные секреты, ключи платформы, состояние алертов. Размер
# небольшой, поэтому рекурсивный chown здесь дешевле, чем разбираться с EACCES на первом запросе.
if chown -hR "$uid:$gid" "$data"; then
  echo "[entrypoint] владелец $data обновлён"
else
  echo "[entrypoint] WARNING: не удалось сменить владельца $data; сервер может не писать в него" >&2
fi

# Каталог песочниц может быть отдельным bind-mount (SANDBOX_DIR на ВМ). Рекурсивный обход
# выполняется только при первом старте: дальше сервер сам создаёт файлы от uid 1000. Симлинки
# не разыменовываются (-h), иначе chown мог бы уйти за пределы песочницы.
case "$sandbox" in
  "$data"|"$data"/*) sandbox_inside_data=1 ;;
  *) sandbox_inside_data=0 ;;
esac
if [ "$sandbox_inside_data" = "1" ]; then
  if [ ! -e "$marker" ]; then
    : > "$marker" 2>/dev/null || true
  fi
else
  if [ ! -d "$sandbox" ]; then
    mkdir -p "$sandbox" || true
  fi
  if [ -d "$sandbox" ] && [ -e "$marker" ]; then
    chown -h "$uid:$gid" "$sandbox" 2>/dev/null || true
  elif [ -d "$sandbox" ]; then
    if chown -hR "$uid:$gid" "$sandbox"; then
      : > "$marker" 2>/dev/null || true
      echo "[entrypoint] владелец песочниц $sandbox обновлён"
    else
      echo "[entrypoint] WARNING: не удалось сменить владельца $sandbox; контейнеры могут не писать в проекты" >&2
    fi
  fi
fi

# Секреты на ВМ часто принадлежат root (их пишет деплой через одноразовый контейнер), а
# bind-mount только для чтения — chown на хосте из контейнера невозможен. Копируем их в
# приватный каталог данных, принадлежащий uid сервера, и подменяем путь для процесса.
if [ -n "$secrets" ] && [ -d "$secrets" ]; then
  runtime_secrets="$data/runtime-secrets"
  rm -rf "$runtime_secrets"
  mkdir -p "$runtime_secrets"
  if cp -a "$secrets/." "$runtime_secrets/" 2>/dev/null; then
    chown -hR "$uid:$gid" "$runtime_secrets" 2>/dev/null || true
    # find не идёт по симлинкам; каталоги и файлы получают минимальные права владельца.
    find "$runtime_secrets" -type d -exec chmod 700 {} + 2>/dev/null || true
    find "$runtime_secrets" -type f -exec chmod 600 {} + 2>/dev/null || true
    export WEBNESTDEV_SECRETS_DIR="$runtime_secrets"
    # Явные пути из .env (YANDEX_SA_KEY_FILE и т.п.) должны указывать на копию, а не на
    # root-only оригинал. Значение переменной не печатается: это путь, не секрет.
    for name in YANDEX_SA_KEY_FILE POSTBOX_SA_KEY_FILE; do
      eval "value=\${$name:-}"
      case "$value" in
        "$secrets"/*)
          relative=${value#"$secrets"/}
          export "$name=$runtime_secrets/$relative"
          ;;
      esac
    done
    echo "[entrypoint] секреты скопированы в $runtime_secrets"
  else
    echo "[entrypoint] WARNING: не удалось скопировать каталог секретов $secrets" >&2
  fi
fi

# Chromium/Playwright и Node пишут кеш в HOME. Для uid 1000 /root недоступен, поэтому даём
# собственный каталог в /tmp; он уже смонтирован с nosuid.
case "${HOME:-}" in
  ""|/root|/root/*) export HOME=/tmp ;;
esac
case "${XDG_CACHE_HOME:-}" in
  ""|/root|/root/*) export XDG_CACHE_HOME=/tmp/.cache ;;
esac
mkdir -p "$XDG_CACHE_HOME" 2>/dev/null || true
chown "$uid:$gid" "$XDG_CACHE_HOME" 2>/dev/null || true

if ! command -v setpriv >/dev/null 2>&1; then
  echo "[entrypoint] setpriv не найден: образ должен содержать util-linux" >&2
  exit 1
fi

echo "[entrypoint] запускаю процесс от uid=$uid gid=$gid"
exec setpriv --reuid="$uid" --regid="$gid" --clear-groups "$@"
