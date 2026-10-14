import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * End-to-end check of the phone login HTTP surface. The data directory has to point at
 * a throwaway folder before the stores are imported, because they resolve their paths
 * at module load. The SMS provider is intentionally left unconfigured so the server
 * runs in test mode: the code comes back in the response instead of a real SMS.
 */
const dataDir = await mkdtemp(path.join(tmpdir(), "webnestdev-phone-"));
process.env.WEBNESTDEV_DATA_DIR = dataDir;
delete process.env.WEBNESTDEV_SMS_TEST_MODE;
for (const name of [
  "SMS_RU_API_ID", "SMSC_LOGIN", "SMSC_PASSWORD", "EXOLVE_API_KEY", "SMSAERO_EMAIL", "SMSAERO_API_KEY", "SMS_PROVIDER",
  "YANDEX_NOTIFY_IAM_TOKEN", "YANDEX_SA_KEY", "YANDEX_SA_KEY_FILE", "YANDEX_CLOUD_ID",
  "WEBNESTDEV_DEMO_PHONE", "WEBNESTDEV_DEMO_PHONE_ENABLED",
]) {
  delete process.env[name];
}
process.env.NODE_ENV = "test";

const Fastify = (await import("fastify")).default;
const cookie = (await import("@fastify/cookie")).default;
const { registerPhoneAuthRoutes } = await import("./phone-auth.js");
const { registerAuthRoutes } = await import("./auth.js");
const { clearPendingCodes } = await import("../auth/phone-store.js");

async function buildApp() {
  const app = Fastify();
  await app.register(cookie);
  await registerAuthRoutes(app);
  await registerPhoneAuthRoutes(app);
  await app.ready();
  return app;
}

function sessionCookie(response: { headers: Record<string, unknown> }) {
  const raw = response.headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  assert.equal(typeof value, "string", "a session cookie is issued");
  return (value as string).split(";")[0];
}

test("status reports test mode when no Russian provider key is set", async t => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const response = await app.inject({ method: "GET", url: "/api/auth/phone/status" });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.configured, false);
  assert.equal(body.testMode, true);
  assert.equal(body.providerLabel, "не подключён");
});

test("a Russian number gets a code and only that code opens a session", async t => {
  clearPendingCodes();
  const app = await buildApp();
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });

  const start = await app.inject({
    method: "POST",
    url: "/api/auth/phone/start",
    payload: { phone: "8 (999) 123-45-67", consent: true },
  });
  assert.equal(start.statusCode, 200);
  const started = start.json();
  assert.equal(started.sent, true);
  assert.equal(started.phone, "+7 999 123-45-67");
  assert.equal(started.testMode, true);
  assert.match(started.devCode, /^\d{6}$/);

  const wrong = await app.inject({
    method: "POST",
    url: "/api/auth/phone/verify",
    payload: { phone: "+79991234567", code: started.devCode === "000000" ? "111111" : "000000" },
  });
  assert.equal(wrong.statusCode, 401);

  const verified = await app.inject({
    method: "POST",
    url: "/api/auth/phone/verify",
    payload: { phone: "+79991234567", code: started.devCode },
  });
  assert.equal(verified.statusCode, 200);
  assert.equal(verified.json().user.email, "79991234567@phone.webnestdev.local");
  const cookieHeader = sessionCookie(verified);

  const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: cookieHeader } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().authenticated, true);

  // A second sign-in with the same number reaches the same account, not a new one.
  const again = await app.inject({ method: "POST", url: "/api/auth/phone/start", payload: { phone: "+79991234567", consent: true } });
  assert.equal(again.statusCode, 200);
  const redo = await app.inject({
    method: "POST",
    url: "/api/auth/phone/verify",
    payload: { phone: "+79991234567", code: again.json().devCode },
  });
  assert.equal(redo.statusCode, 200);
  assert.equal(redo.json().user.id, verified.json().user.id);
});

test("the demo number signs in immediately, without an SMS code", async t => {
  clearPendingCodes();
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const status = await app.inject({ method: "GET", url: "/api/auth/phone/status" });
  assert.equal(status.json().demoPhone, "+7 999 000-00-00");

  const response = await app.inject({
    method: "POST",
    url: "/api/auth/phone/start",
    payload: { phone: "+7 999 000-00-00", consent: true },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.demo, true);
  assert.equal(body.user.email, "79990000000@phone.webnestdev.local");

  const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: sessionCookie(response) } });
  assert.equal(me.json().authenticated, true);
});

test("the demo number is opt-in in production", async t => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  t.after(() => { process.env.NODE_ENV = previous; });
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const status = await app.inject({ method: "GET", url: "/api/auth/phone/status" });
  assert.equal(status.json().demoPhone, undefined);

  const response = await app.inject({ method: "POST", url: "/api/auth/phone/start", payload: { phone: "+7 999 000-00-00", consent: true } });
  assert.equal(response.statusCode, 200);
  assert.notEqual(response.json().demo, true);
});

test("a code is not generated without the phone-number consent", async t => {
  clearPendingCodes();
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const refused = await app.inject({
    method: "POST",
    url: "/api/auth/phone/start",
    payload: { phone: "+7 999 123-45-99" },
  });
  assert.equal(refused.statusCode, 400);
  assert.match(refused.json().error, /согласие/i);
  assert.equal(refused.json().consentRequired, true);

  // Without consent no code exists at all, so even a valid-looking one cannot be used.
  const nothing = await app.inject({
    method: "POST",
    url: "/api/auth/phone/verify",
    payload: { phone: "+7 999 123-45-99", code: "000000" },
  });
  assert.equal(nothing.statusCode, 401);

  const consented = await app.inject({
    method: "POST",
    url: "/api/auth/phone/start",
    payload: { phone: "+7 999 123-45-99", consent: true },
  });
  assert.equal(consented.statusCode, 200);
  assert.match(consented.json().devCode, /^\d{6}$/);
});

test("a non-Russian number is rejected before any code exists", async t => {
  clearPendingCodes();
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/phone/start",
    payload: { phone: "+1 415 555 0132", consent: true },
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /российский/i);
});
