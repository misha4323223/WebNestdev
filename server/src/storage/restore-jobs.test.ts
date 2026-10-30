import test from "node:test";
import assert from "node:assert/strict";
import {
  ProjectRestoreFailedError,
  ProjectRestoringError,
  projectRestoreJob,
  restoreJobActive,
  startRestoreJob,
  type RestoreJob,
  type RestoreProgress,
} from "./restore-jobs.js";

async function waitUntil(check: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("состояние не наступило за " + timeoutMs + " мс");
}

test("задание одно на проект: прогресс виден, повторный запуск возвращает его же", async () => {
  let report!: RestoreProgress;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const job = startRestoreJob({
    projectId: "job-dedupe",
    userId: "user-1",
    bytesTotal: 100,
    run: async progress => {
      report = progress;
      progress(25, 100, "downloading");
      await gate;
      progress(100, 100, "unpacking");
      return true;
    },
  });

  assert.equal(job.state, "downloading");
  assert.equal(job.bytesDone, 25);
  assert.equal(projectRestoreJob("job-dedupe")?.id, job.id);
  assert.equal(restoreJobActive(job), true);

  // Панель опрашивает статус и повторно просит восстановление — второго скачивания быть не должно.
  const again = startRestoreJob({
    projectId: "job-dedupe",
    userId: "user-1",
    bytesTotal: 100,
    run: async () => false,
  });
  assert.equal(again.id, job.id);

  // Прогресс обновляет то же задание, а не копию.
  report(60, 100, "downloading");
  assert.equal(projectRestoreJob("job-dedupe")?.bytesDone, 60);

  release();
  await waitUntil(() => projectRestoreJob("job-dedupe")?.state === "done");
  const done = projectRestoreJob("job-dedupe")!;
  assert.equal(done.bytesDone, 100);
  assert.equal(done.bytesTotal, 100);
  assert.ok(done.finishedAt);
  assert.equal(restoreJobActive(done), false);
});

test("ошибка записывается в задание, явный повтор начинает новое", async () => {
  const first = startRestoreJob({
    projectId: "job-failure",
    userId: "user-2",
    bytesTotal: 2048,
    run: async () => {
      throw new Error("S3 недоступен");
    },
  });
  await waitUntil(() => projectRestoreJob("job-failure")?.state === "failed");
  const failed = projectRestoreJob("job-failure")!;
  assert.equal(failed.id, first.id);
  assert.equal(failed.error, "S3 недоступен");
  assert.equal(restoreJobActive(failed), false);

  const retry = startRestoreJob({
    projectId: "job-failure",
    userId: "user-2",
    bytesTotal: 2048,
    run: async () => true,
  });
  assert.notEqual(retry.id, failed.id);
  await waitUntil(() => projectRestoreJob("job-failure")?.state === "done");
  assert.equal(projectRestoreJob("job-failure")?.error, null);
});

test("ошибки восстановления несут HTTP-код, jobId и размеры для панели", () => {
  const job: RestoreJob = {
    id: "job-1",
    projectId: "project-1",
    userId: "user-1",
    state: "downloading",
    bytesDone: 50,
    bytesTotal: 5 * 1024 * 1024,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  const restoring = new ProjectRestoringError(job);
  assert.equal(restoring.statusCode, 409);
  assert.equal(restoring.code, "PROJECT_RESTORING");
  assert.equal(restoring.jobId, "job-1");
  assert.equal(restoring.bytesDone, 50);
  assert.equal(restoring.bytesTotal, job.bytesTotal);
  assert.match(restoring.message, /5\.0 МБ/);

  const failed = new ProjectRestoreFailedError({ ...job, state: "failed", error: "нет места" });
  assert.equal(failed.statusCode, 502);
  assert.equal(failed.code, "RESTORE_FAILED");
  assert.match(failed.message, /нет места/);
});
