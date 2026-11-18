import assert from "node:assert/strict";
import test from "node:test";
import { clientDatabaseConfig, describeClientDatabase } from "./config.js";

const ENV = {
  CLIENT_DB_ADMIN_URL: "postgres://admin:secret@127.0.0.1:5433/app",
  CLIENT_DB_PUBLIC_HOST: "db.nestdev.ru",
};

test("без обоих адресов фича выключена", () => {
  assert.equal(clientDatabaseConfig({}), null);
  assert.equal(clientDatabaseConfig({ CLIENT_DB_ADMIN_URL: ENV.CLIENT_DB_ADMIN_URL }), null);
  assert.equal(clientDatabaseConfig({ CLIENT_DB_PUBLIC_HOST: ENV.CLIENT_DB_PUBLIC_HOST }), null);
});

test("по умолчанию порт PgBouncer 6432, база app и TLS включён", () => {
  const config = clientDatabaseConfig(ENV);
  assert.ok(config);
  assert.equal(config.port, 6432);
  assert.equal(config.database, "app");
  assert.equal(config.ssl, true);
});

test("настройки можно переопределить, TLS выключается только явным нулём", () => {
  const config = clientDatabaseConfig({
    ...ENV,
    CLIENT_DB_PORT: "5433",
    CLIENT_DB_NAME: "tenants",
    CLIENT_DB_SSL: "0",
  });
  assert.equal(config?.port, 5433);
  assert.equal(config?.database, "tenants");
  assert.equal(config?.ssl, false);
  assert.equal(clientDatabaseConfig({ ...ENV, CLIENT_DB_SSL: "false" })?.ssl, true);
});

test("кривой административный адрес и хост со схемой отклоняются", () => {
  assert.throws(() => clientDatabaseConfig({ ...ENV, CLIENT_DB_ADMIN_URL: "mysql://x" }));
  assert.throws(() => clientDatabaseConfig({ ...ENV, CLIENT_DB_PUBLIC_HOST: "https://db.nestdev.ru" }));
});

test("описание для лога не содержит пароля и полной строки", () => {
  const text = describeClientDatabase(clientDatabaseConfig(ENV));
  assert.match(text, /db\.nestdev\.ru:6432\/app/);
  assert.doesNotMatch(text, /secret/);
  assert.doesNotMatch(text, /postgres:\/\//);
  assert.match(describeClientDatabase(null), /выключена/);
});
