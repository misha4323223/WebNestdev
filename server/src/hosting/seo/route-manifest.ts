import type { ArtifactManifest } from "../artifact.js";
import type { HostingProjectKind, HostingResolvedMode, HostingRoutingMode } from "../types.js";

/**
 * Маршруты, которые реально есть в статическом релизе.
 *
 * Sitemap и аудит не должны угадывать страницы по ссылкам в HTML: ссылка может вести на
 * внешний сайт, на якорь или на страницу, которой нет в релизе. Источник правды — файлы,
 * которые Caddy действительно может отдать.
 */
export type HostingRoute = {
  /** Публичный путь: `/`, `/about/`, `/blog/post/`. */
  path: string;
  /** Файл внутри релиза: `index.html`, `about/index.html`. */
  file: string;
};

export type HostingRouteManifest = {
  version: 1;
  routes: HostingRoute[];
  /** Есть ли в релизе пользовательская 404-страница. */
  has404: boolean;
  /** Сколько HTML-файлов нашли до исключения служебных страниц. */
  htmlFiles: number;
};

const HTML_RE = /\.html$/i;

function normalizeFile(value: string) {
  return value.replaceAll("\\", "/").replace(/^\/+/, "");
}

function isHidden(file: string) {
  return file.split("/").some(part => part.startsWith("."));
}

function isSafeFile(file: string) {
  if (!file || file.startsWith("/") || file.includes("\0")) return false;
  return !file.split("/").some(part => part === ".." || part === ".");
}

function routeForFile(file: string): string | null {
  const normalized = normalizeFile(file);
  if (!isSafeFile(normalized) || !HTML_RE.test(normalized) || isHidden(normalized)) return null;
  if (normalized === "404.html" || normalized.endsWith("/404.html")) return null;
  if (normalized === "index.html") return "/";
  if (normalized.endsWith("/index.html")) {
    const directory = normalized.slice(0, -"index.html".length).replace(/\/+$/, "");
    return directory ? "/" + directory + "/" : "/";
  }
  return "/" + normalized;
}

/**
 * Собирает маршруты из уже проверенного манифеста артефакта. Никаких чтений диска:
 * публикатор вызывает это после inspectArtifact, поэтому список совпадает с тем, что
 * попадёт в релиз.
 */
export function buildRouteManifest(files: ReadonlyArray<{ path: string }>): HostingRouteManifest {
  const routes: HostingRoute[] = [];
  let has404 = false;
  let htmlFiles = 0;
  const seen = new Set<string>();

  for (const item of files) {
    const file = normalizeFile(item.path);
    if (!HTML_RE.test(file) || isHidden(file)) continue;
    htmlFiles++;
    // Caddy ищет `/404.html` в корне релиза; вложенный `sub/404.html` — обычная
    // страница, а не обработчик ошибок.
    if (file === "404.html") {
      has404 = true;
      continue;
    }
    const route = routeForFile(file);
    if (!route || seen.has(route)) continue;
    seen.add(route);
    routes.push({ path: route, file });
  }

  routes.sort((left, right) => left.path.localeCompare(right.path));
  return { version: 1, routes, has404, htmlFiles };
}

export function routeManifestFromArtifact(manifest: ArtifactManifest): HostingRouteManifest {
  return buildRouteManifest(manifest.files);
}

/** Разбор сохранённого JSON; старые релизы без поля получают `null`. */
export function parseRouteManifest(value: string | null | undefined): HostingRouteManifest | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<HostingRouteManifest>;
    if (parsed.version !== 1 || !Array.isArray(parsed.routes)) return null;
    const seen = new Set<string>();
    const routes: HostingRoute[] = [];
    for (const item of parsed.routes) {
      if (!item || typeof item.path !== "string" || typeof item.file !== "string") continue;
      const file = normalizeFile(item.file);
      if (!item.path.startsWith("/") || !HTML_RE.test(file) || !isSafeFile(file)) continue;
      if (seen.has(item.path)) continue;
      seen.add(item.path);
      routes.push({ path: item.path, file });
    }
    return {
      version: 1,
      routes,
      has404: parsed.has404 === true,
      htmlFiles: Number.isFinite(parsed.htmlFiles) ? Math.max(0, Number(parsed.htmlFiles)) : routes.length,
    };
  } catch {
    return null;
  }
}

/**
 * `auto` — это рекомендация, а не скрытый режим. Для готовой HTML-страницы безопаснее
 * static; для сборки с одним index.html сохраняем прежнее поведение SPA, чтобы не сломать
 * уже работающие приложения. Если в сборке несколько HTML или есть 404.html, это уже
 * многостраничный сайт и fallback ему только вредит.
 */
export function resolveRoutingMode(input: {
  requested: HostingRoutingMode | undefined;
  kind: HostingProjectKind | "";
  manifest: HostingRouteManifest;
}): HostingResolvedMode {
  const requested = input.requested ?? "auto";
  if (requested !== "auto") return requested;
  if (input.manifest.has404 || input.manifest.routes.length > 1) return "static";
  if (input.kind === "instant-site") return "static";
  return "spa";
}

/** Публичные страницы для sitemap: без служебных и API-путей. */
export function sitemapRoutes(manifest: HostingRouteManifest): HostingRoute[] {
  return manifest.routes.filter(route =>
    route.path !== "/404.html"
    && !route.path.startsWith("/api/")
    && !route.path.startsWith("/.well-known/")
    && !route.path.endsWith("/404.html"),
  );
}
