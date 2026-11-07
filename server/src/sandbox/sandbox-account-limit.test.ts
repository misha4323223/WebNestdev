import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Очередь аккаунта проверяется вместе с настоящим счётчиком квоты: очередь и списание — одна
 * механика, и проверять их порознь значило бы пропустить случай «место освободили, а время не
 * списали». Данные — во временном каталоге, база не нужна.
 */
const dataDir = await mkdtemp(path.join(os.tmpdir(), "nestdev-sandbox-quota-"));
process.env.WEBNESTDEV_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
delete process.env.WEBNESTDEV_STORAGE;
delete process.env.DATABASE_URL;
process.env.SANDBOX_MAX_CONCURRENT = "3";
process.env.SANDBOX_MAX_PER_USER = "1";
process.env.SANDBOX_QUEUE_TIMEOUT_MS = "5000";

const { withSandboxSlot, resetSandboxLimiters, accountSandboxStats } = await import("./sandbox-limiter.js");
const quota = await import("../account/resource-quota.js");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

const tick = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));

test.beforeEach(() => resetSandboxLimiters());

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test("второй контейнер аккаунта ждёт, а другой аккаунт проходит без ожидания", async () => {
  const holding = deferred();
  const first = withSandboxSlot(async () => {
    await holding.promise;
  }, { userId: "account-a" });
  await tick();

  let otherRan = false;
  await withSandboxSlot(async () => {
    otherRan = true;
  }, { userId: "account-b" });
  assert.equal(otherRan, true, "чужое место не занимает очередь второго аккаунта");

  let secondRan = false;
  const second = withSandboxSlot(async () => {
    secondRan = true;
  }, { userId: "account-a" });
  await tick(60);
  assert.equal(secondRan, false, "второй контейнер того же аккаунта ждёт освобождения своего места");
  assert.equal(accountSandboxStats("account-a").active, 1);

  holding.resolve();
  await first;
  await second;
  assert.equal(secondRan, true);
});

test("время контейнера списывается в дневную квоту аккаунта", async () => {
  await withSandboxSlot(async () => {
    await tick(30);
  }, { userId: "account-time" });
  const used = await quota.readSandboxSeconds("account-time");
  assert.ok(used >= 1, "даже короткая команда списывает хотя бы секунду, получено " + used);
});

test("исчерпанный бюджет объясняется до старта контейнера", async () => {
  const limit = quota.sandboxMinutesLimitFor("free");
  await quota.addSandboxSeconds("account-full", limit * 60);
  let ran = false;
  await assert.rejects(
    withSandboxSlot(async () => {
      ran = true;
    }, { userId: "account-full" }),
    /Дневной лимит времени песочницы/,
  );
  assert.equal(ran, false, "контейнер не запускался");
});

test("без владельца команда идёт только под потолком хоста", async () => {
  assert.equal(await withSandboxSlot(async () => "ок"), "ок");
});
