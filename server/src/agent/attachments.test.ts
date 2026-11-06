import assert from "node:assert/strict";
import test from "node:test";
import {
  attachedImages,
  collectInlineImages,
  dropInlineImages,
  inlineAttachedImages,
  isImageRejection,
  isModelTextOnly,
  markModelTextOnly,
  parseAttachments,
  resetTextOnlyModels,
  visionNotice,
  withImageDescription,
} from "./attachments.js";
import type { ChatMessage } from "../types.js";

/** Настоящий PNG 1×1: тип определяется по байтам, а не по расширению. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const message = (text: string): ChatMessage => ({ role: "user", content: text });
const tail = (lines: string[]) => "\n\nЭти файлы уже доступны:\n" + lines.join("\n");

test("вложения разбираются из служебного хвоста сообщения", () => {
  const text =
    "Поправь вёрстку" +
    tail([
      "- https://storage.mwsapis.ru/bucket/media/a/2026/11/shot.png (изображение по публичной ссылке)",
      "- uploads/logo.webp (изображение в проекте)",
      "- reports/spec.pdf (файл по публичной ссылке)",
    ]);
  const refs = parseAttachments(text);
  assert.deepEqual(refs, [
    { value: "https://storage.mwsapis.ru/bucket/media/a/2026/11/shot.png", remote: true, image: true },
    { value: "uploads/logo.webp", remote: false, image: true },
    { value: "reports/spec.pdf", remote: true, image: false },
  ]);
  assert.deepEqual(attachedImages(text).map(ref => ref.value), [
    "https://storage.mwsapis.ru/bucket/media/a/2026/11/shot.png",
    "uploads/logo.webp",
  ]);
  // Сообщение без хвоста — это обычный текст, а не сломанный формат.
  assert.deepEqual(parseAttachments("просто задача"), []);
});

test("картинка вложения уходит в контекст главной модели", async () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "инструкции" },
    message(
      "Что не так с экраном?" +
        tail([
          "- https://cdn.example/shot.png (изображение по публичной ссылке)",
          "- https://cdn.example/second.png (изображение по публичной ссылке)",
          "- https://cdn.example/third.png (изображение по публичной ссылке)",
        ]),
    ),
  ];
  const loaded: string[] = [];
  const result = await inlineAttachedImages(messages, {
    projectId: "p",
    userId: "u",
    model: "vision-capable-model",
    mode: "auto",
    loadRemote: async url => {
      loaded.push(url);
      return { ok: true, bytes: PNG, contentType: "image/png", finalUrl: url };
    },
  });
  assert.equal(result.attached, 2, "в контекст идут не больше двух картинок");
  assert.equal(result.described, false);
  const target = result.messages.at(-1);
  assert.ok(target && target.role === "user");
  assert.equal(target.images?.length, 2);
  assert.equal(target.images?.[0]?.contentType, "image/png");
  assert.equal(target.images?.[0]?.data, PNG.toString("base64"));
  assert.equal(loaded.length, 2);
  // Исходный массив не меняется: история сессии остаётся текстом со ссылкой.
  assert.equal((messages[1] as { images?: unknown }).images, undefined);
  assert.equal(visionNotice(result), null);
});

test("нечитаемая ссылка не валит запуск, а даёт честную заметку", async () => {
  const result = await inlineAttachedImages(
    [message("Посмотри" + tail(["- https://cdn.example/broken.png (изображение по публичной ссылке)"]))],
    {
      projectId: "p",
      userId: "u",
      model: "vision-capable-model",
      mode: "auto",
      loadRemote: async () => ({ ok: false, code: "unavailable", error: "нет ответа" }),
    },
  );
  assert.equal(result.attached, 0);
  assert.equal(result.unavailable, true);
  assert.match((result.messages.at(-1) as { content: string }).content, /изображение/i);
  assert.match(visionNotice(result) ?? "", /IMAGE NOT AVAILABLE/);
});

test("текстовая модель без модели зрения получает отказ, а не выдумку", async () => {
  const previous = { model: process.env.PLATFORM_VISION_MODEL, base: process.env.PLATFORM_VISION_BASE_URL };
  delete process.env.PLATFORM_VISION_MODEL;
  try {
    const result = await inlineAttachedImages(
      [message("Что тут?" + tail(["- https://cdn.example/shot.png (изображение по публичной ссылке)"]))],
      {
        projectId: "p",
        userId: "u",
        model: "text-only-model",
        mode: "off",
        loadRemote: async url => ({ ok: true, bytes: PNG, contentType: "image/png", finalUrl: url }),
      },
    );
    assert.equal(result.attached, 0);
    assert.equal(result.described, false);
    assert.equal(result.unavailable, true);
    assert.match(visionNotice(result) ?? "", /IMAGE NOT AVAILABLE/);
  } finally {
    if (previous.model !== undefined) process.env.PLATFORM_VISION_MODEL = previous.model;
    if (previous.base !== undefined) process.env.PLATFORM_VISION_BASE_URL = previous.base;
  }
});

test("модель зрения из админки описывает картинку для текстовой модели", async () => {
  const previous = {
    model: process.env.PLATFORM_VISION_MODEL,
    base: process.env.PLATFORM_VISION_BASE_URL,
    key: process.env.PLATFORM_VISION_API_KEY,
    proxy: process.env.AI_PROXY_URL,
  };
  process.env.PLATFORM_VISION_MODEL = "vision-x";
  process.env.PLATFORM_VISION_BASE_URL = "https://vision.example/v1";
  process.env.PLATFORM_VISION_API_KEY = "vision-key";
  delete process.env.AI_PROXY_URL;
  const originalFetch = globalThis.fetch;
  let sent: { authorization?: string; body?: string } = {};
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent = {
      ...(init.headers ? { authorization: (init.headers as Record<string, string>).authorization } : {}),
      body: String(init.body ?? ""),
    };
    return new Response(JSON.stringify({ choices: [{ message: { content: "Тёмная форма входа по центру" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const result = await inlineAttachedImages(
      [message("Что тут?" + tail(["- https://cdn.example/shot.png (изображение по публичной ссылке)"]))],
      {
        projectId: "p",
        userId: "u",
        model: "text-only-model",
        mode: "off",
        loadRemote: async url => ({ ok: true, bytes: PNG, contentType: "image/png", finalUrl: url }),
      },
    );
    assert.equal(result.described, true);
    assert.equal(result.unavailable, false);
    assert.ok(!(result.messages.at(-1) as { images?: unknown }).images, "текстовой модели картинка не отправляется");
    assert.match((result.messages.at(-1) as { content: string }).content, /Тёмная форма входа по центру/);
    assert.match(visionNotice(result) ?? "", /IMAGE VIA VISION MODEL/);
    assert.equal(sent.authorization, "Bearer vision-key");
    assert.match(sent.body ?? "", /vision-x/);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries({
      PLATFORM_VISION_MODEL: previous.model,
      PLATFORM_VISION_BASE_URL: previous.base,
      PLATFORM_VISION_API_KEY: previous.key,
      AI_PROXY_URL: previous.proxy,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("модель, отказавшая по картинке, запоминается как текстовая", () => {
  resetTextOnlyModels();
  assert.equal(isModelTextOnly("some-model"), false);
  markModelTextOnly("Some-Model");
  assert.equal(isModelTextOnly("some-model"), true);
  resetTextOnlyModels();
  assert.equal(isModelTextOnly("some-model"), false);
});

test("отказ провайдера про изображения отличается от отказа про сам запрос", () => {
  assert.equal(isImageRejection('{"error":{"message":"This model does not support image_url content"}}'), true);
  assert.equal(isImageRejection("invalid multimodal content part"), true);
  assert.equal(isImageRejection("messages[0].content: string required"), false);
  assert.equal(isImageRejection("model not found"), false);
});

test("картинки снимаются, описание вставляется в сообщение пользователя", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "инструкции" },
    { role: "user", content: "Посмотри экран", images: [{ contentType: "image/png", data: "AAAA" }] },
  ];
  assert.equal(collectInlineImages(messages).length, 1);
  const dropped = dropInlineImages(messages);
  assert.equal((dropped[1] as { images?: unknown }).images, undefined);
  assert.equal(collectInlineImages(dropped).length, 0);

  const described = withImageDescription(dropped, "На экране тёмная форма входа");
  const content = (described[1] as { content: string }).content;
  assert.match(content, /На экране тёмная форма входа/);
  assert.match(content, /описание модели зрения/i);
});
