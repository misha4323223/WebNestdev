/**
 * Автоматические закупочные цены Polza.ai для админской экономики.
 *
 * Каталог Polza открытый: `GET /v1/models?type=chat&include_providers=true` отдаёт цены
 * каждого upstream-провайдера в рублях за 1M токенов. Ручная таблица
 * `PLATFORM_AI_MODEL_PRICES` остаётся главнее — она нужна, когда провайдер ошибся в цене или
 * платформа договорилась об индивидуальной ставке.
 *
 * Какую цену брать, решает та же маршрутизация, что и у самих запусков:
 *
 * - `fixed` — первый провайдер из списка, у которого есть цена;
 * - `cheapest` — первый в ценовом порядке `rankUpstreamProviders`;
 * - `auto` — `top_provider` каталога, а если у него цены нет, самый дешёвый подходящий.
 *
 * Это оценка по каталогу, а не счёт: у части провайдеров есть почасовые наценки, а `auto`
 * оставляет финальный выбор шлюзу. Поэтому в ответе есть `provider` и `routing`, чтобы
 * расхождение со счётом можно было объяснить, а не искать вслепую.
 */
import { listPlatformModels, platformModelProviderConfig } from "../platform/platform-models.js";
import { getPlatformProviderConfig, type PlatformProviderConfig } from "../provider/platform-provider.js";
import { isPolzaGateway } from "../provider/prompt-caching.js";
import {
  getUpstreamCatalogIndex,
  rankUpstreamProviders,
  resolveUpstreamProviderName,
  type UpstreamCatalogModel,
  type UpstreamCatalogProvider,
} from "../provider/upstream-catalog.js";
import {
  defaultUpstreamRouting,
  type UpstreamRouting,
} from "../provider/upstream-routing.js";
import type { ModelPriceRule } from "./model-pricing.js";

export type PolzaPriceQuote = {
  /** Имя модели, которое попадает в `model_usage` (фактический upstream-адрес). */
  model: string;
  /** Идентификатор модели платформы: `nestdev`, `max`, `mini`. */
  modelId: string;
  provider: string;
  input: number;
  output: number;
  currency: string;
  routing: UpstreamRouting["mode"];
  fetchedAt: string;
};

export type PolzaPricingSnapshot = {
  configured: boolean;
  source: "polza-catalog" | "none";
  fetchedAt: string | null;
  stale: boolean;
  currency: string | null;
  quotes: PolzaPriceQuote[];
  warnings: string[];
};

export type PolzaPricingOptions = {
  fetch?: typeof fetch;
  now?: () => number;
  refresh?: boolean;
  /** Для тестов: готовый список точек входа вместо каталога платформы. */
  targets?: PolzaModelTarget[];
};

export type PolzaModelTarget = {
  id: string;
  config: PlatformProviderConfig;
};

const CURRENCY = "RUB";

function providerPriced(provider: UpstreamCatalogProvider): boolean {
  return provider.promptPerMillion !== null
    && provider.completionPerMillion !== null
    && Boolean(provider.currency);
}

/**
 * Провайдер, по цене которого считается модель. Возвращает `null`, если каталог не дал
 * ни одного варианта с ценой: догадываться о сумме нельзя.
 */
export function choosePolzaProvider(
  model: Pick<UpstreamCatalogModel, "providers" | "topProvider">,
  routing: UpstreamRouting = defaultUpstreamRouting(),
): { provider: UpstreamCatalogProvider; reason: "fixed" | "cheapest" | "top-provider" } | null {
  if (routing.mode === "fixed") {
    for (const name of routing.providers) {
      const resolved = resolveUpstreamProviderName(model.providers, name);
      const provider = resolved
        ? model.providers.find(item => item.name === resolved)
        : undefined;
      if (provider && providerPriced(provider)) return { provider, reason: "fixed" };
    }
  }

  if (routing.mode === "auto" && model.topProvider) {
    const top = model.providers.find(item => item.name === model.topProvider);
    if (top && providerPriced(top)) return { provider: top, reason: "top-provider" };
  }

  const cheapest = rankUpstreamProviders(model.providers, routing)[0];
  if (cheapest && providerPriced(cheapest)) {
    return { provider: cheapest, reason: "cheapest" };
  }
  return null;
}

/** Точки входа платформы, которые действительно идут через Polza.ai. */
export async function readPolzaModelTargets(): Promise<PolzaModelTarget[]> {
  const targets: PolzaModelTarget[] = [];
  const seen = new Set<string>();
  const add = (id: string, config: PlatformProviderConfig | null) => {
    if (!config || !isPolzaGateway(config.baseUrl) || !config.model.trim()) return;
    const model = config.model.trim();
    if (seen.has(model)) return;
    seen.add(model);
    targets.push({ id, config });
  };

  add("nestdev", getPlatformProviderConfig());
  for (const model of await listPlatformModels()) {
    add(model.id, platformModelProviderConfig(model));
  }
  return targets;
}

function number(value: number | null): number {
  return value === null ? 0 : value;
}

export async function readPolzaPricing(
  options: PolzaPricingOptions = {},
): Promise<PolzaPricingSnapshot> {
  const targets = options.targets ?? await readPolzaModelTargets();
  if (targets.length === 0) {
    return {
      configured: false,
      source: "none",
      fetchedAt: null,
      stale: false,
      currency: null,
      quotes: [],
      warnings: ["Цены Polza не подтянуты: ни одна модель платформы не использует Polza.ai."],
    };
  }

  const warnings: string[] = [];
  const quotes: PolzaPriceQuote[] = [];
  const indexes = new Map<string, Awaited<ReturnType<typeof getUpstreamCatalogIndex>>>();
  const fetchedTimes: string[] = [];
  let stale = false;

  for (const target of targets) {
    const key = target.config.baseUrl.trim().replace(/\/+$/, "");
    let index = indexes.get(key);
    if (index === undefined) {
      index = await getUpstreamCatalogIndex(target.config.baseUrl, target.config.token, {
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.now ? { now: options.now } : {}),
        ...(options.refresh ? { refresh: true } : {}),
      });
      indexes.set(key, index);
    }
    if (!index) {
      warnings.push(
        "Каталог Polza недоступен: цена модели " + target.config.model +
        " осталась из ручной таблицы или неизвестна.",
      );
      continue;
    }
    fetchedTimes.push(index.fetchedAt);
    stale = stale || index.stale;
    const model = index.models.get(target.config.model);
    if (!model) {
      warnings.push("Модели " + target.config.model + " нет в каталоге Polza.");
      continue;
    }
    const routing = target.config.routing ?? defaultUpstreamRouting();
    const selected = choosePolzaProvider(model, routing);
    if (!selected) {
      warnings.push(
        "У модели " + target.config.model + " в каталоге Polza нет провайдера с ценой.",
      );
      continue;
    }
    const currency = selected.provider.currency.trim().toUpperCase();
    if (currency !== CURRENCY) {
      warnings.push(
        "Модель " + target.config.model + " оценена в " + currency +
        ": для сравнения с рублёвой выручкой нужна цена в " + CURRENCY + ".",
      );
    }
    if (quotes.some(quote => quote.model === target.config.model)) {
      warnings.push(
        "Модель " + target.config.model + " подключена несколько раз — взята первая точка входа.",
      );
      continue;
    }
    quotes.push({
      model: target.config.model,
      modelId: target.id,
      provider: selected.provider.name,
      input: number(selected.provider.promptPerMillion),
      output: number(selected.provider.completionPerMillion),
      currency,
      routing: routing.mode,
      fetchedAt: index.fetchedAt,
    });
  }

  const currencies = [...new Set(quotes.map(quote => quote.currency).filter(Boolean))];
  const currency = currencies.length === 1 ? currencies[0] : null;
  if (currencies.length > 1) {
    warnings.push(
      "Цены Polza пришли в разных валютах (" + currencies.join(", ") +
      "): автоматические цены не применяются.",
    );
  }

  return {
    configured: quotes.length > 0 && currency === CURRENCY,
    source: quotes.length > 0 ? "polza-catalog" : "none",
    fetchedAt: fetchedTimes.sort().at(-1) ?? null,
    stale,
    currency,
    quotes,
    warnings,
  };
}

/** Автоматические цены в формате ручной таблицы; выбор провайдера уже зафиксирован в quote. */
export function polzaPriceRules(snapshot: PolzaPricingSnapshot): ModelPriceRule[] {
  if (!snapshot.configured) return [];
  return snapshot.quotes.map(quote => ({
    match: quote.model.trim().toLowerCase(),
    input: quote.input,
    output: quote.output,
    source: "polza-catalog" as const,
  }));
}
