import test from "node:test";
import assert from "node:assert/strict";
import {
  assertPlanFeature,
  entitlementsFor,
  planAllows,
  PlanFeatureError,
  planFeatureMessage,
  requiredPlanFor,
} from "./entitlements.js";

test("Старт получает только статический хостинг", () => {
  assert.deepEqual({ ...entitlementsFor("free") }, {
    staticHosting: true,
    serverlessFunctions: false,
    backgroundJobs: false,
    interactiveTerminal: false,
    containerPreview: false,
  });
});

test("Плюс добавляет функции, но не терминал и не контейнерный предпросмотр", () => {
  assert.equal(planAllows("pro", "staticHosting"), true);
  assert.equal(planAllows("pro", "serverlessFunctions"), true);
  assert.equal(planAllows("pro", "backgroundJobs"), false);
  assert.equal(planAllows("pro", "interactiveTerminal"), false);
  assert.equal(planAllows("pro", "containerPreview"), false);
});

test("Премиум открывает все возможности", () => {
  assert.deepEqual({ ...entitlementsFor("team") }, {
    staticHosting: true,
    serverlessFunctions: true,
    backgroundJobs: true,
    interactiveTerminal: true,
    containerPreview: true,
  });
});

test("матрица не меняется через возвращённый объект", () => {
  const entitlements = entitlementsFor("free") as Record<string, boolean>;
  assert.throws(() => {
    entitlements.interactiveTerminal = true;
  }, TypeError);
  assert.equal(planAllows("free", "interactiveTerminal"), false);
});

test("отказ называет тариф, возможность и нужный тариф", () => {
  assert.equal(requiredPlanFor("serverlessFunctions"), "pro");
  assert.equal(requiredPlanFor("backgroundJobs"), "team");
  assert.equal(requiredPlanFor("interactiveTerminal"), "team");
  assert.equal(requiredPlanFor("containerPreview"), "team");
  assert.match(planFeatureMessage("pro", "interactiveTerminal"), /Плюс/);
  assert.match(planFeatureMessage("pro", "interactiveTerminal"), /Премиум/);
  assert.match(planFeatureMessage("free", "serverlessFunctions"), /функции/);
});

test("assertPlanFeature бросает типизированный отказ только при запрете", () => {
  assert.doesNotThrow(() => assertPlanFeature("pro", "serverlessFunctions"));
  assert.throws(() => assertPlanFeature("pro", "interactiveTerminal"), (error: unknown) => {
    assert.ok(error instanceof PlanFeatureError);
    assert.equal(error.code, "PLAN_FEATURE_REQUIRED");
    assert.equal(error.statusCode, 403);
    assert.equal(error.plan, "pro");
    assert.equal(error.feature, "interactiveTerminal");
    return true;
  });
});
