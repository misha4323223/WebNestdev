import { getPlatformEnv } from "../platform/platform-env.js";
import { assertPublicUrl, requestPage, type ResolveName } from "../web/read-url.js";

/**
 * Генерация изображений для проектов — то, что вызывает инструмент `image.generate`
 * (`server/src/tools/image-tools.ts`).
 *
 * Это не модель агента и не провайдер разговора: картинку по текстовому описанию рисует внешний
 * сервис, а сервер отправляет запрос и кладёт готовый файл в проект. Поэтому и переменные свои —
 * `PLATFORM_IMAGE_*`. Включение генерации не трогает ни один набор `PLATFORM_AI_*`: бесплатная
 * модель тарифа и платная модель платформы остаются теми же.
 *
 * Адрес (`PLATFORM_IMAGE_BASE_URL`) бывает двух видов, и по виду выбирается формат запроса:
 * - **Cloudflare Workers AI**: `https://api.cloudflare.com/client/v4/accounts/<Account ID>/ai/run` —
 *   имя модели дописывается к адресу (`@cf/black-forest-labs/flux-1-schnell`), ответ приходит
 *   либо JSON-ом с base64 (`result.image`), либо, у `stable-diffusion-*`, готовыми байтами PNG;
 * - **OpenAI-совместимая генерация картинок**: адрес `…/v1` (к нему дописывается
 *   `/images/generations`) или адрес, уже оканчивающийся на `/images/generations`.
 *
 * Ключи читаются через `getPlatformEnv`, поэтому их можно положить и в окружение выкатки, и в
 * панель «Ключи сервера» — значение из панели важнее и подхватывается без перезапуска. Ключей до
 * трёх: когда первый упирается в лимит аккаунта, запрос уходит к следующему.
 *
 * Запрос идёт тем же защищённым транспортом, что `web.read`/`net.request`: только https, только
 * публичные адреса, соединение по проверенному адресу (DNS при соединении не спрашивается).
 * Адрес берётся из настроек платформы, а не из аргументов инструмента, — модель не может отправить
 * ключ платформы на произвольный хост.
 */

const KEY_NAMES = ["PLATFORM_IMAGE_KEY_1", "PLATFORM_IMAGE_KEY_2", "PLATFORM_IMAGE_KEY_3"] as const;
const DEFAULT_PROVIDER = "Cloudflare Workers AI";
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export type ImageGenerationConfig = {
  providerName: string;
  baseUrl: string;
  model: string;
  keys: string[];
};

/** Как вызывать сервис: `cloudflare` — `/ai/run/<модель>`, `openai` — `/images/generations`. */
export type ImageApiStyle = "cloudflare" | "openai";

/**
 * Настроен ли инструмент целиком. Без адреса, модели или хотя бы одного ключа генерация выключена:
 * инструмент отвечает отказом с именами недостающих переменных, а не пустой картинкой.
 */
export function getImageGenerationConfig(): ImageGenerationConfig | null {
  const baseUrl = getPlatformEnv("PLATFORM_IMAGE_BASE_URL")?.trim();
  const model = getPlatformEnv("PLATFORM_IMAGE_MODEL")?.trim();
  if (!baseUrl || !model) return null;
  const keys: string[] = [];
  for (const name of KEY_NAMES) {
    const value = getPlatformEnv(name)?.trim();
    if (value && !keys.includes(value)) keys.push(value);
  }
  if (!keys.length) return null;
  return {
    providerName: getPlatformEnv("PLATFORM_IMAGE_PROVIDER")?.trim() || DEFAULT_PROVIDER,
    baseUrl,
    model,
    keys,
  };
}

/** Строка для лога старта: одна строка отвечает на «почему image.generate отказывает». */
export function describeImageGeneration() {
  const config = getImageGenerationConfig();
  if (!config) return "генерация изображений: PLATFORM_IMAGE_* не заданы, инструмент image.generate отвечает отказом";
  return "генерация изображений: " + config.providerName + " (" + config.model + "), ключей " + config.keys.length;
}

function trimSlashes(value: string) {
  return value.trim().replace(/\/+$/, "");
}

export function imageApiStyle(baseUrl: string): ImageApiStyle {
  return /\/ai\/run$/i.test(trimSlashes(baseUrl)) ? "cloudflare" : "openai";
}

/** Полный адрес запроса: у Cloudflare — адрес плюс имя модели, у OpenAI — адрес генерации. */
export function imageEndpoint(baseUrl: string, model: string): string {
  const base = trimSlashes(baseUrl);
  if (imageApiStyle(base) === "cloudflare") return base + "/" + model.trim().replace(/^\/+/, "");
  if (/\/images\/generations$/i.test(base)) return base;
  return base + "/images/generations";
}

export type ImageSize = { width: number; height: number };

/** «1024x1024» (и «×» тоже) — размер в том виде, в каком его понимает сервис картинок. */
export function parseImageSize(value: string | undefined): ImageSize | null {
  const match = /^(\d{2,4})\s*[x×]\s*(\d{2,4})$/i.exec(value?.trim() ?? "");
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 256 || width > 2048 || height < 256 || height > 2048) return null;
  return { width, height };
}

export type ImageRequest = { prompt: string; size?: string; negativePrompt?: string };

/**
 * Тело запроса. У Cloudflare поле «размер» уходит только тем моделям, чья схема его знает: Flux
 * рисует фиксированный кадр, и лишнее поле для него — отказ схемы, а не подсказка.
 */
export function imageRequestBody(style: ImageApiStyle, model: string, request: ImageRequest): Record<string, unknown> {
  const size = parseImageSize(request.size);
  if (style === "cloudflare") {
    const knowsSize = !/flux/i.test(model);
    return {
      prompt: request.prompt,
      ...(knowsSize && size ? { width: size.width, height: size.height } : {}),
      ...(knowsSize && request.negativePrompt ? { negative_prompt: request.negativePrompt } : {}),
    };
  }
  return {
    model,
    prompt: request.prompt,
    n: 1,
    ...(request.size ? { size: request.size } : {}),
    response_format: "b64_json",
  };
}

export type GeneratedImage = { bytes: Buffer; contentType: string };

/** Тип картинки по первым байтам: сервисы вроде Cloudflare отдают base64 без имени типа. */
export function sniffImageType(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

/** Расширение файла по типу картинки: у сервисов без имени типа оно берётся из самих байтов. */
export function imageFileExtension(contentType: string) {
  if (/jpe?g/i.test(contentType)) return ".jpg";
  if (/webp/i.test(contentType)) return ".webp";
  return ".png";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** Текст отказа провайдера: у Cloudflare это `errors[0].message`, у OpenAI-совместимых — `error.message`. */
export function providerErrorMessage(payload: unknown): string | null {
  const root = asRecord(payload);
  if (!root) return null;
  const errors = Array.isArray(root.errors) ? root.errors : [];
  const first = asRecord(errors[0]);
  if (typeof first?.message === "string" && first.message.trim()) return first.message.trim();
  const error = asRecord(root.error);
  if (typeof error?.message === "string" && error.message.trim()) return error.message.trim();
  if (typeof root.message === "string" && root.message.trim() && root.success !== true) return root.message.trim();
  if (root.success === false) return "сервис ответил success: false";
  return null;
}

function base64Payload(payload: unknown): string | null {
  const root = asRecord(payload);
  if (!root) return null;
  const result = asRecord(root.result);
  if (typeof result?.image === "string") return result.image;
  if (typeof root.image === "string") return root.image;
  const data = Array.isArray(root.data) ? asRecord(root.data[0]) : null;
  if (typeof data?.b64_json === "string") return data.b64_json;
  if (typeof root.b64_json === "string") return root.b64_json;
  return null;
}

function decodeBase64(value: string): Buffer {
  const body = value.includes(",") && value.trimStart().startsWith("data:") ? value.slice(value.indexOf(",") + 1) : value;
  return Buffer.from(body, "base64");
}

/**
 * Ответ сервиса → байты картинки. Ошибка приходит тем же путём (телом ответа), поэтому читается
 * здесь же — иначе JSON с отказом превратился бы в «картинку» из нуля байт.
 */
export function parseImageResponse(contentType: string | null, bytes: Buffer): GeneratedImage {
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (type.startsWith("image/")) {
    if (!bytes.length) throw new Error("сервис вернул пустое изображение");
    return { bytes, contentType: sniffImageType(bytes) ?? type };
  }
  const text = bytes.toString("utf8").trim();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("ответ сервиса — не изображение и не JSON: " + text.slice(0, 200));
  }
  const failure = providerErrorMessage(payload);
  const encoded = base64Payload(payload);
  if (!encoded) {
    const root = asRecord(payload);
    const first = Array.isArray(root?.data) ? asRecord(root.data[0]) : null;
    if (typeof first?.url === "string" && first.url.trim()) {
      throw new Error("сервис вернул ссылку на картинку, а не сами байты (response_format b64_json не поддержан)");
    }
    throw new Error(failure ?? "в ответе сервиса нет изображения");
  }
  if (failure) throw new Error(failure);
  const image = decodeBase64(encoded);
  if (!image.length) throw new Error("сервис вернул пустое изображение");
  return { bytes: image, contentType: sniffImageType(image) ?? "image/png" };
}

export type ImageAttempt = { status: number; contentType: string | null; bytes: Buffer };

/** Отправка одного запроса. Отделено от разбора ответа, чтобы тест шёл без сети. */
export type ImageSend = (input: { url: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<ImageAttempt>;

export type ImageGenerationDeps = { send?: ImageSend; resolve?: ResolveName };

export type GenerateImageOptions = { prompt: string; size?: string; negativePrompt?: string; signal?: AbortSignal };

export type GeneratedImageInfo = GeneratedImage & { providerName: string; model: string; keyIndex: number };

async function sendViaTransport(input: { url: string; headers: Record<string, string>; body: string; signal?: AbortSignal; resolve?: ResolveName }): Promise<ImageAttempt> {
  const checked = await assertPublicUrl(input.url, input.resolve);
  const signal = input.signal
    ? AbortSignal.any([input.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
    : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await requestPage(checked.url, checked.addresses, signal, {
    method: "POST",
    headers: input.headers,
    body: input.body,
    maxBytes: MAX_IMAGE_BYTES,
  });
  if (response.oversized) throw new Error("ответ сервиса больше лимита " + Math.round(MAX_IMAGE_BYTES / (1024 * 1024)) + " МБ");
  const raw = response.headers["content-type"];
  return {
    status: response.status,
    contentType: Array.isArray(raw) ? raw[0] ?? null : raw ?? null,
    bytes: response.bytes,
  };
}

/** Повторять с другим ключом есть смысл только на отказе доступа, лимите и сбое сервиса. */
function keySwitchable(status: number) {
  return status === 0 || status === 401 || status === 403 || status === 429 || status >= 500;
}

function failureText(attempt: ImageAttempt) {
  const text = attempt.bytes.toString("utf8").trim();
  try {
    return providerErrorMessage(JSON.parse(text)) ?? text.slice(0, 300) ?? "без объяснения";
  } catch {
    return text.slice(0, 300) || "без объяснения";
  }
}

/**
 * Картинка по описанию. Ключи перебираются по порядку, пока один не ответит: отказ доступа,
 * лимит частоты и сбой сервиса переводят запрос к следующему, а ошибка формата (400/404/422) —
 * это ошибка запроса или имени модели, и другой ключ её не исправит.
 */
export async function generateImage(
  config: ImageGenerationConfig,
  options: GenerateImageOptions,
  deps: ImageGenerationDeps = {},
): Promise<GeneratedImageInfo> {
  const send = deps.send ?? (input => sendViaTransport({ ...input, resolve: deps.resolve }));
  const style = imageApiStyle(config.baseUrl);
  const url = imageEndpoint(config.baseUrl, config.model);
  const body = JSON.stringify(imageRequestBody(style, config.model, options));
  const failures: string[] = [];
  for (const [index, key] of config.keys.entries()) {
    const attempt = await send({ url, headers: { authorization: "Bearer " + key, "content-type": "application/json" }, body, signal: options.signal });
    const ok = attempt.status >= 200 && attempt.status < 300;
    console.log("[image] " + config.model + " -> " + attempt.status + " key=#" + (index + 1) + (ok ? " bytes=" + attempt.bytes.length : ""));
    if (ok) {
      return { ...parseImageResponse(attempt.contentType, attempt.bytes), providerName: config.providerName, model: config.model, keyIndex: index };
    }
    const reason = failureText(attempt);
    if (!keySwitchable(attempt.status)) {
      throw new Error("сервис генерации отказал (" + attempt.status + "): " + reason);
    }
    failures.push("ключ #" + (index + 1) + " → " + attempt.status + ": " + reason);
  }
  throw new Error("ни один ключ генерации изображений не подошёл: " + failures.join("; "));
}
