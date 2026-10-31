import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "./admin.js";
import { applyNoStoreToReply } from "./cache-headers.js";
import { recordAudit } from "../security/audit-journal.js";
import { savePlatformEnv } from "../platform/platform-env.js";
import { platformAiProviderStatus } from "../platform/ai-provider.js";
import { getPlatformProviderConfig } from "../provider/platform-provider.js";
import { testProviderConnection } from "../provider/connection-test.js";

const baseUrl = z.string().trim().url().max(500).refine(value => /^https?:\/\//i.test(value), "Нужен адрес вида https://…");
const providerSchema = z.object({
  provider: z.string().trim().min(1, "Укажите название провайдера").max(120),
  baseUrl,
  model: z.string().trim().min(1, "Укажите модель").max(300),
  /** Пусто — сохранить текущий ключ: так смена модели не требует повторной вставки секрета. */
  apiKey: z.string().trim().max(20_000).optional(),
});
const testSchema = z.object({
  provider: z.string().trim().max(120).optional(),
  baseUrl,
  model: z.string().trim().min(1, "Укажите модель").max(300),
  apiKey: z.string().trim().max(20_000).optional(),
});

export type AdminAiRouteDeps = {
  save: typeof savePlatformEnv;
  testAi: typeof testProviderConnection;
};

/**
 * Главный провайдер платформы для отдельного приложения админки: тот же Bearer-вход, что и
 * у остальных `/api/admin/*`. Ответы не содержат ключ даже замаскированным; проверка черновика
 * идёт с новым ключом или с уже сохранённым, если новый не передан.
 */
export async function registerAdminAiRoutes(app: FastifyInstance, overrides: Partial<AdminAiRouteDeps> = {}) {
  const deps: AdminAiRouteDeps = { save: savePlatformEnv, testAi: testProviderConnection, ...overrides };

  app.get("/api/admin/ai", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);
    return { ai: platformAiProviderStatus() };
  });

  app.post("/api/admin/ai", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);
    const parsed = providerSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Проверьте провайдера, адрес и модель" });
    const values: Record<string, string> = {
      PLATFORM_AI_PROVIDER: parsed.data.provider,
      PLATFORM_AI_BASE_URL: parsed.data.baseUrl,
      PLATFORM_AI_MODEL: parsed.data.model,
    };
    if (parsed.data.apiKey?.trim()) values.PLATFORM_AI_API_KEY = parsed.data.apiKey;
    const result = await deps.save(values);
    if (result.skipped.length) {
      return reply.code(400).send({ error: result.skipped.map(item => item.name + " — " + item.message).join("; ") });
    }
    await recordAudit({
      action: "platform.keys.updated",
      actorType: "admin",
      actorId: auth.admin.id,
      actorLabel: auth.admin.email,
      ip: request.ip,
      details: {
        saved: result.saved.join(", "),
        cleared: result.cleared.join(", "),
        provider: parsed.data.provider,
        model: parsed.data.model,
      },
    });
    return { saved: true, ai: platformAiProviderStatus() };
  });

  app.post("/api/admin/ai/test", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);
    const parsed = testSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Проверьте адрес и модель" });
    const saved = getPlatformProviderConfig();
    return deps.testAi({
      provider: parsed.data.provider?.trim() || saved?.provider || "Платформа NestDev",
      baseUrl: parsed.data.baseUrl,
      model: parsed.data.model,
      token: parsed.data.apiKey?.trim() || saved?.token,
    });
  });
}
