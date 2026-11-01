import type { FastifyInstance } from "fastify";
import { requireAdmin } from "./admin.js";
import { applyNoStoreToReply } from "./cache-headers.js";
import { recordAudit } from "../security/audit-journal.js";
import {
  creditSettings,
  creditSettingsPatchSchema,
  creditTopUpExamples,
  publicCreditTopUp,
  saveCreditSettings,
} from "../billing/credit-settings.js";

/**
 * Настройка докупки кредитов для внешней админки.
 *
 * Покупатель вводит любое количество кредитов от 1000; цену считает сервер по ставке за 1000.
 * Здесь владелец платформы задаёт эту ставку и границы. Ответ сразу содержит примеры сумм,
 * чтобы не проверять формулу в голове. Уже выставленные счета не пересчитываются: сумма
 * зафиксирована в `credit_purchases` и в ссылке Робокассы.
 */
export async function registerAdminCreditRoutes(app: FastifyInstance) {
  app.get("/api/admin/billing/credits", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);
    return {
      creditTopUp: publicCreditTopUp(),
      examples: creditTopUpExamples(),
    };
  });

  app.post("/api/admin/billing/credits", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);
    const parsed = creditSettingsPatchSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Проверьте цену, минимум и максимум" });
    }
    const current = creditSettings();
    const next = { ...current, ...parsed.data };
    if (next.minCredits > next.maxCredits) {
      return reply.code(400).send({ error: "Минимум не может быть больше максимума" });
    }
    await saveCreditSettings(next);
    await recordAudit({
      action: "billing.credits.updated",
      actorType: "admin",
      actorId: auth.admin.id,
      actorLabel: auth.admin.email,
      ip: request.ip,
      details: {
        pricePer1000Rub: next.pricePer1000Rub,
        minCredits: next.minCredits,
        maxCredits: next.maxCredits,
      },
    });
    return {
      saved: true,
      creditTopUp: publicCreditTopUp(),
      examples: creditTopUpExamples(),
    };
  });
}
