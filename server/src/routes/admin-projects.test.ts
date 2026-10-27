import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Карточка проекта: владелец, репозиторий, превью, переменные и план выкатки в одном ответе.
 * Главное, что проверяется, — значений секретов в ответе нет: админке нужны имена переменных,
 * чтобы понять, почему приложение не поднимается, а не сами ключи.
 */
process.env.WEBNESTDEV_STORAGE = "json";
const root = await mkdtemp(path.join(tmpdir(), "admin-projects-"));
process.env.WEBNESTDEV_DATA_DIR = root;

const Fastify = (await import("fastify")).default;
const { registerAdminProjectRoutes } = await import("./admin-projects.js");
const { createAdmin, createAdminSession } = await import("../admin/admin-store.js");
const { createUser } = await import("../auth/auth-store.js");
const { createProject } = await import("../project-store.js");
const { sandboxRootPath } = await import("../sandbox/config.js");

const app = Fastify();
await registerAdminProjectRoutes(app);
await app.ready();

const admin = await createAdmin("projects-admin@example.test", "correct-horse-battery");
const session = await createAdminSession(admin.id);
const auth = { authorization: "Bearer " + session.token };

test.after(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

test("карточка показывает владельца и переменные, но не их значения", async () => {
  const user = await createUser("owner@example.test", "user-password-123");
  const project = await createProject("Магазин цветов", undefined, user.id);
  const sandbox = sandboxRootPath(project.id);
  await mkdir(sandbox, { recursive: true });
  await writeFile(path.join(sandbox, ".env.local"), "DATABASE_URL=postgres://super-secret-value\nAPI_TOKEN=another-secret\n");

  const response = await app.inject({ method: "GET", url: "/api/admin/projects/" + project.id, headers: auth });
  assert.equal(response.statusCode, 200);
  const body = response.json();

  assert.equal(body.project.name, "Магазин цветов");
  assert.equal(body.project.repository, null);
  assert.equal(body.owner.email, user.email);
  assert.equal(body.preview.running, false);
  assert.equal(body.deploy.exists, false);

  const names = body.secrets.variables.map((variable: { name: string }) => variable.name).sort();
  assert.deepEqual(names, ["API_TOKEN", "DATABASE_URL"]);

  // Ответ не должен содержать значения секретов ни в каком поле.
  const text = JSON.stringify(body);
  assert.ok(!text.includes("super-secret-value"), "значение секрета попало в ответ");
  assert.ok(!text.includes("another-secret"), "значение секрета попало в ответ");
});

test("чужая дверь и неизвестный проект", async () => {
  const anonymous = await app.inject({ method: "GET", url: "/api/admin/projects/any" });
  assert.equal(anonymous.statusCode, 401);

  const missing = await app.inject({ method: "GET", url: "/api/admin/projects/no-such-project", headers: auth });
  assert.equal(missing.statusCode, 404);
});
