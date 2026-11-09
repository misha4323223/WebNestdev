"""Защита старта PostgreSQL от второго primary.

Запускается systemd как `ExecStartPre` для `postgresql@17-main.service`, поэтому
действует и при ручном `systemctl start postgresql@17-main`, и при загрузке ВМ.

Если data directory стартует как standby (`standby.signal` есть), старт разрешён.
Если это primary, разрешаем его только когда peer точно не является primary:

- peer отвечает как standby; или
- MWS подтвердил `power=OFF` peer: fencing завершён, второй узел выключен.

Текущая цель HAProxy только логируется и сама по себе старт не разрешает: старый
конфиг HAProxy может смотреть в локальную базу, пока peer тоже остаётся primary.
Именно такая комбинация возникла 09.11.2026: data directory остался от прежнего
primary, но узел был настроен как standby, и ручной запуск создал второй primary.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import db_proxy

PGDATA = Path(os.environ.get("PGDATA", "/var/lib/postgresql/17/main"))
PEER_VM_PATH = os.environ.get("PEER_MWS_VM_PATH", "").strip()
PEER_PG_HOST = os.environ.get("PEER_PG_HOST", "").strip()
PEER_PG_PORT = os.environ.get("PEER_PG_PORT", "5433").strip()
REPLICATION_USER = os.environ.get("REPLICATION_USER", "replicator")
ALLOW_PRIMARY_FILE = Path(os.environ.get("PG_GUARD_ALLOW_PRIMARY_FILE", "/etc/webnestdev-ha/ALLOW_PRIMARY"))


def log(message: str) -> None:
    print(f"[pg-start-guard] {message}", file=sys.stderr, flush=True)


def evaluate(
    data_dir: Path,
    proxy_target: tuple[str, int] | None,
    peer_power: str | None,
    peer_in_recovery: bool | None,
) -> tuple[bool, str]:
    """Чистая проверка; возвращает (разрешён ли старт, причина)."""
    if not (data_dir / "PG_VERSION").exists():
        return True, "data directory ещё не инициализирован"
    if (data_dir / "standby.signal").exists():
        return True, "data directory в режиме standby"

    if peer_in_recovery is True:
        return True, "peer отвечает как standby; локальный primary безопасен"
    if peer_in_recovery is False:
        return False, "peer уже primary; локальный primary создал бы split-brain"
    if peer_power is not None and peer_power.upper() == "OFF":
        return True, "peer выключен по MWS (fencing подтверждён)"

    target = "неизвестна" if proxy_target is None else f"{proxy_target[0]}:{proxy_target[1]}"
    power = "неизвестно" if peer_power is None else peer_power
    return False, (
        "data directory стартует как primary, роль peer не подтверждена "
        f"(HAProxy: {target}, MWS power: {power}); это создало бы второй primary. "
        "Цель HAProxy не является доказательством безопасного старта"
    )


def peer_recovery() -> bool | None:
    """Фактическая роль peer по прямому подключению к его локальному PostgreSQL."""
    password = os.environ.get("REPLICATION_PASSWORD", "")
    if not PEER_PG_HOST or not password:
        log("PEER_PG_HOST/REPLICATION_PASSWORD не заданы; роль peer не проверить")
        return None
    env = os.environ.copy()
    env["PGPASSWORD"] = password
    try:
        result = subprocess.run(
            [
                "psql", "-h", PEER_PG_HOST, "-p", PEER_PG_PORT, "-U", REPLICATION_USER,
                "-d", "postgres", "-tAc", "select pg_is_in_recovery()",
            ],
            capture_output=True, text=True, timeout=5, env=env, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        log(f"не удалось проверить роль peer: {error}")
        return None
    value = result.stdout.strip().lower()
    if result.returncode == 0 and value in {"t", "f"}:
        return value == "t"
    log(f"peer не ответил на проверку роли (psql rc={result.returncode})")
    return None


def peer_power() -> str | None:
    if not PEER_VM_PATH:
        log("PEER_MWS_VM_PATH не задан; проверить питание peer нельзя")
        return None
    # Импорт только при реальной проверке: unit-тестам не нужна cryptography.
    import mws

    try:
        return str(mws.vm_state(PEER_VM_PATH).get("power") or "").upper() or None
    except mws.MwsError as error:
        log(f"MWS недоступен: {error}")
        return None


def main() -> int:
    if ALLOW_PRIMARY_FILE.exists():
        log(f"аварийный обход активен: {ALLOW_PRIMARY_FILE}; старт primary разрешён")
        return 0

    target = db_proxy.current_target()
    recovery = None
    power = None
    # Настоящий standby не нуждается в запросах к peer: его роль уже в data directory.
    if (PGDATA / "PG_VERSION").exists() and not (PGDATA / "standby.signal").exists():
        recovery = peer_recovery()
        power = None if recovery is not None else peer_power()
    allowed, reason = evaluate(PGDATA, target, power, recovery)
    if allowed:
        log(reason)
        return 0
    log("СТАРТ ЗАПРЕЩЁН: " + reason)
    log(
        "Сначала верните узел в standby через deploy/ha/standby.sh или подтвердите fencing "
        f"(MWS power=OFF peer). Аварийный обход: создайте {ALLOW_PRIMARY_FILE} и удалите его после запуска."
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
