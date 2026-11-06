import type { ChatMessage, MessageImage } from "../types.js";
import { imageContentType, loadImageFromUrl } from "../media/remote-image.js";
import { readFileBytesInside, resolveInsideSandbox } from "../sandbox/path-guard.js";
import { getSandbox } from "../sandbox-manager.js";
import { describeImage, getDedicatedVisionConfig, visionMode, type VisionMode } from "../provider/vision.js";
import path from "node:path";

/**
 * Вложения пользователя в контексте главной модели.
 *
 * Раньше картинка из чата жила только ссылкой: сообщение содержало публичный URL из бакета, а
 * «увидеть» её агент мог единственным способом — инструментом `image.inspect`, который делал
 * второй запрос к отдельной модели. Именно этот путь и ломался: если отдельная модель не задана,
 * запрос уходил в главную, а та либо не мультимодальна, либо шлюз выбрасывает изображение — и
 * инструмент честно падал с «vision-провайдер вернул пустой ответ».
 *
 * Здесь другая схема, без второй модели по умолчанию:
 *
 * 1. байты вложения подставляются прямо в сообщение пользователя (`ChatMessage.images`), и
 *    главная модель видит картинку так же, как текст;
 * 2. в историю они не попадают: сессия хранит текст со ссылкой, base64 живёт только в запросе
 *    этого запуска (см. `MessageImage`);
 * 3. если главная модель не умеет изображения (задан режим `off` или провайдер уже отказал по
 *    картинке — см. `markModelTextOnly`), работает отдельная модель зрения из админки, а её
 *    описание вставляется в сообщение текстом;
 * 4. если и её нет, модель получает честную заметку «изображение недоступно», а не выдумку.
 */

/** Сколько картинок одного сообщения отправляем модели: каждая — это токены и деньги. */
export const MAX_INLINE_IMAGES = 2;
/** Предел одной картинки: больше — это уже не скриншот интерфейса, а фото в полном разрешении. */
export const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;

/**
 * Хвост, который панель дописывает к сообщению (`withAttachments` в AgentPanel): по нему сервер
 * узнаёт, какие вложения человек приложил, не меняя формат хранения разговора.
 */
const ATTACHMENT_TAIL = /\s*Эти файлы уже (?:доступны|лежат в проекте, используй их по путям):\s*([\s\S]*)$/;
const ATTACHMENT_LINE = /^-\s+(.+?)\s+\((изображение по публичной ссылке|файл по публичной ссылке|изображение в проекте|файл в проекте|публичная ссылка в хранилище)\)\s*$/;

export type AttachmentRef = { value: string; remote: boolean; image: boolean };

/** Вложения из служебного хвоста сообщения; сообщение без хвоста даёт пустой список. */
export function parseAttachments(text: string): AttachmentRef[] {
  const tail = ATTACHMENT_TAIL.exec(text ?? "");
  if (!tail) return [];
  const refs: AttachmentRef[] = [];
  for (const line of (tail[1] ?? "").split("\n")) {
    const match = ATTACHMENT_LINE.exec(line.trim());
    if (!match) continue;
    const value = (match[1] ?? "").trim();
    const label = match[2] ?? "";
    if (!value) continue;
    refs.push({
      value,
      remote: label.includes("ссылк"),
      image: label.startsWith("изображение") || label === "публичная ссылка в хранилище",
    });
  }
  return refs;
}

/** Только изображения: файлы и документы в контекст модели не подставляются. */
export function attachedImages(text: string): AttachmentRef[] {
  return parseAttachments(text).filter(ref => ref.image);
}

export type AttachmentDeps = {
  projectId: string;
  userId: string;
  signal?: AbortSignal;
  /** Подмена загрузчика в тестах: настоящий ходит в сеть и в бакет. */
  loadRemote?: typeof loadImageFromUrl;
};

/**
 * Байты одного вложения. Ссылка грузится защищённым загрузчиком (он же у `web.read`), локальный
 * путь читается только внутри песочницы проекта — вложение не может оказаться `/etc/passwd`.
 */
export async function readAttachedImage(ref: AttachmentRef, deps: AttachmentDeps): Promise<MessageImage | null> {
  if (ref.remote) {
    const load = deps.loadRemote ?? loadImageFromUrl;
    const loaded = await load(ref.value, {
      ...(deps.signal ? { signal: deps.signal } : {}),
      maxBytes: MAX_INLINE_IMAGE_BYTES,
    });
    if (!loaded.ok) return null;
    return { contentType: loaded.contentType, data: loaded.bytes.toString("base64"), name: nameOf(ref.value) };
  }
  try {
    const sandbox = await getSandbox(deps.projectId, deps.userId);
    const target = await resolveInsideSandbox(sandbox.root, path.join(sandbox.root, ref.value));
    const bytes = await readFileBytesInside(sandbox.root, target);
    if (!bytes.length || bytes.length > MAX_INLINE_IMAGE_BYTES) return null;
    const contentType = imageContentType(bytes);
    if (!contentType) return null;
    return { contentType, data: bytes.toString("base64"), name: path.basename(ref.value) };
  } catch {
    return null;
  }
}

function nameOf(value: string) {
  try {
    return path.basename(new URL(value).pathname) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Модели, которые уже отказались принимать изображения. Память процесса, а не настройка: свойство
 * модели на этом хосте, а не решение человека, и после перезапуска проверка просто повторится.
 */
const textOnlyModels = new Set<string>();

export function markModelTextOnly(model: string) {
  const key = model.trim().toLowerCase();
  if (key) textOnlyModels.add(key);
}

export function isModelTextOnly(model: string) {
  return textOnlyModels.has(model.trim().toLowerCase());
}

/** Тестам нужен чистый список: отказ одной модели не должен влиять на следующий прогон. */
export function resetTextOnlyModels() {
  textOnlyModels.clear();
}

/** Признак того, что отказ провайдера — про изображения, а не про сам запрос. */
export function isImageRejection(detail: string) {
  return /image|vision|multimodal|content part|unsupported content|image_url|does not support/i.test(detail ?? "");
}

/** Изображения, вложенные в сообщения (для отката и описания). */
export function collectInlineImages(messages: ChatMessage[]): MessageImage[] {
  const images: MessageImage[] = [];
  for (const message of messages) {
    if (message.role === "user" && message.images?.length) images.push(...message.images);
  }
  return images.slice(0, MAX_INLINE_IMAGES);
}

/** Снять base64 со всех сообщений: после отказа провайдеру отправляется тот же шаг, но текстом. */
export function dropInlineImages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(message => {
    if (message.role !== "user" || !message.images?.length) return message;
    const { images: _images, ...rest } = message;
    return rest as ChatMessage;
  });
}

/**
 * Описание изображений отдельной моделью зрения — тот самый второй проход, но осознанный:
 * результат становится текстом сообщения, а не ответом инструмента.
 */
export async function describeImages(images: MessageImage[], options: { signal?: AbortSignal } = {}): Promise<string | null> {
  const config = getDedicatedVisionConfig();
  if (!config || !images.length) return null;
  const parts: string[] = [];
  for (const image of images) {
    try {
      const result = await describeImage(
        config,
        { bytes: Buffer.from(image.data, "base64"), contentType: image.contentType },
        options.signal ? { signal: options.signal } : {},
      );
      if (result.trim()) parts.push(result.trim());
    } catch (error) {
      console.error("[vision] модель зрения не ответила: " + (error instanceof Error ? error.message : String(error)));
    }
  }
  return parts.length ? parts.join("\n\n") : null;
}

const TEXT_ONLY_NOTE =
  "[ИЗОБРАЖЕНИЕ] Пользователь приложил изображение, но передать его основной модели нельзя: она не принимает картинки, а отдельная модель зрения в админке не настроена. " +
  "Не утверждайте, что видели изображение, и не описывайте его по догадкам. Скажите пользователю, что визуальная проверка недоступна, и предложите настроить модель зрения.";

const DESC_PREFIX = "[ИЗОБРАЖЕНИЕ — описание модели зрения]\n";
const DESC_SUFFIX =
  "\n\nЭто описание сделала отдельная модель зрения: сама основная модель картинку не получила. Опирайтесь на него и не утверждайте, что видели больше, чем в нём сказано.";

export type InlineResult = {
  messages: ChatMessage[];
  /** Сколько изображений реально ушло в контекст. */
  attached: number;
  /** Описание сделано моделью зрения (главная модель изображения не получала). */
  described: boolean;
  /** Изображение было, но передать его нечем. */
  unavailable: boolean;
};

function appendToUserMessage(message: ChatMessage, addition: string): ChatMessage {
  if (message.role !== "user") return message;
  return { role: "user", content: message.content ? message.content + "\n\n" + addition : addition };
}

/**
 * Подготовить сообщения запуска: вложения → изображения в контексте главной модели (или их
 * описание, если она не умеет). Возвращает новый массив — исходная история сессии не меняется.
 */
export async function inlineAttachedImages(
  messages: ChatMessage[],
  deps: AttachmentDeps & { model: string; mode?: VisionMode },
): Promise<InlineResult> {
  const index = (() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === "user") return i;
    return -1;
  })();
  if (index < 0) return { messages, attached: 0, described: false, unavailable: false };
  const target = messages[index] as Extract<ChatMessage, { role: "user" }>;
  const refs = attachedImages(target.content).slice(0, MAX_INLINE_IMAGES);
  if (!refs.length) return { messages, attached: 0, described: false, unavailable: false };

  const mode = deps.mode ?? visionMode();
  const mainCanSee = mode !== "off" && !isModelTextOnly(deps.model);

  if (mainCanSee) {
    const images: MessageImage[] = [];
    for (const ref of refs) {
      const image = await readAttachedImage(ref, deps);
      if (image) images.push(image);
    }
    if (!images.length) {
      // Ссылка не открылась или файл не картинка: модель должна знать, что смотреть было нечего.
      const fixed = [...messages];
      fixed[index] = appendToUserMessage(target, TEXT_ONLY_NOTE);
      return { messages: fixed, attached: 0, described: false, unavailable: true };
    }
    const fixed = [...messages];
    fixed[index] = { ...target, images };
    return { messages: fixed, attached: images.length, described: false, unavailable: false };
  }

  // Главная модель изображения не принимает: единственный честный путь — описание.
  const images: MessageImage[] = [];
  for (const ref of refs) {
    const image = await readAttachedImage(ref, deps);
    if (image) images.push(image);
  }
  const description = images.length ? await describeImages(images, deps.signal ? { signal: deps.signal } : {}) : null;
  const fixed = [...messages];
  fixed[index] = description
    ? appendToUserMessage(target, DESC_PREFIX + description + DESC_SUFFIX)
    : appendToUserMessage(target, TEXT_ONLY_NOTE);
  return { messages: fixed, attached: 0, described: Boolean(description), unavailable: !description };
}

/**
 * Заметка модели о том, как она получила изображение. Без неё описание модели зрения читается
 * как собственные наблюдения, и агент уверенно говорит «я вижу» о том, чего не видел.
 */
export function visionNotice(result: InlineResult): string | null {
  if (result.attached) return null;
  if (result.described) {
    return "IMAGE VIA VISION MODEL: the user attached an image, but the main model cannot accept images, so a separate vision model described it and the description is inside the user message. " +
      "Work from that description, refer to it as the vision model's description rather than your own view, and do not claim you saw more than it says.";
  }
  if (result.unavailable) {
    return "IMAGE NOT AVAILABLE: the user attached an image but it could not be shown to you (the main model does not accept images and no vision model is configured in the admin panel). " +
      "Do not describe it from guesses. Tell the user in one short sentence that the visual check is unavailable and what has to be configured.";
  }
  return null;
}

/**
 * Добавить описание в последнее сообщение пользователя — путь отката из step-runner, когда
 * провайдер отказал уже на первом шаге с изображением в запросе.
 */
export function withImageDescription(messages: ChatMessage[], description: string | null): ChatMessage[] {
  const index = (() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === "user") return i;
    return -1;
  })();
  if (index < 0) return messages;
  const fixed = [...messages];
  fixed[index] = appendToUserMessage(
    fixed[index]!,
    description ? DESC_PREFIX + description + DESC_SUFFIX : TEXT_ONLY_NOTE,
  );
  return fixed;
}
