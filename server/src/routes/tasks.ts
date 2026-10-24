import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireProjectUser } from "../auth/auth.js";
import { getSandbox } from "../sandbox-manager.js";
import { recordStorageMutation } from "../account/storage-quota.js";
import { addTasks, readTasks, removeTask, toggleTask, TasksConflictError } from "../tasks/task-file.js";
import { applyNoStoreToReply } from "./cache-headers.js";

/**
 * Задачи проекта: `TASKS.md` читается, дополняется и отмечается через один маршрут.
 *
 * Зависимости вынесены наружу для теста (как у палитры): в тесте не нужен ни Docker, ни
 * настоящая сессия, достаточно временного каталога проекта. В production — обычная авторизация
 * проекта и песочница.
 */
export type TasksRouteDeps = {
  authorize: (request: FastifyRequest, reply: FastifyReply, projectId: string) => Promise<{ id: string } | null>;
  getSandbox: (projectId: string, userId: string) => Promise<{ root: string }>;
  onMutation?: (projectId: string, userId: string) => Promise<void>;
};

const defaultDeps: TasksRouteDeps = {
  authorize: requireProjectUser,
  getSandbox: (projectId, userId) => getSandbox(projectId, userId),
  onMutation: recordStorageMutation,
};

const addBody = z.object({
  items: z.array(z.object({
    title: z.string().min(1).max(500),
    section: z.string().max(120).optional(),
    done: z.boolean().optional(),
  })).min(1).max(100),
  section: z.string().max(120).optional(),
  revision: z.string().min(1).optional(),
});

const patchBody = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("toggle"),
    line: z.number().int().positive(),
    done: z.boolean(),
    revision: z.string().min(1),
  }),
  z.object({
    op: z.literal("remove"),
    line: z.number().int().positive(),
    revision: z.string().min(1),
  }),
]);

function taskError(reply: FastifyReply, error: unknown) {
  if (error instanceof TasksConflictError) {
    return reply.code(409).send({ error: error.message, tasks: error.state });
  }
  const message = error instanceof Error ? error.message : String(error);
  return reply.code(400).send({ error: message });
}

export async function registerTasksRoutes(app: FastifyInstance, deps: TasksRouteDeps = defaultDeps) {
  async function project(request: FastifyRequest, reply: FastifyReply) {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const user = await deps.authorize(request, reply, params.id);
    if (!user) return null;
    const sandbox = await deps.getSandbox(params.id, user.id);
    return { projectId: params.id, userId: user.id, root: sandbox.root };
  }

  app.get("/api/projects/:id/tasks", async (request, reply) => {
    const context = await project(request, reply);
    if (!context) return;
    applyNoStoreToReply(reply);
    try {
      return await readTasks(context.root);
    } catch (error) {
      return taskError(reply, error);
    }
  });

  app.post("/api/projects/:id/tasks", async (request, reply) => {
    const context = await project(request, reply);
    if (!context) return;
    const body = addBody.parse(request.body ?? {});
    applyNoStoreToReply(reply);
    try {
      const next = await addTasks(context.root, body);
      if (next.added) {
        await deps.onMutation?.(context.projectId, context.userId).catch(error => {
          request.log.warn({ error }, "[tasks] не удалось обновить размер проекта после записи задач");
        });
      }
      return next;
    } catch (error) {
      return taskError(reply, error);
    }
  });

  app.patch("/api/projects/:id/tasks", async (request, reply) => {
    const context = await project(request, reply);
    if (!context) return;
    const body = patchBody.parse(request.body ?? {});
    applyNoStoreToReply(reply);
    try {
      const next = body.op === "toggle"
        ? await toggleTask(context.root, body)
        : await removeTask(context.root, body);
      await deps.onMutation?.(context.projectId, context.userId).catch(error => {
        request.log.warn({ error }, "[tasks] не удалось обновить размер проекта после правки задач");
      });
      return next;
    } catch (error) {
      return taskError(reply, error);
    }
  });
}
