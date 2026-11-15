"""Подготовка WAL-архива на standby и проверка после promotion.

`deploy/scripts/pg-pitr.sh` остаётся единственным местом, где настраиваются
`archive_mode`/`archive_command`. Этот модуль не дублирует ALTER SYSTEM: он
вызывает уже установленный `webnestdev-pg-pitr setup`, проверяет фактическое
состояние и, если нужно, один раз перезапускает standby, чтобы применить
`archive_mode` до promotion.

Почему подготовка делается на standby: PostgreSQL применяет смену
`archive_mode` только при старте. Если включить архив уже после promotion,
потребуется перезапуск primary. Мы готовим архив заранее, пока узел ещё
standby, и после promotion не трогаем работающую primary.
"""

from __future__ import annotations

import logging
import os
import subprocess
import time
from pathlib import Path

import postgres

LOG = logging.getLogger("pitr")

PITR_BIN = Path(os.environ.get("PG_PITR_BIN", "/usr/local/sbin/webnestdev-pg-pitr"))
SETUP_TIMEOUT = float(os.environ.get("PG_PITR_SETUP_TIMEOUT_SECONDS", "120"))
RESTART_TIMEOUT = float(os.environ.get("PG_PITR_RESTART_TIMEOUT_SECONDS", "90"))
RETRY_SECONDS = float(os.environ.get("PG_PITR_RETRY_SECONDS", "60"))

_last_attempt = 0.0


def reset_for_tests() -> None:
    global _last_attempt
    _last_attempt = 0.0


def archive_status() -> tuple[str, str] | None:
    """Фактические `archive_mode` и `archive_command`; None — не прочитали."""
    try:
        mode = postgres.sql("show archive_mode").strip().lower()
        command = postgres.sql("show archive_command").strip()
    except (RuntimeError, OSError) as error:
        LOG.warning("не удалось прочитать состояние WAL-архива: %s", error)
        return None
    return mode, command


def archive_ready(status: tuple[str, str] | None) -> bool:
    if status is None:
        return False
    mode, command = status
    return mode in {"on", "always"} and command not in {"", "(disabled)"}


def _retry_allowed() -> bool:
    return time.monotonic() - _last_attempt >= RETRY_SECONDS


def _mark_attempt() -> None:
    global _last_attempt
    _last_attempt = time.monotonic()


def _run_setup() -> bool:
    if not PITR_BIN.is_file():
        LOG.error("PITR: %s не найден; архив WAL не настраиваю", PITR_BIN)
        return False
    try:
        result = subprocess.run(
            [str(PITR_BIN), "setup"],
            capture_output=True,
            text=True,
            timeout=SETUP_TIMEOUT,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        LOG.error("PITR: setup не выполнен: %s", error)
        return False
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip().replace("\n", " ")
        LOG.error("PITR: setup завершился с кодом %s: %s", result.returncode, detail[:400])
        return False
    return True


def _restart_standby() -> bool:
    """Перезапускает standby через systemd, не поднимая его как primary."""
    unit = f"postgresql@{postgres.PG_CLUSTER}-main.service"
    try:
        result = subprocess.run(
            ["systemctl", "restart", unit],
            capture_output=True,
            text=True,
            timeout=RESTART_TIMEOUT,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        LOG.error("PITR: не удалось перезапустить %s: %s", unit, error)
        return False
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip().replace("\n", " ")
        LOG.error("PITR: %s restart завершился с кодом %s: %s", unit, result.returncode, detail[:400])
        return False

    deadline = time.monotonic() + RESTART_TIMEOUT
    while time.monotonic() < deadline:
        try:
            if postgres.is_in_recovery():
                return True
        except RuntimeError:
            pass
        time.sleep(1)
    LOG.error("PITR: %s не вернулся в standby после перезапуска", unit)
    return False


def ensure_standby_archive(force: bool = False) -> bool:
    """Включает архив на standby до promotion; повторяет попытку не чаще retry."""
    try:
        if not postgres.is_in_recovery():
            return True
    except RuntimeError:
        # PostgreSQL ещё не запущен или уже остановлен — здесь нечего готовить.
        return False

    status = archive_status()
    if archive_ready(status):
        return True
    if status is None:
        LOG.warning("PITR: состояние WAL-архива на standby неизвестно, настройки не меняю")
        return False
    if not force and not _retry_allowed():
        return False

    _mark_attempt()
    LOG.warning("PITR: на standby выключен WAL-архив, выполняю pg-pitr setup")
    if not _run_setup():
        return False

    status = archive_status()
    if archive_ready(status):
        LOG.warning("PITR: WAL-архив включён на standby")
        return True
    if status is None:
        LOG.error("PITR: после setup не удалось проверить архив на standby; рестарт не делаю")
        return False

    # archive_mode — postmaster-параметр: ALTER SYSTEM применяется только
    # после перезапуска. Перед рестартом ещё раз убеждаемся, что узел не успел
    # стать primary: перезапускать primary ради archive_mode нельзя.
    try:
        if not postgres.is_in_recovery():
            LOG.error("PITR: узел перестал быть standby до перезапуска; PostgreSQL не перезапускаю")
            return False
    except RuntimeError:
        return False
    LOG.warning("PITR: archive_mode требует перезапуска standby, перезапускаю PostgreSQL")
    if not _restart_standby():
        return False

    status = archive_status()
    if archive_ready(status):
        LOG.warning("PITR: WAL-архив включён на standby после перезапуска")
        return True
    LOG.error("PITR: archive_mode всё ещё не включён на standby после перезапуска")
    return False


def ensure_primary_archive(force: bool = False) -> bool:
    """Проверяет архив на primary; настраивает его, если это возможно без рестарта."""
    try:
        if postgres.is_in_recovery():
            return False
    except RuntimeError:
        return False

    status = archive_status()
    if archive_ready(status):
        return True
    if status is None:
        LOG.warning("PITR: состояние WAL-архива на primary неизвестно, настройки не меняю")
        return False
    if not force and not _retry_allowed():
        return False

    _mark_attempt()
    LOG.error("PITR: primary работает без WAL-архива, выполняю pg-pitr setup")
    if not _run_setup():
        return False

    status = archive_status()
    if archive_ready(status):
        LOG.warning("PITR: WAL-архив включён на primary")
        return True

    # На primary не перезапускаем PostgreSQL автоматически: во время планового
    # switchover peer может быть жив, и start-guard справедливо не пустит primary.
    # Штатный путь — подготовить архив на standby до promotion.
    LOG.error(
        "PITR: archive_mode всё ещё выключен на primary; "
        "нужен рестарт PostgreSQL или подготовка standby до promotion"
    )
    return False
