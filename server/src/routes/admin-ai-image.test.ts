import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Генерация изображений настраивается из внешней админки: адрес, модель, провайдер и токен.
 * Проверяем то, что важно на практике: ключ не возвращается, пустой ключ не стирает сохранённый,
 * а `clearKeys` действительно выключает генерацию.
 */
process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_ENCRYPTION_KEY = "0123456789abcdef".repeat(4);
const root = await mkdtemp(path.join(tmpdir(), "admin-image-"));
process.env.WEBNESTDEV_DATA_DIR = root;

const MANAGED = [
  "PLATFORM_IMAGE_BASE_URL",
  "PLATFORM_IMAGE_MODEL",
  "PLATFORM_IMAGE_PROVIDER",
  "PLATFORM_IMAGE_KEY_1",
  "PLATFORM_IMAGE_KEY_2",
  "PLATFORM_IMAGE_KEY_3",
] as const;
const previous = new Map(MANAGED.map(name => [name, process.env[name]]));
for (const name of MANAGED) delete process.env[name];

const Fastify = (await import("fastify")).default;
const { registerAdminAiImageRoutes } = await import("./admin-ai-image.js");
const { createAdmin, createAdminSession } = await import("../admin/admin-store.js");

const app = Fastify();
await registerAdminAiImageRoutes(app);
await app.ready();

const admin = await createAdmin("image-admin@example.test", "correct-horse-battery");
const session = await createAdminSession(admin.id);
const auth = { authorization: "Bearer " + session.token };

test.after(async () => {
  await app.close();
  for (const [name, value] of previous) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(root, { recursive: true, force: true });
  delete process.env.WEBNESTDEV_STORAGE;
  delete process.env.WEBNESTDEV_DATA_DIR;
  delete process.env.WEBNESTDEV_ENCRYPTION_KEY;
});

test("настройка картинок без входа недоступна", async () => {
  const response = await app.inject({ method: "GET", url: "/api/admin/ai/image" });
  assert.equal(response.statusCode, 401);
});

test("без настроек статус честно называет недостающие переменные", async () => {
  const response = await app.inject({ method: "GET", url: "/api/admin/ai/image", headers: auth });
  assert.equal(response.statusCode, 200);
  const image = response.json().image;
  assert.equal(image.configured, false);
  assert.equal(image.hasKey, false);
  assert.equal(image.keyCount, 0);
  assert.deepEqual(image.missing, ["PLATFORM_IMAGE_BASE_URL", "PLATFORM_IMAGE_MODEL", "PLATFORM_IMAGE_KEY_1"]);
});

test("админка сохраняет Base URL, модель и токен, но не возвращает токен", async () => {
  const saved = await app.inject({
    method: "POST",
    url: "/api/admin/ai/image",
    headers: auth,
    payload: {
      baseUrl: "https://images.example/v1",
      model: "image-model-1",
      provider: "Image Gateway",
      apiKey: "image-secret-value",
    },
  });
  assert.equal(saved.statusCode, 200);
  const image = saved.json().image;
  assert.equal(saved.json().saved, true);
  assert.equal(image.configured, true);
  assert.equal(image.baseUrl, "https://images.example/v1");
  assert.equal(image.model, "image-model-1");
  assert.equal(image.provider, "Image Gateway");
  assert.equal(image.apiStyle, "openai");
  assert.equal(image.hasKey, true);
  assert.equal(image.keyCount, 1);
  assert.equal(image.keySource, "panel");
  assert.deepEqual(image.sources, { baseUrl: "panel", model: "panel", provider: "panel" });
  assert.ok(!saved.body.includes("image-secret-value"), "токен не должен вернуться в ответе");
});

test("пустой apiKey сохраняет текущий токен, а clearKeys выключает генерацию", async () => {
  const changed = await app.inject({
    method: "POST",
    url: "/api/admin/ai/image",
    headers: auth,
    payload: { model: "image-model-2", apiKey: "" },
  });
  assert.equal(changed.statusCode, 200);
  assert.equal(changed.json().image.model, "image-model-2");
  assert.equal(changed.json().image.hasKey, true, "пустой ключ означает «оставить сохранённый»");

  const cleared = await app.inject({
    method: "POST",
    url: "/api/admin/ai/image",
    headers: auth,
    payload: { clearKeys: true },
  });
  assert.equal(cleared.statusCode, 200);
  assert.equal(cleared.json().image.configured, false);
  assert.equal(cleared.json().image.hasKey, false);
  assert.equal(cleared.json().image.keyCount, 0);
  assert.equal(cleared.json().image.keySource, "none");
  assert.deepEqual(cleared.json().image.missing, ["PLATFORM_IMAGE_KEY_1"]);
});

test("некорректный адрес и одновременный ключ с очисткой отклоняются", async () => {
  const ftp = await app.inject({
    method: "POST",
    url: "/api/admin/ai/image",
    headers: auth,
    payload: { baseUrl: "ftp://images.example" },
  });
  assert.equal(ftp.statusCode, 400);

  const conflict = await app.inject({
    method: "POST",
    url: "/api/admin/ai/image",
    headers: auth,
    payload: { apiKey: "new-secret", clearKeys: true },
  });
  assert.equal(conflict.statusCode, 400);
});
