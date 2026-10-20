import test from "node:test";
import assert from "node:assert/strict";
import { isDuckDuckGoChallenge, parseDuckDuckGoHtml } from "./duckduckgo.js";

/** Форма страницы `lite.duckduckgo.com`: ссылка в одной строке таблицы, сниппет в следующей. */
const LITE_HTML = `
<table>
  <tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2F&amp;rut=abc" class='result-link'>Node.js <b>API</b> docs</a></td></tr>
  <tr><td class='result-snippet'>Официальная документация Node.js.</td></tr>
  <tr><td><a rel="nofollow" href="https://example.com/direct" class='result-link'>Example</a></td></tr>
  <tr><td class='result-snippet'>Second &amp; last result</td></tr>
  <tr><td><a rel="nofollow" href="https://duckduckgo.com/y.js?ad_domain=ads.example" class='result-link'>Реклама</a></td></tr>
  <tr><td class='result-snippet'>Куплено</td></tr>
</table>`;

/** Форма страницы `html.duckduckgo.com`: классы `result__a` и `result__snippet`. */
const HTML_ENDPOINT = `
<div class="result results_links">
  <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ffastify.dev%2F">Fastify</a></h2>
  <a class="result__snippet">Fast and low overhead web framework</a>
</div>`;

test("the lite markup gives a redirect target, a decoded snippet and drops ads", () => {
  const results = parseDuckDuckGoHtml(LITE_HTML);
  assert.equal(results.length, 2, "рекламная ссылка duckduckgo.com/y.js не является результатом");
  assert.equal(results[0]?.url, "https://nodejs.org/api/");
  assert.equal(results[0]?.title, "Node.js API docs");
  assert.equal(results[0]?.snippet, "Официальная документация Node.js.");
  assert.equal(results[1]?.url, "https://example.com/direct");
  assert.equal(results[1]?.snippet, "Second & last result");
});

test("the html endpoint markup parses with the older class names", () => {
  const results = parseDuckDuckGoHtml(HTML_ENDPOINT);
  assert.deepEqual(results.map(result => result.url), ["https://fastify.dev/"]);
  assert.equal(results[0]?.snippet, "Fast and low overhead web framework");
});

test("unknown markup yields no results instead of throwing", () => {
  assert.deepEqual(parseDuckDuckGoHtml("<html><body>ничего</body></html>"), []);
  assert.deepEqual(parseDuckDuckGoHtml(""), []);
});

test("a robot check is recognised as a refusal, not as an empty result list", () => {
  assert.equal(isDuckDuckGoChallenge('<div class="anomaly-modal">Are you a robot?</div>'), true);
  assert.equal(isDuckDuckGoChallenge('<form id="challenge-form">'), true);
  // 202 без разметки — та же проверка: страница пришла, выдачи в ней нет.
  assert.equal(isDuckDuckGoChallenge("", 202), true);
  assert.equal(isDuckDuckGoChallenge(LITE_HTML, 200), false);
});
