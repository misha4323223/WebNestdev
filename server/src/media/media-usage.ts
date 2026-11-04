import { lstat } from "node:fs/promises";
import path from "node:path";
import { getSandbox } from "../sandbox-manager.js";
import { listInside, readFileBytesInside } from "../sandbox/path-guard.js";
import { looksBinary } from "../sandbox/binary.js";
import { isSecretProjectPath } from "../secrets/secret-paths.js";
import { IGNORED_PROJECT_DIRS } from "../project-ignore.js";

export type MediaUsageFile = { path: string; line: number };
export type MediaUsage = { count: number; files: MediaUsageFile[] };
export type MediaUsageScan = {
  usage: Map<string, MediaUsage>;
  filesScanned: number;
  truncated: boolean;
};

const MAX_FILES = 4000;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES_PER_URL = 20;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Ищет публичные ссылки на медиа в исходниках проекта. Это не grep по всему диску:
 * зависимости, сборки и секреты пропускаются, а обход ограничен по числу файлов и байтам,
 * чтобы открытие вкладки «Медиа» не превращалось в тяжёлую операцию на большом проекте.
 * Используется для предупреждения перед удалением/переименованием: заменять файл по тому же
 * URL безопасно, а менять URL у используемой картинки — нет.
 */
export async function scanMediaUsage(
  projectId: string,
  userId: string,
  publicBaseUrl: string,
  urls: string[],
): Promise<MediaUsageScan> {
  const sandbox = await getSandbox(projectId, userId);
  return scanMediaUsageInRoot(sandbox.root, publicBaseUrl, urls);
}

/** Отдельная точка входа для тестов и служебных проверок: обход не требует записи проекта. */
export async function scanMediaUsageInRoot(
  root: string,
  publicBaseUrl: string,
  urls: string[],
): Promise<MediaUsageScan> {
  const usage = new Map<string, MediaUsage>();
  for (const url of urls) usage.set(url, { count: 0, files: [] });
  if (!urls.length) return { usage, filesScanned: 0, truncated: false };

  const base = publicBaseUrl.replace(/\/+$/, "");
  // Ключи генерируются из безопасного имени, поэтому в ссылке нет пробелов и кавычек.
  const expression = new RegExp(escapeRegExp(base) + "/[^\\s\"'`<>()\\[\\],;]+", "g");
  const stack: Array<{ absolute: string; relative: string }> = [{ absolute: root, relative: "" }];
  let filesScanned = 0;
  let totalBytes = 0;
  let truncated = false;
  const skipped = { binary: 0, large: 0, secret: 0 };

  while (stack.length && !truncated) {
    const directory = stack.pop() as { absolute: string; relative: string };
    let entries;
    try {
      entries = await listInside(root, directory.absolute);
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = directory.relative ? directory.relative + "/" + entry.name : entry.name;
      if (entry.isDirectory()) {
        if (!IGNORED_PROJECT_DIRS.has(entry.name)) {
          stack.push({ absolute: path.join(directory.absolute, entry.name), relative });
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (isSecretProjectPath(relative)) {
        skipped.secret += 1;
        continue;
      }
      if (filesScanned >= MAX_FILES || totalBytes >= MAX_TOTAL_BYTES) {
        truncated = true;
        break;
      }
      const absolute = path.join(directory.absolute, entry.name);
      const info = await lstat(absolute).catch(() => null);
      if (!info?.isFile()) continue;
      if (info.size > MAX_FILE_BYTES) {
        skipped.large += 1;
        continue;
      }
      if (totalBytes + info.size > MAX_TOTAL_BYTES) {
        truncated = true;
        break;
      }
      let bytes: Buffer;
      try {
        bytes = await readFileBytesInside(root, absolute);
      } catch {
        continue;
      }
      if (looksBinary(bytes)) {
        skipped.binary += 1;
        continue;
      }
      filesScanned += 1;
      totalBytes += bytes.length;
      const lines = bytes.toString("utf8").split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (!line.includes(base + "/")) continue;
        expression.lastIndex = 0;
        for (const match of line.matchAll(expression)) {
          const found = usage.get(match[0]);
          if (!found) continue;
          found.count += 1;
          if (found.files.length < MAX_FILES_PER_URL) found.files.push({ path: relative, line: index + 1 });
        }
      }
    }
  }

  // Бинарные и секретные файлы не могут содержать текстовую ссылку, поэтому они не делают
  // результат неполным. Пропущенный большой текстовый файл — другое дело: там ссылка может
  // быть, и интерфейс должен честно сказать, что проверил не всё.
  if (skipped.large) truncated = true;
  return { usage, filesScanned, truncated };
}
