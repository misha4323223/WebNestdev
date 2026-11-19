import test from "node:test";
import assert from "node:assert/strict";
import { beginRun, endRun } from "../agent/active-runs.js";
import { idlePreviews, stopIdlePreviews, type IdleSweepDeps } from "./idle-sweep.js";
import { clearIdleStopsForTests, idleStopInfo } from "./idle-stop-marker.js";
import { getPreview, removePreview, setPreview } from "./preview-store.js";
import type { PreviewState } from "./types.js";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

function state(projectId: string, lastUsedAgoMs: number): PreviewState {
  return {
    projectId,
    mode: "container",
    containerId: "container-" + projectId,
    host: "127.0.0.1",
    port: 3000,
    startedAt: NOW - 30 * MINUTE,
    lastUsedAt: NOW - lastUsedAgoMs,
  };
}

function seed(states: PreviewState[]) {
  for (const item of states) setPreview(item);
}

function cleanup(ids: string[]) {
  for (const id of ids) removePreview(id);
}

/** Mirrors the real stop: the container is stopped and the state disappears. */
const stopping: IdleSweepDeps = { stopPreview: async projectId => { removePreview(projectId); } };

test("only previews untouched for longer than the timeout are selected", () => {
  const states = [state("fresh", 2 * MINUTE), state("old", 6 * MINUTE), state("exactly", 5 * MINUTE)];
  const ids = idlePreviews(states, NOW, 5 * MINUTE).map(item => item.projectId);
  assert.deepEqual(ids.sort(), ["exactly", "old"]);
  assert.deepEqual(idlePreviews(states, NOW, 0), []);
});

test("container uses three minutes, static and hybrid keep fifteen", () => {
  const runtime = state("runtime", 3 * MINUTE);
  const staticPreview = { ...state("static", 3 * MINUTE), mode: "static" as const, containerId: "" };
  const hybrid = { ...state("hybrid", 3 * MINUTE), mode: "hybrid" as const };
  const ids = idlePreviews([runtime, staticPreview, hybrid], NOW, 3 * MINUTE, 15 * MINUTE).map(item => item.projectId);
  assert.deepEqual(ids, ["runtime"]);

  const stillAlive = [
    { ...state("static-later", 14 * MINUTE), mode: "static" as const, containerId: "" },
    { ...state("hybrid-later", 14 * MINUTE), mode: "hybrid" as const },
  ];
  assert.deepEqual(idlePreviews(stillAlive, NOW, 3 * MINUTE, 15 * MINUTE), []);
  assert.deepEqual(
    idlePreviews(stillAlive.map(item => ({ ...item, lastUsedAt: NOW - 16 * MINUTE })), NOW, 3 * MINUTE, 15 * MINUTE)
      .map(item => item.projectId),
    ["static-later", "hybrid-later"],
  );
});

test("the sweep stops idle previews, keeps the busy ones and explains the idle stop", async () => {
  clearIdleStopsForTests();
  seed([state("idle-project", 10 * MINUTE), state("busy-project", 10 * MINUTE), state("fresh-project", MINUTE)]);
  beginRun("busy-project");
  try {
    const result = await stopIdlePreviews(NOW, 5 * MINUTE, stopping);
    assert.equal(result.stopped, 1);
    assert.equal(getPreview("idle-project"), undefined);
    assert.ok(getPreview("busy-project"), "проект с активным прогоном должен остаться");
    assert.ok(getPreview("fresh-project"), "недавно использованный предпросмотр должен остаться");
    assert.deepEqual(idleStopInfo("idle-project", NOW), { mode: "container", idleMs: 5 * MINUTE, stoppedAt: NOW });
  } finally {
    endRun("busy-project");
    clearIdleStopsForTests();
    cleanup(["idle-project", "busy-project", "fresh-project"]);
  }
});

test("a run in flight then ending lets the preview be swept on the next pass", async () => {
  seed([state("later", 10 * MINUTE)]);
  beginRun("later");
  try {
    assert.equal((await stopIdlePreviews(NOW, 5 * MINUTE, stopping)).stopped, 0);
  } finally {
    endRun("later");
  }
  const result = await stopIdlePreviews(NOW, 5 * MINUTE, stopping);
  assert.equal(result.stopped, 1);
  assert.equal(getPreview("later"), undefined);
});

test("a failed stop keeps the preview so the next sweep retries instead of losing the container", async () => {
  seed([state("stuck", 10 * MINUTE)]);
  const failing: IdleSweepDeps = { stopPreview: async () => { throw new Error("Docker недоступен"); } };
  const result = await stopIdlePreviews(NOW, 5 * MINUTE, failing);
  assert.equal(result.stopped, 0);
  assert.ok(getPreview("stuck"), "состояние сохраняется для повтора");
  cleanup(["stuck"]);
});
