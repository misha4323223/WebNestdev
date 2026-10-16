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
    // Без Docker: вторая дверь к приложению отвечает только там, где её подставил тест.
    execPreview: async () => null,
    getSandbox: async () => { throw new Error("getSandbox не ожидается в этом тесте"); },
    startPreview: async () => status,
    stopPreview: async () => ({ stopped: true }),
    previewStatus: async () => status,
    previewLogs: async () => ({ running: true, logs: "" }),
    touchPreview: () => true,
    // Публичные адреса предпросмотра выключены по умолчанию: тесты, которым они нужны, задают их сами.
    publicUrl: () => "",
    mintTicket: () => "",
    ticketTtlMs: () => 60_000,
    hostTarget: () => null,
    projectExists: async () => false,
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

/**
 * Живой предпросмотр — это всегда последняя версия проекта. Кэш (браузера или посредника) показывал
 * бы правки не сразу, а после правки конфига — вообще старый экран, поэтому обе двери отвечают
 * `no-store` и без валидаторов: подтвердить старую копию нечем.
 */
test("the framed app is never taken from a cache, whichever door answered", async () => {
  const stale = { etag: 'W/"stale"', "last-modified": "Wed, 01 Oct 2025 10:00:00 GMT", "cache-control": "public, max-age=600" };
  const site = await upstream(() => ({ body: Buffer.from("<html><body>direct</body></html>"), headers: stale }));
  const directApp = await appWith(depsFor(site.port));
  const execApp = await appWith(depsFor(1, {
    execPreview: async () => ({ status: 200, statusText: "OK", headers: { "content-type": "text/html; charset=utf-8", ...stale }, body: Buffer.from("<html><body>exec</body></html>"), truncated: false }),
  }));
  try {
    const direct = await directApp.inject({ method: "GET", url: "/api/projects/p1/preview/open/" });
    assert.equal(direct.statusCode, 200);
    assert.equal(direct.headers["cache-control"], "no-store, no-cache, must-revalidate, max-age=0", direct.body);
    assert.equal(direct.headers.etag, undefined);
    assert.equal(direct.headers["last-modified"], undefined);

    const throughExec = await execApp.inject({ method: "GET", url: "/api/projects/p1/preview/open/" });
    assert.equal(throughExec.statusCode, 200);
    assert.match(throughExec.body, /exec/);
    assert.equal(throughExec.headers["cache-control"], "no-store, no-cache, must-revalidate, max-age=0");
    assert.equal(throughExec.headers.etag, undefined);
    assert.equal(throughExec.headers["last-modified"], undefined);
  } finally {
    await execApp.close();
    await directApp.close();
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

/**
 * Адрес контейнера серверу недоступен — ровно так выглядит изоляция bridge-сетей: приложение живо
 * внутри контейнера, а прямой запрос сервера отваливается. Раньше это был белый кадр в панели;
 * теперь приложение отдаётся тем же путём, которым платформа спрашивает его о готовности.
 */
test("an unreachable container address is served through docker exec instead of a white frame", async () => {
  const page = '<!doctype html><html><head><script type="module" src="/@vite/client"></script></head><body>exec</body></html>';
  const calls: Array<{ path: string; method: string }> = [];
  const app = await appWith(depsFor(1, {
    execPreview: async input => {
      calls.push({ path: input.path, method: input.method });
      return { status: 200, statusText: "OK", headers: { "content-type": "text/html; charset=utf-8" }, body: Buffer.from(page), truncated: false };
    },
  }));
  try {
    const response = await app.inject({ method: "GET", url: "/api/projects/p1/preview/open/" });
    assert.equal(response.statusCode, 200);
    const base = previewProxyBase("p1");
    // Тело приложения — то же, что отдал бы прямой путь: корневые ссылки переписаны на префикс прокси.
    assert.ok(response.body.includes('src="' + base + '@vite/client"'), response.body);
    assert.ok(response.body.includes("exec"), response.body);
    assert.deepEqual(calls, [{ path: "/", method: "GET" }]);
  } finally {
    await app.close();
  }
});

test("a preview already on the exec path does not try the address it knows is unreachable", async () => {
  const site = await upstream(() => ({ body: Buffer.from("<html><body>direct</body></html>") }));
  const app = await appWith(depsFor(site.port, {
    previewStatus: async () => ({ running: true, ready: true, settled: false, viaExec: true, host: "127.0.0.1", port: site.port, containerId: "test", startedAt: 0 }),
    execPreview: async () => ({ status: 200, statusText: "OK", headers: { "content-type": "text/html; charset=utf-8" }, body: Buffer.from("<html><body>exec</body></html>"), truncated: false }),
  }));
  try {
    const response = await app.inject({ method: "GET", url: "/api/projects/p1/preview/open/" });
    assert.equal(response.statusCode, 200);
    assert.ok(response.body.includes("exec"), response.body);
    // Прямой адрес не трогали: каждая заведомо неудачная попытка — это лишняя задержка на каждый файл.
    assert.equal(site.hits.length, 0);
  } finally {
    await app.close();
    await site.close();
  }
});

test("the method, the body and the query reach the container through docker exec", async () => {
  const seen: Array<{ method: string; path: string; body?: Buffer; cookie?: string }> = [];
  const app = await appWith(depsFor(1, {
    execPreview: async input => {
      seen.push({ method: input.method, path: input.path, body: input.body, cookie: input.headers.cookie });
      return { status: 201, statusText: "Created", headers: { "content-type": "application/json" }, body: Buffer.from('{"ok":true}'), truncated: false };
    },
  }));
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects/p1/preview/open/api/data?x=1",
      payload: { a: 1 },
      headers: { "content-type": "application/json", cookie: "session=1" },
    });
    assert.equal(response.statusCode, 201);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, "POST");
    assert.equal(seen[0].path, "/api/data?x=1");
    assert.equal(seen[0].body?.toString("utf8"), '{"a":1}');
    assert.equal(seen[0].cookie, "session=1");
  } finally {
    await app.close();
  }
});

test("when neither the address nor the container answers, the failure is named as such", async () => {
  const app = await appWith(depsFor(1));
  try {
    const response = await app.inject({ method: "GET", url: "/api/projects/p1/preview/open/" });
    assert.equal(response.statusCode, 400);
    assert.match(response.body, /Прокси предпросмотра не сработал/);
    assert.match(response.body, /внутри контейнера приложение тоже не ответило/, response.body);
  } finally {
    await app.close();
  }
});

/**
 * Публичный адрес предпросмотра открывается в новой вкладке без cookie сессии панели, поэтому
 * панель берёт билет на конкретный проект: без него адрес отвечает 401, а не отдаёт приложение
 * первому, кто угадал имя.
 */
test("the ticket endpoint hands the panel a link to the project's public preview address", async () => {
  const app = await appWith(depsFor(1, {
    publicUrl: projectId => "https://" + projectId + ".preview.example",
    mintTicket: projectId => "ticket-" + projectId,
    ticketTtlMs: () => 3_600_000,
  }));
  try {
    const response = await app.inject({ method: "POST", url: "/api/projects/p1/preview/ticket" });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.baseUrl, "https://p1.preview.example");
    assert.equal(body.url, "https://p1.preview.example/?ticket=ticket-p1");
    assert.equal(body.param, "ticket");
    assert.ok(body.expiresAt > Date.now(), "билет должен быть со сроком в будущем");
  } finally {
    await app.close();
  }
});

test("without a public preview domain the ticket endpoint names the missing variable", async () => {
  const app = await appWith(depsFor(1));
  try {
    const response = await app.inject({ method: "POST", url: "/api/projects/p1/preview/ticket" });
    assert.equal(response.statusCode, 400);
    assert.match(response.body, /PREVIEW_PUBLIC_DOMAIN/);
  } finally {
    await app.close();
  }
});

test("the status tells the panel which public address this project has", async () => {
  const app = await appWith(depsFor(1, { publicUrl: projectId => "https://" + projectId + ".preview.example" }));
  try {
    const response = await app.inject({ method: "GET", url: "/api/projects/p1/preview/status" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().publicUrl, "https://p1.preview.example");
  } finally {
    await app.close();
  }
});

/**
 * Ответ реверс-прокси на вопрос «можно ли выдать сертификат на это имя». Проверка имени важнее
 * самой выдачи: подстановочная DNS-запись домена предпросмотра указывает на эту ВМ, поэтому без
 * неё сертификаты выдавались бы на любой придуманный поддомен и исчерпали бы лимит Let's Encrypt.
 */
test("the certificate question is answered yes only for an existing project's host", async () => {
  const app = await appWith(depsFor(1, {
    hostTarget: host => (host === "p1.preview.example" ? "p1" : null),
    projectExists: async projectId => projectId === "p1",
  }));
  try {
    const allowed = await app.inject({ method: "GET", url: "/api/preview/tls-ask?domain=p1.preview.example" });
    assert.equal(allowed.statusCode, 200);
    assert.deepEqual(allowed.json(), { allowed: true, host: "p1.preview.example" });

    const unknown = await app.inject({ method: "GET", url: "/api/preview/tls-ask?domain=whatever.preview.example" });
    assert.equal(unknown.statusCode, 404);

    const missing = await app.inject({ method: "GET", url: "/api/preview/tls-ask" });
    assert.equal(missing.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("a certificate is not issued for a host whose project no longer exists", async () => {
  const app = await appWith(depsFor(1, {
    hostTarget: host => (host === "gone.preview.example" ? "gone" : null),
    projectExists: async () => false,
  }));
  try {
    const response = await app.inject({ method: "GET", url: "/api/preview/tls-ask?domain=gone.preview.example" });
    assert.equal(response.statusCode, 404);
    assert.match(response.body, /Проект не найден/);
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
