import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_DATA_DIR = await mkdtemp(path.join(tmpdir(), "rate-limit-store-"));

const { activeRateLimitWindows, clearRateLimits, consumeRateLimit } = await import("./rate-limit-store.js");

after(async () => {
  await rm(process.env.WEBNESTDEV_DATA_DIR!, { recursive: true, force: true });
});

test("окно пропускает ровно лимит попыток и говорит, когда откроется", async () => {
  await clearRateLimits();
  const now = 1_700_000_000_000;
  const results = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    results.push(await consumeRateLimit("ip:login:1.2.3.4", 3, 60_000, now));
  }
  assert.deepEqual(results.map(item => item.allowed), [true, true, true, false, false]);
  const blocked = results[3];
  assert.ok(blocked && blocked.retryAfter > 0 && blocked.retryAfter <= 60);
});

test("после окончания окна счётчик начинается заново", async () => {
  await clearRateLimits();
  const now = 1_700_000_000_000;
  for (let attempt = 0; attempt < 3; attempt += 1) await consumeRateLimit("subject:login:a@b", 2, 60_000, now);
  assert.equal((await consumeRateLimit("subject:login:a@b", 2, 60_000, now)).allowed, false);

  const later = now + 61_000;
  assert.equal((await consumeRateLimit("subject:login:a@b", 2, 60_000, later)).allowed, true);
});

test("двадцать одновременных попыток не проскакивают сверх лимита", async () => {
  await clearRateLimits();
  const now = 1_700_000_000_000;
  const verdicts = await Promise.all(
    Array.from({ length: 20 }, () => consumeRateLimit("ip:register:race", 5, 60_000, now)),
  );
  assert.equal(verdicts.filter(item => item.allowed).length, 5);
});

test("разные ключи не смешиваются, счётчик окон и сброс работают", async () => {
  await clearRateLimits();
  const now = Date.now();
  await consumeRateLimit("ip:login:one", 1, 60_000, now);
  await consumeRateLimit("ip:login:two", 1, 60_000, now);
  assert.equal((await consumeRateLimit("ip:login:one", 1, 60_000, now)).allowed, false);
  assert.equal((await consumeRateLimit("ip:login:two", 1, 60_000, now)).allowed, false);
  assert.equal(await activeRateLimitWindows(now), 2);

  await clearRateLimits();
  assert.equal(await activeRateLimitWindows(now), 0);
  assert.equal((await consumeRateLimit("ip:login:one", 1, 60_000, now)).allowed, true);
});
