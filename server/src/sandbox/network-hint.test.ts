import test from "node:test";
import assert from "node:assert/strict";
import {
  NO_NETWORK_HINT,
  PACKAGE_INSTALL_HINT,
  commandNeedsNetwork,
  isNetworkFailure,
  isPackageInstall,
  networkHint,
  networkHintForLogs,
} from "./network-hint.js";

test("установка пакетов отличается от запуска скриптов проекта", () => {
  for (const command of [
    "npm install --no-audit --no-fund",
    "npm i react",
    "npm ci",
    "npm add zod",
    "npm update",
    "npx create-vite@latest app",
    "yarn add vite",
    "yarn install",
    "yarn",
    "pnpm install",
    "pnpm i",
    "pnpm add react",
    "bun install",
    "bun add react",
    "pip install requests",
  ]) {
    assert.equal(isPackageInstall(command), true, command);
  }
  for (const command of [
    "npm run build",
    "npm test",
    "npm ls",
    "npm run dev",
    "yarn build",
    "yarn dev",
    "node scripts/build.mjs",
    "vite build",
    "git status",
  ]) {
    assert.equal(isPackageInstall(command), false, command);
    assert.equal(commandNeedsNetwork(command), false, command);
  }
});

test("сетевые команды без установки тоже распознаются", () => {
  for (const command of ["curl https://example.com", "wget -q https://example.com", "git fetch origin", "git pull", "git clone https://example.com/repo.git"]) {
    assert.equal(commandNeedsNetwork(command), true, command);
    assert.equal(isPackageInstall(command), false, command);
  }
  assert.equal(commandNeedsNetwork("git status"), false);
});

test("сетевой отказ отличается от ошибки проекта", () => {
  for (const text of [
    "npm ERR! code ENOTFOUND\nnpm ERR! syscall getaddrinfo",
    "npm ERR! code EAI_AGAIN",
    "connect ECONNREFUSED 104.16.0.34:443",
    "Temporary failure in name resolution",
    "getaddrinfo EAI_AGAIN registry.npmjs.org",
    "FetchError: request to https://registry.npmjs.org/react failed",
    "socket hang up",
  ]) {
    assert.equal(isNetworkFailure(text), true, text);
  }
  for (const text of ["npm ERR! code ERESOLVE", "TS2304: Cannot find name 'foo'", "1 test failed", "added 120 packages in 3s"]) {
    assert.equal(isNetworkFailure(text), false, text);
  }
});

test("подсказка про npm.install появляется только у упавшей сети", () => {
  const failedInstall = { ok: false, stdout: "", stderr: "npm ERR! code EAI_AGAIN" };
  assert.equal(networkHint("npm install", failedInstall), PACKAGE_INSTALL_HINT);
  assert.equal(networkHint("npm ci", failedInstall), PACKAGE_INSTALL_HINT);

  // Настоящая ошибка зависимостей сетью не считается.
  assert.equal(networkHint("npm install", { ok: false, stdout: "", stderr: "npm ERR! code ERESOLVE" }), undefined);
  // Успешная установка (если пакеты пришли иным путём) подсказку не получает.
  assert.equal(networkHint("npm install", { ok: true, stdout: "added 3 packages", stderr: "" }), undefined);

  // Любая другая команда, упавшая из-за сети, получает общее объяснение.
  assert.equal(
    networkHint("curl https://example.com", { ok: false, stdout: "", stderr: "curl: (6) Could not resolve host: example.com" }),
    NO_NETWORK_HINT,
  );
  assert.equal(networkHint("git fetch origin", { ok: false, stdout: "", stderr: "fatal: unable to access: Could not resolve host" }), NO_NETWORK_HINT);
});

test("хвост лога фонового задания тоже объясняет сетевой отказ", () => {
  assert.equal(networkHintForLogs("npm ERR! code ENOTFOUND"), NO_NETWORK_HINT);
  assert.equal(networkHintForLogs("vite v8 ready in 300 ms"), undefined);
});
