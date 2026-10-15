import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openDirsForSandbox, openFileForSandbox, openTreeForSandbox } from "./permissions.js";

/** Проект пишет сервер от root: каталог 755, файл 644 — именно так выглядит песочница на диске. */
async function seedFile(file: string, mode = 0o644) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "export const value = 1;\n", "utf8");
  await chmod(file, mode);
}

/** Каталоги с закрытыми правами: umask тестового процесса не должен влиять на проверку. */
async function seedDirs(root: string, dir: string) {
  const stop = path.resolve(root);
  await mkdir(dir, { recursive: true });
  for (let current = path.resolve(dir); ; ) {
    await chmod(current, 0o755);
    if (current === stop) return;
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function mode(target: string) {
  return ((await stat(target)).mode & 0o777).toString(8);
}

async function withRoot(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "webnestdev-perms-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("обход дерева открывает подкаталоги и файлы на запись для контейнера", async () => {
  await withRoot(async root => {
    const source = path.join(root, "server", "src", "index.ts");
    await seedFile(source);
    await seedDirs(root, path.join(root, "server", "src"));

    assert.equal(await mode(path.join(root, "server")), "755", "до обхода каталог закрыт");
    assert.equal(await mode(source), "644");

    await openTreeForSandbox(root);

    assert.equal(await mode(path.join(root, "server")), "777");
    assert.equal(await mode(path.join(root, "server", "src")), "777");
    assert.equal(await mode(source), "666", "файл должен перезаписываться из контейнера");
  });
});

test("обход не трогает node_modules и .git: их наполняет сам контейнер", async () => {
  await withRoot(async root => {
    const dependency = path.join(root, "node_modules", "left-pad", "index.js");
    const gitHead = path.join(root, ".git", "HEAD");
    await seedFile(dependency);
    await seedFile(gitHead);

    await openTreeForSandbox(root);

    assert.equal(await mode(dependency), "644", "обход зависимостей не нужен и стоит дорого");
    assert.equal(await mode(gitHead), "644");
  });
});

test("новый файл открывает свой каталог и всех родителей до корня песочницы", async () => {
  await withRoot(async root => {
    const nested = path.join(root, "apps", "web", "pages");
    await seedDirs(root, nested);

    await openDirsForSandbox(root, nested);

    assert.equal(await mode(root), "777");
    assert.equal(await mode(path.join(root, "apps")), "777");
    assert.equal(await mode(path.join(root, "apps", "web")), "777");
    assert.equal(await mode(nested), "777");
  });
});

test("открытие отсутствующего файла не роняет вызов инструмента", async () => {
  await withRoot(async root => {
    await openFileForSandbox(path.join(root, "нет-такого-файла.ts"));
  });
});
