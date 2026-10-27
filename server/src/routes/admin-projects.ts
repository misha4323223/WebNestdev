import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "./admin.js";
import { applyNoStoreToReply } from "./cache-headers.js";
import { getProject } from "../project-store.js";
import { getUser } from "../auth/auth-store.js";
import { sandboxRootPath } from "../sandbox/config.js";
import { listProjectSecrets } from "../secrets/project-secrets.js";
import { readDeployPlan } from "../deploy/deploy-plan.js";
import { previewStatus } from "../preview-manager.js";

/**
 * Карточка проекта для админки.
 *
 * Раньше проект в админке был одной строкой с токенами: имя, владелец, дата. По ней нельзя было
 * ответить на вопрос, с которым приходит человек, — «превью не открывается», «куда он это
 * выкатывает», «почему сборка падает». Здесь собрано то, что уже есть на сервере, без новых
 * хранилищ: репозиторий из записи проекта, состояние превью из менеджера, переменные из секретов
 * проекта и последний план выкатки из `deploy_project.md` в песочнице.
 *
 * Значений секретов в ответе нет и быть не может: `listProjectSecrets` отдаёт имя, файл и форму
 * значения («скрыто · 3 строки»), а не само значение — тот же инвариант, что у панели.
 *
 * Только чтение: админка смотрит, а действия над проектами остаются за владельцем и агентом.
 */

const paramsSchema = z.object({ id: z.string().min(1).max(200) });

export async function registerAdminProjectRoutes(app: FastifyInstance) {
  app.get("/api/admin/projects/:id", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);

    const { id } = paramsSchema.parse(request.params);
    const project = await getProject(id);
    if (!project) return reply.code(404).send({ error: "Проект не найден" });

    const root = sandboxRootPath(project.id);
    const [owner, secrets, preview] = await Promise.all([
      getUser(project.userId),
      // Проект мог быть создан до появления секретов или песочница могла быть удалена:
      // отсутствие файлов не должно превращать карточку в ошибку.
      listProjectSecrets(project.id, root).catch(() => []),
      previewStatus(project.id).catch(() => ({ running: false as const })),
    ]);

    let deploy: unknown = null;
    try {
      deploy = await readDeployPlan(root);
    } catch (error) {
      deploy = { exists: false, error: error instanceof Error ? error.message : String(error) };
    }

    return {
      project: {
        id: project.id,
        name: project.name,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        repository: project.github ?? null,
      },
      owner: owner ? { id: owner.id, email: owner.email, createdAt: owner.createdAt } : { id: project.userId, email: null, createdAt: null },
      preview: {
        ...preview,
        /** Причина, по которой живое превью не отвечает, — ровно то, что нужно для разбора. */
        error: preview.running ? preview.hint ?? null : null,
      },
      secrets: {
        count: secrets.length,
        variables: secrets.map(secret => ({ name: secret.name, file: secret.file, preview: secret.preview })),
      },
      deploy,
    };
  });
}
