import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/auth.js";
import { findYandexIdentityByUserId } from "../auth/yandex-account-store.js";
import { findPhoneByUserId, formatPhone } from "../auth/phone-store.js";
import { getUserPreferences, saveUserPreferences, type UserPreferences } from "../account/account-store.js";
import { getUserProfile, saveUserProfile } from "../account/profile-store.js";
import { FREE_PLAN, PLAN_CATALOG, balanceFor, limitsForPlan, subscriptionFor, type BillingSubscription } from "../account/plans.js";
import { getBillingHistory, getCostSnapshot, getTokenBudget, getUsageSnapshot } from "../account/usage-store.js";
import { getStorageOverview, refreshUserStorage } from "../account/storage-quota.js";
import { accountPlanFor, getSubscriptionRecord, isSubscriptionLive, listPayments } from "../billing/store.js";
import { planPriceLabel, planPriceRub, publicPlans, robokassaConfig } from "../billing/robokassa.js";

export { FREE_PLAN, PLAN_CATALOG } from "../account/plans.js";
const preferencesSchema = z.object({
  language: z.enum(["ru", "en"]),
  compactMode: z.boolean(),
  emailNotifications: z.boolean(),
  productUpdates: z.boolean(),
});
/**
 * Первый экран знакомства. Имя и почта обязательны: по ним отвечают человеку, поэтому пустая
 * строка или адрес без домена отклоняются сервером, а не только кнопкой в интерфейсе.
 * Согласия на письма — необязательные флажки.
 */
const onboardingSchema = z.object({
  name: z.string().trim().min(2, "Имя слишком короткое").max(80, "Имя слишком длинное"),
  email: z.string().trim().email("Некорректный email").max(200),
  newsletter: z.boolean().default(false),
  productUpdates: z.boolean().default(false),
});

export async function registerAccountRoutes(app: FastifyInstance) {
  app.get("/api/account/settings", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const [yandex, phone, profile] = await Promise.all([
      findYandexIdentityByUserId(user.id),
      findPhoneByUserId(user.id),
      getUserProfile(user.id),
    ]);
    return {
      user: {
        id: user.id,
        email: user.email,
        createdAt: user.createdAt,
        // У входа по телефону адрес служебный (…@phone.webnestdev.local): номер показывается
        // отдельно, а почта берётся из контактов знакомства.
        ...(phone ? { phone: formatPhone(phone) } : {}),
        ...(yandex ? { yandex: { login: yandex.login, email: yandex.email ?? null } } : {}),
      },
      // Имя и почта для связи, которые аккаунт оставил при знакомстве. null — ещё не оставил.
      profile,
      preferences: await getUserPreferences(user.id),
    };
  });
  app.put("/api/account/settings", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const preferences = preferencesSchema.parse(request.body) as UserPreferences;
    return { preferences: await saveUserPreferences(user.id, preferences) };
  });
  /** Контакты знакомства: null означает, что аккаунт их ещё не оставлял. */
  app.get("/api/account/onboarding", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    return { profile: await getUserProfile(user.id) };
  });
  app.post("/api/account/onboarding", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = onboardingSchema.parse(request.body);
    return { profile: await saveUserProfile(user.id, body) };
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
      // Месячный пул встроенной модели: `limit: 0` у бесплатного тарифа — пула нет, шкалу не рисуем.
      tokens: await getTokenBudget(user.id, plan),
      history: await getBillingHistory(user.id, 7),
      storage: await getStorageOverview(user.id, plan),
      cost: await getCostSnapshot(user.id),
    };
  });

  /**
   * Ручной пересчёт хранилища: после удаления файлов или `node_modules` число в настройках
   * должно уменьшиться сразу, а не ждать ночной сверки. Кнопка в интерфейсе вызывает этот
   * маршрут, поэтому у него свой короткий кулдаун: обход каталога не должен запускаться
   * десятком нажатий подряд.
   */
  const storageRefreshCooldown = new Map<string, number>();
  const STORAGE_REFRESH_COOLDOWN_MS = 60_000;
  app.post("/api/account/storage/refresh", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const now = Date.now();
    const last = storageRefreshCooldown.get(user.id) ?? 0;
    const retryAfter = Math.ceil((STORAGE_REFRESH_COOLDOWN_MS - (now - last)) / 1000);
    if (retryAfter > 0) {
      return reply.code(429).send({
        error: "Размер хранилища пересчитывался только что: попробуйте через " + retryAfter + " с.",
        retryAfter,
      });
    }
    storageRefreshCooldown.set(user.id, now);
    try {
      const refreshed = await refreshUserStorage(user.id);
      const plan = await accountPlanFor(user.id);
      return { ...refreshed, storage: await getStorageOverview(user.id, plan) };
    } catch (error) {
      storageRefreshCooldown.delete(user.id);
      throw error;
    }
  });
}
