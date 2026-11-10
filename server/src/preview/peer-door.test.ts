import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { Duplex } from "node:stream";
import { forwardPreviewHttp, forwardPreviewUpgrade } from "./peer-door.js";
import { isLocalPreviewOwner, normalizePreviewOwnerAddress, previewOwnerTarget } from "./preview-owner.js";

const serverSockets = new WeakMap<http.Server, Set<Duplex>>();

function listen(server: http.Server): Promise<number> {
  const sockets = new Set<Duplex>();
  serverSockets.set(server, sockets);
  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("нет адреса"));
      else resolve(address.port);
    });
  });
}

function close(server: http.Server): Promise<void> {
  // `closeAllConnections` не закрывает сокеты, поднятые до WebSocket, поэтому их держим сами.
  for (const socket of serverSockets.get(server) ?? []) socket.destroy();
  server.closeAllConnections?.();
  return new Promise(resolve => server.close(() => resolve()));
}

function bodyOf(request: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function call(
  port: number,
  options: { method: string; path: string; headers?: Record<string, string> },
  body?: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, method: options.method, path: options.path, headers: options.headers },
      response => {
        bodyOf(response).then(buffer => resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: buffer.toString(),
        }), reject);
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

test("адрес двери нормализуется, а пути и учётные данные отклоняются", () => {
  assert.deepEqual(previewOwnerTarget("10.0.0.5:8788"), { host: "10.0.0.5", port: 8788 });
  assert.deepEqual(previewOwnerTarget("http://10.0.0.5"), { host: "10.0.0.5", port: 8788 });
  assert.equal(normalizePreviewOwnerAddress("http://10.0.0.5:8788/"), "10.0.0.5:8788");
  assert.equal(previewOwnerTarget("http://10.0.0.5:8788/path"), null);
  assert.equal(previewOwnerTarget("http://user:pass@10.0.0.5:8788"), null);
  assert.equal(isLocalPreviewOwner(undefined), true, "старые строки без owner обслуживаются локально");
});

test("HTTP-запрос уходит владельцу с публичным Host, cookie и телом", async () => {
  const owner = http.createServer(async (request, response) => {
    const body = await bodyOf(request);
    response.setHeader("x-preview-owner", "yes");
    response.end([request.headers.host, request.headers.cookie, body.toString()].join("|"));
  });
  const ownerPort = await listen(owner);
  const door = http.createServer(async (request, response) => {
    try {
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : await bodyOf(request);
      await forwardPreviewHttp(request, response, `127.0.0.1:${ownerPort}`, body);
    } catch {
      response.writeHead(502);
      response.end("owner unavailable");
    }
  });
  const doorPort = await listen(door);
  try {
    const get = await call(doorPort, {
      method: "GET",
      path: "/index.html",
      headers: { host: "team.preview.nestdev.ru", cookie: "nest_preview=ticket" },
    });
    assert.equal(get.status, 200);
    assert.equal(get.headers["x-preview-owner"], "yes");
    assert.equal(get.body, "team.preview.nestdev.ru|nest_preview=ticket|");

    const post = await call(doorPort, {
      method: "POST",
      path: "/api/save",
      headers: { host: "team.preview.nestdev.ru", cookie: "nest_preview=ticket", "content-type": "text/plain" },
    }, "payload");
    assert.equal(post.body, "team.preview.nestdev.ru|nest_preview=ticket|payload");
  } finally {
    await close(door);
    await close(owner);
  }
});

test("WebSocket upgrade уходит владельцу и сохраняет Host", async () => {
  const owner = http.createServer();
  owner.on("upgrade", (request, socket) => {
    assert.equal(request.headers.host, "team.preview.nestdev.ru");
    assert.equal(request.headers.upgrade, "websocket");
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", chunk => {
      if (chunk.toString() === "ping") socket.write("pong");
    });
  });
  const ownerPort = await listen(owner);
  const door = http.createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  door.on("upgrade", (request, socket, head) => {
    forwardPreviewUpgrade(request, socket, head, `127.0.0.1:${ownerPort}`, error => {
      socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n" + error.message);
    });
  });
  const doorPort = await listen(door);
  try {
    await new Promise<void>((resolve, reject) => {
      const request = http.request({
        host: "127.0.0.1",
        port: doorPort,
        path: "/__hmr",
        headers: {
          host: "team.preview.nestdev.ru",
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        },
      });
      const timer = setTimeout(() => {
        request.destroy();
        reject(new Error("upgrade не пришёл"));
      }, 5_000);
      request.on("upgrade", (response, socket) => {
        try {
          assert.equal(response.statusCode, 101);
          socket.once("data", chunk => {
            try {
              assert.equal(chunk.toString(), "pong");
              clearTimeout(timer);
              socket.destroy();
              resolve();
            } catch (error) {
              reject(error);
            }
          });
          socket.write("ping");
        } catch (error) {
          reject(error);
        }
      });
      request.on("error", error => {
        clearTimeout(timer);
        reject(error);
      });
      request.end();
    });
  } finally {
    await close(door);
    await close(owner);
  }
});
