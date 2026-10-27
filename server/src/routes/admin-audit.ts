import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "./admin.js";
import { AUDIT_ACTIONS, listAudit, type AuditAction } from "../security/audit-journal.js";

/**
 * Журнал безопасности для админ-приложения: последние события входа, второго фактора, ключей
 * платформы и удаления проектов.
 *
 * Только чтение и только по админ-токену. Значений ключей, паролей и TOTP-секретов в записях нет:
 * `audit-journal.ts` принимает лишь простые подробности и обрезает строки, а вызывающие передают
 * туда имена, счётчики и причины, не сами данные.
 *
 * Фильтр по действию ограничен каталогом `AUDIT_ACTIONS`: опечатка в имени события иначе молча
 * возвращала бы пустой список, и админка выглядела бы как «событий не было».
 */

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  action: z.string().trim().max(80).optional(),
  actorId: z.string().trim().max(200).optional(),
  days: z.coerce.number().int().min(0).max(365).default(0),
});

export function auditCatalogue() {
  return (Object.keys(AUDIT_ACTIONS) as AuditAction[]).map(action => ({
    action,
    label: AUDIT_ACTIONS[action],
  }));
}

export async function registerAdminAuditRoutes(app: FastifyInstance) {
  app.get("/api/admin/audit", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;

    const parsed = querySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Некорректный запрос" });
    }
    const { limit, action, actorId, days } = parsed.data;
    if (action && !(action in AUDIT_ACTIONS)) {
      return reply.code(400).send({
        error: "Неизвестное действие: " + action,
        actions: auditCatalogue().map(item => item.action),
      });
    }

    const entries = await listAudit({ limit, action, actorId, days });
    return {
      entries,
      total: entries.length,
      range: { days, limit },
      actions: auditCatalogue(),
    };
  });
}
