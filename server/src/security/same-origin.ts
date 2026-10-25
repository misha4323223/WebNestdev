import type { FastifyInstance, FastifyRequest } from "fastify";

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

/** Loopback-источники в разработке: Vite проксирует /api и меняет Host, но не Origin. */
function isLoopbackOrigin(value: string) {
  try {
    const host = new URL(value).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
  } catch {
    return false;
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
  const fetchSite = firstHeader(request.headers["sec-fetch-site"]).toLowerCase();
  if (fetchSite === "cross-site") return false;
  // Браузер уже подтвердил, что страница и запрос — один origin. Это важно за прокси,
  // который меняет Host (Vite в разработке: панель на 5173, API на 8787): сравнивать Origin
  // с внутренним Host бессмысленно, а Sec-Fetch-Site браузер подделать не даёт.
  // `same-site` сюда не входит: соседний поддомен — другой origin и так не доверяется.
  if (fetchSite === "same-origin") return true;

  const normalized = normalizeOrigin(origin);
  // В разработке панель открыта на Vite (5173), а API слушает 8787: `changeOrigin` подменяет Host,
  // поэтому строгое сравнение с Host ломало бы каждое сохранение. Production правило не ослабляет.
  if (process.env.NODE_ENV !== "production" && isLoopbackOrigin(origin)) return true;
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

/** Методы, которые не меняют состояние: для них проверка источника не нужна. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Маршруты, куда приходит не браузер, а платежный сервис. У них нет `Origin`, но некоторые
 * посредники его дописывают; подпись уведомления проверяется отдельно, так что CSRF здесь не
 * применим.
 */
export const CROSS_SITE_WEBHOOKS = [/^\/api\/billing\/robokassa\/result$/];

/**
 * Маршруты, которые аутентифицируются только заголовком `Authorization: Bearer`.
 *
 * Cookie они не читают и не ставят, поэтому чужой сайт не может приложить вход к своему запросу:
 * CSRF здесь нечем — подделать заголовок браузер межсайтовой странице не даёт без CORS-preflight,
 * а preflight проходит только для источников из `WEBNESTDEV_ADMIN_ORIGINS`. Именно поэтому префикс
 * исключён из Origin-guard: браузерная админка живёт на своём источнике, а не на домене панели.
 */
export const TOKEN_ONLY_API = [/^\/api\/admin\//];

/**
 * Один хук на всё приложение: любой небезопасный запрос к `/api` с чужим `Origin` отклоняется.
 *
 * Раньше проверка стояла только на маршрутах секретов, ключей платформы и оплаты. Остальные
 * изменяющие ручки оставались открытыми для того же сайта: приложение пользователя живёт на
 * поддомене предпросмотра, а `SameSite=Lax` отличает только «сайт», поэтому cookie панели в таком
 * запросе отправляется. POST без тела (запуск/остановка предпросмотра, отключение GitHub) браузер
 * отправляет без preflight, то есть без CORS-барьера.
 */
export async function registerSameOriginGuard(app: FastifyInstance) {
  app.addHook("onRequest", async (request, reply) => {
    if (SAFE_METHODS.has(request.method)) return;
    const path = (request.raw.url ?? request.url ?? "").split("?")[0];
    if (!path.startsWith("/api/")) return;
    if (CROSS_SITE_WEBHOOKS.some(allowed => allowed.test(path))) return;
    if (TOKEN_ONLY_API.some(allowed => allowed.test(path))) return;
    if (isSameOriginRequest(request)) return;
    request.log.warn({ origin: request.headers.origin, path }, "cross-site request refused");
    return reply.code(403).send({ error: sameOriginRefusal() });
  });
}
