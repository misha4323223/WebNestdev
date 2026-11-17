import assert from "node:assert/strict";
import test from "node:test";
import { FunctionMetrics } from "./metrics.js";

test("пустые метрики не врут про среднее и hit ratio", () => {
  const metrics = new FunctionMetrics();
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.requests, 0);
  assert.equal(snapshot.completed, 0);
  assert.equal(snapshot.averageDurationMs, null);
  assert.equal(snapshot.cache.hitRatio, null);
  assert.deepEqual(snapshot.statuses, { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 });
});

test("считает запросы, статусы, байты и длительность, не считая повторный finish", () => {
  const metrics = new FunctionMetrics();
  const finish = metrics.begin(1_000);
  finish(200, 12, 1_040);
  finish(500, 999, 1_100);
  finish(404, 4, 1_200);

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.requests, 1);
  assert.equal(snapshot.completed, 1);
  assert.equal(snapshot.inFlight, 0);
  assert.equal(snapshot.statuses["2xx"], 1);
  assert.equal(snapshot.statuses["4xx"], 0);
  assert.equal(snapshot.responseBytes, 12);
  assert.equal(snapshot.totalDurationMs, 40);
  assert.equal(snapshot.averageDurationMs, 40);
  assert.equal(snapshot.maxDurationMs, 40);
});

test("считает переполнение, ошибки, кеш и сброс", () => {
  const metrics = new FunctionMetrics();
  metrics.recordCapacityRejection();
  metrics.recordInvokeFailure();
  metrics.recordJobEnqueueFailure();
  metrics.recordCrash();
  metrics.recordCacheHit();
  metrics.recordCacheMiss();
  metrics.recordCacheMiss();

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.capacityRejected, 1);
  assert.equal(snapshot.invokeFailed, 1);
  assert.equal(snapshot.jobEnqueueFailed, 1);
  assert.equal(snapshot.crashed, 1);
  assert.equal(snapshot.cache.hits, 1);
  assert.equal(snapshot.cache.misses, 2);
  assert.equal(snapshot.cache.hitRatio, 0.333);

  metrics.reset(5_000);
  const clean = metrics.snapshot();
  assert.equal(clean.requests, 0);
  assert.equal(clean.capacityRejected, 0);
  assert.equal(clean.cache.hits, 0);
  assert.equal(clean.startedAt, new Date(5_000).toISOString());
});
