/**
 * Каталог upstream-провайдеров модели. Polza.ai отдаёт его публично:
 * `GET /v1/models?type=chat&include_providers=true`, у каждой модели есть массив `providers[]` с
 * ценой, контекстом и `supported_parameters`.
 *
 * Каталог нужен для двух вещей:
 *
 * - узнать, что провайдер ещё существует. Если `morph/fp8` выключили, его имя исчезнет из
 *   `providers[]`, и закреплённый провайдер будет пропущен до запроса, а не после отказа;
 * - посчитать порядок для режима `cheapest`. Цена одной модели различается в десятки раз,
 *   поэтому сравниваем не «цену входа», а оценку под профиль нагрузки: сколько входных токенов
 *   приходится на один выходной (`assumedInputPerOutput`).
 *
 * Кэш короткий (5 минут) и переживает сбой каталога ещё час: если Polza временно не отдаёт
 * список, запуски не должны останавливаться. Устаревший каталог всё равно лучше, чем ничего,
 * а окончательную проверку делает сам запрос — при отказе до первого байта сработает fallback.
 */
import type { UpstreamMaxPrice, UpstreamRouting } from "./upstream-routing.js";

export type UpstreamCatalogProvider = {
  name: string;
  /** Цена за 1M входных токенов в валюте каталога; `null`, если цена не разобрана. */
  promptPerMillion: number | null;
  /** Цена за 1M выходных токенов в валюте каталога; `null`, если цена не разобрана. */
  completionPerMillion: number | null;
  cacheReadPerMillion: number | null;
  currency: string;
  contextLength: number | null;
  maxCompletionTokens: number | null;
  supportedParameters: string[];
  /** Агенту обязательно нужен вызов инструментов. */
  tools: boolean;
  /** Одно имя встречается в каталоге несколько раз: закрепить «именно этот» нельзя. */
  ambiguous: boolean;
  duplicateCount: number;
  isUnofficial: boolean;
  isModerated: boolean;
  storesDataInRussia: boolean;
  isFz152Compliant: boolean;
  hostedOnPolza: boolean;
};

export type UpstreamCatalogModel = {
  id: string;
  name: string;
  contextLength: number | null;
  topProvider: string | null;
  providers: UpstreamCatalogProvider[];
  fetchedAt: string;
  stale: boolean;
};

export type UpstreamCatalogOptions = {
  refresh?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
};

type CacheEntry = {
  model: Omit<UpstreamCatalogModel, "stale">;
  fetchedAt: number;
};

const CACHE_TTL_MS = 5 * 60_000;
const STALE_TTL_MS = 60 * 60_000;
const FAILURE_BACKOFF_MS = 60_000;
const FETCH_TIMEOUT_MS = 8_000;

const cache = new Map<string, CacheEntry>();
const failureUntil = new Map<string, number>();

/** Тестам нужна чистая память: каталог одного прогона не должен влиять на следующий. */
export function resetUpstreamCatalogCache() {
  cache.clear();
  failureUntil.clear();
}

function cacheKey(baseUrl: string, model: string) {
  return baseUrl.trim().replace(/\/+$/, "") + "|" + model.trim();
}

function modelsEndpoint(baseUrl: string) {
  const base = baseUrl.trim().replace(/\/+$/, "");
  const root = base.endsWith("/v1") ? base : base + "/v1";
  const path = "/models?type=chat&include_providers=true";
  return { root, path, url: root + path };
}

/** Тот же маршрут через AI-прокси, что и у chat/completions: каталог не должен зависеть от
 * прямого доступа к шлюзу, если платформа уже ходит через зарубежный прокси. */
function catalogRequest(baseUrl: string, token: string | undefined) {
  const endpoint = modelsEndpoint(baseUrl);
  const proxyUrl = (process.env.AI_PROXY_URL ?? "").replace(/\/+$/, "");
  const proxyToken = (process.env.AI_PROXY_TOKEN ?? "").trim();
  return {
    url: proxyUrl ? proxyUrl + endpoint.path : endpoint.url,
    headers: {
      accept: "application/json",
      ...(proxyUrl ? { "x-ai-proxy-target": endpoint.root } : {}),
      ...(proxyToken && proxyUrl ? { "x-proxy-token": proxyToken } : {}),
      ...(token ? { authorization: "Bearer " + token } : {}),
    } as Record<string, string>,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function numberValue(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function providerFrom(raw: unknown): Omit<UpstreamCatalogProvider, "ambiguous" | "duplicateCount"> | null {
  const record = asRecord(raw);
  if (!record) return null;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name) return null;
  const pricing = asRecord(record.pricing);
  const supportedParameters = stringArray(record.supported_parameters);
  return {
    name,
    promptPerMillion: numberValue(pricing?.prompt_per_million),
    completionPerMillion: numberValue(pricing?.completion_per_million),
    cacheReadPerMillion: numberValue(pricing?.input_cache_read_per_million),
    currency: typeof pricing?.currency === "string" ? pricing.currency : "",
    contextLength: numberValue(record.context_length),
    maxCompletionTokens: numberValue(record.max_completion_tokens),
    supportedParameters,
    tools: supportedParameters.includes("tools"),
    isUnofficial: booleanValue(record.is_unofficial),
    isModerated: booleanValue(record.is_moderated),
    storesDataInRussia: booleanValue(record.stores_data_in_russia),
    isFz152Compliant: booleanValue(record.is_fz152_compliant),
    hostedOnPolza: booleanValue(record.is_hosted_on_polza_infrastructure),
  };
}

/** Разбор одной модели из ответа каталога; экспортируется для тестов без сети. */
export function parseUpstreamModel(value: unknown, modelId: string): Omit<UpstreamCatalogModel, "stale"> | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!id) return null;
  const parsed = Array.isArray(record.providers)
    ? record.providers.map(providerFrom).filter((item): item is Omit<UpstreamCatalogProvider, "ambiguous" | "duplicateCount"> => item !== null)
    : [];
  const counts = new Map<string, number>();
  for (const provider of parsed) counts.set(provider.name, (counts.get(provider.name) ?? 0) + 1);
  const seen = new Set<string>();
  const providers: UpstreamCatalogProvider[] = [];
  for (const provider of parsed) {
    // Дубликаты не склеиваем: одинаковое имя может означать разные пути маршрутизации с разными
    // параметрами. Для `cheapest` такие имена исключаются, для `fixed` — остаются с пометкой.
    const duplicateCount = counts.get(provider.name) ?? 1;
    if (seen.has(provider.name)) continue;
    seen.add(provider.name);
    providers.push({ ...provider, ambiguous: duplicateCount > 1, duplicateCount });
  }
  const top = asRecord(record.top_provider);
  return {
    id: modelId || id,
    name: typeof record.name === "string" ? record.name : id,
    contextLength: numberValue(record.context_length),
    topProvider: typeof top?.name === "string" ? top.name : null,
    providers,
    fetchedAt: new Date().toISOString(),
  };
}

function responseModels(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  const record = asRecord(data);
  return record && Array.isArray(record.data) ? record.data : [];
}

/**
 * Каталог одной модели. `null` — каталог недоступен и сохранённой копии нет; вызывающий код
 * решает, можно ли работать без проверки доступности.
 */
export async function getUpstreamModelCatalog(
  baseUrl: string,
  token: string | undefined,
  model: string,
  options: UpstreamCatalogOptions = {},
): Promise<UpstreamCatalogModel | null> {
  const key = cacheKey(baseUrl, model);
  const now = options.now ?? Date.now;
  const current = cache.get(key);
  const currentAge = current ? now() - current.fetchedAt : Infinity;

  if (!options.refresh && current && currentAge < CACHE_TTL_MS) {
    return { ...current.model, stale: false };
  }
  const backoff = failureUntil.get(key) ?? 0;
  if (!options.refresh && backoff > now()) {
    return current && currentAge < STALE_TTL_MS ? { ...current.model, stale: true } : null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  try {
    const request = catalogRequest(baseUrl, token);
    const response = await fetchImpl(request.url, {
      method: "GET",
      headers: request.headers,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("каталог ответил HTTP " + response.status);
    const payload: unknown = await response.json();
    const found = responseModels(payload).find(item => {
      const record = asRecord(item);
      return record && typeof record.id === "string" && record.id === model;
    });
    if (!found) throw new Error("модель " + model + " не найдена в каталоге");
    const parsed = parseUpstreamModel(found, model);
    if (!parsed) throw new Error("каталог вернул модель без id");
    const entry: CacheEntry = { model: parsed, fetchedAt: now() };
    cache.set(key, entry);
    failureUntil.delete(key);
    return { ...parsed, stale: false };
  } catch (error) {
    failureUntil.set(key, now() + FAILURE_BACKOFF_MS);
    const reason = error instanceof Error ? (error.name === "AbortError" ? "таймаут" : error.message) : String(error);
    console.warn("[provider] каталог провайдеров недоступен: " + reason);
    return current && currentAge < STALE_TTL_MS ? { ...current.model, stale: true } : null;
  } finally {
    clearTimeout(timer);
  }
}

/** Оценка стоимости под профиль нагрузки: входные токены дороже/дешевле выходных по-разному. */
export function estimatedUpstreamCost(provider: UpstreamCatalogProvider, assumedInputPerOutput: number): number | null {
  if (provider.promptPerMillion === null || provider.completionPerMillion === null) return null;
  return provider.promptPerMillion * assumedInputPerOutput + provider.completionPerMillion;
}

function withinMaxPrice(provider: UpstreamCatalogProvider, maxPrice: UpstreamMaxPrice | undefined): boolean {
  if (!maxPrice) return true;
  if (maxPrice.prompt !== undefined && (provider.promptPerMillion === null || provider.promptPerMillion > maxPrice.prompt)) return false;
  if (maxPrice.completion !== undefined && (provider.completionPerMillion === null || provider.completionPerMillion > maxPrice.completion)) return false;
  return true;
}

/**
 * Короткоживущие классы мощности (`spot`, `flex`, `batch`) дешевле, но их доступность и задержка
 * не гарантированы. В автоматическом режиме их не берём; в `fixed` админ может выбрать вручную.
 */
function isOpportunistic(name: string) {
  return /(?:^|\/)(?:spot|flex|batch)(?:\/|$)/i.test(name);
}

/**
 * Порядок для `cheapest`: только провайдеры с инструментами и разобранной ценой, без дублей и
 * временных классов, в пределах `maxPrice`. Сортировка — по оценке стоимости, затем по цене
 * входа и имени, чтобы результат был стабильным между запросами.
 */
export function rankUpstreamProviders(
  providers: UpstreamCatalogProvider[],
  routing: Pick<UpstreamRouting, "assumedInputPerOutput" | "maxPrice">,
): UpstreamCatalogProvider[] {
  return providers
    .filter(provider => upstreamProviderEligible(provider, routing))
    .sort((left, right) => {
      const leftCost = estimatedUpstreamCost(left, routing.assumedInputPerOutput) ?? Infinity;
      const rightCost = estimatedUpstreamCost(right, routing.assumedInputPerOutput) ?? Infinity;
      if (leftCost !== rightCost) return leftCost - rightCost;
      const leftPrompt = left.promptPerMillion ?? Infinity;
      const rightPrompt = right.promptPerMillion ?? Infinity;
      if (leftPrompt !== rightPrompt) return leftPrompt - rightPrompt;
      return left.name.localeCompare(right.name);
    });
}

/**
 * Годится ли провайдер для автоматического порядка: умеет инструменты, цена разобрана, имя
 * не дублируется и это не временный класс мощности. Используется и админкой, чтобы показать
 * причину, по которой провайдер не попал в рекомендацию.
 */
export function upstreamProviderEligible(
  provider: UpstreamCatalogProvider,
  routing: Pick<UpstreamRouting, "maxPrice">,
): boolean {
  return provider.tools
    && !provider.ambiguous
    && !isOpportunistic(provider.name)
    && provider.promptPerMillion !== null
    && provider.completionPerMillion !== null
    && withinMaxPrice(provider, routing.maxPrice);
}

/** Провайдер проходит жёсткий ценовой потолок — используется и для `fixed`. */
export function isWithinUpstreamPrice(provider: UpstreamCatalogProvider, maxPrice: UpstreamMaxPrice | undefined): boolean {
  return withinMaxPrice(provider, maxPrice);
}
