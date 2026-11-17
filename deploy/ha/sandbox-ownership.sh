#!/usr/bin/env bash
# Возвращает проектным каталогам и их содержимому владельца uid 1000 (контейнеры команд и preview).
#
# Зачем: контейнеры работают от uid 1000, а часть дерева может оказаться root:root — от старых
# запусков сборки/установки от root, из архива или из восстановленного дампа. Верхний уровень
# лечился этим таймером, а вложенные каталоги (в первую очередь node_modules) — нет: `npm install`
# падал с `EACCES: permission denied, unlink '.../node_modules/...'`, потому что удалять файл
# можно только при праве записи на его каталог, а каталог принадлежал root. Поэтому обход теперь
# рекурсивный.
#
# Код API тоже повторяет chmod перед командой контейнера, но он не может починить дерево,
# если сам запущен от uid 1000. Поэтому владелец нормализуется этим host-таймером. Обходятся
# только элементы с чужим uid/gid, поэтому повторный запуск дёшев: уже исправленные не
# выбираются, и каждый прогон продолжает с того места, где остановился предыдущий.
set -u

# Проекты могут лежать в двух корнях: общий Gluster-том (shared) и локальный диск ноды
# (local workspace mode). Раньше обходился только SANDBOX_DIR, поэтому root:root внутри
# /var/lib/webnestdev/workspaces не исправлялся, и npm install падал с EACCES.
SANDBOX_UID=${SANDBOX_UID:-1000}
SANDBOX_GID=${SANDBOX_GID:-1000}
# Потолок одного прогона: большое дерево лечится за несколько запусков и не грузит Gluster.
BUDGET=${SANDBOX_OWNERSHIP_BUDGET:-45}
directories=0
entries=0
start=$SECONDS

normalize_root() {
  local root=$1
  [ -d "$root" ] || return 0

  # 1. Верхний уровень проекта: владелец и 775, иначе контейнер не создаст в нём node_modules.
  for dir in "$root"/*/; do
    [ -d "$dir" ] || continue
    owner=$(stat -c '%u:%g' "$dir" 2>/dev/null) || continue
    mode=$(stat -c '%a' "$dir" 2>/dev/null) || continue
    if [ "$owner" != "$SANDBOX_UID:$SANDBOX_GID" ] || [ "$mode" != "775" ]; then
      if chown "$SANDBOX_UID:$SANDBOX_GID" "$dir" 2>/dev/null && chmod 775 "$dir" 2>/dev/null; then
        directories=$((directories + 1))
      fi
    fi
  done

  # 2. Всё дерево, включая node_modules и точечные каталоги npm: только чужой владелец.
  # `-h` обязателен: в node_modules/.bin лежат ссылки на пакеты. Без него chown меняет
  # владельца цели ссылки (потенциально за пределами проекта), а сама ссылка остаётся
  # root:root и снова попадает в следующий обход.
  while IFS= read -r -d '' entry; do
    if [ $((SECONDS - start)) -ge "$BUDGET" ]; then
      break
    fi
    if chown -h "$SANDBOX_UID:$SANDBOX_GID" "$entry" 2>/dev/null; then
      entries=$((entries + 1))
    fi
  done < <(find "$root" -xdev \( ! -uid "$SANDBOX_UID" -o ! -gid "$SANDBOX_GID" \) -print0 2>/dev/null)
}

seen_roots=" "
for root in "${SANDBOX_DIR:-/var/lib/webnestdev/sandboxes}" "${WEBNESTDEV_LOCAL_WORKSPACE_DIR:-/var/lib/webnestdev/workspaces}"; do
  [ -d "$root" ] || continue
  # В local-режиме SANDBOX_DIR и WEBNESTDEV_LOCAL_WORKSPACE_DIR могут указывать на один каталог.
  absolute=$(readlink -f "$root" 2>/dev/null || printf '%s' "$root")
  case "$seen_roots" in
    *" $absolute "*) continue ;;
  esac
  seen_roots="$seen_roots$absolute "
  normalize_root "$root"
  if [ $((SECONDS - start)) -ge "$BUDGET" ]; then
    break
  fi
done

if [ "$directories" -gt 0 ] || [ "$entries" -gt 0 ]; then
  logger -t webnestdev-sandbox-ownership \
    "нормализованы права: каталогов проектов $directories, вложенных элементов $entries"
fi
exit 0
