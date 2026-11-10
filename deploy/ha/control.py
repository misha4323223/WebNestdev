"""Shared mailbox for a planned PostgreSQL switchover.

The admin API writes the initial request into the shared data volume, and the
HA controller on each node advances it in a fixed order:

    requested -> target_ready -> source_stopped -> promoted

No HTTP control port is opened on the VMs. That matters because the API can be
served by the very node whose PostgreSQL is being stopped; a local control
socket would disappear exactly when the operation starts.
"""

from __future__ import annotations

import fcntl
import json
import os
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Iterator

CONTROL_PATH = Path(
    os.environ.get("HA_CONTROL_PATH", "/var/lib/webnestdev/data/ha-switchover.json")
)
LOCK_PATH = Path(str(CONTROL_PATH) + ".lock")
CONTROL_UID = int(os.environ.get("HA_CONTROL_UID", "1000"))
CONTROL_GID = int(os.environ.get("HA_CONTROL_GID", "1000"))

ACTIVE_STATES = {"requested", "target_ready", "source_stopped"}
TERMINAL_STATES = {"promoted", "failed", "rolled_back"}
STATES = ACTIVE_STATES | TERMINAL_STATES


def _read_unlocked() -> dict | None:
    try:
        text = CONTROL_PATH.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    try:
        value = json.loads(text)
    except ValueError as error:
        raise RuntimeError(f"файл switchover повреждён: {CONTROL_PATH}: {error}") from error
    if not isinstance(value, dict):
        raise RuntimeError(f"файл switchover должен содержать объект: {CONTROL_PATH}")
    if value.get("state") not in STATES:
        raise RuntimeError(f"файл switchover содержит неизвестное состояние: {CONTROL_PATH}")
    return value


@contextmanager
def _locked() -> Iterator[None]:
    CONTROL_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LOCK_PATH.open("a+", encoding="utf-8") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def _write_unlocked(command: dict) -> None:
    temporary = CONTROL_PATH.with_name(
        f".{CONTROL_PATH.name}.{os.getpid()}.tmp"
    )
    temporary.write_text(
        json.dumps(command, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    try:
        # The API runs as uid 1000 and the controller as root. The file holds no
        # secrets; 0644 makes the state readable even if chown is unavailable.
        os.chmod(temporary, 0o644)
        os.chown(temporary, CONTROL_UID, CONTROL_GID)
    except (PermissionError, OSError):
        pass
    os.replace(temporary, CONTROL_PATH)


def read() -> dict | None:
    try:
        with _locked():
            return _read_unlocked()
    except FileNotFoundError:
        return None
    except OSError as error:
        # Stale FUSE-моунт общего тома отвечает 'Transport endpoint is not
        # connected'/'Stale file handle'. Это не «команды нет»: вызывающий обязан
        # приостановить обычный failover, иначе fencing/promotion пойдут при
        # недоступном storage.
        raise RuntimeError(f"общий том switchover недоступен: {error}") from error


def write(command: dict) -> None:
    if not isinstance(command.get("id"), str) or not command["id"]:
        raise ValueError("switchover command без id")
    if command.get("state") not in STATES:
        raise ValueError("switchover command с неизвестным состоянием")
    with _locked():
        _write_unlocked(command)


def update(operation_id: str, **changes: object) -> dict | None:
    """Update one operation under a lock; ignore a different/newer operation."""
    with _locked():
        current = _read_unlocked()
        if not current or current.get("id") != operation_id:
            return None
        current.update(changes)
        current["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        _write_unlocked(current)
        return current


def fail(operation_id: str, message: str) -> dict | None:
    return update(operation_id, state="failed", message=message[:500])


def is_active(command: dict | None) -> bool:
    return bool(command and command.get("state") in ACTIVE_STATES)


def is_terminal(command: dict | None) -> bool:
    return bool(command and command.get("state") in TERMINAL_STATES)


def age_seconds(command: dict, now: float | None = None) -> float:
    raw = command.get("createdAt")
    if not isinstance(raw, str):
        return 0.0
    try:
        created = datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0
    return max(0.0, (now if now is not None else time.time()) - created)
