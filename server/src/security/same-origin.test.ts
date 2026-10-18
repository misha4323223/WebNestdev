import test from "node:test";
import assert from "node:assert/strict";
import type { FastifyRequest } from "fastify";
import { isSameOriginRequest } from "./same-origin.js";

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
