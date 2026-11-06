import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

/**
 * Модель зрения настраивается из внешней админки. Проверяем три вещи, которые важны на практике:
 * сохранение не возвращает ключ, режим `off` читается обратно, а проверка связи честно говорит
 * «не принимает изображения», когда модель отвечает пустым текстом.
 */
process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_ENCRYPTION_KEY = "0123456789abcdef".repeat(4);
const root = await mkdtemp(path.join(tmpdir(), "admin-vision-"));
process.env.WEBNESTDEV_DATA_DIR = root;

const Fastify = (await import("fastify")).default;
const { registerAdminAiRoutes } = await import("./admin-ai.js");
const { createAdmin, createAdminSession } = await import("../admin/admin-store.js");

const probes: { model: string; provider: string; key: string; bytes: number }[] = [];
let probeAnswer = "На изображении один пиксель";

const app = Fastify();
await registerAdminAiRoutes(app, {
  probeVision: async (config, bytes) => {
    probes.push({ model: config.model, provider: config.provider, key: config.key, bytes: bytes.length });
    return probeAnswer;
  },
});
await app.ready();

const admin = await createAdmin("vision-admin@example.test", "correct-horse-battery");
const session = await createAdminSession(admin.id);
const auth = { authorization: "Bearer " + session.token };

test.after(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
  delete process.env.WEBNESTDEV_STORAGE;
  delete process.env.WEBNESTDEV_DATA_DIR;
  delete process.env.WEBNESTDEV_ENCRYPTION_KEY;
});

test("модель зрения без входа недоступна", async () => {
  const response = await app.inject({ method: "GET", url: "/api/admin/ai/vision" });
  assert.equal(response.statusCode, 401);
});

test("админка сохраняет модель зрения и не возвращает ключ", async () => {
  const empty = await app.inject({ method: "GET", url: "/api/admin/ai/vision", headers: auth });
  assert.equal(empty.statusCode, 200);
  assert.equal(empty.json().vision.dedicated, false);
  assert.equal(empty.json().vision.mode, "auto");

  const saved = await app.inject({
    method: "POST",
    url: "/api/admin/ai/vision",
    headers: auth,
    payload: { model: "gpt-4o-mini", baseUrl: "https://vision.example/v1", provider: "Vision Gateway", apiKey: "vision-secret" },
  });
  assert.equal(saved.statusCode, 200);
  const body = saved.json() as { saved: boolean; vision: { dedicated: boolean; model: string; keySet: boolean; baseUrl: string } };
  assert.equal(body.saved, true);
  assert.equal(body.vision.dedicated, true);
  assert.equal(body.vision.model, "gpt-4o-mini");
  assert.equal(body.vision.keySet, true);
  assert.equal(body.vision.baseUrl, "https://vision.example/v1");
  assert.ok(!saved.body.includes("vision-secret"), "ключ не должен вернуться в ответе");

  const listed = await app.inject({ method: "GET", url: "/api/admin/ai", headers: auth });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().vision.model, "gpt-4o-mini");
  assert.ok(!listed.body.includes("vision-secret"));
});

test("проверка модели зрения берёт сохранённый ключ и говорит правду о пустом ответе", async () => {
  probeAnswer = "На изображении один пиксель";
  const ok = await app.inject({
    method: "POST",
    url: "/api/admin/ai/vision/test",
    headers: auth,
    payload: { model: "gpt-4o-mini" },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().ok, true);
  assert.equal(ok.json().latencyMs >= 0, true);
  assert.equal(probes.at(-1)?.key, "vision-secret", "без нового ключа проверяется сохранённый");
  assert.equal(probes.at(-1)?.model, "gpt-4o-mini");
  assert.ok((probes.at(-1)?.bytes ?? 0) > 0, "на проверку уходит настоящая картинка");

  probeAnswer = "   ";
  const empty = await app.inject({
    method: "POST",
    url: "/api/admin/ai/vision/test",
    headers: auth,
    payload: { model: "gpt-4o-mini" },
  });
  assert.equal(empty.json().ok, false);
  assert.match(empty.json().error, /пуст/i);
});

test("режим off сохраняется, а пустая модель возвращает поведение по умолчанию", async () => {
  const off = await app.inject({
    method: "POST",
    url: "/api/admin/ai/vision",
    headers: auth,
    payload: { mode: "off" },
  });
  assert.equal(off.statusCode, 200);
  assert.equal(off.json().vision.mode, "off");

  const cleared = await app.inject({
    method: "POST",
    url: "/api/admin/ai/vision",
    headers: auth,
    payload: { model: "", mode: "auto" },
  });
  assert.equal(cleared.statusCode, 200);
  assert.equal(cleared.json().vision.dedicated, false);
  assert.equal(cleared.json().vision.mode, "auto");
});
