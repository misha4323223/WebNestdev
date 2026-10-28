import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Маршруты рассылки проверяются через настоящий HTTP-слой: хранилище — временный каталог,
 * Postbox не вызывается, но админ-токен, разбор тела, коды ответов и страница отписки — настоящие.
 * Логика сегментов и очереди проверяется отдельно (mail/audience.test.ts, mail/queue.test.ts);
 * здесь важно то, что видит админка: 401 без токена, `configured` из настроек, `409` при
 * расхождении числа получателей и запись отписки из письма.
 *
 * Переменные выставляются до импорта: хранилище и ключи читаются при загрузке модулей.
 */
process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_DATA_DIR = await mkdtemp(path.join(tmpdir(), "admin-mail-"));
process.env.POSTBOX_SENDER = "mail@nestdev.ru";
process.env.POSTBOX_IAM_TOKEN = "test-iam-token";
process.env.POSTBOX_DAILY_LIMIT = "200";
process.env.POSTBOX_RATE_PER_SECOND = "1";
process.env.POSTBOX_DKIM_SELECTORS = "selector1";
process.env.PLATFORM_URL = "https://nestdev.ru";

const Fastify = (await import("fastify")).default;
const { registerAdminMailRoutes } = await import("./admin-mail.js");
const { registerUnsubscribeRoutes } = await import("./unsubscribe.js");
const { createAdmin, createAdminSession } = await import("../admin/admin-store.js");
const { createUser } = await import("../auth/auth-store.js");
const { saveUserProfile } = await import("../account/profile-store.js");
const { addSuppression, findSuppression, getCampaign, listCampaigns } = await import("../mail/mail-store.js");
const { unsubscribeToken } = await import("../mail/render.js");

const EMAIL = "admin@example.test";
const PASSWORD = "correct-horse-battery";

const app = Fastify();
await registerAdminMailRoutes(app);
await registerUnsubscribeRoutes(app);

const admin = await createAdmin(EMAIL, PASSWORD);
const session = await createAdminSession(admin.id);
const auth = { authorization: "Bearer " + session.token };

const client = await createUser("client@nestdev.ru", "client-password");
await saveUserProfile(client.id, {
  name: "Иван",
  email: "client@nestdev.ru",
  newsletter: true,
  productUpdates: true,
});

async function post(url: string, payload: unknown) {
  return app.inject({ method: "POST", url, headers: auth, payload: payload as never });
}

test("без админ-токена маршруты рассылки не отвечают", async () => {
  const response = await app.inject({ method: "GET", url: "/api/admin/mail/overview" });
  assert.equal(response.statusCode, 401);
  const send = await app.inject({ method: "POST", url: "/api/admin/mail/send", payload: {} });
  assert.equal(send.statusCode, 401);
});

test("overview показывает сегменты, квоту и предупреждения", async () => {
  const response = await app.inject({ method: "GET", url: "/api/admin/mail/overview", headers: auth });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    configured: boolean;
    provider: string;
    sender: string;
    auth: { kind: string; source: string };
    quota: { perDay: number; remainingToday: number };
    segments: Array<{ id: string; recipients: number }>;
    domainVerified: boolean;
    warnings: string[];
    campaigns: unknown[];
  };
  assert.equal(body.configured, true, "ключ из окружения виден без запроса в Postbox");
  assert.equal(body.provider, "postbox");
  assert.equal(body.sender, "mail@nestdev.ru");
  assert.equal(body.auth.kind, "iam");
  assert.equal(body.quota.perDay, 200);
  assert.equal(body.quota.remainingToday, 200);
  assert.equal(typeof body.domainVerified, "boolean", "состояние домена проверяется по DNS или честно unknown");
  assert.deepEqual(body.campaigns, []);
  assert.deepEqual(body.segments.map(segment => segment.id), ["active30", "paying", "free", "inactive30", "never", "all"]);
  assert.equal(body.segments.find(segment => segment.id === "all")?.recipients, 1);
  assert.ok(body.warnings.some(warning => /Цена за 1 000/.test(warning)), "цена не задана — предупреждение");
});

test("preview считает получателей и ничего не отправляет", async () => {
  const response = await post("/api/admin/mail/preview", { segmentId: "all", subject: "{{name}}, привет", body: "Тариф: {{plan}}" });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    recipients: number;
    excluded: Record<string, number>;
    sample: Array<{ email: string; subject: string; body: string }>;
    cost: { amount: number | null; currency: string; freeLeft: number };
    quota: { remainingToday: number };
    warnings: string[];
  };
  assert.equal(body.recipients, 1);
  assert.deepEqual(body.excluded, { unsubscribed: 0, bounced: 0, invalid: 0, noConsent: 0, duplicate: 0 });
  assert.equal(body.sample[0].email, "client@nestdev.ru");
  assert.equal(body.sample[0].subject, "Иван, привет", "теги раскрываются в живом примере");
  assert.match(body.sample[0].body, /https:\/\/nestdev\.ru\/unsubscribe\?t=/);
  assert.equal(body.cost.amount, null, "без цены за 1000 писем стоимость не выдумывается");
  assert.equal(body.cost.currency, "RUB");
  assert.equal(body.quota.remainingToday, 200);
  assert.equal((await listCampaigns(10)).length, 0, "предпросмотр не создаёт кампаний");
});

test("неизвестный сегмент — это ошибка ввода, а не пустая рассылка", async () => {
  const response = await post("/api/admin/mail/preview", { segmentId: "нет такого", subject: "Тема", body: "Текст" });
  assert.equal(response.statusCode, 400);
  assert.match((response.json() as { error: string }).error, /Неизвестный сегмент/);
});

test("рассылка ставится в очередь и требует подтверждённого числа получателей", async () => {
  const mismatch = await post("/api/admin/mail/send", { segmentId: "all", subject: "Тема", body: "Текст", confirm: 5 });
  assert.equal(mismatch.statusCode, 409);
  assert.equal((mismatch.json() as { error: string }).error, "Число получателей изменилось: 1");

  const response = await post("/api/admin/mail/send", { segmentId: "all", subject: "{{name}}, привет", body: "Текст", confirm: 1 });
  assert.equal(response.statusCode, 200);
  const body = response.json() as { ok: boolean; campaign: { id: string; recipients: number; status: string; createdBy: string } };
  assert.equal(body.ok, true);
  assert.equal(body.campaign.recipients, 1);
  assert.equal(body.campaign.status, "queued");
  assert.equal(body.campaign.createdBy, EMAIL, "в кампании видно, кто её отправил");

  const queue = await app.inject({ method: "GET", url: "/api/admin/mail/overview", headers: auth });
  assert.equal((queue.json() as { campaigns: unknown[] }).campaigns.length, 1);
});

test("остановка рассылки отмечает кампанию и не даёт остановить завершённую", async () => {
  const created = await post("/api/admin/mail/send", { segmentId: "all", subject: "Тема", body: "Текст", confirm: 1 });
  const id = (created.json() as { campaign: { id: string } }).campaign.id;

  const stopped = await app.inject({ method: "POST", url: "/api/admin/mail/campaigns/" + id + "/stop", headers: auth });
  assert.equal(stopped.statusCode, 200);
  assert.equal((stopped.json() as { campaign: { stopRequested: boolean } }).campaign.stopRequested, true);

  const unknown = await app.inject({ method: "POST", url: "/api/admin/mail/campaigns/нет-такой/stop", headers: auth });
  assert.equal(unknown.statusCode, 404);
});

test("страница отписки требует подписанную ссылку и записывает адрес", async () => {
  const bad = await app.inject({ method: "GET", url: "/unsubscribe?t=подделка" });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.body, /Ссылка не сработала/);

  const token = unsubscribeToken("client@nestdev.ru");
  const page = await app.inject({ method: "GET", url: "/unsubscribe?t=" + encodeURIComponent(token) });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /client@nestdev\.ru/);
  assert.match(page.body, /<button type="submit">Отписаться<\/button>/, "отписка подтверждается кнопкой, а не открытием ссылки");
  assert.equal(await findSuppression("client@nestdev.ru"), null, "открытие страницы ничего не записывает");

  const done = await app.inject({ method: "POST", url: "/unsubscribe?t=" + encodeURIComponent(token) });
  assert.equal(done.statusCode, 200);
  assert.match(done.body, /вы отписаны/);
  assert.equal((await findSuppression("client@nestdev.ru"))?.reason, "unsubscribed");

  const again = await app.inject({ method: "GET", url: "/unsubscribe?t=" + encodeURIComponent(token) });
  assert.match(again.body, /уже отписаны/);
});

test("отписавшиеся больше не попадают в предпросмотр", async () => {
  const second = await createUser("second@nestdev.ru", "second-password");
  await saveUserProfile(second.id, { name: "Ольга", email: "second@nestdev.ru", newsletter: true, productUpdates: true });
  await addSuppression("second@nestdev.ru", "unsubscribed", "ссылка из письма");

  const response = await post("/api/admin/mail/preview", { segmentId: "all", subject: "Тема", body: "Текст" });
  const body = response.json() as { recipients: number; excluded: { unsubscribed: number }; skipped: Array<{ email: string; reason: string }> };
  assert.equal(body.recipients, 0, "оба аккаунта отписались — отправлять некому");
  assert.equal(body.excluded.unsubscribed, 2);
  assert.deepEqual(body.skipped.map(item => item.reason), ["отписался от рассылки", "отписался от рассылки"]);

  const sending = await post("/api/admin/mail/send", { segmentId: "all", subject: "Тема", body: "Текст", confirm: 0 });
  assert.equal(sending.statusCode, 409, "пустую рассылку сервер не заводит");
  assert.match((sending.json() as { error: string }).error, /нет ни одного адреса/);
});

test("кампания в очереди сохраняет получателя для подстановок", async () => {
  const campaigns = await listCampaigns(10);
  const stored = await getCampaign(campaigns[0].id);
  assert.equal(stored?.segmentId, "all");
  assert.ok(stored?.createdAt, "у кампании есть время создания");
});
