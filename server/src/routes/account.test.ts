import test from "node:test";
import assert from "node:assert/strict";
import { FREE_PLAN, PLAN_CATALOG } from "./account.js";
import { balanceFor, subscriptionFor } from "../account/plans.js";

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

test("every plan ships a tagline, an audience and detailed highlights for the subscription page", () => {
  for (const plan of Object.values(PLAN_CATALOG)) {
    assert.ok(plan.tagline.length > 0, plan.id + " tagline");
    assert.ok(plan.audience.length > 0, plan.id + " audience");
    assert.ok(plan.details.length >= 3, plan.id + " details");
    assert.ok(plan.details.every(detail => detail.length > 0), plan.id + " detail text");
  }
  assert.equal(Object.values(PLAN_CATALOG).filter(plan => plan.recommended).length, 1);
});
