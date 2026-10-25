import type { FastifyInstance, FastifyRequest } from "fastify";
import { applyNoStoreToReply } from "../routes/cache-headers.js";

/**
 * Заголовки безопасности для ответов панели.
 *
 * CSP включается только в production: в разработке Vite подставляет свои inline-скрипты и
 * eval-обвязку HMR, и строгая политика ломала бы локальную панель, ничего не защищая на
 * localhost. В production документ собирается Vite в обычные файлы с того же origin, поэтому
 * `script-src 'self'` работает без послаблений. `style-src` разрешает inline-стили: панель
 * использует их для раскладки, а не для вставки чужого HTML.
 *
 * HSTS ставится только на ответ, который действительно пришёл по https: заголовок на http
 * игнорируется браузером, а ошибочный `includeSubDomains` мог бы закрыть соседние поддомены.
 * `frame-ancestors` и `X-Frame-Options` запрещают встраивать панель, но не мешают панели
 * показывать предпросмотр проекта в iframe с разрешённого https-адреса.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
  "frame-src 'self' https:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "media-src 'self' data: blob: https:",
].join("; ");

export function requestIsHttps(request: FastifyRequest) {
  const forwarded = request.headers["x-forwarded-proto"];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (value) return value.split(",")[0].trim().toLowerCase() === "https";
  return request.protocol === "https";
}

export function securityHeaders(request: FastifyRequest, environment = process.env.NODE_ENV) {
  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    // SAMEORIGIN, not DENY: живой предпросмотр проекта открывается в iframe панели.
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  };
  if (environment === "production") {
    headers["Content-Security-Policy"] = CONTENT_SECURITY_POLICY;
    if (requestIsHttps(request)) headers["Strict-Transport-Security"] = "max-age=15552000";
  }
  return headers;
}

/**
 * Один хук на всё приложение: заголовки ставятся и на документ, и на API. Ответы API не
 * кэшируются, если маршрут не задал своё правило явно: в них бывают проекты, ключи, баланс и
 * переписка, а `private` в общем кэше посредника — не гарантия.
 */
export async function registerSecurityHeaders(app: FastifyInstance) {
  app.addHook("onSend", async (request, reply, payload) => {
    for (const [name, value] of Object.entries(securityHeaders(request))) reply.header(name, value);
    const path = (request.raw.url ?? "").split("?")[0];
    if (path.startsWith("/api/") && !reply.getHeader("cache-control")) applyNoStoreToReply(reply);
    return payload;
  });
}
