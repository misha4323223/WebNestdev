import assert from "node:assert/strict";
import test from "node:test";
import {
  functionCacheKey,
  FunctionResponseCache,
  requestAllowsResponseCache,
} from "./response-cache.js";

function cache() {
  return new FunctionResponseCache({ enabled: true, maxEntries: 10, maxBytes: 1024 });
}

const key = functionCacheKey({
  siteId: "site-1",
  releaseId: "release-1",
  functionName: "products",
  method: "GET",
  path: "/api/products",
  search: "?page=1",
});

test("ключ различает сайт, релиз, функцию, метод и query", () => {
  assert.notEqual(key, functionCacheKey({
    siteId: "site-1",
    releaseId: "release-1",
    functionName: "products",
    method: "GET",
    path: "/api/products",
    search: "?page=2",
  }));
  assert.notEqual(key, functionCacheKey({
    siteId: "site-1",
    releaseId: "release-2",
    functionName: "products",
    method: "GET",
    path: "/api/products",
    search: "?page=1",
  }));
  assert.notEqual(key, functionCacheKey({
    siteId: "site-1",
    releaseId: "release-1",
    functionName: "products",
    method: "GET",
    path: "/api/products",
    search: "?page=1",
    acceptLanguage: "en",
  }));
});

test("cookie и Authorization обходят кеш", () => {
  assert.equal(requestAllowsResponseCache({}), true);
  assert.equal(requestAllowsResponseCache({ cookie: "session=1" }), false);
  assert.equal(requestAllowsResponseCache({ authorization: "Bearer token" }), false);
});

test("хранит только успешный публичный ответ и уважает TTL", () => {
  const c = cache();
  const response = { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from('{"ok":true}') };
  assert.equal(c.store(key, response, 60, 1_000), true);
  assert.deepEqual(c.lookup(key, 1_001)?.body.toString(), '{"ok":true}');
  assert.equal(c.lookup(key, 61_000), null);

  assert.equal(c.store(key, { ...response, status: 500 }, 60, 1_000), false);
  assert.equal(c.store(key, { ...response, jobs: [{ name: "send", payload: {} }] }, 60, 1_000), false);
  assert.equal(c.store(key, { ...response, headers: { "set-cookie": "a=1" } }, 60, 1_000), false);
  assert.equal(c.store(key, { ...response, headers: { "cache-control": "private, no-store" } }, 60, 1_000), false);
  assert.equal(c.store(key, { ...response, headers: { vary: "*" } }, 60, 1_000), false);
});

test("single-flight выполняет загрузчик один раз", async () => {
  const c = cache();
  let calls = 0;
  const loader = async () => {
    calls += 1;
    await new Promise(resolve => setTimeout(resolve, 5));
    return { status: 200, headers: {}, body: Buffer.from("ok") };
  };
  const results = await Promise.all(Array.from({ length: 100 }, () => c.load(key, loader)));
  assert.equal(calls, 1);
  assert.equal(results.every(result => result.body.toString() === "ok"), true);
});

test("clearSite удаляет только ключи своего сайта", () => {
  const c = cache();
  const other = functionCacheKey({
    siteId: "site-2",
    releaseId: "release-1",
    functionName: "products",
    method: "GET",
    path: "/api/products",
    search: "",
  });
  c.store(key, { status: 200, headers: {}, body: Buffer.from("a") }, 60, 1_000);
  c.store(other, { status: 200, headers: {}, body: Buffer.from("b") }, 60, 1_000);
  c.clearSite("site-1");
  assert.equal(c.lookup(key, 1_001), null);
  assert.equal(c.lookup(other, 1_001)?.body.toString(), "b");
});
