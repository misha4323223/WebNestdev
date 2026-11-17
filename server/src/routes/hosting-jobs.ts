import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { getSiteByProject } from "../hosting/site-store.js";
import { listJobs } from "../jobs/store.js";
import {
  enqueueBackgroundJobs,
  publicBackgroundJob,
  BACKGROUND_JOBS_MAX_ACTIVE_PER_PROJECT,
} from "../hosting/background-jobs.js";
import { BACKGROUND_JOB_MAX_PAYLOAD_BYTES } from "../functions/invoke.js";
import { HostingError } from "../hosting/types.js";
import { requireProject } from "./hosting.js";

/**
 * API фоновых заданий сайта. Постановка из функции идёт через ответ HTTP-обработчика;
 * этот маршрут нужен владельцу для проверки и для повторного запуска после ошибки.
 * Права те же, что у хостинга: проект принадлежит пользователю.
 */

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof HostingError) {
    return reply.code(error.statusCode).send({ error: error.message, code: error.code });
  }
  throw error;
}

export async function registerHostingJobRoutes(app: FastifyInstance) {
  app.get("/api/projects/:id/hosting/jobs", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const auth = await requireProject(request, reply, params.id);
    if (!auth) return;
    const site = await getSiteByProject(params.id);
    if (!site || site.userId !== auth.user.id || site.status === "deleted") {
      return reply.code(404).send({ error: "Сайт не найден", code: "SITE_NOT_FOUND" });
    }
    const jobs = await listJobs({
      projectId: params.id,
      siteId: site.id,
      kind: "hosting.job",
      limit: BACKGROUND_JOBS_MAX_ACTIVE_PER_PROJECT,
    });
    return { jobs: jobs.map(publicBackgroundJob) };
  });

  app.post("/api/projects/:id/hosting/jobs", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const auth = await requireProject(request, reply, params.id);
    if (!auth) return;
    const site = await getSiteByProject(params.id);
    if (!site || site.userId !== auth.user.id || site.status === "deleted") {
      return reply.code(404).send({ error: "Сайт не найден", code: "SITE_NOT_FOUND" });
    }
    const body = z.object({
      name: z.string().trim().regex(/^[a-z][a-z0-9-]{0,62}$/),
      payload: z.unknown().optional(),
      idempotencyKey: z.string().trim().min(1).max(200).optional(),
    }).parse(request.body ?? {});
    const payload = body.payload ?? {};
    if (Buffer.byteLength(JSON.stringify(payload), "utf8") > BACKGROUND_JOB_MAX_PAYLOAD_BYTES) {
      return reply.code(413).send({ error: "payload задания больше 64 КиБ", code: "BACKGROUND_JOB_LIMIT" });
    }
    try {
      const jobs = await enqueueBackgroundJobs({
        site,
        requests: [{
          name: body.name,
          payload,
          ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
        }],
      });
      return reply.code(202).send({ jobs: jobs.map(publicBackgroundJob) });
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
