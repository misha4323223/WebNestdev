import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "./admin.js";
import { applyNoStoreToReply } from "./cache-headers.js";
import { recordAudit } from "../security/audit-journal.js";
import { savePlatformEnv } from "../platform/platform-env.js";
import { platformAiProviderStatus } from "../platform/ai-provider.js";
import { mainCreditRates, creditRatesProblem, normalizeCreditRates } from "../account/credits.js";
import { getPlatformProviderConfig } from "../provider/platform-provider.js";
import { testProviderConnection } from "../provider/connection-test.js";
import {
  defaultUpstreamRouting,
  normalizeUpstreamRouting,
  stringifyUpstreamRouting,
  upstreamRoutingProblem,
  type UpstreamRouting,
} from "../provider/upstream-routing.js";
import {
  estimatedUpstreamCost,
  getUpstreamModelCatalog,
  rankUpstreamProviders,
  upstreamProviderEligible,
} from "../provider/upstream-catalog.js";
import { getPlatformModel } from "../platform/platform-models.js";
import { upstreamRoutingSchema } from "./admin-ai-schema.js";

const baseUrl = z.string().trim().url().max(500).refine(value => /^https?:\/\//i.test(value), "Нужен адрес вида https://…");
/** Частичные ставки: админ-приложение может прислать только изменённое поле. */
const creditRatesSchema = z.object({
  inputPerMillion: z.number().finite().min(0).max(1_000_000).optional(),
  outputPerMillion: z.number().finite().min(0).max(1_000_000).optional(),
  minimumPerRun: z.number().int().min(0).max(10_000).optional(),
}).partial().nullable().optional();
const providerSchema = z.object({
  provider: z.string().trim().min(1, "Укажите название провайдера").max(120),
  baseUrl,
  model: z.string().trim().min(1, "Укажите модель").max(300),
  /** Пусто — сохранить текущий ключ: так смена модели не требует повторной вставки секрета. */
  apiKey: z.string().trim().max(20_000).optional(),
  /** Ставки списания кредитов основной модели; не рубли провайдера. */
  creditRates: creditRatesSchema,
  /** `null` возвращает авто-выбор шлюза; отсутствие поля оставляет настройку как была. */
  routing: upstreamRoutingSchema,
});
const testSchema = z.object({
  provider: z.string().trim().max(120).optional(),
  baseUrl,
  model: z.string().trim().min(1, "Укажите модель").max(300),
  apiKey: z.string().trim().max(20_000).optional(),
  /** Проверить черновик с той же цепочкой провайдеров; без поля берётся сохранённая. */
  routing: upstreamRoutingSchema,
});
const catalogQuerySchema = z.object({
  /** id модели каталога: возьмём её Base URL, модель и сохранённый ключ. */
  id: z.string().trim().min(2).max(32).optional(),
  baseUrl: baseUrl.optional(),
  model: z.string().trim().min(1).max(300).optional(),
  refresh: z.union([z.string(), z.boolean()]).optional(),
});

export type AdminAiRouteDeps = {
  save: typeof savePlatformEnv;
  testAi: typeof testProviderConnection;
  /** Каталог провайдеров; в тестах подменяется, чтобы не ходить в сеть. */
  catalog: typeof getUpstreamModelCatalog;
};

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function refreshRequested(value: string | boolean | undefined) {
  return value === true || value === "1" || value === "true" || value === "yes";
}

/**
 * Главный провайдер платформы для отдельного приложения админки: тот же Bearer-вход, что и
 * у остальных `/api/admin/*`. Ответы не содержат ключ даже замаскированным; проверка черновика
 * идёт с новым ключом или с уже сохранённым, если новый не передан.
 */
export async function registerAdminAiRoutes(app: FastifyInstance, overrides: Partial<AdminAiRouteDeps> = {}) {
  const deps: AdminAiRouteDeps = {
    save: savePlatformEnv,
    testAi: testProviderConnection,
    catalog: getUpstreamModelCatalog,
    ...overrides,
  };

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

    let routingForAudit: unknown = undefined;
    if (parsed.data.routing === null) {
      // Пустая строка удаляет значение панели: остаётся поведение по умолчанию (`auto`).
      values.PLATFORM_AI_ROUTING = "";
      routingForAudit = null;
    } else if (parsed.data.routing !== undefined) {
      const routing = normalizeUpstreamRouting(parsed.data.routing);
      const problem = routing ? upstreamRoutingProblem(routing) : "проверьте режим, список провайдеров и maxPrice";
      if (!routing || problem) return reply.code(400).send({ error: "routing: " + problem });
      values.PLATFORM_AI_ROUTING = stringifyUpstreamRouting(routing);
      routingForAudit = routing;
    }

    if (parsed.data.creditRates === null) {
      // Пустая строка удаляет значение панели: ставки возвращаются к окружению, затем к базовым.
      values.PLATFORM_AI_CREDITS_INPUT_PER_MILLION = "";
      values.PLATFORM_AI_CREDITS_OUTPUT_PER_MILLION = "";
      values.PLATFORM_AI_CREDITS_MINIMUM_PER_RUN = "";
    } else if (parsed.data.creditRates !== undefined) {
      const next = normalizeCreditRates(parsed.data.creditRates, mainCreditRates());
      const problem = creditRatesProblem(next);
      if (problem) return reply.code(400).send({ error: problem });
      // Сохраняем только присланные поля: остальные продолжают читаться из окружения, пока
      // админ-приложение не переопределит их явно.
      if (parsed.data.creditRates.inputPerMillion !== undefined) {
        values.PLATFORM_AI_CREDITS_INPUT_PER_MILLION = String(next.inputPerMillion);
      }
      if (parsed.data.creditRates.outputPerMillion !== undefined) {
        values.PLATFORM_AI_CREDITS_OUTPUT_PER_MILLION = String(next.outputPerMillion);
      }
      if (parsed.data.creditRates.minimumPerRun !== undefined) {
        values.PLATFORM_AI_CREDITS_MINIMUM_PER_RUN = String(next.minimumPerRun);
      }
    }
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
        ...(routingForAudit !== undefined ? { routing: routingForAudit } : {}),
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
    let routing: UpstreamRouting | undefined;
    if (parsed.data.routing === null) {
      routing = undefined;
    } else if (parsed.data.routing !== undefined) {
      const normalized = normalizeUpstreamRouting(parsed.data.routing);
      const problem = normalized ? upstreamRoutingProblem(normalized) : "проверьте режим, список провайдеров и maxPrice";
      if (!normalized || problem) return reply.code(400).send({ error: "routing: " + problem });
      routing = normalized;
    } else if (saved && normalizeBaseUrl(saved.baseUrl) === normalizeBaseUrl(parsed.data.baseUrl) && saved.model === parsed.data.model) {
      // Проверка того же адреса и модели должна проверять и выбранную цепочку.
      routing = saved.routing;
    }
    return deps.testAi({
      provider: parsed.data.provider?.trim() || saved?.provider || "Платформа NestDev",
      baseUrl: parsed.data.baseUrl,
      model: parsed.data.model,
      token: parsed.data.apiKey?.trim() || saved?.token,
      ...(routing ? { routing } : {}),
    });
  });

  /**
   * Каталог провайдеров выбранной модели: кто есть, сколько стоит, умеет ли инструменты и кого
   * выберет `cheapest`. Это единственный источник для выбора в внешней админке: список не
   * зашит в приложение и обновляется из Polza без выкатки.
   */
  app.get("/api/admin/ai/providers", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);
    const parsed = catalogQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Проверьте модель и адрес" });

    const saved = getPlatformProviderConfig();
    const catalogModel = parsed.data.id ? await getPlatformModel(parsed.data.id) : null;
    if (parsed.data.id && !catalogModel) return reply.code(404).send({ error: "Модель не найдена" });

    const targetBaseUrl = parsed.data.id
      ? catalogModel?.baseUrl
      : parsed.data.baseUrl ?? saved?.baseUrl;
    const targetModel = parsed.data.id
      ? catalogModel?.model
      : parsed.data.model ?? saved?.model;
    if (!targetBaseUrl || !targetModel) {
      return reply.code(400).send({ error: "Укажите baseUrl и model или id модели каталога" });
    }

    const sameBase = Boolean(saved && normalizeBaseUrl(saved.baseUrl) === normalizeBaseUrl(targetBaseUrl));
    const token = catalogModel?.apiKey ?? (sameBase ? saved?.token : undefined);
    const catalog = await deps.catalog(targetBaseUrl, token, targetModel, { refresh: refreshRequested(parsed.data.refresh) });
    if (!catalog) {
      return reply.code(502).send({
        error: "Каталог провайдеров недоступен: проверьте Base URL, ключ и доступность шлюза",
        baseUrl: targetBaseUrl,
        model: targetModel,
      });
    }

    const routing = catalogModel?.routing ?? saved?.routing ?? defaultUpstreamRouting();
    const ranked = rankUpstreamProviders(catalog.providers, routing);
    const rankedNames = new Set(ranked.map(provider => provider.name));
    const selected = new Set(
      routing.mode === "fixed" ? routing.providers
        : routing.mode === "cheapest" ? [...rankedNames]
          : [],
    );

    return {
      baseUrl: targetBaseUrl,
      model: targetModel,
      fetchedAt: catalog.fetchedAt,
      stale: catalog.stale,
      topProvider: catalog.topProvider,
      routing,
      recommended: ranked[0]?.name ?? null,
      providers: catalog.providers.map(provider => ({
        ...provider,
        estimatedCost: estimatedUpstreamCost(provider, routing.assumedInputPerOutput),
        eligible: upstreamProviderEligible(provider, routing),
        selected: selected.has(provider.name),
      })),
    };
  });
}
