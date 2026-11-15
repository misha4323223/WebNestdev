import path from "node:path";
import type { ChatMessage, MessageImage } from "../types.js";
import { isModelTextOnly } from "./attachments.js";
import { visionMode } from "../provider/vision.js";
import { imageContentType } from "../media/remote-image.js";
import { MAX_INLINE_IMAGE_BYTES, MAX_INLINE_IMAGES, MAX_TOOL_IMAGES } from "../media/image-limits.js";
import { uploadScreenshotBuffer } from "../media/media-upload.js";
import { getSandbox } from "../sandbox-manager.js";
import { readFileBytesInside, resolveInsideSandbox } from "../sandbox/path-guard.js";

/**
 * Скриншот инструмента как изображение для следующей модели.
 *
 * Вложения пользователя разбираются до старта запуска (agent/attachments.ts), а снимок
 * создаётся в середине цикла. Без этого модуля модель видела только путь и layout-числа, а
 * PNG оставался для человека. Здесь последний снимок становится временным изображением в
 * последнем сообщении пользователя: base64 не попадает ни в историю, ни в базу.
 *
 * Оригинал больше 4 МБ не отправляется в контекст: для него `saveScreenshot` уже подготовил
 * уменьшенную WebP-копию, а сам PNG при необходимости уходит в публичный бакет. Бакет — это
 * хранение, а не обход лимита провайдера.
 */

export type ScreenshotRef = {
  path: string;
  url?: string;
  bytes?: number;
  bucketUrl?: string;
  /** `view` — явный `image.view` по любому файлу проекта, а не автоматический снимок browser.*. */
  kind?: "screenshot" | "view";
  model?: { path: string; bytes: number; contentType: string; width?: number; height?: number };
};

type ScreenshotHolder = Record<string, unknown> & ScreenshotRef;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScreenshotPath(value: unknown): value is string {
  return typeof value === "string" && /^\.webnestdev\/screenshots\/.+\.(png|webp)$/i.test(value);
}

function isImagePath(value: unknown): value is string {
  return typeof value === "string" && /\.(png|jpe?g|webp|gif)$/i.test(value);
}

function asImage(value: unknown, anyPath: boolean): ScreenshotRef | null {
  if (!isObject(value)) return null;
  const imagePath = value.path;
  if (typeof imagePath !== "string") return null;
  if (anyPath ? !isImagePath(imagePath) : !isScreenshotPath(imagePath)) return null;
  const bytes = typeof value.bytes === "number" && Number.isFinite(value.bytes) ? value.bytes : undefined;
  const modelValue = isObject(value.model) ? value.model : null;
  const modelPath = modelValue?.path;
  const model = modelValue && typeof modelPath === "string" && (anyPath ? isImagePath(modelPath) : isScreenshotPath(modelPath))
    ? {
      path: modelPath,
      bytes: typeof modelValue.bytes === "number" ? modelValue.bytes : 0,
      contentType: typeof modelValue.contentType === "string" ? modelValue.contentType : "image/webp",
      ...(typeof modelValue.width === "number" ? { width: modelValue.width } : {}),
      ...(typeof modelValue.height === "number" ? { height: modelValue.height } : {}),
    }
    : undefined;
  return {
    path: imagePath,
    ...(typeof value.url === "string" ? { url: value.url } : {}),
    ...(bytes !== undefined ? { bytes } : {}),
    ...(typeof value.bucketUrl === "string" ? { bucketUrl: value.bucketUrl } : {}),
    ...(anyPath ? { kind: "view" as const } : { kind: "screenshot" as const }),
    ...(model ? { model } : {}),
  };
}

/**
 * Один снимок из результата инструмента: снимок проверки, автоматический failure PNG или
 * последний кадр сценария. Все остальные поля результата остаются текстом.
 */
export function detectToolScreenshot(output: unknown): ScreenshotRef | null {
  if (!isObject(output)) return null;
  const direct = asImage(output.screenshot, false);
  if (direct) return direct;
  if (isObject(output.failedStep)) {
    const failed = asImage(output.failedStep.screenshot, false);
    if (failed) return failed;
  }
  if (Array.isArray(output.screenshots)) {
    for (let index = output.screenshots.length - 1; index >= 0; index--) {
      const shot = asImage(output.screenshots[index], false);
      if (shot) return shot;
    }
  }
  return null;
}

/**
 * Изображение из результата инструмента: автоматический снимок browser.* или явный
 * `image.view` по любому файлу проекта. Второй путь нужен, когда модель хочет посмотреть
 * старый снимок или картинку из другой папки, а не только что созданный кадр.
 */
export function detectToolImage(output: unknown): ScreenshotRef | null {
  if (isObject(output) && output.viewImage === true) return asImage(output, true);
  return detectToolScreenshot(output);
}

function markBucketUrl(value: unknown, screenshotPath: string, bucketUrl: string, depth = 0) {
  if (depth > 6 || !value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) markBucketUrl(item, screenshotPath, bucketUrl, depth + 1);
    return;
  }
  const record = value as ScreenshotHolder;
  if (record.path === screenshotPath) record.bucketUrl = bucketUrl;
  for (const item of Object.values(record)) markBucketUrl(item, screenshotPath, bucketUrl, depth + 1);
}

function lastUserIndex(messages: ChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "user") return index;
  }
  return -1;
}

async function readProjectImage(projectId: string, userId: string, relative: string): Promise<Buffer | null> {
  const sandbox = await getSandbox(projectId, userId);
  const target = await resolveInsideSandbox(sandbox.root, path.join(sandbox.root, relative)).catch(() => null);
  if (!target) return null;
  return readFileBytesInside(sandbox.root, target).catch(() => null);
}

export type ToolScreenshotDeps = {
  projectId: string;
  userId: string;
  model: string;
  signal?: AbortSignal;
  /** Подмена для тестов: настоящий читает песочницу. */
  readImage?: (relative: string) => Promise<Buffer | null>;
  /** Подмена для тестов: настоящий грузит через media-store. */
  upload?: (input: { path: string; bytes: Buffer; contentType: string }) => Promise<{ publicUrl: string } | null>;
  /** Подмена для тестов: иначе решает режим зрения и память провайдера. */
  mainCanSee?: boolean;
};

export type ToolScreenshotResult = {
  output: unknown;
  messages: ChatMessage[];
  attached: boolean;
  /** Это был явный `image.view`, а не автоматический снимок. */
  requestedView: boolean;
  path?: string;
  bucketUrl?: string;
};

/**
 * Загрузить оригинал сверх лимита и, если модель умеет изображения, приложить последний снимок
 * к следующему шагу. Ошибки хранения или чтения не валят запуск: снимок всё равно остаётся
 * файлом проекта, а модель получает то, что действительно удалось прочитать.
 */
export async function attachToolScreenshot(
  messages: ChatMessage[],
  output: unknown,
  deps: ToolScreenshotDeps,
): Promise<ToolScreenshotResult> {
  const ref = detectToolImage(output);
  if (!ref) return { output, messages, attached: false, requestedView: false };
  const requestedView = ref.kind === "view";
  const readImage = deps.readImage ?? ((relative: string) => readProjectImage(deps.projectId, deps.userId, relative));

  let bucketUrl = ref.bucketUrl;
  // `image.view` — это просмотр уже лежащего файла, а не новый снимок: не тратим квоту
  // пользователя на загрузку оригинала, если рядом нет готовой контекстной копии.
  if (!requestedView && !bucketUrl && (ref.bytes ?? 0) > MAX_INLINE_IMAGE_BYTES) {
    try {
      const bytes = await readImage(ref.path);
      if (bytes && bytes.length > MAX_INLINE_IMAGE_BYTES && bytes.length <= 24 * 1024 * 1024) {
        const contentType = imageContentType(bytes);
        if (contentType) {
          const upload = deps.upload ?? (input => uploadScreenshotBuffer({
            userId: deps.userId,
            projectId: deps.projectId,
            name: input.path,
            bytes: input.bytes,
            contentType: input.contentType,
          }));
          const stored = await upload({ path: ref.path, bytes, contentType });
          if (stored?.publicUrl) {
            bucketUrl = stored.publicUrl;
            markBucketUrl(output, ref.path, bucketUrl);
          }
        }
      }
    } catch (error) {
      console.warn("[screenshot] не удалось загрузить оригинал в бакет: " + (error instanceof Error ? error.message : String(error)));
    }
  }

  const mainCanSee = deps.mainCanSee ?? (visionMode() !== "off" && !isModelTextOnly(deps.model));
  if (!mainCanSee) return { output, messages, attached: false, requestedView, path: ref.path, ...(bucketUrl ? { bucketUrl } : {}) };

  const candidate = ref.model && ref.model.bytes <= MAX_INLINE_IMAGE_BYTES ? ref.model.path : ref.path;
  const bytes = await readImage(candidate).catch(() => null);
  if (!bytes || !bytes.length || bytes.length > MAX_INLINE_IMAGE_BYTES) {
    return { output, messages, attached: false, requestedView, path: ref.path, ...(bucketUrl ? { bucketUrl } : {}) };
  }
  const contentType = imageContentType(bytes);
  if (!contentType) return { output, messages, attached: false, requestedView, path: ref.path, ...(bucketUrl ? { bucketUrl } : {}) };
  const image: MessageImage = {
    contentType,
    data: bytes.toString("base64"),
    name: path.basename(candidate),
    source: "tool",
  };

  const index = lastUserIndex(messages);
  if (index < 0) return { output, messages, attached: false, requestedView, path: ref.path, ...(bucketUrl ? { bucketUrl } : {}) };
  const target = messages[index] as Extract<ChatMessage, { role: "user" }>;
  const kept = (target.images ?? []).filter(item => item.source !== "tool").slice(0, MAX_INLINE_IMAGES);
  const fixed = [...messages];
  fixed[index] = { ...target, images: [...kept, image].slice(-(MAX_INLINE_IMAGES + MAX_TOOL_IMAGES)) };
  return { output, messages: fixed, attached: true, requestedView, path: ref.path, ...(bucketUrl ? { bucketUrl } : {}) };
}
