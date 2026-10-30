import test from "node:test";
import assert from "node:assert/strict";
import { sandboxRuntime } from "./config.js";

test("по умолчанию и при docker контейнеры идут на runc", () => {
  assert.equal(sandboxRuntime(undefined), "docker");
  assert.equal(sandboxRuntime(""), "docker");
  assert.equal(sandboxRuntime("docker"), "docker");
});

test("runsc выбирается явно и без учёта регистра", () => {
  assert.equal(sandboxRuntime("runsc"), "runsc");
  assert.equal(sandboxRuntime(" RUNSC "), "runsc");
});

test("неизвестный рантайм — ошибка, а не тихий возврат к runc", () => {
  assert.throws(() => sandboxRuntime("runc"), /SANDBOX_RUNTIME/);
  assert.throws(() => sandboxRuntime("gvisor"), /SANDBOX_RUNTIME/);
});
