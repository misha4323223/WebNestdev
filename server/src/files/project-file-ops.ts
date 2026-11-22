import path from "node:path";
import { lstat } from "node:fs/promises";
import { isSecretProjectPath } from "../secrets/secret-paths.js";
import { deleteInside, mkdirInside, renameInside, writeFileInside } from "../sandbox/path-guard.js";
import { openDirsForSandbox, openFileForSandbox } from "../sandbox/permissions.js";
import { recordStorageMutation } from "../account/storage-quota.js";
import { refreshStaticPreview } from "../preview/static-preview.js";

/** Ошибка операции с файлом: маршрут отдаёт её текст человеку и нужный HTTP-статус. */
export class ProjectFileError extends Error {
  constructor(message: string, readonly statusCode: 400 | 403 | 404 | 409 = 400) {
    super(message);
    this.name = "ProjectFileError";
  }
}

export const MAX_CREATE_BYTES = 1_000_000;
export const MAX_UPLOAD_BYTES = Number(process.env.WORKSPACE_MAX_UPLOAD_BYTES ?? 1_200_000);
const LOCKED_PATH = /(^|\/)(\.git|node_modules)(\/|$)/;

/**
 * Путь из панели — всегда относительный и внутри проекта. Отдельная проверка нужна до
 * обращения к диску: она ловит `..`, абсолютные пути и служебные папки, а path-guard затем
 * защищает от символических ссылок.
 */
export function normalizeProjectPath(value: string) {
  const normalized = path.posix
    .normalize(value.replaceAll("\\", "/").trim())
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("/") ||
    normalized.startsWith("../") ||
    normalized.includes("\0") ||
    /^[a-z]:/i.test(normalized)
  ) {
    throw new ProjectFileError("Недопустимый путь файла");
  }
  return normalized;
}

/** Служебные папки и секреты закрыты так же, как для редактора и инструментов агента. */
export function assertEditableProjectPath(value: string) {
  const normalized = normalizeProjectPath(value);
  if (LOCKED_PATH.test(normalized)) {
    throw new ProjectFileError("Служебную папку .git или node_modules нельзя менять вручную", 400);
  }
  if (isSecretProjectPath(normalized)) {
    throw new ProjectFileError("Файл содержит секреты проекта: значения меняются в разделе «Секреты»", 403);
  }
  return normalized;
}

/** Имя загружаемого файла: только basename, без переходов по путям. */
function uploadName(value: string) {
  const name = value.replaceAll("\\", "/").split("/").pop()?.trim() ?? "";
  if (!name || name === "." || name === ".." || name.includes("\0")) {
    throw new ProjectFileError("Недопустимое имя файла");
  }
  if (LOCKED_PATH.test(name)) {
    throw new ProjectFileError("Служебную папку .git или node_modules нельзя менять вручную");
  }
  if (isSecretProjectPath(name)) {
    throw new ProjectFileError("Файл содержит секреты проекта: значения меняются в разделе «Секреты»", 403);
  }
  return name;
}

async function entryExists(target: string) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function ensureFree(target: string) {
  if (await entryExists(target)) throw new ProjectFileError("Файл или папка с таким именем уже есть", 409);
}

/** После записи файл должен быть доступен контейнеру, а квота и предпросмотр — обновиться. */
async function settleMutation(root: string, projectId: string, userId: string, target: string, directory: boolean) {
  await openDirsForSandbox(root, directory ? target : path.dirname(target)).catch(error =>
    console.warn("[workspace] не удалось открыть каталог для песочницы", error),
  );
  if (!directory) {
    await openFileForSandbox(target).catch(error =>
      console.warn("[workspace] не удалось открыть файл для песочницы", error),
    );
  }
  await recordStorageMutation(projectId, userId).catch(error =>
    console.warn("[storage] не удалось обновить размер после операции с файлом", error),
  );
  await refreshStaticPreview(projectId).catch(error =>
    console.warn("[preview] предпросмотр не пересобран", error),
  );
}

export async function createProjectEntry(
  root: string,
  projectId: string,
  userId: string,
  input: { path: string; type: "file" | "directory"; content?: string },
) {
  const relative = assertEditableProjectPath(input.path);
  const target = path.join(root, relative);
  await ensureFree(target);
  if (input.type === "directory") {
    const created = await mkdirInside(root, target);
    await settleMutation(root, projectId, userId, created, true);
    return { path: relative, type: "directory" as const };
  }
  const content = input.content ?? "";
  if (Buffer.byteLength(content) > MAX_CREATE_BYTES) {
    throw new ProjectFileError("Файл больше " + Math.round(MAX_CREATE_BYTES / 1000) + " КБ", 400);
  }
  const created = await writeFileInside(root, target, content);
  await settleMutation(root, projectId, userId, created, false);
  return { path: relative, type: "file" as const, bytes: Buffer.byteLength(content) };
}

export async function renameProjectEntry(
  root: string,
  projectId: string,
  userId: string,
  input: { from: string; to: string },
) {
  const from = assertEditableProjectPath(input.from);
  const to = assertEditableProjectPath(input.to);
  if (from === to) return { path: to };
  const source = path.join(root, from);
  if (!(await entryExists(source))) throw new ProjectFileError("Файл или папка не найдены", 404);
  await ensureFree(path.join(root, to));
  await renameInside(root, source, path.join(root, to));
  const info = await lstat(path.join(root, to));
  await settleMutation(root, projectId, userId, path.join(root, to), info.isDirectory());
  return { path: to, type: info.isDirectory() ? "directory" : "file" };
}

export async function deleteProjectEntry(
  root: string,
  projectId: string,
  userId: string,
  value: string,
) {
  const relative = assertEditableProjectPath(value);
  const removed = await deleteInside(root, path.join(root, relative));
  if (!removed) throw new ProjectFileError("Файл или папка не найдены", 404);
  await settleMutation(root, projectId, userId, path.dirname(path.join(root, relative)), true);
  return { path: relative, deleted: true };
}

export async function uploadProjectEntry(
  root: string,
  projectId: string,
  userId: string,
  input: { path: string; name: string; data: string },
) {
  const requestedFolder = (input.path || ".").trim();
  const folder = requestedFolder === "." || !requestedFolder ? "" : assertEditableProjectPath(requestedFolder);
  const name = uploadName(input.name);
  const bytes = Buffer.from(input.data, "base64");
  if (!bytes.length) throw new ProjectFileError("Пустой файл");
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new ProjectFileError("Файл больше " + Math.round(MAX_UPLOAD_BYTES / 1000) + " КБ");
  }
  const relative = folder ? path.posix.join(folder, name) : name;
  const target = path.join(root, relative);
  await ensureFree(target);
  await writeFileInside(root, target, bytes);
  await settleMutation(root, projectId, userId, target, false);
  return { path: relative, name, bytes: bytes.length };
}

/** Файл для скачивания: тот же запрет секретов, но без чтения содержимого в память. */
export async function projectDownloadPath(root: string, value: string) {
  const relative = assertEditableProjectPath(value);
  return { path: path.join(root, relative), relative };
}
