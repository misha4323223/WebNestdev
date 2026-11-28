import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { materializeFixture } from "./materialize.js";
import { EVAL_FIXTURES, fixtureProblems, fixtureForRepo, tasksWithFixtures } from "./fixtures/index.js";
import { EVAL_TASKS } from "../tasks.js";

test("фикстуры каталога проходят проверку путей и состава", () => {
  assert.deepEqual(fixtureProblems(), []);
});

test("каждой задаче с фикстурой соответствует существующий репозиторий", () => {
  const tasks = tasksWithFixtures();
  assert.ok(tasks.length >= 8, "ожидается хотя бы восемь задач с фикстурой, сейчас " + tasks.length);
  for (const task of tasks) {
    assert.ok(fixtureForRepo(task.repo), task.id + ": фикстура не найдена");
  }
});

test("фикстура записывается в каталог проекта", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "eval-fixture-"));
  try {
    const written = await materializeFixture(root, EVAL_FIXTURES["landing-basic"]!);
    assert.deepEqual(written, ["app.js", "index.html", "package.json", "scripts/build.mjs", "styles.css"]);
    const html = await readFile(path.join(root, "index.html"), "utf8");
    assert.match(html, /Верста/);
    const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    assert.ok(manifest.scripts?.build, "у фикстуры должна быть команда build");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("путь с .. не выходит за пределы проекта", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "eval-fixture-"));
  try {
    await assert.rejects(
      materializeFixture(root, { files: { "../escape.txt": "x" } }),
      /за пределы|sandbox|проект/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("у каждой живой задачи есть prompt без подсказок по реализации", () => {
  for (const task of EVAL_TASKS.filter(item => fixtureForRepo(item.repo))) {
    assert.ok(task.prompt.trim().length > 20, task.id + ": слишком короткий prompt");
    assert.ok(task.verify.length > 0, task.id + ": нет команд проверки");
  }
});
