import sys
import types
import unittest
from unittest.mock import patch

# The test host does not need the MWS signing dependency: these modules are only
# imported by failover.py and are replaced by mocks in the tests below.
for _name in ("mws", "regru", "storage_quorum"):
    sys.modules.setdefault(_name, types.ModuleType(_name))

import failover


class RecoveringNodeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.state = {"services_started": False}

    def test_stopped_pg_uses_reachable_primary_peer(self) -> None:
        with (
            patch.object(failover, "START_SERVICES", True),
            patch.object(failover.postgres, "is_in_recovery", side_effect=RuntimeError("pg stopped")),
            patch.object(failover.postgres, "primary_reachable", return_value=True),
            patch.object(failover.db_proxy, "ensure", return_value=True) as ensure,
            patch.object(failover, "container_running", return_value=False),
            patch.object(failover, "start_services") as start,
            patch.object(failover, "save_state"),
        ):
            failover.ensure_local_services(self.state)

        ensure.assert_called_once_with(False)
        start.assert_called_once()
        self.assertTrue(self.state["services_started"])

    def test_stopped_pg_does_not_start_api_without_primary_peer(self) -> None:
        with (
            patch.object(failover, "START_SERVICES", True),
            patch.object(failover.postgres, "is_in_recovery", side_effect=RuntimeError("pg stopped")),
            patch.object(failover.postgres, "primary_reachable", return_value=False),
            patch.object(failover.db_proxy, "ensure") as ensure,
            patch.object(failover, "start_services") as start,
        ):
            failover.ensure_local_services(self.state)

        ensure.assert_not_called()
        start.assert_not_called()

    def test_standby_uses_primary_peer(self) -> None:
        with (
            patch.object(failover, "START_SERVICES", True),
            patch.object(failover.postgres, "is_in_recovery", return_value=True),
            patch.object(failover.postgres, "primary_reachable", return_value=True),
            patch.object(failover.db_proxy, "ensure", return_value=True) as ensure,
            patch.object(failover, "container_running", return_value=False),
            patch.object(failover, "start_services") as start,
            patch.object(failover, "save_state"),
        ):
            failover.ensure_local_services(self.state)

        ensure.assert_called_once_with(False)
        start.assert_called_once()

    def test_running_services_are_not_started_again(self) -> None:
        with (
            patch.object(failover, "START_SERVICES", True),
            patch.object(failover.postgres, "is_in_recovery", return_value=True),
            patch.object(failover.postgres, "primary_reachable", return_value=True),
            patch.object(failover.db_proxy, "ensure", return_value=False),
            patch.object(failover, "container_running", return_value=True),
            patch.object(failover, "start_services") as start,
        ):
            failover.ensure_local_services(self.state)

        start.assert_not_called()

    def test_stopped_broker_is_started_even_when_state_says_services_started(self) -> None:
        # После перезагрузки ВМ Docker поднимает API и runner (restart=unless-stopped),
        # но broker и Caddy с restart=no остаются остановленными, а state.json уже
        # содержит services_started=true.
        self.state = {"services_started": True}
        running = {
            failover.API_CONTAINER: True,
            failover.RUNNER_CONTAINER: True,
            failover.BROKER_CONTAINER: False,
            failover.CADDY_CONTAINER: False,
        }
        with (
            patch.object(failover, "START_SERVICES", True),
            patch.object(failover.postgres, "is_in_recovery", return_value=True),
            patch.object(failover.postgres, "primary_reachable", return_value=True),
            patch.object(failover.db_proxy, "ensure", return_value=False),
            patch.object(failover, "container_running", side_effect=lambda name: running.get(name, False)),
            patch.object(failover, "start_services") as start,
        ):
            failover.ensure_local_services(self.state)

        start.assert_called_once()

    def test_primary_uses_local_database(self) -> None:
        with (
            patch.object(failover, "START_SERVICES", True),
            patch.object(failover.postgres, "is_in_recovery", return_value=False),
            patch.object(failover.db_proxy, "ensure", return_value=True) as ensure,
            patch.object(failover, "container_running", return_value=False),
            patch.object(failover, "start_services"),
            patch.object(failover, "save_state"),
        ):
            failover.ensure_local_services(self.state)

        ensure.assert_called_once_with(True)


class StorageGateTests(unittest.TestCase):
    def test_api_is_not_started_on_unmounted_storage(self) -> None:
        # Пустой локальный каталог вместо общего тома не должен выглядеть как
        # рабочий узел: API поднимается только после перемонтирования.
        with (
            patch.object(failover, "START_SERVICES", True),
            patch.object(failover, "REQUIRE_STORAGE", True),
            patch.object(failover, "STORAGE_PATH", "/var/lib/webnestdev/data"),
            patch.object(failover, "storage_probe", return_value=False),
            patch.object(failover.postgres, "is_in_recovery", return_value=False),
            patch.object(failover, "start_services") as start,
            patch.object(failover, "container_running", return_value=False),
        ):
            failover.ensure_local_services({"services_started": False})

        start.assert_not_called()

    def test_storage_probe_rejects_dangling_mount(self) -> None:
        # Мёртвый FUSE-моунт остаётся mountpoint, но читать его нельзя.
        with (
            patch.object(failover.os.path, "ismount", return_value=True),
            patch.object(failover.subprocess, "run", return_value=type("R", (), {"stdout": "fuse.glusterfs\n"})()),
            patch.object(failover.os, "scandir", side_effect=OSError(107, "Transport endpoint is not connected")),
        ):
            self.assertFalse(failover.storage_probe("/var/lib/webnestdev/data"))


if __name__ == "__main__":
    unittest.main()
