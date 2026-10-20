import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/auth.js";
import { findYandexIdentityByUserId } from "../auth/yandex-account-store.js";
import { getUserPreferences, saveUserPreferences, type UserPreferences } from "../account/account-store.js";
import { FREE_PLAN, PLAN_CATALOG, balanceFor, limitsForPlan, subscriptionFor, type BillingSubscription } from "../account/plans.js";
import { getBillingHistory, getCostSnapshot, getUsageSnapshot } from "../account/usage-store.js";
import { getStorageSnapshot } from "../account/storage-quota.js";
import { accountPlanFor, getSubscriptionRecord, isSubscriptionLive, listPayments } from "../billing/store.js";
import { planPriceLabel, planPriceRub, publicPlans, robokassaConfig } from "../billing/robokassa.js";

export { FREE_PLAN, PLAN_CATALOG } from "../account/plans.js";
const preferencesSchema = z.object({
  language: z.enum(["ru", "en"]),
  compactMode: z.boolean(),
  emailNotifications: z.boolean(),
  productUpdates: z.boolean(),
});

export async function registerAccountRoutes(app: FastifyInstance) {
  app.get("/api/account/settings", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const yandex = await findYandexIdentityByUserId(user.id);
    return {
      user: {
        id: user.id,
        email: user.email,
        createdAt: user.createdAt,
        ...(yandex ? { yandex: { login: yandex.login, email: yandex.email ?? null } } : {}),
      },
      preferences: await getUserPreferences(user.id),
    };
  });
  app.put("/api/account/settings", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const preferences = preferencesSchema.parse(request.body) as UserPreferences;
    return { preferences: await saveUserPreferences(user.id, preferences) };
  });
  app.get("/api/billing", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    // Тариф аккаунта — одно место на весь биллинг: лимиты, подписка и история читают его,
    // поэтому оплаченный тариф меняет всё сразу, а не только надпись на экране.
    const config = robokassaConfig();
    const plan = await accountPlanFor(user.id);
    const record = await getSubscriptionRecord(user.id);
    const live = isSubscriptionLive(record);
    const subscription: BillingSubscription = live && record
      ? {
          plan: record.plan,
          planName: PLAN_CATALOG[record.plan].name,
          priceLabel: planPriceLabel(record.plan),
          status: record.autoRenew ? "active" : "canceled",
          startedAt: record.startedAt,
          renewsAt: record.renewsAt,
          paymentConnected: config.configured,
          autoRenew: record.autoRenew,
          amountRub: planPriceRub(record.plan),
          recurringAvailable: config.recurring,
        }
      : subscriptionFor(FREE_PLAN, user.createdAt, {
          paymentConnected: config.configured,
          recurringAvailable: config.recurring,
        });
    const payments = await listPayments(user.id, 20);
    return {
      plans: publicPlans(),
      plan,
      limits: limitsForPlan(plan),
      subscription,
      balance: { ...balanceFor(), paymentsConnected: config.configured },
      paymentsEnabled: config.configured,
      payments: payments.map(payment => ({
        invId: payment.invId,
        plan: payment.plan,
        planName: PLAN_CATALOG[payment.plan].name,
        amount: payment.amount,
        currency: "RUB",
        status: payment.status,
        kind: payment.kind,
        createdAt: payment.createdAt,
        paidAt: payment.paidAt,
      })),
      usage: await getUsageSnapshot(user.id),
      history: await getBillingHistory(user.id, 7),
      storage: await getStorageSnapshot(user.id, plan),
      cost: await getCostSnapshot(user.id),
    };
  });
}
