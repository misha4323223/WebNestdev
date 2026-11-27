import test from "node:test";
import assert from "node:assert/strict";
import { hasActiveDeployPlan } from "./deploy-state.js";

test("плана нет — инструменты деплоя по состоянию не нужны", () => {
  assert.equal(hasActiveDeployPlan(null), false);
  assert.equal(hasActiveDeployPlan(undefined), false);
  assert.equal(hasActiveDeployPlan({ exists: false, complete: false, total: 0 }), false);
});

test("пустой файл без шагов — ещё не работа в процессе", () => {
  assert.equal(hasActiveDeployPlan({ exists: true, complete: false, total: 0 }), false);
});

test("завершённый план — история, а не текущая задача", () => {
  assert.equal(hasActiveDeployPlan({ exists: true, complete: true, total: 5 }), false);
});

test("незавершённые шаги включают инструменты деплоя для короткой реплики", () => {
  assert.equal(hasActiveDeployPlan({ exists: true, complete: false, total: 1 }), true);
  assert.equal(hasActiveDeployPlan({ exists: true, complete: false, total: 12 }), true);
});
