import { constants } from "node:fs";
import type { Dirent } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

/**
 * Пути проекта приходят от агента и от пользователя, а внутри проекта может лежать
 * символическая ссылка на что угодно: `node_modules/.bin`, распакованный архив, сам агент.
 * Лексическая проверка («начинается с корня песочницы») такую ссылку пропускает, а `readFile`
 * и `writeFile` идут по ней к файлу соседнего проекта или к `/etc`. Поэтому каждая операция
 * ниже сначала приводит путь к реальному (без ссылок) и только потом трогает файл; запись
 * дополнительно открывается с `O_NOFOLLOW`, а открытый дескриптор проверяется через
 * `/proc/self/fd`, чтобы подмена ссылки между проверкой и открытием не осталась незамеченной.
 */

const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;

function inside(root: string, candidate: string) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/** Быстрая лексическая проверка: отсекает `..` до любого обращения к диску. */
export function assertInsideSandbox(root: string, candidate: string) {
  const safeRoot = path.resolve(root);
  const target = path.resolve(candidate);
  if (!inside(safeRoot, target)) throw new Error("Путь выходит за пределы песочницы");
  return target;
}

async function statOrNull(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Реальный путь уже существующего объекта. `realpath` раскрывает все ссылки, после чего
 * результат сравнивается с реальным корнем песочницы — ссылка наружу отвергается целиком.
 */
export async function resolveInsideSandbox(root: string, candidate: string) {
  const safeRoot = await realpath(root);
  const lexical = assertInsideSandbox(root, candidate);
  const resolved = await realpath(lexical);
  if (!inside(safeRoot, resolved)) throw new Error("Путь выходит за пределы песочницы");
  return resolved;
}

/**
 * Каталог, в котором можно создавать или удалять файл. Каждый существующий компонент пути
 * проверяется через `lstat`: символическая ссылка отвергается, а не раскрывается. Отсутствующие
 * каталоги создаются по одному (при `create`), поэтому создание файла не может «провалиться»
 * через ссылку, которой ещё нет.
 */
async function safeParent(root: string, candidate: string, create: boolean) {
  const safeRoot = await realpath(root);
  const lexical = assertInsideSandbox(root, candidate);
  let relative = path.relative(path.resolve(root), lexical);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    relative = path.relative(safeRoot, lexical);
  }
  const segments = relative.split(path.sep).filter(segment => segment && segment !== ".");
  const name = segments.pop();
  if (!name || name === "..") throw new Error("Нельзя изменить корень песочницы");

  let current = safeRoot;
  for (const segment of segments) {
    if (segment === "..") throw new Error("Путь выходит за пределы песочницы");
    const next = path.join(current, segment);
    const info = await statOrNull(next);
    if (!info) {
      if (!create) return { dir: next, path: path.join(next, name) };
      try {
        await mkdir(next, { mode: 0o777 });
      } catch (error) {
        // Параллельная запись могла создать тот же каталог; ссылку на его месте не принимаем.
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const raced = await statOrNull(next);
        if (!raced || raced.isSymbolicLink() || !raced.isDirectory()) throw error;
      }
      current = next;
      continue;
    }
    if (info.isSymbolicLink()) throw new Error("Символическая ссылка внутри проекта указывает за его пределы");
    if (!info.isDirectory()) throw new Error("Часть пути не является каталогом");
    current = next;
  }
  return { dir: current, path: path.join(current, name) };
}

/**
 * Открытый файл — это уже не «путь, который можно подменить»: дескриптор смотрит на конкретный
 * inode. На Linux `/proc/self/fd/N` показывает его реальный путь, и проверка закрывает окно
 * между `realpath` и `open`. На других системах такой проверки нет — остаётся O_NOFOLLOW.
 */
async function assertHandleInside(handle: { fd: number }, safeRoot: string) {
  let target: string;
  try {
    target = await realpath("/proc/self/fd/" + handle.fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!inside(safeRoot, target)) throw new Error("Путь выходит за пределы песочницы");
}

export async function assertRegularFile(root: string, candidate: string) {
  const resolved = await resolveInsideSandbox(root, candidate);
  const info = await lstat(resolved);
  if (!info.isFile()) throw new Error("Читать можно только обычные файлы");
  return resolved;
}

/** Текст из файла проекта; символическая ссылка не раскрывается. */
export async function readFileInside(root: string, candidate: string) {
  const safeRoot = await realpath(root);
  const target = await resolveInsideSandbox(root, candidate);
  const handle = await open(target, READ_FLAGS);
  try {
    await assertHandleInside(handle, safeRoot);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

/** Запись файла проекта: родители создаются внутри проверенной цепочки, ссылки отвергаются. */
export async function writeFileInside(root: string, candidate: string, content: string | Uint8Array) {
  const safeRoot = await realpath(root);
  const { path: target } = await safeParent(root, candidate, true);
  const handle = await open(target, WRITE_FLAGS, 0o644);
  try {
    await assertHandleInside(handle, safeRoot);
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
  return target;
}

/** Удаление: сама ссылка удаляется как ссылка, переход по ней не выполняется. */
export async function deleteInside(root: string, candidate: string) {
  const { path: target } = await safeParent(root, candidate, false);
  const info = await statOrNull(target);
  if (!info) return false;
  await rm(target, { recursive: true, force: true });
  return true;
}

/** Переименование: источник и приёмник проверены по компонентам, ссылки не раскрываются. */
export async function renameInside(root: string, from: string, to: string) {
  const source = await safeParent(root, from, false);
  const target = await safeParent(root, to, true);
  const info = await statOrNull(source.path);
  if (!info) throw Object.assign(new Error("Файл или каталог не найден"), { code: "ENOENT" });
  await rename(source.path, target.path);
}

/** Содержимое каталога без символических ссылок: читать их всё равно нельзя. */
export async function listInside(root: string, candidate: string): Promise<Dirent[]> {
  const target = await resolveInsideSandbox(root, candidate);
  const entries = await readdir(target, { withFileTypes: true });
  return entries.filter(entry => !entry.isSymbolicLink());
}
