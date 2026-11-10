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

// Второе приложение с подменённым холодным ярусом: настоящая архивация пошла бы в бакет,
// а здесь проверяется сам маршрут — гварды, коды ответа и аудит.
const audited: Array<{ action: string; target?: string }> = [];
let archivedBytes = 4096;
let existingArchive: { bytes: number } | null = null;
let archiveError: Error | null = null;
let restoreJob: { id: string; bytesDone: number; bytesTotal: number } | null = null;
const stubbed = Fastify();
await registerAdminProjectRoutes(stubbed, {
  archiveInfo: async () => existingArchive,
  enqueue: async () => {
    if (archiveError) throw archiveError;
    return { id: "job-archive-1", state: "queued" };
  },
  restore: async () => restoreJob,
  audit: async input => {
    audited.push({ action: input.action, target: input.target });
  },
});
await stubbed.ready();

test.after(async () => {
  await app.close();
  await stubbed.close();
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
  assert.equal(body.preview.reservation, null);
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

  // Действия холодного яруса закрыты той же дверью, что и карточка.
  for (const action of ["archive", "restore"]) {
    const denied = await stubbed.inject({ method: "POST", url: "/api/admin/projects/any/" + action });
    assert.equal(denied.statusCode, 401, action + " без сессии администратора");
    const unknown = await stubbed.inject({ method: "POST", url: "/api/admin/projects/no-such/" + action, headers: auth });
    assert.equal(unknown.statusCode, 404, action + " для неизвестного проекта");
  }
});

test("админ укладывает проект в холодный ярус и это попадает в аудит", async () => {
  const user = await createUser("archive-owner@example.test", "user-password-123");
  const project = await createProject("Склад", undefined, user.id);
  audited.length = 0;
  archivedBytes = 123456;
  existingArchive = null;
  archiveError = null;

  const response = await stubbed.inject({ method: "POST", url: "/api/admin/projects/" + project.id + "/archive", headers: auth });
  // 202: работа принята в очередь, а не выполнена в запросе.
  assert.equal(response.statusCode, 202);
  const body = response.json();
  assert.deepEqual(body, { archived: false, queued: true, jobId: "job-archive-1", state: "queued" });
  assert.deepEqual(audited, [{ action: "admin.project.archived", target: project.id }]);
});

test("уже архивированный проект отвечает сразу, без очереди", async () => {
  const user = await createUser("archive-existing@example.test", "user-password-123");
  const project = await createProject("Гараж", undefined, user.id);
  audited.length = 0;
  existingArchive = { bytes: 987654 };
  archiveError = null;
  try {
    const response = await stubbed.inject({ method: "POST", url: "/api/admin/projects/" + project.id + "/archive", headers: auth });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { archived: true, bytes: 987654, alreadyArchived: true });
  } finally {
    existingArchive = null;
  }
});

test("сбой хранилища отвечает понятным кодом, а не 500", async () => {
  const user = await createUser("archive-fail@example.test", "user-password-123");
  const project = await createProject("Пекарня", undefined, user.id);
  existingArchive = null;
  archiveError = new Error("Объектное хранилище не настроено");
  try {
    const response = await stubbed.inject({ method: "POST", url: "/api/admin/projects/" + project.id + "/archive", headers: auth });
    assert.equal(response.statusCode, 400);
    const body = response.json();
    assert.equal(body.code, "ARCHIVE_FAILED");
    assert.match(body.error, /Объектное хранилище не настроено/);
  } finally {
    archiveError = null;
  }
});

test("возврат из бакета: 202 с jobId, а проект без архива — без задания", async () => {
  const user = await createUser("restore-owner@example.test", "user-password-123");
  const project = await createProject("Сад", undefined, user.id);
  audited.length = 0;

  restoreJob = null;
  const nothing = await stubbed.inject({ method: "POST", url: "/api/admin/projects/" + project.id + "/restore", headers: auth });
  assert.equal(nothing.statusCode, 200);
  assert.deepEqual(nothing.json(), { archived: false, restored: false, restoring: false, jobId: null });
  assert.deepEqual(audited, [], "без задания аудит не пишется");

  restoreJob = { id: "job-1", bytesDone: 0, bytesTotal: 987654 };
  const started = await stubbed.inject({ method: "POST", url: "/api/admin/projects/" + project.id + "/restore", headers: auth });
  assert.equal(started.statusCode, 202);
  const body = started.json();
  assert.equal(body.jobId, "job-1");
  assert.equal(body.bytesTotal, 987654);
  assert.equal(body.restoring, true);
  assert.deepEqual(audited, [{ action: "admin.project.restored", target: project.id }]);
});
