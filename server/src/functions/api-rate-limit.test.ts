import assert from "node:assert/strict";
import test from "node:test";
import {
  checkFunctionsApiRateLimit,
  functionsApiRateLimitKey,
  functionsApiRateLimitOptions,
} from "./api-rate-limit.js";

test("по умолчанию разрешает 120 запросов в минуту с одного IP на сайт", () => {
  assert.deepEqual(functionsApiRateLimitOptions({} as NodeJS.ProcessEnv), {
    limit: 120,
    windowMs: 60_000,
  });
});

test("лимит из окружения читается и ограничивается разумным диапазоном", () => {
  assert.equal(
    functionsApiRateLimitOptions({ FUNCTIONS_API_RATE_LIMIT_PER_MINUTE: "30" } as NodeJS.ProcessEnv).limit,
    30,
  );
  assert.equal(
    functionsApiRateLimitOptions({ FUNCTIONS_API_RATE_LIMIT_PER_MINUTE: "0" } as NodeJS.ProcessEnv).limit,
    120,
  );
  assert.equal(
    functionsApiRateLimitOptions({ FUNCTIONS_API_RATE_LIMIT_PER_MINUTE: "999999" } as NodeJS.ProcessEnv).limit,
    120,
  );
});

test("ключ разделяет сайты и адреса, пустой адрес не смешивается с реальным", () => {
  assert.equal(functionsApiRateLimitKey("site-1", "10.0.0.1"), "functions:api:site-1:10.0.0.1");
  assert.equal(functionsApiRateLimitKey("site-2", "10.0.0.1"), "functions:api:site-2:10.0.0.1");
  assert.equal(functionsApiRateLimitKey("site-1", ""), "functions:api:site-1:unknown");
});

test("возвращает retryAfter, когда окно закрыто", async () => {
  const calls: Array<[string, number, number]> = [];
  const verdict = await checkFunctionsApiRateLimit(
    "site-1",
    "10.0.0.1",
    { limit: 2, windowMs: 60_000 },
    async (key, limit, windowMs) => {
      calls.push([key, limit, windowMs]);
      return { allowed: false, retryAfter: 17 };
    },
  );

  assert.deepEqual(calls, [["functions:api:site-1:10.0.0.1", 2, 60_000]]);
  assert.deepEqual(verdict, { allowed: false, retryAfter: 17 });
});

test("недоступное хранилище не блокирует сайт", async () => {
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    const verdict = await checkFunctionsApiRateLimit(
      "site-1",
      "10.0.0.1",
      { limit: 1, windowMs: 60_000 },
      async () => {
        throw new Error("storage down");
      },
    );
    assert.deepEqual(verdict, { allowed: true, retryAfter: 0 });
  } finally {
    console.warn = warn;
  }
});
