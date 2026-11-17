import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import { nodeId } from "../nodes/identity.js";
import { sandboxRootPath } from "../sandbox/config.js";
import { getProject } from "../project-store.js";
import { SANDBOX_GID, SANDBOX_UID } from "../sandbox/permissions.js";
import { recordStorageMutation } from "../account/storage-quota.js";
import { ARCHIVE_EXCLUDES } from "./project-archive.js";
import { restoreStagingPrefix, storageTempDir } from "./temp-paths.js";
import { objectStoreConfigFromEnv, projectSnapshotKey, s3ObjectStore, type ObjectStore } from "./object-store.js";
import { getProjectWorkspaceMeta, saveProjectSnapshotMeta } from "./project-workspace-store.js";

const exec = promisify(execFile);
const TAR_TIMEOUT_MS = Number(process.env.PROJECT_SNAPSHOT_TAR_TIMEOUT_MS ?? 10 * 60 * 1000);

export type SnapshotResult = {
  key: string;
  bytes: number;
  sha256: string;
  createdAt: string;
};

export type SnapshotOptions = {
  store?: ObjectStore;
};

export type SnapshotRestoreOptions = SnapshotOptions & {
  shouldAbort?: () => boolean;
};

function safeId(projectId: string) {
  return projectId.replace(/[^A-Za-z0-9_-]/g, "_");
}

async function tempFile(suffix: string) {
  const dir = storageTempDir();
  await mkdir(dir, { recursive: true });
  return path.join(dir, "snapshot-" + randomUUID() + suffix);
}

async function sha256File(file: string) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

async function assertSafeArchive(file: string) {
  const { stdout } = await exec("tar", ["-tzf", file], { timeout: TAR_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 });
  for (const raw of stdout.split("\n")) {
    const name = raw.replace(/\r$/, "");
    if (!name) continue;
    if (name.startsWith("/") || name.split("/").includes("..")) {
      throw new Error("Snapshot содержит недопустимый путь: " + name);
    }
  }
}

function storeFor(options: SnapshotOptions): ObjectStore {
  if (options.store) return options.store;
  const config = objectStoreConfigFromEnv();
  if (!config) throw new Error("Горячий snapshot требует настроенное объектное хранилище PLATFORM_S3_*");
  return s3ObjectStore(config);
}

/** Один snapshot на проект в процессе: две упаковки одного каталога одновременно не нужны. */
const locks = new Map<string, Promise<unknown>>();
async function withLock<T>(projectId: string, action: () => Promise<T>): Promise<T> {
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
 * Снять snapshot, не удаляя рабочую папку. Это принципиальное отличие от `archiveProject()`:
 * холодный архив — переезд в бакет, snapshot — страховка для миграции и failover.
 */
export async function snapshotProject(
  projectId: string,
  userId: string,
  options: SnapshotOptions = {},
): Promise<SnapshotResult> {
  return withLock(projectId, async () => {
    const project = await getProject(projectId);
    if (!project || project.userId !== userId) throw new Error("Проект не найден");
    const root = sandboxRootPath(projectId);
    const info = await stat(root).catch(() => null);
    if (!info?.isDirectory()) throw new Error("Рабочая папка проекта не найдена — snapshot невозможен");

    const store = storeFor(options);
    const previousKey = (await getProjectWorkspaceMeta(projectId))?.snapshotKey ?? "";
    const file = await tempFile(".tar.gz");
    try {
      await exec(
        "tar",
        ["-czf", file, "-C", root, ...ARCHIVE_EXCLUDES.map(pattern => "--exclude=" + pattern), "."],
        { timeout: TAR_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      );
      const bytes = (await stat(file)).size;
      if (!bytes) throw new Error("Snapshot проекта получился пустым");
      const sha256 = await sha256File(file);
      const createdAt = new Date().toISOString();
      const key = projectSnapshotKey(store.prefix, userId, projectId, createdAt, sha256);
      await store.putFile(key, file, "application/gzip");
      const stored = await store.head(key);
      if (!stored || stored.size !== bytes) {
        throw new Error("Хранилище приняло snapshot не целиком: " + (stored?.size ?? 0) + " из " + bytes);
      }

      const manifest = {
        projectId,
        userId,
        node: nodeId(),
        workspaceEpoch: Math.max(0, Math.trunc(project.workspaceEpoch ?? 0)),
        createdAt,
        bytes,
        sha256,
        excludes: [...ARCHIVE_EXCLUDES],
      };
      const manifestFile = await tempFile(".json");
      try {
        await writeFile(manifestFile, JSON.stringify(manifest, null, 2), { mode: 0o600 });
        await store.putFile(key + ".json", manifestFile, "application/json");
      } finally {
        await rm(manifestFile, { force: true }).catch(() => undefined);
      }
      await saveProjectSnapshotMeta(projectId, { key, at: createdAt, bytes });
      if (previousKey && previousKey !== key) {
        // Держим один горячий snapshot на проект: иначе каждый проход планировщика оставлял бы
        // в бакете оплачиваемый tar, который никто никогда не удалит.
        await store.remove(previousKey).catch(() => undefined);
        await store.remove(previousKey + ".json").catch(() => undefined);
      }
      await recordStorageMutation(projectId, userId, { heavy: true }).catch(() => undefined);
      console.log("[storage] проект " + projectId + ": snapshot создан (" + bytes + " байт, " + sha256.slice(0, 12) + ")");
      return { key, bytes, sha256, createdAt };
    } finally {
      await rm(file, { force: true }).catch(() => undefined);
    }
  });
}

/** Удаление snapshot вместе с проектом: без этого в бакете остаётся оплачиваемый сирота. */
export async function deleteProjectSnapshot(projectId: string, key: string): Promise<void> {
  if (!key) return;
  const store = storeFor({});
  await store.remove(key);
  await store.remove(key + ".json").catch(() => undefined);
}

/**
 * Восстановить последний snapshot на текущую ноду. Рабочая папка заменяется только целиком:
 * распаковка идёт в staging рядом с ней, старая копия откладывается как `.project-backup-*`.
 */
export async function restoreProjectSnapshot(
  projectId: string,
  userId: string,
  options: SnapshotRestoreOptions = {},
): Promise<SnapshotResult> {
  return withLock(projectId, async () => {
    const project = await getProject(projectId);
    if (!project || project.userId !== userId) throw new Error("Проект не найден");
    const meta = await getProjectWorkspaceMeta(projectId);
    if (!meta?.snapshotKey) throw new Error("У проекта нет snapshot для восстановления");
    const store = storeFor(options);
    const file = await tempFile(".tar.gz");
    try {
      const found = await store.getToFile(meta.snapshotKey, file);
      if (!found) throw new Error("Snapshot не найден в объектном хранилище");
      const sha256 = await sha256File(file);
      const expected = meta.snapshotKey.endsWith(".tar.gz")
        ? path.basename(meta.snapshotKey).split("-").at(-1)?.replace(".tar.gz", "") ?? ""
        : "";
      if (expected && !sha256.startsWith(expected)) {
        throw new Error("Контрольная сумма snapshot не совпала");
      }
      await assertSafeArchive(file);
      if (options.shouldAbort?.()) throw new Error("Восстановление snapshot отменено");

      const root = sandboxRootPath(projectId);
      const staging = path.join(
        path.dirname(root),
        restoreStagingPrefix() + safeId(projectId) + "-" + randomUUID().slice(0, 8),
      );
      const backup = path.join(path.dirname(root), ".project-backup-" + safeId(projectId));
      try {
        await mkdir(staging, { recursive: true });
        const ownership = process.getuid?.() === 0
          ? ["--owner=" + SANDBOX_UID, "--group=" + SANDBOX_GID]
          : [];
        await exec(
          "tar",
          ["-xzf", file, "-C", staging, "--no-same-owner", ...ownership],
          { timeout: TAR_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
        );
        const leftovers = await readdir(root).catch(() => [] as string[]);
        if (leftovers.length) {
          await rm(backup, { recursive: true, force: true }).catch(() => undefined);
          await rename(root, backup).catch(error => {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          });
        } else {
          await rm(root, { recursive: true, force: true });
        }
        await rename(staging, root);
      } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      }
      await recordStorageMutation(projectId, userId, { heavy: true }).catch(() => undefined);
      console.log("[storage] проект " + projectId + ": восстановлен из snapshot " + meta.snapshotKey);
      return { key: meta.snapshotKey, bytes: meta.workspaceBytes, sha256, createdAt: meta.snapshotAt ?? "" };
    } finally {
      await rm(file, { force: true }).catch(() => undefined);
    }
  });
}
