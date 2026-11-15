import unittest
from unittest.mock import patch

import pitr


class PitrTests(unittest.TestCase):
    def setUp(self) -> None:
        pitr.reset_for_tests()
        self.retry = patch.object(pitr, "RETRY_SECONDS", 0)
        self.retry.start()

    def tearDown(self) -> None:
        self.retry.stop()
        pitr.reset_for_tests()

    def test_archive_ready_accepts_on_and_always_and_rejects_disabled(self) -> None:
        self.assertTrue(pitr.archive_ready(("on", "cp %p /archive/%f")))
        self.assertTrue(pitr.archive_ready(("always", "cp %p /archive/%f")))
        self.assertFalse(pitr.archive_ready(("off", "cp %p /archive/%f")))
        self.assertFalse(pitr.archive_ready(("on", "(disabled)")))
        self.assertFalse(pitr.archive_ready(None))

    def test_standby_enables_archive_without_restart_when_setup_applies(self) -> None:
        with (
            patch.object(pitr.postgres, "is_in_recovery", return_value=True),
            patch.object(pitr, "archive_status", side_effect=[("off", "(disabled)"), ("on", "cp %p /archive/%f")]),
            patch.object(pitr, "_run_setup", return_value=True) as setup,
            patch.object(pitr, "_restart_standby") as restart,
        ):
            self.assertTrue(pitr.ensure_standby_archive())

        setup.assert_called_once()
        restart.assert_not_called()

    def test_standby_restarts_once_when_archive_mode_needs_restart(self) -> None:
        with (
            patch.object(pitr.postgres, "is_in_recovery", return_value=True),
            patch.object(
                pitr,
                "archive_status",
                side_effect=[("off", "(disabled)"), ("off", "cp %p /archive/%f"), ("on", "cp %p /archive/%f")],
            ),
            patch.object(pitr, "_run_setup", return_value=True),
            patch.object(pitr, "_restart_standby", return_value=True) as restart,
        ):
            self.assertTrue(pitr.ensure_standby_archive())

        restart.assert_called_once()

    def test_standby_does_not_restart_when_setup_failed(self) -> None:
        with (
            patch.object(pitr.postgres, "is_in_recovery", return_value=True),
            patch.object(pitr, "archive_status", return_value=("off", "(disabled)")),
            patch.object(pitr, "_run_setup", return_value=False),
            patch.object(pitr, "_restart_standby") as restart,
        ):
            self.assertFalse(pitr.ensure_standby_archive())

        restart.assert_not_called()

    def test_standby_does_not_restart_if_promoted_during_setup(self) -> None:
        with (
            patch.object(pitr.postgres, "is_in_recovery", side_effect=[True, False]),
            patch.object(pitr, "archive_status", return_value=("off", "(disabled)")),
            patch.object(pitr, "_run_setup", return_value=True),
            patch.object(pitr, "_restart_standby") as restart,
        ):
            self.assertFalse(pitr.ensure_standby_archive())

        restart.assert_not_called()

    def test_standby_returns_false_when_restart_fails(self) -> None:
        with (
            patch.object(pitr.postgres, "is_in_recovery", return_value=True),
            patch.object(pitr, "archive_status", side_effect=[("off", "(disabled)"), ("off", "cp %p /archive/%f")]),
            patch.object(pitr, "_run_setup", return_value=True),
            patch.object(pitr, "_restart_standby", return_value=False),
        ):
            self.assertFalse(pitr.ensure_standby_archive())

    def test_standby_does_nothing_when_archive_is_ready(self) -> None:
        with (
            patch.object(pitr.postgres, "is_in_recovery", return_value=True),
            patch.object(pitr, "archive_status", return_value=("on", "cp %p /archive/%f")),
            patch.object(pitr, "_run_setup") as setup,
            patch.object(pitr, "_restart_standby") as restart,
        ):
            self.assertTrue(pitr.ensure_standby_archive())

        setup.assert_not_called()
        restart.assert_not_called()

    def test_primary_setup_is_checked_but_never_restarted(self) -> None:
        with (
            patch.object(pitr.postgres, "is_in_recovery", return_value=False),
            patch.object(pitr, "archive_status", side_effect=[("off", "(disabled)"), ("off", "cp %p /archive/%f")]),
            patch.object(pitr, "_run_setup", return_value=True) as setup,
            patch.object(pitr, "_restart_standby") as restart,
        ):
            self.assertFalse(pitr.ensure_primary_archive())

        setup.assert_called_once()
        restart.assert_not_called()

    def test_primary_is_ready_after_setup_without_restart(self) -> None:
        with (
            patch.object(pitr.postgres, "is_in_recovery", return_value=False),
            patch.object(pitr, "archive_status", side_effect=[("off", "(disabled)"), ("on", "cp %p /archive/%f")]),
            patch.object(pitr, "_run_setup", return_value=True),
            patch.object(pitr, "_restart_standby") as restart,
        ):
            self.assertTrue(pitr.ensure_primary_archive())

        restart.assert_not_called()

    def test_primary_is_not_configured_when_local_pg_is_standby(self) -> None:
        with (
            patch.object(pitr.postgres, "is_in_recovery", return_value=True),
            patch.object(pitr, "archive_status") as status,
            patch.object(pitr, "_run_setup") as setup,
        ):
            self.assertFalse(pitr.ensure_primary_archive())

        status.assert_not_called()
        setup.assert_not_called()

    def test_unknown_status_does_not_change_database(self) -> None:
        with (
            patch.object(pitr.postgres, "is_in_recovery", return_value=True),
            patch.object(pitr, "archive_status", return_value=None),
            patch.object(pitr, "_run_setup") as setup,
            patch.object(pitr, "_restart_standby") as restart,
        ):
            self.assertFalse(pitr.ensure_standby_archive())

        setup.assert_not_called()
        restart.assert_not_called()


if __name__ == "__main__":
    unittest.main()
