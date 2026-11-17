import http from "node:http";
import net from "node:net";
import { timingSafeEqual } from "node:crypto";
import { internalApiPort, internalApiTokenConfigured, ownerRoutingEnabled } from "../sandbox/workspace-mode.js";

/**
 * Внутренняя дверь ноды-владельца.
 *
 * Публичный API слушает loopback за Caddy. Этот listener нужен только для приватной сети между
 * нодами: он принимает запрос от owner-router соседней ноды, проверяет общий токен и передаёт
 * запрос локальному API. Наружу порт не публикуется; compose привязывает его к приватному IP.
 *
 * Дверь не является вторым API и не содержит маршрутов: только проверка токена и потоковая
 * пересылка HTTP/WebSocket на `127.0.0.1:PORT`.
 */

const PROJECT_PATH = /^\/api\/projects\/[^/?#]+(?:\/|$)/;
const INTERNAL_RESTORE_PATH = /^\/api\/internal\/workspace\/restore$/;

export type OwnerDoorOptions = {
  port?: number;
  apiPort?: number;
  host?: string;
  token?: string;
};

export type OwnerDoorHandle = {
  port: number;
  close: () => Promise<void>;
};

function tokenMatches(received: string, expected: string): boolean {
  if (expected.length < 32 || received.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(received), Buffer.from(expected));
  } catch {
    return false;
  }
}

function allowedPath(url: string | undefined): boolean {
  const path = (url ?? "").split("?")[0] ?? "";
  if (PROJECT_PATH.test(path)) return true;
  if (INTERNAL_RESTORE_PATH.test(path)) return true;
  // WebSocket агента: projectId обязателен в query, иначе владельца выбрать нельзя.
  if (path === "/ws") {
    const query = new URLSearchParams((url ?? "").split("?")[1] ?? "");
    return Boolean(query.get("projectId")?.trim());
  }
  return false;
}

function filteredHeaders(headers: http.IncomingHttpHeaders, token: string): http.OutgoingHttpHeaders {
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
  result["x-webnestdev-internal"] = "1";
  result["x-webnestdev-internal-token"] = token;
  return result;
}

function reject(res: http.ServerResponse, status: number, message: string) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", connection: "close" });
  res.end(JSON.stringify({ error: message }));
}

export async function startOwnerDoor(options: OwnerDoorOptions = {}): Promise<OwnerDoorHandle | null> {
  if (!ownerRoutingEnabled()) return null;
  const token = options.token ?? process.env.WEBNESTDEV_INTERNAL_TOKEN?.trim() ?? "";
  if (!internalApiTokenConfigured({ ...process.env, WEBNESTDEV_INTERNAL_TOKEN: token })) {
    console.warn("[owner] внутренняя дверь не поднята: WEBNESTDEV_INTERNAL_TOKEN не задан или короче 32 символов");
    return null;
  }
  const port = options.port ?? internalApiPort();
  const apiPort = options.apiPort ?? Number(process.env.PORT ?? 8787);
  if (port === apiPort) {
    console.warn("[owner] внутренняя дверь не поднята: порт совпадает с публичным API");
    return null;
  }
  const host = options.host ?? "0.0.0.0";

  const server = http.createServer((request, response) => {
    const received = (request.headers["x-webnestdev-internal-token"] ?? "").toString();
    if (!tokenMatches(received, token)) {
      reject(response, 401, "Внутренний токен не принят");
      return;
    }
    if (!allowedPath(request.url)) {
      reject(response, 404, "Внутренняя дверь обслуживает только проектные маршруты");
      return;
    }

    const upstream = http.request(
      {
        hostname: "127.0.0.1",
        port: apiPort,
        method: request.method,
        path: request.url ?? "/",
        headers: {
          ...filteredHeaders(request.headers, token),
          host: "127.0.0.1:" + apiPort,
        },
      },
      answer => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
      },
    );
    upstream.once("error", error => {
      if (!response.headersSent) reject(response, 502, "Локальный API недоступен: " + error.message);
      else response.destroy(error);
    });
    request.once("aborted", () => upstream.destroy());
    request.pipe(upstream);
  });

  server.on("upgrade", (request, socket, head) => {
    const received = (request.headers["x-webnestdev-internal-token"] ?? "").toString();
    if (!tokenMatches(received, token) || !allowedPath(request.url)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = net.connect(apiPort, "127.0.0.1", () => {
      const headers = filteredHeaders(request.headers, token);
      headers.host = "127.0.0.1:" + apiPort;
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
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  }).catch(error => {
    console.warn(
      "[owner] внутренняя дверь не поднялась на порту " + port + ": " +
        (error instanceof Error ? error.message : String(error)),
    );
    return null;
  });
  if (!server.listening) return null;

  console.log("[owner] внутренняя дверь слушает " + host + ":" + port + " → 127.0.0.1:" + apiPort);
  return {
    port,
    close: () =>
      new Promise<void>(resolve => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
