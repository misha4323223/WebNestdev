import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "./admin.js";
import { applyNoStoreToReply } from "./cache-headers.js";
import { recordAudit } from "../security/audit-journal.js";
import { savePlatformEnv } from "../platform/platform-env.js";
import { imageGenerationStatus } from "../provider/image-generation.js";

const IMAGE_KEY_NAMES = ["PLATFORM_IMAGE_KEY_1", "PLATFORM_IMAGE_KEY_2", "PLATFORM_IMAGE_KEY_3"] as const;

const imageUrl = z.string().trim().max(500).refine(
  value => !value || /^https?:\/\/[^\s]+$/i.test(value),
  "Нужен адрес вида https://…",
);

/**
 * Генерация изображений для внешней админки: тот же Bearer-вход, что у остальных
 * `/api/admin/*`. Секреты не возвращаются; `apiKey` при отсутствии сохраняет текущий ключ,
 * `clearKeys` удаляет все сохранённые ключи и возвращает чтение из окружения.
 */
const imageSchema = z.object({
  baseUrl: imageUrl.optional(),
  model: z.string().trim().max(300).optional(),
  provider: z.string().trim().max(120).optional(),
  apiKey: z.string().trim().max(20_000).optional(),
  clearKeys: z.boolean().optional(),
}).superRefine((data, ctx) => {
  if (data.clearKeys && data.apiKey?.trim()) {
    ctx.addIssue({
      code: "custom",
      message: "Нельзя одновременно передать новый ключ и очистить ключи",
      path: ["apiKey"],
    });
  }
});

export async function registerAdminAiImageRoutes(app: FastifyInstance) {
  app.get("/api/admin/ai/image", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);
    return { image: imageGenerationStatus() };
  });

  app.post("/api/admin/ai/image", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);

    const parsed = imageSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Проверьте Base URL, модель и ключ" });
    }

    const values: Record<string, string> = {};
    if (parsed.data.baseUrl !== undefined) values.PLATFORM_IMAGE_BASE_URL = parsed.data.baseUrl;
    if (parsed.data.model !== undefined) values.PLATFORM_IMAGE_MODEL = parsed.data.model;
    if (parsed.data.provider !== undefined) values.PLATFORM_IMAGE_PROVIDER = parsed.data.provider;
    if (parsed.data.apiKey?.trim()) values.PLATFORM_IMAGE_KEY_1 = parsed.data.apiKey;
    if (parsed.data.clearKeys) {
      for (const name of IMAGE_KEY_NAMES) values[name] = "";
    }
    if (!Object.keys(values).length) {
      return reply.code(400).send({ error: "Нечего сохранять: передайте Base URL, модель, провайдера или ключ" });
    }

    const result = await savePlatformEnv(values);
    if (result.skipped.length) {
      return reply.code(400).send({ error: result.skipped.map(item => item.name + " — " + item.message).join("; ") });
    }

    await recordAudit({
      action: "platform.image.updated",
      actorType: "admin",
      actorId: auth.admin.id,
      actorLabel: auth.admin.email,
      ip: request.ip,
      details: {
        saved: result.saved.join(", "),
        cleared: result.cleared.join(", "),
        model: parsed.data.model ?? null,
        provider: parsed.data.provider ?? null,
      },
    });

    return { saved: true, image: imageGenerationStatus() };
  });
}
