import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getProjectProvider, getProject, saveProjectProvider, removeProjectProvider, type ProjectProviderConfig } from "../project-store.js";
import { getPlatformProviderConfig } from "../provider/platform-provider.js";
import { reasoningSupport } from "../provider/openai-compatible-provider.js";
import { createProvider } from "../provider.js";
import { requireProjectUser, requireUser } from "../auth/auth.js";

type ModelsRequest = { baseUrl?: string; token?: string; };
function normalizeBaseUrl(value: string) { return value.trim().replace(/\/+$/, ""); }
function modelUrl(baseUrl: string) { const root = normalizeBaseUrl(baseUrl); if (/\/models$/i.test(root)) return root; return root + "/models"; }

export async function registerProviderRoutes(app: FastifyInstance) {
  app.get("/api/projects/:projectId/provider", async (request,reply) => {
    const { projectId } = request.params as { projectId: string };
    if(!await requireProjectUser(request,reply,projectId))return;
    const config = await getProjectProvider(projectId);
    const platform = getPlatformProviderConfig();
    const platformDefault = platform
      ? { available: true, providerName: platform.provider, model: platform.model }
      : { available: false, providerName: "", model: "" };
    // Индикатор глубины размышления строится для той модели, которая реально отработает запуск:
    // своей у проекта или платформенной по умолчанию. null — провайдера нет вовсе.
    const effective = config ?? platform;
    const reasoning = effective ? reasoningSupport(effective.baseUrl, effective.model) : null;
    if (!config) return { configured: false, provider: "", baseUrl: "", model: "", hasToken: false, platformDefault, reasoning };
    return { configured: true, provider: config.provider, baseUrl: config.baseUrl, model: config.model, hasToken: Boolean(config.token), platformDefault, reasoning };
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
    if(!await requireProjectUser(request,reply,projectId))return;
    await removeProjectProvider(projectId);
    const platform = getPlatformProviderConfig();
    return {
      configured:false,
      removed:true,
      platformDefault: platform ? { available:true, providerName:platform.provider, model:platform.model } : { available:false, providerName:"", model:"" }
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
    const platformConfig = getPlatformProviderConfig();
    const effective = projectConfig ?? platformConfig;
    const source = projectConfig ? "project" : "platform";
    if (!effective) return reply.code(400).send({ ok: false, error: "Провайдер не настроен: заполните настройки проекта или задайте PLATFORM_AI_* в окружении." });
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    let text = ""; const toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    let usage: { promptTokens: number; completionTokens: number } | null = null;
    try {
      const provider = createProvider(effective);
      const tools = [{ type: "function", function: { name: "ping", description: "Проверочный инструмент. Вызови его с аргументом value=\"ok\".", parameters: { type: "object", properties: { value: { type: "string" } }, additionalProperties: true } } }];
      for await (const chunk of provider.stream([{ role: "user", content: "Проверка связи: вызови инструмент ping с аргументом value=\"ok\"." }], effective.model, tools, controller.signal)) {
        if (chunk.type === "text") text += chunk.text;
        else if (chunk.type === "tool_call") toolCalls.push({ name: chunk.call.name, arguments: chunk.call.arguments });
        else if (chunk.type === "usage") usage = { promptTokens: chunk.promptTokens, completionTokens: chunk.completionTokens };
      }
      // Проверка — самое удобное место узнать про глубину: она уже сходила в шлюз с просьбой
      // о рассуждении, поэтому индикатор в настройках обновляется сразу, без первого запуска.
      const reasoning = reasoningSupport(effective.baseUrl, effective.model);
      return { ok: true, source, provider: effective.provider, model: effective.model, latencyMs: Date.now() - started, tools: toolCalls.length > 0, toolCalls, text: text.slice(0, 400), usage, reasoning };
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const message = /abort/i.test(raw) ? "Провайдер не ответил за 20 секунд" : raw;
      return reply.code(502).send({ ok: false, source, provider: effective.provider, model: effective.model, latencyMs: Date.now() - started, error: message, reasoning: reasoningSupport(effective.baseUrl, effective.model) });
    } finally {
      clearTimeout(timer);
    }
  });
}