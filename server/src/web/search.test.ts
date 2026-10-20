import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { consumeUsage } from "../account/usage-store.js";
import { clearWebSearchCache, providerChain, providerForPlan, resolveProvider, searchWeb } from "./search.js";

const MANAGED = ["WEB_SEARCH_PROVIDER", "YANDEX_SEARCH_API_KEY", "YANDEX_SEARCH_FOLDER_ID", "TAVILY_API_KEY"] as const;

/** Провайдеры читают ключи из окружения: тест выставляет их сам и возвращает всё как было. */
function withEnv<T>(values: Partial<Record<(typeof MANAGED)[number], string>>, run: () => T): T {
  const previous = new Map(MANAGED.map(name => [name, process.env[name]]));
  try {
    for (const name of MANAGED) delete process.env[name];
    for (const [name, value] of Object.entries(values)) process.env[name] = value;
    return run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("the free plan searches DuckDuckGo, paid plans search Yandex", () => {
  assert.equal(providerForPlan("free"), "duckduckgo");
  assert.equal(providerForPlan("pro"), "yandex");
  assert.equal(providerForPlan("team"), "yandex");
});

test("the free plan never gets a paid provider, even with keys configured", () => {
  withEnv({ TAVILY_API_KEY: "tvly-test", YANDEX_SEARCH_API_KEY: "Aq-test", YANDEX_SEARCH_FOLDER_ID: "b1gtest" }, () => {
    assert.deepEqual(providerChain("free").chain, ["duckduckgo"]);
  });
});

test("a paid plan with both keys tries Yandex first and keeps Tavily as the reserve", () => {
  withEnv({ TAVILY_API_KEY: "tvly-test", YANDEX_SEARCH_API_KEY: "Aq-test", YANDEX_SEARCH_FOLDER_ID: "b1gtest" }, () => {
    assert.deepEqual(providerChain("pro").chain, ["yandex", "tavily", "duckduckgo"]);
    assert.equal(resolveProvider("pro").provider, "yandex");
  });
});

test("a paid plan without a Yandex key searches through Tavily", () => {
  withEnv({ TAVILY_API_KEY: "tvly-test" }, () => {
    assert.deepEqual(providerChain("pro").chain, ["tavily", "duckduckgo"]);
    assert.equal(resolveProvider("pro").provider, "tavily");
    assert.equal(resolveProvider("pro").note, undefined, "ключ есть — предупреждать не о чем");
  });
});

test("a paid plan without any key still answers through DuckDuckGo and says what is missing", () => {
  withEnv({}, () => {
    const paid = resolveProvider("pro");
    assert.equal(paid.provider, "duckduckgo");
    assert.match(paid.note ?? "", /ключи поисковых провайдеров не заданы/);
    assert.match(paid.note ?? "", /YANDEX_SEARCH_API_KEY/);
    assert.match(paid.note ?? "", /TAVILY_API_KEY/);
  });
});

test("the environment can force one provider for the whole server", () => {
  withEnv({ WEB_SEARCH_PROVIDER: "duckduckgo" }, () => {
    assert.deepEqual(providerChain("pro").chain, ["duckduckgo"], "принудительный бесплатный провайдер работает и для платного тарифа");
  });
  withEnv({ WEB_SEARCH_PROVIDER: "yandex" }, () => {
    // Ключа нет: принудительный Yandex не выбирается, иначе каждый запрос заканчивался бы отказом.
    const forced = resolveProvider("free");
    assert.equal(forced.provider, "duckduckgo");
    assert.match(forced.note ?? "", /WEB_SEARCH_PROVIDER=yandex/);
  });
  withEnv({ WEB_SEARCH_PROVIDER: "tavily" }, () => {
    assert.match(resolveProvider("pro").note ?? "", /TAVILY_API_KEY не настроен/);
  });
});

test("an exhausted daily search quota is reported instead of asking the provider", async () => {
  const userId = "web-quota-" + randomUUID();
  clearWebSearchCache();
  for (let index = 0; index < 25; index++) await consumeUsage(userId, "webSearches", "free");
  const response = await searchWeb({ userId, plan: "free", query: "fastify hooks" });
  assert.equal(response.ok, false);
  assert.equal(response.code, "quota");
  assert.equal(response.results.length, 0);
  assert.match(response.error ?? "", /25 из 25/);
});
