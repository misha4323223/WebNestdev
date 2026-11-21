import dns from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import type { Browser, LaunchOptions } from "playwright";
import { isIpLiteral, isPrivateAddress } from "../security/address-policy.js";

/**
 * Сетевой фильтр для Chromium.
 *
 * Браузер запускается внутри контейнера API, поэтому без фильтра страница проекта могла бы
 * запросить `127.0.0.1:8787`, PostgreSQL, Docker-сокет через TCP или metadata облака. Playwright
 * route здесь недостаточно: он видит URL до DNS, а DNS rebinding может вернуть приватный адрес
 * уже после проверки.
 *
 * Поэтому Chromium ходит через маленький локальный HTTP-прокси. Прокси сам разрешает имя,
 * проверяет каждый полученный адрес и соединяется уже с проверенным IP. Белый список — это
 * origin текущего preview (и адрес панели для отдельной проверки); всё остальное должно быть
 * публичным. Внешние API, CDN и HMR через публичный домен продолжают работать.
 */

export type ResolvedTarget = { address: string; port: number; hostname: string };
export type Lookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

/** Отказ политики, а не сбой сети: клиент получает 403 и не повторяет запрос. */
export class BrowserProxyDeniedError extends Error {
  readonly statusCode = 403;
  constructor(message: string) {
    super(message);
    this.name = "BrowserProxyDeniedError";
  }
}

const defaultLookup: Lookup = hostname => dns.lookup(hostname, { all: true, verbatim: true });

/** Порт по умолчанию для абсолютного http-URL и CONNECT. */
function defaultPort(protocol: string): number {
  return protocol === "https:" ? 443 : 80;
}

function normalizeHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function targetKey(hostname: string, port: number): string {
  return normalizeHost(hostname) + ":" + String(port);
}

/** Разбирает `host:port`, `[::1]:port` и `host`; порт обязан быть числом 1..65535. */
export function parseHostPort(value: string, fallbackPort: number): { hostname: string; port: number } | null {
  const input = value.trim();
  if (!input) return null;
  let hostname = input;
  let portText = "";
  if (input.startsWith("[")) {
    const close = input.indexOf("]");
    if (close < 0) return null;
    hostname = input.slice(1, close);
    const rest = input.slice(close + 1);
    if (rest.startsWith(":")) portText = rest.slice(1);
    else if (rest) return null;
  } else {
    const colon = input.lastIndexOf(":");
    if (colon > -1 && input.indexOf(":") === colon) {
      hostname = input.slice(0, colon);
      portText = input.slice(colon + 1);
    }
  }
  const port = portText ? Number(portText) : fallbackPort;
  if (!hostname || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { hostname: normalizeHost(hostname), port };
}

function allowedTargets(urls: string[]): Set<string> {
  const allowed = new Set<string>();
  for (const raw of urls) {
    try {
      const url = new URL(raw);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      allowed.add(targetKey(url.hostname, Number(url.port) || defaultPort(url.protocol)));
    } catch {
      // Некорректный адрес не должен расширять белый список.
    }
  }
  return allowed;
}

/**
 * Разрешает цель и отказывает, если это private-адрес вне явного белого списка.
 * Проверяются ВСЕ ответы DNS: домен с одной публичной и одной приватной записью не проходит.
 */
export async function resolveProxyTarget(
  hostname: string,
  port: number,
  allowed: Set<string>,
  lookup: Lookup = defaultLookup,
): Promise<ResolvedTarget> {
  const host = normalizeHost(hostname);
  const explicitlyAllowed = allowed.has(targetKey(host, port));
  const addresses = isIpLiteral(host)
    ? [{ address: host, family: net.isIP(host) }]
    : await lookup(host);
  if (addresses.length === 0) throw new Error("DNS не вернул ни одного адреса для " + host);
  // Соединяемся только с IP, а не с именем: иначе резолвер мог бы вернуть строку, и
  // net.connect/http.request разрешили бы её заново — DNS rebinding обошёл бы проверку.
  if (addresses.some(item => !isIpLiteral(item.address))) {
    throw new Error("DNS вернул не IP-адрес для " + host);
  }
  if (!explicitlyAllowed && addresses.some(item => isPrivateAddress(item.address))) {
    throw new BrowserProxyDeniedError("адрес " + host + " ведёт в private/link-local сеть");
  }
  // Для публичного имени берём первый публичный адрес. Если хотя бы один ответ приватный,
  // выше уже был отказ — это и защищает от DNS rebinding.
  const chosen = explicitlyAllowed
    ? addresses[0]!
    : addresses.find(item => !isPrivateAddress(item.address))!;
  return { address: chosen.address, port, hostname: host };
}

function stripHopHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const output: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (["proxy-connection", "proxy-authorization", "connection", "keep-alive", "upgrade"].includes(lower)) continue;
    if (value !== undefined) output[key] = value;
  }
  return output;
}

function reject(response: http.ServerResponse, status: number, message: string) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(message);
}

type BrowserProxy = { url: string; port: number; close: () => Promise<void> };

/**
 * Поднимает фильтрующий прокси на 127.0.0.1 со случайным портом. Слушает только loopback:
 * снаружи контейнера API прокси недоступен.
 */
export async function startBrowserProxy(options: {
  allowUrls: string[];
  lookup?: Lookup;
  log?: (message: string) => void;
}): Promise<BrowserProxy> {
  const allowed = allowedTargets(options.allowUrls);
  const lookup = options.lookup ?? defaultLookup;
  const log = options.log ?? (() => undefined);
  const sockets = new Set<Duplex>();

  const server = http.createServer((request, response) => {
    void handleHttp(request, response).catch(error => {
      log("browser proxy: " + (error instanceof Error ? error.message : String(error)));
      const denied = error instanceof BrowserProxyDeniedError;
      reject(response, denied ? 403 : 502, denied ? "Адрес запрещён фильтром браузера" : "Фильтр браузера не смог выполнить запрос");
    });
  });

  async function targetFor(hostname: string, port: number): Promise<ResolvedTarget> {
    return resolveProxyTarget(hostname, port, allowed, lookup);
  }

  async function handleHttp(request: http.IncomingMessage, response: http.ServerResponse) {
    let url: URL;
    try {
      url = new URL(request.url ?? "");
    } catch {
      reject(response, 400, "Прокси браузера ожидает абсолютный http-URL");
      return;
    }
    if (url.protocol !== "http:") {
      reject(response, 400, "Прокси браузера принимает только http; https идёт через CONNECT");
      return;
    }
    const target = await targetFor(url.hostname, Number(url.port) || 80);
    const headers = stripHopHeaders(request.headers);
    // Host обязан остаться исходным: приложение на preview может строить по нему ссылки.
    headers.host = url.host;
    const upstream = http.request({
      host: target.address,
      port: target.port,
      method: request.method,
      path: url.pathname + url.search,
      headers,
    }, answer => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    });
    upstream.on("error", error => {
      log("browser proxy: " + target.hostname + ": " + error.message);
      reject(response, 502, "Фильтр браузера не смог подключиться к " + target.hostname);
    });
    request.on("aborted", () => upstream.destroy());
    request.pipe(upstream);
  }

  /** WebSocket/HMR: Chromium присылает absolute http-URL с Upgrade, его нельзя пускать через
   * обычный http.request — заголовки upgrade были бы потеряны. Туннелируем байты к проверенному
   * адресу, сохраняя рукопожатие и путь. */
  async function handleUpgrade(request: http.IncomingMessage, client: Duplex, head: Buffer) {
    client.pause();
    let url: URL;
    try {
      const raw = request.url ?? "";
      url = raw.startsWith("http://") || raw.startsWith("https://")
        ? new URL(raw)
        : new URL("http://" + (request.headers.host ?? "") + raw);
    } catch {
      client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    if (url.protocol !== "http:") {
      client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    let resolved: ResolvedTarget;
    try {
      resolved = await targetFor(url.hostname, Number(url.port) || 80);
    } catch (error) {
      log("browser proxy upgrade: " + (error instanceof Error ? error.message : String(error)));
      client.end(error instanceof BrowserProxyDeniedError
        ? "HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"
        : "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = net.connect({ host: resolved.address, port: resolved.port }, () => {
      const lines = [request.method + " " + url.pathname + url.search + " HTTP/1.1"];
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        const name = request.rawHeaders[index]!;
        if (/^(proxy-connection|proxy-authorization)$/i.test(name)) continue;
        lines.push(name + ": " + request.rawHeaders[index + 1]);
      }
      upstream.write(lines.join("\r\n") + "\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
    client.resume();
  }

  async function handleConnect(request: http.IncomingMessage, client: Duplex, head: Buffer) {
    client.pause();
    const target = parseHostPort(request.url ?? "", 443);
    if (!target) {
      client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    let resolved: ResolvedTarget;
    try {
      resolved = await targetFor(target.hostname, target.port);
    } catch (error) {
      log("browser proxy CONNECT: " + (error instanceof Error ? error.message : String(error)));
      const denied = error instanceof BrowserProxyDeniedError;
      client.end(denied
        ? "HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"
        : "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = net.connect({ host: resolved.address, port: resolved.port }, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.on("error", () => {
      client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    });
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
    client.resume();
  }

  server.on("connect", (request, socket, head) => {
    void handleConnect(request, socket, head).catch(() => socket.destroy());
  });
  server.on("upgrade", (request, socket, head) => {
    void handleUpgrade(request, socket, head).catch(() => socket.destroy());
  });
  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  await new Promise<void>((resolve, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectPromise);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Фильтр браузера не получил порт");
  const port = address.port;

  return {
    url: "http://127.0.0.1:" + String(port),
    port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

/**
 * Флаги Chromium:
 *   - `<-loopback>` отключает неявный обход прокси для localhost. Без него Chromium ходил бы
 *     в 127.0.0.1 напрямую, и фильтр не увидел бы запрос;
 *   - WebRTC/QUIC не должны ходить мимо HTTP-прокси: `disable_non_proxied_udp` запрещает прямой
 *     UDP, `--disable-quic` — HTTP/3 через UDP. Иначе страница могла бы обратиться к private-сети
 *     по UDP, пока HTTP-запросы проверяет прокси;
 *   - фоновые сетевые запросы Chromium не нужны проверке и тоже не должны обходить фильтр;
 *   - лимит renderer-процессов и old-space не дают одной странице занять весь контейнер API.
 */
export const GUARDED_CHROMIUM_ARGS = [
  "--proxy-bypass-list=<-loopback>",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--disable-quic",
  "--disable-background-networking",
  "--renderer-process-limit=4",
  "--js-flags=--max-old-space-size=512",
] as const;

export type LaunchBrowser = (options: LaunchOptions) => Promise<Browser>;
export type GuardedBrowser = { browser: Browser; close: () => Promise<void> };

/**
 * Запускает браузер с фильтром и возвращает пару «браузер + закрытие». `close` обязателен:
 * если закрыть только браузер, прокси остался бы слушать до конца процесса API.
 */
export async function launchGuardedBrowser(
  launch: LaunchBrowser,
  options: LaunchOptions,
  urls: string[],
): Promise<GuardedBrowser> {
  const proxy = await startBrowserProxy({ allowUrls: urls });
  try {
    const browser = await launch({
      ...options,
      proxy: { server: proxy.url, bypass: "<-loopback>" },
      args: [...new Set([...(options.args ?? []), ...GUARDED_CHROMIUM_ARGS])],
    });
    return {
      browser,
      close: async () => {
        await browser.close().catch(() => undefined);
        await proxy.close();
      },
    };
  } catch (error) {
    await proxy.close().catch(() => undefined);
    throw error;
  }
}
