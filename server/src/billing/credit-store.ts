import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { getTable, isYdbEnabled, ydbQuery } from "../storage/ydb.js";
import { allocateInvoiceId } from "./store.js";

/**
 * Докупленные кредиты.
 *
 * Покупка — отдельный счёт Робокассы, а не продление подписки. После подтверждения оплаты в
 * журнал `credit_ledger` добавляется положительная запись, а расходы сверх месячного лимита
 * тарифа — отрицательные. Баланс — сумма журнала, поэтому повторное уведомление Робокассы не
 * может зачислить пакет дважды.
 *
 * Докупленные кредиты не сгорают при смене месяца и расходуются только после кредитов тарифа.
 * Журнал также хранит `run_id`: повторная запись одного запуска не спишет кредиты второй раз.
 */

export type CreditPurchaseStatus = "pending" | "paid" | "failed";

export type CreditPurchase = {
  invId: number;
  userId: string;
  packId: string;
  credits: number;
  amount: number;
  status: CreditPurchaseStatus;
  createdAt: string;
  paidAt: string | null;
};

export type CreditLedgerEntry = {
  id: string;
  userId: string;
  kind: "purchase" | "usage";
  /** Положительное число для покупки, отрицательное для расхода. */
  credits: number;
  invId: number | null;
  runId: string | null;
  createdAt: string;
};

const root = process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");
const locks = new Map<string, Promise<unknown>>();
const purchasesFile = () => path.join(root, "billing", "credit-purchases.json");
const ledgerFile = () => path.join(root, "billing", "credit-ledger.json");

async function withLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const current = previous.then(() => gate);
  locks.set(key, current);
  await previous;
  try { return await action(); }
  finally { release(); if (locks.get(key) === current) locks.delete(key); }
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(file, "utf8")) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = file + "." + randomUUID() + ".tmp";
  try { await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 }); await rename(temp, file); }
  catch (error) { try { await unlink(temp); } catch {} throw error; }
}

type PurchaseRow = {
  inv_id: number | string | bigint;
  user_id: string;
  pack_id: string;
  credits: number | string | bigint;
  amount: number | string | bigint;
  status: string;
  created_at: string;
  paid_at: string | null;
};

function purchaseFromRow(row: PurchaseRow): CreditPurchase {
  return {
    invId: Number(row.inv_id),
    userId: row.user_id,
    packId: row.pack_id,
    credits: Number(row.credits),
    amount: Number(row.amount),
    status: row.status === "paid" || row.status === "failed" ? row.status : "pending",
    createdAt: row.created_at,
    paidAt: row.paid_at || null,
  };
}

export async function createCreditPurchase(input: {
  userId: string;
  packId: string;
  credits: number;
  amount: number;
}): Promise<CreditPurchase> {
  const purchase: CreditPurchase = {
    invId: await allocateInvoiceId(),
    userId: input.userId,
    packId: input.packId,
    credits: Math.max(1, Math.round(input.credits)),
    amount: Math.max(1, Math.round(input.amount)),
    status: "pending",
    createdAt: new Date().toISOString(),
    paidAt: null,
  };
  if (isYdbEnabled()) {
    await ydbQuery()`
      INSERT INTO ${ydbQuery().identifier(getTable("credit_purchases"))}
        (inv_id, user_id, pack_id, credits, amount, status, created_at, paid_at)
      VALUES (${purchase.invId}, ${purchase.userId}, ${purchase.packId}, ${purchase.credits}, ${purchase.amount}, ${purchase.status}, ${purchase.createdAt}, ${purchase.paidAt})
    `;
    return purchase;
  }
  await withLock("credit-purchases", async () => {
    const purchases = await readJson<CreditPurchase[]>(purchasesFile(), []);
    purchases.push(purchase);
    await writeJsonAtomic(purchasesFile(), purchases);
  });
  return purchase;
}

export async function getCreditPurchase(invId: number): Promise<CreditPurchase | null> {
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<PurchaseRow[]>`
      SELECT inv_id, user_id, pack_id, credits, amount, status, created_at, paid_at
      FROM ${ydbQuery().identifier(getTable("credit_purchases"))}
      WHERE inv_id = ${invId}
      LIMIT 1
    `;
    return rows[0] ? purchaseFromRow(rows[0]) : null;
  }
  const purchases = await readJson<CreditPurchase[]>(purchasesFile(), []);
  return purchases.find(purchase => purchase.invId === invId) ?? null;
}

export async function listCreditPurchases(userId: string, limit = 20): Promise<CreditPurchase[]> {
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<PurchaseRow[]>`
      SELECT inv_id, user_id, pack_id, credits, amount, status, created_at, paid_at
      FROM ${ydbQuery().identifier(getTable("credit_purchases"))}
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return rows.map(purchaseFromRow);
  }
  const purchases = await readJson<CreditPurchase[]>(purchasesFile(), []);
  return purchases
    .filter(purchase => purchase.userId === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

async function ledgerEntryExists(id: string): Promise<boolean> {
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<Array<{ id: string }>>`
      SELECT id FROM ${ydbQuery().identifier(getTable("credit_ledger"))}
      WHERE id = ${id}
      LIMIT 1
    `;
    return rows.length > 0;
  }
  const entries = await readJson<CreditLedgerEntry[]>(ledgerFile(), []);
  return entries.some(entry => entry.id === id);
}

async function writeLedgerEntry(entry: CreditLedgerEntry): Promise<boolean> {
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<Array<{ id: string }>>`
      INSERT INTO ${ydbQuery().identifier(getTable("credit_ledger"))}
        (id, user_id, kind, credits, inv_id, run_id, created_at)
      VALUES (${entry.id}, ${entry.userId}, ${entry.kind}, ${entry.credits}, ${entry.invId}, ${entry.runId}, ${entry.createdAt})
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `;
    return rows.length > 0;
  }
  const entries = await readJson<CreditLedgerEntry[]>(ledgerFile(), []);
  if (entries.some(item => item.id === entry.id)) return false;
  entries.push(entry);
  await writeJsonAtomic(ledgerFile(), entries);
  return true;
}

async function addLedgerEntry(entry: CreditLedgerEntry): Promise<boolean> {
  // Один журнал на аккаунт: записи о покупках и расходах не должны перезаписывать друг друга.
  if (!isYdbEnabled()) return withLock("credit-ledger", () => writeLedgerEntry(entry));
  return writeLedgerEntry(entry);
}

/** Остаток докупленных кредитов. Отрицательный баланс не показываем: это долг платформы, не клиента. */
export async function creditBalance(userId: string): Promise<number> {
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<Array<{ balance: number | string | bigint | null }>>`
      SELECT COALESCE(SUM(credits), 0) AS balance
      FROM ${ydbQuery().identifier(getTable("credit_ledger"))}
      WHERE user_id = ${userId}
    `;
    return Math.max(0, Math.round(Number(rows[0]?.balance ?? 0)));
  }
  const entries = await readJson<CreditLedgerEntry[]>(ledgerFile(), []);
  return Math.max(0, entries
    .filter(entry => entry.userId === userId)
    .reduce((sum, entry) => sum + Number(entry.credits ?? 0), 0));
}

export async function markCreditPurchasePaid(invId: number, now = new Date()) {
  const purchase = await getCreditPurchase(invId);
  if (!purchase) return null;
  if (purchase.status === "paid") return { purchase, alreadyPaid: true as const };

  const paidAt = now.toISOString();
  // Сначала журнал, потом статус: если процесс упадёт между шагами, повторное уведомление
  // увидит pending, но не добавит кредиты второй раз благодаря id `purchase:<invId>`.
  await addLedgerEntry({
    id: "purchase:" + invId,
    userId: purchase.userId,
    kind: "purchase",
    credits: purchase.credits,
    invId,
    runId: null,
    createdAt: paidAt,
  });

  if (isYdbEnabled()) {
    await ydbQuery()`
      UPDATE ${ydbQuery().identifier(getTable("credit_purchases"))}
      SET status = 'paid', paid_at = ${paidAt}
      WHERE inv_id = ${invId}
    `;
  } else {
    await withLock("credit-purchases", async () => {
      const purchases = await readJson<CreditPurchase[]>(purchasesFile(), []);
      const stored = purchases.find(item => item.invId === invId);
      if (stored) { stored.status = "paid"; stored.paidAt = paidAt; }
      await writeJsonAtomic(purchasesFile(), purchases);
    });
  }

  return {
    purchase: { ...purchase, status: "paid" as const, paidAt },
    alreadyPaid: false as const,
  };
}

/**
 * Списывает часть запуска, которая вышла за месячный лимит тарифа.
 *
 * `credit-store` не решает, сколько стоит запуск: готовое число кредитов приходит из
 * `recordRunUsage`. Здесь только журнал и защита от повторного списания по тому же run_id.
 * Если докупленных кредитов меньше, чем превышение, списываем остаток: отрицательный баланс
 * клиента не должен превращаться в долг, который погасит следующая покупка.
 */
export async function recordCreditConsumption(userId: string, runId: string, credits: number, now = new Date()): Promise<number> {
  const amount = Math.max(0, Math.round(credits));
  if (amount <= 0) return 0;
  return withLock("credit-ledger", async () => {
    // run_id уникален в пределах аккаунта и дня, а не всей платформы: привязываем журнал к user.
    const id = "usage:" + userId + ":" + runId;
    if (await ledgerEntryExists(id)) return 0;
    const available = await creditBalance(userId);
    const debit = Math.min(amount, available);
    if (debit <= 0) return 0;
    await writeLedgerEntry({
      id,
      userId,
      kind: "usage",
      credits: -debit,
      invId: null,
      runId,
      createdAt: now.toISOString(),
    });
    return debit;
  });
}
