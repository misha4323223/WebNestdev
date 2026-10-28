import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/auth.js";
import { findYandexIdentityByUserId } from "../auth/yandex-account-store.js";
import { findPhoneByUserId, formatPhone } from "../auth/phone-store.js";
import { getUserPreferences, saveUserPreferences, type UserPreferences } from "../account/account-store.js";
import { getUserProfile, saveUserProfile, updateUserProfile } from "../account/profile-store.js";
import { FREE_PLAN, PLAN_CATALOG, balanceFor, limitsForPlan, subscriptionFor, type BillingSubscription } from "../account/plans.js";
import { getBillingHistory, getCostSnapshot, getTokenBudget, getUsageSnapshot } from "../account/usage-store.js";
import { getStorageOverview, refreshUserStorage } from "../account/storage-quota.js";
import { accountPlanFor, getSubscriptionRecord, isSubscriptionLive, listPayments } from "../billing/store.js";
import { planPriceLabel, planPriceRub, publicPlans, robokassaConfig } from "../billing/robokassa.js";
import { planDisplayName } from "../billing/plan-settings.js";

export { FREE_PLAN, PLAN_CATALOG } from "../account/plans.js";
const preferencesSchema = z.object({
  language: z.enum(["ru", "en"]),
  compactMode: z.boolean(),
  emailNotifications: z.boolean(),
  productUpdates: z.boolean(),
});
/**
 * Почта для связи. Пустая строка разрешена: аккаунт может войти по телефону и не хотеть
 * оставлять адрес. Если адрес введён, он проверяется и здесь, а не только кнопкой в интерфейсе.
 */
const contactEmail = z.string().trim().max(200).refine(
  value => value === "" || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value),
  "Некорректный email",
);

/**
 * Первый экран знакомства. Имя обязательно, почта — нет. Согласия на письма — отдельные флажки;
 * рекламное согласие (`productUpdates`) без адреса не имеет смысла, но сервер его не выдумывает.
 */
const onboardingSchema = z.object({
  name: z.string().trim().min(2, "Имя слишком короткое").max(80, "Имя слишком длинное"),
  email: contactEmail.default(""),
  newsletter: z.boolean().default(false),
  productUpdates: z.boolean().default(false),
  /** Откуда человек узнал о NestDev; вопрос задаётся после контактов. */
  source: z.string().trim().max(80).optional(),
});

/**
 * Точечная правка профиля: настройки меняют согласие, почту или имя по одному полю. Пустой
 * запрос отклоняется, чтобы «сохранить» без изменений не переписывало дату правки.
 */
const profilePatchSchema = z.object({
  name: z.string().trim().min(2, "Имя слишком короткое").max(80, "Имя слишком длинное").optional(),
  email: contactEmail.optional(),
  newsletter: z.boolean().optional(),
  productUpdates: z.boolean().optional(),
  source: z.string().trim().max(80).optional(),
}).strict();

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
  /** Лёгкий ответ для формы поддержки: какой адрес подставить в поле «Email для ответа». */
  app.get("/api/account/contact", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const profile = await getUserProfile(user.id);
    return { email: profile?.email || "", loginEmail: user.email };
  });
  app.post("/api/account/onboarding", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = onboardingSchema.parse(request.body);
    return { profile: await saveUserProfile(user.id, body) };
  });
  /**
   * Правка контактов и согласий после знакомства. Согласие на рекламу можно и дать, и отозвать:
   * это одно и то же поле `productUpdates`, поэтому рассылка сразу видит новое решение.
   */
  app.patch("/api/account/profile", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = profilePatchSchema.parse(request.body);
    if (!Object.keys(body).length) {
      return reply.code(400).send({ error: "Нет изменений для сохранения" });
    }
    const profile = await updateUserProfile(user.id, body);
    if (!profile) {
      return reply.code(404).send({ error: "Сначала пройдите знакомство: профиля ещё нет" });
    }
    return { profile };
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
          planName: planDisplayName(record.plan),
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
        planName: planDisplayName(payment.plan),
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
