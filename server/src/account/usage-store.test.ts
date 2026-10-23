import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { consumeAgentRun, consumeUsage, getBillingHistory, getTokenBudget, getUsageSnapshot, recordRunUsage, UsageLimitError } from "./usage-store.js";

test("daily agent quota blocks the next run and usage is isolated per account", async () => {
  const userId = "quota-test-" + randomUUID();
  const otherUserId = "quota-test-" + randomUUID();
  for (let index = 0; index < 10; index++) await consumeUsage(userId, "agentRuns", "free");
  await assert.rejects(
    () => consumeUsage(userId, "agentRuns", "free"),
    (error: unknown) => error instanceof UsageLimitError && error.limit === 10 && error.used === 10,
  );
  const own = await getUsageSnapshot(userId);
  const other = await getUsageSnapshot(otherUserId);
  assert.equal(own.agentRuns, 10);
  assert.equal(own.browserChecks, 0);
  assert.equal(other.agentRuns, 0);
});

test("daily browser quota is enforced independently from agent runs", async () => {
  const userId = "quota-test-" + randomUUID();
  for (let index = 0; index < 5; index++) await consumeUsage(userId, "browserChecks", "free");
  await assert.rejects(
    () => consumeUsage(userId, "browserChecks", "free"),
    (error: unknown) => error instanceof UsageLimitError && error.limit === 5 && error.used === 5,
  );
  assert.equal((await getUsageSnapshot(userId)).browserChecks, 5);
});

/**
 * Свой AI-провайдер проекта: запуск идёт за счёт пользователя (его ключ и его модель), поэтому дневная
 * квота встроенной модели к нему не применяется. Проверяются обе стороны: запуски со своим
 * провайдером не тратят квоту платформы, а запуски без него — тратят.
 */
test("a run on the project's own provider does not spend the platform quota", async () => {
  const userId = "quota-own-provider-" + randomUUID();
  for (let index = 0; index < 15; index++) await consumeAgentRun(userId, { ownProvider: true });
  assert.equal((await getUsageSnapshot(userId)).agentRuns, 0, "запуски за свой счёт не считаются");
  // Квота платформы осталась целой: на встроенной модели доступны все 10 запусков дня.
  for (let index = 0; index < 10; index++) await consumeAgentRun(userId, { ownProvider: false });
  assert.equal((await getUsageSnapshot(userId)).agentRuns, 10);
  await assert.rejects(() => consumeAgentRun(userId, { ownProvider: false }), UsageLimitError);
  // И даже с исчерпанной квотой платформы свой провайдер продолжает работать.
  await assert.doesNotReject(() => consumeAgentRun(userId, { ownProvider: true }));
  assert.equal((await getUsageSnapshot(userId)).agentRuns, 10);
});

/**
 * Пул токенов читается из фактического расхода модели (`model_usage`), поэтому отдельного
 * счётчика нет и расхождение невозможно. На бесплатном тарифе пула нет: `limit: 0`, шкалу не рисуем.
 */
test("the monthly token budget reads real model usage, and the free plan has no pool", async () => {
  const userId = "token-pool-" + randomUUID();
  const empty = await getTokenBudget(userId, "free");
  assert.equal(empty.limit, 0, "на бесплатном тарифе пула нет");
  assert.equal(empty.remaining, 0);
  assert.match(empty.month, /^\d{4}-\d{2}$/);

  await recordRunUsage(userId, {
    runId: randomUUID(),
    projectId: "token-pool-project",
    model: "test-model",
    promptTokens: 400,
    completionTokens: 600,
    estimated: false,
  });
  const paid = await getTokenBudget(userId, "pro");
  assert.equal(paid.used, 1000, "пул считает и промпт, и ответ модели");
  assert.equal(paid.remaining, paid.limit - 1000);
  assert.equal(paid.month, empty.month);
});

test("the daily web search quota grows with the plan and is counted separately", async () => {
  const userId = "quota-search-" + randomUUID();
  for (let index = 0; index < 24; index++) await consumeUsage(userId, "webSearches", "free");
  const snapshot = await consumeUsage(userId, "webSearches", "free");
  assert.equal(snapshot.webSearches, 25);
  assert.equal(snapshot.agentRuns, 0, "поиски не тратят квоту запусков");
  await assert.rejects(
    () => consumeUsage(userId, "webSearches", "free"),
    (error: unknown) => error instanceof UsageLimitError && error.limit === 25 && error.kind === "webSearches",
  );
  // Платный тариф даёт больше поисков — граница берётся из каталога, а не из константы.
  await assert.doesNotReject(() => consumeUsage(userId, "webSearches", "pro"));
});

/**
 * Вкладка биллинга читает недельную историю: пустые дни в ней обязаны остаться на месте, иначе
 * график врал бы о перерывах, а подпись «сегодня» съезжала бы на вчера.
 */
test("billing history returns a zero-filled week with today's usage in the last day", async () => {
  const userId = "billing-history-" + randomUUID();
  await consumeUsage(userId, "agentRuns", "free");
  await consumeUsage(userId, "webSearches", "free");
  const history = await getBillingHistory(userId, 7);
  assert.equal(history.days.length, 7);
  const today = history.days[6];
  assert.equal(today.date, new Date().toISOString().slice(0, 10));
  assert.equal(today.agentRuns, 1);
  assert.equal(today.webSearches, 1);
  assert.equal(today.browserChecks, 0);
  assert.deepEqual(
    { runs: today.runs, prompt: today.promptTokens },
    { runs: 0, prompt: 0 },
    "без прогонов модели расходов за день нет",
  );
  const yesterday = history.days[5];
  assert.equal(yesterday.agentRuns + yesterday.browserChecks + yesterday.webSearches, 0);
});

test("concurrent reservations never exceed the daily quota", async () => {
  const userId = "quota-concurrency-" + randomUUID();
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, () => consumeUsage(userId, "agentRuns", "free")),
  );
  assert.equal(results.filter(result => result.status === "fulfilled").length, 10);
  assert.equal(results.filter(result => result.status === "rejected" && result.reason instanceof UsageLimitError).length, 10);
  assert.equal((await getUsageSnapshot(userId)).agentRuns, 10);
});
