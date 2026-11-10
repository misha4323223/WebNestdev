"""Двусторонний failover: локальный standby принимает роль после потери peer.

Один и тот же контроллер работает на обеих ВМ. Параметры роли задаются окружением
(`HA_LOCAL_NODE`, `HA_PEER_NODE`, `PRIMARY_PG_HOST`, `MWS_VM_PATH`, `HA_LOCAL_PUBLIC_IP`).
Действует только узел, который является PostgreSQL standby: primary пассивен. Поэтому
копия контроллера на второй ВМ не создаёт второго primary.

Порядок действий при потере peer:

1. проверить, что локальная база всё ещё в recovery и storage доступен;
2. подтвердить через MWS, что peer выключен, и при необходимости выключить его (fencing);
3. только после `power=OFF` повысить локальный standby;
4. поднять API/Caddy и проверить `/api/ready` и запись в PostgreSQL;
5. переключить A-записи REG.RU на публичный адрес этого узла.

Если MWS недоступен, promotion не выполняется: два primary опаснее простоя. После
promotion контроллер пассивен и не делает автоматический failback; возврат старого primary
выполняется отдельной процедурой rejoin.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import time
from pathlib import Path

import db_proxy
import mws
import postgres
import regru
import storage_quorum
import switchover

LOG = logging.getLogger("failover")
STATE_PATH = Path(os.environ.get("HA_STATE_PATH", "/var/lib/webnestdev-ha/state.json"))
GRACE = float(os.environ.get("FAILOVER_GRACE_SECONDS", "30"))
INTERVAL = float(os.environ.get("CHECK_INTERVAL_SECONDS", "5"))
API_READY_URL = os.environ.get("API_READY_URL", "http://127.0.0.1:8787/api/ready")
API_CONTAINER = os.environ.get("API_CONTAINER", "src-webnestdev-server-1")
CADDY_CONTAINER = os.environ.get("CADDY_CONTAINER", "src-caddy-1")
BROKER_CONTAINER = os.environ.get("BROKER_CONTAINER", "src-docker-broker-1")
RUNNER_CONTAINER = os.environ.get("RUNNER_CONTAINER", "")
LOCAL_NODE = os.environ.get("HA_LOCAL_NODE", "node-1")
PEER_NODE = os.environ.get("HA_PEER_NODE", "node-2")
DNS_ENABLED = os.environ.get("DNS_ENABLED", "1") == "1"
DNS_NEW_IP = os.environ.get("HA_LOCAL_PUBLIC_IP", os.environ.get("DNS_NEW_IP", "178.236.27.102"))
DNS_OLD_IP = os.environ.get("HA_PEER_PUBLIC_IP", os.environ.get("DNS_OLD_IP", "2.59.82.143"))
STORAGE_PATH = os.environ.get("HA_STORAGE_PATH", "").strip()
REQUIRE_STORAGE = os.environ.get("HA_REQUIRE_STORAGE", "1") == "1"
START_SERVICES = os.environ.get("HA_START_SERVICES", "1") == "1"
SWITCHOVER_TIMEOUT = float(os.environ.get("HA_SWITCHOVER_TIMEOUT_SECONDS", "180"))


def load_state() -> dict:
    try:
        return json.loads(STATE_PATH.read_text())
    except (OSError, ValueError):
        return {"phase": "passive", "suspect_since": None, "dns_done": False, "api_restarted": False}


def save_state(state: dict) -> None:
    try:
        STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2))
    except OSError as error:
        LOG.warning("не удалось сохранить состояние %s: %s", STATE_PATH, error)


def set_phase(state: dict, phase: str) -> None:
    if state.get("phase") != phase:
        LOG.info("фаза: %s → %s", state.get("phase"), phase)
        state["phase"] = phase
        save_state(state)


def api_ready(timeout: float = 5.0) -> bool:
    try:
        result = subprocess.run(
            ["curl", "-fsS", "-m", str(timeout), "-o", "/dev/null", "-w", "%{http_code}", API_READY_URL],
            capture_output=True, text=True, timeout=timeout + 3, check=False,
        )
        return result.returncode == 0 and result.stdout.strip() == "200"
    except (OSError, subprocess.TimeoutExpired):
        return False


def start_container(name: str) -> bool:
    """Поднимает существующий stopped-контейнер, не пересоздавая его."""
    if not name:
        return True
    result = subprocess.run(
        ["docker", "start", name], capture_output=True, text=True, timeout=90, check=False,
    )
    if result.returncode != 0:
        LOG.error("docker start %s: %s", name, (result.stderr or result.stdout).strip()[:400])
        return False
    return True


def start_services() -> None:
    if not START_SERVICES:
        return
    LOG.warning(
        "поднимаю broker/API/Caddy/runner на %s: %s, %s, %s, %s",
        LOCAL_NODE, BROKER_CONTAINER or "без broker", API_CONTAINER,
        CADDY_CONTAINER or "без Caddy", RUNNER_CONTAINER or "без runner",
    )
    # API проверяет Docker через broker и не станет ready без него.
    if BROKER_CONTAINER:
        start_container(BROKER_CONTAINER)
    start_container(API_CONTAINER)
    if CADDY_CONTAINER:
        start_container(CADDY_CONTAINER)
    if RUNNER_CONTAINER:
        start_container(RUNNER_CONTAINER)


def container_running(name: str) -> bool:
    if not name:
        return False
    result = subprocess.run(
        ["docker", "inspect", "-f", "{{.State.Running}}", name],
        capture_output=True, text=True, timeout=15, check=False,
    )
    return result.returncode == 0 and result.stdout.strip() == "true"


def all_services_running() -> bool:
    names = [
        name for name in (BROKER_CONTAINER, API_CONTAINER, CADDY_CONTAINER, RUNNER_CONTAINER) if name
    ]
    return all(container_running(name) for name in names)


def local_primary_role() -> bool | None:
    """Роль локальной базы: True primary, False standby, None — база не запущена.

    None — не ошибка для вернувшегося старого primary: systemd-guard намеренно не
    пускает его PostgreSQL, пока peer остаётся primary. API при этом может работать
    через HAProxy peer, поэтому ensure_local_services не должен просто выходить.
    """
    try:
        return not postgres.is_in_recovery()
    except RuntimeError:
        return None


def ensure_storage_quorum() -> None:
    local_primary = local_primary_role()
    if local_primary is None:
        return
    storage_quorum.ensure(local_primary, postgres.primary_reachable())


def ensure_local_services(state: dict) -> None:
    """Держит API/Caddy живыми на обеих ВМ, а не только после promotion.

    На standby API имеет смысл только после того, как локальный HAProxy направлен
    в primary peer. Если HAProxy обновить не удалось, API не запускаем: иначе он
    попадёт в локальную read-only базу и будет отвечать ошибками записи.

    Если локальный PostgreSQL остановлен (например, вернувшийся старый primary
    заблокирован start-guard), но primary peer доступен, узел всё равно должен
    принимать клиентов: переводим его HAProxy на peer и поднимаем API/Caddy.
    """
    if not START_SERVICES:
        return
    # Пустой локальный каталог вместо общего тома выглядит как рабочая ВМ, но
    # проекты и платформенные ключи в нём отсутствуют. Пока storage не готов,
    # API не поднимаем: storage-guard и таймер перемонтируют том сами.
    if REQUIRE_STORAGE and STORAGE_PATH and not storage_probe(STORAGE_PATH):
        LOG.error("общий storage %s недоступен: API не поднимаю, чтобы не работать с пустыми каталогами", STORAGE_PATH)
        return
    local_primary = local_primary_role()
    if local_primary is None:
        if not postgres.primary_reachable():
            LOG.info("локальный PostgreSQL не запущен и primary peer недоступен; API не поднимаю")
            return
        LOG.warning("локальный PostgreSQL не запущен; API пойдёт через primary %s", PEER_NODE)
        local_primary = False
    elif not local_primary and not postgres.primary_reachable():
        # Peer недоступен: это ещё не повод поднимать API на локальном standby.
        # После fencing/promotion сюда придёт tick с local_primary=True.
        return

    changed = db_proxy.ensure(local_primary)
    if changed is None:
        return

    # После смены цели рвём старые соединения API: пул не должен ходить в прежний primary.
    if changed and container_running(API_CONTAINER):
        restart_api()

    # Флаг services_started переживает выключение ВМ, а broker и Caddy имеют
    # restart=no: Docker после загрузки поднимает только API и runner, и флаг
    # скрывал остановленный ingress. NLB видит Caddy как бэкенд, поэтому
    # проверяем фактическое состояние всех контейнеров, а не только флаг.
    if changed or not all_services_running():
        start_services()
        state["services_started"] = True
        save_state(state)


def stop_api() -> None:
    """Stop only the API container before a planned PostgreSQL handoff.

    The runner and Caddy stay alone; stopping them is not needed to quiesce
    database writes and would make the node lose its other work.
    """
    if not API_CONTAINER or not container_running(API_CONTAINER):
        return
    result = subprocess.run(["docker", "stop", API_CONTAINER], capture_output=True, text=True, timeout=90, check=False)
    if result.returncode != 0:
        raise RuntimeError("docker stop " + API_CONTAINER + ": " + (result.stderr or result.stdout).strip()[:400])


def restart_api() -> None:
    LOG.warning("API не готов после promotion — перезапускаю контейнер %s", API_CONTAINER)
    result = subprocess.run(["docker", "restart", API_CONTAINER], capture_output=True, text=True, timeout=90, check=False)
    if result.returncode != 0:
        LOG.error("docker restart %s: %s", API_CONTAINER, (result.stderr or result.stdout).strip()[:400])


def wait_api(state: dict, timeout: float = 90.0) -> bool:
    # После promotion сначала поднимаем остановленные контейнеры, затем ждём readiness.
    # Иначе контроллер тратит первый timeout на ожидание контейнера, который ещё не запущен.
    if not state.get("services_started"):
        state["services_started"] = True
        save_state(state)
        start_services()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if api_ready():
            return True
        time.sleep(2)
    if not state.get("api_restarted"):
        state["api_restarted"] = True
        save_state(state)
        restart_api()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if api_ready():
                return True
            time.sleep(2)
    return False


def storage_probe(path: str, timeout: float = 5.0) -> bool:
    """Общий том действительно смонтирован и отвечает.

    `os.path.ismount` возвращает True и для мёртвого FUSE-моунта, который отдаёт
    'Transport endpoint is not connected'. Dangling mount опаснее отсутствующего:
    API стартует и видит пустые каталоги вместо данных проектов.
    """
    if not os.path.ismount(path):
        return False
    try:
        result = subprocess.run(
            ["findmnt", "-no", "FSTYPE", "--target", path],
            capture_output=True, text=True, timeout=timeout, check=False,
        )
        if result.stdout.strip() != "fuse.glusterfs":
            return False
    except (OSError, subprocess.SubprocessError):
        return False
    try:
        with os.scandir(path) as entries:
            next(entries, None)
    except OSError:
        return False
    return True


def storage_ready() -> bool:
    if not STORAGE_PATH:
        return True
    if storage_probe(STORAGE_PATH):
        return True
    LOG.error("storage %s не смонтирован или не отвечает: promotion опасен, файлы проектов могут быть пустыми", STORAGE_PATH)
    return not REQUIRE_STORAGE


def dns_pending() -> bool:
    summary = regru.summary()
    for name, addresses in summary.items():
        if DNS_NEW_IP not in addresses or DNS_OLD_IP in addresses:
            LOG.info("DNS %s: %s (нужно %s)", name, addresses or "нет A", DNS_NEW_IP)
            return True
    return False


def ensure_dns(state: dict) -> None:
    if not DNS_ENABLED:
        set_phase(state, "done")
        return
    try:
        if not dns_pending():
            set_phase(state, "done")
            LOG.info("DNS уже указывает на %s", DNS_NEW_IP)
            return
        changed = regru.switch_records(DNS_OLD_IP, DNS_NEW_IP)
        LOG.info("DNS переключён на %s: %s", DNS_NEW_IP, ", ".join(changed) or "без изменений")
        if dns_pending():
            LOG.error("после переключения DNS всё ещё не все записи указывают на %s", DNS_NEW_IP)
            return
        set_phase(state, "done")
    except (regru.RegRuError, OSError) as error:
        LOG.error("DNS не переключён: %s", error)


def finish_failover(state: dict) -> None:
    if not postgres.can_write():
        LOG.error("локальная база после promotion не принимает записи")
        return
    if not wait_api(state):
        LOG.error("API на %s не стал готов после promotion; DNS не переключаю", LOCAL_NODE)
        return
    LOG.info("API на %s готов, база принимает записи", LOCAL_NODE)
    ensure_dns(state)


def switchover_controller() -> switchover.Controller:
    return switchover.Controller(
        local_node=LOCAL_NODE,
        peer_node=PEER_NODE,
        timeout_seconds=SWITCHOVER_TIMEOUT,
        storage_ready=storage_ready,
        ensure_services=ensure_local_services,
        finish=finish_failover,
        stop_api=stop_api,
        set_phase=set_phase,
        save_state=save_state,
    )


def tick(state: dict) -> None:
    # Сначала защищаем общий storage от split-brain, затем поднимаем API.
    ensure_storage_quorum()
    # Планируемое переключение идёт отдельным протоколом: старый primary не
    # считается упавшим и не должен быть выключен MWS-fencing.
    if switchover_controller().tick(state):
        return
    # API должен работать и на standby-узле: база у него одна, но приложение
    # active-active. Поэтому сервисы держим до всех проверок роли.
    ensure_local_services(state)

    local_primary = local_primary_role()
    if local_primary is None:
        LOG.info("локальный PostgreSQL не запущен; promotion не выполняю, API обслуживает %s", PEER_NODE)
        return
    in_recovery = not local_primary

    if state.get("phase") in {"done", "promoted"}:
        # После rejoin этот узел снова standby. Старое состояние done/promoted не должно
        # блокировать следующее переключение в его сторону.
        if in_recovery:
            LOG.info("локальная база снова standby — сбрасываю состояние %s в passive", state.get("phase"))
            state.update({
                "phase": "passive",
                "suspect_since": None,
                "dns_done": False,
                "api_restarted": False,
                "services_started": False,
            })
            save_state(state)
            return
        if state.get("phase") == "promoted":
            finish_failover(state)
        return

    if not in_recovery:
        if state.get("phase") != "passive":
            LOG.info("локальная база на %s уже primary — контроллер пассивен, failback не выполняется", LOCAL_NODE)
        set_phase(state, "passive")
        return

    if postgres.primary_reachable():
        if state.get("phase") != "passive":
            LOG.info("primary %s снова доступен — сбрасываю ожидание", PEER_NODE)
        state["suspect_since"] = None
        set_phase(state, "passive")
        return

    if state.get("phase") == "passive":
        state["suspect_since"] = time.time()
        set_phase(state, "suspect")
        LOG.warning("primary %s недоступен, начинаю отсчёт %.0f с", PEER_NODE, GRACE)
        return

    elapsed = time.time() - float(state.get("suspect_since") or time.time())
    if elapsed < GRACE:
        return

    if state.get("phase") in {"suspect", "fencing"}:
        if not storage_ready():
            return
        set_phase(state, "fencing")
        try:
            vm = mws.vm_state()
        except mws.MwsError as error:
            LOG.error("fencing невозможен, MWS недоступен: %s", error)
            return
        LOG.warning("fencing %s: power=%s", PEER_NODE, vm["power"])
        if vm["power"] != "OFF":
            try:
                mws.power_off()
            except mws.MwsError as error:
                LOG.error("не удалось выключить %s: %s", PEER_NODE, error)
                return
            LOG.warning("MWS подтвердил power=OFF %s", PEER_NODE)
        set_phase(state, "promoting")

    if state.get("phase") != "promoting":
        return

    try:
        if in_recovery:
            LOG.warning("повышаю standby PostgreSQL на %s", LOCAL_NODE)
            postgres.promote()
        if not postgres.wait_for_primary():
            LOG.error("PostgreSQL не вышел из recovery после promote")
            return
    except (RuntimeError, OSError) as error:
        LOG.error("promotion не выполнен: %s", error)
        return

    LOG.warning("PostgreSQL на %s стал primary", LOCAL_NODE)
    state["promoted_at"] = time.time()
    set_phase(state, "promoted")
    ensure_storage_quorum()
    ensure_local_services(state)
    finish_failover(state)


def main() -> int:
    logging.basicConfig(
        stream=sys.stdout,
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )
    state = load_state()
    LOG.info(
        "контроллер запущен: local=%s, peer=%s, pg=%s:%s, storage=%s",
        LOCAL_NODE, PEER_NODE, postgres.PRIMARY_HOST, postgres.PRIMARY_PORT,
        STORAGE_PATH or "не проверяется",
    )
    while True:
        try:
            tick(state)
        except Exception as error:  # noqa: BLE001 - контроллер не должен умирать от одной ошибки
            LOG.exception("ошибка цикла: %s", error)
        time.sleep(INTERVAL)


if __name__ == "__main__":
    raise SystemExit(main())
