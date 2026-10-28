import test from "node:test";
import assert from "node:assert/strict";
import { planAdminList, planPriceRub, publicPlans } from "./robokassa.js";

const MANAGED = ["PLAN_SETTINGS", "ROBOKASSA_PRICE_PRO", "ROBOKASSA_PRICE_TEAM"] as const;

function withSettings<T>(settings: unknown, run: () => T): T {
  const previous = new Map(MANAGED.map(name => [name, process.env[name]]));
  try {
    for (const name of MANAGED) delete process.env[name];
    if (settings !== undefined) process.env.PLAN_SETTINGS = JSON.stringify(settings);
    return run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("admin plan settings change the name, description and discounted price", () => {
  withSettings({
    version: 1,
    plans: {
      pro: { name: "Профи", description: "Для постоянной работы", priceRub: 1000, discountPercent: 20 },
      team: { name: "Студия", description: "Для нескольких продуктов", priceRub: 3000, discountPercent: 0 },
    },
  }, () => {
    const plans = publicPlans();
    const pro = plans.find(plan => plan.id === "pro");
    const team = plans.find(plan => plan.id === "team");
    assert.ok(pro && team);
    assert.equal(pro.name, "Профи");
    assert.equal(pro.description, "Для постоянной работы");
    assert.equal(pro.priceRub, 800);
    assert.equal(pro.basePriceRub, 1000);
    assert.equal(pro.priceLabel, "800 ₽");
    assert.equal(pro.basePriceLabel.replace(/\u00a0/g, " "), "1 000 ₽");
    assert.equal(pro.discountPercent, 20);
    assert.equal(team.priceRub, 3000);
    assert.equal(team.discountPercent, 0);

    const admin = planAdminList();
    assert.deepEqual(admin.map(plan => plan.id), ["pro", "team"]);
    assert.equal(admin[0].priceRub, 1000, "форма редактирует базовую цену, а не итоговую");
    assert.equal(admin[0].priceLabel, "800 ₽");
  });
});

test("a broken or incomplete plan setting falls back to the catalog instead of breaking checkout", () => {
  withSettings(undefined, () => {
    assert.equal(planPriceRub("pro"), 990);
  });
  withSettings({ plans: { pro: { name: " ", priceRub: -1, discountPercent: 200 } } }, () => {
    const pro = publicPlans().find(plan => plan.id === "pro");
    assert.ok(pro);
    assert.equal(pro.name, "Плюс");
    assert.equal(pro.description, "Для регулярной разработки");
    assert.equal(pro.priceRub, 990);
  });
});
