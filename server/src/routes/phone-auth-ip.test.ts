import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Телефонный вход создаёт обычный аккаунт, поэтому предел адреса действует и здесь: иначе
 * «три аккаунта с IP» обходились бы регистрацией по номеру. Повторный вход в существующий
 * аккаунт места не занимает — иначе человек с тремя аккаунтами не смог бы войти в свой.
 */
const dataDir = await mkdtemp(path.join(tmpdir(), "phone-auth-ip-"));
process.env.WEBNESTDEV_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.PHONE_AUTH_ENABLED = "1";
delete process.env.WEBNESTDEV_SMS_TEST_MODE;
delete process.env.SIGNUP_IP_LIMIT;
for (const name of [
  "SMS_RU_API_ID", "SMSC_LOGIN", "SMSC_PASSWORD", "EXOLVE_API_KEY", "SMSAERO_EMAIL", "SMSAERO_API_KEY", "SMS_PROVIDER",
  "YANDEX_NOTIFY_IAM_TOKEN", "YANDEX_SA_KEY", "YANDEX_SA_KEY_FILE", "YANDEX_CLOUD_ID",
  "WEBNESTDEV_DEMO_PHONE", "WEBNESTDEV_DEMO_PHONE_ENABLED",
]) {
  delete process.env[name];
}

const Fastify = (await import("fastify")).default;
const cookie = (await import("@fastify/cookie")).default;
const { registerPhoneAuthRoutes } = await import("./phone-auth.js");
const { registerAuthRoutes } = await import("./auth.js");
const { clearPendingCodes } = await import("../auth/phone-store.js");
const { signupIpAccounts } = await import("../auth/signup-ip.js");

async function buildApp() {
  const app = Fastify();
  await app.register(cookie);
  await registerAuthRoutes(app);
  await registerPhoneAuthRoutes(app);
  await app.ready();
  return app;
}

async function signIn(app: Awaited<ReturnType<typeof buildApp>>, phone: string, ip: string) {
  const start = await app.inject({
    method: "POST",
    url: "/api/auth/phone/start",
    remoteAddress: ip,
    payload: { phone, consent: true },
  });
  assert.equal(start.statusCode, 200, start.body);
  return app.inject({
    method: "POST",
    url: "/api/auth/phone/verify",
    remoteAddress: ip,
    payload: { phone, code: start.json().devCode },
  });
}

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test("четвёртый новый номер с одного IP получает отказ, вход в старый аккаунт работает", async t => {
  clearPendingCodes();
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const ip = "203.0.113.80";
  const phones = ["+79990000101", "+79990000102", "+79990000103"];

  for (const phone of phones) {
    const verified = await signIn(app, phone, ip);
    assert.equal(verified.statusCode, 200, verified.body);
  }
  assert.equal(await signupIpAccounts(ip), 3);

  const fourth = await signIn(app, "+79990000104", ip);
  assert.equal(fourth.statusCode, 403);
  assert.equal(fourth.json().code, "SIGNUP_IP_LIMIT");
  assert.match(fourth.json().error, /уже создано 3 аккаунта/);

  // Тот же номер — тот же аккаунт: лимит не должен запирать вход тем, кто уже зарегистрирован.
  const again = await signIn(app, phones[0], ip);
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(await signupIpAccounts(ip), 3);
});

test("новый номер с другого адреса проходит", async t => {
  clearPendingCodes();
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  for (const phone of ["+79990000201", "+79990000202", "+79990000203"]) {
    assert.equal((await signIn(app, phone, "198.51.100.120")).statusCode, 200);
  }
  const fresh = await signIn(app, "+79990000204", "198.51.100.121");
  assert.equal(fresh.statusCode, 200, fresh.body);
});
