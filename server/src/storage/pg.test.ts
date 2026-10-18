import test from "node:test";
import assert from "node:assert/strict";
import { assertStorageConfigured } from "./pg.js";

test("известные бэкенды проходят проверку", () => {
  assert.doesNotThrow(() => assertStorageConfigured("json", undefined));
  assert.doesNotThrow(() => assertStorageConfigured("postgres", "postgres://localhost/db"));
});

test("старое значение ydb останавливает старт вместо тихого JSON", () => {
  assert.throws(() => assertStorageConfigured("ydb", undefined), /not a known backend/);
  assert.throws(() => assertStorageConfigured("", undefined), /not a known backend/);
});

test("postgres без DATABASE_URL не стартует", () => {
  assert.throws(() => assertStorageConfigured("postgres", undefined), /DATABASE_URL is required/);
});
