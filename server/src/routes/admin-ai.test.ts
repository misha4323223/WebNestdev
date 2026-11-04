import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { UpstreamCatalogModel } from "../provider/upstream-catalog.js";

process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_ENCRYPTION_KEY = "0123456789abcdef".repeat(4);
const root = await mkdtemp(path.join(tmpdir(), "admin-ai-"));
process.env.WEBNESTDEV_DATA_DIR = root;

const Fastify = (await import("fastify")).default;
const { registerAdminAiRoutes } = await import("./admin-ai.js");
const { createAdmin, createAdminSession } = await import("../admin/admin-store.js");

const seen: { value: { provider: string; baseUrl: string; model: string; token?: string; routing?: { mode: string } } | null } = { value: null };
const catalogSeen: { value: { baseUrl: string; token?: string; model: string } | null } = { value: null };
function catalogFor(model: string): UpstreamCatalogModel {
  return {
    id: model,
    name: model,
    contextLength: 1_048_576,
    topProvider: "morph/fp8",
    fetchedAt: "2026-11-01T12:00:00.000Z",
    stale: false,
    providers: [
      {
        name: "morph/fp8", promptPerMillion: 5.7, completionPerMillion: 21.88, cacheReadPerMillion: 0.91,
        currency: "RUB", contextLength: 1_048_576, maxCompletionTokens: 943_718,
        supportedParameters: ["tools"], tools: true, ambiguous: false, duplicateCount: 1,
        isUnofficial: false, isModerated: false, storesDataInRussia: false, isFz152Compliant: false, hostedOnPolza: false,
      },
      {
        name: "open-inference/fp4", promptPerMillion: 3.99, completionPerMillion: 56.97, cacheReadPerMillion: 0.57,
        currency: "RUB", contextLength: 1_048_576, maxCompletionTokens: 900_000,
        supportedParameters: ["tools"], tools: true, ambiguous: false, duplicateCount: 1,
        isUnofficial: false, isModerated: false, storesDataInRussia: false, isFz152Compliant: false, hostedOnPolza: false,
      },
    ],
  };
}
const app = Fastify();
await registerAdminAiRoutes(app, {
  testAi: async config => {
    seen.value = config;
    return { ok: true, provider: config.provider, model: config.model, latencyMs: 10, tools: true };
  },
  catalog: async (baseUrl, token, model) => {
    catalogSeen.value = { baseUrl, ...(token ? { token } : {}), model };
    return catalogFor(model);
  },
});
await app.ready();

const admin = await createAdmin("ai-admin@example.test", "correct-horse-battery");
const session = await createAdminSession(admin.id);
const auth = { authorization: "Bearer " + session.token };

test.after(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
  delete process.env.WEBNESTDEV_STORAGE;
  delete process.env.WEBNESTDEV_DATA_DIR;
  delete process.env.WEBNESTDEV_ENCRYPTION_KEY;
});

test("главный провайдер без входа недоступен", async () => {
  const response = await app.inject({ method: "GET", url: "/api/admin/ai" });
  assert.equal(response.statusCode, 401);
});

test("админка сохраняет провайдера, модель и ключ, но не возвращает ключ", async () => {
  const saved = await app.inject({
    method: "POST",
    url: "/api/admin/ai",
    headers: auth,
    payload: {
      provider: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "deepseek/deepseek-chat",
      apiKey: "sk-or-secret-value",
    },
  });
  assert.equal(saved.statusCode, 200);
  const body = saved.json() as { saved: boolean; ai: { provider: string; baseUrl: string; model: string; hasKey: boolean; keySource: string } };
  assert.equal(body.saved, true);
  assert.equal(body.ai.provider, "OpenRouter");
  assert.equal(body.ai.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(body.ai.model, "deepseek/deepseek-chat");
  assert.equal(body.ai.hasKey, true);
  assert.equal(body.ai.keySource, "panel");
  assert.ok(!saved.body.includes("sk-or-secret-value"), "ключ не должен вернуться в ответе");

  const status = await app.inject({ method: "GET", url: "/api/admin/ai", headers: auth });
  assert.equal(status.statusCode, 200);
  assert.ok(!status.body.includes("sk-or-secret-value"));
});

test("проверка провайдера берёт сохранённый ключ, если новый не передан", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/ai/test",
    headers: auth,
    payload: { provider: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "deepseek/deepseek-chat" },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().ok, true);
  assert.equal(seen.value?.token, "sk-or-secret-value");
  assert.ok(!response.body.includes("sk-or-secret-value"));
});

test("некорректный адрес провайдера отклоняется", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/ai",
    headers: auth,
    payload: { provider: "OpenRouter", baseUrl: "ftp://openrouter.ai/api", model: "model" },
  });
  assert.equal(response.statusCode, 400);
});

test("админка сохраняет ставки главной модели и отдаёт их в GET", async () => {
  const saved = await app.inject({
    method: "POST",
    url: "/api/admin/ai",
    headers: auth,
    payload: {
      provider: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "deepseek/deepseek-chat",
      creditRates: { inputPerMillion: 60, outputPerMillion: 600, minimumPerRun: 2 },
    },
  });
  assert.equal(saved.statusCode, 200);
  const body = saved.json() as { ai: { creditRates: { inputPerMillion: number; outputPerMillion: number; minimumPerRun: number } } };
  assert.deepEqual(body.ai.creditRates, { inputPerMillion: 60, outputPerMillion: 600, minimumPerRun: 2 });

  const status = await app.inject({ method: "GET", url: "/api/admin/ai", headers: auth });
  assert.equal(status.statusCode, 200);
  assert.deepEqual(status.json().ai.creditRates, { inputPerMillion: 60, outputPerMillion: 600, minimumPerRun: 2 });
});

test("частичное обновление ставок главной модели не сбрасывает остальные поля", async () => {
  const saved = await app.inject({
    method: "POST",
    url: "/api/admin/ai",
    headers: auth,
    payload: {
      provider: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "deepseek/deepseek-chat",
      creditRates: { outputPerMillion: 700 },
    },
  });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.json().ai.creditRates, { inputPerMillion: 60, outputPerMillion: 700, minimumPerRun: 2 });
});

test("админка сохраняет маршрутизацию и отдаёт каталог провайдеров", async () => {
  const saved = await app.inject({
    method: "POST",
    url: "/api/admin/ai",
    headers: auth,
    payload: {
      provider: "Polza.ai",
      baseUrl: "https://polza.ai/api/v1",
      model: "deepseek/deepseek-v4.1-flash-1017",
      routing: { mode: "fixed", providers: ["morph/fp8"], allowFallback: true },
    },
  });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.json().ai.routing, {
    mode: "fixed",
    providers: ["morph/fp8"],
    allowFallback: true,
    fallbackToAuto: false,
    assumedInputPerOutput: 10,
  });

  const status = await app.inject({ method: "GET", url: "/api/admin/ai", headers: auth });
  assert.equal(status.statusCode, 200);
  assert.deepEqual(status.json().ai.routing, saved.json().ai.routing);

  const catalog = await app.inject({
    method: "GET",
    url: "/api/admin/ai/providers?baseUrl=" + encodeURIComponent("https://polza.ai/api/v1") +
      "&model=" + encodeURIComponent("deepseek/deepseek-v4.1-flash-1017"),
    headers: auth,
  });
  assert.equal(catalog.statusCode, 200);
  const body = catalog.json() as {
    recommended: string | null;
    providers: Array<{ name: string; selected: boolean; eligible: boolean; estimatedCost: number }>;
  };
  assert.equal(body.recommended, "morph/fp8");
  assert.deepEqual(body.providers.map(provider => provider.name), ["morph/fp8", "open-inference/fp4"]);
  assert.equal(body.providers.find(provider => provider.name === "morph/fp8")?.selected, true);
  assert.equal(body.providers.find(provider => provider.name === "open-inference/fp4")?.selected, false);
  assert.equal(body.providers.find(provider => provider.name === "open-inference/fp4")?.eligible, true);
  assert.equal(body.providers.find(provider => provider.name === "morph/fp8")?.estimatedCost, 78.88);

  // Проверка того же адреса и модели должна идти с сохранённой цепочкой, а не с auto.
  const tested = await app.inject({
    method: "POST",
    url: "/api/admin/ai/test",
    headers: auth,
    payload: {
      provider: "Polza.ai",
      baseUrl: "https://polza.ai/api/v1",
      model: "deepseek/deepseek-v4.1-flash-1017",
    },
  });
  assert.equal(tested.statusCode, 200);
  assert.equal(seen.value?.routing?.mode, "fixed");
});

test("каталог черновика получает ключ из заголовка и не наследует routing главной модели", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/api/admin/ai/providers?baseUrl=" + encodeURIComponent("https://gateway.example/v1") +
      "&model=" + encodeURIComponent("mini-model"),
    headers: { ...auth, "x-ai-provider-key": "sk-mini-draft" },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(catalogSeen.value?.token, "sk-mini-draft");
  assert.equal(catalogSeen.value?.baseUrl, "https://gateway.example/v1");
  assert.equal(catalogSeen.value?.model, "mini-model");
  assert.equal(response.json().routing.mode, "auto", "routing главной модели относится только к ней");
  assert.deepEqual(response.json().providers.map((provider: { selected: boolean }) => provider.selected), [false, false]);
});

test("fixed без провайдера отклоняется на уровне API", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/ai",
    headers: auth,
    payload: {
      provider: "Polza.ai",
      baseUrl: "https://polza.ai/api/v1",
      model: "deepseek/deepseek-v4.1-flash-1017",
      routing: { mode: "fixed", providers: [] },
    },
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /routing:.*хотя бы одного/);
});

test("нулевые обе ставки главной модели отклоняются", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/ai",
    headers: auth,
    payload: {
      provider: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "deepseek/deepseek-chat",
      creditRates: { inputPerMillion: 0, outputPerMillion: 0 },
    },
  });
  assert.equal(response.statusCode, 400);
});
