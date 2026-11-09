from __future__ import annotations

import os
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

import control


class ControlMailboxTests(unittest.TestCase):
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

    def tearDown(self) -> None:
        for item in reversed(self.patches):
            item.stop()
        self.directory.cleanup()

    def command(self, **changes: object) -> dict:
        value = {
            "id": "op-1",
            "action": "switchover",
            "target": "node-2",
            "state": "requested",
            "createdAt": "2026-11-09T10:00:00Z",
            "updatedAt": "2026-11-09T10:00:00Z",
            "requestedBy": "admin@example.test",
        }
        value.update(changes)
        return value

    def test_write_read_and_update_preserve_the_operation(self) -> None:
        control.write(self.command())
        command = control.read()
        assert command is not None
        self.assertEqual(command["target"], "node-2")

        updated = control.update("op-1", state="target_ready", replayLsn="0/16B6C50")
        assert updated is not None
        self.assertEqual(control.read()["state"], "target_ready")
        self.assertEqual(control.read()["replayLsn"], "0/16B6C50")
        self.assertTrue(control.is_active(control.read()))
        self.assertFalse(control.is_terminal(control.read()))

    def test_update_does_not_touch_a_newer_operation(self) -> None:
        control.write(self.command(id="new"))
        self.assertIsNone(control.update("old", state="promoted"))
        self.assertEqual(control.read()["state"], "requested")

    def test_fail_is_terminal_and_bounded(self) -> None:
        control.write(self.command())
        result = control.fail("op-1", "x" * 600)
        assert result is not None
        self.assertEqual(result["state"], "failed")
        self.assertEqual(len(result["message"]), 500)
        self.assertTrue(control.is_terminal(control.read()))

    def test_age_seconds_parses_utc(self) -> None:
        command = self.command()
        created = datetime.fromisoformat("2026-11-09T10:00:00+00:00").timestamp()
        self.assertEqual(control.age_seconds(command, now=created), 0.0)
        self.assertGreater(control.age_seconds(command, now=created + 60), 59)

    def test_missing_and_corrupt_files_are_explicit(self) -> None:
        self.assertIsNone(control.read())
        self.path.write_text("{not json", encoding="utf-8")
        with self.assertRaises(RuntimeError):
            control.read()


if __name__ == "__main__":
    unittest.main()
