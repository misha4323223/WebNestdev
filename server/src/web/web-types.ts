/**
 * Web-поиск платформы: типы и ошибки, общие для провайдеров.
 *
 * Поиск выполняет сервер, а не песочница проекта: ключи провайдеров живут в окружении
 * платформы, расход считается по тарифу аккаунта, а песочница остаётся без сети.
 */

/**
 * Кто отдал результаты: `duckduckgo` — бесплатный тариф, `yandex` — основной провайдер подписки,
 * `tavily` — её резерв на случай, когда Yandex Search API ещё не настроен или ответил отказом.
 */
export type WebSearchProvider = "duckduckgo" | "yandex" | "tavily";

export type WebResult = {
  title: string;
  url: string;
  snippet: string;
  provider: WebSearchProvider;
};

/**
 * Причина отказа, которую модель и человек читают по-разному:
 *
 * - `blocked` — провайдер ответил проверкой на робота. Это не «ничего не найдено»:
 *   пустой список результатов здесь был бы ложью, из-за которой агент решил бы,
 *   что материала в интернете нет;
 * - `not_configured` — у платформы нет ключа провайдера (для Yandex Search API);
 * - `quota` — дневной лимит поисков аккаунта исчерпан;
 * - `unavailable` — сеть, таймаут, 5xx или неожидаемый ответ.
 */
export type WebSearchErrorCode = "blocked" | "not_configured" | "quota" | "unavailable";

export class WebSearchError extends Error {
  constructor(
    readonly code: WebSearchErrorCode,
    message: string,
    readonly provider: WebSearchProvider,
  ) {
    super(message);
    this.name = "WebSearchError";
  }
}

export type WebSearchResponse = {
  ok: boolean;
  provider: WebSearchProvider;
  query: string;
  results: WebResult[];
  /** Ответ взят из короткого кэша сервера: запрос к провайдеру не выполнялся. */
  cached?: boolean;
  /** Что стоит знать помимо результатов (резервный провайдер, отказ основного). */
  note?: string;
  code?: WebSearchErrorCode;
  error?: string;
};
