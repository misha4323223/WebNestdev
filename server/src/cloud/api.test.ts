import { test } from "node:test";
import assert from "node:assert/strict";
import { assertWritesAllowed, cloudRequestTarget, needsWriteConsent } from "./api.js";
import { assertNoBillingChange, isBillingPath } from "../security/billing-guard.js";

test("timeweb requests are limited to its versioned API prefix", () => {
  const target = cloudRequestTarget("timeweb", { path: "/api/v1/servers" });
  assert.equal(target.url, "https://api.timeweb.cloud/api/v1/servers");
  assert.throws(() => cloudRequestTarget("timeweb", { path: "/v1/servers" }), /api\/v1/);
});

test("methods the provider can answer are accepted, unknown ones are not", () => {
  assert.equal(cloudRequestTarget("timeweb", { method: "POST", path: "/api/v1/servers" }).method, "POST");
  assert.equal(cloudRequestTarget("mws", { method: "DELETE", path: "/rm/v3/projects" }).method, "DELETE");
  assert.throws(() => cloudRequestTarget("timeweb", { method: "TRACE", path: "/api/v1/servers" }), /не поддерживается/);
});

test("changes need the user's permission, reads never do", () => {
  assert.equal(needsWriteConsent("GET"), false);
  assert.equal(needsWriteConsent("head"), false);
  assert.equal(needsWriteConsent("POST"), true);
  assert.equal(needsWriteConsent("DELETE"), true);
  assert.doesNotThrow(() => assertWritesAllowed("GET", false));
  assert.doesNotThrow(() => assertWritesAllowed("POST", true));
  assert.throws(() => assertWritesAllowed("POST", false), /Разрешить агенту изменять ресурсы/);
  assert.throws(() => assertWritesAllowed("delete", false), /выключены/);
});

test("биллинг и тарифы читаются, но меняются только человеком", () => {
  assert.equal(isBillingPath("/api/v1/billing/accounts"), true);
  assert.equal(isBillingPath("/api/v1/payments"), true);
  assert.equal(isBillingPath("/api/v1/servers"), false);
  assert.doesNotThrow(() => assertNoBillingChange("GET", "/api/v1/billing/accounts"));
  assert.doesNotThrow(() => assertNoBillingChange("POST", "/api/v1/servers"));
  assert.throws(() => assertNoBillingChange("PATCH", "/api/v1/billing/accounts"), /только человеком/);
  assert.throws(() => assertNoBillingChange("POST", "/api/v1/payments"), /только человеком/);
});

test("only provider hosts are accepted", () => {
  // `/rm` живёт на iam, а не на каталоге api: иначе живой API отвечает
  // `404 No static resource rm/v3/projects`.
  assert.equal(cloudRequestTarget("mws", { path: "/rm/v3/projects" }).host, "iam.mwsapis.ru");
  assert.equal(cloudRequestTarget("mws", { path: "/compute/v1/projects/p/virtualMachines" }).host, "compute.mwsapis.ru");
  assert.equal(cloudRequestTarget("mws", { path: "/vpc/v1/networks" }).host, "vpc.mwsapis.ru");
  assert.equal(cloudRequestTarget("mws", { path: "/rm/v3/projects", host: "compute.mwsapis.ru" }).host, "compute.mwsapis.ru");
  assert.throws(() => cloudRequestTarget("mws", { path: "/v3/projects" }), /endpoint/);
  assert.throws(() => cloudRequestTarget("mws", { path: "/rm/v3/projects", host: "api.mwsapis.ru" }), /каталог эндпоинтов/);
  assert.throws(() => cloudRequestTarget("mws", { path: "/rm/v3/projects", host: "evil.example" }), /mwsapis/);
  assert.equal(cloudRequestTarget("cloudru", { path: "/v3/projects" }).host, "api.cloud.ru");
  assert.equal(cloudRequestTarget("cloudru", { path: "/v3/projects", host: "vm.api.cloud.ru" }).url, "https://vm.api.cloud.ru/v3/projects");
  assert.throws(() => cloudRequestTarget("cloudru", { path: "/v3/projects", host: "cloud.ru.evil.example" }), /cloud\.ru/);
});

test("reg.ru cloud keeps its own host and the /v1 prefix", () => {
  const target = cloudRequestTarget("regru", { path: "/v1/reglets" });
  assert.equal(target.url, "https://api.cloudvps.reg.ru/v1/reglets");
  assert.equal(target.host, "api.cloudvps.reg.ru");
  assert.throws(() => cloudRequestTarget("regru", { path: "/reglets" }), /\/v1\//);
  assert.throws(() => cloudRequestTarget("regru", { path: "/v1/reglets", host: "evil.example" }), /api\.cloudvps\.reg\.ru/);
  assert.equal(cloudRequestTarget("regru", { method: "POST", path: "/v1/reglets" }).url, "https://api.cloudvps.reg.ru/v1/reglets");
});

test("traversal and relative paths are rejected", () => {
  assert.throws(() => cloudRequestTarget("timeweb", { path: "api/v1/servers" }), /Некорректный путь/);
  assert.throws(() => cloudRequestTarget("timeweb", { path: "/api/v1/../v1/servers" }), /Некорректный путь/);
});
