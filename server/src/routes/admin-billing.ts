import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "./admin.js";
import { applyNoStoreToReply } from "./cache-headers.js";
import { getTable, isYdbEnabled, ydbQuery } from "../storage/ydb.js";
import { listAllPayments, listSubscriptions, isSubscriptionLive } from "../billing/store.js";
import { listUserIdentities } from "../auth/auth-store.js";
import { PLAN_CATALOG, FREE_PLAN, tokenPoolFor, type PlanId } from "../account/plans.js";
import { tokenMonth } from "../account/token-bonus.js";

/**
 * Реестр платежей и подписок для админки.
 *
 * Данные лежали в billing/store.ts с самого начала, но ни один маршрут их не отдавал: «кто
 * истекает на этой неделе», «у кого автопродление упало дважды» и «сколько денег реально пришло»
 * нельзя было узнать вообще. Здесь они собраны в один ответ, потому что это один экран: список
 * платежей, состояние подписок и то, сколько выбирают из пула токенов.
 *
 * `pool` — калибровка тарифа: медиана и p90 расхода на подписчика и доля тех, кто выбирает пул
 * целиком. Общий расход для этого вопроса слишком грубый: он смешивает кабинет с тяжёлым
 * пользователем и не отвечает, сколько токенов класть в «Плюс».
 *
 * Только чтение: деньги и подписки здесь не меняются (для этого есть действия над пользователем в
 * admin-users.ts и сама оплата в robokassa).
 */

const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const T = (name: string) => ydbQuery().identifier(getTable(name));

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Медиана: среднее двух центральных значений при чётном числе — иначе «половина» врёт. */
export function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/** p90 по ближайшему рангу: значение, которое не превышают 90% подписчиков. */
export function percentile(values: number[], share: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(share * sorted.length) - 1));
  return sorted[index];
}

/** Расход токенов по аккаунтам с начала календарного месяца — тот же источник, что и у пула. */
async function monthlyTokensByUser(month: string): Promise<Map<string, number>> {
  const first = month + "-01";
  const today = new Date().toISOString().slice(0, 10);
  const result = new Map<string, number>();

  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<Array<{ user_id: string; prompt: unknown; completion: unknown }>>`
      SELECT user_id, SUM(prompt_tokens) AS prompt, SUM(completion_tokens) AS completion
      FROM ${T("model_usage")}
      WHERE usage_date >= ${first} AND usage_date <= ${today}
      GROUP BY user_id
    `;
    for (const row of rows) result.set(row.user_id, num(row.prompt) + num(row.completion));
    return result;
  }

  const root = process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");
  const start = new Date(`${first}T00:00:00Z`);
  for (let cursor = start; cursor.toISOString().slice(0, 10) <= today; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = cursor.toISOString().slice(0, 10);
    let records: Array<{ userId?: string; promptTokens?: number; completionTokens?: number }> = [];
    try {
      records = JSON.parse(await readFile(path.join(root, "account", "costs", date + ".json"), "utf8"));
    } catch {
      continue;
    }
    for (const record of records) {
      if (!record?.userId) continue;
      result.set(record.userId, (result.get(record.userId) ?? 0) + num(record.promptTokens) + num(record.completionTokens));
    }
  }
  return result;
}

export async function registerAdminBillingRoutes(app: FastifyInstance) {
  app.get("/api/admin/billing", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);

    const query = querySchema.parse(request.query);
    const now = new Date();
    const from = new Date(now.getTime() - query.days * 86_400_000).toISOString();

    const [payments, subscriptions, identities, tokensByUser] = await Promise.all([
      listAllPayments({ sinceIso: from, limit: query.limit }),
      listSubscriptions(),
      listUserIdentities(),
      monthlyTokensByUser(tokenMonth(now)),
    ]);
    const emails = new Map(identities.map(identity => [identity.id, identity.email]));

    // Деньги считаются по тому же окну, что и список: «пришло 12 000 ₽» и платежи под ним
    // должны сходиться, иначе цифра и таблица рассказывают разное.
    const money = payments.reduce(
      (totals, payment) => {
        if (payment.status === "paid") {
          totals.paidRub += payment.amount;
          totals.paidCount += 1;
          if (payment.kind === "renewal") totals.renewalsPaid += 1;
          else totals.initialPaid += 1;
        } else if (payment.status === "pending") {
          totals.pendingRub += payment.amount;
          totals.pendingCount += 1;
        } else {
          totals.failedCount += 1;
          totals.failedRub += payment.amount;
        }
        if (payment.kind === "renewal" && payment.attempts > 0) totals.renewalsRetried += 1;
        return totals;
      },
      { paidRub: 0, paidCount: 0, initialPaid: 0, renewalsPaid: 0, pendingRub: 0, pendingCount: 0, failedRub: 0, failedCount: 0, renewalsRetried: 0 },
    );

    const weekAhead = new Date(now.getTime() + 7 * 86_400_000);
    const live = subscriptions.filter(record => record.plan !== FREE_PLAN && isSubscriptionLive(record, now));
    const expiringSoon = live
      .filter(record => new Date(record.renewsAt) <= weekAhead)
      .sort((a, b) => a.renewsAt.localeCompare(b.renewsAt))
      .map(record => ({
        userId: record.userId,
        email: emails.get(record.userId) ?? null,
        plan: record.plan,
        planName: PLAN_CATALOG[record.plan].name,
        renewsAt: record.renewsAt,
        autoRenew: record.autoRenew,
        status: record.status,
        daysLeft: Math.max(0, Math.ceil((new Date(record.renewsAt).getTime() - now.getTime()) / 86_400_000)),
      }));
    // Автопродление, у которого уже были неудачи: после третьей подписка истекает молча.
    const renewalFailures = subscriptions
      .filter(record => record.renewalAttempts > 0)
      .sort((a, b) => b.renewalAttempts - a.renewalAttempts)
      .map(record => ({
        userId: record.userId,
        email: emails.get(record.userId) ?? null,
        plan: record.plan,
        attempts: record.renewalAttempts,
        renewsAt: record.renewsAt,
        autoRenew: record.autoRenew,
        status: record.status,
      }));

    // Пул считается по действующим подписчикам: у бесплатного тарифа пула нет, и его расход
    // ничего не говорит о том, сколько токенов класть в платный тариф.
    const subscribers = live
      .map(record => ({ plan: record.plan, used: tokensByUser.get(record.userId) ?? 0 }))
      .filter(entry => tokenPoolFor(entry.plan) > 0);
    const usage = subscribers.map(entry => entry.used);
    const full = subscribers.filter(entry => entry.used >= tokenPoolFor(entry.plan)).length;
    const near = subscribers.filter(entry => entry.used >= tokenPoolFor(entry.plan) * 0.9).length;
    const share = (count: number) => (subscribers.length ? Math.round((count / subscribers.length) * 1000) / 1000 : 0);

    return {
      generatedAt: now.toISOString(),
      window: { days: query.days, from, to: now.toISOString() },
      money,
      payments: payments.map(payment => ({
        ...payment,
        email: emails.get(payment.userId) ?? null,
        planName: PLAN_CATALOG[payment.plan as PlanId]?.name ?? payment.plan,
      })),
      subscriptions: {
        total: subscriptions.length,
        live: live.length,
        canceled: live.filter(record => record.status === "canceled").length,
        expiringSoon,
        renewalFailures,
      },
      /**
       * Калибровка пула. `p90Tokens` — масштаб, а не решение за владельца: столько токенов
       * покрывает 90% подписчиков, то есть отсекает только самых тяжёлых. `fullPoolShare` — доля
       * тех, кто выбирает пул целиком: если она высокая, тариф тесен, даже если медиана низкая.
       */
      pool: {
        month: tokenMonth(now),
        subscribers: subscribers.length,
        medianTokens: median(usage),
        p90Tokens: percentile(usage, 0.9),
        averageTokens: usage.length ? Math.round(usage.reduce((sum, value) => sum + value, 0) / usage.length) : 0,
        fullPoolShare: share(full),
        nearPoolShare: share(near),
        fullPoolCount: full,
        nearPoolCount: near,
      },
    };
  });
}
