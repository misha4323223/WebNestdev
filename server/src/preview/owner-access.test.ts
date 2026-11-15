import test from "node:test";
import assert from "node:assert/strict";
import { previewAccessFor, previewCheckPath } from "./owner-access.js";
import type { PreviewStatus } from "./types.js";

const localStatus: PreviewStatus = {
  running: true,
  ready: true,
  mode: "hybrid",
  host: "127.0.0.1",
  port: 5173,
  containerId: "",
  startedAt: Date.now(),
};

const remoteStatus: PreviewStatus = {
  ...localStatus,
  ownerAddress: "203.0.113.10:8788",
};

function fakeFetch() {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    return new Response("ok", { status: 200 });
  };
  return { calls, fetchImpl };
}

test("локальный владелец проверяется напрямую, без cookie", async () => {
  const { calls, fetchImpl } = fakeFetch();
  const access = previewAccessFor("p-local", localStatus, {
    fetch: fetchImpl,
    publicUrl: () => "https://should-not-be-used.example",
    isLocalOwner: () => true,
    mintTicket: () => "unused",
    ownerAware: true,
  });

  assert.equal(access.source, "local");
  assert.equal(access.baseUrl, "http://127.0.0.1:5173");
  assert.equal(access.cookie, undefined);
  assert.equal(access.urlFor("src/main.tsx?v=2"), "http://127.0.0.1:5173/src/main.tsx?v=2");

  const response = await access.fetch("/api/health");
  assert.equal(response.status, 200);
  assert.equal(calls[0]?.url, "http://127.0.0.1:5173/api/health");
  assert.equal(calls[0]?.headers.has("cookie"), false);
});

test("чужой владелец проверяется через публичную дверь с билетом проекта", async () => {
  const { calls, fetchImpl } = fakeFetch();
  const access = previewAccessFor("p-remote", remoteStatus, {
    fetch: fetchImpl,
    publicUrl: () => "https://p-remote.preview.example/",
    isLocalOwner: () => false,
    mintTicket: () => "ticket-123",
    ownerAware: true,
  });

  assert.equal(access.source, "owner");
  assert.equal(access.baseUrl, "https://p-remote.preview.example");
  assert.deepEqual(access.cookie, { name: "webnestdev_preview", value: "ticket-123" });
  assert.equal(access.urlFor("/"), "https://p-remote.preview.example/");
  assert.equal(access.urlFor("style.css"), "https://p-remote.preview.example/style.css");

  await access.fetch("/api/health", { headers: { accept: "application/json" } });
  assert.equal(calls[0]?.url, "https://p-remote.preview.example/api/health");
  assert.equal(calls[0]?.headers.get("accept"), "application/json");
  assert.equal(calls[0]?.headers.get("cookie"), "webnestdev_preview=ticket-123");
});

test("для чужого владельца без публичного домена ошибка называется явно", () => {
  assert.throws(
    () => previewAccessFor("p-no-domain", remoteStatus, {
      publicUrl: () => "",
      isLocalOwner: () => false,
      mintTicket: () => "unused",
      ownerAware: true,
    }),
    /PREVIEW_PUBLIC_DOMAIN/,
  );
});

test("аварийный выключатель возвращает прямой путь", () => {
  const access = previewAccessFor("p-fallback", remoteStatus, {
    isLocalOwner: () => false,
    ownerAware: false,
  });
  assert.equal(access.source, "local");
  assert.equal(access.baseUrl, "http://127.0.0.1:5173");
});

test("абсолютный URL не превращает проверку в открытый прокси", () => {
  assert.throws(() => previewCheckPath("https://evil.example/"), /абсолютным URL/);
  assert.equal(previewCheckPath(""), "/");
  assert.equal(previewCheckPath("health"), "/health");
});
