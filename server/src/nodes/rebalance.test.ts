import test from "node:test";
import assert from "node:assert/strict";

import { planRebalance } from "./rebalance.js";
import type { SandboxNode } from "./node-store.js";

const NOW = Date.parse("2026-11-07T12:00:00.000Z");

function node(overrides: Partial<SandboxNode> = {}): SandboxNode {
  return {
    id: "node-a",
    address: "",
    status: "online",
    memoryTotalMb: 4096,
    memoryUsedMb: 1024,
    containers: 1,
    lastSeenAt: new Date(NOW - 10_000).toISOString(),
    createdAt: new Date(NOW - 86_400_000).toISOString(),
    updatedAt: new Date(NOW - 10_000).toISOString(),
    ...overrides,
  };
}

test("a crowded node gives one project to the roomiest node", () => {
  const nodes = [
    node({ id: "local", memoryUsedMb: 3600 }),
    node({ id: "node-2", memoryUsedMb: 200 }),
  ];
  const plan = planRebalance(nodes, new Map([["local", 12]]), { requiredMemoryMb: 1024, marginMb: 512, now: NOW });
  assert.deepEqual(plan, { from: "local", to: "node-2", fromFreeMb: -528, toFreeMb: 2872 });
});

test("a difference below the margin is not worth a move", () => {
  const nodes = [
    node({ id: "local", memoryUsedMb: 1600 }),
    node({ id: "node-2", memoryUsedMb: 1400 }),
  ];
  const plan = planRebalance(nodes, new Map([["local", 5]]), { requiredMemoryMb: 1024, marginMb: 512, now: NOW });
  assert.equal(plan, null);
});

test("a target without room for the project plus margin is not a target", () => {
  const nodes = [
    node({ id: "local", memoryUsedMb: 3600 }),
    node({ id: "node-2", memoryUsedMb: 3900 }),
  ];
  const plan = planRebalance(nodes, new Map([["local", 5]]), { requiredMemoryMb: 1024, marginMb: 512, now: NOW });
  assert.equal(plan, null);
});

test("draining and stale nodes take no part in a move", () => {
  const nodes = [
    node({ id: "local", memoryUsedMb: 3600 }),
    node({ id: "node-2", status: "draining", memoryUsedMb: 200 }),
    node({ id: "node-3", memoryUsedMb: 200, lastSeenAt: new Date(NOW - 10 * 60_000).toISOString() }),
  ];
  const plan = planRebalance(nodes, new Map([["local", 5]]), { requiredMemoryMb: 1024, marginMb: 512, now: NOW });
  assert.equal(plan, null);
});

test("the node that already has every project is not a source", () => {
  const nodes = [
    node({ id: "local", memoryUsedMb: 3600 }),
    node({ id: "node-2", memoryUsedMb: 200 }),
  ];
  const plan = planRebalance(nodes, new Map([["node-2", 3]]), { requiredMemoryMb: 1024, marginMb: 512, now: NOW });
  assert.equal(plan, null);
});
