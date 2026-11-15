import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import db_proxy


class DbProxyRenderTests(unittest.TestCase):
    def test_peer_default_is_postgres_direct_port(self) -> None:
        # HAProxy больше не ходит в HAProxy peer: иначе TLS пришлось бы терминировать
        # на промежуточной ноде или заворачивать дважды.
        self.assertEqual(db_proxy.PEER_PORT, 5433)

    def test_plaintext_render_has_no_ssl(self) -> None:
        text = db_proxy._render("10.0.0.5", 5433, tls=False)
        self.assertIn("server primary 10.0.0.5:5433 check", text)
        self.assertNotIn("ssl", text)

    def test_tls_render_verifies_certificate(self) -> None:
        with patch.object(db_proxy, "TLS_CA", Path("/etc/haproxy/pg-ca.crt")):
            text = db_proxy._render("10.0.0.5", 5433, tls=True)
        self.assertIn(
            "server primary 10.0.0.5:5433 check ssl verify required "
            "ca-file /etc/haproxy/pg-ca.crt",
            text,
        )


class DbProxyEnsureTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.config = self.root / "haproxy.cfg"
        self.ca = self.root / "pg-ca.crt"

    def test_ensure_writes_then_leaves_unchanged(self) -> None:
        with (
            patch.object(db_proxy, "CONFIG_PATH", self.config),
            patch.object(db_proxy, "TLS_CA", self.ca),
            patch.object(db_proxy, "TLS_MODE", "auto"),
            patch.object(db_proxy, "ENABLED", True),
            patch.object(db_proxy, "_ensure_service", return_value=True),
        ):
            self.assertTrue(db_proxy.ensure(True))
            self.assertFalse(db_proxy.ensure(True))

        text = self.config.read_text(encoding="utf-8")
        self.assertIn("server primary 127.0.0.1:5433 check", text)
        self.assertNotIn("ssl", text)

    def test_certificate_appearing_rewrites_same_primary_with_tls(self) -> None:
        # node2-sync сначала ставит HA-код, затем передаёт сертификат. Цель не меняется,
        # но HAProxy обязан перейти на TLS без ожидания следующего failover.
        with (
            patch.object(db_proxy, "CONFIG_PATH", self.config),
            patch.object(db_proxy, "TLS_CA", self.ca),
            patch.object(db_proxy, "TLS_MODE", "auto"),
            patch.object(db_proxy, "ENABLED", True),
            patch.object(db_proxy, "_ensure_service", return_value=True),
        ):
            self.assertTrue(db_proxy.ensure(False))
            self.assertNotIn("ssl", self.config.read_text(encoding="utf-8"))
            self.ca.write_text("test-ca", encoding="utf-8")
            self.assertTrue(db_proxy.ensure(False))

        text = self.config.read_text(encoding="utf-8")
        self.assertIn("server primary 10.0.0.5:5433 check", text)
        self.assertIn("ssl verify required", text)

    def test_current_target_ignores_tls_suffix(self) -> None:
        self.config.write_text(
            "backend pg_servers\n"
            "    server primary 10.0.0.5:5433 check ssl verify required ca-file /etc/haproxy/pg-ca.crt\n",
            encoding="utf-8",
        )
        with patch.object(db_proxy, "CONFIG_PATH", self.config):
            self.assertEqual(db_proxy.current_target(), ("10.0.0.5", 5433))


if __name__ == "__main__":
    unittest.main()
