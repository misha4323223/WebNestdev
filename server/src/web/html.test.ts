import test from "node:test";
import assert from "node:assert/strict";
import { decodeEntities, extractTitle, mainContent, readableText, resolveDuckDuckGoHref, textOf } from "./html.js";

test("entities are decoded in all three shapes that appear in real pages", () => {
  assert.equal(decodeEntities("Tom &amp; Jerry"), "Tom & Jerry");
  assert.equal(decodeEntities("&#39;quoted&#39;"), "'quoted'");
  assert.equal(decodeEntities("&#x2F;path"), "/path");
  assert.equal(decodeEntities("&laquo;Ёлка&raquo;"), "«Ёлка»");
  assert.equal(decodeEntities("&unknown;"), "&unknown;", "неизвестная сущность остаётся как была");
});

test("readable text keeps the article and drops navigation chrome and scripts", () => {
  const page = `<html><head><title>Статья</title><style>.a{}</style></head><body>
    <header><a href="/">Логотип</a></header>
    <nav><a href="/docs">Документация</a></nav>
    <main><h1>Заголовок</h1><p>Первый абзац &amp; продолжение.</p><script>alert(1)</script></main>
    <aside>Реклама</aside>
    <footer>© 2026</footer>
  </body></html>`;
  const text = readableText(page);
  assert.match(text, /Первый абзац & продолжение\./);
  assert.ok(!text.includes("Логотип"), "шапка не является содержанием страницы");
  assert.ok(!text.includes("Документация"), "меню не является содержанием страницы");
  assert.ok(!text.includes("Реклама"));
  assert.ok(!text.includes("alert(1)"));
  assert.equal(extractTitle(page), "Статья");
});

test("main content is preferred when the page marks it, and the whole page is the fallback", () => {
  const long = "Слово ".repeat(120);
  const marked = `<body><nav>меню</nav><main><p>${long}</p></main><footer>подвал</footer></body>`;
  assert.match(mainContent(marked), /^<main>/);
  assert.ok(!mainContent(marked).includes("подвал"));

  const shortMain = "<body><main>мало</main><p>весь текст страницы</p></body>";
  assert.equal(mainContent(shortMain), shortMain, "короткий <main> не заменяет страницу целиком");

  const plain = "<body><p>без разметки</p></body>";
  assert.equal(mainContent(plain), plain);
});

test("duckduckgo links become real urls, and ads are dropped", () => {
  assert.equal(
    resolveDuckDuckGoHref("//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2F&rut=abc"),
    "https://nodejs.org/api/",
  );
  assert.equal(resolveDuckDuckGoHref("https://example.com/page"), "https://example.com/page");
  assert.equal(resolveDuckDuckGoHref("https://duckduckgo.com/y.js?ad_domain=shop.example"), "");
  assert.equal(resolveDuckDuckGoHref("javascript:alert(1)"), "");
  assert.equal(resolveDuckDuckGoHref(""), "");
});

test("a snippet is flattened to one line", () => {
  assert.equal(textOf("<b>Hooks</b> are\n   registered"), "Hooks are registered");
});
