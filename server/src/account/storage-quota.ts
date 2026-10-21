import { mkdir, readdir, stat, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { sandboxRootPath } from "../sandbox/config.js";
import { isYdbEnabled, ydbQuery, getTable, withAdvisoryLock } from "../storage/ydb.js";
import { limitsForPlan, type PlanId } from "./plans.js";
import { accountPlanFor } from "../billing/store.js";
import { listProjectOwners, listProjects } from "../project-store.js";
import { readArchiveRecord } from "../storage/project-archive-state.js";

const root = process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");

/**
 * `updatedAt` — когда размер последний раз мерили, `lastWriteAt` — когда в проект последний раз
 * писали. Это разные вещи: ежедневная сверка обновляет первое, но не имеет права сдвигать второе,
 * иначе проект с двухнедельным простоем выглядит «только что изменённым» и в бакет не уезжает.
 * `lastWriteAt` может быть null у строк, созданных до появления поля: читатели берут
 * `lastWriteAt ?? updatedAt`.
 */
type StoredProjectSize = { userId: string; sizeBytes: number; updatedAt: string; lastWriteAt: string | null };
type StorageSize = {
  projectSizes: Record<string, StoredProjectSize>;
  users: Record<string, { usedBytes: number; updatedAt: string }>;
};

/**
 * Состояние квоты для интерфейса. Считается на сервере, а не в каждом экране: иначе настройки,
 * страница подписки и колонка рабочей области показывали бы разные пороги.
 */
export type StorageState = "ok" | "warning" | "full";
export type ProjectStorageInfo = { id: string; name: string; sizeBytes: number; measuredAt: string | null };
export type StorageOverview = {
  usedBytes: number;
  limitBytes: number;
  state: StorageState;
  measuredAt: string | null;
  projects: ProjectStorageInfo[];
};
export type ReconcileResult = {
  ok: boolean;
  reason: string;
  projects: number;
  measured: number;
  skipped: number;
  orphans: number;
  usedBytes: number;
  durationMs: number;
  error?: string;
};

/** Порог предупреждения. 100% — блокировка записи, 80% — заранее видно, что место кончается. */
export const STORAGE_WARN_RATIO = 0.8;

export function storageState(usedBytes: number, limitBytes: number): StorageState {
  if (limitBytes <= 0) return "ok";
  if (usedBytes >= limitBytes) return "full";
  if (usedBytes >= limitBytes * STORAGE_WARN_RATIO) return "warning";
  return "ok";
}

export class StorageLimitError extends Error {
  readonly statusCode = 429;
  constructor(
    readonly usedBytes: number,
    readonly limitBytes: number,
  ) {
    super("Достигнут лимит хранилища");
    this.name = "StorageLimitError";
  }
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    try {
      await unlink(temp);
    } catch {}
    throw error;
  }
}

/**
 * Обход каталога занимает заметное время, а размер пишется по частям. Один проект — одна
 * очередь: замер и запись не должны перемешиваться между агентом и сверкой, иначе более
 * старый замер мог бы затереть более новый.
 */
const projectLocks = new Map<string, Promise<unknown>>();

async function withProjectLock<T>(projectId: string, action: () => Promise<T>): Promise<T> {
  const previous = projectLocks.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const current = previous.then(() => gate);
  projectLocks.set(projectId, current);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (projectLocks.get(projectId) === current) projectLocks.delete(projectId);
  }
}

/** JSON-хранилище — один файл на всех; записи сериализуются, чтобы не потерять проект соседа. */
let jsonWriteQueue: Promise<unknown> = Promise.resolve();

function withJsonWriteLock<T>(action: () => Promise<T>): Promise<T> {
  const next = jsonWriteQueue.then(action, action);
  jsonWriteQueue = next.then(() => undefined, () => undefined);
  return next;
}

async function measureDirSize(dir: string): Promise<number> {
  async function walk(current: string): Promise<number> {
    let total = 0;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        total += await walk(entryPath);
      } else if (entry.isFile()) {
        try {
          const info = await stat(entryPath);
          total += info.size;
        } catch {}
      }
    }
    return total;
  }
  return walk(dir);
}

async function measureProjectSize(projectId: string): Promise<number> {
  const dir = sandboxRootPath(projectId);
  const info = await stat(dir).catch(() => null);
  if (info?.isDirectory()) return measureDirSize(dir);
  // Проект в холодном ярусе: на диске его нет, но место в бакете всё равно занято и входит
  // в квоту аккаунта. Размер берётся из отметки, поставленной при архивации.
  const archived = await readArchiveRecord(projectId).catch(() => null);
  return archived?.bytes ?? 0;
}

async function jsonStorageFile() {
  return path.join(root, "account", "storage-sizes.json");
}

async function readJsonStorage(): Promise<StorageSize> {
  return readJson<StorageSize>(await jsonStorageFile(), { projectSizes: {}, users: {} });
}

async function writeJsonStorage(value: StorageSize) {
  await writeJsonAtomic(await jsonStorageFile(), value);
}

const sizeCache = new Map<string, { at: number; size: number }>();
const sizeCacheTtlMs = 15_000;

/**
 * Размеры проектов. В PostgreSQL это таблица project_sizes, в файловом режиме — один JSON.
 * Читаются без обхода диска: сумма для аккаунта и список проектов должны отвечать быстро.
 */
export async function readProjectSizes(userId?: string): Promise<Map<string, StoredProjectSize>> {
  const sizes = new Map<string, StoredProjectSize>();
  if (isYdbEnabled()) {
    const sql = ydbQuery();
    const table = sql.identifier(getTable("project_sizes"));
    const [rows] = userId
      ? await sql<Array<{ project_id: string; user_id: string; size_bytes: number | string | bigint; updated_at: string; last_write_at: string | null }>>`
          SELECT project_id, user_id, size_bytes, updated_at, last_write_at
          FROM ${table}
          WHERE user_id = ${userId}
        `
      : await sql<Array<{ project_id: string; user_id: string; size_bytes: number | string | bigint; updated_at: string; last_write_at: string | null }>>`
          SELECT project_id, user_id, size_bytes, updated_at, last_write_at
          FROM ${table}
        `;
    for (const row of rows) {
      sizes.set(row.project_id, {
        userId: row.user_id,
        sizeBytes: Number(row.size_bytes),
        updatedAt: row.updated_at,
        lastWriteAt: row.last_write_at ?? null,
      });
    }
    return sizes;
  }
  const data = await readJsonStorage();
  for (const [projectId, item] of Object.entries(data.projectSizes)) {
    if (userId && item.userId !== userId) continue;
    sizes.set(projectId, { ...item, lastWriteAt: item.lastWriteAt ?? null });
  }
  return sizes;
}

async function readProjectSize(projectId: string): Promise<StoredProjectSize | null> {
  if (isYdbEnabled()) {
    const sql = ydbQuery();
    const [rows] = await sql<Array<{ user_id: string; size_bytes: number | string | bigint; updated_at: string; last_write_at: string | null }>>`
      SELECT user_id, size_bytes, updated_at, last_write_at
      FROM ${sql.identifier(getTable("project_sizes"))}
      WHERE project_id = ${projectId}
      LIMIT 1
    `;
    const row = rows[0];
    return row
      ? { userId: row.user_id, sizeBytes: Number(row.size_bytes), updatedAt: row.updated_at, lastWriteAt: row.last_write_at ?? null }
      : null;
  }
  const data = await readJsonStorage();
  const item = data.projectSizes[projectId];
  return item ? { ...item, lastWriteAt: item.lastWriteAt ?? null } : null;
}

async function readUserStorage(userId: string): Promise<{ usedBytes: number; updatedAt: string } | null> {
  if (isYdbEnabled()) {
    const sql = ydbQuery();
    const [rows] = await sql<Array<{ used_bytes: number | string | bigint; updated_at: string }>>`
      SELECT used_bytes, updated_at
      FROM ${sql.identifier(getTable("user_storage"))}
      WHERE user_id = ${userId}
      LIMIT 1
    `;
    const row = rows[0];
    return row ? { usedBytes: Number(row.used_bytes), updatedAt: row.updated_at } : null;
  }
  const data = await readJsonStorage();
  return data.users[userId] ?? null;
}

/**
 * `lastWriteAt` — время последней записи в проект. Вызывающий обязан передать его явно:
 * мутация ставит «сейчас», а замер (сверка, кнопка «Пересчитать») сохраняет прежнее значение,
 * иначе каждый обход диска обнулял бы таймер простоя и холодный ярус никогда бы не сработал.
 */
async function writeProjectSize(
  projectId: string,
  userId: string,
  sizeBytes: number,
  updatedAt: string,
  recomputeUser = true,
  lastWriteAt: string = updatedAt,
) {
  if (isYdbEnabled()) {
    const sql = ydbQuery();
    await sql`
      UPSERT INTO ${sql.identifier(getTable("project_sizes"))} (project_id, user_id, size_bytes, updated_at, last_write_at)
      VALUES (${projectId}, ${userId}, ${sizeBytes}, ${updatedAt}, ${lastWriteAt})
    `;
    if (recomputeUser) await recomputeUserStorage(userId, updatedAt);
    return;
  }
  await withJsonWriteLock(async () => {
    const data = await readJsonStorage();
    data.projectSizes[projectId] = { userId, sizeBytes, updatedAt, lastWriteAt };
    if (recomputeUser) data.users[userId] = { usedBytes: sumUserProjectSizes(data, userId), updatedAt };
    await writeJsonStorage(data);
  });
}

function sumUserProjectSizes(data: StorageSize, userId: string) {
  let total = 0;
  for (const item of Object.values(data.projectSizes)) {
    if (item.userId === userId) total += item.sizeBytes;
  }
  return total;
}

/** Сумма аккаунта пересчитывается из проектов, а не инкрементом: так она не «уплывает» от гонок. */
async function recomputeUserStorage(userId: string, updatedAt: string) {
  if (isYdbEnabled()) {
    const sql = ydbQuery();
    const projectSizes = sql.identifier(getTable("project_sizes"));
    const userStorage = sql.identifier(getTable("user_storage"));
    await sql`
      INSERT INTO ${userStorage} (user_id, used_bytes, updated_at)
      SELECT ${userId}, COALESCE(SUM(size_bytes), 0), ${updatedAt}
      FROM ${projectSizes}
      WHERE user_id = ${userId}
      ON CONFLICT (user_id) DO UPDATE SET used_bytes = EXCLUDED.used_bytes, updated_at = EXCLUDED.updated_at
    `;
    return;
  }
  await withJsonWriteLock(async () => {
    const data = await readJsonStorage();
    const usedBytes = sumUserProjectSizes(data, userId);
    if (usedBytes > 0) data.users[userId] = { usedBytes, updatedAt };
    else delete data.users[userId];
    await writeJsonStorage(data);
  });
}

/** Сумма всех аккаунтов пересчитывается после сверки: удалённые проекты не должны тянуть её вверх. */
async function recomputeAllUserStorage(updatedAt: string) {
  if (isYdbEnabled()) {
    const sql = ydbQuery();
    const projectSizes = sql.identifier(getTable("project_sizes"));
    const userStorage = sql.identifier(getTable("user_storage"));
    await sql`
      INSERT INTO ${userStorage} (user_id, used_bytes, updated_at)
      SELECT user_id, COALESCE(SUM(size_bytes), 0), ${updatedAt}
      FROM ${projectSizes}
      GROUP BY user_id
      ON CONFLICT (user_id) DO UPDATE SET used_bytes = EXCLUDED.used_bytes, updated_at = EXCLUDED.updated_at
    `;
    await sql`
      DELETE FROM ${userStorage}
      WHERE user_id NOT IN (SELECT user_id FROM ${projectSizes})
    `;
    return;
  }
  await withJsonWriteLock(async () => {
    const data = await readJsonStorage();
    const users: StorageSize["users"] = {};
    for (const item of Object.values(data.projectSizes)) {
      users[item.userId] = users[item.userId] ?? { usedBytes: 0, updatedAt };
      users[item.userId].usedBytes += item.sizeBytes;
    }
    data.users = users;
    await writeJsonStorage(data);
  });
}

async function deleteProjectSizes(projectIds: string[]) {
  if (!projectIds.length) return;
  if (isYdbEnabled()) {
    const sql = ydbQuery();
    await sql`DELETE FROM ${sql.identifier(getTable("project_sizes"))} WHERE project_id = ANY(${projectIds})`;
    return;
  }
  await withJsonWriteLock(async () => {
    const data = await readJsonStorage();
    for (const id of projectIds) delete data.projectSizes[id];
    await writeJsonStorage(data);
  });
}

export async function refreshProjectSize(
  projectId: string,
  userId: string,
  options: { force?: boolean } = {},
): Promise<number> {
  return withProjectLock(projectId, async () => {
    const cached = sizeCache.get(projectId);
    if (!options.force && cached && Date.now() - cached.at < sizeCacheTtlMs) {
      return cached.size;
    }
    const sizeBytes = await measureProjectSize(projectId);
    sizeCache.set(projectId, { at: Date.now(), size: sizeBytes });
    await writeProjectSize(projectId, userId, sizeBytes, new Date().toISOString());
    return sizeBytes;
  });
}

export async function getStorageSnapshot(userId: string, plan: PlanId): Promise<{ usedBytes: number; limitBytes: number }> {
  const limitBytes = limitsForPlan(plan).storageBytes ?? 0;
  const stored = await readUserStorage(userId);
  return { usedBytes: stored?.usedBytes ?? 0, limitBytes };
}

/**
 * Что показывает биллинг: сумма, лимит, состояние и разбивка по проектам. Список — только
 * проекты аккаунта: размер чужого проекта не должен попадать даже числом.
 */
export async function getStorageOverview(userId: string, plan: PlanId): Promise<StorageOverview> {
  const limitBytes = limitsForPlan(plan).storageBytes ?? 0;
  const [projects, sizes, stored] = await Promise.all([
    listProjects(userId),
    readProjectSizes(userId),
    readUserStorage(userId),
  ]);
  const items: ProjectStorageInfo[] = projects
    .map(project => ({
      id: project.id,
      name: project.name,
      sizeBytes: sizes.get(project.id)?.sizeBytes ?? 0,
      measuredAt: sizes.get(project.id)?.updatedAt ?? null,
    }))
    .sort((a, b) => b.sizeBytes - a.sizeBytes);
  const measuredAt = stored?.updatedAt ?? items.reduce<string | null>(
    (latest, item) => item.measuredAt && (!latest || item.measuredAt > latest) ? item.measuredAt : latest,
    null,
  );
  const usedBytes = stored?.usedBytes ?? items.reduce((sum, item) => sum + item.sizeBytes, 0);
  return { usedBytes, limitBytes, state: storageState(usedBytes, limitBytes), measuredAt, projects: items };
}

export async function assertWithinStorageLimit(userId: string, plan: PlanId): Promise<void> {
  const { usedBytes, limitBytes } = await getStorageSnapshot(userId, plan);
  if (limitBytes > 0 && usedBytes >= limitBytes) {
    throw new StorageLimitError(usedBytes, limitBytes);
  }
}

/** Проверяет квоту хранилища тарифа аккаунта: подписка расширяет её без перезапуска. */
export async function assertWithinCurrentPlan(userId: string): Promise<void> {
  await assertWithinStorageLimit(userId, await accountPlanFor(userId));
}

/** Records a size change after a mutating tool. Cheap: one dir scan, cached briefly. */
export async function recordStorageMutation(
  projectId: string,
  userId: string,
  options: { heavy?: boolean } = {},
): Promise<void> {
  await refreshProjectSize(projectId, userId, { force: options.heavy });
}

/**
 * Проект удалён: его размер и сумма аккаунта больше не должны существовать. Раньше строка
 * оставалась в таблице навсегда, и пользователь видел занятое место без единого файла.
 */
export async function forgetProjectStorage(projectId: string, userId: string): Promise<void> {
  sizeCache.delete(projectId);
  await deleteProjectSizes([projectId]);
  await recomputeUserStorage(userId, new Date().toISOString());
}

/**
 * Ручной пересчёт хранилища одного аккаунта: кнопка «Пересчитать» в настройках. Меряет все
 * проекты аккаунта, убирает строки удалённых и пересчитывает сумму. Возвращает только счётчики:
 * полный отчёт отдаёт getStorageOverview.
 */
export async function refreshUserStorage(userId: string): Promise<{ projects: number; measured: number }> {
  const projects = await listProjects(userId);
  let measured = 0;
  for (const project of projects) {
    await withProjectLock(project.id, async () => {
      const previous = await readProjectSize(project.id);
      const sizeBytes = await measureProjectSize(project.id);
      sizeCache.set(project.id, { at: Date.now(), size: sizeBytes });
      // «Пересчитать» — это замер, а не запись в проект: таймер простоя не сдвигается.
      await writeProjectSize(
        project.id,
        userId,
        sizeBytes,
        new Date().toISOString(),
        false,
        previous?.lastWriteAt ?? previous?.updatedAt ?? new Date().toISOString(),
      );
      measured++;
    });
  }
  const sizes = await readProjectSizes(userId);
  const alive = new Set(projects.map(project => project.id));
  const orphans = [...sizes.keys()].filter(id => !alive.has(id));
  await deleteProjectSizes(orphans);
  await recomputeUserStorage(userId, new Date().toISOString());
  return { projects: projects.length, measured };
}

const RECONCILE_LOCK = "webnestdev:storage-reconcile";
let jsonReconcileRunning = false;

function lockedResult(reason: string, startedAt: number): ReconcileResult {
  return { ok: false, reason, projects: 0, measured: 0, skipped: 0, orphans: 0, usedBytes: 0, durationMs: Date.now() - startedAt };
}

/**
 * Сверка размеров: обходит проекты, обновляет project_sizes, убирает строки удалённых проектов
 * и пересчитывает суммы аккаунтов одним запросом. Запускается при старте и раз в сутки, но
 * только на одной реплике: в PostgreSQL это advisory-лок, в файловом режиме — флаг процесса.
 *
 * `staleMs` ограничивает работу: проекты, измеренные недавно, пропускаются. Дневная сверка
 * берёт сутки, стартовая — несколько часов, чтобы не сканировать диск после каждого рестарта.
 */
export async function reconcileStorage(options: { reason?: string; staleMs?: number } = {}): Promise<ReconcileResult> {
  const startedAt = Date.now();
  const reason = options.reason ?? "manual";
  if (isYdbEnabled()) {
    const result = await withAdvisoryLock(RECONCILE_LOCK, () => runReconcile(reason, options.staleMs ?? 0, startedAt));
    return result ?? lockedResult("locked", startedAt);
  }
  if (jsonReconcileRunning) return lockedResult("locked", startedAt);
  jsonReconcileRunning = true;
  try {
    return await runReconcile(reason, options.staleMs ?? 0, startedAt);
  } finally {
    jsonReconcileRunning = false;
  }
}

async function runReconcile(reason: string, staleMs: number, startedAt: number): Promise<ReconcileResult> {
  const owners = await listProjectOwners();
  const existing = await readProjectSizes();
  // Пустой список проектов при непустых размерах — это почти наверняка не «все проекты удалили»,
  // а недоступная база или ещё не смонтированный каталог. Удалять по такому ответу нельзя.
  if (!owners.length && existing.size > 0) {
    return {
      ok: false, reason, projects: 0, measured: 0, skipped: 0, orphans: 0,
      usedBytes: 0, durationMs: Date.now() - startedAt, error: "список проектов пуст — сверка пропущена",
    };
  }
  let measured = 0;
  let skipped = 0;
  for (const project of owners) {
    const current = existing.get(project.id);
    if (staleMs > 0 && current && Date.now() - Date.parse(current.updatedAt) < staleMs) {
      skipped++;
      continue;
    }
    const didMeasure = await withProjectLock(project.id, async () => {
      // Замер идёт секунды: если за это время агент записал свежий размер, старый замер его не затрёт.
      const previous = await readProjectSize(project.id);
      const before = previous?.updatedAt ?? current?.updatedAt ?? null;
      const sizeBytes = await measureProjectSize(project.id);
      const after = (await readProjectSize(project.id))?.updatedAt ?? null;
      if (before !== after) return false;
      const measuredAt = new Date().toISOString();
      // Сверка меняет только время замера. Время последней записи остаётся прежним — именно по
      // нему холодный ярус решает, что проект простаивает (раньше сверка сбрасывала его каждый день).
      await writeProjectSize(
        project.id,
        project.userId,
        sizeBytes,
        measuredAt,
        false,
        previous?.lastWriteAt ?? previous?.updatedAt ?? measuredAt,
      );
      return true;
    });
    if (didMeasure) measured++;
    else skipped++;
  }

  const afterSizes = await readProjectSizes();
  const alive = new Set(owners.map(project => project.id));
  const orphans = [...afterSizes.keys()].filter(id => !alive.has(id));
  await deleteProjectSizes(orphans);
  await recomputeAllUserStorage(new Date().toISOString());
  const usedBytes = [...afterSizes.entries()]
    .filter(([id]) => alive.has(id))
    .reduce((sum, [, item]) => sum + item.sizeBytes, 0);
  return {
    ok: true,
    reason,
    projects: owners.length,
    measured,
    skipped,
    orphans: orphans.length,
    usedBytes,
    durationMs: Date.now() - startedAt,
  };
}
