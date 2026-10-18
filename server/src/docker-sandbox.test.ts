import test from "node:test";
import assert from "node:assert/strict";
import { runDockerSandbox } from "./docker-sandbox.js";
import type { SandboxConfig } from "./sandbox-manager.js";

const config: SandboxConfig = {
  projectId: "00000000-0000-0000-0000-000000000000",
  root: "/tmp/webnestdev-abort-test",
  hostRoot: "/tmp/webnestdev-abort-test",
  memoryMb: 128,
  cpuLimit: 1,
  timeoutMs: 60_000,
};

test("отмена запуска отвергает команду сразу и не ждёт таймаута", async () => {
  const controller = new AbortController();
  controller.abort();
  const started = Date.now();
  await assert.rejects(
    runDockerSandbox(config, "echo should-not-run", config.root, { signal: controller.signal }),
    /отменён/,
  );
  assert.ok(Date.now() - started < 2000, "отмена не должна ждать контейнер");
});
