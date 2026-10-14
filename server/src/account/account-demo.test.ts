import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The stores resolve their paths when the module loads, so the throwaway data directory
 * comes first and everything else is imported afterwards.
 */
const dataDir = await mkdtemp(path.join(tmpdir(), "webnestdev-demo-"));
process.env.WEBNESTDEV_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
delete process.env.WEBNESTDEV_STORAGE;
delete process.env.DATABASE_URL;
delete process.env.WEBNESTDEV_TRIAL_CLAIM_SECRET;
delete process.env.WEBNESTDEV_ENCRYPTION_KEY;

const { DemoAlreadyClaimedError, PhoneVerificationRequiredError, activateDemoOnce, getSubscription, saveSubscription } = await import("./account-store.js");
const { createUser } = await import("../auth/auth-store.js");
const { linkPhone } = await import("../auth/phone-store.js");

after(async () => { await rm(dataDir, { recursive: true, force: true }); });

async function accountWithPhone(phone: string) {
  const user = await createUser(phone.replace(/\D/g, "") + "@phone.webnestdev.local", "local-test-password-1");
  await linkPhone(phone, user.id);
  return user;
}

test("an account without a number cannot claim a demo", async () => {
  const user = await createUser("plain-account@webnestdev.local", "local-test-password-1");
  await assert.rejects(() => activateDemoOnce(user.id, "pro"), PhoneVerificationRequiredError);
});

test("a number claims the demo once and the number itself is not stored in the claim", async () => {
  const user = await accountWithPhone("+79990000111");
  const subscription = await activateDemoOnce(user.id, "pro");
  assert.equal(subscription.plan, "pro");
  assert.equal(subscription.status, "demo_active");
  assert.equal((await getSubscription(user.id)).plan, "pro");

  await assert.rejects(() => activateDemoOnce(user.id, "pro"), DemoAlreadyClaimedError);
  await assert.rejects(() => activateDemoOnce(user.id, "team"), DemoAlreadyClaimedError);

  const claims = await readFile(path.join(dataDir, "account", "demo-claims.json"), "utf8");
  assert.ok(!claims.includes("79990000111"), "the claim file keeps a hash of the number, not the number");
});

test("another number from another account still gets its own demo", async () => {
  const user = await accountWithPhone("+79990000222");
  const subscription = await activateDemoOnce(user.id, "team");
  assert.equal(subscription.plan, "team");
});

test("a cancelled demo is not handed out again", async () => {
  const user = await accountWithPhone("+79990000333");
  const first = await activateDemoOnce(user.id, "pro");
  await saveSubscription({ ...first, plan: "free", status: "demo_cancelled", expiresAt: null, updatedAt: new Date().toISOString() });
  await assert.rejects(() => activateDemoOnce(user.id, "pro"), DemoAlreadyClaimedError);
});
