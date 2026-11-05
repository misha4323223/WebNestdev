import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_DATA_DIR = await mkdtemp(path.join(tmpdir(), "jobs-worker-"));

const dirs: string[] = [];
async function freshQueue() {
  const dir = await mkdtemp(path.join(tmpdir(), "jobs-worker-case-"));
  dirs.push(dir);
  process.env.WEBNESTDEV_DATA_DIR = dir;
}

const { enqueueJob, jobById } = await import("./store.js");
const { retryDelayMs, startJobWorker } = await import("./worker.js");

after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const at = (ms: number) => new Date(1_700_000_000_000 + ms);
const silent = () => undefined;

test("воркер выполняет задание и пишет итог с прогрессом", async () => {
  await freshQueue();
  const job = await enqueueJob({ kind: "project.archive", projectId: "w-done", userId: "u1", now: at(0) });
  const seen: string[] = [];
  const worker = startJobWorker({
    now: () => at(0),
    log: silent,
    handlers: {
      "project.archive": async record => {
        seen.push(record.projectId);
        return { done: 1234, total: 1234 };
      },
    },
  });
  try {
    await worker.tick();
    // Задание выполняется асинхронно: ждём, пока оно закроется в хранилище.
    const deadline = Date.now() + 2000;
    let stored = await jobById(job.id);
    while (stored && stored.state !== "done" && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
      stored = await jobById(job.id);
    }
    assert.deepEqual(seen, ["w-done"]);
    assert.equal(stored!.state, "done");
    assert.equal(stored!.progressDone, 1234);
    assert.equal(stored!.progressTotal, 1234);
  } finally {
    worker.stop();
  }
});

test("ошибка обработчика откладывает задание и оставляет причину", async () => {
  await freshQueue();
  const job = await enqueueJob({ kind: "project.restore", projectId: "w-retry", userId: "u1", now: at(0) });
  const worker = startJobWorker({
    now: () => at(0),
    log: silent,
    handlers: {
      "project.restore": async () => {
        throw new Error("бакет ответил 503");
      },
    },
  });
  try {
    await worker.tick();
    const deadline = Date.now() + 2000;
    let stored = await jobById(job.id);
    while (stored && stored.state === "running" && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
      stored = await jobById(job.id);
    }
    assert.equal(stored!.state, "queued", "после первой ошибки задание ждёт повтора");
    assert.equal(stored!.lastError, "бакет ответил 503");
    assert.equal(stored!.attempts, 1);
    assert.ok(stored!.runAfter > at(0).toISOString(), "повтор отложен, а не мгновенный");
  } finally {
    worker.stop();
  }
});

test("после последней попытки задание закрывается ошибкой", async () => {
  await freshQueue();
  const job = await enqueueJob({
    kind: "project.archive",
    projectId: "w-fail",
    userId: "u1",
    maxAttempts: 1,
    now: at(0),
  });
  const worker = startJobWorker({
    now: () => at(0),
    log: silent,
    handlers: {
      "project.archive": async () => {
        throw new Error("нет места");
      },
    },
  });
  try {
    await worker.tick();
    const deadline = Date.now() + 2000;
    let stored = await jobById(job.id);
    while (stored && stored.state === "running" && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
      stored = await jobById(job.id);
    }
    assert.equal(stored!.state, "failed");
    assert.equal(stored!.lastError, "нет места");
  } finally {
    worker.stop();
  }
});

test("задание без обработчика не висит в очереди", async () => {
  await freshQueue();
  const job = await enqueueJob({ kind: "project.archive", projectId: "w-unknown", userId: "u1", now: at(0) });
  const worker = startJobWorker({ now: () => at(0), log: silent, handlers: {} });
  try {
    await worker.tick();
    const deadline = Date.now() + 2000;
    let stored = await jobById(job.id);
    while (stored && stored.state === "running" && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
      stored = await jobById(job.id);
    }
    assert.equal(stored!.state, "failed");
    assert.match(stored!.lastError, /обработчика/);
  } finally {
    worker.stop();
  }
});

test("backoff растёт вдвое и упирается в потолок", () => {
  assert.equal(retryDelayMs(1), 30_000);
  assert.equal(retryDelayMs(2), 60_000);
  assert.equal(retryDelayMs(3), 120_000);
  assert.equal(retryDelayMs(20), 10 * 60_000);
});
