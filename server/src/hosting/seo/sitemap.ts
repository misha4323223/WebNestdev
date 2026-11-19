import { sitemapRoutes, type HostingRouteManifest } from "./route-manifest.js";
import type { HostingTrailingSlash } from "./settings.js";

function xmlEscape(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function pathUrl(origin: string, route: string) {
  return origin + (route.startsWith("/") ? route : "/" + route);
}

export const SITEMAP_MAX_URLS = 50_000;
export type SitemapChunk = { name: string; content: string };
export type SitemapBundle = {
  /** Один файл для обычного сайта или index для большого. */
  index: string;
  chunks: SitemapChunk[];
  /** Сколько URL всего попало в карту. */
  urls: number;
};

/**
 * Sitemap только из реальных HTML-файлов релиза. Никаких ссылок, найденных в тексте:
 * битые URL в sitemap хуже отсутствия sitemap. `/404.html` и служебные пути исключены.
 */
function applySlashPolicy(routes: readonly string[], policy: HostingTrailingSlash | undefined) {
  if (policy === "never") {
    return routes.map(route => route.length > 1 ? route.replace(/\/+$/, "") : route);
  }
  if (policy === "always") {
    return routes.map(route => route !== "/" && !/\.[a-z0-9]{1,16}$/i.test(route) && !route.endsWith("/") ? route + "/" : route);
  }
  return [...routes];
}

export function renderSitemapXml(input: {
  origin: string;
  manifest: HostingRouteManifest;
  lastmod?: string | null;
  trailingSlash?: HostingTrailingSlash;
}): string {
  return renderSitemapChunk({
    origin: input.origin,
    routes: applySlashPolicy(sitemapRoutes(input.manifest).map(route => route.path), input.trailingSlash),
    lastmod: input.lastmod,
  });
}

/** Один `<urlset>` не больше SITEMAP_MAX_URLS; его же использует index-сборка. */
export function renderSitemapChunk(input: {
  origin: string;
  routes: readonly string[];
  lastmod?: string | null;
}): string {
  const origin = input.origin.replace(/\/+$/, "");
  const lastmod = input.lastmod?.slice(0, 10);
  // Не добавляем `/` сами: если в релизе нет index.html, такой URL был бы битым.
  const unique = [...new Set(input.routes)];
  const urls = unique.map(route => [
    "  <url>",
    "    <loc>" + xmlEscape(pathUrl(origin, route)) + "</loc>",
    ...(lastmod ? ["    <lastmod>" + xmlEscape(lastmod) + "</lastmod>"] : []),
    "  </url>",
  ].join("\n")).join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urls,
    "</urlset>",
    "",
  ].join("\n");
}

/**
 * Sitemap index нужен только когда URL больше 50 000: поисковики не принимают больший
 * `<urlset>`. Индекс сам остаётся маленьким и не зависит от числа страниц.
 */
export function renderSitemapBundle(input: {
  origin: string;
  manifest: HostingRouteManifest;
  lastmod?: string | null;
  trailingSlash?: HostingTrailingSlash;
  maxUrls?: number;
}): SitemapBundle {
  const origin = input.origin.replace(/\/+$/, "");
  const routes = [...new Set(applySlashPolicy(sitemapRoutes(input.manifest).map(route => route.path), input.trailingSlash))];
  const maxUrls = Math.min(SITEMAP_MAX_URLS, Math.max(1, Math.floor(input.maxUrls ?? SITEMAP_MAX_URLS)));
  if (routes.length <= maxUrls) {
    return {
      index: renderSitemapChunk({ origin, routes, lastmod: input.lastmod }),
      chunks: [],
      urls: routes.length,
    };
  }
  const chunks: SitemapChunk[] = [];
  for (let offset = 0; offset < routes.length; offset += maxUrls) {
    chunks.push({
      name: "sitemap-" + (chunks.length + 1) + ".xml",
      content: renderSitemapChunk({
        origin,
        routes: routes.slice(offset, offset + maxUrls),
        lastmod: input.lastmod,
      }),
    });
  }
  const lastmod = input.lastmod?.slice(0, 10);
  const body = chunks.map(chunk => [
    "  <sitemap>",
    "    <loc>" + xmlEscape(origin + "/" + chunk.name) + "</loc>",
    ...(lastmod ? ["    <lastmod>" + xmlEscape(lastmod) + "</lastmod>"] : []),
    "  </sitemap>",
  ].join("\n")).join("\n");
  return {
    index: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      body,
      "</sitemapindex>",
      "",
    ].join("\n"),
    chunks,
    urls: routes.length,
  };
}

export function renderRobotsTxt(input: { origin: string; allowIndexing?: boolean }): string {
  const origin = input.origin.replace(/\/+$/, "");
  if (input.allowIndexing === false) {
    return ["User-agent: *", "Disallow: /", ""].join("\n");
  }
  return [
    "User-agent: *",
    "Allow: /",
    "Sitemap: " + origin + "/sitemap.xml",
    "",
  ].join("\n");
}
