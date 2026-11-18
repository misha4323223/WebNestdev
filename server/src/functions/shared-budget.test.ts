import assert from "node:assert/strict";
import test from "node:test";
import {
  checkFunctionsSharedBudget,
  sharedBudgetKey,
  sharedBudgetOptions,
} from "./shared-budget.js";

test("по умолчанию сайт получает 2400, аккаунт 4800 запросов в минуту", () => {
  assert.deepEqual(sharedBudgetOptions({} as NodeJS.ProcessEnv), {
    siteLimit: 2_400,
    accountLimit: 4_800,
    windowMs: 60_000,
  });
});

test("ключи сайта и аккаунта разные", () => {
  assert.equal(sharedBudgetKey("site", "site-1"), "functions:site:site-1");
  assert.equal(sharedBudgetKey("account", "user-1"), "functions:account:user-1");
});

test("при отказе сайта аккаунт уже не расходуется", async () => {
  const calls: string[] = [];
  const verdict = await checkFunctionsSharedBudget(
    { siteId: "site-1", userId: "user-1" },
    { siteLimit: 1, accountLimit: 10, windowMs: 60_000 },
    async key => {
      calls.push(key);
      return { allowed: false, retryAfter: 7 };
    },
  );
  assert.deepEqual(calls, ["functions:site:site-1"]);
  assert.deepEqual(verdict, { allowed: false, retryAfter: 7, scope: "site" });
});

test("аккаунт ограничивает несколько сайтов", async () => {
  const verdict = await checkFunctionsSharedBudget(
    { siteId: "site-1", userId: "user-1" },
    { siteLimit: 10, accountLimit: 2, windowMs: 60_000 },
    async key => key.includes("account")
      ? { allowed: false, retryAfter: 11 }
      : { allowed: true, retryAfter: 0 },
  );
  assert.deepEqual(verdict, { allowed: false, retryAfter: 11, scope: "account" });
});

test("недоступное хранилище не блокирует функции", async () => {
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    const verdict = await checkFunctionsSharedBudget(
      { siteId: "site-1", userId: "user-1" },
      { siteLimit: 1, accountLimit: 1, windowMs: 60_000 },
      async () => { throw new Error("storage down"); },
    );
    assert.deepEqual(verdict, { allowed: true, retryAfter: 0 });
  } finally {
    console.warn = warn;
  }
});
