import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireUser } from "../auth/auth.js";
import { isPlatformAdmin } from "../platform/admin.js";
import { isSameOriginRequest, sameOriginRefusal } from "../security/same-origin.js";
import { recordAudit } from "../security/audit-journal.js";
import { applyNoStoreToReply } from "./cache-headers.js";
import { planAdminList } from "../billing/robokassa.js";
import { planSettingsFeaturePresence, planSettingsSchema, savePlanSettings } from "../billing/plan-settings.js";

/**
 * Витрина тарифов для админки панели: название, описание, базовая цена и скидка.
 *
 * Это не секреты и не проектные настройки, поэтому раздел живёт отдельно от «Ключей сервера».
 * Доступ — тот же флаг администратора платформы, что и у ключей; обычный пользователь видит
 * только публичный каталог через `/api/billing`.
 */
function guard(request: FastifyRequest, reply: FastifyReply) {
  applyNoStoreToReply(reply);
  if (!isSameOriginRequest(request)) {
    void reply.code(403).send({ error: sameOriginRefusal() });
    return false;
  }
  return true;
}

export async function registerPlatformPlanRoutes(app: FastifyInstance) {
  app.get("/api/platform/plans", async (request, reply) => {
    if (!guard(request, reply)) return;
    const user = await requireUser(request, reply); if (!user) return;
    if (!isPlatformAdmin(user)) return { admin: false };
    return { admin: true, plans: planAdminList() };
  });

  app.post("/api/platform/plans", async (request, reply) => {
    if (!guard(request, reply)) return;
    const user = await requireUser(request, reply); if (!user) return;
    if (!isPlatformAdmin(user)) return reply.code(403).send({ error: "Тарифы может менять только администратор платформы" });
    const raw = request.body ?? {};
    const parsed = planSettingsSchema.safeParse(raw);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Проверьте название, описание, пункты, цену и скидку" });
    const featuresProvided = planSettingsFeaturePresence(raw);
    await savePlanSettings(parsed.data, { preserveFeatures: { pro: !featuresProvided.pro, team: !featuresProvided.team } });
    await recordAudit({
      action: "billing.plans.updated",
      actorType: "user",
      actorId: user.id,
      actorLabel: user.email,
      ip: request.ip,
      details: {
        pro: parsed.data.pro.name + " · " + parsed.data.pro.priceRub + " ₽ − " + parsed.data.pro.discountPercent + "%",
        team: parsed.data.team.name + " · " + parsed.data.team.priceRub + " ₽ − " + parsed.data.team.discountPercent + "%",
      },
    });
    request.log.info({ pro: parsed.data.pro, team: parsed.data.team }, "billing: тарифы обновлены");
    return { saved: true, plans: planAdminList() };
  });
}
