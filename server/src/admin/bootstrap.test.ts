import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Хранилище читает каталог при импорте, поэтому окружение выставляется до dynamic import.
process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_DATA_DIR = await mkdtemp(path.join(tmpdir(), "admin-bootstrap-"));

const { ensureBootstrapAdmin } = await import("./bootstrap.js");
const { findAdminByEmail, verifyAdminPassword } = await import("./admin-store.js");

const EMAIL = "owner@example.test";
const PASSWORD = "bootstrap-password-1";

function configure(email: string | undefined, password: string | undefined) {
  if (email === undefined) delete process.env.ADMIN_BOOTSTRAP_EMAIL;
  else process.env.ADMIN_BOOTSTRAP_EMAIL = email;
  if (password === undefined) delete process.env.ADMIN_BOOTSTRAP_PASSWORD;
  else process.env.ADMIN_BOOTSTRAP_PASSWORD = password;
}

test("без переменных окружения ничего не создаётся", async () => {
  configure(undefined, undefined);
  const result = await ensureBootstrapAdmin();
  assert.equal(result.status, "skipped");
});

test("короткий пароль и кривая почта отвергаются: вход на всю платформу не бывает слабым", async () => {
  configure("not-an-email", PASSWORD);
  assert.equal((await ensureBootstrapAdmin()).status, "skipped");

  configure(EMAIL, "short");
  const weak = await ensureBootstrapAdmin();
  assert.equal(weak.status, "skipped");
  assert.match(weak.status === "skipped" ? weak.reason : "", /12/);
  assert.equal(await findAdminByEmail(EMAIL), null);
});

test("переменные создают администратора, и пароль действительно подходит", async () => {
  configure("Owner@Example.Test", PASSWORD);
  const created = await ensureBootstrapAdmin();
  assert.deepEqual(created, { status: "created", email: EMAIL });

  const admin = await verifyAdminPassword(EMAIL, PASSWORD);
  assert.ok(admin, "вход по паролю из окружения работает");
  assert.equal(admin?.totpEnabledAt, "", "фактор ещё не подключён: первый вход начнётся с TOTP");
});

test("повторный запуск не меняет существующую запись", async () => {
  configure(EMAIL, "another-password-22");
  const second = await ensureBootstrapAdmin();
  assert.deepEqual(second, { status: "exists", email: EMAIL });

  // Пароль остался прежним: выкатка не должна незаметно менять вход администратора.
  assert.ok(await verifyAdminPassword(EMAIL, PASSWORD));
  assert.equal(await verifyAdminPassword(EMAIL, "another-password-22"), null);
});
