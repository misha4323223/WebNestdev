import test from "node:test";
import assert from "node:assert/strict";
import { dockerOptions } from "./options.js";
import type { SandboxConfig } from "../sandbox-types.js";

const config: SandboxConfig = { projectId: "p1", root: "/tmp/p1", memoryMb: 1024, cpuLimit: 1, timeoutMs: 120_000 };

function withEnv(values: Record<string, string | undefined>, run: () => void) {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("без потолка команды действует общий SANDBOX_MEMORY", () => {
  withEnv({ SANDBOX_MEMORY: "1g" }, () => {
    assert.equal(dockerOptions(config).memory, "1g");
  });
  withEnv({ SANDBOX_MEMORY: undefined }, () => {
    assert.equal(dockerOptions(config).memory, "1024m");
  });
});

test("потолок команды перекрывает общий SANDBOX_MEMORY", () => {
  // Это и есть production-случай: в .env стоит SANDBOX_MEMORY=1g, и без приоритета лёгкая команда
  // получала бы полный гигабайт, а бюджет считал бы 256 МБ.
  withEnv({ SANDBOX_MEMORY: "1g" }, () => {
    assert.equal(dockerOptions(config, 256).memory, "256m");
  });
});
