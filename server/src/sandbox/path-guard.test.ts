import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  deleteInside,
  listInside,
  readFileInside,
  renameInside,
  resolveInsideSandbox,
  writeFileInside,
} from "./path-guard.js";

async function fixture() {
  const base = await mkdtemp(path.join(tmpdir(), "path-guard-"));
  const root = path.join(base, "project");
  const outside = path.join(base, "outside");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "secret.txt"), "SECRET", "utf8");
  return { base, root, outside };
}

test("readFileInside не раскрывает ссылку на файл вне проекта", async () => {
  const { base, root, outside } = await fixture();
  try {
    await symlink(path.join(outside, "secret.txt"), path.join(root, "leak.txt"));
    await assert.rejects(
      readFileInside(root, path.join(root, "leak.txt")),
      /за пределы песочницы/,
    );
    await assert.rejects(
      resolveInsideSandbox(root, path.join(root, "leak.txt")),
      /за пределы песочницы/,
    );
    assert.equal(await readFile(path.join(outside, "secret.txt"), "utf8"), "SECRET");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("writeFileInside не перезаписывает файл через ссылку", async () => {
  const { base, root, outside } = await fixture();
  try {
    await symlink(path.join(outside, "secret.txt"), path.join(root, "leak.txt"));
    await assert.rejects(
      writeFileInside(root, path.join(root, "leak.txt"), "OVERWRITTEN"),
      /ELOOP|за пределы песочницы/,
    );
    assert.equal(await readFile(path.join(outside, "secret.txt"), "utf8"), "SECRET");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("writeFileInside не создаёт файл через ссылку на каталог", async () => {
  const { base, root, outside } = await fixture();
  try {
    await symlink(outside, path.join(root, "leak-dir"));
    await assert.rejects(
      writeFileInside(root, path.join(root, "leak-dir", "new.txt"), "NEW"),
      /Символическая ссылка/,
    );
    await assert.rejects(stat(path.join(outside, "new.txt")));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("writeFileInside создаёт вложенные каталоги только внутри проекта", async () => {
  const { base, root } = await fixture();
  try {
    const target = await writeFileInside(root, path.join(root, "src", "nested", "file.txt"), "OK");
    assert.equal(await readFile(target, "utf8"), "OK");
    assert.equal(await readFile(path.join(root, "src", "nested", "file.txt"), "utf8"), "OK");
    await assert.rejects(
      writeFileInside(root, path.join(root, "..", "escape.txt"), "NO"),
      /за пределы песочницы/,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("deleteInside удаляет саму ссылку, не трогая её цель", async () => {
  const { base, root, outside } = await fixture();
  try {
    const link = path.join(root, "leak.txt");
    await symlink(path.join(outside, "secret.txt"), link);
    assert.equal(await deleteInside(root, link), true);
    await assert.rejects(stat(link));
    assert.equal(await readFile(path.join(outside, "secret.txt"), "utf8"), "SECRET");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("renameInside не переносит файл через ссылку на каталог", async () => {
  const { base, root, outside } = await fixture();
  try {
    await writeFile(path.join(root, "source.txt"), "SOURCE", "utf8");
    await symlink(outside, path.join(root, "leak-dir"));
    await assert.rejects(
      renameInside(root, path.join(root, "source.txt"), path.join(root, "leak-dir", "moved.txt")),
      /Символическая ссылка/,
    );
    await assert.rejects(stat(path.join(outside, "moved.txt")));
    assert.equal(await readFile(path.join(root, "source.txt"), "utf8"), "SOURCE");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("listInside не показывает ссылки", async () => {
  const { base, root, outside } = await fixture();
  try {
    await writeFile(path.join(root, "real.txt"), "REAL", "utf8");
    await symlink(path.join(outside, "secret.txt"), path.join(root, "leak.txt"));
    const names = (await listInside(root, root)).map(entry => entry.name).sort();
    assert.deepEqual(names, ["real.txt"]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
