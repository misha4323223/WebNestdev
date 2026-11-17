import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { validInternalToken } from "../nodes/internal-auth.js";
import { restoreProjectSnapshot } from "../storage/workspace-snapshot.js";

/**
 * Внутренние операции с workspace между нодами. Публичный Caddy видит `/api/internal`, поэтому
 * единственная защита — общий токен; без него маршрут отвечает 401. Пользовательские сессии сюда
 * не допускаются: это не API панели.
 */
export async function registerInternalWorkspaceRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/internal/workspace/restore", async (request, reply) => {
    if (!validInternalToken(request.headers["x-webnestdev-internal-token"])) {
      return reply.code(401).send({ error: "Внутренний токен не принят" });
    }
    const body = z.object({
      projectId: z.string().min(1).max(200),
      userId: z.string().min(1).max(200),
    }).parse(request.body);
    const result = await restoreProjectSnapshot(body.projectId, body.userId);
    return { ok: true, ...result };
  });
}
