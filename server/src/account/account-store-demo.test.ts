import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("concurrent demo activation grants only one plan for a verified phone", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "webnestdev-demo-"));
  const previousStorage = process.env.WEBNESTDEV_STORAGE;
  const previousDataDir = process.env.WEBNESTDEV_DATA_DIR;
  process.env.WEBNESTDEV_STORAGE = "json";
  process.env.WEBNESTDEV_DATA_DIR = root;
  try {
    const { createUser, linkPhoneToUser } = await import("../auth/auth-store.js");
    const { activateDemoOnce, DemoAlreadyClaimedError, PhoneVerificationRequiredError, saveSubscription } = await import("./account-store.js");
    const user = await createUser("trial-test@example.test", "long-enough-test-password");
    await linkPhoneToUser("+79001234567", user.id);
    const results = await Promise.allSettled([
      activateDemoOnce(user.id, "pro"),
      activateDemoOnce(user.id, "team"),
    ]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected" && result.reason instanceof DemoAlreadyClaimedError).length, 1);
    const granted = results.find(result => result.status === "fulfilled");
    if (!granted || granted.status !== "fulfilled") throw new Error("Expected one successful demo activation");
    await saveSubscription({ ...granted.value, plan: "free", status: "free", startedAt: null, expiresAt: null });
    await assert.rejects(() => activateDemoOnce(user.id, "team"), DemoAlreadyClaimedError);

    const emailOnly = await createUser("email-only@example.test", "long-enough-test-password");
    await assert.rejects(() => activateDemoOnce(emailOnly.id, "pro"), PhoneVerificationRequiredError);
  } finally {
    if (previousStorage === undefined) delete process.env.WEBNESTDEV_STORAGE;
    else process.env.WEBNESTDEV_STORAGE = previousStorage;
    if (previousDataDir === undefined) delete process.env.WEBNESTDEV_DATA_DIR;
    else process.env.WEBNESTDEV_DATA_DIR = previousDataDir;
    await rm(root, { recursive: true, force: true });
  }
});
