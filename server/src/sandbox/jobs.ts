import { randomUUID } from "node:crypto";
import { dockerRunArgs } from "./docker/args.js";
import { dockerOptions } from "./docker/options.js";
import { openProjectForSandbox } from "./permissions.js";
import { resolveSandboxHost, sandboxHost, type SandboxHost } from "./host.js";
import { nodeId } from "../nodes/identity.js";
import type { DockerCliResult } from "./docker/types.js";
import { tailLogLines } from "../preview/log-lines.js";
import { memoryLimitMb, reserveSandboxMemory, type SandboxMemoryReservation } from "./memory-budget.js";
import { positiveInt, QueueTimeoutError } from "../concurrency.js";
import { secretEnvMaskMounts } from "./secret-mask.js";
import { assertSandboxJobBudget, chargeSandboxJob } from "./job-quota.js";
import type { SandboxConfig } from "./sandbox-types.js";

/**
 * Долгие команды песочницы.
 *
 * `terminal.exec` держит шаг агента, пока команда не закончится. Для `npm test` это нормально,
 * для сборки на двадцать минут — нет: шаг упирается в таймаут, а повторный запуск начинает работу
 * с нуля. Поэтому долгая команда запускается отдельным контейнером (`docker run -d`), а её вывод
 * читается хвостом через `terminal.tail`. Песочница при этом остаётся без сети, без Docker внутри
 * и с теми же масками секретных файлов, что и обычная команда.
 *
 * Контейнер живёт не вечно: у задания есть предельный срок (`SANDBOX_JOB_MAX_MS`, 30 минут) и
 * лимит одновременных заданий (`SANDBOX_MAX_JOBS`, 4 на хост; два на проект). Иначе «долгая
 * команда» стала бы способом оставить память занятой навсегда. Состояние живёт в памяти сервера:
 * после перезапуска задание не продолжается, а контейнеры прошлого запуска убираются на старте.
 */

const JOB_PREFIX = "wnd-job-";
const MAX_LOG_CHARS = 10_000;
const DOCKER_TIMEOUT_MS = 20_000;
const MAX_TAIL_LINES = 400;

type JobRecord = {
  name: string;
  projectId: string;
  userId: string;
  command: string;
  cwd: string;
  startedAt: number;
  timer: NodeJS.Timeout;
  /** Учёт времени и освобождение памяти выполняются ровно один раз. */
  forgotten?: boolean;
  host: SandboxHost;
  /** Возвращает память, занятую под контейнер задания на всё время его жизни. */
  releaseMemory: () => void;
  /**
   * Что сделать после снятия контейнера. Задание пишет файлы в проект, но ответ агент получает
   * раньше: без этого хука размер проекта оставался старым до следующей правки и квота тарифа
   * не видела фондовую сборку.
   */
  onExit?: () => Promise<void> | void;
};

const jobs = new Map<string, JobRecord>();

function jobLimit() {
  const raw = Number(process.env.SANDBOX_MAX_JOBS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 4;
}

function perProjectLimit() {
  const raw = Number(process.env.SANDBOX_JOBS_PER_PROJECT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2;
}

/** Предельный срок задания: после него контейнер снимается, даже если команда ещё работает. */
export function sandboxJobMaxMs() {
  const raw = Number(process.env.SANDBOX_JOB_MAX_MS);
  return Number.isFinite(raw) && raw >= 60_000 ? Math.min(raw, 2 * 60 * 60_000) : 30 * 60_000;
}

/** Имя контейнера — одновременно идентификатор задания: по нему читаются логи и состояние. */
export function sandboxJobName(projectId: string) {
  const project = projectId.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 60);
  return (JOB_PREFIX + project + "-" + randomUUID().slice(0, 8)).slice(0, 120);
}

export function isSandboxJobName(value: string) {
  return /^wnd-job-[A-Za-z0-9_.-]{1,112}$/.test(value);
}

type DockerResult = DockerCliResult;

function forgetJob(record: JobRecord) {
  // Задание может «закончиться» сразу с двух сторон: по таймеру срока и через `terminal.tail`,
  // который увидел остановленный контейнер. Память и время учитываются один раз.
  if (record.forgotten) return;
  record.forgotten = true;
  clearTimeout(record.timer);
  jobs.delete(record.name);
  record.releaseMemory();
  // Секунды жизни контейнера задания — те же «CPU-минуты» тарифа, что у обычной команды.
  // Списание не ждём: команда уже выполнена, и сбой учёта не должен влиять на ответ.
  void chargeSandboxJob(record.userId, record.startedAt);
}

async function removeContainer(record: JobRecord) {
  await record.host.docker(["rm", "-f", record.name], DOCKER_TIMEOUT_MS).catch(() => undefined);
}

async function stopInternal(record: JobRecord) {
  forgetJob(record);
  await removeContainer(record);
  try {
    await record.onExit?.();
  } catch (error) {
    // Команда уже выполнена: сбой учёта не должен превращаться в ошибку терминала.
    console.warn("[jobs] не удалось выполнить действие после задания", error);
  }
}

/**
 * Сколько долгих заданий живёт на хосте и каковы потолки. Нужно метрикам: задание держит
 * контейнер памяти до получаса, и без числа таких контейнеров перегрузка выглядит как «медленно».
 * Пределы берутся те же, что проверяет `startSandboxJob` — одна правка не должна разъезжаться с другой.
 */
export function sandboxJobCounts() {
  return { running: jobs.size, limit: jobLimit(), perProjectLimit: perProjectLimit() };
}

/** Активные задания проекта: по ним видно, что уже запущено, и можно остановить нужное. */
export function listSandboxJobs(projectId: string) {
  return [...jobs.values()]
    .filter(record => record.projectId === projectId)
    .sort((left, right) => left.startedAt - right.startedAt)
    .map(record => ({
      jobId: record.name,
      command: record.command,
      cwd: record.cwd,
      startedAt: new Date(record.startedAt).toISOString(),
      runningForSeconds: Math.round((Date.now() - record.startedAt) / 1000),
    }));
}

export type StartedSandboxJob = {
  ok: true;
  background: true;
  jobId: string;
  command: string;
  cwd: string;
  startedAt: string;
  maxLifetimeSeconds: number;
};

export async function startSandboxJob(
  config: SandboxConfig,
  userId: string,
  command: string,
  cwd: string,
  signal?: AbortSignal,
  /** Вызывается после снятия контейнера — на завершении, остановке и по таймауту. */
  onExit?: () => Promise<void> | void,
): Promise<StartedSandboxJob> {
  if ((process.env.SANDBOX_MODE ?? "docker") !== "docker") {
    throw new Error("Выполнение команды на хосте отключено. Установите SANDBOX_MODE=docker.");
  }
  if (signal?.aborted) throw Object.assign(new Error("Запуск агента отменён"), { name: "AbortError" });
  const active = [...jobs.values()];
  if (active.length >= jobLimit()) {
    throw new Error(
      "На этом хосте уже работают " + jobLimit() + " долгих заданий. Дождитесь завершения одного из них " +
      "или остановите ненужное через terminal.stop.",
    );
  }
  if (active.filter(record => record.projectId === config.projectId).length >= perProjectLimit()) {
    throw new Error(
      "У проекта уже " + perProjectLimit() + " долгих задания. Прочитайте вывод через terminal.tail " +
      "или остановите одно через terminal.stop, прежде чем запускать ещё.",
    );
  }

  // Бюджет минут проверяется до запуска контейнера и до резервации памяти: исчерпанный лимит
  // получает объяснение сразу, а не держит память полчаса. Только проверка, без очереди —
  // фоновое задание не должно заставлять обычные команды аккаунта ждать своего конца.
  await assertSandboxJobBudget(userId);
  await openProjectForSandbox(config.root);
  const host=await resolveSandboxHost(config.node||nodeId());
  const masks = await secretEnvMaskMounts(config);
  if (signal?.aborted) throw Object.assign(new Error("Запуск агента отменён"), { name: "AbortError" });
  const name = sandboxJobName(config.projectId);
  const args = dockerRunArgs(
    config,
    cwd,
    dockerOptions(config),
    command,
    "none",
    name,
    masks,
    { detached: true, labels: { "webnestdev.job": "1", "webnestdev.project": config.projectId, "webnestdev.load": "job" } },
  );
  // Память занимается на всё время жизни контейнера задания. Раньше задание в предел
  // `withSandboxSlot` не входило вовсе: четыре задания по 1 ГБ могли стоять рядом с двумя
  // командами на машине с 2.7 ГБ доступной памяти, и OOM убивал не обязательно виновника.
  // Замер 24.11.2026 (node-1/node-2): 3886 МБ всего, 2.7–2.9 ГБ доступно, база платформы
  // ~0.7 ГБ, поэтому бюджет по умолчанию — 2048 МБ потолков (2 × 1 ГБ).
  const memoryMb = memoryLimitMb(dockerOptions(config).memory, config.memoryMb);
  let memory: SandboxMemoryReservation;
  try {
    memory = await reserveSandboxMemory(memoryMb, {
      ...(signal ? { signal } : {}),
      label: "Память песочницы",
      waitMs: positiveInt(process.env.SANDBOX_JOB_MEMORY_WAIT_MS, 60_000),
    });
  } catch (error) {
    if (error instanceof QueueTimeoutError) {
      throw new Error(
        "Сейчас нет свободной памяти под ещё одно долгое задание. Дождитесь завершения текущего " +
        "или остановите ненужное через terminal.stop.",
      );
    }
    throw error;
  }
  let result: DockerResult;
  try {
    result = await host.docker(args);
  } catch (error) {
    memory.release();
    throw error;
  }
  if (result.code !== 0) {
    memory.release();
    const detail = (result.stderr || result.stdout).trim().slice(0, 500);
    throw new Error("Не удалось запустить долгую команду" + (detail ? ": " + detail : ""));
  }

  const record: JobRecord = {
    name,
    projectId: config.projectId,
    userId,
    command,
    cwd,
    startedAt: Date.now(),
    timer: setTimeout(() => { void stopInternal(record); }, sandboxJobMaxMs()),
    host,
    releaseMemory: () => memory.release(),
    ...(onExit ? { onExit } : {}),
  };
  record.timer.unref?.();
  jobs.set(name, record);

  return {
    ok: true,
    background: true,
    jobId: name,
    command,
    cwd,
    startedAt: new Date(record.startedAt).toISOString(),
    maxLifetimeSeconds: Math.round(sandboxJobMaxMs() / 1000),
  };
}

export type SandboxJobTail = {
  ok: boolean;
  jobId: string;
  running: boolean;
  done: boolean;
  status: string;
  exitCode: number | null;
  logs: string;
  lines: number;
  totalLines: number;
  matchedLines: number;
  truncated: boolean;
  note: string;
  /** Отказ из-за выключенной сети — с объяснением, что делать вместо этого. */
  hint?: string;
  error?: string;
  missing?: boolean;
};

function readOwner(projectId: string, userId: string, jobId: string) {
  const record = jobs.get(jobId);
  if (!record) return null;
  // Чужое задание не отличается от исчезнувшего: имя контейнера не должно становиться способом
  // читать вывод другого проекта.
  if (record.projectId !== projectId || record.userId !== userId) return null;
  return record;
}

export async function tailSandboxJob(
  projectId: string,
  userId: string,
  jobId: string,
  requestedLines: number,
  grep = "",
): Promise<SandboxJobTail> {
  const record = readOwner(projectId, userId, jobId);
  if (!record) {
    return {
      ok: false,
      jobId,
      running: false,
      done: true,
      status: "missing",
      exitCode: null,
      logs: "",
      lines: 0,
      totalLines: 0,
      matchedLines: 0,
      truncated: false,
      missing: true,
      error: "Задание не найдено: оно уже завершилось, было остановлено или сервер перезапускался.",
      note: "Запустите команду снова через terminal.start, если результат ещё нужен.",
    };
  }

  const [logsResult, stateResult] = await Promise.all([
    record.host.docker(["logs", "--tail", String(MAX_TAIL_LINES), jobId]),
    record.host.docker(["inspect", "--format", "{{.State.Status}}|{{.State.ExitCode}}", jobId]),
  ]);
  if (logsResult.code !== 0 && /no such container/i.test(logsResult.stderr)) {
    forgetJob(record);
    return {
      ok: false,
      jobId,
      running: false,
      done: true,
      status: "missing",
      exitCode: null,
      logs: "",
      lines: 0,
      totalLines: 0,
      matchedLines: 0,
      truncated: false,
      missing: true,
      error: "Контейнер задания уже удалён.",
      note: "Результат больше недоступен. Запустите команду снова, если он нужен.",
    };
  }

  const [status = "unknown", exitText = ""] = stateResult.stdout.trim().split("|");
  const exitCode = Number.isFinite(Number(exitText)) ? Number(exitText) : null;
  const running = status === "running" || status === "created" || status === "restarting";
  const done = !running;
  const combined = [logsResult.stdout, logsResult.stderr].filter(Boolean).join("\n");
  const tail = tailLogLines(combined, requestedLines, grep);
  let logs = tail.lines.join("\n");
  const truncated = logs.length > MAX_LOG_CHARS;
  if (truncated) logs = logs.slice(-MAX_LOG_CHARS);

  // Завершённое задание отдаёт вывод один раз: контейнер без `--rm` иначе оставался бы навсегда.
  if (done) await stopInternal(record);

  return {
    ok: true,
    jobId,
    running,
    done,
    status,
    exitCode: done ? exitCode : null,
    logs,
    lines: tail.lines.length,
    totalLines: tail.total,
    matchedLines: tail.matched,
    truncated,
    note: !tail.lines.length
      ? grep
        ? "В выводе нет строк с «" + grep + "». Попробуйте более короткое слово или вызовите без grep."
        : "Пока нет вывода: команда ещё ничего не написала."
      : done
        ? "Задание завершено, это последний доступный вывод."
        : "Задание ещё работает. Логи — снимок на текущий момент, повторите terminal.tail позже.",
  };
}

export async function stopSandboxJob(projectId: string, userId: string, jobId: string) {
  const record = readOwner(projectId, userId, jobId);
  if (!record) {
    return {
      ok: false,
      jobId,
      stopped: false,
      error: "Задание не найдено: оно уже завершилось или было остановлено.",
    };
  }
  await stopInternal(record);
  return { ok: true, jobId, stopped: true, note: "Задание остановлено, контейнер удалён." };
}

/**
 * Убирает задания прошлого запуска сервера. Они принадлежат контейнерам, а не процессу Node:
 * после падения или перезапуска их никто не сможет прочитать, но память они продолжат занимать.
 * `SANDBOX_JOBS_REAP_ON_START=0` выключает уборку для хоста с несколькими репликами.
 */
export async function cleanupSandboxJobs() {
  if (process.env.SANDBOX_JOBS_REAP_ON_START === "0") return { removed: 0 };
  const listed = await sandboxHost().docker(["ps", "-aq", "--filter", "label=webnestdev.job=1"]);
  if (listed.code !== 0) return { removed: 0 };
  const ids = listed.stdout.split(/\s+/).filter(Boolean);
  if (ids.length) await sandboxHost().docker(["rm", "-f", ...ids]);
  return { removed: ids.length };
}
