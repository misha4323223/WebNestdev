import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Квота времени песочницы проверяется на настоящем файловом хранилище: в бою это PostgreSQL, но
 * правила «сутки UTC, накопление, сброс» одинаковы в обоих режимах, а файловый можно проверить
 * без базы. Переменные выставляются до импорта — путь данных читается при загрузке модуля.
 */
const dataDir = await mkdtemp(path.join(os.tmpdir(), "nestdev-resource-quota-"));
process.env.WEBNESTDEV_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
delete process.env.WEBNESTDEV_STORAGE;
delete process.env.DATABASE_URL;
delete process.env.SANDBOX_MAX_PER_USER;

const quota = await import("./resource-quota.js");
const { limitsForPlan } = await import("./plans.js");

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test("секунды контейнеров складываются за сутки и не переходят между аккаунтами", async () => {
  await quota.addSandboxSeconds("user-one", 90);
  await quota.addSandboxSeconds("user-one", 30);
  assert.equal(await quota.readSandboxSeconds("user-one"), 120);
  assert.equal(await quota.readSandboxSeconds("user-two"), 0, "чужой счётчик не читается");
});

test("дневная граница UTC: на следующий день счёт начинается с нуля", async () => {
  const day = new Date("2026-11-07T23:00:00Z");
  await quota.addSandboxSeconds("user-day", 600, day);
  assert.equal(await quota.readSandboxSeconds("user-day", day), 600);
  const next = new Date("2026-11-08T00:05:00Z");
  assert.equal(await quota.readSandboxSeconds("user-day", next), 0);
});

test("минуты растут с тарифом, а параллельный контейнер один на всех", () => {
  assert.equal(quota.sandboxMinutesLimitFor("free"), limitsForPlan("free").resourceLimits.sandboxMinutesPerDay);
  assert.ok(quota.sandboxMinutesLimitFor("pro") > quota.sandboxMinutesLimitFor("free"));
  assert.ok(quota.sandboxMinutesLimitFor("team") > quota.sandboxMinutesLimitFor("pro"));
  // Правило продукта: один контейнер на аккаунт независимо от тарифа — агент всё равно один.
  for (const plan of ["free", "pro", "team"] as const) {
    assert.equal(quota.concurrentSandboxLimitFor(plan), 1, plan);
  }
});

test("исчерпанный бюджет — 429 с причиной, временем сброса и поддержкой", async () => {
  const limit = quota.sandboxMinutesLimitFor("free");
  await quota.addSandboxSeconds("user-full", limit * 60);
  const now = new Date("2026-11-07T10:00:00Z");
  await assert.rejects(quota.assertSandboxBudget("user-full", "free", now), (error: unknown) => {
    const typed = error as { statusCode?: number; code?: string; message: string };
    assert.equal(typed.statusCode, 429);
    assert.equal(typed.code, "SANDBOX_QUOTA_EXCEEDED");
    assert.match(typed.message, new RegExp(limit + " из " + limit));
    assert.match(typed.message, /00:00 UTC/);
    assert.match(typed.message, /поддержку/);
    return true;
  });
});

test("пока лимит не исчерпан, запуск разрешён", async () => {
  await quota.addSandboxSeconds("user-ok", 60);
  await quota.assertSandboxBudget("user-ok", "free", new Date("2026-11-07T10:00:00Z"));
});

test("SANDBOX_MAX_PER_USER переопределяет тариф, 0 — без ограничения на аккаунт", () => {
  try {
    process.env.SANDBOX_MAX_PER_USER = "1";
    assert.equal(quota.concurrentSandboxLimitFor("team"), 1);
    process.env.SANDBOX_MAX_PER_USER = "0";
    assert.equal(quota.concurrentSandboxLimitFor("free"), 0);
  } finally {
    delete process.env.SANDBOX_MAX_PER_USER;
  }
});

test("состояние для панели: минуты, лимит и параллельность", async () => {
  const usage = await quota.resourceUsageFor("user-view", "pro", new Date("2026-11-07T10:00:00Z"));
  assert.equal(usage.date, "2026-11-07");
  assert.equal(usage.sandboxMinutesUsed, 0);
  assert.equal(usage.sandboxMinutesLimit, quota.sandboxMinutesLimitFor("pro"));
  assert.equal(usage.concurrentLimit, quota.concurrentSandboxLimitFor("pro"));
});
