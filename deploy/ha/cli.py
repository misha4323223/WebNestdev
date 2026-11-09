"""Операции failover-контроллера: status, dns-switch, power, promote, api.

Секреты берет из окружения (systemd EnvironmentFile или `set -a; . ...`).
"""

from __future__ import annotations

import json
import subprocess
import sys

import mws
import postgres
import regru


def status() -> None:
    print("MWS power:", mws.vm_state()["power"])
    print("PG in recovery:", postgres.is_in_recovery())
    print("PG writable:", postgres.can_write())
    print("node-2 PG reachable:", postgres.primary_reachable())
    print("DNS SOA TTL:", regru.soa_ttl())
    print("DNS:", json.dumps(regru.summary(), ensure_ascii=False))
    result = subprocess.run(
        ["curl", "-fsS", "-m", "5", "-o", "/dev/null", "-w", "%{http_code}", "http://127.0.0.1:8787/api/ready"],
        capture_output=True, text=True, check=False,
    )
    print("API /api/ready:", result.stdout.strip() or "error")


def main(argv: list[str]) -> int:
    if not argv:
        status()
        return 0
    command = argv[0]
    if command == "status":
        status()
    elif command == "dns-switch":
        print("changed:", ", ".join(regru.switch_records()) or "none")
        print(json.dumps(regru.summary(), ensure_ascii=False))
    elif command == "dns-ttl":
        regru.ensure_ttl(int(argv[1]))
        print("soa ttl:", regru.soa_ttl())
    elif command == "dns-list":
        for record in regru.a_records():
            print(regru._name(record), "->", regru._content(record))
    elif command == "dns-add":
        regru._add(argv[1], argv[2])
        print(json.dumps(regru.summary(), ensure_ascii=False))
    elif command == "dns-remove":
        regru._remove(argv[1], argv[2])
        print(json.dumps(regru.summary(), ensure_ascii=False))
    elif command == "power":
        print("power:", mws.set_power(argv[1])["power"])
    elif command == "promote":
        postgres.promote()
        print("primary:", postgres.wait_for_primary())
    else:
        print("usage: cli.py [status|dns-list|dns-switch|dns-ttl N|dns-add NAME IP|dns-remove NAME IP|power ON|OFF|promote]")
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
