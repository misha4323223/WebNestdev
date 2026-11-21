import type { FastifyRequest } from "fastify";
import { getPlatformEnv } from "../platform/platform-env.js";
import { fallbackOrigin, originFromRequest } from "../oauth/oauth-flow.js";

/**
 * Публичный адрес приложения для абсолютных ссылок в письмах.
 *
 * `PLATFORM_URL` — единственный адрес, который не зависит от запроса: за TLS-прокси
 * `Host` можно подделать, а `Origin` приходит только от браузера. Если явная настройка
 * отсутствует, берём разрешённый Origin из списка `WEBNESTDEV_ALLOWED_ORIGINS`, а не
 * `Host`. Пустой `PLATFORM_URL` не должен превращать ссылку сброса в чужой адрес.
 */
export function publicBaseUrl(request: FastifyRequest): string {
  const configured = getPlatformEnv("PLATFORM_URL")?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return originFromRequest(request) ?? fallbackOrigin();
}
