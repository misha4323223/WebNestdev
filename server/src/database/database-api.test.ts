import test from "node:test";
import assert from "node:assert/strict";
import { buildDatabaseUrl, checkDatabaseReachable, maskDatabaseUrl, parseDatabaseUrl } from "./database-api.js";
import { envVariables, mergeEnvFile } from "./env-file.js";

test("parses the connection string a Yandex Cloud console shows", () => {
  const parts = parseDatabaseUrl("postgresql://user1:P%40ss@rc1a-abc.mdb.yandexcloud.net:6432/store?sslmode=require");
  assert.equal(parts.scheme, "postgresql");
  assert.equal(parts.host, "rc1a-abc.mdb.yandexcloud.net");
  assert.equal(parts.port, 6432);
  assert.equal(parts.database, "store");
  assert.equal(parts.username, "user1");
  assert.equal(parts.password, "P@ss");
  assert.equal(parts.ssl, true);
});

test("falls back to the engine's default port and detects redis TLS", () => {
  assert.equal(parseDatabaseUrl("postgres://u:p@db.internal/store").port, 5432);
  assert.equal(parseDatabaseUrl("mongodb+srv://u:p@cluster.example.net/store").port, 27017);
  assert.equal(parseDatabaseUrl("rediss://u:p@cache.internal/0").ssl, true);
});

test("rejects unsupported schemes and incomplete strings", () => {
  assert.throws(() => parseDatabaseUrl("oracle://u:p@host/x"), /Поддерживаются PostgreSQL/);
  assert.throws(() => parseDatabaseUrl("db.internal:5432/store"), /начинаться со схемы/);
  assert.throws(() => parseDatabaseUrl("postgresql://u:p@host"), /имени базы данных/);
  assert.throws(() => parseDatabaseUrl(""), /Вставьте строку подключения/);
});

test("builds a connection string from separate fields", () => {
  const url = buildDatabaseUrl({
    scheme: "postgres",
    host: "rc1a-abc.mdb.yandexcloud.net",
    port: 6432,
    database: "store",
    username: "user1",
    password: "p@ss word",
    ssl: true,
  });
  assert.equal(url, "postgres://user1:p%40ss%20word@rc1a-abc.mdb.yandexcloud.net:6432/store?sslmode=require");
  assert.deepEqual(parseDatabaseUrl(url), {
    scheme: "postgres",
    host: "rc1a-abc.mdb.yandexcloud.net",
    port: 6432,
    database: "store",
    username: "user1",
    password: "p@ss word",
    ssl: true,
  });
});

test("the status form never contains the password", () => {
  const parts = parseDatabaseUrl("postgresql://user1:topsecret@db.internal:5432/store");
  const masked = maskDatabaseUrl(parts);
  assert.equal(masked, "postgresql://user1:***@db.internal:5432/store");
  assert.equal(masked.includes("topsecret"), false);
});

test("a closed port is reported as refused instead of an empty error", async () => {
  const result = await checkDatabaseReachable({ host: "127.0.0.1", port: 1 }, 2000);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /порт закрыт|не удалось подключиться/);
});

test("the metadata address is never probed", async () => {
  const result = await checkDatabaseReachable({ host: "169.254.169.254", port: 80 }, 2000);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /недоступен/);
});

test("env variables follow the engine", () => {
  assert.deepEqual(envVariables("postgres", "postgres://x"), { DATABASE_URL: "postgres://x" });
  assert.deepEqual(envVariables("mongodb", "mongodb://x"), { DATABASE_URL: "mongodb://x", MONGODB_URI: "mongodb://x" });
  assert.equal(envVariables("redis", "redis://x").REDIS_URL, "redis://x");
  assert.equal(envVariables("grpcs", "grpcs://endpoint/ru-central1/id").YDB_CONNECTION_STRING, "grpcs://endpoint/ru-central1/id");
});

test("a Serverless YDB endpoint is accepted as a connection string", () => {
  const parts = parseDatabaseUrl("grpcs://ydb.serverless.yandexcloud.net:2135/ru-central1/b1g0example");
  assert.equal(parts.scheme, "grpcs");
  assert.equal(parts.host, "ydb.serverless.yandexcloud.net");
  assert.equal(parts.port, 2135);
  assert.equal(parts.database, "ru-central1/b1g0example");
  assert.equal(parts.ssl, true);
});

test("merging keeps unrelated lines and replaces our own key", () => {
  const existing = "# app settings\nPORT=3000\nDATABASE_URL=postgres://old\n";
  const merged = mergeEnvFile(existing, { DATABASE_URL: "postgres://new" });
  assert.equal(merged, "# app settings\nPORT=3000\nDATABASE_URL=postgres://new\n");
});

test("merging into an empty or missing file writes just our keys", () => {
  assert.equal(mergeEnvFile("", { DATABASE_URL: "postgres://new" }), "DATABASE_URL=postgres://new\n");
  assert.equal(
    mergeEnvFile("PORT=3000", { DATABASE_URL: "postgres://new", MONGODB_URI: "postgres://new" }),
    "PORT=3000\nDATABASE_URL=postgres://new\nMONGODB_URI=postgres://new\n",
  );
});
