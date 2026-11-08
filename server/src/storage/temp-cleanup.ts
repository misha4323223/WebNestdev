import type { Dirent } from "node:fs";
import { readdir, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { sandboxRootDir } from "../sandbox/config.js";

/**
 * Хвосты прерванной архивации и распаковки.
 *
 * Обычная ошибка чистит за собой `finally`: временный `tar.gz` и сторожащий каталог
 * `.restore-*`. Но `SIGKILL`, OOM или внезапный рестарт контейнера не дают выполниться
 * `finally`, и файлы остаются на диске навсегда. Поэтому при старте API, пока этот процесс
 * ещё ничего не распаковывает, вызывающий удаляет эти хвосты.
 *
 * В обычной выкатке воркер встроен в API, и после рестарта других владельцев файлов нет —
 * `maxAgeMs: 0` убирает и хвост только что убитого процесса. Если воркер вынесен
 * (`JOBS_INLINE_WORKER=0`), API оставляет часовой порог: свежая распаковка отдельного
 * процесса не должна быть удалена. Час с запасом больше нормального скачивания проекта.
 */

const DEFAULT_MAX_AGE_MS = 60 * 60_000;
const ARCHIVE_NAME = /^archive-[A-Za-z0-9-]+\.tar\.gz$/;
const RESTORE_PREFIX = ".restore-";

export type TempCleanupResult = {
  files: number;
  dirs: number;
  bytes: number;
  failed: number;
};

export type TempCleanupOptions = {
  now?: number;
  maxAgeMs?: number;
  tempDir?: string;
  sandboxDir?: string;
};

/** Тот же каталог, в который `project-archive.ts` кладёт `archive-*.tar.gz`. */
export function defaultStorageTempDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev"), "tmp");
}

async function removeStale(
  dir: string,
  kind: "file" | "dir",
  matches: (name: string) => boolean,
  cutoff: number,
  result: TempCleanupResult,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    // Каталога ещё нет — убирать нечего. Это не ошибка старта. Отказ доступа — ошибка,
    // но она только попадает в счётчик и лог, а не блокирует подъём сервера.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.failed += 1;
    return;
  }

  for (const entry of entries) {
    if (kind === "file" ? !entry.isFile() : !entry.isDirectory()) continue;
    if (!matches(entry.name)) continue;
    const full = path.join(dir, entry.name);
    let info;
    try {
      info = await stat(full);
    } catch {
      result.failed += 1;
      continue;
    }
    // Свежий файл может принадлежать идущей архивации/распаковке — не трогаем.
    if (info.mtimeMs > cutoff) continue;
    try {
      if (kind === "file") {
        await unlink(full);
        result.files += 1;
        result.bytes += info.size;
      } else {
        await rm(full, { recursive: true, force: true });
        result.dirs += 1;
      }
    } catch {
      result.failed += 1;
    }
  }
}

/**
 * Один проход уборки. Вызывается только при старте API, до `listen` и до воркера.
 * Не трогает рабочие каталоги проектов, S3 и отметки архива в базе.
 */
export async function cleanupAbandonedTemp(
  options: TempCleanupOptions = {},
): Promise<TempCleanupResult> {
  const now = options.now ?? Date.now();
  const maxAgeMs = Math.max(0, options.maxAgeMs ?? DEFAULT_MAX_AGE_MS);
  const cutoff = now - maxAgeMs;
  const result: TempCleanupResult = { files: 0, dirs: 0, bytes: 0, failed: 0 };

  await removeStale(
    options.tempDir ?? defaultStorageTempDir(),
    "file",
    name => ARCHIVE_NAME.test(name),
    cutoff,
    result,
  );
  await removeStale(
    options.sandboxDir ?? sandboxRootDir(),
    "dir",
    name => name.startsWith(RESTORE_PREFIX),
    cutoff,
    result,
  );
  return result;
}
