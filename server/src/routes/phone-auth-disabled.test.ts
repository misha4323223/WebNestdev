import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";

/**
 * SMS-вход выключен по умолчанию: это платный канал, и на проде он не используется.
 * Код сохранён для будущего, поэтому проверяется именно выключенное состояние: ни кода,
 * ни аккаунта, ни отправки — только честный ответ `PHONE_AUTH_DISABLED`.
 */
const dataDir = await mkdtemp(path.join(tmpdir(), "phone-auth-off-"));
process.env.WEBNESTDEV_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
delete process.env.PHONE_AUTH_ENABLED;
delete process.env.WEBNESTDEV_SMS_TEST_MODE;
for (const name of [
  "SMS_RU_API_ID", "SMSC_LOGIN", "SMSC_PASSWORD", "EXOLVE_API_KEY", "SMSAERO_EMAIL", "SMSAERO_API_KEY", "SMS_PROVIDER",
  "YANDEX_NOTIFY_IAM_TOKEN", "YANDEX_SA_KEY", "YANDEX_SA_KEY_FILE", "YANDEX_CLOUD_ID",
  "WEBNESTDEV_DEMO_PHONE", "WEBNESTDEV_DEMO_PHONE_ENABLED",
]) {
  delete process.env[name];
}

const { registerPhoneAuthRoutes } = await import("./phone-auth.js");
const { findUserIdByPhone } = await import("../auth/phone-store.js");
const { sendLoginCode } = await import("../auth/sms.js");

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test("вход по телефону выключен по умолчанию: ни кода, ни аккаунта, ни SMS", async () => {
  const app = Fastify();
  try {
    await registerPhoneAuthRoutes(app);
    await app.ready();

    const status = await app.inject({ method: "GET", url: "/api/auth/phone/status" });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().enabled, false, "статус честно говорит, что вход отключён");

    const start = await app.inject({
      method: "POST",
      url: "/api/auth/phone/start",
      payload: { phone: "+7 999 123-45-67", consent: true },
    });
    assert.equal(start.statusCode, 403, start.body);
    assert.equal(start.json().code, "PHONE_AUTH_DISABLED");

    const verify = await app.inject({
      method: "POST",
      url: "/api/auth/phone/verify",
      payload: { phone: "+7 999 123-45-67", code: "123456" },
    });
    assert.equal(verify.statusCode, 403, verify.body);
    assert.equal(verify.json().code, "PHONE_AUTH_DISABLED");

    assert.equal(await findUserIdByPhone("+79991234567"), null, "аккаунт по номеру не создан");

    const delivery = await sendLoginCode("+79991234567", "123456");
    assert.equal(delivery.ok, false, "отправка заблокирована и на уровне доставки");
    assert.match(delivery.error ?? "", /отключён/);
  } finally {
    await app.close();
  }
});
