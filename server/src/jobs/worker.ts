import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  claimJob,
  finishJob,
  retryJob,
  updateJobProgress,
  type JobKind,
  type JobRecord,
} from "./store.js";

/**
 * Воркер очереди: забирает готовые задания и выполняет их по одному на слот.
 *
 * Один и тот же цикл работает и внутри API-процесса (по умолчанию), и отдельным процессом
 * (`server/src/scripts/job-worker.ts`, `JOBS_INLINE_WORKER=0` отключает встроенный). Разница только
 * в том, кто владеет арендой: у каждого воркера свой `workerId`, поэтому два процесса не возьмут
 * одно задание — это делает `FOR UPDATE SKIP LOCKED` в хранилище.
 *
 * Ретраи: попытка засчитывается при захвате, а не при падении. Иначе задание, упавшее в момент
 * захвата, крутилось бы вечно. Backoff растёт вдвое: 30 с, минута, две — и до десяти минут.
 * После `maxAttempts` задание закрывается ошибкой и остаётся в админке как след.
 */

export type JobHandlerContext = {
  /** Прогресс для панели: байты сделано и (если известно) всего. */
  report: (done: number, total?: number) => void;
};

export type JobHandlerResult = { done?: number; total?: number };

export type JobHandler = (job: JobRecord, context: JobHandlerContext) => Promise<JobHandlerResult>;

export type JobWorkerDeps = {
  handlers: Partial<Record<JobKind, JobHandler>>;
  now?: () => Date;
  leaseMs?: number;
  pollMs?: number;
  concurrency?: number;
  workerId?: string;
  /** Лог вынесен наружу: тест не должен писать в stdout сервера. */
  log?: (line: string) => void;
};

const DEFAULT_POLL_MS = 2000;
const DEFAULT_CONCURRENCY = 2;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;

/** Ошибки «проект занят» — не повод закрывать задание: оно повторится после паузы. */
const TRANSIENT_CODES = new Set(["PROJECT_BUSY", "PREVIEW_RUNNING", "SANDBOX_BUSY"]);

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "";
}

export function retryDelayMs(attempts: number): number {
  const step = Math.max(1, attempts);
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (step - 1));
}

export type JobWorker = {
  stop: () => void;
  /** Один проход: забрать и выполнить до `concurrency` заданий. Возвращает число выполненных. */
  tick: () => Promise<{ claimed: number }>;
};

/**
 * Запускает цикл. Возвращает объект с `stop` и `tick`: тест дёргает `tick()` руками и не зависит
 * от таймеров, прод — обычный `setInterval`.
 */
export function startJobWorker(deps: JobWorkerDeps): JobWorker {
  const log = deps.log ?? (line => console.log(line));
  const now = deps.now ?? (() => new Date());
  const pollMs = Math.max(200, deps.pollMs ?? DEFAULT_POLL_MS);
  const concurrency = Math.max(1, deps.concurrency ?? DEFAULT_CONCURRENCY);
  const leaseMs = deps.leaseMs;
  const workerId = deps.workerId ?? hostname() + ":" + process.pid + ":" + randomUUID().slice(0, 8);

  let stopped = false;
  let ticking = false;
  const running = new Set<Promise<void>>();

  const execute = async (job: JobRecord): Promise<void> => {
    const handler = deps.handlers[job.kind];
    if (!handler) {
      await finishJob(job.id, { state: "failed", error: "нет обработчика для " + job.kind, now: now() });
      return;
    }
    let lastReport = 0;
    const report = (done: number, total?: number) => {
      const stamp = now().getTime();
      // Пишем не на каждый чанк: при скачивании 200 МБ это были бы сотни UPDATE в секунду.
      if (stamp - lastReport < 1000) return;
      lastReport = stamp;
      void updateJobProgress(job.id, { done, total }, now()).catch(() => undefined);
    };
    try {
      log("[jobs] " + job.kind + " " + job.projectId + ": попытка " + job.attempts + "/" + job.maxAttempts);
      const result = await handler(job, { report });
      await finishJob(job.id, {
        state: "done",
        done: result.done,
        total: result.total,
        now: now(),
      });
      log("[jobs] " + job.kind + " " + job.projectId + ": выполнено");
    } catch (error) {
      const message = messageOf(error);
      const code = codeOf(error);
      const transient = TRANSIENT_CODES.has(code);
      const attemptsLeft = job.attempts < job.maxAttempts;
      if (attemptsLeft) {
        const delay = transient ? Math.max(RETRY_BASE_MS, retryDelayMs(job.attempts)) : retryDelayMs(job.attempts);
        log(
          "[jobs] " + job.kind + " " + job.projectId + ": ошибка (" + message + "), повтор через " +
            Math.round(delay / 1000) + " с",
        );
        await retryJob(job.id, {
          error: message,
          runAfter: new Date(now().getTime() + delay),
          attemptsLeft: true,
          now: now(),
        });
      } else {
        log("[jobs] " + job.kind + " " + job.projectId + ": сдались после " + job.attempts + " попыток — " + message);
        await retryJob(job.id, { error: message, runAfter: now(), attemptsLeft: false, now: now() });
      }
    }
  };

  const tick = async (): Promise<{ claimed: number }> => {
    if (ticking) return { claimed: 0 };
    ticking = true;
    let claimed = 0;
    try {
      while (!stopped && running.size < concurrency) {
        const job = await claimJob({ workerId, now: now(), ...(leaseMs === undefined ? {} : { leaseMs }) });
        if (!job) break;
        claimed++;
        const task = execute(job).finally(() => running.delete(task));
        running.add(task);
      }
    } catch (error) {
      log("[jobs] очередь недоступна: " + messageOf(error));
    } finally {
      ticking = false;
    }
    return { claimed };
  };

  const timer = setInterval(() => {
    if (!stopped) void tick();
  }, pollMs);
  timer.unref();

  log("[jobs] воркер запущен: " + workerId + ", параллельно " + concurrency + ", опрос " + pollMs + " мс");

  return {
    tick,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}
