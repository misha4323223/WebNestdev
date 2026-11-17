import assert from "node:assert/strict";
import test from "node:test";
import { FunctionCapacityError, FunctionLimiter, type FunctionLimiterOptions } from "./function-limiter.js";

function limiter(overrides: Partial<FunctionLimiterOptions> = {}) {
  return new FunctionLimiter({
    maxConcurrent: 1,
    maxPerSite: 1,
    maxQueue: 2,
    waitMs: 100,
    ...overrides,
  });
}

test("общий лимит и лимит на сайт не дают одному сайту занять все слоты", async () => {
  const pool = limiter({ maxConcurrent: 2, maxPerSite: 1, maxQueue: 2 });
  const releaseA = await pool.acquire("site-a");
  const releaseB = await pool.acquire("site-b");
  let started = false;
  const queued = pool.acquire("site-a").then(release => {
    started = true;
    return release;
  });

  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(started, false, "второй вызов того же сайта обязан ждать");

  releaseA();
  const releaseA2 = await queued;
  assert.equal(started, true);
  releaseA2();
  releaseB();
});

test("переполненная очередь сразу даёт 503, а не плодит контейнеры", async () => {
  const pool = limiter({ maxQueue: 0 });
  const release = await pool.acquire("site-a");
  await assert.rejects(
    () => pool.acquire("site-b"),
    (error: unknown) => error instanceof FunctionCapacityError && error.statusCode === 503,
  );
  release();
});

test("ожидание слота ограничено по времени", async () => {
  const pool = limiter({ maxQueue: 1, waitMs: 20 });
  const release = await pool.acquire("site-a");
  await assert.rejects(
    () => pool.acquire("site-b"),
    (error: unknown) => error instanceof FunctionCapacityError && /Не дождались слота функции/.test(error.message),
  );
  release();
});

test("лимиты читаются из env и не выходят за безопасные границы", async () => {
  const { functionLimiterOptions } = await import("./function-limiter.js");
  assert.deepEqual(functionLimiterOptions({
    FUNCTIONS_MAX_CONCURRENT: "4",
    FUNCTIONS_MAX_CONCURRENT_PER_SITE: "3",
    FUNCTIONS_MAX_QUEUE: "8",
    FUNCTIONS_MAX_WAIT_MS: "2500",
  } as NodeJS.ProcessEnv), { maxConcurrent: 4, maxPerSite: 3, maxQueue: 8, waitMs: 2500 });
  assert.equal(functionLimiterOptions({ FUNCTIONS_MAX_CONCURRENT: "0" } as NodeJS.ProcessEnv).maxConcurrent, 2);
});
