import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearRootOwnedBuildCaches, isSecretEnvFile, openDirsForSandbox, openFileForSandbox, openGitForSandbox, openTreeForSandbox } from "./permissions.js";

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

test("обход дерева не трогает node_modules и .git: это отдельные обходы", async () => {
  await withRoot(async root => {
    const dependency = path.join(root, "node_modules", "left-pad", "index.js");
    const gitHead = path.join(root, ".git", "HEAD");
    await seedFile(dependency);
    await seedFile(gitHead);

    await openTreeForSandbox(root);

    assert.equal(await mode(dependency), "644", "обход зависимостей не нужен и стоит дорого");
    assert.equal(await mode(gitHead), "644", "для .git есть отдельный обход, он вызывается явно");
  });
});

test("каталог .git открывается контейнеру отдельно от дерева проекта", async () => {
  await withRoot(async root => {
    const gitDir = path.join(root, ".git");
    const objects = path.join(gitDir, "objects");
    const fanout = path.join(objects, "ab");
    const head = path.join(gitDir, "HEAD");
    const index = path.join(gitDir, "index");
    const object = path.join(fanout, "cdef");
    await seedFile(head);
    await seedFile(index);
    await seedFile(object);
    await chmod(gitDir, 0o755);
    await chmod(objects, 0o755);
    await chmod(fanout, 0o755);

    assert.equal(await openGitForSandbox(root), true);

    assert.equal(await mode(gitDir), DIR, "без записи в .git git add/commit падает");
    assert.equal(await mode(objects), DIR);
    assert.equal(await mode(fanout), DIR);
    // Файлы не переписываются на 664: достаточно бита записи владельца, а бит x у хуков не теряется.
    for (const file of [head, index, object]) {
      assert.ok(((await stat(file)).mode & 0o200) !== 0, file + " должен быть доступен на запись");
    }
    if (CAN_OWN) assert.equal((await stat(head)).uid, 1000, "репозиторий принадлежит uid контейнера");
  });
});

test("без .git открытие ничего не делает", async () => {
  await withRoot(async root => {
    assert.equal(await openGitForSandbox(root), false);
  });
});

test("кеш Vite, созданный не контейнером, удаляется — Vite пересоздаст его сам", async () => {
  await withRoot(async root => {
    const temp = path.join(root, "node_modules", ".vite-temp");
    await seedFile(path.join(temp, "vite.config.ts.timestamp-1.mjs"));
    const before = await stat(temp);

    const removed = await clearRootOwnedBuildCaches(root);

    if (before.uid === 1000) {
      // Кеш уже контейнера: удалять его незачем, Vite им пользуется.
      assert.equal(removed, 0);
      assert.ok((await stat(temp)).isDirectory());
    } else {
      assert.equal(removed, 1);
      await assert.rejects(stat(temp));
    }
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
