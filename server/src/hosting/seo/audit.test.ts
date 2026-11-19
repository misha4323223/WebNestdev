import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { auditSeoRelease } from "./audit.js";
import { buildRouteManifest } from "./route-manifest.js";

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "webnestdev-seo-audit-"));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
  }
  return root;
}

test("аудит находит технические проблемы, но не выдумывает оценку", async () => {
  process.env.SEO_AUDIT_LIVE = "0";
  const root = await fixture({
    "index.html": "<!doctype html><html lang=\"ru\"><head><title>Сайт</title><meta name=\"robots\" content=\"noindex\"></head><body><img src=\"/a.png\"></body></html>",
  });
  try {
    const manifest = buildRouteManifest([{ path: "index.html" }]);
    const result = await auditSeoRelease({
      releaseDir: root,
      seoDir: path.join(root, "seo"),
      manifest,
      origin: "https://site.example.ru",
      mode: "static",
    });
    assert.equal(result.version, 1);
    assert.ok(result.issues.some(item => item.id === "homepage-noindex" && item.level === "critical"));
    assert.ok(result.issues.some(item => item.id === "description-missing"));
    assert.ok(result.issues.some(item => item.id === "h1-missing"));
    assert.ok(result.issues.some(item => item.id === "404-missing"));
    assert.ok(!("score" in result));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sitemap index не считается ошибкой отсутствия главной, а битые _redirects видны в аудите", async () => {
  process.env.SEO_AUDIT_LIVE = "0";
  const root = await fixture({
    "index.html": "<!doctype html><html lang=\"ru\"><head><title>Главная</title><meta name=\"description\" content=\"Описание\"><link rel=\"canonical\" href=\"https://site.example.ru/\"></head><body><h1>Привет</h1></body></html>",
    "404.html": "<!doctype html><html lang=\"ru\"><title>Нет</title></html>",
    "robots.txt": "User-agent: *\nAllow: /\n",
    "sitemap.xml": "<?xml version=\"1.0\"?><sitemapindex><sitemap><loc>https://site.example.ru/sitemap-1.xml</loc></sitemap></sitemapindex>",
    "sitemap-1.xml": "<?xml version=\"1.0\"?><urlset><url><loc>https://site.example.ru/</loc></url></urlset>",
    "_redirects": "/old https://evil.example 301",
  });
  try {
    const result = await auditSeoRelease({
      releaseDir: root,
      seoDir: path.join(root, "seo"),
      manifest: buildRouteManifest([{ path: "index.html" }, { path: "404.html" }]),
      origin: "https://site.example.ru",
      mode: "static",
    });
    assert.equal(result.issues.some(item => item.id === "sitemap-origin"), false);
    assert.ok(result.issues.some(item => item.id === "redirects-invalid" && item.level === "warning"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("корректная страница с sitemap/robots не получает критичных замечаний", async () => {
  process.env.SEO_AUDIT_LIVE = "0";
  const root = await fixture({
    "index.html": "<!doctype html><html lang=\"ru\"><head><title>Главная</title><meta name=\"description\" content=\"Описание\"><link rel=\"canonical\" href=\"https://site.example.ru/\"></head><body><h1>Привет</h1><img src=\"/a.png\" alt=\"картинка\"><a href=\"/about/\">О нас</a></body></html>",
    "about/index.html": "<!doctype html><html lang=\"ru\"><head><title>О нас</title><meta name=\"description\" content=\"О компании\"><link rel=\"canonical\" href=\"https://site.example.ru/about/\"></head><body><h1>О нас</h1></body></html>",
    "404.html": "<!doctype html><html lang=\"ru\"><title>Нет страницы</title></html>",
    "sitemap.xml": "<?xml version=\"1.0\"?><urlset><url><loc>https://site.example.ru/</loc></url></urlset>",
    "robots.txt": "User-agent: *\nAllow: /\n",
  });
  try {
    const manifest = buildRouteManifest([
      { path: "index.html" },
      { path: "about/index.html" },
      { path: "404.html" },
    ]);
    const result = await auditSeoRelease({
      releaseDir: root,
      seoDir: path.join(root, "seo"),
      manifest,
      origin: "https://site.example.ru",
      mode: "static",
    });
    assert.equal(result.issues.filter(item => item.level === "critical").length, 0);
    assert.equal(result.issues.some(item => item.id === "canonical-mismatch"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
