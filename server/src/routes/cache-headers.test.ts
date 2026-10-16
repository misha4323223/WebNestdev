import test from "node:test";
import assert from "node:assert/strict";
import { applyNoStore, applyNoStoreToReply, CACHE_VALIDATORS, isFreshOnlyResponse, NO_STORE_HEADERS } from "./cache-headers.js";

test("a response that must be fresh loses its cache validators, not only its cache-control", () => {
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "public, max-age=86400",
    etag: 'W/"abc"',
    "last-modified": "Wed, 01 Oct 2025 10:00:00 GMT",
    "x-frame-options": "DENY",
  });
  applyNoStore(headers);
  // `no-store` в одиночку не мешает посреднику ответить 304 по etag: старая версия остаётся.
  assert.equal(headers.get("cache-control"), "no-store, no-cache, must-revalidate, max-age=0");
  assert.equal(headers.get("pragma"), "no-cache");
  assert.equal(headers.get("expires"), "0");
  assert.equal(headers.get("etag"), null);
  assert.equal(headers.get("last-modified"), null);
  // Остальные заголовки приложения не трогаются: их ставит и снимает вызывающий.
  assert.equal(headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(headers.get("x-frame-options"), "DENY");
});

test("the reply variant sets and removes the same headers", () => {
  const set: Record<string, string> = { etag: "kept", "last-modified": "kept", "x-other": "kept" };
  const removed: string[] = [];
  applyNoStoreToReply({
    header: (name, value) => { set[name] = value },
    removeHeader: name => { removed.push(name); delete set[name] },
  });
  assert.equal(set["cache-control"], NO_STORE_HEADERS["cache-control"]);
  assert.equal(set.etag, undefined);
  assert.equal(set["last-modified"], undefined);
  assert.deepEqual(removed, [...CACHE_VALIDATORS]);
  assert.equal(set["x-other"], "kept", "посторонние заголовки не трогаются");
});

test("only documents are treated as fresh-only by the shared rule", () => {
  assert.equal(isFreshOnlyResponse("text/html; charset=utf-8"), true);
  assert.equal(isFreshOnlyResponse("TEXT/HTML"), true);
  assert.equal(isFreshOnlyResponse("application/json"), false);
  assert.equal(isFreshOnlyResponse("image/png"), false);
  assert.equal(isFreshOnlyResponse(undefined), false);
});
