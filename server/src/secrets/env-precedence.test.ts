import test from "node:test";
import assert from "node:assert/strict";
import { productionEnvValues } from "./env-precedence.js";

test("production читает .env, .env.production, .env.local и .env.production.local по старшинству", () => {
  const values = productionEnvValues({
    ".env": { API_URL: "https://dev.example", SHARED: "base" },
    ".env.production": { API_URL: "https://prod.example", SHARED: "prod" },
    ".env.local": { SHARED: "local" },
    ".env.production.local": { SECRET: "only-here" },
    // Режим разработки на боевом сайте не нужен.
    ".env.development": { SHARED: "dev", DEBUG: "1" },
  });
  assert.equal(values.API_URL, "https://prod.example", ".env.production перекрывает .env");
  assert.equal(values.SHARED, "local", ".env.local сильнее .env.production");
  assert.equal(values.SECRET, "only-here");
  assert.equal(values.DEBUG, undefined, ".env.development не попадает в production");
});

test("пустое хранилище даёт пустое окружение", () => {
  assert.deepEqual(productionEnvValues(null), {});
  assert.deepEqual(productionEnvValues({}), {});
});
