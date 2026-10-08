import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("concurrent demo activation grants only one plan for an account", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "webnestdev-demo-"));
  process.env.WEBNESTDEV_STORAGE = "json";
  process.env.WEBNESTDEV_DATA_DIR = root;
  try {
    const { activateDemoOnce, DemoAlreadyClaimedError } = await import("../account/account-store.js");
    const results = await Promise.allSettled([
      activateDemoOnce("race-user", "pro"),
      activateDemoOnce("race-user", "team"),
    ]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected" && result.reason instanceof DemoAlreadyClaimedError).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
