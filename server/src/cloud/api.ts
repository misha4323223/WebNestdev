import { getCloudConnection, type CloudConnection } from "./connections.js";
import type { CloudProviderId } from "./providers.js";
import { mwsRequest } from "../mws/mws-auth.js";

/**
 * Запросы к API подключённых облаков от имени пользователя. Пока только чтение: изменение
 * ресурсов — отдельное согласие, как переключатель записей у Yandex Cloud, и до него здесь
 * просто нет пути (любой метод кроме GET/HEAD отклоняется).
 *
 * Каждый провайдер разрешает только свои хосты: ключ пользователя не должен уйти на чужой
 * адрес из-за опечатки в пути, а пути ограничены API-префиксом сервиса.
 */

const TIMEOUT_MS = 20_000;
const MAX_BODY_CHARS = 8000;
const READ_METHODS = new Set(["GET", "HEAD"]);

export type CloudApiRequest = { method?: string; path: string; host?: string };

/** Разбор и проверка адреса запроса — без сети, поэтому проверяется тестом. */
export function cloudRequestTarget(provider: CloudProviderId, request: CloudApiRequest) {
  const method = (request.method ?? "GET").toUpperCase();
  if (!READ_METHODS.has(method)) {
    throw new Error("Пока доступно только чтение: " + method + " к облаку запрещён. Изменения ресурсов появятся вместе с переключателем разрешений.");
  }
  const path = request.path.trim();
  if (!path.startsWith("/") || path.includes("..")) throw new Error("Некорректный путь запроса: " + path);

  if (provider === "timeweb") {
    if (!path.startsWith("/api/v1/")) throw new Error("Timeweb Cloud: путь должен начинаться с /api/v1/");
    return { method, url: "https://api.timeweb.cloud" + path, host: "api.timeweb.cloud" };
  }
  if (provider === "cloudru") {
    const host = request.host?.trim() || "api.cloud.ru";
    if (host !== "cloud.ru" && !host.endsWith(".cloud.ru")) throw new Error("Cloud.ru: разрешены только хосты *.cloud.ru, получен " + host);
    return { method, url: "https://" + host + path, host };
  }
  const host = request.host?.trim() || "api.mwsapis.ru";
  if (!/^[a-z0-9-]+\.mwsapis\.ru$/.test(host)) throw new Error("MWS: разрешены только хосты *.mwsapis.ru, получен " + host);
  return { method, url: "https://" + host + path, host };
}

function fieldsOf(connection: CloudConnection) {
  return JSON.parse(connection.secret) as Record<string, string>;
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function cloudRuToken(userId: string, keyId: string, secret: string) {
  // Ключ в кэше — по паре (пользователь, Key ID): после переподключения с другим ключом
  // токен старого аккаунта не должен отвечать за нового.
  const cacheKey = userId + ":" + keyId;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch("https://iam.api.cloud.ru/api/v1/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyId, secret }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error("Cloud.ru IAM вернул " + response.status + ": " + text.slice(0, 300));
    const parsed = JSON.parse(text) as { access_token?: string };
    if (!parsed.access_token) throw new Error("Cloud.ru IAM не выдал токен");
    tokenCache.set(cacheKey, { token: parsed.access_token, expiresAt: Date.now() + 50 * 60 * 1000 });
    return parsed.access_token;
  } finally {
    clearTimeout(timer);
  }
}

/** Один авторизованный запрос к подключённому облаку. */
export async function cloudFetch(userId: string, provider: CloudProviderId, request: CloudApiRequest) {
  const target = cloudRequestTarget(provider, request);
  const connection = await getCloudConnection(userId, provider);
  if (!connection) throw new Error("Облако не подключено: попросите пользователя подключить " + provider + " в разделе «Интеграции».");
  const fields = fieldsOf(connection);

  if (provider === "mws") {
    const result = await mwsRequest({ method: target.method, host: target.host, path: request.path }, { key: fields.key });
    return { ...result, provider };
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (provider === "timeweb") headers.Authorization = "Bearer " + fields.token;
  else headers.Authorization = "Bearer " + await cloudRuToken(userId, fields.keyId, fields.secret);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(target.url, { method: target.method, headers, signal: controller.signal });
    const text = await response.text();
    let body: unknown = text.slice(0, MAX_BODY_CHARS);
    try { body = text ? JSON.parse(text) : null; } catch { /* не JSON — отдаём текстом */ }
    return { ok: response.ok, status: response.status, provider, method: target.method, url: target.url, body };
  } catch (error) {
    throw new Error("Нет ответа от " + target.host + ": " + (error instanceof Error ? error.message : String(error)));
  } finally {
    clearTimeout(timer);
  }
}
