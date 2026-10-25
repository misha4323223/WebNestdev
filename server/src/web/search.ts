import { createLimiter, positiveInt, type LimiterStats, type Slot } from "../concurrency.js";
import { consumeUsage, getUsageSnapshot, UsageLimitError } from "../account/usage-store.js";
import { limitsForPlan, type PlanId } from "../account/plans.js";
import { searchDuckDuckGo } from "./duckduckgo.js";
import { searchYandex, yandexSearchConfig } from "./yandex-search.js";
import { searchTavily, tavilyKey } from "./tavily.js";
import { WebSearchError, type WebResult, type WebSearchProvider, type WebSearchResponse } from "./web-types.js";

/**
 * Слой поиска: кто отвечает, в каком порядке, сколько запросов идёт одновременно, что кэшируется и
 * как отказ провайдера превращается в понятный ответ.
 *
 * Разделение по тарифу — правило продукта, а не настройка:
 * - бесплатный тариф: только DuckDuckGo. Это режим «попробовать»: бесплатно, без ключа, без гарантий
 *   (DuckDuckGo не публикует API и ограничивает серверные адреса — см. `duckduckgo.ts`);
 * - платные тарифы: Yandex Search API основным провайдером и Tavily резервным. Подписка не должна
 *   оставаться без поиска из-за одной неготовой интеграции, а бесплатный провайдер последней
 *   ступенью нужен, чтобы поиск не выключался целиком, если оба ключа ещё не заведены.
 *
 * `WEB_SEARCH_PROVIDER=auto|duckduckgo|yandex|tavily` переопределяет выбор на весь сервер, но
 * только внутри права тарифа: включённый на сервере `yandex` не даёт бесплатному аккаунту платную
 * выдачу. Раньше давал — и бесплатный запуск со своим AI-провайдером уходил в Yandex Search API.
 */

const DEFAULT_LIMIT = 8;

export type SearchLocale = {
  /** Регион выдачи для DuckDuckGo (`kl`), например `ru-ru`. */
  region: string;
  /** Тип выдачи Yandex Search API. */
  searchType: "SEARCH_TYPE_RU" | "SEARCH_TYPE_COM" | "SEARCH_TYPE_TR";
};

/**
 * Язык выдачи по самому запросу. Раньше все запросы уходили в одну региональную выдачу, и
 * русскоязычная тема возвращала англоязычные страницы (или наоборот). Модель формулирует запрос
 * на языке источников, поэтому скрипт запроса — достаточный сигнал; явный `WEB_SEARCH_REGION`
 * по-прежнему важнее и позволяет закрепить регион на сервере.
 */
export function localeForQuery(query: string): SearchLocale {
  const cyrillic = (query.match(/[А-Яа-яЁё]/g) ?? []).length;
  const configured = (process.env.WEB_SEARCH_REGION ?? "").trim();
  if (cyrillic >= 2) return { region: configured || "ru-ru", searchType: "SEARCH_TYPE_RU" };
  if (/[\u0600-\u06FF]/.test(query)) return { region: configured || "tr-tr", searchType: "SEARCH_TYPE_TR" };
  return { region: configured || "us-en", searchType: "SEARCH_TYPE_COM" };
}

/** Одинаковые запросы внутри одного запуска повторяются часто: кэш экономит и квоту, и время. */
const cacheTtlMs = () => positiveInt(process.env.WEB_SEARCH_CACHE_TTL_MS, 600_000);
const cacheSize = () => positiveInt(process.env.WEB_SEARCH_CACHE_SIZE, 200);

const searchLimiter = createLimiter(() => ({
  limit: positiveInt(process.env.WEB_SEARCH_MAX_CONCURRENT, 2),
  queueLimit: positiveInt(process.env.WEB_SEARCH_MAX_QUEUE, 8),
  waitTimeoutMs: positiveInt(process.env.WEB_SEARCH_QUEUE_TIMEOUT_MS, 30_000),
  busyLabel: "Веб-поиск",
}));

export function webSearchQueueStats(): LimiterStats {
  return searchLimiter.stats();
}

/** Провайдер тарифа по умолчанию: бесплатный — DuckDuckGo, платные — Yandex Search API. */
export function providerForPlan(plan: PlanId): WebSearchProvider {
  return plan === "free" ? "duckduckgo" : "yandex";
}

/** Переопределение из окружения: `auto` (по тарифу) — значение по умолчанию. */
export function configuredProviderOverride(): WebSearchProvider | null {
  const value = (process.env.WEB_SEARCH_PROVIDER ?? "").trim().toLowerCase();
  return value === "duckduckgo" || value === "yandex" || value === "tavily" ? value : null;
}

/** Тариф без подписки: для него цепочка провайдеров не расширяется никогда. */
function isFreePlan(plan: PlanId) {
  return plan === "free";
}

/**
 * Порядок провайдеров для тарифа. Первый — основной, следующие включаются только при отказе
 * предыдущего. Провайдер без ключа в цепочку не попадает: иначе каждый запрос начинался бы с
 * гарантированного отказа.
 */
export function providerChain(plan: PlanId): { chain: WebSearchProvider[]; note?: string } {
  const override = configuredProviderOverride();
  const yandex = Boolean(yandexSearchConfig());
  const tavily = Boolean(tavilyKey());

  // Тариф — жёсткая граница: переопределение провайдера на сервере не может выдать бесплатному
  // аккаунту платную выдачу. Это правило проверяется до всех остальных веток, потому что цена
  // запроса Yandex платит платформа, а бесплатный тариф её не покрывает.
  if (isFreePlan(plan)) {
    const forced = override && override !== "duckduckgo"
      ? "WEB_SEARCH_PROVIDER=" + override + " не применяется к бесплатному тарифу: его поиск всегда идёт через DuckDuckGo."
      : undefined;
    return { chain: ["duckduckgo"], ...(forced ? { note: forced } : {}) };
  }

  if (override === "duckduckgo") return { chain: ["duckduckgo"] };
  if (override === "yandex") {
    if (yandex) return { chain: ["yandex", ...(tavily ? ["tavily" as const] : []), "duckduckgo"] };
    return {
      chain: ["duckduckgo"],
      note: "WEB_SEARCH_PROVIDER=yandex задан, но Yandex Search API не настроен (нет ключа или каталога) — поиск идёт через DuckDuckGo.",
    };
  }
  if (override === "tavily") {
    if (tavily) return { chain: ["tavily", "duckduckgo"] };
    return {
      chain: ["duckduckgo"],
      note: "WEB_SEARCH_PROVIDER=tavily задан, но TAVILY_API_KEY не настроен — поиск идёт через DuckDuckGo.",
    };
  }

  const chain: WebSearchProvider[] = [];
  if (yandex) chain.push("yandex");
  if (tavily) chain.push("tavily");
  chain.push("duckduckgo");
  const missing: string[] = [];
  if (!yandex) missing.push("YANDEX_SEARCH_API_KEY и YANDEX_SEARCH_FOLDER_ID");
  if (!tavily) missing.push("TAVILY_API_KEY");
  return missing.length === 2
    ? { chain, note: "Тариф платный, но ключи поисковых провайдеров не заданы (" + missing.join("; ") + ") — пока отвечает DuckDuckGo." }
    : { chain };
}

/** Основной провайдер тарифа: им подписан ответ, если он не отказал. */
export function resolveProvider(plan: PlanId): { provider: WebSearchProvider; note?: string } {
  const { chain, note } = providerChain(plan);
  return { provider: chain[0] ?? "duckduckgo", ...(note ? { note } : {}) };
}

type CacheEntry = { expiresAt: number; provider: WebSearchProvider; results: WebResult[] };
const cache = new Map<string, CacheEntry>();

function cacheKey(plan: PlanId, query: string, limit: number, locale: SearchLocale) {
  // Ключ включает класс тарифа: бесплатный запрос не должен получать из кэша ответ платного
  // провайдера (и наоборот) — иначе ответ приписывался бы не тому источнику. Регион тоже входит
  // в ключ: смена WEB_SEARCH_REGION не должна отдавать старую выдачу.
  return (isFreePlan(plan) ? "free" : "paid") + "|" + limit + "|" + locale.region + "|" + query.toLowerCase().replace(/\s+/g, " ");
}

function readCache(key: string): CacheEntry | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  // Переставляем запись в конец: `Map` удаляет из начала, то есть вытесняет самое старое.
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

function writeCache(key: string, provider: WebSearchProvider, results: WebResult[]) {
  const limit = cacheSize();
  while (cache.size >= limit) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  cache.set(key, { expiresAt: Date.now() + cacheTtlMs(), provider, results });
}

/** Кэш живёт в памяти процесса и в тестах должен начинаться с чистого листа. */
export function clearWebSearchCache() {
  cache.clear();
}

export type WebSearchInput = {
  userId: string;
  plan: PlanId;
  query: string;
  limit?: number;
  signal?: AbortSignal;
};

function failure(provider: WebSearchProvider, query: string, error: unknown, note?: string): WebSearchResponse {
  const code = error instanceof WebSearchError ? error.code : "unavailable";
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, provider, query, results: [], code, error: message, ...(note ? { note } : {}) };
}

async function runProvider(provider: WebSearchProvider, query: string, limit: number, locale: SearchLocale, signal?: AbortSignal): Promise<WebResult[]> {
  const slot: Slot = await searchLimiter.acquire(signal);
  try {
    if (provider === "yandex") return await searchYandex(query, { limit, searchType: locale.searchType, ...(signal ? { signal } : {}) });
    if (provider === "tavily") return await searchTavily(query, { limit, ...(signal ? { signal } : {}) });
    return await searchDuckDuckGo(query, { limit, region: locale.region, ...(signal ? { signal } : {}) });
  } finally {
    slot.release();
  }
}

/**
 * Поиск для одного запроса агента.
 *
 * Порядок намеренно такой: квота проверяется до запроса, а списывается только за удачный ответ —
 * иначе сеть провайдера съедала бы дневной лимит отказами, и пользователь терял бы все поиски дня,
 * не увидев ни одного результата. Ответ из кэша не списывается вовсе. Отказ провайдера передаёт
 * запрос следующему в цепочке тарифа, а причина отказа остаётся в `note`.
 */
export async function searchWeb(input: WebSearchInput): Promise<WebSearchResponse> {
  const query = input.query.trim();
  const limit = Math.min(20, Math.max(1, Math.floor(input.limit ?? DEFAULT_LIMIT)));
  if (!query) return { ok: false, provider: "duckduckgo", query, results: [], code: "unavailable", error: "Пустой поисковый запрос" };

  const { chain, note } = providerChain(input.plan);
  const locale = localeForQuery(query);
  const key = cacheKey(input.plan, query, limit, locale);
  const cached = readCache(key);
  if (cached) return { ok: true, provider: cached.provider, query, results: cached.results, cached: true, ...(note ? { note } : {}) };

  const snapshot = await getUsageSnapshot(input.userId);
  const dailyLimit = limitsForPlan(input.plan).webSearchesPerDay;
  if (snapshot.webSearches >= dailyLimit) {
    return {
      ok: false,
      provider: chain[0] ?? "duckduckgo",
      query,
      results: [],
      code: "quota",
      error: "Дневной лимит поисков в интернете исчерпан (" + snapshot.webSearches + " из " + dailyLimit + "). Следующий поиск будет доступен завтра.",
    };
  }

  /** Списание за удачный ответ: отказ провайдера не должен тратить дневной лимит. */
  const charge = async () => {
    try { await consumeUsage(input.userId, "webSearches", input.plan); }
    catch (error) {
      // Параллельные запуски могли исчерпать лимит между проверкой и списанием: результат уже
      // получен и отдан, поэтому гонка не превращается в ошибку поиска.
      if (!(error instanceof UsageLimitError)) throw error;
    }
  };

  const failures: Array<{ provider: WebSearchProvider; error: unknown }> = [];
  for (const provider of chain) {
    if (input.signal?.aborted) break;
    try {
      const results = await runProvider(provider, query, limit, locale, input.signal);
      writeCache(key, provider, results);
      await charge();
      const reasons = failures.map(item => item.provider + ": " + (item.error instanceof Error ? item.error.message : String(item.error)));
      return {
        ok: true,
        provider,
        query,
        results,
        ...(failures.length ? { note: "Ответ получен через " + provider + " (не ответили — " + reasons.join("; ") + ")." } : note ? { note } : {}),
      };
    } catch (error) {
      failures.push({ provider, error });
    }
  }

  // Ни один провайдер цепочки не ответил: возвращается отказ первого (основного) с причинами
  // остальных, чтобы «интернет пуст» нельзя было прочитать как результат поиска.
  const primary = failures[0];
  const others = failures.slice(1).map(item => item.provider + ": " + (item.error instanceof Error ? item.error.message : String(item.error)));
  return failure(
    primary?.provider ?? chain[0] ?? "duckduckgo",
    query,
    primary?.error ?? new WebSearchError("unavailable", "Ни один провайдер поиска не ответил", chain[0] ?? "duckduckgo"),
    [note, others.length ? "Другие провайдеры: " + others.join("; ") : ""].filter(Boolean).join(" ") || undefined,
  );
}

/** Строка в лог при старте: одной фразой видно, кто отвечает и какие ключи настроены. */
export function describeWebSearch(): string {
  const override = configuredProviderOverride();
  const yandex = yandexSearchConfig() ? "ключ есть" : "ключа нет";
  const tavily = tavilyKey() ? "ключ есть" : "ключа нет";
  const mode = override
    ? "WEB_SEARCH_PROVIDER=" + override + " (free всё равно duckduckgo)"
    : "по тарифу (free → duckduckgo, платные → yandex → tavily)";
  const stats = webSearchQueueStats();
  return "веб-поиск: " + mode + "; Yandex Search API: " + yandex + "; Tavily: " + tavily + "; одновременно " + stats.limit + ", кэш " + Math.round(cacheTtlMs() / 1000) + " с";
}
