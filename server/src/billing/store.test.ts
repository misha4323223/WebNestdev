import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createPayment,
  getSubscriptionRecord,
  hasPendingPayment,
  listPayments,
  markPaymentPaid,
  planForUser,
  setAutoRenew,
} from "./store.js";

const newUser = () => "billing-" + randomUUID();

test("a paid invoice activates the plan for a month and a repeated notification changes nothing", async () => {
  const userId = newUser();
  const payment = await createPayment({ userId, plan: "pro", amount: 990 });
  assert.equal(payment.status, "pending");
  assert.equal(await planForUser(userId), "free", "выставленный счёт ещё не даёт тариф");

  const now = new Date("2026-03-10T10:00:00.000Z");
  const first = await markPaymentPaid(payment.invId, { autoRenew: false }, now);
  assert.equal(first?.alreadyPaid, false);
  assert.equal(await planForUser(userId, now), "pro");

  const record = await getSubscriptionRecord(userId);
  assert.equal(record?.renewsAt, "2026-04-10T10:00:00.000Z");
  assert.equal(record?.status, "active");
  assert.equal(record?.parentInvId, payment.invId);

  // Робокасса повторяет уведомление, пока не получит OK: второй раз срок не удваивается.
  const second = await markPaymentPaid(payment.invId, { autoRenew: true }, now);
  assert.equal(second?.alreadyPaid, true);
  assert.equal((await getSubscriptionRecord(userId))?.renewsAt, record?.renewsAt);
  assert.equal((await listPayments(userId))[0]?.status, "paid");

  // Подписка кончилась — тариф сразу бесплатный, без отдельной задачи «понизить всех».
  assert.equal(await planForUser(userId, new Date("2026-04-10T10:00:01.000Z")), "free");
});

test("a renewal extends the paid period instead of replacing it and keeps the parent invoice", async () => {
  const userId = newUser();
  const now = new Date("2026-05-01T09:00:00.000Z");
  const initial = await createPayment({ userId, plan: "team", amount: 2990 });
  await markPaymentPaid(initial.invId, { autoRenew: true }, now);

  // Продление внутри оплаченного срока: месяц добавляется к концу, а не к сегодняшнему дню.
  const renewal = await createPayment({ userId, plan: "team", amount: 2990, kind: "renewal", parentInvId: initial.invId });
  await markPaymentPaid(renewal.invId, { autoRenew: true }, new Date("2026-05-11T09:00:00.000Z"));

  const record = await getSubscriptionRecord(userId);
  assert.equal(record?.renewsAt, "2026-07-01T09:00:00.000Z");
  assert.equal(record?.parentInvId, initial.invId, "ребёнок серии помнит первый платёж");
  assert.equal(record?.startedAt, now.toISOString(), "дата начала подписки не переписывается продлением");
});

test("auto-renew can be turned off and on without losing the paid days", async () => {
  const userId = newUser();
  const now = new Date("2026-06-01T00:00:00.000Z");
  const payment = await createPayment({ userId, plan: "pro", amount: 990 });
  await markPaymentPaid(payment.invId, { autoRenew: true }, now);

  const off = await setAutoRenew(userId, false, now);
  assert.equal(off?.autoRenew, false);
  assert.equal(off?.status, "canceled");
  assert.equal(await planForUser(userId, now), "pro", "выключенное автопродление не отнимает оплаченный месяц");

  const on = await setAutoRenew(userId, true, now);
  assert.equal(on?.status, "active");
  assert.equal(await setAutoRenew(newUser(), true, now), null, "у аккаунта без подписки включать нечего");
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
