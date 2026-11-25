import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Квота долгих заданий проверяется на настоящем счётчике: задание списывает не «одну команду»,
 * а секунды жизни своего контейнера, и это должно быть видно в том же дневном счётчике, что у
 * обычных команд. Данные — во временном каталоге, база не нужна.
 */
const dataDir = await mkdtemp(path.join(os.tmpdir(), "nestdev-job-quota-"));
process.env.WEBNESTDEV_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
delete process.env.WEBNESTDEV_STORAGE;
delete process.env.DATABASE_URL;

const quota = await import("../account/resource-quota.js");
const { assertSandboxJobBudget, chargeSandboxJob, sandboxJobSeconds } = await import("./job-quota.js");

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test("задание списывает фактическое время жизни контейнера в дневную квоту", async () => {
  await chargeSandboxJob("job-time", Date.now() - 90_000);
  const used = await quota.readSandboxSeconds("job-time");
  assert.ok(used >= 90, "ожидалось не меньше 90 с, получено " + used);
});

test("короткое задание списывает хотя бы секунду, а не ноль", () => {
  assert.equal(sandboxJobSeconds(Date.now()), 1);
  assert.equal(sandboxJobSeconds(Date.now() - 5_000), 5);
});

test("исчерпанный лимит объясняется до старта задания", async () => {
  const limit = quota.sandboxMinutesLimitFor("free");
  await quota.addSandboxSeconds("job-full", limit * 60);
  await assert.rejects(assertSandboxJobBudget("job-full"), /Дневной лимит времени песочницы/);
});

test("при свободном лимите задание стартует", async () => {
  await assertSandboxJobBudget("job-fresh");
});

test("без владельца проверка и списание ничего не делают", async () => {
  await assertSandboxJobBudget("");
  await chargeSandboxJob("", Date.now() - 60_000);
});
