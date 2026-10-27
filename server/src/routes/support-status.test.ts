import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Статус обращения и сводка «где болит»: проверяется, что статус доезжает до файла обращения,
 * старые тикеты без поля читаются как открытые, а сводка считает очередь по отправленным ответам,
 * а не по наличию переписки (неудачная попытка ответом не считается).
 */
process.env.WEBNESTDEV_STORAGE = "json";
const root = await mkdtemp(path.join(tmpdir(), "support-status-"));
process.env.WEBNESTDEV_DATA_DIR = root;

const Fastify = (await import("fastify")).default;
const { registerSupportRoutes } = await import("./support.js");
const { createAdmin, createAdminSession } = await import("../admin/admin-store.js");
const { createUser } = await import("../auth/auth-store.js");
const { addSupportMessage, createSupportTicket, getSupportTicket } = await import("../support/support-store.js");

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const app = Fastify();
await registerSupportRoutes(app);
await app.ready();

const admin = await createAdmin("support-status@example.test", "correct-horse-battery");
const session = await createAdminSession(admin.id);
const auth = { authorization: "Bearer " + session.token };

test.after(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

async function seed(category: "bug" | "idea" = "bug", severity = 8) {
  const user = await createUser("author-" + Math.random().toString(36).slice(2) + "@example.test", "user-password-123");
  return createSupportTicket({
    userId: user.id,
    email: user.email,
    category,
    severity,
    description: "Не открывается превью после перезапуска проекта",
    screenshot: PNG,
  });
}

test("статус обращения меняется и виден в карточке", async () => {
  const ticket = await seed();

  const anonymous = await app.inject({ method: "PATCH", url: "/api/support/tickets/" + ticket.id + "/status", payload: { status: "closed" } });
  assert.equal(anonymous.statusCode, 401);

  const bad = await app.inject({ method: "PATCH", url: "/api/support/tickets/" + ticket.id + "/status", headers: auth, payload: { status: "done" } });
  assert.equal(bad.statusCode, 400);

  const extra = await app.inject({ method: "PATCH", url: "/api/support/tickets/" + ticket.id + "/status", headers: auth, payload: { status: "closed", notify: true } });
  assert.equal(extra.statusCode, 400);

  const closed = await app.inject({ method: "PATCH", url: "/api/support/tickets/" + ticket.id + "/status", headers: auth, payload: { status: "closed" } });
  assert.equal(closed.statusCode, 200);
  assert.equal(closed.json().status, "closed");

  const stored = await getSupportTicket(ticket.id);
  assert.equal(stored?.status, "closed");

  const missing = await app.inject({ method: "PATCH", url: "/api/support/tickets/00000000-0000-4000-8000-000000000000/status", headers: auth, payload: { status: "open" } });
  assert.equal(missing.statusCode, 404);
});

test("старое обращение без статуса читается как открытое", async () => {
  const ticket = await seed("idea", 3);
  const stored = await getSupportTicket(ticket.id);
  assert.equal(stored?.status, "open");
});

test("сводка считает очередь по отправленному ответу", async () => {
  const waiting = await seed("bug", 9);
  const answered = await seed("idea", 2);
  await addSupportMessage({
    ticketId: answered.id,
    author: "admin",
    authorName: admin.email,
    subject: "Ответ",
    body: "Здравствуйте! Исправили, проверьте",
    to: "author@example.test",
    status: "sent",
    error: "",
    messageId: "msg-1",
  });
  // Неудачная попытка не закрывает очередь: человек письма не получил.
  const failed = await seed("bug", 5);
  await addSupportMessage({
    ticketId: failed.id,
    author: "admin",
    authorName: admin.email,
    subject: "Ответ",
    body: "Письмо не ушло",
    to: "author@example.test",
    status: "failed",
    error: "Postbox ответил 502",
    messageId: "",
  });

  const response = await app.inject({ method: "GET", url: "/api/admin/support/stats", headers: auth });
  assert.equal(response.statusCode, 200);
  const body = response.json();

  assert.equal(body.total, 5);
  assert.equal(body.byStatus.open, 4);
  assert.equal(body.byStatus.closed, 1);
  assert.equal(body.awaitingReply, 4);
  assert.equal(body.severity["9-10"], 1);
  assert.equal(body.severity["1-3"], 2);
  assert.equal(body.last7Days, 5);
  assert.ok(body.oldestOpen, "должно быть открытое обращение");
  assert.equal(typeof body.oldestOpen.ageHours, "number");
  assert.ok(waiting.id);
});
