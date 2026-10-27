import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Карточка автора обращения собирается из нескольких хранилищ. Тест держит их в одном временном
 * каталоге и задаёт режим json до импорта: иначе проверка ушла бы в боевой Postgres.
 */
process.env.WEBNESTDEV_STORAGE = "json";
const root = await mkdtemp(path.join(tmpdir(), "support-user-"));
process.env.WEBNESTDEV_DATA_DIR = root;

const { createSession, createUser } = await import("../auth/auth-store.js");
const { linkPhone } = await import("../auth/phone-store.js");
const { saveUserProfile } = await import("../account/profile-store.js");
const { createProject } = await import("../project-store.js");
const { loadSupportUser, supportReporterFor, supportReporterFrom } = await import("./support-user.js");

test.after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("карточка автора содержит контакты, тариф, проекты и активность", async () => {
  const user = await createUser("client@example.test", "correct-horse-battery");
  await saveUserProfile(user.id, {
    name: "Иван Петров",
    email: "ivan@example.test",
    newsletter: true,
    productUpdates: false,
  });
  await linkPhone("+79991234567", user.id);
  await createSession(user.id);
  const project = await createProject("Магазин", undefined, user.id);

  const details = await loadSupportUser(user.id);
  assert.ok(details);
  assert.equal(details.email, "client@example.test");
  assert.equal(details.name, "Иван Петров");
  assert.equal(details.contactEmail, "ivan@example.test");
  assert.equal(details.phone, "+7 999 123-45-67");
  assert.deepEqual(details.signIn, ["phone", "password"]);
  assert.equal(details.plan, "free");
  assert.equal(details.planName, "Старт");
  assert.equal(details.projects, 1);
  assert.equal(details.recentProjects[0]?.id, project.id);
  assert.equal(details.recentProjects[0]?.name, "Магазин");
  assert.equal(details.lastActiveAt, project.updatedAt);
  assert.equal(details.tokens.limit, 0);
  assert.equal(details.usage.agentRuns, 0);
  assert.equal(details.yandexLogin, null);

  const reporter = supportReporterFrom(details);
  assert.equal(reporter.projects, 1);
  assert.equal(reporter.plan, "free");
  assert.equal("recentProjects" in reporter, false);
  assert.deepEqual(await supportReporterFor(user.id), reporter);
});

test("удалённый аккаунт не ломает чтение обращения", async () => {
  assert.equal(await loadSupportUser("missing-user"), null);
  assert.equal(await supportReporterFor("missing-user"), null);
});
