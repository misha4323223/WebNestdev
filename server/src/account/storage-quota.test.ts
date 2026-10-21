import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

/**
 * Сверка хранилища проверяется на настоящем каталоге: она и в бою работает с файлами, а не с
 * моками. Данные и песочницы живут во временном каталоге, поэтому тест не касается рабочей
 * установки. Переменные выставляются до импорта: project-store и sandbox/config читают корни
 * один раз при загрузке модуля.
 */
const dataDir = await mkdtemp(path.join(os.tmpdir(), "nestdev-storage-test-"));
const sandboxDir = path.join(dataDir, "sandboxes");
process.env.WEBNESTDEV_DATA_DIR = dataDir;
process.env.WEBNESTDEV_SANDBOX_DIR = sandboxDir;
process.env.WEBNESTDEV_SANDBOX_HOST_DIR = sandboxDir;
process.env.NODE_ENV = "test";
delete process.env.WEBNESTDEV_STORAGE;
delete process.env.DATABASE_URL;

const quota = await import("./storage-quota.js");

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function seedProject(options: { id: string; userId: string; name: string; bytes: number; withDirectory?: boolean }) {
  const now = new Date().toISOString();
  await mkdir(path.join(dataDir, "projects"), { recursive: true });
  await writeFile(
    path.join(dataDir, "projects", options.id + ".json"),
    JSON.stringify({ id: options.id, name: options.name, userId: options.userId, createdAt: now, updatedAt: now }),
  );
  if (options.withDirectory === false) return;
  await mkdir(path.join(sandboxDir, options.id), { recursive: true });
  await writeFile(path.join(sandboxDir, options.id, "index.js"), Buffer.alloc(options.bytes, 65));
}

async function removeProject(id: string) {
  await rm(path.join(dataDir, "projects", id + ".json"), { force: true });
  await rm(path.join(sandboxDir, id), { recursive: true, force: true });
}

test("storage state switches to warning at 80% and to full at 100%", () => {
  assert.equal(quota.storageState(0, 100), "ok");
  assert.equal(quota.storageState(79, 100), "ok");
  assert.equal(quota.storageState(80, 100), "warning");
  assert.equal(quota.storageState(99, 100), "warning");
  assert.equal(quota.storageState(100, 100), "full");
  assert.equal(quota.storageState(500, 100), "full");
  assert.equal(quota.storageState(500, 0), "ok", "нулевой лимит означает «без ограничения»");
});

test("reconcile measures projects, sorts them and removes sizes of deleted projects", async () => {
  const userId = "user-" + randomUUID();
  const first = "project-" + randomUUID();
  const second = "project-" + randomUUID();
  await seedProject({ id: first, userId, name: "Первый", bytes: 1_000 });
  await seedProject({ id: second, userId, name: "Второй", bytes: 3_000 });

  const result = await quota.reconcileStorage({ reason: "test" });
  assert.equal(result.ok, true);

  const overview = await quota.getStorageOverview(userId, "free");
  assert.equal(overview.usedBytes, 4_000);
  assert.deepEqual(overview.projects.map(project => project.name), ["Второй", "Первый"]);
  assert.ok(overview.projects.every(project => project.measuredAt), "у каждого размера есть время замера");
  assert.equal(overview.state, "ok");

  await removeProject(second);
  const afterDelete = await quota.reconcileStorage({ reason: "test" });
  assert.ok(afterDelete.orphans >= 1, "строка удалённого проекта должна исчезнуть");
  const after = await quota.getStorageOverview(userId, "free");
  assert.equal(after.usedBytes, 1_000);
  assert.equal(after.projects.length, 1);
});

test("a project without a sandbox directory counts as zero, not as an error", async () => {
  const userId = "user-" + randomUUID();
  const id = "project-" + randomUUID();
  await seedProject({ id, userId, name: "Пустой", bytes: 0, withDirectory: false });
  const result = await quota.reconcileStorage({ reason: "test" });
  assert.equal(result.ok, true);
  const overview = await quota.getStorageOverview(userId, "free");
  assert.equal(overview.usedBytes, 0);
  assert.equal(overview.projects[0]?.sizeBytes, 0);
});

test("forgetting a project clears its size and the account total", async () => {
  const userId = "user-" + randomUUID();
  const id = "project-" + randomUUID();
  await seedProject({ id, userId, name: "Удаляемый", bytes: 2_000 });
  await quota.refreshProjectSize(id, userId, { force: true });
  assert.equal((await quota.getStorageSnapshot(userId, "free")).usedBytes, 2_000);

  await removeProject(id);
  await quota.forgetProjectStorage(id, userId);
  assert.equal((await quota.getStorageSnapshot(userId, "free")).usedBytes, 0);
  assert.equal((await quota.getStorageOverview(userId, "free")).projects.length, 0);
});

test("manual refresh measures only the account's projects and cleanups deleted rows", async () => {
  const userId = "user-" + randomUUID();
  const kept = "project-" + randomUUID();
  const gone = "project-" + randomUUID();
  await seedProject({ id: kept, userId, name: "Остаётся", bytes: 1_500 });
  await seedProject({ id: gone, userId, name: "Удалён", bytes: 500 });
  await quota.reconcileStorage({ reason: "test" });

  await removeProject(gone);
  const refreshed = await quota.refreshUserStorage(userId);
  assert.equal(refreshed.projects, 1);
  assert.equal(refreshed.measured, 1);
  const overview = await quota.getStorageOverview(userId, "free");
  assert.equal(overview.usedBytes, 1_500);
  assert.deepEqual(overview.projects.map(project => project.name), ["Остаётся"]);
});
