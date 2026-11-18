"""Тесты политики failover клиентской базы: без сети, без psql, без systemd."""

from __future__ import annotations

import importlib.util
import pathlib
import unittest

MODULE_PATH = pathlib.Path(__file__).with_name("failover.py")
SPEC = importlib.util.spec_from_file_location("client_db_failover", MODULE_PATH)
assert SPEC and SPEC.loader
failover = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(failover)


class DecideTest(unittest.TestCase):
    def test_primary_always_keeps_role(self):
        self.assertEqual(failover.decide("primary", "primary", True, 5, 2), "keep")
        self.assertEqual(failover.decide("primary", "unreachable", True, 0, 2), "keep")

    def test_standby_with_live_primary_never_promotes(self):
        self.assertEqual(failover.decide("standby", "primary", True, 99, 2), "reset")

    def test_unhealthy_local_waits(self):
        self.assertEqual(failover.decide("standby", "unreachable", False, 3, 2), "wait")
        self.assertEqual(failover.decide("down", "unreachable", False, 3, 2), "wait")

    def test_peer_standby_or_unknown_never_promotes(self):
        self.assertEqual(failover.decide("standby", "standby", True, 9, 1), "wait")
        self.assertEqual(failover.decide("standby", "unknown", True, 9, 1), "wait")

    def test_needs_two_confirmations_by_default(self):
        self.assertEqual(failover.decide("standby", "unreachable", True, 0, 2), "count")
        self.assertEqual(failover.decide("standby", "unreachable", True, 1, 2), "promote")

    def test_single_confirmation_when_configured(self):
        self.assertEqual(failover.decide("standby", "unreachable", True, 0, 1), "promote")

    def test_more_confirmations_delay_promotion(self):
        self.assertEqual(failover.decide("standby", "unreachable", True, 1, 3), "count")
        self.assertEqual(failover.decide("standby", "unreachable", True, 2, 3), "promote")

    def test_peer_returning_primary_resets_counter(self):
        self.assertEqual(failover.decide("standby", "primary", True, 2, 3), "reset")

    def test_auth_error_is_not_treated_as_dead_peer(self):
        # Ошибка pg_hba/пароля не должна приводить к promotion: это «unknown», а не «unreachable».
        self.assertEqual(failover.decide("standby", "unknown", True, 0, 1), "wait")
        self.assertTrue(failover.UNREACHABLE_MARKERS.search("could not connect to server: Connection refused"))
        self.assertFalse(failover.UNREACHABLE_MARKERS.search('password authentication failed for user "x"'))


if __name__ == "__main__":
    unittest.main()
