import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getProject } from "../project-store.js";
import { getNode } from "./node-store.js";
import { nodeId } from "./identity.js";
import { internalApiPort, internalApiTokenConfigured, ownerRoutingEnabled } from "../sandbox/workspace-mode.js";

/**
 * Owner-routing для проектных HTTP-запросов.
 *
 * В shared-режиме этот слой выключен и ничего не делает. Когда он включён, запрос к
 * `/api/projects/:id/...` проверяет `project.node` и, если владелец — другая нода, пересылает
 * запрос на её приватный внутренний listener. Проксирование идёт потоком: upload/download не
 * буферизуются в память.
 *
 * WebSocket `/ws` здесь пока не проксируется: он требует решения до upgrade и отдельного
 * маршрута с `projectId` в query. До этого локальный режим включать нельзя.
 */

const PROJECT_PATH = /^(?:\/api\/projects|\/api\/admin\/projects)\/([^/?#]+)(?:\/|$)/;

export function projectIdFromUrl(url: string | undefined): string | null {
  const path = (url ?? "").split("?")[0] ?? "";
  const match = PROJECT_PATH.exec(path);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function projectIdFromQuery(url: string | undefined): string | null {
  const raw = (url ?? "").split("?")[1] ?? "";
  if (!raw) return null;
  const value = new URLSearchParams(raw).get("projectId")?.trim();
  return value || null;
}

type Target = { protocol: "http:" | "https:"; hostname: string; port: number };

export function ownerTarget(address: string, fallbackPort = internalApiPort()): Target | null {
  const raw = address.trim();
  if (!raw) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : "http://" + raw);
    if (!url.hostname) return null;
    if (url.pathname && url.pathname !== "/") return null;
    if (url.username || url.password) return null;
    const port = url.port ? Number(url.port) : fallbackPort;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return {
      protocol: url.protocol === "https:" ? "https:" : "http:",
      hostname: url.hostname,
      port,
    };
  } catch {
    return null;
  }
}

function copyHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const result: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (name === "connection" || name === "keep-alive" || name === "host") continue;
    if (name === "proxy-authenticate" || name === "proxy-authorization") continue;
    if (name === "te" || name === "trailer" || name === "transfer-encoding") continue;
    if (name === "upgrade") continue;
    if (name === "x-webnestdev-internal" || name === "x-webnestdev-internal-token") continue;
    result[name] = value;
  }
  return result;
}

function responseHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const result: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (name === "connection" || name === "keep-alive") continue;
    if (name === "proxy-authenticate" || name === "proxy-authorization") continue;
    if (name === "te" || name === "trailer" || name === "transfer-encoding") continue;
    if (name === "upgrade") continue;
    result[name] = value;
  }
  return result;
}

function respond(reply: FastifyReply, status: number, message: string, code: string) {
  if (reply.raw.headersSent) return;
  reply.code(status).send({ error: message, code });
}

/**
 * Пересылает запрос владельцу и отдаёт ответ как есть. `reply.hijack()` обязателен: иначе
 * Fastify попытается отправить собственный ответ после того, как мы уже начали писать в сокет.
 */
async function proxyToOwner(
  request: FastifyRequest,
  reply: FastifyReply,
  target: Target,
  token: string,
): Promise<void> {
  const transport = target.protocol === "https:" ? await import("node:https") : null;
  const upstream = (transport?.request ?? http.request)({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    method: request.method,
    path: request.raw.url ?? "/",
    headers: {
      ...copyHeaders(request.raw.headers),
      host: target.hostname + ":" + target.port,
      "x-webnestdev-internal": "1",
      "x-webnestdev-internal-token": token,
      "x-webnestdev-forwarded-by": nodeId(),
    },
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };

    upstream.once("response", response => {
      reply.hijack();
      const status = response.statusCode ?? 502;
      reply.raw.writeHead(status, responseHeaders(response.headers));
      response.pipe(reply.raw);
      response.once("end", () => finish());
      response.once("close", () => finish());
      response.once("error", error => finish(error));
    });
    upstream.once("error", error => finish(error));
    request.raw.once("aborted", () => {
      upstream.destroy();
      finish();
    });
    request.raw.pipe(upstream);
  });
}

/**
 * Хук ставится до проектных маршрутов. Если routing выключен, он сразу возвращается, поэтому
 * shared-режим не получает ни лишних чтений БД, ни сетевых вызовов.
 */
function websocketHeaders(headers: http.IncomingHttpHeaders, token: string, target: Target): http.OutgoingHttpHeaders {
  const result: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    // `Connection: Upgrade` обязателен для WebSocket: без него дверь владельца видит
    // обычный GET и отдаёт 404 вместо 101.
    if (name === "connection") {
      result[name] = value;
      continue;
    }
    if (name === "keep-alive" || name === "host") continue;
    if (name === "proxy-authenticate" || name === "proxy-authorization") continue;
    if (name === "te" || name === "trailer" || name === "transfer-encoding") continue;
    if (name === "x-webnestdev-internal" || name === "x-webnestdev-internal-token") continue;
    result[name] = value;
  }
  result.host = target.hostname + ":" + target.port;
  result["x-webnestdev-internal"] = "1";
  result["x-webnestdev-internal-token"] = token;
  result["x-webnestdev-forwarded-by"] = nodeId();
  return result;
}

function proxyWebSocket(
  request: http.IncomingMessage,
  socket: import("node:stream").Duplex,
  head: Buffer,
  target: Target,
  token: string,
): void {
  const upstream = target.protocol === "https:"
    ? tls.connect({ host: target.hostname, port: target.port })
    : net.connect(target.port, target.hostname);
  upstream.once(target.protocol === "https:" ? "secureConnect" : "connect", () => {
    const headers = websocketHeaders(request.headers, token, target);
    const lines = [request.method + " " + (request.url ?? "/") + " HTTP/" + request.httpVersion];
    for (const [name, value] of Object.entries(headers)) {
      if (Array.isArray(value)) for (const item of value) lines.push(name + ": " + item);
      else if (value !== undefined) lines.push(name + ": " + value);
    }
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.once("error", () => socket.destroy());
  socket.once("error", () => upstream.destroy());
}

/**
 * WebSocket ставится после регистрации штатного обработчика `/ws`: мы оборачиваем его upgrade-
 * listener, а не добавляем второй, иначе Fastify всё равно принял бы соединение локально.
 * Старый клиент без `projectId` в query обслуживается как раньше — только на текущей ноде.
 */
export function registerOwnerWebSocket(app: FastifyInstance): void {
  if (!ownerRoutingEnabled()) return;
  const original = app.server.listeners("upgrade") as Array<
    (request: http.IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => void
  >;
  if (!original.length) return;
  app.server.removeAllListeners("upgrade");
  app.server.on("upgrade", (request, socket, head) => {
    const projectId = projectIdFromQuery(request.url);
    if (!projectId) {
      for (const handler of original) handler.call(app.server, request, socket, head);
      return;
    }
    void (async () => {
      try {
        const project = await getProject(projectId);
        if (!project) {
          socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
          return;
        }
        const owner = project.node?.trim() || nodeId();
        if (owner === nodeId()) {
          for (const handler of original) handler.call(app.server, request, socket, head);
          return;
        }
        const token = process.env.WEBNESTDEV_INTERNAL_TOKEN?.trim() ?? "";
        if (!internalApiTokenConfigured()) {
          socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
          return;
        }
        const node = await getNode(owner);
        const target = node?.apiAddress ? ownerTarget(node.apiAddress) : null;
        if (!node || node.status === "offline" || !target) {
          socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
          return;
        }
        proxyWebSocket(request, socket, head, target, token);
      } catch {
        socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      }
    })();
  });
}

export function registerOwnerRouting(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    if (!ownerRoutingEnabled()) return;
    const projectId = projectIdFromUrl(request.raw.url);
    if (!projectId) return;

    const internal = request.headers["x-webnestdev-internal"] === "1";
    const token = (request.headers["x-webnestdev-internal-token"] ?? "").toString();
    const expected = process.env.WEBNESTDEV_INTERNAL_TOKEN?.trim() ?? "";
    if (internal && expected.length >= 32 && token === expected) return;

    if (!internalApiTokenConfigured()) {
      respond(reply, 503, "Owner-маршрутизация включена, но WEBNESTDEV_INTERNAL_TOKEN не задан", "OWNER_ROUTING_CONFIG");
      return;
    }

    const project = await getProject(projectId);
    if (!project) return;
    const owner = project.node?.trim() || nodeId();
    if (owner === nodeId()) return;

    const node = await getNode(owner);
    if (!node || node.status === "offline" || !node.apiAddress.trim()) {
      respond(
        reply,
        503,
        "Проект закреплён за узлом " + owner + ", но его внутренний API недоступен",
        "OWNER_UNAVAILABLE",
      );
      return;
    }
    const target = ownerTarget(node.apiAddress);
    if (!target) {
      respond(reply, 503, "Некорректный WEBNESTDEV_API_ADDRESS узла " + owner, "OWNER_ADDRESS");
      return;
    }

    try {
      await proxyToOwner(request, reply, target, expected);
    } catch (error) {
      request.log.warn(
        { error: error instanceof Error ? error.message : String(error), owner },
        "owner proxy failed",
      );
      if (!reply.raw.headersSent) {
        respond(reply, 502, "Не удалось переслать запрос ноде-владельцу " + owner, "OWNER_PROXY");
      } else {
        reply.raw.destroy();
      }
    }
  });
}
