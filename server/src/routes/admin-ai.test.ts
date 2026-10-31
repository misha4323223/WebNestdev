import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_ENCRYPTION_KEY = "0123456789abcdef".repeat(4);
const root = await mkdtemp(path.join(tmpdir(), "admin-ai-"));
process.env.WEBNESTDEV_DATA_DIR = root;

const Fastify = (await import("fastify")).default;
const { registerAdminAiRoutes } = await import("./admin-ai.js");
const { createAdmin, createAdminSession } = await import("../admin/admin-store.js");

const seen: { value: { provider: string; baseUrl: string; model: string; token?: string } | null } = { value: null };
const app = Fastify();
await registerAdminAiRoutes(app, {
  testAi: async config => {
    seen.value = config;
    return { ok: true, provider: config.provider, model: config.model, latencyMs: 10, tools: true };
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
