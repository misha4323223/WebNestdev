import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Админка получает не только текст тикета, но и карточку автора. Тест специально создаёт тикет
 * без сохранённого снимка — так выглядит обращение, отправленное до обновления, — и проверяет,
 * что список дополняет его при чтении, а карточка отдаёт живые данные.
 */
process.env.WEBNESTDEV_STORAGE = "json";
const root = await mkdtemp(path.join(tmpdir(), "support-detail-"));
process.env.WEBNESTDEV_DATA_DIR = root;
const KEY = "read-only-key-0123456789";
process.env.SUPPORT_API_KEY = KEY;

const Fastify = (await import("fastify")).default;
const cookie = (await import("@fastify/cookie")).default;
const { registerSupportRoutes } = await import("./support.js");
const { createSupportTicket } = await import("../support/support-store.js");
const { createSession, createUser } = await import("../auth/auth-store.js");
const { linkPhone } = await import("../auth/phone-store.js");
const { saveUserProfile } = await import("../account/profile-store.js");
const { createProject } = await import("../project-store.js");

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const app = Fastify();
await app.register(cookie);
await registerSupportRoutes(app);
await app.ready();

test.after(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

async function seedTicket() {
  const user = await createUser("client@example.test", "correct-horse-battery");
  await saveUserProfile(user.id, {
    name: "Иван Петров",
    email: "ivan@example.test",
    newsletter: false,
    productUpdates: false,
  });
  await linkPhone("+79991234567", user.id);
  await createSession(user.id);
  const project = await createProject("Магазин", undefined, user.id);
  const ticket = await createSupportTicket({
    userId: user.id,
    email: user.email,
    category: "bug",
    severity: 8,
    description: "После публикации пропала страница оформления заказа",
    steps: "Открыть проект, нажать «Опубликовать», перейти в предпросмотр",
    page: "https://nestdev.ru/project/" + project.id,
    projectId: project.id,
    userAgent: "test-agent",
    screenshot: PNG,
  });
  return { user, project, ticket };
}

test("список и карточка обращения отдают подробную информацию об авторе", async () => {
  const { user, project, ticket } = await seedTicket();

  const list = await app.inject({
    method: "GET",
    url: "/api/support/tickets",
    headers: { "x-support-key": KEY },
  });
  assert.equal(list.statusCode, 200, list.body);
  const listed = list.json().tickets.find((item: { id: string }) => item.id === ticket.id);
  assert.ok(listed);
  assert.equal(listed.reporter.name, "Иван Петров");
  assert.equal(listed.reporter.contactEmail, "ivan@example.test");
  assert.equal(listed.reporter.phone, "+7 999 123-45-67");

  const detail = await app.inject({
    method: "GET",
    url: "/api/support/tickets/" + ticket.id,
    headers: { authorization: "Bearer " + KEY },
  });
  assert.equal(detail.statusCode, 200, detail.body);
  const body = detail.json();
  assert.equal(body.ticket.id, ticket.id);
  assert.equal(body.ticket.reporter.name, "Иван Петров");
  assert.equal(body.user.id, user.id);
  assert.equal(body.user.name, "Иван Петров");
  assert.equal(body.user.phone, "+7 999 123-45-67");
  assert.equal(body.user.plan, "free");
  assert.equal(body.user.projects, 1);
  assert.equal(body.user.recentProjects[0].id, project.id);
  assert.equal(body.history.total, 1);
  assert.equal(body.history.tickets[0].id, ticket.id);
  assert.ok(body.user.usage && body.user.tokens);
});

test("новое обращение сохраняет снимок автора на момент отправки", async () => {
  const user = await createUser("snapshot@example.test", "correct-horse-battery");
  await saveUserProfile(user.id, {
    name: "Мария Смирнова",
    email: "maria@example.test",
    newsletter: false,
    productUpdates: false,
  });
  const session = await createSession(user.id);

  const created = await app.inject({
    method: "POST",
    url: "/api/support",
    headers: {
      cookie: "webnestdev_session=" + session.id,
      "content-type": "application/json",
    },
    payload: {
      category: "idea",
      severity: 4,
      description: "Хочу сохранять шаблоны проектов в один клик",
      steps: "Открыть список проектов и нажать «Сохранить шаблон»",
      screenshot: PNG,
    },
  });
  assert.equal(created.statusCode, 201, created.body);

  const detail = await app.inject({
    method: "GET",
    url: "/api/support/tickets/" + created.json().id,
    headers: { "x-support-key": KEY },
  });
  assert.equal(detail.statusCode, 200, detail.body);
  const ticket = detail.json().ticket;
  assert.equal(ticket.reporter.name, "Мария Смирнова");
  assert.equal(ticket.reporter.contactEmail, "maria@example.test");
  assert.equal(ticket.reporter.projects, 0);
  assert.equal(ticket.ip, "127.0.0.1");
});

test("карточка закрыта без ключа и не выдумывает несуществующее обращение", async () => {
  const anonymous = await app.inject({ method: "GET", url: "/api/support/tickets/00000000-0000-4000-8000-000000000000" });
  assert.equal(anonymous.statusCode, 401);

  const missing = await app.inject({
    method: "GET",
    url: "/api/support/tickets/00000000-0000-4000-8000-000000000000",
    headers: { "x-support-key": KEY },
  });
  assert.equal(missing.statusCode, 404);
});
