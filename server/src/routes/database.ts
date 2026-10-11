import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/auth.js";
import { getDatabaseConnection } from "../database/database-connection-store.js";
import { checkDatabaseReachable, databaseStatus, disconnectDatabase, saveDatabaseCredential } from "../database/database-api.js";

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
}
