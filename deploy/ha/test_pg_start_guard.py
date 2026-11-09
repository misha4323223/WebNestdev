import tempfile
import unittest
from pathlib import Path

import pg_start_guard


class EvaluateTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.data = Path(self._tmp.name)
        (self.data / "PG_VERSION").write_text("17\n")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_standby_data_is_allowed(self) -> None:
        (self.data / "standby.signal").write_text("")
        allowed, _ = pg_start_guard.evaluate(self.data, ("10.0.0.4", 5432), "ON", False)
        self.assertTrue(allowed)

    def test_fresh_data_is_allowed(self) -> None:
        (self.data / "PG_VERSION").unlink()
        allowed, _ = pg_start_guard.evaluate(self.data, ("10.0.0.4", 5432), "ON", False)
        self.assertTrue(allowed)

    def test_primary_with_peer_standby_is_allowed(self) -> None:
        allowed, _ = pg_start_guard.evaluate(self.data, ("10.0.0.4", 5432), "ON", True)
        self.assertTrue(allowed)

    def test_primary_with_peer_primary_is_blocked(self) -> None:
        allowed, reason = pg_start_guard.evaluate(self.data, ("10.0.0.4", 5432), "ON", False)
        self.assertFalse(allowed)
        self.assertIn("split-brain", reason)

    def test_primary_with_unknown_peer_and_peer_on_is_blocked(self) -> None:
        allowed, reason = pg_start_guard.evaluate(self.data, ("10.0.0.4", 5432), "ON", None)
        self.assertFalse(allowed)
        self.assertIn("второй primary", reason)

    def test_primary_with_unknown_peer_and_peer_off_is_allowed(self) -> None:
        allowed, _ = pg_start_guard.evaluate(self.data, ("127.0.0.1", 5433), "OFF", None)
        self.assertTrue(allowed)

    def test_primary_without_proxy_or_power_is_blocked(self) -> None:
        allowed, _ = pg_start_guard.evaluate(self.data, None, None, None)
        self.assertFalse(allowed)

    def test_local_proxy_target_is_not_enough(self) -> None:
        allowed, reason = pg_start_guard.evaluate(self.data, ("127.0.0.1", 5433), "ON", None)
        self.assertFalse(allowed)
        self.assertIn("HAProxy", reason)


if __name__ == "__main__":
    unittest.main()
