import type { CustomDomain } from "./domain-types.js";
import { defaultTrailingSlash, type HostingSeoSettings, type HostingTrailingSlash } from "./seo/settings.js";
import { isHostingSlug } from "./slug.js";
import type { HostingResolvedMode, HostingSite } from "./types.js";

/**
 * Компактная карта `host → режим + основной домен` для Caddy.
 *
 * Один wildcard site-блок обслуживает все платформенные адреса. Поэтому режим нельзя
 * записать отдельным Caddy-блоком на каждый сайт: на тысячах сайтов это раздувает конфиг и
 * замедляет reload. Map хранит только строки, а Caddy вычисляет placeholder при запросе.
 *
 * `default "spa" "" "ignore"` выбран намеренно: до SEO-этапа платформа отдавала неизвестные
 * пути через index.html. Старые сайты без новых полей должны продолжать работать, а не
 * получить 404 сразу после выкатки. Новые статические сайты получают явный `static` и
 * политику слеша из `seo/settings.json`.
 */
export type HostingModeRoute = {
  hostname: string;
  mode: HostingResolvedMode;
  /** Непустой только после реальной активации custom domain. */
  canonicalHostname: string;
  trailingSlash: HostingTrailingSlash;
};

const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function validHostname(value: string) {
  return HOST_RE.test(value) && value.length <= 253;
}

function validMode(value: HostingResolvedMode | undefined): HostingResolvedMode {
  return value === "static" || value === "hybrid" ? value : "spa";
}

export function buildHostingModeRoutes(input: {
  sites: readonly HostingSite[];
  domains: readonly CustomDomain[];
  publicDomain: string;
  /** Настройки читаются из `seo/settings.json`; для старых сайтов берётся default по режиму. */
  seoSettings?: ReadonlyMap<string, HostingSeoSettings>;
}): HostingModeRoute[] {
  const activeCanonical = new Map<string, CustomDomain>();
  for (const domain of input.domains) {
    if (domain.status !== "active" || !domain.isCanonical || !validHostname(domain.hostname)) continue;
    // На сайте может быть несколько групп в старых данных; выбираем первый стабильный
    // canonical, чтобы карта была детерминированной и не давала два разных 301.
    if (!activeCanonical.has(domain.siteId)) activeCanonical.set(domain.siteId, domain);
  }

  const routes: HostingModeRoute[] = [];
  const seen = new Set<string>();
  for (const site of input.sites) {
    if (site.status !== "live" || !site.activeReleaseId || !isHostingSlug(site.slug)) continue;
    const hostname = site.slug + "." + input.publicDomain;
    if (!validHostname(hostname) || seen.has(hostname)) continue;
    seen.add(hostname);
    const mode = validMode(site.effectiveRoutingMode);
    routes.push({
      hostname,
      mode,
      canonicalHostname: activeCanonical.get(site.id)?.hostname ?? "",
      trailingSlash: input.seoSettings?.get(site.id)?.trailingSlash ?? defaultTrailingSlash(mode),
    });
  }
  return routes.sort((left, right) => left.hostname.localeCompare(right.hostname));
}

function quote(value: string) {
  return '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
}

function validSlash(value: HostingTrailingSlash | undefined): HostingTrailingSlash {
  return value === "always" || value === "never" ? value : "ignore";
}

export function renderHostingModesCaddy(routes: readonly HostingModeRoute[]): string {
  const lines = [
    "# Сгенерировано API для статических сайтов. Не редактировать вручную.",
    "# Источник: sites.effective_routing_mode + активный canonical custom domain + SEO-настройки.",
    "map {http.request.host} {hosting_mode} {hosting_canonical} {hosting_slash} {",
    '\tdefault "spa" "" "ignore"',
  ];
  const seen = new Set<string>();
  for (const route of routes) {
    if (!validHostname(route.hostname) || seen.has(route.hostname)) continue;
    seen.add(route.hostname);
    lines.push(
      "\t" + quote(route.hostname) + " " + quote(validMode(route.mode)) + " " +
      quote(route.canonicalHostname && validHostname(route.canonicalHostname) ? route.canonicalHostname : "") +
      " " + quote(validSlash(route.trailingSlash)),
    );
  }
  lines.push("}", "");
  return lines.join("\n");
}
