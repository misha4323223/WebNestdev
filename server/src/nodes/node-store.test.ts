import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SandboxNode } from "./node-store.js";

test("node registry persists metrics and operator status", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "node-store-"));
  process.env.WEBNESTDEV_DATA_DIR = root;
  process.env.WEBNESTDEV_STORAGE = "json";
  process.env.WEBNESTDEV_NODE_ID = "local";
  try {
    const store = await import("./node-store.js");
    const now = new Date().toISOString();
    const first: SandboxNode = {
      id: "node-a",
      address: "10.0.0.10:8787",
      status: "online",
      memoryTotalMb: 8192,
      memoryUsedMb: 2048,
      containers: 3,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await store.upsertNode(first);
    assert.deepEqual(await store.getNode("node-a"), first);
    assert.deepEqual((await store.listNodes()).map(node => node.id), ["node-a"]);

    const drained = await store.setNodeStatus("node-a", "draining");
    assert.equal(drained?.status, "draining");
    assert.equal((await store.getNode("node-a"))?.status, "draining");
    const refreshed = await store.updateNodeMetrics({
      ...first,
      memoryUsedMb: 4096,
      containers: 5,
      lastSeenAt: new Date(Date.now() + 1_000).toISOString(),
      updatedAt: new Date(Date.now() + 1_000).toISOString(),
    });
    assert.equal(refreshed?.status, "draining", "heartbeat must not revive a drained node");
    assert.equal((await store.getNode("node-a"))?.status, "draining");
    assert.equal(await store.setNodeStatus("missing", "offline"), null);

    await mkdir(path.join(root, "projects"), { recursive: true });
    await writeFile(
      path.join(root, "projects", "pinned.json"),
      JSON.stringify({ id: "pinned", name: "Pinned", userId: "u", createdAt: now, updatedAt: now, node: "node-a" }),
    );
    await writeFile(
      path.join(root, "projects", "legacy.json"),
      JSON.stringify({ id: "legacy", name: "Legacy", userId: "u", createdAt: now, updatedAt: now }),
    );
    const counts = await store.countProjectsByNode();
    assert.equal(counts.get("node-a"), 1);
    assert.equal(counts.get("local"), 1);

    assert.equal(await store.backfillProjectNodes("local"), 1);
    const legacy = JSON.parse(await readFile(path.join(root, "projects", "legacy.json"), "utf8")) as { node?: string };
    assert.equal(legacy.node, "local");
    assert.equal(await store.backfillProjectNodes("local"), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
    delete process.env.WEBNESTDEV_DATA_DIR;
    delete process.env.WEBNESTDEV_STORAGE;
    delete process.env.WEBNESTDEV_NODE_ID;
  }
});
