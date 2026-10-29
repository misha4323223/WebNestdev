import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ObjectStore } from "./object-store.js";

// Каталоги задаются до импорта модулей: sandbox/config.ts и storage-quota.ts читают окружение
// один раз при загрузке. Тест идёт в отдельном процессе (node --test), поэтому это безопасно.
const work = await mkdtemp(path.join(tmpdir(), "project-archive-"));
process.env.WEBNESTDEV_DATA_DIR = path.join(work, "data");
process.env.WEBNESTDEV_SANDBOX_DIR = path.join(work, "sandboxes");
process.env.WEBNESTDEV_STORAGE = "json";
delete process.env.PLATFORM_S3_ENDPOINT;
delete process.env.PLATFORM_S3_BUCKET;
delete process.env.PLATFORM_S3_ACCESS_KEY_ID;
delete process.env.PLATFORM_S3_SECRET_ACCESS_KEY;

const { archiveProject, ensureProjectWorkspace, projectArchiveInfo, restoreProject, unsafeArchiveEntry } = await import("./project-archive.js");
const { sandboxRootPath } = await import("../sandbox/config.js");
const { readArchiveRecord } = await import("./project-archive-state.js");

after(async () => {
  await rm(work, { recursive: true, force: true });
});

function memoryStore(): ObjectStore & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  return {
    prefix: "test",
    objects,
    async putFile(key, filePath) {
      const data = await readFile(filePath);
      objects.set(key, data);
      return data.length;
    },
    async getToFile(key, filePath) {
      const data = objects.get(key);
      if (!data) return false;
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, data);
      return true;
    },
    async head(key) {
      const data = objects.get(key);
      return data ? { size: data.length } : null;
    },
    async remove(key) {
      objects.delete(key);
    },
  };
}

async function projectWithFiles() {
  const projectId = randomUUID();
  const root = sandboxRootPath(projectId);
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "uploads"), { recursive: true });
  await writeFile(path.join(root, "src", "index.ts"), "export const answer = 42;\n");
  await writeFile(path.join(root, "uploads", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(path.join(root, "package.json"), "{\"name\":\"demo\"}\n");
  return { projectId, userId: "user-" + projectId, root };
}

test("архив уезжает в хранилище, локальная папка освобождается, квота знает размер", async () => {
  const { projectId, userId, root } = await projectWithFiles();
  const store = memoryStore();

  const result = await archiveProject(projectId, userId, { store });
  assert.equal(result.alreadyArchived, false);
  assert.ok(result.bytes > 0);

  await assert.rejects(() => stat(root), /ENOENT/);
  const record = await readArchiveRecord(projectId);
  assert.equal(record?.key, "test/projects/" + userId + "/" + projectId + "/workspace.tar.gz");
  assert.equal(record?.bytes, result.bytes);
  assert.equal(store.objects.get(record!.key)!.length, result.bytes);

  // Повторная архивация не делает второй объект.
  const again = await archiveProject(projectId, userId, { store });
  assert.equal(again.alreadyArchived, true);
  assert.equal(store.objects.size, 1);
});

test("первое обращение возвращает проект на диск с файлами и очищает отметку", async () => {
  const { projectId, userId, root } = await projectWithFiles();
  const store = memoryStore();
  await archiveProject(projectId, userId, { store });

  const restored = await ensureProjectWorkspace(projectId, userId, { store });
  assert.equal(restored, true);
  assert.equal(await readFile(path.join(root, "src", "index.ts"), "utf8"), "export const answer = 42;\n");
  assert.deepEqual([...await readFile(path.join(root, "uploads", "logo.png"))], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(await readArchiveRecord(projectId), null);
  assert.equal(await projectArchiveInfo(projectId), null);

  // Второй вызов — быстрый путь: архива нет, ничего не происходит.
  assert.equal(await ensureProjectWorkspace(projectId, userId, { store }), false);
  assert.equal(await restoreProject(projectId, userId, { store }), false);

  const entries = await readdir(root);
  assert.ok(entries.includes("src"));
});

test("прерванная операция не теряет проект: живая отметка и остатки папки восстанавливаются", async () => {
  const { projectId, userId, root } = await projectWithFiles();
  const store = memoryStore();
  await archiveProject(projectId, userId, { store });

  // Оборванное удаление после архивации (или оборванная распаковка): на диске остались только
  // node_modules и .git, отметка архива — на месте. Раньше такой каталог считался целой копией,
  // отметка удалялась, и исходники уже никогда не возвращались.
  await mkdir(path.join(root, "node_modules", "dep"), { recursive: true });
  await mkdir(path.join(root, ".git"), { recursive: true });
  await writeFile(path.join(root, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  await writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");

  assert.equal(await ensureProjectWorkspace(projectId, userId, { store }), true);
  assert.equal(await readFile(path.join(root, "src", "index.ts"), "utf8"), "export const answer = 42;\n");
  assert.equal(await readArchiveRecord(projectId), null);
  // Сторожащий каталог распаковки не остаётся рядом с проектом.
  const siblings = await readdir(path.dirname(root));
  assert.deepEqual(siblings.filter(name => name.startsWith(".restore-")), []);
});

test("неудачная распаковка не трогает рабочую папку и оставляет отметку архива", async () => {
  const { projectId, userId, root } = await projectWithFiles();
  const store = memoryStore();
  await archiveProject(projectId, userId, { store });
  // Объект испорчен: tar не сможет его распаковать.
  for (const key of store.objects.keys()) store.objects.set(key, Buffer.from("not a tarball"));

  await assert.rejects(() => ensureProjectWorkspace(projectId, userId, { store }));
  assert.ok(await readArchiveRecord(projectId), "отметка остаётся, чтобы распаковка повторилась");
  assert.deepEqual(
    (await readdir(path.dirname(root))).filter(name => name.startsWith(".restore-")),
    [],
    "сторожащий каталог убран",
  );
});

test("распаковка чужого архива и недопустимые пути отклоняются", async () => {
  assert.equal(unsafeArchiveEntry(["./src/index.ts", "./uploads/logo.png"]), null);
  assert.equal(unsafeArchiveEntry(["/etc/passwd"]), "/etc/passwd");
  assert.equal(unsafeArchiveEntry(["./src/../../etc/passwd"]), "./src/../../etc/passwd");

  const { projectId, userId, root } = await projectWithFiles();
  const store = memoryStore();
  await archiveProject(projectId, userId, { store });
  await assert.rejects(() => restoreProject(projectId, "someone-else", { store }), /Проект не найден/);
  await assert.rejects(() => stat(root), /ENOENT/);
});

test("без настроенного бакета архивация говорит об этом прямо", async () => {
  const { projectId, userId, root } = await projectWithFiles();
  await assert.rejects(() => archiveProject(projectId, userId), /Объектное хранилище не настроено/);
  assert.ok((await stat(root)).isDirectory());
});
