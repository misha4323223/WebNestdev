import test from "node:test";
import assert from "node:assert/strict";
import { checkSeo } from "./check.js";

/**
 * Проверка тестируется без Preview и без песочницы: `fetchPage` и `readFile` подставные.
 * Тесты фиксируют именно то, за что агент получает инструмент: критические пункты находятся,
 * а чистая страница не даёт ни одного критического.
 */

function doc(head: string, body = "<h1>Заголовок</h1>") {
  return "<!doctype html><html lang=\"ru\"><head>" + head + "</head><body>" + body + "</body></html>";
}

const GOOD_HEAD =
  "<title>Сайт о ремонте квартир</title>" +
  "<meta name=\"description\" content=\"Короткое описание страницы для поисковой выдачи.\">" +
  "<link rel=\"canonical\" href=\"https://site.ru/\">";

function files(map: Record<string, string>) {
  return async (relativePath: string) => map[relativePath] ?? null;
}

test("seo.check находит критическое: нет title и H1, страница закрыта noindex", async () => {
  const report = await checkSeo({
    siteUrl: "https://site.ru",
    fetchPage: async () => ({
      status: 200,
      html: doc(
        "<meta name=\"robots\" content=\"noindex, follow\"><link rel=\"canonical\" href=\"https://site.ru/\">",
        "<p>Без заголовка</p>",
      ),
    }),
    readFile: files({
      "public/404.html": "<h1>404</h1>",
      "robots.txt": "User-agent: *\nAllow: /",
      "sitemap.xml": "<urlset><url><loc>https://site.ru/</loc></url></urlset>",
    }),
  });

  const ids = report.issues.map(item => item.id);
  assert.equal(report.ok, false);
  assert.ok(ids.includes("title-missing"), "нет title — критично");
  assert.ok(ids.includes("h1-missing"), "нет H1 — критично");
  assert.ok(ids.includes("noindex"), "публичная страница с noindex — критично");
  for (const item of report.issues) assert.ok(item.fix.length > 0, "у каждого пункта есть исправление");
  assert.equal(report.counts.critical, 3);
});

test("seo.check проверяет canonical относительно siteUrl и битые внутренние ссылки", async () => {
  const report = await checkSeo({
    siteUrl: "https://site.ru",
    fetchPage: async route => {
      if (route === "/missing") return { status: 404, html: "<h1>404</h1>" };
      return { status: 200, html: doc(GOOD_HEAD.replace("https://site.ru/", "https://other.ru/"), "<h1>Квартиры</h1><a href=\"/missing\">Страница</a>") };
    },
    readFile: files({
      "public/404.html": "<h1>404</h1>",
      "robots.txt": "User-agent: *\nAllow: /",
      "sitemap.xml": "<urlset><url><loc>https://site.ru/</loc></url></urlset>",
    }),
  });

  const ids = report.issues.map(item => item.id);
  assert.ok(ids.includes("canonical-origin"), "canonical на чужой домен — предупреждение");
  assert.ok(ids.includes("broken-link"), "ссылка на 404 — критично");
  assert.equal(report.ok, false);
});

test("seo.check читает файлы проекта: robots, sitemap и _redirects", async () => {
  const report = await checkSeo({
    siteUrl: "https://site.ru",
    readFile: files({
      "robots.txt": "User-agent: *\nDisallow: /\n",
      "_redirects": "/old /new 301\n/cat /category 200\n",
    }),
  });

  const ids = report.issues.map(item => item.id);
  assert.ok(ids.includes("robots-blocks-all"), "Disallow: / закрывает сайт — критично");
  assert.ok(ids.includes("redirects-invalid"), "код 200 в _redirects — ошибка строки");
  assert.ok(ids.includes("404-missing"), "нет 404.html — предупреждение");
  assert.ok(ids.includes("sitemap-generated"), "sitemap строит платформа — это не ошибка");
  assert.ok(ids.includes("preview-off"), "без Preview инструмент говорит, что HTML не проверялся");
  assert.equal(report.pages.length, 0);
  assert.equal(report.ok, false);
});

test("seo.check не выдумывает провал: чистая страница проходит", async () => {
  const report = await checkSeo({
    siteUrl: "https://site.ru",
    fetchPage: async () => ({
      status: 200,
      html: doc(
        GOOD_HEAD +
        "<meta property=\"og:title\" content=\"Ремонт квартир\">" +
        "<meta property=\"og:description\" content=\"Описание для соцсетей.\">",
        "<h1>Ремонт квартир</h1><img src=\"/a.png\" alt=\"Комната\">",
      ),
    }),
    readFile: files({
      "public/404.html": "<h1>404</h1>",
      "robots.txt": "User-agent: *\nAllow: /",
      "sitemap.xml": "<urlset><url><loc>https://site.ru/</loc></url></urlset>",
    }),
  });

  assert.deepEqual(report.counts, { critical: 0, warning: 0, info: 0 }, "замечаний нет: " + JSON.stringify(report.issues));
  assert.equal(report.ok, true);

});

test("seo.check предупреждает об одинаковом title на разных страницах", async () => {
  const head = "<title>Одна и та же страница</title><meta name=\"description\" content=\"Описание страницы для выдачи.\"><link rel=\"canonical\" href=\"https://site.ru/\" />";
  const report = await checkSeo({
    routes: ["/", "/about"],
    siteUrl: "https://site.ru",
    fetchPage: async route => ({
      status: 200,
      html: doc(head.replace("https://site.ru/", "https://site.ru" + route), "<h1>Заголовок</h1>"),
    }),
    readFile: files({
      "public/404.html": "<h1>404</h1>",
      "robots.txt": "User-agent: *\nAllow: /",
      "sitemap.xml": "<urlset><url><loc>https://site.ru/</loc></url></urlset>",
    }),
  });

  assert.ok(report.issues.some(item => item.id === "title-duplicate"));
  assert.equal(report.counts.critical, 0);
});
