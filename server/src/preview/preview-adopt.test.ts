import test from "node:test";
import assert from "node:assert/strict";
import { getPreview, removePreview } from "./preview-store.js";
import { adoptRunningPreview } from "./preview-adopt.js";
import type { SandboxHost } from "../sandbox/host.js";
import type { SandboxConfig } from "../sandbox/sandbox-types.js";

const config: SandboxConfig = {
  projectId: "adopt-project",
  root: "/tmp/adopt-project",
  memoryMb: 256,
  cpuLimit: 1,
  timeoutMs: 5_000,
};

function fakeHost(containerId: string, running: boolean, kind = "container"): SandboxHost {
  const docker = async (args: string[]) => {
    if (args[0] === "ps") return { code: 0, stdout: containerId + "\n", stderr: "" };
    if (args[0] === "inspect" && args[2] === "{{.State.Running}}") {
      return { code: 0, stdout: String(running) + "\n", stderr: "" };
    }
    if (args[0] === "inspect" && String(args[2]).includes("Config.Labels")) {
      return { code: 0, stdout: kind + "\n", stderr: "" };
    }
    if (args[0] === "inspect") {
      return {
        code: 0,
        stdout: JSON.stringify({ "preview-net": { IPAddress: "172.21.0.4" } }),
        stderr: "",
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return {
    id: "local",
    status: async () => ({ mode: "docker", available: true }),
    runCommand: async () => ({ ok: true, exitCode: 0, signal: null, stdout: "", stderr: "", truncated: false }),
    docker,
    networks: async () => ({ preview: "preview-net", attach: ["preview-net"] }),
  };
}

test("принимает работающий контейнер с меткой проекта, когда строки состояния нет", async () => {
  const adopted = await adoptRunningPreview(config, {
    resolveHost: async () => fakeHost("container-running", true),
  });
  assert.equal(adopted?.containerId, "container-running");
  assert.equal(adopted?.host, "172.21.0.4");
  assert.equal(adopted?.port, 3000);
  assert.equal(adopted?.mode, "container");
  assert.equal(getPreview(config.projectId)?.containerId, "container-running");
});

test("остановленный контейнер не принимается", async () => {
  const adopted = await adoptRunningPreview(config, {
    resolveHost: async () => fakeHost("container-stopped", false),
  });
  assert.equal(adopted, null);
});

test("hybrid backend не принимается как обычный dev-контейнер", async () => {
  removePreview(config.projectId);
  const adopted = await adoptRunningPreview(config, {
    resolveHost: async () => fakeHost("container-hybrid", true, "hybrid"),
  });
  assert.equal(adopted, null);
  assert.equal(getPreview(config.projectId), undefined);
});
