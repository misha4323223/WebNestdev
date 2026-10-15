import { mkdir, readdir, stat, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { sandboxRootPath } from "../sandbox/config.js";
import { isYdbEnabled, ydbQuery, getTable } from "../storage/ydb.js";
import { FREE_PLAN, limitsForPlan, type PlanId } from "./plans.js";

const root = process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");

type StorageSize = {
  projectSizes: Record<string, { userId: string; sizeBytes: number; updatedAt: string }>;
  users: Record<string, { usedBytes: number; updatedAt: string }>;
};

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

export async function refreshProjectSize(
  projectId: string,
  userId: string,
  options: { force?: boolean } = {},
): Promise<number> {
  const cached = sizeCache.get(projectId);
  if (!options.force && cached && Date.now() - cached.at < sizeCacheTtlMs) {
    return cached.size;
  }
  const sizeBytes = await measureDirSize(sandboxRootPath(projectId));
  sizeCache.set(projectId, { at: Date.now(), size: sizeBytes });
  const now = new Date().toISOString();
  if (isYdbEnabled()) {
    const sql = ydbQuery();
    const projectSizes = sql.identifier(getTable("project_sizes"));
    const userStorage = sql.identifier(getTable("user_storage"));
    await sql`
      UPSERT INTO ${projectSizes} (project_id, user_id, size_bytes, updated_at)
      VALUES (${projectId}, ${userId}, ${sizeBytes}, ${now})
    `;
    const [rows] = await sql<Array<{ total_bytes: number | string | bigint }>>`
      SELECT COALESCE(SUM(size_bytes), 0) AS total_bytes
      FROM ${projectSizes}
      WHERE user_id = ${userId}
    `;
    const usedBytes = Number(rows[0]?.total_bytes ?? 0);
    await sql`
      UPSERT INTO ${userStorage} (user_id, used_bytes, updated_at)
      VALUES (${userId}, ${usedBytes}, ${now})
    `;
    return sizeBytes;
  }
  const data = await readJsonStorage();
  data.projectSizes[projectId] = { userId, sizeBytes, updatedAt: now };
  let usedBytes = 0;
  for (const item of Object.values(data.projectSizes)) {
    if (item.userId === userId) usedBytes += item.sizeBytes;
  }
  data.users[userId] = { usedBytes, updatedAt: now };
  await writeJsonStorage(data);
  return sizeBytes;
}

export async function getStorageSnapshot(userId: string, plan: PlanId): Promise<{ usedBytes: number; limitBytes: number }> {
  const limitBytes = limitsForPlan(plan).storageBytes ?? 0;
  if (isYdbEnabled()) {
    const sql = ydbQuery();
    const [rows] = await sql<Array<{ used_bytes: number | string | bigint }>>`
      SELECT used_bytes FROM ${sql.identifier(getTable("user_storage"))}
      WHERE user_id = ${userId}
      LIMIT 1
    `;
    const usedBytes = Number(rows[0]?.used_bytes ?? 0);
    return { usedBytes, limitBytes };
  }
  const data = await readJsonStorage();
  const usedBytes = data.users[userId]?.usedBytes ?? 0;
  return { usedBytes, limitBytes };
}

export async function assertWithinStorageLimit(userId: string, plan: PlanId): Promise<void> {
  const { usedBytes, limitBytes } = await getStorageSnapshot(userId, plan);
  if (limitBytes > 0 && usedBytes >= limitBytes) {
    throw new StorageLimitError(usedBytes, limitBytes);
  }
}

/** Asserts the storage quota of the account's plan — the free one while paid plans are not on sale. */
export async function assertWithinCurrentPlan(userId: string): Promise<void> {
  await assertWithinStorageLimit(userId, FREE_PLAN);
}

/** Records a size change after a mutating tool. Cheap: one dir scan, cached briefly. */
export async function recordStorageMutation(
  projectId: string,
  userId: string,
  options: { heavy?: boolean } = {},
): Promise<void> {
  await refreshProjectSize(projectId, userId, { force: options.heavy });
}

export async function reconcileSandboxSizes(): Promise<void> {
  const sandboxDir = path.resolve(process.env.WEBNESTDEV_SANDBOX_DIR ?? ".webnestdev/sandboxes");
  let entries: string[] = [];
  try {
    entries = await readdir(sandboxDir);
  } catch {
    return;
  }
  for (const projectId of entries) {
    // Only refresh if we can determine owner from the project store.
    // We don't import project-store here to avoid circularity.
    // In production, a scheduler can call refreshProjectSize after each mutation;
    // this reconcile is a safety net for JSON mode only.
    if (!isYdbEnabled()) {
      const data = await readJsonStorage();
      const owner = data.projectSizes[projectId]?.userId;
      if (owner) {
        await refreshProjectSize(projectId, owner);
      }
    }
  }
}
