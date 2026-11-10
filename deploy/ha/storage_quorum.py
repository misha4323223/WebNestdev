"""Кворум GlusterFS без третьей ВМ.

Replica 2 сам по себе не умеет отличить «сосед выключен» от «сосед жив, но сеть
порвалась». Пока живы оба узла, тому и другому разрешена запись; при разделении
сети копии могут разойтись.

Здесь используется server-side quorum GlusterFS:

- оба узла доступны → `cluster.quorum-type auto`: для записи нужны оба brick;
- один узел недоступен и MWS подтвердил его `power=OFF` → `none`: оставшийся узел
  работает один, но только после внешнего fencing;
- узел недоступен, но MWS говорит `power=ON` или сам MWS недоступен → `auto`:
  запись замораживается, чтобы не получить split-brain.

Это временная замена witness-ВМ. Когда появится третья машина, её arbiter
заменит ручное переключение quorum.
"""

from __future__ import annotations

import os
import subprocess
import time

import mws

VOLUMES = [name.strip() for name in os.environ.get("HA_STORAGE_VOLUMES", "sandboxes,sites,data").split(",") if name.strip()]
ENABLED = os.environ.get("HA_STORAGE_QUORUM", "1") == "1"
CHECK_INTERVAL = float(os.environ.get("HA_STORAGE_QUORUM_INTERVAL", "30"))
_last_check = 0.0
_last_desired: str | None = None


def _run(*args: str, timeout: int = 20) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)


def _current(volume: str) -> str | None:
    result = _run("gluster", "volume", "get", volume, "cluster.quorum-type")
    if result.returncode != 0:
        return None
    for line in result.stdout.splitlines():
        fields = line.split()
        if fields and fields[0] == "cluster.quorum-type":
            return fields[-1].strip().lower()
    return None


def _set(volume: str, value: str) -> bool:
    result = _run("gluster", "volume", "set", volume, "cluster.quorum-type", value)
    if result.returncode != 0:
        print(
            f"[storage-quorum] {volume}: не удалось выставить {value}: "
            + (result.stderr or result.stdout).strip()[:300],
            flush=True,
        )
        return False
    return True


def desired(local_primary: bool, peer_reachable: bool) -> str:
    if peer_reachable:
        return "auto"
    try:
        power = str(mws.vm_state().get("power") or "").upper()
    except mws.MwsError as error:
        print(f"[storage-quorum] MWS недоступен, запись остаётся под quorum: {error}", flush=True)
        return "auto"
    # Если peer включён, но не отвечает — это может быть сетевая изоляция.
    # Разрешать запись в одиночку в этом состоянии нельзя.
    if power != "OFF":
        return "auto"
    # Peer подтверждённо выключен, второй brick недоступен не из-за сети.
    # quorum снимается и на standby: иначе после promotion клиент Gluster
    # получает 'Client-quorum is not met / no read subvols', проверка storage
    # не проходит и узел не повышается. Пока узел standby, приложение в него
    # не пишет, а второй копии нет — split-brain невозможен.
    if not local_primary:
        print("[storage-quorum] peer power=OFF: снимаю quorum, чтобы standby мог читать storage при promotion", flush=True)
    return "none"


def ensure(local_primary: bool, peer_reachable: bool) -> None:
    global _last_check, _last_desired
    if not ENABLED or not VOLUMES:
        return
    now = time.monotonic()
    target = desired(local_primary, peer_reachable)
    if target is None:
        return
    # MWS/gluster не дёргаем каждые 5 секунд; роль меняется редко.
    if target == _last_desired and now - _last_check < CHECK_INTERVAL:
        return
    _last_check = now
    _last_desired = target
    for volume in VOLUMES:
        try:
            if _current(volume) == target:
                continue
            if _set(volume, target):
                print(f"[storage-quorum] {volume}: cluster.quorum-type={target}", flush=True)
        except (OSError, subprocess.SubprocessError) as error:
            # gluster CLI может зависнуть на мёртвом моунте/сети. Это не повод
            # ронять весь цикл failover: promotion решит storage_ready().
            print(f"[storage-quorum] {volume}: ошибка gluster CLI: {error}", flush=True)
