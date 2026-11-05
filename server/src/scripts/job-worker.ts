import { archiveProject, runQueuedRestore } from "../storage/project-archive.js";
import { initializeStorage, describeStorage } from "../storage/pg.js";
import { startJobWorker } from "../jobs/worker.js";

/**
 * Отдельный процесс очереди долгих заданий.
 *
 * Нужен на хосте, где API масштабируется отдельно от работы: `tar` проекта в 300 МБ и загрузка в
 * бакет не должны делить память с HTTP-сервером. В обычной однопроцессной выкатке очередь
 * обслуживает сам API (см. `JOBS_INLINE_WORKER=0` в `server/src/index.ts` — этим флагом встроенный
 * воркер выключается, чтобы задач не выполняли двое).
 *
 * Запуск: `node server/dist/scripts/job-worker.js` (или `npm run jobs:worker` в `server/`).
 */

async function main() {
  console.log("[jobs] " + describeStorage());
  await initializeStorage();
  const worker = startJobWorker({
    concurrency: Number(process.env.JOBS_CONCURRENCY ?? 2),
    workerId: "worker:" + process.pid,
    handlers: {
      "project.archive": async job => {
        const result = await archiveProject(job.projectId, job.userId);
        return { done: result.bytes, total: result.bytes };
      },
      "project.restore": (job, context) => runQueuedRestore(job.projectId, job.userId, context.report),
    },
  });
  const stop = (signal: string) => {
    console.log("[jobs] остановка по " + signal);
    worker.stop();
    // Незавершённые задания не трогаем: аренда истечёт, и их подберёт следующий воркер.
    process.exit(0);
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

main().catch(error => {
  console.error("[jobs] воркер не запустился: " + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
