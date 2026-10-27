import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Очередь рассылки — то место, где ошибка дороже всего: письмо уходит живому человеку, а
 * остановить поток можно только через состояние в базе. Поэтому проверяется не «письмо ушло», а
 * состояния: повторная попытка не теряет счётчик, отписка и служебный адрес не отправляются,
 * остановка завершает кампанию, а предел не даёт отправлять сверх квоты.
 *
 * Очередь берёт самую старую незаконченную кампанию — как на живом сервере, где рассылка одна.
 * Поэтому каждый тест закрывает свою кампанию до конца, а тест про суточный предел стоит
 * последним: он намеренно оставляет кампанию в очереди.
 *
 * Хранилище — JSON во временном каталоге: очередь одна и та же для обоих бэкендов, а Postgres в
 * тесте не поднять. Переменные выставляются до импорта: хранилище читает их при загрузке модуля.
 */
process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_DATA_DIR = await mkdtemp(path.join(tmpdir(), "mail-queue-"));
process.env.POSTBOX_SENDER = "mail@nestdev.ru";
process.env.POSTBOX_DAILY_LIMIT = "200";
process.env.POSTBOX_RATE_PER_SECOND = "1";
process.env.PLATFORM_URL = "https://nestdev.ru";

const { mailTick, renderMail } = await import("./queue.js");
const {
  addSuppression,
  campaignCounters,
  createCampaign,
  getCampaign,
  lastSentAt,
  markRecipient,
  requestCampaignStop,
  requeueStuck,
  sentSince,
} = await import("./mail-store.js");

let sequence = 0;
const campaign = (recipients: Array<{ email: string; name?: string; userId?: string }>) =>
  createCampaign({
    subject: "Новое в NestDev — {{name}}",
    body: "Здравствуйте, {{name}}!\\n\\nВаш тариф: {{plan}}.",
    segmentId: "all",
    segmentLabel: "Все аккаунты",
    createdBy: "admin@nestdev.ru",
    recipients: recipients.map(item => ({ userId: item.userId ?? "", email: item.email, name: item.name ?? "" })),
  });

/** Отправка без сети: запоминает письма и позволяет задать отказ для конкретного адреса. */
function fakeSend(failures: string[] = []) {
  const sentTo: string[] = [];
  const send = async (message: { to: string }) => {
    if (failures.includes(message.to)) throw new Error("454 Maximum sending rate exceeded");
    sentTo.push(message.to);
    return { messageId: "msg-" + (sequence += 1), status: 200 };
  };
  return { send, sentTo };
}

type Send = (message: { to: string }) => Promise<{ messageId: string; status: number }>;

function deps(send: Send, limits = { perSecond: 1, dailyLimit: 200 }) {
  return { send: send as never, now: () => new Date(), limits: () => limits };
}

test("кампания отправляется по одному письму и завершается сама", async () => {
  const { send, sentTo } = fakeSend();
  const created = await campaign([{ email: "ivan@nestdev.ru", name: "Иван" }, { email: "olga@nestdev.ru", name: "Ольга" }]);

  assert.equal((await mailTick(deps(send))).state, "sent");
  assert.equal((await mailTick(deps(send))).state, "sent");
  assert.equal((await mailTick(deps(send))).state, "finished");
  assert.deepEqual(sentTo, ["ivan@nestdev.ru", "olga@nestdev.ru"]);

  const stored = await getCampaign(created.id);
  assert.equal(stored?.status, "sent");
  assert.equal(stored?.sent, 2);
  assert.equal(stored?.failed, 0);
  assert.ok(stored?.startedAt && stored?.finishedAt, "у завершённой кампании есть обе отметки времени");
  assert.ok(await lastSentAt(), "отметка последней отправки сохраняется");
});

test("упавшее письмо возвращается в конец очереди и уходит со второй попытки", async () => {
  const created = await campaign([{ email: "boom@nestdev.ru" }, { email: "olga@nestdev.ru" }]);
  const failing = fakeSend(["boom@nestdev.ru"]);
  assert.equal((await mailTick(deps(failing.send))).state, "failed");
  assert.equal((await mailTick(deps(failing.send))).state, "sent", "второй адрес уходит, несмотря на первый отказ");

  const { send } = fakeSend();
  assert.equal((await mailTick(deps(send))).state, "sent", "упавшее письмо повторяется");
  assert.equal((await mailTick(deps(send))).state, "finished");

  const stored = await getCampaign(created.id);
  assert.equal(stored?.status, "sent");
  assert.equal(stored?.failed, 0, "одна неудачная попытка не считается провалом письма");
  assert.equal(stored?.sent, 2);
});

test("после третьей попытки письмо помечается проваленным, кампания — failed", async () => {
  const created = await campaign([{ email: "dead@nestdev.ru" }]);
  const { send } = fakeSend(["dead@nestdev.ru"]);
  for (let attempt = 0; attempt < 3; attempt += 1) await mailTick(deps(send));
  assert.equal((await mailTick(deps(send))).state, "failed");

  const stored = await getCampaign(created.id);
  assert.equal(stored?.status, "failed", "кампания без единого доставленного письма — failed");
  assert.equal(stored?.failed, 1);
  assert.match(stored?.error ?? "", /Ни одно письмо не ушло/);
});

test("служебный адрес и отписка пропускаются без отправки", async () => {
  const first = await campaign([{ email: "79531814136@phone.webnestdev.local" }]);
  const { send, sentTo } = fakeSend();
  assert.equal((await mailTick(deps(send))).state, "skipped");
  assert.deepEqual(sentTo, []);
  assert.equal((await campaignCounters(first.id)).skipped, 1);
  assert.equal((await mailTick(deps(send))).state, "finished");

  await addSuppression("unsubscribed@nestdev.ru", "unsubscribed", "ссылка из письма");
  const second = await campaign([{ email: "unsubscribed@nestdev.ru" }]);
  assert.equal((await mailTick(deps(send))).state, "skipped");
  assert.equal((await mailTick(deps(send))).state, "finished");
  assert.equal((await getCampaign(second.id))?.status, "sent", "кампания из отписавшихся завершается без писем");
});

test("остановка завершает кампанию и не оставляет писем в очереди", async () => {
  const { send } = fakeSend();
  const created = await campaign([{ email: "stop1@nestdev.ru" }, { email: "stop2@nestdev.ru" }]);
  assert.equal((await mailTick(deps(send))).state, "sent");
  await requestCampaignStop(created.id);

  assert.equal((await mailTick(deps(send))).state, "stopped");
  const stored = await getCampaign(created.id);
  assert.equal(stored?.status, "stopped");
  assert.equal(stored?.sent, 1);
  assert.equal(stored?.skipped, 1, "остаток очереди помечен пропущенным");
  assert.ok(stored?.finishedAt);
});

test("письмо, застрявшее в отправке, возвращается в очередь при старте", async () => {
  const created = await campaign([{ email: "stuck@nestdev.ru" }]);
  await markRecipient(created.id, "stuck@nestdev.ru", { status: "sending" });
  assert.equal(await requeueStuck(), 1);

  const { send, sentTo } = fakeSend();
  assert.equal((await mailTick(deps(send))).state, "sent");
  assert.deepEqual(sentTo, ["stuck@nestdev.ru"]);
  assert.equal((await mailTick(deps(send))).state, "finished");
});

test("суточный предел останавливает очередь, письмо остаётся в очереди", async () => {
  const before = await sentSince(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const { send, sentTo } = fakeSend();
  const created = await campaign([{ email: "limit1@nestdev.ru" }, { email: "limit2@nestdev.ru" }]);
  // Предел — на одно письмо больше уже отправленного: в базе теста письма от прошлых сценариев.
  const limited = deps(send, { perSecond: 1, dailyLimit: before + 1 });

  assert.equal((await mailTick(limited)).state, "sent");
  assert.equal((await mailTick(limited)).state, "limited");
  assert.deepEqual(sentTo, ["limit1@nestdev.ru"], "сверх предела ничего не отправляется");
  assert.equal(await sentSince(new Date(Date.now() - 24 * 60 * 60 * 1000)), before + 1);

  const stored = await getCampaign(created.id);
  assert.equal(stored?.status, "sending", "кампания не завершается: очередь продолжится, когда предел освободится");
  assert.match(stored?.error ?? "", /суточный предел/, "причина видна в карточке кампании");
});

test("письмо раскрывает теги и несёт ссылку отписки", () => {
  const mail = renderMail(
    { subject: "{{name}}, тариф {{plan}}", body: "Здравствуйте, {{name}}! Проект: {{project}}." },
    { email: "ivan@nestdev.ru", name: "Иван" },
    { plan: "Плюс", project: "Магазин", platformUrl: "https://nestdev.ru" },
  );
  assert.equal(mail.subject, "Иван, тариф Плюс");
  assert.match(mail.text, /Магазин/);
  assert.match(mail.text, /https:\/\/nestdev\.ru\/unsubscribe\?t=/);
  assert.match(mail.html, /<a href="https:\/\/nestdev\.ru\/unsubscribe\?t=/);
});

test("без имени в письме не остаётся дырки", () => {
  const mail = renderMail(
    { subject: "{{name}}, привет", body: "Здравствуйте, {{name}}!" },
    { email: "ivan.petrov@nestdev.ru", name: "" },
    { plan: "Старт", project: "проект", platformUrl: "https://nestdev.ru" },
  );
  assert.equal(mail.subject, "ivan.petrov, привет", "пустое имя заменяется частью адреса, а не пустотой");
});
