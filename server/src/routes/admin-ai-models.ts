import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireAdmin } from "./admin.js";
import { applyNoStoreToReply } from "./cache-headers.js";
import { recordAudit } from "../security/audit-journal.js";
import {
  deletePlatformModel,
  getPlatformModel,
  listPlatformModels,
  platformModelAdminView,
  platformModelIdProblem,
  savePlatformModel,
  type PlatformModelInput,
} from "../platform/platform-models.js";
import { reasoningSupport } from "../provider/openai-compatible-provider.js";
import { testProviderConnection } from "../provider/connection-test.js";
import { normalizeUpstreamRouting, upstreamRoutingProblem, type UpstreamRouting } from "../provider/upstream-routing.js";
import { upstreamRoutingSchema } from "./admin-ai-schema.js";

/**
 * Дополнительные модели платформы для внешней админки: Max, Mini и любые другие
 * OpenAI-совместимые точки входа, которые администратор добавляет сам.
 *
 * Главная модель (`PLATFORM_AI_*`) остаётся в `/api/admin/ai`; здесь только каталог
 * дополнительных. Оба API используют один и тот же Bearer-токен админки, поэтому мобильному
 * приложению не нужен отдельный вход. Ключ модели никогда не возвращается: только `hasKey`.
 */
const baseUrl = z.string().trim().url().max(500).refine(value => /^https?:\/\//i.test(value), "Нужен адрес вида https://…");
const modelId = z.string().trim().min(2).max(32).regex(/^[a-z][a-z0-9-]*$/, "id: латиница в нижнем регистре, цифры и дефис");
const plans = z.array(z.enum(["pro", "team"])).min(1).max(2);
/** Частичные ставки: PATCH одного поля не должен обнулять остальные. */
const creditRates = z.object({
  inputPerMillion: z.number().finite().min(0).max(1_000_000).optional(),
  outputPerMillion: z.number().finite().min(0).max(1_000_000).optional(),
  minimumPerRun: z.number().int().min(0).max(10_000).optional(),
}).partial().nullable().optional();

const modelSchema = z.object({
  /** Для max/mini имя подставляется автоматически, если админка его не передала. */
  name: z.string().trim().min(1, "Укажите название").max(80).optional(),
  description: z.string().trim().max(300).optional(),
  provider: z.string().trim().min(1, "Укажите провайдера").max(120).optional(),
  baseUrl,
  model: z.string().trim().min(1, "Укажите модель").max(300),
  /** Пусто — сохранить текущий ключ. */
  apiKey: z.string().trim().max(20_000).optional(),
  clearKey: z.boolean().optional(),
  plans: plans.optional(),
  enabled: z.boolean().optional(),
  contextTokens: z.number().int().min(4_000).max(2_000_000).nullable().optional(),
  /** Ставки списания кредитов за 1 млн входных и выходных токенов. */
  creditRates,
  /** `null` возвращает авто-выбор шлюза; отсутствие поля оставляет настройку как была. */
  routing: upstreamRoutingSchema,
});

const createSchema = modelSchema.extend({ id: modelId });
const patchSchema = modelSchema.partial().refine(value => Object.keys(value).length > 0, {
  message: "Пустой запрос: нечего менять",
});
const testSchema = z.object({
  id: modelId.optional(),
  provider: z.string().trim().max(120).optional(),
  baseUrl: baseUrl.optional(),
  model: z.string().trim().max(300).optional(),
  apiKey: z.string().trim().max(20_000).optional(),
  /** Проверить черновик с цепочкой; без поля берётся сохранённая у модели. */
  routing: upstreamRoutingSchema,
});

export type AdminAiModelsRouteDeps = {
  testAi: typeof testProviderConnection;
};

export async function registerAdminAiModelsRoutes(
  app: FastifyInstance,
  overrides: Partial<AdminAiModelsRouteDeps> = {},
) {
  const deps: AdminAiModelsRouteDeps = { testAi: testProviderConnection, ...overrides };

  app.get("/api/admin/ai/models", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);
    const models = await listPlatformModels();
    return {
      models: models.map(model => ({
        ...platformModelAdminView(model),
        reasoning: reasoningSupport(model.baseUrl, model.model),
      })),
    };
  });

  app.post("/api/admin/ai/models", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);
    const parsed = createSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Проверьте модель" });
    const problem = platformModelIdProblem(parsed.data.id);
    if (problem) return reply.code(400).send({ error: problem });
    return writeModel(request, reply, auth, parsed.data.id, parsed.data);
  });

  app.put("/api/admin/ai/models/:id", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);
    const id = String((request.params as { id?: unknown }).id ?? "").trim();
    const problem = platformModelIdProblem(id);
    if (problem) return reply.code(400).send({ error: problem });
    const parsed = modelSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Проверьте модель" });
    return writeModel(request, reply, auth, id, parsed.data);
  });

  app.patch("/api/admin/ai/models/:id", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);
    const id = String((request.params as { id?: unknown }).id ?? "").trim();
    const problem = platformModelIdProblem(id);
    if (problem) return reply.code(400).send({ error: problem });
    const parsed = patchSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Проверьте модель" });
    return writeModel(request, reply, auth, id, parsed.data);
  });

  app.delete("/api/admin/ai/models/:id", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);
    const id = String((request.params as { id?: unknown }).id ?? "").trim();
    const problem = platformModelIdProblem(id);
    if (problem) return reply.code(400).send({ error: problem });
    const deleted = await deletePlatformModel(id);
    if (!deleted) return reply.code(404).send({ error: "Модель не найдена" });
    await recordAudit({
      action: "platform.ai_model.deleted",
      actorType: "admin",
      actorId: auth.admin.id,
      actorLabel: auth.admin.email,
      ip: request.ip,
      details: { id },
    });
    return { deleted: true, id };
  });

  app.post("/api/admin/ai/models/test", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);
    const parsed = testSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Проверьте адрес и модель" });
    const saved = parsed.data.id ? await getPlatformModel(parsed.data.id) : null;
    if (parsed.data.id && !saved) return reply.code(404).send({ error: "Модель не найдена" });
    let routing: UpstreamRouting | undefined;
    if (parsed.data.routing === null) {
      routing = undefined;
    } else if (parsed.data.routing !== undefined) {
      const normalized = normalizeUpstreamRouting(parsed.data.routing);
      const problem = normalized ? upstreamRoutingProblem(normalized) : "проверьте режим, список провайдеров и maxPrice";
      if (!normalized || problem) return reply.code(400).send({ error: "routing: " + problem });
      routing = normalized;
    } else {
      routing = saved?.routing;
    }
    const target = {
      provider: parsed.data.provider?.trim() || saved?.provider || "Модель платформы",
      baseUrl: parsed.data.baseUrl || saved?.baseUrl || "",
      model: parsed.data.model || saved?.model || "",
      token: parsed.data.apiKey?.trim() || saved?.apiKey,
      ...(routing ? { routing } : {}),
    };
    if (!target.baseUrl || !target.model) return reply.code(400).send({ error: "Укажите Base URL и модель" });
    const result = await deps.testAi(target);
    await recordAudit({
      action: "platform.ai_model.tested",
      actorType: "admin",
      actorId: auth.admin.id,
      actorLabel: auth.admin.email,
      ip: request.ip,
      details: { id: parsed.data.id ?? null, provider: target.provider, model: target.model, ok: result.ok },
    });
    return result;
  });

  async function writeModel(
    request: FastifyRequest,
    reply: FastifyReply,
    auth: NonNullable<Awaited<ReturnType<typeof requireAdmin>>>,
    id: string,
    input: PlatformModelInput,
  ) {
    const existing = await getPlatformModel(id);
    try {
      const model = await savePlatformModel(id, {
        ...input,
        ...(input.contextTokens === null ? { contextTokens: null } : {}),
        ...(input.creditRates === null ? { creditRates: null } : {}),
      });
      await recordAudit({
        action: existing ? "platform.ai_model.updated" : "platform.ai_model.created",
        actorType: "admin",
        actorId: auth.admin.id,
        actorLabel: auth.admin.email,
        ip: request.ip,
        details: {
          id,
          name: model.name,
          provider: model.provider,
          baseUrl: model.baseUrl,
          model: model.model,
          plans: model.plans,
          enabled: model.enabled,
          creditRates: model.creditRates,
          routing: model.routing,
          hasKey: Boolean(model.apiKey),
        },
      });
      return reply.code(existing ? 200 : 201).send({ saved: true, model: platformModelAdminView(model) });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  }
}
