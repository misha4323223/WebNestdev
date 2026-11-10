import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "./admin.js";
import { applyNoStoreToReply } from "./cache-headers.js";
import { getProject } from "../project-store.js";
import { sandboxRootPath } from "../sandbox/config.js";
import { repairProjectOwnership, type OwnershipRepair } from "../sandbox/ownership-repair.js";
import { recordAudit, type AuditInput } from "../security/audit-journal.js";

/**
 * Ручной ремонт прав проекта из внешней админки.
 *
 * Когда у проекта в `node_modules` (или в другом каталоге) остаются файлы `root:root`,
 * контейнер с uid 1000 не может их удалить, и установка/сборка падает с
 * `EACCES: permission denied, unlink ...`. Автоматически это лечит host-таймер
 * `webnestdev-sandbox-ownership` (раз в минуту, рекурсивно, на обеих ВМ). Эта ручка нужна,
 * когда ждать минуту нельзя или таймер выключен: админ открывает карточку проекта и запускает
 * ремонт, не заходя на ВМ.
 *
 * Ручка идемпотентна: меняет владельца только у элементов с чужим uid/gid, поэтому повторный
 * вызов дешёвый. Разрушительных действий нет — файлы не удаляются, только `chown`.
 * Общий storage смонтирован на обеих ВМ, поэтому путь один и тот же независимо от того, за
 * каким узлом закреплён проект.
 */

const paramsSchema = z.object({ id: z.string().min(1).max(200) });

export type AdminProjectPermissionsDeps = {
  getProject: typeof getProject;
  repair: (projectId: string) => Promise<OwnershipRepair>;
  audit: (input: AuditInput) => Promise<unknown>;
};

const defaultDeps: AdminProjectPermissionsDeps = {
  getProject,
  repair: projectId => repairProjectOwnership(sandboxRootPath(projectId)),
  audit: input => recordAudit(input),
};

export async function registerAdminProjectPermissionsRoutes(
  app: FastifyInstance,
  overrides: Partial<AdminProjectPermissionsDeps> = {},
) {
  const deps: AdminProjectPermissionsDeps = { ...defaultDeps, ...overrides };

  app.post("/api/admin/projects/:id/permissions", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);

    const { id } = paramsSchema.parse(request.params);
    const project = await deps.getProject(id);
    if (!project) return reply.code(404).send({ error: "Проект не найден" });

    const result = await deps.repair(project.id);
    if (result.missing) {
      return reply.code(409).send({
        error: "У проекта ещё нет каталога на общем storage — ремонтировать нечего",
        code: "NO_WORKSPACE",
      });
    }

    await deps.audit({
      action: "admin.project.permissions",
      actorType: "admin",
      actorId: auth.admin.id,
      actorLabel: auth.admin.email,
      target: project.id,
      targetLabel: project.name,
      details: {
        entries: result.entries,
        repaired: result.repaired,
        failed: result.failed,
        truncated: result.truncated,
      },
    });
    console.log(
      "[admin] проект " + project.id + ": права восстановлены (элементов " + result.entries +
        ", исправлено " + result.repaired + ", ошибок " + result.failed + ")",
    );
    return { ok: true, projectId: project.id, ...result };
  });
}
