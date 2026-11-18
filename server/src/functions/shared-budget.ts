/**
 * Общие бюджеты на сайт и аккаунт.
 *
 * Локальный token bucket защищает ноду от всплеска, но не знает, что тот же сайт долбит вторую
 * ноду. Эти окна живут в общем `rate-limit-store` (PostgreSQL в production), поэтому счётчик
 * один на кластер и переживает рестарт. Проверка стоит двух атомарных upsert'ов только на путь
 * функции; статика и кэшированные ответы сюда не попадают.
 *
 * Ошибка хранилища не запирает сайт: недоступная база не должна означать «магазин не принимает
 * заказы». Это тот же fail-open, что и у per-IP лимита.
 */

import { consumeRateLimit, type RateLimitVerdict } from "../storage/rate-limit-store.js";

export const FUNCTIONS_SITE_RATE_LIMIT_ENV = "FUNCTIONS_SITE_RATE_LIMIT_PER_MINUTE";
export const FUNCTIONS_ACCOUNT_RATE_LIMIT_ENV = "FUNCTIONS_ACCOUNT_RATE_LIMIT_PER_MINUTE";

const DEFAULT_SITE_LIMIT = 2_400;
const DEFAULT_ACCOUNT_LIMIT = 4_800;
const WINDOW_MS = 60_000;

export type SharedBudgetOptions = {
  siteLimit: number;
  accountLimit: number;
  windowMs: number;
};

export type SharedBudgetVerdict = RateLimitVerdict & { scope?: "site" | "account" };

function positiveInt(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function sharedBudgetOptions(env: NodeJS.ProcessEnv = process.env): SharedBudgetOptions {
  return {
    siteLimit: positiveInt(env[FUNCTIONS_SITE_RATE_LIMIT_ENV], DEFAULT_SITE_LIMIT, 1, 1_000_000),
    accountLimit: positiveInt(env[FUNCTIONS_ACCOUNT_RATE_LIMIT_ENV], DEFAULT_ACCOUNT_LIMIT, 1, 1_000_000),
    windowMs: WINDOW_MS,
  };
}

export function sharedBudgetKey(kind: "site" | "account", id: string) {
  return "functions:" + kind + ":" + (id.trim() || "unknown");
}

export async function checkFunctionsSharedBudget(
  input: { siteId: string; userId: string },
  options: SharedBudgetOptions = sharedBudgetOptions(),
  consume: (key: string, limit: number, windowMs: number) => Promise<RateLimitVerdict> = consumeRateLimit,
): Promise<SharedBudgetVerdict> {
  try {
    const site = await consume(sharedBudgetKey("site", input.siteId), options.siteLimit, options.windowMs);
    if (!site.allowed) return { ...site, scope: "site" };
    const account = await consume(sharedBudgetKey("account", input.userId), options.accountLimit, options.windowMs);
    if (!account.allowed) return { ...account, scope: "account" };
    return site;
  } catch (error) {
    console.warn(
      "[functions] общий бюджет недоступен, проверка пропущена: " +
        (error instanceof Error ? error.message : String(error)),
    );
    return { allowed: true, retryAfter: 0 };
  }
}

export function describeFunctionsSharedBudget(options = sharedBudgetOptions()) {
  return "функции: " + options.siteLimit + "/мин на сайт, " +
    options.accountLimit + "/мин на аккаунт";
}
