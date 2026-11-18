import { consumeRateLimit, type RateLimitVerdict } from "../storage/rate-limit-store.js";

/**
 * Лимит запросов к отдельной API-двери функций.
 *
 * CDN не пропускает POST, поэтому формы сайтов идут напрямую на `api.nestdev.ru`, минуя
 * edge-защиту. Конкурентный лимит (`functionLimiter`) не спасает от потока коротких запросов:
 * каждый из них по очереди занимает слот, а источник продолжает слать новые. Здесь считается
 * именно частота с одного IP на один сайт, и лишние запросы получают 429 до запуска контейнера.
 *
 * Счётчики живут в общем `rate-limit-store`: PostgreSQL в production и файл локально. Поэтому
 * окно не обнуляется рестартом и одинаково для обеих нод. Ошибка хранилища не запирает сайт:
 * недоступная база не должна превращаться в «магазин не принимает заказы».
 */

export const FUNCTIONS_API_RATE_LIMIT_ENV = "FUNCTIONS_API_RATE_LIMIT_PER_MINUTE";

const DEFAULT_LIMIT = 120;
const WINDOW_MS = 60_000;

export type FunctionsApiRateLimitOptions = {
  /** Сколько запросов с одного IP на один сайт разрешено за минуту. */
  limit: number;
  windowMs: number;
};

function positiveInt(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function functionsApiRateLimitOptions(env: NodeJS.ProcessEnv = process.env): FunctionsApiRateLimitOptions {
  return {
    limit: positiveInt(env[FUNCTIONS_API_RATE_LIMIT_ENV], DEFAULT_LIMIT, 1, 10_000),
    windowMs: WINDOW_MS,
  };
}

/** Ключ на сайт, а не на slug: переименование сайта не должно обнулять окно. */
export function functionsApiRateLimitKey(siteId: string, ip: string) {
  return "functions:api:" + siteId + ":" + (ip.trim() || "unknown");
}

export async function checkFunctionsApiRateLimit(
  siteId: string,
  ip: string,
  options: FunctionsApiRateLimitOptions = functionsApiRateLimitOptions(),
  consume: (key: string, limit: number, windowMs: number) => Promise<RateLimitVerdict> = consumeRateLimit,
): Promise<RateLimitVerdict> {
  try {
    return await consume(functionsApiRateLimitKey(siteId, ip), options.limit, options.windowMs);
  } catch (error) {
    console.warn(
      "[functions] счётчик частоты API недоступен, проверка пропущена: " +
        (error instanceof Error ? error.message : String(error)),
    );
    return { allowed: true, retryAfter: 0 };
  }
}

export function describeFunctionsApiRateLimit(options = functionsApiRateLimitOptions()) {
  return "API-дверь: " + options.limit + " запросов в минуту с одного IP на сайт";
}
