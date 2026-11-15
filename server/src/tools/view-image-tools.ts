import { lstat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { registerTool } from "../tool-registry.js";
import { getSandbox } from "../sandbox-manager.js";
import { readFileBytesInside, resolveInsideSandbox } from "../sandbox/path-guard.js";
import { assertNotSecretProjectPath } from "../secrets/secret-paths.js";
import { imageContentType, MAX_IMAGE_BYTES } from "../media/remote-image.js";
import { MAX_INLINE_IMAGE_BYTES } from "../media/image-limits.js";

/**
 * `image.view` — прямой просмотр локального изображения главной моделью.
 *
 * `image.inspect` — текстовый разбор через отдельную модель зрения. Он полезен, когда главная
 * модель текстовая, но именно из-за него агент «переодевался» в vision, хотя рядом лежал
 * собственный PNG. Здесь путь любой: `.webnestdev/screenshots/…`, `public/images/…`, загруженный
 * пользователем файл. Инструмент только читает файл и возвращает ссылку; рантайм сам прикладывает
 * байты к следующему шагу, поэтому base64 не попадает ни в историю, ни в результат инструмента.
 *
 * Для PNG больше 4 МБ используется готовая `.context.webp`-копия, которую создаёт
 * `tools/screenshot-context.ts`. Если копии нет, инструмент честно отказывает: отправлять
 * 10-мегабайтный оригинал в контекст нельзя.
 */

const requestSchema = z.object({
  path: z.string().trim().min(1).max(400),
});

const CONTEXT_SUFFIX = ".context.webp";

function contextPathFor(relative: string) {
  return relative.replace(/\.(png|jpe?g|webp|gif)$/i, "") + CONTEXT_SUFFIX;
}

registerTool({
  name: "image.view",
  description:
    "Attach an existing local image to your own context. Use this when you need to actually see a screenshot, photo, diagram or UI asset that is a file in the project — any PNG/JPEG/WebP/GIF under any directory, not only .webnestdev/screenshots. The image is put in front of the main model on the next step; do not call image.inspect for the same file when you want to see it yourself. For a PNG larger than 4 MB the prepared .context.webp copy is used when it exists. If the main model cannot accept images, the tool reports vision_unavailable honestly instead of pretending; only then use image.inspect for a textual vision review, or tell the user the visual check is unavailable.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: {
        type: "string",
        description: "Путь к изображению внутри проекта: .webnestdev/screenshots/…, public/images/hero.webp, загруженный пользователем файл. PNG, JPEG, WebP или GIF.",
      },
    },
  },
  execute: async (input, context) => {
    const body = requestSchema.parse(input ?? {});
    const relative = body.path.replace(/\\/g, "/");
    assertNotSecretProjectPath(relative, "смотреть");
    const sandbox = await getSandbox(context.projectId, context.userId);
    const target = await resolveInsideSandbox(sandbox.root, path.join(sandbox.root, relative)).catch(() => null);
    if (!target) return { ok: false, code: "not_found", error: "Изображение не найдено внутри проекта: " + relative };
    const info = await lstat(target).catch(() => null);
    if (!info?.isFile()) return { ok: false, code: "not_found", error: "Это не файл изображения: " + relative };

    let contentType: string | null = null;
    let bytes: Buffer | null = null;
    if (info.size <= MAX_IMAGE_BYTES) {
      bytes = await readFileBytesInside(sandbox.root, target);
      contentType = imageContentType(bytes);
      if (!contentType) {
        return {
          ok: false,
          code: "unsupported",
          error: "Это не PNG/JPEG/WebP/GIF: главная модель принимает только растровые изображения. SVG и другие форматы не отправляются.",
          path: relative,
        };
      }
    }

    let model: { path: string; bytes: number; contentType: string } | undefined;
    if (info.size > MAX_INLINE_IMAGE_BYTES) {
      const contextRelative = contextPathFor(relative);
      const contextTarget = await resolveInsideSandbox(sandbox.root, path.join(sandbox.root, contextRelative)).catch(() => null);
      const contextInfo = contextTarget ? await lstat(contextTarget).catch(() => null) : null;
      if (contextTarget && contextInfo?.isFile() && contextInfo.size <= MAX_INLINE_IMAGE_BYTES) {
        const contextBytes = await readFileBytesInside(sandbox.root, contextTarget);
        const contextType = imageContentType(contextBytes);
        if (contextType && contextBytes.length <= MAX_INLINE_IMAGE_BYTES) {
          model = { path: contextRelative, bytes: contextBytes.length, contentType: contextType };
        }
      }
      if (!model) {
        return {
          ok: false,
          code: "too_large",
          error: "Изображение больше 4 МБ, а готовой уменьшенной копии рядом нет: " + relative,
          hint: "Для PNG из browser.* копия .context.webp создаётся автоматически. Другой файл уменьшите или посмотрите его через image.inspect — текстовый разбор принимает до 10 МБ.",
          path: relative,
          bytes: info.size,
        };
      }
    }

    return {
      ok: true,
      path: relative,
      bytes: info.size,
      contentType: contentType ?? model?.contentType ?? "image/webp",
      viewImage: true,
      ...(model ? { model } : {}),
      hint: "Изображение будет приложено к следующему шагу. Посмотрите на него напрямую; не вызывайте image.inspect для этого же файла.",
    };
  },
});
