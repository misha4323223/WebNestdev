import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Перенос проектов между аккаунтами. Главное здесь — что вместе с `projects.user_id`
 * переезжают владельцы сайта, релизов, размера и холодного архива, а чужие проекты и
 * аккаунтные данные остаются на месте. Проверяется живой маршрут: админка вызывает его
 * с Bearer-токеном, а не отдельную функцию.
 *
 * Окружение выставляется до импорта: хранилища читают тип и каталог при загрузке.
 */
process.env.WEBNESTDEV_STORAGE = "json";
const root = await mkdtemp(path.join(tmpdir(), "admin-project-transfer-"));
process.env.WEBNESTDEV_DATA_DIR = root;

const Fastify = (await import("fastify")).default;
const { registerAdminUserActionRoutes } = await import("./admin-users.js");
const { createAdmin, createAdminSession } = await import("../admin/admin-store.js");
const { createUser } = await import("../auth/auth-store.js");
const { createProject, getProject, listProjects } = await import("../project-store.js");
const { sandboxRootPath } = await import("../sandbox/config.js");
const { refreshProjectSize, readProjectSizes } = await import("../account/storage-quota.js");
const { readArchiveRecord, writeArchiveRecord } = await import("../storage/project-archive-state.js");
const { beginPublish, createSite, finishPublish, getRelease, getSite } = await import("../hosting/site-store.js");
const { beginRun, endRun } = await import("../agent/active-runs.js");
const { listAudit } = await import("../security/audit-journal.js");

const app = Fastify();
await registerAdminUserActionRoutes(app);
await app.ready();

const admin = await createAdmin("transfer-admin@example.test", "correct-horse-battery");
const adminSession = await createAdminSession(admin.id);
const auth = { authorization: "Bearer " + adminSession.token };

test.after(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

let counter = 0;
async function makeUser() {
  counter += 1;
  return createUser("transfer-" + counter + "@example.test", "user-password-123");
}

const transfer = async (fromId: string, body: Record<string, unknown>) =>
  await app.inject({
    method: "POST",
    url: "/api/admin/users/" + fromId + "/projects/transfer",
    headers: auth,
    payload: body,
  });

test("маршрут требует админ-сессию, подтверждение и известные аккаунты", async () => {
  const source = await makeUser();
  const target = await makeUser();

  const anonymous = await app.inject({
    method: "POST",
    url: "/api/admin/users/" + source.id + "/projects/transfer",
    payload: { confirm: true, toUserId: target.id },
  });
  assert.equal(anonymous.statusCode, 401);

  assert.equal((await transfer(source.id, { toUserId: target.id })).statusCode, 400);
  // Строгая схема: лишнее поле — отказ, а не «перенесём заодно и это».
  assert.equal((await transfer(source.id, { confirm: true, toUserId: target.id, deleteSource: true })).statusCode, 400);
  assert.equal((await transfer(source.id, { confirm: true, toUserId: target.id, projectIds: [] })).statusCode, 400);

  assert.equal((await transfer("no-such-user", { confirm: true, toUserId: target.id })).statusCode, 404);
  assert.equal((await transfer(source.id, { confirm: true, toUserId: "no-such-user" })).statusCode, 404);
  assert.equal((await transfer(source.id, { confirm: true, toUserId: source.id })).statusCode, 400);

  const anonymousTarget = await app.inject({ method: "GET", url: "/api/admin/users/" + source.id + "/restriction" });
  assert.equal(anonymousTarget.statusCode, 401);
});

test("перенос всех проектов двигает владельца проекта, сайта, квоты и архива", async () => {
  const source = await makeUser();
  const target = await makeUser();
  const existing = await createProject("Старый проект получателя", undefined, target.id);

  const first = await createProject("Магазин цветов", undefined, source.id);
  const second = await createProject("Лендинг", undefined, source.id);

  // Сайт и готовый релиз: после переноса оба должны принадлежать получателю, иначе
  // публикация от нового владельца упрётся в чужую запись.
  const site = await createSite({ projectId: first.id, userId: source.id, nodeId: "node-a" });
  const publishing = await beginPublish({ siteId: site.id, userId: source.id, kind: "static-build", nodeId: "node-a" });
  const published = await finishPublish({
    siteId: site.id,
    releaseId: publishing.release.id,
    userId: source.id,
    kind: "static-build",
    bytes: 2048,
    files: 2,
    sha256: "abc",
    manifestJson: "{}",
  });

  // Непустой размер: квота не должна остаться у источника.
  await mkdir(sandboxRootPath(first.id), { recursive: true });
  await writeFile(path.join(sandboxRootPath(first.id), "index.html"), "x".repeat(512));
  await refreshProjectSize(first.id, source.id, { force: true });
  await writeArchiveRecord({
    projectId: first.id,
    userId: source.id,
    key: "projects/" + first.id + ".tar.gz",
    bytes: 512,
    archivedAt: new Date().toISOString(),
  });

  const response = await transfer(source.id, { confirm: true, toUserId: target.id });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.ok, true);
  assert.equal(body.from.id, source.id);
  assert.equal(body.to.id, target.id);
  assert.deepEqual(body.transferred.map((project: { name: string }) => project.name).sort(), ["Лендинг", "Магазин цветов"]);
  assert.deepEqual(body.counts, { from: 0, to: 3 });

  assert.equal((await listProjects(source.id)).length, 0);
  const targetProjects = await listProjects(target.id);
  assert.deepEqual(targetProjects.map(project => project.id).sort(), [existing.id, first.id, second.id].sort());
  assert.equal((await getProject(first.id))?.userId, target.id);

  assert.equal((await getSite(site.id))?.userId, target.id);
  assert.equal((await getRelease(published.release.id))?.userId, target.id);

  const sourceSizes = await readProjectSizes(source.id);
  const targetSizes = await readProjectSizes(target.id);
  assert.equal(sourceSizes.size, 0);
  assert.ok((targetSizes.get(first.id)?.sizeBytes ?? 0) > 0, "размер проекта должен уехать к получателю");

  assert.equal((await readArchiveRecord(first.id))?.userId, target.id);

  const audit = await listAudit({ action: "projects.transferred", limit: 10 });
  assert.equal(audit[0]?.target, source.id);
  assert.equal(audit[0]?.actorId, admin.id);
  assert.equal(audit[0]?.details.count, 2);
  assert.equal(audit[0]?.details.toUserId, target.id);
});

test("выборочный перенос оставляет остальные проекты источнику", async () => {
  const source = await makeUser();
  const target = await makeUser();
  const keep = await createProject("Остаётся", undefined, source.id);
  const move = await createProject("Переезжает", undefined, source.id);

  const response = await transfer(source.id, { confirm: true, toUserId: target.id, projectIds: [move.id] });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.deepEqual(body.transferred.map((project: { id: string }) => project.id), [move.id]);
  assert.deepEqual(body.counts, { from: 1, to: 1 });

  assert.equal((await getProject(keep.id))?.userId, source.id);
  assert.equal((await getProject(move.id))?.userId, target.id);
});

test("чужой, несуществующий или занятый проект отменяет весь перенос", async () => {
  const source = await makeUser();
  const other = await makeUser();
  const target = await makeUser();
  const own = await createProject("Свой", undefined, source.id);
  const foreign = await createProject("Чужой", undefined, other.id);

  const notOwned = await transfer(source.id, { confirm: true, toUserId: target.id, projectIds: [own.id, foreign.id] });
  assert.equal(notOwned.statusCode, 404);
  assert.equal(notOwned.json().code, "PROJECT_NOT_FOUND");
  assert.equal((await getProject(own.id))?.userId, source.id);
  assert.equal((await getProject(foreign.id))?.userId, other.id);

  const noProjects = await transfer((await makeUser()).id, { confirm: true, toUserId: target.id });
  assert.equal(noProjects.statusCode, 409);
  assert.equal(noProjects.json().code, "NO_PROJECTS");

  // Работающий агент пишет от имени старого владельца — перенос ждёт завершения.
  beginRun(own.id);
  try {
    const busy = await transfer(source.id, { confirm: true, toUserId: target.id });
    assert.equal(busy.statusCode, 409);
    assert.equal(busy.json().code, "PROJECT_BUSY");
    assert.equal(busy.json().projects[0].name, "Свой");
    assert.equal((await getProject(own.id))?.userId, source.id);
  } finally {
    endRun(own.id);
  }

  const after = await transfer(source.id, { confirm: true, toUserId: target.id });
  assert.equal(after.statusCode, 200);
  assert.equal((await getProject(own.id))?.userId, target.id);
});
