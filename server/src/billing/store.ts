import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { getTable, isYdbEnabled, ydbQuery } from "../storage/ydb.js";
import { FREE_PLAN, PLAN_CATALOG, type PlanId } from "../account/plans.js";

/**
 * Платежи и подписки — то, что делает оплату настоящей.
 *
 * Платёж живёт двумя состояниями: `pending` (счёт выставлен, ждём уведомление Робокассы) и `paid`
 * (уведомление пришло с верной подписью). Подписка — отдельная запись: она переживает платежи и
 * отвечает на единственный вопрос, который важен остальному серверу — какой тариф у аккаунта
 * сейчас. Хранилище то же, что у остальных данных: PostgreSQL в бою, JSON-файлы локально.
 */

export type PaymentStatus = "pending" | "paid" | "failed";

export type BillingPayment = {
  invId: number;
  userId: string;
  plan: PlanId;
  /** Сумма в рублях. */
  amount: number;
  status: PaymentStatus;
  kind: "initial" | "renewal";
  /** Первый платёж серии — по нему Робокасса списывает следующие. */
  parentInvId: number | null;
  createdAt: string;
  paidAt: string | null;
  /** Сколько раз пытались списать автопродление: после третьей неудачи подписка не продлевается. */
  attempts: number;
};

export type SubscriptionRecord = {
  userId: string;
  plan: PlanId;
  /** `canceled` — подписка действует до `renewsAt`, но автопродление выключено. */
  status: "active" | "canceled" | "expired";
  startedAt: string;
  renewsAt: string;
  autoRenew: boolean;
  parentInvId: number;
  /** Неудачные попытки автопродления подряд: после третьей подписка истекает. */
  renewalAttempts: number;
  updatedAt: string;
};

const root = process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");
const locks = new Map<string, Promise<unknown>>();

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

const paymentsFile = () => path.join(root, "billing", "payments.json");
const subscriptionsFile = () => path.join(root, "billing", "subscriptions.json");
const countersFile = () => path.join(root, "billing", "counters.json");

/** Номер счёта Робокассы — целое число. Счётчик общий, чтобы номера не повторялись между аккаунтами. */
async function nextInvId(): Promise<number> {
  const start = 100_000;
  if (isYdbEnabled()) {
    const table = ydbQuery().identifier(getTable("billing_counters"));
    const [rows] = await ydbQuery()<Array<{ value: number | string | bigint }>>`
      INSERT INTO ${table} (id, value) VALUES ('invoice', ${start})
      ON CONFLICT (id) DO UPDATE SET value = ${table}.value + 1
      RETURNING value
    `;
    return Number(rows[0]?.value ?? start);
  }
  return withLock("billing", async () => {
    const counters = await readJson<Record<string, number>>(countersFile(), {});
    const current = Number(counters.invoice ?? start - 1);
    const value = Math.max(start, Number.isFinite(current) ? current + 1 : start);
    counters.invoice = value;
    await writeJsonAtomic(countersFile(), counters);
    return value;
  });
}

/**
 * Номер для любого счёта Робокассы. Донат — не подписка, но живёт в том же магазине и в том же
 * диапазоне номеров, поэтому берёт номер из общего счётчика: два счётчика рано или поздно выдали
 * бы один и тот же InvId, и уведомление об оплате попало бы не в тот платёж.
 */
export const allocateInvoiceId = nextInvId;

export async function createPayment(input: {
  userId: string;
  plan: PlanId;
  amount: number;
  kind?: "initial" | "renewal";
  parentInvId?: number | null;
}): Promise<BillingPayment> {
  const payment: BillingPayment = {
    invId: await nextInvId(),
    userId: input.userId,
    plan: input.plan,
    amount: input.amount,
    status: "pending",
    kind: input.kind ?? "initial",
    parentInvId: input.parentInvId ?? null,
    createdAt: new Date().toISOString(),
    paidAt: null,
    attempts: 0,
  };
  if (isYdbEnabled()) {
    await ydbQuery()`
      INSERT INTO ${ydbQuery().identifier(getTable("billing_payments"))}
        (inv_id, user_id, plan, amount, status, kind, parent_inv_id, created_at, paid_at, attempts)
      VALUES (${payment.invId}, ${payment.userId}, ${payment.plan}, ${payment.amount}, ${payment.status}, ${payment.kind}, ${payment.parentInvId}, ${payment.createdAt}, ${payment.paidAt}, ${payment.attempts})
    `;
    return payment;
  }
  await withLock("billing", async () => {
    const payments = await readJson<BillingPayment[]>(paymentsFile(), []);
    payments.push(payment);
    await writeJsonAtomic(paymentsFile(), payments);
  });
  return payment;
}

type PaymentRow = {
  inv_id: number | string | bigint;
  user_id: string;
  plan: string;
  amount: number | string | bigint;
  status: string;
  kind: string;
  parent_inv_id: number | string | bigint | null;
  created_at: string;
  paid_at: string | null;
  attempts: number | string | bigint | null;
};

function paymentFromRow(row: PaymentRow): BillingPayment {
  return {
    invId: Number(row.inv_id),
    userId: row.user_id,
    plan: row.plan as PlanId,
    amount: Number(row.amount),
    status: row.status as PaymentStatus,
    kind: row.kind === "renewal" ? "renewal" : "initial",
    parentInvId: row.parent_inv_id == null ? null : Number(row.parent_inv_id),
    createdAt: row.created_at,
    paidAt: row.paid_at || null,
    attempts: Number(row.attempts ?? 0),
  };
}

export async function getPayment(invId: number): Promise<BillingPayment | null> {
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<PaymentRow[]>`
      SELECT inv_id, user_id, plan, amount, status, kind, parent_inv_id, created_at, paid_at, attempts
      FROM ${ydbQuery().identifier(getTable("billing_payments"))}
      WHERE inv_id = ${invId}
      LIMIT 1
    `;
    return rows[0] ? paymentFromRow(rows[0]) : null;
  }
  const payments = await readJson<BillingPayment[]>(paymentsFile(), []);
  return payments.find(payment => payment.invId === invId) ?? null;
}

export async function listPayments(userId: string, limit = 20): Promise<BillingPayment[]> {
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<PaymentRow[]>`
      SELECT inv_id, user_id, plan, amount, status, kind, parent_inv_id, created_at, paid_at, attempts
      FROM ${ydbQuery().identifier(getTable("billing_payments"))}
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return rows.map(paymentFromRow);
  }
  const payments = await readJson<BillingPayment[]>(paymentsFile(), []);
  return payments
    .filter(payment => payment.userId === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

/** Есть ли по аккаунту счёт этого вида, созданный после указанного времени (ждём уведомление). */
export async function hasPendingPayment(userId: string, kind: "initial" | "renewal", sinceIso: string): Promise<boolean> {
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<Array<{ inv_id: number | string | bigint }>>`
      SELECT inv_id FROM ${ydbQuery().identifier(getTable("billing_payments"))}
      WHERE user_id = ${userId} AND kind = ${kind} AND status = 'pending' AND created_at > ${sinceIso}
      LIMIT 1
    `;
    return rows.length > 0;
  }
  const payments = await readJson<BillingPayment[]>(paymentsFile(), []);
  return payments.some(payment => payment.userId === userId && payment.kind === kind && payment.status === "pending" && payment.createdAt > sinceIso);
}

type SubscriptionRow = {
  user_id: string;
  plan: string;
  status: string;
  started_at: string;
  renews_at: string;
  auto_renew: boolean;
  parent_inv_id: number | string | bigint;
  renewal_attempts: number | string | bigint | null;
  updated_at: string;
};

function subscriptionFromRow(row: SubscriptionRow): SubscriptionRecord {
  return {
    userId: row.user_id,
    plan: row.plan as PlanId,
    status: row.status as SubscriptionRecord["status"],
    startedAt: row.started_at,
    renewsAt: row.renews_at,
    autoRenew: Boolean(row.auto_renew),
    parentInvId: Number(row.parent_inv_id),
    renewalAttempts: Number(row.renewal_attempts ?? 0),
    updatedAt: row.updated_at,
  };
}

export async function getSubscriptionRecord(userId: string): Promise<SubscriptionRecord | null> {
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<SubscriptionRow[]>`
      SELECT user_id, plan, status, started_at, renews_at, auto_renew, parent_inv_id, renewal_attempts, updated_at
      FROM ${ydbQuery().identifier(getTable("billing_subscriptions"))}
      WHERE user_id = ${userId}
      LIMIT 1
    `;
    return rows[0] ? subscriptionFromRow(rows[0]) : null;
  }
  const subscriptions = await readJson<Record<string, SubscriptionRecord>>(subscriptionsFile(), {});
  return subscriptions[userId] ?? null;
}

async function saveSubscription(record: SubscriptionRecord) {
  if (isYdbEnabled()) {
    await ydbQuery()`
      UPSERT INTO ${ydbQuery().identifier(getTable("billing_subscriptions"))}
        (user_id, plan, status, started_at, renews_at, auto_renew, parent_inv_id, renewal_attempts, updated_at)
      VALUES (${record.userId}, ${record.plan}, ${record.status}, ${record.startedAt}, ${record.renewsAt}, ${record.autoRenew}, ${record.parentInvId}, ${record.renewalAttempts}, ${record.updatedAt})
    `;
    return record;
  }
  await withLock("billing", async () => {
    const subscriptions = await readJson<Record<string, SubscriptionRecord>>(subscriptionsFile(), {});
    subscriptions[record.userId] = record;
    await writeJsonAtomic(subscriptionsFile(), subscriptions);
  });
  return record;
}

/** Прибавляет календарный месяц: подписка на месяц не должна «съезжать» на 30 дней. */
export function addMonth(value: Date) {
  const next = new Date(value);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

export function isSubscriptionLive(record: SubscriptionRecord | null, now = new Date()) {
  return Boolean(record && record.plan !== FREE_PLAN && new Date(record.renewsAt).getTime() > now.getTime());
}

/**
 * Тариф аккаунта — единственное место, где он берётся. Просроченная подписка сразу означает
 * бесплатный тариф: отдельная задача «понизить всех ночью» не нужна, а лимиты не могут остаться
 * платными после окончания оплаченного срока.
 */
export async function planForUser(userId: string, now = new Date()): Promise<PlanId> {
  const record = await getSubscriptionRecord(userId);
  return isSubscriptionLive(record, now) ? record!.plan : FREE_PLAN;
}

export const accountPlanFor = planForUser;

/**
 * Уведомление об оплате подтверждено: платёж закрывается один раз (Робокасса повторяет
 * уведомление, пока не получит `OK{InvId}`), а подписка продлевается от текущего срока, поэтому
 * ранняя оплата не теряет уже оплаченные дни.
 */
export async function markPaymentPaid(invId: number, options: { autoRenew: boolean }, now = new Date()) {
  const payment = await getPayment(invId);
  if (!payment) return null;
  if (payment.status === "paid") return { payment, alreadyPaid: true as const };

  const paidAt = now.toISOString();
  if (isYdbEnabled()) {
    await ydbQuery()`
      UPDATE ${ydbQuery().identifier(getTable("billing_payments"))}
      SET status = 'paid', paid_at = ${paidAt}
      WHERE inv_id = ${invId}
    `;
  } else {
    await withLock("billing", async () => {
      const payments = await readJson<BillingPayment[]>(paymentsFile(), []);
      const stored = payments.find(item => item.invId === invId);
      if (stored) { stored.status = "paid"; stored.paidAt = paidAt; }
      await writeJsonAtomic(paymentsFile(), payments);
    });
  }

  const existing = await getSubscriptionRecord(payment.userId);
  const live = isSubscriptionLive(existing, now);
  const base = live && existing!.plan === payment.plan ? new Date(existing!.renewsAt) : now;
  const record: SubscriptionRecord = {
    userId: payment.userId,
    plan: payment.plan,
    status: "active",
    startedAt: live ? existing!.startedAt : now.toISOString(),
    renewsAt: addMonth(base).toISOString(),
    // Выбор человека важнее настройки сервера: подписку, у которой автопродление выключили, платёж
    // не включает обратно. У новой подписки автопродление доступно, только если магазин умеет его.
    autoRenew: live ? existing!.autoRenew : options.autoRenew,
    parentInvId: payment.kind === "renewal" && existing ? existing.parentInvId : payment.invId,
    renewalAttempts: 0,
    updatedAt: now.toISOString(),
  };
  await saveSubscription(record);
  return { payment: { ...payment, status: "paid" as const, paidAt }, alreadyPaid: false as const, subscription: record };
}

export async function markPaymentFailed(invId: number) {
  if (isYdbEnabled()) {
    await ydbQuery()`
      UPDATE ${ydbQuery().identifier(getTable("billing_payments"))}
      SET status = 'failed', attempts = attempts + 1
      WHERE inv_id = ${invId}
    `;
    return;
  }
  await withLock("billing", async () => {
    const payments = await readJson<BillingPayment[]>(paymentsFile(), []);
    const stored = payments.find(item => item.invId === invId);
    if (stored) { stored.status = "failed"; stored.attempts += 1; }
    await writeJsonAtomic(paymentsFile(), payments);
  });
}

/** Включает или выключает автопродление. Возвращает null, если платной подписки нет. */
export async function setAutoRenew(userId: string, autoRenew: boolean, now = new Date()) {
  const record = await getSubscriptionRecord(userId);
  const live = isSubscriptionLive(record, now);
  if (!record || !live) return null;
  return saveSubscription({
    ...record,
    autoRenew,
    status: autoRenew ? "active" : "canceled",
    updatedAt: now.toISOString(),
  });
}

/** Подписки, которые пора продлить: срок вышел, автопродление включено. */
export async function listDueSubscriptions(now = new Date()): Promise<SubscriptionRecord[]> {
  const iso = now.toISOString();
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<SubscriptionRow[]>`
      SELECT user_id, plan, status, started_at, renews_at, auto_renew, parent_inv_id, renewal_attempts, updated_at
      FROM ${ydbQuery().identifier(getTable("billing_subscriptions"))}
      WHERE auto_renew = true AND renews_at <= ${iso}
      ORDER BY renews_at
    `;
    return rows.map(subscriptionFromRow).filter(record => record.plan !== FREE_PLAN);
  }
  const subscriptions = await readJson<Record<string, SubscriptionRecord>>(subscriptionsFile(), {});
  return Object.values(subscriptions)
    .filter(record => record.autoRenew && record.plan !== FREE_PLAN && record.renewsAt <= iso)
    .sort((a, b) => a.renewsAt.localeCompare(b.renewsAt));
}

/**
 * Неудачное автопродление: следующая попытка через сутки, но не больше трёх. После третьей
 * подписка остаётся истекать — платформа не списывает деньги бесконечно и не обещает доступ,
 * который не оплачен.
 */
export async function postponeRenewal(record: SubscriptionRecord, now = new Date()) {
  const attempts = record.renewalAttempts + 1;
  if (attempts >= 3) {
    return saveSubscription({ ...record, status: "expired", renewsAt: now.toISOString(), renewalAttempts: attempts, updatedAt: now.toISOString() });
  }
  return saveSubscription({ ...record, renewsAt: new Date(now.getTime() + 86_400_000).toISOString(), renewalAttempts: attempts, updatedAt: now.toISOString() });
}

/** Название и цена тарифа для письма, чека и истории платежей. */
export function planLabel(plan: PlanId) {
  return PLAN_CATALOG[plan].name;
}
