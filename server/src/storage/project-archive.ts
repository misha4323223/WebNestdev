import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { nodeId } from "../nodes/identity.js";
import { sandboxRootPath } from "../sandbox/config.js";
import { recordStorageMutation } from "../account/storage-quota.js";
import { objectStoreConfigFromEnv, projectArchiveKey, s3ObjectStore, type ObjectStore } from "./object-store.js";
import {
  archivedProjectCount as countArchiveRecords,
  clearArchiveRecord,
  readArchiveRecord,
  writeArchiveRecord,
  type ProjectArchiveRecord,
} from "./project-archive-state.js";
import {
  ProjectRestoreFailedError,
  ProjectRestoringError,
  projectRestoreCancelled,
  projectRestoreJob,
  restoreJobActive,
  startRestoreJob,
  type RestoreJob,
} from "./restore-jobs.js";

/**
 * Холодный ярус проектов: рабочая папка уезжает в S3-совместимый бакет и освобождает диск ВМ.
 *
 * Что здесь важно и почему так:
 * - архивируется весь каталог проекта (`tar.gz`), включая `node_modules` и `.git`: распаковка
 *   должна вернуть проект ровно в то состояние, в котором его оставили, а не «исходники без
 *   зависимостей»;
 * - локальная копия удаляется только после того, как хранилище подтвердило размер объекта
 *   (`head`): иначе сбой сети на последнем шаге стоил бы пользователю проекта;
 * - распаковка идёт сначала в сторожащий каталог рядом с песочницами и только целиком заменяет
 *   рабочую папку (`rename`): прерванная распаковка не оставляет полудерево, из которого потом
 *   «пропадают файлы». Список файлов проверяется заранее, потому что архив — данные, а не код;
 * - отметка архива снимается только после успешной замены, а её наличие — единственный признак
 *   «проект в бакете»: непустая папка при живой отметке не считается целой копией;
 * - первое же обращение (`getSandbox`) возвращает проект на диск: панель, агент и предпросмотр
 *   работают с обычной папкой и о холодном ярусе не знают.
 */

const exec = promisify(execFile);
const TAR_TIMEOUT_MS = Number(process.env.PROJECT_ARCHIVE_TAR_TIMEOUT_MS ?? 10 * 60 * 1000);

function dataDir() {
  return process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");
}

/**
 * Имя узла для отметки архива. При нескольких машинах по нему видно, откуда проект уехал в бакет.
 * Источник тот же, что у реестра узлов: `WEBNESTDEV_NODE_ID`, иначе `local`. Так отметка архива
 * и закрепление проекта не расходятся из-за случайного hostname контейнера.
 */
function archiveNodeId() {
  return nodeId();
}

async function tempFile(extension: string) {
  const dir = path.join(dataDir(), "tmp");
  await mkdir(dir, { recursive: true });
  return path.join(dir, "archive-" + randomUUID() + extension);
}

/**
 * Куда распаковывается архив, пока рабочий каталог ещё не тронут. Каталог лежит рядом с
 * песочницами — на той же файловой системе, иначе `rename` был бы копированием, — и начинается
 * с точки, чтобы не выглядеть проектом. Удаляется в `finally` при любом исходе.
 */
function restoreStagingDir(projectId: string) {
  const safe = projectId.replace(/[^A-Za-z0-9_-]/g, "_");
  return path.join(path.dirname(sandboxRootPath(projectId)), ".restore-" + safe + "-" + randomUUID().slice(0, 8));
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

/**
 * Дождаться уже идущей архивации или распаковки этого проекта.
 *
 * С обходом раз в десять минут окно «сверка уже начала упаковку, а пользователь как раз открыл
 * проект» стало реальным: без этой проверки `ensureProjectWorkspace` прочитал бы ещё не созданную
 * отметку и вернул пустой каталог вместо ожидания. Ждём ровно одну операцию — быстрый путь
 * (отметки нет, очередь пуста) остаётся одним чтением файла.
 */
export async function waitForProjectArchive(projectId: string): Promise<void> {
  const pending = locks.get(projectId);
  if (pending) await pending.catch(() => undefined);
}

/**
 * Восстановить отметку, если она потерялась, а проекта на диске уже нет.
 *
 * Это страховка от двух разных потерь: база переехала/восстановилась без строки, а объект в
 * бакете остался; или старый JSON-маркер не доехал. Ключ объекта детерминированный, поэтому
 * достаточно `HEAD` — скачивать архив ради отметки не нужно.
 *
 * Живая папка важнее бакета: если проект есть на диске, старый объект в бакете не повод считать
 * его архивным и удалять рабочую копию. Ошибка хранилища здесь не бросается: отсутствие отметки
 * не должно ронять список проектов, а следующая попытка повторит проверку.
 */
export async function recoverProjectArchiveRecord(
  projectId: string,
  userId: string,
  options: { store?: ObjectStore } = {},
): Promise<ProjectArchiveRecord | null> {
  const existing = await readArchiveRecord(projectId);
  if (existing) return existing;
  const local = await stat(sandboxRootPath(projectId)).catch(() => null);
  if (local?.isDirectory()) return null;
  let store: ObjectStore;
  if (options.store) {
    store = options.store;
  } else {
    let config: ReturnType<typeof objectStoreConfigFromEnv>;
    try {
      config = objectStoreConfigFromEnv();
    } catch (error) {
      console.warn(
        "[storage] проект " + projectId + ": отметка архива потеряна, хранилище настроено не полностью: " +
          (error instanceof Error ? error.message : String(error)),
      );
      return null;
    }
    if (!config) return null;
    store = s3ObjectStore(config);
  }
  const key = projectArchiveKey(store.prefix, userId, projectId);
  const stored = await store.head(key).catch(error => {
    console.warn(
      "[storage] проект " + projectId + ": отметка архива потеряна, HEAD не удался: " +
        (error instanceof Error ? error.message : String(error)),
    );
    return null;
  });
  if (!stored) return null;
  const record: ProjectArchiveRecord = {
    projectId,
    userId,
    key,
    bytes: stored.size,
    archivedAt: new Date().toISOString(),
    node: archiveNodeId(),
  };
  await writeArchiveRecord(record);
  console.log(
    "[storage] проект " + projectId + ": отметка архива восстановлена по объекту в бакете (" + stored.size + " байт)",
  );
  return record;
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

/** Прогресс восстановления: байты объекта, а не распакованного дерева — их видно уже при скачивании. */
export type RestoreProgressHandler = (
  bytesDone: number,
  bytesTotal: number,
  phase: "downloading" | "unpacking",
) => void;

export type RestoreOptions = {
  store?: ObjectStore;
  onProgress?: RestoreProgressHandler;
  /** Отмена: проект удалили, пока архив ехал, — распаковывать его обратно нельзя. */
  shouldAbort?: () => boolean;
};

export async function archiveProject(
  projectId: string,
  userId: string,
  options: { store?: ObjectStore } = {},
): Promise<ArchiveResult> {
  return withArchiveLock(projectId, async () => {
    const existing = await recoverProjectArchiveRecord(projectId, userId, options);
    if (existing) return { archived: true as const, bytes: existing.bytes, key: existing.key, alreadyArchived: true };

    const store = options.store ?? s3ObjectStore();
    const root = sandboxRootPath(projectId);
    const info = await stat(root).catch(() => null);
    if (!info?.isDirectory()) throw new Error("Рабочая папка проекта не найдена — архивировать нечего");

    const started = Date.now();
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
      const record: ProjectArchiveRecord = {
        projectId,
        userId,
        key,
        bytes,
        archivedAt: new Date().toISOString(),
        node: archiveNodeId(),
      };
      await writeArchiveRecord(record);
      await rm(root, { recursive: true, force: true });
      await refreshSize(projectId, userId);
      // Строчный след на проект: агрегата «освобождено N» не хватало, чтобы разобрать инцидент
      // без шелла на ВМ — по этим строкам видно, что и когда уезжало в бакет.
      console.log(
        "[storage] проект " + projectId + ": архивирован в бакет (" + bytes + " байт, " +
        Math.round((Date.now() - started) / 1000) + " с)",
      );
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
  options: RestoreOptions = {},
): Promise<boolean> {
  return withArchiveLock(projectId, async () => {
    const record = await recoverProjectArchiveRecord(projectId, userId, options);
    if (!record) return false;
    if (record.userId !== userId) throw new Error("Проект не найден");
    const store = options.store ?? s3ObjectStore();
    const file = await tempFile(".tar.gz");
    const started = Date.now();
    const total = record.bytes;
    try {
      options.onProgress?.(0, total, "downloading");
      const found = await store.getToFile(record.key, file, {
        onProgress: received => options.onProgress?.(Math.min(received, total), total, "downloading"),
      });
      if (!found) throw new Error("Архив проекта не найден в объектном хранилище");
      // Пока архив ехал, проект могли удалить. Без отметки распаковка вернула бы каталог
      // удалённого проекта на диск и снова записала бы его в квоту.
      if (!(await readArchiveRecord(projectId))) {
        throw new Error("Архив проекта удалён — восстанавливать нечего");
      }
      // Дальше архив читается и распаковывается: байт уже столько же, меняется только фаза,
      // чтобы панель не показывала «100%», пока дерево ещё собирается.
      options.onProgress?.(total, total, "unpacking");
      await assertSafeArchive(file);
      const root = sandboxRootPath(projectId);
      const leftovers = await readdir(root).catch(() => [] as string[]);
      if (leftovers.length) {
        // Живая отметка при непустой папке — это последствие прерванной архивации или
        // распаковки. Архив — источник истины: он распаковывается и заменяет каталог целиком,
        // иначе проект остался бы полупустым навсегда (так и «пропадали файлы»).
        console.log(
          "[storage] проект " + projectId + ": локальная папка не пуста (" + leftovers.length +
          " записей) при живой отметке архива — восстанавливаю поверх",
        );
      }
      const staging = restoreStagingDir(projectId);
      try {
        await mkdir(staging, { recursive: true });
        await exec("tar", ["-xzf", file, "-C", staging, "--no-same-owner"], { timeout: TAR_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
        // Удаление могло прийти и во время распаковки: подменять рабочую папку уже нельзя.
        if (options.shouldAbort?.()) throw new Error("Восстановление отменено: проект удалён");
        // Старая копия убирается только после того, как новая распакована целиком: обрыв на
        // любом шаге оставляет либо прежнюю папку, либо отметку архива — и распаковка повторится.
        await rm(root, { recursive: true, force: true });
        await rename(staging, root);
      } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      }
      await clearArchiveRecord(projectId);
      await refreshSize(projectId, userId);
      console.log(
        "[storage] проект " + projectId + ": восстановлен из архива (" + record.bytes + " байт, " +
        Math.round((Date.now() - started) / 1000) + " с)",
      );
      return true;
    } finally {
      await rm(file, { force: true }).catch(() => undefined);
    }
  });
}

/**
 * Поставить восстановление в фон. Возвращается само задание, а не результат: HTTP-запрос
 * заканчивается сразу, панель спрашивает `projectRestoreJob`/`GET .../archive`.
 *
 * `null` — архива нет, проект уже на диске. Если для проекта уже идёт восстановление, вернётся
 * оно: два параллельных скачивания в один каталог не нужны.
 */
export async function startProjectRestore(
  projectId: string,
  userId: string,
  options: RestoreOptions = {},
): Promise<RestoreJob | null> {
  const running = projectRestoreJob(projectId);
  if (running && restoreJobActive(running)) return running;
  const record = await projectArchiveInfo(projectId, userId, { store: options.store });
  if (!record) return null;
  if (record.userId !== userId) throw new Error("Проект не найден");
  console.log(
    "[storage] проект " + projectId + ": восстановление начато (" + record.bytes + " байт)",
  );
  return startRestoreJob({
    projectId,
    userId,
    bytesTotal: record.bytes,
    run: progress =>
      restoreProject(projectId, userId, {
        ...options,
        onProgress: progress,
        shouldAbort: options.shouldAbort ?? (() => projectRestoreCancelled(projectId)),
      }),
  });
}

/**
 * Вызывается перед каждым доступом к песочнице. Быстрый путь — «отметки нет»: один `readFile`,
 * который сразу падает с ENOENT. Если проект лежит в бакете, распаковка ставится в фон, а
 * вызывающий получает `ProjectRestoringError` (409): держать HTTP-запрос десятки секунд на
 * проекте в 200 МБ — это и есть «сайт завис», от которого уходим.
 *
 * Задание проверяется до ожидания чужой архивации: иначе второй запрос ждал бы не упаковку, а
 * идущее восстановление и снова висел бы до конца скачивания.
 */
export async function ensureProjectWorkspace(
  projectId: string,
  userId: string,
  options: RestoreOptions = {},
): Promise<boolean> {
  const running = projectRestoreJob(projectId);
  if (running && restoreJobActive(running)) throw new ProjectRestoringError(running);
  if (running && running.state === "failed") throw new ProjectRestoreFailedError(running);
  // Упаковка могла начаться за миг до этого запроса: сначала даём ей закончиться — после неё
  // появится отметка, и восстановление начнётся уже из архива.
  await waitForProjectArchive(projectId);
  const job = await startProjectRestore(projectId, userId, options);
  if (!job) return false;
  throw new ProjectRestoringError(job);
}

/**
 * Отметка архива для API и планировщика. Если известен владелец, потерянную отметку можно
 * восстановить по объекту в бакете; без владельца ключ не построить, поэтому остаётся чтение.
 */
export async function projectArchiveInfo(
  projectId: string,
  userId?: string,
  options: { store?: ObjectStore } = {},
): Promise<ProjectArchiveRecord | null> {
  return userId ? recoverProjectArchiveRecord(projectId, userId, options) : readArchiveRecord(projectId);
}

/** Удаление проекта: объект в бакете не должен остаться сиротой и оплачиваться дальше. */
export async function deleteProjectArchive(projectId: string, userId: string): Promise<void> {
  const record = await readArchiveRecord(projectId);
  if (record && record.userId !== userId) return;
  const config = objectStoreConfigFromEnv();
  if (config) {
    const store = s3ObjectStore(config);
    // Ключ детерминированный: объект удаляется, даже если отметка уже потерялась. Иначе после
    // удаления проекта в бакете остался бы оплачиваемый сирота, который никто не найдёт.
    await store.remove(record?.key ?? projectArchiveKey(store.prefix, userId, projectId));
  }
  await clearArchiveRecord(projectId);
}

/** Для `/api/health` и лога: сколько проектов сейчас лежит в бакете. */
export async function archivedProjectCount(): Promise<number> {
  return countArchiveRecords();
}
