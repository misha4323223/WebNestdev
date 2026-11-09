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


if __name__ == "__main__":
    unittest.main()
