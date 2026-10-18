import test from "node:test";
import assert from "node:assert/strict";
import { assertNotSecretProjectPath, isSecretProjectPath, secretEnvRefusal } from "./secret-paths.js";

test("секретные env-файлы узнаются в корне и в подкаталогах", () => {
  for (const value of [
    ".env",
    ".env.local",
    ".env.production",
    ".env.production.local",
    "apps/web/.env",
    "apps\\web\\.env.local",
    "./.env.local",
  ]) {
    assert.equal(isSecretProjectPath(value), true, value);
  }
});

test("шаблоны окружения и обычные файлы не считаются секретами", () => {
  for (const value of [
    ".env.example",
    ".env.sample",
    ".env.template",
    "apps/web/.env.example",
    "environment.ts",
    "env.local",
    "src/.envrc.ts",
  ]) {
    assert.equal(isSecretProjectPath(value), false, value);
  }
});

test("отказ называет действие и не раскрывает значение", () => {
  const message = secretEnvRefusal("apps/web/.env.local", "читать");
  assert.match(message, /apps\/web\/\.env\.local/);
  assert.match(message, /читать/);
  assert.match(message, /secrets\.request/);
  assert.throws(() => assertNotSecretProjectPath(".env", "перезаписать"), /перезаписать/);
});
