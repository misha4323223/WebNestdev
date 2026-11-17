import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import path from "node:path";
import { hostingApiHost, hostingPublicDomain } from "../hosting/config.js";
import { getDomainByHostname } from "../hosting/domain-store.js";
import { hostingFunctionDir, hostingFunctionsDir } from "../hosting/paths.js";
import { isHostingSlug } from "../hosting/slug.js";
import { getSite, getSiteBySlug } from "../hosting/site-store.js";
import { HostingError } from "../hosting/types.js";
import { enqueueBackgroundJobs } from "../hosting/background-jobs.js";
import { invokeFunction, FunctionInvokeError, type BackgroundJobRequest, type FunctionRequest } from "./invoke.js";
import { readReleaseManifest } from "./release-manifest.js";
import { projectFunctionEnv } from "./runtime-env.js";
import { functionLimiter, FunctionCapacityError } from "./function-limiter.js";
import { functionMetrics } from "./metrics.js";
import { functionCacheKey, functionResponseCache, requestAllowsResponseCache } from "./response-cache.js";
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
  /** Ставит задания из ответа функции в очередь до отправки ответа клиенту. */
  enqueueJobs?: (input: { site: NonNullable<Awaited<ReturnType<typeof getSiteBySlug>>>; requests: BackgroundJobRequest[] }) => Promise<unknown>;
  /** Слот на одновременное выполнение функций; возвращённую функцию вызывают в finally. */
  acquireSlot?: (siteId: string) => Promise<() => void>;
};

const defaultDeps: FunctionsHostDeps = {
  getSiteBySlug,
  getSite,
  getDomainByHostname,
  readManifest: readReleaseManifest,
  invoke: invokeFunction,
  secrets: projectFunctionEnv,
  enqueueJobs: enqueueBackgroundJobs,
  acquireSlot: siteId => functionLimiter.acquire(siteId),
};

function requestHost(request: FastifyRequest) {
  const raw = String(request.headers.host ?? "").trim().toLowerCase();
  return raw.replace(/:\d+$/, "").replace(/\.$/, "");
}

/**
 * `api.<домен>/<slug>/api/...` — отдельная дверь для POST в обход CDN. Хост проверяется
 * точным сравнением с настройкой, а slug — регуляркой; Host из запроса не становится
 * путём к чужому сайту. Caddy передаёт путь как есть, поэтому префикс снимаем здесь.
 */
function apiTarget(hostname: string, pathname: string) {
  const apiHost = hostingApiHost();
  if (!apiHost || hostname !== apiHost) return null;
  const parts = pathname.split("/");
  const slug = parts[1] ?? "";
  if (parts[2] !== "api" || !isHostingSlug(slug)) return null;
  return { slug, pathname: "/api/" + parts.slice(3).join("/") };
}

function apiCors(reply: FastifyReply, request: FastifyRequest) {
  reply.header("access-control-allow-origin", "*");
  reply.header("access-control-allow-methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
  const requested = request.headers["access-control-request-headers"];
  reply.header(
    "access-control-allow-headers",
    typeof requested === "string" && requested.trim() ? requested : "content-type, authorization",
  );
  reply.header("access-control-expose-headers", "x-function-cache, retry-after");
  reply.header("access-control-max-age", "600");
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

/** Повторяющиеся параметры склеиваются через запятую: фильтры вида `sizes=S,M` остаются строками. */
function queryParams(url: URL) {
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    query[key] = query[key] === undefined ? value : query[key] + "," + value;
  }
  return query;
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
    const url = new URL(request.raw.url ?? "/", "http://site.local");
    const apiHost = hostingApiHost();
    const isApiHost = Boolean(apiHost && hostname === apiHost);
    if (isApiHost) apiCors(reply, request);
    // Preflight обслуживаем до поиска сайта: браузер не присылает с ним полезное тело.
    if (isApiHost && request.method === "OPTIONS") return reply.code(204).send();

    const target = isApiHost ? apiTarget(hostname, url.pathname) : null;
    if (isApiHost && !target) return sendError(reply, 404, "Сайт не найден");
    const site = target
      ? await deps.getSiteBySlug(target.slug).catch(() => null)
      : await resolveSite(hostname, deps).catch(() => null);
    if (!site || site.status !== "live" || !site.activeReleaseId) return sendError(reply, 404, "Сайт не найден");
    // Фиксируем релиз в локальной переменной: замыкание execute теряет narrowing поля.
    const activeReleaseId = site.activeReleaseId;

    const manifest = await deps.readManifest(
      path.join(hostingFunctionsDir(site.slug, activeReleaseId), "manifest.json"),
    ).catch(() => null);
    if (!manifest?.functions.length) return sendError(reply, 404, "У сайта нет функций");

    if (target) url.pathname = target.pathname;
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
      query: queryParams(url),
      search: url.search,
      headers,
      bodyBase64: body.toString("base64"),
    };

    // Кеш — только явный opt-in функции и только для публичного GET/HEAD без cookie и
    // Authorization. POST/PUT/PATCH/DELETE не кешируются независимо от манифеста.
    const cachePolicy = fn.cache && functionResponseCache.enabled &&
      (request.method === "GET" || request.method === "HEAD") &&
      requestAllowsResponseCache(request.headers)
      ? fn.cache
      : null;
    const cacheKey = cachePolicy
      ? functionCacheKey({
        siteId: site.id,
        releaseId: activeReleaseId,
        functionName: fn.name,
        method: request.method,
        path: url.pathname,
        search: url.search,
        accept: request.headers.accept,
        acceptLanguage: request.headers["accept-language"],
      })
      : "";
    const cached = cacheKey ? functionResponseCache.lookup(cacheKey) : null;

    let release: (() => void) | undefined;
    let metricStatus = 502;
    let metricBytes = 0;
    const finishMetric = functionMetrics.begin();
    try {
      if (cached) {
        functionMetrics.recordCacheHit();
        metricStatus = cached.status;
        metricBytes = cached.body.byteLength;
        reply.header("x-function-cache", "HIT");
        return reply.code(cached.status).headers(publicHeaders(cached.headers)).send(cached.body);
      }
      if (cacheKey) functionMetrics.recordCacheMiss();

      const execute = async () => {
        release = await (deps.acquireSlot ?? (siteId => functionLimiter.acquire(siteId)))(site.projectId);
        const env = await deps.secrets(site.projectId);
        const result = await deps.invoke({
          artifactDir: hostingFunctionDir(site.slug, activeReleaseId, fn.name),
          fn,
          request: input,
          env,
        });
        if (result.jobs?.length) {
          // Постановка до ответа: если очередь недоступна, клиент не должен получить 202
          // и решить, что задача принята.
          await deps.enqueueJobs?.({ site, requests: result.jobs });
        }
        return result;
      };

      const result = cacheKey ? await functionResponseCache.load(cacheKey, execute) : await execute();
      if (cachePolicy) functionResponseCache.store(cacheKey, result, cachePolicy.ttlSeconds);
      metricStatus = result.status;
      metricBytes = result.body.byteLength;
      return reply.code(result.status).headers(publicHeaders(result.headers)).send(result.body);
    } catch (error) {
      if (error instanceof FunctionCapacityError) {
        functionMetrics.recordCapacityRejection();
        metricStatus = error.statusCode;
        reply.header("retry-after", "1");
        return sendError(reply, error.statusCode, error.message, { code: error.code });
      }
      if (error instanceof FunctionInvokeError) {
        functionMetrics.recordInvokeFailure();
        metricStatus = error.statusCode;
        request.log.warn({ error: error.message, function: fn.name, site: site.slug }, "function failed");
        return sendError(reply, error.statusCode, error.message, { function: fn.name });
      }
      if (error instanceof HostingError) {
        functionMetrics.recordJobEnqueueFailure();
        metricStatus = error.statusCode;
        request.log.warn({ error: error.message, function: fn.name, site: site.slug }, "function job enqueue failed");
        return sendError(reply, error.statusCode, error.message, { code: error.code, function: fn.name });
      }
      functionMetrics.recordCrash();
      request.log.error({ error, function: fn.name, site: site.slug }, "function crashed");
      return sendError(reply, 502, "Функция завершилась с ошибкой", { function: fn.name });
    } finally {
      finishMetric(metricStatus, metricBytes);
      release?.();
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
  return "serverless-функции: дверь 0.0.0.0:" + functionsHostPort() + ", маршрут /api/*, одноразовый контейнер на запрос, " + functionLimiter.describe();
}
