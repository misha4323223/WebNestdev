import type { FastifyRequest } from "fastify";

/**
 * Защита от CSRF для маршрутов, которые меняют секреты.
 *
 * Cookie сессии стоит `SameSite=Lax`, поэтому межсайтовый POST её и так не отправит. Но
 * `Lax` не спасает от страницы на соседнем поддомене или от браузера, который трактует
 * `localhost:5173` и `localhost:8787` как один сайт. Поэтому мутация секрета дополнительно
 * требует, чтобы `Origin` совпадал с адресом, на который пришёл запрос.
 *
 * Запрос без `Origin` (curl, серверный вызов, мобильный клиент) пропускается: cookie всё равно
 * нужна, а подделать её межсайтовая страница не может. Явно заданный список источников
 * (`WEBNESTDEV_ALLOWED_ORIGINS`) побеждает сравнение с `Host`: за TLS-прокси `Host` может быть
 * внутренним, а список — единственная правда.
 */

function firstHeader(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function normalizeOrigin(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

function configuredOrigins() {
  return (process.env.WEBNESTDEV_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean);
}

export function isSameOriginRequest(request: FastifyRequest): boolean {
  const origin = firstHeader(request.headers.origin);
  // Браузер сообщает `null` для sandboxed iframe и file:// — это не наш источник.
  if (!origin) return true;
  if (origin === "null") return false;

  // Современные браузеры присылают это вместе с Origin; значение надёжнее, чем разбор адреса.
  if (firstHeader(request.headers["sec-fetch-site"]).toLowerCase() === "cross-site") return false;

  const normalized = normalizeOrigin(origin);
  const allowed = configuredOrigins();
  if (allowed.length) return allowed.includes(normalized);

  const host = firstHeader(request.headers["x-forwarded-host"]) || firstHeader(request.headers.host);
  if (!host) return false;
  const proto =
    firstHeader(request.headers["x-forwarded-proto"]).split(",")[0].trim().toLowerCase() ||
    request.protocol ||
    "http";
  return normalized === normalizeOrigin(proto + "://" + host);
}

/** Единый отказ: не подсказываем, какой именно источник «почти подошёл». */
export function sameOriginRefusal() {
  return "Запрос с чужого источника отклонён";
}
