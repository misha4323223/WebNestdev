import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/auth.js";
import { DemoAlreadyClaimedError, PhoneVerificationRequiredError, activateDemoOnce, getSubscription, getUserPreferences, saveSubscription, saveUserPreferences, type Subscription, type UserPreferences } from "../account/account-store.js";
import { PLAN_CATALOG, limitsForPlan, type PlanId } from "../account/plans.js";
import { getCostSnapshot, getUsageSnapshot } from "../account/usage-store.js";
import { getStorageSnapshot } from "../account/storage-quota.js";

export { PLAN_CATALOG } from "../account/plans.js";
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
    const plan = currentPlan(subscription);
    let normalized = subscription;
    if (subscription.status === "demo_active" && plan === "free") {
      normalized = { ...subscription, plan: "free", status: "demo_expired", updatedAt: new Date().toISOString() };
      await saveSubscription(normalized);
    }
    return { mode: "demo", subscription: publicSubscription(normalized), plans: Object.values(PLAN_CATALOG), limits: limitsForPlan(currentPlan(normalized)), usage: await getUsageSnapshot(user.id), storage: await getStorageSnapshot(user.id, currentPlan(normalized)), cost: await getCostSnapshot(user.id) };
  });
  app.post("/api/billing/demo/activate", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { plan } = demoPlanSchema.parse(request.body);
    try {
      const subscription = await activateDemoOnce(user.id, plan);
      return { mode: "demo", subscription: publicSubscription(subscription), message: "Демо-тариф активирован. Оплата не выполнялась." };
    } catch (error) {
      if (error instanceof DemoAlreadyClaimedError) {
        return reply.code(409).send({ error: "Демо-доступ выдаётся один раз на номер телефона: для этого номера он уже использован. Оформите платный тариф или обратитесь в поддержку." });
      }
      if (error instanceof PhoneVerificationRequiredError) {
        return reply.code(403).send({ error: "Демо-доступ доступен только аккаунту, который вошёл по номеру телефона." });
      }
      throw error;
    }
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
