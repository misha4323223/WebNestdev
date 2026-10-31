import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Скидка не должна оставаться только надписью на витрине: в счёт, подпись и запись платежа
 * уходит ровно итоговая сумма, а базовая цена остаётся видимой как зачёркнутая.
 */
process.env.WEBNESTDEV_STORAGE = "json";
const root = await mkdtemp(path.join(tmpdir(), "billing-discount-"));
process.env.WEBNESTDEV_DATA_DIR = root;
process.env.ROBOKASSA_LOGIN = "nestdev";
process.env.ROBOKASSA_PASSWORD_1 = "pass1";
process.env.ROBOKASSA_PASSWORD_2 = "pass2";
process.env.ROBOKASSA_HASH = "md5";
delete process.env.ROBOKASSA_TEST_MODE;
delete process.env.ROBOKASSA_RECURRING;
delete process.env.ROBOKASSA_RECEIPT;
process.env.PLAN_SETTINGS = JSON.stringify({
  version: 1,
  plans: {
    pro: { name: "Профи", description: "Для постоянной работы", features: ["15 проектов", "Поддержка"], priceRub: 1000, discountPercent: 20 },
    team: { name: "Студия", description: "Для нескольких продуктов", features: ["50 проектов"], priceRub: 3000, discountPercent: 0 },
  },
});

const Fastify = (await import("fastify")).default;
const cookie = (await import("@fastify/cookie")).default;
const { registerBillingRoutes } = await import("./billing.js");
const { createSession, createUser } = await import("../auth/auth-store.js");
const { SESSION_COOKIE } = await import("../auth/auth.js");
const { getPayment } = await import("../billing/store.js");
const { signValue } = await import("../billing/robokassa.js");

const app = Fastify();
await app.register(cookie);
await registerBillingRoutes(app);
await app.ready();

test.after(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

test("скидка попадает в счёт и подпись Робокассы, а базовая цена остаётся на витрине", async () => {
  const user = await createUser("discount-" + Date.now() + "@example.test", "password-123");
  const session = await createSession(user.id);
  const headers = { cookie: SESSION_COOKIE + "=" + session.id };

  const plans = (await app.inject({ method: "GET", url: "/api/billing/plans" })).json() as {
    plans: Array<{ id: string; name: string; features: string[]; priceRub: number; priceLabel: string; basePriceRub: number; basePriceLabel: string; discountPercent: number }>;
  };
  const pro = plans.plans.find(plan => plan.id === "pro");
  const free = plans.plans.find(plan => plan.id === "free");
  assert.ok(pro);
  assert.equal(pro.name, "Профи");
  assert.deepEqual(pro.features, ["15 проектов", "Поддержка"]);
  assert.ok(free);
  assert.equal(free.features[0], "3 проекта", "пункты бесплатного тарифа не редактируются");
  assert.notDeepEqual(free.features, pro.features);
  assert.equal(pro.basePriceRub, 1000);
  assert.equal(pro.priceRub, 800);
  assert.equal(pro.discountPercent, 20);
  assert.equal(pro.priceLabel, "800 ₽");
  assert.equal(pro.basePriceLabel.replace(/\u00a0/g, " "), "1 000 ₽");

  const checkout = await app.inject({ method: "POST", url: "/api/billing/checkout", headers, payload: { plan: "pro" } });
  assert.equal(checkout.statusCode, 200);
  const body = checkout.json() as { invId: number; paymentUrl: string; amount: number };
  assert.equal(body.amount, 800, "в счёт уходит цена со скидкой");
  const url = new URL(body.paymentUrl);
  assert.equal(url.searchParams.get("OutSum"), "800.00");
  assert.equal(url.searchParams.get("SignatureValue"), signValue("nestdev:800.00:" + body.invId + ":pass1", "md5"));
  assert.equal((await getPayment(body.invId))?.amount, 800);
});
