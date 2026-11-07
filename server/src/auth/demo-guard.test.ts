import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * P2 #17 из docs/SECURITY.md: демо-вход включается флагом, но пароль и номер по умолчанию
 * известны всем. В production одного флага мало — нужны свои значения, иначе платформа получает
 * общую дверь. Тест проверяет именно это, а не сам факт наличия флага.
 */
const dataDir = await mkdtemp(path.join(os.tmpdir(), "nestdev-demo-guard-"));
process.env.WEBNESTDEV_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
delete process.env.WEBNESTDEV_STORAGE;
delete process.env.DATABASE_URL;

const auth = await import("./auth-store.js");
const phones = await import("./phone-store.js");

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function inProduction(action: () => Promise<void>) {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  return action().finally(() => {
    process.env.NODE_ENV = previous;
  });
}

test("демо-аккаунт с паролем по умолчанию в production не создаётся", async () => {
  const previousPassword = process.env.WEBNESTDEV_DEMO_PASSWORD;
  delete process.env.WEBNESTDEV_DEMO_PASSWORD;
  try {
    await inProduction(async () => {
      const result = await auth.ensureDemoUser();
      assert.equal(result.created, false);
      assert.equal(await auth.findUserByEmail(auth.DEMO_ACCOUNT.email), null);
    });
  } finally {
    if (previousPassword === undefined) delete process.env.WEBNESTDEV_DEMO_PASSWORD;
    else process.env.WEBNESTDEV_DEMO_PASSWORD = previousPassword;
  }
});

test("свой пароль в production разрешает демо-аккаунт", async () => {
  const previousPassword = process.env.WEBNESTDEV_DEMO_PASSWORD;
  process.env.WEBNESTDEV_DEMO_PASSWORD = "демо-пароль-для-стенда-2026";
  try {
    await inProduction(async () => {
      const result = await auth.ensureDemoUser();
      assert.equal(result.created, true);
      assert.ok(await auth.verifyUser(auth.DEMO_ACCOUNT.email, "демо-пароль-для-стенда-2026"));
    });
  } finally {
    if (previousPassword === undefined) delete process.env.WEBNESTDEV_DEMO_PASSWORD;
    else process.env.WEBNESTDEV_DEMO_PASSWORD = previousPassword;
  }
});

test("демо-номер: в production нужен и флаг, и свой номер", async () => {
  const previousEnabled = process.env.WEBNESTDEV_DEMO_PHONE_ENABLED;
  const previousPhone = process.env.WEBNESTDEV_DEMO_PHONE;
  try {
    await inProduction(async () => {
      delete process.env.WEBNESTDEV_DEMO_PHONE_ENABLED;
      delete process.env.WEBNESTDEV_DEMO_PHONE;
      assert.equal(phones.demoPhone(), null, "по умолчанию в production выключен");

      process.env.WEBNESTDEV_DEMO_PHONE_ENABLED = "1";
      assert.equal(phones.demoPhone(), null, "флаг без своего номера не открывает вход");

      process.env.WEBNESTDEV_DEMO_PHONE = "+79991234567";
      assert.equal(phones.demoPhone(), "+79991234567");
    });
  } finally {
    if (previousEnabled === undefined) delete process.env.WEBNESTDEV_DEMO_PHONE_ENABLED;
    else process.env.WEBNESTDEV_DEMO_PHONE_ENABLED = previousEnabled;
    if (previousPhone === undefined) delete process.env.WEBNESTDEV_DEMO_PHONE;
    else process.env.WEBNESTDEV_DEMO_PHONE = previousPhone;
  }
});
