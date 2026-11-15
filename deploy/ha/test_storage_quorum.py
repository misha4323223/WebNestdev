import sys
import types
import unittest
from unittest.mock import patch

try:  # pragma: no cover - на тестовом хосте может не быть зависимостей MWS
    import mws
    if not hasattr(mws, "MwsError"):
        class _MwsError(RuntimeError):
            pass

        mws.MwsError = _MwsError  # type: ignore[attr-defined]
    if not hasattr(mws, "vm_state"):
        mws.vm_state = lambda: {"power": "ON"}  # type: ignore[attr-defined]
except Exception:  # noqa: BLE001
    _stub = types.ModuleType("mws")

    class _MwsError(RuntimeError):
        pass

    _stub.MwsError = _MwsError
    _stub.vm_state = lambda: {"power": "ON"}
    sys.modules["mws"] = _stub

# discover runs test modules in alphabetical order; test_failover_recovery may have put an
# empty compatibility stub in sys.modules. Import the real module under test in that case.
_stale = sys.modules.get("storage_quorum")
if _stale is not None and not hasattr(_stale, "desired"):
    del sys.modules["storage_quorum"]

import storage_quorum


class StorageQuorumTransitionTests(unittest.TestCase):
    def setUp(self) -> None:
        storage_quorum.reset_for_tests()

    def test_peer_reachable_keeps_quorum(self) -> None:
        self.assertEqual(storage_quorum.desired(True, True), "auto")
        self.assertEqual(storage_quorum.desired(False, True), "auto")

    def test_peer_on_but_unreachable_keeps_write_frozen(self) -> None:
        # Включённый, но недоступный peer — это может быть сетевой разрыв.
        with patch.object(storage_quorum.mws, "vm_state", return_value={"power": "ON"}):
            self.assertEqual(storage_quorum.desired(True, False), "auto")
            self.assertEqual(storage_quorum.desired(False, False), "auto")

    def test_standby_relaxes_quorum_when_peer_is_off(self) -> None:
        # Регрессия: раньше standby возвращал None, quorum оставался auto, и
        # после promotion Gluster отдавал 'no read subvols' — узел не повышался.
        with patch.object(storage_quorum.mws, "vm_state", return_value={"power": "OFF"}):
            self.assertEqual(storage_quorum.desired(False, False), "none")

    def test_primary_relaxes_quorum_when_peer_is_off(self) -> None:
        with patch.object(storage_quorum.mws, "vm_state", return_value={"power": "OFF"}):
            self.assertEqual(storage_quorum.desired(True, False), "none")

    def test_mws_failure_keeps_quorum(self) -> None:
        with patch.object(
            storage_quorum.mws,
            "vm_state",
            side_effect=storage_quorum.mws.MwsError("unavailable"),
        ):
            self.assertEqual(storage_quorum.desired(True, False), "auto")

    def test_ensure_reports_success_when_all_volumes_already_desired(self) -> None:
        with (
            patch.object(storage_quorum, "VOLUMES", ("sandboxes", "sites", "data")),
            patch.object(storage_quorum, "_current", return_value="auto") as current,
            patch.object(storage_quorum, "_set") as set_value,
        ):
            self.assertTrue(storage_quorum.ensure(True, True))

        self.assertEqual(current.call_count, 3)
        set_value.assert_not_called()

    def test_ensure_reports_failure_when_set_fails(self) -> None:
        with (
            patch.object(storage_quorum, "VOLUMES", ("sandboxes",)),
            patch.object(storage_quorum.mws, "vm_state", return_value={"power": "OFF"}),
            patch.object(storage_quorum, "_current", return_value="auto"),
            patch.object(storage_quorum, "_set", return_value=False),
        ):
            self.assertFalse(storage_quorum.ensure(True, False))

    def test_ensure_verifies_value_after_set(self) -> None:
        with (
            patch.object(storage_quorum, "VOLUMES", ("sandboxes",)),
            patch.object(storage_quorum.mws, "vm_state", return_value={"power": "OFF"}),
            patch.object(storage_quorum, "_current", side_effect=["auto", "none"]),
            patch.object(storage_quorum, "_set", return_value=True) as set_value,
        ):
            self.assertTrue(storage_quorum.ensure(False, False))

        set_value.assert_called_once_with("sandboxes", "none")

    def test_failed_result_is_cached_for_the_interval(self) -> None:
        with (
            patch.object(storage_quorum, "VOLUMES", ("sandboxes",)),
            patch.object(storage_quorum.mws, "vm_state", return_value={"power": "OFF"}),
            patch.object(storage_quorum, "_current", return_value="auto"),
            patch.object(storage_quorum, "_set", return_value=False) as set_value,
        ):
            self.assertFalse(storage_quorum.ensure(True, False))
            self.assertFalse(storage_quorum.ensure(True, False))

        set_value.assert_called_once()


if __name__ == "__main__":
    unittest.main()
