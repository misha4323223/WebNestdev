import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(tmpdir(), "runner-server-"));
process.env.WEBNESTDEV_SANDBOX_DIR = root;
process.env.WEBNESTDEV_SANDBOX_HOST_DIR = root;
process.env.WEBNESTDEV_NODE_ID = "runner-a";
process.env.SANDBOX_IMAGE = "node:22-bookworm";

const { createRunnerServer } = await import("./server.js");
const { createRemoteSandboxHost, RemoteRunnerError } = await import("../sandbox/remote-host.js");
const { buildSandboxConfig } = await import("../sandbox/config.js");

const token = "a".repeat(40);
const config = buildSandboxConfig("project", path.join(root, "project"), "runner-a");
let seenCommand = "";
let seenCwd = "";
let seenEnv: Record<string, string> | undefined;

const server = createRunnerServer({
  token,
  status: async () => ({
    ok: true,
    nodeId: "runner-a",
    mode: "docker",
    available: true,
    dockerVersion: "test",
    metrics: { memoryTotalMb: 4096, memoryUsedMb: 1024, containers: 2 },
    workspace: { root, hostRoot: root, shared: true },
    previewNetwork: "preview",
    previewAttachNetworks: ["preview"],
  }),
  runCommand: async (_config, command, cwd, options) => {
    seenCommand = command;
    seenCwd = cwd;
    seenEnv = options?.env;
    return { ok: true, exitCode: 0, signal: null, stdout: "done", stderr: "", truncated: false };
  },
  docker: async args => {
    if (args[0] === "inspect") {
      if (args[3] === "foreign") return { code: 0, stdout: "<no value>|<no value>", stderr: "" };
      return { code: 0, stdout: "project-a|", stderr: "" };
    }
    assert.deepEqual(args, ["ps", "-aq", "--filter", "label=webnestdev.preview"]);
    return { code: 0, stdout: "abc123", stderr: "" };
  },
  relay: {
    open: async () => ({ host: "10.0.0.2", port: 4321 }),
    close: async () => undefined,
    closeAll: async () => undefined,
  },
});

await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("runner test server has no port");

const host = createRemoteSandboxHost({ id: "runner-a", address: "127.0.0.1:" + address.port, token });

test("a remote host authenticates, reports metrics and runs a project command", async () => {
  const status = await host.status();
  assert.equal(status.nodeId, "runner-a");
  assert.deepEqual(status.metrics, { memoryTotalMb: 4096, memoryUsedMb: 1024, containers: 2 });
  assert.equal(status.workspace?.shared, true);
  assert.deepEqual(await host.networks?.(), { preview: "preview", attach: ["preview"] });

  const result = await host.runCommand(config, "npm test", path.join(config.root, "sub"), {
    env: { SAFE_TEST: "1" },
    timeoutMs: 5_000,
  });
  assert.equal(result.stdout, "done");
  assert.equal(seenCommand, "npm test");
  assert.equal(seenCwd, path.join(root, "project", "sub"));
  assert.deepEqual(seenEnv, { SAFE_TEST: "1" });

  await assert.rejects(
    host.runCommand({ ...config, projectId: "../escape" }, "id", config.root),
    /Некорректный запрос/,
  );
});

test("Docker operations go through the allowlist and the relay is requested from the runner", async () => {
  assert.deepEqual(await host.docker(["ps", "-aq", "--filter", "label=webnestdev.preview"]), { code: 0, stdout: "abc123", stderr: "" });
  assert.deepEqual(await host.previewRelay?.("abc123", 3000), { host: "10.0.0.2", port: 4321 });
  await assert.rejects(host.docker(["inspect", "-f", "{{.State.Running}}", "foreign"]), /не принадлежит/);
});

test("a wrong token is rejected without leaking the expected value", async () => {
  const wrong = createRemoteSandboxHost({ id: "runner-a", address: "127.0.0.1:" + address.port, token: "b".repeat(40) });
  await assert.rejects(wrong.status(), (error: unknown) => {
    assert.ok(error instanceof RemoteRunnerError);
    assert.equal(error.statusCode, 401);
    assert.doesNotMatch(error.message, new RegExp(token));
    return true;
  });
});

test("a runner that reports another node id is refused", async () => {
  const other = createRunnerServer({
    token,
    status: async () => ({
      ok: true,
      nodeId: "other",
      mode: "docker",
      available: true,
      metrics: { memoryTotalMb: 0, memoryUsedMb: 0, containers: 0 },
      workspace: { root, hostRoot: root, shared: true },
      previewNetwork: "",
      previewAttachNetworks: [],
    }),
    relay: { open: async () => ({ host: "127.0.0.1", port: 1 }), close: async () => undefined, closeAll: async () => undefined },
  });
  await new Promise<void>(resolve => other.listen(0, "127.0.0.1", resolve));
  const otherAddress = other.address();
  if (!otherAddress || typeof otherAddress === "string") throw new Error("other runner has no port");
  const wrong = createRemoteSandboxHost({ id: "runner-a", address: "127.0.0.1:" + otherAddress.port, token });
  await assert.rejects(wrong.status(), /представился/);
  await new Promise<void>(resolve => other.close(() => resolve()));
});

test.after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});
