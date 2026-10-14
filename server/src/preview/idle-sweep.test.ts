import test from "node:test";
import assert from "node:assert/strict";
import { beginRun, endRun } from "../agent/active-runs.js";
import { idlePreviews, stopIdlePreviews, type IdleSweepDeps } from "./idle-sweep.js";
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

test("the sweep stops idle previews and keeps the busy ones", async () => {
  seed([state("idle-project", 10 * MINUTE), state("busy-project", 10 * MINUTE), state("fresh-project", MINUTE)]);
  beginRun("busy-project");
  try {
    const result = await stopIdlePreviews(NOW, 5 * MINUTE, stopping);
    assert.equal(result.stopped, 1);
    assert.equal(getPreview("idle-project"), undefined);
    assert.ok(getPreview("busy-project"), "проект с активным прогоном должен остаться");
    assert.ok(getPreview("fresh-project"), "недавно использованный предпросмотр должен остаться");
  } finally {
    endRun("busy-project");
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
