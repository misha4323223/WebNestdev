import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/auth.js";
import { getDatabaseConnection } from "../database/database-connection-store.js";
import { checkDatabaseReachable, databaseStatus, disconnectDatabase, saveDatabaseCredential } from "../database/database-api.js";
import { accountPlanFor } from "../billing/store.js";
import { getProject } from "../project-store.js";
import { getSandbox } from "../sandbox-manager.js";
import {
  ClientDatabaseError,
  accountClientDatabaseStatus,
  clientDatabaseStatus,
  connectClientDatabase,
  disconnectClientDatabase,
} from "../database/client-db/service.js";

const credential = z.object({
  provider: z.string().max(60).optional(),
  url: z.string().max(2000).optional(),
  scheme: z.string().max(40).optional(),
  host: z.string().max(300).optional(),
  port: z.union([z.number(), z.string().max(10)]).optional(),
  database: z.string().max(200).optional(),
  username: z.string().max(200).optional(),
  password: z.string().max(500).optional(),
  ssl: z.boolean().optional(),
});

/**
 * The database the user's own project stores data in. Only the connection metadata is
 * ever returned; the password and the full connection string stay on the server.
 */
export async function registerDatabaseRoutes(app: FastifyInstance) {
  app.get("/api/database/status", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    return databaseStatus(user.id);
  });

  app.post("/api/database/connection", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = credential.parse(request.body ?? {});
    try {
      return await saveDatabaseCredential(user.id, body);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Не удалось сохранить подключение" });
    }
  });

  /** Reachability from the API host, which is what the user can act on. */
  app.post("/api/database/check", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const connection = await getDatabaseConnection(user.id);
    if (!connection) return reply.code(400).send({ error: "База данных не подключена" });
    const result = await checkDatabaseReachable(connection);
    return { ...result, host: connection.host, port: connection.port };
  });

  app.post("/api/database/disconnect", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    await disconnectDatabase(user.id);
    return { connected: false };
  });

  /**
   * Использование встроенной базы на уровне аккаунта: личный кабинет показывает его в обзоре
   * ресурсов, где ещё нет выбранного проекта. Секреты проекта здесь не читаются.
   */
  app.get("/api/account/client-database", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const plan = await accountPlanFor(user.id).catch(() => "free" as const);
    return accountClientDatabaseStatus({ userId: user.id, plan });
  });

  /**
   * Клиентская база платформы. Путь проектный, потому что `DATABASE_URL` живёт в зашифрованном
   * хранилище проекта, а схема — у аккаунта: один аккаунт, одна схема, строка в каждом проекте.
   */
  app.get("/api/projects/:id/client-database", async (request, reply) => {
    const scope = await projectScope(request, reply);
    if (!scope) return;
    return clientDatabaseStatus(scope);
  });

  app.post("/api/projects/:id/client-database", async (request, reply) => {
    const scope = await projectScope(request, reply);
    if (!scope) return;
    try {
      return await connectClientDatabase(scope);
    } catch (error) {
      return replyClientDatabaseError(reply, error);
    }
  });

  app.delete("/api/projects/:id/client-database", async (request, reply) => {
    const scope = await projectScope(request, reply);
    if (!scope) return;
    try {
      return await disconnectClientDatabase(scope);
    } catch (error) {
      return replyClientDatabaseError(reply, error);
    }
  });
}

/**
 * Проект, его владелец и текущий тариф. Чужой проект отвечает 404, а не 403: существование
 * чужого проекта не должно становиться утечкой. Тариф читается на каждый запрос, поэтому
 * смена подписки действует без перезапуска.
 */
async function projectScope(request: FastifyRequest, reply: FastifyReply) {
  const user = await requireUser(request, reply); if (!user) return null;
  const { id } = z.object({ id: z.string().min(1).max(120) }).parse(request.params);
  const project = await getProject(id);
  if (!project || project.userId !== user.id) {
    reply.code(404).send({ error: "Проект не найден" });
    return null;
  }
  const sandbox = await getSandbox(id, user.id);
  const plan = await accountPlanFor(user.id).catch(() => "free" as const);
  return { userId: user.id, projectId: id, root: sandbox.root, plan };
}

function replyClientDatabaseError(reply: FastifyReply, error: unknown) {
  if (error instanceof ClientDatabaseError) {
    return reply.code(error.statusCode).send({ error: error.message, code: error.code });
  }
  return reply.code(500).send({ error: error instanceof Error ? error.message : "Ошибка клиентской базы" });
}
