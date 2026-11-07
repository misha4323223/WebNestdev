import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Удаление проекта должно убирать не только запись в списке, но и рабочую область целиком:
 * файлы, `.git` с коммитами агента и историю чатов. Иначе повторный импорт того же репозитория
 * мог бы принести чужие правки, а диск остался бы занятым удалённым проектом.
 */
test("удаление проекта стирает песочницу с коммитами и историю чатов", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "webnestdev-delete-"));
  process.env.WEBNESTDEV_STORAGE = "json";
  process.env.WEBNESTDEV_DATA_DIR = path.join(root, "data");
  process.env.WEBNESTDEV_SANDBOX_DIR = path.join(root, "sandboxes");
  process.env.WEBNESTDEV_SANDBOX_HOST_DIR = process.env.WEBNESTDEV_SANDBOX_DIR;
  try {
    const { deleteProject } = await import("./project-store.js");
    const { sandboxRootPath } = await import("./sandbox/config.js");
    const projectId = "project-to-delete";
    const projectRoot = sandboxRootPath(projectId);
    await mkdir(path.join(projectRoot, ".git", "refs", "heads"), { recursive: true });
    await writeFile(path.join(projectRoot, "src.txt"), "правки агента");
    await writeFile(path.join(projectRoot, ".git", "HEAD"), "ref: refs/heads/main");
    await mkdir(path.join(root, "data", "projects"), { recursive: true });
    await mkdir(path.join(root, "data", "conversations"), { recursive: true });
    await writeFile(path.join(root, "data", "projects", projectId + ".json"), JSON.stringify({
      id: projectId,
      name: "Импорт",
      userId: "user-1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    await writeFile(path.join(root, "data", "conversations", "own.json"), JSON.stringify({ id: "own", projectId, messages: [] }));
    await writeFile(path.join(root, "data", "conversations", "other.json"), JSON.stringify({ id: "other", projectId: "other", messages: [] }));

    assert.equal(await deleteProject(projectId, "user-1"), true);
    assert.equal(await stat(projectRoot).catch(() => null), null, "каталог песочницы удалён вместе с .git");
    assert.deepEqual(await readdir(path.join(root, "data", "conversations")), ["other.json"], "удалены только чаты этого проекта");
    assert.equal(await stat(path.join(root, "data", "projects", projectId + ".json")).catch(() => null), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("чужой проект удалить нельзя: его песочница остаётся на месте", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "webnestdev-delete-"));
  process.env.WEBNESTDEV_STORAGE = "json";
  process.env.WEBNESTDEV_DATA_DIR = path.join(root, "data");
  process.env.WEBNESTDEV_SANDBOX_DIR = path.join(root, "sandboxes");
  process.env.WEBNESTDEV_SANDBOX_HOST_DIR = process.env.WEBNESTDEV_SANDBOX_DIR;
  try {
    const { deleteProject } = await import("./project-store.js");
    const { sandboxRootPath } = await import("./sandbox/config.js");
    const projectId = "someone-else";
    const projectRoot = sandboxRootPath(projectId);
    await mkdir(projectRoot, { recursive: true });
    await writeFile(path.join(projectRoot, "keep.txt"), "не трогать");
    await mkdir(path.join(root, "data", "projects"), { recursive: true });
    await writeFile(path.join(root, "data", "projects", projectId + ".json"), JSON.stringify({
      id: projectId,
      name: "Чужой",
      userId: "owner-1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    assert.equal(await deleteProject(projectId, "intruder"), false);
    assert.notEqual(await stat(projectRoot).catch(() => null), null, "песочница чужого проекта не удалена");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
