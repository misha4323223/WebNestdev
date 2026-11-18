import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getTool } from "../tool-registry.js";

/**
 * Инструмент проверяется через настоящий вызов, как и остальные: отказ «не настроено» и запрет
 * путей вне проекта должны быть видны модели текстом и не зависеть от сети. Хранилище уводится во
 * временный каталог до импорта модулей, которые читают настройки при загрузке.
 */
const data = await mkdtemp(path.join(os.tmpdir(), "webnestdev-image-"));
process.env.WEBNESTDEV_DATA_DIR = data;
process.env.WEBNESTDEV_SANDBOX_DIR = path.join(data, "sandboxes");
const { createProject } = await import("../project-store.js");
const { consumeUsage } = await import("../account/usage-store.js");
const { defaultImageName, freeImageName, withImageExtension } = await import("./image-tools.js");

const NAMES = [
  "PLATFORM_IMAGE_BASE_URL", "PLATFORM_IMAGE_MODEL", "PLATFORM_IMAGE_PROVIDER",
  "PLATFORM_IMAGE_KEY_1", "PLATFORM_IMAGE_KEY_2", "PLATFORM_IMAGE_KEY_3",
  "MEDIA_S3_ENDPOINT", "MEDIA_S3_BUCKET", "MEDIA_S3_PREFIX", "MEDIA_PUBLIC_BASE_URL",
];

function configure() {
  process.env.PLATFORM_IMAGE_BASE_URL = "https://api.cloudflare.com/client/v4/accounts/acc/ai/run";
  process.env.PLATFORM_IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
  process.env.PLATFORM_IMAGE_KEY_1 = "cf-key";
}

function clear() {
  for (const name of NAMES) delete process.env[name];
}

type Result = { ok: boolean; code?: string; error?: string };

test("без PLATFORM_IMAGE_* инструмент отвечает отказом и называет переменные", async t => {
  t.after(() => rm(data, { recursive: true, force: true }));
  clear();
  const project = await createProject("Картинки без настройки", undefined, "u-image-1");
  const tool = getTool("image.generate");
  assert.ok(tool?.execute);
  const execute = tool.execute;
  const result = (await execute({ prompt: "кот в шляпе" }, { projectId: project.id, runId: "r", userId: "u-image-1" })) as Result;
  assert.equal(result.ok, false);
  assert.equal(result.code, "not_configured");
  assert.match(result.error ?? "", /PLATFORM_IMAGE_BASE_URL, PLATFORM_IMAGE_MODEL и PLATFORM_IMAGE_KEY_1/, "модель должна узнать, чего не хватает");
  clear();
});

test("без хранилища медиа картинка не пишется на локальный диск", async t => {
  t.after(() => rm(data, { recursive: true, force: true }));
  configure();
  clear();
  configure();
  const userId = "u-image-media";
  const project = await createProject("Картинки без бакета", undefined, userId);
  const tool = getTool("image.generate");
  assert.ok(tool?.execute);
  const result = (await tool.execute({ prompt: "кот в шляпе" }, { projectId: project.id, runId: "r", userId })) as Result;
  assert.equal(result.ok, false);
  assert.equal(result.code, "media_not_configured");
  assert.match(result.error ?? "", /MEDIA_S3_ENDPOINT/);
  clear();
});

test("после пяти изображений инструмент отказывает до запроса к сервису", async t => {
  t.after(() => rm(data, { recursive: true, force: true }));
  configure();
  const userId = "u-image-quota";
  const project = await createProject("Картинки квоты", undefined, userId);
  for (let index = 0; index < 5; index++) await consumeUsage(userId, "images", "free");
  const tool = getTool("image.generate");
  assert.ok(tool?.execute);
  const result = (await tool.execute({ prompt: "кот в шляпе" }, { projectId: project.id, runId: "r", userId })) as Result;
  assert.equal(result.ok, false);
  assert.equal(result.code, "quota");
  assert.match(result.error ?? "", /5 в день/);
  clear();
});

test("картинку нельзя записать за пределы проекта, в .git или в файл окружения", async t => {
  t.after(() => rm(data, { recursive: true, force: true }));
  configure();
  const project = await createProject("Картинки пути", undefined, "u-image-2");
  const tool = getTool("image.generate");
  assert.ok(tool?.execute);
  const execute = tool.execute;
  const context = { projectId: project.id, runId: "r", userId: "u-image-2" };

  await assert.rejects(() => execute({ prompt: "кот", path: "../hero.png" }, context), /не выходить за пределы проекта/);
  await assert.rejects(() => execute({ prompt: "кот", path: "/tmp/hero.png" }, context), /должен быть относительным/);
  await assert.rejects(() => execute({ prompt: "кот", path: ".env.local" }, context), /файл окружения/);
  await assert.rejects(() => execute({ prompt: "кот", path: ".git/hooks/pre-commit" }, context), /внутрь \.git/);
  clear();
});

test("имя файла берётся из описания, расширение — из настоящего формата картинки", async t => {
  t.after(() => rm(data, { recursive: true, force: true }));
  assert.equal(defaultImageName("Hero section with a mountain lake"), "hero-section-with-a-mountain-lake");
  assert.equal(defaultImageName("Красивый кот в шляпе"), "image", "кириллица в имя файла не попадает");
  assert.equal(defaultImageName("###"), "image");
  assert.equal(withImageExtension("public/hero.jpg", "image/png"), "public/hero.png", "расширение следует формату ответа");
  assert.equal(withImageExtension("public/hero", "image/webp"), "public/hero.webp");
  assert.equal(withImageExtension("assets/hero.png", "image/jpeg"), "assets/hero.jpg");

  // Одинаковые описания не затирают друг друга: свободное имя добавляет номер.
  const root = path.join(data, "sandboxes", "unique");
  await mkdir(path.join(root, "public", "images"), { recursive: true });
  await writeFile(path.join(root, "public", "images", "image.png"), "старая картинка");
  assert.equal(await freeImageName(root, "public/images/image.png"), "public/images/image-2.png");
  assert.equal(await freeImageName(root, "public/images/new.png"), "public/images/new.png");
});
