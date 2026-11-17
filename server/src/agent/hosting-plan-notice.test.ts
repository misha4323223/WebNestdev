import assert from "node:assert/strict";
import test from "node:test";
import { hostingPlanNotice } from "./hosting-plan-notice.js";

test("Старт получает только статику и не получает контракт функций", () => {
  const notice = hostingPlanNotice("free");
  assert.match(notice, /static hosting only/i);
  assert.match(notice, /«Плюс»/);
  assert.doesNotMatch(notice, /Functions contract/);
});

test("Плюс получает контракт функций и запрет постоянного сервера", () => {
  const notice = hostingPlanNotice("pro");
  assert.match(notice, /static hosting AND serverless functions/i);
  assert.match(notice, /Do not create a long-running/);
  assert.match(notice, /nestdev\.functions\.json/);
  assert.match(notice, /\/api\/\*/);
  assert.match(notice, /process\.env/);
  assert.match(notice, /Background jobs are not available/);
});

test("Премиум видит контейнерный preview, но production остаётся статикой и функциями", () => {
  const notice = hostingPlanNotice("team");
  assert.match(notice, /Container preview is available/);
  assert.match(notice, /does not change the production hosting model/);
  assert.match(notice, /background jobs/i);
  assert.match(notice, /60 seconds/);
  assert.match(notice, /permanent server process/);
});

test("без тарифа заметки нет", () => {
  assert.equal(hostingPlanNotice(undefined), "");
});
