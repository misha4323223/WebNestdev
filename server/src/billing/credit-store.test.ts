import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(tmpdir(), "credit-store-"));
process.env.WEBNESTDEV_DATA_DIR = root;

const {
  createCreditPurchase,
  creditBalance,
  getCreditPurchase,
  listCreditPurchases,
  markCreditPurchasePaid,
  recordCreditConsumption,
} = await import("./credit-store.js");

test.after(async () => { await rm(root, { recursive: true, force: true }); });

test("a paid credit purchase is added to the ledger and repeated payment notices are idempotent", async () => {
  const userId = "credit-purchase-" + randomUUID();
  const purchase = await createCreditPurchase({
    userId,
    packId: "credits-5000",
    credits: 5_000,
    amount: 1_190,
  });
  assert.equal(purchase.status, "pending");
  assert.equal(await creditBalance(userId), 0, "до уведомления банка кредиты не зачисляются");
  assert.equal((await getCreditPurchase(purchase.invId))?.paidAt, null);

  const paid = await markCreditPurchasePaid(purchase.invId);
  assert.equal(paid?.alreadyPaid, false);
  assert.equal((await getCreditPurchase(purchase.invId))?.status, "paid");
  assert.equal(await creditBalance(userId), 5_000);

  const repeated = await markCreditPurchasePaid(purchase.invId);
  assert.equal(repeated?.alreadyPaid, true);
  assert.equal(await creditBalance(userId), 5_000, "повторное уведомление не зачисляет пакет второй раз");
  assert.equal((await listCreditPurchases(userId)).length, 1);
});

test("credit usage is written once per run and never drives the purchased balance below zero", async () => {
  const userId = "credit-usage-" + randomUUID();
  const purchase = await createCreditPurchase({
    userId,
    packId: "credits-1000",
    credits: 1_000,
    amount: 290,
  });
  await markCreditPurchasePaid(purchase.invId);

  assert.equal(await recordCreditConsumption(userId, "run-a", 400), 400);
  assert.equal(await creditBalance(userId), 600);
  assert.equal(await recordCreditConsumption(userId, "run-a", 400), 0, "повторный запуск не списывает ещё раз");
  assert.equal(await creditBalance(userId), 600);

  // Превышение больше остатка: списываем только остаток, отрицательного долга не создаём.
  assert.equal(await recordCreditConsumption(userId, "run-b", 900), 600);
  assert.equal(await creditBalance(userId), 0);
  assert.equal(await recordCreditConsumption(userId, "run-c", 100), 0);
  assert.equal(await creditBalance(userId), 0);
});
