import test from "node:test";
import assert from "node:assert/strict";
import { buildTavilyBody, parseTavilyResponse } from "./tavily.js";

const RESPONSE = {
  query: "fastify hooks",
  response_time: 0.42,
  results: [
    { title: "Hooks | Fastify", url: "https://fastify.dev/docs/latest/Reference/Hooks/", content: "Hooks are registered with the addHook method.", score: 0.98, raw_content: null },
    { title: "", url: "https://example.com/no-title", content: "  Snippet with spaces  " },
    { title: "Без адреса", url: "not-a-url", content: "мусор" },
    { title: "Другой протокол", url: "ftp://example.com/file", content: "не веб-страница" },
  ],
};

test("the request asks for one-credit basic search with the requested number of results", () => {
  const body = buildTavilyBody("fastify hooks", 5);
  assert.equal(body.query, "fastify hooks");
  assert.equal(body.search_depth, "basic", "advanced стоит два кредита, агенту хватает basic");
  assert.equal(body.max_results, 5);
  assert.equal(body.include_answer, false);
  assert.equal(body.include_raw_content, false);
});

test("the limit is clamped to the provider range", () => {
  assert.equal(buildTavilyBody("q", 0).max_results, 8, "ноль и мусор заменяются значением по умолчанию");
  assert.equal(buildTavilyBody("q", 50).max_results, 20);
});

test("results become title, url and snippet, and non-http entries are dropped", () => {
  const results = parseTavilyResponse(RESPONSE);
  assert.equal(results.length, 2);
  assert.equal(results[0]?.url, "https://fastify.dev/docs/latest/Reference/Hooks/");
  assert.equal(results[0]?.title, "Hooks | Fastify");
  assert.equal(results[0]?.snippet, "Hooks are registered with the addHook method.");
  assert.equal(results[1]?.title, "https://example.com/no-title", "пустой заголовок заменяется адресом");
  assert.equal(results[1]?.snippet, "Snippet with spaces");
});

test("an unexpected response shape yields no results instead of throwing", () => {
  assert.deepEqual(parseTavilyResponse({}), []);
  assert.deepEqual(parseTavilyResponse({ results: "нет" }), []);
  assert.deepEqual(parseTavilyResponse(null), []);
});
