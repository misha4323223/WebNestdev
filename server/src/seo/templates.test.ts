import test from "node:test";
import assert from "node:assert/strict";
import { buildSeoTemplate } from "./templates.js";

test("seo-шаблон отдаёт canonical, Open Graph и JSON-LD на выбранный URL", () => {
  const result = buildSeoTemplate({
    kind: "landing",
    siteUrl: "https://example.ru/",
    pagePath: "/about",
    title: "О продукте",
    description: "Как работает продукт",
  });
  assert.equal(result.canonicalUrl, "https://example.ru/about");
  assert.match(result.head, /<title>О продукте<\/title>/);
  assert.match(result.head, /rel="canonical" href="https:\/\/example\.ru\/about"/);
  assert.match(result.head, /property="og:title" content="О продукте"/);
  assert.match(result.head, /application\/ld\+json/);
  assert.doesNotMatch(result.head, /noindex/);
});

test("app-шаблон закрывает приватный маршрут, а static-шаблон не создаёт sitemap/robots", () => {
  const app = buildSeoTemplate({ kind: "app", siteUrl: "https://app.example.ru", pagePath: "/app/settings" });
  assert.equal(app.routing.mode, "spa");
  assert.match(app.head, /noindex, nofollow/);
  assert.equal(app.files["public/sitemap.xml"], undefined);
  assert.equal(app.files["public/robots.txt"], undefined);
  assert.equal(app.robots.managedByHosting, true);

  const landing = buildSeoTemplate({ kind: "landing", siteUrl: "https://example.ru" });
  assert.equal(landing.routing.mode, "static");
  assert.match(landing.files["public/404.html"]!, /noindex, nofollow/);
  assert.match(landing.files["public/_redirects"]!, /\/blog\/\* \/articles\/:splat 301/);
});

test("некорректный origin заменяется безопасным placeholder, а не ломает шаблон", () => {
  const result = buildSeoTemplate({ siteUrl: "javascript:alert(1)" });
  assert.equal(result.siteUrl, "https://example.com");
  assert.match(result.head, /https:\/\/example\.com\//);
});
