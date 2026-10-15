import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { consumeAgentRun, consumeUsage, getUsageSnapshot, UsageLimitError } from "./usage-store.js";

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

test("concurrent reservations never exceed the daily quota", async () => {
  const userId = "quota-concurrency-" + randomUUID();
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, () => consumeUsage(userId, "agentRuns", "free")),
  );
  assert.equal(results.filter(result => result.status === "fulfilled").length, 10);
  assert.equal(results.filter(result => result.status === "rejected" && result.reason instanceof UsageLimitError).length, 10);
  assert.equal((await getUsageSnapshot(userId)).agentRuns, 10);
});
