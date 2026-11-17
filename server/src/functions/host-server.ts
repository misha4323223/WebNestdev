import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { hostingPublicDomain } from "../hosting/config.js";
import { getDomainByHostname } from "../hosting/domain-store.js";
import { hostingFunctionDir, hostingFunctionsDir } from "../hosting/paths.js";
import { isHostingSlug } from "../hosting/slug.js";
import { getSite, getSiteBySlug } from "../hosting/site-store.js";
import { loadStoredSecretValues } from "../secrets/secret-store.js";
import { invokeFunction, FunctionInvokeError, type FunctionRequest } from "./invoke.js";
import type { FunctionReleaseManifest } from "./build.js";

/**
 * Публичная дверь serverless-функций.
 *
 * Caddy отправляет сюда только `/api/*` опубликованного сайта. Дверь по Host находит сайт
 * и активный релиз, читает `.functions/manifest.json` и вызывает ровно одну функцию.
 * Статический `index.html` сюда не попадает и не подменяет отсутствующий API: нет функции —
 * честный JSON 404.
 */

export type FunctionsHostDeps = {
  getSiteBySlug: typeof getSiteBySlug;
  getSite: typeof getSite;
  getDomainByHostname: typeof getDomainByHostname;
  readManifest: (file: string) => Promise<FunctionReleaseManifest | null>;
  invoke: typeof invokeFunction;
  secrets: (projectId: string) => Promise<Record<string, string>>;
};

async function readManifestFile(file: string): Promise<FunctionReleaseManifest | null> {
  const text = await readFile(file, "utf8").catch(() => "");
  if (!text.trim()) return null;
  try {
    const parsed = JSON.parse(text) as FunctionReleaseManifest;
    return parsed?.version === 1 && Array.isArray(parsed.functions) ? parsed : null;
  } catch {
    return null;
  }
}

async function projectEnv(projectId: string) {
  const files = await loadStoredSecretValues(projectId).catch(() => null);
  if (!files) return {};
  // Порядок как у приложения: `.env` → `.env.local` → `.env.production`; последний выигрывает.
  return Object.assign({}, files[".env"] ?? {}, files[".env.local"] ?? {}, files[".env.production"] ?? {});
}

const defaultDeps: FunctionsHostDeps = {
  getSiteBySlug,
  getSite,
  getDomainByHostname,
  readManifest: readManifestFile,
  invoke: invokeFunction,
  secrets: projectEnv,
};

function requestHost(request: FastifyRequest) {
  const raw = String(request.headers.host ?? "").trim().toLowerCase();
  return raw.replace(/:\d+$/, "").replace(/\.$/, "");
}

async function resolveSite(hostname: string, deps: FunctionsHostDeps) {
  const domain = hostingPublicDomain();
  if (hostname.endsWith("." + domain)) {
    const slug = hostname.slice(0, -domain.length - 1);
    if (!isHostingSlug(slug)) return null;
    return deps.getSiteBySlug(slug);
  }
  const custom = await deps.getDomainByHostname(hostname);
  if (!custom) return null;
  return deps.getSite(custom.siteId);
}

function publicHeaders(headers: Record<string, string>) {
  return {
    ...headers,
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
  };
}

function sendError(reply: FastifyReply, status: number, message: string, extra: Record<string, unknown> = {}) {
  return reply.code(status).send({ error: message, ...extra });
}

export function createFunctionsHostServer(deps: FunctionsHostDeps = defaultDeps): FastifyInstance {
  const app = Fastify({
    bodyLimit: 1024 * 1024,
    disableRequestLogging: true,
    logger: false,
  });

  // Функция получает тело байтами в исходном виде, а не разобранным JSON: иначе
  // `application/json` ушёл бы в стандартный парсер Fastify, и обработчик увидел бы пустое тело.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: 1024 * 1024 }, (_request, body, done) => {
    done(null, body);
  });

  app.all("/*", async (request, reply) => {
    const hostname = requestHost(request);
    if (!hostname) return sendError(reply, 400, "Не передан Host");
    const site = await resolveSite(hostname, deps).catch(() => null);
    if (!site || site.status !== "live" || !site.activeReleaseId) return sendError(reply, 404, "Сайт не найден");

    const manifest = await deps.readManifest(
      path.join(hostingFunctionsDir(site.slug, site.activeReleaseId), "manifest.json"),
    ).catch(() => null);
    if (!manifest?.functions.length) return sendError(reply, 404, "У сайта нет функций");

    const url = new URL(request.raw.url ?? "/", "http://site.local");
    const fn = manifest.functions.find(entry => entry.path === url.pathname);
    if (!fn) return sendError(reply, 404, "Функция не найдена", { path: url.pathname });
    if (!fn.methods.includes(request.method as never)) {
      reply.header("allow", fn.methods.join(", "));
      return sendError(reply, 405, "Метод не разрешён");
    }

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      if (Array.isArray(value)) headers[key] = value.join(", ");
      else if (typeof value === "string") headers[key] = value;
    }
    const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const input: FunctionRequest = {
      method: request.method,
      path: url.pathname,
      query: url.search,
      headers,
      bodyBase64: body.toString("base64"),
    };

    try {
      const env = await deps.secrets(site.projectId);
      const result = await deps.invoke({
        artifactDir: hostingFunctionDir(site.slug, site.activeReleaseId, fn.name),
        fn,
        request: input,
        env,
      });
      return reply.code(result.status).headers(publicHeaders(result.headers)).send(result.body);
    } catch (error) {
      if (error instanceof FunctionInvokeError) {
        request.log.warn({ error: error.message, function: fn.name, site: site.slug }, "function failed");
        return sendError(reply, error.statusCode, error.message, { function: fn.name });
      }
      request.log.error({ error, function: fn.name, site: site.slug }, "function crashed");
      return sendError(reply, 502, "Функция завершилась с ошибкой", { function: fn.name });
    }
  });

  return app;
}

let running: FastifyInstance | null = null;

export function functionsHostPort() {
  const value = Number(process.env.HOSTING_FUNCTIONS_PORT ?? 8792);
  return Number.isInteger(value) && value > 0 && value < 65_536 ? value : 8792;
}

export function functionsHostEnabled() {
  return (process.env.HOSTING_FUNCTIONS_ENABLED ?? "1").trim() !== "0";
}

export async function startFunctionsHostServer(): Promise<{ started: boolean; port?: number; reason?: string }> {
  if (!functionsHostEnabled()) return { started: false, reason: "HOSTING_FUNCTIONS_ENABLED=0" };
  if (running) return { started: true, port: functionsHostPort() };
  const app = createFunctionsHostServer();
  await app.listen({ host: "0.0.0.0", port: functionsHostPort() });
  running = app;
  return { started: true, port: functionsHostPort() };
}

export async function stopFunctionsHostServer() {
  const current = running;
  running = null;
  if (current) await current.close();
}

export function describeFunctionsHostServer() {
  if (!functionsHostEnabled()) return "serverless-функции: дверь выключена (HOSTING_FUNCTIONS_ENABLED=0)";
  return "serverless-функции: дверь 0.0.0.0:" + functionsHostPort() + ", маршрут /api/*, одноразовый контейнер на запрос";
}
