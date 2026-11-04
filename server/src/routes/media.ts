import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { requireProjectUser } from "../auth/auth.js";
import { accountPlanFor } from "../billing/store.js";
import { getStorageSnapshot } from "../account/storage-quota.js";
import {
  abortMultipartUpload,
  completeMultipartUpload,
  createMultipartUpload,
  deleteMediaObject,
  headMediaObject,
  invalidateMediaUsage,
  listMediaObjects,
  mediaConfigFromEnv,
  mediaKeyBelongsTo,
  MediaError,
  mediaPublicUrl,
  renameMediaObject,
  type MediaConfig,
} from "../media/media-store.js";
import { scanMediaUsage } from "../media/media-usage.js";

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

async function usageFor(
  config: MediaConfig,
  userId: string,
  projectId: string,
  urls: string[],
): Promise<{ usage: Map<string, { count: number; files: Array<{ path: string; line: number }> }>; truncated: boolean } | null> {
  try {
    return await scanMediaUsage(projectId, userId, config.publicBaseUrl, urls);
  } catch (error) {
    // Проект в архиве, песочница недоступна или файлы ещё не вернулись: это не повод
    // показывать «не используется». Лучше честно потребовать force для удаления.
    console.warn("[media] не удалось проверить ссылки в проекте", error);
    return null;
  }
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

  /**
   * Список того, что реально лежит в бакете. Он не зависит от истории чата: файл, который
   * забыли удалить, остаётся видимым и управляемым. `usage` показывает ссылки в исходниках,
   * чтобы интерфейс предупредил перед удалением или переименованием.
   */
  app.get("/api/projects/:id/media/objects", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const user = await requireProjectUser(request, reply, params.id);
    if (!user) return;
    try {
      const config = configOrThrow();
      const listed = await listMediaObjects(config, user.id, params.id);
      const scan = await usageFor(config, user.id, params.id, listed.objects.map(object => object.url));
      return {
        objects: listed.objects.map(object => ({
          ...object,
          usage: scan?.usage.get(object.url) ?? null,
        })),
        truncated: listed.truncated,
        usageTruncated: scan?.truncated ?? false,
        usageAvailable: scan !== null,
        publicBaseUrl: config.publicBaseUrl,
      };
    } catch (error) {
      return sendMediaError(reply, error);
    }
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
        // Замена: новый файл пишется в тот же ключ, поэтому URL в коде остаётся прежним.
        replaceKey: z.string().min(1).max(2000).optional(),
      }).parse(request.body);
      if (body.replaceKey && !mediaKeyBelongsTo(config, body.replaceKey, user.id, params.id)) {
        return reply.code(403).send({ error: "Этот ключ медиа не принадлежит проекту", code: "MEDIA_FOREIGN_KEY" });
      }
      // При замене в квоте считается только прирост: старый объект уже занимает место.
      const oldBytes = body.replaceKey ? (await headMediaObject(config, body.replaceKey)).bytes : 0;
      await assertQuota(user.id, Math.max(0, body.size - oldBytes));
      const upload = await createMultipartUpload(config, {
        userId: user.id,
        projectId: params.id,
        name: body.name,
        size: body.size,
        contentType: body.contentType,
        ...(body.replaceKey ? { key: body.replaceKey } : {}),
      });
      return upload;
    } catch (error) {
      return sendMediaError(reply, error);
    }
  });

  /**
   * Удаление одного готового файла: пользователь снял вложение до отправки или очищает медиа
   * вручную. Ключ обязан принадлежать этому проекту, иначе чужой объект удалить нельзя.
   */
  app.delete("/api/projects/:id/media", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const user = await requireProjectUser(request, reply, params.id);
    if (!user) return;
    try {
      const config = configOrThrow();
      const body = z.object({ key: z.string().min(1).max(2000), force: z.boolean().optional() }).parse(request.body);
      if (!mediaKeyBelongsTo(config, body.key, user.id, params.id)) {
        return reply.code(403).send({ error: "Этот ключ медиа не принадлежит проекту", code: "MEDIA_FOREIGN_KEY" });
      }
      const scan = await usageFor(config, user.id, params.id, [mediaPublicUrl(config, body.key)]);
      const used = scan?.usage.values().next().value;
      if (!body.force && (!scan || (used && used.count > 0))) {
        return reply.code(409).send({
          error: scan ? "Файл используется в проекте — сначала уберите ссылку или подтвердите удаление" : "Не удалось проверить ссылки в проекте — подтвердите удаление",
          code: "MEDIA_IN_USE",
          usage: used ?? null,
          usageAvailable: scan !== null,
        });
      }
      await deleteMediaObject(config, body.key);
      invalidateMediaUsage(user.id);
      return { deleted: true };
    } catch (error) {
      return sendMediaError(reply, error);
    }
  });

  /**
   * Переименование — это новый ключ, а значит новый URL. Поэтому используемый файл
   * переименовывать нельзя: иначе ссылки в исходниках молча станут битыми. Для используемых
   * картинок правильное действие — «Заменить» с тем же ключом.
   */
  app.post("/api/projects/:id/media/rename", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const user = await requireProjectUser(request, reply, params.id);
    if (!user) return;
    try {
      const config = configOrThrow();
      const body = z.object({
        key: z.string().min(1).max(2000),
        name: z.string().trim().min(1).max(300),
      }).parse(request.body);
      if (!mediaKeyBelongsTo(config, body.key, user.id, params.id)) {
        return reply.code(403).send({ error: "Этот ключ медиа не принадлежит проекту", code: "MEDIA_FOREIGN_KEY" });
      }
      const scan = await usageFor(config, user.id, params.id, [mediaPublicUrl(config, body.key)]);
      const used = scan?.usage.values().next().value;
      if (!scan || (used && used.count > 0)) {
        return reply.code(409).send({
          error: scan ? "Файл используется в проекте — переименование сломает ссылки. Замените файл, чтобы сохранить URL." : "Не удалось проверить ссылки в проекте — переименование отменено",
          code: "MEDIA_IN_USE",
          usage: used ?? null,
          usageAvailable: scan !== null,
        });
      }
      const result = await renameMediaObject(config, {
        userId: user.id,
        projectId: params.id,
        key: body.key,
        name: body.name,
      });
      invalidateMediaUsage(user.id);
      return result;
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
      // Для замены старый объект ещё лежит в бакете: в квоту идёт только прирост.
      const existing = await listMediaObjects(config, user.id, params.id).then(list => list.objects.find(object => object.key === body.key));
      await assertQuota(user.id, Math.max(0, body.bytes - (existing?.bytes ?? 0))).catch(async error => {
        await abortMultipartUpload(config, body.key, body.uploadId).catch(() => undefined);
        throw error;
      });
      const result = await completeMultipartUpload(config, {
        key: body.key,
        uploadId: body.uploadId,
        parts: body.parts,
        expectedBytes: body.bytes,
        preserveOnMismatch: Boolean(existing),
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
