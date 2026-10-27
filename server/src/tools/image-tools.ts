import { lstat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { registerTool } from "../tool-registry.js";
import { createLimiter, positiveInt, type Slot } from "../concurrency.js";
import { getSandbox } from "../sandbox-manager.js";
import { writeFileInside } from "../sandbox/path-guard.js";
import { isSecretEnvFile, openDirsForSandbox, openFileForSandbox } from "../sandbox/permissions.js";
import { generateImage, getImageGenerationConfig, imageFileExtension } from "../provider/image-generation.js";

/**
 * `image.generate` — картинка по описанию, сохранённая в проект.
 *
 * Инструмент нужен там, где проекту нужна настоящая фотография или иллюстрация (обложка, фон,
 * карточка товара, аватар): агент описывает кадр словами, сервер просит картинку у сервиса
 * платформы и кладёт файл в проект — как обычный ассет, который можно подключить в разметке.
 *
 * Ключ здесь платформенный (`PLATFORM_IMAGE_*`), а не проектный: пользователю не нужно заводить
 * аккаунт сервиса картинок, чтобы получить фотографии в своём сайте. Поэтому адрес запроса берётся
 * только из настроек платформы — модель не может отправить ключ на произвольный хост. Работа идёт
 * через `provider/image-generation.ts`, где живут разбор ответов и перебор ключей.
 *
 * Файл пишется только внутрь проекта и никогда в `.git` или `.env*`; имя по умолчанию — по
 * описанию, поэтому второй такой же запрос не перезапишет первый.
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
  "Свои ключи проекту не нужны — это ключ платформы, и пользователь вносит его в панели «Ключи сервера». " +
  "Не подменяйте картинку заглушкой из интернета и не рисуйте её сами: скажите пользователю, какой переменной не хватает.";

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
    "Draw an image from a text prompt and save it into the project as a real asset — use it when the user's project needs a photo, illustration, logo, avatar or background and no ready file exists. " +
    "Input: {prompt, path?, size?, negativePrompt?}. The prompt decides everything: subject, style, framing, colours, mood — write it in the language of the request and in the shape of a caption, not as a command. " +
    "`size` is 'WxH' (for example 1024x1024) and is used only by models that accept it; `negativePrompt` is what must not appear. " +
    "Without `path` the file goes to public/images/<name>.<ext> and an existing file is never overwritten; with `path` that exact asset is replaced and the extension follows the real image format. " +
    "`show` is about the conversation, not the project: pass show:true when the user asked you to draw a picture for them to look at — the platform then shows the finished image in the chat under your answer, so do not paste it into your reply and do not add any image markup. " +
    "When you draw a picture as material for the project itself, omit `show` and just use the returned path in the code — nothing is shown in the chat in that case. " +
    "After a successful call, reference the returned path in the code like any other asset (a file under public/ is served from the site root) — never replace it with a placeholder service such as picsum.photos, placehold.co or an emoji. " +
    "The image costs the platform's own key, so the project needs no credentials; if the answer is not_configured, tell the user which PLATFORM_IMAGE_* variables are missing instead of drawing the picture another way. " +
    "Text inside the image is unreliable: for lettering use HTML/CSS over the picture.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["prompt"],
    properties: {
      prompt: { type: "string", description: "Описание кадра: сюжет, стиль, ракурс, свет и цвета. Английский обычно даёт лучший результат, но язык пользователя тоже работает." },
      path: { type: "string", description: "Куда положить файл внутри проекта, например public/images/hero.png. Без него — public/images/<имя по описанию>.<расширение>." },
      size: { type: "string", description: "Кадр в виде «1024x1024»; модели, которые его не принимают (Flux), рисуют фиксированный кадр." },
      negativePrompt: { type: "string", description: "Что не должно появиться на картинке (артефакты, лишний текст, люди); поддерживают не все модели." },
      show: { type: "boolean", description: "true — пользователь просил нарисовать картинку и должен увидеть её в чате. Не указывайте, когда картинка нужна самому проекту." },
    },
  },
  execute: async (input, context) => {
    const body = requestSchema.parse(input ?? {});
    const config = getImageGenerationConfig();
    if (!config) return { ok: false, code: "not_configured", error: NOT_CONFIGURED };

    const requested = body.path?.replace(/\\/g, "/");
    if (requested) {
      if (path.isAbsolute(requested) || requested.split("/").some(segment => segment === "..")) {
        throw new Error("Путь картинки должен быть относительным и не выходить за пределы проекта");
      }
      const name = requested.split("/").pop() ?? "";
      if (isSecretEnvFile(name)) throw new Error("Картинку нельзя записать в файл окружения: это перезаписало бы секреты проекта");
      if (requested === ".git" || requested.startsWith(".git/")) throw new Error("Писать картинку внутрь .git нельзя");
    }

    const sandbox = await getSandbox(context.projectId, context.userId);
    const slot: Slot = await imageLimiter.acquire(context.signal);
    try {
      const image = await generateImage(config, {
        prompt: body.prompt,
        ...(body.size ? { size: body.size } : {}),
        ...(body.negativePrompt ? { negativePrompt: body.negativePrompt } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      });
      const extension = imageFileExtension(image.contentType);
      const relative = requested
        ? withImageExtension(requested, image.contentType)
        : await freeImageName(sandbox.root, "public/images/" + defaultImageName(body.prompt) + extension);
      const written = await writeFileInside(sandbox.root, path.join(sandbox.root, relative), image.bytes);
      // Файл записан сервером от root: контейнер предпросмотра должен уметь его читать и заменять.
      await openDirsForSandbox(sandbox.root, path.dirname(written));
      await openFileForSandbox(written);
      // В журнал — модель, файл и размер. Ни ключа, ни адреса сервиса, ни самого описания.
      console.log("[image] " + config.model + " -> " + relative + " bytes=" + image.bytes.length + " project=" + context.projectId + (body.show ? " chat=yes" : ""));
      return {
        ok: true,
        path: relative,
        url: imageAssetUrl(context.projectId, relative),
        bytes: image.bytes.length,
        contentType: image.contentType,
        model: config.model,
        provider: config.providerName,
        // Признак для панели: картинку показывают в переписке. Он есть только когда о показе попросили.
        ...(body.show ? { shownInChat: true } : {}),
        hint:
          "Файл лежит в проекте. Ссылайтесь на него как на обычный ассет" +
          (relative.startsWith("public/") ? " — из public/ он отдаётся с корня сайта: \"/" + relative.slice("public/".length) + "\"" : "") +
          ". Не заменяйте его заглушкой из интернета и не вставляйте заново на каждом запуске: файл уже создан." +
          (body.show
            ? " Картинку панель уже показала пользователю в чате — не вставляйте её в ответ разметкой, просто скажите одной фразой, что нарисовано и где лежит файл."
            : ""),
      };
    } catch (error) {
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
