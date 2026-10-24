import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { addTasks, readTasks, removeTask, TasksConflictError, toggleTask } from "./task-file.js";

async function project(files: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "nestdev-tasks-"));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(root, name), content);
  }
  return root;
}

test("TASKS.md: создаётся, добавляет задачи без дублей и переживает перечитывание", async () => {
  const root = await project();
  try {
    const empty = await readTasks(root);
    assert.equal(empty.exists, false);
    assert.equal(empty.total, 0);

    const first = await addTasks(root, { items: [{ title: "Проверить вход" }, { title: "Починить меню" }] });
    assert.equal(first.added, 2);
    assert.equal(first.skipped, 0);
    assert.equal(first.total, 2);
    assert.match(await readFile(path.join(root, "TASKS.md"), "utf8"), /^# Задачи проекта/m);

    const duplicate = await addTasks(root, { items: [{ title: "Проверить вход" }, { title: "Новая задача" }] });
    assert.equal(duplicate.added, 1);
    assert.equal(duplicate.skipped, 1);
    assert.equal(duplicate.total, 3);

    const reopened = await readTasks(root);
    assert.deepEqual(reopened.tasks.map(task => task.title), ["Проверить вход", "Починить меню", "Новая задача"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TASKS.md: отметка и удаление меняют только выбранную строку", async () => {
  const root = await project({
    "TASKS.md": [
      "# Задачи проекта",
      "",
      "## Вход",
      "",
      "* [ ] Проверить вход",
      "- [ ] Починить меню",
      "",
      "## Меню",
      "",
      "- [x] Сверить на телефоне",
      "",
    ].join("\n"),
  });
  try {
    const state = await readTasks(root);
    assert.equal(state.total, 3);
    assert.equal(state.done, 1);
    assert.equal(state.tasks[0].section, "Вход");
    assert.equal(state.tasks[2].section, "Меню");

    const toggled = await toggleTask(root, { line: state.tasks[0].line, done: true, revision: state.revision });
    assert.equal(toggled.done, 2);
    assert.match(toggled.markdown, /\* \[x\] Проверить вход/);

    const removed = await removeTask(root, { line: toggled.tasks[1].line, revision: toggled.revision });
    assert.equal(removed.total, 2);
    assert.doesNotMatch(removed.markdown, /Починить меню/);
    assert.match(removed.markdown, /Сверить на телефоне/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TASKS.md: добавляет в существующий раздел и создаёт новый до следующего раздела", async () => {
  const root = await project({
    "TASKS.md": [
      "# Задачи проекта",
      "",
      "Вступительный текст, который нельзя потерять.",
      "",
      "## Вход",
      "",
      "- [ ] Первая",
      "",
      "## Меню",
      "",
      "- [ ] Вторая",
      "",
    ].join("\n"),
  });
  try {
    const before = await readTasks(root);
    const inSection = await addTasks(root, { items: [{ title: "Третья" }], section: "Вход", revision: before.revision });
    assert.equal(inSection.added, 1);
    assert.match(inSection.markdown, /- \[ \] Первая\n- \[ \] Третья\n\n## Меню/);

    const newSection = await addTasks(root, { items: [{ title: "Четвёртая", section: "Оплата" }], revision: inSection.revision });
    assert.equal(newSection.tasks.find(task => task.title === "Четвёртая")?.section, "Оплата");
    assert.match(newSection.markdown, /## Оплата\n\n- \[ \] Четвёртая/);
    assert.match(newSection.markdown, /Вступительный текст/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TASKS.md: код в fence не считается задачей, а вложенность сохраняется", async () => {
  const root = await project({
    "TASKS.md": [
      "# Задачи проекта",
      "",
      "- [ ] Обычная",
      "  - [ ] Вложенная",
      "```md",
      "- [ ] Это пример кода, а не задача",
      "```",
      "",
    ].join("\n"),
  });
  try {
    const state = await readTasks(root);
    assert.equal(state.total, 2);
    assert.equal(state.tasks[1].depth, 1);
    assert.ok(!state.tasks.some(task => task.title.includes("пример кода")));

    const toggled = await toggleTask(root, { line: state.tasks[1].line, done: true, revision: state.revision });
    assert.match(toggled.markdown, /  - \[x\] Вложенная/);
    assert.match(toggled.markdown, /- \[ \] Это пример кода, а не задача/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TASKS.md: удаление последней задачи убирает пустой раздел и лишние пустые строки", async () => {
  const root = await project({
    "TASKS.md": "# Задачи проекта\n\n- [ ] Общая\n\n## Вход\n\n- [ ] Первая\n\n## Меню\n\n- [ ] Вторая\n",
  });
  try {
    let state = await readTasks(root);
    state = await removeTask(root, { line: state.tasks.find(task => task.title === "Первая")!.line, revision: state.revision });
    assert.doesNotMatch(state.markdown, /## Вход/);
    assert.match(state.markdown, /- \[ \] Общая\n\n## Меню\n\n- \[ \] Вторая/);
    assert.ok(!state.markdown.includes("\n\n\n"));

    state = await removeTask(root, { line: state.tasks.find(task => task.title === "Вторая")!.line, revision: state.revision });
    assert.doesNotMatch(state.markdown, /## Меню/);
    assert.equal(state.markdown, "# Задачи проекта\n\n- [ ] Общая\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TASKS.md: устаревшая revision не перезаписывает чужую правку", async () => {
  const root = await project({ "TASKS.md": "# Задачи проекта\n\n- [ ] Первая\n" });
  try {
    const state = await readTasks(root);
    const changed = await addTasks(root, { items: [{ title: "Вторая" }], revision: state.revision });
    assert.equal(changed.added, 1);

    await assert.rejects(
      () => toggleTask(root, { line: state.tasks[0].line, done: true, revision: state.revision }),
      (error: unknown) => error instanceof TasksConflictError && error.state.total === 2,
    );
    assert.match(await readFile(path.join(root, "TASKS.md"), "utf8"), /- \[ \] Первая/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TASKS.md: два одновременных добавления не теряют ни одного пункта", async () => {
  const root = await project();
  try {
    await Promise.all([
      addTasks(root, { items: [{ title: "Из первой вкладки" }] }),
      addTasks(root, { items: [{ title: "Из второй вкладки" }] }),
    ]);
    const state = await readTasks(root);
    assert.deepEqual(state.tasks.map(task => task.title).sort(), ["Из второй вкладки", "Из первой вкладки"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
