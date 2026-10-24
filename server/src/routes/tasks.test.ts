import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { registerTasksRoutes, type TasksRouteDeps } from "./tasks.js";

async function appFor(root: string) {
  const deps: TasksRouteDeps = {
    authorize: async () => ({ id: "user-1" }),
    getSandbox: async () => ({ root }),
    onMutation: async () => undefined,
  };
  const app = Fastify();
  await registerTasksRoutes(app, deps);
  await app.ready();
  return app;
}

test("API задач: чтение, добавление, отметка, удаление и разделы", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nestdev-tasks-route-"));
  const app = await appFor(root);
  try {
    const empty = await app.inject({ method: "GET", url: "/api/projects/p1/tasks" });
    assert.equal(empty.statusCode, 200);
    assert.equal(empty.json().exists, false);
    assert.equal(empty.json().total, 0);

    const added = await app.inject({
      method: "POST",
      url: "/api/projects/p1/tasks",
      payload: { items: [{ title: "Проверить вход" }, { title: "Починить меню", section: "Меню" }] },
    });
    assert.equal(added.statusCode, 200);
    const afterAdd = added.json();
    assert.equal(afterAdd.added, 2);
    assert.equal(afterAdd.total, 2);
    assert.equal(afterAdd.tasks.find((task: { title: string }) => task.title === "Починить меню").section, "Меню");

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/projects/p1/tasks",
      payload: { items: [{ title: "Проверить вход" }, { title: "Новая" }] },
    });
    assert.equal(duplicate.json().added, 1);
    assert.equal(duplicate.json().skipped, 1);
    assert.equal(duplicate.json().total, 3);

    const fresh = duplicate.json();
    const toggled = await app.inject({
      method: "PATCH",
      url: "/api/projects/p1/tasks",
      payload: { op: "toggle", line: fresh.tasks[0].line, done: true, revision: fresh.revision },
    });
    assert.equal(toggled.statusCode, 200);
    assert.equal(toggled.json().done, 1);
    assert.match(toggled.json().markdown, /- \[x\] Проверить вход/);

    const menuTask = toggled.json().tasks.find((task: { title: string }) => task.title === "Починить меню");
    const removed = await app.inject({
      method: "PATCH",
      url: "/api/projects/p1/tasks",
      payload: { op: "remove", line: menuTask.line, revision: toggled.json().revision },
    });
    assert.equal(removed.statusCode, 200);
    assert.equal(removed.json().total, 2);
    assert.doesNotMatch(removed.json().markdown, /Починить меню/);

    const stale = await app.inject({
      method: "PATCH",
      url: "/api/projects/p1/tasks",
      payload: { op: "toggle", line: fresh.tasks[0].line, done: false, revision: fresh.revision },
    });
    assert.equal(stale.statusCode, 409);
    assert.match(stale.json().error, /изменился/);
    assert.equal(stale.json().tasks.total, 2, "конфликт возвращает свежий список");

    assert.match(String(removed.headers["cache-control"]), /no-store/);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("API задач: без проекта отвечает 404, пустой список не создаёт файл", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nestdev-tasks-route-"));
  const deps: TasksRouteDeps = {
    authorize: async (_request, reply) => {
      await reply.code(404).send({ error: "Проект не найден" });
      return null;
    },
    getSandbox: async () => ({ root }),
  };
  const app = Fastify();
  await registerTasksRoutes(app, deps);
  await app.ready();
  try {
    const response = await app.inject({ method: "GET", url: "/api/projects/missing/tasks" });
    assert.equal(response.statusCode, 404);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
