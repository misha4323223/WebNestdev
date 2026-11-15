"""Снимок состояния HA для API.

Контроллер уже знает роль базы, доступность peer и фазу переключения. Писать это в
отдельный файл дешевле, чем давать приложению доступ к `pg_stat_replication` и системным
юнитам: API читает общий `data/ha-status-<node>.json` и не дублирует SQL/проверки.

Секретов здесь нет: только роль, лаг в байтах, статус WAL receiver и фаза контроллера.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import postgres

STATUS_DIR = Path(os.environ.get("HA_STATUS_DIR", "/var/lib/webnestdev/data"))


def _role(local_primary: bool | None) -> str:
    if local_primary is True:
        return "primary"
    if local_primary is False:
        return "standby"
    return "unknown"


def snapshot(node: str, state: dict, local_primary: bool | None) -> dict:
    role = _role(local_primary)
    streams: int | None = None
    lag: int | None = None
    receiver: str | None = None
    if local_primary is True:
        replication = postgres.replication_streams()
        if replication is not None:
            streams, lag = replication
    elif local_primary is False:
        receiver = postgres.wal_receiver_status()

    return {
        "node": node,
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "updatedAtUnix": int(time.time()),
        "role": role,
        "phase": str(state.get("phase") or "passive"),
        "peerReachable": postgres.primary_reachable(),
        "replicationStreams": streams,
        "replicationLagBytes": lag,
        "walReceiverStatus": receiver,
        "archiveReady": state.get("archive_ready"),
        "servicesStarted": bool(state.get("services_started")),
    }


def write(node: str, state: dict, local_primary: bool | None) -> Path | None:
    """Атомарно записать снимок; ошибка не должна останавливать failover-контроллер."""
    path = STATUS_DIR / f"ha-status-{node}.json"
    try:
        STATUS_DIR.mkdir(parents=True, exist_ok=True)
        temp = STATUS_DIR / f".ha-status-{node}.{os.getpid()}.tmp"
        temp.write_text(json.dumps(snapshot(node, state, local_primary), ensure_ascii=False), encoding="utf-8")
        os.chmod(temp, 0o644)
        os.replace(temp, path)
        return path
    except OSError as error:
        print(f"[ha-status] не удалось записать {path}: {error}", flush=True)
        return None
