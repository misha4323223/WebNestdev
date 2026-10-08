import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { createProjectWithinLimit, ProjectLimitError } from "./project-store.js";

const root = process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");

test("concurrent project creation respects the per-user limit", async () => {
  const userId = "project-quota-" + randomUUID();
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, (_, index) => createProjectWithinLimit("Quota test " + index, undefined, userId, 3)),
  );
  const created = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof createProjectWithinLimit>>> => result.status === "fulfilled");
  try {
    assert.equal(created.length, 3);
    assert.equal(results.filter(result => result.status === "rejected" && result.reason instanceof ProjectLimitError).length, 9);
  } finally {
    await Promise.all(created.map(result => rm(path.join(root, "projects", result.value.id + ".json"), { force: true })));
  }
});
