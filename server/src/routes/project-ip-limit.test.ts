import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Счётчик создания проектов по адресу проверяется напрямую: маршрут — обёртка над ним, а сама
 * логика (десять проектов за сутки, отдельно на каждый адрес) и есть правило.
 */
const dataDir = await mkdtemp(path.join(os.tmpdir(), "nestdev-project-ip-"));
process.env.WEBNESTDEV_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
delete process.env.WEBNESTDEV_STORAGE;
delete process.env.DATABASE_URL;

const { reserveProjectCreationByIp } = await import("./projects.js");
const { clearRateLimits } = await import("../storage/rate-limit-store.js");

test.after(async () => {
  await clearRateLimits();
  await rm(dataDir, { recursive: true, force: true });
});

test("одиннадцатый проект с одного адреса за сутки отклоняется, первые десять проходят", async () => {
  await clearRateLimits();
  for (let index = 0; index < 10; index += 1) {
    const verdict = await reserveProjectCreationByIp("203.0.113.10");
    assert.equal(verdict.allowed, true, "попытка " + (index + 1) + " должна проходить");
  }
  const blocked = await reserveProjectCreationByIp("203.0.113.10");
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfter > 0, "видно, через сколько окно откроется");
});

test("счётчик отдельный на каждый адрес", async () => {
  await clearRateLimits();
  for (let index = 0; index < 10; index += 1) await reserveProjectCreationByIp("198.51.100.1");
  const other = await reserveProjectCreationByIp("198.51.100.2");
  assert.equal(other.allowed, true, "чужой адрес не расходует чужой лимит");
});
