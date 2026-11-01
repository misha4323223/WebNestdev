import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getProjectProvider, saveProjectProvider, removeProjectProvider, type ProjectProviderConfig } from "../project-store.js";
import { getPlatformProviderConfig, type PlatformProviderConfig } from "../provider/platform-provider.js";
import { createFreeModelRoute, getFreeModelConfig, type FreeModelConfig } from "../provider/free-model.js";
import { reasoningSupport, type ReasoningSupport } from "../provider/openai-compatible-provider.js";
import {
  listPlatformModels,
  platformModelProviderConfig,
  type PlatformModelRecord,
} from "../platform/platform-models.js";
import { createProvider } from "../provider.js";
import { requireProjectUser, requireUser } from "../auth/auth.js";
import { accountPlanFor } from "../billing/store.js";
import type { PlanId } from "../account/plans.js";
import { creditMultiplier, mainCreditRates } from "../account/credits.js";

type ModelsRequest = { baseUrl?: string; token?: string; };
function normalizeBaseUrl(value: string) { return value.trim().replace(/\/+$/, ""); }
function modelUrl(baseUrl: string) { const root = normalizeBaseUrl(baseUrl); if (/\/models$/i.test(root)) return root; return root + "/models"; }

const MAIN_MODEL_ID = "nestdev";
const AIR_MODEL_ID = "nestdev-air";

export type PlatformModelOption = {
  id: string;
  name: string;
  description: string;
  available: boolean;
  locked: boolean;
  freeModel: boolean;
  current: boolean;
  reasoning: ReasoningSupport | null;
  /** Во сколько раз модель дороже основной по входу: подпись «×5» в выборе. */
  creditMultiplier: number;
};

type PlatformState = {
  options: PlatformModelOption[];
  current: PlatformModelOption | null;
  record: PlatformModelRecord | null;
  config: PlatformProviderConfig | null;
};

/**
 * Что показать в выборе модели. Основная модель и бесплатная Air — не записи каталога: первая
 * живёт в `PLATFORM_AI_*`, вторая — в бесплатной цепочке. Дополнительные модели приходят из
 * каталога, который администратор заполняет через `/api/admin/ai/models`.
 *
 * Закрытая модель остаётся в списке: так бесплатный тариф видит, что Max и Mini существуют, но
 * не может их выбрать. Закрытая и недоступная — разные вещи: `locked` говорит про тариф,
 * `available` — про настроенный адрес и ключ.
 */
async function buildPlatformState(
  plan: PlanId,
  requestedId: string | undefined,
  free: FreeModelConfig | null,
  main: PlatformProviderConfig | null,
): Promise<PlatformState> {
  const isFree = plan === "free";
  const records = (await listPlatformModels()).filter(model => model.enabled);
  const mainReasoning = main ? reasoningSupport(main.baseUrl, main.model) : null;
  const freeReasoning = free ? reasoningSupport(free.baseUrl, free.model) : mainReasoning;
  const mainRates = mainCreditRates();
  const options: PlatformModelOption[] = [];

  if (isFree) {
    options.push({
      id: AIR_MODEL_ID,
      name: "NestDev Air",
      description: "Бесплатно · для знакомства",
      available: Boolean(free || main),
      locked: false,
      freeModel: true,
      current: false,
      reasoning: freeReasoning,
      creditMultiplier: 0,
    });
  } else {
    options.push({
      id: MAIN_MODEL_ID,
      name: "NestDev",
      description: "Основная модель · баланс скорости и качества",
      available: Boolean(main),
      locked: false,
      freeModel: false,
      current: false,
      reasoning: mainReasoning,
      creditMultiplier: 1,
    });
  }

  for (const record of records) {
    const allowed = !isFree && record.plans.includes(plan as "pro" | "team");
    options.push({
      id: record.id,
      name: record.name,
      description: record.description || (allowed ? "Дополнительная модель платформы" : "Доступна на платном тарифе"),
      // Без ключа модель ещё не готова к запуску: показываем её, но не даём выбрать.
      available: Boolean(record.apiKey),
      locked: !allowed,
      freeModel: false,
      current: false,
      reasoning: reasoningSupport(record.baseUrl, record.model),
      creditMultiplier: creditMultiplier(record.creditRates, mainRates),
    });
  }

  const preferredId = isFree ? AIR_MODEL_ID : MAIN_MODEL_ID;
  const requested = requestedId?.trim();
  const requestedOption = requested
    ? options.find(option => option.id === requested && option.available && !option.locked)
    : undefined;
  const current = requestedOption
    ?? options.find(option => option.id === preferredId && option.available && !option.locked)
    ?? options.find(option => option.available && !option.locked)
    ?? null;
  if (current) current.current = true;

  const record = current && current.id !== MAIN_MODEL_ID && current.id !== AIR_MODEL_ID
    ? records.find(model => model.id === current.id) ?? null
    : null;

  return {
    options,
    current,
    record,
    config: current
      ? current.id === AIR_MODEL_ID
        ? (free ? { provider: free.providerName, baseUrl: free.baseUrl, model: free.model } : main)
        : current.id === MAIN_MODEL_ID
          ? main
          : record ? platformModelProviderConfig(record) : null
      : null,
  };
}

function platformDefaultOf(state: PlatformState, main: PlatformProviderConfig | null) {
  const option = state.current;
  if (!option) return { available: false, providerName: "", model: "", displayName: "", id: "", description: "", freeModel: false };
  if (option.freeModel) {
    return {
      available: option.available,
      providerName: "",
      model: "",
      displayName: option.name,
      id: option.id,
      description: option.description,
      freeModel: true,
    };
  }
  return {
    available: option.available,
    providerName: state.record?.provider ?? main?.provider ?? "",
    model: state.record?.model ?? main?.model ?? "",
    displayName: option.name,
    id: option.id,
    description: option.description,
    freeModel: false,
  };
}

export async function registerProviderRoutes(app: FastifyInstance) {
  app.get("/api/projects/:projectId/provider", async (request,reply) => {
    const { projectId } = request.params as { projectId: string };
    const user = await requireProjectUser(request,reply,projectId);
    if(!user)return;
    const config = await getProjectProvider(projectId);
    const plan = await accountPlanFor(user.id);
    const freePlan = plan === "free";
    const free = freePlan ? getFreeModelConfig() : null;
    const platform = getPlatformProviderConfig();
    const requested = typeof (request.query as { model?: unknown } | undefined)?.model === "string"
      ? String((request.query as { model: string }).model)
      : undefined;
    const state = await buildPlatformState(plan, requested, free, platform);
    const platformDefault = platformDefaultOf(state, platform);
    // Индикатор глубины размышления строится для той модели, которая реально отработает запуск:
    // своей у проекта, выбранной платформенной или бесплатной на «Старте».
    const effective = config ?? state.config;
    const reasoning = effective ? reasoningSupport(effective.baseUrl, effective.model) : null;
    const platformModels = state.options;
    const selectedModelId = config ? null : state.current?.id ?? null;
    if (!config) return { configured: false, provider: "", baseUrl: "", model: "", hasToken: false, platformDefault, platformModels, selectedModelId, reasoning };
    return { configured: true, provider: config.provider, baseUrl: config.baseUrl, model: config.model, hasToken: Boolean(config.token), platformDefault, platformModels, selectedModelId, reasoning };
  });

  app.put("/api/projects/:projectId/provider", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    if(!await requireProjectUser(request,reply,projectId))return;
    const body = (request.body ?? {}) as ModelsRequest & { provider?: string; model?: string };
    const baseUrl = body.baseUrl?.trim() ?? "";
    if (!baseUrl) return reply.code(400).send({ error: "Укажите Base URL провайдера" });
    if (!/^https?:\/\//i.test(baseUrl)) return reply.code(400).send({ error: "Base URL должен начинаться с http:// или https://" });
    const existing = await getProjectProvider(projectId);
    const token = body.token?.trim() || existing?.token;
    const config = { provider: body.provider?.trim() || "OpenAI-compatible", baseUrl: normalizeBaseUrl(baseUrl), model: body.model?.trim() || "", ...(token ? { token } : {}) };
    await saveProjectProvider(projectId, config);
    return { configured: true, provider: config.provider, baseUrl: config.baseUrl, model: config.model, hasToken: Boolean(config.token) };
  });

  app.delete("/api/projects/:projectId/provider", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const user = await requireProjectUser(request,reply,projectId);
    if(!user)return;
    await removeProjectProvider(projectId);
    const plan = await accountPlanFor(user.id);
    const freePlan = plan === "free";
    const free = freePlan ? getFreeModelConfig() : null;
    const platform = getPlatformProviderConfig();
    const state = await buildPlatformState(plan, undefined, free, platform);
    return {
      configured:false,
      removed:true,
      platformDefault: platformDefaultOf(state, platform),
      platformModels: state.options,
      selectedModelId: state.current?.id ?? null,
    };
  });

  app.post("/api/providers/models", async (request, reply) => {
    if (!await requireUser(request, reply)) return;
    const body = (request.body ?? {}) as ModelsRequest;
    const baseUrl = body.baseUrl?.trim(); const token = body.token?.trim();
    if (!baseUrl) return reply.code(400).send({ error: "Укажите Base URL провайдера" });
    if (!/^https?:\/\//i.test(baseUrl)) return reply.code(400).send({ error: "Base URL должен начинаться с http:// или https://" });
    let parsedUrl: URL;
    try { parsedUrl = new URL(baseUrl);    } catch { return reply.code(400).send({error:"Base URL должен быть корректной ссылкой"}); }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) return reply.code(400).send({error:"Поддерживаются только HTTP и HTTPS"});
    const host = parsedUrl.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host === "metadata.google.internal" || host === "169.254.169.254" || host === "0.0.0.0" || host === "::1" || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)) return reply.code(400).send({error:"Локальные и приватные адреса провайдера запрещены"});
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(modelUrl(baseUrl), {method:"GET",headers:{Accept:"application/json",...(token ? {Authorization:`Bearer ${token}`}: {})},signal:controller.signal});
      const text = await response.text(); let data: unknown; try { data=JSON.parse(text); } catch { data=null; }
      if (!response.ok) return reply.code(502).send({error:data&&typeof data==="object"&&data!==null&&"error"in data?String((data as {error:unknown}).error):`Провайдер вернул HTTP ${response.status}`});
      const rawModels=Array.isArray(data)?data:data&&typeof data==="object"&&Array.isArray((data as {data?:unknown}).data)?(data as {data:unknown[]}).data:[];
      const models=rawModels.map(item=>{if(typeof item==="string")return{id:item,name:item};if(item&&typeof item==="object"&&"id"in item&&typeof item.id==="string"){const value=item as {id:string;name?:unknown};return{id:value.id,name:typeof value.name==="string"?value.name:value.id}}return null}).filter((item):item is {id:string;name:string}=>item!==null);
      return {models};
    } catch(error) {
      const message=error instanceof Error&&error.name==="AbortError"?"Провайдер не ответил вовремя":error instanceof Error?error.message:String(error);
      return reply.code(502).send({error:"Не удалось подключиться к провайдеру: "+message});
    } finally { clearTimeout(timeout); }
  });

  app.post("/api/providers/test", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = z.object({ projectId: z.string().min(1).max(200).optional() }).parse(request.body ?? {});
    let projectConfig: ProjectProviderConfig | null = null;
    if (body.projectId) {
      if (!await requireProjectUser(request, reply, body.projectId)) return;
      projectConfig = await getProjectProvider(body.projectId);
    }
    const plan = await accountPlanFor(user.id);
    // Бесплатный тариф без своего провайдера проверяет ту же цепочку, которая реально работает:
    // сначала Agnes, затем резерв. Имя модели в ответе не показываем — см. GET выше.
    const freeModel = !projectConfig && plan === "free";
    const freeRoute = freeModel ? createFreeModelRoute() : null;
    const platformConfig = getPlatformProviderConfig();
    const effective = projectConfig ?? (freeRoute ? null : platformConfig);
    const source = projectConfig ? "project" : "platform";
    if (!effective && !freeRoute) return reply.code(400).send({ ok: false, error: "Провайдер не настроен: заполните настройки проекта или задайте PLATFORM_AI_* в окружении." });
    const provider = freeRoute ? freeRoute.provider : createProvider(effective!);
    const model = freeRoute ? freeRoute.model : effective!.model;
    const presented = freeModel
      ? { provider: "NestDev Air", model: "", freeModel: true }
      : { provider: effective!.provider, model: effective!.model };
    const reasoningTarget = freeRoute ?? effective;
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    let text = ""; const toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    let usage: { promptTokens: number; completionTokens: number } | null = null;
    try {
      const tools = [{ type: "function", function: { name: "ping", description: "Проверочный инструмент. Вызови его с аргументом value=\"ok\".", parameters: { type: "object", properties: { value: { type: "string" } }, additionalProperties: true } } }];
      for await (const chunk of provider.stream([{ role: "user", content: "Проверка связи: вызови инструмент ping с аргументом value=\"ok\"." }], model, tools, controller.signal)) {
        if (chunk.type === "text") text += chunk.text;
        else if (chunk.type === "tool_call") toolCalls.push({ name: chunk.call.name, arguments: chunk.call.arguments });
        else if (chunk.type === "usage") usage = { promptTokens: chunk.promptTokens, completionTokens: chunk.completionTokens };
      }
      // Проверка — самое удобное место узнать про глубину: она уже сходила в шлюз с просьбой
      // о рассуждении, поэтому индикатор в настройках обновляется сразу, без первого запуска.
      const reasoning = reasoningTarget ? reasoningSupport(reasoningTarget.baseUrl, reasoningTarget.model) : null;
      return { ok: true, source, ...presented, latencyMs: Date.now() - started, tools: toolCalls.length > 0, toolCalls, text: text.slice(0, 400), usage, reasoning };
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const message = /abort/i.test(raw) ? "Провайдер не ответил за 20 секунд" : raw;
      return reply.code(502).send({ ok: false, source, ...presented, latencyMs: Date.now() - started, error: message, ...(reasoningTarget ? { reasoning: reasoningSupport(reasoningTarget.baseUrl, reasoningTarget.model) } : {}) });
    } finally {
      clearTimeout(timer);
    }
  });
}
