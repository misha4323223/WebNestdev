import test from "node:test";
import assert from "node:assert/strict";
import { decideRuntimePreviewStart, describePreviewLimits, runtimePreviewLimit } from "./preview-limiter.js";

const live = (projectId: string, userId: string, lastUsedAt: number) => ({ projectId, userId, lastUsedAt });

test("a host with room starts another runtime preview", () => {
  const decision = decideRuntimePreviewStart({
    live: [live("a", "user-1", 100)],
    projectId: "b",
    userId: "user-2",
    limit: 3,
  });
  assert.deepEqual(decision, { ok: true });
});

test("the host's own project never counts against the limit: restarting is not a new preview", () => {
  const decision = decideRuntimePreviewStart({
    live: [live("a", "user-1", 100), live("a", "user-1", 100), live("a", "user-1", 100)],
    projectId: "a",
    userId: "user-1",
    limit: 3,
  });
  assert.deepEqual(decision, { ok: true });
});

test("at the cap, the user's own oldest preview is stopped instead of refusing them", () => {
  const decision = decideRuntimePreviewStart({
    live: [live("old", "user-1", 100), live("new", "user-1", 900), live("other", "user-2", 950)],
    projectId: "third",
    userId: "user-1",
    limit: 3,
  });
  assert.deepEqual(decision, { ok: true, stopProjectId: "old" });
});

test("at the cap with only other people's previews, the answer is a reason, not a silent stop", () => {
  const decision = decideRuntimePreviewStart({
    live: [live("a", "user-1", 100), live("b", "user-2", 200), live("c", "user-3", 300)],
    projectId: "d",
    userId: "user-4",
    limit: 3,
  });
  assert.equal(decision.ok, false);
  if (decision.ok) return;
  assert.match(decision.reason, /PREVIEW_MAX_CONTAINERS/);
  assert.match(decision.reason, /3 серверных предпросмотров/);
});

test("a preview without an owner is never stopped on someone else's behalf", () => {
  const decision = decideRuntimePreviewStart({
    live: [live("a", "user-1", 100), live("b", "user-2", 200), live("orphan", "", 300)],
    projectId: "d",
    userId: "",
    limit: 3,
  });
  assert.equal(decision.ok, false, "пустой userId не считается «своим» превью");
});

test("a limit of zero means no cap, and the default is three", () => {
  assert.deepEqual(
    decideRuntimePreviewStart({ live: [live("a", "user-1", 1), live("b", "user-2", 2)], projectId: "c", userId: "user-3", limit: 0 }),
    { ok: true },
  );
  const previous = process.env.PREVIEW_MAX_CONTAINERS;
  try {
    delete process.env.PREVIEW_MAX_CONTAINERS;
    assert.equal(runtimePreviewLimit(), 3);
    assert.match(describePreviewLimits(), /серверных предпросмотров одновременно: 3/);
    process.env.PREVIEW_MAX_CONTAINERS = "1";
    assert.equal(runtimePreviewLimit(), 1);
    process.env.PREVIEW_MAX_CONTAINERS = "0";
    assert.match(describePreviewLimits(), /без ограничения/);
  } finally {
    if (previous === undefined) delete process.env.PREVIEW_MAX_CONTAINERS;
    else process.env.PREVIEW_MAX_CONTAINERS = previous;
  }
});
