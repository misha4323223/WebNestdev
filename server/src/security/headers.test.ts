import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import type { FastifyRequest } from "fastify";
import { CONTENT_SECURITY_POLICY, requestIsHttps, registerSecurityHeaders, securityHeaders } from "./headers.js";

function request(headers: Record<string, string>, protocol = "http"): FastifyRequest {
  return { headers, protocol } as unknown as FastifyRequest;
}

test("production: CSP и HSTS только на https", () => {
  const https = securityHeaders(request({ "x-forwarded-proto": "https" }, "http"), "production");
  assert.equal(https["Content-Security-Policy"], CONTENT_SECURITY_POLICY);
  assert.equal(https["Strict-Transport-Security"], "max-age=15552000");
  const http = securityHeaders(request({}), "production");
  assert.equal(http["Content-Security-Policy"], CONTENT_SECURITY_POLICY);
  assert.equal(http["Strict-Transport-Security"], undefined);
});

test("development не включает CSP, чтобы не ломать HMR Vite", () => {
  const headers = securityHeaders(request({}), "development");
  assert.equal(headers["Content-Security-Policy"], undefined);
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
});

test("X-Forwarded-Proto с несколькими значениями читается первым", () => {
  assert.equal(requestIsHttps(request({ "x-forwarded-proto": "https, http" })), true);
  assert.equal(requestIsHttps(request({ "x-forwarded-proto": "http" })), false);
});

test("API-ответы получают no-store, если маршрут не задал кэш сам", async () => {
  const app = Fastify();
  try {
    await registerSecurityHeaders(app);
    app.get("/api/data", async () => ({ secret: "not cached" }));
    app.get("/api/cached", async (_request, reply) => {
      reply.header("cache-control", "public, max-age=60");
      return { ok: true };
    });
    await app.ready();

    const fresh = await app.inject({ method: "GET", url: "/api/data" });
    assert.equal(fresh.statusCode, 200, fresh.body);
    assert.match(String(fresh.headers["cache-control"]), /no-store/);
    assert.equal(fresh.headers["x-content-type-options"], "nosniff");

    const cached = await app.inject({ method: "GET", url: "/api/cached" });
    assert.equal(cached.headers["cache-control"], "public, max-age=60");
  } finally {
    await app.close();
  }
});
