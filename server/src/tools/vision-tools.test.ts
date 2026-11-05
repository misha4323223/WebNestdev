import test from "node:test";
import assert from "node:assert/strict";
import { getTool } from "../tool-registry.js";
import { loadImageFromUrl } from "./vision-tools.js";
import "./vision-tools.js";

/** Без настроенной модели инструмент обязан сначала ответить not_configured, не трогая ссылку. */
async function withoutVisionModel<T>(run: () => Promise<T>): Promise<T> {
  const names = ["PLATFORM_VISION_MODEL", "PLATFORM_AI_MODEL", "AI_MODEL"] as const;
  const before = new Map(names.map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  try {
    return await run();
  } finally {
    for (const name of names) {
      const value = before.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("image.inspect без vision-модели честно отвечает not_configured и называет переменную", async () => {
  await withoutVisionModel(async () => {
    const tool = getTool("image.inspect");
    assert.ok(tool?.execute);
    const result = (await tool.execute({ path: "uploads/screenshot.webp" }, {
      projectId: "p",
      runId: "r",
      userId: "u",
    })) as { ok: boolean; code?: string; error?: string };
    assert.equal(result.ok, false);
    assert.equal(result.code, "not_configured");
    assert.match(result.error ?? "", /PLATFORM_VISION_MODEL/);
  });
});

test("image.inspect принимает ссылку на вложение вместо пути в проекте", async () => {
  await withoutVisionModel(async () => {
    const execute = getTool("image.inspect")?.execute;
    assert.ok(execute);
    const result = (await execute({ url: "https://storage.mwsapis.ru/media/u/p/photo.webp" }, {
      projectId: "p",
      runId: "r",
      userId: "u",
    })) as { ok: boolean; code?: string };
    assert.equal(result.ok, false);
    // Схема ссылку приняла: до загрузки дело дошло, отказ только из-за отсутствия модели.
    assert.equal(result.code, "not_configured");
  });
});

test("image.inspect отвергает два источника сразу и ни одного", async () => {
  const execute = getTool("image.inspect")?.execute;
  assert.ok(execute);
  const context = { projectId: "p", runId: "r", userId: "u" };
  await assert.rejects(() => execute({ path: "uploads/a.webp", url: "https://example.com/a.webp" }, context), /ровно один источник/);
  await assert.rejects(() => execute({}, context), /ровно один источник/);
});

test("ссылка на изображение открывается только как публичный http(s) адрес", async () => {
  const schema = await loadImageFromUrl("file:///etc/passwd");
  assert.equal(schema.ok, false);
  assert.equal(schema.ok === false && schema.code, "not_url");

  const metadata = await loadImageFromUrl("http://169.254.169.254/latest/meta-data/");
  assert.equal(metadata.ok, false);
  assert.equal(metadata.ok === false && metadata.code, "blocked_host");

  const loopback = await loadImageFromUrl("http://127.0.0.1:8787/api/health");
  assert.equal(loopback.ok, false);
  assert.equal(loopback.ok === false && loopback.code, "blocked_host");

  const port = await loadImageFromUrl("https://example.com:8443/a.png");
  assert.equal(port.ok, false);
  assert.equal(port.ok === false && port.code, "blocked_host");
});

test("имя, которое резолвится во внутренний адрес, не открывается", async () => {
  const result = await loadImageFromUrl("https://photos.example.com/a.webp", {
    resolve: async () => ["10.0.0.12"],
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, "blocked_host");
  assert.match(result.ok === false ? result.error : "", /внутренний адрес/);
});
