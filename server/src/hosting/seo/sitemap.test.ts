import test from "node:test";
import assert from "node:assert/strict";
import { renderRobotsTxt, renderSitemapBundle, renderSitemapXml } from "./sitemap.js";
import { buildRouteManifest } from "./route-manifest.js";

test("sitemap берёт только страницы релиза, primary domain и дату релиза", () => {
  const manifest = buildRouteManifest([
    { path: "index.html" },
    { path: "about/index.html" },
    { path: "404.html" },
  ]);
  const xml = renderSitemapXml({
    origin: "https://example.ru",
    manifest,
    lastmod: "2026-11-19T10:38:20Z",
  });
  assert.match(xml, /<loc>https:\/\/example\.ru\/<\/loc>/);
  assert.match(xml, /<loc>https:\/\/example\.ru\/about\/<\/loc>/);
  assert.doesNotMatch(xml, /404\.html/);
  assert.match(xml, /<lastmod>2026-11-19<\/lastmod>/);
});

test("sitemap экранирует origin и не добавляет выдуманные URL", () => {
  const xml = renderSitemapXml({
    origin: "https://example.ru",
    manifest: buildRouteManifest([{ path: "index.html" }, { path: "about/index.html" }]),
  });
  assert.match(xml, /<loc>https:\/\/example\.ru\/<\/loc>/);
  assert.match(xml, /<loc>https:\/\/example\.ru\/about\/<\/loc>/);
  assert.equal((xml.match(/<url>/g) ?? []).length, 2);
});

test("sitemap не выдумывает главную, если index.html в релизе нет", () => {
  const xml = renderSitemapXml({
    origin: "https://example.ru",
    manifest: buildRouteManifest([{ path: "about.html" }]),
  });
  assert.match(xml, /<loc>https:\/\/example\.ru\/about\.html<\/loc>/);
  assert.doesNotMatch(xml, /<loc>https:\/\/example\.ru\/<\/loc>/);
});

test("sitemap index делит большие сайты на куски и ссылается на них", () => {
  const manifest = buildRouteManifest([
    { path: "index.html" },
    { path: "a/index.html" },
    { path: "b/index.html" },
    { path: "c/index.html" },
    { path: "d/index.html" },
  ]);
  const bundle = renderSitemapBundle({
    origin: "https://example.ru",
    manifest,
    lastmod: "2026-11-19T10:38:20Z",
    maxUrls: 2,
  });
  assert.equal(bundle.urls, 5);
  assert.equal(bundle.chunks.length, 3);
  assert.deepEqual(bundle.chunks.map(chunk => chunk.name), ["sitemap-1.xml", "sitemap-2.xml", "sitemap-3.xml"]);
  assert.match(bundle.index, /<sitemapindex/);
  assert.match(bundle.index, /<loc>https:\/\/example\.ru\/sitemap-1\.xml<\/loc>/);
  assert.doesNotMatch(bundle.chunks[0]!.content, /<sitemapindex/);
  assert.equal((bundle.chunks[0]!.content.match(/<url>/g) ?? []).length, 2);
});

test("sitemap применяет выбранную политику хвостового слеша", () => {
  const manifest = buildRouteManifest([{ path: "index.html" }, { path: "about/index.html" }, { path: "file.html" }]);
  const always = renderSitemapXml({ origin: "https://example.ru", manifest, trailingSlash: "always" });
  assert.match(always, /<loc>https:\/\/example\.ru\/about\/<\/loc>/);
  assert.match(always, /<loc>https:\/\/example\.ru\/file\.html<\/loc>/);
  const never = renderSitemapXml({ origin: "https://example.ru", manifest, trailingSlash: "never" });
  assert.match(never, /<loc>https:\/\/example\.ru\/about<\/loc>/);
  assert.doesNotMatch(never, /<loc>https:\/\/example\.ru\/about\/<\/loc>/);
});

test("robots закрывает preview и указывает sitemap на primary domain", () => {
  assert.match(renderRobotsTxt({ origin: "https://example.ru" }), /Sitemap: https:\/\/example\.ru\/sitemap\.xml/);
  assert.match(renderRobotsTxt({ origin: "https://preview.example.ru", allowIndexing: false }), /Disallow: \//);
  assert.doesNotMatch(renderRobotsTxt({ origin: "https://preview.example.ru", allowIndexing: false }), /Sitemap:/);
});
