import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_DATA_DIR = await mkdtemp(path.join(tmpdir(), "jobs-store-"));

/** Своя очередь на каждый тест: иначе остатки предыдущего задания попадают в следующий захват. */
const dirs: string[] = [];
async function freshQueue() {
  const dir = await mkdtemp(path.join(tmpdir(), "jobs-store-case-"));
  dirs.push(dir);
  process.env.WEBNESTDEV_DATA_DIR = dir;
}

const {
  claimJob,
  enqueueJob,
  finishJob,
  jobById,
  jobCounters,
  listJobs,
  retryJob,
  updateJobProgress,
} = await import("./store.js");

after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const at = (ms: number) => new Date(1_700_000_000_000 + ms);

test("задание ставится в очередь, повторная постановка возвращает его же", async () => {
  await freshQueue();
  const first = await enqueueJob({ kind: "project.archive", projectId: "p-dedupe", userId: "u1", now: at(0) });
  assert.equal(first.state, "queued");
  assert.equal(first.attempts, 0);

  const second = await enqueueJob({ kind: "project.archive", projectId: "p-dedupe", userId: "u1", now: at(1000) });
  assert.equal(second.id, first.id, "второе задание на тот же проект не нужно");

  // Другой вид задания — отдельная строка: архивация и восстановление не конфликтуют.
  const other = await enqueueJob({ kind: "project.restore", projectId: "p-dedupe", userId: "u1", now: at(1000) });
  assert.notEqual(other.id, first.id);
});

test("захват помечает задание занятым, второй воркер его не получает", async () => {
  await freshQueue();
  await enqueueJob({ kind: "project.archive", projectId: "p-claim", userId: "u1", now: at(0) });
  const claimed = await claimJob({ workerId: "w1", now: at(0) });
  assert.ok(claimed);
  assert.equal(claimed!.projectId, "p-claim");
  assert.equal(claimed!.state, "running");
  assert.equal(claimed!.attempts, 1);
  assert.equal(claimed!.lockedBy, "w1");

  const again = await claimJob({ workerId: "w2", now: at(1000) });
  assert.equal(again, null, "задание под арендой не отдаётся второму воркеру");
});

test("просроченная аренда возвращает задание в очередь, готовое к повтору", async () => {
  await freshQueue();
  await enqueueJob({ kind: "project.restore", projectId: "p-lease", userId: "u1", now: at(0) });
  const claimed = await claimJob({ workerId: "w1", leaseMs: 1000, now: at(0) });
  assert.equal(claimed!.state, "running");

  // Через две секунды аренда истекла: задание снова доступно и попытка уже вторая.
  const reclaimed = await claimJob({ workerId: "w2", leaseMs: 60_000, now: at(2000) });
  assert.ok(reclaimed);
  assert.equal(reclaimed!.projectId, "p-lease");
  assert.equal(reclaimed!.attempts, 2);
  assert.equal(reclaimed!.lockedBy, "w2");
});

test("исчерпанные попытки не крутятся вечно: задание закрывается ошибкой", async () => {
  await freshQueue();
  await enqueueJob({ kind: "project.archive", projectId: "p-dead", userId: "u1", maxAttempts: 1, now: at(0) });
  const claimed = await claimJob({ workerId: "w1", leaseMs: 1000, now: at(0) });
  assert.equal(claimed!.attempts, 1);

  // Аренда истекла, а попытка была последней.
  const next = await claimJob({ workerId: "w2", now: at(5000) });
  const job = await jobById(claimed!.id);
  assert.equal(job!.state, "failed");
  assert.ok(job!.lastError.length > 0);
  assert.equal(next, null);
});

test("ошибка откладывает задание на backoff, а не выполняет его сразу", async () => {
  await freshQueue();
  const queued = await enqueueJob({ kind: "project.archive", projectId: "p-retry", userId: "u1", now: at(0) });
  const claimed = await claimJob({ workerId: "w1", now: at(0) });
  assert.equal(claimed!.id, queued.id);

  const retried = await retryJob(queued.id, {
    error: "бакет недоступен",
    runAfter: at(30_000),
    attemptsLeft: true,
    now: at(0),
  });
  assert.equal(retried!.state, "queued");
  assert.equal(retried!.runAfter, at(30_000).toISOString());
  assert.equal(retried!.lastError, "бакет недоступен");

  // До срока задание не берут.
  assert.equal(await claimJob({ workerId: "w2", now: at(10_000) }), null);
  const later = await claimJob({ workerId: "w3", now: at(31_000) });
  assert.equal(later!.id, queued.id);
  assert.equal(later!.attempts, 2);
});

test("прогресс и итог видны в задании, фильтры и счётчики работают", async () => {
  await freshQueue();
  const job = await enqueueJob({ kind: "project.restore", projectId: "p-progress", userId: "u1", now: at(0) });
  await updateJobProgress(job.id, { done: 512, total: 4096 }, at(500));
  await finishJob(job.id, { state: "done", done: 4096, total: 4096, now: at(1000) });

  const stored = await jobById(job.id);
  assert.equal(stored!.state, "done");
  assert.equal(stored!.progressDone, 4096);
  assert.equal(stored!.progressTotal, 4096);
  assert.ok(stored!.finishedAt);

  const restores = await listJobs({ kind: "project.restore" });
  assert.ok(restores.some(item => item.id === job.id));

  const counters = await jobCounters();
  assert.ok(counters.done >= 1);
  assert.equal(typeof counters.queued, "number");
});
