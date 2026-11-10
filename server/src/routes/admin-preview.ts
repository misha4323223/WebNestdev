import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "./admin.js";
import { applyNoStoreToReply } from "./cache-headers.js";
import { getProject } from "../project-store.js";
import { nodeId } from "../nodes/identity.js";
import { hydratePreview } from "../preview/preview-store.js";
import { resetProjectPreview, type PreviewResetResult } from "../preview/preview-reset.js";
import { recordAudit, type AuditInput } from "../security/audit-journal.js";

/**
 * Ручной разбор зависшего предпросмотра из внешней админки.
 *
 * Пользователь видит «Этот предпросмотр уже запускается», когда в PostgreSQL осталась бронь,
 * а строка состояния потеряна. Автоматическое принятие контейнера помогает не всегда: контейнера
 * может не быть, Docker может быть недоступен, а запуск — упасть между шагами. Эта ручка —
 * последний ручной путь: оператор открывает карточку проекта, видит `preview.reservation` и
 * сбрасывает состояние. Следующий запуск начинает с чистого листа.
 *
 * Действие разрушительное для текущего предпросмотра (контейнер останавливается), поэтому
 * требует `confirm: true` и пишется в журнал безопасности.
 */

const bodySchema = z.object({ confirm: z.literal(true) });
const paramsSchema = z.object({ id: z.string().min(1).max(200) });

export type AdminPreviewDeps = {
  getProject: typeof getProject;
  hydrate: typeof hydratePreview;
  reset: (projectId: string, nodes: string[]) => Promise<PreviewResetResult>;
  audit: (input: AuditInput) => Promise<unknown>;
};

const defaultDeps: AdminPreviewDeps = {
  getProject,
  hydrate: hydratePreview,
  reset: (projectId, nodes) => resetProjectPreview(projectId, nodes),
  audit: input => recordAudit(input),
};

export async function registerAdminPreviewResetRoutes(
  app: FastifyInstance,
  overrides: Partial<AdminPreviewDeps> = {},
) {
  const deps: AdminPreviewDeps = { ...defaultDeps, ...overrides };

  app.post("/api/admin/projects/:id/preview/reset", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);

    const parsed = bodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Сброс предпросмотра требует подтверждения",
        code: "CONFIRM_REQUIRED",
      });
    }

    const { id } = paramsSchema.parse(request.params);
    const project = await deps.getProject(id);
    if (!project) return reply.code(404).send({ error: "Проект не найден" });

    // Контейнер мог остаться на узле, записанном в состоянии, даже если проект уже закреплён
    // за другим: сбрасываем на обоих, чтобы не оставить сироту.
    const state = await deps.hydrate(id).catch(() => undefined);
    const nodes = [
      ...new Set(
        [project.node?.trim() || nodeId(), state?.node]
          .map(value => value?.trim())
          .filter((value): value is string => Boolean(value)),
      ),
    ];

    const result = await deps.reset(id, nodes);
    await deps.audit({
      action: "admin.preview.reset",
      actorType: "admin",
      actorId: auth.admin.id,
      actorLabel: auth.admin.email,
      target: id,
      targetLabel: project.name,
      details: {
        removedContainers: result.removedContainers.length,
        remainingContainers: result.remainingContainers.length,
        reservationCleared: result.reservationCleared,
        warnings: result.warnings.length,
      },
    });
    console.log(
      "[admin] проект " + id + ": предпросмотр сброшен (контейнеров удалено " +
        result.removedContainers.length + ", осталось " + result.remainingContainers.length + ")",
    );
    return { ok: true, ...result };
  });
}
