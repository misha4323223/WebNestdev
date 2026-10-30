import { stat } from "node:fs/promises";
import { listProjectOwners } from "../project-store.js";
import { sandboxRootDir, sandboxRootPath } from "../sandbox/config.js";
import { readProjectSizes } from "../account/storage-quota.js";
import { isRunActive } from "../agent/active-runs.js";
import { getPreview } from "../preview/preview-store.js";
import { diskStatus, type DiskStatus } from "../health/host-metrics.js";
import { objectStoreConfigFromEnv } from "./object-store.js";
import {
  archiveProject as archiveProjectToBucket,
  lastProjectAccess as projectLastAccess,
  projectArchiveInfo,
} from "./project-archive.js";
import {
  recordArchiveFailure,
  recordArchiveRun,
  type ArchiveRunReport,
} from "./archive-health.js";

/**
 * Перенос давно не открывавшихся проектов в объектное хранилище.
 *
 * По умолчанию выключен: архивация меняет поведение (первое открытие проекта после простоя
 * скачивает архив), и включать её без явного решения оператора нельзя. Диск освобождается
 * только когда `PROJECT_ARCHIVE_ENABLED=1` и настроены `PLATFORM_S3_*`.
 *
 * «Давно» считается по времени последней записи в проект (`project_sizes.last_write_at`): этот
 * счётчик обновляется после работы агента, загрузки файла, импорта и предпросмотра. Время замера
 * (`updated_at`) для этого не годится: ежедневная сверка обновляет его у всех проектов, и таймер
 * простоя обнулялся бы каждые сутки. Проект без замера не трогаем — иначе под архивацию попал
 * бы только что созданный.
 *
 * Кроме таймера есть второй повод: заполненный диск. При занятости выше
 * `PROJECT_ARCHIVE_DISK_HIGH_PERCENT` самые старые из простаивающих проектов уезжают в бакет,
 * пока занятость не опустится до `PROJECT_ARCHIVE_DISK_TARGET_PERCENT`. Это не трогает проекты
 * моложе порога простоя и проекты, открытые в этом процессе недавно, — иначе архивация забрала
 * бы файлы из-под открытой вкладки.
 */

const DEFAULT_START_DELAY_MS = 5 * 60 * 1000;
// Минуты, а не дни: проект может «уснуть» уже через час после того, как его закрыли, и тогда
// обход должен случаться чаще, иначе час простоя превращается в семь.
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_IDLE_MINUTES = 180;
// Час после последнего открытия: счётчик размера растёт только на запись, а чтение файлов
// (панель, терминал) в нём не видно — без этого запаса архив мог уехать из-под открытой вкладки.
const DEFAULT_ACCESS_GUARD_MS = 60 * 60 * 1000;
const DEFAULT_DISK_HIGH_PERCENT = 75;
const DEFAULT_DISK_TARGET_PERCENT = 68;
const DEFAULT_ARCHIVE_CONCURRENCY = 2;
const DEFAULT_PRESSURE_CHECK_MS = 60 * 1000;
const MIN_INTERVAL_MS = 60_000;
const MIN_PRESSURE_CHECK_MS = 30_000;
const MAX_ARCHIVE_CONCURRENCY = 4;

let started = false;
let running = false;

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function optionalNumber(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Порог простоя в миллисекундах. `PROJECT_ARCHIVE_IDLE_MINUTES` — основной ключ (по умолчанию
 * 3 часа), `PROJECT_ARCHIVE_IDLE_DAYS` — старый, сохранён для уже настроенных установок.
 * Минуты важнее дней: иначе значение из старого .env (14 дней) молча перебивало бы новое.
 *
 * 3 часа — компромисс: при часовом пороге возврат к проекту после обеда каждый раз превращался
 * в скачивание архива, а шесть часов держали диск занятым дольше, чем нужно.
 */
export function projectArchiveIdleMs(): number {
  const minutes = optionalNumber("PROJECT_ARCHIVE_IDLE_MINUTES");
  if (minutes !== null) return Math.max(1, minutes) * 60_000;
  const days = optionalNumber("PROJECT_ARCHIVE_IDLE_DAYS");
  if (days !== null) return Math.max(1, Math.round(days * 1440)) * 60_000;
  return DEFAULT_IDLE_MINUTES * 60_000;
}

/** Занятость, при которой начинается разгрузка диска, в процентах. */
export function projectArchiveDiskHighPercent(): number {
  return Math.min(100, Math.max(1, Math.round(envNumber("PROJECT_ARCHIVE_DISK_HIGH_PERCENT", DEFAULT_DISK_HIGH_PERCENT))));
}

/** Занятость, до которой разгружается диск. Всегда ниже порога срабатывания. */
export function projectArchiveDiskTargetPercent(): number {
  const high = projectArchiveDiskHighPercent();
  const target = Math.round(envNumber("PROJECT_ARCHIVE_DISK_TARGET_PERCENT", DEFAULT_DISK_TARGET_PERCENT));
  return Math.min(high - 1, Math.max(0, target));
}

/** Сколько проектов разрешено упаковывать одновременно: tar и загрузка не должны съесть CPU. */
export function projectArchiveConcurrency(): number {
  return Math.min(
    MAX_ARCHIVE_CONCURRENCY,
    Math.max(1, Math.round(envNumber("PROJECT_ARCHIVE_CONCURRENCY", DEFAULT_ARCHIVE_CONCURRENCY))),
  );
}

/** Как часто проверять диск между обычными обходами; сама проверка дешёвая (statfs). */
export function projectArchivePressureCheckMs(): number {
  return Math.max(MIN_PRESSURE_CHECK_MS, envNumber("PROJECT_ARCHIVE_PRESSURE_CHECK_MS", DEFAULT_PRESSURE_CHECK_MS));
}

export type ArchiveRunResult = ArchiveRunReport;

export type ArchiveCandidateInput = {
  projectId: string;
  userId: string;
  sizeBytes: number;
  lastWriteMs: number;
  lastAccessMs: number;
  active: boolean;
  preview: boolean;
  archived: boolean;
  workspace: boolean;
};

export type ArchiveCandidate = {
  projectId: string;
  userId: string;
  sizeBytes: number;
  lastWriteMs: number;
  lastAccessMs: number;
  lastActiveMs: number;
};

/**
 * Чистый отбор: по нему видно, почему проект не попал в архив, и его легко проверить тестом.
 * `lastActiveMs` — самое позднее из записи и открытия; по нему старые проекты уходят первыми.
 */
export function selectArchiveCandidates(
  inputs: readonly ArchiveCandidateInput[],
  options: { now: number; idleMs: number; accessGuardMs: number },
): ArchiveCandidate[] {
  return inputs
    .filter(candidate => {
      if (candidate.active || candidate.preview || candidate.archived || !candidate.workspace) return false;
      if (!Number.isFinite(candidate.lastWriteMs)) return false;
      if (options.now - candidate.lastWriteMs < options.idleMs) return false;
      if (options.now - candidate.lastAccessMs < options.accessGuardMs) return false;
      return true;
    })
    .map(candidate => ({
      projectId: candidate.projectId,
      userId: candidate.userId,
      sizeBytes: candidate.sizeBytes,
      lastWriteMs: candidate.lastWriteMs,
      lastAccessMs: candidate.lastAccessMs,
      lastActiveMs: Math.max(candidate.lastWriteMs, candidate.lastAccessMs),
    }))
    .sort((a, b) => a.lastActiveMs - b.lastActiveMs);
}

type ProjectSize = {
  sizeBytes: number;
  updatedAt: string;
  lastWriteAt: string | null;
};

export type ArchiveSweepDeps = {
  hasStore: () => boolean;
  listProjects: () => Promise<Array<{ id: string; userId: string }>>;
  readSizes: () => Promise<Map<string, ProjectSize>>;
  isProjectActive: (projectId: string) => boolean;
  hasPreview: (projectId: string) => boolean;
  lastProjectAccess: (projectId: string) => number;
  archiveInfo: (projectId: string) => Promise<unknown | null>;
  workspaceExists: (projectId: string) => Promise<boolean>;
  archiveProject: (projectId: string, userId: string) => Promise<{ alreadyArchived: boolean; bytes: number }>;
  diskStatus: () => Promise<DiskStatus>;
  now: () => number;
  recordFailure: () => void;
};

const defaultDeps: ArchiveSweepDeps = {
  hasStore: () => {
    try {
      return Boolean(objectStoreConfigFromEnv());
    } catch {
      return false;
    }
  },
  listProjects: () => listProjectOwners(),
  readSizes: () => readProjectSizes(),
  isProjectActive: projectId => isRunActive(projectId),
  hasPreview: projectId => Boolean(getPreview(projectId)),
  lastProjectAccess: projectId => projectLastAccess(projectId),
  archiveInfo: projectId => projectArchiveInfo(projectId),
  workspaceExists: async projectId => {
    const info = await stat(sandboxRootPath(projectId)).catch(() => null);
    return Boolean(info?.isDirectory());
  },
  archiveProject: (projectId, userId) => archiveProjectToBucket(projectId, userId),
  diskStatus: () => diskStatus(sandboxRootDir()),
  now: () => Date.now(),
  recordFailure: () => recordArchiveFailure(),
};

function emptyResult(
  mode: "idle" | "pressure",
  startedAtMs: number,
  diskBefore: number | null,
): ArchiveRunResult {
  const at = new Date(startedAtMs).toISOString();
  return {
    mode,
    startedAt: at,
    finishedAt: at,
    durationMs: 0,
    candidates: 0,
    archived: 0,
    skipped: 0,
    deferred: 0,
    failed: 0,
    bytesFreed: 0,
    diskBefore,
    diskAfter: diskBefore,
    targetPercent: null,
    targetReached: null,
  };
}

export type ArchiveSweepOptions = {
  /** Проверять только давление на диск: обычный обход по таймеру уже сделан или ещё не нужен. */
  pressureOnly?: boolean;
  /** Подмена зависимостей для теста; в продакшене не задаётся. */
  deps?: Partial<ArchiveSweepDeps>;
};

/**
 * Один проход. Без давления на диск архивирует все простаивающие проекты, как раньше. При
 * занятости выше порога идёт по самым старым и останавливается, когда диск разгружен до цели.
 * Параллелизм ограничен: каждый архив — это `tar` и загрузка, они конкурируют с превью за CPU.
 */
export async function sweepIdleProjects(
  idleMs = projectArchiveIdleMs(),
  options: ArchiveSweepOptions = {},
): Promise<ArchiveRunResult> {
  const deps: ArchiveSweepDeps = { ...defaultDeps, ...options.deps };
  const startedAt = deps.now();
  const highPercent = projectArchiveDiskHighPercent();
  const targetPercent = projectArchiveDiskTargetPercent();
  const concurrency = projectArchiveConcurrency();

  if (!deps.hasStore()) return emptyResult("idle", startedAt, null);

  idleMs = Math.max(60_000, idleMs);
  const accessGuardMs = envNumber("PROJECT_ARCHIVE_ACCESS_GUARD_MS", DEFAULT_ACCESS_GUARD_MS);
  // Диск проверяется первым: проверка давления не должна читать список проектов и размеры,
  // когда места достаточно. Это и есть дешёвый путь между десятиминутными обходами.
  const initialDisk = await deps.diskStatus();
  const diskBefore = initialDisk?.usedPercent ?? null;
  const pressure = diskBefore !== null && diskBefore >= highPercent;

  // Проверка по таймеру давления не должна делать полный обход, если диск уже в норме.
  if (options.pressureOnly && !pressure) {
    const result = emptyResult("idle", startedAt, diskBefore);
    result.diskAfter = diskBefore;
    return result;
  }

  const [projects, sizes] = await Promise.all([deps.listProjects(), deps.readSizes()]);
  const mode: "idle" | "pressure" = pressure ? "pressure" : "idle";
  const result = emptyResult(mode, startedAt, diskBefore);
  result.targetPercent = pressure ? targetPercent : null;
  result.targetReached = pressure && diskBefore !== null ? diskBefore <= targetPercent : null;

  let skipped = 0;
  const inputs: ArchiveCandidateInput[] = [];
  for (const project of projects) {
    const measured = sizes.get(project.id);
    if (!measured) {
      skipped++;
      continue;
    }
    // `lastWriteAt` может быть null у строк, созданных до появления поля: тогда годится время
    // замера — оно всё равно не позже первой записи.
    const lastWriteMs = Date.parse(measured.lastWriteAt ?? measured.updatedAt);
    if (!Number.isFinite(lastWriteMs)) {
      skipped++;
      continue;
    }
    const archived = await deps.archiveInfo(project.id);
    inputs.push({
      projectId: project.id,
      userId: project.userId,
      sizeBytes: measured.sizeBytes,
      lastWriteMs,
      lastAccessMs: deps.lastProjectAccess(project.id),
      active: deps.isProjectActive(project.id),
      preview: deps.hasPreview(project.id),
      archived: Boolean(archived),
      // Живая папка важнее отметки; отсутствие папки без отметки — не архив, а потерянный проект.
      workspace: archived ? false : await deps.workspaceExists(project.id),
    });
  }

  const candidates = selectArchiveCandidates(inputs, {
    now: startedAt,
    idleMs,
    accessGuardMs,
  });
  result.candidates = candidates.length;
  result.skipped = skipped + (inputs.length - candidates.length);

  let stop = false;
  const diskNow = async () => {
    const status = await deps.diskStatus();
    if (status) result.diskAfter = status.usedPercent;
    return status?.usedPercent ?? null;
  };
  const shouldStop = async () => {
    if (mode !== "pressure") return false;
    const used = await diskNow();
    return used !== null && used <= targetPercent;
  };

  if (await shouldStop()) stop = true;

  let cursor = 0;
  let attempted = 0;
  const worker = async () => {
    while (!stop) {
      if (mode === "pressure" && (await shouldStop())) {
        stop = true;
        break;
      }
      const index = cursor++;
      if (index >= candidates.length) break;
      attempted++;
      const candidate = candidates[index];
      try {
        const archived = await deps.archiveProject(candidate.projectId, candidate.userId);
        if (archived.alreadyArchived) {
          result.skipped++;
        } else {
          result.archived++;
          result.bytesFreed += archived.bytes;
        }
      } catch (error) {
        result.failed++;
        deps.recordFailure();
        console.warn(
          "[storage] не удалось перенести проект " + candidate.projectId + " в объектное хранилище: " +
            (error instanceof Error ? error.message : String(error)),
        );
      }
      if (mode === "pressure" && (await shouldStop())) stop = true;
    }
  };

  const workerCount = Math.min(concurrency, candidates.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  result.deferred = Math.max(0, candidates.length - attempted);

  if (mode === "pressure") {
    const after = await diskNow();
    result.targetReached = after !== null && after <= targetPercent;
  } else {
    await diskNow();
  }
  result.finishedAt = new Date(deps.now()).toISOString();
  result.durationMs = Math.max(0, deps.now() - startedAt);
  return result;
}

export function startProjectArchiveScheduler(): () => void {
  if (started) return () => {};
  started = true;
  if (process.env.PROJECT_ARCHIVE_ENABLED !== "1") {
    console.log("[storage] холодный ярус проектов выключен (PROJECT_ARCHIVE_ENABLED=1 включает архивацию в бакет)");
    return () => { started = false; };
  }
  let config: ReturnType<typeof objectStoreConfigFromEnv>;
  try {
    config = objectStoreConfigFromEnv();
  } catch (error) {
    console.warn("[storage] холодный ярус не запущен: " + (error instanceof Error ? error.message : String(error)));
    return () => { started = false; };
  }
  if (!config) {
    console.warn("[storage] холодный ярус не запущен: не заданы PLATFORM_S3_*");
    return () => { started = false; };
  }

  const idleMs = projectArchiveIdleMs();
  const startDelayMs = envNumber("PROJECT_ARCHIVE_START_DELAY_MS", DEFAULT_START_DELAY_MS);
  const intervalMs = Math.max(MIN_INTERVAL_MS, envNumber("PROJECT_ARCHIVE_SWEEP_INTERVAL_MS", DEFAULT_INTERVAL_MS));
  const pressureCheckMs = projectArchivePressureCheckMs();
  const diskHigh = projectArchiveDiskHighPercent();
  const diskTarget = projectArchiveDiskTargetPercent();
  const concurrency = projectArchiveConcurrency();
  const idleLabel = idleMs % 3_600_000 === 0
    ? Math.round(idleMs / 3_600_000) + " ч"
    : Math.round(idleMs / 60_000) + " мин";
  // Если под давлением не осталось простаивающих проектов, полный обход раз в минуту ничего
  // не даст: ждём обычный интервал, чтобы не читать список и отметки каждую минуту впустую.
  let pressureBackoffUntil = 0;

  const run = async (reason: string, pressureOnly = false) => {
    if (running) return;
    // Проверка давления между десятиминутными обходами: statfs дешевле, чем полный список
    // проектов и чтение размеров. Если диск в норме, делать нечего.
    if (pressureOnly) {
      if (Date.now() < pressureBackoffUntil) return;
      const status = await diskStatus(sandboxRootDir()).catch(() => null);
      if (!status || status.usedPercent < diskHigh) return;
    }
    running = true;
    try {
      const result = await sweepIdleProjects(idleMs, { pressureOnly });
      if (pressureOnly && result.archived === 0 && result.failed === 0) {
        pressureBackoffUntil = Date.now() + intervalMs;
      } else {
        pressureBackoffUntil = 0;
      }
      if (!pressureOnly || result.candidates > 0 || result.failed > 0) {
        recordArchiveRun(result);
        const disk = result.diskBefore === null
          ? "диск: ?"
          : "диск: " + result.diskBefore + "% → " + (result.diskAfter ?? "?") + "%";
        console.log(
          "[storage] холодный ярус (" + reason + "): " + result.mode + ", освобождено " +
            result.archived + " проектов, отложено " + result.deferred + ", пропущено " +
            result.skipped + ", ошибок " + result.failed + "; " + disk +
            (result.targetPercent !== null
              ? "; цель " + result.targetPercent + "%" + (result.targetReached ? " достигнута" : " не достигнута")
              : ""),
        );
      } else if (result.diskBefore !== null) {
        console.warn(
          "[storage] холодный ярус: диск занят на " + result.diskBefore + "%, но простаивающих " +
            "проектов для архивации нет; следующая проверка через " + Math.round(intervalMs / 60_000) + " мин",
        );
      }
    } catch (error) {
      console.warn("[storage] холодный ярус упал: " + (error instanceof Error ? error.message : String(error)));
    } finally {
      running = false;
    }
  };

  const startupTimer = setTimeout(() => void run("startup"), startDelayMs);
  startupTimer.unref();
  const timer = setInterval(() => void run("schedule"), intervalMs);
  timer.unref();
  const pressureTimer = setInterval(() => void run("pressure", true), pressureCheckMs);
  pressureTimer.unref();
  console.log(
    "[storage] холодный ярус: проекты без изменений " + idleLabel + " переносятся в бакет; " +
    "давление на диск: при " + diskHigh + "% архивируются самые старые до " + diskTarget + "%, " +
    "проверка раз в " + Math.round(pressureCheckMs / 1000) + " с; параллельно " + concurrency + "; " +
    "первый обход через " + Math.round(startDelayMs / 1000) + " с, далее раз в " + Math.round(intervalMs / 60_000) + " мин",
  );
  return () => {
    clearTimeout(startupTimer);
    clearInterval(timer);
    clearInterval(pressureTimer);
    started = false;
  };
}
