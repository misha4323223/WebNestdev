import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_DATA_DIR = await mkdtemp(path.join(tmpdir(), "admin-bootstrap-password-"));

const {
  adminUsesBootstrapPassword,
  consumeAdminBootstrapPassword,
  createAdmin,
  findAdminByEmail,
  verifyAdminPassword,
} = await import("./admin-store.js");

const EMAIL = "bootstrap-owner@example.test";
const PASSWORD = "bootstrap-password-1";

test("bootstrap-пароль работает до первого полного входа и сгорает после него", async () => {
  const created = await createAdmin(EMAIL, PASSWORD, { bootstrap: true });
  assert.equal(adminUsesBootstrapPassword(created), true);
  assert.ok(await verifyAdminPassword(EMAIL, PASSWORD));

  assert.equal(await consumeAdminBootstrapPassword(created.id), true);
  assert.equal(await verifyAdminPassword(EMAIL, PASSWORD), null, "старый пароль из окружения больше не подходит");

  const stored = await findAdminByEmail(EMAIL);
  assert.ok(stored);
  assert.equal(adminUsesBootstrapPassword(stored), false);
  assert.equal(await consumeAdminBootstrapPassword(created.id), false, "повторное погашение не нужно");
});

test("обычный админ из CLI не помечается одноразовым", async () => {
  const email = "cli-owner@example.test";
  const created = await createAdmin(email, PASSWORD);
  assert.equal(adminUsesBootstrapPassword(created), false);
  assert.ok(await verifyAdminPassword(email, PASSWORD));
  assert.equal(await consumeAdminBootstrapPassword(created.id), false);
  assert.ok(await verifyAdminPassword(email, PASSWORD));
});
