#!/usr/bin/env bash
# Установка storage-guard: общие Gluster-тома перемонтируются после загрузки
# и при мёртвом FUSE-моунте, не дожидаясь ручного `mount -a`.
# Повторный запуск безопасен.
set -euo pipefail

SRC=$(cd "$(dirname "$0")" && pwd)
API_CONTAINER=${API_CONTAINER:-src-webnestdev-server-1}
RUNNER_CONTAINER=${RUNNER_CONTAINER:-}

install -m 755 "$SRC/storage-ensure.sh" /usr/local/sbin/webnestdev-storage-ensure
install -m 644 "$SRC/webnestdev-storage.service" /etc/systemd/system/webnestdev-storage.service
install -m 644 "$SRC/webnestdev-storage.timer" /etc/systemd/system/webnestdev-storage.timer

# Владелец каталогов проектов: см. sandbox-ownership.sh.
install -m 755 "$SRC/sandbox-ownership.sh" /usr/local/sbin/webnestdev-sandbox-ownership
install -m 644 "$SRC/webnestdev-sandbox-ownership.service" /etc/systemd/system/webnestdev-sandbox-ownership.service
install -m 644 "$SRC/webnestdev-sandbox-ownership.timer" /etc/systemd/system/webnestdev-sandbox-ownership.timer

# nofail: неудачный Gluster-моунт при загрузке не должен блокировать boot.
if ! grep -qE '^[^#]*/var/lib/webnestdev/(data|sandboxes|sites).*nofail' /etc/fstab; then
  cp /etc/fstab "/etc/fstab.bak-$(date -u +%Y%m%dT%H%M%SZ)"
  sed -i -E 's#(^[^#]*/var/lib/webnestdev/(data|sandboxes|sites)[[:space:]]+glusterfs[[:space:]]+[^[:space:]]*)#\1,nofail#' /etc/fstab
  echo "fstab: добавлен nofail для общих томов (backup рядом)"
fi

if [ -n "$RUNNER_CONTAINER" ]; then
  RESTART="$API_CONTAINER $RUNNER_CONTAINER"
else
  RESTART="$API_CONTAINER"
fi

install -d -m 755 /etc/systemd/system/webnestdev-storage.service.d
cat > /etc/systemd/system/webnestdev-storage.service.d/restart-containers.conf <<EOF
[Service]
Environment=HA_STORAGE_RESTART_CONTAINERS=$RESTART
EOF

systemctl daemon-reload
systemctl enable webnestdev-storage.service webnestdev-storage.timer >/dev/null
systemctl enable webnestdev-sandbox-ownership.timer >/dev/null
systemctl start webnestdev-storage.timer
systemctl start webnestdev-storage.service
systemctl start webnestdev-sandbox-ownership.timer
systemctl start webnestdev-sandbox-ownership.service
echo "storage-guard установлен; таймеры: storage=$(systemctl is-active webnestdev-storage.timer) ownership=$(systemctl is-active webnestdev-sandbox-ownership.timer)"
