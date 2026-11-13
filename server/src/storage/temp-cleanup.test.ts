import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanupAbandonedTemp, defaultStorageTempDir } from "./temp-cleanup.js";

const HOUR = 60 * 60_000;

test("стартовая уборка удаляет только старые временные архивы и .restore-* этой реплики", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "wnd-temp-cleanup-"));
  const tempDir = path.join(base, "tmp");
  const sandboxDir = path.join(base, "sandboxes");
  const now = Date.now();
  const old = new Date(now - 2 * HOUR);

  try {
    await mkdir(tempDir, { recursive: true });
    await mkdir(sandboxDir, { recursive: true });

    const oldArchive = path.join(tempDir, "archive-old.tar.gz");
    await writeFile(oldArchive, "old");
    await utimes(oldArchive, old, old);

    const newArchive = path.join(tempDir, "archive-new.tar.gz");
    await writeFile(newArchive, "new");

    const unrelated = path.join(tempDir, "notes.txt");
    await writeFile(unrelated, "keep");
    await utimes(unrelated, old, old);

    const oldRestore = path.join(sandboxDir, ".restore-local-project-old");
    await mkdir(oldRestore);
    await writeFile(path.join(oldRestore, "partial.txt"), "partial");
    await utimes(oldRestore, old, old);

    const newRestore = path.join(sandboxDir, ".restore-local-project-new");
    await mkdir(newRestore);
    await writeFile(path.join(newRestore, "partial.txt"), "partial");

    // Файл другой реплики на том же общем SANDBOX_DIR не принадлежит этой уборке.
    const otherNode = path.join(sandboxDir, ".restore-node-2-project-old");
    await mkdir(otherNode);
    await writeFile(path.join(otherNode, "partial.txt"), "partial");
    await utimes(otherNode, old, old);

    const liveProject = path.join(sandboxDir, "project-id");
    await mkdir(liveProject);
    await writeFile(path.join(liveProject, "README.md"), "live");
    await utimes(liveProject, old, old);

    const result = await cleanupAbandonedTemp({
      now,
      maxAgeMs: HOUR,
      tempDir,
      sandboxDir,
      nodeId: "local",
    });

    assert.deepEqual(result, { files: 1, dirs: 1, bytes: 3, failed: 0 });
    assert.deepEqual((await readdir(tempDir)).sort(), ["archive-new.tar.gz", "notes.txt"]);
    assert.deepEqual(
      (await readdir(sandboxDir)).sort(),
      [".restore-local-project-new", ".restore-node-2-project-old", "project-id"],
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("при maxAgeMs=0 убирает свежий хвост убитого процесса", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "wnd-temp-cleanup-fresh-"));
  const tempDir = path.join(base, "tmp");
  const sandboxDir = path.join(base, "sandboxes");

  try {
    await mkdir(tempDir, { recursive: true });
    await mkdir(sandboxDir, { recursive: true });
    await writeFile(path.join(tempDir, "archive-fresh.tar.gz"), "fresh");
    await mkdir(path.join(sandboxDir, ".restore-local-project-fresh"));
    await mkdir(path.join(sandboxDir, "project-id"));

    // mtime файла может быть на доли миллисекунды позже целого Date.now(); сдвигаем
    // «сейчас» вперёд, чтобы проверка maxAgeMs=0 не зависела от разрешения часов CI.
    const result = await cleanupAbandonedTemp({ maxAgeMs: 0, now: Date.now() + 1_000, tempDir, sandboxDir, nodeId: "local" });

    assert.deepEqual(result, { files: 1, dirs: 1, bytes: 5, failed: 0 });
    assert.deepEqual(await readdir(tempDir), []);
    assert.deepEqual(await readdir(sandboxDir), ["project-id"]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("временные архивы разложены по namespace реплики", () => {
  assert.equal(
    defaultStorageTempDir({ WEBNESTDEV_DATA_DIR: "/data", WEBNESTDEV_NODE_ID: "node-2" }),
    path.join("/data", "tmp", "node-2"),
  );
  assert.equal(
    defaultStorageTempDir({ WEBNESTDEV_DATA_DIR: "/data", WEBNESTDEV_NODE_ID: "../other" }),
    path.join("/data", "tmp", "other"),
  );
});

test("отсутствующие каталоги не мешают старту", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "wnd-temp-cleanup-empty-"));
  try {
    const result = await cleanupAbandonedTemp({
      tempDir: path.join(base, "no-tmp"),
      sandboxDir: path.join(base, "no-sandboxes"),
    });
    assert.deepEqual(result, { files: 0, dirs: 0, bytes: 0, failed: 0 });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
