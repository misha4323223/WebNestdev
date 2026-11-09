"""MWS Compute API: IAM-токен сервисного аккаунта и питание ВМ.

Ключ читается из MWS_SA_KEY_ID + MWS_SA_PRIVATE_KEY (те же имена, что у сервера),
поэтому отдельный формат конфигурации не нужен. Подпись — ES256, `kid` — имя
авторизованного ключа, `sub` — сервисный аккаунт; IAM принимает подписанный JWT
в заголовке Authorization без префикса `Bearer`.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

IAM_HOST = os.environ.get("MWS_IAM_HOST", "iam.mwsapis.ru")
COMPUTE_HOST = "compute.mwsapis.ru"
TOKEN_PATH = "/iam/v2/tokens/:issueServiceAccountToken"
DEFAULT_VM_PATH = "/compute/v1/projects/project-pimashin2015/virtualMachines/node-2"
VM_PATH = os.environ.get("MWS_VM_PATH", DEFAULT_VM_PATH)
HTTP_TIMEOUT = int(os.environ.get("MWS_HTTP_TIMEOUT", "20"))
JWT_TTL_SECONDS = 3600

_KEY_ID = re.compile(r"^projects/([^/]+)/serviceAccounts/([^/]+)/authorizedKeys/([^/]+)$")

_token_cache: dict[str, object] = {"value": None, "expires_at": 0.0}


class MwsError(RuntimeError):
    """Ошибка MWS с понятным текстом; секреты в сообщение не попадают."""


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _private_key():
    key_id = os.environ.get("MWS_SA_KEY_ID", "").strip()
    private_value = os.environ.get("MWS_SA_PRIVATE_KEY", "").strip()
    if not key_id or not private_value:
        raise MwsError("MWS не настроен: нужны MWS_SA_KEY_ID и MWS_SA_PRIVATE_KEY")
    match = _KEY_ID.match(key_id)
    if not match:
        raise MwsError("MWS_SA_KEY_ID не похож на projects/<проект>/serviceAccounts/<аккаунт>/authorizedKeys/<ключ>")
    project, account, key_name = match.groups()
    try:
        if "BEGIN" in private_value:
            key = serialization.load_pem_private_key(private_value.encode("utf-8"), password=None)
        else:
            key = serialization.load_der_private_key(base64.b64decode(private_value), password=None)
    except Exception as error:  # noqa: BLE001 - причину важно показать целиком
        raise MwsError("MWS_SA_PRIVATE_KEY не читается как ключ ES256: " + str(error)) from error
    if not isinstance(key, ec.EllipticCurvePrivateKey) or not isinstance(key.curve, ec.SECP256R1):
        raise MwsError("MWS_SA_PRIVATE_KEY должен быть эллиптическим ключом P-256 (ES256)")
    return key, project, account, key_name


def _signed_jwt() -> str:
    key, project, account, key_name = _private_key()
    now = int(time.time())
    header = _b64url(json.dumps({"alg": "ES256", "typ": "JWT", "kid": key_name}, separators=(",", ":")).encode())
    payload = _b64url(json.dumps({
        "sub": f"projects/{project}/serviceAccounts/{account}",
        "iat": now,
        "exp": now + JWT_TTL_SECONDS,
    }, separators=(",", ":")).encode())
    signing_input = header + "." + payload
    der = key.sign(signing_input.encode("ascii"), ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der)
    raw = r.to_bytes(32, "big") + s.to_bytes(32, "big")
    return signing_input + "." + _b64url(raw)


def _http(method: str, host: str, path: str, token: str | None, body: object | None = None) -> dict:
    data = None if body is None else json.dumps(body, separators=(",", ":")).encode()
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request("https://" + host + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT) as response:
            text = response.read().decode("utf-8", "replace")
            return {"status": response.status, "body": json.loads(text) if text else None, "text": text}
    except urllib.error.HTTPError as error:
        text = error.read().decode("utf-8", "replace")[:800]
        raise MwsError(f"MWS {method} {host}{path}: HTTP {error.code} {text}") from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise MwsError(f"Нет связи с MWS {host}: {error}") from error


def iam_token() -> str:
    cached = _token_cache["value"]
    if cached and float(_token_cache["expires_at"]) - 60 > time.time():
        return str(cached)
    key, project, account, _ = _private_key()
    query = urllib.parse.urlencode({"serviceAccount": f"projects/{project}/serviceAccounts/{account}"})
    request = urllib.request.Request(
        "https://" + IAM_HOST + TOKEN_PATH + "?" + query,
        headers={"Authorization": _signed_jwt(), "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT) as response:
            payload = json.loads(response.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as error:
        text = error.read().decode("utf-8", "replace")[:800]
        raise MwsError(f"MWS IAM отклонил ключ: HTTP {error.code} {text}") from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise MwsError(f"Нет связи с MWS IAM: {error}") from error
    token = payload.get("accessToken") or payload.get("iamToken")
    if not token:
        raise MwsError("MWS IAM не выдал accessToken: " + json.dumps(payload)[:300])
    expires = payload.get("expirationTs") or payload.get("expiresAt")
    try:
        expires_at = time.mktime(time.strptime(expires[:19], "%Y-%m-%dT%H:%M:%S")) if expires else time.time() + JWT_TTL_SECONDS
    except ValueError:
        expires_at = time.time() + JWT_TTL_SECONDS
    _token_cache.update(value=token, expires_at=expires_at)
    del key
    return token


def _compute(method: str, path: str, body: object | None = None) -> dict:
    result = _http(method, COMPUTE_HOST, path, iam_token(), body)
    payload = result["body"]
    if not isinstance(payload, dict):
        raise MwsError("MWS Compute вернул не объект: " + str(result["text"])[:300])
    return payload


def vm_state(vm_path: str | None = None) -> dict:
    """`power` — ON/OFF, `etag` нужен для POST, `status` — исходный ответ MWS."""
    path = vm_path or VM_PATH
    state = _compute("GET", path)
    hardware = (state.get("status") or {}).get("hardware") or {}
    power = str(hardware.get("power") or "").upper()
    etag = (state.get("metadata") or {}).get("etag")
    if not power:
        raise MwsError("MWS не вернул status.hardware.power для " + path)
    if not etag:
        raise MwsError("MWS не вернул metadata.etag для " + path)
    return {"power": power, "etag": etag, "status": state.get("status") or {}}


def set_power(power: str) -> dict:
    """Переводит ВМ в ON/OFF и ждёт подтверждения фактического состояния."""
    desired = power.upper()
    if desired not in {"ON", "OFF"}:
        raise MwsError("Недопустимое питание: " + power)
    state = vm_state()
    if state["power"] == desired:
        return state
    _compute("POST", VM_PATH, {
        "metadata": {"etag": state["etag"]},
        "spec": {"hardware": {"power": desired}},
    })
    deadline = time.monotonic() + int(os.environ.get("MWS_POWER_TIMEOUT", "180"))
    last = state["power"]
    while time.monotonic() < deadline:
        time.sleep(2)
        last = vm_state()["power"]
        if last == desired:
            return vm_state()
    raise MwsError(f"MWS не подтвердил power={desired} за отведённое время (сейчас {last})")


def power_off() -> dict:
    return set_power("OFF")
