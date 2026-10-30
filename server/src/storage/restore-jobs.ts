import { randomUUID } from "node:crypto";

/**
 * Задания восстановления холодного яруса.
 *
 * Само скачивание и распаковка живут в `project-archive.ts`; здесь только состояние задания,
 * чтобы HTTP-запрос отвечал сразу, а панель могла спросить прогресс. Реестр — в памяти процесса:
 * распаковка идёт на этой машине, и задание, начатое здесь, никому больше не нужно. При
 * нескольких репликах (этап 3) каждое задание останется на своей машине, а отметка архива —
 * общая; это осознанное ограничение, а не забытая деталь.
 *
 * Одно задание на проект: два параллельных восстановления писали бы один и тот же каталог.
 * Завершённое задание держится ещё десять минут — панель успевает дочитать финальный статус
 * после последнего опроса, а следующий заход не находит вчерашнюю ошибку.
 */

export type RestoreJobState = "queued" | "downloading" | "unpacking" | "done" | "failed";

export type RestoreJob = {
  id: string;
  projectId: string;
  userId: string;
  state: RestoreJobState;
  bytesDone: number;
  bytesTotal: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type RestoreProgress = (
  bytesDone: number,
  bytesTotal: number,
  phase: "downloading" | "unpacking",
) => void;

/** Тело задания: возвращает `true`, если проект действительно вернулся на диск. */
export type RestoreRunner = (progress: RestoreProgress) => Promise<boolean>;

const FINISHED_TTL_MS = 10 * 60 * 1000;
const jobs = new Map<string, RestoreJob>();
/**
 * Отменённые проекты. Проект могли удалить, пока архив ехал: распаковка вернула бы каталог
 * удалённого проекта на диск и снова записала его в квоту. Флаг снимается новым заданием.
 */
const cancelled = new Set<string>();

const activeStates: ReadonlySet<RestoreJobState> = new Set(["queued", "downloading", "unpacking"]);

export function restoreJobActive(job: RestoreJob): boolean {
  return activeStates.has(job.state);
}

/** Убирает старые завершённые задания: карта не должна расти вместе с числом проектов. */
function prune(now = Date.now()) {
  for (const [projectId, job] of jobs) {
    if (!job.finishedAt) continue;
    if (now - Date.parse(job.finishedAt) > FINISHED_TTL_MS) {
      jobs.delete(projectId);
      cancelled.delete(projectId);
    }
  }
}

export function projectRestoreJob(projectId: string): RestoreJob | null {
  prune();
  return jobs.get(projectId) ?? null;
}

export function cancelProjectRestore(projectId: string): void {
  // Флаг нужен только идущему (или недавнему) восстановлению: у проекта без задания отменять
  // нечего, а множество не должно расти вместе со всеми удалёнными проектами.
  if (!jobs.has(projectId)) return;
  cancelled.add(projectId);
}

export function projectRestoreCancelled(projectId: string): boolean {
  return cancelled.has(projectId);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Ставит задание и сразу возвращает его. Если для проекта уже идёт восстановление, возвращается
 * оно же: повторный запрос панели не должен начинать второе скачивание.
 */
export function startRestoreJob(input: {
  projectId: string;
  userId: string;
  bytesTotal: number;
  run: RestoreRunner;
}): RestoreJob {
  prune();
  const running = jobs.get(input.projectId);
  if (running && restoreJobActive(running)) return running;

  cancelled.delete(input.projectId);
  const job: RestoreJob = {
    id: randomUUID(),
    projectId: input.projectId,
    userId: input.userId,
    state: "queued",
    bytesDone: 0,
    bytesTotal: Math.max(0, input.bytesTotal),
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  jobs.set(input.projectId, job);

  const report: RestoreProgress = (bytesDone, bytesTotal, phase) => {
    if (jobs.get(input.projectId) !== job) return;
    if (bytesTotal > 0) job.bytesTotal = bytesTotal;
    job.bytesDone = Math.max(0, bytesDone);
    job.state = phase;
  };

  void (async () => {
    job.state = "downloading";
    try {
      const restored = await input.run(report);
      if (jobs.get(input.projectId) !== job) return;
      job.bytesDone = job.bytesTotal || job.bytesDone;
      job.state = "done";
      job.finishedAt = new Date().toISOString();
      if (restored) {
        console.log("[storage] проект " + input.projectId + ": задание восстановления завершено");
      }
    } catch (error) {
      if (jobs.get(input.projectId) !== job) return;
      job.state = "failed";
      job.error = messageOf(error);
      job.finishedAt = new Date().toISOString();
      console.warn(
        "[storage] проект " + input.projectId + ": восстановление не удалось — " + job.error,
      );
    }
  })();

  return job;
}

function formatMegabytes(bytes: number): string {
  if (bytes <= 0) return "";
  const mb = bytes / (1024 * 1024);
  return (mb >= 100 ? mb.toFixed(0) : mb.toFixed(1)) + " МБ";
}

/**
 * Ответ «файлы ещё в архиве»: 409, а не 500. Код разбирает панель, размеры нужны, чтобы
 * показать полосу прогресса без отдельного запроса.
 */
export class ProjectRestoringError extends Error {
  readonly statusCode = 409;
  readonly code = "PROJECT_RESTORING";
  readonly jobId: string;
  readonly bytesDone: number;
  readonly bytesTotal: number;

  constructor(job: RestoreJob) {
    const size = formatMegabytes(job.bytesTotal);
    super(
      "Проект просыпается: файлы возвращаются из архива" +
        (size ? " (" + size + ")" : "") +
        ". Это занимает несколько секунд — попробуйте ещё раз.",
    );
    this.name = "ProjectRestoringError";
    this.jobId = job.id;
    this.bytesDone = job.bytesDone;
    this.bytesTotal = job.bytesTotal;
  }
}

/** Задание уже упало: повторять скачивание на каждом запросе нельзя, нужен явный повтор. */
export class ProjectRestoreFailedError extends Error {
  readonly statusCode = 502;
  readonly code = "RESTORE_FAILED";
  readonly jobId: string;
  readonly bytesDone: number;
  readonly bytesTotal: number;

  constructor(job: RestoreJob) {
    super("Не удалось вернуть проект из архива: " + (job.error ?? "неизвестная ошибка"));
    this.name = "ProjectRestoreFailedError";
    this.jobId = job.id;
    this.bytesDone = job.bytesDone;
    this.bytesTotal = job.bytesTotal;
  }
}
