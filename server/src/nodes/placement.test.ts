import test from "node:test";
import assert from "node:assert/strict";
import {
  NoSandboxNodeError,
  chooseProjectNode,
  rankNodes,
  type NodePlacement,
} from "./placement.js";
import type { SandboxNode } from "./node-store.js";

const NOW = Date.parse("2026-10-30T12:00:00.000Z");

function node(overrides: Partial<SandboxNode> = {}): SandboxNode {
  return {
    id: "node-a",
    address: "",
    status: "online",
    memoryTotalMb: 4096,
    memoryUsedMb: 1024,
    containers: 2,
    lastSeenAt: new Date(NOW - 10_000).toISOString(),
    createdAt: new Date(NOW - 86_400_000).toISOString(),
    updatedAt: new Date(NOW - 10_000).toISOString(),
    ...overrides,
  };
}

function ids(ranked: NodePlacement[]) {
  return ranked.map(item => item.node.id);
}

test("placement picks free memory first, then containers and project count", () => {
  const nodes = [
    node({ id: "small", memoryTotalMb: 4096, memoryUsedMb: 1000, containers: 1 }),
    node({ id: "roomy", memoryTotalMb: 8192, memoryUsedMb: 2000, containers: 4 }),
    node({ id: "busy", memoryTotalMb: 8192, memoryUsedMb: 2000, containers: 2 }),
  ];
  const ranked = rankNodes(nodes, new Map([["busy", 9], ["roomy", 1]]), { now: NOW, requiredMemoryMb: 1024 });
  assert.deepEqual(ids(ranked), ["busy", "roomy", "small"]);
});

test("a draining, offline, stale or capacity-less node is never a fallback", () => {
  const nodes = [
    node({ id: "draining", status: "draining" }),
    node({ id: "offline", status: "offline" }),
    node({ id: "stale", lastSeenAt: new Date(NOW - 10 * 60_000).toISOString() }),
    node({ id: "unknown", memoryTotalMb: 0 }),
    node({ id: "online", memoryUsedMb: 512 }),
  ];
  const ranked = rankNodes(nodes, new Map(), { now: NOW, staleMs: 120_000 });
  assert.deepEqual(ids(ranked), ["online"]);
});

test("project count breaks a full tie between equal nodes", () => {
  const nodes = [node({ id: "a" }), node({ id: "b" })];
  const ranked = rankNodes(nodes, new Map([["a", 4], ["b", 2]]), { now: NOW });
  assert.deepEqual(ids(ranked), ["b", "a"]);
});

test("choosing a node uses the local registration when no explicit list is supplied", async () => {
  const local = node({ id: "local" });
  let ensured = 0;
  const chosen = await chooseProjectNode({
    ensureLocal: async () => {
      ensured++;
      return local;
    },
    list: async () => [local],
    projectsByNode: async () => new Map([["local", 0]]),
    now: () => NOW,
  });
  assert.equal(ensured, 1);
  assert.equal(chosen.id, "local");
});

test("selection fails clearly when every node is unavailable", async () => {
  await assert.rejects(
    chooseProjectNode({
      ensureLocal: async () => node({ id: "local", status: "draining" }),
      list: async () => [node({ id: "local", status: "draining" })],
      projectsByNode: async () => new Map(),
      now: () => NOW,
    }),
    (error: unknown) => error instanceof NoSandboxNodeError && error.statusCode === 503,
  );
});
