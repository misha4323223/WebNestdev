import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Проверка главного правила 376-ФЗ: письмо-предупреждение уходит раньше списания, и без письма
 * подписка в очередь на оплату не попадает.
 *
 * Свипер обходит все подписки в хранилище, поэтому у теста свой каталог данных: общий принёс бы
 * в утверждения подписки из соседних файлов тестов. Настройки магазина читаются из окружения,
 * когда панель ничего не сохраняла: тест выставляет периодические платежи сам.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "billing-recurring-"));
process.env.WEBNESTDEV_DATA_DIR = root;
const { notifyUpcomingRenewals } = await import("./recurring.js");
const { createPayment, getSubscriptionRecord, listDueSubscriptions, markPaymentPaid } = await import("./store.js");
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const MANAGED = ["ROBOKASSA_LOGIN", "ROBOKASSA_PASSWORD_1", "ROBOKASSA_PASSWORD_2", "ROBOKASSA_RECURRING", "ROBOKASSA_HASH", "ROBOKASSA_TEST_MODE"] as const;

async function withShop<T>(run: () => Promise<T>): Promise<T> {
  const previous = new Map(MANAGED.map(name => [name, process.env[name]]));
  process.env.ROBOKASSA_LOGIN = "nestdev";
  process.env.ROBOKASSA_PASSWORD_1 = "pass1";
  process.env.ROBOKASSA_PASSWORD_2 = "pass2";
  process.env.ROBOKASSA_RECURRING = "1";
  delete process.env.ROBOKASSA_TEST_MODE;
  try { return await run(); }
  finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("предупреждение о списании уходит один раз и до списания", async () => {
  await withShop(async () => {
    const userId = "billing-" + randomUUID();
    const now = new Date("2026-06-01T00:00:00.000Z");
    const payment = await createPayment({ userId, plan: "pro", amount: 990, autoRenew: true });
    await markPaymentPaid(payment.invId, now);

    // До окна предупреждения (срок 1 июля) писем нет.
    const calls: string[] = [];
    const early = await notifyUpcomingRenewals(new Date("2026-06-10T00:00:00.000Z"), async record => { calls.push(record.userId); return true; });
    assert.deepEqual(calls, [], "раньше срока писем нет");
    assert.equal(early.notified, 0);

    // За трое суток до срока свипер отправляет письмо и ставит отметку.
    const noticed = await notifyUpcomingRenewals(new Date("2026-06-29T12:00:00.000Z"), async () => true);
    assert.equal(noticed.notified, 1);
    assert.ok((await getSubscriptionRecord(userId))?.noticeAt, "отметка о письме сохранена");

    // Повтор письма не дублирует: отметка уже стоит.
    const again = await notifyUpcomingRenewals(new Date("2026-06-29T18:00:00.000Z"), async () => { throw new Error("письма быть не должно"); });
    assert.equal(again.notified, 0);

    // И только теперь подписка попадает в очередь на списание.
    const due = await listDueSubscriptions(new Date("2026-07-01T00:00:01.000Z"));
    assert.equal(due.length, 1);
    assert.equal(due[0]?.userId, userId);
  });
});

test("подписка без отправленного предупреждения не списывается", async () => {
  await withShop(async () => {
    const userId = "billing-" + randomUUID();
    const now = new Date("2026-08-01T00:00:00.000Z");
    const payment = await createPayment({ userId, plan: "pro", amount: 990, autoRenew: true });
    await markPaymentPaid(payment.invId, now);
    assert.equal((await getSubscriptionRecord(userId))?.noticeAt, null);

    const due = await listDueSubscriptions(new Date("2026-09-01T00:00:01.000Z"));
    assert.ok(!due.some(record => record.userId === userId), "письма не было — списания нет");
  });
});
