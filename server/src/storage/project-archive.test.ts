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

const { archiveProject, ensureProjectWorkspace, projectArchiveInfo, restoreProject, startProjectRestore, unsafeArchiveEntry } = await import("./project-archive.js");
const { sandboxRootPath } = await import("../sandbox/config.js");
const { clearArchiveRecord, readArchiveRecord } = await import("./project-archive-state.js");
const { cancelProjectRestore, projectRestoreJob, restoreJobActive } = await import("./restore-jobs.js");

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
    async getToFile(key, filePath, options) {
      const data = objects.get(key);
      if (!data) return false;
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, data);
      options?.onProgress?.(data.length, data.length);
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

/** Задание восстановления выполняется в фоне: тест ждёт его завершения, а не спит фиксированно. */
async function waitRestore(projectId: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = projectRestoreJob(projectId);
    if (job && !restoreJobActive(job)) return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("восстановление не завершилось за " + timeoutMs + " мс");
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

test("первое обращение запускает восстановление в фоне и возвращает проект на диск", async () => {
  const { projectId, userId, root } = await projectWithFiles();
  const store = memoryStore();
  const archived = await archiveProject(projectId, userId, { store });

  // Запрос больше не держится до конца распаковки: он отдаёт понятный код, а работу делает задание.
  await assert.rejects(
    () => ensureProjectWorkspace(projectId, userId, { store }),
    (error: unknown) => (error as { code?: string }).code === "PROJECT_RESTORING",
  );
  const job = await waitRestore(projectId);
  assert.equal(job.state, "done");
  assert.equal(job.bytesTotal, archived.bytes);
  assert.equal(job.bytesDone, archived.bytes);
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

  await assert.rejects(
    () => ensureProjectWorkspace(projectId, userId, { store }),
    (error: unknown) => (error as { code?: string }).code === "PROJECT_RESTORING",
  );
  assert.equal((await waitRestore(projectId)).state, "done");
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

  await assert.rejects(
    () => ensureProjectWorkspace(projectId, userId, { store }),
    (error: unknown) => (error as { code?: string }).code === "PROJECT_RESTORING",
  );
  const failed = await waitRestore(projectId);
  assert.equal(failed.state, "failed");
  assert.ok(failed.error, "причина записана в задание");
  assert.ok(await readArchiveRecord(projectId), "отметка остаётся, чтобы распаковка повторилась");
  // Пока причина известна, доступ не начинает новое скачивание на каждом запросе.
  await assert.rejects(
    () => ensureProjectWorkspace(projectId, userId, { store }),
    (error: unknown) => (error as { code?: string }).code === "RESTORE_FAILED",
  );
  // Кнопка «Повторить» в панели — это явный новый заход, а не ожидание протухания ошибки.
  const retry = await startProjectRestore(projectId, userId, { store });
  assert.ok(retry);
  assert.notEqual(retry!.id, failed.id);
  assert.equal((await waitRestore(projectId)).state, "failed");
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

test("хранилище не подтвердило размер: локальная папка и отметка не трогаются", async () => {
  const { projectId, userId, root } = await projectWithFiles();
  const store = memoryStore();
  const unconfirmed: ObjectStore = {
    ...store,
    async head() {
      return null;
    },
  };

  await assert.rejects(
    () => archiveProject(projectId, userId, { store: unconfirmed }),
    /приняло архив не целиком/,
  );
  assert.ok((await stat(root)).isDirectory(), "рабочая папка осталась на диске");
  assert.equal(await readArchiveRecord(projectId), null, "отметка архива не появилась");
});

test("потерянная отметка восстанавливается по объекту в бакете", async () => {
  const { projectId, userId, root } = await projectWithFiles();
  const store = memoryStore();
  const archived = await archiveProject(projectId, userId, { store });

  // Так выглядит потеря тома или переезд базы без строки: объекта в бакете есть, отметки нет.
  await clearArchiveRecord(projectId);
  assert.equal(await readArchiveRecord(projectId), null);

  const recovered = await projectArchiveInfo(projectId, userId, { store });
  assert.ok(recovered);
  assert.equal(recovered!.key, "test/projects/" + userId + "/" + projectId + "/workspace.tar.gz");
  assert.equal(recovered!.bytes, archived.bytes);
  assert.deepEqual(await readArchiveRecord(projectId), recovered);

  // Восстановленная отметка возвращает проект на диск тем же путём, что и обычная.
  await assert.rejects(
    () => ensureProjectWorkspace(projectId, userId, { store }),
    (error: unknown) => (error as { code?: string }).code === "PROJECT_RESTORING",
  );
  assert.equal((await waitRestore(projectId)).state, "done");
  assert.equal(await readFile(path.join(root, "src", "index.ts"), "utf8"), "export const answer = 42;\n");
  assert.equal(await readArchiveRecord(projectId), null);
});

test("ensure отвечает сразу, пока архив ещё скачивается", async () => {
  const { projectId, userId, root } = await projectWithFiles();
  const store = memoryStore();
  await archiveProject(projectId, userId, { store });
  // Скачивание держим на воротах: пока они закрыты, запрос обязан уже ответить.
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const slow: ObjectStore = {
    ...store,
    async getToFile(key, filePath, options) {
      await gate;
      return store.getToFile(key, filePath, options);
    },
  };

  const started = Date.now();
  await assert.rejects(
    () => ensureProjectWorkspace(projectId, userId, { store: slow }),
    (error: unknown) => (error as { code?: string }).code === "PROJECT_RESTORING",
  );
  assert.ok(Date.now() - started < 1000, "запрос не ждёт скачивание");
  // Задание действительно идёт, а не потерялось.
  const running = projectRestoreJob(projectId);
  assert.ok(running && restoreJobActive(running), "восстановление в работе");

  release();
  const job = await waitRestore(projectId);
  assert.equal(job.state, "done");
  assert.equal(await readFile(path.join(root, "src", "index.ts"), "utf8"), "export const answer = 42;\n");
  assert.equal(await readArchiveRecord(projectId), null);
});

test("удаление во время скачивания отменяет распаковку", async () => {
  const { projectId, userId, root } = await projectWithFiles();
  const store = memoryStore();
  await archiveProject(projectId, userId, { store });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const slow: ObjectStore = {
    ...store,
    async getToFile(key, filePath, options) {
      await gate;
      return store.getToFile(key, filePath, options);
    },
  };

  assert.ok(await startProjectRestore(projectId, userId, { store: slow }));
  cancelProjectRestore(projectId);
  release();
  const failed = await waitRestore(projectId);
  assert.equal(failed.state, "failed");
  assert.match(failed.error ?? "", /отменено/);
  // Каталог удалённого проекта не вернулся на диск, а отметка осталась: архив не потерян.
  await assert.rejects(() => stat(root), /ENOENT/);
  assert.ok(await readArchiveRecord(projectId));
});

test("живая папка важнее объекта в бакете: проект не считается архивным", async () => {
  const { projectId, userId } = await projectWithFiles();
  const store = memoryStore();
  // Объект с детерминированным ключом существует, но рабочая папка на месте.
  store.objects.set("test/projects/" + userId + "/" + projectId + "/workspace.tar.gz", Buffer.from("старый архив"));

  assert.equal(await projectArchiveInfo(projectId, userId, { store }), null);
  assert.equal(await readArchiveRecord(projectId), null);
});
