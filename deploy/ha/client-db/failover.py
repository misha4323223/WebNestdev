#!/usr/bin/env python3
"""Failover клиентской базы платформы.

Две ноды держат отдельный кластер PostgreSQL `17/client` (порт 5434): primary на одной,
streaming standby на другой. Задача — поднять standby, если primary пропал, и не допустить
двух primary одновременно.

Команды:
    status   показать роль и доступность второй ноды (ничего не меняет);
    guard    ExecStartPre кластера: не дать стартовать primary рядом с живым primary;
    tick     один шаг таймера: посчитать подтверждения и, если пора, сделать promote.

Решение вынесено в `decide()` и покрыто тестами: сеть и psql в проверках не участвуют.
Порог подтверждений (`FAILOVER_CONFIRMATIONS`, по умолчанию 2) защищает от одного
случайного таймаута.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path


def load_env_file(path: str) -> None:
    """Читает /etc/webnestdev/client-db.env для ручных вызовов.

    В systemd переменные приходят через EnvironmentFile, но `failover.py status` запускают и
    руками; без этого PEER_IP оказывался пустым и статус врал «соседа нет».
    """
    file = Path(path)
    if not file.exists():
        return
    for line in file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


load_env_file(os.environ.get("CLIENT_DB_ENV_FILE", "/etc/webnestdev/client-db.env"))

PG_VERSION = os.environ.get("PG_VERSION", "17")
PG_CLUSTER = os.environ.get("PG_CLUSTER", "client")
PG_PORT = int(os.environ.get("PG_PORT", "5434"))
PEER_IP = os.environ.get("PEER_IP", "")
REPL_PASSWORD = os.environ.get("REPL_PASSWORD", "")
STATE_DIR = Path(os.environ.get("STATE_DIR", "/var/lib/webnestdev/client-db"))
STATE_FILE = STATE_DIR / "role.json"
NEEDED = int(os.environ.get("FAILOVER_CONFIRMATIONS", "2"))


def sql(query: str, host: str | None = None) -> str:
    """Запрос к локальному кластеру (superuser) или к соседу (роль репликации)."""
    if host is None:
        command = ["sudo", "-n", "-u", "postgres", "psql", "-p", str(PG_PORT), "-tAc", query]
        env = None
    else:
        command = [
            "psql", "-h", host, "-p", str(PG_PORT), "-U",
            os.environ.get("REPL_USER", "client_replicator"), "-d", "postgres", "-tAc", query,
        ]
        env = {**os.environ, "PGPASSWORD": REPL_PASSWORD, "PGCONNECT_TIMEOUT": "3"}
    result = subprocess.run(command, capture_output=True, text=True, timeout=20, check=False, env=env)
    if result.returncode != 0:
        raise RuntimeError("psql: " + (result.stderr or result.stdout).strip()[:300])
    return result.stdout.strip()


def local_role() -> str:
    try:
        return "standby" if sql("select pg_is_in_recovery()") == "t" else "primary"
    except RuntimeError:
        return "down"


UNREACHABLE_MARKERS = re.compile(
    r"could not connect|connection refused|timeout expired|connection timed out|"
    r"no route to host|network is unreachable|server closed the connection",
    re.IGNORECASE,
)


def peer_role() -> str:
    """Роль соседа: primary, standby, unreachable или unknown.

    Разница принципиальна. `pg_isready` говорит лишь «сервер жив», а не «он пишет», поэтому
    спрашиваем `pg_is_in_recovery()`. Ошибку авторизации или конфигурации нельзя считать
    «соседа нет»: иначе сломанный pg_hba приводит к двум primary. Продвигаем только при
    недоступности по сети.
    """
    if not PEER_IP:
        return "unknown"
    try:
        value = sql("select pg_is_in_recovery()", host=PEER_IP)
    except subprocess.TimeoutExpired:
        return "unreachable"
    except (RuntimeError, OSError) as error:
        return "unreachable" if UNREACHABLE_MARKERS.search(str(error)) else "unknown"
    return "primary" if value == "f" else "standby"


def decide(role: str, peer: str, local_healthy: bool, confirmations: int, needed: int) -> str:
    """Что делать на этом шаге. Чистая функция — вся политика failover здесь.

    promote возможен только когда локальная нода здорова, а сосед именно недоступен.
    Живой standby, неизвестная ошибка и живой primary не дают продвижения.
    """
    if role == "primary":
        return "keep"
    if not local_healthy:
        return "wait"
    if peer == "primary":
        return "reset"
    if peer in ("standby", "unknown"):
        return "wait"
    return "promote" if confirmations + 1 >= needed else "count"


def load_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text())
    except (OSError, ValueError):
        return {"confirmations": 0}


def save_state(state: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state))


def flip_pgbouncer(backend: str) -> None:
    """PgBouncer должен смотреть на текущий primary: локально после promote, на соседа после rejoin."""
    path = Path(os.environ.get("PGBOUNCER_INI", "/etc/pgbouncer/pgbouncer.ini"))
    if not path.exists():
        return
    lines = []
    for line in path.read_text().splitlines():
        if line.startswith("app = "):
            db = os.environ.get("PG_DB", "app")
            port = PG_PORT
            lines.append(f"{db} = host={backend} port={port} dbname={db}")
        else:
            lines.append(line)
    path.write_text("\n".join(lines) + "\n")
    subprocess.run(["sudo", "-n", "systemctl", "reload", "pgbouncer"], check=False, timeout=30)


def promote() -> int:
    print(json.dumps({"action": "promote", "at": time.time()}))
    subprocess.run(["sudo", "-n", "pg_ctlcluster", PG_VERSION, PG_CLUSTER, "promote"], check=False, timeout=60)
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if local_role() == "primary":
            flip_pgbouncer("127.0.0.1")
            save_state({"confirmations": 0, "role": "primary"})
            print(json.dumps({"action": "promoted"}))
            return 0
        time.sleep(1)
    print(json.dumps({"action": "promote-failed"}))
    return 1


def tick() -> int:
    role = local_role()
    healthy = role in ("primary", "standby")
    peer = peer_role()
    state = load_state()
    confirmations = int(state.get("confirmations", 0))
    action = decide(role, peer, healthy, confirmations, NEEDED)
    if action == "keep":
        if confirmations:
            save_state({"confirmations": 0, "role": role})
        return 0
    if action == "wait":
        save_state({"confirmations": 0, "role": role})
        print(json.dumps({"action": "wait", "peer": peer}))
        return 0
    if action == "reset":
        save_state({"confirmations": 0, "role": role})
        flip_pgbouncer(PEER_IP or "127.0.0.1")
        return 0
    if action == "count":
        save_state({"confirmations": confirmations + 1, "role": role})
        print(json.dumps({"action": "count", "confirmations": confirmations + 1, "needed": NEEDED}))
        return 0
    return promote()


def guard() -> int:
    """ExecStartPre: не пустить локальный primary, если сосед уже primary (split-brain)."""
    role = local_role()
    if role != "primary":
        return 0
    if peer_role() == "primary":
        print(json.dumps({"action": "guard-refused", "reason": "peer is primary"}), file=sys.stderr)
        return 1
    return 0


def status() -> int:
    print(json.dumps({
        "role": local_role(),
        "peer": peer_role(),
        "confirmations": load_state().get("confirmations", 0),
        "needed": NEEDED,
        "peerAddress": PEER_IP or None,
    }))
    return 0


def main(argv: list[str]) -> int:
    command = argv[1] if len(argv) > 1 else "status"
    if command == "status":
        return status()
    if command == "guard":
        return guard()
    if command == "tick":
        return tick()
    if command == "promote":
        return promote()
    print("usage: failover.py status|guard|tick|promote", file=sys.stderr)
    return 64


if __name__ == "__main__":
    sys.exit(main(sys.argv))
