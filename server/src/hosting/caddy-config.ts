import { isHostingSlug } from "./slug.js";
import type { HostingRedirectRule } from "./seo/redirects.js";
import { renderRedirectDirectives } from "./seo/redirects.js";
import type { HostingTrailingSlash } from "./seo/settings.js";
import type { HostingResolvedMode } from "./types.js";

/**
 * Генератор Caddy-конфигурации для пользовательских доменов.
 *
 * Здесь нет чтения базы и записи файлов: на вход приходят уже проверенные маршруты, на
 * выходе — детерминированный текст. Детерминированность важна для HA: обе ноды генерируют
 * один и тот же файл из одной базы, и таймер reload не перезагружает Caddy без изменений.
 *
 * Адрес сайта в блоке — точное имя, а не `{host}`. Caddy не должен уметь выбрать каталог
 * релиза по заголовку Host: путь к файлам приходит только из slug'а сайта в базе.
 */

export type CustomDomainCaddyRoute = {
  hostname: string;
  /** Точное имя, на которое перенаправляются остальные имена группы. */
  canonicalHostname: string;
  /** Проверенный slug сайта; из него строится путь /srv/sites/<slug>/current. */
  siteSlug: string;
  isCanonical: boolean;
  /** Режим отдачи. Старые маршруты без поля считаются SPA, как было до SEO-этапа. */
  routingMode?: HostingResolvedMode;
  /** Политика слеша в URL; отсутствует у старых сайтов. */
  trailingSlash?: HostingTrailingSlash;
  /** Проверенные правила `_redirects` активного релиза. */
  redirects?: readonly HostingRedirectRule[];
};

const FILE_HEADER = [
  "# Сгенерировано API для пользовательских доменов. Не редактировать вручную.",
  "# Источник: site_domains + sites.status=live. После изменения файла нужен reload Caddy.",
  "#",
].join("\n");

const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function assertHostname(hostname: string) {
  if (!HOSTNAME_RE.test(hostname) || hostname.length > 253) {
    throw new Error("Некорректный hostname для Caddy: " + hostname);
  }
}

function effectiveMode(route: CustomDomainCaddyRoute): HostingResolvedMode {
  return route.routingMode === "static" || route.routingMode === "hybrid" ? route.routingMode : "spa";
}

function modeHandles(mode: HostingResolvedMode): string[] {
  // Расширение проверяем без учёта регистра и с запасом по длине: иначе отсутствующий
  // /site.webmanifest или /ASSET.JS уходил бы в SPA-fallback и отвечал 200 HTML.
  const notAsset = "not path_regexp ext (?i)\\.[a-z0-9]{1,16}$";
  if (mode === "static") {
    return [
      "\t# static: неизвестная страница — честный 404, а не index.html.",
      "\thandle {",
      // Явный index.html нужен и при политике `never`: `/about` должен отдать файл
      // `about/index.html`, а не ждать, что file_server сам догадается о каталоге.
      "\t\ttry_files {path} {path}/index.html",
      "\t\tfile_server",
      "\t}",
    ];
  }
  if (mode === "hybrid") {
    return [
      "\t# hybrid: SPA-раздел /app/* получает fallback, остальные страницы — как static.",
      "\t@hybrid {",
      "\t\tpath /app/*",
      "\t\tnot path_regexp ext (?i)\\.[a-z0-9]{1,16}$",
      "\t}",
      "\thandle @hybrid {",
      "\t\ttry_files {path} /index.html",
      "\t\tfile_server",
      "\t}",
      "\thandle {",
      "\t\ttry_files {path} {path}/index.html",
      "\t\tfile_server",
      "\t}",
    ];
  }
  return [
    "\t# SPA-fallback только для путей без расширения: отсутствующий .js остаётся 404.",
    "\t@spa " + notAsset,
    "\thandle @spa {",
    "\t\ttry_files {path} /index.html",
    "\t\tfile_server",
    "\t}",
    "\thandle {",
    "\t\tfile_server",
    "\t}",
  ];
}

function trailingSlashHandles(mode: HostingTrailingSlash | undefined): string[] {
  if (mode !== "always" && mode !== "never") return [];
  if (mode === "always") {
    return [
      "\t# Один канонический вариант для каталогов: /about → /about/.",
      "\t@slash_add {",
      "\t\tpath_regexp slash ^(/.+[^/])$",
      "\t\tnot path_regexp ext (?i)\\.[a-z0-9]{1,16}$",
      "\t\tnot path /api/* /.well-known/*",
      "\t}",
      "\tredir @slash_add {http.request.uri.path}/{?query} permanent",
      "",
    ];
  }
  return [
    "\t# Один канонический вариант без хвостового слеша: /about/ → /about.",
    "\t@slash_remove {",
    "\t\tpath_regexp slash ^(/.+[^/])/$",
    "\t\tnot path /api/* /.well-known/*",
    "\t}",
    "\tredir @slash_remove {re.slash.1}{?query} permanent",
    "",
  ];
}

function staticSiteBlock(route: CustomDomainCaddyRoute): string {
  assertHostname(route.hostname);
  if (!isHostingSlug(route.siteSlug)) {
    throw new Error("Некорректный slug сайта для Caddy: " + route.siteSlug);
  }
  const siteDir = "/srv/sites/" + route.siteSlug;
  return [
    route.hostname + " {",
    "\ttls {",
    "\t\ton_demand",
    "\t}",
    "",
    "\tencode zstd gzip",
    "",
    "\troot * " + siteDir + "/current",
    "",
    "\t# 404.html — только шаблон ошибки, а не обычная страница с 200.",
    "\t@errorfile path /404.html",
    "\trespond @errorfile 404",
    "",
    "\t# Скрытые файлы и служебные каталоги не отдаём; ACME-путь Caddy обрабатывает до site-блока.",
    "\t@hidden {",
    "\t\tpath_regexp dot (^|/)\\.",
    "\t\tnot path /.well-known/*",
    "\t}",
    "\trespond @hidden 404",
    "\t# `_redirects` — входной файл маршрутизации, а не публичная страница.",
    "\t@redirects_file path /_redirects",
    "\trespond @redirects_file 404",
    "",
    ...renderRedirectDirectives({
      hostname: route.hostname,
      rules: route.redirects ?? [],
      namePrefix: "custom_" + route.siteSlug,
    }),
    ...(route.redirects?.length ? [""] : []),
    ...trailingSlashHandles(route.trailingSlash),
    "\t@html path / *.html",
    "\theader @html Cache-Control \"no-cache\"",
    "",
    "\t# sitemap/robots/проверка Search Console не должны жить в CDN год.",
    "\t@seo path /sitemap.xml /sitemap-*.xml /robots.txt /google*.html",
    "\theader @seo Cache-Control \"public, max-age=300\"",
    "",
    "\t# Долгий кеш только для файлов с хешем в имени.",
    "\t@hashed path_regexp hashed -[A-Za-z0-9_-]{6,}\\.[a-z0-9]{1,8}$",
    "\theader @hashed Cache-Control \"public, max-age=31536000, immutable\"",
    "",
    "\theader {",
    "\t\tX-Content-Type-Options nosniff",
    "\t\tReferrer-Policy strict-origin-when-cross-origin",
    "\t}",
    "",
    "\t# Serverless API. Дверь сама отвечает 404, если у релиза нет функции на этот путь:",
    "\t# статический SPA-fallback не должен превращать отсутствующий API в index.html.",
    "\thandle /api/* {",
    "\t\treverse_proxy webnestdev-server:8792",
    "\t}",
    "",
    "\t# Пользовательский sitemap/robots главнее сгенерированного overlay.",
    "\thandle /sitemap.xml {",
    "\t\troot * " + siteDir,
    "\t\ttry_files /current/sitemap.xml /seo/sitemap.xml",
    "\t\tfile_server",
    "\t}",
    "\thandle /sitemap-*.xml {",
    "\t\troot * " + siteDir,
    "\t\ttry_files /current{path} /seo{path}",
    "\t\tfile_server",
    "\t}",
    "\thandle /robots.txt {",
    "\t\troot * " + siteDir,
    "\t\ttry_files /current/robots.txt /seo/robots.txt",
    "\t\tfile_server",
    "\t}",
    "\thandle /google*.html {",
    "\t\troot * " + siteDir,
    "\t\ttry_files /current{path} /seo{path}",
    "\t\tfile_server",
    "\t}",
    "",
    ...modeHandles(effectiveMode(route)),
    "",
    "\t# 404.html отдаём с исходным статусом 404 и noindex, не превращая ошибку в 200.",
    "\thandle_errors {",
    "\t\t@notfound expression int({http.error.status_code}) == 404",
    "\t\theader @notfound X-Robots-Tag \"noindex\"",
    "\t\theader @notfound Cache-Control \"no-cache\"",
    "\t\trewrite @notfound /404.html",
    "\t\tfile_server",
    "\t}",
    "}",
  ].join("\n");
}

function redirectSiteBlock(route: CustomDomainCaddyRoute): string {
  assertHostname(route.hostname);
  assertHostname(route.canonicalHostname);
  return [
    "# " + route.hostname + " → " + route.canonicalHostname + " (канонический адрес).",
    route.hostname + " {",
    "\ttls {",
    "\t\ton_demand",
    "\t}",
    "",
    "\tredir https://" + route.canonicalHostname + "{uri} permanent",
    "}",
  ].join("\n");
}

/**
 * Собирает один общий файл. Сортировка и отсутствие времени генерации дают одинаковый
 * результат на обеих нодах; иначе таймер reload видел бы изменение на каждом проходе.
 */
export function renderCustomDomainsCaddy(routes: readonly CustomDomainCaddyRoute[]): string {
  const unique = new Map<string, CustomDomainCaddyRoute>();
  for (const route of routes) {
    assertHostname(route.hostname);
    if (!unique.has(route.hostname)) unique.set(route.hostname, route);
  }
  const ordered = [...unique.values()].sort((left, right) => left.hostname.localeCompare(right.hostname));
  if (!ordered.length) return FILE_HEADER + "\n";
  const blocks = ordered.map(route => (
    route.isCanonical && route.hostname === route.canonicalHostname
      ? staticSiteBlock(route)
      : redirectSiteBlock(route)
  ));
  return FILE_HEADER + "\n" + blocks.join("\n\n") + "\n";
}
