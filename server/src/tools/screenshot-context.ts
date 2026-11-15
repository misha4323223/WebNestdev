import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { CONTEXT_IMAGE_MAX_EDGE, CONTEXT_IMAGE_QUALITY, MAX_INLINE_IMAGE_BYTES } from "../media/image-limits.js";

/**
 * Уменьшенная копия скриншота для контекста главной модели.
 *
 * Оригинальный PNG остаётся файлом проекта: его открывает человек и по нему ищут дефект.
 * Модели же нужен кадр, который влезает в лимит вложения `4 МБ` и не раздувает каждый
 * следующий запрос. Перекодирование делает тот же Chromium, который уже стоит для
 * browser.*; отдельная библиотека для картинок в сервер не добавляется.
 *
 * Функция вызывается только для PNG больше лимита. Неудача — не ошибка снимка: остаётся
 * оригинал, а рантайм честно не притворяется, что модель увидела кадр.
 */
export type ScreenshotContext = {
  /** Путь внутри проекта рядом с оригиналом. */
  path: string;
  bytes: number;
  contentType: string;
  width: number;
  height: number;
};

const ATTEMPTS = [
  { edge: CONTEXT_IMAGE_MAX_EDGE, quality: CONTEXT_IMAGE_QUALITY },
  { edge: 1400, quality: 0.72 },
  { edge: 1100, quality: 0.65 },
] as const;

type Encoded = { dataUrl: string; width: number; height: number };

async function encodeInChromium(page: Page, source: string, edge: number, quality: number): Promise<Encoded | null> {
  const helper = await page.context().newPage();
  try {
    return await helper.evaluate(async input => {
      // Никаких локальных функций внутри evaluate: сборка через tsx подмешивает к ним __name,
      // которого нет в контексте страницы.
      const image = new Image();
      image.src = input.source;
      await image.decode();
      if (!image.naturalWidth || !image.naturalHeight) return null;
      const scale = Math.min(1, input.edge / Math.max(image.naturalWidth, image.naturalHeight));
      const width = Math.max(1, Math.round(image.naturalWidth * scale));
      const height = Math.max(1, Math.round(image.naturalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.drawImage(image, 0, 0, width, height);
      return { dataUrl: canvas.toDataURL("image/webp", input.quality), width, height };
    }, { source, edge, quality });
  } finally {
    await helper.close().catch(() => undefined);
  }
}

export async function makeScreenshotContext(
  page: Page,
  buffer: Buffer,
  input: { root: string; relative: string },
): Promise<ScreenshotContext | null> {
  if (buffer.length <= MAX_INLINE_IMAGE_BYTES) return null;
  const source = "data:image/png;base64," + buffer.toString("base64");
  for (const attempt of ATTEMPTS) {
    try {
      const encoded = await encodeInChromium(page, source, attempt.edge, attempt.quality);
      if (!encoded) return null;
      // Canvas может не знать WebP и молча вернуть PNG. Такую копию не выдаём за уменьшенную.
      if (!encoded.dataUrl.startsWith("data:image/webp;base64,")) return null;
      const payload = encoded.dataUrl.slice("data:image/webp;base64,".length);
      const bytes = Buffer.from(payload, "base64");
      if (!bytes.length || bytes.length > MAX_INLINE_IMAGE_BYTES) continue;
      const relative = input.relative.replace(/\.png$/i, "") + ".context.webp";
      await writeFile(path.join(input.root, relative), bytes);
      return { path: relative, bytes: bytes.length, contentType: "image/webp", width: encoded.width, height: encoded.height };
    } catch (error) {
      // Снимок важнее производной копии: оригинал уже записан, а причина остаётся в логе.
      console.warn("[screenshot] не удалось подготовить контекстную копию: " + (error instanceof Error ? error.message : String(error)));
      return null;
    }
  }
  return null;
}
