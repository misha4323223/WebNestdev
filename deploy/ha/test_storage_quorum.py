import sys
import types
import unittest
from unittest.mock import patch

try:  # pragma: no cover - на тестовом хосте может не быть зависимостей MWS
    import mws  # noqa: F401
except Exception:  # noqa: BLE001
    _stub = types.ModuleType("mws")

    class _MwsError(RuntimeError):
        pass

    _stub.MwsError = _MwsError
    _stub.vm_state = lambda: {"power": "ON"}
    sys.modules["mws"] = _stub

import storage_quorum


class StorageQuorumTransitionTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
