import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isSecretEnvFile, openDirsForSandbox, openFileForSandbox, openTreeForSandbox } from "./permissions.js";

/**
 * Владельца можно сменить только от root. Локально и в CI сервер запущен обычным
 * пользователем, и тогда права остаются прежними (777/666), иначе контейнер не смог бы писать.
 */
const CAN_OWN = process.getuid?.() === 0;
const DIR = CAN_OWN ? "775" : "777";
const FILE = CAN_OWN ? "664" : "666";
const SECRET = CAN_OWN ? "600" : "644";

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

    assert.equal(await mode(path.join(root, "server")), DIR);
    assert.equal(await mode(path.join(root, "server", "src")), DIR);
    assert.equal(await mode(source), FILE, "файл должен перезаписываться из контейнера");
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

    assert.equal(await mode(root), DIR);
    assert.equal(await mode(path.join(root, "apps")), DIR);
    assert.equal(await mode(path.join(root, "apps", "web")), DIR);
    assert.equal(await mode(nested), DIR);
  });
});

test("открытие отсутствующего файла не роняет вызов инструмента", async () => {
  await withRoot(async root => {
    await openFileForSandbox(path.join(root, "нет-такого-файла.ts"));
  });
});

test("файлы окружения закрыты, шаблоны — обычные файлы", () => {
  for (const name of [".env", ".env.local", ".env.production.local"]) {
    assert.equal(isSecretEnvFile(name), true, name);
  }
  for (const name of [".env.example", ".env.sample", ".env.template", ".envrc", "env.local"]) {
    assert.equal(isSecretEnvFile(name), false, name);
  }
});

test("права .env не открываются для остальных пользователей хоста", async () => {
  await withRoot(async root => {
    const secret = path.join(root, ".env.local");
    const example = path.join(root, ".env.example");
    await seedFile(secret);
    await seedFile(example);

    await openFileForSandbox(secret);
    await openFileForSandbox(example);

    assert.equal(await mode(secret), SECRET, "ключи не должны быть доступны на запись/чтение всем");
    assert.equal(await mode(example), FILE, "шаблон без секретов остаётся обычным файлом");
    if (CAN_OWN) assert.equal((await stat(secret)).uid, 1000, "контейнер читает файл как владелец");
  });
});

test("chmod не идёт по символической ссылке и не меняет чужой файл", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "webnestdev-perms-link-"));
  const root = path.join(base, "project");
  try {
    await mkdir(root, { recursive: true });
    const target = path.join(base, "victim.txt");
    await writeFile(target, "VICTIM", "utf8");
    await chmod(target, 0o640);
    const link = path.join(root, "leak.txt");
    await symlink(target, link);

    await openFileForSandbox(link);

    assert.equal((await lstat(target)).mode & 0o777, 0o640, "цель ссылки не должна меняться");
    assert.equal((await lstat(link)).isSymbolicLink(), true, "ссылка остаётся ссылкой");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("обход дерева не заходит в символические ссылки", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "webnestdev-perms-tree-"));
  const root = path.join(base, "project");
  try {
    await mkdir(root, { recursive: true });
    const outside = path.join(base, "outside");
    const nested = path.join(outside, "nested");
    await mkdir(nested, { recursive: true });
    const file = path.join(nested, "file.txt");
    await writeFile(file, "OUTSIDE", "utf8");
    await chmod(nested, 0o700);
    await chmod(file, 0o600);
    await symlink(outside, path.join(root, "leak-dir"));

    await openTreeForSandbox(root);

    assert.equal(await mode(nested), "700");
    assert.equal(await mode(file), "600");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
