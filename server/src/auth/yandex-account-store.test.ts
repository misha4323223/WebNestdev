import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The store resolves its data directory at module load, so the throwaway folder has to
 * be set before the dynamic imports below. These tests cover the rule that matters for
 * accounts: one Yandex identity always returns the same local user, and a Yandex e-mail
 * never merges into a local account that somebody else may have pre-registered.
 */
const dataDir = await mkdtemp(path.join(tmpdir(), "webnestdev-yandex-"));
process.env.WEBNESTDEV_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";

const { ensureYandexAccount, findUserIdByYandexId, findYandexIdentityByUserId } = await import("./yandex-account-store.js");
const { createUser } = await import("./auth-store.js");

test("a Yandex identity maps to one local account and keeps the e-mail", async t => {
  t.after(async () => { await rm(dataDir, { recursive: true, force: true }); });

  const first = await ensureYandexAccount({ id: "1001", login: "alice", email: "alice@example.com" });
  assert.equal(first.email, "yandex-1001@yandex-id.webnestdev.local");

  const again = await ensureYandexAccount({ id: "1001", login: "alice-new", email: "alice@example.com" });
  assert.equal(again.id, first.id);
  assert.equal(await findUserIdByYandexId("1001"), first.id);

  const identity = await findYandexIdentityByUserId(first.id);
  assert.equal(identity?.login, "alice-new");
  assert.equal(identity?.email, "alice@example.com");
});

test("a Yandex e-mail never merges into a pre-registered local account", async t => {
  const squatter = await createUser("bob@example.com", "password123");
  const yandexUser = await ensureYandexAccount({ id: "1002", login: "bob", email: "BOB@example.com" });
  assert.notEqual(yandexUser.id, squatter.id);
  assert.equal(yandexUser.email, "yandex-1002@yandex-id.webnestdev.local");
  const identity = await findYandexIdentityByUserId(yandexUser.id);
  assert.equal(identity?.email, "bob@example.com");
  t.after(async () => { await rm(dataDir, { recursive: true, force: true }); });
});

test("without e-mail permission the account gets a readable synthetic address", async t => {
  const user = await ensureYandexAccount({ id: "1003", login: "carol" });
  assert.equal(user.email, "yandex-1003@yandex-id.webnestdev.local");
  t.after(async () => { await rm(dataDir, { recursive: true, force: true }); });
});
