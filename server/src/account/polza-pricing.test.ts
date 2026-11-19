import assert from "node:assert/strict";
import test from "node:test";
import {
  choosePolzaProvider,
  polzaPriceRules,
  readPolzaPricing,
  type PolzaModelTarget,
} from "./polza-pricing.js";
import { readModelPriceTable, withCatalogPrices } from "./model-pricing.js";
import { resetUpstreamCatalogCache, type UpstreamCatalogModel } from "../provider/upstream-catalog.js";
import { defaultUpstreamRouting, type UpstreamRouting } from "../provider/upstream-routing.js";

const model: UpstreamCatalogModel = {
  id: "test/model",
  name: "Test Model",
  contextLength: 100_000,
  topProvider: "morph/fp8",
  fetchedAt: "2026-11-19T00:00:00.000Z",
  stale: false,
  providers: [
    {
      name: "cheap/fp4",
      promptPerMillion: 2,
      completionPerMillion: 10,
      cacheReadPerMillion: null,
      currency: "RUB",
      contextLength: 100_000,
      maxCompletionTokens: 8_000,
      supportedParameters: ["tools"],
      tools: true,
      ambiguous: false,
      duplicateCount: 1,
      isUnofficial: false,
      isModerated: false,
      storesDataInRussia: false,
      isFz152Compliant: false,
      hostedOnPolza: false,
    },
    {
      name: "morph/fp8",
      promptPerMillion: 5,
      completionPerMillion: 20,
      cacheReadPerMillion: null,
      currency: "RUB",
      contextLength: 100_000,
      maxCompletionTokens: 8_000,
      supportedParameters: ["tools"],
      tools: true,
      ambiguous: false,
      duplicateCount: 1,
      isUnofficial: false,
      isModerated: false,
      storesDataInRussia: false,
      isFz152Compliant: false,
      hostedOnPolza: false,
    },
  ],
};

function target(routing: UpstreamRouting): PolzaModelTarget {
  return {
    id: "nestdev",
    config: {
      provider: "Polza.ai",
      baseUrl: "https://polza.ai/api/v1",
      model: "test/model",
      routing,
    },
  };
}

test("auto берёт top_provider каталога, cheapest — самый дешёвый по профилю нагрузки", () => {
  const auto = choosePolzaProvider(model, defaultUpstreamRouting());
  assert.equal(auto?.provider.name, "morph/fp8");
  assert.equal(auto?.reason, "top-provider");

  const cheapest = choosePolzaProvider(model, {
    ...defaultUpstreamRouting(),
    mode: "cheapest",
    assumedInputPerOutput: 1,
  });
  assert.equal(cheapest?.provider.name, "cheap/fp4");
  assert.equal(cheapest?.reason, "cheapest");
});

test("fixed сохраняет порядок провайдеров из админки", () => {
  const fixed = choosePolzaProvider(model, {
    ...defaultUpstreamRouting(),
    mode: "fixed",
    providers: ["Morph", "cheap"],
  });
  assert.equal(fixed?.provider.name, "morph/fp8");
  assert.equal(fixed?.reason, "fixed");
});

test("ручная цена перекрывает автоцену, а свободные модели остаются нулём", () => {
  const manual = readModelPriceTable({
    PLATFORM_AI_MODEL_PRICES: JSON.stringify({ "test/model": { input: 1, output: 2 } }),
    PLATFORM_AI_PRICE_CURRENCY: "RUB",
  });
  const merged = withCatalogPrices(manual, [
    { match: "test/model", input: 999, output: 999, source: "polza-catalog" },
    { match: "free-model", input: 0, output: 0, source: "polza-catalog" },
  ], { currency: "RUB" });
  assert.equal(merged.rules.find(rule => rule.match === "test/model")?.input, 1);
  assert.equal(merged.rules.find(rule => rule.match === "free-model")?.source, "polza-catalog");
  assert.equal(merged.currency, "RUB");

  // Частичное ручное правило тоже главнее: иначе точная автоцена перебила бы его.
  const partial = readModelPriceTable({
    PLATFORM_AI_MODEL_PRICES: JSON.stringify({ deepseek: { input: 1, output: 2 } }),
    PLATFORM_AI_PRICE_CURRENCY: "RUB",
  });
  const noOverride = withCatalogPrices(partial, [
    { match: "deepseek/model", input: 999, output: 999, source: "polza-catalog" },
  ], { currency: "RUB" });
  assert.equal(noOverride.rules.some(rule => rule.match === "deepseek/model"), false);

  // Явная общая ставка тоже закрывает автоцены: это осознанное переопределение всех моделей.
  const catchAll = readModelPriceTable({
    PLATFORM_AI_PRICE_INPUT_PER_MILLION: "10",
    PLATFORM_AI_PRICE_OUTPUT_PER_MILLION: "20",
    PLATFORM_AI_PRICE_CURRENCY: "RUB",
  });
  assert.equal(withCatalogPrices(catchAll, [
    { match: "deepseek/model", input: 999, output: 999, source: "polza-catalog" },
  ]).rules.length, 0);

  // Без ручной таблицы валюта каталога становится валютой расчёта, иначе рубли Polza
  // выглядели бы долларами по умолчанию.
  const autoOnly = withCatalogPrices(readModelPriceTable({}), [
    { match: "deepseek/model", input: 4, output: 18, source: "polza-catalog" },
  ], { currency: "RUB" });
  assert.equal(autoOnly.currency, "RUB");
  assert.equal(autoOnly.source, "polza-catalog");
  assert.equal(autoOnly.configured, true);
});

test("каталог Polza превращается в цены выбранного провайдера и кэшируется", async () => {
  resetUpstreamCatalogCache();
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(JSON.stringify({
      data: [{
        id: "test/model",
        name: "Test Model",
        context_length: 100_000,
        top_provider: { name: "morph/fp8" },
        providers: [
          { name: "morph/fp8", pricing: { prompt_per_million: "5", completion_per_million: "20", currency: "RUB" }, supported_parameters: ["tools"] },
        ],
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const options = {
    targets: [target(defaultUpstreamRouting())],
    fetch: fetchImpl,
    now: () => 1_000_000,
  };
  const first = await readPolzaPricing(options);
  assert.equal(first.configured, true);
  assert.equal(first.currency, "RUB");
  assert.equal(first.quotes[0].provider, "morph/fp8");
  assert.equal(first.quotes[0].input, 5);
  assert.deepEqual(polzaPriceRules(first), [{
    match: "test/model",
    input: 5,
    output: 20,
    source: "polza-catalog",
  }]);

  await readPolzaPricing(options);
  assert.equal(calls, 1, "в пределах TTL повторный запрос не идёт в сеть");
  resetUpstreamCatalogCache();
});
