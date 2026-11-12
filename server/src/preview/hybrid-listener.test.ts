import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHybridListener, isBackendPath } from "./hybrid-listener.js";
import { SESSION_COOKIE } from "../auth/auth.js";

async function staticDir() {
  const root = await mkdtemp(path.join(tmpdir(), "webnestdev-hybrid-listener-"));
  await mkdir(path.join(root, "assets"), { recursive: true });
  await writeFile(path.join(root, "index.html"), "<html><body>hybrid frontend</body></html>");
  await writeFile(path.join(root, "assets/app.js"), "console.log('asset')");
  return root;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (typeof address === "object" && address) resolve(address.port);
      else reject(new Error("no port"));
    });
  });
}

async function backend() {
  const requests: Array<{ method?: string; url?: string; body: string; cookie: string }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      requests.push({
        method: request.method,
        url: request.url,
        body: Buffer.concat(chunks).toString("utf8"),
        cookie: String(request.headers.cookie ?? ""),
      });
      if (request.url === "/api/echo") {
        response.writeHead(201, { "content-type": "application/json", "set-cookie": ["app=1; Path=/", "second=2; Path=/"] });
        response.end(JSON.stringify({ ok: true, body: Buffer.concat(chunks).toString("utf8") }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, url: request.url }));
    });
  });
  const port = await listen(server);
  return { server, port, requests };
}

test("backend paths match only a slash-delimited prefix", () => {
  assert.equal(isBackendPath("/api", ["/api"]), true);
  assert.equal(isBackendPath("/api/users?x=1", ["/api"]), true);
  assert.equal(isBackendPath("/apiary", ["/api"]), false);
  assert.equal(isBackendPath("/ws", ["/api", "/ws"]), true);
});

test("hybrid listener serves static files and proxies API methods, body and cookies", async () => {
  const dir = await staticDir();
  const api = await backend();
  const listener = await createHybridListener({
    dir,
    backendHost: "127.0.0.1",
    backendPort: api.port,
    backendPaths: ["/api", "/ws"],
  });
  try {
    const base = "http://127.0.0.1:" + listener.port;
    const page = await fetch(base + "/");
    assert.equal(page.status, 200);
    assert.match(await page.text(), /hybrid frontend/);
    assert.equal(page.headers.get("cache-control"), "no-store, max-age=0");

    const clientRoute = await fetch(base + "/settings/profile");
    assert.equal(clientRoute.status, 200);
    assert.match(await clientRoute.text(), /hybrid frontend/);

    const asset = await fetch(base + "/assets/app.js");
    assert.equal(asset.status, 200);
    assert.match(await asset.text(), /asset/);

    const apiResponse = await fetch(base + "/api/users?limit=2", {
      headers: { cookie: SESSION_COOKIE + "=platform-secret; app=kept" },
    });
    assert.equal(apiResponse.status, 200);
    assert.equal((await apiResponse.json() as { ok: boolean }).ok, true);
    assert.equal(api.requests[0]?.url, "/api/users?limit=2");
    assert.equal(api.requests[0]?.cookie, "app=kept");

    const post = await fetch(base + "/api/echo", {
      method: "POST",
      body: "payload",
      headers: { "content-type": "text/plain" },
    });
    assert.equal(post.status, 201);
    assert.equal((await post.json() as { body: string }).body, "payload");
    assert.deepEqual(post.headers.getSetCookie(), ["app=1; Path=/", "second=2; Path=/"]);

    // `/apiary` is not `/api`; it is a frontend route, not a backend call.
    const notApi = await fetch(base + "/apiary");
    assert.equal(notApi.status, 200);
    assert.match(await notApi.text(), /hybrid frontend/);

    // A missing asset remains a 404 instead of becoming the SPA entry point.
    assert.equal((await fetch(base + "/assets/missing.js")).status, 404);
  } finally {
    await listener.close();
    await new Promise<void>(resolve => api.server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("hybrid listener returns JSON 502, never index.html, when the backend is down", async () => {
  const dir = await staticDir();
  const api = await backend();
  const listener = await createHybridListener({
    dir,
    backendHost: "127.0.0.1",
    backendPort: api.port,
    backendPaths: ["/api"],
  });
  try {
    await new Promise<void>(resolve => api.server.close(() => resolve()));
    const response = await fetch("http://127.0.0.1:" + listener.port + "/api/health");
    assert.equal(response.status, 502);
    assert.match(String(response.headers.get("content-type")), /application\/json/);
    assert.doesNotMatch(await response.text(), /hybrid frontend/);
  } finally {
    await listener.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("hybrid listener upgrades a configured WebSocket path to the backend", async () => {
  const dir = await staticDir();
  const api = createServer();
  api.on("upgrade", (_request, socket) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.write("backend-hello");
  });
  const backendPort = await listen(api);
  const listener = await createHybridListener({
    dir,
    backendHost: "127.0.0.1",
    backendPort,
    backendPaths: ["/ws"],
  });
  try {
    const socket = connect(listener.port, "127.0.0.1");
    const received = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      socket.on("data", chunk => {
        chunks.push(Buffer.from(chunk));
        if (Buffer.concat(chunks).toString("utf8").includes("backend-hello")) resolve(Buffer.concat(chunks).toString("utf8"));
      });
      socket.on("error", reject);
      socket.on("connect", () => {
        socket.write("GET /ws HTTP/1.1\r\nHost: preview.local\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
      });
    });
    assert.match(received, /101 Switching Protocols/);
    assert.match(received, /backend-hello/);
    socket.destroy();
  } finally {
    await listener.close();
    // The fake backend's upgraded socket is not owned by the listener once the client is gone;
    // destroy it explicitly so `server.close()` does not wait for an upgraded connection.
    api.closeAllConnections?.();
    await new Promise<void>(resolve => {
      api.close(() => resolve());
      setTimeout(resolve, 100);
    });
    await rm(dir, { recursive: true, force: true });
  }
});
