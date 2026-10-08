import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/auth.js";
import { getSubscription, getUserPreferences, saveSubscription, saveUserPreferences, type PlanId, type Subscription, type UserPreferences } from "../account/account-store.js";

export const PLAN_CATALOG = {
  free: { id: "free", name: "Free", priceLabel: "$0", description: "Чтобы познакомиться с WebNestdev", limits: { projects: 3, agentRunsPerDay: 10, browserChecksPerDay: 5 }, features: ["3 проекта", "10 запусков агента в день", "5 браузерных проверок в день"] },
  pro: { id: "pro", name: "Pro", priceLabel: "Демо", description: "Для регулярной разработки", limits: { projects: 15, agentRunsPerDay: 100, browserChecksPerDay: 50 }, features: ["15 проектов", "100 запусков агента в день", "50 браузерных проверок в день", "Приоритетные возможности (демо)"] },
  team: { id: "team", name: "Team", priceLabel: "Демо", description: "Для небольшой команды", limits: { projects: 50, agentRunsPerDay: 500, browserChecksPerDay: 250 }, features: ["50 проектов", "500 запусков агента в день", "250 браузерных проверок в день", "Командные возможности (демо)"] },
} as const;
const preferencesSchema = z.object({
  language: z.enum(["ru", "en"]),
  compactMode: z.boolean(),
  emailNotifications: z.boolean(),
  productUpdates: z.boolean(),
});
const demoPlanSchema = z.object({ plan: z.enum(["pro", "team"]) });

function currentPlan(subscription: Subscription): PlanId {
  return subscription.status === "demo_active" && subscription.expiresAt && Date.parse(subscription.expiresAt) > Date.now() ? subscription.plan : "free";
}
function publicSubscription(subscription: Subscription) {
  const plan = currentPlan(subscription);
  return { plan, status: subscription.status === "demo_active" && plan === "free" ? "demo_expired" : subscription.status, startedAt: subscription.startedAt, expiresAt: subscription.expiresAt, updatedAt: subscription.updatedAt, mode: "demo" as const };
}
export async function registerAccountRoutes(app: FastifyInstance) {
  app.get("/api/account/settings", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    return { user: { id: user.id, email: user.email, createdAt: user.createdAt }, preferences: await getUserPreferences(user.id) };
  });
  app.put("/api/account/settings", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const preferences = preferencesSchema.parse(request.body) as UserPreferences;
    return { preferences: await saveUserPreferences(user.id, preferences) };
  });
  app.get("/api/billing", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const subscription = await getSubscription(user.id);
    if (subscription.status === "demo_active" && currentPlan(subscription) === "free") {
      const expired = { ...subscription, plan: "free" as const, status: "demo_expired" as const, updatedAt: new Date().toISOString() };
      await saveSubscription(expired);
      return { mode: "demo", subscription: publicSubscription(expired), plans: Object.values(PLAN_CATALOG) };
    }
    return { mode: "demo", subscription: publicSubscription(subscription), plans: Object.values(PLAN_CATALOG) };
  });
  app.post("/api/billing/demo/activate", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { plan } = demoPlanSchema.parse(request.body);
    const now = new Date();
    const subscription: Subscription = { userId: user.id, plan, status: "demo_active", startedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(), updatedAt: now.toISOString() };
    await saveSubscription(subscription);
    return { mode: "demo", subscription: publicSubscription(subscription), message: "Демо-тариф активирован. Оплата не выполнялась." };
  });
  app.post("/api/billing/demo/cancel", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const current = await getSubscription(user.id);
    const now = new Date().toISOString();
    const subscription: Subscription = { ...current, plan: "free", status: "demo_cancelled", expiresAt: null, updatedAt: now };
    await saveSubscription(subscription);
    return { mode: "demo", subscription: publicSubscription(subscription), message: "Демо-подписка отменена. Платежей не было." };
  });
}
