import assert from "node:assert/strict";
import test from "node:test";
import {
  estimatedUpstreamCost,
  getUpstreamModelCatalog,
  parseUpstreamModel,
  rankUpstreamProviders,
  resetUpstreamCatalogCache,
  resolveUpstreamProviderName,
  upstreamProviderEligible,
  type UpstreamCatalogProvider,
} from "./upstream-catalog.js";

function provider(name: string, prompt: number, completion: number, tools = true, extra: Partial<UpstreamCatalogProvider> = {}): UpstreamCatalogProvider {
  return {
    name,
    promptPerMillion: prompt,
    completionPerMillion: completion,
    cacheReadPerMillion: null,
    currency: "RUB",
    contextLength: 100_000,
    maxCompletionTokens: 8_000,
    supportedParameters: tools ? ["tools"] : ["temperature"],
    tools,
    ambiguous: false,
    duplicateCount: 1,
    isUnofficial: false,
    isModerated: false,
    storesDataInRussia: false,
    isFz152Compliant: false,
    hostedOnPolza: false,
    ...extra,
  };
}

test("каталог разбирает цены, tools и помечает одинаковые имена провайдеров", () => {
  const model = parseUpstreamModel({
    id: "deepseek/deepseek-v4.1-flash-1017",
    name: "DeepSeek V4.1 Flash",
    context_length: 1_048_576,
    top_provider: { name: "morph/fp8" },
    providers: [
      { name: "deepseek", pricing: { prompt_per_million: "17.09", completion_per_million: "68.36", currency: "RUB" }, supported_parameters: ["tools"], is_unofficial: false },
      { name: "deepseek", pricing: { prompt_per_million: "17.09", completion_per_million: "68.36", currency: "RUB" }, supported_parameters: ["temperature"] },
      { name: "morph/fp8", pricing: { prompt_per_million: "5.70", completion_per_million: "21.88", input_cache_read_per_million: "0.91", currency: "RUB" }, supported_parameters: ["tools", "reasoning"] },
      { name: "no-tools", pricing: { prompt_per_million: "1", completion_per_million: "1", currency: "RUB" }, supported_parameters: ["temperature"] },
    ],
  }, "deepseek/deepseek-v4.1-flash-1017");

  assert.ok(model);
  assert.equal(model?.topProvider, "morph/fp8");
  assert.equal(model?.providers.length, 3);
  const deepseek = model?.providers.find(item => item.name === "deepseek");
  assert.equal(deepseek?.ambiguous, true);
  assert.equal(deepseek?.duplicateCount, 2);
  assert.equal(deepseek?.tools, true);
  const morph = model?.providers.find(item => item.name === "morph/fp8");
  assert.equal(morph?.ambiguous, false);
  assert.equal(morph?.promptPerMillion, 5.7);
  assert.equal(morph?.completionPerMillion, 21.88);
  assert.equal(morph?.cacheReadPerMillion, 0.91);
});

test("cheapest сортирует по профилю нагрузки и не берёт spot, flex, дубли и модели без tools", () => {
  const providers = [
    provider("morph/fp8", 5.7, 21.88),
    provider("open-inference/fp4", 3.99, 56.97),
    provider("sail-research/fp4", 11.51, 17.09),
    provider("fireworks/spot", 1, 1),
    provider("deepinfra/fp8/flex", 1, 1),
    provider("no-tools", 1, 1, false),
    provider("deepseek", 17.09, 68.36, true, { ambiguous: true, duplicateCount: 2 }),
  ];
  const ranked = rankUpstreamProviders(providers, { assumedInputPerOutput: 10 });
  assert.deepEqual(ranked.map(item => item.name), ["morph/fp8", "open-inference/fp4", "sail-research/fp4"]);
  assert.equal(estimatedUpstreamCost(providers[0], 10), 78.88);
  assert.equal(upstreamProviderEligible(providers[3], {}), false, "spot не выбирается автоматически");
  assert.equal(upstreamProviderEligible(providers[6], {}), false, "дубль имени нельзя закрепить точно");
  assert.deepEqual(rankUpstreamProviders(providers, { assumedInputPerOutput: 10, maxPrice: { completion: 20 } }).map(item => item.name), ["sail-research/fp4"]);
});

test("подпись провайдера из админки приводится к имени каталога", () => {
  const providers = [
    provider("sail-research/fp4/us", 11.51, 17.09),
    provider("sail-research/fp4", 11.51, 17.09),
    provider("sail-research/fp4:batch", 9, 15),
    provider("morph/fp8", 5.7, 21.88),
  ];
  assert.equal(resolveUpstreamProviderName(providers, "sail-research/fp4"), "sail-research/fp4");
  assert.equal(resolveUpstreamProviderName(providers, "Sail Research"), "sail-research/fp4", "вендор без варианта — обычный, не /us и не :batch");
  assert.equal(resolveUpstreamProviderName(providers, "Sail Research FP4"), "sail-research/fp4");
  assert.equal(resolveUpstreamProviderName(providers, "Morph"), "morph/fp8");
  assert.equal(resolveUpstreamProviderName(providers, "Unknown Provider"), null);
});

test("каталог кэшируется и переживает временный сбой", async () => {
  resetUpstreamCatalogCache();
  const now = { value: 1_000_000 };
  let calls = 0;
  let fail = false;
  const model = {
    id: "test/model",
    name: "Test",
    context_length: 100_000,
    top_provider: { name: "morph/fp8" },
    providers: [
      { name: "morph/fp8", pricing: { prompt_per_million: "5", completion_per_million: "20", currency: "RUB" }, supported_parameters: ["tools"] },
      { name: "cheap/fp4", pricing: { prompt_per_million: "2", completion_per_million: "60", currency: "RUB" }, supported_parameters: ["tools"] },
    ],
  };
  const fetchImpl = (async () => {
    calls += 1;
    if (fail) throw new TypeError("fetch failed");
    return new Response(JSON.stringify({ data: [model] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const first = await getUpstreamModelCatalog("https://polza.ai/api/v1", "key", "test/model", { fetch: fetchImpl, now: () => now.value });
    assert.equal(first?.stale, false);
    assert.equal(first?.providers.length, 2);
    assert.equal(calls, 1);

    // В пределах TTL сеть не трогается.
    await getUpstreamModelCatalog("https://polza.ai/api/v1", "key", "test/model", { fetch: fetchImpl, now: () => now.value });
    assert.equal(calls, 1);

    // Истёк TTL и каталог упал: отдаём прошлую копию с пометкой stale, запуски не останавливаются.
    now.value += 6 * 60_000;
    fail = true;
    const stale = await getUpstreamModelCatalog("https://polza.ai/api/v1", "key", "test/model", { fetch: fetchImpl, now: () => now.value });
    assert.equal(calls, 2);
    assert.equal(stale?.stale, true);
    assert.equal(stale?.providers.length, 2);
  } finally {
    resetUpstreamCatalogCache();
  }
});
