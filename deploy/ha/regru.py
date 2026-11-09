"""REG.API 2: переключение A-записей зоны на уцелевший узел.

`zone/update_records` доступен только партнёрам, поэтому замена записи состоит
из двух клиентских команд: `zone/remove_record` и `zone/add_alias`.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

API_URL = "https://api.reg.ru/api/regru2/"
TIMEOUT = int(os.environ.get("REGRU_HTTP_TIMEOUT", "20"))


class RegRuError(RuntimeError):
    pass


def _credentials() -> tuple[str, str]:
    username = os.environ.get("REGRU_USERNAME", "").strip()
    password = os.environ.get("REGRU_PASSWORD", "").strip()
    if not username or not password:
        raise RegRuError("REG.RU не настроен: нужны REGRU_USERNAME и REGRU_PASSWORD")
    return username, password


def call(command: str, input_data: dict) -> dict:
    username, password = _credentials()
    form = urllib.parse.urlencode({
        "username": username,
        "password": password,
        "input_format": "json",
        "output_format": "json",
        "io_encoding": "utf8",
        "input_data": json.dumps(input_data, separators=(",", ":")),
    }).encode()
    request = urllib.request.Request(API_URL + command, data=form, method="POST", headers={
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            payload = json.loads(response.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as error:
        text = error.read().decode("utf-8", "replace")[:600]
        raise RegRuError(f"REG.RU {command}: HTTP {error.code} {text}") from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise RegRuError(f"Нет связи с REG.RU: {error}") from error
    result = str(payload.get("result") or payload.get("status") or "").lower()
    if result != "success":
        raise RegRuError(
            f"REG.RU {command}: {payload.get('error_text') or payload.get('error_code') or json.dumps(payload)[:400]}"
        )
    return payload


def _zone() -> dict:
    return {"dname": os.environ.get("DNS_DOMAIN", "nestdev.ru")}


def a_records() -> list[dict]:
    payload = call("zone/get_resource_records", {"domains": [_zone()]})
    answer = payload.get("answer") or {}
    records = answer.get("records") if isinstance(answer, dict) else None
    if records is None and isinstance(answer, dict):
        # Реальный ответ REG.RU: answer.domains[0].rrs.
        domains = answer.get("domains") or []
        records = (domains[0] or {}).get("rrs") if domains else []
    return [record for record in (records or []) if str(record.get("rectype") or record.get("record_type") or "").upper() == "A"]


def _name(record: dict) -> str:
    value = str(record.get("subname") or record.get("subdomain") or record.get("name") or "").strip()
    return "@" if value in {"", "@"} else value


def _content(record: dict) -> str:
    return str(record.get("content") or record.get("ipaddr") or record.get("value") or "").strip()


def _ttl(record: dict) -> int | None:
    try:
        return int(str(record.get("ttl")).strip())
    except (TypeError, ValueError):
        return None


def _remove(subdomain: str, ipaddr: str) -> None:
    call("zone/remove_record", {
        "domains": [_zone()],
        "subdomain": subdomain,
        "record_type": "A",
        "content": ipaddr,
    })


def _add(subdomain: str, ipaddr: str) -> None:
    call("zone/add_alias", {
        "domains": [_zone()],
        "subdomain": subdomain,
        "ipaddr": ipaddr,
    })


def ensure_ttl(seconds: int) -> None:
    """Понижает TTL зоны, чтобы переключение не ждало часовой кеш."""
    call("zone/update_soa", {"domains": [_zone()], "ttl": str(seconds)})


def _desired_names() -> list[str]:
    raw = os.environ.get("DNS_NAMES", "@,www,host,*.host,*.preview")
    return [name.strip() for name in raw.split(",") if name.strip()]


def switch_records(old_ip: str | None = None, new_ip: str | None = None) -> list[str]:
    """Переводит все A-записи из old_ip на new_ip. Возвращает изменённые имена."""
    old_ip = old_ip or os.environ.get("DNS_OLD_IP", "2.59.82.143")
    new_ip = new_ip or os.environ.get("DNS_NEW_IP", "178.236.27.102")
    changed: list[str] = []
    for _ in range(4):
        records = a_records()
        pending = False
        for name in _desired_names():
            current = [_content(record) for record in records if _name(record) == name]
            if new_ip in current and old_ip not in current:
                continue
            pending = True
            changed.append(name)
            for ipaddr in [ip for ip in current if ip == old_ip]:
                _remove(name, ipaddr)
            if new_ip not in current:
                _add(name, new_ip)
        if not pending:
            break
        # После удаления перечитываем зону: add_alias не должен создать дубль.
        time.sleep(1)
    return sorted(set(changed))


def summary() -> dict:
    records = a_records()
    return {
        name: [_content(record) for record in records if _name(record) == name]
        for name in _desired_names()
    }


def soa_ttl() -> str:
    payload = call("zone/get_resource_records", {"domains": [_zone()]})
    domains = (payload.get("answer") or {}).get("domains") or []
    return str(((domains[0] or {}).get("soa") or {}).get("ttl") or "")
