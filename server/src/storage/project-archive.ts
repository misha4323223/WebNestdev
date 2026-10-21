import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { sandboxRootPath } from "../sandbox/config.js";
import { recordStorageMutation } from "../account/storage-quota.js";
import { objectStoreConfigFromEnv, projectArchiveKey, s3ObjectStore, type ObjectStore } from "./object-store.js";
import { clearArchiveRecord, readArchiveRecord, writeArchiveRecord, type ProjectArchiveRecord } from "./project-archive-state.js";

/**
 * Холодный ярус проектов: рабочая папка уезжает в S3-совместимый бакет и освобождает диск ВМ.
 *
 * Что здесь важно и почему так:
 * - архивируется весь каталог проекта (`tar.gz`), включая `node_modules` и `.git`: распаковка
 *   должна вернуть проект ровно в то состояние, в котором его оставили, а не «исходники без
 *   зависимостей»;
 * - локальная копия удаляется только после того, как хранилище подтвердило размер объекта
 *   (`head`): иначе сбой сети на последнем шаге стоил бы пользователю проекта;
 * - распаковка идёт в тот же каталог и только из нашего объекта; список файлов проверяется
 *   заранее, потому что архив — это данные, а не доверенный код;
 * - первое же обращение (`getSandbox`) возвращает проект на диск: панель, агент и предпросмотр
 *   работают с обычной папкой и о холодном ярусе не знают.
 */

const exec = promisify(execFile);
const TAR_TIMEOUT_MS = Number(process.env.PROJECT_ARCHIVE_TAR_TIMEOUT_MS ?? 10 * 60 * 1000);

function dataDir() {
  return process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");
}

async function tempFile(extension: string) {
  const dir = path.join(dataDir(), "tmp");
  await mkdir(dir, { recursive: true });
  return path.join(dir, "archive-" + randomUUID() + extension);
}

/** Одна архивация на проект: два параллельных запуска писали бы один объект и один маркер. */
const locks = new Map<string, Promise<unknown>>();

/**
 * Когда проект последний раз открывали в этом процессе. Нужен планировщику: счётчик размера
 * обновляется только на запись, а человек может открыть старый проект и просто читать файлы —
 * такой проект архивировать нельзя, хотя по базе он «простаивает» две недели.
 */
const lastAccess = new Map<string, number>();

export function noteProjectAccess(projectId: string, now = Date.now()) {
  lastAccess.set(projectId, now);
}

export function lastProjectAccess(projectId: string): number {
  return lastAccess.get(projectId) ?? 0;
}

async function withArchiveLock<T>(projectId: string, action: () => Promise<T>): Promise<T> {
  const previous = locks.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const current = previous.then(() => gate);
  locks.set(projectId, current);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (locks.get(projectId) === current) locks.delete(projectId);
  }
}

/**
 * Проверка списка файлов архива. Абсолютные пути и `..` — единственный способ, которым архив мог бы
 * записать что-то вне каталога проекта, поэтому такой архив не распаковывается вовсе.
 */
export function unsafeArchiveEntry(entries: string[]): string | null {
  for (const entry of entries) {
    const name = entry.replace(/\r$/, "");
    if (!name) continue;
    if (name.startsWith("/")) return name;
    if (name.split("/").includes("..")) return name;
  }
  return null;
}

async function assertSafeArchive(file: string) {
  const { stdout } = await exec("tar", ["-tzf", file], { timeout: TAR_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 });
  const unsafe = unsafeArchiveEntry(stdout.split("\n"));
  if (unsafe) throw new Error("Архив проекта содержит недопустимый путь: " + unsafe);
}

async function refreshSize(projectId: string, userId: string) {
  // Учёт квоты не должен отменять уже выполненную архивацию: проект на диске отсутствует,
  // поэтому размер берётся из отметки (см. measureProjectSize в storage-quota.ts).
  await recordStorageMutation(projectId, userId, { heavy: true }).catch(error =>
    console.warn("[storage] не удалось обновить размер после архивации: " + (error instanceof Error ? error.message : String(error))),
  );
}

export type ArchiveResult = { archived: true; bytes: number; key: string; alreadyArchived: boolean };

export async function archiveProject(
  projectId: string,
  userId: string,
  options: { store?: ObjectStore } = {},
): Promise<ArchiveResult> {
  return withArchiveLock(projectId, async () => {
    const existing = await readArchiveRecord(projectId);
    if (existing) return { archived: true as const, bytes: existing.bytes, key: existing.key, alreadyArchived: true };

    const store = options.store ?? s3ObjectStore();
    const root = sandboxRootPath(projectId);
    const info = await stat(root).catch(() => null);
    if (!info?.isDirectory()) throw new Error("Рабочая папка проекта не найдена — архивировать нечего");

    const file = await tempFile(".tar.gz");
    try {
      await exec("tar", ["-czf", file, "-C", root, "."], { timeout: TAR_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
      const bytes = (await stat(file)).size;
      if (!bytes) throw new Error("Архив проекта получился пустым");
      const key = projectArchiveKey(store.prefix, userId, projectId);
      await store.putFile(key, file, "application/gzip");
      // Хранилище подтверждает размер: без этого «загрузили» могло означать оборванный поток.
      const stored = await store.head(key);
      if (!stored || stored.size !== bytes) {
        throw new Error("Хранилище приняло архив не целиком (" + (stored?.size ?? 0) + " из " + bytes + " байт)");
      }
      const record: ProjectArchiveRecord = { projectId, userId, key, bytes, archivedAt: new Date().toISOString() };
      await writeArchiveRecord(record);
      await rm(root, { recursive: true, force: true });
      await refreshSize(projectId, userId);
      return { archived: true as const, bytes, key, alreadyArchived: false };
    } finally {
      await rm(file, { force: true }).catch(() => undefined);
    }
  });
}

/**
 * Возвращает проект из бакета на диск. `false` — проект не архивирован, делать ничего не нужно.
 * Ошибка хранилища не маскируется: пусть панель скажет, что проект в облаке и оно недоступно,
 * вместо пустой рабочей папки, в которой «пропали файлы».
 */
export async function restoreProject(
  projectId: string,
  userId: string,
  options: { store?: ObjectStore } = {},
): Promise<boolean> {
  return withArchiveLock(projectId, async () => {
    const record = await readArchiveRecord(projectId);
    if (!record) return false;
    if (record.userId !== userId) throw new Error("Проект не найден");
    const store = options.store ?? s3ObjectStore();
    const file = await tempFile(".tar.gz");
    try {
      const found = await store.getToFile(record.key, file);
      if (!found) throw new Error("Архив проекта не найден в объектном хранилище");
      await assertSafeArchive(file);
      const root = sandboxRootPath(projectId);
      await mkdir(root, { recursive: true });
      await exec("tar", ["-xzf", file, "-C", root, "--no-same-owner"], { timeout: TAR_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
      await clearArchiveRecord(projectId);
      await refreshSize(projectId, userId);
      return true;
    } finally {
      await rm(file, { force: true }).catch(() => undefined);
    }
  });
}

/**
 * Вызывается перед каждым доступом к песочнице. Быстрый путь — «отметки нет»: один `readFile`,
 * который сразу падает с ENOENT. Пустой каталог при наличии отметки — это прерванная распаковка
 * или архивация, поэтому проект восстанавливается, а не считается пустым.
 */
export async function ensureProjectWorkspace(
  projectId: string,
  userId: string,
  options: { store?: ObjectStore } = {},
): Promise<boolean> {
  const record = await readArchiveRecord(projectId);
  if (!record) return false;
  if (record.userId !== userId) throw new Error("Проект не найден");
  const entries = await readdir(sandboxRootPath(projectId)).catch(() => null);
  if (entries && entries.length) {
    // Локальная копия уже есть (например, архив создали, но распаковка шла вручную).
    await clearArchiveRecord(projectId);
    return false;
  }
  return restoreProject(projectId, userId, options);
}

export async function projectArchiveInfo(projectId: string): Promise<ProjectArchiveRecord | null> {
  return readArchiveRecord(projectId);
}

/** Удаление проекта: объект в бакете не должен остаться сиротой и оплачиваться дальше. */
export async function deleteProjectArchive(projectId: string, userId: string): Promise<void> {
  const record = await readArchiveRecord(projectId);
  if (!record) return;
  if (record.userId !== userId) return;
  const config = objectStoreConfigFromEnv();
  if (config) await s3ObjectStore(config).remove(record.key);
  await clearArchiveRecord(projectId);
}

/** Для `/api/health` и лога: сколько проектов сейчас лежит в бакете. */
export async function archivedProjectCount(): Promise<number> {
  const dir = path.join(dataDir(), "project-archives");
  const names = await readdir(dir).catch(() => [] as string[]);
  return names.filter(name => name.endsWith(".json")).length;
}
