import test from "node:test";
import assert from "node:assert/strict";
import { planAdminList, planPriceRub, publicPlans } from "./robokassa.js";
import { PLAN_CATALOG } from "../account/plans.js";

const MANAGED = ["PLAN_SETTINGS", "ROBOKASSA_PRICE_PRO", "ROBOKASSA_PRICE_TEAM"] as const;

function withSettings<T>(settings: unknown, run: () => T): T {
  return withRawSettings(settings === undefined ? undefined : JSON.stringify(settings), run);
}

function withRawSettings<T>(raw: string | undefined, run: () => T): T {
  const previous = new Map(MANAGED.map(name => [name, process.env[name]]));
  try {
    for (const name of MANAGED) delete process.env[name];
    if (raw !== undefined) process.env.PLAN_SETTINGS = raw;
    return run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("admin plan settings change the name, features, description and discounted price", () => {
  withSettings({
    version: 1,
    plans: {
      pro: { name: "Профи", description: "Для постоянной работы", features: ["15 проектов", "Поддержка"], priceRub: 1000, discountPercent: 20 },
      team: { name: "Студия", description: "Для нескольких продуктов", priceRub: 3000, discountPercent: 0 },
    },
  }, () => {
    const plans = publicPlans();
    const pro = plans.find(plan => plan.id === "pro");
    const team = plans.find(plan => plan.id === "team");
    assert.ok(pro && team);
    assert.equal(pro.name, "Профи");
    assert.equal(pro.description, "Для постоянной работы");
    assert.deepEqual(pro.features, ["15 проектов", "Поддержка"]);
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
    assert.deepEqual(admin[0].features, ["15 проектов", "Поддержка"]);
    assert.deepEqual(admin[1].features, [...PLAN_CATALOG.team.features], "без override остаётся каталог");
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
    assert.deepEqual(pro.features, [...PLAN_CATALOG.pro.features]);
  });
  withSettings({ plans: { pro: { features: "не массив" } } }, () => {
    const pro = publicPlans().find(plan => plan.id === "pro");
    assert.ok(pro);
    assert.deepEqual(pro.features, [...PLAN_CATALOG.pro.features]);
  });
});

test("features are trimmed, capped and never turn the showcase into an error", () => {
  withSettings({
    version: 1,
    plans: {
      pro: {
        name: "Профи",
        description: "Для постоянной работы",
        features: ["  15 проектов  ", "", "   ", "x".repeat(100), ...Array.from({ length: 12 }, (_, index) => "Пункт " + index)],
        priceRub: 1000,
        discountPercent: 0,
      },
    },
  }, () => {
    const pro = publicPlans().find(plan => plan.id === "pro");
    assert.ok(pro);
    assert.equal(pro.features.length, 10);
    assert.equal(pro.features[0], "15 проектов");
    assert.equal(pro.features[1], "x".repeat(80));
    const free = publicPlans().find(plan => plan.id === "free");
    assert.deepEqual(free?.features, [...PLAN_CATALOG.free.features], "бесплатный тариф всегда из каталога");
  });
});

test("broken PLAN_SETTINGS JSON keeps the catalog instead of returning 500", () => {
  withRawSettings("{ broken json", () => {
    const pro = publicPlans().find(plan => plan.id === "pro");
    assert.ok(pro);
    assert.equal(pro.name, "Плюс");
    assert.deepEqual(pro.features, [...PLAN_CATALOG.pro.features]);
  });
});
