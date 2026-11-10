import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { sandboxRootDir } from "../sandbox/config.js";
import { listProjectOwners } from "../project-store.js";

/**
 * Уборка каталогов проектов, которых больше нет в базе.
 *
 * Когда проект удаляют, запись в базе исчезает сразу, а папка на общем диске — нет: удаление
 * файлов идёт после ответа пользователю и может не доехать (рестарт контейнера, потеря узла,
 * обрыв на общем томе). Снаружи такой каталог занимает место, но открыть его некому: проекта
 * нет ни в списке, ни в архивах. За месяцы это копится молча — на 10.11.2026 так лежал каталог
 * с 14 октября.
 *
 * Критерий «неактуальности» здесь не возраст, а **отсутствие проекта в базе**. Возраст —
 * только запас на случай, когда база отвечает неполно: пока каталог моложе порога простоя
 * (24 часа по умолчанию), его не трогают.
 *
 * Что НЕ удаляется никогда, хотя лежит рядом:
 * - `.secret-mask`, `archive-*.tar.gz`, `.restore-*` — служебные каталоги платформы;
 * - `.project-backup-<id>` — прежняя папка проекта при восстановлении из архива; в ней может
 *   быть более свежая работа, чем в бакете, поэтому её разбирает человек, а не таймер;
 * - каталоги, имя которых не является UUID проекта: чужая папка на общем томе — не наша.
 */

const DEFAULT_RETENTION_HOURS = 24;
const DEFAULT_START_DELAY_MS = 10 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const MIN_INTERVAL_MS = 5 * 60 * 1000;
/** Сколько каталогов убирать за один проход: ошибка в списке проектов не должна снести всё. */
const MAX_REMOVALS_PER_RUN = 20;
/** Предел обхода при подсчёте размера: каталог-сирота может быть любой, а лог нужен быстрый. */
const MAX_SIZE_ENTRIES = 50_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESERVED = new Set([".secret-mask"]);
const TEMP_PREFIXES = [".project-backup-", ".restore-", "archive-"];

export type OrphanSweepResult = {
  scanned: number;
  removed: number;
  bytes: number;
  skipped: number;
  failed: number;
  /** Причина, по которой проход ничего не делал: пустой список проектов, нет каталога. */
  aborted: string | null;
};

export type OrphanSweepOptions = {
  /** Корень песочниц; в тестах подменяется временным каталогом. */
  root?: string;
  /** Текущее время, мс. */
  now?: number;
  retentionHours?: number;
  /** Только показать, что было бы удалено. */
  dryRun?: boolean;
  /** Список живых проектов. В тестах подменяется, в работе читается из хранилища. */
  projectIds?: () => Promise<Set<string>>;
};

/** Порог простоя в часах: `SANDBOX_GC_HOURS` (по умолчанию 24). */
export function orphanRetentionHours(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SANDBOX_GC_HOURS?.trim();
  if (!raw) return DEFAULT_RETENTION_HOURS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 1 ? Math.min(Math.round(value), 24 * 30) : DEFAULT_RETENTION_HOURS;
}

/** Размер каталога для строки лога. Ошибки обхода не мешают уборке. */
async function dirSize(dir: string, budget = { left: MAX_SIZE_ENTRIES }): Promise<number> {
  if (budget.left <= 0) return 0;
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (budget.left <= 0) break;
    budget.left -= 1;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await dirSize(full, budget);
    } else if (entry.isFile()) {
      const info = await stat(full).catch(() => null);
      if (info) total += info.size;
    }
  }
  return total;
}

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1) + " МБ";
}

/**
 * Один проход уборки. Не трогает живые проекты, архивы в бакете и отметки в базе: только
 * каталоги на диске, для которых проекта нет.
 */
export async function sweepOrphanProjects(options: OrphanSweepOptions = {}): Promise<OrphanSweepResult> {
  const now = options.now ?? Date.now();
  const retentionMs = Math.max(1, options.retentionHours ?? orphanRetentionHours()) * 60 * 60 * 1000;
  const dryRun = options.dryRun ?? process.env.SANDBOX_GC_DRY_RUN === "1";
  const root = options.root ?? sandboxRootDir();
  const result: OrphanSweepResult = { scanned: 0, removed: 0, bytes: 0, skipped: 0, failed: 0, aborted: null };

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    result.aborted = "каталога песочниц нет: " + root;
    return result;
  }

  const ids = await (options.projectIds ?? (async () => new Set((await listProjectOwners()).map(p => p.id))))();
  // Пустой список — это почти всегда сбой чтения хранилища, а не «все проекты удалили».
  // По такому списку уборка снесла бы рабочие каталоги, поэтому проход отменяется целиком.
  if (ids.size === 0) {
    result.aborted = "список проектов пуст — уборку не выполняю";
    return result;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      result.skipped += 1;
      continue;
    }
    const name = entry.name;
    result.scanned += 1;
    if (RESERVED.has(name) || TEMP_PREFIXES.some(prefix => name.startsWith(prefix))) {
      result.skipped += 1;
      continue;
    }
    // Имя не UUID — чужая папка в общем томе. Не наше дело.
    if (!UUID.test(name)) {
      result.skipped += 1;
      continue;
    }
    if (ids.has(name)) {
      result.skipped += 1;
      continue;
    }
    const full = path.join(root, name);
    const info = await stat(full).catch(() => null);
    if (!info) {
      result.failed += 1;
      continue;
    }
    if (now - info.mtimeMs < retentionMs) {
      result.skipped += 1;
      continue;
    }
    if (result.removed >= MAX_REMOVALS_PER_RUN) {
      result.aborted = "достигнут предел " + MAX_REMOVALS_PER_RUN + " удалений за проход";
      break;
    }
    const size = await dirSize(full);
    if (dryRun) {
      console.log(
        "[storage] сирота " + name + " (" + megabytes(size) + "): проекта в базе нет — удалил бы" +
          " (dry-run, SANDBOX_GC_DRY_RUN=1)",
      );
      result.removed += 1;
      result.bytes += size;
      continue;
    }
    try {
      await rm(full, { recursive: true, force: true });
      result.removed += 1;
      result.bytes += size;
      console.log("[storage] удалён каталог без проекта в базе: " + name + " (" + megabytes(size) + ")");
    } catch (error) {
      result.failed += 1;
      console.warn(
        "[storage] каталог " + name + " удалить не удалось: " +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
  return result;
}

export function sandboxGcEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.SANDBOX_GC_ENABLED?.trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

/**
 * Периодический проход по общему диску. Интервал намеренно редкий: каталог-сирота никому не
 * мешает, а лишние обходы по Gluster стоят дороже, чем экономия часа.
 */
export function startOrphanProjectSweeper(): () => void {
  if (!sandboxGcEnabled()) {
    console.log("[storage] уборка каталогов без проекта выключена (SANDBOX_GC_ENABLED=0)");
    return () => undefined;
  }
  const hours = orphanRetentionHours();
  const intervalMs = Math.max(
    MIN_INTERVAL_MS,
    Number(process.env.SANDBOX_GC_INTERVAL_MS ?? DEFAULT_INTERVAL_MS) || DEFAULT_INTERVAL_MS,
  );
  const startDelayMs = Number(process.env.SANDBOX_GC_START_DELAY_MS ?? DEFAULT_START_DELAY_MS) || DEFAULT_START_DELAY_MS;
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      const result = await sweepOrphanProjects({ retentionHours: hours });
      if (result.aborted) {
        if (result.removed > 0) {
          console.log("[storage] уборка каталогов без проекта: " + result.aborted);
        }
        return;
      }
      if (result.removed > 0 || result.failed > 0) {
        console.log(
          "[storage] уборка каталогов без проекта: удалено " + result.removed +
            " (" + megabytes(result.bytes) + "), ошибок " + result.failed +
            ", пропущено " + result.skipped,
        );
      }
    } catch (error) {
      console.warn(
        "[storage] уборка каталогов без проекта упала: " +
          (error instanceof Error ? error.message : String(error)),
      );
    } finally {
      running = false;
    }
  };

  const startupTimer = setTimeout(() => void run(), startDelayMs);
  startupTimer.unref();
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref();
  console.log(
    "[storage] уборка каталогов без проекта: порог " + hours + " ч, проверка раз в " +
      Math.round(intervalMs / 60_000) + " мин",
  );
  return () => {
    clearTimeout(startupTimer);
    clearInterval(timer);
  };
}
