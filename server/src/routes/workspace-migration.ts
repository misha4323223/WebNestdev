import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "./admin.js";
import { applyNoStoreToReply } from "./cache-headers.js";
import { getProject } from "../project-store.js";
import { migrateProjectWorkspace, publicMigrationMeta } from "../storage/workspace-migration.js";
import { getProjectWorkspaceMeta } from "../storage/project-workspace-store.js";
import { recordAudit } from "../security/audit-journal.js";

const bodySchema = z.object({
  node: z.string().trim().min(1).max(120),
  confirm: z.literal(true),
});

/**
 * Ручная миграция проекта в локальном режиме. Запрос должен попасть на ноду-владельца через
 * owner-routing; иначе сервис сам откажется, чтобы не снять snapshot с пустого каталога.
 */
export async function registerWorkspaceMigrationRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/admin/projects/:id/migrate", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);
    const params = z.object({ id: z.string().min(1).max(200) }).parse(request.params);
    const body = bodySchema.parse(request.body);
    const project = await getProject(params.id);
    if (!project) return reply.code(404).send({ error: "Проект не найден" });
    const result = await migrateProjectWorkspace(project.id, project.userId, body.node);
    const meta = await getProjectWorkspaceMeta(project.id);
    await recordAudit({
      action: "admin.workspace.migrated",
      actorType: "admin",
      actorId: auth.admin.id,
      actorLabel: auth.admin.email,
      target: project.id,
      targetLabel: result.from + " → " + result.to,
    }).catch(() => undefined);
    return {
      ok: true,
      projectId: project.id,
      from: result.from,
      to: result.to,
      bytes: result.bytes,
      ...(meta ? { workspace: publicMigrationMeta(meta) } : {}),
    };
  });
}
