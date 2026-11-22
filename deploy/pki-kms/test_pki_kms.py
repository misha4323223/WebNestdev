"""Тесты подписанта без Yandex: локальный ECDSA-ключ заменяет KMS.

Проверяем именно политику выпуска: фиксированные SAN нод, срок, CA-флаг,
проверку CSR и сборку сертификата. Сетевые вызовы KMS не нужны.
"""

from __future__ import annotations

import base64
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa
from cryptography.x509.oid import NameOID

import pki_kms


class PkiTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.ca_key = ec.generate_private_key(ec.SECP256R1())
        self.ca_public_pem = self.ca_key.public_key().public_bytes(
            serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        ).decode("ascii")
        self.ca_cert = self.dir / "ca.crt"
        self.ca_cert.write_bytes(
            pki_kms._pem(
                pki_kms.build_root_certificate(
                    self.ca_public_pem,
                    self.sign,
                    subject="Test KMS Root CA",
                )
            )
        )

    def sign(self, data: bytes) -> bytes:
        return self.ca_key.sign(data, ec.ECDSA(hashes.SHA256()))

    def make_csr(self, key=None, *, common_name: str = "ignored") -> Path:
        key = key or rsa.generate_private_key(public_exponent=65537, key_size=2048)
        csr = (
            x509.CertificateSigningRequestBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common_name)]))
            .sign(key, hashes.SHA256())
        )
        path = self.dir / "request.csr"
        path.write_bytes(csr.public_bytes(serialization.Encoding.PEM))
        return path

    def build_leaf(self, node: str = "node-1", *, days: int = 90) -> Path:
        csr = self.make_csr()
        der = pki_kms.build_leaf_certificate(
            str(self.ca_cert), str(csr), node, self.sign, days=days
        )
        path = self.dir / f"{node}.crt"
        path.write_bytes(pki_kms._pem(der))
        return path


class CertificateTests(PkiTestBase):
    def test_root_and_leaf_verify(self) -> None:
        leaf = self.build_leaf()
        pki_kms.verify_certificate(str(self.ca_cert), str(leaf))
        cert = x509.load_pem_x509_certificate(leaf.read_bytes())
        self.assertEqual(
            cert.subject.get_attributes_for_oid(NameOID.COMMON_NAME)[0].value,
            "webnestdev-postgres-node-1",
        )
        self.assertEqual(
            cert.issuer.get_attributes_for_oid(NameOID.COMMON_NAME)[0].value,
            "Test KMS Root CA",
        )
        self.assertLessEqual(cert.not_valid_after_utc, datetime.now(timezone.utc) + timedelta(days=91))

    def test_san_is_fixed_for_node(self) -> None:
        leaf = self.build_leaf("node-2")
        cert = x509.load_pem_x509_certificate(leaf.read_bytes())
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        self.assertEqual(
            san.get_values_for_type(x509.IPAddress),
            [
                __import__("ipaddress").ip_address("127.0.0.1"),
                __import__("ipaddress").ip_address("10.0.0.5"),
            ],
        )
        self.assertEqual(
            san.get_values_for_type(x509.DNSName),
            ["host.docker.internal", "localhost"],
        )
        self.assertNotIn("10.0.0.4", [str(value) for value in san])

    def test_csr_subject_is_ignored(self) -> None:
        csr = self.make_csr(common_name="attacker.example")
        der = pki_kms.build_leaf_certificate(
            str(self.ca_cert), str(csr), "node-1", self.sign
        )
        cert = x509.load_der_x509_certificate(der)
        self.assertEqual(
            cert.subject.get_attributes_for_oid(NameOID.COMMON_NAME)[0].value,
            "webnestdev-postgres-node-1",
        )

    def test_rejects_unknown_node(self) -> None:
        csr = self.make_csr()
        with self.assertRaises(pki_kms.PkiError):
            pki_kms.build_leaf_certificate(str(self.ca_cert), str(csr), "node-3", self.sign)

    def test_rejects_leaf_longer_than_90_days(self) -> None:
        csr = self.make_csr()
        with self.assertRaises(pki_kms.PkiError):
            pki_kms.build_leaf_certificate(
                str(self.ca_cert), str(csr), "node-1", self.sign, days=91
            )

    def test_rejects_long_root(self) -> None:
        with self.assertRaises(pki_kms.PkiError):
            pki_kms.build_root_certificate(
                self.ca_public_pem, self.sign, days=pki_kms.MAX_ROOT_DAYS + 1
            )

    def test_rejects_small_rsa_csr(self) -> None:
        key = rsa.generate_private_key(public_exponent=65537, key_size=1024)
        csr = self.make_csr(key)
        with self.assertRaises(pki_kms.PkiError):
            pki_kms.build_leaf_certificate(str(self.ca_cert), str(csr), "node-1", self.sign)

    def test_rejects_invalid_csr_signature(self) -> None:
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        csr = x509.CertificateSigningRequestBuilder().subject_name(
            x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "bad")])
        ).sign(key, hashes.SHA256())
        raw = bytearray(csr.public_bytes(serialization.Encoding.DER))
        raw[-1] ^= 0x01
        path = self.dir / "bad.csr"
        path.write_bytes(bytes(raw))
        with self.assertRaises(pki_kms.PkiError):
            pki_kms.build_leaf_certificate(str(self.ca_cert), str(path), "node-1", self.sign)

    def test_other_ca_does_not_verify(self) -> None:
        leaf = self.build_leaf()
        other = ec.generate_private_key(ec.SECP256R1())
        other_ca = self.dir / "other.crt"
        other_ca.write_bytes(
            pki_kms._pem(
                pki_kms.build_root_certificate(
                    other.public_key().public_bytes(
                        serialization.Encoding.PEM,
                        serialization.PublicFormat.SubjectPublicKeyInfo,
                    ).decode(),
                    lambda data: other.sign(data, ec.ECDSA(hashes.SHA256())),
                    subject="Other Root",
                )
            )
        )
        with self.assertRaises(pki_kms.PkiError):
            pki_kms.verify_certificate(str(other_ca), str(leaf))

    def test_serials_are_unique(self) -> None:
        leaf_a = self.build_leaf("node-1")
        csr = self.make_csr()
        leaf_b = self.dir / "node-1-second.crt"
        leaf_b.write_bytes(
            pki_kms._pem(
                pki_kms.build_leaf_certificate(
                    str(self.ca_cert), str(csr), "node-1", self.sign
                )
            )
        )
        a = x509.load_pem_x509_certificate(leaf_a.read_bytes())
        b = x509.load_pem_x509_certificate(leaf_b.read_bytes())
        self.assertNotEqual(a.serial_number, b.serial_number)


class KmsUnitTests(unittest.TestCase):
    def test_sign_posts_base64_message(self) -> None:
        auth = mock.Mock()
        auth.token.return_value = "iam-token"
        client = pki_kms.KmsClient(key_id="key-1", auth=auth)
        signature = b"\x30\x01\x02"
        with mock.patch.object(
            pki_kms,
            "_http_json",
            return_value={"signature": base64.b64encode(signature).decode("ascii")},
        ) as http:
            result = client.sign(b"hello")
        self.assertEqual(result, signature)
        first, second, third = http.call_args.args
        self.assertEqual(first, "POST")
        self.assertTrue(second.endswith("/key-1:sign"))
        self.assertEqual(third, "iam-token")
        self.assertEqual(base64.b64decode(http.call_args.kwargs["payload"]["message"]), b"hello")

    def test_public_key_rejects_non_pem(self) -> None:
        auth = mock.Mock()
        auth.token.return_value = "iam-token"
        client = pki_kms.KmsClient(key_id="key-1", auth=auth)
        with mock.patch.object(pki_kms, "_http_json", return_value={"publicKey": "nope"}):
            with self.assertRaises(pki_kms.PkiError):
                client.public_key()

    def test_create_key_does_not_require_an_existing_key_id(self) -> None:
        auth = mock.Mock()
        auth.token.return_value = "iam-token"
        client = pki_kms.KmsClient(key_id="", auth=auth)
        with mock.patch.object(
            pki_kms,
            "_http_json",
            side_effect=[{"id": "operation-1"}, {"done": True, "response": {"id": "new-key"}}],
        ):
            self.assertEqual(client.create_key(folder_id="folder-1", name="ca"), "new-key")

    def test_service_account_jwt(self) -> None:
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        pem = key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ).decode("ascii")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sa.json"
            path.write_text(
                json.dumps(
                    {
                        "id": "key-id",
                        "service_account_id": "sa-id",
                        "private_key": pem,
                    }
                )
            )
            auth = pki_kms.IamAuth(sa_key_file=str(path), iam_token=None)
            jwt = auth._make_jwt()
        header_b64, payload_b64, signature_b64 = jwt.split(".")
        decode = lambda value: json.loads(
            base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
        )
        header = decode(header_b64)
        payload = decode(payload_b64)
        self.assertEqual(header["kid"], "key-id")
        self.assertEqual(payload["iss"], "sa-id")
        key.public_key().verify(
            base64.urlsafe_b64decode(signature_b64 + "=" * (-len(signature_b64) % 4)),
            f"{header_b64}.{payload_b64}".encode("ascii"),
            padding.PKCS1v15(),
            hashes.SHA256(),
        )


if __name__ == "__main__":
    unittest.main()
