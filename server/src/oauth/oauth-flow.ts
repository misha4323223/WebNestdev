import type { FastifyRequest } from "fastify";

/**
 * The OAuth app is registered by the user, so the flow must use the origin the browser
 * actually talks to (a hosted preview or production domain), not the API host: the
 * frontend proxies /api, so that origin serves the callback too. Production pins the
 * allowed origins in index.ts, so only those are trusted; development mirrors the
 * existing permissive CORS policy.
 */
export function isAllowedOrigin(origin: string) {
  let url: URL;
  try { url = new URL(origin); } catch { return false; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  const allowed = (process.env.WEBNESTDEV_ALLOWED_ORIGINS ?? "").split(",").map(value => value.trim()).filter(Boolean);
  if (allowed.length) return allowed.includes(url.origin);
  return process.env.NODE_ENV !== "production";
}

export function originFromRequest(request: FastifyRequest) {
  const header = request.headers.origin;
  if (typeof header === "string" && isAllowedOrigin(header)) return new URL(header).origin;
  const referer = request.headers.referer;
  if (typeof referer === "string") {
    try {
      const url = new URL(referer);
      if (isAllowedOrigin(url.origin)) return url.origin;
    } catch {}
  }
  return null;
}

export type OAuthFlowOptions = {
  /** Path of the provider callback on this server, for example "/api/github/callback". */
  callbackPath: string;
  configuredCallbackUrl?: string;
  configuredFrontendUrl?: string;
  requestedOrigin?: string;
};

/**
 * Явно заданные адреса важнее вычисленных, но **пустая строка — это не адрес**. Compose передаёт
 * в контейнер каждую перечисленную переменную, поэтому незаданный `GITHUB_CALLBACK_URL`
 * приходит как `""`, а не отсутствует. Раньше такое значение побеждало вычисленный адрес: в
 * GitHub уходил `redirect_uri=` (пустой), а все отказы возвращали в `?github=…` без пути —
 * кнопка «Подключить» завершалась «ссылка авторизации устарела».
 */
function explicitUrl(value?: string) {
  const text = value?.trim();
  return text ? text : undefined;
}

/** Explicit env URLs win, so a pinned deployment keeps working exactly as before. */
export function resolveOAuthFlow(request: FastifyRequest, options: OAuthFlowOptions) {
  const requested = options.requestedOrigin && isAllowedOrigin(options.requestedOrigin) ? new URL(options.requestedOrigin).origin : null;
  const origin = requested ?? originFromRequest(request) ?? "http://localhost:" + (process.env.PORT ?? 8787);
  return {
    origin,
    callbackUrl: explicitUrl(options.configuredCallbackUrl) ?? origin + options.callbackPath,
    frontendUrl: explicitUrl(options.configuredFrontendUrl) ?? origin + "/",
  };
}

/** The callback is opened by the browser, so failures return to the app instead of raw JSON. */
export function redirectToApp(reply: { redirect: (url: string) => unknown }, frontendUrl: string, provider: string, status: string) {
  return reply.redirect(frontendUrl + (frontendUrl.includes("?") ? "&" : "?") + provider + "=" + encodeURIComponent(status));
}
