import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/auth.js";
import { findYandexIdentityByUserId } from "../auth/yandex-account-store.js";
import { getUserPreferences, saveUserPreferences, type UserPreferences } from "../account/account-store.js";
import { FREE_PLAN, PLAN_CATALOG, limitsForPlan } from "../account/plans.js";
import { getCostSnapshot, getUsageSnapshot } from "../account/usage-store.js";
import { getStorageSnapshot } from "../account/storage-quota.js";

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
    return {
      plans: Object.values(PLAN_CATALOG),
      limits: limitsForPlan(FREE_PLAN),
      usage: await getUsageSnapshot(user.id),
      storage: await getStorageSnapshot(user.id, FREE_PLAN),
      cost: await getCostSnapshot(user.id),
    };
  });
}
