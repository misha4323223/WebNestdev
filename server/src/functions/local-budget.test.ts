import assert from "node:assert/strict";
import test from "node:test";
import { LocalTokenBucket, localBudgetKey, localBudgetOptions } from "./local-budget.js";

test("4 CPU дают 100 RPS на ноду, 2 CPU — 50", () => {
  assert.equal(localBudgetOptions({} as NodeJS.ProcessEnv, 4).globalRps, 100);
  assert.equal(localBudgetOptions({} as NodeJS.ProcessEnv, 2).globalRps, 50);
});

test("env переопределяет локальные лимиты", () => {
  const options = localBudgetOptions({
    FUNCTIONS_LOCAL_GLOBAL_RPS: "20",
    FUNCTIONS_LOCAL_GLOBAL_BURST: "5",
    FUNCTIONS_LOCAL_IP_RPS: "3",
    FUNCTIONS_LOCAL_IP_BURST: "4",
    FUNCTIONS_LOCAL_SITE_RPS: "7",
    FUNCTIONS_LOCAL_SITE_BURST: "8",
    FUNCTIONS_LOCAL_MAX_KEYS: "1000",
  } as NodeJS.ProcessEnv, 4);
  assert.deepEqual(options, {
    globalRps: 20,
    globalBurst: 5,
    ipRps: 3,
    ipBurst: 4,
    siteRps: 7,
    siteBurst: 8,
    maxKeys: 1000,
  });
});

test("bucket разрешает всплеск и затем отказывает с retryAfter", () => {
  const bucket = new LocalTokenBucket(100);
  const now = 1_000_000;
  assert.deepEqual(bucket.take("global", 1, 2, now), { allowed: true, retryAfter: 0 });
  assert.deepEqual(bucket.take("global", 1, 2, now), { allowed: true, retryAfter: 0 });
  assert.deepEqual(bucket.take("global", 1, 2, now), { allowed: false, retryAfter: 1 });
  assert.deepEqual(bucket.take("global", 1, 2, now + 1_000), { allowed: true, retryAfter: 0 });
});

test("ключи не смешивают глобальный бюджет, IP и сайт", () => {
  assert.equal(localBudgetKey("global"), "global");
  assert.equal(localBudgetKey("ip", "10.0.0.1"), "ip:10.0.0.1");
  assert.equal(localBudgetKey("site", "site-1"), "site:site-1");
});
