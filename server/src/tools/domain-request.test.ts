import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_DATA_DIR = await mkdtemp(path.join(tmpdir(), "nestdev-domain-tool-"));

const { saveDomainConnection } = await import("../domains/connections.js");
await import("./domain-tools.js");
const { getTool } = await import("../tool-registry.js");

const now = "2026-10-22T00:00:00.000Z";
const context = { userId: "tool-user", projectId: "project-1" } as never;

function request(input: unknown) {
  const tool = getTool("domain.request");
  assert.ok(tool, "инструмент domain.request должен быть зарегистрирован");
  return tool.execute!(input as Record<string, unknown>, context);
}

test("a change is refused before any network call when the user disabled changes", async () => {
  await saveDomainConnection({
    userId: "tool-user",
    provider: "regru",
    secret: JSON.stringify({ username: "u", password: "p" }),
    account: "u",
    allowWrites: false,
    createdAt: now,
    updatedAt: now,
  });
  const result = await request({ registrar: "regru", path: "zone/add_alias", input: { domains: [{ dname: "example.ru" }], subdomain: "@", ipaddr: "203.0.113.10" } }) as { ok: boolean; blocked?: string; hint?: string };
  assert.equal(result.ok, false);
  assert.equal(result.blocked, "changes_disabled");
  assert.match(result.hint ?? "", /Разрешить агенту изменять ресурсы/);
});

test("покупка и удаление домена запрещены даже при включённых изменениях", async () => {
  await saveDomainConnection({
    userId: "tool-user",
    provider: "regru",
    secret: JSON.stringify({ username: "u", password: "p" }),
    account: "u",
    allowWrites: true,
    createdAt: now,
    updatedAt: now,
  });
  const result = await request({ registrar: "regru", path: "domain/register", input: { domains: [{ dname: "example.ru" }], period: 1 } }) as { ok: boolean; blocked?: string; hint?: string };
  assert.equal(result.ok, false);
  assert.equal(result.blocked, "forbidden");
  assert.match(result.hint ?? "", /только человеком в кабинете/);
});

test("запрет не мешает DNS и настройкам, но закрывает деньги и владение доменом", async () => {
  const { forbiddenRegistrarAction } = await import("../domains/registrar-api.js");
  assert.equal(forbiddenRegistrarAction("regru", { path: "zone/add_alias" }), null);
  assert.equal(forbiddenRegistrarAction("regru", { path: "zone/remove_record" }), null);
  assert.equal(forbiddenRegistrarAction("beget", { path: "dns/changeRecords" }), null);
  assert.ok(forbiddenRegistrarAction("regru", { path: "domain/renew" }));
  assert.ok(forbiddenRegistrarAction("beget", { path: "domain/delete" }));
  assert.ok(forbiddenRegistrarAction("regru", { path: "make_payment" }));
  assert.equal(forbiddenRegistrarAction("timeweb", { path: "/api/v1/domains/example.ru/dns-records", method: "DELETE" }), null);
  assert.ok(forbiddenRegistrarAction("timeweb", { path: "/api/v1/domains", method: "POST" }));
  assert.ok(forbiddenRegistrarAction("timeweb", { path: "/api/v1/domains/example.ru", method: "DELETE" }));
  assert.ok(forbiddenRegistrarAction("timeweb", { path: "/api/v1/domains/example.ru/renew", method: "POST" }));
  assert.ok(forbiddenRegistrarAction("timeweb", { path: "/api/v1/billing/accounts", method: "PATCH" }));
});

test("a change (and everything else) is refused when the cabinet is not connected", async () => {
  const result = await request({ registrar: "beget", path: "dns/changeRecords", input: { fqdn: "example.ru", records: {} } }) as { ok: boolean; blocked?: string; hint?: string };
  assert.equal(result.ok, false);
  assert.equal(result.blocked, "not_connected");
  assert.match(result.hint ?? "", /«Интеграции» → «Домены»/);
});

test("read commands are classified as such, so they never need the switch", async () => {
  const { isReadOnlyRegistrarCall } = await import("../domains/registrar-api.js");
  assert.equal(isReadOnlyRegistrarCall("regru", { path: "zone/get_resource_records" }), true);
  assert.equal(isReadOnlyRegistrarCall("regru", { path: "service/get_list" }), true);
  assert.equal(isReadOnlyRegistrarCall("beget", { path: "dns/getData" }), true);
  assert.equal(isReadOnlyRegistrarCall("regru", { path: "zone/add_alias" }), false);
  assert.equal(isReadOnlyRegistrarCall("regru", { path: "zone/remove_record" }), false);
  assert.equal(isReadOnlyRegistrarCall("beget", { path: "dns/changeRecords" }), false);
  assert.equal(isReadOnlyRegistrarCall("timeweb", { path: "/api/v1/domains/example.ru/dns-records" }), true);
  assert.equal(isReadOnlyRegistrarCall("timeweb", { path: "/api/v1/domains/example.ru/dns-records", method: "POST" }), false);
});
