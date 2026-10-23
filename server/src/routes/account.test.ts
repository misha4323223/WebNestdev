import test from "node:test";
import assert from "node:assert/strict";
import { FREE_PLAN, PLAN_CATALOG } from "./account.js";
import { balanceFor, integrationLimitFor, subscriptionFor, tokenPoolFor } from "../account/plans.js";
import { assertIntegrationSlot, IntegrationLimitError } from "../account/integration-limits.js";

test("paid plans carry a monthly price and quotas grow with the plan", () => {
  assert.equal(PLAN_CATALOG.free.priceLabel, "0 ₽");
  assert.equal(PLAN_CATALOG.free.priceRub, 0);
  assert.equal(PLAN_CATALOG.pro.priceRub, 990);
  assert.equal(PLAN_CATALOG.team.priceRub, 2990);
  assert.ok(PLAN_CATALOG.pro.priceLabel.includes("₽"), "цена тарифа видна в интерфейсе");
  assert.ok(PLAN_CATALOG.free.limits.projects < PLAN_CATALOG.pro.limits.projects);
  assert.ok(PLAN_CATALOG.pro.limits.projects < PLAN_CATALOG.team.limits.projects);
  assert.ok(PLAN_CATALOG.free.limits.agentRunsPerDay < PLAN_CATALOG.pro.limits.agentRunsPerDay);
  assert.ok(PLAN_CATALOG.pro.limits.agentRunsPerDay < PLAN_CATALOG.team.limits.agentRunsPerDay);
});

/** 700 MiB, not 700 000 000 bytes: the billing formatter divides by 1024 and must print «700 МБ». */
test("the free plan gives 700 MB of account storage", () => {
  assert.equal(PLAN_CATALOG.free.limits.storageBytes, 700 * 1024 * 1024);
  assert.ok(PLAN_CATALOG.free.features.includes("700 МБ хранилища"));
  assert.ok(PLAN_CATALOG.free.details.some(detail => detail.includes("на все проекты")), "квота подписана как общая на аккаунт");
});

/** Nothing user-visible may offer a demo plan again: the picker is a choice, not an entitlement. */
test("the plan catalog promises no demo tariff", () => {
  assert.ok(!JSON.stringify(PLAN_CATALOG).toLowerCase().includes("демо"), "the plan catalog still mentions a demo");
  assert.equal(FREE_PLAN, "free");
});

/**
 * Биллинг показывает подписку и баланс отдельными полями: с подключением оплаты меняется только
 * их содержимое, а экран остаётся тем же. Пока оплаты нет, баланс нулевой и это честно подписано.
 */
test("the billing account reports an active free plan and an empty balance until a payment exists", () => {
  const subscription = subscriptionFor("free", "2026-01-02T03:04:05.000Z");
  assert.equal(subscription.planName, PLAN_CATALOG.free.name);
  assert.equal(subscription.status, "active");
  assert.equal(subscription.startedAt, "2026-01-02T03:04:05.000Z");
  assert.equal(subscription.renewsAt, null);
  assert.equal(subscription.paymentConnected, false);
  assert.equal(subscription.autoRenew, false);
  assert.equal(subscription.amountRub, 0);
  assert.deepEqual(balanceFor(), { amount: 0, currency: "RUB", paymentsConnected: false });
});

/**
 * Пул токенов — то, что человек покупает на платном тарифе: он растёт вместе с ценой, а на
 * бесплатном его нет вовсе (там работает дневной лимит запусков). Это проверяется отдельно,
 * потому что ноль в каталоге означает «пула нет», а не «пул нулевой».
 */
test("the monthly token pool is a paid-plan benefit and grows with the plan", () => {
  assert.equal(tokenPoolFor("free"), 0, "бесплатный тариф живёт дневным лимитом запусков");
  assert.ok(tokenPoolFor("pro") > 0 && tokenPoolFor("team") > tokenPoolFor("pro"));
  assert.ok(PLAN_CATALOG.pro.features.some(feature => feature.includes("токенов")));
  assert.ok(PLAN_CATALOG.team.details.some(detail => detail.includes("токенов")));
  // Пул — не бесконечность и не «безлимит»: в описании сказано, по какому факту он считается.
  assert.ok(PLAN_CATALOG.pro.details.some(detail => detail.includes("фактический расход")));
});

/**
 * Интеграции на бесплатном тарифе ограничены по числу, на платных — нет. Уже подключённое
 * остаётся рабочим при смене тарифа: `replacing` и `used` внутри лимита проходят всегда.
 */
test("integration slots are a free-plan limit and never disconnect what already works", () => {
  assert.equal(integrationLimitFor("free", "cloud"), 1);
  assert.equal(integrationLimitFor("pro", "cloud"), null);
  assert.doesNotThrow(() => assertIntegrationSlot({ plan: "free", kind: "cloud", used: 0, replacing: false }));
  assert.throws(
    () => assertIntegrationSlot({ plan: "free", kind: "cloud", used: 1, replacing: false }),
    (error: unknown) => error instanceof IntegrationLimitError && error.statusCode === 403 && error.message.includes("«Старт»"),
  );
  assert.doesNotThrow(() => assertIntegrationSlot({ plan: "free", kind: "cloud", used: 1, replacing: true }));
  assert.doesNotThrow(() => assertIntegrationSlot({ plan: "pro", kind: "cloud", used: 9, replacing: false }));
});

test("every plan ships a tagline, an audience and detailed highlights for the subscription page", () => {
  for (const plan of Object.values(PLAN_CATALOG)) {
    assert.ok(plan.tagline.length > 0, plan.id + " tagline");
    assert.ok(plan.audience.length > 0, plan.id + " audience");
    assert.ok(plan.details.length >= 3, plan.id + " details");
    assert.ok(plan.details.every(detail => detail.length > 0), plan.id + " detail text");
  }
  assert.equal(Object.values(PLAN_CATALOG).filter(plan => plan.recommended).length, 1);
});
