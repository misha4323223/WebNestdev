#!/usr/bin/env bash
# Гарантирует, что общие Gluster-тома смонтированы и отвечают.
#
# Зачем: при загрузке glusterd/сеть могут быть ещё не готовы, и fstab-моунт
# один раз падает. Раньше никто его не повторял: API стартовал с пустыми
# локальными каталогами вместо данных проектов.
#
# Второй случай — мёртвый FUSE-моунт. Когда вторая ВМ пропадает, клиент Gluster
# с `cluster.quorum-type=auto` теряет оба brick'а и отвечает
# 'Transport endpoint is not connected' / 'no read subvols'. Даже после
# перевода кворума в `none` старый клиент не оживает: нужен перемоунт. А он
# невозможен, пока каталог держат контейнеры (API, runner, preview): их bind
# mounts не дают снять моунт. Поэтому здесь они останавливаются, том
# перемонтируется, контейнеры поднимаются обратно. Без этого promotion после
# падения peer'а упирается в storage и узел не повышается.
#
# Скрипт вызывается при загрузке (до docker.service) и таймером каждые 30 с.
# Монтирование идёт через systemd-юниты из fstab, а не через mount(8): иначе
# systemd считает юнит неактивным и через несколько секунд снимает чужой
# FUSE-процесс.
set -u

MOUNTS=${HA_STORAGE_MOUNTS:-"/var/lib/webnestdev/data /var/lib/webnestdev/sandboxes /var/lib/webnestdev/sites"}
ATTEMPTS=${HA_STORAGE_ATTEMPTS:-15}
RESTART_CONTAINERS=${HA_STORAGE_RESTART_CONTAINERS:-"src-webnestdev-server-1 node1-runner"}
PROBE_TIMEOUT=${HA_STORAGE_PROBE_TIMEOUT:-5}

STOPPED=""

log() { logger -t webnestdev-storage "$*"; }

# Моунт есть и каталог читается. timeout обязателен: мёртвый FUSE-моунт
# может висеть в uninterruptible sleep и без него заблокирует таймер.
is_healthy() {
  local path=$1
  mountpoint -q "$path" || return 1
  [ "$(findmnt -no FSTYPE --target "$path" 2>/dev/null)" = "fuse.glusterfs" ] || return 1
  timeout "$PROBE_TIMEOUT" stat "$path" >/dev/null 2>&1 || return 1
  return 0
}

is_mounted() {
  mountpoint -q "$1"
}

docker_active() {
  command -v docker >/dev/null 2>&1 && systemctl is-active --quiet docker
}

# Контейнеры, у которых есть bind mount внутрь каталога. Пока они живы,
# lazy-umount не завершится и новый моунт не появится.
stop_holders() {
  local path=$1 id name sources
  docker_active || return 0
  for id in $(docker ps -q 2>/dev/null); do
    sources=$(docker inspect --format '{{range .Mounts}}{{.Source}} {{end}}' "$id" 2>/dev/null) || continue
    case " $sources " in
      *" $path/"*|*" $path "*)
        name=$(docker inspect --format '{{.Name}}' "$id" 2>/dev/null)
        if docker stop -t 5 "$id" >/dev/null 2>&1; then
          STOPPED="$STOPPED $id"
          log "остановлен контейнер $name: держал мёртвый моунт $path"
        else
          log "не удалось остановить контейнер $name ($path)"
        fi
        ;;
    esac
  done
}

restart_stopped() {
  local id
  for id in $STOPPED; do
    docker start "$id" >/dev/null 2>&1 || log "не удалось поднять контейнер $id"
  done
  STOPPED=""
}

repair_mount() {
  local path=$1 unit
  unit=$(systemd-escape -p --suffix=mount "$path")
  stop_holders "$path"
  systemctl stop "$unit" >/dev/null 2>&1 || true
  systemctl reset-failed "$unit" >/dev/null 2>&1 || true
  is_mounted "$path" && umount -l -f "$path" >/dev/null 2>&1
  # Каталог мог исчезнуть вместе с моунтом: без него mount не стартует.
  mkdir -p "$path"
  systemctl start "$unit" >/dev/null 2>&1 && is_healthy "$path"
}

for attempt in $(seq 1 "$ATTEMPTS"); do
  missing=0
  for path in $MOUNTS; do
    is_healthy "$path" && continue
    missing=1
    if repair_mount "$path"; then
      log "смонтирован $path"
    else
      log "не удалось восстановить $path (попытка $attempt)"
    fi
  done
  if [ "$missing" -eq 0 ]; then
    restart_stopped
    exit 0
  fi
  sleep 2
done

log "ОШИБКА: не все общие тома смонтированы и отвечают"
restart_stopped
exit 1
