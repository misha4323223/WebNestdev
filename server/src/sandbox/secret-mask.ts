import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { hostPathFor } from "./config.js";
import { isSecretEnvFile } from "./permissions.js";
import type { SandboxConfig } from "./sandbox-types.js";

/**
 * Маскирование секретных файлов для контейнеров команд.
 *
 * `terminal.exec` — это произвольная оболочка с доступом ко всему `/workspace`, включая
 * `.env.local`. Запретить отдельные команды (`cat`, `grep`, `cp`, `node -e`) нельзя: обойти
 * такой список стоит одной строкой. Поэтому в контейнер, который выполняет команду агента,
 * каждый существующий секретный файл монтируется поверх пустым read-only файлом: путь виден,
 * а значения — нет. Файл на диске при этом не меняется.
 *
 * Маскируются только команды. Предпросмотр получает настоящий файл: приложение должно читать
 * свои ключи. Это разделение и есть граница: агент управляет кодом, но не получает значения.
 */

const MASK_DIR = ".secret-mask";
const MASK_FILE = "empty";
/** Обход ограничен: большой проект не должен превращать каждую команду в полный скан. */
const MAX_DEPTH = 12;
const MAX_SECRET_FILES = 200;
/** Каталоги, которые наполняет контейнер: секретов платформы в них быть не может. */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".output",
  ".cache",
  ".turbo",
  ".vite",
  MASK_DIR,
]);

/**
 * Все секретные env-файлы проекта, относительными путями через `/`.
 *
 * Символические ссылки с секретным именем тоже попадают в список: ссылка `.env.local` на
 * `.env` — это тот же файл с другим именем, и оставлять её незамаскированной нельзя.
 */
export async function findSecretEnvFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(current: string, relative: string, depth: number) {
    if (result.length >= MAX_SECRET_FILES || depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (result.length >= MAX_SECRET_FILES) return;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(
          path.join(current, entry.name),
          relative ? path.posix.join(relative, entry.name) : entry.name,
          depth + 1,
        );
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (!isSecretEnvFile(entry.name)) continue;
      result.push(relative ? path.posix.join(relative, entry.name) : entry.name);
    }
  }
  await walk(root, "", 0);
  return result;
}

/**
 * Docker-аргументы `-v source:target:ro` для каждого секретного файла. Пустой файл лежит вне
 * рабочего каталога проекта, поэтому агент не видит даже его, а Docker монтирует его на место
 * настоящего `.env.local` только внутри контейнера команды.
 */
export async function secretEnvMaskMounts(config: SandboxConfig): Promise<string[]> {
  const files = await findSecretEnvFiles(config.root);
  if (!files.length) return [];

  // Файл-заглушка живёт рядом с каталогом проекта, а не внутри него: иначе она попала бы в
  // `fs.list`, в git и в архив проекта.
  const maskDir = path.join(path.dirname(config.root), MASK_DIR);
  await mkdir(maskDir, { recursive: true });
  const maskFile = path.join(maskDir, MASK_FILE);
  // 0644 — чтобы uid 1000 контейнера мог прочитать пустой файл. Содержимого в нём нет, а
  // каталог `.secret-mask` не монтируется в проект.
  await writeFile(maskFile, "", { mode: 0o644 });
  const source = hostPathFor(maskFile);

  const mounts: string[] = [];
  for (const relative of files) {
    // `-v` разделяет поля двоеточием и запятой: имя с таким символом Docker разберёт как
    // другой mount. Выполнять команду без маски нельзя, поэтому лучше отказать целиком.
    if (relative.includes(":") || relative.includes(",")) {
      throw new Error(
        "Невозможно изолировать секретный файл " +
          relative +
          ": в пути есть `:` или `,`. Переименуйте файл и повторите команду.",
      );
    }
    mounts.push("-v", source + ":/workspace/" + relative + ":ro");
  }
  if (files.length >= MAX_SECRET_FILES) {
    throw new Error(
      "В проекте больше " +
        MAX_SECRET_FILES +
        " файлов окружения — команда не запущена, чтобы ни один из них не остался доступен.",
    );
  }
  return mounts;
}
