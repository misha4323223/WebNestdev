import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { requireProjectUser } from "../auth/auth.js";
import { accountPlanFor } from "../billing/store.js";
import { getStorageSnapshot } from "../account/storage-quota.js";
import {
  abortMultipartUpload,
  completeMultipartUpload,
  createMultipartUpload,
  invalidateMediaUsage,
  mediaConfigFromEnv,
  mediaKeyBelongsTo,
  MediaError,
  type MediaConfig,
} from "../media/media-store.js";

/**
 * Прямая загрузка больших файлов в публичный бакет. Браузер получает presigned URL на каждую
 * часть, поэтому 10 ГБ не проходят через JSON, память Node и лимит тела Fastify. Сервер
 * проверяет владельца проекта, квоту и завершает multipart, а публичная ссылка появляется
 * только после успешного complete.
 */

function configOrThrow(): MediaConfig {
  const config = mediaConfigFromEnv();
  if (!config) {
    throw new MediaError("MEDIA_DISABLED", "Медиа-хранилище не настроено", 503);
  }
  return config;
}

function sendMediaError(reply: FastifyReply, error: unknown) {
  if (error instanceof MediaError) {
    return reply.code(error.statusCode).send({ error: error.message, code: error.code });
  }
  throw error;
}

async function assertQuota(userId: string, addBytes: number) {
  const plan = await accountPlanFor(userId);
  const { usedBytes, limitBytes } = await getStorageSnapshot(userId, plan);
  if (limitBytes <= 0) return;
  if (usedBytes + addBytes > limitBytes) {
    throw new MediaError(
      "MEDIA_QUOTA",
      "Файл не помещается в хранилище тарифа: занято " + Math.round(usedBytes / 1024 / 1024) +
        " МБ из " + Math.round(limitBytes / 1024 / 1024) + " МБ",
      429,
    );
  }
}

export async function registerMediaRoutes(app: FastifyInstance) {
  app.get("/api/projects/:id/media", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const user = await requireProjectUser(request, reply, params.id);
    if (!user) return;
    let config: MediaConfig | null = null;
    try {
      config = mediaConfigFromEnv();
    } catch (error) {
      return reply.code(503).send({ error: error instanceof Error ? error.message : String(error), code: "MEDIA_MISCONFIGURED" });
    }
    return {
      enabled: config !== null,
      maxFileBytes: config?.maxFileBytes ?? 0,
      partSizeBytes: config?.partSizeBytes ?? 0,
      publicBaseUrl: config?.publicBaseUrl ?? null,
    };
  });

  app.post("/api/projects/:id/media", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const user = await requireProjectUser(request, reply, params.id);
    if (!user) return;
    try {
      const config = configOrThrow();
      const body = z.object({
        name: z.string().min(1).max(300),
        size: z.number().int().positive(),
        contentType: z.string().max(200).optional(),
      }).parse(request.body);
      await assertQuota(user.id, body.size);
      const upload = await createMultipartUpload(config, {
        userId: user.id,
        projectId: params.id,
        name: body.name,
        size: body.size,
        contentType: body.contentType,
      });
      return upload;
    } catch (error) {
      return sendMediaError(reply, error);
    }
  });

  app.post("/api/projects/:id/media/complete", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const user = await requireProjectUser(request, reply, params.id);
    if (!user) return;
    try {
      const config = configOrThrow();
      const body = z.object({
        key: z.string().min(1).max(2000),
        uploadId: z.string().min(1).max(2000),
        bytes: z.number().int().positive(),
        parts: z.array(z.object({
          partNumber: z.number().int().min(1).max(10_000),
          etag: z.string().min(1).max(200),
        })).min(1).max(10_000),
      }).parse(request.body);
      if (!mediaKeyBelongsTo(config, body.key, user.id, params.id)) {
        return reply.code(403).send({ error: "Этот ключ медиа не принадлежит проекту", code: "MEDIA_FOREIGN_KEY" });
      }
      // Размер в начале загрузки — обещание клиента, а не факт. На завершении проверяем
      // фактический размер ещё раз, иначе можно начать с одного байта и залить гигабайт.
      await assertQuota(user.id, body.bytes).catch(async error => {
        await abortMultipartUpload(config, body.key, body.uploadId).catch(() => undefined);
        throw error;
      });
      const result = await completeMultipartUpload(config, {
        key: body.key,
        uploadId: body.uploadId,
        parts: body.parts,
        expectedBytes: body.bytes,
      });
      invalidateMediaUsage(user.id);
      return result;
    } catch (error) {
      return sendMediaError(reply, error);
    }
  });

  app.post("/api/projects/:id/media/abort", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const user = await requireProjectUser(request, reply, params.id);
    if (!user) return;
    try {
      const config = configOrThrow();
      const body = z.object({
        key: z.string().min(1).max(2000),
        uploadId: z.string().min(1).max(2000),
      }).parse(request.body);
      if (!mediaKeyBelongsTo(config, body.key, user.id, params.id)) {
        return reply.code(403).send({ error: "Этот ключ медиа не принадлежит проекту", code: "MEDIA_FOREIGN_KEY" });
      }
      await abortMultipartUpload(config, body.key, body.uploadId);
      return { aborted: true };
    } catch (error) {
      return sendMediaError(reply, error);
    }
  });
}
