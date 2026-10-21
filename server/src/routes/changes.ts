import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireProjectUser } from "../auth/auth.js";
import {
  changesOverview,
  createRepositoryForProject,
  listProjectBranches,
  pullFromGithub,
  pushCurrentBranch,
  rollbackToCheckpoint,
  switchProjectBranch,
} from "../changes/changes-service.js";

/**
 * «Изменения» проекта: история коммитов, откат к точке и повторная отправка на GitHub.
 * Маршруты проверяют владельца проекта так же, как файлы и терминал: точка в истории — это
 * весь код проекта, а не только название.
 */
export async function registerChangesRoutes(app: FastifyInstance) {
  app.get("/api/projects/:id/changes", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const user = await requireProjectUser(request, reply, params.id);
    if (!user) return;
    return changesOverview(params.id, user.id);
  });

  /**
   * Репозиторий для проекта, созданного в приложении: без него отправлять коммиты некуда,
   * а «Изменения» работали бы только для импортированных проектов.
   */
  app.post("/api/projects/:id/changes/repository", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const user = await requireProjectUser(request, reply, params.id);
    if (!user) return;
    const body = z.object({ name: z.string().trim().max(100).optional() }).parse(request.body ?? {});
    try {
      return reply.code(201).send(await createRepositoryForProject(params.id, user.id, body.name));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /**
   * Ветки проекта: список для меню в шапке. Отправка уходит в текущую ветку, поэтому выбор
   * здесь — это выбор, куда выгружать, а не отдельный «пуш в другую ветку».
   */
  app.get("/api/projects/:id/changes/branches", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const user = await requireProjectUser(request, reply, params.id);
    if (!user) return;
    return listProjectBranches(params.id, user.id);
  });

  app.post("/api/projects/:id/changes/branches/switch", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const user = await requireProjectUser(request, reply, params.id);
    if (!user) return;
    const body = z.object({ branch: z.string().min(1).max(120) }).parse(request.body ?? {});
    try {
      return await switchProjectBranch(params.id, user.id, body.branch);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/projects/:id/changes/push", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const user = await requireProjectUser(request, reply, params.id);
    if (!user) return;
    try {
      const outcome = await pushCurrentBranch(params.id, user.id);
      if (!outcome.pushed) {
        return reply.code(502).send({ error: outcome.error ?? "Не удалось отправить изменения на GitHub", branch: outcome.branch });
      }
      return { pushed: true, branch: outcome.branch, at: outcome.at };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /**
   * Выгрузка из GitHub — обратное действие к отправке. Ответ 200 и при отказе fast-forward:
   * это не сбой сервера, а объяснение, почему выгрузка не стала перезаписывать работу.
   */
  app.post("/api/projects/:id/changes/pull", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const user = await requireProjectUser(request, reply, params.id);
    if (!user) return;
    try {
      return await pullFromGithub(params.id, user.id);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/projects/:id/changes/:sha/rollback", async (request, reply) => {
    const params = z.object({ id: z.string().min(1), sha: z.string().min(7).max(40) }).parse(request.params);
    const user = await requireProjectUser(request, reply, params.id);
    if (!user) return;
    try {
      const result = await rollbackToCheckpoint(params.id, user.id, params.sha);
      return { ...result, overview: await changesOverview(params.id, user.id) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
