import test from "node:test";
import assert from "node:assert/strict";
import { FREE_PLAN, PLAN_CATALOG } from "./account.js";

test("paid plans are marked as not on sale yet and quotas grow with the plan", () => {
  assert.equal(PLAN_CATALOG.free.priceLabel, "0 ₽");
  assert.equal(PLAN_CATALOG.pro.priceLabel, "Скоро");
  assert.equal(PLAN_CATALOG.team.priceLabel, "Скоро");
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

test("every plan ships a tagline, an audience and detailed highlights for the subscription page", () => {
  for (const plan of Object.values(PLAN_CATALOG)) {
    assert.ok(plan.tagline.length > 0, plan.id + " tagline");
    assert.ok(plan.audience.length > 0, plan.id + " audience");
    assert.ok(plan.details.length >= 3, plan.id + " details");
    assert.ok(plan.details.every(detail => detail.length > 0), plan.id + " detail text");
  }
  assert.equal(Object.values(PLAN_CATALOG).filter(plan => plan.recommended).length, 1);
});
