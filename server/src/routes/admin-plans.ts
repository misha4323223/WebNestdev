import type { FastifyInstance } from "fastify";
import { requireAdmin } from "./admin.js";
import { applyNoStoreToReply } from "./cache-headers.js";
import { recordAudit } from "../security/audit-journal.js";
import { planAdminList } from "../billing/robokassa.js";
import { planSettingsSchema, savePlanSettings } from "../billing/plan-settings.js";

/**
 * Та же витрина тарифов для внешней админки: Bearer-токен, как у остальных `/api/admin/*`.
 * Ответ и правила совпадают с `/api/platform/plans`, чтобы десктопное приложение и панель
 * не расходились в том, какую цену и скидку они показывают.
 */
export async function registerAdminPlanRoutes(app: FastifyInstance) {
  app.get("/api/admin/plans", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);
    return { plans: planAdminList() };
  });

  app.post("/api/admin/plans", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);
    const parsed = planSettingsSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Проверьте название, описание, цену и скидку" });
    await savePlanSettings(parsed.data);
    await recordAudit({
      action: "billing.plans.updated",
      actorType: "admin",
      actorId: auth.admin.id,
      actorLabel: auth.admin.email,
      ip: request.ip,
      details: {
        pro: parsed.data.pro.name + " · " + parsed.data.pro.priceRub + " ₽ − " + parsed.data.pro.discountPercent + "%",
        team: parsed.data.team.name + " · " + parsed.data.team.priceRub + " ₽ − " + parsed.data.team.discountPercent + "%",
      },
    });
    return { saved: true, plans: planAdminList() };
  });
}
