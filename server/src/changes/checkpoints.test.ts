import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCheckpoint, ignoredPath, initRepo, listCheckpoints, pushBranch, readPushState, restoreCheckpoint } from "./git-repo.js";

async function withRoot(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "webnestdev-changes-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const branch = "main";

test("служебные каталоги и секреты не попадают в историю", () => {
  assert.equal(ignoredPath("node_modules/react/index.js"), true);
  assert.equal(ignoredPath("dist/index.html"), true);
  assert.equal(ignoredPath(".env"), true);
  assert.equal(ignoredPath(".env.local"), true);
  assert.equal(ignoredPath(".env.example"), false);
  assert.equal(ignoredPath("src/App.tsx"), false);
});

test("задача создаёт точку, а повтор без изменений — нет", () => withRoot(async root => {
  await writeFile(path.join(root, "index.html"), "<h1>Мир</h1>");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "app.ts"), "export const answer = 41;\n");
  await mkdir(path.join(root, "node_modules", "left-pad"), { recursive: true });
  await writeFile(path.join(root, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
  await initRepo(root, { branch });

  const first = await createCheckpoint(root, {
    branch,
    subject: "Собрать страницу",
    kind: "task",
    runId: "run-1",
    conversationId: "conversation-1",
  });
  assert.ok(first, "первая точка должна появиться");
  assert.equal(first.filesChanged, 2);
  assert.deepEqual(first.files.map(file => file.path).sort(), ["index.html", "src/app.ts"]);
  assert.equal(first.pushed, false);

  // node_modules не в истории: зависимость не превращается в коммит.
  const listed = await listCheckpoints(root, { branch });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].kind, "task");
  assert.equal(listed[0].runId, "run-1");
  assert.equal(listed[0].conversationId, "conversation-1");
  assert.deepEqual(listed[0].files.map(file => file.path).sort(), ["index.html", "src/app.ts"]);

  assert.equal(await createCheckpoint(root, { branch, subject: "Ничего", kind: "task" }), null);
}));

test("откат возвращает файлы и создаёт коммит отката", () => withRoot(async root => {
  await writeFile(path.join(root, "app.txt"), "версия 1\n");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "page.txt"), "вложенная 1\n");
  await initRepo(root, { branch });
  const first = await createCheckpoint(root, { branch, subject: "Первая версия", kind: "task" });
  assert.ok(first);
  assert.equal(first.filesChanged, 2);

  await writeFile(path.join(root, "app.txt"), "версия 2\n");
  await writeFile(path.join(root, "src", "page.txt"), "вложенная 2\n");
  await writeFile(path.join(root, "new.txt"), "новая страница\n");
  const second = await createCheckpoint(root, { branch, subject: "Вторая версия", kind: "task" });
  assert.ok(second);
  assert.equal(second.filesChanged, 3);

  const rollback = await restoreCheckpoint(root, { sha: first.sha, branch, subject: "Откат к " + first.shortSha });
  assert.equal(rollback.kind, "rollback");
  assert.equal(rollback.revertedTo, first.sha);
  assert.equal(await readFile(path.join(root, "app.txt"), "utf8"), "версия 1\n");
  // Вложенные файлы восстанавливаются так же: история — это дерево, а не список корня.
  assert.equal(await readFile(path.join(root, "src", "page.txt"), "utf8"), "вложенная 1\n");
  // Файл, появившийся после точки, удаляется: иначе проект не равен её состоянию.
  assert.equal(existsSync(path.join(root, "new.txt")), false);

  const listed = await listCheckpoints(root, { branch });
  assert.equal(listed[0].sha, rollback.sha);
  assert.equal(listed[0].kind, "rollback");
  assert.equal(listed[0].revertedTo, first.sha);
  assert.equal(listed[1].sha, second.sha);
  assert.equal(listed[2].sha, first.sha);

  // Повторный откат к тому же состоянию — не новая точка и понятный ответ, а не пустой коммит.
  await assert.rejects(() => restoreCheckpoint(root, { sha: first.sha, branch, subject: "Ещё раз" }), /уже находится/);
}));

test("собственный .gitignore проекта тоже исключает файлы из истории", () => withRoot(async root => {
  await writeFile(path.join(root, ".gitignore"), "*.log\ncache/\n");
  await writeFile(path.join(root, "app.ts"), "export const a = 1;\n");
  await writeFile(path.join(root, "debug.log"), "шум\n");
  await mkdir(path.join(root, "cache"));
  await writeFile(path.join(root, "cache", "dump.bin"), "данные\n");
  await initRepo(root, { branch });

  const point = await createCheckpoint(root, { branch, subject: "Первая задача", kind: "task" });
  assert.ok(point);
  assert.deepEqual(point.files.map(file => file.path).sort(), [".gitignore", "app.ts"]);
}));

test("отправка без подключённого GitHub объясняет причину и сохраняет коммит", () => withRoot(async root => {
  await writeFile(path.join(root, "app.txt"), "версия 1\n");
  await initRepo(root, { branch });
  const point = await createCheckpoint(root, { branch, subject: "Задача", kind: "task" });
  assert.ok(point);

  const outcome = await pushBranch(root, { branch, token: null });
  assert.equal(outcome.pushed, false);
  assert.match(String(outcome.error), /не подключён/);
  // Отказ отправки — это состояние, а не потерянная точка: коммит на месте, причина записана.
  assert.match(String((await readPushState(root))?.lastPushError), /не подключён/);
  assert.equal((await listCheckpoints(root, { branch }))[0].sha, point.sha);
}));

test("ошибка отката на неизвестную точку не портит проект", () => withRoot(async root => {
  await writeFile(path.join(root, "app.txt"), "содержимое\n");
  await initRepo(root, { branch });
  await createCheckpoint(root, { branch, subject: "Первая", kind: "task" });
  await assert.rejects(
    () => restoreCheckpoint(root, { sha: "0123456789012345678901234567890123456789", branch, subject: "Откат" }),
    /не найдена/,
  );
  assert.equal(await readFile(path.join(root, "app.txt"), "utf8"), "содержимое\n");
}));
