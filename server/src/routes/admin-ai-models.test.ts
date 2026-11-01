import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_ENCRYPTION_KEY = "0123456789abcdef".repeat(4);
const root = await mkdtemp(path.join(tmpdir(), "admin-ai-models-"));
process.env.WEBNESTDEV_DATA_DIR = root;

const Fastify = (await import("fastify")).default;
const { registerAdminAiModelsRoutes } = await import("./admin-ai-models.js");
const { createAdmin, createAdminSession } = await import("../admin/admin-store.js");

const seen: { value: { provider: string; baseUrl: string; model: string; token?: string; routing?: { mode: string } } | null } = { value: null };
const app = Fastify();
await registerAdminAiModelsRoutes(app, {
  testAi: async config => {
    seen.value = config;
    return { ok: true, provider: config.provider, model: config.model, latencyMs: 10, tools: true };
  },
});
await app.ready();

const admin = await createAdmin("models-admin@example.test", "correct-horse-battery");
const session = await createAdminSession(admin.id);
const auth = { authorization: "Bearer " + session.token };

test.after(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
  delete process.env.WEBNESTDEV_STORAGE;
  delete process.env.WEBNESTDEV_DATA_DIR;
  delete process.env.WEBNESTDEV_ENCRYPTION_KEY;
});

test("каталог моделей закрыт без входа администратора", async () => {
  const response = await app.inject({ method: "GET", url: "/api/admin/ai/models" });
  assert.equal(response.statusCode, 401);
});

test("модель добавляется, ключ не попадает в ответ, обновление сохраняет ключ", async () => {
  const created = await app.inject({
    method: "PUT",
    url: "/api/admin/ai/models/max",
    headers: auth,
    payload: {
      name: "NestDev Max",
      description: "Для сложных задач",
      provider: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "anthropic/claude-sonnet",
      apiKey: "sk-max-secret",
      plans: ["pro", "team"],
      creditRates: { inputPerMillion: 300, outputPerMillion: 3_000, minimumPerRun: 2 },
      routing: { mode: "fixed", providers: ["morph/fp8", "open-inference/fp4"] },
    },
  });
  assert.equal(created.statusCode, 201);
  const body = created.json() as { saved: boolean; model: { id: string; name: string; hasKey: boolean; creditRates: unknown; routing: unknown } };
  assert.equal(body.saved, true);
  assert.equal(body.model.id, "max");
  assert.equal(body.model.name, "NestDev Max");
  assert.equal(body.model.hasKey, true);
  assert.deepEqual(body.model.creditRates, { inputPerMillion: 300, outputPerMillion: 3_000, minimumPerRun: 2 });
  assert.deepEqual(body.model.routing, {
    mode: "fixed",
    providers: ["morph/fp8", "open-inference/fp4"],
    allowFallback: true,
    fallbackToAuto: false,
    assumedInputPerOutput: 10,
  });
  assert.ok(!created.body.includes("sk-max-secret"));

  const changed = await app.inject({
    method: "PATCH",
    url: "/api/admin/ai/models/max",
    headers: auth,
    payload: { name: "NestDev Max Pro" },
  });
  assert.equal(changed.statusCode, 200);
  assert.equal(changed.json().model.name, "NestDev Max Pro");
  assert.equal(changed.json().model.hasKey, true);
  assert.ok(!changed.body.includes("sk-max-secret"));

  const rates = await app.inject({
    method: "PATCH",
    url: "/api/admin/ai/models/max",
    headers: auth,
    payload: { creditRates: { outputPerMillion: 3_500 } },
  });
  assert.equal(rates.statusCode, 200);
  assert.deepEqual(rates.json().model.creditRates, { inputPerMillion: 300, outputPerMillion: 3_500, minimumPerRun: 2 });

  const listed = await app.inject({ method: "GET", url: "/api/admin/ai/models", headers: auth });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().models.length, 1);
  assert.ok(!listed.body.includes("sk-max-secret"));
});

test("для mini достаточно адреса, модели и ключа: имя и провайдер подставляются", async () => {
  const created = await app.inject({
    method: "PUT",
    url: "/api/admin/ai/models/mini",
    headers: auth,
    payload: { baseUrl: "https://api.example.com/v1", model: "mini-model", apiKey: "sk-mini-secret" },
  });
  assert.equal(created.statusCode, 201);
  const body = created.json() as { model: { name: string; provider: string; hasKey: boolean; creditRates: { inputPerMillion: number } } };
  assert.equal(body.model.name, "NestDev Mini");
  assert.equal(body.model.provider, "OpenAI-compatible");
  assert.equal(body.model.hasKey, true);
  assert.equal(body.model.creditRates.inputPerMillion, 25);
  assert.ok(!created.body.includes("sk-mini-secret"));
  await app.inject({ method: "DELETE", url: "/api/admin/ai/models/mini", headers: auth });
});

test("маршрутизация Max обновляется и сбрасывается в auto", async () => {
  const changed = await app.inject({
    method: "PATCH",
    url: "/api/admin/ai/models/max",
    headers: auth,
    payload: { routing: { mode: "cheapest", assumedInputPerOutput: 30 } },
  });
  assert.equal(changed.statusCode, 200);
  assert.equal(changed.json().model.routing.mode, "cheapest");
  assert.equal(changed.json().model.routing.assumedInputPerOutput, 30);

  const reset = await app.inject({
    method: "PATCH",
    url: "/api/admin/ai/models/max",
    headers: auth,
    payload: { routing: null },
  });
  assert.equal(reset.statusCode, 200);
  assert.equal(reset.json().model.routing.mode, "auto");

  const invalid = await app.inject({
    method: "PATCH",
    url: "/api/admin/ai/models/max",
    headers: auth,
    payload: { routing: { mode: "fixed", providers: [] } },
  });
  assert.equal(invalid.statusCode, 400);
  assert.match(invalid.json().error, /routing:.*хотя бы одного/);
});

test("проверка модели использует сохранённый ключ и не возвращает его", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/ai/models/test",
    headers: auth,
    payload: { id: "max" },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().ok, true);
  assert.equal(seen.value?.token, "sk-max-secret");
  assert.equal(seen.value?.routing?.mode, "auto", "проверка берёт сохранённую цепочку модели");
  assert.ok(!response.body.includes("sk-max-secret"));
});

test("удаление убирает модель из каталога", async () => {
  const deleted = await app.inject({ method: "DELETE", url: "/api/admin/ai/models/max", headers: auth });
  assert.equal(deleted.statusCode, 200);
  const listed = await app.inject({ method: "GET", url: "/api/admin/ai/models", headers: auth });
  assert.equal(listed.json().models.length, 0);
});
