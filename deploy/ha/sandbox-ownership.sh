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
# Исправление в коде (runner создаёт каталог от uid 1000, API повторяет chmod) выходит со
# следующей сборкой; до неё владелец нормализуется таймером. Обходятся только элементы с чужим
# uid/gid, поэтому повторный запуск дёшев: уже исправленные не выбираются, и каждый прогон
# продолжает с того места, где остановился предыдущий.
set -u

ROOT=${SANDBOX_DIR:-/var/lib/webnestdev/sandboxes}
SANDBOX_UID=${SANDBOX_UID:-1000}
SANDBOX_GID=${SANDBOX_GID:-1000}
# Потолок одного прогона: большое дерево лечится за несколько запусков и не грузит Gluster.
BUDGET=${SANDBOX_OWNERSHIP_BUDGET:-45}
directories=0
entries=0
start=$SECONDS

[ -d "$ROOT" ] || exit 0

# 1. Верхний уровень проекта: владелец и 775, иначе контейнер не создаст в нём node_modules.
for dir in "$ROOT"/*/; do
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
while IFS= read -r -d '' entry; do
  if [ $((SECONDS - start)) -ge "$BUDGET" ]; then
    break
  fi
  if chown "$SANDBOX_UID:$SANDBOX_GID" "$entry" 2>/dev/null; then
    entries=$((entries + 1))
  fi
done < <(find "$ROOT" -xdev \( ! -uid "$SANDBOX_UID" -o ! -gid "$SANDBOX_GID" \) -print0 2>/dev/null)

if [ "$directories" -gt 0 ] || [ "$entries" -gt 0 ]; then
  logger -t webnestdev-sandbox-ownership \
    "нормализованы права: каталогов проектов $directories, вложенных элементов $entries"
fi
exit 0
