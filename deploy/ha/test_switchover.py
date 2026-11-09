from __future__ import annotations

import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import control
import switchover


def iso_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class SwitchoverTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "ha-switchover.json"
        self.patches = [
            patch.object(control, "CONTROL_PATH", self.path),
            patch.object(control, "LOCK_PATH", Path(str(self.path) + ".lock")),
            patch.object(control, "CONTROL_UID", os.getuid()),
            patch.object(control, "CONTROL_GID", os.getgid()),
        ]
        for item in self.patches:
            item.start()
        self.stop_api = 0
        self.finish = 0
        self.ensure = 0

    def tearDown(self) -> None:
        for item in reversed(self.patches):
            item.stop()
        self.directory.cleanup()

    def controller(self, local: str, peer: str = "node-2") -> switchover.Controller:
        return switchover.Controller(
            local_node=local,
            peer_node=peer,
            timeout_seconds=180,
            storage_ready=lambda: True,
            ensure_services=lambda _state: setattr(self, "ensure", self.ensure + 1),
            finish=lambda _state: setattr(self, "finish", self.finish + 1),
            stop_api=lambda: setattr(self, "stop_api", self.stop_api + 1),
            set_phase=lambda _state, _phase: None,
            save_state=lambda _state: None,
        )

    def command(self, **changes: object) -> dict:
        value = {
            "id": "op-1",
            "action": "switchover",
            "target": "node-2",
            "state": "requested",
            "createdAt": iso_now(),
            "updatedAt": iso_now(),
            "requestedBy": "admin@example.test",
        }
        value.update(changes)
        return value

    def test_target_advertises_replay_lsn_when_it_is_a_streaming_standby(self) -> None:
        control.write(self.command())
        with (
            patch.object(switchover.postgres, "is_in_recovery", return_value=True),
            patch.object(switchover.postgres, "primary_reachable", return_value=True),
            patch.object(switchover.postgres, "wal_receiver_status", return_value="streaming"),
            patch.object(switchover.postgres, "replay_lsn", return_value="0/16B6C50"),
        ):
            self.assertTrue(self.controller("node-2", peer="node-1").tick({}))

        command = control.read()
        assert command is not None
        self.assertEqual(command["state"], "target_ready")
        self.assertEqual(command["replayLsn"], "0/16B6C50")

    def test_target_refuses_to_advertise_when_not_a_standby(self) -> None:
        control.write(self.command())
        with patch.object(switchover.postgres, "is_in_recovery", return_value=False):
            self.assertTrue(self.controller("node-2", peer="node-1").tick({}))

        self.assertEqual(control.read()["state"], "failed")

    def test_source_stops_api_then_postgres_only_after_lsn_catch_up(self) -> None:
        control.write(self.command(state="target_ready", replayLsn="0/16B6C50"))
        stopped = {"value": False}

        def stop_postgres() -> None:
            stopped["value"] = True

        def recovery() -> bool:
            if stopped["value"]:
                raise RuntimeError("PostgreSQL остановлен")
            return False

        with (
            patch.object(switchover.postgres, "is_in_recovery", side_effect=recovery),
            patch.object(switchover.postgres, "current_lsn", return_value="0/16B6C50"),
            patch.object(switchover.postgres, "lsn_diff", return_value=0),
            patch.object(switchover.postgres, "stop", side_effect=stop_postgres),
        ):
            self.assertTrue(self.controller("node-1", peer="node-2").tick({}))
            self.assertEqual(self.stop_api, 1)
            self.assertFalse(stopped["value"])
            self.assertEqual(control.read()["state"], "target_ready")
            self.assertIn("apiStoppedAt", control.read())

            self.assertTrue(self.controller("node-1", peer="node-2").tick({}))
            self.assertTrue(stopped["value"])
            self.assertEqual(control.read()["state"], "source_stopped")

    def test_source_waits_while_target_is_behind(self) -> None:
        control.write(self.command(state="target_ready", replayLsn="0/16B6C50"))
        with (
            patch.object(switchover.postgres, "is_in_recovery", return_value=False),
            patch.object(switchover.postgres, "current_lsn", return_value="0/16B6D00"),
            patch.object(switchover.postgres, "lsn_diff", return_value=176),
            patch.object(switchover.postgres, "stop") as stop,
        ):
            self.assertTrue(self.controller("node-1").tick({}))

        self.assertEqual(self.stop_api, 0)
        stop.assert_not_called()
        self.assertEqual(control.read()["state"], "target_ready")

    def test_target_promotes_only_after_source_stopped(self) -> None:
        control.write(self.command(state="source_stopped"))
        with (
            patch.object(switchover.postgres, "is_in_recovery", return_value=True),
            patch.object(switchover.postgres, "promote") as promote,
            patch.object(switchover.postgres, "wait_for_primary", return_value=True),
        ):
            self.assertTrue(self.controller("node-2", peer="node-1").tick({}))

        promote.assert_called_once()
        self.assertEqual(self.finish, 1)
        self.assertEqual(control.read()["state"], "promoted")

    def test_source_rolls_back_after_failed_target(self) -> None:
        control.write(self.command(state="failed"))
        with (
            patch.object(switchover.postgres, "is_in_recovery", side_effect=RuntimeError("stopped")),
            patch.object(switchover.postgres, "wait_for_primary", return_value=True),
            patch.object(switchover.postgres, "start") as start,
        ):
            self.assertFalse(self.controller("node-1").tick({}))

        start.assert_called_once()
        self.assertEqual(control.read()["state"], "rolled_back")

    def test_corrupt_control_pauses_failover_instead_of_fencing(self) -> None:
        self.path.write_text("{broken", encoding="utf-8")
        self.assertTrue(self.controller("node-1").tick({}))

    def test_unrelated_operation_does_not_pause_the_node(self) -> None:
        control.write(self.command(target="other-node"))
        with patch.object(switchover.postgres, "is_in_recovery", return_value=False):
            self.assertTrue(self.controller("node-1").tick({}))
        self.assertEqual(control.read()["state"], "failed")


if __name__ == "__main__":
    unittest.main()
