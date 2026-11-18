import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { withoutPlatformCookies } from "./preview-proxy.js";

/**
 * Platform-owned proxy for a static app whose API lives on another origin.
 *
 * A static preview has the same origin as the panel (`*.preview.nestdev.ru`), while the API
 * usually lives elsewhere. A browser request with `credentials: include` cannot use
 * `Access-Control-Allow-Origin: *`, and an API without an OPTIONS handler cannot pass a
 * preflight. A project should not have to reimplement a proxy for every generated site, so the
 * preview listener mounts `/api/upstream/*` and forwards it to the upstream declared in
 * `package.json.preview.apiUpstream`.
 *
 * The upstream is fixed by the project configuration, never by the request. Hostnames are
 * resolved and checked again on every request, so a public name cannot point at a private
 * address after the project was opened.
 */

const API_UPSTREAM_PREFIX = "/api/upstream";
const MAX_BODY_BYTES = 2_000_000;
const PROXY_TIMEOUT_MS = 30_000;

const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "proxy-authorization",
  "proxy-connection",
]);

type PackageShape = { preview?: unknown };

export type ApiUpstreamConfig = {
  /** Base path on the upstream, without a trailing slash (`/api` or empty for the root). */
  basePath: string;
  /** HTTPS origin of the API. */
  origin: string;
  /** Full base as declared by the project, without a trailing slash. */
  base: string;
};

export type ApiUpstreamRead =
  | { kind: "absent" }
  | { kind: "invalid"; reason: string }
  | { kind: "configured"; config: ApiUpstreamConfig };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function privateIpv4(address: string) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a = 0, b = 0] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

/** True for loopback, link-local, private, documentation and other non-public addresses. */
export function isPrivateAddress(address: string) {
  const family = isIP(address);
  if (family === 4) return privateIpv4(address);
  if (family !== 6) return true;
  const normalized = address.toLowerCase().split("%")[0] ?? "";
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
  if (normalized.startsWith("::ffff:")) return privateIpv4(normalized.slice(7));
  return false;
}

function literalHostIsPrivate(hostname: string) {
  const value = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!value || value === "localhost" || value.endsWith(".localhost") || value.endsWith(".local")) return true;
  if (value === "metadata.google.internal" || value === "metadata.google.internal.") return true;
  return isIP(value) ? isPrivateAddress(value) : false;
}

/** Parses the explicit `preview.apiUpstream` contract. Exported for a focused unit test. */
export function parseApiUpstream(value: unknown): ApiUpstreamRead {
  if (typeof value !== "string" || !value.trim()) {
    return { kind: "invalid", reason: "package.json.preview.apiUpstream должен быть HTTPS-адресом API." };
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { kind: "invalid", reason: "package.json.preview.apiUpstream — некорректный URL." };
  }
  if (url.protocol !== "https:") {
    return { kind: "invalid", reason: "package.json.preview.apiUpstream должен использовать HTTPS." };
  }
  if (url.username || url.password) {
    return { kind: "invalid", reason: "package.json.preview.apiUpstream не должен содержать логин или пароль." };
  }
  if (url.search || url.hash) {
    return { kind: "invalid", reason: "package.json.preview.apiUpstream не должен содержать query или fragment." };
  }
  if (literalHostIsPrivate(url.hostname)) {
    return { kind: "invalid", reason: "package.json.preview.apiUpstream не может указывать на локальный или приватный адрес." };
  }
  const basePath = url.pathname.replace(/\/+$/, "");
  const origin = url.origin;
  return {
    kind: "configured",
    config: {
      basePath,
      origin,
      base: origin + basePath,
    },
  };
}

/** Reads the project contract from package.json; a missing key is the normal case. */
export async function readApiUpstream(root: string): Promise<ApiUpstreamRead> {
  let raw: string;
  try {
    raw = await readFile(path.join(root, "package.json"), "utf8");
  } catch {
    return { kind: "absent" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "invalid", reason: "В package.json проекта некорректный JSON." };
  }
  if (!isObject(parsed) || !isObject(parsed.preview) || !("apiUpstream" in parsed.preview)) return { kind: "absent" };
  return parseApiUpstream(parsed.preview.apiUpstream);
}

/** Exact `/api/upstream` plus slash-delimited children, never `/api/upstream-other`. */
export function isApiUpstreamPath(rawUrl: string | undefined) {
  const pathname = new URL(rawUrl ?? "/", "http://preview.local").pathname;
  return pathname === API_UPSTREAM_PREFIX || pathname.startsWith(API_UPSTREAM_PREFIX + "/");
}

async function publicAddresses(hostname: string) {
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("upstream " + hostname + " не разрешается в IP-адрес");
  }
  if (!addresses.length) throw new Error("upstream " + hostname + " не имеет IP-адреса");
  if (addresses.some(entry => isPrivateAddress(entry.address))) {
    throw new Error("upstream " + hostname + " указывает на локальный или приватный адрес");
  }
  return addresses;
}

function rewriteSetCookie(cookie: string) {
  const parts = cookie
    .split(";")
    .map(part => part.trim())
    .filter(part => part && !/^(domain|path)\s*=/i.test(part));
  // The browser must send this cookie back to /api/upstream, not to a path on the
  // external API's domain that does not exist on the preview host.
  return [...parts, "Path=/"].join("; ");
}

function rewriteLocation(value: string, target: URL, config: ApiUpstreamConfig) {
  try {
    const location = new URL(value, target);
    if (location.origin !== config.origin) return value;
    const basePath = config.basePath;
    const suffix = location.pathname.startsWith(basePath + "/")
      ? location.pathname.slice(basePath.length)
      : location.pathname === basePath
        ? "/"
        : location.pathname;
    return API_UPSTREAM_PREFIX + suffix + location.search + location.hash;
  } catch {
    return value;
  }
}

function responseHeaders(source: IncomingMessage["headers"], target: URL, config: ApiUpstreamConfig) {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
    if (name.toLowerCase() === "set-cookie") {
      headers[name] = (Array.isArray(value) ? value : [value]).map(rewriteSetCookie);
    } else if (name.toLowerCase() === "location" && typeof value === "string") {
      headers[name] = rewriteLocation(value, target, config);
    } else {
      headers[name] = value;
    }
  }
  headers["cache-control"] = "no-store, max-age=0";
  return headers;
}

function requestHeaders(source: IncomingMessage["headers"], target: URL) {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  headers.origin = target.origin;
  delete headers.referer;
  const cookie = withoutPlatformCookies(typeof source.cookie === "string" ? source.cookie : undefined);
  if (cookie) headers.cookie = cookie;
  else delete headers.cookie;
  return headers;
}

function sendError(response: ServerResponse, status: number, message: string) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body = Buffer.from(JSON.stringify({ error: message }), "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store, max-age=0",
    "content-length": String(body.length),
  });
  response.end(body);
}

function targetFor(request: IncomingMessage, config: ApiUpstreamConfig) {
  const incoming = new URL(request.url ?? "/", "http://preview.local");
  const rest = incoming.pathname === API_UPSTREAM_PREFIX
    ? "/"
    : incoming.pathname.slice(API_UPSTREAM_PREFIX.length);
  const target = new URL(config.origin);
  target.pathname = (config.basePath + rest).replace(/\/{2,}/g, "/") || "/";
  target.search = incoming.search;
  return target;
}

/**
 * Streams one request to the configured upstream. The request body is piped, so uploads are not
 * buffered twice; the response body is piped too. Redirects are returned to the browser with a
 * rewritten Location instead of followed, because every hop would need another public-address
 * check and is not needed by a normal API.
 */
export async function proxyApiUpstream(
  request: IncomingMessage,
  response: ServerResponse,
  config: ApiUpstreamConfig,
): Promise<void> {
  const target = targetFor(request, config);
  const addresses = await publicAddresses(target.hostname);
  const selected = addresses[0]!;
  const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
  const upstream = transport({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || undefined,
    path: target.pathname + target.search,
    method: request.method,
    headers: requestHeaders(request.headers, target),
    // The checked address is pinned for this request; the original name is kept for SNI and Host.
    lookup: ((_hostname: string, options: { all?: boolean }, callback: (error: Error | null, address?: unknown, family?: number) => void) => {
      if (options?.all) callback(null, addresses);
      else callback(null, selected.address, selected.family);
    }) as never,
  });

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) {
        upstream.destroy();
        sendError(response, 502, "API upstream недоступен: " + error.message);
      }
      resolve();
    };

    upstream.setTimeout(PROXY_TIMEOUT_MS, () => {
      upstream.destroy(new Error("API upstream не ответил за " + Math.round(PROXY_TIMEOUT_MS / 1000) + " с"));
    });
    upstream.on("response", upstreamResponse => {
      const headers = responseHeaders(upstreamResponse.headers, target, config);
      response.writeHead(upstreamResponse.statusCode ?? 502, headers);
      upstreamResponse.pipe(response);
      upstreamResponse.on("end", () => finish());
      upstreamResponse.on("error", finish);
    });
    upstream.on("error", finish);
    request.on("aborted", () => upstream.destroy(new Error("запрос клиента прерван")));

    let size = 0;
    request.on("data", chunk => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        upstream.destroy(new Error("тело запроса больше предела предпросмотра"));
        if (!response.headersSent) sendError(response, 413, "Запрос больше предела, который принимает предпросмотр.");
      }
    });
    request.pipe(upstream);
  });
}
