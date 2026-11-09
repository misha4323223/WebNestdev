"""PostgreSQL на node-1: проверка роли, доступность primary и promotion."""

from __future__ import annotations

import os
import re
import socket
import subprocess
import time

PG_PORT = int(os.environ.get("LOCAL_PG_PORT", "5433"))
PG_CLUSTER = os.environ.get("PG_CLUSTER", "17")
PRIMARY_HOST = os.environ.get("PRIMARY_PG_HOST", "10.0.0.5")
PRIMARY_PORT = int(os.environ.get("PRIMARY_PG_PORT", "5432"))


def sql(query: str) -> str:
    result = subprocess.run(
        ["sudo", "-u", "postgres", "psql", "-p", str(PG_PORT), "-tAc", query],
        capture_output=True, text=True, timeout=20, check=False,
    )
    if result.returncode != 0:
        raise RuntimeError("psql: " + (result.stderr or result.stdout).strip()[:400])
    return result.stdout.strip()


def is_in_recovery() -> bool:
    return sql("select pg_is_in_recovery()") == "t"


def primary_reachable(timeout: float = 3.0) -> bool:
    """Проверяет не только TCP, но и что сервер отвечает как PostgreSQL.

    Один HAProxy может принимать TCP при мёртвом backend; для выбора failover этого мало.
    `pg_isready` отправляет startup-пакет и отличает живой сервер от открытого порта.
    """
    try:
        result = subprocess.run(
            ["pg_isready", "-h", PRIMARY_HOST, "-p", str(PRIMARY_PORT), "-d", "postgres", "-q"],
            capture_output=True, text=True, timeout=timeout, check=False,
        )
        if result.returncode in (0, 1):
            return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        pass
    try:
        with socket.create_connection((PRIMARY_HOST, PRIMARY_PORT), timeout=timeout):
            return True
    except OSError:
        return False


def current_lsn() -> str:
    return sql("select pg_current_wal_lsn()")


def replay_lsn() -> str | None:
    return sql("select pg_last_wal_replay_lsn()") or None


def wal_receiver_status() -> str | None:
    return sql("select status from pg_stat_wal_receiver") or None


def lsn_diff(source: str, target: str) -> int:
    """How many bytes source is ahead of target; validates both LSN strings."""
    for name, value in (("source", source), ("target", target)):
        if not re.fullmatch(r"[0-9A-Fa-f]+/[0-9A-Fa-f]+", value or ""):
            raise RuntimeError(f"некорректный LSN {name}: {value!r}")
    return int(sql(f"select pg_wal_lsn_diff('{source}', '{target}')"))


def stop() -> None:
    """Clean stop for a planned handoff; does not use the start-guard."""
    result = subprocess.run(
        ["pg_ctlcluster", PG_CLUSTER, "main", "stop"],
        capture_output=True, text=True, timeout=60, check=False,
    )
    if result.returncode != 0:
        raise RuntimeError("pg_ctlcluster stop: " + (result.stderr or result.stdout).strip()[:400])


def start() -> None:
    """Start through systemd so the split-brain guard runs."""
    unit = f"postgresql@{PG_CLUSTER}-main.service"
    result = subprocess.run(
        ["systemctl", "start", unit],
        capture_output=True, text=True, timeout=90, check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"systemctl start {unit}: " + (result.stderr or result.stdout).strip()[:400])


def promote() -> None:
    result = subprocess.run(
        ["pg_ctlcluster", PG_CLUSTER, "main", "promote"],
        capture_output=True, text=True, timeout=60, check=False,
    )
    if result.returncode != 0:
        raise RuntimeError("pg_ctlcluster promote: " + (result.stderr or result.stdout).strip()[:400])


def wait_for_primary(timeout: float = 60.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if not is_in_recovery():
                return True
        except RuntimeError:
            pass
        time.sleep(1)
    return False


def can_write() -> bool:
    try:
        sql("select pg_current_wal_lsn()")
        return True
    except RuntimeError:
        return False
