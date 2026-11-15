import { getPlatformEnv, platformEnvSource, type PlatformEnvSource } from "../platform/platform-env.js";
import { providerChain } from "./search.js";
import type { WebSearchProvider } from "./web-types.js";
import { YANDEX_SEARCH_FOLDER_ENV, YANDEX_SEARCH_KEY_ENV, yandexSearchConfig } from "./yandex-search.js";
import { TAVILY_KEY_ENV, tavilyKey } from "./tavily.js";

/**
 * Состояние настройки поиска для внешней админки. Здесь нет самих ключей: интерфейсу нужно
 * показать, какие провайдеры готовы, откуда взято значение и какую цепочку получит каждый тариф.
 *
 * `provider` — сохранённое переопределение (`auto`, когда не задано или задано неверно).
 * `chains.paid` уже учитывает `WEB_SEARCH_PROVIDER` и наличие ключей; `chains.free` всегда
 * DuckDuckGo, потому что бесплатный тариф не может уйти в платную выдачу.
 */
export type WebSearchStatus = {
  provider: "auto" | WebSearchProvider;
  providerSource: PlatformEnvSource;
  yandex: {
    configured: boolean;
    hasKey: boolean;
    keySource: PlatformEnvSource;
    folderId: string | null;
    folderSource: PlatformEnvSource;
    folderVariable: "YANDEX_SEARCH_FOLDER_ID" | "YANDEX_FOLDER_ID" | null;
  };
  tavily: {
    configured: boolean;
    hasKey: boolean;
    keySource: PlatformEnvSource;
  };
  duckduckgo: {
    configured: true;
    requiresKey: false;
  };
  chains: {
    free: WebSearchProvider[];
    paid: WebSearchProvider[];
  };
  note: string | null;
};

export function webSearchStatus(): WebSearchStatus {
  const rawProvider = (getPlatformEnv("WEB_SEARCH_PROVIDER") ?? "").trim().toLowerCase();
  const provider: "auto" | WebSearchProvider =
    rawProvider === "duckduckgo" || rawProvider === "yandex" || rawProvider === "tavily"
      ? rawProvider
      : "auto";

  const searchFolder = (getPlatformEnv(YANDEX_SEARCH_FOLDER_ENV) ?? "").trim();
  const legacyFolder = (getPlatformEnv("YANDEX_FOLDER_ID") ?? "").trim();
  const folderId = searchFolder || legacyFolder || null;
  const folderVariable = searchFolder
    ? YANDEX_SEARCH_FOLDER_ENV
    : legacyFolder ? "YANDEX_FOLDER_ID" : null;
  const folderSource = folderVariable ? platformEnvSource(folderVariable) : "none";

  const yandexConfigured = Boolean(yandexSearchConfig());
  const tavilyConfigured = Boolean(tavilyKey());
  const paid = providerChain("pro");

  return {
    provider,
    providerSource: platformEnvSource("WEB_SEARCH_PROVIDER"),
    yandex: {
      configured: yandexConfigured,
      hasKey: Boolean((getPlatformEnv(YANDEX_SEARCH_KEY_ENV) ?? "").trim()),
      keySource: platformEnvSource(YANDEX_SEARCH_KEY_ENV),
      folderId,
      folderSource,
      folderVariable,
    },
    tavily: {
      configured: tavilyConfigured,
      hasKey: Boolean((getPlatformEnv(TAVILY_KEY_ENV) ?? "").trim()),
      keySource: platformEnvSource(TAVILY_KEY_ENV),
    },
    duckduckgo: { configured: true, requiresKey: false },
    chains: {
      free: ["duckduckgo"],
      paid: paid.chain,
    },
    note: paid.note ?? null,
  };
}
