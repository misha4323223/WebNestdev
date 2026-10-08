import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { consumeUsage, getUsageSnapshot, UsageLimitError } from "./usage-store.js";

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

test("concurrent reservations never exceed the daily quota", async () => {
  const userId = "quota-concurrency-" + randomUUID();
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, () => consumeUsage(userId, "agentRuns", "free")),
  );
  assert.equal(results.filter(result => result.status === "fulfilled").length, 10);
  assert.equal(results.filter(result => result.status === "rejected" && result.reason instanceof UsageLimitError).length, 10);
  assert.equal((await getUsageSnapshot(userId)).agentRuns, 10);
});
