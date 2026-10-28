import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Ответ на обращение проверяется через настоящий HTTP-слой, а сам транспорт подменяется: живой
 * SMTP в CI недоступен, и проверять здесь надо всё, что стоит вокруг письма — выбор адреса,
 * квоту, запись в переписку, журнал и отказ. Само письмо (отправитель, Reply-To, тема, текст)
 * проверяется в `support/support-reply.test.ts` на поддельном SMTP-соединении.
 *
 * Так же проверяется главное обещание двери: ключ поддержки обращения читает, но писем людям не
 * отправляет, а ответы считаются в тот же суточный предел, что и рассылка.
 *
 * Переменные выставляются до импорта: тип хранилища и каталог данных читаются при загрузке
 * admin-store, а суточный предел — при каждом запросе.
 */
process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_DATA_DIR = await mkdtemp(path.join(tmpdir(), "support-reply-"));
process.env.POSTBOX_DAILY_LIMIT = "200";
process.env.SUPPORT_API_KEY = "test-support-read-key-1234";

const Fastify = (await import("fastify")).default;
const { registerSupportRoutes } = await import("./support.js");
const { createAdmin, createAdminSession } = await import("../admin/admin-store.js");
const { createUser } = await import("../auth/auth-store.js");
const { saveUserProfile } = await import("../account/profile-store.js");
const { createSupportTicket, listSupportMessages } = await import("../support/support-store.js");
const { listAudit } = await import("../security/audit-journal.js");

type Sent = { to: string; subject: string; text: string };
const sent: Sent[] = [];
let answer: () => Promise<{ messageId: string }> = async () => ({ messageId: "msg-1" });

const app = Fastify();
await registerSupportRoutes(app, {
  reply: input => {
    sent.push(input);
    return answer();
  },
});

const EMAIL = "admin@example.test";
const PASSWORD = "correct-horse-battery";
const SUPPORT_KEY = process.env.SUPPORT_API_KEY ?? "";
const PHONE_LOGIN = "79531814136@phone.webnestdev.local";

const admin = await createAdmin(EMAIL, PASSWORD);
const session = await createAdminSession(admin.id);
const auth = { authorization: "Bearer " + session.token };

/** Минимальный PNG: хранилище проверяет сигнатуру файла, а не картинку целиком. */
const SCREENSHOT = "data:image/png;base64," + Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(24),
]).toString("base64");

const client = await createUser("client@nestdev.ru", "client-password");
await saveUserProfile(client.id, {
  name: "Иван",
  email: "ivan.petrov@yandex.ru",
  newsletter: true,
  productUpdates: true,
});
const ticket = await createSupportTicket({
  userId: client.id,
  email: "client@nestdev.ru",
  category: "idea",
  severity: 3,
  description: "Хочу тёмную тему в панели",
  screenshot: SCREENSHOT,
});

const phone = await createUser(PHONE_LOGIN, "phone-password");
const phoneTicket = await createSupportTicket({
  userId: phone.id,
  email: PHONE_LOGIN,
  category: "bug",
  severity: 5,
  description: "Кнопка не отвечает при входе с телефона",
  screenshot: SCREENSHOT,
});

function reply(ticketId: string, payload: unknown) {
  return app.inject({ method: "POST", url: "/api/support/tickets/" + ticketId + "/reply", headers: auth, payload: payload as never });
}

test("ключ поддержки читает обращения, но писем людям не отправляет", async () => {
  const payload = { body: "Здравствуйте! Проверка ответа из админки." };

  const anonymous = await app.inject({ method: "POST", url: "/api/support/tickets/" + ticket.id + "/reply", payload });
  assert.equal(anonymous.statusCode, 401);

  const byKey = await app.inject({
    method: "POST",
    url: "/api/support/tickets/" + ticket.id + "/reply",
    headers: { "x-support-key": SUPPORT_KEY },
    payload,
  });
  assert.equal(byKey.statusCode, 401, "ключ чтения не отправляет письма");

  const read = await app.inject({ method: "GET", url: "/api/support/tickets", headers: { "x-support-key": SUPPORT_KEY } });
  assert.equal(read.statusCode, 200, "тем же ключом обращения читаются");
  assert.deepEqual(sent, [], "до отправки дело не дошло");
});

test("короткий и длинный текст — ошибка ввода, а не попытка отправки", async () => {
  const short = await reply(ticket.id, { body: "ок" });
  assert.equal(short.statusCode, 400);
  assert.deepEqual(short.json(), { error: "Текст ответа слишком короткий", code: "body_too_short" });

  const long = await reply(ticket.id, { body: "я".repeat(8_001) });
  assert.equal(long.statusCode, 400);
  assert.deepEqual(long.json(), { error: "Текст ответа длиннее 8000 символов", code: "body_too_long" });

  assert.deepEqual(sent, []);
});

test("неизвестное обращение не отправляет письмо", async () => {
  const response = await reply("11111111-1111-1111-1111-111111111111", { body: "Здравствуйте! Есть ли такое обращение?" });
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), { error: "Обращение не найдено", code: "ticket_not_found" });
  assert.deepEqual(sent, []);
});

test("отвечать некуда: служебный логин без почты профиля", async () => {
  const response = await reply(phoneTicket.id, { body: "Здравствуйте! Отвечаем на ваше обращение." });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), {
    error: "У аккаунта нет почты, которую человек вводил сам: отвечать некуда",
    code: "contact_email_missing",
    email: PHONE_LOGIN,
  });
  assert.deepEqual(sent, []);
});

test("ответ уходит на почту профиля с темой обращения и идентификатором письма", async () => {
  const response = await reply(ticket.id, {
    body: "Здравствуйте! Инструкция: https://nestdev.ru/docs.\n\nПроверка ответа из админки.",
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as { ok: boolean; to: string; messageId: string; sentAt: string };
  assert.equal(body.ok, true);
  assert.equal(body.to, "ivan.petrov@yandex.ru", "письмо уходит на почту профиля, а не на логин");
  assert.equal(body.messageId, "msg-1");
  assert.equal(typeof body.sentAt, "string");

  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "ivan.petrov@yandex.ru");
  assert.equal(sent[0].subject, "Обращение " + ticket.id + ": идея", "без своей темы — тема обращения");
  assert.match(sent[0].text, /Проверка ответа из админки/);
  assert.match(sent[0].text, /https:\/\/nestdev\.ru\/docs/);
  assert.doesNotMatch(sent[0].text, /[Оо]тписаться/, "в ответе нет строки отписки: это не рассылка");

  const events = await listAudit({ action: "support.reply" });
  assert.equal(events.length, 1);
  assert.equal(events[0].target, ticket.id);
  assert.equal(events[0].actorLabel, EMAIL);
  assert.equal(events[0].details.to, "ivan.petrov@yandex.ru");
});

test("переписка видна в списке обращений и в карточке", async () => {
  const list = await app.inject({ method: "GET", url: "/api/support/tickets", headers: auth });
  assert.equal(list.statusCode, 200);
  const tickets = (list.json() as { tickets: Array<{ id: string; messages: Array<{ author: string; authorName: string; status: string; to: string; body: string; createdAt: string }> }> }).tickets;

  const answered = tickets.find(item => item.id === ticket.id);
  assert.equal(answered?.messages.length, 1);
  assert.equal(answered?.messages[0].author, "admin");
  assert.equal(answered?.messages[0].authorName, EMAIL, "видно, кто именно ответил");
  assert.equal(answered?.messages[0].status, "sent");
  assert.equal(answered?.messages[0].to, "ivan.petrov@yandex.ru");
  assert.match(answered?.messages[0].body ?? "", /Проверка ответа из админки/);
  assert.ok(answered?.messages[0].createdAt);

  const untouched = tickets.find(item => item.id === phoneTicket.id);
  assert.deepEqual(untouched?.messages, [], "у обращения без ответов переписка пустая, а не отсутствует");

  const card = await app.inject({ method: "GET", url: "/api/support/tickets/" + ticket.id, headers: auth });
  assert.equal(card.statusCode, 200);
  assert.equal((card.json() as { messages: unknown[] }).messages.length, 1);
});

test("неудачная отправка попадает в переписку с причиной, а не теряется", async () => {
  // Так выглядит отказ сервиса: текст ошибки важнее кода, и он должен остаться в переписке.
  answer = async () => {
    throw new Error("SMTP ответил 535 на шаге «password»");
  };

  const response = await reply(ticket.id, { subject: "Про ваше обращение", body: "Здравствуйте! Второй ответ." });
  assert.equal(response.statusCode, 502);
  const body = response.json() as { error: string; code: string };
  assert.equal(body.code, "send_failed");
  assert.match(body.error, /535/);

  const messages = await listSupportMessages(ticket.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].status, "failed");
  assert.equal(messages[1].subject, "Про ваше обращение", "своя тема сохраняется как есть");
  assert.match(messages[1].error, /535/);
  assert.equal(messages[1].messageId, "");

  const events = await listAudit({ action: "support.reply.failed" });
  assert.equal(events.length, 1);
  assert.equal(events[0].target, ticket.id);

  answer = async () => ({ messageId: "msg-2" });
});

test("ответы считаются в тот же суточный предел, что и рассылка", async () => {
  // Предел — на одно письмо: один ответ уже ушёл, значит следующий должен быть отклонён.
  // Отказы в счёт не идут: в переписке есть и неудачная отправка, но она не занимает квоту.
  process.env.POSTBOX_DAILY_LIMIT = "1";
  try {
    const attemptsBefore = sent.length;
    const response = await reply(ticket.id, { body: "Здравствуйте! Третий ответ." });
    assert.equal(response.statusCode, 429);
    const body = response.json() as { error: string; code: string };
    assert.equal(body.code, "quota_exceeded");
    assert.match(body.error, /1 из 1 за сутки/);
    assert.equal(sent.length, attemptsBefore, "сверх предела письмо не уходит");
  } finally {
    process.env.POSTBOX_DAILY_LIMIT = "200";
  }
});

test("почта из формы обращения важнее служебного логина", async () => {
  const formTicket = await createSupportTicket({
    userId: phone.id,
    email: PHONE_LOGIN,
    contactEmail: "answer@example.com",
    category: "idea",
    severity: 2,
    description: "Хочу сохранять черновики обращения",
    screenshot: SCREENSHOT,
  });

  const list = await app.inject({ method: "GET", url: "/api/support/tickets", headers: auth });
  assert.equal(list.statusCode, 200);
  const listed = (list.json() as { tickets: Array<{ id: string; contactEmail: string | null }> }).tickets.find(item => item.id === formTicket.id);
  assert.equal(listed?.contactEmail, "answer@example.com", "админка видит почту из обращения, а не только логин");

  const response = await reply(formTicket.id, { body: "Здравствуйте! Ответим на адрес из обращения." });
  assert.equal(response.statusCode, 200);
  assert.equal((response.json() as { to: string }).to, "answer@example.com");
  assert.equal(sent.at(-1)?.to, "answer@example.com");
});
