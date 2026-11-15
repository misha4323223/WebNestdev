import assert from "node:assert/strict";
import test from "node:test";
import {
  declaredPackageManager,
  installCommandFor,
  lockfileFor,
  lockfilePackageManager,
  packageManagerFor,
} from "./package-manager.js";

test("packageManager в package.json важнее lock-файла", () => {
  assert.equal(declaredPackageManager({ packageManager: "pnpm@9.12.0" }), "pnpm");
  assert.equal(packageManagerFor({ packageManager: "yarn@4.1.0" }, ["package-lock.json"]), "yarn");
});

test("lock-файл выбирает менеджер, если packageManager не задан", () => {
  assert.equal(lockfilePackageManager(["package-lock.json"]), "npm");
  assert.equal(packageManagerFor({}, ["pnpm-lock.yaml"]), "pnpm");
  assert.equal(packageManagerFor(null, ["bun.lock"]), "bun");
  assert.equal(packageManagerFor(null, []), "npm");
});

test("неизвестный packageManager не ломает установку", () => {
  assert.equal(declaredPackageManager({ packageManager: "deno@2" }), null);
  assert.equal(packageManagerFor({ packageManager: "deno@2" }, ["yarn.lock"]), "yarn");
});

test("npm использует ci только при своём lock-файле", () => {
  assert.equal(lockfileFor("npm"), "package-lock.json");
  assert.equal(lockfileFor("pnpm"), "pnpm-lock.yaml");
  assert.equal(installCommandFor("npm", false), "npm install --no-audit --no-fund");
  assert.equal(installCommandFor("npm", true), "npm ci --no-audit --no-fund");
  assert.equal(installCommandFor("pnpm", true), "pnpm install --frozen-lockfile");
  assert.equal(installCommandFor("yarn", false), "yarn install");
  assert.equal(installCommandFor("bun", true), "bun install --frozen-lockfile");
});
