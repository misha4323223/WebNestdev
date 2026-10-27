import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Ответ на обращение проверяется через настоящий HTTP-слой и настоящий транспорт: вместо Postbox
 * поднимается локальный сервер на 127.0.0.1, поэтому проверяются не «мы вызвали функцию», а само
 * письмо — куда оно ушло, с какой темой, с каким Reply-To и с какой ссылкой в HTML.
 *
 * Так же проверяется главное обещание двери: ключ поддержки обращения читает, но писем людям не
 * отправляет, а ответы считаются в тот же суточный предел, что и рассылка.
 *
 * Переменные выставляются до импорта: тип хранилища и каталог данных читаются при загрузке
 * admin-store, а адрес Postbox — при каждом запросе (getPlatformEnv читает окружение живьём).
 */
process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_DATA_DIR = await mkdtemp(path.join(tmpdir(), "support-reply-"));
process.env.POSTBOX_SENDER = "noreply@nestdev.ru";
process.env.POSTBOX_IAM_TOKEN = "test-iam-token";
process.env.POSTBOX_DAILY_LIMIT = "200";
process.env.POSTBOX_RATE_PER_SECOND = "1";
process.env.PLATFORM_URL = "https://nestdev.ru";
process.env.SUPPORT_API_KEY = "test-support-read-key-1234";

type Outbound = { url: string; headers: NodeJS.Dict<string | string[]>; body: Record<string, unknown> };
const outbound: Outbound[] = [];
let answer = () => ({ status: 200, body: JSON.stringify({ MessageId: "msg-1" }) });

const postbox = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", chunk => chunks.push(chunk as Buffer));
  request.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      body = { raw };
    }
    outbound.push({ url: request.url ?? "", headers: request.headers, body });
    const result = answer();
    response.writeHead(result.status, { "content-type": "application/json" });
    response.end(result.body);
  });
});
await new Promise<void>(resolve => postbox.listen(0, "127.0.0.1", resolve));
process.env.POSTBOX_ENDPOINT = "http://127.0.0.1:" + (postbox.address() as AddressInfo).port;

const Fastify = (await import("fastify")).default;
const { registerSupportRoutes } = await import("./support.js");
const { createAdmin, createAdminSession } = await import("../admin/admin-store.js");
const { createUser } = await import("../auth/auth-store.js");
const { saveUserProfile } = await import("../account/profile-store.js");
const { createSupportTicket, listSupportMessages } = await import("../support/support-store.js");
const { listAudit } = await import("../security/audit-journal.js");

const EMAIL = "admin@example.test";
const PASSWORD = "correct-horse-battery";
const SUPPORT_KEY = process.env.SUPPORT_API_KEY ?? "";
const PHONE_LOGIN = "79531814136@phone.webnestdev.local";

const app = Fastify();
await registerSupportRoutes(app);

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
  assert.deepEqual(outbound, [], "до Postbox дело не дошло");
});

test("короткий и длинный текст — ошибка ввода, а не попытка отправки", async () => {
  const short = await reply(ticket.id, { body: "ок" });
  assert.equal(short.statusCode, 400);
  assert.deepEqual(short.json(), { error: "Текст ответа слишком короткий", code: "body_too_short" });

  const long = await reply(ticket.id, { body: "я".repeat(8_001) });
  assert.equal(long.statusCode, 400);
  assert.deepEqual(long.json(), { error: "Текст ответа длиннее 8000 символов", code: "body_too_long" });

  assert.deepEqual(outbound, []);
});

test("неизвестное обращение не отправляет письмо", async () => {
  const response = await reply("11111111-1111-1111-1111-111111111111", { body: "Здравствуйте! Есть ли такое обращение?" });
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), { error: "Обращение не найдено", code: "ticket_not_found" });
  assert.deepEqual(outbound, []);
});

test("отвечать некуда: служебный логин без почты профиля", async () => {
  const response = await reply(phoneTicket.id, { body: "Здравствуйте! Отвечаем на ваше обращение." });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), {
    error: "У аккаунта нет почты, которую человек вводил сам: отвечать некуда",
    code: "contact_email_missing",
    email: PHONE_LOGIN,
  });
  assert.deepEqual(outbound, []);
});

test("ответ уходит на почту профиля с Reply-To и ссылкой в HTML", async () => {
  const response = await reply(ticket.id, {
    body: "Здравствуйте! Инструкция: https://nestdev.ru/docs.\n\nПроверка ответа из админки.",
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as { ok: boolean; to: string; messageId: string; sentAt: string };
  assert.equal(body.ok, true);
  assert.equal(body.to, "ivan.petrov@yandex.ru", "письмо уходит на почту профиля, а не на логин");
  assert.equal(body.messageId, "msg-1");
  assert.equal(typeof body.sentAt, "string");

  assert.equal(outbound.length, 1);
  assert.equal(outbound[0].url, "/v2/email/outbound-emails");
  assert.ok(outbound[0].headers["x-yacloud-subjecttoken"], "ключ Postbox тот же, что у рассылки");
  const sent = outbound[0].body as {
    FromEmailAddress: string;
    Destination: { ToAddresses: string[] };
    ReplyToAddresses: string[];
    Content: { Simple: { Subject: { Data: string }; Body: { Text: { Data: string }; Html: { Data: string } } } };
  };
  assert.equal(sent.FromEmailAddress, "noreply@nestdev.ru");
  assert.deepEqual(sent.Destination.ToAddresses, ["ivan.petrov@yandex.ru"]);
  assert.deepEqual(sent.ReplyToAddresses, ["support@nestdev.ru"], "ответ человека уходит в поддержку");
  assert.equal(sent.Content.Simple.Subject.Data, "Обращение " + ticket.id + ": идея");
  assert.match(sent.Content.Simple.Body.Text.Data, /Проверка ответа из админки/);
  assert.match(
    sent.Content.Simple.Body.Html.Data,
    /<a href="https:\/\/nestdev\.ru\/docs">https:\/\/nestdev\.ru\/docs<\/a>/,
    "адрес из текста становится ссылкой, а точка после него — нет",
  );
  assert.doesNotMatch(sent.Content.Simple.Body.Text.Data, /[Оо]тписаться/, "в ответе нет строки отписки: это не рассылка");

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

test("неудачная отправка попадает в переписку с причиной", async () => {
  answer = () => ({ status: 500, body: JSON.stringify({ message: "внутренняя ошибка" }) });

  const response = await reply(ticket.id, { subject: "Про ваше обращение", body: "Здравствуйте! Второй ответ." });
  assert.equal(response.statusCode, 502);
  const body = response.json() as { error: string; code: string };
  assert.equal(body.code, "send_failed");
  assert.match(body.error, /Postbox отказал \(500\)/);

  const messages = await listSupportMessages(ticket.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].status, "failed");
  assert.equal(messages[1].subject, "Про ваше обращение", "своя тема сохраняется как есть");
  assert.match(messages[1].error, /500/);
  assert.equal(messages[1].messageId, "");

  const events = await listAudit({ action: "support.reply.failed" });
  assert.equal(events.length, 1);
  assert.equal(events[0].target, ticket.id);

  answer = () => ({ status: 200, body: JSON.stringify({ MessageId: "msg-2" }) });
});

test("ответы считаются в тот же суточный предел, что и рассылка", async () => {
  // Предел — на одно письмо: один ответ уже ушёл, значит следующий должен быть отклонён.
  // Отказы в счёт не идут: в переписке есть и неудачная отправка, но она не занимает квоту.
  process.env.POSTBOX_DAILY_LIMIT = "1";
  try {
    const attemptsBefore = outbound.length;
    const response = await reply(ticket.id, { body: "Здравствуйте! Третий ответ." });
    assert.equal(response.statusCode, 429);
    const body = response.json() as { error: string; code: string };
    assert.equal(body.code, "quota_exceeded");
    assert.match(body.error, /1 из 1 за сутки/);
    assert.equal(outbound.length, attemptsBefore, "сверх предела письмо не уходит");
  } finally {
    process.env.POSTBOX_DAILY_LIMIT = "200";
  }
});

test.after(() => {
  postbox.close();
});
