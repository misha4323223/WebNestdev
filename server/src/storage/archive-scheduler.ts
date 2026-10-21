import { stat } from "node:fs/promises";
import { listProjectOwners } from "../project-store.js";
import { sandboxRootPath } from "../sandbox/config.js";
import { readProjectSizes } from "../account/storage-quota.js";
import { isRunActive } from "../agent/active-runs.js";
import { getPreview } from "../preview/preview-store.js";
import { objectStoreConfigFromEnv } from "./object-store.js";
import { archiveProject, lastProjectAccess, projectArchiveInfo } from "./project-archive.js";

/**
 * Перенос давно не открывавшихся проектов в объектное хранилище.
 *
 * По умолчанию выключен: архивация меняет поведение (первое открытие проекта после простоя
 * скачивает архив), и включать её без явного решения оператора нельзя. Диск освобождается
 * только когда `PROJECT_ARCHIVE_ENABLED=1` и настроены `PLATFORM_S3_*`.
 *
 * «Давно» считается по времени последней записи в проект (`project_sizes.updated_at`): этот
 * счётчик обновляется после работы агента, загрузки файла, импорта и предпросмотра. Проект без
 * замера не трогаем — иначе под архивацию попал бы только что созданный.
 */

const DEFAULT_START_DELAY_MS = 5 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_IDLE_DAYS = 14;
// Час после последнего открытия: счётчик размера растёт только на запись, а чтение файлов
// (панель, терминал) в нём не видно — без этого запаса архив мог уехать из-под открытой вкладки.
const DEFAULT_ACCESS_GUARD_MS = 60 * 60 * 1000;
const MIN_INTERVAL_MS = 60_000;

let started = false;
let running = false;

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export type ArchiveSweepResult = {
  candidates: number;
  archived: number;
  skipped: number;
  failed: number;
};

export async function sweepIdleProjects(idleDays = envNumber("PROJECT_ARCHIVE_IDLE_DAYS", DEFAULT_IDLE_DAYS)): Promise<ArchiveSweepResult> {
  const result: ArchiveSweepResult = { candidates: 0, archived: 0, skipped: 0, failed: 0 };
  if (!objectStoreConfigFromEnv()) return result;
  const idleMs = Math.max(1, idleDays) * 24 * 60 * 60 * 1000;
  const accessGuardMs = envNumber("PROJECT_ARCHIVE_ACCESS_GUARD_MS", DEFAULT_ACCESS_GUARD_MS);
  const [projects, sizes] = await Promise.all([listProjectOwners(), readProjectSizes()]);
  for (const project of projects) {
    const measured = sizes.get(project.id);
    if (!measured) {
      result.skipped++;
      continue;
    }
    if (Date.now() - Date.parse(measured.updatedAt) < idleMs) {
      result.skipped++;
      continue;
    }
    // Агент, живой предпросмотр или недавно открытая панель держат файлы открытыми:
    // архивировать проект в этот момент нельзя.
    if (isRunActive(project.id) || getPreview(project.id)) {
      result.skipped++;
      continue;
    }
    if (Date.now() - lastProjectAccess(project.id) < accessGuardMs) {
      result.skipped++;
      continue;
    }
    if (await projectArchiveInfo(project.id)) {
      result.skipped++;
      continue;
    }
    const info = await stat(sandboxRootPath(project.id)).catch(() => null);
    if (!info?.isDirectory()) {
      result.skipped++;
      continue;
    }
    result.candidates++;
    try {
      const archived = await archiveProject(project.id, project.userId);
      if (archived.alreadyArchived) result.skipped++;
      else result.archived++;
    } catch (error) {
      result.failed++;
      console.warn(
        "[storage] не удалось перенести проект " + project.id + " в объектное хранилище: " +
        (error instanceof Error ? error.message : String(error)),
      );
    }
  }
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

  const idleDays = envNumber("PROJECT_ARCHIVE_IDLE_DAYS", DEFAULT_IDLE_DAYS);
  const startDelayMs = envNumber("PROJECT_ARCHIVE_START_DELAY_MS", DEFAULT_START_DELAY_MS);
  const intervalMs = Math.max(MIN_INTERVAL_MS, envNumber("PROJECT_ARCHIVE_SWEEP_INTERVAL_MS", DEFAULT_INTERVAL_MS));

  const run = async (reason: string) => {
    if (running) return;
    running = true;
    try {
      const result = await sweepIdleProjects(idleDays);
      console.log(
        "[storage] холодный ярус (" + reason + "): освобождено " + result.archived + " проектов, " +
        "пропущено " + result.skipped + ", ошибок " + result.failed,
      );
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
  console.log(
    "[storage] холодный ярус: проекты без изменений " + idleDays + " дн. переносятся в бакет; " +
    "первый проход через " + Math.round(startDelayMs / 1000) + " с, далее раз в " + Math.round(intervalMs / 3_600_000) + " ч",
  );
  return () => {
    clearTimeout(startupTimer);
    clearInterval(timer);
    started = false;
  };
}
