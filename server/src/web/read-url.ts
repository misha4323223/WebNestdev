import { lookup } from "node:dns/promises";
import { extractTitle, mainContent, readableText } from "./html.js";
import type { WebSearchErrorCode } from "./web-types.js";

/**
 * `web.read`: сервер открывает публичную страницу и возвращает её читаемый текст.
 *
 * Это единственный инструмент, которому агент называет адрес, а сервер идёт по нему сам. Поэтому
 * здесь стоит защита от SSRF, а не только таймаут: сервер видит внутреннюю сеть Docker, Postgres на
 * loopback и метаданные облака, и «прочитай http://169.254.169.254/…» не должно возвращать документ.
 *
 * Правила:
 * - только `http`/`https`, только порты 80 и 443, без логина и пароля в адресе;
 * - имя резолвится, и каждый полученный адрес проверяется: частные, loopback, link-local и
 *   многоадресные диапазоны запрещены;
 * - редиректы проходятся вручную, до четырёх переходов, и каждый проверяется заново;
 * - ответ ограничен по размеру и времени, читается только текст.
 */

const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 4;
const MAX_BYTES = 400_000;
const DEFAULT_MAX_CHARS = 8_000;
const ALLOWED_PORTS = new Set(["", "80", "443"]);
const BLOCKED_HOSTNAMES = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|.*\.home\.arpa|metadata\.google\.internal)$/i;

export class WebReadError extends Error {
  constructor(readonly code: WebSearchErrorCode | "not_url" | "blocked_host", message: string) {
    super(message);
    this.name = "WebReadError";
  }
}

function ipv4Parts(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const numbers = parts.map(part => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  return numbers.every(number => Number.isFinite(number) && number >= 0 && number <= 255) ? numbers : null;
}

/** Частный ли это адрес: то, что сервер не должен открывать по просьбе модели. */
export function isPrivateAddress(address: string): boolean {
  const value = address.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!value) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value)?.[1];
  const target = mapped ?? value;
  const v4 = ipv4Parts(target);
  if (v4) {
    const [a, b] = v4;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    return false;
  }
  if (value === "::" || value === "::1") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(value)) return true; // fc00::/7 — уникальные локальные адреса
  if (/^fe[89ab][0-9a-f]:/.test(value)) return true; // fe80::/10 — link-local
  if (value.startsWith("64:ff9b:")) return true; // NAT64
  return false;
}

type CheckedUrl = { url: URL; addresses: string[] };

/** Проверка адреса до запроса: протокол, порт, имя и все адреса, в которые имя резолвится. */
export async function assertPublicUrl(raw: string): Promise<CheckedUrl> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebReadError("not_url", "Это не адрес: " + raw.slice(0, 120));
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebReadError("not_url", "Можно читать только http и https, а не " + url.protocol);
  }
  if (url.username || url.password) {
    throw new WebReadError("blocked_host", "Адрес содержит логин и пароль — такие ссылки не открываются");
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new WebReadError("blocked_host", "Разрешены только порты 80 и 443, а не " + url.port);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTNAMES.test(hostname)) {
    throw new WebReadError("blocked_host", "Внутренние адреса (" + hostname + ") не открываются");
  }
  if (ipv4Parts(hostname) || hostname.includes(":")) {
    if (isPrivateAddress(hostname)) throw new WebReadError("blocked_host", "Частный адрес " + hostname + " не открывается");
    return { url, addresses: [hostname] };
  }
  let addresses: string[];
  try {
    addresses = (await lookup(hostname, { all: true })).map(entry => entry.address);
  } catch (error) {
    throw new WebReadError("unavailable", "Не удалось разрешить имя " + hostname + ": " + (error instanceof Error ? error.message : String(error)));
  }
  if (!addresses.length) throw new WebReadError("unavailable", "Имя " + hostname + " не разрешилось ни в один адрес");
  const blocked = addresses.find(address => isPrivateAddress(address));
  if (blocked) {
    throw new WebReadError("blocked_host", "Имя " + hostname + " ведёт на внутренний адрес " + blocked + " — такие страницы не открываются");
  }
  return { url, addresses };
}

function isTextContentType(value: string | null): boolean {
  const type = (value ?? "").toLowerCase();
  if (!type) return true;
  return type.startsWith("text/") || type.includes("json") || type.includes("xml") || type.includes("javascript");
}

export type WebReadResult = {
  ok: boolean;
  url: string;
  status: number;
  contentType: string | null;
  title: string;
  text: string;
  truncated: boolean;
  code?: string;
  error?: string;
};

export type WebReadOptions = { maxChars?: number; signal?: AbortSignal };

/**
 * Загрузка и чтение страницы. Отказ по адресу возвращается как `ok:false` с причиной: модель видит,
 * что именно запрещено, вместо пустого исключения.
 */
export async function readWebPage(raw: string, options: WebReadOptions = {}): Promise<WebReadResult> {
  const maxChars = Math.min(20_000, Math.max(500, Math.floor(options.maxChars ?? DEFAULT_MAX_CHARS)));
  const empty = (url: string, code: string, error: string): WebReadResult => ({
    ok: false,
    url,
    status: 0,
    contentType: null,
    title: "",
    text: "",
    truncated: false,
    code,
    error,
  });

  let current: URL;
  try {
    current = (await assertPublicUrl(raw)).url;
  } catch (error) {
    const reason = error instanceof WebReadError ? error : new WebReadError("unavailable", error instanceof Error ? error.message : String(error));
    return empty(raw, reason.code, reason.message);
  }

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const response = await fetch(current, {
        method: "GET",
        redirect: "manual",
        headers: {
          "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          accept: "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5",
          "accept-language": "ru-RU,ru;q=0.9,en;q=0.8",
        },
        signal: options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) return empty(current.href, "unavailable", "Редирект без адреса (Location)");
        let next: URL;
        try {
          next = (await assertPublicUrl(new URL(location, current).href)).url;
        } catch (error) {
          const reason = error instanceof WebReadError ? error : new WebReadError("unavailable", String(error));
          return empty(current.href, reason.code, "Редирект ведёт на запрещённый адрес: " + reason.message);
        }
        current = next;
        continue;
      }
      const contentType = response.headers.get("content-type");
      if (!isTextContentType(contentType)) {
        return {
          ok: false,
          url: current.href,
          status: response.status,
          contentType,
          title: "",
          text: "",
          truncated: false,
          code: "unavailable",
          error: "Это не текст (" + (contentType ?? "тип неизвестен") + "): можно читать только HTML, текст, JSON и XML",
        };
      }
      const rawBody = (await response.text()).slice(0, MAX_BYTES);
      const text = readableText(mainContent(rawBody));
      const sliced = text.slice(0, maxChars);
      return {
        ok: response.ok,
        url: current.href,
        status: response.status,
        contentType,
        title: extractTitle(rawBody),
        text: sliced,
        truncated: sliced.length < text.length || rawBody.length >= MAX_BYTES,
        ...(response.ok ? {} : { code: "unavailable", error: "Страница ответила " + response.status }),
      };
    }
    return empty(current.href, "unavailable", "Слишком много перенаправлений (больше " + MAX_REDIRECTS + ")");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return empty(current.href, "unavailable", "Не удалось открыть страницу: " + message);
  } finally {
    clearTimeout(timer);
  }
}
