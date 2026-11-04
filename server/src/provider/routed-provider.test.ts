import assert from "node:assert/strict";
import test from "node:test";
import { RoutedProvider, UpstreamRoutingError } from "./routed-provider.js";
import { ProviderHttpError } from "./provider-errors.js";
import type { FailoverEndpoint } from "./failover-provider.js";
import type { Provider, ProviderChunk, UpstreamProviderRequest } from "./provider-types.js";
import type { UpstreamCatalogModel, UpstreamCatalogProvider } from "./upstream-catalog.js";
import { defaultUpstreamRouting, type UpstreamRouting } from "./upstream-routing.js";

function provider(name: string, prompt: number, completion: number, extra: Partial<UpstreamCatalogProvider> = {}): UpstreamCatalogProvider {
  return {
    name,
    promptPerMillion: prompt,
    completionPerMillion: completion,
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
    ...extra,
  };
}

function catalogOf(...providers: UpstreamCatalogProvider[]): UpstreamCatalogModel {
  return {
    id: "deepseek/deepseek-v4.1-flash-1017",
    name: "DeepSeek V4.1 Flash",
    contextLength: 1_048_576,
    topProvider: "morph/fp8",
    providers,
    fetchedAt: new Date(0).toISOString(),
    stale: false,
  };
}

function routing(overrides: Partial<UpstreamRouting>): UpstreamRouting {
  return { ...defaultUpstreamRouting(), ...overrides };
}

type Call = { label: string; upstream?: UpstreamProviderRequest };

function recordingCreate(calls: Call[], behaviour?: (endpoint: FailoverEndpoint) => AsyncGenerator<ProviderChunk>): (endpoint: FailoverEndpoint) => Provider {
  return endpoint => ({
    async *stream(_messages, _model, _tools, _signal, options) {
      calls.push({ label: endpoint.label, ...(options?.upstream ? { upstream: options.upstream } : {}) });
      if (behaviour) {
        yield* behaviour(endpoint);
        return;
      }
      yield { type: "text", text: "ответ " + endpoint.label };
      yield { type: "done" };
    },
  });
}

async function collect(instance: Provider) {
  const chunks: ProviderChunk[] = [];
  for await (const chunk of instance.stream([{ role: "user", content: "привет" }], "deepseek/deepseek-v4.1-flash-1017")) chunks.push(chunk);
  return chunks;
}

async function *failure(error: unknown): AsyncGenerator<ProviderChunk> {
  throw error;
}

test("fixed пропускает выключенного Morph и берёт следующего по списку", async () => {
  const calls: Call[] = [];
  const logs: string[] = [];
  const instance = new RoutedProvider(
    "https://polza.ai/api/v1",
    "key",
    routing({ mode: "fixed", providers: ["morph/fp8", "open-inference/fp4"] }),
    {
      catalog: async () => catalogOf(provider("open-inference/fp4", 3.99, 56.97)),
      create: recordingCreate(calls),
      log: message => logs.push(message),
    },
  );

  const chunks = await collect(instance);
  assert.deepEqual(calls.map(call => call.label), ["open-inference/fp4"]);
  assert.deepEqual(calls[0]?.upstream, { only: ["open-inference/fp4"], allowFallbacks: false });
  assert.deepEqual(chunks, [{ type: "text", text: "ответ open-inference/fp4" }, { type: "done" }]);
  assert.ok(logs.some(message => /morph\/fp8 отсутствует в каталоге/.test(message)), logs.join("\n"));
});

test("fixed понимает подпись Sail Research и отправляет шлюзу точное имя", async () => {
  const calls: Call[] = [];
  const logs: string[] = [];
  const instance = new RoutedProvider(
    "https://polza.ai/api/v1",
    "key",
    routing({ mode: "fixed", providers: ["Sail Research"] }),
    {
      catalog: async () => catalogOf(
        provider("sail-research/fp4/us", 11.51, 17.09),
        provider("sail-research/fp4", 11.51, 17.09),
        provider("morph/fp8", 5.7, 21.88),
      ),
      create: recordingCreate(calls),
      log: message => logs.push(message),
    },
  );

  await collect(instance);
  assert.deepEqual(calls.map(call => call.label), ["sail-research/fp4"]);
  assert.deepEqual(calls[0]?.upstream, { only: ["sail-research/fp4"], allowFallbacks: false });
  assert.ok(logs.some(message => /«Sail Research» → sail-research\/fp4/.test(message)), logs.join("\n"));
});

test("fixed переключается, если провайдер ответил отказом до первого байта", async () => {
  const calls: Call[] = [];
  const instance = new RoutedProvider(
    "https://polza.ai/api/v1",
    "key",
    routing({ mode: "fixed", providers: ["morph/fp8", "open-inference/fp4"] }),
    {
      catalog: async () => catalogOf(provider("morph/fp8", 5.7, 21.88), provider("open-inference/fp4", 3.99, 56.97)),
      create: recordingCreate(calls, endpoint => endpoint.label === "morph/fp8"
        ? failure(new ProviderHttpError(400, "provider morph/fp8 is disabled"))
        : (async function *() { yield { type: "text", text: "ответ open" }; yield { type: "done" }; })()),
      log: () => {},
    },
  );

  const chunks = await collect(instance);
  assert.deepEqual(calls.map(call => call.label), ["morph/fp8", "open-inference/fp4"]);
  assert.deepEqual(calls[0]?.upstream?.only, ["morph/fp8"]);
  assert.deepEqual(calls[1]?.upstream?.only, ["open-inference/fp4"]);
  assert.deepEqual(chunks, [{ type: "text", text: "ответ open" }, { type: "done" }]);
});

test("allowFallback:false оставляет один шанс и не уводит к соседнему провайдеру", async () => {
  const calls: Call[] = [];
  const instance = new RoutedProvider(
    "https://polza.ai/api/v1",
    "key",
    routing({ mode: "fixed", providers: ["morph/fp8"], allowFallback: false }),
    {
      catalog: async () => catalogOf(provider("morph/fp8", 5.7, 21.88), provider("open-inference/fp4", 3.99, 56.97)),
      create: recordingCreate(calls, () => failure(new ProviderHttpError(503, "down"))),
      log: () => {},
    },
  );

  await assert.rejects(collect(instance), error => error instanceof ProviderHttpError && error.code === "UNAVAILABLE");
  assert.deepEqual(calls.map(call => call.label), ["morph/fp8"]);
});

test("cheapest строит порядок по цене под профиль и не берёт spot/flex/дубли", async () => {
  const calls: Call[] = [];
  const instance = new RoutedProvider(
    "https://polza.ai/api/v1",
    "key",
    routing({ mode: "cheapest" }),
    {
      catalog: async () => catalogOf(
        provider("morph/fp8", 5.7, 21.88),
        provider("open-inference/fp4", 3.99, 56.97),
        provider("sail-research/fp4", 11.51, 17.09),
        provider("fireworks/spot", 1, 1),
        provider("deepinfra/fp8/flex", 1, 1),
        provider("deepseek", 17.09, 68.36, { ambiguous: true, duplicateCount: 2 }),
        provider("no-tools", 1, 1, { tools: false, supportedParameters: ["temperature"] }),
      ),
      create: recordingCreate(calls, endpoint => endpoint.label === "morph/fp8"
        ? failure(new ProviderHttpError(503, "down"))
        : (async function *() { yield { type: "text", text: "ответ " + endpoint.label }; yield { type: "done" }; })()),
      log: () => {},
    },
  );

  const chunks = await collect(instance);
  assert.deepEqual(calls.map(call => call.label), ["morph/fp8", "open-inference/fp4"]);
  assert.deepEqual(calls[1]?.upstream?.only, ["open-inference/fp4"]);
  assert.deepEqual(chunks, [{ type: "text", text: "ответ open-inference/fp4" }, { type: "done" }]);
});

test("fallbackToAuto включается только когда вся цепочка недоступна", async () => {
  const calls: Call[] = [];
  const instance = new RoutedProvider(
    "https://polza.ai/api/v1",
    "key",
    routing({ mode: "fixed", providers: ["morph/fp8"], fallbackToAuto: true }),
    {
      catalog: async () => catalogOf(provider("open-inference/fp4", 3.99, 56.97)),
      create: recordingCreate(calls),
      log: () => {},
    },
  );

  const chunks = await collect(instance);
  assert.deepEqual(calls.map(call => call.label), ["авто-выбор шлюза"]);
  assert.equal(calls[0]?.upstream, undefined, "auto не должен отправлять provider.only");
  assert.deepEqual(chunks, [{ type: "text", text: "ответ авто-выбор шлюза" }, { type: "done" }]);
});

test("шлюз без массива providers не блокирует fixed", async () => {
  const calls: Call[] = [];
  const instance = new RoutedProvider(
    "https://openrouter.ai/api/v1",
    "key",
    routing({ mode: "fixed", providers: ["morph/fp8"] }),
    {
      catalog: async () => catalogOf(),
      create: recordingCreate(calls),
      log: () => {},
    },
  );

  await collect(instance);
  assert.deepEqual(calls.map(call => call.label), ["morph/fp8"]);
});

test("fallbackToAuto включается после отказов всей цепочки", async () => {
  const calls: Call[] = [];
  const instance = new RoutedProvider(
    "https://polza.ai/api/v1",
    "key",
    routing({ mode: "fixed", providers: ["morph/fp8"], fallbackToAuto: true }),
    {
      catalog: async () => catalogOf(provider("morph/fp8", 5.7, 21.88)),
      create: recordingCreate(calls, endpoint => endpoint.label === "morph/fp8"
        ? failure(new ProviderHttpError(503, "down"))
        : (async function *() { yield { type: "text", text: "ответ авто" }; yield { type: "done" }; })()),
      log: () => {},
    },
  );

  const chunks = await collect(instance);
  assert.deepEqual(calls.map(call => call.label), ["morph/fp8", "авто-выбор шлюза"]);
  assert.deepEqual(calls[0]?.upstream?.only, ["morph/fp8"]);
  assert.equal(calls[1]?.upstream, undefined);
  assert.deepEqual(chunks, [{ type: "text", text: "ответ авто" }, { type: "done" }]);
});

test("каталог недоступен — fixed не блокирует запуск и пробует настроенный порядок", async () => {
  const calls: Call[] = [];
  const instance = new RoutedProvider(
    "https://polza.ai/api/v1",
    "key",
    routing({ mode: "fixed", providers: ["morph/fp8", "open-inference/fp4"] }),
    {
      catalog: async () => null,
      create: recordingCreate(calls),
      log: () => {},
    },
  );

  await collect(instance);
  assert.deepEqual(calls.map(call => call.label), ["morph/fp8"]);
  assert.deepEqual(calls[0]?.upstream?.only, ["morph/fp8"]);
});

test("после первого байта ответа провайдер не меняется", async () => {
  const calls: Call[] = [];
  const instance = new RoutedProvider(
    "https://polza.ai/api/v1",
    "key",
    routing({ mode: "fixed", providers: ["morph/fp8", "open-inference/fp4"] }),
    {
      catalog: async () => catalogOf(provider("morph/fp8", 5.7, 21.88), provider("open-inference/fp4", 3.99, 56.97)),
      create: recordingCreate(calls, endpoint => endpoint.label === "morph/fp8"
        ? (async function *() { yield { type: "text", text: "начало" }; throw new ProviderHttpError(503, "down"); })()
        : (async function *() { yield { type: "text", text: "не должно быть" }; yield { type: "done" }; })()),
      log: () => {},
    },
  );

  const chunks: ProviderChunk[] = [];
  let failure: unknown = null;
  try {
    for await (const chunk of instance.stream([{ role: "user", content: "привет" }], "deepseek/deepseek-v4.1-flash-1017")) chunks.push(chunk);
  } catch (error) {
    failure = error;
  }
  assert.deepEqual(chunks, [{ type: "text", text: "начало" }]);
  assert.ok(failure instanceof ProviderHttpError);
  assert.deepEqual(calls.map(call => call.label), ["morph/fp8"]);
});

test("fixed без доступных провайдеров и без auto объясняет, что именно недоступно", async () => {
  const instance = new RoutedProvider(
    "https://polza.ai/api/v1",
    "key",
    routing({ mode: "fixed", providers: ["morph/fp8"] }),
    {
      catalog: async () => catalogOf(provider("open-inference/fp4", 3.99, 56.97)),
      create: recordingCreate([]),
      log: () => {},
    },
  );

  await assert.rejects(
    collect(instance),
    error => error instanceof UpstreamRoutingError && /morph\/fp8 отсутствует/.test(error.message),
  );
});
