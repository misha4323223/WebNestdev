import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * У файла свой каталог данных: `node --test` даёт каждому файлу отдельный процесс, и переменная
 * встаёт раньше, чем хранилище вычислит путь. Импорт поэтому динамический — статический
 * выполнился бы до присваивания, и счета легли бы в общий каталог разработки.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "billing-store-"));
process.env.WEBNESTDEV_DATA_DIR = root;
const {
  createPayment,
  getSubscriptionRecord,
  hasPendingPayment,
  listPayments,
  markNoticeSent,
  markPaymentPaid,
  planForUser,
  setAutoRenew,
} = await import("./store.js");
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const newUser = () => "billing-" + randomUUID();

test("a paid invoice activates the plan for a month and a repeated notification changes nothing", async () => {
  const userId = newUser();
  // Согласия на автопродление в счёте нет: платёж разовый, и продление по нему не включается.
  const payment = await createPayment({ userId, plan: "pro", amount: 990 });
  assert.equal(payment.status, "pending");
  assert.equal(payment.autoRenew, false, "без отдельной отметки согласия нет");
  assert.equal(await planForUser(userId), "free", "выставленный счёт ещё не даёт тариф");

  const now = new Date("2026-03-10T10:00:00.000Z");
  const first = await markPaymentPaid(payment.invId, now);
  assert.equal(first?.alreadyPaid, false);
  assert.equal(await planForUser(userId, now), "pro");

  const record = await getSubscriptionRecord(userId);
  assert.equal(record?.renewsAt, "2026-04-10T10:00:00.000Z");
  assert.equal(record?.status, "active");
  assert.equal(record?.parentInvId, payment.invId);
  assert.equal(record?.autoRenew, false, "разовый платёж не включает автопродление");

  // Робокасса повторяет уведомление, пока не получит OK: второй раз срок не удваивается.
  const second = await markPaymentPaid(payment.invId, now);
  assert.equal(second?.alreadyPaid, true);
  assert.equal((await getSubscriptionRecord(userId))?.renewsAt, record?.renewsAt);
  assert.equal((await listPayments(userId))[0]?.status, "paid");

  // Подписка кончилась — тариф сразу бесплатный, без отдельной задачи «понизить всех».
  assert.equal(await planForUser(userId, new Date("2026-04-10T10:00:01.000Z")), "free");
});

test("a renewal extends the paid period instead of replacing it and keeps the parent invoice", async () => {
  const userId = newUser();
  const now = new Date("2026-05-01T09:00:00.000Z");
  const initial = await createPayment({ userId, plan: "team", amount: 2990, autoRenew: true });
  await markPaymentPaid(initial.invId, now);

  // Продление внутри оплаченного срока: месяц добавляется к концу, а не к сегодняшнему дню.
  const renewal = await createPayment({ userId, plan: "team", amount: 2990, kind: "renewal", parentInvId: initial.invId, autoRenew: true });
  await markPaymentPaid(renewal.invId, new Date("2026-05-11T09:00:00.000Z"));

  const record = await getSubscriptionRecord(userId);
  assert.equal(record?.renewsAt, "2026-07-01T09:00:00.000Z");
  assert.equal(record?.autoRenew, true, "согласие из счёта включает продление и переживает списание");
  assert.equal(record?.parentInvId, initial.invId, "ребёнок серии помнит первый платёж");
  assert.equal(record?.startedAt, now.toISOString(), "дата начала подписки не переписывается продлением");
});

test("auto-renew can be turned off and on without losing the paid days", async () => {
  const userId = newUser();
  const now = new Date("2026-06-01T00:00:00.000Z");
  const payment = await createPayment({ userId, plan: "pro", amount: 990, autoRenew: true });
  await markPaymentPaid(payment.invId, now);

  const off = await setAutoRenew(userId, false, now);
  assert.equal(off?.autoRenew, false);
  assert.equal(off?.status, "canceled");
  assert.equal(await planForUser(userId, now), "pro", "выключенное автопродление не отнимает оплаченный месяц");

  const on = await setAutoRenew(userId, true, now);
  assert.equal(on?.status, "active");
  assert.equal(await setAutoRenew(newUser(), true, now), null, "у аккаунта без подписки включать нечего");
});

test("a paid extension resets the pre-charge notice: the new period needs a new warning", async () => {
  const userId = newUser();
  const now = new Date("2026-05-01T09:00:00.000Z");
  const payment = await createPayment({ userId, plan: "pro", amount: 990, autoRenew: true });
  await markPaymentPaid(payment.invId, now);
  await markNoticeSent(userId, new Date("2026-05-29T09:00:00.000Z"));
  assert.ok((await getSubscriptionRecord(userId))?.noticeAt, "письмо за текущий период отмечено");

  const renewal = await createPayment({ userId, plan: "pro", amount: 990, kind: "renewal", parentInvId: payment.invId, autoRenew: true });
  await markPaymentPaid(renewal.invId, new Date("2026-06-01T09:00:00.000Z"));
  assert.equal((await getSubscriptionRecord(userId))?.noticeAt, null, "новый период — новое предупреждение");
});

test("a pending renewal is visible to the sweeper so it does not charge twice", async () => {
  const userId = newUser();
  const now = new Date();
  assert.equal(await hasPendingPayment(userId, "renewal", new Date(now.getTime() - 3_600_000).toISOString()), false);
  const renewal = await createPayment({ userId, plan: "pro", amount: 990, kind: "renewal", parentInvId: 100001 });
  assert.equal(await hasPendingPayment(userId, "renewal", new Date(now.getTime() - 3_600_000).toISOString()), true);
  assert.equal(await hasPendingPayment(userId, "initial", new Date(now.getTime() - 3_600_000).toISOString()), false, "вид счёта учитывается");
  assert.equal(renewal.kind, "renewal");
});
