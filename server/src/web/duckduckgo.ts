import { resolveDuckDuckGoHref, textOf } from "./html.js";
import { WebSearchError, type WebResult } from "./web-types.js";

/**
 * Бесплатный поиск через DuckDuckGo.
 *
 * У DuckDuckGo нет публичного API веб-поиска: `api.duckduckgo.com` отдаёт мгновенные ответы, а не
 * список ссылок. Поэтому берётся облегчённая страница `lite.duckduckgo.com/lite/` — тот же поиск без
 * JavaScript. Три следствия, которые важны для эксплуатации:
 *
 * 1. Это не контракт. Разметка страницы не обещана никому, поэтому парсер ниже опирается на классы
 *    `result-link` / `result__a` и `result-snippet` / `result__snippet` двух исторических версий и
 *    возвращает пустой список, а не падает, если разметка изменится целиком.
 * 2. `robots.txt` DuckDuckGo закрывает `/lite` и `/html` для всех агентов. Это не разрешение, а
 *    предупреждение: такие запросы допустимы как редкий резерв и недопустимы как основа платного
 *    продукта. Провайдер по умолчанию для платных тарифов — Yandex Search API (`yandex-search.ts`).
 * 3. Сервер с «датацентровым» адресом получает проверку на робота (`202` + `anomaly-modal`) уже
 *    после первого-второго запроса. Такой ответ — не «ничего не найдено», а отказ: он превращается
 *    в `WebSearchError("blocked")`, чтобы агент не решил, что материала в интернете нет.
 */

const SEARCH_ENDPOINT = "https://lite.duckduckgo.com/lite/";
const TIMEOUT_MS = 12_000;
const MAX_RESULTS = 20;
const DEFAULT_LIMIT = 8;
/** Проверка на робота, которую DuckDuckGo отдаёт вместо выдачи. */
const CHALLENGE_PATTERN = /(anomaly-modal|challenge-form|id=["']challenge["'])/i;
/** Браузерный User-Agent: без него страница отвечает проверкой заметно чаще. */
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export type DuckDuckGoOptions = {
  limit?: number;
  /** Регион выдачи (`kl`), например `ru-ru` или `us-en`. */
  region?: string;
  signal?: AbortSignal;
};

function clampLimit(limit: number | undefined) {
  const value = Math.floor(limit ?? DEFAULT_LIMIT);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_RESULTS, value);
}

type RawResult = { title: string; url: string; snippet: string };

/**
 * Разбор страницы `lite`. Ссылки и сниппеты лежат в отдельных строках таблицы, поэтому они
 * собираются двумя проходами и склеиваются по порядку — так парсер не зависит от того, как именно
 * вложены ячейки.
 *
 * Экспортируется для теста: разметку провайдера нельзя проверять только живой сетью.
 */
export function parseDuckDuckGoHtml(html: string): RawResult[] {
  const anchors: Array<{ href: string; title: string }> = [];
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorPattern)) {
    const attributes = match[1] ?? "";
    const className = /class\s*=\s*["']([^"']*)["']/i.exec(attributes)?.[1] ?? "";
    if (!/\b(result-link|result__a)\b/.test(className)) continue;
    const href = /href\s*=\s*["']([^"']*)["']/i.exec(attributes)?.[1] ?? "";
    const url = resolveDuckDuckGoHref(href);
    const title = textOf(match[2] ?? "");
    if (url && title) anchors.push({ href: url, title });
  }

  const snippets: string[] = [];
  // Класс проверяется в самом шаблоне, а не после него: иначе жадный до `</div>` проход начинался
  // бы с внешнего контейнера `.result` и съедал бы сниппет вместе с ним.
  const snippetPattern = /<(td|div|a|span)\b([^>]*class\s*=\s*["'][^"']*\b(?:result-snippet|result__snippet)\b[^"']*["'][^>]*)>([\s\S]*?)<\/\1>/gi;
  for (const match of html.matchAll(snippetPattern)) {
    snippets.push(textOf(match[3] ?? ""));
  }

  const seen = new Set<string>();
  const results: RawResult[] = [];
  anchors.forEach((anchor, index) => {
    if (seen.has(anchor.href)) return;
    seen.add(anchor.href);
    results.push({ title: anchor.title, url: anchor.href, snippet: snippets[index] ?? "" });
  });
  return results;
}

/** Признак того, что вместо выдачи пришла проверка на робота или форма капчи. */
export function isDuckDuckGoChallenge(html: string, status = 200): boolean {
  if (status === 202) return true;
  return CHALLENGE_PATTERN.test(html);
}

export async function searchDuckDuckGo(query: string, options: DuckDuckGoOptions = {}): Promise<WebResult[]> {
  const trimmed = query.trim();
  if (!trimmed) throw new WebSearchError("unavailable", "Пустой поисковый запрос", "duckduckgo");
  const limit = clampLimit(options.limit);
  const url = new URL(SEARCH_ENDPOINT);
  url.searchParams.set("q", trimmed);
  const region = options.region ?? process.env.WEB_SEARCH_REGION ?? "ru-ru";
  if (region) url.searchParams.set("kl", region);

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml",
        "accept-language": "ru-RU,ru;q=0.9,en;q=0.8",
      },
      redirect: "follow",
      signal: options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal,
    });
    const html = (await response.text()).slice(0, 400_000);
    if (isDuckDuckGoChallenge(html, response.status)) {
      throw new WebSearchError(
        "blocked",
        "DuckDuckGo ответил проверкой на робота вместо выдачи (бесплатный провайдер ограничивает автоматические запросы с серверных адресов). Повторите запрос позже, сформулируйте его иначе или читайте известные страницы через web.read.",
        "duckduckgo",
      );
    }
    if (!response.ok) {
      throw new WebSearchError(
        "unavailable",
        "DuckDuckGo ответил " + response.status + " вместо выдачи",
        "duckduckgo",
      );
    }
    return parseDuckDuckGoHtml(html)
      .slice(0, limit)
      .map(result => ({ ...result, provider: "duckduckgo" as const }));
  } catch (error) {
    if (error instanceof WebSearchError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new WebSearchError(
      "unavailable",
      "Не удалось получить ответ DuckDuckGo: " + message,
      "duckduckgo",
    );
  } finally {
    clearTimeout(timer);
  }
}
