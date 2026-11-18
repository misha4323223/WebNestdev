import assert from "node:assert/strict";
import test from "node:test";
import { agentPlanBrief } from "./plan-brief.js";

test("«Старт» получает лимиты и запреты своего тарифа", () => {
  const brief = agentPlanBrief("free");
  assert.match(brief, /Current plan: «Старт» \(free\)/);
  assert.match(brief, /3 projects/);
  assert.match(brief, /1 hosting site/);
  assert.match(brief, /500 MB of account storage/);
  assert.match(brief, /10 agent runs per day/);
  assert.match(brief, /25 web searches per day/);
  assert.match(brief, /5 generated images per day/);
  assert.match(brief, /repository import up to 50 MB/);
  assert.match(brief, /Not available on this plan: .*serverless functions/);
  assert.match(brief, /the panel terminal/);
  assert.match(brief, /container and hybrid preview/);
  assert.match(brief, /pushing commits back to a repository/);
  assert.match(brief, /custom domains/);
  assert.match(brief, /the client database \(it starts on «Плюс»\)/);
  assert.match(brief, /CLIENT DATABASE: the built-in database is not available on this plan/);
  assert.doesNotMatch(brief, /serverless function per site/);
  assert.doesNotMatch(brief, /agent credits per month/);
});

test("«Плюс» получает кредиты, функции и домен, но не фоновые задания", () => {
  const brief = agentPlanBrief("pro");
  assert.match(brief, /Current plan: «Плюс» \(pro\)/);
  assert.match(brief, /6 projects/);
  assert.match(brief, /2 GB of account storage/);
  assert.match(brief, /5 000 agent credits per month/);
  assert.match(brief, /5 serverless functions per site/);
  assert.match(brief, /a client database of 128 MB/);
  assert.match(brief, /CLIENT DATABASE: this plan includes a managed PostgreSQL database/);
  assert.match(brief, /Встроенная база NestDev/);
  assert.match(brief, /database\.client with action='provision'/);
  assert.match(brief, /repository import up to 600 MB/);
  assert.match(brief, /pushing commits to a connected repository/);
  assert.match(brief, /a custom domain group \(apex \+ www\) per site/);
  assert.match(brief, /Not available on this plan: background jobs after the HTTP response/);
  assert.match(brief, /container and hybrid preview/);
  assert.match(brief, /Not available on this plan: .*the panel terminal/);
});

test("«Премиум» получает всё, что продаёт каталог", () => {
  const brief = agentPlanBrief("team");
  assert.match(brief, /Current plan: «Премиум» \(team\)/);
  assert.match(brief, /9 projects/);
  assert.match(brief, /10 GB of account storage/);
  assert.match(brief, /10 000 agent credits per month/);
  assert.match(brief, /25 serverless functions per site/);
  assert.match(brief, /a client database of 1024 MB/);
  assert.match(brief, /repository import up to 1024 MB/);
  assert.match(brief, /unlimited keyed services/);
  assert.doesNotMatch(brief, /Not available on this plan/);
});

test("памятка запрещает обходы и содержит контракт хостинга", () => {
  for (const plan of ["free", "pro", "team"] as const) {
    const brief = agentPlanBrief(plan);
    assert.match(brief, /HOSTING CAPABILITIES FOR THIS RUN/, plan);
    assert.match(brief, /Never try to reach a plan feature through a workaround/, plan);
    assert.match(brief, /no second project or account/, plan);
    assert.match(brief, /which plan provides it/, plan);
  }
});

test("без тарифа памятки нет", () => {
  assert.equal(agentPlanBrief(undefined), "");
});
