import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import type { FastifyRequest } from "fastify";
import { isSameOriginRequest, registerSameOriginGuard } from "./same-origin.js";

function request(headers: Record<string, string>, protocol = "http"): FastifyRequest {
  return {
    headers,
    protocol,
  } as unknown as FastifyRequest;
}

test("запрос без Origin (curl, сервер) проходит", () => {
  assert.equal(isSameOriginRequest(request({ host: "app.test" })), true);
});

test("свой Origin проходит, чужой — нет", () => {
  assert.equal(isSameOriginRequest(request({ host: "app.test", origin: "http://app.test" })), true);
  assert.equal(isSameOriginRequest(request({ host: "app.test", origin: "https://evil.test" })), false);
  assert.equal(isSameOriginRequest(request({ host: "app.test", origin: "null" })), false);
});

test("за TLS-прокси источник сравнивается с X-Forwarded-*", () => {
  assert.equal(
    isSameOriginRequest(request({
      host: "internal:8787",
      "x-forwarded-host": "app.example.com",
      "x-forwarded-proto": "https",
      origin: "https://app.example.com",
    })),
    true,
  );
  assert.equal(
    isSameOriginRequest(request({
      host: "internal:8787",
      "x-forwarded-host": "app.example.com",
      "x-forwarded-proto": "https",
      origin: "http://app.example.com",
    })),
    false,
  );
});

test("Sec-Fetch-Site: cross-site отклоняется даже при совпадающем Origin", () => {
  assert.equal(
    isSameOriginRequest(request({
      host: "app.test",
      origin: "http://app.test",
      "sec-fetch-site": "cross-site",
    })),
    false,
  );
});

/**
 * Vite-прокси в разработке меняет Host на localhost:8787, хотя страница и API для браузера
 * остаются на одном публичном origin. Без этой проверки любой POST из hosted-предпросмотра
 * получал 403 «чужой источник».
 */
test("same-origin за прокси с подменённым Host проходит, same-site — нет", () => {
  assert.equal(
    isSameOriginRequest(request({
      host: "localhost:8787",
      origin: "https://5173-example.e2b.app",
      "sec-fetch-site": "same-origin",
    })),
    true,
  );
  assert.equal(
    isSameOriginRequest(request({
      host: "localhost:8787",
      origin: "https://preview.example.com",
      "sec-fetch-site": "same-site",
    })),
    false,
  );
});

test("настроенный список источников побеждает Host", () => {
  const previous = process.env.WEBNESTDEV_ALLOWED_ORIGINS;
  process.env.WEBNESTDEV_ALLOWED_ORIGINS = "https://panel.example.com";
  try {
    assert.equal(
      isSameOriginRequest(request({ host: "internal:8787", origin: "https://panel.example.com" })),
      true,
    );
    assert.equal(
      isSameOriginRequest(request({ host: "panel.example.com", origin: "http://panel.example.com" })),
      false,
    );
  } finally {
    if (previous === undefined) delete process.env.WEBNESTDEV_ALLOWED_ORIGINS;
    else process.env.WEBNESTDEV_ALLOWED_ORIGINS = previous;
  }
});

/**
 * Один хук закрывает все изменяющие ручки, а не три файла маршрутов. Проверяются обе стороны:
 * чужой источник получает 403, а серверный вызов без Origin и вебхук оплаты продолжают работать.
 */
test("глобальный хук отклоняет чужой Origin на изменяющем запросе", async () => {
  const previousEnv = process.env.NODE_ENV;
  const previousOrigins = process.env.WEBNESTDEV_ALLOWED_ORIGINS;
  process.env.NODE_ENV = "production";
  process.env.WEBNESTDEV_ALLOWED_ORIGINS = "https://panel.example.com";
  const app = Fastify();
  try {
    await registerSameOriginGuard(app);
    app.post("/api/projects/:id/preview/start", async () => ({ ok: true }));
    app.post("/api/billing/robokassa/result", async () => "OK");
    app.get("/api/projects", async () => ({ projects: [] }));
    await app.ready();

    const evil = await app.inject({ method: "POST", url: "/api/projects/p1/preview/start", headers: { origin: "https://evil.example" } });
    assert.equal(evil.statusCode, 403, evil.body);

    const own = await app.inject({ method: "POST", url: "/api/projects/p1/preview/start", headers: { origin: "https://panel.example.com" } });
    assert.equal(own.statusCode, 200, own.body);

    // Серверный вызов без Origin (инструменты, curl, внутренние задачи) не блокируется.
    const server = await app.inject({ method: "POST", url: "/api/projects/p1/preview/start" });
    assert.equal(server.statusCode, 200, server.body);

    // Вебхук оплаты подписан и приходит от сервиса: его Origin не проверяется.
    const webhook = await app.inject({ method: "POST", url: "/api/billing/robokassa/result", headers: { origin: "https://robokassa.example" } });
    assert.equal(webhook.statusCode, 200, webhook.body);

    // GET ничего не меняет.
    const read = await app.inject({ method: "GET", url: "/api/projects", headers: { origin: "https://evil.example" } });
    assert.equal(read.statusCode, 200, read.body);
  } finally {
    await app.close();
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
    if (previousOrigins === undefined) delete process.env.WEBNESTDEV_ALLOWED_ORIGINS;
    else process.env.WEBNESTDEV_ALLOWED_ORIGINS = previousOrigins;
  }
});
