import { getPlatformEnv } from "../platform/platform-env.js";
import { textOf } from "./html.js";
import { WebSearchError, type WebResult } from "./web-types.js";

/**
 * Yandex Search API v2 — провайдер платных тарифов.
 *
 * Платформа платит за запрос, поэтому у него есть ключ и каталог, а не только адрес:
 * `YANDEX_SEARCH_API_KEY` — API-ключ сервисного аккаунта со scope `yc.search-api.execute`,
 * `YANDEX_SEARCH_FOLDER_ID` — каталог, в котором этому аккаунту выдана роль `search-api.webSearch.user`
 * (если отдельной переменной нет, берётся общий `YANDEX_FOLDER_ID`).
 *
 * Ответ — `{ "rawData": "<base64>" }`: внутри base64 лежит XML выдачи. Поэтому разбор идёт в два
 * шага (декодирование и вытаскивание `<doc>`), и оба шага проверяются тестом на настоящей форме
 * ответа, а не на догадке.
 */

const ENDPOINT = "https://searchapi.api.cloud.yandex.net/v2/web/search";
const TIMEOUT_MS = 15_000;
const MAX_RESULTS = 30;
const DEFAULT_LIMIT = 8;
/** Каталог и ключ читаются через панель платформы: значение из панели важнее переменной окружения. */
export const YANDEX_SEARCH_KEY_ENV = "YANDEX_SEARCH_API_KEY";
export const YANDEX_SEARCH_FOLDER_ENV = "YANDEX_SEARCH_FOLDER_ID";

export type YandexSearchConfig = { apiKey: string; folderId: string };

/** Настроен ли платный провайдер: без обоих значений запрос гарантированно вернёт 401/403. */
export function yandexSearchConfig(): YandexSearchConfig | null {
  const apiKey = (getPlatformEnv(YANDEX_SEARCH_KEY_ENV) ?? "").trim();
  const folderId = ((getPlatformEnv(YANDEX_SEARCH_FOLDER_ENV) ?? getPlatformEnv("YANDEX_FOLDER_ID")) ?? "").trim();
  if (!apiKey || !folderId) return null;
  return { apiKey, folderId };
}

export type YandexSearchOptions = {
  limit?: number;
  signal?: AbortSignal;
  config?: YandexSearchConfig;
  /** `SEARCH_TYPE_RU` (по умолчанию), `SEARCH_TYPE_TR`, `SEARCH_TYPE_COM`. */
  searchType?: string;
};

function clampLimit(limit: number | undefined) {
  const value = Math.floor(limit ?? DEFAULT_LIMIT);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_RESULTS, value);
}

function searchTypeFromEnv() {
  const configured = (process.env.YANDEX_SEARCH_TYPE ?? "").trim().toUpperCase();
  return ["SEARCH_TYPE_RU", "SEARCH_TYPE_TR", "SEARCH_TYPE_COM"].includes(configured)
    ? configured
    : "SEARCH_TYPE_RU";
}

/**
 * Тело запроса. Числовые поля Search API принимает строками (protobuf-JSON), поэтому `page`,
 * `maxPassages` и `groupsOnPage` отправляются строками — так же, как в документации.
 */
export function buildYandexSearchBody(query: string, folderId: string, options: { limit?: number; searchType?: string } = {}) {
  return {
    query: {
      searchType: options.searchType ?? searchTypeFromEnv(),
      queryText: query,
      familyMode: "FAMILY_MODE_MODERATE",
      page: "0",
      maxPassages: "3",
      groupSpec: {
        groupMode: "GROUP_MODE_DEEP",
        groupsOnPage: String(clampLimit(options.limit)),
        docsInGroup: "1",
      },
    },
    folderId,
  };
}

/** `<![CDATA[ … ]]>` и обычный текст одинаково превращаются в чистый текст. */
function xmlText(fragment: string | undefined): string {
  if (!fragment) return "";
  const withoutCdata = fragment.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  return textOf(withoutCdata);
}

/**
 * Разбор XML выдачи Yandex. Один `<group>` — один результат верхнего уровня, внутри него первый
 * `<doc>`; ссылка, заголовок и первый пассаж становятся полями результата.
 *
 * Экспортируется для теста: форма XML — единственное, что связывает нас с провайдером.
 */
export function parseYandexXml(xml: string): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const groupPattern = /<group\b[^>]*>([\s\S]*?)<\/group>/gi;
  const groups = xml.match(groupPattern) ?? [];
  const documents = groups.length ? groups : (xml.match(/<doc\b[^>]*>[\s\S]*?<\/doc>/gi) ?? []);
  for (const block of documents) {
    const url = xmlText(/<url\b[^>]*>([\s\S]*?)<\/url>/i.exec(block)?.[1]);
    if (!url) continue;
    const title = xmlText(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(block)?.[1]);
    const snippet = xmlText(/<passage\b[^>]*>([\s\S]*?)<\/passage>/i.exec(block)?.[1]);
    results.push({ title: title || url, url, snippet });
  }
  return results;
}

/**
 * Ответ Search API — `<base64>` внутри `rawData`. Декодирование терпит и голый XML (если формат
 * когда-нибудь вернут как есть), и `documents`-массив из отчётов других клиентов, чтобы отказ был
 * понятным, а не «Unexpected token».
 */
export function parseYandexResponse(payload: unknown): Array<{ title: string; url: string; snippet: string }> {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as { rawData?: unknown; documents?: unknown };
  if (typeof record.rawData === "string" && record.rawData.trim()) {
    const raw = record.rawData.trim();
    const xml = raw.startsWith("<") ? raw : Buffer.from(raw, "base64").toString("utf8");
    return parseYandexXml(xml);
  }
  if (Array.isArray(record.documents)) {
    return record.documents.flatMap(document => {
      if (typeof document !== "string") return [];
      const xml = document.trim().startsWith("<") ? document : Buffer.from(document, "base64").toString("utf8");
      return parseYandexXml(xml);
    });
  }
  return [];
}

export async function searchYandex(query: string, options: YandexSearchOptions = {}): Promise<WebResult[]> {
  const trimmed = query.trim();
  if (!trimmed) throw new WebSearchError("unavailable", "Пустой поисковый запрос", "yandex");
  const config = options.config ?? yandexSearchConfig();
  if (!config) {
    throw new WebSearchError(
      "not_configured",
      "Yandex Search API не настроен: добавьте API-ключ сервисного аккаунта в " + YANDEX_SEARCH_KEY_ENV +
        " и каталог в " + YANDEX_SEARCH_FOLDER_ENV + " (или YANDEX_FOLDER_ID) в панели платформенных ключей.",
      "yandex",
    );
  }

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Api-Key " + config.apiKey,
      },
      body: JSON.stringify(buildYandexSearchBody(trimmed, config.folderId, options)),
      signal: options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal,
    });
    const body = await response.text();
    if (!response.ok) {
      throw new WebSearchError(
        "unavailable",
        "Yandex Search API ответил " + response.status + ": " + body.slice(0, 300),
        "yandex",
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new WebSearchError("unavailable", "Yandex Search API вернул не JSON: " + body.slice(0, 300), "yandex");
    }
    return parseYandexResponse(payload)
      .slice(0, clampLimit(options.limit))
      .map(result => ({ ...result, provider: "yandex" as const }));
  } catch (error) {
    if (error instanceof WebSearchError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new WebSearchError("unavailable", "Не удалось получить ответ Yandex Search API: " + message, "yandex");
  } finally {
    clearTimeout(timer);
  }
}
