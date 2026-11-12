import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { withoutPlatformCookies } from "./preview-proxy.js";

/**
 * The API-side half of a hybrid preview.
 *
 * The listener serves the built frontend from `dir` and sends only the configured paths to the
 * backend container. It lives next to the static preview listener because both must be reached
 * through the API process's owner door; the backend itself stays a normal container and is never
 * published on a host port.
 *
 * Fastify's `onRequest` hook runs before the static plugin's route matcher. That is what keeps
 * `/api` from becoming `index.html`: the hook hijacks the reply and pipes the raw request to the
 * backend. WebSocket upgrades are handled on the Node server directly, because Fastify's normal
 * request pipeline does not own upgraded sockets.
 */

const LOOPBACK = "127.0.0.1";
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

export type HybridListenerOptions = {
  dir: string;
  backendHost: string;
  backendPort: number;
  backendPaths: string[];
};

export type HybridListener = {
  app: FastifyInstance;
  port: number;
  close: () => Promise<void>;
};

/** A backend path matches the exact prefix or a slash-delimited child, never `/apiary`. */
export function isBackendPath(rawUrl: string | undefined, backendPaths: string[]): boolean {
  const pathname = new URL(rawUrl ?? "/", "http://preview.local").pathname;
  return backendPaths.some(prefix => pathname === prefix || pathname.startsWith(prefix + "/"));
}

function responseHeaders(source: IncomingMessage["headers"]): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  // A preview is always the latest project state, including API responses.
  headers["cache-control"] = "no-store, max-age=0";
  return headers;
}

function requestHeaders(source: IncomingMessage["headers"], backendHost: string, backendPort: number): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  headers.host = backendHost + ":" + backendPort;
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

/** Raw HTTP proxy for API calls: body and response are streamed, cookies are preserved. */
function proxyHttp(
  request: IncomingMessage,
  response: ServerResponse,
  options: Pick<HybridListenerOptions, "backendHost" | "backendPort">,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const upstream = httpRequest(
      {
        host: options.backendHost,
        port: options.backendPort,
        method: request.method,
        path: request.url ?? "/",
        headers: requestHeaders(request.headers, options.backendHost, options.backendPort),
      },
      upstreamResponse => {
        const headers = responseHeaders(upstreamResponse.headers);
        response.writeHead(upstreamResponse.statusCode ?? 502, headers);
        upstreamResponse.pipe(response);
        upstreamResponse.on("end", resolve);
        upstreamResponse.on("error", reject);
      },
    );
    upstream.setTimeout(PROXY_TIMEOUT_MS, () => {
      upstream.destroy(new Error("backend не ответил за " + Math.round(PROXY_TIMEOUT_MS / 1000) + " с"));
    });
    upstream.on("error", error => {
      if (!response.headersSent) sendError(response, 502, "Backend предпросмотра недоступен: " + error.message);
      resolve();
    });
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

function upgradeHeaders(request: IncomingMessage, backendHost: string, backendPort: number): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    // `connection` and `upgrade` are required for the handshake and must survive.
    if (lower === "host" || lower === "proxy-connection") continue;
    if (lower === "cookie") {
      const cookie = withoutPlatformCookies(typeof value === "string" ? value : value.join("; "));
      if (!cookie) continue;
      lines.push("cookie: " + cookie);
      continue;
    }
    lines.push(name + ": " + (Array.isArray(value) ? value.join(", ") : value));
  }
  lines.push("host: " + backendHost + ":" + backendPort);
  return lines.join("\r\n") + "\r\n\r\n";
}

function proxyUpgrade(
  request: IncomingMessage,
  socket: Socket,
  head: Buffer,
  options: Pick<HybridListenerOptions, "backendHost" | "backendPort">,
  register?: (socket: Socket) => void,
) {
  // Only the TCP handshake is bounded. A live HMR/socket.io connection may be idle for minutes;
  // an idle timeout on the tunneled socket would disconnect it just for having nothing to say.
  const handshakeTimer = setTimeout(() => {
    upstream.destroy();
    socket.destroy();
  }, PROXY_TIMEOUT_MS);
  const upstream = netConnect(options.backendPort, options.backendHost, () => {
    clearTimeout(handshakeTimer);
    upstream.write((request.method ?? "GET") + " " + (request.url ?? "/") + " HTTP/1.1\r\n");
    upstream.write(upgradeHeaders(request, options.backendHost, options.backendPort));
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  register?.(upstream);
  const clearHandshake = () => clearTimeout(handshakeTimer);
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
  // Either side closing is the end of the tunnel; without this a closed browser leaves the
  // upstream socket alive and the backend's server.close() waits forever.
  socket.on("close", () => { clearHandshake(); upstream.destroy(); });
  upstream.on("close", () => { clearHandshake(); socket.destroy(); });
  upstream.on("connect", clearHandshake);
}

function looksLikeFile(url: string | undefined): boolean {
  const pathname = new URL(url ?? "/", "http://preview.local").pathname;
  return /\.[a-z0-9]{1,8}$/i.test(pathname);
}

/**
 * Create the listener without starting it. Tests can call this with a fake backend and a
 * temporary static directory, without Docker or the rest of the preview manager.
 */
export async function createHybridListener(options: HybridListenerOptions): Promise<HybridListener> {
  const app = Fastify({ logger: false, disableRequestLogging: true, bodyLimit: MAX_BODY_BYTES });

  // This hook must be registered before the static plugin. It hijacks backend paths before
  // Fastify parses a body or serves a client-side route. It is async because Fastify waits for
  // a two-argument hook that returns a promise; static responses also get no-store here.
  app.addHook("onRequest", async (request, reply) => {
    reply.header("cache-control", "no-store, max-age=0");
    if (!isBackendPath(request.raw.url, options.backendPaths)) return;
    reply.hijack();
    void proxyHttp(request.raw, reply.raw, options).catch(error => {
      sendError(reply.raw, 502, "Backend предпросмотра недоступен: " + (error instanceof Error ? error.message : String(error)));
    });
  });

  // Static responses are part of a live preview too: never let a reload show an older build.
  // `onSend` runs after @fastify/static has set its own cache header. This hook must be async;
  // Fastify's two-argument sync hook would be treated as not finished.
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store, max-age=0");
    return payload;
  });

  await app.register(fastifyStatic, {
    root: options.dir,
    index: ["index.html"],
    maxAge: 0,
    cacheControl: true,
  });
  app.setNotFoundHandler((request, reply) => {
    if (request.method === "GET" || request.method === "HEAD") {
      if (!looksLikeFile(request.raw.url)) return reply.sendFile("index.html", { maxAge: 0, immutable: false });
    }
    return reply.code(404).send({ error: "Not Found" });
  });

  // Fastify leaves upgraded sockets to the Node server. Only configured backend paths may reach
  // the backend; an unknown WebSocket path is closed instead of being handed to static files.
  // The set is needed because `server.close()` does not track upgraded sockets, so without it
  // closing a preview with an open HMR/WebSocket connection would wait forever.
  const upgraded = new Set<Socket>();
  const upstreams = new Set<Socket>();
  app.server.on("upgrade", (request, socket, head) => {
    if (!isBackendPath(request.url, options.backendPaths)) {
      socket.destroy();
      return;
    }
    upgraded.add(socket as Socket);
    socket.once("close", () => upgraded.delete(socket as Socket));
    proxyUpgrade(request, socket as Socket, head, options, upstream => {
      upstreams.add(upstream);
      upstream.once("close", () => upstreams.delete(upstream));
    });
  });

  await app.listen({ host: LOOPBACK, port: 0 });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  if (!port) {
    await app.close().catch(() => undefined);
    throw new Error("Не удалось определить порт hybrid-предпросмотра");
  }

  return {
    app,
    port,
    close: async () => {
      for (const socket of upstreams) socket.destroy();
      for (const socket of upgraded) socket.destroy();
      upstreams.clear();
      upgraded.clear();
      app.server.closeIdleConnections?.();
      app.server.closeAllConnections?.();
      await app.close().catch(() => undefined);
    },
  };
}

/** Exported for a unit test that only needs the raw response header policy. */
export function hybridResponseHeaders(headers: IncomingMessage["headers"]) {
  return responseHeaders(headers);
}
