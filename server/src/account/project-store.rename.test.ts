import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { createProject, getProject, renameProject } from "../project-store.js";

const root = process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");

test("renameProject renames a project for its owner only", async () => {
  const userId = "rename-" + randomUUID();
  const project = await createProject("Старое имя", undefined, userId);
  try {
    const renamed = await renameProject(project.id, userId, "  Новое имя  ");
    assert.equal(renamed?.name, "Новое имя");
    assert.ok(renamed && Date.parse(renamed.updatedAt) >= Date.parse(project.updatedAt));
    assert.equal((await getProject(project.id))?.name, "Новое имя");

    // Another account must not be able to rename (or even reach) the project.
    assert.equal(await renameProject(project.id, "another-" + userId, "Чужое имя"), null);
    assert.equal((await getProject(project.id))?.name, "Новое имя");

    // A blank name keeps the current one instead of erasing it.
    assert.equal((await renameProject(project.id, userId, "   "))?.name, "Новое имя");
    assert.equal((await getProject(project.id))?.name, "Новое имя");

    // A missing project is reported as not found.
    assert.equal(await renameProject(randomUUID(), userId, "Нет такого"), null);
  } finally {
    await rm(path.join(root, "projects", project.id + ".json"), { force: true });
  }
});
