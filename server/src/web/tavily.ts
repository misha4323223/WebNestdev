import { getPlatformEnv } from "../platform/platform-env.js";
import { WebSearchError, type WebResult } from "./web-types.js";

/**
 * Tavily — резервный провайдер платных тарифов (`pro`, `team`).
 *
 * Основной провайдер подписки — Yandex Search API: своя выдача на русском и предсказуемая цена.
 * Tavily стоит за ним на случай, когда ключ Yandex ещё не заведён, роль не выдана или API ответил
 * отказом: подписка не должна оставаться без поиска из-за одной неготовой интеграции.
 *
 * Бесплатная квота Tavily — 1 000 кредитов в месяц, обычный поиск стоит 1 кредит. Ключ живёт в
 * окружении платформы (`TAVILY_API_KEY`) или в панели ключей; значение в панели важнее окружения.
 */

const ENDPOINT = "https://api.tavily.com/search";
const TIMEOUT_MS = 15_000;
const MAX_RESULTS = 20;
const DEFAULT_LIMIT = 8;

export const TAVILY_KEY_ENV = "TAVILY_API_KEY";

export function tavilyKey(): string | null {
  const key = (getPlatformEnv(TAVILY_KEY_ENV) ?? "").trim();
  return key ? key : null;
}

export type TavilyOptions = {
  limit?: number;
  signal?: AbortSignal;
  key?: string;
};

function clampLimit(limit: number | undefined) {
  const value = Math.floor(limit ?? DEFAULT_LIMIT);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_RESULTS, value);
}

/**
 * Тело запроса. `basic` — один кредит вместо двух у `advanced`, а агенту нужны ссылки и сниппеты,
 * а не готовый ответ: он читает страницу сам через `web.read` и проверяет факты по источнику.
 */
export function buildTavilyBody(query: string, limit: number | undefined) {
  return {
    query,
    search_depth: "basic" as const,
    topic: "general" as const,
    max_results: clampLimit(limit),
    include_answer: false,
    include_raw_content: false,
  };
}

/** Ответ Tavily: `results[]` с `title`, `url`, `content`. Поля могут отсутствовать — тогда пустая строка. */
export function parseTavilyResponse(payload: unknown): Array<{ title: string; url: string; snippet: string }> {
  if (!payload || typeof payload !== "object") return [];
  const results = (payload as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  const parsed: Array<{ title: string; url: string; snippet: string }> = [];
  for (const item of results) {
    if (!item || typeof item !== "object") continue;
    const record = item as { title?: unknown; url?: unknown; content?: unknown };
    const url = typeof record.url === "string" ? record.url : "";
    if (!/^https?:\/\//i.test(url)) continue;
    const title = typeof record.title === "string" && record.title.trim() ? record.title.trim() : url;
    // `content` — уже извлечённый текст страницы, и в нём бывают меню и хлебные крошки. Модель
    // читает сниппет как краткое описание, поэтому пробелы схлопываются, а хвост обрезается.
    const snippet = typeof record.content === "string" ? record.content.replace(/\s+/g, " ").trim().slice(0, 400) : "";
    parsed.push({ title, url, snippet });
  }
  return parsed;
}

export async function searchTavily(query: string, options: TavilyOptions = {}): Promise<WebResult[]> {
  const trimmed = query.trim();
  if (!trimmed) throw new WebSearchError("unavailable", "Пустой поисковый запрос", "tavily");
  const key = options.key ?? tavilyKey();
  if (!key) {
    throw new WebSearchError(
      "not_configured",
      "Tavily не настроен: добавьте ключ в " + TAVILY_KEY_ENV + " (панель ключей платформы или окружение).",
      "tavily",
    );
  }

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + key,
      },
      body: JSON.stringify(buildTavilyBody(trimmed, options.limit)),
      signal: options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal,
    });
    const body = await response.text();
    if (response.status === 401 || response.status === 403) {
      throw new WebSearchError(
        "not_configured",
        "Tavily отклонил ключ (" + response.status + "): " + body.slice(0, 300),
        "tavily",
      );
    }
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      throw new WebSearchError(
        "unavailable",
        "Tavily ответил 429: лимит частоты" + (retryAfter ? ", повторить через " + retryAfter + " с" : "") + ".",
        "tavily",
      );
    }
    if (!response.ok) {
      throw new WebSearchError("unavailable", "Tavily ответил " + response.status + ": " + body.slice(0, 300), "tavily");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new WebSearchError("unavailable", "Tavily вернул не JSON: " + body.slice(0, 300), "tavily");
    }
    return parseTavilyResponse(payload)
      .slice(0, clampLimit(options.limit))
      .map(result => ({ ...result, provider: "tavily" as const }));
  } catch (error) {
    if (error instanceof WebSearchError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new WebSearchError("unavailable", "Не удалось получить ответ Tavily: " + message, "tavily");
  } finally {
    clearTimeout(timer);
  }
}
