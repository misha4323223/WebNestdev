import test from "node:test";
import assert from "node:assert/strict";
import type { SandboxConfig } from "../sandbox-manager.js";
import type { DockerCommandResult } from "./docker/types.js";
import { sandboxHost, sandboxHostForNode } from "./host.js";
import { createLocalSandboxHost, localSandboxHost } from "./local-host.js";

test("the server starts on the local sandbox host", () => {
  assert.equal(sandboxHost(), localSandboxHost);
  assert.equal(localSandboxHost.id, "local");
  assert.equal(sandboxHostForNode(localSandboxHost.id), localSandboxHost);
  assert.throws(() => sandboxHostForNode("missing-node"), /не подключён/);
});

test("the local host forwards command, status and container operations", async () => {
  const config = {} as SandboxConfig;
  let seenCommand = "";
  let seenCwd = "";
  let seenTimeout = 0;

  const host = createLocalSandboxHost({
    status: async () => ({ mode: "docker", available: true, dockerVersion: "test" }),
    runCommand: async (_config, command, cwd, options) => {
      seenCommand = command;
      seenCwd = cwd;
      seenTimeout = options.timeoutMs ?? 0;
      const result: DockerCommandResult = {
        ok: true,
        exitCode: 0,
        signal: null,
        stdout: "done",
        stderr: "",
        truncated: false,
      };
      return result;
    },
    docker: async (args, timeoutMs) => {
      assert.deepEqual(args, ["inspect", "preview-1"]);
      assert.equal(timeoutMs, 1_234);
      return { code: 0, stdout: "true", stderr: "" };
    },
  });

  assert.deepEqual(await host.status(), { mode: "docker", available: true, dockerVersion: "test" });
  const command = await host.runCommand(config, "npm test", "/workspace", { timeoutMs: 42 });
  assert.equal(command.stdout, "done");
  assert.equal(seenCommand, "npm test");
  assert.equal(seenCwd, "/workspace");
  assert.equal(seenTimeout, 42);

  const inspect = await host.docker(["inspect", "preview-1"], 1_234);
  assert.deepEqual(inspect, { code: 0, stdout: "true", stderr: "" });
});
