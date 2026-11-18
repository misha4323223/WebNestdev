import assert from "node:assert/strict";
import test from "node:test";
import { clientDatabaseUrl, maskClientDatabaseUrl } from "./service.js";

const config = { host: "db.nestdev.ru", port: 6432, database: "app", ssl: true };

test("строка подключения собирается с TLS и экранирует пароль", () => {
  const url = clientDatabaseUrl(config, "tenant_x", "a/b+c=");
  assert.equal(url, "postgres://tenant_x:a%2Fb%2Bc%3D@db.nestdev.ru:6432/app?sslmode=require");
});

test("без TLS строка короче, но адрес тот же", () => {
  assert.equal(
    clientDatabaseUrl({ ...config, ssl: false }, "tenant_x", "password_password"),
    "postgres://tenant_x:password_password@db.nestdev.ru:6432/app",
  );
});

test("маска скрывает пароль и не содержит строки подключения", () => {
  const masked = maskClientDatabaseUrl(config, "tenant_x");
  assert.equal(masked, "postgres://tenant_x:***@db.nestdev.ru:6432/app");
  assert.doesNotMatch(masked, /sslmode/);
});
