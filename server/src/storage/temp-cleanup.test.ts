import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanupAbandonedTemp } from "./temp-cleanup.js";

const HOUR = 60 * 60_000;

test("стартовая уборка удаляет только старые временные архивы и .restore-*", async () => {
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

    const oldRestore = path.join(sandboxDir, ".restore-project-old");
    await mkdir(oldRestore);
    await writeFile(path.join(oldRestore, "partial.txt"), "partial");
    await utimes(oldRestore, old, old);

    const newRestore = path.join(sandboxDir, ".restore-project-new");
    await mkdir(newRestore);
    await writeFile(path.join(newRestore, "partial.txt"), "partial");

    const liveProject = path.join(sandboxDir, "project-id");
    await mkdir(liveProject);
    await writeFile(path.join(liveProject, "README.md"), "live");
    await utimes(liveProject, old, old);

    const result = await cleanupAbandonedTemp({
      now,
      maxAgeMs: HOUR,
      tempDir,
      sandboxDir,
    });

    assert.deepEqual(result, { files: 1, dirs: 1, bytes: 3, failed: 0 });
    assert.deepEqual((await readdir(tempDir)).sort(), ["archive-new.tar.gz", "notes.txt"]);
    assert.deepEqual((await readdir(sandboxDir)).sort(), [".restore-project-new", "project-id"]);
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
    await mkdir(path.join(sandboxDir, ".restore-project-fresh"));
    await mkdir(path.join(sandboxDir, "project-id"));

    const result = await cleanupAbandonedTemp({ maxAgeMs: 0, tempDir, sandboxDir });

    assert.deepEqual(result, { files: 1, dirs: 1, bytes: 5, failed: 0 });
    assert.deepEqual(await readdir(tempDir), []);
    assert.deepEqual(await readdir(sandboxDir), ["project-id"]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
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
