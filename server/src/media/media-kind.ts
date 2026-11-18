/**
 * Определение изображения и видео по имени и content-type.
 *
 * Это единственное место, где решается «это медиа или обычный файл»: от ответа зависит,
 * уйдёт ли содержимое в бакет или останется обычным файлом проекта. Поэтому проверяются оба
 * признака — серверы часто отдают картинку с `application/octet-stream`, а расширение бывает
 * потеряно в URL.
 */

const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "webp", "gif", "avif", "bmp", "svg", "ico",
  "tif", "tiff", "heic", "heif", "jxl",
]);

const VIDEO_EXTENSIONS = new Set([
  "mp4", "m4v", "webm", "mov", "avi", "mkv", "ogv", "mpeg", "mpg", "3gp", "mts", "m2ts",
]);

export type MediaKind = "image" | "video";

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  gif: "image/gif", avif: "image/avif", bmp: "image/bmp", svg: "image/svg+xml",
  ico: "image/x-icon", tif: "image/tiff", tiff: "image/tiff", heic: "image/heic", heif: "image/heif",
  mp4: "video/mp4", m4v: "video/x-m4v", webm: "video/webm", mov: "video/quicktime",
  avi: "video/x-msvideo", mkv: "video/x-matroska", ogv: "video/ogg",
  mpeg: "video/mpeg", mpg: "video/mpeg", "3gp": "video/3gpp", mts: "video/mp2t", m2ts: "video/mp2t",
};

function extensionOf(name: string) {
  const clean = name.split(/[?#]/)[0] ?? "";
  const dot = clean.lastIndexOf(".");
  return dot >= 0 ? clean.slice(dot + 1).toLowerCase() : "";
}

export function mediaKindFromName(name: string): MediaKind | null {
  const extension = extensionOf(name);
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  return null;
}

/**
 * `contentType` важнее имени: сервер может отдать `photo.php` с `image/jpeg`.
 * Неизвестный `application/octet-stream` не мешает распознать файл по расширению.
 */
export function mediaKind(input: { name?: string | null; contentType?: string | null }): MediaKind | null {
  const contentType = (input.contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  // Текст и JSON не становятся картинкой только из-за расширения в URL: это обычно страница
  // ошибки, отданная с кодом 200. Остальные неоднозначные типы (octet-stream, binary) решает имя.
  if (contentType.startsWith("text/") || contentType === "application/json" || contentType.endsWith("+json")) return null;
  return input.name ? mediaKindFromName(input.name) : null;
}

/**
 * Content-type для бакета: заголовок сервера сохраняется, если он действительно медиа.
 * Иначе тип восстанавливается по расширению — иначе `<video>` не проиграет файл,
 * отданный как `application/octet-stream`.
 */
export function mediaContentType(input: { name: string; contentType?: string | null; kind: MediaKind }): string {
  const contentType = (input.contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (contentType.startsWith("image/") || contentType.startsWith("video/")) return contentType;
  return MIME_BY_EXTENSION[extensionOf(input.name)] ?? (input.kind === "video" ? "video/mp4" : "image/png");
}
