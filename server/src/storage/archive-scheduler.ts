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
 * «Давно» считается по времени последней записи в проект (`project_sizes.last_write_at`): этот
 * счётчик обновляется после работы агента, загрузки файла, импорта и предпросмотра. Время замера
 * (`updated_at`) для этого не годится: ежедневная сверка обновляет его у всех проектов, и таймер
 * простоя обнулялся бы каждые сутки. Проект без замера не трогаем — иначе под архивацию попал
 * бы только что созданный.
 */

const DEFAULT_START_DELAY_MS = 5 * 60 * 1000;
// Минуты, а не дни: проект может «уснуть» уже через час после того, как его закрыли, и тогда
// обход должен случаться чаще, иначе час простоя превращается в семь.
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_IDLE_MINUTES = 360;
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

function optionalNumber(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Порог простоя в миллисекундах. `PROJECT_ARCHIVE_IDLE_MINUTES` — основной ключ (по умолчанию
 * 6 часов), `PROJECT_ARCHIVE_IDLE_DAYS` — старый, сохранён для уже настроенных установок.
 * Минуты важнее дней: иначе значение из старого .env (14 дней) молча перебивало бы новое.
 *
 * 6 часов, а не час: при часовом пороге возврат к проекту после обеда каждый раз превращался
 * в скачивание архива, и экономия диска стоила дороже, чем трафик и ожидание.
 */
export function projectArchiveIdleMs(): number {
  const minutes = optionalNumber("PROJECT_ARCHIVE_IDLE_MINUTES");
  if (minutes !== null) return Math.max(1, minutes) * 60_000;
  const days = optionalNumber("PROJECT_ARCHIVE_IDLE_DAYS");
  if (days !== null) return Math.max(1, Math.round(days * 1440)) * 60_000;
  return DEFAULT_IDLE_MINUTES * 60_000;
}

export type ArchiveSweepResult = {
  candidates: number;
  archived: number;
  skipped: number;
  failed: number;
};

export async function sweepIdleProjects(idleMs = projectArchiveIdleMs()): Promise<ArchiveSweepResult> {
  const result: ArchiveSweepResult = { candidates: 0, archived: 0, skipped: 0, failed: 0 };
  if (!objectStoreConfigFromEnv()) return result;
  idleMs = Math.max(60_000, idleMs);
  const accessGuardMs = envNumber("PROJECT_ARCHIVE_ACCESS_GUARD_MS", DEFAULT_ACCESS_GUARD_MS);
  const [projects, sizes] = await Promise.all([listProjectOwners(), readProjectSizes()]);
  for (const project of projects) {
    const measured = sizes.get(project.id);
    if (!measured) {
      result.skipped++;
      continue;
    }
    // `lastWriteAt` может быть null у строк, созданных до появления поля: тогда годится время
    // замера — оно всё равно не позже первой записи.
    const lastWrite = measured.lastWriteAt ?? measured.updatedAt;
    if (Date.now() - Date.parse(lastWrite) < idleMs) {
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

  const idleMs = projectArchiveIdleMs();
  const startDelayMs = envNumber("PROJECT_ARCHIVE_START_DELAY_MS", DEFAULT_START_DELAY_MS);
  const intervalMs = Math.max(MIN_INTERVAL_MS, envNumber("PROJECT_ARCHIVE_SWEEP_INTERVAL_MS", DEFAULT_INTERVAL_MS));
  const idleLabel = idleMs % 3_600_000 === 0
    ? Math.round(idleMs / 3_600_000) + " ч"
    : Math.round(idleMs / 60_000) + " мин";

  const run = async (reason: string) => {
    if (running) return;
    running = true;
    try {
      const result = await sweepIdleProjects(idleMs);
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
    "[storage] холодный ярус: проекты без изменений " + idleLabel + " переносятся в бакет; " +
    "первый проход через " + Math.round(startDelayMs / 1000) + " с, далее раз в " + Math.round(intervalMs / 60_000) + " мин",
  );
  return () => {
    clearTimeout(startupTimer);
    clearInterval(timer);
    started = false;
  };
}
