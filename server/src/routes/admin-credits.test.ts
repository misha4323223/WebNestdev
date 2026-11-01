import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Настройка докупки кредитов: владелец задаёт цену за 1000 и границы, а ответ сразу показывает,
 * во что превращаются типовые суммы. Ставка не должна приниматься без проверки — иначе один
 * нулевой или отрицательный рубль сделал бы докупку бесплатной.
 */
process.env.WEBNESTDEV_STORAGE = "json";
delete process.env.CREDIT_SETTINGS;
const root = await mkdtemp(path.join(tmpdir(), "admin-credits-"));
process.env.WEBNESTDEV_DATA_DIR = root;

const Fastify = (await import("fastify")).default;
const { registerAdminCreditRoutes } = await import("./admin-credits.js");
const { createAdmin, createAdminSession } = await import("../admin/admin-store.js");

const app = Fastify();
await registerAdminCreditRoutes(app);
await app.ready();

const admin = await createAdmin("credits-admin@example.test", "correct-horse-battery");
const session = await createAdminSession(admin.id);
const auth = { authorization: "Bearer " + session.token };

type CreditTopUpBody = {
  creditTopUp: {
    pricePer1000Rub: number;
    minCredits: number;
    maxCredits: number;
    pricePer1000Label: string;
    minAmountRub: number;
  };
  examples: Array<{ credits: number; amountRub: number }>;
};

test.after(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

test("настройки докупки недоступны без сессии администратора", async () => {
  const response = await app.inject({ method: "GET", url: "/api/admin/billing/credits" });
  assert.equal(response.statusCode, 401);
});

test("по умолчанию цена 290 ₽ за 1000, минимум 1000 и максимум 100000", async () => {
  const response = await app.inject({ method: "GET", url: "/api/admin/billing/credits", headers: auth });
  assert.equal(response.statusCode, 200);
  const body = response.json() as CreditTopUpBody;
  assert.equal(body.creditTopUp.pricePer1000Rub, 290);
  assert.equal(body.creditTopUp.pricePer1000Label.replace(/\u00a0/g, " "), "290 ₽");
  assert.equal(body.creditTopUp.minCredits, 1_000);
  assert.equal(body.creditTopUp.maxCredits, 100_000);
  assert.equal(body.creditTopUp.minAmountRub, 290);
  assert.equal(body.examples.find(item => item.credits === 5_000)?.amountRub, 1_450);
});

test("ставка меняется одним полем, а остальные границы сохраняются", async () => {
  const saved = await app.inject({
    method: "POST",
    url: "/api/admin/billing/credits",
    headers: { ...auth, "content-type": "application/json" },
    payload: { pricePer1000Rub: 250 },
  });
  assert.equal(saved.statusCode, 200);
  const body = saved.json() as CreditTopUpBody;
  assert.equal(body.creditTopUp.pricePer1000Rub, 250);
  assert.equal(body.creditTopUp.minCredits, 1_000);
  assert.equal(body.creditTopUp.maxCredits, 100_000);
  assert.equal(body.examples.find(item => item.credits === 5_000)?.amountRub, 1_250);

  const after = await app.inject({ method: "GET", url: "/api/admin/billing/credits", headers: auth });
  assert.equal((after.json() as CreditTopUpBody).creditTopUp.pricePer1000Rub, 250);
});

test("минимум и максимум можно поднять, а противоречие отклоняется", async () => {
  const saved = await app.inject({
    method: "POST",
    url: "/api/admin/billing/credits",
    headers: { ...auth, "content-type": "application/json" },
    payload: { minCredits: 2_000, maxCredits: 20_000 },
  });
  assert.equal(saved.statusCode, 200);
  const body = saved.json() as CreditTopUpBody;
  assert.equal(body.creditTopUp.minCredits, 2_000);
  assert.equal(body.creditTopUp.maxCredits, 20_000);
  assert.equal(body.examples[0]?.credits, 2_000);

  const contradiction = await app.inject({
    method: "POST",
    url: "/api/admin/billing/credits",
    headers: { ...auth, "content-type": "application/json" },
    payload: { minCredits: 10_000, maxCredits: 5_000 },
  });
  assert.equal(contradiction.statusCode, 400);

  const tooLow = await app.inject({
    method: "POST",
    url: "/api/admin/billing/credits",
    headers: { ...auth, "content-type": "application/json" },
    payload: { minCredits: 500 },
  });
  assert.equal(tooLow.statusCode, 400, "минимум ниже 1000 не принимается");

  const zeroPrice = await app.inject({
    method: "POST",
    url: "/api/admin/billing/credits",
    headers: { ...auth, "content-type": "application/json" },
    payload: { pricePer1000Rub: 0 },
  });
  assert.equal(zeroPrice.statusCode, 400);
});
