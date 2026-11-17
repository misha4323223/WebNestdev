import test from "node:test";
import assert from "node:assert/strict";

import type { Project } from "../project-store.js";
import type { SandboxNode } from "../nodes/node-store.js";
import type { PreviewState } from "./types.js";
import {
  failoverPreviewCleanupOnce,
  nodeLostReason,
  type FailoverSweepDeps,
} from "./preview-failover.js";

const NOW = Date.parse("2026-11-15T21:00:00.000Z");

function node(overrides: Partial<SandboxNode> = {}): SandboxNode {
  return {
    id: "node-1",
    address: "10.0.0.4:8790",
    apiAddress: "10.0.0.4:8791",
    workspaceMode: "shared",
    status: "online",
    memoryTotalMb: 4096,
    memoryUsedMb: 512,
    containers: 0,
    diskTotalMb: 19_000,
    diskFreeMb: 12_000,
    lastSeenAt: new Date(NOW - 10_000).toISOString(),
    createdAt: new Date(NOW - 86_400_000).toISOString(),
    updatedAt: new Date(NOW - 10_000).toISOString(),
    ...overrides,
  };
}

function staleNode(overrides: Partial<SandboxNode> = {}): SandboxNode {
  return node({
    id: "node-2",
    lastSeenAt: new Date(NOW - 10 * 60_000).toISOString(),
    ...overrides,
  });
}

function project(id: string, pin: string): Project {
  return {
    id,
    name: id,
    userId: "user-1",
    node: pin,
    createdAt: new Date(NOW - 86_400_000).toISOString(),
    updatedAt: new Date(NOW - 10_000).toISOString(),
  };
}

function preview(projectId: string, pin: string): PreviewState {
  return {
    mode: "container",
    projectId,
    containerId: "container-" + projectId,
    host: "10.0.0.5",
    port: 3000,
    startedAt: NOW - 60_000,
    lastUsedAt: NOW,
    settled: true,
    node: pin,
  };
}

function baseDeps(overrides: Partial<FailoverSweepDeps> = {}): FailoverSweepDeps {
  const local = node();
  const remote = staleNode();
  const projectRows = [project("p1", remote.id), project("p2", remote.id)];
  const state = preview("p1", remote.id);
  const cleared = new Set<string>();
  return {
    localNode: () => local.id,
    listNodes: async () => [local, remote],
    listProjects: async (nodeId, limit) =>
      projectRows.filter(item => item.node === nodeId).slice(0, limit).map(item => ({
        id: item.id,
        userId: item.userId,
        name: item.name,
      })),
    listPreviews: async () => (cleared.has(state.projectId) ? [] : [state]),
    confirmedLost: async () => "power-off",
    clearPreview: async projectId => {
      cleared.add(projectId);
      return true;
    },
    hydrate: async projectId => (cleared.has(projectId) ? undefined : projectId === state.projectId ? state : undefined),
    getProject: async projectId => projectRows.find(item => item.id === projectId) ?? null,
    chooseNode: async () => local,
    reassign: async (projectId, userId, nodeId) => {
      const current = projectRows.find(item => item.id === projectId);
      return current && current.userId === userId ? { ...current, node: nodeId } : null;
    },
    restoreLost: async () => undefined,
    hasJobs: () => false,
    runActive: async () => false,
    log: () => undefined,
    ...overrides,
  };
}

test("stale node with confirmed power OFF is a loss, fresh node is not", async () => {
  const fresh = await nodeLostReason(node(), {
    now: () => NOW,
    staleMs: 120_000,
    readPower: async () => ({ power: "OFF" }),
  });
  assert.equal(fresh, null);

  const off = await nodeLostReason(staleNode(), {
    now: () => NOW,
    staleMs: 120_000,
    readPower: async () => ({ power: "OFF" }),
  });
  assert.equal(off, "power-off");

  const on = await nodeLostReason(staleNode(), {
    now: () => NOW,
    staleMs: 120_000,
    readPower: async () => ({ power: "ON" }),
  });
  assert.equal(on, null);
});

test("explicit offline wins without calling MWS", async () => {
  let calls = 0;
  const reason = await nodeLostReason(staleNode({ status: "offline" }), {
    now: () => NOW,
    readPower: async () => {
      calls++;
      return { power: "OFF" };
    },
  });
  assert.equal(reason, "offline");
  assert.equal(calls, 0);
});

test("MWS error is not a confirmation", async () => {
  const logs: string[] = [];
  const reason = await nodeLostReason(staleNode(), {
    now: () => NOW,
    readPower: async () => {
      throw new Error("MWS недоступен");
    },
    log: message => logs.push(message),
  });
  assert.equal(reason, null);
  assert.equal(logs.length, 1);
  assert.match(logs[0] ?? "", /перенос отложен/);
});

test("loses preview state and moves projects to the live node", async () => {
  const events: string[] = [];
  const base = baseDeps({
    clearPreview: async projectId => {
      events.push("clear:" + projectId);
      return true;
    },
    hydrate: async () => undefined,
    reassign: async (projectId, userId, nodeId) => {
      events.push("move:" + projectId + ":" + nodeId);
      return { ...project(projectId, nodeId), userId };
    },
    log: message => events.push("log:" + message),
  });

  const result = await failoverPreviewCleanupOnce(base);

  assert.equal(result.length, 1);
  assert.deepEqual(result[0]?.clearedPreviews, ["p1"]);
  assert.deepEqual(result[0]?.movedProjects, ["p1", "p2"]);
  assert.deepEqual(result[0]?.skippedProjects, []);
  assert.deepEqual(events.filter(event => !event.startsWith("log:")), [
    "clear:p1",
    "move:p1:node-1",
    "move:p2:node-1",
  ]);
});

test("does nothing while the node is not confirmed lost", async () => {
  let cleared = 0;
  let moved = 0;
  const result = await failoverPreviewCleanupOnce(baseDeps({
    confirmedLost: async () => null,
    clearPreview: async () => {
      cleared++;
      return true;
    },
    reassign: async () => {
      moved++;
      return null;
    },
  }));

  assert.deepEqual(result, []);
  assert.equal(cleared, 0);
  assert.equal(moved, 0);
});

test("does not ask MWS when there is no preview or project on the node", async () => {
  let checked = 0;
  const result = await failoverPreviewCleanupOnce(baseDeps({
    listProjects: async () => [],
    listPreviews: async () => [],
    confirmedLost: async () => {
      checked++;
      return "power-off";
    },
  }));

  assert.deepEqual(result, []);
  assert.equal(checked, 0);
});

test("clears a dead preview but does not move a project with an active job or run", async () => {
  const result = await failoverPreviewCleanupOnce(baseDeps({
    hasJobs: projectId => projectId === "p2",
    runActive: async projectId => projectId === "p1",
  }));

  assert.deepEqual(result[0]?.clearedPreviews, ["p1"]);
  assert.deepEqual(result[0]?.movedProjects, []);
  assert.deepEqual(result[0]?.skippedProjects, [
    { projectId: "p1", reason: "active-run" },
    { projectId: "p2", reason: "active-job" },
  ]);
});

test("a preview that could not be cleared keeps the project blocked", async () => {
  const base = baseDeps();
  const result = await failoverPreviewCleanupOnce({
    ...base,
    clearPreview: async () => false,
    hydrate: async projectId => projectId === "p1" ? preview("p1", "node-2") : undefined,
  });

  assert.deepEqual(result[0]?.clearedPreviews, []);
  assert.deepEqual(result[0]?.movedProjects, ["p2"]);
  assert.deepEqual(result[0]?.skippedProjects, [
    { projectId: "p1", reason: "preview-remains" },
  ]);
});

test("no live node leaves preview cleared but project pin untouched", async () => {
  const result = await failoverPreviewCleanupOnce(baseDeps({
    chooseNode: async () => {
      throw new Error("нет живых нод");
    },
  }));

  assert.deepEqual(result[0]?.clearedPreviews, ["p1"]);
  assert.deepEqual(result[0]?.movedProjects, []);
  assert.deepEqual(result[0]?.skippedProjects, [
    { projectId: "p1", reason: "no-target" },
    { projectId: "p2", reason: "no-target" },
  ]);
});
