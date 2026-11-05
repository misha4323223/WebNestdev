import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getTable, initializeStorage, isYdbEnabled, ydbQuery } from "../storage/pg.js";

/**
 * Очередь долгих заданий: архивация и восстановление проекта.
 *
 * До неё состояние восстановления жило в памяти процесса (`storage/restore-jobs.ts`), а
 * архивация выполнялась прямо в HTTP-запросе админки. Оба варианта ломаются одинаково: рестарт
 * посреди работы не оставляет следа, а запрос держится столько, сколько идёт `tar` и загрузка в
 * бакет. Очередь переносит состояние в базу (`jobs`, `FOR UPDATE SKIP LOCKED`) и даёт три вещи:
 * переживание рестарта (аренда истекла — задание вернулось в очередь), ретраи с backoff и
 * видимость в админке.
 *
 * JSON-режим (`WEBNESTDEV_STORAGE=json`) остаётся для локальной разработки и тестов: там очередь —
 * файл `jobs.json` в `WEBNESTDEV_DATA_DIR`. Блокировок уровня строки в файле нет, но в этом режиме
 * и процессов обычно один; для боевого режима есть PostgreSQL.
 */

export type JobKind = "project.archive" | "project.restore";
export type JobState = "queued" | "running" | "done" | "failed";

export type JobRecord = {
  id: string;
  kind: JobKind;
  /** Ключ дедупликации: одно активное задание на проект и вид. */
  subject: string;
  projectId: string;
  userId: string;
  state: JobState;
  /** Сколько раз задание уже пытались выполнить (растёт при захвате, а не при падении). */
  attempts: number;
  maxAttempts: number;
  /** Раньше этого момента задание не берут: backoff после ошибки и отложенный старт. */
  runAfter: string;
  /** Аренда: пока она жива, задание считается чужим. Истекла — воркер вернёт его в очередь. */
  lockedUntil: string | null;
  lockedBy: string;
  lastError: string;
  progressDone: number;
  progressTotal: number;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export type JobRow = {
  id: string;
  kind: string;
  subject: string;
  project_id: string;
  user_id: string;
  state: string;
  attempts: number | string;
  max_attempts: number | string;
  run_after: string;
  locked_until: string | null;
  locked_by: string;
  last_error: string;
  progress_done: number | string;
  progress_total: number | string;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};

export const ACTIVE_STATES: readonly JobState[] = ["queued", "running"];
const DEFAULT_MAX_ATTEMPTS = 3;
/** Сколько секунд задание считается занятым, прежде чем его вернут в очередь. */
export const DEFAULT_LEASE_MS = 30 * 60 * 1000;

export function rowToJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    kind: row.kind as JobKind,
    subject: row.subject,
    projectId: row.project_id,
    userId: row.user_id,
    state: row.state as JobState,
    // node-postgres отдаёт INTEGER строкой в некоторых конфигурациях: без Number() счётчики
    // пришли бы в API строками, а сравнение `attempts >= maxAttempts` — по строкам.
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    runAfter: row.run_after,
    lockedUntil: row.locked_until,
    lockedBy: row.locked_by,
    lastError: row.last_error,
    progressDone: Number(row.progress_done),
    progressTotal: Number(row.progress_total),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

// ─── JSON-режим ──────────────────────────────────────────────────────────────

function jobsFile(): string {
  return path.join(process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev"), "jobs.json");
}

/** Очередь в одном файле: запись идёт через `rename`, поэтому половина JSON не читается. */
let fileGate: Promise<unknown> = Promise.resolve();

function withFileLock<T>(action: () => Promise<T>): Promise<T> {
  const next = fileGate.then(action, action);
  fileGate = next.catch(() => undefined);
  return next;
}

async function readFileJobs(): Promise<JobRecord[]> {
  try {
    const parsed = JSON.parse(await readFile(jobsFile(), "utf8")) as { jobs?: JobRecord[] };
    return Array.isArray(parsed.jobs) ? parsed.jobs : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeFileJobs(jobs: JobRecord[]): Promise<void> {
  const file = jobsFile();
  await mkdir(path.dirname(file), { recursive: true });
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temp, JSON.stringify({ jobs }, null, 2), { mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

// ─── Запись очереди ──────────────────────────────────────────────────────────

export type EnqueueInput = {
  kind: JobKind;
  projectId: string;
  userId: string;
  /** Отложенный старт: например, «попробовать через десять минут». */
  runAfter?: Date;
  maxAttempts?: number;
  now?: Date;
};

function isActive(job: JobRecord): boolean {
  return ACTIVE_STATES.includes(job.state);
}

/**
 * Поставить задание в очередь. Если по этому проекту и виду уже есть активное задание, вернётся
 * оно: повторный клик в админке или второй запрос панели не должны начинать вторую архивацию.
 */
export async function enqueueJob(input: EnqueueInput): Promise<JobRecord> {
  const now = input.now ?? new Date();
  const iso = now.toISOString();
  const subject = input.projectId;
  if (!isYdbEnabled()) {
    return withFileLock(async () => {
      const jobs = await readFileJobs();
      const existing = jobs.find(job => job.kind === input.kind && job.subject === subject && isActive(job));
      if (existing) return existing;
      const job: JobRecord = {
        id: randomUUID(),
        kind: input.kind,
        subject,
        projectId: input.projectId,
        userId: input.userId,
        state: "queued",
        attempts: 0,
        maxAttempts: Math.max(1, input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
        runAfter: (input.runAfter ?? now).toISOString(),
        lockedUntil: null,
        lockedBy: "",
        lastError: "",
        progressDone: 0,
        progressTotal: 0,
        createdAt: iso,
        updatedAt: iso,
        finishedAt: null,
      };
      jobs.push(job);
      await writeFileJobs(jobs);
      return job;
    });
  }

  await initializeStorage();
  const table = ydbQuery().identifier(getTable("jobs"));
  // Частичный уникальный индекс `(kind, subject) WHERE state IN ('queued','running')` делает
  // дедупликацию атомарной: две реплики не создадут два задания на один проект.
  const [inserted] = await ydbQuery()<JobRow[]>`
    INSERT INTO ${table} (id, kind, subject, project_id, user_id, state, attempts, max_attempts,
                          run_after, locked_until, locked_by, last_error, progress_done,
                          progress_total, created_at, updated_at, finished_at)
    VALUES (${randomUUID()}, ${input.kind}, ${subject}, ${input.projectId}, ${input.userId}, ${"queued"},
            ${0}, ${Math.max(1, input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)}, ${(input.runAfter ?? now).toISOString()},
            ${null}, ${""}, ${""}, ${0}, ${0}, ${iso}, ${iso}, ${null})
    ON CONFLICT (kind, subject) WHERE state IN ('queued', 'running') DO NOTHING
    RETURNING *`;
  if (inserted[0]) return rowToJob(inserted[0]);
  const [existing] = await ydbQuery()<JobRow[]>`
    SELECT * FROM ${table}
     WHERE kind = ${input.kind} AND subject = ${subject} AND state IN ('queued', 'running')
     ORDER BY created_at DESC LIMIT 1`;
  if (!existing[0]) throw new Error("не удалось поставить задание в очередь");
  return rowToJob(existing[0]);
}

/**
 * Вернуть в очередь задания, у которых истекла аренда: процесс упал, контейнер перезапустили,
 * выкатка убила воркер. Исчерпавшие попытки сразу помечаются ошибкой, иначе они возвращались бы
 * в очередь вечно.
 */
async function reclaimExpired(now: Date): Promise<void> {
  const iso = now.toISOString();
  if (!isYdbEnabled()) {
    return withFileLock(async () => {
      const jobs = await readFileJobs();
      let changed = false;
      for (const job of jobs) {
        if (job.state !== "running" || !job.lockedUntil) continue;
        if (job.lockedUntil >= iso) continue;
        changed = true;
        job.lockedUntil = null;
        job.lockedBy = "";
        job.updatedAt = iso;
        if (job.attempts >= job.maxAttempts) {
          job.state = "failed";
          job.finishedAt = iso;
          job.lastError = job.lastError || "аренда истекла, попытки кончились";
        } else {
          job.state = "queued";
          job.lastError = job.lastError || "аренда истекла — задание возвращено в очередь";
        }
      }
      if (changed) await writeFileJobs(jobs);
    });
  }
  await initializeStorage();
  const table = ydbQuery().identifier(getTable("jobs"));
  await ydbQuery()`
    UPDATE ${table}
       SET state = ${"failed"}, locked_until = ${null}, locked_by = ${""}, finished_at = ${iso},
           updated_at = ${iso},
           last_error = CASE WHEN last_error = ${""} THEN ${"аренда истекла, попытки кончились"} ELSE last_error END
     WHERE state = ${"running"} AND locked_until IS NOT NULL AND locked_until < ${iso}
       AND attempts >= max_attempts`;
  await ydbQuery()`
    UPDATE ${table}
       SET state = ${"queued"}, locked_until = ${null}, locked_by = ${""}, updated_at = ${iso},
           last_error = CASE WHEN last_error = ${""} THEN ${"аренда истекла — задание возвращено в очередь"} ELSE last_error END
     WHERE state = ${"running"} AND locked_until IS NOT NULL AND locked_until < ${iso}
       AND attempts < max_attempts`;
}

export type ClaimInput = {
  workerId: string;
  leaseMs?: number;
  now?: Date;
};

/**
 * Забрать одно готовое задание. В PostgreSQL — `FOR UPDATE SKIP LOCKED`, поэтому два воркера
 * никогда не возьмут одно и то же, а второй не будет ждать первого.
 */
export async function claimJob(input: ClaimInput): Promise<JobRecord | null> {
  const now = input.now ?? new Date();
  const iso = now.toISOString();
  const leaseUntil = new Date(now.getTime() + (input.leaseMs ?? DEFAULT_LEASE_MS)).toISOString();
  await reclaimExpired(now);

  if (!isYdbEnabled()) {
    return withFileLock(async () => {
      const jobs = await readFileJobs();
      const next = jobs
        .filter(job => job.state === "queued" && job.runAfter <= iso)
        .sort((a, b) => (a.runAfter === b.runAfter ? a.createdAt.localeCompare(b.createdAt) : a.runAfter.localeCompare(b.runAfter)))[0];
      if (!next) return null;
      next.state = "running";
      next.attempts += 1;
      next.lockedUntil = leaseUntil;
      next.lockedBy = input.workerId;
      next.updatedAt = iso;
      await writeFileJobs(jobs);
      return next;
    });
  }

  await initializeStorage();
  const table = ydbQuery().identifier(getTable("jobs"));
  const [claimed] = await ydbQuery()<JobRow[]>`
    WITH next AS (
      SELECT id FROM ${table}
       WHERE state = ${"queued"} AND run_after <= ${iso}
       ORDER BY run_after, created_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED
    )
    UPDATE ${table} AS j
       SET state = ${"running"}, attempts = j.attempts + 1, locked_until = ${leaseUntil},
           locked_by = ${input.workerId}, updated_at = ${iso}
      FROM next
     WHERE j.id = next.id
    RETURNING j.*`;
  return claimed[0] ? rowToJob(claimed[0]) : null;
}

/** Прогресс: пишется не на каждый байт, а когда воркер решит (раз в несколько процентов). */
export async function updateJobProgress(
  id: string,
  progress: { done: number; total?: number },
  now = new Date(),
): Promise<void> {
  if (!isYdbEnabled()) {
    return withFileLock(async () => {
      const jobs = await readFileJobs();
      const job = jobs.find(item => item.id === id);
      if (!job) return;
      job.progressDone = Math.max(0, Math.round(progress.done));
      if (progress.total !== undefined) job.progressTotal = Math.max(0, Math.round(progress.total));
      job.updatedAt = now.toISOString();
      await writeFileJobs(jobs);
    });
  }
  await initializeStorage();
  const table = ydbQuery().identifier(getTable("jobs"));
  if (progress.total === undefined) {
    await ydbQuery()`UPDATE ${table} SET progress_done = ${Math.round(progress.done)}, updated_at = ${now.toISOString()} WHERE id = ${id}`;
    return;
  }
  await ydbQuery()`
    UPDATE ${table}
       SET progress_done = ${Math.round(progress.done)}, progress_total = ${Math.round(progress.total!)},
           updated_at = ${now.toISOString()}
     WHERE id = ${id}`;
}

/** Задание выполнено. `progress` фиксирует итог, чтобы админка не показывала «60%» у готового. */
export async function finishJob(
  id: string,
  result: { state: "done" | "failed"; error?: string; done?: number; total?: number; now?: Date },
): Promise<void> {
  const now = result.now ?? new Date();
  const iso = now.toISOString();
  const state = result.state;
  const error = result.state === "failed" ? (result.error ?? "неизвестная ошибка").slice(0, 2000) : "";
  if (!isYdbEnabled()) {
    return withFileLock(async () => {
      const jobs = await readFileJobs();
      const job = jobs.find(item => item.id === id);
      if (!job) return;
      job.state = state;
      job.lastError = error;
      job.lockedUntil = null;
      job.lockedBy = "";
      job.updatedAt = iso;
      job.finishedAt = iso;
      if (result.total !== undefined) job.progressTotal = Math.max(0, Math.round(result.total));
      if (result.done !== undefined) job.progressDone = Math.max(0, Math.round(result.done));
      await writeFileJobs(jobs);
    });
  }
  await initializeStorage();
  const table = ydbQuery().identifier(getTable("jobs"));
  const total = result.total === undefined ? null : Math.max(0, Math.round(result.total));
  const done = result.done === undefined ? null : Math.max(0, Math.round(result.done));
  await ydbQuery()`
    UPDATE ${table}
       SET state = ${state}, last_error = ${error}, locked_until = ${null}, locked_by = ${""},
           updated_at = ${iso}, finished_at = ${iso},
           progress_total = COALESCE(${total}, progress_total),
           progress_done = COALESCE(${done}, progress_done)
     WHERE id = ${id}`;
}

/**
 * Отложить повтор. Попытка уже засчитана при захвате, поэтому здесь только срок: если попытки
 * кончились, задание закрывается ошибкой — иначе «упавшее» задание крутилось бы вечно.
 */
export async function retryJob(
  id: string,
  input: { error: string; runAfter: Date; attemptsLeft: boolean; now?: Date },
): Promise<JobRecord | null> {
  const now = input.now ?? new Date();
  const iso = now.toISOString();
  if (!input.attemptsLeft) {
    await finishJob(id, { state: "failed", error: input.error, now });
    return jobById(id);
  }
  if (!isYdbEnabled()) {
    return withFileLock(async () => {
      const jobs = await readFileJobs();
      const job = jobs.find(item => item.id === id);
      if (!job) return null;
      job.state = "queued";
      job.runAfter = input.runAfter.toISOString();
      job.lockedUntil = null;
      job.lockedBy = "";
      job.lastError = input.error.slice(0, 2000);
      job.updatedAt = iso;
      await writeFileJobs(jobs);
      return job;
    });
  }
  await initializeStorage();
  const table = ydbQuery().identifier(getTable("jobs"));
  const [rows] = await ydbQuery()<JobRow[]>`
    UPDATE ${table}
       SET state = ${"queued"}, run_after = ${input.runAfter.toISOString()}, locked_until = ${null},
           locked_by = ${""}, last_error = ${input.error.slice(0, 2000)}, updated_at = ${iso}
     WHERE id = ${id}
    RETURNING *`;
  return rows[0] ? rowToJob(rows[0]) : null;
}

export async function jobById(id: string): Promise<JobRecord | null> {
  if (!isYdbEnabled()) {
    const jobs = await readFileJobs();
    return jobs.find(job => job.id === id) ?? null;
  }
  await initializeStorage();
  const table = ydbQuery().identifier(getTable("jobs"));
  const [rows] = await ydbQuery()<JobRow[]>`SELECT * FROM ${table} WHERE id = ${id}`;
  return rows[0] ? rowToJob(rows[0]) : null;
}

/** Последнее задание по проекту: панели и админке нужен статус, а не история. */
export async function latestJobFor(projectId: string, kind?: JobKind): Promise<JobRecord | null> {
  const jobs = await listJobs({ projectId, kind, limit: 1 });
  return jobs[0] ?? null;
}

export type ListJobsInput = {
  state?: JobState;
  kind?: JobKind;
  projectId?: string;
  limit?: number;
};

/**
 * Список заданий для админки: свежие сверху. `limit` ограничен, потому что таблица растёт вместе
 * с числом архиваций, а панель показывает только последние.
 */
export async function listJobs(input: ListJobsInput = {}): Promise<JobRecord[]> {
  const limit = Math.min(Math.max(1, input.limit ?? 50), 200);
  if (!isYdbEnabled()) {
    const jobs = await readFileJobs();
    return jobs
      .filter(job => (!input.state || job.state === input.state)
        && (!input.kind || job.kind === input.kind)
        && (!input.projectId || job.projectId === input.projectId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }
  await initializeStorage();
  const table = ydbQuery().identifier(getTable("jobs"));
  // Условия собираются как `($1 IS NULL OR col = $1)`: один запрос на все комбинации фильтров.
  const [rows] = await ydbQuery()<JobRow[]>`
    SELECT * FROM ${table}
     WHERE (${input.state ?? null}::text IS NULL OR state = ${input.state ?? null})
       AND (${input.kind ?? null}::text IS NULL OR kind = ${input.kind ?? null})
       AND (${input.projectId ?? null}::text IS NULL OR project_id = ${input.projectId ?? null})
     ORDER BY created_at DESC
     LIMIT ${limit}`;
  return rows.map(rowToJob);
}

/** Счётчики для `/api/health` и админки: сколько заданий в каждом состоянии. */
export async function jobCounters(): Promise<Record<JobState, number>> {
  const counters: Record<JobState, number> = { queued: 0, running: 0, done: 0, failed: 0 };
  if (!isYdbEnabled()) {
    for (const job of await readFileJobs()) counters[job.state]++;
    return counters;
  }
  await initializeStorage();
  const table = ydbQuery().identifier(getTable("jobs"));
  const [rows] = await ydbQuery()<Array<{ state: string; count: number | string }>>`
    SELECT state, COUNT(*) AS count FROM ${table} GROUP BY state`;
  for (const row of rows) {
    const state = row.state as JobState;
    if (state in counters) counters[state] = Number(row.count);
  }
  return counters;
}
