import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import status


class StatusSnapshotTests(unittest.TestCase):
    def test_primary_snapshot_has_lag_and_no_secrets(self) -> None:
        with (
            patch.object(status.postgres, "replication_streams", return_value=(1, 123)),
            patch.object(status.postgres, "primary_reachable", return_value=True),
        ):
            value = status.snapshot("node-1", {"phase": "passive", "archive_ready": True}, True)
        self.assertEqual(value["role"], "primary")
        self.assertEqual(value["replicationStreams"], 1)
        self.assertEqual(value["replicationLagBytes"], 123)
        self.assertNotIn("password", json.dumps(value).lower())
        self.assertNotIn("database_url", json.dumps(value).lower())

    def test_standby_snapshot_reports_receiver(self) -> None:
        with (
            patch.object(status.postgres, "wal_receiver_status", return_value="streaming"),
            patch.object(status.postgres, "primary_reachable", return_value=True),
        ):
            value = status.snapshot("node-2", {"phase": "passive"}, False)
        self.assertEqual(value["role"], "standby")
        self.assertEqual(value["walReceiverStatus"], "streaming")

    def test_write_is_atomic_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with (
                patch.object(status, "STATUS_DIR", Path(tmp)),
                patch.object(status.postgres, "replication_streams", return_value=(1, 0)),
                patch.object(status.postgres, "primary_reachable", return_value=True),
            ):
                path = status.write("node-1", {"phase": "passive"}, True)
            self.assertIsNotNone(path)
            value = json.loads(Path(tmp, "ha-status-node-1.json").read_text(encoding="utf-8"))
            self.assertEqual(value["node"], "node-1")
            self.assertEqual(value["role"], "primary")


if __name__ == "__main__":
    unittest.main()
