import type { FastifyInstance } from "fastify";
import { getProjectProvider, getProject, saveProjectProvider } from "../project-store.js";
import { requireProjectUser } from "../auth/auth.js";

type ModelsRequest = { baseUrl?: string; token?: string; };
function normalizeBaseUrl(value: string) { return value.trim().replace(/\/+$/, ""); }
function modelUrl(baseUrl: string) { const root = normalizeBaseUrl(baseUrl); if (/\/models$/i.test(root)) return root; return root + "/models"; }

export async function registerProviderRoutes(app: FastifyInstance) {
  app.get("/api/projects/:projectId/provider", async (request,reply) => {
    const { projectId } = request.params as { projectId: string };
    if(!await requireProjectUser(request,reply,projectId))return;
    const config = await getProjectProvider(projectId);
    if (!config) return { configured: false, provider: "", baseUrl: "", model: "", hasToken: false };
    return { configured: true, provider: config.provider, baseUrl: config.baseUrl, model: config.model, hasToken: Boolean(config.token) };
  });
  app.put("/api/projects/:projectId/provider", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    if(!await requireProjectUser(request,reply,projectId))return;
    const body = (request.body ?? {}) as ModelsRequest & { provider?: string; model?: string };
    const baseUrl = body.baseUrl?.trim() ?? "";
    if (!baseUrl) return reply.code(400).send({ error: "Base URL is required" });
    if (!/^https?:\/\//i.test(baseUrl)) return reply.code(400).send({ error: "Base URL must start with http:// or https://" });
    const existing = await getProjectProvider(projectId);
    const token = body.token?.trim() || existing?.token;
    const config = { provider: body.provider?.trim() || "OpenAI-compatible", baseUrl: normalizeBaseUrl(baseUrl), model: body.model?.trim() || "", ...(token ? { token } : {}) };
    await saveProjectProvider(projectId, config);
    return { configured: true, provider: config.provider, baseUrl: config.baseUrl, model: config.model, hasToken: Boolean(config.token) };
  });
  app.post("/api/providers/models", async (request, reply) => {
    const body = (request.body ?? {}) as ModelsRequest;
    const baseUrl = body.baseUrl?.trim(); const token = body.token?.trim();
    if (!baseUrl) return reply.code(400).send({ error: "Base URL is required" });
    if (!/^https?:\/\//i.test(baseUrl)) return reply.code(400).send({ error: "Base URL must start with http:// or https://" });
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(modelUrl(baseUrl), {method:"GET",headers:{Accept:"application/json",...(token ? {Authorization:`Bearer ${token}`}: {})},signal:controller.signal});
      const text = await response.text(); let data: unknown; try { data=JSON.parse(text); } catch { data=null; }
      if (!response.ok) return reply.code(502).send({error:data&&typeof data==="object"&&data!==null&&"error"in data?String((data as {error:unknown}).error):`Provider returned HTTP ${response.status}`});
      const rawModels=Array.isArray(data)?data:data&&typeof data==="object"&&Array.isArray((data as {data?:unknown}).data)?(data as {data:unknown[]}).data:[];
      const models=rawModels.map(item=>{if(typeof item==="string")return{id:item,name:item};if(item&&typeof item==="object"&&"id"in item&&typeof item.id==="string"){const value=item as {id:string;name?:unknown};return{id:value.id,name:typeof value.name==="string"?value.name:value.id}}return null}).filter((item):item is {id:string;name:string}=>item!==null);
      return {models};
    } catch(error) {
      const message=error instanceof Error&&error.name==="AbortError"?"Provider request timed out":error instanceof Error?error.message:String(error);
      return reply.code(502).send({error:"Could not reach provider: "+message});
    } finally { clearTimeout(timeout); }
  });
}