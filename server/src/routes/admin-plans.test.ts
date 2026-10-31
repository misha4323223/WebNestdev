import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Витрина тарифов для админки: форма сохраняет базовую цену и скидку, а ответ сразу
 * показывает итоговую сумму, которую увидит человек и получит Робокасса.
 */
process.env.WEBNESTDEV_STORAGE = "json";
const root = await mkdtemp(path.join(tmpdir(), "admin-plans-"));
process.env.WEBNESTDEV_DATA_DIR = root;

const Fastify = (await import("fastify")).default;
const { registerAdminPlanRoutes } = await import("./admin-plans.js");
const { createAdmin, createAdminSession } = await import("../admin/admin-store.js");

const app = Fastify();
await registerAdminPlanRoutes(app);
await app.ready();

const admin = await createAdmin("plans-admin@example.test", "correct-horse-battery");
const session = await createAdminSession(admin.id);
const auth = { authorization: "Bearer " + session.token };

test.after(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

test("тарифы без сессии администратора недоступны", async () => {
  const response = await app.inject({ method: "GET", url: "/api/admin/plans" });
  assert.equal(response.statusCode, 401);
});

test("админка меняет название, описание, цену и скидку, а ответ сразу считает итог", async () => {
  const before = await app.inject({ method: "GET", url: "/api/admin/plans", headers: auth });
  assert.equal(before.statusCode, 200);
  const beforeBody = before.json() as { plans: Array<{ id: string; name: string; priceRub: number; discountPercent: number }> };
  assert.equal(beforeBody.plans.find(plan => plan.id === "pro")?.name, "Плюс");
  assert.equal(beforeBody.plans.find(plan => plan.id === "pro")?.priceRub, 990);

  const saved = await app.inject({
    method: "POST",
    url: "/api/admin/plans",
    headers: { ...auth, "content-type": "application/json" },
    payload: {
      pro: { name: "Профи", description: "Для постоянной работы", features: ["15 проектов", "Поддержка"], priceRub: 1200, discountPercent: 25 },
      team: { name: "Студия", description: "Для нескольких продуктов", features: ["50 проектов"], priceRub: 3000, discountPercent: 0 },
    },
  });
  assert.equal(saved.statusCode, 200);
  const body = saved.json() as { saved: boolean; plans: Array<{ id: string; name: string; features: string[]; priceLabel: string; basePriceLabel: string; discountPercent: number }> };
  assert.equal(body.saved, true);
  const pro = body.plans.find(plan => plan.id === "pro");
  assert.ok(pro);
  assert.equal(pro.name, "Профи");
  assert.deepEqual(pro.features, ["15 проектов", "Поддержка"]);
  assert.equal(pro.discountPercent, 25);
  assert.equal(pro.basePriceLabel.replace(/\u00a0/g, " "), "1 200 ₽");
  assert.equal(pro.priceLabel, "900 ₽", "в счёт и на витрину идёт цена со скидкой");

  const after = await app.inject({ method: "GET", url: "/api/admin/plans", headers: auth });
  assert.equal(after.statusCode, 200);
  const afterBody = after.json() as { plans: Array<{ id: string; name: string; features: string[]; priceLabel: string }> };
  assert.equal(afterBody.plans.find(plan => plan.id === "pro")?.name, "Профи");
  assert.deepEqual(afterBody.plans.find(plan => plan.id === "pro")?.features, ["15 проектов", "Поддержка"]);
  assert.equal(afterBody.plans.find(plan => plan.id === "pro")?.priceLabel, "900 ₽");
});

test("слишком большая скидка отклоняется, а прежние настройки остаются", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/plans",
    headers: { ...auth, "content-type": "application/json" },
    payload: {
      pro: { name: "Профи", description: "Для постоянной работы", priceRub: 1200, discountPercent: 95 },
      team: { name: "Студия", description: "Для нескольких продуктов", priceRub: 3000, discountPercent: 0 },
    },
  });
  assert.equal(response.statusCode, 400);

  const after = await app.inject({ method: "GET", url: "/api/admin/plans", headers: auth });
  const body = after.json() as { plans: Array<{ id: string; name: string; priceLabel: string; features: string[] }> };
  assert.equal(body.plans.find(plan => plan.id === "pro")?.name, "Профи");
  assert.equal(body.plans.find(plan => plan.id === "pro")?.priceLabel, "900 ₽");
  assert.deepEqual(body.plans.find(plan => plan.id === "pro")?.features, ["15 проектов", "Поддержка"], "отклонённая форма не стёрла пункты");
});

test("старый админ без поля features продолжает сохранять тариф", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/plans",
    headers: { ...auth, "content-type": "application/json" },
    payload: {
      pro: { name: "Профи", description: "Для постоянной работы", priceRub: 1200, discountPercent: 25 },
      team: { name: "Студия", description: "Для нескольких продуктов", priceRub: 3000, discountPercent: 0 },
    },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as { saved: boolean; plans: Array<{ id: string; features: string[] }> };
  assert.equal(body.saved, true);
  assert.deepEqual(body.plans.find(plan => plan.id === "pro")?.features, ["15 проектов", "Поддержка"], "старый клиент не стирает пункты");
});

test("слишком длинный список пунктов отклоняется", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/plans",
    headers: { ...auth, "content-type": "application/json" },
    payload: {
      pro: { name: "Профи", description: "Для постоянной работы", features: Array.from({ length: 11 }, (_, index) => "Пункт " + index), priceRub: 1200, discountPercent: 0 },
      team: { name: "Студия", description: "Для нескольких продуктов", features: [], priceRub: 3000, discountPercent: 0 },
    },
  });
  assert.equal(response.statusCode, 400);
});
