import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Реестр платежей проверяется на настоящих записях магазина: платёж, подтверждённый уведомлением,
 * зависший `pending`, отказ и подписка, у которой автопродление уже падало. Главное здесь — что
 * цифры в ответе сходятся со списком под ними и что «истекает на этой неделе» действительно
 * показывает истекающую подписку, а не всё подряд.
 */
process.env.WEBNESTDEV_STORAGE = "json";
const root = await mkdtemp(path.join(tmpdir(), "admin-billing-"));
process.env.WEBNESTDEV_DATA_DIR = root;

const Fastify = (await import("fastify")).default;
const { registerAdminBillingRoutes, median, percentile } = await import("./admin-billing.js");
const { createAdmin, createAdminSession } = await import("../admin/admin-store.js");
const { createUser } = await import("../auth/auth-store.js");
const { createPayment, getSubscriptionRecord, markPaymentFailed, markPaymentPaid, postponeRenewal } = await import("../billing/store.js");
const { recordRunUsage } = await import("../account/usage-store.js");

const app = Fastify();
await registerAdminBillingRoutes(app);
await app.ready();

const admin = await createAdmin("billing-admin@example.test", "correct-horse-battery");
const session = await createAdminSession(admin.id);
const auth = { authorization: "Bearer " + session.token };

test.after(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

test("медиана и p90 считаются по правилам, а не «на глаз»", () => {
  assert.equal(median([]), 0);
  assert.equal(median([7]), 7);
  assert.equal(median([10, 20, 30]), 20);
  // Чётное число: середина двух центральных, иначе «типичный» подписчик был бы завышен.
  assert.equal(median([10, 20, 30, 40]), 25);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
  assert.equal(percentile([42], 0.9), 42);
});

test("реестр отдаёт деньги, платежи, истекающие подписки и калибровку пула", async () => {
  const payer = await createUser("payer@example.test", "user-password-123");
  const renewing = await createUser("renewing@example.test", "user-password-123");
  const failing = await createUser("failing@example.test", "user-password-123");

  const paid = await createPayment({ userId: payer.id, plan: "pro", amount: 990 });
  await markPaymentPaid(paid.invId);
  await createPayment({ userId: payer.id, plan: "pro", amount: 990, kind: "renewal" });

  const renewal = await createPayment({ userId: renewing.id, plan: "pro", amount: 990 });
  await markPaymentPaid(renewal.invId);
  // Провалившееся автопродление: срок сдвинут на сутки вперёд, попытка одна.
  await postponeRenewal((await getSubscriptionRecord(renewing.id))!);

  const failedPayment = await createPayment({ userId: failing.id, plan: "pro", amount: 990 });
  await markPaymentFailed(failedPayment.invId);

  // Расход подписчика: 15 млн токенов — это и есть то, по чему калибруется тариф.
  await recordRunUsage(payer.id, {
    runId: "run-1",
    projectId: "project-1",
    model: "test-model",
    promptTokens: 10_000_000,
    completionTokens: 5_000_000,
    estimated: false,
  });

  const anonymous = await app.inject({ method: "GET", url: "/api/admin/billing" });
  assert.equal(anonymous.statusCode, 401);

  const response = await app.inject({ method: "GET", url: "/api/admin/billing?days=30", headers: auth });
  assert.equal(response.statusCode, 200);
  const body = response.json();

  assert.equal(body.money.paidCount, 2);
  assert.equal(body.money.paidRub, 1980);
  assert.equal(body.money.pendingCount, 1);
  assert.equal(body.money.failedCount, 1);
  assert.equal(body.money.renewalsPaid, 0);

  const listed = body.payments.find((payment: { invId: number }) => payment.invId === paid.invId);
  assert.equal(listed.email, payer.email);
  assert.equal(listed.status, "paid");
  assert.equal(listed.planName, "Плюс");

  assert.equal(body.subscriptions.expiringSoon.length, 1);
  assert.equal(body.subscriptions.expiringSoon[0].userId, renewing.id);
  assert.equal(body.subscriptions.expiringSoon[0].email, renewing.email);
  assert.ok(body.subscriptions.expiringSoon[0].daysLeft <= 7);

  assert.equal(body.subscriptions.renewalFailures[0].userId, renewing.id);
  assert.equal(body.subscriptions.renewalFailures[0].attempts, 1);

  // Два подписчика: у одного 15 млн токенов, у второго — ноль.
  assert.equal(body.pool.subscribers, 2);
  assert.equal(body.pool.medianTokens, 7_500_000);
  assert.equal(body.pool.p90Tokens, 15_000_000);
  // Пул «Плюса» — 50 млн, поэтому целиком его не выбрал никто.
  assert.equal(body.pool.fullPoolShare, 0);
  assert.equal(body.pool.fullPoolCount, 0);
});
