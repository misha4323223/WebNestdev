import test from "node:test";
import assert from "node:assert/strict";
import { npmInstallTimeoutMs, sandboxRuntime } from "./config.js";

test("по умолчанию и при docker контейнеры идут на runc", () => {
  assert.equal(sandboxRuntime(undefined), "docker");
  assert.equal(sandboxRuntime(""), "docker");
  assert.equal(sandboxRuntime("docker"), "docker");
});

test("runsc выбирается явно и без учёта регистра", () => {
  assert.equal(sandboxRuntime("runsc"), "runsc");
  assert.equal(sandboxRuntime(" RUNSC "), "runsc");
});

/**
 * Установка зависимостей — не обычная команда: дерево из сотен пакетов не укладывается в общие
 * 120 секунд, и `npm install` умирал на таймауте с недособранным node_modules. У неё свой предел,
 * который можно поднять переменной окружения, но не выше получаса.
 */
test("установка npm получает собственный лимит времени", () => {
  const previous = process.env.NPM_INSTALL_TIMEOUT_MS;
  try {
    delete process.env.NPM_INSTALL_TIMEOUT_MS;
    assert.equal(npmInstallTimeoutMs(), 600_000, "по умолчанию десять минут");
    process.env.NPM_INSTALL_TIMEOUT_MS = "900000";
    assert.equal(npmInstallTimeoutMs(), 900_000);
    process.env.NPM_INSTALL_TIMEOUT_MS = "1000";
    assert.equal(npmInstallTimeoutMs(), 600_000, "слишком малое значение не превращается в мгновенный таймаут");
    process.env.NPM_INSTALL_TIMEOUT_MS = "99999999";
    assert.equal(npmInstallTimeoutMs(), 1_800_000, "больше получаса не ждём");
  } finally {
    if (previous === undefined) delete process.env.NPM_INSTALL_TIMEOUT_MS;
    else process.env.NPM_INSTALL_TIMEOUT_MS = previous;
  }
});

test("неизвестный рантайм — ошибка, а не тихий возврат к runc", () => {
  assert.throws(() => sandboxRuntime("runc"), /SANDBOX_RUNTIME/);
  assert.throws(() => sandboxRuntime("gvisor"), /SANDBOX_RUNTIME/);
});
