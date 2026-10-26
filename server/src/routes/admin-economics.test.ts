import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Проверяются расчётные функции без базы: превращение токенов в деньги, разрез по тарифам и
 * формула цены подписки. SQL-часть новых маршрутов проверяется на живом Postgres после выкатки —
 * в песочнице его нет, как и у прежней статистики админки.
 *
 * Переменные окружения выставляются до импорта: модуль маршрутов тянет admin-store, который
 * читает тип хранилища и каталог данных при загрузке.
 */
process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_DATA_DIR = await mkdtemp(path.join(tmpdir(), "admin-economics-"));

const { priceGuidance, priceModelRows, planUsageStats, spendersFromRows, costWarnings } = await import("./admin-economics.js");
const { readModelPriceTable } = await import("../account/model-pricing.js");

const table = readModelPriceTable({
  PLATFORM_AI_MODEL_PRICES: JSON.stringify({
    "free-model": { input: 0, output: 0 },
    "paid-model": { input: 500, output: 500 },
  }),
  PLATFORM_AI_PRICE_CURRENCY: "RUB",
});

test("токены превращаются в деньги по каждой модели, а неизвестная модель остаётся без цены", () => {
  const priced = priceModelRows([
    { model: "free-model", prompt: 1_000_000, completion: 1_000_000, runs: 2, users: 1 },
    { model: "paid-model", prompt: 1_000_000, completion: 1_000_000, runs: 1, users: 1 },
    { model: "unknown-model", prompt: 1_000, completion: 0, runs: 1, users: 1 },
  ], table);

  assert.equal(priced.complete, false);
  assert.deepEqual(priced.unpriced, [{ model: "unknown-model", tokens: 1000 }]);
  // Бесплатная модель — ноль, платная — 500 + 500 за миллион каждого направления.
  assert.equal(priced.totalCost, 1000);
  const paid = priced.models.find(model => model.model === "paid-model")!;
  assert.equal(paid.cost, 1000);
  assert.equal(paid.tokenShare, 2_000_000 / 4_001_000);
  const unknown = priced.models.find(model => model.model === "unknown-model")!;
  assert.equal(unknown.cost, null);
  assert.equal(unknown.costShare, null);
});

test("разрез по тарифам относит расход к текущей подписке пользователя", () => {
  const plans = planUsageStats([
    { plan: "free", model: "free-model", prompt: 10_000_000, completion: 0, runs: 5 },
    { plan: "pro", model: "paid-model", prompt: 1_000_000, completion: 1_000_000, runs: 1 },
    { plan: "team", model: "paid-model", prompt: 2_000_000, completion: 0, runs: 1 },
  ], new Map([["free", 10], ["pro", 2], ["team", 1]]), table, 2000, 14_000_000);

  const free = plans.find(plan => plan.plan === "free")!;
  const pro = plans.find(plan => plan.plan === "pro")!;
  const team = plans.find(plan => plan.plan === "team")!;
  assert.equal(free.modelCost, 0);
  assert.equal(free.activeUsers, 10);
  assert.equal(pro.modelCost, 1000);
  assert.equal(team.modelCost, 1000);
  // Тариф без пользователей всё равно в ответе: админка не должна «терять» колонку.
  const empty = planUsageStats([], new Map(), table, 0, 0);
  assert.deepEqual(empty.map(plan => plan.plan), ["free", "pro", "team"]);
  assert.equal(empty[1].costShare, null);
});

test("топ расходов не прячет крупного потребителя из-за модели без цены", () => {
  const rows = [
    { id: "u1", email: "one@example.com", model: "paid-model", prompt: 1_000_000, completion: 0, runs: 2 },
    { id: "u2", email: "two@example.com", model: "free-model", prompt: 5_000_000, completion: 0, runs: 4 },
    { id: "u2", email: "two@example.com", model: "unknown-model", prompt: 1000, completion: 0, runs: 1 },
  ];
  const spenders = spendersFromRows(rows, table);
  assert.equal(spenders[0].id, "u2", "неизвестная цена не должна опускать крупного потребителя вниз");
  assert.equal(spenders[1].id, "u1");
  assert.equal(spenders[1].cost, 500);
  assert.equal(spenders[0].costComplete, false);
  assert.equal(spenders[1].costComplete, true);
});

test("цена подписки покрывает модель, инфраструктуру и дотацию бесплатного тарифа", () => {
  const guidance = priceGuidance({
    targetMargin: 0.7,
    monthlyFactor: 1,
    infraMonthly: 3000,
    freeModelCostPeriod: 300,
    paidSubscribers: 10,
    plans: [
      { plan: "free", subscribers: 0, modelCostPeriod: 300 },
      { plan: "pro", subscribers: 6, modelCostPeriod: 600 },
      { plan: "team", subscribers: 4, modelCostPeriod: 1200 },
    ],
  });

  assert.equal(guidance.length, 2);
  const pro = guidance.find(row => row.plan === "pro")!;
  const team = guidance.find(row => row.plan === "team")!;

  // pro: 600/6 = 100 модели + 3000/10 инфраструктуры + 300/10 дотации = 430.
  assert.equal(pro.breakEvenPrice, 430);
  // Цена под 70 % маржи: 430 / 0,3 = 1433,33 → 1440 (кратно 10).
  assert.equal(pro.suggestedPrice, 1440);
  assert.equal(pro.coversCostAtCurrentPrice, true);
  assert.ok(Math.abs(pro.marginAtCurrentPrice! - (990 - 430) / 990) < 1e-9);

  // team: 1200/4 = 300 модели + 300 инфраструктуры + 30 дотации = 630.
  assert.equal(team.breakEvenPrice, 630);
  assert.equal(team.suggestedPrice, 2100);
});

test("текущая цена берётся из настройки магазина, а не из каталога", () => {
  const previous = process.env.ROBOKASSA_PRICE_PRO;
  process.env.ROBOKASSA_PRICE_PRO = "1490";
  try {
    const guidance = priceGuidance({
      targetMargin: 0.7,
      monthlyFactor: 1,
      infraMonthly: 0,
      freeModelCostPeriod: 0,
      paidSubscribers: 1,
      plans: [{ plan: "pro", subscribers: 1, modelCostPeriod: 100 }],
    });
    assert.equal(guidance[0].currentPriceRub, 1490);
  } finally {
    if (previous === undefined) delete process.env.ROBOKASSA_PRICE_PRO;
    else process.env.ROBOKASSA_PRICE_PRO = previous;
  }
});

test("без платящих цена не выдумывается", () => {
  const guidance = priceGuidance({
    targetMargin: 0.7,
    monthlyFactor: 1,
    infraMonthly: 3000,
    freeModelCostPeriod: 500,
    paidSubscribers: 0,
    plans: [{ plan: "pro", subscribers: 0, modelCostPeriod: 100 }],
  });
  assert.deepEqual(guidance, []);
});

test("предупреждения объясняют, что именно не вошло в сумму", () => {
  const noPrices = readModelPriceTable({});
  const warnings = costWarnings({
    table: noPrices,
    unpriced: [{ model: "paid-model", tokens: 1234 }],
    infraConfigured: false,
    freeModelTokens: 100,
    freeFallbackConfigured: true,
  });
  assert.ok(warnings.some(text => text.includes("Цены моделей не заданы")));
  assert.ok(warnings.some(text => text.includes("Нет цены для моделей")));
  assert.ok(warnings.some(text => text.includes("free-model")));
  assert.ok(warnings.some(text => text.includes("PLATFORM_INFRA_COST_PER_MONTH")));
});
