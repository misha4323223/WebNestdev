import assert from "node:assert/strict";
import test from "node:test";
import { hostingPlanNotice } from "./hosting-plan-notice.js";

test("Старт знает свой тариф, получает только статику и не получает контракт функций", () => {
  const notice = hostingPlanNotice("free");
  assert.match(notice, /Current plan: «Старт» \(free\)/);
  assert.match(notice, /static hosting only/i);
  assert.match(notice, /Preview: this plan is static only/);
  assert.match(notice, /Do not create API handlers/);
  assert.match(notice, /«Плюс»/);
  assert.doesNotMatch(notice, /Functions contract/);
});

test("Плюс знает тариф, получает контракт функций и статический preview", () => {
  const notice = hostingPlanNotice("pro");
  assert.match(notice, /Current plan: «Плюс» \(pro\)/);
  assert.match(notice, /static hosting AND serverless functions/i);
  assert.match(notice, /Do not create a long-running/);
  assert.match(notice, /executes the serverless functions declared in nestdev\.functions\.json in one preview container/);
  assert.match(notice, /The \/api\/\* routes work in preview/);
  assert.match(notice, /test them with preview\.start and project\.verify before publishing/);
  assert.doesNotMatch(notice, /not executed in static preview/);
  assert.match(notice, /nestdev\.functions\.json/);
  assert.match(notice, /\/api\/\*/);
  assert.match(notice, /process\.env/);
  assert.match(notice, /Background jobs are not available/);
});

test("Премиум знает тариф и видит контейнерный preview, но production остаётся статикой и функциями", () => {
  const notice = hostingPlanNotice("team");
  assert.match(notice, /Current plan: «Премиум» \(team\)/);
  assert.match(notice, /container\/hybrid development runtime/);
  assert.match(notice, /it prefers hybrid/i);
  assert.match(notice, /package\.json\.preview/);
  assert.match(notice, /pure container only when/i);
  assert.match(notice, /does not change the production hosting model/);
  assert.match(notice, /never launch/);
  assert.match(notice, /background jobs/i);
  assert.match(notice, /60 seconds/);
  assert.match(notice, /permanent server process/);
});

test("без тарифа заметки нет", () => {
  assert.equal(hostingPlanNotice(undefined), "");
});
