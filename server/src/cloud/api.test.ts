import { test } from "node:test";
import assert from "node:assert/strict";
import { cloudRequestTarget } from "./api.js";

test("timeweb requests are limited to its versioned API prefix", () => {
  const target = cloudRequestTarget("timeweb", { path: "/api/v1/servers" });
  assert.equal(target.url, "https://api.timeweb.cloud/api/v1/servers");
  assert.throws(() => cloudRequestTarget("timeweb", { path: "/v1/servers" }), /api\/v1/);
});

test("writes are refused before any credential is used", () => {
  assert.throws(() => cloudRequestTarget("timeweb", { method: "POST", path: "/api/v1/servers" }), /только чтение/);
  assert.throws(() => cloudRequestTarget("mws", { method: "DELETE", path: "/rm/v3/projects" }), /только чтение/);
});

test("only provider hosts are accepted", () => {
  assert.equal(cloudRequestTarget("mws", { path: "/rm/v3/projects" }).host, "api.mwsapis.ru");
  assert.throws(() => cloudRequestTarget("mws", { path: "/rm/v3/projects", host: "evil.example" }), /mwsapis/);
  assert.equal(cloudRequestTarget("cloudru", { path: "/v3/projects" }).host, "api.cloud.ru");
  assert.equal(cloudRequestTarget("cloudru", { path: "/v3/projects", host: "vm.api.cloud.ru" }).url, "https://vm.api.cloud.ru/v3/projects");
  assert.throws(() => cloudRequestTarget("cloudru", { path: "/v3/projects", host: "cloud.ru.evil.example" }), /cloud\.ru/);
});

test("traversal and relative paths are rejected", () => {
  assert.throws(() => cloudRequestTarget("timeweb", { path: "api/v1/servers" }), /Некорректный путь/);
  assert.throws(() => cloudRequestTarget("timeweb", { path: "/api/v1/../v1/servers" }), /Некорректный путь/);
});
