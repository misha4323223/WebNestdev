#!/usr/bin/env python3
"""Выпуск X.509 для PostgreSQL через асимметричный ключ Yandex KMS.

Идея разделения:
  * приватный ключ CA никогда не покидает Yandex KMS и не лежит на node-1;
  * этот скрипт запускается на отдельном подписанте (GitHub Actions или машина
    администратора) и умеет только: прочитать публичный ключ, выпустить root CA и
    подписать CSR с фиксированными SAN для node-1/node-2;
  * на нодах остаются только открытый ca.crt и обычные leaf-ключи.

Скрипт намеренно не принимает произвольные расширения из CSR: subject, SAN,
EKU и срок задаёт подписант. Это не даёт превратить подпись произвольного CSR
в новый CA или в сертификат для чужого имени.

Примеры:
  python3 pki_kms.py --kms-key-id <id> --sa-key-file key.json \
      root --out ca.crt --days 3650
  python3 pki_kms.py --kms-key-id <id> --sa-key-file key.json \
      sign --ca-cert ca.crt --csr node-1.csr --node node-1 --out node-1.crt
  python3 pki_kms.py --ca-cert ca.crt verify --cert node-1.crt

Требуются asn1crypto и cryptography (см. requirements.txt).
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Optional

from asn1crypto import algos, keys, x509
from cryptography import x509 as pyx509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa


DEFAULT_KMS_ENDPOINT = "https://kms.api.cloud.yandex.net"
# Криптооперации (:sign) обслуживает data plane kms.yandex; control plane
# kms.api.cloud.yandex.net отвечает на них HTTP 404 без тела.
DEFAULT_KMS_CRYPTO_ENDPOINT = "https://kms.yandex"
DEFAULT_IAM_ENDPOINT = "https://iam.api.cloud.yandex.net"
DEFAULT_OPERATION_ENDPOINT = "https://operation.api.cloud.yandex.net"
KEY_ALGORITHM = "ECDSA_NIST_P256_SHA_256"
SIGNATURE_ALGORITHM = "sha256_ecdsa"

NODE_IPS = {
    "node-1": "10.0.0.4",
    "node-2": "10.0.0.5",
}
DEFAULT_ROOT_SUBJECT = "WebNestDev PostgreSQL Root CA (Yandex KMS)"
LEAF_SUBJECT_PREFIX = "webnestdev-postgres-"
DEFAULT_LEAF_DAYS = 90
MAX_LEAF_DAYS = 90
DEFAULT_ROOT_DAYS = 3650
MAX_ROOT_DAYS = 3650


class PkiError(Exception):
    """Ошибка выпуска или проверки; текст пригоден для пользователя."""


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64decode(value: str) -> bytes:
    try:
        return base64.b64decode(value, validate=True)
    except Exception as exc:  # noqa: BLE001 - сообщение важнее типа
        raise PkiError("KMS вернул некорректный base64") from exc


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _http_json(
    method: str,
    url: str,
    token: Optional[str] = None,
    payload: Optional[dict[str, Any]] = None,
    timeout: float = 30.0,
) -> dict[str, Any]:
    """Небольшой HTTP-клиент без requests, чтобы не тянуть лишнюю зависимость."""
    data = _json_bytes(payload) if payload is not None else None
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout, context=ssl.create_default_context()) as response:
            body = response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:1000]
        raise PkiError(f"{method} {url.split('?', 1)[0]}: HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise PkiError(f"{method} {url.split('?', 1)[0]}: сеть недоступна: {exc.reason}") from exc
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError as exc:
        raise PkiError(f"{method} {url.split('?', 1)[0]}: ответ не JSON") from exc
    if not isinstance(parsed, dict):
        raise PkiError(f"{method} {url.split('?', 1)[0]}: неожидаемый ответ")
    return parsed


class IamAuth:
    """IAM-токен из service account key JSON или готового YC_IAM_TOKEN."""

    def __init__(
        self,
        *,
        sa_key_file: Optional[str],
        iam_token: Optional[str],
        iam_endpoint: str = DEFAULT_IAM_ENDPOINT,
        timeout: float = 30.0,
    ) -> None:
        self._sa_key_file = sa_key_file
        self._static_token = iam_token
        self._iam_endpoint = iam_endpoint.rstrip("/")
        self._timeout = timeout
        self._token: Optional[str] = None
        self._expires_at = 0.0

    def token(self) -> str:
        if self._static_token:
            return self._static_token
        if self._token and time.time() < self._expires_at - 60:
            return self._token
        if not self._sa_key_file:
            raise PkiError(
                "нужен --sa-key-file / YC_SA_KEY_FILE или --iam-token / YC_IAM_TOKEN"
            )
        jwt = self._make_jwt()
        response = _http_json(
            "POST",
            f"{self._iam_endpoint}/iam/v1/tokens",
            payload={"jwt": jwt},
            timeout=self._timeout,
        )
        token = response.get("iamToken")
        if not isinstance(token, str) or not token:
            raise PkiError("IAM не вернул iamToken")
        self._token = token
        expires = response.get("expiresAt")
        if isinstance(expires, str):
            try:
                self._expires_at = datetime.fromisoformat(expires.replace("Z", "+00:00")).timestamp()
            except ValueError:
                self._expires_at = time.time() + 3600
        else:
            self._expires_at = time.time() + 3600
        return token

    def _make_jwt(self) -> str:
        assert self._sa_key_file is not None
        try:
            raw = Path(self._sa_key_file).read_text(encoding="utf-8")
        except OSError as exc:
            raise PkiError(f"не читается service account key: {exc}") from exc
        try:
            key = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise PkiError("service account key — не JSON") from exc
        try:
            key_id = key["id"]
            service_account_id = key["service_account_id"]
            private_key_pem = key["private_key"]
        except (KeyError, TypeError) as exc:
            raise PkiError("в service account key нет id/service_account_id/private_key") from exc
        try:
            private_key = serialization.load_pem_private_key(
                private_key_pem.encode("utf-8"), password=None
            )
        except Exception as exc:  # noqa: BLE001
            raise PkiError("не удалось прочитать private_key из service account key") from exc
        if not isinstance(private_key, rsa.RSAPrivateKey):
            raise PkiError("service account key должен содержать RSA private key")
        now = int(time.time())
        header = {"alg": "PS256", "typ": "JWT", "kid": key_id}
        payload = {
            "iss": service_account_id,
            "aud": f"{self._iam_endpoint}/iam/v1/tokens",
            "iat": now,
            "exp": now + 3600,
        }
        signing_input = f"{_b64url(_json_bytes(header))}.{_b64url(_json_bytes(payload))}".encode("ascii")
        signature = private_key.sign(
            signing_input,
            padding.PSS(
                mgf=padding.MGF1(hashes.SHA256()),
                salt_length=hashes.SHA256().digest_size,
            ),
            hashes.SHA256(),
        )
        return f"{signing_input.decode('ascii')}.{_b64url(signature)}"


class KmsClient:
    def __init__(
        self,
        *,
        key_id: str,
        auth: IamAuth,
        endpoint: str = DEFAULT_KMS_ENDPOINT,
        crypto_endpoint: str = DEFAULT_KMS_CRYPTO_ENDPOINT,
        operation_endpoint: str = DEFAULT_OPERATION_ENDPOINT,
        timeout: float = 30.0,
    ) -> None:
        # create-key не работает с конкретным ключом, поэтому пустой key_id
        # допустим на этапе конструктора; методы ключа проверяют его сами.
        self.key_id = key_id
        self.auth = auth
        self.endpoint = endpoint.rstrip("/")
        self.crypto_endpoint = crypto_endpoint.rstrip("/")
        self.operation_endpoint = operation_endpoint.rstrip("/")
        self.timeout = timeout

    def _path_key(self) -> str:
        if not self.key_id:
            raise PkiError("не задан --kms-key-id / YC_KMS_KEY_ID")
        return urllib.parse.quote(self.key_id, safe="")

    def get_key(self) -> dict[str, Any]:
        return _http_json(
            "GET",
            f"{self.endpoint}/kms/v1/asymmetricSignatureKeys/{self._path_key()}",
            self.auth.token(),
            timeout=self.timeout,
        )

    def public_key(self) -> str:
        response = _http_json(
            "GET",
            f"{self.endpoint}/kms/v1/asymmetricSignatureKeys/{self._path_key()}:getPublicKey",
            self.auth.token(),
            timeout=self.timeout,
        )
        value = response.get("publicKey")
        if not isinstance(value, str) or "PUBLIC KEY" not in value:
            raise PkiError("KMS не вернул publicKey в PEM (SPKI)")
        return value

    def sign(self, message: bytes) -> bytes:
        response = _http_json(
            "POST",
            f"{self.crypto_endpoint}/kms/v1/asymmetricSignatureKeys/{self._path_key()}:sign",
            self.auth.token(),
            payload={"message": base64.b64encode(message).decode("ascii")},
            timeout=self.timeout,
        )
        value = response.get("signature")
        if not isinstance(value, str) or not value:
            raise PkiError("KMS не вернул signature")
        signature = _b64decode(value)
        if not signature:
            raise PkiError("KMS вернул пустую signature")
        return signature

    def create_key(self, *, folder_id: str, name: str, description: str = "") -> str:
        if not folder_id:
            raise PkiError("для create-key нужен --folder-id / YC_FOLDER_ID")
        body: dict[str, Any] = {
            "folderId": folder_id,
            "name": name,
            "signatureAlgorithm": KEY_ALGORITHM,
            "deletionProtection": True,
        }
        if description:
            body["description"] = description
        operation = _http_json(
            "POST",
            f"{self.endpoint}/kms/v1/asymmetricSignatureKeys",
            self.auth.token(),
            payload=body,
            timeout=self.timeout,
        )
        operation_id = operation.get("id")
        if not isinstance(operation_id, str) or not operation_id:
            raise PkiError("KMS не вернул id операции создания ключа")
        result = self._wait_operation(operation_id)
        key_id = result.get("id")
        if not isinstance(key_id, str) or not key_id:
            metadata = result.get("metadata") or {}
            key_id = metadata.get("asymmetricSignatureKeyId") if isinstance(metadata, dict) else None
        if not isinstance(key_id, str) or not key_id:
            raise PkiError("операция создания ключа завершилась без id ключа")
        return key_id

    def _wait_operation(self, operation_id: str) -> dict[str, Any]:
        url = f"{self.operation_endpoint}/operations/{urllib.parse.quote(operation_id, safe='')}"
        deadline = time.time() + 120
        while time.time() < deadline:
            result = _http_json("GET", url, self.auth.token(), timeout=self.timeout)
            if result.get("done"):
                error = result.get("error")
                if error:
                    raise PkiError(f"операция KMS завершилась ошибкой: {error}")
                response = result.get("response")
                if isinstance(response, dict):
                    return response
                metadata = result.get("metadata")
                if isinstance(metadata, dict):
                    return metadata
                return {}
            time.sleep(2)
        raise PkiError("истекло время ожидания операции KMS")


def _load_public_key(pem: str) -> tuple[Any, bytes]:
    try:
        public_key = serialization.load_pem_public_key(pem.encode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise PkiError("не удалось прочитать публичный ключ KMS") from exc
    if not isinstance(public_key, ec.EllipticCurvePublicKey):
        raise PkiError("KMS-ключ должен быть асимметричным ECDSA (P-256)")
    if not isinstance(public_key.curve, ec.SECP256R1):
        raise PkiError("поддерживается только ECDSA P-256 (secp256r1)")
    spki = public_key.public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    return public_key, spki


def _read_cert(path: str) -> pyx509.Certificate:
    try:
        data = Path(path).read_bytes()
    except OSError as exc:
        raise PkiError(f"не читается {path}: {exc}") from exc
    try:
        return pyx509.load_pem_x509_certificate(data)
    except ValueError:
        try:
            return pyx509.load_der_x509_certificate(data)
        except ValueError as exc:
            raise PkiError(f"{path} — не сертификат") from exc


def _read_csr(path: str) -> pyx509.CertificateSigningRequest:
    try:
        data = Path(path).read_bytes()
    except OSError as exc:
        raise PkiError(f"не читается {path}: {exc}") from exc
    try:
        return pyx509.load_pem_x509_csr(data)
    except ValueError:
        try:
            return pyx509.load_der_x509_csr(data)
        except ValueError as exc:
            raise PkiError(f"{path} — не CSR") from exc


def _check_csr(csr: pyx509.CertificateSigningRequest) -> None:
    try:
        valid = csr.is_signature_valid
    except ValueError as exc:
        raise PkiError("CSR подписан неподдерживаемым алгоритмом") from exc
    if not valid:
        raise PkiError("подпись CSR не проходит проверку")
    public_key = csr.public_key()
    if isinstance(public_key, rsa.RSAPublicKey):
        if public_key.key_size < 2048:
            raise PkiError("RSA-ключ CSR меньше 2048 бит")
        return
    if isinstance(public_key, ec.EllipticCurvePublicKey):
        if not isinstance(public_key.curve, (ec.SECP256R1, ec.SECP384R1)):
            raise PkiError("EC-ключ CSR должен быть P-256 или P-384")
        return
    raise PkiError("CSR должен содержать RSA или EC public key")


def _asn1_time(value: datetime) -> x509.Time:
    if value.year < 1950 or value.year >= 2050:
        return x509.Time({"general_time": value})
    return x509.Time({"utc_time": value})


def _serial() -> int:
    # 127 бит: положительное число и достаточно энтропии для уникальности.
    value = int.from_bytes(os.urandom(16), "big") & ((1 << 127) - 1)
    return value or 1


def _extensions(*items: x509.Extension) -> x509.Extensions:
    return x509.Extensions(list(items))


def _basic_constraints(*, ca: bool) -> x509.Extension:
    return x509.Extension(
        {
            "extn_id": "basic_constraints",
            "critical": True,
            "extn_value": x509.BasicConstraints(
                {"ca": ca, "path_len_constraint": 0 if ca else None}
            ),
        }
    )


def _key_usage(*, ca: bool) -> x509.Extension:
    usage = (
        {"key_cert_sign", "crl_sign", "digital_signature"}
        if ca
        else {"digital_signature", "key_encipherment"}
    )
    return x509.Extension(
        {"extn_id": "key_usage", "critical": True, "extn_value": x509.KeyUsage(usage)}
    )


def _leaf_sans(node: str) -> x509.GeneralNames:
    ip = NODE_IPS[node]
    return x509.GeneralNames(
        [
            x509.GeneralName({"dns_name": "host.docker.internal"}),
            x509.GeneralName({"dns_name": "localhost"}),
            x509.GeneralName({"ip_address": "127.0.0.1"}),
            x509.GeneralName({"ip_address": ip}),
        ]
    )


def _build_tbs(
    *,
    serial: int,
    issuer: x509.Name,
    subject: x509.Name,
    spki: bytes,
    not_before: datetime,
    not_after: datetime,
    extensions: x509.Extensions,
) -> x509.TbsCertificate:
    return x509.TbsCertificate(
        {
            "version": "v3",
            "serial_number": serial,
            "signature": algos.SignedDigestAlgorithm({"algorithm": SIGNATURE_ALGORITHM}),
            "issuer": issuer,
            "validity": x509.Validity(
                {
                    "not_before": _asn1_time(not_before),
                    "not_after": _asn1_time(not_after),
                }
            ),
            "subject": subject,
            "subject_public_key_info": keys.PublicKeyInfo.load(spki),
            "extensions": extensions,
        }
    )


def _build_certificate(tbs: x509.TbsCertificate, sign_func: Callable[[bytes], bytes]) -> bytes:
    signature = sign_func(tbs.dump())
    if not signature:
        raise PkiError("подписант вернул пустую подпись")
    certificate = x509.Certificate(
        {
            "tbs_certificate": tbs,
            "signature_algorithm": algos.SignedDigestAlgorithm({"algorithm": SIGNATURE_ALGORITHM}),
            "signature_value": signature,
        }
    )
    der = certificate.dump()
    # Проверяем, что из DER действительно собирается сертификат, а не только ASN.1.
    pyx509.load_der_x509_certificate(der)
    return der


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _validate_days(days: int, *, maximum: int, label: str) -> None:
    if not isinstance(days, int) or days < 1 or days > maximum:
        raise PkiError(f"{label}: срок должен быть от 1 до {maximum} дней")


def build_root_certificate(
    public_key_pem: str,
    sign_func: Callable[[bytes], bytes],
    *,
    subject: str = DEFAULT_ROOT_SUBJECT,
    days: int = DEFAULT_ROOT_DAYS,
) -> bytes:
    _validate_days(days, maximum=MAX_ROOT_DAYS, label="root")
    _public_key, spki = _load_public_key(public_key_pem)
    name = x509.Name.build({"common_name": subject})
    now = _now()
    tbs = _build_tbs(
        serial=_serial(),
        issuer=name,
        subject=name,
        spki=spki,
        not_before=now - timedelta(minutes=5),
        not_after=now + timedelta(days=days),
        extensions=_extensions(
            _basic_constraints(ca=True),
            _key_usage(ca=True),
        ),
    )
    return _build_certificate(tbs, sign_func)


def build_leaf_certificate(
    ca_cert_path: str,
    csr_path: str,
    node: str,
    sign_func: Callable[[bytes], bytes],
    *,
    days: int = DEFAULT_LEAF_DAYS,
) -> bytes:
    _validate_days(days, maximum=MAX_LEAF_DAYS, label="leaf")
    if node not in NODE_IPS:
        raise PkiError(f"неизвестная нода: {node}")
    ca = _read_cert(ca_cert_path)
    try:
        ca_asn1 = x509.Certificate.load(ca.public_bytes(serialization.Encoding.DER))
    except Exception as exc:  # noqa: BLE001
        raise PkiError("не удалось разобрать CA-сертификат") from exc
    if not ca_asn1["tbs_certificate"]["extensions"]:
        raise PkiError("у CA-сертификата нет расширений")
    try:
        ca_basic = ca.extensions.get_extension_for_class(pyx509.BasicConstraints).value
    except pyx509.ExtensionNotFound as exc:
        raise PkiError("у CA-сертификата нет basicConstraints") from exc
    if not ca_basic.ca:
        raise PkiError("CA-сертификат не помечен как CA")

    csr = _read_csr(csr_path)
    _check_csr(csr)
    spki = csr.public_key().public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    issuer = ca_asn1["tbs_certificate"]["subject"]
    subject = x509.Name.build({"common_name": f"{LEAF_SUBJECT_PREFIX}{node}"})
    now = _now()
    tbs = _build_tbs(
        serial=_serial(),
        issuer=issuer,
        subject=subject,
        spki=spki,
        not_before=now - timedelta(minutes=5),
        not_after=now + timedelta(days=days),
        extensions=_extensions(
            _basic_constraints(ca=False),
            _key_usage(ca=False),
            x509.Extension(
                {
                    "extn_id": "extended_key_usage",
                    "critical": False,
                    "extn_value": x509.ExtKeyUsageSyntax(["server_auth"]),
                }
            ),
            x509.Extension(
                {
                    "extn_id": "subject_alt_name",
                    "critical": False,
                    "extn_value": _leaf_sans(node),
                }
            ),
        ),
    )
    return _build_certificate(tbs, sign_func)


def verify_certificate(ca_cert_path: str, cert_path: str) -> None:
    ca = _read_cert(ca_cert_path)
    leaf = _read_cert(cert_path)
    try:
        leaf.verify_directly_issued_by(ca)
    except (ValueError, InvalidSignature) as exc:
        raise PkiError("сертификат не подписан этим CA или цепочка неверна") from exc
    if leaf.not_valid_before_utc > _now():
        raise PkiError("сертификат ещё не действует")
    if leaf.not_valid_after_utc < _now():
        raise PkiError("сертификат истёк")


def _write(path: str, data: bytes, mode: int = 0o644) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    os.chmod(target, mode)


def _pem(der: bytes) -> bytes:
    return pyx509.load_der_x509_certificate(der).public_bytes(serialization.Encoding.PEM)


def _fingerprint(cert_path: str) -> str:
    cert = _read_cert(cert_path)
    return cert.fingerprint(hashes.SHA256()).hex().upper()


def _print_cert_info(path: str) -> None:
    cert = _read_cert(path)
    sans: list[str] = []
    try:
        sans = [str(name.value) for name in cert.extensions.get_extension_for_class(
            pyx509.SubjectAlternativeName
        ).value]
    except pyx509.ExtensionNotFound:
        pass
    print(f"cert: {path}")
    print(f"subject: {cert.subject.rfc4514_string()}")
    print(f"issuer: {cert.issuer.rfc4514_string()}")
    print(f"not_before: {cert.not_valid_before_utc.isoformat()}")
    print(f"not_after: {cert.not_valid_after_utc.isoformat()}")
    print(f"sha256: {_fingerprint(path)}")
    if sans:
        print("san: " + ", ".join(sans))


def _client_from_args(args: argparse.Namespace) -> KmsClient:
    auth = IamAuth(
        sa_key_file=args.sa_key_file,
        iam_token=args.iam_token,
        iam_endpoint=args.iam_endpoint,
        timeout=args.timeout,
    )
    return KmsClient(
        key_id=args.kms_key_id or "",
        auth=auth,
        endpoint=args.kms_endpoint,
        crypto_endpoint=args.kms_crypto_endpoint,
        operation_endpoint=args.operation_endpoint,
        timeout=args.timeout,
    )


def cmd_root(args: argparse.Namespace) -> int:
    client = _client_from_args(args)
    public_key = client.public_key()
    der = build_root_certificate(
        public_key,
        client.sign,
        subject=args.subject,
        days=args.days,
    )
    _write(args.out, _pem(der), 0o644)
    verify_certificate(args.out, args.out)
    _print_cert_info(args.out)
    return 0


def cmd_sign(args: argparse.Namespace) -> int:
    client = _client_from_args(args)
    der = build_leaf_certificate(
        args.ca_cert,
        args.csr,
        args.node,
        client.sign,
        days=args.days,
    )
    _write(args.out, _pem(der), 0o644)
    verify_certificate(args.ca_cert, args.out)
    _print_cert_info(args.out)
    return 0


def cmd_verify(args: argparse.Namespace) -> int:
    verify_certificate(args.ca_cert, args.cert)
    print("verify: OK")
    _print_cert_info(args.cert)
    return 0


def cmd_public_key(args: argparse.Namespace) -> int:
    client = _client_from_args(args)
    pem = client.public_key()
    _write(args.out, pem.encode("ascii"), 0o644)
    print(f"public key: {args.out}")
    return 0


def cmd_show_key(args: argparse.Namespace) -> int:
    client = _client_from_args(args)
    key = client.get_key()
    print(f"key_id: {key.get('id', args.kms_key_id)}")
    print(f"signature_algorithm: {key.get('signatureAlgorithm', 'unknown')}")
    print(f"status: {key.get('status', 'unknown')}")
    return 0


def cmd_create_key(args: argparse.Namespace) -> int:
    client = _client_from_args(args)
    key_id = client.create_key(
        folder_id=args.folder_id or "",
        name=args.name,
        description=args.description,
    )
    if args.out_key_id:
        _write(args.out_key_id, f"{key_id}\n".encode("ascii"), 0o644)
    print(f"key_id: {key_id}")
    print("Роль подписанта: kms.asymmetricSignatureKeys.signer")
    print("Роль чтения публичного ключа: kms.asymmetricSignatureKeys.publicKeyViewer")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="X.509 для PostgreSQL через Yandex KMS (приватный ключ CA не на нодах)",
    )
    parser.add_argument("--kms-key-id", default=os.getenv("YC_KMS_KEY_ID"))
    parser.add_argument("--sa-key-file", default=os.getenv("YC_SA_KEY_FILE"))
    parser.add_argument("--iam-token", default=os.getenv("YC_IAM_TOKEN"))
    parser.add_argument("--kms-endpoint", default=os.getenv("YC_KMS_ENDPOINT", DEFAULT_KMS_ENDPOINT))
    parser.add_argument(
        "--kms-crypto-endpoint",
        default=os.getenv("YC_KMS_CRYPTO_ENDPOINT", DEFAULT_KMS_CRYPTO_ENDPOINT),
    )
    parser.add_argument("--iam-endpoint", default=os.getenv("YC_IAM_ENDPOINT", DEFAULT_IAM_ENDPOINT))
    parser.add_argument(
        "--operation-endpoint",
        default=os.getenv("YC_OPERATION_ENDPOINT", DEFAULT_OPERATION_ENDPOINT),
    )
    parser.add_argument("--timeout", type=float, default=30.0)
    sub = parser.add_subparsers(dest="command", required=True)

    root = sub.add_parser("root", help="выпустить новый root CA из публичного ключа KMS")
    root.add_argument("--out", required=True)
    root.add_argument("--subject", default=DEFAULT_ROOT_SUBJECT)
    root.add_argument("--days", type=int, default=DEFAULT_ROOT_DAYS)
    root.set_defaults(func=cmd_root)

    sign = sub.add_parser("sign", help="подписать CSR листа для node-1/node-2")
    sign.add_argument("--ca-cert", required=True)
    sign.add_argument("--csr", required=True)
    sign.add_argument("--node", required=True, choices=sorted(NODE_IPS))
    sign.add_argument("--out", required=True)
    sign.add_argument("--days", type=int, default=DEFAULT_LEAF_DAYS)
    sign.set_defaults(func=cmd_sign)

    verify = sub.add_parser("verify", help="проверить сертификат против CA")
    verify.add_argument("--ca-cert", required=True)
    verify.add_argument("--cert", required=True)
    verify.set_defaults(func=cmd_verify)

    public = sub.add_parser("public-key", help="сохранить публичный ключ KMS")
    public.add_argument("--out", required=True)
    public.set_defaults(func=cmd_public_key)

    show = sub.add_parser("show-key", help="показать метаданные ключа KMS")
    show.set_defaults(func=cmd_show_key)

    create = sub.add_parser("create-key", help="создать асимметричный ключ KMS")
    create.add_argument("--folder-id", default=os.getenv("YC_FOLDER_ID"))
    create.add_argument("--name", default="webnestdev-pg-root-ca")
    create.add_argument("--description", default="PostgreSQL root CA for WebNestDev")
    create.add_argument("--out-key-id")
    create.set_defaults(func=cmd_create_key)

    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except PkiError as exc:
        print(f"pki-kms: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
