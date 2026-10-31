import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(tmpdir(), "host-routing-"));
process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_DATA_DIR = root;
process.env.WEBNESTDEV_NODE_ID = "local";
process.env.WEBNESTDEV_RUNNER_TOKEN = "r".repeat(40);

const { resolveSandboxHost, SandboxNodeUnavailableError, clearSandboxHostsForTests } = await import("./host.js");
const { upsertNode, setNodeStatus, getNode } = await import("../nodes/node-store.js");
const { registerConfiguredRemoteNodes } = await import("../nodes/remote-heartbeat.js");

function node(id: string, overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id,
    address: "127.0.0.1:8790",
    status: "online" as const,
    memoryTotalMb: 4096,
    memoryUsedMb: 1024,
    containers: 1,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test("a pinned remote project resolves to a token-authenticated runner", async () => {
  await upsertNode(node("runner-a"));
  const host = await resolveSandboxHost("runner-a");
  assert.equal(host.id, "runner-a");
  assert.equal((await resolveSandboxHost("runner-a")), host);
});

test("an offline node is a clear error, never a local fallback", async () => {
  await upsertNode(node("runner-b"));
  await setNodeStatus("runner-b", "offline");
  clearSandboxHostsForTests();
  await assert.rejects(
    resolveSandboxHost("runner-b"),
    (error: unknown) => error instanceof SandboxNodeUnavailableError && error.statusCode === 503,
  );
});

test("configured remote nodes are registered idempotently", async () => {
  process.env.WEBNESTDEV_REMOTE_NODES = JSON.stringify([
    { id: "runner-config", address: "10.0.0.9:8790" },
    { id: "local", address: "bad" },
  ]);
  const changed = await registerConfiguredRemoteNodes();
  assert.equal(changed, 1);
  assert.equal((await getNode("runner-config"))?.address, "10.0.0.9:8790");
  assert.equal(await registerConfiguredRemoteNodes(), 0);
  delete process.env.WEBNESTDEV_REMOTE_NODES;
});

test("a remote node without a token is refused", async () => {
  await upsertNode(node("runner-c"));
  clearSandboxHostsForTests();
  delete process.env.WEBNESTDEV_RUNNER_TOKEN;
  await assert.rejects(resolveSandboxHost("runner-c"), /WEBNESTDEV_RUNNER_TOKEN/);
  process.env.WEBNESTDEV_RUNNER_TOKEN = "r".repeat(40);
});

test.after(async () => {
  clearSandboxHostsForTests();
  await rm(root, { recursive: true, force: true });
  delete process.env.WEBNESTDEV_STORAGE;
  delete process.env.WEBNESTDEV_DATA_DIR;
  delete process.env.WEBNESTDEV_NODE_ID;
  delete process.env.WEBNESTDEV_RUNNER_TOKEN;
});
