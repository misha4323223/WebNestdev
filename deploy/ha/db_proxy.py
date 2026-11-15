"""Локальный HAProxy для единого primary PostgreSQL.

Обе API-реплики подключаются к своему `host.docker.internal:5432`. Этот HAProxy
направляет их либо в локальный PostgreSQL, если узел primary, либо напрямую в
PostgreSQL соседнего узла (`5433`), если локальная база standby. Так второй API
может принимать проекты, пока его PostgreSQL только читает WAL, и при этом никто
не пишет в standby напрямую.

Если рядом с HAProxy есть `pg-ca.crt`, backend идёт с `ssl verify required`.
Файл конфигурации переписывается при смене цели или появлении сертификата;
после записи HAProxy перезагружается, чтобы новые соединения пошли в правильный
primary уже по TLS.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

CONFIG_PATH = Path(os.environ.get("HA_DB_PROXY_CONFIG", "/etc/haproxy/haproxy.cfg"))
SERVICE = os.environ.get("HA_DB_PROXY_SERVICE", "haproxy")
LOCAL_PORT = int(os.environ.get("LOCAL_PG_PORT", "5433"))
PEER_HOST = os.environ.get("PRIMARY_PG_HOST", "10.0.0.5")
# Начиная с TLS HAProxy ходит в PostgreSQL напрямую, а не в HAProxy соседа:
# иначе получается либо двойной TLS, либо расшифровка на промежуточной ноде.
PEER_PORT = int(os.environ.get("PRIMARY_PG_PORT", "5433"))
ENABLED = os.environ.get("HA_DB_PROXY_ENABLED", "1") == "1"
TLS_CA = Path(os.environ.get("HA_PG_TLS_CA", "/etc/haproxy/pg-ca.crt"))
TLS_MODE = os.environ.get("HA_PG_TLS", "auto").strip().lower()


def tls_available() -> bool:
    """TLS включается только когда есть публичный CA-файл.

    На свежей node-2 сертификат появляется после node2-sync.sh. До этого HAProxy
    должен остаться на прежнем plaintext-подключении, иначе API потеряет базу.
    """
    if TLS_MODE in {"0", "off", "false", "no"}:
        return False
    try:
        return TLS_CA.is_file() and TLS_CA.stat().st_size > 0
    except OSError:
        return False


def _render(host: str, port: int, tls: bool | None = None) -> str:
    use_tls = tls_available() if tls is None else tls
    server = f"server primary {host}:{port} check"
    if use_tls:
        server += f" ssl verify required ca-file {TLS_CA}"
    return f"""global
    log /dev/log local0
    maxconn 500
    daemon
defaults
    log global
    mode tcp
    option tcplog
    timeout connect 3s
    timeout client 60m
    timeout server 60m
frontend pg
    bind 0.0.0.0:5432
    default_backend pg_servers
backend pg_servers
    balance first
    option tcp-check
    # Цель выбирает HA-контроллер: primary — локальный PostgreSQL,
    # standby — PostgreSQL текущего primary напрямую по приватной сети.
    {server}
"""


def target(local_primary: bool) -> tuple[str, int]:
    if local_primary:
        return "127.0.0.1", LOCAL_PORT
    return PEER_HOST, PEER_PORT


def current_target() -> tuple[str, int] | None:
    """Текущая цель HAProxy; нужна guard-проверке перед стартом PostgreSQL."""
    return _current_target()


def _current_target() -> tuple[str, int] | None:
    try:
        text = CONFIG_PATH.read_text(encoding="utf-8")
    except OSError:
        return None
    for line in text.splitlines():
        fields = line.split()
        if len(fields) >= 3 and fields[0] == "server" and fields[1] == "primary":
            host, _, port = fields[2].rpartition(":")
            if host and port.isdigit():
                return host, int(port)
    return None


def _write(text: str) -> None:
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    if CONFIG_PATH.exists():
        backup = CONFIG_PATH.with_suffix(CONFIG_PATH.suffix + ".webnestdev.bak")
        if not backup.exists():
            shutil.copy2(CONFIG_PATH, backup)
    fd, tmp_name = tempfile.mkstemp(prefix=".haproxy-", dir=str(CONFIG_PATH.parent), text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.chmod(tmp_name, 0o644)
        os.replace(tmp_name, CONFIG_PATH)
    finally:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass


def _run(*args: str, timeout: int = 30) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)


def _ensure_service() -> bool:
    check = _run("systemctl", "is-active", SERVICE)
    if check.returncode != 0:
        result = _run("systemctl", "enable", "--now", SERVICE)
        if result.returncode != 0:
            return False
    reload_result = _run("systemctl", "reload", SERVICE)
    if reload_result.returncode == 0:
        return True
    restart_result = _run("systemctl", "restart", SERVICE)
    return restart_result.returncode == 0


def ensure(local_primary: bool) -> bool | None:
    """True — цель изменилась, False — уже верна, None — HAProxy не обновлён.

    Ошибки не пробрасываются: контроллер должен продолжать следить за базой.
    Вызывающий код по логу поймёт, что HAProxy не обновился, и не должен
    запускать API, пока локальная база остаётся standby.
    """
    if not ENABLED:
        return False
    host, port = target(local_primary)
    rendered = _render(host, port)
    try:
        current = CONFIG_PATH.read_text(encoding="utf-8")
    except OSError:
        current = ""
    # Сравниваем текст, а не только цель: при появлении сертификата на node-2
    # HAProxy должен перейти с plaintext на TLS без смены primary.
    if current == rendered:
        return False
    try:
        _write(rendered)
    except OSError as error:
        print(f"[db-proxy] не удалось записать {CONFIG_PATH}: {error}", flush=True)
        return None
    if not _ensure_service():
        print(f"[db-proxy] HAProxy не перезагрузился после записи {CONFIG_PATH}", flush=True)
        return None
    print(f"[db-proxy] API PostgreSQL → {host}:{port} (local_primary={local_primary})", flush=True)
    return True
