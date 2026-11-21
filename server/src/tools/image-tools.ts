import { lstat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { registerTool } from "../tool-registry.js";
import { createLimiter, positiveInt, type Slot } from "../concurrency.js";
import { isSecretEnvFile } from "../sandbox/permissions.js";
import { generateImage, getImageGenerationConfig, imageFileExtension } from "../provider/image-generation.js";
import { accountPlanFor } from "../billing/store.js";
import { limitsForPlan } from "../account/plans.js";
import { consumeUsage, getUsageSnapshot, UsageLimitError } from "../account/usage-store.js";
import { MediaError, mediaConfigured } from "../media/media-store.js";
import { uploadMediaBuffer } from "../media/media-upload.js";

/**
 * `image.generate` — картинка по описанию, которая живёт в бакете платформы.
 *
 * Инструмент нужен там, где проекту нужна настоящая фотография или иллюстрация (обложка, фон,
 * карточка товара, аватар): агент описывает кадр словами, сервер просит картинку у сервиса
 * платформы и сразу загружает байты в публичное хранилище. Локальный файл в песочнице не
 * создаётся вообще: агент получает абсолютный URL и прописывает его в разметку. Так картинка,
 * сгенерированная ИИ, не занимает диск проекта и не теряется при пересборке контейнера.
 *
 * Ключ здесь платформенный (`PLATFORM_IMAGE_*`), а не проектный: пользователю не нужно заводить
 * аккаунт сервиса картинок, чтобы получить фотографии в своём сайте. Поэтому адрес запроса берётся
 * только из настроек платформы — модель не может отправить ключ на произвольный хост. Работа идёт
 * через `provider/image-generation.ts`, где живут разбор ответов и перебор ключей.
 */

const requestSchema = z.object({
  prompt: z.string().trim().min(3).max(2000),
  path: z.string().trim().min(1).max(300).optional(),
  size: z.string().trim().max(20).optional(),
  negativePrompt: z.string().trim().max(600).optional(),
  /** Показать готовую картинку в переписке: так просят, когда рисуют для человека, а не для кода. */
  show: z.boolean().optional(),
});

/** Ответ на ненастроенный сервер: агент называет пользователю переменные, а не рисует заглушку. */
const NOT_CONFIGURED =
  "Генерация изображений не настроена на сервере: не заданы PLATFORM_IMAGE_BASE_URL, PLATFORM_IMAGE_MODEL и PLATFORM_IMAGE_KEY_1. " +
  "Свои ключи проекту не нужны — это ключ платформы: администратор задаёт его через API платформенных ключей или .env. " +
  "Не подменяйте картинку заглушкой из интернета и не рисуйте её сами: скажите пользователю, какой переменной не хватает.";

const MEDIA_NOT_CONFIGURED =
  "Хранилище медиа не настроено: картинка не сохранена ни в бакет, ни на локальный диск. " +
  "Нужны MEDIA_S3_ENDPOINT, MEDIA_S3_BUCKET и сервисный аккаунт MWS (MWS_SA_KEY, MWS_SA_KEY_ID или MWS_SA_KEY_FILE). " +
  "Скажите пользователю, каких переменных не хватает; не подменяйте картинку локальным файлом.";

function quotaResponse(limit: number) {
  return {
    ok: false,
    code: "quota",
    error: "Достигнут дневной лимит генерации изображений: " + limit + " в день. Лимит обновится в 00:00 UTC.",
    hint: "Скажите пользователю, что на сегодня изображения закончились. Не подменяйте картинку заглушкой и не просите ключ: лимит относится к тарифу, а не к настройкам проекта.",
  };
}

/** Лимит одновременных генераций: картинка считается на чужой стороне, но ждёт её наш запрос. */
const imageLimiter = createLimiter(() => ({
  limit: positiveInt(process.env.IMAGE_MAX_CONCURRENT, 2),
  queueLimit: positiveInt(process.env.IMAGE_MAX_QUEUE, 4),
  waitTimeoutMs: positiveInt(process.env.IMAGE_QUEUE_TIMEOUT_MS, 60_000),
  busyLabel: "Генерация изображений",
}));

/** Имя файла по описанию: латиница из промпта, иначе просто `image`. */
export function defaultImageName(prompt: string) {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .replace(/-$/, "");
  return slug || "image";
}

/** Расширение файла приводится к настоящему формату: сервис вправе вернуть PNG вместо прошеного JPG. */
export function withImageExtension(target: string, contentType: string) {
  const extension = imageFileExtension(contentType);
  return /\.(png|jpe?g|webp)$/i.test(target) ? target.replace(/\.(png|jpe?g|webp)$/i, extension) : target + extension;
}

/** Адрес картинки проекта: по нему её открывает и панель «Файлы», и карточка в чате. */
export function imageAssetUrl(projectId: string, relative: string) {
  return "/api/projects/" + encodeURIComponent(projectId) + "/asset?path=" + encodeURIComponent(relative);
}

/** Свободное имя: одинаковые описания не затирают друг друга, пока пользователь не назовёт путь сам. */
export async function freeImageName(root: string, relative: string) {
  const exists = async (candidate: string) => Boolean(await lstat(path.join(root, candidate)).catch(() => null));
  if (!(await exists(relative))) return relative;
  const extension = path.posix.extname(relative);
  const base = relative.slice(0, relative.length - extension.length);
  for (let index = 2; index <= 20; index++) {
    const candidate = base + "-" + index + extension;
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error("В каталоге уже 20 картинок с таким именем: укажите path явно");
}

registerTool({
  name: "image.generate",
  description:
    "Draw an image from a text prompt; the image is uploaded to the platform bucket and returned as an absolute public URL — use this when the user's project needs a photo, illustration, logo, avatar or background and no ready file exists. " +
    "Input: {prompt, path?, size?, negativePrompt?}. The prompt decides everything: subject, style, framing, colours, mood — write it in the language of the request and in the shape of a caption, not as a command. " +
    "`size` is 'WxH' (for example 1024x1024) and is used only by models that accept it; `negativePrompt` is what must not appear. " +
    "No local media file is created: `path` only sets the object name, and the returned `url` is the only thing the code should use. Never download the image back into the project, never write image bytes into public/ and never reference a local media path. " +
    "`show` is about the conversation, not the project: pass show:true when the user asked you to draw a picture for them to look at — the platform then shows the finished image in the chat under your answer, so do not paste it into your reply and do not add any image markup. " +
    "When you draw a picture as material for the project itself, omit `show` and use the returned `url` in `<img>`, CSS, `poster`, metadata or data — nothing is shown in the chat in that case. " +
    "After a successful call, reference the returned URL — never replace it with a placeholder service such as picsum.photos, placehold.co or an emoji, and never re-generate the same image on every run. " +
    "The image costs the platform's own key, so the project needs no credentials; if the answer is not_configured or media_not_configured, tell the user which variables are missing instead of drawing the picture another way. " +
    "Text inside the image is unreliable: for lettering use HTML/CSS over the picture.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["prompt"],
    properties: {
      prompt: { type: "string", description: "Описание кадра: сюжет, стиль, ракурс, свет и цвета. Английский обычно даёт лучший результат, но язык пользователя тоже работает." },
      path: { type: "string", description: "Имя объекта в бакете, например public/images/hero.png; каталог в нём не создаётся. Без него — <имя по описанию>.<расширение>. Локальный файл не создаётся в любом случае." },
      size: { type: "string", description: "Кадр в виде «1024x1024»; модели, которые его не принимают (Flux), рисуют фиксированный кадр." },
      negativePrompt: { type: "string", description: "Что не должно появиться на картинке (артефакты, лишний текст, люди); поддерживают не все модели." },
      show: { type: "boolean", description: "true — пользователь просил нарисовать картинку и должен увидеть её в чате. Не указывайте, когда картинка нужна самому проекту." },
    },
  },
  execute: async (input, context) => {
    const body = requestSchema.parse(input ?? {});
    const config = getImageGenerationConfig();
    if (!config) return { ok: false, code: "not_configured", error: NOT_CONFIGURED };

    const plan = await accountPlanFor(context.userId);
    const imageLimit = limitsForPlan(plan).imagesPerDay;
    if (imageLimit !== null) {
      const usage = await getUsageSnapshot(context.userId);
      if (usage.images >= imageLimit) return quotaResponse(imageLimit);
    }

    const requested = body.path?.replace(/\\/g, "/");
    if (requested) {
      if (path.isAbsolute(requested) || requested.split("/").some(segment => segment === "..")) {
        throw new Error("Путь картинки должен быть относительным и не выходить за пределы проекта");
      }
      const name = requested.split("/").pop() ?? "";
      if (isSecretEnvFile(name)) throw new Error("Картинку нельзя записать в файл окружения: это перезаписало бы секреты проекта");
      if (requested === ".git" || requested.startsWith(".git/")) throw new Error("Писать картинку внутрь .git нельзя");
    }

    try {
      if (!mediaConfigured()) return { ok: false, code: "media_not_configured", error: MEDIA_NOT_CONFIGURED };
    } catch (error) {
      return {
        ok: false,
        code: "media_not_configured",
        error: MEDIA_NOT_CONFIGURED + " Причина: " + (error instanceof Error ? error.message : String(error)),
      };
    }

    const slot: Slot = await imageLimiter.acquire(context.signal);
    try {
      const image = await generateImage(config, {
        prompt: body.prompt,
        ...(body.size ? { size: body.size } : {}),
        ...(body.negativePrompt ? { negativePrompt: body.negativePrompt } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      });
      const extension = imageFileExtension(image.contentType);
      const stem = requested
        ? path.posix.basename(requested).replace(/\.[^.]+$/, "")
        : defaultImageName(body.prompt);
      const name = (stem || "image") + extension;
      const stored = await uploadMediaBuffer({
        userId: context.userId,
        projectId: context.projectId,
        name,
        bytes: image.bytes,
        contentType: image.contentType,
      });
      if (!stored) return { ok: false, code: "media_not_configured", error: MEDIA_NOT_CONFIGURED };
      // Дневной лимит списываем только после успешной загрузки: сбой хранилища не должен
      // съедать попытку пользователя.
      try {
        await consumeUsage(context.userId, "images", plan);
      } catch (error) {
        if (error instanceof UsageLimitError) return quotaResponse(error.limit);
        throw error;
      }
      // В журнал — модель, ключ и размер. Ни ключа сервиса, ни адреса сервиса, ни самого описания.
      console.log("[image] " + config.model + " -> " + stored.key + " bytes=" + stored.bytes + " project=" + context.projectId + (body.show ? " chat=yes" : ""));
      return {
        ok: true,
        url: stored.publicUrl,
        key: stored.key,
        name,
        bytes: stored.bytes,
        contentType: image.contentType,
        model: config.model,
        provider: config.providerName,
        stored: "bucket",
        // Признак для панели: картинку показывают в переписке. Он есть только когда о показе попросили.
        ...(body.show ? { shownInChat: true } : {}),
        hint:
          "Картинка загружена в бакет платформы; локального файла в проекте нет. Пропишите в коде этот абсолютный URL: " +
          stored.publicUrl +
          ". Не скачивайте его обратно в песочницу, не копируйте байты в public/ и не заменяйте заглушкой из интернета. " +
          "Ссылка постоянная, поэтому её можно хранить в данных, использовать в <img>, CSS background-image, poster и метаданных." +
          (body.show
            ? " Картинку панель уже показала пользователю в чате — не вставляйте её в ответ разметкой, просто скажите одной фразой, что нарисовано."
            : ""),
      };
    } catch (error) {
      if (error instanceof MediaError) {
        return {
          ok: false,
          code: error.code,
          error: error.message,
          hint: "Картинка не сохранена. Не подменяйте её локальным файлом или заглушкой: сообщите пользователю причину отказа хранилища.",
        };
      }
      return {
        ok: false,
        code: "failed",
        error: "Не удалось сгенерировать изображение: " + (error instanceof Error ? error.message : String(error)),
        hint: "Проверьте описание и повторите один раз; при повторном отказе скажите пользователю, что сервис картинок не ответил, — не подменяйте результат заглушкой.",
      };
    } finally {
      slot.release();
    }
  },
});
