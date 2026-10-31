import { createHash } from "node:crypto";

/**
 * Кэширование контекста у провайдера — не наш ответный кэш и не экономия на истории:
 * провайдер сохраняет уже обработанный префикс промпта и при следующем шаге читает его
 * дешевле. У семейств моделей это устроено по-разному, поэтому решение о разметке живёт
 * в одном месте, а не в агенте и не в каждом маршруте.
 *
 * - DeepSeek кэширует префикс автоматически; разметка в запросе не нужна. Polza умеет
 *   дополнительно закреплять серию запросов за одним провайдером через `prompt_cache_key`,
 *   иначе балансировщик может отправить соседний шаг туда, где этого кэша нет.
 * - Claude требует явные точки через `cache_control`. Их ставит Polza/OpenRouter в
 *   OpenAI-совместимом формате; точка на системном блоке покрывает и схемы инструментов,
 *   которые идут раньше.
 * - OpenAI, Gemini и Grok кэшируют автоматически; для них достаточно стабильного префикса,
 *   а на Polza — того же ключа серии.
 *
 * Неизвестная модель не получает разметки контента: формат `cache_control` может быть
 * незнаком конкретному семейству. Поле серии на Polza, наоборот, документировано для всего
 * Chat Completions, поэтому его можно отправлять и незнакомой модели — вреда от него нет.
 */

export type PromptCacheMode = "automatic" | "explicit" | "none";
export type PromptCacheFamily = "deepseek" | "anthropic" | "openai" | "google" | "xai" | "unknown";

export type PromptCachePolicy = {
  mode: PromptCacheMode;
  family: PromptCacheFamily;
  /** Шлюз принимает `prompt_cache_key`: одна серия шагов идёт к одному провайдеру. */
  routeByKey: boolean;
};

export type PromptCacheScope = {
  projectId: string;
  conversationId?: string;
  runId: string;
};

type CacheControl = { type: "ephemeral" };
type CacheTextPart = { type: "text"; text: string; cache_control?: CacheControl };
export type CacheableMessage = { role: string; content: unknown };

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Polza — единственный известный шлюз с явным полем серии для кэша. */
export function isPolzaGateway(baseUrl: string): boolean {
  const host = hostOf(baseUrl);
  return host === "polza.ai" || host.endsWith(".polza.ai");
}

/**
 * Политика выбирается по модели и адресу, а не по названию проекта: один и тот же
 * OpenAI-совместимый шлюз обслуживает разные семейства.
 */
export function promptCachePolicy(baseUrl: string, model: string): PromptCachePolicy {
  const normalized = model.trim().toLowerCase();
  const polza = isPolzaGateway(baseUrl);

  if (normalized.includes("deepseek")) {
    return { mode: "automatic", family: "deepseek", routeByKey: polza };
  }
  if (normalized.includes("claude") || normalized.includes("anthropic/")) {
    // Явные точки понимают Polza и OpenRouter. Для произвольного прокси оставляем
    // автоматический режим без разметки: содержимое-массив там может быть отклонено.
    const host = hostOf(baseUrl);
    const openRouter = host === "openrouter.ai" || host.endsWith(".openrouter.ai");
    return { mode: polza || openRouter ? "explicit" : "automatic", family: "anthropic", routeByKey: polza };
  }
  if (normalized.includes("gemini") || normalized.startsWith("google/")) {
    return { mode: "automatic", family: "google", routeByKey: polza };
  }
  if (normalized.includes("grok") || normalized.startsWith("x-ai/")) {
    return { mode: "automatic", family: "xai", routeByKey: polza };
  }
  if (
    normalized.startsWith("openai/") ||
    normalized.startsWith("gpt-") ||
    normalized.startsWith("o1") ||
    normalized.startsWith("o3") ||
    normalized.startsWith("o4")
  ) {
    return { mode: "automatic", family: "openai", routeByKey: polza };
  }
  return { mode: "none", family: "unknown", routeByKey: polza };
}

/**
 * Стабильный ключ серии. Он не содержит ни проекта, ни разговора в открытом виде: шлюзу
 * достаточно одинаковой строки, а хэш не даёт использовать журнал кэша как справочник
 * идентификаторов. Модель входит в ключ: разные модели одного чата — разные серии.
 */
export function promptCacheKey(scope: PromptCacheScope, model: string): string {
  const conversation = scope.conversationId?.trim() || "run:" + scope.runId;
  const seed = [scope.projectId, conversation, model.trim()].join("\u0000");
  return "nestdev-" + createHash("sha256").update(seed).digest("hex").slice(0, 40);
}

/**
 * Поля запроса, которые включают маршрутизацию по кэшу. Только для шлюзов, где поле
 * документировано: прямые API DeepSeek/Anthropic такого поля не знают.
 */
export function promptCacheRequestFields(
  policy: PromptCachePolicy,
  key: string | undefined,
): { prompt_cache_key?: string } {
  if (!policy.routeByKey || !key) return {};
  return { prompt_cache_key: key };
}

/** Системные сообщения, которые образуют стабильный префикс до истории. */
function leadingSystemIndexes(messages: CacheableMessage[]): number[] {
  let end = 0;
  while (end < messages.length && messages[end].role === "system") end++;
  if (end === 0) return [];
  // Первая точка покрывает схемы инструментов и системный промпт, последняя — ещё и
  // проектный контекст. Две точки (а не по одной на каждое сообщение) укладываются в
  // лимит Anthropic и переживают добавление служебных заметок.
  return [...new Set([0, end - 1])];
}

function contentParts(content: unknown): unknown {
  if (typeof content === "string") {
    return [{ type: "text", text: content, cache_control: { type: "ephemeral" } } satisfies CacheTextPart];
  }
  if (!Array.isArray(content)) return content;
  const parts = content as Array<Record<string, unknown>>;
  let marked = false;
  return parts.map((part, index) => {
    if (marked || part?.type !== "text") return part;
    // Один маркер на сообщение: несколько текстовых блоков не должны съедать лимит
    // точек кэширования. Ставим его на последний текстовый блок.
    if (!parts.slice(index + 1).some(next => next?.type === "text")) {
      marked = true;
      return { ...part, cache_control: { type: "ephemeral" } satisfies CacheControl };
    }
    return part;
  });
}

/**
 * Явные точки кэша для Claude. Меняются только системные сообщения; история и результаты
 * инструментов остаются байт-в-байт прежними, иначе кэш-префикс не совпал бы.
 */
export function withPromptCacheControl<T extends CacheableMessage>(messages: T[]): T[] {
  const indexes = new Set(leadingSystemIndexes(messages));
  return messages.map((message, index) => {
    if (!indexes.has(index)) return message;
    return { ...message, content: contentParts(message.content) };
  }) as T[];
}

export type CacheUsage = {
  cachedPromptTokens: number;
  cacheWritePromptTokens: number;
};

function nonNegativeInteger(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

/**
 * Один формат usage на все семейства. Polza отдаёт
 * `prompt_tokens_details.cached_tokens`; официальный DeepSeek — `prompt_cache_hit_tokens`;
 * Anthropic-совместимые шлюзы — `cache_read_input_tokens`. Поля могут прийти не все, и
 * ноль здесь означает «кэш не сработал», а не «провайдер не умеет кэш».
 */
export function cacheUsageFromUsage(usage: unknown): CacheUsage {
  if (!usage || typeof usage !== "object") {
    return { cachedPromptTokens: 0, cacheWritePromptTokens: 0 };
  }
  const value = usage as Record<string, unknown>;
  const details = (
    value.prompt_tokens_details && typeof value.prompt_tokens_details === "object"
      ? value.prompt_tokens_details
      : value.input_tokens_details && typeof value.input_tokens_details === "object"
        ? value.input_tokens_details
        : {}
  ) as Record<string, unknown>;
  const rawCached = nonNegativeInteger(
    details.cached_tokens ?? value.prompt_cache_hit_tokens ?? value.cache_read_input_tokens,
  );
  const cacheWritePromptTokens = nonNegativeInteger(
    details.cache_write_tokens ?? value.cache_write_tokens ?? value.cache_creation_input_tokens,
  );
  // Нативный Anthropic считает `input_tokens` **без** кэша, а полный вход — суммой трёх
  // полей. В OpenAI-совместимом пути `prompt_tokens` уже полный, поэтому ветки различаются
  // по наличию `prompt_tokens`, а не по названию шлюза.
  const nativeAnthropic = value.prompt_tokens == null && value.input_tokens != null;
  const promptTokens = nativeAnthropic
    ? nonNegativeInteger(value.input_tokens) + rawCached + cacheWritePromptTokens
    : nonNegativeInteger(value.prompt_tokens ?? value.input_tokens ?? value.total_tokens);
  const cachedPromptTokens = promptTokens > 0 ? Math.min(promptTokens, rawCached) : rawCached;
  return { cachedPromptTokens, cacheWritePromptTokens };
}

/** Доля входа, прочитанная из кэша; используется в логе и в биллинге. */
export function cacheHitRate(promptTokens: number, cachedPromptTokens: number): number {
  if (!Number.isFinite(promptTokens) || promptTokens <= 0) return 0;
  return Math.min(1, Math.max(0, cachedPromptTokens / promptTokens));
}
