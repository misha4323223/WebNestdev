import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import type { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
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
 * - **соединение идёт на проверенный адрес, а не на имя**: DNS-ответ передаётся транспорту как
 *   готовая функция `lookup`, поэтому между проверкой и `connect` имя не спрашивается второй раз
 *   и подменить его (DNS rebinding) нечем. Это же действует и на каждом редиректе;
 * - редиректы проходятся вручную, до четырёх переходов, и каждый проверяется заново;
 * - ответ ограничен по размеру и времени, читается только текст.
 *
 * Раньше здесь был `fetch`: он резолвит имя сам, уже после проверки, — именно это и делало
 * rebinding рабочим. Поэтому запрос собран на `node:http`/`node:https` с подставленным `lookup`:
 * единственное, что осталось от DNS, — адреса, которые проверил `assertPublicUrl`.
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

/**
 * IPv6 → восемь 16-битных групп, или `null`, если адрес не разбирается.
 *
 * Разбор нужен по-настоящему: нормализованный URL пишет IPv4-mapped адрес не точками, а hex-ом
 * (`::ffff:127.0.0.1` → `::ffff:7f00:1`), поэтому проверка по префиксам строк пропускала бы
 * loopback. Группы одинаково покрывают сжатую, полную и mapped-запись.
 */
function ipv6Groups(address: string): number[] | null {
  const value = address.trim().toLowerCase().replace(/%.*$/, "");
  if (!value.includes(":")) return null;
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string | undefined): number[] | null => {
    if (!part) return [];
    const groups: number[] = [];
    for (const piece of part.split(":")) {
      const v4 = ipv4Parts(piece);
      if (v4) {
        groups.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
      groups.push(parseInt(piece, 16));
    }
    return groups;
  };
  const head = parse(halves[0]);
  if (!head) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = parse(halves[1]);
  if (!tail) return null;
  const fill = 8 - head.length - tail.length;
  return fill < 0 ? null : [...head, ...new Array<number>(fill).fill(0), ...tail];
}

function bytesOf(groups: number[]): number[] {
  return groups.flatMap(group => [group >> 8, group & 0xff]);
}

function hasPrefix(bytes: number[], prefix: number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

/** Частный IPv6: loopback, ULA, link-local, multicast, туннели и всё, что вкладывает IPv4. */
function isPrivateIpv6(bytes: number[]): boolean {
  // :: и ::1
  if (bytes.every(byte => byte === 0)) return true;
  if (bytes.slice(0, 15).every(byte => byte === 0) && bytes[15] === 1) return true;
  // ::ffff:0:0/96 — IPv4-mapped: адрес ведёт ровно на вложенный IPv4.
  if (hasPrefix(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff])) return isPrivateAddress(bytes.slice(12).join("."));
  // ::ffff:0:0:0/96 — IPv4-translated запись: вложенный IPv4 — те же последние 32 бита.
  if (bytes.slice(0, 8).every(byte => byte === 0) && bytes[8] === 0xff && bytes[9] === 0xff) return isPrivateAddress(bytes.slice(12).join("."));
  // ::/96 — устаревшая IPv4-compatible запись, тоже ведёт на IPv4.
  if (hasPrefix(bytes, new Array<number>(12).fill(0))) return isPrivateAddress(bytes.slice(12).join("."));
  // fc00::/7 — уникальные локальные адреса.
  if ((bytes[0] & 0xfe) === 0xfc) return true;
  // fe80::/10 — link-local.
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;
  // ff00::/8 — multicast.
  if (bytes[0] === 0xff) return true;
  // 64:ff9b::/96 — NAT64: дальше идёт вложенный IPv4.
  if (hasPrefix(bytes, [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0])) return isPrivateAddress(bytes.slice(12).join("."));
  // 2002::/16 — 6to4: вложенный IPv4 лежит сразу после префикса.
  if (hasPrefix(bytes, [0x20, 0x02])) return isPrivateAddress(bytes.slice(2, 6).join("."));
  // 2001:0::/32 — Teredo (вложенный адрес перевёрнут) и 2001:db8::/32 — только документация.
  if (hasPrefix(bytes, [0x20, 0x01, 0x00, 0x00])) return true;
  if (hasPrefix(bytes, [0x20, 0x01, 0x0d, 0xb8])) return true;
  return false;
}

/** Частный ли это адрес: то, что сервер не должен открывать по просьбе модели. */
export function isPrivateAddress(address: string): boolean {
  const value = address.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!value) return true;
  const v4 = ipv4Parts(value);
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
  const groups = ipv6Groups(value);
  // Неразобранный адрес — не повод считать его публичным: пусть лучше откажет.
  if (!groups) return true;
  return isPrivateIpv6(bytesOf(groups));
}

type CheckedUrl = { url: URL; addresses: string[] };

/** Резолвер подменяем в тестах: иначе проверка rebinding проверяла бы настоящий DNS. */
export type ResolveName = (hostname: string) => Promise<string[]>;

export async function resolveName(hostname: string): Promise<string[]> {
  return (await lookup(hostname, { all: true })).map(entry => entry.address);
}

/** Проверка адреса до запроса: протокол, порт, имя и все адреса, в которые имя резолвится. */
export async function assertPublicUrl(raw: string, resolve: ResolveName = resolveName): Promise<CheckedUrl> {
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
    addresses = await resolve(hostname);
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

/**
 * `lookup` для транспорта: отдаёт ровно те адреса, которые уже проверил `assertPublicUrl`.
 *
 * Это и есть защита от DNS rebinding. Node спросил бы DNS в момент соединения, и второй ответ мог
 * бы отличаться от проверенного (имя с TTL 0 — самый дешёвый способ). Здесь имени уже нет: есть
 * список проверенных адресов и семейство, которое просит соединение.
 */
export function pinnedLookup(addresses: string[]): LookupFunction {
  return ((hostname: string, options: { all?: boolean; family?: number }, callback: (...args: unknown[]) => void) => {
    const family = options?.family === 6 ? 6 : options?.family === 4 ? 4 : 0;
    // Без явного семейства предпочитается IPv4: в контейнере без рабочего IPv6 первый адрес из
    // ответа DNS может быть недоступен, а раньше перебор адресов делал `fetch`.
    const address =
      family === 6 ? addresses.find(value => value.includes(":")) :
      family === 4 ? addresses.find(value => !value.includes(":")) :
      addresses.find(value => !value.includes(":")) ?? addresses[0];
    if (!address) {
      callback(Object.assign(new Error("Нет проверенного адреса для " + hostname), { code: "ENOTFOUND" }));
      return;
    }
    const found = address.includes(":") ? 6 : 4;
    // Node просит либо один адрес, либо список (`all`). `autoSelectFamily` выключен, поэтому
    // практически всегда нужен один — но обработка списка делает функцию честной для обоих режимов.
    if (options?.all) callback(null, [{ address, family: found }]);
    else callback(null, address, found);
  }) as unknown as LookupFunction;
}

/** Распаковка тела по `content-encoding`: `identity` запрашивается явно, но сервер вправе сжать и без просьбы. */
function decodeBody(response: Readable, encoding: string | string[] | undefined): Readable {
  const value = (Array.isArray(encoding) ? encoding[0] : encoding ?? "").trim().toLowerCase();
  if (!value || value === "identity") return response;
  if (value === "gzip" || value === "x-gzip") return response.pipe(createGunzip());
  if (value === "deflate") return response.pipe(createInflate());
  if (value === "br") return response.pipe(createBrotliDecompress());
  throw new WebReadError("unavailable", "Неизвестное сжатие ответа: " + value);
}

/**
 * Чтение тела с потолком: дальше `limit` байт от сервера не читаем и закрываем поток.
 * `keep: "tail"` нужен логам: у них ценен конец, а не начало.
 */
async function readCapped(stream: Readable, limit: number, keep: "head" | "tail"): Promise<{ body: Buffer; oversized: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let oversized = false;
  for await (const chunk of stream) {
    const bytes = chunk as Buffer;
    const room = limit - size;
    if (bytes.length > room) {
      if (keep === "tail") chunks.push(bytes);
      else chunks.push(bytes.subarray(0, Math.max(0, room)));
      size += bytes.length;
      oversized = true;
      break;
    }
    chunks.push(bytes);
    size += bytes.length;
  }
  let body = Buffer.concat(chunks);
  // Для хвоста начало отрезается после чтения: последняя порция может быть больше потолка.
  if (keep === "tail" && body.length > limit) body = body.subarray(body.length - limit);
  return { body, oversized };
}

export type PageResponse = { status: number; headers: IncomingHttpHeaders; body: string; oversized: boolean };
export type TransportOptions = { maxBytes?: number; keep?: "head" | "tail" };

/**
 * Один запрос страницы по уже проверенному адресу.
 *
 * Редирект не читается: возвращается только его статус и заголовок `location`, а следующий адрес
 * проверяет и прибивает вызывающий. Таймаут и отмена — общий `AbortSignal` всего чтения.
 *
 * Экспортируется для теста транспорта: снаружи страницу читает только `readWebPage`, и она
 * передаёт сюда адреса, проверенные `assertPublicUrl`.
 */
export async function requestPage(url: URL, addresses: string[], signal: AbortSignal, options: TransportOptions = {}): Promise<PageResponse> {
  const limit = Math.max(0, Math.floor(options.maxBytes ?? MAX_BYTES));
  const keep = options.keep ?? "head";
  const secure = url.protocol === "https:";
  const send = secure ? httpsRequest : httpRequest;
  return await new Promise<PageResponse>((resolve, reject) => {
    const request = send(
      url,
      {
        method: "GET",
        lookup: pinnedLookup(addresses),
        // Семейство выбирает сам `lookup`, а не второй проход DNS с перебором адресов.
        autoSelectFamily: false,
        // Без пула соединений: сокет из пула привязан к адресу прошлого запроса, а здесь адрес —
        // часть проверки, и переиспользовать чужое соединение незачем.
        agent: false,
        headers: {
          "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          accept: "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5",
          "accept-language": "ru-RU,ru;q=0.9,en;q=0.8",
          // Без сжатия: `fetch` сам разбирал gzip, а здесь распаковка — отдельный шаг, и лишний
          // повод для него не нужен. Если сервер сожмёт всё равно — `decodeBody` разберёт.
          "accept-encoding": "identity",
        },
        signal,
      } as RequestOptions,
      response => {
        try {
          const status = response.statusCode ?? 0;
          const headers = response.headers;
          if (status >= 300 && status < 400) {
            response.resume();
            resolve({ status, headers, body: "", oversized: false });
            return;
          }
          readCapped(decodeBody(response, headers["content-encoding"]), limit, keep).then(
            ({ body, oversized }) => resolve({ status, headers, body: body.toString("utf8"), oversized }),
            reject,
          );
        } catch (error) {
          reject(error);
        }
      },
    );
    request.on("error", reject);
    request.end();
  });
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

export type WebReadOptions = { maxChars?: number; signal?: AbortSignal; resolve?: ResolveName };

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

  // Проверенный адрес живёт вместе с адресами, которые из него получились: дальше по ним идёт
  // соединение, а DNS второй раз уже не спрашивается.
  let current: URL;
  let addresses: string[];
  try {
    const checked = await assertPublicUrl(raw, options.resolve);
    current = checked.url;
    addresses = checked.addresses;
  } catch (error) {
    const reason = error instanceof WebReadError ? error : new WebReadError("unavailable", error instanceof Error ? error.message : String(error));
    return empty(raw, reason.code, reason.message);
  }

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const response = await requestPage(current, addresses, signal);
      const ok = response.status >= 200 && response.status < 300;
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.location;
        if (!location) return empty(current.href, "unavailable", "Редирект без адреса (Location)");
        try {
          const next = await assertPublicUrl(new URL(location, current).href, options.resolve);
          current = next.url;
          addresses = next.addresses;
        } catch (error) {
          const reason = error instanceof WebReadError ? error : new WebReadError("unavailable", String(error));
          return empty(current.href, reason.code, "Редирект ведёт на запрещённый адрес: " + reason.message);
        }
        continue;
      }
      const contentType = response.headers["content-type"] ?? null;
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
      const rawBody = response.body;
      const text = readableText(mainContent(rawBody));
      const sliced = text.slice(0, maxChars);
      return {
        ok,
        url: current.href,
        status: response.status,
        contentType,
        title: extractTitle(rawBody),
        text: sliced,
        truncated: sliced.length < text.length || response.oversized || rawBody.length >= MAX_BYTES,
        ...(ok ? {} : { code: "unavailable", error: "Страница ответила " + response.status }),
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
