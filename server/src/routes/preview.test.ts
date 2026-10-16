import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import Fastify from "fastify";
import { registerPreviewRoutes, type PreviewRouteDeps } from "./preview.js";
import { previewProxyBase } from "../preview/preview-rewrite.js";
import type { PreviewStatus } from "../preview/types.js";

type Upstream = { server: Server; port: number; close: () => Promise<void>; hits: string[] };

async function upstream(handler: (url: string, contentType: string, body: Buffer) => { body: Buffer; contentType?: string; headers?: Record<string, string>; status?: number }): Promise<Upstream> {
  const hits: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk as Buffer));
    request.on("end", () => {
      const url = request.url ?? "/";
      hits.push(url);
      const result = handler(url, String(request.headers["content-type"] ?? ""), Buffer.concat(chunks));
      response.writeHead(result.status ?? 200, { "content-type": result.contentType ?? "text/html; charset=utf-8", ...(result.headers ?? {}) });
      response.end(result.body);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, port, hits, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

function depsFor(port: number, overrides: Partial<PreviewRouteDeps> = {}): PreviewRouteDeps {
  const status: PreviewStatus = { running: true, ready: true, host: "127.0.0.1", port, containerId: "test", startedAt: 0 };
  return {
    authorize: async () => true,
    getSandbox: async () => { throw new Error("getSandbox не ожидается в этом тесте"); },
    startPreview: async () => status,
    stopPreview: async () => ({ stopped: true }),
    previewStatus: async () => status,
    previewLogs: async () => ({ running: true, logs: "" }),
    touchPreview: () => true,
    ...overrides,
  };
}

async function appWith(deps: PreviewRouteDeps) {
  const app = Fastify();
  await registerPreviewRoutes(app, deps);
  await app.ready();
  return app;
}

test("the proxy rewrites the app's root-absolute urls onto the proxy prefix", async () => {
  const page = '<!doctype html><html><head><script type="module" src="/@vite/client"></script></head><body><img src="/logo.png"></body></html>';
  const site = await upstream(() => ({ body: Buffer.from(page) }));
  const app = await appWith(depsFor(site.port));
  try {
    const response = await app.inject({ method: "GET", url: "/api/projects/p1/preview/open/" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["content-type"], "text/html; charset=utf-8");
    const base = previewProxyBase("p1");
    assert.ok(response.body.includes('src="' + base + '@vite/client"'), response.body);
    assert.ok(response.body.includes('src="' + base + 'logo.png"'), response.body);
    assert.equal(site.hits.at(-1), "/");
  } finally {
    await app.close();
    await site.close();
  }
});

test("javascript module specifiers are rewritten and the app's own framing headers are dropped", async () => {
  const code = 'import { createRoot } from "/node_modules/.vite/deps/react.js";\nconst router=[{path:"/about"}];';
  const site = await upstream(() => ({
    body: Buffer.from(code),
    contentType: "application/javascript",
    headers: { "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" },
  }));
  const app = await appWith(depsFor(site.port));
  try {
    const response = await app.inject({ method: "GET", url: "/api/projects/p1/preview/open/src/main.tsx" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["x-frame-options"], undefined);
    assert.equal(response.headers["content-security-policy"], undefined);
    const base = previewProxyBase("p1");
    assert.ok(response.body.includes('from "' + base + 'node_modules/.vite/deps/react.js"'), response.body);
    assert.ok(response.body.includes('path:"/about"'), response.body);
    assert.equal(site.hits.at(-1), "/src/main.tsx");
  } finally {
    await app.close();
    await site.close();
  }
});

test("binary responses pass through untouched and the query string is forwarded", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const site = await upstream(() => ({ body: png, contentType: "image/png" }));
  const app = await appWith(depsFor(site.port));
  try {
    const response = await app.inject({ method: "GET", url: "/api/projects/p1/preview/open/logo.png?v=2" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.rawPayload, png);
    assert.equal(site.hits.at(-1), "/logo.png?v=2");
  } finally {
    await app.close();
    await site.close();
  }
});

test("the heartbeat marks the project as used and reports whether a preview is open", async () => {
  const touched: string[] = [];
  const app = await appWith(depsFor(1, { touchPreview: projectId => { touched.push(projectId); return true; } }));
  try {
    const response = await app.inject({ method: "POST", url: "/api/projects/p1/preview/touch" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ok: true });
    assert.deepEqual(touched, ["p1"]);
  } finally {
    await app.close();
  }
});

test("the preview address without the trailing slash is redirected onto the canonical one", async () => {
  const site = await upstream(() => ({ body: Buffer.from("<html><body>ok</body></html>") }));
  const app = await appWith(depsFor(site.port));
  try {
    // Без слэша относительные ссылки приложения ("style.css") уходят на уровень выше — в JSON-404,
    // поэтому браузер отказывается применять стили и скрипты. Вход всегда переводится на адрес со слэшем.
    const response = await app.inject({ method: "GET", url: "/api/projects/p1/preview/open" });
    assert.equal(response.statusCode, 302);
    assert.equal(response.headers.location, previewProxyBase("p1"));
    assert.equal(site.hits.length, 0);
  } finally {
    await app.close();
    await site.close();
  }
});

/**
 * Приложение приняло соединение и молчит. Раньше прокси ждал общего таймаута запроса, и панель всё это
 * время показывала пустой белый кадр: пользователь видел «ничего». Теперь отказ ограничен бюджетом и
 * назван словами — «не ответил за N с», а не «fetch failed».
 */
test("an app that accepts the connection but never answers is named as a timeout instead of a white frame", async () => {
  const silent = createServer(() => {});
  await new Promise<void>(resolve => silent.listen(0, "127.0.0.1", resolve));
  const address = silent.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const previous = process.env.PREVIEW_PROXY_TIMEOUT_MS;
  process.env.PREVIEW_PROXY_TIMEOUT_MS = "150";
  const app = await appWith(depsFor(port));
  try {
    const response = await app.inject({ method: "GET", url: "/api/projects/p1/preview/open/" });
    assert.equal(response.statusCode, 400);
    assert.match(response.body, /Прокси предпросмотра не сработал/);
    assert.match(response.body, /не ответил за 1 с/, response.body);
    assert.match(response.body, /снаружи недоступно/, response.body);
  } finally {
    if (previous === undefined) delete process.env.PREVIEW_PROXY_TIMEOUT_MS;
    else process.env.PREVIEW_PROXY_TIMEOUT_MS = previous;
    await app.close();
    silent.closeAllConnections?.();
    await new Promise<void>(resolve => silent.close(() => resolve()));
  }
});

test("a refused connection keeps the plain reason, not a timeout sentence", async () => {
  // На этом порту никто не слушает: это другой диагноз (порт/предпросмотр упал), и он не должен
  // подменяться сообщением про сеть.
  const probe = createServer(() => {});
  await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const app = await appWith(depsFor(port));
  try {
    const response = await app.inject({ method: "GET", url: "/api/projects/p1/preview/open/" });
    assert.equal(response.statusCode, 400);
    assert.match(response.body, /Прокси предпросмотра не сработал/);
    assert.doesNotMatch(response.body, /не ответил за/, response.body);
  } finally {
    await app.close();
  }
});

test("a stopped preview answers with an error instead of an empty page", async () => {
  const app = await appWith(depsFor(1, { previewStatus: async () => ({ running: false }) }));
  try {
    const response = await app.inject({ method: "GET", url: "/api/projects/p1/preview/open/" });
    // 400 с причиной, а не 500 «Внутренняя ошибка сервера»: панель показывает её пользователю.
    assert.equal(response.statusCode, 400);
    assert.match(response.body, /Предпросмотр не запущен/);
  } finally {
    await app.close();
  }
});
