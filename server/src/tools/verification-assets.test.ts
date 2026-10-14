import test from "node:test";
import assert from "node:assert/strict";
import { referencedAssets } from "./verification-tools.js";

test("относительные и абсолютные ссылки на файлы проверяются, внешние — нет", () => {
  const html = '<link rel="stylesheet" href="style.css"><script src="app.js" defer></script>'
    + '<link href="/assets/site.css" rel="stylesheet">'
    + '<img src="https://cdn.example.com/a.png"><img src="//cdn.example.com/b.png">'
    + '<script src="data:text/javascript,0"></script>'
    + '<a href="#top">вверх</a><a href="/about">о нас</a><a href="mailto:a@b.c">почта</a>';
  assert.deepEqual(referencedAssets(html, "/"), ["/style.css", "/app.js", "/assets/site.css"]);
});

test("ссылка без расширения — это переход, а не файл: SPA-фолбэк отдаёт её как страницу", () => {
  const html = '<a href="/catalog/product">товар</a><link rel="manifest" href="/site.webmanifest">';
  assert.deepEqual(referencedAssets(html, "/"), ["/site.webmanifest"]);
});

test("относительные ссылки разрешаются от каталога запрошенного маршрута", () => {
  const html = '<link rel="stylesheet" href="./style.css"><script src="js/app.js"></script>';
  assert.deepEqual(referencedAssets(html, "/catalog/"), ["/catalog/style.css", "/catalog/js/app.js"]);
  assert.deepEqual(referencedAssets(html, "/catalog/index.html"), ["/catalog/style.css", "/catalog/js/app.js"]);
});

test("запросы с параметрами и якорем проверяются без них, дубликаты не повторяются", () => {
  const html = '<script src="/app.js?v=2"></script><script src="/app.js#x"></script><img src="/logo.svg">';
  assert.deepEqual(referencedAssets(html, "/"), ["/app.js", "/logo.svg"]);
});

test("число проверок ограничено: длинная страница не превращается в сотню запросов", () => {
  const html = Array.from({ length: 30 }, (_, index) => '<img src="/img/' + index + '.png">').join("");
  assert.equal(referencedAssets(html, "/").length, 12);
});
