import { assertPublicUrl, requestPage, WebReadError, type ResolveName } from "../web/read-url.js";
import { sniffImageType } from "../provider/image-generation.js";

/**
 * Загрузка изображения по публичной ссылке — единственный путь, которым сервер берёт чужие байты.
 *
 * Живёт отдельным модулем, а не внутри инструмента `image.inspect`, потому что теперь нужен двум
 * местам: инструменту («посмотри на эту картинку») и рантайму агента, который подставляет
 * вложение пользователя прямо в запрос к главной модели. Копия этой логики во втором месте была
 * бы дырой: адрес называет пользователь, а сервер видит внутреннюю сеть Docker, Postgres на
 * loopback и метаданные облака.
 *
 * Поэтому только http/https и порты 80/443, имя резолвится один раз и соединение идёт на
 * проверенный адрес (иначе DNS rebinding вернул бы внутренний хост), каждый редирект проверяется
 * заново, а тело ограничено по размеру и времени.
 */

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const URL_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 4;

export type ImageUrlResult =
  | { ok: true; bytes: Buffer; contentType: string; finalUrl: string }
  | { ok: false; code: "not_url" | "blocked_host" | "unavailable" | "too_large" | "unsupported"; error: string };

/** Тип изображения по самим байтам: заголовок ответа может врать, а модель ждёт настоящий. */
export function imageContentType(bytes: Buffer): string | null {
  const known = sniffImageType(bytes);
  if (known) return known;
  if (bytes.length >= 6) {
    const head = bytes.subarray(0, 6).toString("latin1");
    if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  }
  return null;
}

export async function loadImageFromUrl(
  raw: string,
  options: { signal?: AbortSignal; resolve?: ResolveName; maxBytes?: number } = {},
): Promise<ImageUrlResult> {
  const limit = Math.min(options.maxBytes ?? MAX_IMAGE_BYTES, MAX_IMAGE_BYTES);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), URL_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
  try {
    let current: URL;
    let addresses: string[];
    try {
      const checked = await assertPublicUrl(raw, options.resolve);
      current = checked.url;
      addresses = checked.addresses;
    } catch (error) {
      const reason = error instanceof WebReadError ? error : null;
      const code = reason?.code === "blocked_host" ? "blocked_host" : reason?.code === "not_url" ? "not_url" : "unavailable";
      return { ok: false, code, error: reason?.message ?? (error instanceof Error ? error.message : String(error)) };
    }

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const response = await requestPage(current, addresses, signal, { maxBytes: limit });
      if (response.status >= 300 && response.status < 400) {
        const header = response.headers.location;
        const location = Array.isArray(header) ? header[0] : header;
        if (!location) return { ok: false, code: "unavailable", error: "Ссылка отвечает редиректом без адреса (Location)" };
        try {
          const next = await assertPublicUrl(new URL(location, current).href, options.resolve);
          current = next.url;
          addresses = next.addresses;
        } catch (error) {
          return {
            ok: false,
            code: "blocked_host",
            error: "Редирект ведёт на запрещённый адрес: " + (error instanceof Error ? error.message : String(error)),
          };
        }
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        return { ok: false, code: "unavailable", error: "Ссылка на изображение ответила HTTP " + response.status };
      }
      if (response.oversized || response.bytes.length > limit) {
        return {
          ok: false,
          code: "too_large",
          error: "Изображение по ссылке больше " + Math.round(limit / (1024 * 1024)) + " МБ — уменьшите его перед анализом",
        };
      }
      if (!response.bytes.length) return { ok: false, code: "unavailable", error: "По ссылке пришёл пустой ответ" };
      // Тип изображения по самим байтам: заголовок ответа может врать, а модель ждёт настоящий.
      const contentType = imageContentType(response.bytes);
      if (!contentType) {
        return { ok: false, code: "unsupported", error: "По ссылке не PNG/JPEG/WebP/GIF: vision-модель такие форматы не принимает" };
      }
      return { ok: true, bytes: response.bytes, contentType, finalUrl: current.href };
    }
    return { ok: false, code: "unavailable", error: "Слишком много перенаправлений (больше " + MAX_REDIRECTS + ")" };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, code: "unavailable", error: "Ссылка не ответила за " + Math.round(URL_TIMEOUT_MS / 1000) + " секунд" };
    }
    return { ok: false, code: "unavailable", error: "Не удалось открыть ссылку: " + (error instanceof Error ? error.message : String(error)) };
  } finally {
    clearTimeout(timer);
  }
}

export { MAX_IMAGE_BYTES };
