import test from "node:test";
import assert from "node:assert/strict";
import { liveRuntimePreviews } from "./preview-limiter.js";
import { removePreview, setPreview } from "./preview-store.js";
import { flushPreviewWritesForTests } from "./preview-store.js";

const state = (projectId: string, mode: "container" | "static" | "hybrid") => ({
  projectId,
  containerId: projectId + "-container",
  host: "127.0.0.1",
  port: 4000,
  startedAt: 1,
  lastUsedAt: 1,
  mode,
});

test("hybrid is counted as a runtime preview, while static is not", async () => {
  setPreview(state("limit-hybrid", "hybrid"));
  setPreview(state("limit-container", "container"));
  setPreview(state("limit-static", "static"));
  try {
    assert.deepEqual(liveRuntimePreviews().map(item => item.projectId).sort(), ["limit-container", "limit-hybrid"]);
  } finally {
    removePreview("limit-hybrid");
    removePreview("limit-container");
    removePreview("limit-static");
    await flushPreviewWritesForTests();
  }
});
