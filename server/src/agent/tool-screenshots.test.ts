import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage } from "../types.js";
import { attachToolScreenshot, detectToolImage, detectToolScreenshot } from "./tool-screenshots.js";
import { MAX_INLINE_IMAGE_BYTES } from "../media/image-limits.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const BIG = Buffer.concat([PNG, Buffer.alloc(MAX_INLINE_IMAGE_BYTES + 1)]);

const baseMessage = (): ChatMessage => ({
  role: "user",
  content: "Проверь экран",
  images: [{ contentType: "image/png", data: "user-image" }],
});

test("снимок из результата инструмента становится временной картинкой следующего шага", async () => {
  const output = {
    ok: true,
    screenshot: {
      path: ".webnestdev/screenshots/shot.png",
      url: "/api/projects/p/screenshot?path=shot.png",
      bytes: PNG.length,
    },
  };
  const result = await attachToolScreenshot([baseMessage()], output, {
    projectId: "p",
    userId: "u",
    model: "vision-model",
    mainCanSee: true,
    readImage: async () => PNG,
  });
  assert.equal(result.attached, true);
  const last = result.messages.at(-1);
  assert.ok(last?.role === "user");
  assert.equal(last.images?.length, 2);
  assert.equal(last.images?.[0]?.data, "user-image");
  assert.equal(last.images?.[1]?.source, "tool");
  assert.equal(last.images?.[1]?.data, PNG.toString("base64"));
});

test("новый снимок заменяет предыдущий автоматический, но не вложения пользователя", async () => {
  const first = {
    screenshot: { path: ".webnestdev/screenshots/first.png", bytes: PNG.length },
  };
  const started = await attachToolScreenshot([baseMessage()], first, {
    projectId: "p",
    userId: "u",
    model: "vision-model",
    mainCanSee: true,
    readImage: async () => PNG,
  });
  const second = await attachToolScreenshot(started.messages, {
    screenshot: { path: ".webnestdev/screenshots/second.png", bytes: PNG.length },
  }, {
    projectId: "p",
    userId: "u",
    model: "vision-model",
    mainCanSee: true,
    readImage: async relative => relative.endsWith("second.png") ? PNG : Buffer.from("old"),
  });
  const images = (second.messages.at(-1) as Extract<ChatMessage, { role: "user" }>).images ?? [];
  assert.equal(images.length, 2);
  assert.equal(images[0]?.data, "user-image");
  assert.match(images[1]?.name ?? "", /second\.png$/);
});

test("оригинал больше лимита уходит в бакет, а в контекст идёт уменьшенная копия", async () => {
  const output = {
    screenshot: {
      path: ".webnestdev/screenshots/large.png",
      bytes: BIG.length,
      model: {
        path: ".webnestdev/screenshots/large.context.webp",
        bytes: PNG.length,
        contentType: "image/webp",
        width: 800,
        height: 600,
      },
    },
  };
  const uploaded: { bytes?: Buffer } = {};
  const result = await attachToolScreenshot([baseMessage()], output, {
    projectId: "p",
    userId: "u",
    model: "vision-model",
    mainCanSee: true,
    readImage: async relative => relative.endsWith(".context.webp") ? PNG : BIG,
    upload: async input => {
      uploaded.bytes = input.bytes;
      return { publicUrl: "https://storage.example/large.png" };
    },
  });
  assert.equal(uploaded.bytes?.length, BIG.length);
  assert.equal(result.attached, true);
  assert.equal(result.bucketUrl, "https://storage.example/large.png");
  assert.equal((output.screenshot as { bucketUrl?: string }).bucketUrl, "https://storage.example/large.png");
  const image = (result.messages.at(-1) as Extract<ChatMessage, { role: "user" }>).images?.at(-1);
  assert.equal(image?.data, PNG.toString("base64"));
});

test("текстовой модели снимок не отправляется, но большой оригинал всё равно сохраняется", async () => {
  const output = {
    screenshot: {
      path: ".webnestdev/screenshots/large.png",
      bytes: BIG.length,
      model: { path: ".webnestdev/screenshots/large.context.webp", bytes: PNG.length, contentType: "image/webp" },
    },
  };
  const result = await attachToolScreenshot([baseMessage()], output, {
    projectId: "p",
    userId: "u",
    model: "text-only",
    mainCanSee: false,
    readImage: async relative => relative.endsWith(".context.webp") ? PNG : BIG,
    upload: async () => ({ publicUrl: "https://storage.example/large.png" }),
  });
  assert.equal(result.attached, false);
  assert.equal(result.bucketUrl, "https://storage.example/large.png");
  const images = (result.messages.at(-1) as Extract<ChatMessage, { role: "user" }>).images ?? [];
  assert.equal(images.length, 1, "вложение пользователя не должно исчезнуть");
  assert.equal(images[0]?.data, "user-image");
});

test("image.view прикладывает файл из любой папки и не загружает его в бакет", async () => {
  const output = {
    ok: true,
    path: "public/hero.png",
    bytes: BIG.length,
    contentType: "image/png",
    viewImage: true,
  };
  let uploads = 0;
  const result = await attachToolScreenshot([baseMessage()], output, {
    projectId: "p",
    userId: "u",
    model: "vision-model",
    mainCanSee: true,
    readImage: async () => PNG,
    upload: async () => {
      uploads++;
      return { publicUrl: "https://storage.example/hero.png" };
    },
  });
  assert.equal(result.requestedView, true);
  assert.equal(result.attached, true);
  assert.equal(uploads, 0, "просмотр локального файла не тратит квоту бакета");
  const image = (result.messages.at(-1) as Extract<ChatMessage, { role: "user" }>).images?.at(-1);
  assert.equal(image?.source, "tool");
  assert.equal(image?.data, PNG.toString("base64"));
});

test("image.view понимает файл вне папки скриншотов, а обычный результат — нет", () => {
  assert.equal(detectToolImage({ viewImage: true, path: "public/images/hero.webp" })?.path, "public/images/hero.webp");
  assert.equal(detectToolImage({ path: "public/images/hero.webp" }), null, "без viewImage автоматически прикладываются только снимки browser.*");
});

test("снимок ищется в failureStep и последнем кадре сценария", () => {
  assert.equal(
    detectToolScreenshot({
      failedStep: { screenshot: { path: ".webnestdev/screenshots/failure.png" } },
      screenshots: [{ path: ".webnestdev/screenshots/step.png" }],
    })?.path,
    ".webnestdev/screenshots/failure.png",
  );
  assert.equal(
    detectToolScreenshot({
      screenshots: [
        { path: ".webnestdev/screenshots/first.png" },
        { path: ".webnestdev/screenshots/last.png" },
      ],
    })?.path,
    ".webnestdev/screenshots/last.png",
  );
  assert.equal(detectToolScreenshot({ screenshot: { path: "not-a-screenshot.png" } }), null);
});
