import { isHostingSlug } from "./slug.js";

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

function staticSiteBlock(route: CustomDomainCaddyRoute): string {
  assertHostname(route.hostname);
  if (!isHostingSlug(route.siteSlug)) {
    throw new Error("Некорректный slug сайта для Caddy: " + route.siteSlug);
  }
  return [
    route.hostname + " {",
    "\ttls {",
    "\t\ton_demand",
    "\t}",
    "",
    "\tencode zstd gzip",
    "",
    "\troot * /srv/sites/" + route.siteSlug + "/current",
    "",
    "\t# Скрытые файлы и служебные каталоги не отдаём; ACME-путь Caddy обрабатывает до site-блока.",
    "\t@hidden {",
    "\t\tpath_regexp dot (^|/)\\.",
    "\t\tnot path /.well-known/*",
    "\t}",
    "\trespond @hidden 404",
    "",
    "\t@html path / *.html",
    "\theader @html Cache-Control \"no-cache\"",
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
    "\t# SPA-fallback только для путей без расширения: отсутствующий .js остаётся 404.",
    "\t@spa not path_regexp ext \\.[a-z0-9]{1,8}$",
    "\thandle @spa {",
    "\t\ttry_files {path} /index.html",
    "\t\tfile_server",
    "\t}",
    "\thandle {",
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
