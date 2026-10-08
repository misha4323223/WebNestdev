import test from "node:test";
import assert from "node:assert/strict";
import { PLAN_CATALOG } from "./account.js";

test("demo plan catalog has no real prices and has progressively higher quotas", () => {
  assert.equal(PLAN_CATALOG.free.priceLabel, "$0");
  assert.equal(PLAN_CATALOG.pro.priceLabel, "Демо");
  assert.equal(PLAN_CATALOG.team.priceLabel, "Демо");
  assert.ok(PLAN_CATALOG.free.limits.projects < PLAN_CATALOG.pro.limits.projects);
  assert.ok(PLAN_CATALOG.pro.limits.projects < PLAN_CATALOG.team.limits.projects);
  assert.ok(PLAN_CATALOG.free.limits.agentRunsPerDay < PLAN_CATALOG.pro.limits.agentRunsPerDay);
  assert.ok(PLAN_CATALOG.pro.limits.agentRunsPerDay < PLAN_CATALOG.team.limits.agentRunsPerDay);
});
